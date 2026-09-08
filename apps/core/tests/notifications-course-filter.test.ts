import { describe, expect, it } from 'vitest';
import { shouldProcessNotificationCourse } from '../src/scraper/notifications.js';

describe('shouldProcessNotificationCourse()', () => {
  it('skips both CE2201 laboratory groups before resolving their content', () => {
    expect(
      shouldProcessNotificationCourse(
        'https://tecdigital.tec.ac.cr/dotlrn/classes/CES/CE2201/S-2-2026.CA.CE2201.1/file-storage/',
      ),
    ).toBe(false);
    expect(
      shouldProcessNotificationCourse(
        'https://tecdigital.tec.ac.cr/dotlrn/classes/CES/CE2201/S-2-2026.CA.CE2201.2/file-storage/',
      ),
    ).toBe(false);
  });

  it('keeps notifications from other courses', () => {
    expect(
      shouldProcessNotificationCourse(
        'https://tecdigital.tec.ac.cr/dotlrn/classes/CES/CE1107/S-2-2026.CA.CE1107.1/file-storage/',
      ),
    ).toBe(true);
  });
});
