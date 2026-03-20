# AGENTS Guide for TecBot-api

This file briefs autonomous contributors on how to work inside the TEC Brain monorepo without surprises.
Read it end to end before touching code; it is the canonical agreement for agentic work here.

## Mission & Scope

- Automate TEC Digital scraping, notification dispatch, and Drive uploads across `apps/` and `packages/`.
- Primary apps: `apps/core` (orchestrator + API) and `apps/scraper` (Fastify scraper & download proxy).
- Shared logic lives under `packages/` (`database`, `drive`, `telegram`, `types`). Prefer reusing those exports.
- Google Drive uploads are not fully operational yet; keep document fallbacks via Telegram intact.

## Environment & Tooling

- Node.js 20+ and pnpm 9+ are mandatory (`package.json` enforces via `engines`).
- `pnpm install` sets up workspaces; never use npm/yarn.
- Secrets live in `.env` (copy from `.env.example`). Keep `DB_ENCRYPTION_KEY`, `INTERNAL_API_SECRET`, Telegram and Drive tokens private.
- Cursor/Copilot: there are no `.cursor/rules`, `.cursorrules`, or `.github/copilot-instructions.md` files, so this document is the only rulebook.
- Local session storage defaults to `data/sessions`; do not commit that directory.
- Docker Desktop or CLI is required for Postgres services defined in `infra/docker-compose.yml`.

## Essential Commands

- Install deps: `pnpm install`.
- Build everything: `pnpm build` (runs `pnpm -r build`).
- Lint: `pnpm lint` (ESLint across `apps/**/*.ts` and `packages/**/*.ts`).
- Format: `pnpm format` (Prettier write mode, config in `.prettierrc`).
- Test all packages: `pnpm test` (recursive Vitest runs via `pnpm -r test`).
- Focused test run per package: `pnpm --filter @tec-brain/core test` or replace filter with any workspace name.
- Single test file example: `pnpm --filter @tec-brain/core vitest run apps/core/tests/dispatcher.test.ts`.
- Single spec name example: append `-t "dispatch() should fan out"` to the command above for name-based filtering.
- Watch mode: `pnpm --filter @tec-brain/scraper vitest watch apps/scraper/tests/notifications.heuristics.test.ts`.
- Database migrations: `pnpm --filter @tec-brain/database migrate` (runs `node --loader ts-node/esm src/migrate.ts`).

## Runtime Shortcuts

- Scraper dev server: `pnpm dev:scraper` (tsx watch on `apps/scraper/src/index.ts`).
- Core orchestrator dev server: `pnpm dev:core`.
- Compose full stack: `docker compose -f infra/docker-compose.yml up -d --build` (core + scraper + Postgres).
- Compose database only: `docker compose -f infra/docker-compose.yml up -d db`.
- Deploy helper script: `./infra/deploy.sh` (pulls main, rebuilds compose, tails `core`).
- User bootstrap: `pnpm add-user "Nombre" "correo@estudiantec.cr" "password" "telegram_chat_id" "drive_root_id"` (encrypts TEC password automatically).

## Database & Data Safety

- Database tooling is centralized in `@tec-brain/database`; never talk to Postgres via ad-hoc clients outside that package.
- Encrypt secrets via `encrypt()` from the database package. Plaintext credentials must never cross module boundaries.
- Use `runMigrations()` on startup (already invoked inside `apps/core/src/index.ts`). Avoid writing new migration entry points elsewhere.
- When tests touch the database, prefer deterministic fixtures and clean up tables explicitly; there is no global test DB reset script yet.
- File sessions rely on `SessionManager` under `apps/scraper/src/sessions`; always reuse it for HTTP cookie jars.

## Testing Playbook

- Vitest is the single source of truth; do not introduce Jest or Mocha.
- Standalone unit tests live beside production code under `tests/` folders (see `apps/core/tests` and `apps/scraper/tests`).
- Prefer deterministic schedulers: stub timers (`vi.useFakeTimers`) when exercising cron logic.
- Current suites assume Node ESM; keep extensions explicit (`import './foo.js'`).
- For integration tests hitting Fastify, spin up instances via factory helpers (`buildServer`, etc.) and inject requests instead of binding to real ports.
- Keep tests side-effect free; interact with the filesystem via `tmp` directories routed through `SESSION_DIR` to avoid polluting `data/`.

## Code Style – Global Principles

- TypeScript is strict (`tsconfig.base.json`), NodeNext modules, ES2022 target.
- Use named exports; default exports are discouraged in existing code.
- Imports should favor workspaces (`@tec-brain/database`, `@tec-brain/types`, etc.) before relative paths.
- Keep import ordering pragmatic: Node built-ins, external, workspace, then relative; group by blank lines when it improves clarity.
- Each new import needs the `.js` suffix for intra-repo modules because of NodeNext resolution.
- Avoid `any`; ESLint flags `@typescript-eslint/no-explicit-any` as warnings, so choose narrower unions or generics.
- Unused parameters must be prefixed with `_` to satisfy the ESLint rule configured in `.eslintrc.cjs`.
- Use ESLint + Prettier before submitting changes; CI is light, so local compliance is critical.

## Formatting Rules (Prettier)

- Semicolons are required.
- Strings default to single quotes; use template literals where interpolation is needed.
- `tabWidth` is 2 spaces and tabs are forbidden in this repo.
- Trailing commas should appear in multi-line literals per `trailingComma: "all"`.
- Maximum line length is 100 characters; break long objects/arrays thoughtfully rather than ignoring formatting.
- Run `pnpm format` only on files you intend to commit to avoid churn.

