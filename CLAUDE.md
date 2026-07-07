# Features Service — CLAUDE.md

## `cost-engine.ts` — TWO named engines are the SINGLE source of truth for "cost per outcome"; default = projected everywhere except accounting

Every stats surface computes "cost per outcome" through ONE of TWO named functions in `src/lib/cost-engine.ts` —
never an inline `spent / count`. This keeps the 0-outcome decision homogeneous across endpoints.

- **`observedCostPerOutcome(spentUsd, observedCount) → number | null`** — "what actually happened"
  (ACCOUNTING / real spend). `null` (renders "-") when 0 spend OR 0 outcomes; NEVER fabricates a number
  that wasn't measured. Use ONLY for real-money / bookkeeping surfaces.
- **`projectedCostPerOutcome(spentUsd, observedCount, parentCost?) → number`** — "rankable estimate"
  (the DEFAULT). Real ratio when `observedCount > 0`; else the CASCADE FLOOR `max(spentUsd, parentCost)`.
  NEVER null when there is spend — a rankable surface must always yield a comparable number. `parentCost`
  = the same unit cost on the next COARSER grain (crossOrg → brand → audience), iterative; omit when the
  surface has no coarser grain → floor degrades to own spend (`max(spentUsd, 0)`), the cascade's base case.

**DEFAULT RULE (product, Kevin 2026-07-07): projection is the default for the dashboard and EVERYWHERE,
EXCEPT accounting (real spend / bookkeeping), which takes observed.** If the front wants raw observed cost
on a projection surface, that is a DEDICATED observed endpoint — NOT a flag/tag on this one. Naming must be
clear: accounting fields carry accounting names (`spent`, `actual`); projection is the unnamed default.

**Cascade rationale (projected):** with 0 observed outcomes the true cost is unknown but ≥ the spend so
far; the coarser grain's cost is the prior. So `spent < parentCost` → assume the parent (not yet proven
worse); `spent > parentCost` → own spend is the higher conservative floor (already outspent the parent
with nothing to show). This stops a barely-spent 0-outcome grain from looking artificially free and winning
the ranking.

**Surface classification (target — migrate one at a time, verify the consumer each time):**

| Surface | Engine | Notes |
|---|---|---|
| `workflow-projection` (unit costs → projected goal costs) | **projected** (cascade crossOrg→brand→audience) | DONE (PR1) |
| `audience-stats` `cpcCents`/`cpprCents` | **projected** (cascade audience→brand) | DONE (PR2) — ⚠️ campaign-service reads `cpcCents` byte-equal → flooring untracked-cost audiences to the brand parent CHANGES its ranking (intended) |
| `/stats` `costPerRecipient*` (registry `type:"currency"`) | **observed** | DONE (PR3) — brand is the TOP grain here (no coarser grain fetched → no cascade), so observed (null on 0). Also killed a latent false-$0 (0 cost / >0 outcomes → was $0, now null). |
| `/public/stats/cost-projection` | **projected** (already EV) | not yet routed through the module |
| `pipeline-activity` | n/a (no cost ratio) | It computes forecast **RATES** (`openPerOutreach`…) not costs; its local `ratio` returns `null` on 0-denom = correct for a displayed rate. Nothing to route. |
| `/revenue` `spend` block (`total/actual/provisioned Cpc` + `cps`/`cpsm`) | **observed** (ACCOUNTING — real money) | DONE — routed through `observedCostPerOutcome` (removed the local `ratioCents` dupe; also fixed a latent false-$0 on `cps`/`cpsm` which guarded only `count>0`, not spend>0) |

**Rate helpers are NOT part of the cost engine and legitimately differ by consumption — do NOT "homogenize" them.**
`platform-rates-client.ratio` returns **0** on 0-denom because its rates are MULTIPLIED in the EV funnel
(`funnel-registry.ts` `r.sentPerContacted * pCloseSent` …) — `null` would poison the product with NaN.
`pipeline-activity.ratio` returns **null** on 0-denom because its rates are DISPLAYED (0 contacted → unknown
rate, not 0%). Same observed/projected-style polymorphism as cost: a multiplied rate needs a number, a
displayed rate needs null. Neither is buggy.

**A surface uses `projected` only where it HAS a coarser grain to floor against inside the endpoint;
a top-grain surface with no coarser grain fetched uses `observed`.** workflow-projection has the full
crossOrg→brand→audience ladder; audience-stats floors audience→brand (the brand parent is computed from
audience-stats' OWN data — total tagged cost / distinct-union membership outcomes, no extra fetch, no
grain mix); `/stats` is brand-only (no fleet parent fetched) → observed.

**Engine guard:** `projectedCostPerOutcome` returns a real ratio ONLY when BOTH spend > 0 AND outcomes > 0;
a 0-spend / >0-outcomes cell (cost un-attributed but outcomes tracked — the ~3% audienceId cost-tag gap)
would be a false $0 as `spent/count`, so it floors to the parent instead (or null via `observed` when the
parent is absent). workflow-projection never hits this (grains built only at spend > 0).

