# Next steps - Fix notifications

## Current issue

- Scraper fails to re-login because it cannot write cookies to `data/sessions/`.
- Error seen: `EACCES: permission denied, open 'data/sessions/'`.
- Result: login retries fail and core receives 500 from scraper.

## Required fix (Coolify)

1. Ensure scraper uses a writable session directory.
   - Temporary (no persistence):
     - Set `SESSION_DIR=/tmp/tec-sessions` in the scraper service.
   - Persistent (recommended):
     - Mount a volume to `/app/data` in the scraper service.
     - Set `SESSION_DIR=/app/data/sessions`.

2. Restart the scraper service.

3. Wait for the next cron cycle or trigger a manual run.

## Expected result

- Scraper should save cookies and complete re-login automatically.
- Core should report `notificationsDispatched > 0`.

## If it still fails

- Check scraper logs for:
  - `Could not retrieve notifications via API` with `contentType` and `preview`.
  - Any login errors or `socket hang up`.
- If needed, increase login retry/timeout.
