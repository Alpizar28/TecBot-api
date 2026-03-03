import { describe, it, expect } from 'vitest';
import {
  classifyType,
  extractCourse,
  ensureAbsoluteUrl,
  shouldDeleteFromTec,
  buildExternalId,
} from '../src/extractors/notifications.js';

describe('notifications heuristics', () => {
  it('classifies document notifications from file-storage links', () => {
    expect(classifyType('', 'Nuevo material disponible', '/dotlrn/file-storage/#/123#/')).toBe(
      'documento',
    );
  });

  it('classifies evaluation notifications from keywords', () => {
    expect(classifyType('', 'Se publico examen parcial', '/dotlrn/classes/EL2207')).toBe(
      'evaluacion',
    );
  });

  it('extracts course from labeled text', () => {
    expect(extractCourse('Curso: Matematica Discreta | Se subio material')).toBe(
      'Matematica Discreta',
    );
  });

  it('extracts course from separator', () => {
    expect(extractCourse('EL2207 - Se actualizo el contenido del curso')).toBe('EL2207');
  });

  it('prioritizes full text name over URL code', () => {
    expect(extractCourse('Física General II - Tarea 1', '/dotlrn/classes/fi2207/')).toBe(
      'Física General II',
    );
  });

  it('falls back to URL code if no text name is found', () => {
    expect(extractCourse('Nueva notificación', '/dotlrn/classes/fi2207/')).toBe('FI2207');
  });

  it('normalizes relative TEC urls', () => {
    expect(ensureAbsoluteUrl('/dotlrn/classes/EL2207')).toBe(
      'https://tecdigital.tec.ac.cr/dotlrn/classes/EL2207',
    );
  });

  it('deletes in TEC only when dispatch confirms processed true', () => {
    expect(shouldDeleteFromTec(200, { status: 'success', processed: true })).toBe(true);
    expect(shouldDeleteFromTec(200, { status: 'success', processed: false })).toBe(false);
    expect(shouldDeleteFromTec(500, { status: 'success', processed: true })).toBe(false);
    expect(shouldDeleteFromTec(200, { status: 'error', processed: true })).toBe(false);
  });

  describe('buildExternalId — deduplication stability', () => {
    it('uses tecId when provided', () => {
      expect(buildExternalId('42', 'https://tecdigital.tec.ac.cr/x', 'some text')).toBe('notif_42');
    });

    it('produces the same id for the same link+text across calls (no random component)', () => {
      const link = 'https://tecdigital.tec.ac.cr/dotlrn/classes/EL2207/news/';
      const text = 'Física General II - Se publicó material';
      const id1 = buildExternalId(undefined, link, text);
      const id2 = buildExternalId(undefined, link, text);
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^notif_[0-9a-f]{16}$/);
    });

    it('produces different ids for different links', () => {
      const text = 'Misma noticia';
      const id1 = buildExternalId(null, 'https://tecdigital.tec.ac.cr/curso/a', text);
      const id2 = buildExternalId(null, 'https://tecdigital.tec.ac.cr/curso/b', text);
      expect(id1).not.toBe(id2);
    });

    it('produces different ids for different texts on the same link', () => {
      const link = 'https://tecdigital.tec.ac.cr/dotlrn/classes/EL2207/news/';
      const id1 = buildExternalId(undefined, link, 'Noticia A');
      const id2 = buildExternalId(undefined, link, 'Noticia B');
      expect(id1).not.toBe(id2);
    });

    it('treats 0 as a valid tecId (edge case)', () => {
      expect(buildExternalId(0, 'https://example.com', 'text')).toBe('notif_0');
    });
  });
});