**PR1** wired `workflow-projection` (parent = coarser grain's unit costs; audience blocks built PER COUPLE).
**PR2** wired `audience-stats` (audience→brand; when the brand has no parent cpc, falls back to `observed`
null — never a false $0). **PR3** wired `/stats` currency keys → `observed`. Response shapes unchanged
across all three → no OpenAPI change. (Set 2026-07-07.)

## Per-goal `costPerPaidClient` chains through THAT goal's OWN funnel — coherent by construction (≥ the goal's outcome cost)

`workflow-projection`'s displayed **cost / paid client** (drives `roiMultiple` + `cacPct`) MUST chain
through the SAME funnel as the goal's outcome metric, so `costPerPaidClient ≥ costPerOutcome` ALWAYS —
a paid client is downstream of the outcome (a signup, a booked meeting). `paidClientCostForGoal`
(`src/routes/workflow-projection.ts`) routes by goal, single-sourced through `projectOutcomeCosts`
(`src/lib/funnel-registry.ts`):

- **signup / self-serve** → `costPerSignupPaidClientUsd = clickUsd/(v2s·s2pc) = costPerSignup / signupToPaid`
  (visit → signup → paid, CLICK route only; `s2pc` = `signupToPaidClientPct`).
- **meeting-booked** → `costPerMeetingPaidClientUsd = 1/[(1/clickUsd)·v2m·m2c + (1/replyUsd)·r2m·m2c] =
  costPerMeetingBooked / m2c` (the two MEETING→paid routes only; `m2c` = `meetingToClosePct` = the card's
  "Meeting → Paid client"). Does NOT include the direct self-serve `v2c` route.
- **purchase** → `costPerPurchaseUsd` (the full self-serve + meeting close funnel, `orP(v2c, v2m·m2c)` +
  reply route — self-serve `v2c` belongs HERE).
- **websiteVisit / positiveReply** (single-step) → `v2pc` / `r2pc` (paid IS the outcome).
- **form_submissions** → `costPerFormSubmissionPaidClientUsd = costPerFormSubmission / fs2pc`.

**The bug this fixes (do NOT regress):** signup + meeting-booked used to fall through to
`costPerPurchaseUsd` (the meeting/close funnel), whose rates are UNRELATED to the signup step — so for
a signup-goal brand, cost/paid ($3.79) read BELOW cost/signup ($38.67), an internally-incoherent output
(a paid client cheaper than a signup). Each goal's paid-client cost = `costPerOutcome / (outcome→paid
rate)` keeps the invariant. A `0` outcome→paid rate (or 0 meeting routes) → null (renders "-"), never a
false $0. Zero cross-repo: brand-service already serves `signupToPaidClientPct`/`meetingToClosePct` on
its sales-economics + effective layers. campaign-service ranks on `costPerOutcomeUsd` (unchanged) and the
recommended workflow rides `outcomeCostForGoal` (unchanged) — this touches ONLY the displayed cost/paid +
ROI + CAC. `ProjectedOutcomeCosts` is an internal lib type (NOT a response schema) → no OpenAPI regen.
(Set 2026-07-07.)

## SINGLE-STEP optimization goals — `websiteVisit` (visit→paid) + `positiveReply` (reply→paid)

Two beta brand goals convert straight to a paid client in ONE step, NOT through the multi-step
funnels the legacy goals use. brand-service owns them (its `OptimizationGoal` = `website_visits` /
`positive_replies`, its runtime `CurrentGoal` = `websiteVisit` / `positiveReply`) and serves two new
rate fields — **`visitToPaidClientPct`** + **`replyToPaidClientPct`** (0..100) — on the
sales-economics **and** effective (gold) layers. features-service reads them verbatim; it does NOT own
or default them (a brand-service gap → fail loud, never a substituted 0).

**Math (single-sourced through `projectOutcomeCosts`, `src/lib/funnel-registry.ts`):** the goal's
paid-client rate is applied to ONE channel — `websiteVisit` → click channel only
(`costPerVisitPaidClientUsd = clickUsd / (visitToPaidClientPct/100)`), `positiveReply` → reply channel
only (`costPerReplyPaidClientUsd = replyUsd / (replyToPaidClientPct/100)`). EV per lead =
`(rate/100) × LTR`. No funnel chaining, no orP — the OTHER channel does NOT fund it. A `0` rate is a
valid zero-denominator gate → null cost (renders "-"), never a false $0; a genuinely-ABSENT rate field
fails loud via `singleStepRateDecimal` (502), never NaN / zero-collapse.

**Surfaces wired (each keyed on the goal):**
- `workflow-projection` (`objective`): the single-step cost rides each grain's `projected` +
  `resolved.costPerOutcomeUsd` (NOT `costPerPurchaseUsd`) → non-null `roiMultiple` + positive
  `recommendedBudgetUsd`, no zero-collapse.
- `audience-stats` (`goal`): `costPerOutcomeUsd` / sort-metric per goal
  (`websiteVisit`→CPC, `positiveReply`→CPPR); `conversion.rate` = the single-step rate.
- `revenue` (`lens=website_visits`/`positive_replies`): per-lead EV = rate × LTR via `lensProbability`
  (mirrors the existing `signups`/`booked-meetings` lens, single-step).

**Vocabulary — accept ALL fleet spellings, echo the per-param canonical (`matchSingleStepGoal`, `src/lib/goals.ts`).**
campaign-service forwards the brand's `currentGoal` in camelCase (`websiteVisit`); the dashboard reads
`salesEconomics.optimizationGoal` in snake_case (`website_visits`). Every param accepts snake / camel /
kebab and normalises internally (input tolerance, NOT a missing-data fallback). Canonical echo: `goal`
param → camel (`websiteVisit`, = CurrentGoal); `objective` + `lens` → snake (`website_visits`, = the
brief's LOCKED byte-equal + the endpoints' existing snake style). Legacy goals unchanged. (Set 2026-07-05.)

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

## `GET /features/:slug/workflow-projection` — 3-grain cost-per-outcome LADDER (`/candidates` DELETED, folded in; PR #449)

`GET /features/:slug/workflow-projection?brandId=&audienceId?=&goal=` returns a **3-grain
cost-per-outcome ladder** (`crossOrg` → `brand` → `audience`) keyed per `(audienceId?,
workflowDynasty)` in a top-level **`rows[]`** array, plus a `resolved` pick per row. The legacy
`GET /features/:slug/candidates` endpoint + `src/routes/candidates.ts` + `src/lib/candidates-audience.ts`
are **DELETED** — folded into this endpoint. campaign-service (the consumer) now reads
`/workflow-projection` `rows[]` + `resolved.costPerOutcomeUsd`; the api-service proxy was reshaped and
the candidates proxy removed.

**Row shape.** Each row `{ audienceId, workflow:{workflowDynastySlug, workflowDynastyName},
estimatesByGrain:{crossOrg?, brand?, audience?}, resolved }`. `economics` (brand effective, **no
`source` field**) is shown ONCE at the top level, not per row.

**Grain rules (per grain in `estimatesByGrain`):**
- `unitCosts.costPerXUsd = spentUsd / max(observedX, 1)` — **NEVER null**. A 0-outcome grain that has
  spend yields a FLOOR = `spentUsd` (the front renders `">$X"`); this is deliberate, NOT a bug.
- A grain with `spentUsd == 0` is **OMITTED** entirely.
- `projected` per grain = `projectOutcomeCosts(brandEcon, unitCosts)` (null ONLY at cold start).
- crossOrg + brand grains reuse `fetchPublicCosts` (version-grain) + `aggregateAcrossChains` local
  dynasty rollup; the brand grain adds a `brandId` filter. The audience grain is audience-WIDE — NOT
  split per-workflow (send/engagement is not workflow-tagged; fleet gap #366/#367).

**`resolved`.** `resolved.grain` = the FINEST grain present with spend, precedence
`audience > brand > crossOrg`. `resolved.costPerOutcomeUsd` is the goal metric campaign-service ranks
on. The `recommended` selection ranks on `resolved.costPerOutcomeUsd`. (Set 2026-07-06.)

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
**PROJECTED** `cpsCents`/`cpsmCents` (EV-math cost-per-signup / -sales-meeting) were REMOVED from the
block (PR #406, breaking) — do NOT re-add a PROJECTION here; cost-per-outcome projection lives in
`workflow-projection` / `/public/stats/cost-projection`, not the `spend` block. **`cpsCents`/`cpsmCents`
were RE-ADDED as the REAL tracked computation (PR #458, features-service#461) — NOT the #406 projection.**
The block now also carries `signupsCount`/`salesMeetingsCount` (REAL attributed conversion counts, from
lead-service `GET /internal/brands/{brandId}/conversion-counts`, service-auth x-api-key + x-service-name,
via `conversion-counts-client.ts`), and `cpsCents = totalSpentCents (COMMITTED) / signupsCount`,
`cpsmCents = committed / salesMeetingsCount` (SAME denominator as `totalCpcCents`, so `cps × count ≈
committed` by construction). null when the count is 0 (no denominator, never a false $0); ABSENT (never a
fabricated 0) when lead-service didn't serve the counts. The counts read is **fail-SOFT** on the Overview
(`fetchConversionCountsSoft` → absent + loud log, never 502s — display enrichment, like `sequences`),
while the client itself is fail-loud. features-service CONSUMES the counts verbatim — it does NOT own or
default them. `spend` is on the OVERVIEW only (null on `?lens=`, absent on `?groupBy=campaignId` groups).

**ROI/CAC + `costEconomics` ride REALIZED (ACTUAL) spend, NOT committed.** `fetchRunsCostCents`
(revenue.ts) sums `actualCostInUsdCents` → `costEconomics.actualCostUsd` (renamed from the ambiguous
`totalCostUsd` in PR #403 so it is unmistakably distinct from the committed `total…` figures) — brand +
grouped + lens + public revenue. ROI = `pipeline / actualCostUsd`, CAC = `actualCostUsd / pipeline`.
Counting reserved-but-unbilled holds as cost-spent would understate ROI on money not yet billed.

- `/stats` `systemStats.actualCostInUsdCents` (alongside `totalCostInUsdCents`) + the stats-registry
  `actualCostInUsdCents` raw key, to which **every `costPer*Cents` derived numerator points** (incl.
  `costPerOutletCents`). **Already** convention-compliant (actual = billed, total = committed) — NOT
  renamed by #403.
- `workflow-projection` `roiMultiple = LTR / resolved.costPerOutcomeUsd` (budget-independent,
  = 100/cacPct; the `resolved` pick is the finest-grain cost-per-outcome from the 3-grain ladder) —
  the dashboard renders it instead of inverting `cacPct` client-side.

Null-safe convention (mirrors per-audience `metrics.cpcCents`): a ratio is **null** (renders "-"), never
a false **$0.00**, when its denominator OR the attributed spend is 0. Do NOT add a smoothing/floor to
force a CPC number. The per-audience `/audience-stats metrics.*Cents` (and `pipeline-activity` cpc) still
key on `totalCostInUsdCents` (committed) and are INTENTIONALLY left untouched (provisioned component
negligible at that grain; **campaign-service consumes `metrics.cpcCents` byte-equal** via
`features-audience-client.ts`, so renaming there would break it — out of scope). (Set 2026-06-26;
committed-spend on `/revenue` + total/actual/provisioned naming 2026-06-27, PR #403.)

## `GET /internal/stats/send-forecast` — GLOBAL fleet email send forecast (api-key, staff-gated at api-service), 3 email-grain series stacked

Cross-org, fleet-wide projection of how many outreach emails will be SENT per calendar day over a
past+future window (`?days=N`, default 14 future + fixed 7-day past tail). Answers Kevin's question
"combien d'emails seront envoyés sur les N prochains jours, sachant les brands actives + leur budget".
Handler `handleSendForecast` in `src/routes/public.ts`, pure assembly in
`src/lib/send-forecast-compute.ts` (`buildSendForecast`), série-3 aggregation in
`src/lib/send-forecast-aggregate.ts`, cross-org reads in `src/lib/send-forecast-client.ts`. 60s
in-memory cache (`__resetSendForecastCache` seam), same pattern as the other `/public/stats/*`.

**Three series, ALL email-grain (1 email = 1 unit) — do NOT mix grains.** Each day carries
`{actualSent, inFlightSent, forecastNew, total}`, null-safe (null renders "-", never a false 0):
- **`actualSent`** (past) = real `email_sent` EVENTS/day (follow-ups INCLUDED), from email-gateway
  `GET /public/stats?groupBy=day` → `broadcast.emailStats.sent`. **NOT `recipientStats.contacted`**
  (that's campaign-created = initials only, the funnel grain used by `sequences-client.ts`/#415) —
  the forecast stacks email-grain, so the past actual MUST be email-grain too.
- **`inFlightSent`** (future) = already-scheduled follow-up sends for sequences launched BEFORE today,
  from instantly `sending-forecast` (provisioned steps) relayed by email-gateway
  `GET /public/stats/sending-forecast` (`days[].scheduledCount`; that email-gateway route is mounted
  at `/public` despite its `internalRouter` var name — verified byte-equal to prod v0.24.0).
- **`forecastNew`** (future) = NEW sequences the active brands' daily budgets launch from today
  onward, each emitting on the **D0/D3/D10** cadence model (convolution). `forecastNew` covers
  cohorts started today-or-later; `inFlightSent` covers pre-today cohorts — **they never overlap**
  (anti-double-count boundary at `today`).

**Série-3 math (fleet reduces to 2 scalars).** Per brand `R_b = dailyBudget_b · (1/outreachUsd)`,
where `outreachUsd` is the best-signup workflow's cost-per-outreach — a CROSS-ORG per-FEATURE figure
(`computeFeatureOutreachUsd`, exported from `pipeline-activity.ts`), NOT per-brand: only the BUDGET is
per-brand. Best-signup ranking is monotonic in `clickUsd` → economics-INVARIANT, so `outreachUsd` is
computed ONCE per cold-email feature and reused across every active brand (a brand on multiple
features takes the cheapest = `max` sequences/$). `totalNewPerDay = Σ_b R_b`; today's cohort is scaled
to the REMAINING budget (`todayNewOverride = Σ_b R_b·remaining_b/budget_b`, remaining = budget −
committed spend-so-far-today). The convolution then only needs those two scalars. **`max` over a
brand's features, budget counted ONCE — do NOT sum per (feature,brand), that double-counts the
budget.**

**Only ACTIVE accounts contribute — reuses `accountStatus()` from `accounts-compute.ts` (do NOT
duplicate).** A (org, brand) enters `totalNewPerDay` iff `accountStatus(budget, balance, paused) ===
"active"` — NOT paused (campaign-service brand pause) AND `dailyBudget > 0` AND `orgBalance > dailyBudget`
(org spendable credit covers ≥1 more day). This is THE fix for the forecast OVER-count: before the gate,
every brand that ever ran cold-email and still had a stale positive budget was summed in — incl. PAUSED
brands and churned orgs with $0 credits — inflating the projection ~6× above the observed send rate.
Org balance is fetched ONCE per org (shared across its brands); brand pause is read per (org, brand).
Same status rule + same account universe as `/internal/stats/accounts`.

**Fleet enumeration = the 5 `*-cold-email-outreach` seed slugs** (`coldEmailOutreachSlugs`, derived at
runtime from the `features` table, `slug.endsWith`) — the instantly cold-email sequences that série 2
also describes. Active (org, brand) pairs come from `fetchFeatureMemberships(slug)` per slug
(cross-org, api-key only). All per-org/brand reads are **ORG-LESS platform reads — api-key + x-org-id
ONLY, NO forwarded/faked user identity**: daily-budget + runs cost authorize on `x-org-id` (their
header builders now OMIT user/run when absent), and org balance uses billing's user-less
`GET /internal/accounts/by-org/:orgId/balance`. fail-loud (série 2 is essential, not optional — a
forecast missing the in-flight component is misleading).

**Depends on email-gateway `GET /public/stats/sending-forecast`** (shipped v0.24.0, prod). The endpoint
is additive/dormant (no dashboard consumer yet) — a distribute.you follow-up wires the graph. Reuses
existing env vars only (EMAIL_GATEWAY / LEAD / BILLING / RUNS). (Set 2026-07-01.)

**Cross-org platform fleet reads send api-key + x-org-id ONLY — NO sentinel/faked user identity.**
(Supersedes the earlier "stub MUST be a valid UUID" pin, #425/v0.70.3, now REMOVED.) The original 500
(v0.70.3) came from forwarding a *marker string* `x-user-id` to runs `/v1/stats/costs`, which
format-validates it (`400 "x-user-id header must be a valid UUID"`). The band-aid was a valid-UUID
sentinel `00000000-0000-4000-8000-000000000000`; the REAL fix is that these reads never needed a user
at all — `x-user-id`/`x-run-id` are OPTIONAL context on every one of them (runs `/v1/stats/costs`
validates *only if present*; billing daily-budget authorizes on `x-org-id`). So:
`getRunsServiceHeaders`/`getBillingServiceHeaders` (pipeline-activity) now OMIT user/run/brand/feature
when empty (the authed dashboard path still forwards its real values), the fleet reads pass `{orgId}`
only, and the org-balance read moved off the user-required `/v1/accounts/balance` onto billing's
**user-less `GET /internal/accounts/by-org/:orgId/balance`** (`fetchOrgBalanceUsd`). Zero sentinel in
`send-forecast-aggregate.ts` / `accounts-client.ts` / `accounts-compute.ts`. Any NEW cross-org fleet
read: pass org-only, use an `/internal/*` (org-in-path) producer endpoint — never fabricate a user.
(Set 2026-07-01, send-forecast active-gate + sentinel removal.)

## `GET /internal/stats/accounts` — fleet cold-email customer ACCOUNTS audit (api-key, staff-gated at api-service)

Cross-org, fleet-wide list of every cold-email customer account (org × brand) for the admin
"Audit → Accounts" page — the money-and-status analog of send-forecast. Handler `handleAccounts` in
`src/routes/public.ts`, pure assembly in `src/lib/accounts-compute.ts` (`buildAccountsAudit`,
injectable deps), new cross-org reads in `src/lib/accounts-client.ts`. 60s in-memory cache
(`__resetAccountsCache` seam), same pattern as the other `/internal/stats/*` audits. **All money +
the active determination + MRR/ARR are computed HERE; the dashboard renders only.**

Each row: `{ orgId, orgExternalId, ownerEmail, brandId, brandName, brandDomain, dailyBudgetUsd,
orgBalanceUsd, status }`. Response also carries `stats { totalDailyBudgetUsd, mrrUsd, arrUsd,
activeCount, pausedCount, inactiveCount, totalCount }` + `asOf`.

**STATUS rule (exact, single source `accountStatus()` — do NOT re-litigate). Precedence paused >
active > inactive:** (1) `paused === true` (campaign-service brand pause) → `"paused"`; (2) else
`dailyBudgetUsd != null && dailyBudgetUsd > 0 && orgBalanceUsd > dailyBudgetUsd` → `"active"`; (3) else
`"inactive"`. A PAUSED brand keeps its budget but campaigns are HELD — so it is neither active nor
plain-inactive (paused wins even over a funded budget). **All rows (active + paused + inactive) are
LISTED — never dropped.** `stats.totalDailyBudgetUsd`/MRR(×30)/ARR(×365) sum ACTIVE rows ONLY (a paused
brand is not spending). send-forecast's série-3 gate reuses `accountStatus` and counts only `"active"`.

**Account universe = the SAME source send-forecast uses** — lead-service `/internal/feature-memberships`
over the cold-email slugs (`coldEmailOutreachSlugs`), deduped to distinct (org, brand). Org-level reads
(balance + Clerk id + owner email) run ONCE per org; the daily budget + the brand pause state are
per-(org,brand); brand name/domain is one batched brand-service call. Fail loud on any read error.

- **paused** = campaign-service **`GET /brands/:brandId/pause`** → `{ paused }` (api-key + x-org-id; no
  user/run). The brand pause lives in campaign-service (NOT brand/billing): a brand can be paused while
  keeping a non-zero daily budget. No pause row → `paused:false` (active by default). Fail loud.

- **orgBalanceUsd** = billing **`GET /internal/accounts/by-org/:orgId/balance`** (user-less internal
  read — api-key only, org in path; NOT the user-required `/v1/accounts/balance`) → `balance_cents/100`
  (SPENDABLE, incl. provisioned holds — the authorization/runway value), **NOT `actual_balance_cents`**.
  The ONE mapped status: billing **404 "billing account not found" → 0** (an org that never funded a
  wallet has zero spendable → inactive by the rule). That is a documented billing semantic, NOT a
  swallowed error — do NOT "fix" it to fail-loud (it would 500 the whole fleet audit on one unfunded
  org). Any OTHER non-OK fails loud.
- **dailyBudgetUsd** = billing `GET /internal/brands/:brandId/daily-budget` (reuses
  `fetchBrandDailyBudgetUsd`); `dailyBudgetCents:null` = unset/paused → row inactive.
- **orgExternalId** (Clerk `org_...`) = client-service `GET /internal/orgs/:orgId` (NEW producer read,
  client-service). **ownerEmail** = client-service `GET /internal/users?orgId=` → earliest-created
  user's email (owner proxy; no staff flag exposed, so earliest-createdAt is the heuristic). A
  feature-membership org can have NO client-service row (resolved directly in lead/billing, or staging
  drift) → **client-service 404 → null identity, row STILL listed** (both fields nullable; same
  documented-not-found→null pattern as balance 404→0 — do NOT fail-loud it, that 500s the whole audit).
- **brandName/brandDomain** = brand-service `GET /internal/brands?ids=` (batch, ≤100/req; missing ids
  omitted → null name/domain, still listed).

Rows sort active-first, then daily budget desc (nulls last), tiebreak brandId. **Depends on the NEW
client-service `GET /internal/orgs/:orgId` + the SHARED `CLIENT_SERVICE_URL`/`CLIENT_SERVICE_API_KEY`
on features-service Railway (prod + staging).** Additive/dormant (no dashboard consumer yet). Reuses
existing env vars otherwise (BILLING / LEAD / BRAND).

**VERIFY ON PROD, NOT STAGING — the balance path is prod-only.** `orgBalanceUsd` reads billing
`/v1/accounts/balance`, whose `computeBalance` calls **stripe-service, which has NO staging runtime**
(prod-only). So on staging billing 502s "Failed to compose account funds" fleet-wide → this endpoint
correctly fails loud → 500 on staging. That is NOT a features-service defect; it's the documented
prod-only-dependency gotcha (railway-vars skill). Verified working on prod v0.72.0 (2026-07-01): 32
rows, 10 active / 22 inactive, `totalDailyBudgetUsd`=Σ active budgets, `mrr`=×30, `arr`=×365.
(Set 2026-07-01.)

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

## Issue-tag in code comments — NEVER bake an UNCONFIRMED `features-service#NNN` (sibling OR guessed-next)

This repo tags features in code/OpenAPI describe strings with `features-service#NNN`. The number you
bake in MUST be confirmed to belong to THIS work before you write it — two ways it goes wrong:
1. **Reusing a sibling's number** the brief mentions (e.g. "#388 is reconciling /stats — stay out of it").
2. **Guessing the next sequential number** (`HEAD PR is #472, so mine is ~#473`) — the actual next
   number is often an unrelated sync/hotfix/docs PR that lands between your guess and your push.

Do NOT bake a specific `#NNN` before confirming it. Options, cheapest first: **(a)** run
`gh issue view <n>` / `gh pr view <n>` to confirm the number is FREE or already yours; **(b)** create the
work's own issue FIRST and tag with it; **(c)** open the PR, read its number from `gh pr create`'s output,
THEN `sed` the tag into the code + regen OpenAPI in a follow-up commit ON THE SAME BRANCH *before* it merges.
Baking a wrong number forces a doc-fix follow-up PR (and if the first PR auto-merged on fast CI, a whole
new branch, since you can't push to a merged PR's branch). Cost 2026-06-25 (repliedPositive, PR #389):
tagged `#388` (a /stats sibling) → needed PR #391 to fix. **Recurrence 2026-07-07 (per-lead signup/form
outcomes, PR #476): guessed `#473` from the branch HEAD — but #473 was an unrelated merged "sync hotfix
v0.80.2 to staging" PR; the feature PR auto-merged before I noticed, forcing a fresh branch + retag PR
#477 across 19 refs. A 5-second `gh pr view 473` at tag time would have shown it was taken.**

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

## `/revenue` Outreach card + graph = `sequences` (per-day outreach VOLUME), NOT the deduped-lead snapshot (features-service#415)

**The bug:** the Overview "outreach today" undercounted badly (showed 3 while 34 sequences launched +
~$4.60 spent today). Root cause: the outreach series counted DISTINCT leads by their FIRST-ever contact
date for the brand (`recipientsContacted`, deduped, first-occurrence-dated). When a brand RE-contacts leads
it already emailed (new campaign, spend incurred), each re-contact back-dates to the lead's first-contact
month → today's bucket collapses to the ~3 genuinely-new leads. Confirmed in prod: 31 of 34 today-leads
were prior sequences of the SAME brand (`instantly_lead_status_current`, brand-scoped, correct). NOT an
email-gateway/instantly bug — the brand-scoped first-contact IS April/May for those leads.

**The fix — a distinct VOLUME series.** `sequences` (`src/lib/sequences-client.ts` `fetchSequencesByDay`)
= instantly campaigns-created per day via email-gateway `GET /orgs/stats?type=broadcast&groupBy=day`
(`recipientStats.contacted` = one campaign per lead-sequence enrolled that day, **undeduped** by lead).
`{total, daily, undatedCount:0}`. The dashboard renders the Outreach **card** = `sequences.total` and the
graph **Outreach bars** = `sequences.daily` (= 34 today, matches "budget spent today"). OVERVIEW-only (same
gate as `spend`; null on `?lens=`, absent on grouped). **Fail-soft** (null + loud log on email-gateway
failure — display enrichment, not the pipeline total; never 502s the response).

**Grain split is INTENTIONAL and NOT reconciled.** `sequences.*` = outreach ACTIONS per day (undeduped,
volume, matches spend). `recipientsContacted.*` = DISTINCT leads reached (deduped, funnel view). They answer
different questions and legitimately differ (`sequences.total` ≥ `recipientsContacted.total`). Do NOT try to
make `sum(sequences.daily) === recipientsContacted.total`. campaign-service reads neither (only
`headline`/`costEconomics`/`leads`/`dailyBudgetCents`) → zero backend blast; the dashboard is the only consumer.

**Naming homogenization (same PR) — `/revenue` count series unified to the `/stats` `recipients*` incumbent.**
The `/revenue` outreach/engagement COUNT series were renamed so the same concept has ONE name across both
endpoints: `outreachContacted→recipientsContacted`, `opened→recipientsOpened`, `clicked→recipientsClicked`,
`repliedPositive→recipientsRepliesPositive` (`meetingsBooked`/`purchased` kept — outcomes, not recipient-ladder
stages). Same name + same value as the `/stats` scalar (`recipientsClicked.total` on `/revenue` ==
`recipientsClicked` on `/stats`, guaranteed by #388); the `/revenue` form just adds the `daily` breakdown.
`/stats recipients*` (public ranking-objective contract) + api-service = UNCHANGED. The per-lead `leads[]` row
booleans (`contacted/opened/clicked/repliedPositive/...`) STAY the event words (a row IS one recipient), and the
response array key stays **`leads[]`** (campaign-service reads `res.body.leads`; renaming = backend break).
Convention going forward: **`recipients<Stage>` (plural) = a COUNT/series of recipients; `sequences` = undeduped
outreach volume; per-recipient event booleans on a `leads[]` row use the bare event word.** This SUPERSEDES the
`outreachContacted`/`opened`/`clicked`/`repliedPositive` field names used in the #384/#388/#390 sections below.

**Deferred (features-service#415 follow-up, PR2):** the INTERNAL revenue-engine vocab is still inhomogeneous —
`EnginePerson.signals.{open,positiveReply,closeWin,meeting}` (funnel EV keys) use different words than the
`leads[]`/response layer (`opened/repliedPositive/purchased/meetingBooked`), and `EnginePerson` should become
`Recipient`. Left to a dedicated no-behavior refactor PR because `positiveReply`/`open` are OVERLOADED across
distinct concepts (engine signals vs email-gateway `SignalDates` overlay vs audience `positiveReplies` counts vs
funnel `positiveReplyPerDelivered` rates) — a blind sweep would conflate them, and it touches the revenue math.
(Set 2026-07-01.)

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

## `form_submissions` goal — outcome + attribution data mirrors signups across THREE surfaces (v0.80.1/.2)

A `form_submissions` brand (visit-driven micro-conversion, the sibling of `signup`) now carries the
SAME classes of outcome data features-service serves for signups/visits — do NOT re-borrow the signup
display. All three sit alongside the signup/click equivalents:

- **`/revenue` spend block** — `formSubmissionsCount` + `cpfsCents` (committed spend ÷ real count),
  next to `signupsCount`/`cpsCents`. The count is ALREADY in hand (the conversion-counts client returns
  `form_submission`); zero new producer dep. `cpfsCents` rides the COMMITTED denominator (like cps/cpsm)
  → `cpfsCents × formSubmissionsCount ≈ committed`. null on 0 count, ABSENT when counts weren't served.
- **`/pipeline-activity`** — a `formSubmissions` daily series (`metrics.formSubmissions`, +
  `summary.clickToFormSubmissionPct`), PROJECTED off clicks × the brand's effective
  `visitToFormSubmissionPct`, EXACTLY like the `signups` series (actual-today + forward projection).
  All-null when the brand carries no form-submission rate (non-form brand) — never a false 0.
- **`/audience-stats`** — per-audience `evidence.formSubmissions` + `metrics.cpfsCents` (OBSERVED,
  accounting). REAL producer-side attribution: intersect each audience's member emails with the
  brand's matched-lead form-submission conversion emails — the SAME membership join used for
  per-audience clicks/replies, NEVER a split of the brand total. `cpfsCents` is NOT a ranking metric
  (form_submissions ranks on `cpc`, visit-driven).

**Per-audience attribution depends on lead-service `GET /internal/brands/:brandId/converted-lead-emails?event=`**
(`src/lib/conversion-emails-client.ts`, service-auth) — the producer returns `{ event, emails }` where
`emails` = DISTINCT matched-lead canonical emails (already lowercased) with ≥1 attributed conversion of
`event`. features-service reads `emails` (ignores the echoed `event`) into a Set for O(1) membership
intersection. It is fetched **ONLY for the `formSubmission` goal** (the hot ranking path for every other
goal keeps its exact fan-out and never touches the conversion tracker) and is **fail-SOFT**
(`fetchFormSubmissionEmailsSoft` → null → the per-audience form-submission column is ABSENT, never a
false 0; the client itself is fail-loud). This is the SAME fail-soft-display pattern as the /revenue
conversion-count tiles — a pre-rollout / down lead-service never 502s the ranking. Reuses the existing
`LEAD_SERVICE_URL`/`LEAD_SERVICE_API_KEY` (already wired for conversion-counts). NOTE: the consumer was
first written against a guessed path (`conversion-emails`) and CONFORMED to the producer's deployed
`converted-lead-emails` in v0.80.2 — the producer owns its path/shape; conform the consumer, do not
author it. (Set 2026-07-07.)

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

  **Views wired through `servedCached` (all AUTHED read endpoints):** `revenue` / `revenue-lens` /
  `revenue-grouped` (revenue.ts), `stats` (stats.ts), `workflow-projection`, `audience-stats`,
  `pipeline-activity`. Validation (400/404) stays OUTSIDE the cached compute (never cached — except
  audience-stats caches its whole deterministic `ComputeResult` union, since its validation lives inside
  the compute lib; transient downstream failures THROW and bypass the cache). `pipeline-activity`'s
  `generatedAt` is frozen to the snapshot's compute time (the as-of semantic). The CROSS-ORG `/public/*`
  + `/internal/stats/*` endpoints do NOT use the Gold layer (no per-org `scope_key`); they ALL go through
  ONE shared in-memory memo primitive in `public.ts` — `type PublicCache = Map<string, {payload:unknown,
  expiresAt}>` + `getPublicCache<T>` / `setPublicCache<T>` (single 60s `PUBLIC_STATS_TTL_MS`). Every
  cache (ranked, best, workflow-latency, public-revenue, cost-projection, send-forecast, accounts) is a
  `PublicCache`; the per-endpoint `__reset*` test seams stay (each clears its own Map). Do NOT re-add a
  per-cache bespoke get/set/TTL — route new public caches through the shared helper.

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
