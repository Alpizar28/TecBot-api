/**
 * Evaluations extractor: scrapes the per-course "Evaluaciones" rubric
 * (tda-ce-estudiante/tda-index) that never surfaces in the notifications
 * feed. One GET per course returns everything pre-rendered: categories,
 * assignments, weights, grades, due dates and the statement PDF links.
 *
 * Course discovery: the /dotlrn/ portal lists every enrolled course (all
 * terms); we keep only the most recent term (max year in the community key,
 * e.g. "S-1-2026.CA.EL2114.2").
 */
import crypto from 'crypto';
import * as cheerio from 'cheerio';
import type { TecHttpClient } from '../clients/tec-http.client.js';
import { logger } from '../logger.js';

const extractorLogger = logger.child({ component: 'evaluations_extractor' });

const TEC_BASE = 'https://tecdigital.tec.ac.cr';

export interface CourseRef {
  /** e.g. "EL2114" */
  code: string;
  /** e.g. "S-1-2026.CA.EL2114.2" — unique per course+group+term */
  community_key: string;
  /** Human name as shown in the portal, e.g. "Cálculo superior GR 1" */
  name: string;
  /** Absolute URL to the course root, e.g. https://.../dotlrn/classes/MA/MA2104/S-1-2026.CA.MA2104.1/ */
  url: string;
  /** Term year parsed from the community key (used for current-term filter) */
  year: number;
}

export interface EvaluationFile {
  file_name: string;
  download_url: string;
  mime_type: string;
}

export interface CourseEvaluation {
  /** Stable id: eval_<sha256(community_key|category|title)[:16]> */
  external_id: string;
  category: string;
  /** Category weight over the course total, e.g. 80 (from item_weight) */
  category_weight: number | null;
  title: string;
  /** Points obtained toward the course total (null while ungraded) */
  score: number | null;
  /** Max points toward the course total */
  max_score: number | null;
  /** "Ponderado" assignments report a 0-100 weighted grade instead */
  weighted_score: number | null;
  /** From "Nota obtenida: 80.3 / 100" in Mis entregas (null if absent) */
  grade_over_100: number | null;
  description: string;
  /** ISO date YYYY-MM-DD ("" when "Fecha no definida") */
  due_date: string;
  /** HH:MM ("" when no due date) */
  due_time: string;
  late_allowed: boolean;
  comments: string;
  /** Statement PDFs attached to the assignment description */
  files: EvaluationFile[];
}

export interface CourseEvaluations extends CourseRef {
  evaluations: CourseEvaluation[];
}

/** Community key segment, e.g. "S-1-2026.CA.EL2114.2" (also V-/H- terms). */
const COMMUNITY_RE = /^([SVH])-(\d)-(\d{4})\./;
const COURSE_HREF_RE = /^\/dotlrn\/classes\/[^/]+\/([A-Z]{2,4}\d{3,4})\/([^/]+)\/?$/i;

/** Parses the /dotlrn/ portal HTML into the current-term course list. */
export function parseCourseLinks(html: string): CourseRef[] {
  const $ = cheerio.load(html);
  const byKey = new Map<string, CourseRef>();

  $('a[href*="/dotlrn/classes/"]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim().replace(/\/+$/, '/');
    const match = href.match(COURSE_HREF_RE);
    if (!match) return; // subgroup or deep link — not a course root
    const [, code, communityKey] = match;
    const term = communityKey.match(COMMUNITY_RE);
    if (!term) return;

    const name = $(el)
      .text()
      .replace(/\bbeenhere\b/g, '') // material-icons ligature leaks into text
      .replace(/\s+/g, ' ')
      .trim();

    if (!byKey.has(communityKey)) {
      byKey.set(communityKey, {
        code: code.toUpperCase(),
        community_key: communityKey,
        name: name || code.toUpperCase(),
        url: `${TEC_BASE}${href.endsWith('/') ? href : `${href}/`}`,
        year: parseInt(term[3], 10),
      });
    }
  });

  const all = [...byKey.values()];
  if (all.length === 0) return [];
  const maxYear = Math.max(...all.map((c) => c.year));
  return all.filter((c) => c.year === maxYear);
}

