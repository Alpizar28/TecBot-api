import { describe, it, expect } from 'vitest';
import {
  classifyType,
  extractCourse,
  ensureAbsoluteUrl,
  shouldDeleteFromTec,
} from '../src/extractors/notifications.js';

describe('notifications heuristics', () => {
  it('classifies document notifications from file-storage links', () => {
    expect(classifyType('', 'Nuevo material disponible', '/dotlrn/file-storage/#/123#/')).toBe('documento');
  });

  it('classifies evaluation notifications from keywords', () => {
    expect(classifyType('', 'Se publico examen parcial', '/dotlrn/classes/EL2207')).toBe('evaluacion');
  });

  it('extracts course from labeled text', () => {
    expect(extractCourse('Curso: Matematica Discreta | Se subio material')).toBe('Matematica Discreta');
  });

  it('extracts course from separator', () => {
    expect(extractCourse('EL2207 - Se actualizo el contenido del curso')).toBe('EL2207');
  });

  it('normalizes relative TEC urls', () => {
    expect(ensureAbsoluteUrl('/dotlrn/classes/EL2207')).toBe('https://tecdigital.tec.ac.cr/dotlrn/classes/EL2207');
  });

  it('deletes in TEC only when dispatch confirms processed true', () => {
    expect(shouldDeleteFromTec(200, { status: 'success', processed: true })).toBe(true);
    expect(shouldDeleteFromTec(200, { status: 'success', processed: false })).toBe(false);
    expect(shouldDeleteFromTec(500, { status: 'success', processed: true })).toBe(false);
    expect(shouldDeleteFromTec(200, { status: 'error', processed: true })).toBe(false);
  });
});
