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

## `GET /features/:slug/candidates` — audience grain is LIVE (audience rung emits real per-audience evidence)

The candidate-evidence endpoint (`src/routes/candidates.ts`, PR #299/#298; audience grain wired in)
serves the `(audienceId, workflow)` candidate SET for campaign-service's runtime per-couple selection
(uncertainty-aware / Thompson). Each candidate carries its own `costPerOutcomeUsd`, separate
`conversion`/`cost` evidence, and a labelled `grain` ladder (`audience` → `brand-goal` →
`goal-global`). The coarse rungs reuse the workflow-projection data path
(`buildUpgradeChains`/`aggregateAcrossChains` + `fetchEffectiveEconomics` + `projectOutcomeCosts`).

**Sample size lives WITH the cost evidence, NOT at the candidate top level (data-honesty fix).** A
coarse row resolves its CONVERSION at brand level (`conversion.grain:"brand-goal"`, the brand's own
saved economics) but its COST from the cross-org workflow population (`cost.grain:"goal-global"`). The
sample (runs/contacted/clicks/replies) is ENTIRELY a cost-side artifact, so it lives at
`cost.sampleSize` labelled by `cost.grain` — there is NO top-level `sampleSize`. This prevents the
Pocket-CMO trap: a brand that signed up today (saved 8% signup economics, sent 4 emails, 0 clicks)
returned coarse rows whose single top-level `grain:"brand-goal"` sat next to a single `sampleSize`
showing `contacted` in the thousands / `runs` ~80k — the cross-org cost sample mis-read as the brand's
own. Now `cost.sampleSize` + `cost.grain:"goal-global"` make the cost provenance/size legible
SEPARATELY from `conversion.grain`. The top-level `grain` is a SUMMARY label only (finest grain across
components); it does not describe the sample, and the two components can resolve at different grains.
`conversion.sampleSize` is ALWAYS null — the rate comes from brand-service saved economics, which
carry no per-grain observation count (brand-service#242). campaign-service (the only consumer) ranks
on `costPerOutcomeUsd` and never read top-level `sampleSize`, so the move is zero-blast.

**Null `costPerOutcomeUsd` on a thin cross-org sample is INTENDED — it's a zero-denominator gate, not
a thinness threshold.** `costPerOutcomeUsd` needs a `clickUsd` (and/or `replyUsd`) denominator; a
workflow with `contacted>0` but 0 clicks/replies yields `cost.costPerLeadUsd` present (contacted
denominator) yet `clickUsd`/`replyUsd` null → `projectOutcomeCosts` returns null. Can't project
cost-per-signup without a per-click cost. Do NOT add a smoothing/floor to force a number.

**The `audience` rung is LIVE.** For each ACTIVE human-service audience that has runs-attributed
`(audienceId × workflowDynastySlug)` couples, the endpoint emits one audience candidate per couple via
`src/lib/candidates-audience.ts` `fetchAudienceCandidateEvidence` — `audienceId` non-null,
`grain:"audience"`, `cost.grain:"audience"`. Evidence is **audience-grain (single coherent grain per
row)**: cost from runs `groupBy=audienceId` (byte-identical numerator to `/audience-stats`), outcomes
from read-time membership (`fetchAudienceMemberEmails` → `fetchEmailOutcomes`, explicit provenance, no
send-tagging). A second runs call `groupBy=audienceId,workflowDynastySlug` enumerates WHICH workflows
ran for the audience (the couple keys; runs `GET /v1/stats/costs` does `groupBy.split(",")` +
dynasty-rollup). **Per-workflow OUTCOME splitting does NOT exist in the fleet** (send/engagement is not
workflow-tagged — staging gap notes #366/#367, workflow-service#321), so each of an audience's couple
rows carries the SAME audience slice; per-workflow cost discrimination stays on the coarse
`audienceId:null` rows. `conversion.rate` stays brand-goal/goal-global on audience rows too —
brand-service has no per-audience economics (**brand-service#242**) — so the audience's empirical tally
rides in `sampleSize` for the consumer.

**Do NOT mix grains within an audience row** (option-A trap, rejected): couple-exact cost ÷ audience-grain
clicks is arithmetically incoherent when an audience ran >1 workflow. Cost ratios + sampleSize are all
audience-grain. Couples with no audience-level evidence keep `audienceId:null` and fall through the
coarse ladder unchanged — additive, no shape change for existing per-workflow consumers (campaign-service
already handles `audienceId:null`). `customerProfileId` is fully purged from this endpoint (audience
grain replaced it). Does NOT touch `workflow-projection` / `stats/ranked`. (Set 2026-06-21.)

## `GET /features/:slug/audience-stats` — ranked human-service AUDIENCES (persona-stats alias DELETED, PR #351→ removal)

The ranking endpoint is `audience-stats` (`src/routes/audience-stats.ts` → shared compute
`src/lib/audience-stats-compute.ts`). The legacy `persona-stats` alias (old `personas`/`persona`
response shape) was **DELETED** — there is NO persona-named surface anymore, no legacy, no fallback.
Consumers (campaign-service, api-service proxy, distribute.you) read `audiences`/`audience`.

It sources ranked candidate filter-sets from **human-service active audiences** via
`src/lib/human-client.ts` `fetchActiveAudiences` → `GET /orgs/audiences?brandId=<uuid>&status=active`.
Each row keys on `audienceId` (= `audience.id`); `audience.filters` is the structured audience filter
shape (faithful passthrough). `brandProfileId` comes from brand-service `fetchCurrentBrandProfile`
(separate entity — leave it). Response: top-level `audiences` array, each row `{ audienceId,
brandProfileId, audience:{id,name,status,filters}, evidence, metrics }`. **No `customerProfileId` —
fully purged, no deprecated alias on the row.**

**Org-scoped — settled, do NOT re-litigate.** Audiences are org-scoped. The ranking evidence
(`fetchAudienceCosts`/`fetchAudienceOutcomes`) is ALREADY org-scoped (filtered by `x-org-id`), so a
cross-org candidate carries zero evidence → null metrics → sorted last → never `audiences[0]`
(campaign-service calls with `limit=1`). Building a brand-scoped audiences read would only resurrect
zero-evidence rows that never rank.

**Cost attributed via `audienceId` write-tag, NOT read-time inference.** `fetchAudienceCosts` reads
runs-service `groupBy=audienceId` (`x-audience-id` attribution from runs-service #154; campaign-service
#204 sets it on the workflow root run, runs inherits it down the tree). `audienceIdFromDimensions`
reads `dimensions.audienceId` ONLY — no `customerProfileId` fallback. Cost is EXACT (one workflow
execution = one priority audience → its run tree maps to one audience; no allocation).

**KNOWN UPSTREAM GAP — per-audience cost is currently UNDER-stated (~20-30x), and the fix is NOT
here.** The `audienceId` write-tag only reaches the LEAD-DISCOVERY runs (`lead-serve`,
`apollo people-search`, `apify search`). The dominant cost — `instantly-service` email-SEND runs
(`email-send-step-1/2/3`) + `chat-service complete` / `content-generation single-generation` LLM
message-GEN — runs INSIDE the per-lead `forloopflow` body of the SAME `execute-workflow` DAG, but
those body nodes never receive `x-audience-id` so `run.audience_id` is NULL. Root cause is in
**workflow-service** (`dag-to-openflow.ts`): it threads `audienceId` from campaign `/start-run`'s
result into descendant nodes as `results.<start_run>?.audienceId`, which resolves for top-level
lead-finding nodes but NOT inside the nested for-each-lead loop → gen/send body nodes untagged.
Measured prod (brand `f4d73dab…`, this feature): only **$10.59 of $346.26 actual cost (3%)** carries
an `audienceId` → CPC reads $0.24 where ~$5 is real. **Do NOT "fix" this in features-service by
reverse-joining lead→audience→send cost** — that is working around another service's gap (forbidden).
Tracked in **workflow-service#321**; features-service sums what is tagged and stays correct with ZERO
change as coverage improves. (Set 2026-06-21.)

**The cost NUMERATOR must NOT be filtered by `goal`/`brandProfileId` — only `brandId` +
`featureSlugs` (+ `workflowDynastySlug` in `pipeline-activity`).** runs/cost rows are tagged with
`audienceId` but NOT `goal`/`brandProfileId` (both NULL in prod — 0 of ~42k cost rows carry a
non-null `goal`), so adding either as a runs `/v1/stats/costs` filter drops EVERY real cost row →
`totalCostInUsdCents=0` → `ratioCents(0, clicks)` returned a false **$0.00** CPC (and broke
campaign-service's `limit=1` pick — a false-$0 sorts first). Conceptually a campaign's spend to reach
an audience is not partitioned by goal: `goal` selects the METRIC/DENOMINATOR (cpc vs cppr,
`sortMetricForGoal`), never which spend counts. `ratioCents` returns **null** (renders "-") when cost
is 0 — never a false $0.00, even for an audience with clicks whose runs were never `audienceId`-tagged.
Do NOT "re-add goal scoping" thinking it's missing; it's deliberately absent until the writer tags
goal AND it's proven correct for the numerator. (Set 2026-06-21, hotfix v0.59.1.)

**Outcomes resolved READ-TIME from explicit membership.** `fetchAudienceOutcomes`: recipient emails →
human-service membership (`fetchAudienceMemberEmails`, provenance populated by serve-next +
lead-service#295) → per-email broadcast flags from email-gateway. **No inference / no send-tagging /
no enrichment** — explicit provenance only (human-service#42). Forward-only: only campaigns served via
audiences after #295 get attributed; historical = unattributed, acceptable.

`HUMAN_SERVICE_URL`/`HUMAN_SERVICE_API_KEY` are read at CALL time (no boot crash) and fail loud when
the targeting read runs without them — no fallback. (Set 2026-06-19; persona-stats alias removed 2026-06-20.)

## Spend naming convention: `total…`=committed (actual+provisioned), `actual…`=billed, `provisioned…`=holds — `/revenue` `spend` shows COMMITTED; ROI stays ACTUAL (PR #396, committed-naming PR #403)

runs-service `/v1/stats/costs` returns BOTH `totalCostInUsdCents` (committed = actual + **provisioned
holds**) and `actualCostInUsdCents` (only `actual` is billable spend) per group. The service-wide naming
convention (a field name must never lie about its accounting):

- **`total…`** = COMMITTED = ACTUAL + PROVISIONED (money already reserved, incl. open holds for
  scheduled follow-up sends). The customer-facing "Total spent" / "Budget spent today" / "CPC". It
  legitimately **DIPS** when a hold releases (a follow-up actualizes → net-zero; a cancelled hold → drop).
- **`actual…`** = actualized / billed spend only. ROI/CAC and projected cost-per-outcome ride THIS.
- **`provisioned…`** = open holds only (= total − actual).

**The `/revenue` `spend` block displays COMMITTED** (PR #403 — product wants customers to see reserved
money, not only billed). `lib/spend-client.ts` `fetchSpendBreakdown` reads BOTH runs fields and derives
provisioned = total − actual. The block exposes nine fields, each `total… = actual + provisioned`:
`{total,actual,provisioned}SpentCents`, `{total,actual,provisioned}SpentTodayCents` (via `startedAfter`),
`{total,actual,provisioned}CpcCents`. `sources[]{totalSpentCents,actualSpentCents,provisionedSpentCents,
sharePct}` (sharePct = share of committed). Reconciled BY CONSTRUCTION: each top-level total/actual/
provisioned == Σ over `sources`; each `…CpcCents` = its OWN spend ÷ `clicked.total`; null-safe. The
projected `cpsCents`/`cpsmCents` (cost-per-signup / -sales-meeting) were REMOVED from the block (PR #406,
breaking) — do NOT re-add them here; cost-per-outcome projection lives in `workflow-projection` /
`/public/stats/cost-projection`, not the `spend` block. `spend` is on the OVERVIEW only (null on
`?lens=`, absent on `?groupBy=campaignId` groups). fail-loud.

**ROI/CAC + `costEconomics` ride REALIZED (ACTUAL) spend, NOT committed.** `fetchRunsCostCents`
(revenue.ts) sums `actualCostInUsdCents` → `costEconomics.actualCostUsd` (renamed from the ambiguous
`totalCostUsd` in PR #403 so it is unmistakably distinct from the committed `total…` figures) — brand +
grouped + lens + public revenue. ROI = `pipeline / actualCostUsd`, CAC = `actualCostUsd / pipeline`.
Counting reserved-but-unbilled holds as cost-spent would understate ROI on money not yet billed.

- `/stats` `systemStats.actualCostInUsdCents` (alongside `totalCostInUsdCents`) + the stats-registry
  `actualCostInUsdCents` raw key, to which **every `costPer*Cents` derived numerator points** (incl.
  `costPerOutletCents`). **Already** convention-compliant (actual = billed, total = committed) — NOT
  renamed by #403.
- `workflow-projection` `roiMultiple = LTR / costPerCloseUsd` (budget-independent, = 100/cacPct) — the
  dashboard renders it instead of inverting `cacPct` client-side.

Null-safe convention (mirrors per-audience `metrics.cpcCents`): a ratio is **null** (renders "-"), never
a false **$0.00**, when its denominator OR the attributed spend is 0. Do NOT add a smoothing/floor to
force a CPC number. The per-audience `/audience-stats metrics.*Cents` (and `pipeline-activity` cpc) still
key on `totalCostInUsdCents` (committed) and are INTENTIONALLY left untouched (provisioned component
negligible at that grain; **campaign-service consumes `metrics.cpcCents` byte-equal** via
`features-audience-client.ts`, so renaming there would break it — out of scope). (Set 2026-06-26;
committed-spend on `/revenue` + total/actual/provisioned naming 2026-06-27, PR #403.)

## `pipeline-activity.ts` — forecasting migrated to audiences; `customerProfileId`/brand-persona vocabulary PURGED (PR #346)

`pipeline-activity.ts` (the budget→forecast endpoint) was the LAST `customerProfileId` / brand-persona
consumer. It now mirrors audience-stats exactly: candidates from human-service active audiences
(`fetchActiveAudiences`), cost from runs `groupBy=audienceId` (`dimensions.audienceId`, no legacy id
fallback), engagement from read-time membership (`fetchAudienceMemberEmails` → `fetchEmailOutcomes`,
explicit provenance — no send-tagging/inference). `fetchBestAudienceForecast` picks the lowest-CPC
active audience for the chosen workflow (CPC = runs cost / membership clicks) and derives its rates
from the SAME outcome tally (one pass). `fetchBrandPersonas`/`BrandPersona` are DELETED from
`brand-client.ts` (zero remaining callers); `fetchCurrentBrandProfile` stays (still feeds the cost
`brandProfileId` filter). **`git grep -i customerprofile src` now returns ZERO matches** — the field is
fully purged (the `audience-stats.test` no-legacy guard asserts `r.persona`/`personas` absent instead). campaign-service
already reads `personas[0].audienceId` and asserts `customerProfileId` absent (campaign-service#204,
drizzle 0035), so the purge had zero consumer blast radius — the prior "do NOT remove until T5" note was
stale (T5 was already done).

All forecast rates are AUDIENCE-GRAIN from one membership tally: `openPerOutreach = opened/contacted`,
`clickPerOutreach = clicked/contacted`, `positiveReplyPerOutreach = positiveReplies/contacted`.
`fetchEmailOutcomes` reads the email-gateway broadcast `brand` scope booleans
`contacted`/`opened`/`clicked` + positive-reply (all are required fields on the
`POST /orgs/status` contract). The caller still falls back to the chosen workflow's aggregate rates
when NO audience qualifies (no clicks). Don't mix grains — opens/clicks/replies must all come from the
same audience tally so the forecast stays internally coherent (a workflow-grain open rate beside an
audience-grain click rate was a bug, fixed PR #349). (Set 2026-06-20.)

## Migration gotcha — drizzle-kit meta snapshot is DRIFTED; strip spurious `features` drops

`drizzle/meta/` is out of sync with the live `features` table (a prior schema simplify edited
`schema.ts` without a matching migration). So **every** `npx drizzle-kit generate` re-emits
unrelated teardown of `features` — `DROP COLUMN display_name/category/channel/audience_type/
signature/forked_from/upgraded_to`, `DROP INDEX idx_features_signature`, and a **no-`IF EXISTS`
`ALTER TABLE features DROP CONSTRAINT features_signature_unique`** that will **crash-loop boot**
if those objects are already gone (migrations run at boot; a throw = Railway restart loop).

When you generate a new migration, **hand-strip the SQL down to ONLY your intended statements**
before committing (the runtime migrator checks journal `when`-ordering, not content, so editing the
`.sql` is safe; leave the `meta/*_snapshot.json` as the new baseline). Reference: `0006_gold_view_
snapshots.sql` was stripped to just its `CREATE TABLE`/`CREATE INDEX`. Reconciling the meta drift
fully (so generate stops re-emitting the `features` drops) is a deferred follow-up. (Set 2026-06-15, PR #293.)

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

## CI test flake — `EnvironmentTeardownError` (FIXED v0.41.3)

**Fixed.** `vitest.config.ts` now sets `include: ["src/**/*.test.ts"]` so vitest collects
tests from `src` ONLY. Previously CI ran `pnpm build` (emits `dist/*.test.js`) before
`pnpm test`, and vitest's default glob picked up BOTH src and dist — running every suite
**twice**, doubling console output and intermittently tripping a vitest worker-teardown race:
`EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`. It surfaced as
**1 unhandled error with ALL tests passing** + exit 1. The src-only `include` halves runtime
and removes the flake at the source. If a teardown error ever recurs despite this, confirm no
new `include`/dist glob crept back in (`pnpm exec vitest list` must show only `src/` files).

## Issue-tag in code comments — NEVER reuse the brief's *sibling* issue number for THIS work

This repo tags features in code/OpenAPI describe strings with `features-service#NNN`. When a brief
references a sibling issue (e.g. "#388 is reconciling /stats — stay out of it"), that number is NOT
this work's tag. Do NOT bake a specific `#NNN` into comments before confirming the number belongs to
the current change — create the work's own issue first (or use the PR number) and tag with THAT.
Baking the sibling's number in forces a doc-fix follow-up PR. Cost 2026-06-25 (repliedPositive series,
PR #389): tagged the new series `features-service#388` (the /stats sibling) before #390 existed →
needed PR #391 to correct the OpenAPI describe strings #388→#390.

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

## Public cost-per-outcome is PROJECTED (EV math), NOT the real tracked meeting/closed counts

`GET /public/stats/cost-projection?featureSlug=` returns feature-wide EXPECTED `$/meeting-booked` +
`$/purchase` for the landing. Real meeting-booked / closed events ARE tracked (instantly manual
qualifications, `instantly_manual_qualifications_raw` — the SoT the revenue engine reads via
`qualifications-client.ts`) but **thinly populated** (≈1 meeting / 4 closed in prod, 2026-06). So the
public proof metric uses the PROJECTION, not the real counts. Do NOT re-propose exposing the raw
tracked counts as the landing number — that path was considered and rejected for being too sparse.

The math is the SAME EV funnel as the revenue engine / `workflow-projection`, single-sourced through
`projectOutcomeCosts(econ, {clickUsd, replyUsd})` in `funnel-registry.ts`:
`closesPerBudget = (1/clickUsd)·orP(v2c, v2m·m2c) + (1/replyUsd)·(r2m·m2c)`, `costPerPurchase =
1/closesPerBudget`; `meetingsPerBudget = (1/clickUsd)·v2m + (1/replyUsd)·r2m`, `costPerMeeting =
1/meetingsPerBudget`. Per brand pick the best workflow PER METRIC (lowest cost), then unweighted mean
across client brands; null only when no brand has usable economics. No forced ordering between the two
costs — high self-serve `v2c` lets purchases bypass meetings, so cost-per-meeting CAN exceed
cost-per-purchase (correct, not a bug). (#274, PR #275.)

## Revenue close-paths — combine via independent-OR (`orP`), NEVER `max`; ranking is objective-agnostic

A lead reaches a close through MULTIPLE non-exclusive paths and they must be COMBINED, not MAX'd —
`max` silently drops the weaker path and undercounts the pipeline. Two combine rules, two relations:

- **A click closes via two independent routes** — direct self-serve (`visitToClosePct`, defined in
  the dashboard sales-economics card as *"buy without a meeting (self-serve)"*) OR via a booked
  meeting (`visitToMeetingPct · meetingToClosePct`). Combine: `pCloseClick = orP(v2c, v2m·m2c)`.
- **A delivered-but-unengaged lead** can take the click route OR the reply route → `pCloseDeliv =
  orP(click·pCloseClick, reply·pCloseReply)`.

`orP(a,b) = 1−(1−a)(1−b)` (≥ max, ≤ sum, ≤ 1) lives in `funnel-registry.ts` (exported); it's the
probability twin of the engine's `combineIndependent` (which combines in EV/dollars). The engine's
`maxSingleEv` legitimately stays `max` — that's the lead's FURTHEST funnel POSITION (delivery vs
meeting vs closeWin: a lead is at exactly one), not a set of independent close-paths.

**`max` here was a real bug (#229).** It dropped the second click route everywhere (`/revenue` brand
+ campaign + groupBy AND `workflow-projection`). Before calling any close-path math "correct", check
the brand-service field SEMANTICS — `visitToClose` is the DIRECT/self-serve close, NOT the all-routes
click→close, so it's disjoint-but-independent from the meeting route and MUST be combined.

**workflow-projection is objective-agnostic** — a workflow makes both clicks and replies, so the
`objective` (meeting-booked/self-serve) does NOT gate which paths count. `closesPerBudget =
(1/clickUsd)·orP(v2c, v2m·m2c) + (1/replyUsd)·(r2m·m2c)` (click-vs-reply ADD by linearity at the
population level; the click's two sub-paths combine via orP). `objective` is no longer required and
no longer affects the math — it's still accepted + echoed in the response for dashboard back-compat
(the dashboard `WorkflowProjectionResponseSchema.objective` is a required enum; removing it from the
response breaks `safeParse`). Don't re-add objective gating. (#229, v0.41.1.)

## Public stat families are INDEPENDENT — fetch via `Promise.allSettled`, never `Promise.all`

`handleRanked`/`handleBest` → `fetchOutcomeStats` (`src/routes/public.ts`) fans out to SEVERAL
independent upstream stat families (email-gateway recipient stats, journalists stats; the registry
has more sources but only these two are fetched today). They are NOT a transaction — one family's
health says nothing about another's. `Promise.all` rejects the WHOLE batch if ANY member rejects, so
a single upstream outage (e.g. journalists-service 500 from instantly-service being down) made the
batch reject → `handleRanked` returned empty outcomes → `computeGroupStats` defaulted EVERY recipient
stat to 0 while the separately-computed `totalCostInUsdCents`/`completedRuns` survived. That's the
"200 OK, all funnel stats = 0, cost populated" prod incident.

Use `Promise.allSettled` and merge only fulfilled families. A rejected family is **logged loudly**
(`console.error` with `featureSlug` + `groupBy` + reason — fail-loud per family) and contributes no
keys; its stats default to 0/null downstream, but the succeeding families still populate. Do NOT
re-introduce `Promise.all` here, and do NOT swallow a family failure silently (no bare `.catch(()=>{})`).
The DOD is "succeeding families never zeroed by a sibling's failure", NOT "failures masked as zero".
Keep the cost/runs path (`fetchPublicCosts`, the outer `Promise.all` in `handleRanked`) untouched —
cost is essential, not an optional outcome family. (Set 2026-06-08, PR #248 stat-families resilience.)

## `/revenue` Overview actual series — ALL four graph actuals come from ONE `leads[]` snapshot (PR #384, #385)

The brand Overview graph renders four ACTUAL series (Outreach, Opens, Clicks, goal-outcome) + a
conversions table that MUST all describe the SAME leads. `/revenue` server-computes each series from
the SAME `leads[]` snapshot, via `buildSignalSeries(leads, has, dateOf)` in `revenue-engine.ts`
(`buildContactedSeries` delegates to it). Response fields, each a `{total, daily, undatedCount}`:
`outreachContacted` (contacted, #371/#372), **`opened`** (signal `open`), **`clicked`** (signal
`clicked`), **`meetingsBooked`** (signal `meeting`), **`purchased`** (signal `closeWin`). Built in
all three sites (`computeFeatureRevenue`, `buildLensBody`, `emptyBody`) via `buildOutcomeSeries`.

**Coherent BY CONSTRUCTION — do NOT re-source any actual from pipeline-activity/instantly.** The
prior bug: Outreach read the snapshot aggregate but Opens/Clicks/Signups still came from
`pipeline-activity` (instantly broadcast stats bucketed by event-day — re-opens by already-advanced
leads), decoupled from the contacted snapshot → impossible states ("3 opens today while 0 outreach
today"; "3 opens today" while the table showed opens only on the prior day). Because every series
now buckets the SAME `leads[]` by each lead's real per-signal first-occurrence date, the invariant
`sum(daily)+undatedCount === total === count(leads with the signal)` holds and no series can exceed
contacted (opened ⊆ contacted, clicked ⊆ contacted). **No date synthesis** — an undated signal lead
is counted in `total`+`undatedCount`, never bucketed (mirror `outreachContacted`).

**Signup-goal outcome = the observed CLICK (website visit), NOT a tracked signup event — settled, do
NOT "fix" by inventing a signup signal.** A downstream account signup happens on the client's own
site and is not tracked in the fleet; the funnel anchors "signup" to the click everywhere
(`visitToSignupPct`, the signups lens filters on `clicked`). So the coherent signup-funnel ACTUAL is
the `clicked` series; the dashboard scales it by `visitToSignupPct` for the PROJECTED signups line
(that projection stays a forecast — this change is ACTUAL-only). `meetingsBooked`/`purchased` are the
meeting/purchase-goal observed outcomes (instantly manual-qualification dates).

**Fully additive / zero blast.** campaign-service reads `headline`/`costEconomics`/`leads` only. The
dashboard (distribute.you) consumes the new series exactly as `outreachContacted.daily` today
(non-strict Zod parse ignores them until wired) — separate distribute.you follow-up to repoint the
Opens/Clicks/Signups actuals off pipeline-activity. (Set 2026-06-24.)

## `/stats` `recipients*` engagement counts derive from the SAME lead snapshot as `/revenue` (PR #388)

The brand stat card (`GET /features/:slug/stats?brandId=` → `recipientsClicked`) and the Overview
(`GET /features/:slug/revenue?brandId=` → `clicked.total`) MUST show the same number. They used to
drift (72 vs 71) because they counted DIFFERENT things: `/revenue` counts DISTINCT leads (deduped by
`leadId`, bounced/unsubscribed zeroed) from the `leads[]` snapshot; `/stats` `recipientsClicked` was
the email-gateway `broadcast.recipientStats.clicked` AGGREGATE — one recipient row PER send, so a lead
served in two campaigns (or who clicked two emails of a sequence) double-counts. The +1 was exactly
one such duplicate (the Sibylle Linnebo case: same lead, two click events 13 days apart).

**Canonical = the lead snapshot (distinct leads).** "Link Clicks" on a lead funnel is *how many of my
leads clicked*, not *total click events* — a count that could exceed `contacted` breaks the funnel.
So `src/routes/stats.ts` (authed handler) re-derives the six snapshot-ownable engagement counts —
`recipientsContacted`/`recipientsSent`/`recipientsDelivered`/`recipientsOpened`/`recipientsClicked`/
`recipientsRepliesPositive` — via `src/lib/engagement-snapshot.ts` `fetchEngagementSnapshotCounts`,
which composes the EXACT same primitives `/revenue` uses (`fetchLeadsForRevenue` → best-effort
open-timestamp overlay via `fetchEventTimestamps` → `dedupPersonsByLead` → count), so the two can
never disagree (invariant test in `engagement-snapshot.test.ts`). The counts OVERRIDE the
email-gateway aggregate via spread order in the non-grouped `rawStats`.

**Gated to non-grouped + `brandId` present** (the dashboard stat card). The grouped
(`?groupBy=campaignId`) per-campaign breakdown KEEPS the email-gateway aggregate — the snapshot fetch
is brand-scoped (one `fetchLeadsForRevenue` call), not per-group. Brand-scope matches `/revenue`,
which also calls `fetchLeadsForRevenue(brandId, campaignId)` with NO feature filter on the leads — so
matching it is correct by construction even though it counts all the brand's leads.

**email-gateway is STILL fetched** for the keys the snapshot can't produce — `recipientsBounced`
(snapshot zeroes bounced leads' signals) and replies Negative/Neutral/AutoReply (snapshot only knows
`positiveReply` via `replyClassification`). Only the six above are overridden. Open has NO lead-row
boolean — a known email-gateway open timestamp IS the signal (mirrors revenue.ts Wave B); the
open-overlay is BEST-EFFORT (an email-gateway failure degrades `opened` to 0 on BOTH endpoints
identically, while the lead fetch itself stays fail-loud). No OpenAPI change (same keys, same types).
(Set 2026-06-25.)

## Data layering — features-service owns a GOLD serving layer (CQRS read model)

features-service is otherwise a **derive-on-read aggregator** (the API-Composition pattern, Richardson):
it owns no domain data, computing `/revenue` + `/stats` by live-fanning-out to N sibling services per
request. That fan-out — amplified by sibling Neon cold-starts — is the dashboard's latency. The fix is
the industry-canon answer to "API Composition too slow": a **Gold read model** (Richardson CQRS,
Databricks medallion Gold, Kleppmann derived-data).

- **Bronze/Silver: none.** The siblings (lead/brand/runs/email-gateway/…) stay source-of-truth and own
  their own layers. features-service never ingests raw data.
- **Gold: `feature_view_snapshots`** (`src/db/schema.ts`) — a denormalized snapshot of the exact response
  body, keyed `(view, scope_key)` where `scope_key = buildScopeKey(featureSlug, {orgId, …query})`. Served
  through `servedCached()` (`src/lib/view-cache.ts`) with **stale-while-revalidate**:
  - fresh hit (age < TTL) → serve snapshot, no recompute;
  - stale hit → serve snapshot NOW + single-flight background refresh (claims `refreshing_at` via a
    conditional UPDATE, cross-replica safe);
  - too-stale hit (age ≥ hard max age) → compute live ONCE synchronously, persist, serve;
  - miss → compute live ONCE (in-process single-flight, fail-loud: a compute error propagates / 502s),
    persist, serve.
  The slow fan-out thus runs ~once per TTL per *viewed* cell, OFF the request path; idle cells never refresh.

**It is DERIVED + rebuildable** — dropping every row is safe (next read recomputes); siblings stay SoT.
**Eventual-consistency is the accepted CQRS tradeoff**: a served body is "as-of `computed_at`", at most
the hard max stale window (default 60s). The revenue engine's day-scale decay is therefore as-of
`computed_at` — negligible drift at the 5s default TTL / 60s hard max. The cache is an OPTIMISATION,
never SoT: a snapshot-table read error logs loud and falls through to a live compute (correct answer,
just slow) — that fall-through is legitimate degradation, NOT a silent swallow.

**Env (optional, sane defaults):** `FEATURE_VIEW_SNAPSHOT_TTL_MS` (default `5000` = the 5s freshness
target) and `FEATURE_VIEW_CACHE_ENABLED` (default on; set `"false"` to bypass — tests that assert the
pure live-compute path set it false). The hard stale cap is fixed at 60s: a viewed cell older than
1min recomputes synchronously rather than serving too-old decay-sensitive data. Future: event-driven
invalidation (siblings publish domain events → incremental refresh) is the next medallion step beyond
SWR if staleness ever bites. (PR #293, refined by features-service#304.)

## `GET /features/:slug/stats` scopes its fan-out to the feature's DECLARED sources

The authed feature-stats handler (`src/routes/stats.ts`) does NOT call all 10 upstream stat
families anymore — it derives the minimal source set from the feature's declared `outputs` +
`charts` via `requiredStatsSources(keys)` (`stats-registry.ts`) and only fans out to those.
`runs` (cost + systemStats) and `activeCampaigns` are UNIVERSAL — always fetched. A cold-email
feature thus skips outlets/journalists/leads/press-kits/journalists-quotes/ai-visibility, none of
which it renders; the endpoint stops waiting on those (often cold-starting) siblings. `Promise.all`
here stays fail-loud per family (each fetcher wraps `fetchWithRetry` internally) — this is the
authed dashboard path, NOT the public `Promise.allSettled` path above; don't conflate them.

A skipped source contributes no keys → its (unrendered) stats default to `null` downstream, exactly
as a no-data fetch would. So the response is byte-identical for the feature's DECLARED output keys +
cost + systemStats; only keys the feature never renders may read `null` instead of a zero-fill —
unobservable, since the dashboard renders `feature.outputs` only. `requiredStatsSources` resolves
derived keys to their numerator+denominator sources and flags `needsRunFilter` for the pipeline
(runFilter) family; unknown keys (chart ids like `funnel`) are ignored, so deep-collecting every
nested `key` from outputs+charts and passing the lot is safe.

**Test gotcha:** a feature mock fed to this handler MUST carry realistic `outputs`/`charts` — a mock
without them yields an EMPTY required-source set and every source-fetcher is skipped, silently
breaking mapping/resilience suites. `stats.test.ts`'s `MOCK_FEATURE` declares EVERY registry key
(`Object.keys(STATS_REGISTRY).map(k => ({ key: k }))`) to keep all fetchers active; the narrow-scope
behavior is asserted with a separate cold-email feature. (Set 2026-06-15, PR #289 fan-out scoping.)

## Grouped revenue (`?groupBy=campaignId`) fetches brand economics ONCE, not per campaign

`computeFeatureRevenue` takes an optional `economicsOverride` (`EffectiveEconomics`). Sales
economics are brand-scoped (brand-service serves them at `/orgs/brands/:id/sales-economics-effective`
— no campaign in the path), so the grouped route fetches them once before the per-campaign
`Promise.all` and passes the result in, instead of each of N campaigns re-hitting brand-service. The
override is skipped on the no-funnel short-circuit (which never reaches Wave A). The remaining
per-campaign reads (runs-cost / leads / timestamps / quals) are genuinely campaign-scoped and still
fan out per campaign — collapsing them brand-wide (`4N → 4`) is a deferred follow-up. (PR #289.)

## revenue.test.ts `mockFetch` routes by URL SUBSTRING — order specific paths before their prefixes

`mockFetch` / `mockFetchGrouped` dispatch on `url.includes("...")`. A new brand-service path that
CONTAINS an existing one as a substring silently routes to the wrong handler unless its branch is
placed FIRST. Concretely: `"/orgs/sales-economics-average".includes("/sales-economics") === true`, so
the `/sales-economics-average` branch MUST precede the per-brand `/sales-economics` branch — otherwise
the cross-brand-average call gets the per-brand `{ salesEconomics }` envelope (wrong shape) and the
fallback test asserts the wrong thing with no error. When adding any downstream mock whose path is a
superstring of an existing one, add it ABOVE the shorter match. (Set 2026-06-07, #236 cross-brand-average.)

## Two expert-quote features — don't conflate

- `pr-expert-quote-outreach` — autonomous PR quote outreach.
- `pr-expert-quote-opportunities` — HITL ranked queue (review → generate → send manually). `inbox` icon, displayOrder 10.

Near-identical inputs/outputs/charts. Confirm the exact slug before editing — they diverge by intent.

## Public cross-org revenue — reuse the engine via identity-forwarding, don't approximate

`GET /public/stats/revenue?groupBy=brand` exposes the SAME expected-pipeline number as the
authenticated dashboard (`/features/:slug/revenue`), cross-org. The pattern (don't rebuild it as a
counts × per-stage-EV approximation — that loses company-dedup + decay and reads "lower quality"):

- **Forward the owning org's identity.** lead-service `/orgs/leads` and brand-service
  `/orgs/.../sales-economics` (and email-gateway `/orgs/status`, instantly `/orgs/manual-qualifications`)
  authorize on `apiKeyAuth + requireOrgId` — only `x-org-id` is required; `x-user-id`/`x-run-id` are
  optional, unvalidated context. So a service can run `computeFeatureRevenue` on ANY org's behalf by
  setting `x-org-id` = that org + a service stub user/run. **Zero new cross-org reads needed.**
- **Enumerate (org, brand[, workflow]) pairs** from lead-service `GET /internal/feature-memberships`
  (reads `leads_campaigns.{org_id, brand_ids, workflow_slug, feature_slug}`), run the engine once per
  `(org, brand)`, then **sum per brand across its orgs**. Leads are disjoint per org (a lead belongs to
  exactly one org), so the sum never double-counts at the lead level. Cross-org same-company overlap is
  the only residual approximation (rare).
- **CAC/ROI** = `buildCostEconomics` (exported from `revenue.ts`) — byte-identical to the dashboard.
- Heavy (one engine pass per pair) → cache the assembled response in-memory (`__resetPublicRevenueCache`
  test seam).
- Other heavy public stats (`/public/stats/ranked`, `/public/stats/best`,
  `/public/stats/workflow-engagement-latency`) also use short in-memory caches (`__resetPublicStatsCache`
  test seam) so landing/report refreshes do not re-hit workflow/runs/email/journalists on every request.

**Per-workflow revenue is NOT a `createdForBrandId` proxy.** 14/46 sales workflows span multiple brands
(a template re-run across brands), so a workflow's LTR is not one brand's. Attribute at the
`(brand × workflow)` cell — each run/recipient is single-brand, so cells are exact. Needs workflow-scoped
COST (runs `groupBy=workflowSlug`) + a lead-service `workflowSlug` filter on `/orgs/leads`. Tracked as a
follow-up in features-service#225.
