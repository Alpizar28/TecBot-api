import crypto from 'crypto';
import * as cheerio from 'cheerio';
import type { TecHttpClient } from './tec-http.client.js';
import { logger } from '../logger.js';

const extractorLogger = logger.child({ component: 'evaluations_extractor' });

const TEC_BASE = 'https://tecdigital.tec.ac.cr';

export interface CourseRef {
  code: string;
  community_key: string;
  name: string;
  url: string;
  year: number;
  term: number;
}

export interface EvaluationFile {
  file_name: string;
  download_url: string;
  mime_type: string;
}

export interface CourseEvaluation {
  external_id: string;
  category: string;
  category_weight: number | null;
  title: string;
  score: number | null;
  max_score: number | null;
  weighted_score: number | null;
  grade_over_100: number | null;
  description: string;
  due_date: string;
  due_time: string;
  submitted: boolean;
  late_allowed: boolean;
  comments: string;
  files: EvaluationFile[];
}

export interface CourseEvaluations extends CourseRef {
  evaluations: CourseEvaluation[];
}

const COMMUNITY_RE = /^([SVH])-(\d)-(\d{4})\./;
const COURSE_HREF_RE = /^\/dotlrn\/classes\/[^/]+\/([A-Z]{2,4}\d{3,4})\/([^/]+)\/?$/i;

export function parseCourseLinks(html: string): CourseRef[] {
  const $ = cheerio.load(html);
  const byKey = new Map<string, CourseRef>();

  $('a[href*="/dotlrn/classes/"]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim().replace(/\/+$/, '/');
    const match = href.match(COURSE_HREF_RE);
    if (!match) return;
    const [, code, communityKey] = match;
    const term = communityKey.match(COMMUNITY_RE);
    if (!term) return;

    const name = $(el)
      .text()
      .replace(/\bbeenhere\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!byKey.has(communityKey)) {
      byKey.set(communityKey, {
        code: code.toUpperCase(),
        community_key: communityKey,
        name: name || code.toUpperCase(),
        url: `${TEC_BASE}${href.endsWith('/') ? href : `${href}/`}`,
        year: parseInt(term[3], 10),
        term: parseInt(term[2], 10),
      });
    }
  });

  const all = [...byKey.values()];
  if (all.length === 0) return [];
  const rank = (c: CourseRef) => c.year * 10 + c.term;
  const maxRank = Math.max(...all.map(rank));
  return all.filter((c) => rank(c) === maxRank);
}

function parseScorePair(text: string): { score: number | null; max: number | null } {
  const m = text.replace(/\s+/g, ' ').match(/(-{1,2}|\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)/);
  if (!m) return { score: null, max: null };
  const score = m[1].startsWith('-') ? null : parseFloat(m[1].replace(',', '.'));
  return { score, max: parseFloat(m[2].replace(',', '.')) };
}

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

function decodeRichText(text: string): string {
  if (!/[&][a-z#]+;|&lt;|&amp;/i.test(text)) return text;
  const decodedOnce = cheerio.load(`<div>${text}</div>`)('div').text();
  const plain = cheerio.load(`<div>${decodedOnce}</div>`)('div').text();
  return plain.replace(/\s+/g, ' ').trim();
}

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

export function parseEvaluationsPage(html: string, courseUrl: string): CourseEvaluation[] {
  const $ = cheerio.load(html);
  const results: CourseEvaluation[] = [];

  const communityKey = courseUrl.match(/\/dotlrn\/classes\/[^/]+\/[^/]+\/([^/]+)\//)?.[1] ?? '';
  let category = '';
  let categoryWeight: number | null = null;

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

    const gradeEl = node.find('.vt_grade_student').first();
    const weightedText = gradeEl.find('.gradeW').first().text().trim();
    const weightedScore = weightedText ? parseFloat(weightedText.replace(',', '.')) : null;
    const { score, max } =
      weightedScore === null ? parseScorePair(gradeEl.text()) : { score: null, max: null };

    const description = (() => {
      const value = detailValue($, node, /^Descripción/);
      const text = value ? decodeRichText($(value).text()) : '';
      return /^(No hay descripción|Ver archivo adjunto)/i.test(text) ? '' : text;
    })();

    const dueText = (() => {
      const value = detailValue($, node, /^Fecha de Entrega/);
      return value ? $(value).text().trim() : '';
    })();
    const { date: dueDate, time: dueTime } = parseDueDate(dueText);
    const assignmentText = node.text().replace(/\s+/g, ' ').trim();
    // TEC Digital displays either timestamp only after the student submits.
    const submitted =
      /D[ií]a de entrega\s*:/i.test(assignmentText) || /Hora de entrega\s*:/i.test(assignmentText);

    const lateAllowed = radioIsYes($, detailValue($, node, /después de fecha límite/));

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

    const files: EvaluationFile[] = [];
    const seen = new Set<string>();
    const descriptionBlock = node
      .find('p.title_subsection')
      .filter((_, el) => /^Descripción/.test($(el).text().replace(/\s+/g, ' ').trim()))
      .first()
      .parent();
    descriptionBlock.find('a[href*="/evaluation/view/"]').each((_, a) => {
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
      submitted,
      late_allowed: lateAllowed,
      comments,
      files,
    });
  });

  return results;
}

export function resolveEvaluationUrl(href: string, courseUrl: string): string {
  const trimmed = href.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  const viewIdx = trimmed.indexOf('evaluation/view/');
  if (viewIdx === -1) return '';
  const base = courseUrl.endsWith('/') ? courseUrl : `${courseUrl}/`;
  return `${base}${trimmed.slice(viewIdx)}`;
}

export type CourseSelection = (course: CourseRef) => boolean;

export async function scrapeEvaluations(
  client: TecHttpClient,
  shouldScrapeCourse: CourseSelection = () => true,
): Promise<CourseEvaluations[]> {
  const portal = await client.client.get<string>(`${TEC_BASE}/dotlrn/`, { timeout: 30_000 });
  const discovered = parseCourseLinks(String(portal.data ?? ''));
  const courses = discovered.filter(shouldScrapeCourse);
  extractorLogger.info(
    { discovered: discovered.length, selected: courses.length },
    'Current-term courses selected for evaluations',
  );

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