## Error Handling & Logging

- Prefer throwing typed `Error` instances (or subclasses) with actionable messages; never throw raw strings.
- HTTP handlers must always resolve with Fastify replies; return sanitized payloads and log structured details separately.
- Use the provided `logger` (`apps/core/src/logger.ts`) or `fastify.log` instead of `console.log`.
- Include `component` and contextual identifiers (`userId`, `notificationId`, etc.) in log metadata.
- Gracefully degrade around external APIs (TEC Digital, Google, Telegram) by catching `axios` errors and inspecting `response.status` before choosing HTTP codes.
- When re-throwing database errors, wrap them with domain-specific context to simplify alerting.

## Types & Data Contracts

- Reuse shared interfaces from `@tec-brain/types` to avoid drift between core and scraper.
- Leverage the `satisfies` operator when returning DTOs to guarantee structural correctness (`ScrapeResponse`, etc.).
- Keep raw TEC Digital payloads in dedicated `Raw*` types to make transformation layers explicit.
- Environment-derived values should be parsed once (e.g., `parseInt(process.env.PORT ?? '3002', 10)`) and then treated as constants.
- Sensitive blobs (Drive tokens, TEC passwords) must be encrypted before persistence; inspect `encrypt()` usage for reference.

## Naming & File Layout

- File names stay kebab-case for modules (`session-manager.ts`), PascalCase for classes, camelCase for functions/variables, and SCREAMING_SNAKE_CASE for constants derived from env vars.
- Keep Fastify route files self-contained with request/response types declared inline like existing handlers.
- Utilities that cross packages should live in `packages/*` rather than `apps/*/utils` folders to keep layering tidy.

## Imports & Modules

- Always specify file extensions for local imports when referencing compiled TypeScript output (`import { foo } from './foo.js'`).
- Use `dotenv/config` at the top of entrypoints to avoid ad-hoc `config()` calls later in the lifecycle.
- Avoid circular dependencies between `apps/core` and `apps/scraper`; cross-module calls should flow through HTTP APIs or shared packages.
- When touching ESM interop with CommonJS libs, enable `esModuleInterop` already set in `tsconfig.base.json` instead of manual namespace hacks.

## HTTP & Scheduler Patterns

- Cron expressions default to the `CRON_SCHEDULE` env var; validate with `cron.validate` before scheduling (follow `apps/core/src/index.ts`).
- Long-running jobs should log start/end markers and include counters (processed notifications, failures, retries).
- Fastify schemas (zod-free) currently use JSON schema objects; extend them rather than switching libraries mid-file.
- For sequential scraping, follow the `SessionManager` flow: create/get client, reuse cookies, handle invalid session by re-login.
- Download proxy endpoints must stream buffers and forward content headers exactly as shown in `apps/scraper/src/server.ts`.

## Git & Workflow Expectations

- Never rewrite history on shared branches; favor feature branches even when working solo.
- Keep commits scoped (tests + implementation). Run lint/tests locally before requesting review.
- Document any non-obvious behavior changes in `NEXT_STEPS.md` or relevant docs under `docs/`.
- Update `tasks/todo.md` when planning multi-step efforts to align with the orchestration process enforced for agents.
- If you receive user feedback, append lessons to `tasks/lessons.md` (create if missing) per CLAUDE instructions.

## Reference Pointers

- Architecture overview: `README.md` (stack, services, runbooks).
- Status tracker: `docs/status/PROJECT_STATUS.md`.
- Deployment automation: `infra/deploy.sh` and `infra/docker-compose.yml`.
- Incoming roadmap: `NEXT_STEPS.md` at repo root.
- Tests of interest: `apps/scraper/tests/notifications.heuristics.test.ts`, `apps/core/tests/dispatcher.test.ts`, and `apps/core/src/tests/orchestrator.test.ts`.
- Secrets examples: `.env.example` plus docs in `README.md` under “Configuración rápida”.
- Data directory: `data/` (sessions, temp files); ensure `.gitignore` continues to cover any new subfolders.

## Operational Tips & Alerts

- Prefer `docker logs -f tec-brain-core` / `tec-brain-scraper` for runtime debugging instead of sprinkling console prints.
- Check Fastify `/health` endpoints (ports 3001/3002) before triggering manual jobs to avoid cascading failures.
- Use `/api/run-now` for manual orchestration triggers; pair it with log tailing to confirm completion.
- Keep `CRON_SCHEDULE` realistic for TEC Digital rate limits; 5-minute cadence is the default safe value.
- Configure `SESSION_DIR` on SSD-backed storage when running inside containers to prevent slow cookie jar writes.
- Always store Drive OAuth files outside the repo and mount them through env-driven paths such as `GOOGLE_OAUTH_CLIENT_PATH`.
- When replaying downloads, rely on `/download-file` so that cookies remain encapsulated in the scraper process.
- Telegram fallbacks remain the source of truth for documents until Drive uploads succeed; do not delete fallback logic.
- Drive tokens vencen con frecuencia: si Google responde `invalid_grant`, el dispatcher avisa al usuario vía Telegram (cooldown 12h) para que ejecute `/actualizar`; mantén ese flujo activo al tocar la integración.
- Prefer environment toggles over ad-hoc feature flags; document any new toggle in `.env.example`.
- When adding monitoring, expose metrics through Fastify routes or logs rather than introducing new dependencies mid-stack.
- Before cutting a release, rerun migrations and re-encryption helpers locally to ensure drift-free deployments.

Stay pragmatic, fail loudly in logs, and favor shared abstractions over copy/paste. Welcome aboard.