function parseScorePair(text: string): { score: number | null; max: number | null } {
  const m = text.replace(/\s+/g, ' ').match(/(-{1,2}|\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)/);
  if (!m) return { score: null, max: null };
  const score = m[1].startsWith('-') ? null : parseFloat(m[1].replace(',', '.'));
  return { score, max: parseFloat(m[2].replace(',', '.')) };
}

/** "20/03/2026 08:00" → {date: "2026-03-20", time: "08:00"}; anything else → empty. */
export function parseDueDate(text: string): { date: string; time: string } {
  const m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}:\d{2}))?/);
  if (!m) return { date: '', time: '' };
  const [, dd, mm, yyyy, hhmm] = m;
  return {
    date: `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`,
    time: hhmm ?? '',
  };
}

export function buildEvaluationExternalId(
  communityKey: string,
  category: string,
  title: string,
): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${communityKey}|${category}|${title}`)
    .digest('hex')
    .slice(0, 16);
  return `eval_${digest}`;
}

type Node = ReturnType<cheerio.CheerioAPI>;

/** Reads the value node that follows a `p.title_subsection` label matching `labelRe`. */
function detailValue($: cheerio.CheerioAPI, block: Node, labelRe: RegExp): Node | null {
  let found: Node | null = null;
  block.find('p.title_subsection').each((_, el) => {
    if (found) return;
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    if (labelRe.test(label)) {
      let candidate: Node = $(el).nextAll('.body_style, a').first();
      if (candidate.length === 0) candidate = $(el).parent().find('.body_style').first();
      found = candidate;
    }
  });
  return found && (found as Node).length > 0 ? found : null;
}

function radioIsYes($: cheerio.CheerioAPI, value: Node | null): boolean {
  if (!value) return false;
  let yes = false;
  value.find('input').each((_, input) => {
    const checked = $(input).attr('checked') !== undefined;
    const label = $(input).next('label').text().trim().toLowerCase();
    if (checked && label === 'sí') yes = true;
  });
  return yes;
}

/** Parses one course's tda-index HTML into structured evaluations. */
export function parseEvaluationsPage(html: string, courseUrl: string): CourseEvaluation[] {
  const $ = cheerio.load(html);
  const results: CourseEvaluation[] = [];

  const communityKey = courseUrl.match(/\/dotlrn\/classes\/[^/]+\/[^/]+\/([^/]+)\//)?.[1] ?? '';
  let category = '';
  let categoryWeight: number | null = null;

  // Categories and assignment blocks appear interleaved in document order.
  $('.title_acor_grade, .ccontent_assign').each((_, el) => {
    const node = $(el);

    if (node.hasClass('title_acor_grade')) {
      category = node.find('.clase').first().text().replace(/\s+/g, ' ').trim();
      const weightAttr = node.find('[item_weight]').first().attr('item_weight');
      categoryWeight = weightAttr ? parseFloat(weightAttr) : null;
      return;
    }

    const title = node.find('.assignNameText').first().text().replace(/\s+/g, ' ').trim();
    if (!title) return;

    // Grade in the header: either "27.30 / 34.00" or a "Ponderado 100.0" widget.
    const gradeEl = node.find('.vt_grade_student').first();
    const weightedText = gradeEl.find('.gradeW').first().text().trim();
    const weightedScore = weightedText ? parseFloat(weightedText.replace(',', '.')) : null;
    const { score, max } =
      weightedScore === null
        ? parseScorePair(gradeEl.text())
        : { score: null, max: null };

    const description = (() => {
      const value = detailValue($, node, /^Descripción/);
      const text = value ? $(value).text().replace(/\s+/g, ' ').trim() : '';
      return /^(No hay descripción|Ver archivo adjunto)/i.test(text) ? '' : text;
    })();

    const dueText = (() => {
      const value = detailValue($, node, /^Fecha de Entrega/);
      return value ? $(value).text().trim() : '';
    })();
    const { date: dueDate, time: dueTime } = parseDueDate(dueText);

    const lateAllowed = radioIsYes(
      $,
      detailValue($, node, /después de fecha límite/),
    );

    // "Mis entregas" right column: published grade over 100 + comments.
    let gradeOver100: number | null = null;
    let comments = '';
    node.find('p.title_subsection').each((_, label) => {
      const text = $(label).text().replace(/\s+/g, ' ').trim();
      const value = $(label).nextAll('.body_style').first();
      if (/^Nota obtenida/.test(text)) {
        const pair = parseScorePair(value.text());
        if (pair.score !== null) gradeOver100 = pair.score;
      } else if (/^Comentarios/.test(text)) {
        comments = value.text().replace(/\s+/g, ' ').trim();
      }
    });

    // Statement attachments live in the description column as
    // href="../../evaluation/view/<name>.pdf?revision_id=N". Student
    // submissions use different markup (.taskAnswer) and are skipped.
    const files: EvaluationFile[] = [];
    const seen = new Set<string>();
    node.find('a[href*="/evaluation/view/"]').each((_, a) => {
      if ($(a).hasClass('taskAnswer') || $(a).closest('.answerStyle').length > 0) return;
      const href = $(a).attr('href') ?? '';
      const resolved = resolveEvaluationUrl(href, courseUrl);
      if (!resolved || seen.has(resolved)) return;
      seen.add(resolved);
      const fileName = decodeURIComponent(
        resolved.split('/').pop()?.split('?')[0] ?? 'adjunto.pdf',
      );
      files.push({
        file_name: fileName,
        download_url: resolved,
        mime_type: fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : '',
      });
    });

    results.push({
      external_id: buildEvaluationExternalId(communityKey, category, title),
      category,
      category_weight: categoryWeight,
      title,
      score,
      max_score: max,
      weighted_score: weightedScore,
      grade_over_100: gradeOver100,
      description,
      due_date: dueDate,
      due_time: dueTime,
      late_allowed: lateAllowed,
      comments,
      files,
    });
  });

  return results;
}

/** Resolves "../../evaluation/view/x.pdf?rev" (or variants) against the course root. */
export function resolveEvaluationUrl(href: string, courseUrl: string): string {
  const trimmed = href.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  const viewIdx = trimmed.indexOf('evaluation/view/');
  if (viewIdx === -1) return '';
  const base = courseUrl.endsWith('/') ? courseUrl : `${courseUrl}/`;
  return `${base}${trimmed.slice(viewIdx)}`;
}

/** Fetches the portal + every current-term course rubric. Never throws per-course. */
export async function scrapeEvaluations(client: TecHttpClient): Promise<CourseEvaluations[]> {
  const portal = await client.client.get<string>(`${TEC_BASE}/dotlrn/`, { timeout: 30_000 });
  const courses = parseCourseLinks(String(portal.data ?? ''));
  extractorLogger.info({ count: courses.length }, 'Current-term courses discovered');

  const out: CourseEvaluations[] = [];
  for (const course of courses) {
    try {
      const res = await client.client.get<string>(
        `${course.url}evaluation/tda-ce-estudiante/tda-index`,
        { timeout: 30_000 },
      );
      const evaluations = parseEvaluationsPage(String(res.data ?? ''), course.url);
      out.push({ ...course, evaluations });
      extractorLogger.info(
        { course: course.code, evaluations: evaluations.length },
        'Course evaluations extracted',
      );
    } catch (error) {
      extractorLogger.warn(
        { course: course.code, error: error instanceof Error ? error.message : String(error) },
        'Failed to extract course evaluations',
      );
    }
  }
  return out;
}
