import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parseCourseLinks,
  parseEvaluationsPage,
  parseDueDate,
  resolveEvaluationUrl,
  buildEvaluationExternalId,
} from '../src/extractors/evaluations.js';

const FIXTURE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tda-index.html'),
  'utf8',
);

const COURSE_URL = 'https://tecdigital.tec.ac.cr/dotlrn/classes/MA/MA2104/S-1-2026.CA.MA2104.1/';

const PORTAL_HTML = `
<html><body>
<a href="/dotlrn/classes/E/EL2114/S-1-2026.CA.EL2114.2/">Circuitos eléctricos en corriente alterna GR 2 beenhere</a>
<a href="/dotlrn/classes/E/EL2114/S-1-2026.CA.EL2114.2/notafinalestudiantesentutora20/">Nota Final - Estudiantes en Tutoría</a>
<a href="/dotlrn/classes/MA/MA2104/S-1-2026.CA.MA2104.1/">Cálculo superior GR 1 beenhere</a>
<a href="/dotlrn/classes/AE/AE4208/V-1-2025.CA.AE4208.3/">Desarrollo de emprendedores GR 3</a>
<a href="/dotlrn/classes/E/EL2114/S-1-2026.CA.EL2114.2/">Circuitos eléctricos en corriente alterna GR 2</a>
</body></html>`;

describe('parseCourseLinks', () => {
  const courses = parseCourseLinks(PORTAL_HTML);

  it('keeps only current-term course roots, deduped', () => {
    expect(courses.map((c) => c.community_key).sort()).toEqual([
      'S-1-2026.CA.EL2114.2',
      'S-1-2026.CA.MA2104.1',
    ]);
  });

  it('excludes older terms and subgroup links', () => {
    expect(courses.some((c) => c.community_key.includes('2025'))).toBe(false);
    expect(courses.some((c) => c.url.includes('notafinal'))).toBe(false);
  });

  it('cleans the material-icons ligature from names and builds absolute URLs', () => {
    const ma = courses.find((c) => c.code === 'MA2104');
    expect(ma?.name).toBe('Cálculo superior GR 1');
    expect(ma?.url).toBe(COURSE_URL);
  });
});

describe('parseEvaluationsPage', () => {
  const evals = parseEvaluationsPage(FIXTURE, COURSE_URL);

  it('extracts every assignment with its category in document order', () => {
    expect(evals.map((e) => `${e.category}/${e.title}`)).toEqual([
      'Exámenes/I Parcial',
      'Quices o Tareas/Q2',
      'Quices o Tareas/Q3',
    ]);
    expect(evals[0].category_weight).toBe(80);
    expect(evals[1].category_weight).toBe(20);
  });

  it('parses plain score pairs and pending grades', () => {
    const parcial = evals[0];
    expect(parcial.score).toBe(21.15);
    expect(parcial.max_score).toBe(26.67);
    const q3 = evals[2];
    expect(q3.score).toBeNull();
    expect(q3.max_score).toBe(5.0);
  });

  it('parses "Ponderado" weighted grades and the Mis entregas block', () => {
    const q2 = evals[1];
    expect(q2.weighted_score).toBe(100.0);
    expect(q2.score).toBeNull();
    expect(q2.grade_over_100).toBe(100.0);
    expect(q2.comments).toBe('Puntos extra');
  });

  it('parses due dates and late-submission flags', () => {
    expect(evals[0].due_date).toBe('');
    expect(evals[0].late_allowed).toBe(false);
    expect(evals[1].due_date).toBe('2026-03-20');
    expect(evals[1].due_time).toBe('08:00');
    expect(evals[1].late_allowed).toBe(true);
    expect(evals[2].due_date).toBe('2026-08-01');
  });

  it('collects statement files but skips the student submission links', () => {
    const q2 = evals[1];
    expect(q2.files).toHaveLength(1);
    expect(q2.files[0].file_name).toBe('Quiz2Tarea1.pdf');
    expect(q2.files[0].mime_type).toBe('application/pdf');
    expect(q2.files[0].download_url).toBe(
      `${COURSE_URL}evaluation/view/Quiz2Tarea1.pdf?revision_id=234033789`,
    );
    expect(evals[0].files).toHaveLength(0);
  });

  it('keeps real descriptions and blanks the placeholder ones', () => {
    expect(evals[0].description).toBe('');
    expect(evals[2].description).toBe('Resolver los problemas del capítulo 4');
  });

  it('builds stable external ids scoped by community key', () => {
    expect(evals[0].external_id).toBe(
      buildEvaluationExternalId('S-1-2026.CA.MA2104.1', 'Exámenes', 'I Parcial'),
    );
    expect(evals[0].external_id).toMatch(/^eval_[0-9a-f]{16}$/);
    expect(new Set(evals.map((e) => e.external_id)).size).toBe(3);
  });
});

describe('helpers', () => {
  it('parseDueDate handles undefined dates', () => {
    expect(parseDueDate('Fecha no definida')).toEqual({ date: '', time: '' });
    expect(parseDueDate('5/12/2024 00:00')).toEqual({ date: '2024-12-05', time: '00:00' });
  });

  it('resolveEvaluationUrl normalizes the ../view/../../ variants', () => {
    expect(
      resolveEvaluationUrl('../view/../../evaluation/view/x.pdf?revision_id=1', COURSE_URL),
    ).toBe(`${COURSE_URL}evaluation/view/x.pdf?revision_id=1`);
    expect(resolveEvaluationUrl('/otra/cosa.pdf', COURSE_URL)).toBe('');
  });
});
