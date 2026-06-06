# Features Service — CLAUDE.md

## Quick Start

```bash
npm run dev          # Start dev server (tsx watch)
npm run test         # Run tests (vitest)
npm run build        # TypeScript compile
npm run db:generate  # Generate Drizzle migrations from schema
npm run db:push      # Push schema to DB (dev)
npm run db:migrate:prod  # Run migrations on prod (tsx scripts/migrate-prod.ts)
npm run generate:openapi # Regenerate openapi.json from Zod schemas
```

## Stack

- TypeScript (strict), Express, Zod, Drizzle ORM, Postgres (Neon)
- Tests: Vitest + Supertest
- OpenAPI: auto-generated from Zod schemas via `@asteasolutions/zod-to-openapi`
- Deployed on Railway via Dockerfile

**Package manager: pnpm is canonical.** The repo ships BOTH `package-lock.json` and
`pnpm-lock.yaml`, but CI runs `pnpm test`. On a fresh Conductor workspace (`node_modules`
absent), install with `pnpm install --frozen-lockfile` — not `npm ci` — so the local tree
matches CI. The `npm run <script>` aliases above still work once deps are installed (pnpm
just runs the same `package.json` scripts).

## CI test flake — `EnvironmentTeardownError`

CI's `pnpm test` runs every suite **twice** — once from `src/*.test.ts` and once from the
compiled `dist/*.test.js` — so console output volume is doubled. This intermittently trips a
vitest worker-teardown race: `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog"
was pending` (often attributed to `src/routes/features.test.ts`). It surfaces as **1 unhandled
error with ALL tests passing** (`407 passed`, `1 error`, exit 1). It is a non-deterministic
flake, NOT a logic failure: if the summary shows all tests green + only this teardown error,
**rerun the job** (`gh run rerun <runId> --failed`) — it passes on retry. Do not chase it as a
code bug. Follow-up worth doing: make CI run src OR dist, not both (halves runtime + the flake).

## Key Files

| File | Purpose |
|------|---------|
| `src/db/schema.ts` | Drizzle table definition (source of truth for DB shape) |
| `src/lib/schemas.ts` | Zod schemas for request validation |
| `src/lib/openapi.ts` | OpenAPI spec generation (response schemas + path registration) |
| `src/lib/stats-registry.ts` | Stats key registry (raw + derived keys) |
| `src/routes/features.ts` | All feature CRUD endpoints |
| `src/routes/stats.ts` | Stats computation endpoints |
| `src/seed/features.ts` | Seed feature definitions (registered at cold start) |
| `src/middleware/auth.ts` | API key + identity header auth |
| `openapi.json` | Generated — never edit manually |

## OpenAPI Rule

Every new or changed endpoint requires THREE changes in the same PR:
1. Zod schema in `src/lib/schemas.ts` (note: the `/revenue` + `/stats` response schemas
   actually live inline in `src/lib/openapi.ts`, NOT `schemas.ts` — add new response
   schemas where the sibling ones already are)
2. Path entry in `src/lib/openapi.ts`
3. Re-generated `openapi.json` (run `npm run generate:openapi`)

**Polymorphic 200 (`z.union`) — build the union from the `registry.register()` RETURN
values, not the raw schema instances.** A route that returns two shapes (e.g. `/revenue`
overview vs `?groupBy=campaignId` grouped) needs `200: { schema: z.union([refA, refB]) }`.
If you pass the raw `xSchema` instances, zod-to-openapi INLINES both bodies as `anyOf`
(orphans the named components + bloats `openapi.json` by hundreds of lines). Capture the
ref: `const refA = registry.register("Name", xSchema)` and put `refA` in the union → clean
`oneOf`/`anyOf` of two `$ref`s. (Set 2026-06-07, v0.40.1 revenue groupBy — cost one regen.)

**Scope:** this rule covers ENDPOINT shape changes. Editing seed feature `inputs`/`outputs`
content in `src/seed/features.ts` does NOT touch OpenAPI — the schema is `inputs: z.array(z.any())`,
so seed content never appears in `openapi.json`. No regen needed for seed-data edits.

## Seed feature inputs — `description` is an extraction prompt

In `src/seed/features.ts`, each input's `extractKey` + `description` are double-duty. The
`POST /features/:slug/prefill` route maps every input to `{ key: extractKey, description }` and
sends it to brand-service `extract-fields`, which AI-extracts the value from the brand site
(cached 30d per brandId+fieldKey+campaignId). So **`description` must be written as an
extraction-quality prompt**, not just UI help text — it's what brand-service's LLM reads to find
the value. Pick a clear `extractKey`; org name/url/logo are already known by construction (don't
ask), prefer extraction over user-entry for anything scrapeable.

## Revenue engine is time-dependent — decay tests need RELATIVE dates

`computeRevenue` defaults `now = Date.now()` and the `/features/:slug/revenue` route calls it
with no `now`. So any stage that carries a `staleAfterMs` decay window (sales funnel:
contacted/sent/delivered/open, and Phase 2 reply→meeting 14d / meeting→close 30d) is evaluated
against wall-clock. **Test fixtures for a windowed stage MUST use relative dates** (`daysAgo(n)`),
never fixed ISO strings — a fixed past date silently crosses its window as real time advances and
the test rots. This bit Phase 2 (#214): Phase 1's route happy-path fixture pinned a reply at
`2026-02-01`; once reply gained a 14d window that 4-month-old reply decayed and the assertion
flipped 140→20. Engine unit tests sidestep this by passing an explicit `NOW` constant +
`ago(days)` helper — mirror that. Terminals with no window (click `visit`, `closeWin`) are
date-safe. Close-win books **full LTR** (realized revenue) and is immune to decay.

## Two expert-quote features — don't conflate

- `pr-expert-quote-outreach` — autonomous PR quote outreach.
- `pr-expert-quote-opportunities` — HITL ranked queue (review → generate → send manually). `inbox` icon, displayOrder 10.

Near-identical inputs/outputs/charts. Confirm the exact slug before editing — they diverge by intent.
