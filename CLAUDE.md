# Features Service — CLAUDE.md

## Per-brand CONFIGURATION is (org, brand) data — every brand-service read of it names the org whose answer it wants, and a caller with NO org FAILS LOUD

A brand row is a **shared global identity**: any org that claims the same domain lands on the same brand
id. So the goal a brand optimizes for, its sales economics, its declared funnels — its CONFIGURATION —
belong to an **(org, brand) PAIR**, not to the brand. Two orgs claiming one domain legitimately sell
different things at different rates, so there is no single answer to give; brand-service can answer when
exactly one org claims the brand, but for a brand claimed by several it REFUSES rather than guess
(guessing is the cross-org read/write leak it closed). In prod 21 brands are claimed by more than one
org, 8 of them with live campaigns.

Every internal read of per-brand configuration therefore sends **`x-org-id`**, and the org is a
**REQUIRED argument**, not a header the client resolves:

| Read | Org comes from |
|---|---|
| `GET /internal/brands/:id/sales-funnels` (`fetchDeclaredSalesFunnels`) | the request's `identity.orgId` (`/goal-arbitration`) |
| `GET /internal/brands/:id/sales-economics` (`fetchBrandSavedEconomicsWithGoal`) | `headers.orgId` (`/revenue` spend parents), the row's `account.orgId` (customer-health), the feature MEMBERSHIP's claiming org (cross-org goal-bucket dataset) |
| `GET /orgs/brands/:id/sales-economics[-effective]` | already org-scoped — the in-repo precedent these two conformed to |

- **NEVER pick an org on brand-service's behalf.** An empty `orgId` throws before the fetch
  (`SalesFunnelsUnavailableError` / a loud `Error`) — a plausible stand-in IS the bug. A caller with no
  org has no question to ask.
- **Cross-org fleet surfaces are not org-LESS.** `fetchGoalBucketDataset` / `fetchFleetBrandEconomics`
  take the claiming org from the lead-service feature membership that put the brand in the set
  (`brandToOrg`, first claimant) — a REAL claimant, never a substitute. The goal-bucket dataset stays
  **one row per brand** on purpose: its spend + outcome legs are read at BRAND grain (runs `brandId`,
  email-gateway `brandId`), so emitting a row per (org, brand) would count a multi-org brand's fleet
  spend once per claimant and inflate every bucket it lands in.
- **Out of scope: `GET /internal/brands?ids=`** (accounts audit + public stats) — that reads brand NAME
  and DOMAIN, which are the shared global identity itself, not per-org configuration.
- **No behaviour change for a brand exactly one org claims**; the header is a no-op against a
  brand-service that predates the change, so there is no ordering constraint either way.
- Guard: `src/lib/brand-config-org-scoping.test.ts` asserts the header VALUE on both reads, that two
  orgs on ONE brand id get their own answers, that an org-less caller throws before any fetch, and that
  the fleet dataset asks under the membership's org while reading the brand's spend once. Plus the
  call-site guards in `src/routes/goal-arbitration.test.ts` (the caller's org rides the funnels read) and
  `src/lib/customer-health-compute.test.ts` (each row asks under its own org). (Set 2026-08-01.)

## `GET /features/:slug/goal-arbitration` — RANKS every DECLARED sales funnel by RETURN PER DOLLAR. It is a RECOMMENDATION, not a selection, and an UNFUNDED funnel is still ranked

**The funding decides what runs; this endpoint decides nothing.** It used to BE the decision —
campaign-service asked which goal to work and ran the one that came back. That ended when the customer
started funding each funnel separately (billing-service#344) and campaign-service began working EVERY
funded funnel, pacing each against its own ceiling and taking whichever has spent the least relative to
what it may spend (campaign-service#308, prod v0.48.0). So what this service owes is the one question
only it can answer — it holds the outcomes, the spend and the economics — **which funnel returns best,
and how do the others compare**. That is advice a customer reads to decide where to put their money.

- **`ranking` IS the answer; `recommendation` is merely its head.** `ranking` carries EVERY declared
  funnel, `rank` 1..N best-return-first, unrankable ones last with `rank: null` and their reason. The
  COMPARISON is the value now, not the winner — a shape that says "this is THE goal to run" would be
  lying about what the consumer does with it.
- **NEVER ask billing which funnels are funded.** Ranking is about HISTORY: what a funnel has returned
  per dollar is what makes it comparable, and being unfunded is a decision the customer JUST MADE, not a
  reason to hide how it performed. A ranking that dropped the unfunded ones would answer "where should I
  move my budget?" with only the places the budget already is. There is no billing read anywhere on this
  path and no funding field on the response; funding is campaign-service's question at run time and it
  already asks it. Guards: the route test asserting no request URL matches `/billing|budget|ceiling/i`,
  and the `declaredFunnelsToRank` entry-shape test (`{funnelKey,name,goal,economics}` and nothing else).
- **`arbitration` / `workflow` / `rows` stay byte-compatible — campaign-service reads them in PROD.**
  `fetchGoalArbitration` (`features-workflow-projection-client.ts`) matches `arbitration.status ===
  "resolved"`, `arbitration.goal`, `workflow.workflowDynastySlug`, `rows[]`, and the 502 body substring
  `authorized_goals_unavailable`; a campaign that states its OWN goal (every funnel campaign does) is
  never arbitrated, so the election now only paces a brand with NO per-funnel funding. All of it is
  DERIVED from the head of `ranking`, so the two can never name different funnels — verified by a route
  test. `candidates` + `authorizedGoals` were REMOVED: nothing in the fleet read either (checked in
  campaign-service, api-service — a pure passthrough proxy — and distribute.you), and keeping a second
  goal-grain shape beside `ranking` is the two-vocabularies smell.

**RANKING BASIS (the documented, stable rule — do NOT rank on cost-per-outcome):**

```
returnPerDollar(funnel) = lifetimeRevenueUsd / costPerPaidClientUsd(funnel, its best workflow)
```

= the EXISTING `workflow-projection` `roiMultiple` (= 100 / `cacPct`). It is the ONLY cross-funnel-comparable
number: a cost-per-outcome is denominated in each funnel's OWN outcome (a click, a reply, a booked meeting),
so comparing two funnels' cost-per-outcome compares two different things. Normalising each funnel through ITS
OWN chain to the same terminal unit — a paying client's lifetime revenue — is what makes them commensurable.
Rankable funnels sort on `returnPerDollar` desc; ties break on the canonical `GOALS` index then `funnelKey`,
so the same evidence + the same economics always produce the same list.

- **Best workflow per funnel = `argmin resolved.costPerOutcomeUsd` over the BRAND-LEVEL rows**
  (`audienceId === null`) — byte-for-byte the ungated argmin `fetchBrandProjectedParents` and the Strategy
  page's `pickBestBrandRow` use, so this endpoint can never crown a different workflow than those surfaces
  for the same brand + goal. Ranking the workflow on the COST while ranking the funnel on the RETURN is not
  a mix-up: within one funnel `costPerPaidClient = costPerOutcome / (outcome→paid rate)` and that rate is a
  constant for it, so the two argmins are the SAME ordering — the cost keeps coherence with the live
  surfaces, and the return falls out of the winning row.
- **A funnel with no defined return is ranked LAST, never dropped.** A whatsapp funnel has no path to a
  paying client at all (brand-service exposes no whatsapp→paid rate), so its return is undefined — not
  zero, and never "borrow the click funnel". It stays in `ranking` with `rankable: false` +
  `unrankableReason: "no_paid_client_path"`, carrying whatever IS known (its own outcome cost + best
  workflow). Same for `no_economics` / `no_workflow_evidence` (no history yet) / `no_return_defined` (a
  paid-client cost exists but the brand states no lifetime revenue). Hiding any of them would leave the
  customer comparing against a list missing one of their own funnels.
- **"A funnel is recommended" and "nothing could be ranked" are DISTINGUISHABLE, never an error that
  hides why.** `arbitration.status` is `"resolved"` or `"unrankable"` with a reason:
  `"no_declared_funnels"` (nothing to rank) vs `"no_rankable_funnel"` (every declared funnel is
  unrankable — each entry carries its own reason). Both are 200s.
- **`rows` are the RECOMMENDED PAIRING's rows only** — the brand-level row plus EVERY active audience's row
  for that dynasty, in the SAME `ProjectionRow` shape `/workflow-projection` serves, so campaign-service's
  audience bandit reuses its existing parser (`resolvedOutcomeCount` successes, `evidence.observedContacted`
  trials, `evidence.spentUsd` cost; an audience with no attributed evidence carries no audience grain = a
  cold arm, and still resolves via the cascade — never absent, never a false $0).

**The DECLARED SET is brand-service's to own** = the SALES FUNNELS a brand DECLARED it sells through,
read from **`GET /internal/brands/:brandId/sales-funnels`** (api-key + `x-org-id`, brandId in path — see
the org-scoping section below) via `src/lib/sales-funnels-client.ts` → mapped by
`src/lib/declared-funnels.ts`. **Never accepted from the caller** and **never inferred** — a brand's
single `optimizationGoal` is ONE goal, not a set, and brand-service is explicit that its brand-wide
economics row cannot stand in for a declaration (every rate on it is NOT NULL with a server default, so a
brand that configured nothing still reads back plausible-looking numbers and no absence signals
anything). Reading either as the set is a bug.

- **Read the WIRE `goal`, NOT `currentGoal`.** brand-service deliberately collapses `form_submissions`
  onto the `signup` runtime token so "consumers never see a new value" — but features-service models form
  submissions as their OWN goal with their own funnel (visit→form→paid), so reading `currentGoal` would
  price a Form Magnet funnel on signup economics: a wrong answer that looks right. `currentGoal` is the
  fallback only when the wire goal maps to nothing. `matchBrandServiceGoal` covers every value the
  producer can echo (incl. the dashboard's `sales_meetings` spelling).
- **The LIST answers it alone — an EMPTY list is a PRODUCER GAP, not "I sell through nothing".** An org
  that has answered always keeps at least one funnel active (brand-service refuses to switch off the
  last), so "answered but sells through none" cannot occur. An empty list therefore joins every other
  read that cannot be ANSWERED (transport, non-OK, a brand-service predating the funnel model → 404) in
  throwing `SalesFunnelsUnavailableError` ⇒ **502 `reason: "authorized_goals_unavailable"`** naming what
  failed — never a substituted default set. The wire `reason` keeps that legacy spelling on purpose:
  campaign-service matches on it verbatim to tell "no ranking yet" from a genuine fault. An UNMAPPABLE
  goal value likewise 502s (`reason: "authorized_goal_unrecognised"`) rather than being dropped.
- **TWO FUNNELS SHARING ONE GOAL are ranked SEPARATELY — the merge is GONE (supersedes #704–#711).**
  `reply_meeting` and `visit_meeting` used to collapse into one `meetingBooked` entry whose rates unioned
  and whose lifetime revenue took the LOWEST of the two, because a single-elected-goal answer had no
  place to put two funnels. The customer now funds them separately, so a merged row cannot answer "where
  should I move my budget?" for either. Nothing is lost: a rate a funnel does not state falls back to the
  brand's EFFECTIVE economics (never to zero, never to half a funnel), and each funnel is now priced on
  its OWN lifetime revenue — which is the whole point of per-funnel economics (a $200 self-serve plan and
  a $20k contract ranked on their own revenue, not one blend).
- **PER-FUNNEL economics** are merged OVER the brand's effective set for THAT funnel only. A rate the
  brand never declared arrives as `null` and is **DROPPED** — never coerced to 0, which would
  zero-collapse the funnel. Nothing declared ⇒ the brand's effective economics apply unchanged.
- **A SHARED FIELD NAME IS NOT A SHARED MEANING — the meeting chain COMPOSES** (`meetingChainCloseRate`).
  Every funnel rate key lines up 1:1 with `SalesEconomics` EXCEPT `meetingToClosePct`. Our projection
  multiplies it by `visitToMeetingPct`/`replyToMeetingPct`, both of which produce a meeting **BOOKED**,
  so ours is BOOKED→paid. brand-service's chains are `… → Meeting booked → Meeting attended → Paid
  client` with `legs[i]` between `steps[i]` and `steps[i+1]`, so ITS `meetingToClosePct` is
  **ATTENDED→paid** and `meetingBookedToAttendedPct` is the show-up rate in between. So the override is
  `booked→paid = attended% × close%`; the show-up rate never reaches `SalesEconomics` under its own name
  (there is no field for it), and a show-up rate with NO close rate contributes nothing (half a chain is
  not a close rate). No show-up rate declared ⇒ the close rate stands alone — exactly the brand-wide
  semantics, whose economics row has no show-up column at all — never discarded.
  **Do NOT "simplify" this back to a name-match copy.** #707 did (reasoning that we model no show-up
  step, so importing it would rename a rate we never read) — but the effect of dropping it is asserting
  a **100% show-up rate**: a brand declaring 50% show-up and 40% attended→close scored 40% booked→paid
  instead of 20%, halving its cost per paid client and DOUBLING the return `meetingBooked` is ranked on.
  Guard: the `meetingChainCloseRate` cases in `declared-funnels.test.ts` + the route-level "not a free
  100%" test, which drives the SAME funnel with and without the show-up rate and asserts the return halves.
- **Consumer-conforms-to-producer, learned the expensive way (2026-07-31):** the first ship guessed the
  producer would put the set on the effective-economics payload under one of several plausible names and
  shipped a tolerant parser for that guess. brand-service had ALREADY shipped it to staging as *sales
  funnels* on its own endpoint, so the guess matched nothing and the endpoint 502'd for every brand in
  prod. The dup-check missed it because it searched the CONSUMER's vocabulary ("authorized goals"), not
  the producer's. When a producer feature is "in flight", grep the producer repo for the CONCEPT before
  designing a reader — and read the deployed shape from the registry, never a shape you authored.
- A funnel that needs a rate the brand's economics do not carry still FAILS LOUD (the same behaviour
  `/workflow-projection` has for that goal today) — a missing producer rate is a data gap to surface, not
  an "unrankable" verdict to record.

**Cost + coherence:** the evidence fan-out is goal-INDEPENDENT, so this endpoint reuses the SAME Gold
snapshot `/workflow-projection` maintains (view `workflow-projection-evidence`, scope key
`featureSlug + orgId + brandId + pricing`) and ranking N funnels adds ZERO IO over reading one — N pure
`projectFromEvidence` calls. Two small brand-service reads ride the request path (effective economics +
declared funnels), both live. Economics is read LIVE (never cached), same freshness rule as
`/workflow-projection`. `?pricing=gross|net` behaves identically to its siblings. **`/workflow-projection`
and `/audience-stats` are UNTOUCHED.** Guard suites: `src/lib/goal-arbitration.test.ts` (ordered ranking,
arbitration-equals-ranking-head, two funnels on one goal ranked apart, never-rank-undefined-return,
determinism/tie-break incl. funnelKey, no-funding-input, recommended-pairing rows),
`src/lib/declared-funnels.test.ts` (wire-goal-not-currentGoal, NO merge, null rates dropped, meeting-chain
compose, entry shape carries no funding), `src/routes/goal-arbitration.test.ts` (drives BOTH endpoints from
ONE fixture: the recommended workflow equals the single-goal read's own argmin, the deployed
campaign-service fields still resolve, and no billing URL is ever requested). (Set 2026-08-02; supersedes
the goal-grain election documented 2026-07-31.)

## Per-audience attribution is SEND-TAG on BOTH `audience-stats` + `workflow-projection` — cost AND outcome one basis; `workflow-projection` audience grain is now PER-(audience × dynasty), enumerating EVERY active audience (supersedes the membership + audience-WIDE notes below)

Per-audience COST was always send-tag (runs `groupBy=audienceId`); per-audience OUTCOME used to be
read-time MEMBERSHIP (human-service member emails ∩ email-gateway per-email flags). That was a
basis-mismatch (send-tag cost ÷ membership clicks) AND membership cannot split by workflow. Now that the
loop-body send/gen cost carries `audienceId` (workflow-service#333) and email-gateway exposes per-(audience,
workflow) engagement (email-gateway#168/#170), BOTH surfaces read the **send-tag** outcome, one basis end
to end → cost-per-outcome coherent, and the per-dynasty rows SUM to the audience total.

- **`audience-stats` engagement** (`contacted/opened/websiteClicks/positiveReplies` + the brand-grain
  cascade parent) now reads email-gateway **`/orgs/stats?type=broadcast&groupBy=audienceId`** (send-tag),
  the SAME basis as the cost. `fetchAudienceSendTagEngagement`. Campaign scope narrows via the `campaignId`
  query param. **`memberCount` + conversions (formSubmissions/signups/sales) STAY membership** — memberCount
  IS the audience size, and a conversion is attributed to whichever audience produced the matched lead
  (`fetchAudienceMembership`, the old `fetchAudienceOutcomes` minus engagement). A send is tagged to ONE
  audience, so the brand-grain = Σ per-audience (no double-count, unlike overlapping memberships).
- **`workflow-projection` audience grain** is now PER-(audience × dynasty), all send-tag: cost from runs
  `groupBy=audienceId,workflowSlug`, outcome from email-gateway `/orgs/stats?audienceId=<id>&groupBy=
  workflowSlug` (one call per audience, concurrency-capped 6), both mapped slug→dynasty
  (`fetchAudienceDynastyCosts` / `fetchAudienceDynastyOutcomes`, `AudienceGrainEvidence.byDynasty`). The
  handler emits a row for **EVERY active audience × EVERY active dynasty** — so a consumer filtering rows to
  the chosen workflow (campaign-service, `r.workflow.workflowDynastySlug === chosen`) gets the FULL
  active-audience set (the enumeration fix: audiences with no attributed couple used to be DROPPED). A
  (audience, dynasty) couple with no attributed audience data floors via the cascade to brand→crossOrg
  (never absent, never a false $0). This lets campaign-service consume workflow-projection alone (best
  workflow + all active audiences) and drop its audience-stats call.

**Forward-only coverage:** the send-tag `audienceId` on the dominant loop-body cost/sends only exists post
workflow-service#333 (~2026-07-06), so per-(audience×dynasty) data is sparse on historical runs → the
cascade floor covers the gaps. This is the SAME forward-only acceptance as the audienceId cost-tag gap.
Response shapes unchanged (row/evidence fields identical) → no OpenAPI regen. campaign-service reads
`metrics.cpcCents` (audience-stats) + `resolved` (workflow-projection) — both flip to the send-tag basis.
(Set 2026-07-22; supersedes the audience-WIDE / membership notes in the audience-stats + workflow-projection
sections below.)

## The `/audience-stats` floor parent is CROSS-ORG + **BEST WORKFLOW** — NEVER a cross-workflow POOLED average (supersedes #653's fleet-pooled parent)

**Standing product rule (Kevin, 2026-07-29): we never surface a cross-org PLUS cross-workflow pooled
estimate. A fleet-wide estimate is cross-org plus the BEST workflow, only.** `fetchBrandProjectedParents`
(`src/lib/audience-stats-brand-projection.ts`) builds the parent every per-audience cost column floors
against at 0 outcomes. It used to sum the WHOLE fleet's spend over the WHOLE fleet's outcomes — a
cross-org AND cross-workflow pooled average — while `workflow-projection` floors each audience against
the workflow it is projected under. Both are labelled "fleet benchmark" in the UI, so the Audiences table
and the Strategy page showed **two different prices for the same audience, same brand, same goal, same
moment** (prod: $8.33 vs $2.64 on brand `7604c385…`, a ~3x split, both audiences reading the parent
verbatim because each had 0 clicks and own spend below it).

`fetchBrandProjectedParents` **rebuilds workflow-projection's BRAND-LEVEL rows** (the `audienceId: null`
ones the Strategy page ranks — `strategy-model.ts pickBestWorkflow` filters to them) and takes the goal's
winner. **ONE dynasty is picked and EVERY column reads ITS resolved unit costs** — do NOT pick a different
best workflow per column (that blends workflows and re-opens the incoherence one layer down: the click
column would price off the cheapest-click workflow while the Strategy page shows the goal-winner's click).

- **The full crossOrg → brand LADDER, not crossOrg alone.** Per dynasty: crossOrg unit costs, then the
  brand grain floored against them (`projectedCostPerOutcome`, i.e. `max(own spend, parent)`), numbers
  from the finest grain WITH SPEND — byte-for-byte `resolvePick`'s NUMBER selection. **The brand grain
  routinely FLIPS the winner**: prod EmailToolsHub burned $4.16 on Osprey with 0 clicks, flooring its
  click from the fleet $2.43 to $4.16 and handing websitePurchase to Pelican ($3.63/click, $273.65 per
  purchase). A crossOrg-only parent crowned Osprey and disagreed with the Strategy page by ~30%.
- **The pick is the goal's argmin, scored with `outcomeCostForGoal`** — now EXPORTED from
  `workflow-projection.ts` and shared, so it is the byte-same goal→cost routing workflow-projection ranks
  its rows on. The two surfaces can never crown a different workflow for the same goal. The winner is
  often NOT the cheapest-click workflow (purchases close through the reply channel too).
- **NO eligibility filter — EVERY dynasty competes, including one that has produced 0 of the goal's
  outcome.** Standing product rule (Kevin, 2026-07-29): a workflow with no outcome still returns a real,
  RANKABLE number — its cascade floor `max(spend, parent)` — and it ranks on equal footing. A
  `grainHasObservedOutcome` gate lived here from v0.106.3 and was REMOVED in v0.107.5: the Strategy page's
  `pickBestBrandRow` ranks those workflows, so gating them out HERE made the two surfaces crown different
  workflows for the same brand+goal — which IS the incoherence (prod: this module crowned `arcadia` at
  $64.11 with 1 observed reply while the dashboard crowned `dawn` at $61.73 with zero). Do NOT re-add the
  filter to keep a barely-spent workflow from winning: the floor is the exploration device (it rises as
  the workflow spends), and honesty lives on the LABEL — `resolvePick` still tags a floored row `crossOrg`
  (benchmark), never "this brand's own results".
- **Version chains collapse FIRST** via `buildUpgradeChains` + `aggregateAcrossChains` — the SAME rollup
  workflow-projection's crossOrg/brand grains use — so "a workflow" means one dynasty on both surfaces.
  Treating versioned slugs as independent workflows would corrupt the pick.
- **Cold start** (no economics, or no eligible dynasty scores the goal): workflow-projection reports no
  cost-per-outcome either, so there is nothing to be coherent with — `cpc`/`cppr` fall back to the best
  eligible workflow's raw unit cost per channel and the goal-projected columns stay null.

### NEVER null `resolved.costPerOutcomeUsd` for a 0-outcome workflow — the floor IS the exploration device, and nulling it STARVES the fleet (v0.107.2 tried it, v0.107.3 reverted)

**Standing product rule (Kevin, 2026-07-29): a workflow with no outcome must ALWAYS return a number.**
`resolved.costPerOutcomeUsd` is the cascade floor `max(spend, parent)` when the workflow has produced zero
of the goal's outcome, and that is CORRECT — it is a rankable estimate, not noise to gate away.

v0.107.2 gated the field on `grainHasObservedOutcome` (nulling it when no grain observed the outcome) to
stop the Strategy page crowning a 0-reply workflow. **Wrong; reverted in v0.107.3.** Two reasons, both
load-bearing:

- **Starvation.** campaign-service's `selectWorkflowGreedy` SKIPS a null-cost row ("no rankable
  economics"), so a nulled workflow is never selected → never runs → never produces an outcome → stays
  nulled. An absorbing state, and a **newly added workflow** (zero evidence by definition) could never
  enter rotation at all — it would have frozen the fleet's workflow mix.
- **The floor self-corrects; it IS the explore/exploit mechanism.** Barely-tried reads cheap → gets picked
  → spends → its floor RISES → it drops out on its own once it outspends the alternatives with nothing to
  show. In prod the husks read $61–$77 against measured workflows at $64–$421 — a 4% gap, not an order of
  magnitude. Do not describe a barely-used workflow as "artificially cheap".

**Number and LABEL stay decoupled — that is the correct place for honesty.** `resolved.grain` still runs
`grainHasObservedOutcome`, so a floored row is labelled `crossOrg` (benchmark) and never "this brand's own
results". The number always exists (rankable, explorable); the label never lies (displayable). Guard test:
`audience-cost-coherence.test.ts` → "a workflow with ZERO of the goal's outcome still reports a rankable
number, never null (exploration must not starve)".

**The coherence fix went the OTHER way (v0.107.5): `fetchBrandProjectedParents` DROPPED its own
`grainHasObservedOutcome` filter** so its argmin is byte-for-byte the dashboard's ungated
`pickBestBrandRow`. Both surfaces now price an audience off the same cheapest workflow, floors included.
The rule is one-directional and worth stating plainly: **align the PICK, never gate the shared ranking
metric.** Gating the metric starves exploration fleet-wide; aligning the pick costs nothing and is what the
customer actually sees.

### Verifying the coherence invariant at a SECOND goal — compare the COMPARABLE field, or you manufacture a false mismatch

`/audience-stats`' cost column is goal-dependent (`sortMetricForGoal`): for `positiveReply` it is `cpprCents`
(cost per reply), for the click-driven goals it is `cpcCents` (cost per CLICK). `workflow-projection`'s
`resolved.costPerOutcomeUsd` is the cost of the GOAL's outcome. Those coincide ONLY for the single-step
goals, where the driving outcome IS the outcome. At `meetingBooked` / `websitePurchase` / `signup` the goal
outcome is a MEETING / PURCHASE / SIGNUP reached THROUGH the funnel, so comparing `cpcCents` against
`costPerOutcomeUsd` pits a per-click cost against a per-meeting cost — a units error that reads as a large
"mismatch" and invites a fix for a bug that does not exist. The comparable projection field for a
`cpcCents` column is `resolved.costPerClickUsd`.

**And subtract the residual regime before calling anything a mismatch:** an audience whose OWN spend exceeds
the benchmark legitimately shows that spend on the accounting surface (`max(own spend, parent)`), and
`/audience-stats` sums an audience's spend across ALL workflows while `workflow-projection` splits it per
dynasty — so the two legitimately differ ABOVE the benchmark. Coherence is required only in the LOW-spend
regime. Verified 2026-07-29 on prod brand `b97440f6…`: at `positiveReply` all four audiences matched at
$64.11; at `meetingBooked` all four differed purely because their own spend ($4.61 / $2.63 / $3.01 / $5.11)
sat above the $2.2151 benchmark — documented behaviour, not a regression.

### An UNSTARTED audience is priced like its barely-started siblings — `flooredCostPerOutcome`/`derivedCostPerOutcome` no longer special-case the empty cell

Both display engines used to return `null` for a 0-spend AND 0-outcome cell even when a positive parent
existed. But the Strategy page ALWAYS has a row for such an audience (its per-audience pick falls back to
the best workflow's brand row), so four equally-unstarted audiences rendered as "three priced, one blank" —
the blank one reading as "no estimate available" beside siblings differing only by a few cents of spend.
Never-started is not a distinct regime from barely-started: both are un-evidenced and both floor to the same
benchmark. The engines now let the empty cell fall through to the normal `max(spend, parent)` / funnel
projection (a pure DELETION of the guard); `null` survives only when there is genuinely nothing to fall back
on — no parent and no projection — which is still the cold-start case that must never fabricate a value.

### A DERIVED (funnel) column at 0 outcomes takes the audience's own PROJECTION, NEVER its raw dollar total — `derivedCostPerOutcome`, per-(audience × winning workflow)

Split the five cost columns by what their outcome IS. A **RAW** column (`cpcCents`, `cpprCents`) has the
driving outcome AS the outcome, so a raw dollar total is a sound lower bound — "$23.16 spent, 0 clicks →
a click costs at least $23.16" — and it keeps `flooredCostPerOutcome`'s `max(audience spend, parent)`.
A **DERIVED / funnel** column (`cpfsCents`, `cpsCents`, `cpsaleCents`) reaches its outcome THROUGH an
observed website visit at the brand's conversion rate; flooring it on a dollar total is a **units error**
that ALSO discards the clicks the audience did observe. Those three now use **`derivedCostPerOutcome`**
(`cost-engine.ts`, the 4th named engine): real ratio at ≥1 outcome → null when truly empty → else the
audience's FUNNEL PROJECTION → raw cascade floor only at cold start (no economics ⇒ no funnel, and
nothing on either surface to be coherent with).

The projection is `fetchBrandProjectedParents`'s `byAudience` map, and it mirrors the consumer that
RENDERS the per-audience row — which is a DIFFERENT rule from the brand-level pick above. The Strategy
page's per-audience table (`strategy-model.ts` `pickAudienceOrBrandRow` → `pickAudienceGrainRow`) is
**WORKFLOW-AGNOSTIC**: among ALL of an audience's rows whose RESOLVED GRAIN is `"audience"`, it renders
the one with the lowest `resolved.costPerClickUsd`. So `byAudience` takes, per audience, the dynasty
where it has send-tag spend AND MEASURED the goal's driving outcome (`grainHasObservedOutcome` — a
0-outcome audience block is labelled `brand`/`crossOrg` by `resolvePick`, so it is not a candidate on
either side), lowest resolved click cost wins, and THAT row's unit costs feed the funnel.

**Do NOT key this to the brand-level winner, and do NOT use `recommendedWorkflowDynastySlug`.** All three
picks differ in prod, and only the workflow-agnostic one is what the customer sees. `pickBestBrandRow`
carries the dashboard's own warning: `recommendedWorkflowDynastySlug` is a backend argmin that spans
per-audience rows (it exists for campaign-service's per-run audience selection), so a single cheap 2-click
audience row can crown a dynasty whose brand-level cost is bad. For the CEO Defense-Tech audience:
**$12.14** (`pelican`, $3.035/click — rendered) vs $13.49 (`permafrost`, the brand-best) vs $23.08
(`dawn`, `recommendedWorkflowDynastySlug`).

**An audience that observed NO driving outcome anywhere is ABSENT from the map on purpose** — that is
exactly the regime where a raw dollar total IS the legitimate answer, so `derivedCostPerOutcome` falls
through to `max(own spend, parent)` and the anti-flattering protection is preserved intact (unchanged
behaviour, covered by the pre-existing `audience-stats.test.ts` 0-click case).

`fetchAudienceGrainEvidence` now takes the caller's already-resolved audience ids, so this adds **zero**
human-service round-trips and covers paused / archived rows too.

**The prod bug (2026-07-29, brand `6e21bb6c…`, goal formSubmission, net):** three audiences with real
observed clicks and zero form submissions each displayed their own raw net spend, to the cent, as their
cost per form submission — $23.16 / $33.19 / $45.23 — while the Strategy page priced the same audiences
at $11.24 / $10.18 / $12.14. Both surfaces now agree.

**Tested invariant (`src/routes/audience-cost-coherence.test.ts`)**: driven by ONE downstream fixture,
an audience gets the IDENTICAL number from `/audience-stats` `metrics.*Cents` and from the row the
Strategy page actually renders (the suite replicates `pickBestBrandRow` + `pickAudienceGrainRow` rather
than reading whichever row is convenient) — for a 0-outcome audience whose own spend is below the parent
(goal metric AND click column), for the 0-outcome-WITH-clicks funnel regime ($80 = its own $20 click cost
through a 25% visit→form rate, not the $8 fleet benchmark and not its $40 raw spend), and for the
multi-dynasty case where the audience's cheapest MEASURED leg is NOT the brand-best workflow ($6.00 on
`wf-pricey`, not $80 on `wf-cheap`). It fails on the pooled parent (8.03 vs 2.00), on a per-column blend
($2.00 vs $4.00 click) and on the raw-spend floor (40 vs 80), so the agreement is by construction.

**The residual regime — own spend still wins above the benchmark.** An audience that observed NO driving
outcome keeps the plain `max(own spend, parent)` floor on its derived columns too (it has no measured
audience grain, so there is no projection to prefer) — unchanged behaviour, still covered by the
pre-existing `audience-stats.test.ts` 0-click case. What DOES legitimately differ between the surfaces is the RAW columns:
audience-stats sums an audience's spend across ALL workflows while workflow-projection splits it per
dynasty, so an audience that outspent the benchmark shows its own (higher) spend on the Audiences table.
That is the cascade behaving as documented, not a new incoherence.

Reuses workflow-projection's own reads verbatim (no new field/endpoint/persisted state, shapes unchanged
→ no OpenAPI regen). `cost-per-outcome-trend` / `-lifetime` / `-distribution` stay POOLED on purpose (a
different methodology on a different axis). (Set 2026-07-29; derived-column split same day.)

## `/revenue` `spend` cost-per-outcome is FLOORED at the SAME best-workflow benchmark the per-audience rows use — the brand/campaign AGGREGATE twin of the section above

Every cost-per-outcome on the `/revenue` `spend` block (`totalCpcCents`/`actualCpcCents`/
`provisionedCpcCents`, `cpprCents`, `cpsCents`, `cpsmCents`, `cpfsCents`, `cpSaleCents`) runs the SAME
zero-outcome engine `/audience-stats` runs per audience, floored against the SAME parent
(`fetchBrandProjectedParents` — the goal's winning workflow, crossOrg → brand ladder). The Overview card,
the Audiences table and the Strategy page therefore cannot print two prices for one brand + goal + moment.

**The bug (prod 2026-07-30, brand `b97440f6…`, goal positive_replies, `pricing=net`):** these columns were
`observedCostPerOutcome`, i.e. **null at 0 outcomes** — and the dashboard's null-fallback then rendered the
brand's own total committed spend, so **"Cost per positive reply $28.74" sat directly above "Total spent
$28.74"** while the Strategy page priced the same brand at **$62.98** (`dawn`, grain `crossOrg`). Now
`cpprCents` = 6298: `max(own committed spend $28.74, benchmark $62.98)`.

- **Goal source = the brand's OWN declared `optimizationGoal`** (`fetchBrandSavedEconomicsWithGoal`,
  brand-service INTERNAL saved economics — never the cross-brand average, a goal must be the brand's own).
  It selects the winning workflow, exactly as the `goal` query param does on `/audience-stats`.
  **NO declared goal → the whole block stays OBSERVED (null at 0 outcomes), and the projection is not even
  fetched:** "the goal they optimise for" does not exist, so there is no expected cost to be coherent with.
- **RAW columns** (cost per click / positive reply — the driving outcome IS the outcome) →
  `flooredCostPerOutcome` = `max(own spend, parent)`. **SPEND-WINS ABOVE THE BENCHMARK IS INTENDED**, not a
  bug: a brand that already outspent the expected cost with nothing to show reports its own (higher) spend
  — the identical conservative floor the audience grain applies. All THREE CPC variants floor against the
  same parent on their OWN spend basis; the block has never claimed `total == actual + provisioned` for a
  RATIO, so at 0 clicks they legitimately coincide (three lower bounds, one benchmark).
- **FUNNEL columns** (signup / sales meeting / form submission / sale — reached THROUGH a click or reply at
  the brand's conversion rate) → `derivedCostPerOutcome` on the winning workflow's projection. A raw dollar
  total under a funnel label is a UNITS ERROR, so when the goal's projection does not resolve that column's
  rate (e.g. cost per form submission is only projected for the form-submission goal) the column stays
  **null**, never the spend total. The own-spend protection is not lost: the driving unit cost fed to the
  projection is itself `max(own spend, fleet)` at 0 driving outcomes.
- **Grain:** brand, and campaign when `?campaignId=` is set (own spend narrows, the parent stays
  brand-level — the same cascade one grain finer). `?groupBy=campaignId` groups carry no `spend` block and
  are untouched; `?lens=` is untouched.
- **`pricing` threads through** — the parent is fetched with the caller's selector, so a NET request floors
  net-on-net.
- **ZERO audience fan-out**: the aggregate passes `audienceIds: []`, so `fetchAudienceGrainEvidence`
  short-circuits — no human-service round-trip, no per-audience cost/outcome reads (guarded by a test).
- **Fail-SOFT with a loud log** (`fetchSpendCostParentsSoft`), the same display-enrichment pattern as the
  conversion-count tiles + the `sequences` series on this same Overview path: a projection blip degrades
  the columns to today's OBSERVED behaviour (null = "we could not estimate this"), it does **NOT** 502 the
  customer's Overview, and it NEVER degrades to the raw-spend floor (that is the bug being removed).

`BrandProjectedParentsUsd` gained `cpsmUsd` (cost per booked meeting) for `cpsmCents`; `/audience-stats`
has no meeting column and ignores it. Response shapes unchanged (same fields, same `number | null` types)
→ no OpenAPI regen. Guard suite: `src/routes/revenue-aggregate-cost-floor.test.ts` drives `/revenue` and
`/workflow-projection` from ONE downstream fixture, so the equality is a property of the two computes.
(Set 2026-07-30.)

## Staff admin metrics — DAILY BUDGET (+ its MRR/ARR projection) is the RAW configured value, NEVER discounted; realized-revenue stays NET (supersedes PR #592's discounted-budget)

The per-org usage discount is a modifier on CHARGES only (frozen gross+net per cost row in the runs/billing
ledger). The DAILY BUDGET is a **configuration ceiling, not a charge**, so the discount is NEVER applied to
it: two orgs with the same configured budget show the SAME daily budget regardless of their discounts.
PR #592 wrongly applied the discount to the budget display (an $8/day, 50%-discount org showed $4/day); that
is reverted — the net/gross budget split (`grossDailyBudgetUsd`, `stats.gross*`, `applyDiscount`,
`fetchOrgUsageDiscountPct`, the `usage-discount` fetch) is **DELETED** (a config budget has ONE true value,
no "net budget"; the admin only ever read `dailyBudgetUsd`, so the gross* twins had zero external consumers).

- **`/internal/stats/accounts` (`buildAccountsAudit`)** — per-brand `dailyBudgetUsd` = the RAW configured
  billing daily-budget (undiscounted). Fleet `stats.totalDailyBudgetUsd`/`mrrUsd`/`arrUsd` are pure budget
  projections (Σ active budget, × 30, × 365) → undiscounted too. The ACTIVE verdict + row sort gate on this
  same raw budget vs the actual balance (no separate gross field). `customer-health` reads `dailyBudgetUsd`
  directly.
- **`/internal/stats/revenue`** — committed MRR/ARR (`currentMrrUsd`, `committedMrr.*`) are budget
  projections (Σ active budget × 30) → **undiscounted** automatically (they read the accounts-audit
  `stats.mrrUsd`/`totalDailyBudgetUsd`). **Realized-spend buckets STAY NET** (actual charges) — they read
  runs' **frozen-NET twin `netActualCostInUsdCents`** on `/v1/stats/public/costs/timeseries`
  (`selectBucketActualCents`, `revenue-history-client.ts`); those are real billed spend, so net is correct.
  The distinction: budget-derived = undiscounted (config projection), realized-charge = net (money we bill).

**Why in-place:** the admin renders `dailyBudgetUsd`/`mrrUsd` verbatim (no discount math of its own), so
fixing the value at the source corrects the admin display with ZERO dashboard change (distribute.you is
main=prod Vercel, no staging buffer).

**Realized-revenue NET is DORMANT + self-activating until runs ships net-on-timeseries.** The frozen-net
twin is live on the UNTIMED `/v1/stats/public/costs` (runs#179) but **NOT yet on `/costs/timeseries`**
(verified via api-registry + a live call — timeseries buckets carry only gross today; runs is shipping it
in parallel). `selectBucketActualCents` prefers `netActualCostInUsdCents`; when absent it **falls back to
GROSS with a loud one-shot `console.warn`** (= today's number — the LIVE staff Revenue view must not break)
and self-activates to NET the instant runs deploys the twin. A bucket missing BOTH fields fails loud
(corruption). This gross-fallback-with-warn is the correct transition for a LIVE surface with an
unshipped-producer dependency — distinct from the customer-facing `?pricing=net` doctrine (fail-loud 502)
which only applies to an opt-in surface with an "X% off" banner and no live consumer yet. (Set 2026-07-16.)

## `?pricing=gross|net` — GROSS (default) vs NET on the cost-metric endpoints; NET reads runs-service's FROZEN net, NEVER a read-time discount multiply (supersedes PR #510)

The customer-facing cost-metric endpoints (`/revenue`, `/stats` + `/features/:slug/stats`,
`/audience-stats`, `/workflow-projection`) accept `?pricing=gross|net`. **GROSS is the DEFAULT** — an
omitted or `gross` selector is byte-identical to today (existing callers — campaign-service
`metrics.cpcCents`, cross-org public revenue — never send `pricing` → always gross). `net` shows the
org's metrics at the discounted price it actually pays (dashboard coherence with a "you have X% off"
banner); staff/internal keep gross.

**NET sources runs-service's FROZEN net cost amounts — features-service does NOT recompute the discount
(supersedes #510's read-time multiply).** runs-service freezes each cost row's usage discount AT WRITE
TIME (runs-service#179): every `/v1/stats/costs` + `/v1/stats/public/costs` group now returns BOTH the
gross fields (`totalCostInUsdCents` / `actualCostInUsdCents` / `provisionedCostInUsdCents`) AND their
frozen-NET twins (`netTotalCostInUsdCents` / `netActualCostInUsdCents` / `netProvisionedCostInUsdCents`).
So NET pricing simply READS the net twin instead of the gross field at the COST INPUT — no billing
discount fetch, no `1−pct/100` factor, no multiply. `lib/pricing.ts` `selectCostCents(group, grossField,
pricing)` / `selectCostCentsString(...)` pick gross-vs-net per group; threaded into every cost PRODUCER —
`fetchRunsCostCents`, `fetchSpendBreakdown`, `fetchRunsStats`, `fetchAudienceCosts`, `fetchPublicCosts`
(crossOrg fleet grain), and workflow-projection's brand+audience grain fetchers. Every money metric (CPC,
cost-per-outcome/-close, total spent, revenue spend, CAC, ROI, roiMultiple, cacPct, recommendedBudget) is
DERIVED from these cents, so reading the frozen-net cents at the input makes spend/CPC/CAC come out net
and ROI scale UP by construction, coherent — no field-by-field output classification. **A NEW money field
is net automatically IF it derives from a producer that reads via `selectCostCents`; if you add a cost
read, thread `pricing` into it and select the field — do NOT post-process the response, do NOT reintroduce
a discount multiply.** Counts, conversion rates, and probabilities never touch cost → unchanged in net.

**`resolveDiscountFactor` / `discountCents` / `billing-discount-client.ts` are DELETED.** NET no longer
calls billing at all (the read-time discount fetch is gone). The old billing-service usage-discount GAP
(#248) is moot for this feature — the discount now lives frozen on the runs cost row, owned by
runs-service, not read live from billing.

**Fail-loud, no silent fallback.** `parsePricing` defaults to gross with NO Zod `.default()`; an invalid
value → 400. NET requires the frozen net twin on every cost group it reads: `selectCostCents(..., "net")`
THROWS (→ 502) when the `net*` field is absent / non-numeric — NET NEVER falls back to gross (that would
show undiscounted prices under the "X% off" banner). A non-discounted org has frozen net == gross per row
(runs freezes a 0% discount), so NET == GROSS for it BY CONSTRUCTION — no special-casing here. `pricing`
is in every Gold `scope_key` so gross/net never collide in the snapshot cache.

**`pipeline-activity` IS wired too** — this SUPERSEDES the earlier "intentionally NOT wired, there is
nothing to discount" note. It surfaces no cost COLUMN, but its expected series are **money-DERIVED**:
`expected.outreach = dailyBudgetUsd / effectiveOutreachUsd`, and that divisor is a cost per outreach. See
the dedicated section below.

**Deploy ordering.** NET reads runs' `net*` fields, so on any env where runs-service predates #179 it
fails loud (502) while GROSS (the default) is unaffected. Live since runs#179 deployed. (Set 2026-07-10;
supersedes #510's read-time compute, PR #517 → v0.87.6.)

**Base-branch lesson (2026-07-10):** when SUPERSEDING a PR, verify where the superseded code ACTUALLY
lives (`git cat-file -e origin/<b>:<file>`) rather than trusting the brief's named branch — a fresh add of
the same file on the wrong base ADD/ADD-conflicts the real one on promotion.

## `cost-engine.ts` — FOUR named engines are the SINGLE source of truth for "cost per outcome"; default = projected everywhere except accounting

Every stats surface computes "cost per outcome" through ONE of FOUR named functions in `src/lib/cost-engine.ts` —
never an inline `spent / count`. This keeps the 0-outcome decision homogeneous across endpoints.

- **`observedCostPerOutcome(spentUsd, observedCount) → number | null`** — "what actually happened"
  (ACCOUNTING / real spend). `null` (renders "-") when 0 spend OR 0 outcomes; NEVER fabricates a number
  that wasn't measured. Use ONLY for real-money / bookkeeping surfaces.
- **`projectedCostPerOutcome(spentUsd, observedCount, parentCost?) → number`** — "rankable estimate"
  (the RANKING default). Real ratio when `observedCount > 0`; else the CASCADE FLOOR `max(spentUsd, parentCost)`.
  NEVER null when there is spend — a rankable surface must always yield a comparable number. `parentCost`
  = the same unit cost on the next COARSER grain (crossOrg → brand → audience), iterative; omit when the
  surface has no coarser grain → floor degrades to own spend (`max(spentUsd, 0)`), the cascade's base case.
- **`flooredCostPerOutcome(spentUsd, observedCount, parentCost?) → number | null`** — the DISPLAY variant:
  `projectedCostPerOutcome`'s floor, with an honest `null` ONLY when that floor is 0 (no spend AND no
  positive parent — nothing to fall back on). Real ratio when both present; else `max(spentUsd, parentCost)`.
  Use where the value is DISPLAYED and a coarser grain can back-stop it (audience → brand): a 0-outcome
  audience with spend shows the brand-floored estimate (never a raw tiny-spend value below the brand cost,
  never null), and an UNSTARTED audience (0 spend, 0 outcomes) shows that SAME parent — it is no less
  evidenced than a sibling that spent a few cents, and the Strategy page shows it the same benchmark row, so
  blanking it alone produced the "three priced, one blank" split. This lets the dashboard render the server
  value directly (no client-side spend fallback). Distinct from `projected` (never null — ranking) and `observed` (null on any
  0 outcome — accounting). **RAW columns only** — one whose driving outcome IS the outcome (cost per
  website visit / positive reply). A FUNNEL column takes `derived` instead.
- **`derivedCostPerOutcome(spentUsd, observedCount, funnelProjectionUsd, parentCost?) → number | null`** —
  the DISPLAY variant for a FUNNEL column, whose outcome is reached THROUGH an observed driving outcome at
  the brand's conversion rate (cost per form submission / signup / sale). A raw dollar TOTAL is a sound
  lower bound only for a RAW column; answering "cost per form submission" with a total spend is a units
  error AND discards the clicks the grain observed. Order: real ratio when both present →
  `funnelProjectionUsd` (the grain's RESOLVED driving unit cost through
  `projectOutcomeCosts`, i.e. its own evidence AND the number the projection surface resolves for it) →
  the raw cascade floor `max(spentUsd, parentCost)` only at cold start (no economics ⇒ no funnel), `null`
  only when that floor is 0 too. An unstarted grain is NOT special-cased — same projection as its
  barely-started siblings. The
  "already outspent the benchmark" protection is not lost: the driving unit cost fed to the funnel is
  itself `max(own spend, parent)` at 0 driving outcomes.

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
| `audience-stats` `cpcCents`/`cpprCents` (RAW) | **floored** (cascade audience→brand, DISPLAY) | The click / reply IS the outcome, so the raw-spend floor is sound. A 0-outcome audience with spend → max(spend, brand cost-per-outcome), never a raw tiny-spend value, never null; 0-spend + 0-outcome → null. The brand parent is the FLEET-BACKED cross-org **BEST-WORKFLOW** projected cost (see the best-workflow section at the top), NOT a brand-own aggregate and NOT a cross-workflow pooled average. campaign-service NO LONGER reads audience-stats (it ranks on `workflow-projection` `resolved.costPerOutcomeUsd`), so the floor does not touch its ranking. |
| `audience-stats` `cpfsCents`/`cpsCents`/`cpsaleCents` (DERIVED/funnel) | **derived** (per-(audience × winning workflow) projection) | A form submission / signup / sale is reached THROUGH a click, so at 0 outcomes these take the audience's own funnel projection under the goal's winning workflow — byte-equal to `workflow-projection` `resolved` for the same row — NEVER the audience's raw dollar total (the prod bug: cost-per-form-submission == net spend to the cent). |
| `/stats` `costPerRecipient*` (registry `type:"currency"`) | **observed** | DONE (PR3) — brand is the TOP grain here (no coarser grain fetched → no cascade), so observed (null on 0). Also killed a latent false-$0 (0 cost / >0 outcomes → was $0, now null). |
| `/public/stats/cost-projection` | **projected** (already EV) | not yet routed through the module |
| `pipeline-activity` | n/a (no cost ratio) | It computes forecast **RATES** (`openPerOutreach`…) not costs; its local `ratio` returns `null` on 0-denom = correct for a displayed rate. Nothing to route. |
| `/revenue` `spend` — RAW (`total/actual/provisioned Cpc`, `cppr`) | **floored** (cascade brand/campaign → best-workflow benchmark, DISPLAY) | Was observed-only, which rendered as the brand's own total spend under a cost-per-outcome label. Now the AGGREGATE twin of the per-audience rows: `max(own committed spend, the goal-winning workflow's projected unit cost)`. Falls back to **observed** when the brand declares no goal, or when the projection read degrades (fail-soft). |
| `/revenue` `spend` — DERIVED/funnel (`cps`/`cpsm`/`cpfs`/`cpSale`) | **derived** (best-workflow projection, DISPLAY) | Same units rule as the per-audience funnel columns — a raw dollar total is never an answer to "cost per signup". `null` when the goal's projection does not resolve that column's rate (never the spend total), and **observed** on the no-goal / degraded paths. |

**Rate helpers are NOT part of the cost engine and legitimately differ by consumption — do NOT "homogenize" them.**
`platform-rates-client.ratio` returns **0** on 0-denom because its rates are MULTIPLIED in the EV funnel
(`funnel-registry.ts` `r.sentPerContacted * pCloseSent` …) — `null` would poison the product with NaN.
`pipeline-activity.ratio` returns **null** on 0-denom because its rates are DISPLAYED (0 contacted → unknown
rate, not 0%). Same observed/projected-style polymorphism as cost: a multiplied rate needs a number, a
displayed rate needs null. Neither is buggy.

**A surface uses `projected` only where it HAS a coarser grain to floor against inside the endpoint;
a top-grain surface with no coarser grain fetched uses `observed`.** workflow-projection has the full
crossOrg→brand→audience ladder; audience-stats floors audience→brand, where the brand parent is the
FLEET-BACKED cross-org BEST-WORKFLOW projected cost (`fetchBrandProjectedParents`), so it lands on the
same number the Strategy page shows; `/stats` is brand-only (no fleet parent fetched) → observed.

**Engine guard:** `projectedCostPerOutcome` returns a real ratio ONLY when BOTH spend > 0 AND outcomes > 0;
a 0-spend / >0-outcomes cell (cost un-attributed but outcomes tracked — the ~3% audienceId cost-tag gap)
would be a false $0 as `spent/count`, so it floors to the parent instead (or null via `observed` when the
parent is absent). workflow-projection never hits this (grains built only at spend > 0).

All three wirings kept response shapes unchanged → no OpenAPI change. (Set 2026-07-07.)

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

## COMBINED-`sales` goal cost = the BEST converting channel (`min` of visit→paid vs reply→paid), NEVER the population SUM (supersedes #615)

`projectOutcomeCosts(...).costPerSaleUsd` (the combined-`sales` goal's cost-per-outcome == cost-per-paid
client, drives its ranking + headline ROI/CAC on `workflow-projection` + the cross-org objective surfaces)
= **`min(clickUsd/v2pc, replyUsd/r2pc)` = `1 / max(visitPaidPerBudget, replyPaidPerBudget)`** — the
CHEAPER of the two single-step paid-client costs (visit→paid, reply→paid). A sale is won via the BEST
channel, so combined-sales reduces to the best of its two single-step goals and is coherent by
construction (≥ the best channel; can NEVER read below either single path).

**Do NOT restore the population-SUM `salesPerBudget = (1/clickUsd)·v2pc + (1/replyUsd)·r2pc` (#615).** The
SUM adds the channels' sales-per-budget, so a workflow merely CHEAP on a near-zero-conversion channel
(e.g. clicks at 0.5% visit→paid) had its cost-per-sale DILUTED below its real, higher-converting reply
channel — it (a) RANKED the wrong workflow best (rewarded cheap-on-visits over genuinely-good-at-converting)
and (b) produced a combined headline cost BELOW every per-audience row (internally incoherent). Repro
(features-service#630): LTR $2500, visit→paid 0.5%, reply→paid 20% — SUM gave Dawn $204/sale (< its own
$240 reply-path cost) and headline 12.2x over a best-audience 8.7x; MIN gives Dawn $240, Granite $230 →
Sales picks Granite = the positiveReply goal's pick (the reply path IS this brand's real acquisition
route). Same doctrine as the per-goal `costPerPaidClient` section above: no combined/downstream cost may
read cheaper than the honest single-path cost.

The per-LEAD sale probability (`combinedSaleProbability`, revenue lens EV) STAYS the `orP` of the two
paths — a DISTINCT quantity (a lead converts at most once, P ≤ 1), not a cost-ranking one. Do NOT conflate
the two combinations. `costPerSaleUsd` shape unchanged (internal lib field) → no OpenAPI regen; auto-flows
to `objectiveCostPerOutcome` (cross-org) + `paidClientCostForGoal`/`outcomeCostForGoal` (workflow-projection).
(Set 2026-07-19.)

## `sales` means TWO different things — resolve it by ENTRY POINT (`matchBrandServiceGoal` for a producer payload, `matchCombinedSalesGoal` for a caller's param), never with one resolver

The token `sales` arrives through two doors carrying opposite meanings, so `src/lib/goals.ts` keeps two
resolvers and they must never be merged:

- **brand-service PAYLOAD** (`salesEconomics.optimizationGoal` on `/internal/brands/:id/sales-economics`;
  a declared funnel's `goal` / `currentGoal` on `/internal/brands/:brandId/sales-funnels`) →
  **`matchBrandServiceGoal`**, where **`sales` = WEBSITE PURCHASE**. That is brand-service's older,
  data-backed meaning, documented there as unchangeable: the legacy `sales` wire spelling "ALWAYS means
  website-purchase, and can NEVER be re-purposed for the new combined goal (that would silently
  reinterpret every stored purchase-brand)". Its INTERNAL read deliberately collapses the
  `website_purchase` wire sub-type onto `sales`, so **every** stored purchase brand reads back as `sales`
  (verified live on `emailtoolshub.com`: stored `website_purchase`, current goal `purchase` → `"sales"`).
  The combined goal has its own brand-new token there — `combined_sales` / runtime `combinedSales` —
  which the old dashboard never sends, so it can never collide with a stored purchase row.
- **a CALLER's REQUEST PARAM** (`goal` / `objective` / `lens`) → `matchCombinedSalesGoal` /
  `normalizeObjective`, where **`sales` = COMBINED sales**, because the dashboard's local enum spells the
  combined goal `sales` and sends it verbatim (distribute.you `strategy-model.ts`
  `goalForOptimizationGoal("sales") === "sales"`). Unchanged until that migration lands separately.

**The bug (2026-08-01):** this resolver's doc comment asserted the `sales`=purchase mapping was "gone post
fleet-rename". brand-service never made that rename, so every website-purchase brand in prod (20+, real
customers) was bucketed into the COMBINED-sales fleet cost-per-outcome benchmark — polluting it and
leaving the website-purchase bucket empty. That number is customer-facing (the fleet benchmark the
Audiences + Strategy pages floor on, and the live rate the landing prints). Guard:
`src/lib/goals-entry-points.test.ts` drives BOTH doors and pins all three cases, naming the entry point
each value arrives through. An unrecognised value still returns null and is excluded from every bucket —
no silent fallback. Part of the fleet goal-vocabulary homogenization (distribute.you#3214); the rename
waves follow separately.

## Goal vocabulary — a NEW optimization goal goes in the CANONICAL `Goal` enum + `GOALS`, NEVER a parallel "ExtendedGoal" side-type

When adding an optimization goal (or renaming one), put it in the shared `Goal` enum + the `GOALS`
array and RIPPLE it through EVERY consumer — cross-org public/staff surfaces (`objectiveCostPerOutcome`,
`windowBaseOutcome`, `OBJECTIVE_GOAL_BUCKET`, `buildObjectiveAverages`, `normalizeObjective`,
`matchBrandServiceGoal`), customer-health, workflow-projection `goalToProjectionInputs`, the OpenAPI
enums. Do **NOT** create a parallel `ExtendedGoal = Goal | <new>` type to keep the goal OUT of `GOALS`
just so the `GOALS`-iterating cross-org/admin surfaces "stay byte-unchanged" — that bounded-blast-radius
dodge is a smell (two vocabularies, two names for one concept) and gets rejected ("no extended concept
remove that shit"). One fleet vocabulary is the rule, even when it means touching the staff analytics +
the admin dashboard. A goal with no paid-client economics (e.g. `whatsappConversation`) is still a plain
`Goal` member — its outcome cost is just CPC and its paid/ROI fields read null (null-safe).

**Non-breaking rollout across the cross-org response contract = a TRANSITIONAL byte-equal alias, not a
side-type.** When the rename changes a `Record<Goal,…>` response key the out-of-repo admin reads (e.g.
`avgCostPerOutcomeByObjective.purchase` → `.websitePurchase`), keep the OLD key as a transitional alias
(`{ ...objectives, purchase: objectives.websitePurchase }`) so the admin keeps rendering during the fleet
rename, and drop the alias once the consumer migrates (expand-contract). (Set 2026-07-19: `ExtendedGoal`
introduced for `sales`/`websitePurchase`, then `whatsappConversation` — removed entirely across PRs
#617/#622; `sales`+`websitePurchase`+`whatsappConversation` are now first-class `Goal` members.)

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
- `workflow-projection` (`objective`): `resolved.costPerOutcomeUsd` = the RAW unit cost of the outcome
  (`websiteVisit`→CPC = `unitCosts.clickUsd`, `positiveReply`→CPPR = `unitCosts.replyUsd`) — the visit /
  reply IS the outcome, matching audience-stats + the cross-org objective→cost doctrine. It is NOT the
  single-step PAID-CLIENT cost (that is `resolved.costPerPaidClientUsd` = raw / rate, which drives ROI +
  `recommendedBudget`); the two are DISTINCT by the visit/reply→paid rate. Returning the paid-client cost
  as the outcome cost made cost-per-outcome == cost-per-paid-client — an internally-incoherent pair when
  the rate < 100% (features-service#528). Fixed in `outcomeCostForGoal` (`workflow-projection.ts`).
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

## `workflow-projection` caches the EVIDENCE fan-out only — the brand's ECONOMICS is read LIVE on every request, NEVER cached

`GET /features/:slug/workflow-projection` splits into two halves and only the first is Gold-SWR-cached:

- **`fetchWorkflowProjectionEvidence`** (heavy, IO) — fleet workflows + fleet cost/outcome + brand grain
  + per-audience grain. Depends ONLY on `(featureSlug, brandId, pricing)`; economics- AND goal-independent
  → cached under view **`workflow-projection-evidence`**, `scopeKey = (featureSlug, orgId, brandId,
  pricing)`. One snapshot now serves EVERY goal (`objective` left the key — the evidence never depended
  on it).
- **`projectFromEvidence`** (pure, no IO) — the goal's 3-grain ladder + `resolved` + recommendation,
  derived from that evidence **plus `fetchEffectiveEconomics` fetched fresh on the request path**.

**The bug this fixes (do NOT regress by re-wrapping the whole compute in `servedCached`):** onboarding
writes the brand's sales economics, then the very next screen reads this endpoint. The old code cached
the ENTIRE response with a freshness key that ignored economics, so a read inside the stale window
replayed the PRE-write answer — brand `7604c385…` went lifetimeRevenue 2500 → 100 and kept showing the
2500-derived numbers. `roiMultiple = LTR / costPerPaidClient` (and `cacPct = 100/roi`), so the displayed
ROI/CAC were wrong by the full 25x ratio. The consumer must NOT have to ask for freshness — no
cache-bypass query param (any caller could then stampede the fan-out), no consumer-side poll/retry
(guessing at a producer's cache window). Economics is one cheap brand-service call; the fan-out it used
to ride along with stays off the request path.

**`WorkflowProjectionEvidence` MUST stay JSON-serializable** — the snapshot round-trips through a jsonb
column, so the grain fetchers' `Map`s are flattened to entry arrays in the evidence and rebuilt in
`projectFromEvidence`. A `Map` stored in jsonb deserializes as `{}` = a silent all-zero ladder. The
freshness suite (`workflow-projection-economics-freshness.test.ts`, cache ENABLED — the sibling suite
disables it) covers write→read-with-no-wait, repeated writes, no-refetch-without-change, and the jsonb
round-trip. Response shape unchanged → no OpenAPI regen. `computeWorkflowProjection` (customer-health's
"best workflow by CAC") keeps its signature and now composes the two halves. Old `workflow-projection`
snapshot rows are orphaned and harmless (the Gold layer is derived + rebuildable). (Set 2026-07-29.)

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

**`resolved` — NUMBER and PROVENANCE LABEL are DECOUPLED (do NOT re-conflate).** Two independent
selections in `resolvePick` (`workflow-projection.ts`):

- **NUMBERS** (`costPer*`, `roiMultiple`, `cacPct`) come from the finest grain **WITH SPEND**
  (`audience > brand > crossOrg`). That grain's unit costs already encode the cascade floor
  `max(spentUsd, parentCost)`, so a brand/audience that OUTSPENT the coarser grain with 0 outcomes keeps
  its OWN higher spend floor — the resolved number is NEVER collapsed down to the fleet value. (Collapsing
  a money-burning 0-outcome grain to the cheap fleet rate is the "artificially free" bug the cascade
  exists to prevent — do NOT resolve the NUMBER to crossOrg.)
- **`resolved.grain`** is the PROVENANCE **LABEL** the dashboard renders — the finest grain that actually
  OBSERVED the goal's outcome (replies for `positiveReply`, clicks for the click-driven goals, either
  channel for meeting-booked/purchase via `grainHasObservedOutcome`), else `crossOrg` (benchmark). A grain
  with spend but ZERO outcomes is a FLOORED projection, so it is NEVER labelled `brand`/`audience` (the
  dashboard renders that verbatim as "From this brand's own results" — a lie for a brand with 0 realized
  outcomes). A brand WITH real observed outcomes still labels `brand`/`audience` (no regression).

So a 0-outcome brand that spent $135 (fleet cost $10) → resolved cost = **$135** (its own floor),
`grain` = **crossOrg** (benchmark): the number stays brand-specific, only the label stops lying.
campaign-service ranks on `resolved.costPerOutcomeUsd`; `recommended` ranks on the same. (Set 2026-07-06;
provenance/number decoupled + single-step raw-outcome cost, features-service#528 2026-07-10.)

**Audience-grain SET must equal `/audience-stats`' set — enumerate the `groupBy=audienceId` cost
universe, NEVER the `groupBy=audienceId,workflowDynastySlug` couples.** `fetchAudienceGrainEvidence`
(`workflow-projection-grains.ts`) enumerates active audiences by their `groupBy=audienceId,workflowSlug`
cost couples (raw `workflowSlug` column) and maps each slug → dynasty LOCALLY via the same workflow
metadata the crossOrg/brand grains roll up through. Do NOT revert to `groupBy=audienceId,workflowDynastySlug`:
runs-service resolves `workflowDynastySlug` by grouping on `workflow_slug` then merging with `regroupByDynasty`
whose merge key is DYNASTY ALONE — it DROPS the co-grouped `audienceId`, collapsing every audience that
shares a dynasty into the single highest-spend one (only ~2 of 15 audiences survived → the Strategy
"Estimates by audience" table flattened the rest to the brand number). The raw-`workflowSlug` groupBy is
correctly multi-dim split; this makes the audience set + per-audience cost-per-visit agree with
`/audience-stats` by construction (identical `groupBy=audienceId` numerator + membership clicks; for
clicks>0 both return `spent/clicks`). General lesson: when a consumer needs a `(X × derivedDim)` split
from a producer, group on the RAW column + derive locally — a producer's derived-dimension regroup can
silently collapse the co-grouped `X`. Producer fix tracked in runs-service#174; features-service#488.
(Set 2026-07-08, PR #487.)

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
(Supersedes the earlier "stub MUST be a valid UUID" pin, #425/v0.70.3, REMOVED.) Forwarding a marker
string as `x-user-id` 400s at runs (`must be a valid UUID`); a valid-UUID sentinel was the band-aid.
These reads never needed a user at all — `x-user-id`/`x-run-id` are OPTIONAL on every one of them, so
`getRunsServiceHeaders`/`getBillingServiceHeaders` OMIT user/run/brand/feature when empty (the authed
path still forwards its real values) and the org-balance read uses billing's user-less
`GET /internal/accounts/by-org/:orgId/balance`. Any NEW cross-org fleet read: pass org-only, use an
`/internal/*` (org-in-path) producer endpoint — never fabricate a user. (Set 2026-07-01.)

## `GET /internal/stats/accounts` — fleet cold-email customer ACCOUNTS audit (api-key, staff-gated at api-service)

Cross-org, fleet-wide list of every cold-email customer account (org × brand) for the admin
"Audit → Accounts" page — the money-and-status analog of send-forecast. Handler `handleAccounts` in
`src/routes/public.ts`, pure assembly in `src/lib/accounts-compute.ts` (`buildAccountsAudit`,
injectable deps), new cross-org reads in `src/lib/accounts-client.ts`. 60s in-memory cache
(`__resetAccountsCache` seam), same pattern as the other `/internal/stats/*` audits. **All money +
the active determination + MRR/ARR are computed HERE; the dashboard renders only.**

Each row: `{ orgId, orgExternalId, ownerEmail, brandId, brandName, brandDomain, dailyBudgetUsd,
orgBalanceUsd, orgActualBalanceUsd, autoTopupEnabled, status }`. Response also carries `stats {
totalDailyBudgetUsd, mrrUsd, arrUsd, activeCount, pausedCount, inactiveCount, totalCount }` + `asOf`.

**STATUS rule (exact, single source `accountStatus(dailyBudget, actualBalance, autoTopup, paused)` — do
NOT re-litigate). Precedence paused > active > inactive:** (1) `paused === true` (campaign-service brand
pause) → `"paused"`; (2) else `dailyBudgetUsd != null && dailyBudgetUsd > 0 && (autoTopupEnabled ||
orgActualBalanceUsd > dailyBudgetUsd)` → `"active"`; (3) else `"inactive"`. The credit test uses the
**ACTUAL** balance (credited − ACTUALIZED usage), **NOT the spendable** figure — a provisioned hold is
in-flight ACTIVE spend, so subtracting it wrongly read the busiest accounts "inactive" (the bug this
fixed, features-service#502). An **auto-topup** org never runs dry → active regardless of the momentary
balance (`has_auto_topup` is OPTIONAL on the balance read — absent ⇒ not-enabled, so the actual-balance
path already corrects the verdict and auto-topup activates once billing ships it). A PAUSED brand keeps
its budget but campaigns are HELD — so it is neither active nor plain-inactive (paused wins even over a
funded budget). **All rows (active + paused + inactive) are LISTED — never dropped.**
`stats.totalDailyBudgetUsd`/MRR(×30)/ARR(×365) sum ACTIVE rows ONLY (a paused brand is not spending).
send-forecast's série-3 gate reuses `accountStatus` and counts only `"active"`.

**Account universe = the SAME source send-forecast uses** — lead-service `/internal/feature-memberships`
over the cold-email slugs (`coldEmailOutreachSlugs`), deduped to distinct (org, brand). Org-level reads
(balance + Clerk id + owner email) run ONCE per org; the daily budget + the brand pause state are
per-(org,brand); brand name/domain is one batched brand-service call. Fail loud on any read error.

- **paused** = campaign-service **`GET /brands/:brandId/pause`** → `{ paused }` (api-key + x-org-id; no
  user/run). The brand pause lives in campaign-service (NOT brand/billing): a brand can be paused while
  keeping a non-zero daily budget. No pause row → `paused:false` (active by default). Fail loud.

- **orgBalanceUsd / orgActualBalanceUsd / autoTopupEnabled** = billing **`GET
  /internal/accounts/by-org/:orgId/balance`** (user-less internal read — api-key only, org in path; NOT
  the user-required `/v1/accounts/balance`), read via `fetchOrgBalance` → `{ spendableUsd, actualUsd,
  autoTopupEnabled }`. `orgBalanceUsd` = `balance_cents/100` (SPENDABLE, incl. provisioned holds —
  DISPLAY only); `orgActualBalanceUsd` = `actual_balance_cents/100` (credited − ACTUALIZED usage — the
  figure the ACTIVE verdict gates on, since a provisioned hold is in-flight active spend);
  `autoTopupEnabled` = `has_auto_topup` (the DEPLOYED name on this balance read — verified live via
  api-registry: the SAME `has_auto_topup` name `/v1/accounts` uses; OPTIONAL, absent ⇒ false). A prior
  hotfix (#508) locked the wrong `auto_topup_enabled` name and read false for every org — billing had
  renamed it to `has_auto_topup` (billing#244/v0.46.0); the two crossed; corrected here to `has_auto_topup`. The ONE mapped status: billing **404 "billing account not found" → zero balances / no
  auto-topup** (an org that never funded a wallet is inactive by the rule). That is a documented billing
  semantic, NOT a swallowed error — do NOT "fix" it to fail-loud (it would 500 the whole fleet audit on
  one unfunded org). Any OTHER non-OK fails loud.
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
prod-only-dependency gotcha (railway-vars skill). Verified on prod v0.72.0. (Set 2026-07-01.)

## `GET /internal/stats/customer-health` — fleet "Customer Success" health board (api-key, staff-gated at api-service)

Cross-org, fleet-wide list of every cold-email customer (org × brand) — the SAME universe as the accounts
audit + active-users — for the admin "Customer Success" page. **One ready-composed HEALTH ROW per (org,
brand), currently-active first, a green/yellow/red badge each. ALL metrics computed + owned HERE; the
dashboard renders only (no browser math, no per-row fan-out).** Handler `handleCustomerHealth`
(`src/routes/public.ts`), pure assembly in `src/lib/customer-health-compute.ts` (`buildCustomerHealthBoard`,
injectable deps). 60s in-memory cache + **single-flight** (`__resetCustomerHealthCache` seam) — a miss fans
out per customer to SEVERAL heavy composites, so the single-flight guard is load-bearing (stampede rule).

**GRAIN = (org, brand)**, same as `/internal/stats/accounts` (economics/goal/audiences/workflows are all
brand-scoped). **Reuses the fleet composites wholesale** rather than re-enumerating: `buildAccountsAudit`
(identity + status + budget + balance) + `buildActiveUsersByUser` (per-org recency + retention). Then per
(org, brand) it enriches via the SAME computes the dashboard's own pages use — `computeFeatureRevenue`
(ROI), `computeAudienceStats` (audiences), `computeWorkflowProjection` (best workflow) — so a health-row
number never disagrees with the drill-down it summarizes. The EXACT cold feature per pair comes from a
per-slug `fetchFeatureMemberships` enumeration (the CSV call drops which feature a pair belongs to).

**Economics coherent BY CONSTRUCTION (owned formula).** `breakevenCacUsd = ltrUsd = economics.lifetimeRevenueUsd`;
the revenue engine's `costEconomics` gives `roiMultiple = pipeline/spend` and `cacPct = spend/pipeline×100`;
`currentCacUsd = (cacPct/100)×LTR`. So `roiMultiple = LTR/CAC`, `cacPct = CAC/LTR×100` — **GREEN's "ROI ≥ 1"
⟺ "CAC ≤ breakeven" ⟺ "%CAC ≤ 100%"**, one condition three views. These are surfaced **ONLY with the brand's
OWN saved economics** (`fetchBrandSavedEconomicsWithGoal`, source="user"); with no own economics the pipeline
would fall back to a cross-brand AVERAGE, so every economics-derived field is explicit **null** instead (never
an averaged ROI dressed as the brand's own) — and the revenue engine is not even called for those brands.

**Health badge (owned thresholds):** `red` = not active (paused/inactive/no budget); `green` = active AND
ROI ≥ 1 AND audience not near-exhausted (`pctUsed < 80`); `yellow` = active but ROI < 1 (or unknown) OR
audience `pctUsed ≥ 80`. The badge + its INPUTS are both returned (`health.inputs`).

**Audience size/remaining/%used** derive from `AudienceStatsRow.evidence.memberCount` — a NEW field added to
the audience evidence (`memberCount` = distinct member emails, ALREADY fetched for the outcome join, so free;
additive, `toMatchObject` tests unaffected). remaining = memberCount − contacted, %used = contacted/memberCount.
Best audience = the goal-ranked `audiences[0]`; best workflow = the lowest-positive `resolved.costPerOutcomeUsd`
row (name = `workflowDynastyName`, grain = `resolved.grain`).

**Conversion tracker** (`conversionTracker`): `needed` = goal ∈ {signup, formSubmission, purchase};
`observedConversions` = the goal's `fetchConversionCounts` count (null for websiteVisit/positiveReply — the
visit/reply IS the outcome); `firing` = INFERRED `observed > 0` (a clean installed/verified boolean is a KNOWN
GAP → `inferred:true` always). The billed-spend active-day timeline (cheap, already tracked) IS included
(`activeDays`).

**`notTrackedYet.dashboardReturnFrequency` is a REAL per-org PostHog signal (features-service#576).** It KEEPS
its slot under `notTrackedYet` for response-path stability with the dashboard, but is now populated (not the
old literal null). Per (org, brand) row it carries the org's dashboard-RETURN signal — `{ sessions7d,
sessions30d, pageviews7d, pageviews30d, lastSeen, daysSinceLastSeen }` — so the board flags disengaged-but-paying
customers. Source: ONE fleet-wide HogQL scan of `$pageview` events grouped by `person.properties.org_id` (=
the Clerk org id = the row's `orgExternalId`, NOT the internal org UUID), sessions counted via
`$session_id` (a "return" = a distinct session), via `src/lib/posthog-client.ts` `fetchDashboardReturnsByOrg`
(POST `{POSTHOG_API_HOST}/api/projects/{POSTHOG_PROJECT_ID}/query/`, `Authorization: Bearer {key}`). Fetched
ONCE per board build (dep-injected), joined per row on `orgExternalId`. **Fail-SOFT** — key-service / PostHog
unreachable / provider-not-registered / no data ⇒ explicit `null` on every row (NEVER a fabricated count, NEVER
a 502), the SAME display-enrichment pattern as the /revenue conversion-count tiles + sequences series (the
`posthog-client` itself is fail-LOUD; `buildCustomerHealthBoard` wraps the one call soft).

**`budgetChangeHistory` + `pauseHistory` are now TRACKED too — per-(org,brand) forward-only timelines consumed
from the producers (billing / campaign).** billing-service `GET /internal/brands/:brandId/daily-budget/history`
(→ `[{dailyBudgetUsd, changedAt}]`) + campaign-service `GET /brands/:brandId/pause-history` (→ `[{paused,
transitionedAt}]`), both api-key + `x-org-id`, oldest-first, via `src/lib/history-clients.ts`
(`fetchBudgetChangeHistory` / `fetchPauseHistory`). Shapes CONFORM to the DEPLOYED producer contracts (verified
live via api-registry — billing returns cents, converted to USD here), NOT a guess. Fetched PER customer inside
the enrichment fan-out, each **fail-SOFT independently** (own `.catch → null`): a billing blip nulls only
`budgetChangeHistory`, a campaign blip nulls only `pauseHistory`, neither degrades the row's economics or the
board. **Forward-only ⇒ an empty array is a legitimate "tracked, nothing yet" state, DISTINCT from `null` =
"couldn't read"** — do NOT collapse `[]`→`null`. All three `notTrackedYet` fields are now real signals kept in
that slot for response-path stability with the dashboard. No new env var (reuses BILLING/CAMPAIGN). (Consumer
wiring for billing-service#266 + campaign-service#270; features-service#576 shipped the PostHog twin.)

**The PostHog personal API key is resolved from KEY-SERVICE, NOT a features-service env var (do NOT
re-introduce a `POSTHOG_*_API_KEY` Railway var).** The fleet's single secret source is key-service platform
providers — the admin app (`distribute.you apps/admin/src/instrumentation.ts`) registers each `{provider,
envVar}` from its Vercel env into key-service at startup. `src/lib/key-service-client.ts` `getPlatformKey`
(mirrors ahref-service) fetches the decrypted key via `GET {KEY_SERVICE_URL}/keys/platform/posthog/decrypt`
(`x-api-key` + `X-Caller-*`), so the secret lives in ONE place and flows Vercel→key-service→features-service.
`POSTHOG_API_HOST` (`https://eu.posthog.com`) + `POSTHOG_PROJECT_ID` (`171095`) are NON-secret and DEFAULT in
code (env-overridable) — the only runtime dep is the standard fleet `KEY_SERVICE_URL`/`KEY_SERVICE_API_KEY`.
**Self-activates** once the `posthog` provider is registered in key-service; until then `getPlatformKey`
404s → null fleet-wide (dormant-safe). NO features-service Railway secret needed. The api-service proxy
(`GET /v1/features/audit/customer-success`) and the admin render already exist.
Same prod-only-balance gotcha as the accounts audit (billing balance → stripe-service, no staging runtime → the
whole board 502s on staging; **verify on PROD**). Triage: STAGING → feature. (PR #572; PostHog signal PR #577,
features-service#576, set 2026-07-15.)

## `pipeline-activity` `expected.outreach` DIVISOR is floored at the brand's OWN cost per outreach — the graph may never promise more sends than the brand's budget can buy

`computeExpectedActivity` divides the brand's daily budget by `bestWorkflow.outreachUsd` — the CROSS-ORG
cheapest-signup workflow's cost per outreach. Nothing brand-specific entered the forecast except the
budget, so a brand that structurally pays MORE than the fleet benchmark (more enrichment per lead, more
sequence steps) was promised sends it cannot afford, and the SAME page showed its real cost per outreach.

The divisor is now `max(bestWorkflow.outreachUsd, brandObservedOutreachUsd)`:

- **`brandObservedOutreachUsd`** = the brand's LIFETIME committed spend on this feature ÷ the recipients
  it contacted, summed over every dynasty — `fetchBrandObservedOutreachUsd`, reusing
  `fetchBrandWorkflowEvidence` (the exact brand-grain read `workflow-projection` already makes). SAME
  BASIS as the fleet figure (`totalCostInUsdCents` committed over `recipientStats.contacted`); only the
  SCOPE differs, so the `max` compares like with like. NOT `fetchDailyBroadcastActivity` — that only
  covers the requested `days` window (7 by default), far too thin a denominator to price a send.
- **Direction:** same cascade doctrine as `audience-stats` / `cost-engine.ts` (`max(own evidence,
  benchmark)`), inverted ONLY because the output is a COUNT — flooring the DIVISOR lowers the count, so
  the graph can never over-promise. The floor releases itself once the brand's ratio reaches the
  benchmark; a brand CHEAPER than the fleet keeps the fleet number (a `max`, never a raise).
- **No own-ratio** (0 spend OR 0 contacted — a fresh brand) → `null` → the fleet figure alone,
  byte-identical to before. Never a fabricated ratio.
- `opens`/`clicks`/`signups`/`formSubmissions` derive from `outreach`, so they fall proportionally.

**`computeFeatureOutreachUsd` (exported, consumed by `send-forecast-aggregate` for the ADMIN FLEET
send-forecast) keeps its behaviour UNCHANGED — no brand floor there**, that surface is legitimately
fleet-level and cross-brand. `buildWorkflowActivityUnits` now returns `{units, workflows}` so the brand
grain reuses the workflow metadata (no extra `fetchPublicWorkflows` call). Adds two brand-scoped reads
(runs `groupBy=workflowSlug&brandId`, email-gateway `groupBy=workflowSlug&brandId`) — both already made
by `workflow-projection`, and both covered by the existing `servedCached` scope key (featureSlug + orgId +
brandId + timezone + days; the new inputs are pure functions of brand + feature). Response shape unchanged
→ no OpenAPI regen, no dashboard change (`metrics.outreach.expected` renders verbatim).

**Prod (2026-07-29, brand `b97440f6…`, `sales-cold-email-outreach`):** $15/day budget returned
`expected.outreach` 107.717/day = $0.1393 implied per send, while the brand's real committed spend ÷
contacted was $14.67/36 = **$0.41**. At the $1/day budget the user reported, that printed **7** sends/day
against a reality of ~2-3. (Set 2026-07-30.)

## `pipeline-activity` accepts `?pricing=gross|net` — a COUNT can be money-derived, and this one is

`GET /features/:slug/pipeline-activity` takes the SAME `?pricing=gross|net` selector its sibling
cost-metric endpoints take (`/revenue`, `/stats`, `/audience-stats`, `/workflow-projection`), with the
same semantics: **GROSS is the DEFAULT** (omitted ⇒ byte-identical to before), NET reads runs#179's
FROZEN net twins (no billing call, no read-time multiply), an unknown value 400s, and a NET request whose
net twin is absent **fails loud (502) — never a silent fallback to full price**.

**Why it needed the selector at all (supersedes the "nothing to discount here" note in the `?pricing=`
section above).** This endpoint publishes no cost COLUMN, so it was skipped — but its expected series are
**money-DERIVED**: `expected.outreach = dailyBudgetUsd / effectiveOutreachUsd`, and the divisor is a cost
per outreach. Priced at FULL rate against a budget that is already-discounted REAL money, a 50%-off org
was promised roughly HALF the volume its budget buys. Prod 2026-07-30 (org `315bb5a3…` / brand
`6e21bb6c…`, `sales-cold-email-outreach`, $5/day): `expected.outreach` **15.88** for every future day
beside an actual of **30** — $197.45 gross ÷ 627 contacts = $0.3149/outreach, where the net $106.35 ÷ 627
= $0.1696 → 29.48, matching the real bars. The ratio 15.88/29.48 = 0.539 was exactly that org's net/gross.
**General rule: a metric does not have to be denominated in dollars to be wrong under a discount — if a $
figure appears anywhere in its derivation, it needs the selector.**

- **EVERY cost input reads the chosen basis — all three.** The fleet benchmark
  (`buildWorkflowActivityUnits` → `fetchPublicCosts`), the brand's OWN observed cost per outreach
  (`fetchBrandObservedOutreachUsd` → `fetchBrandWorkflowEvidence`), and the per-audience cost that ranks
  the forecast audience (`fetchAudienceCosts`). The first two are the two sides of the
  `max(fleet, own)` floor: mixing a gross figure with a net one compares two different currencies and
  can pick the WRONG side (guarded by a test where net-vs-net answers 12.5 and the mixed comparison
  answers 10). The audience read only ranks, but a per-row frozen discount can differ across rows, so
  the argmin is not guaranteed invariant — it is threaded rather than assumed to cancel.
- **The daily BUDGET is NEVER discounted.** It is a configuration ceiling, not a charge (same rule as the
  staff accounts-audit budget). Only the divisor moves; `summary.dailyBudgetUsd` is the raw configured
  value on both bases.
- **No count or rate field moves.** Open/click/reply rates, the conversion percentages and every `.actual`
  are cost-free and identical either way; only the money-derived `expected.*` scale.
- **`pricing` is in the Gold `scope_key`**, so a gross and a net request never share a cached body. An
  omitted selector defaults to gross and lands on the SAME cell as an explicit `pricing=gross` (no cache
  fragmentation when the dashboard starts sending it). Pre-existing snapshot rows keyed without `pricing`
  simply orphan — the Gold layer is derived and rebuildable.
- **`computeFeatureOutreachUsd` stays GROSS, unchanged** — it feeds the ADMIN fleet send-forecast, a
  cross-org staff surface with no per-org pricing selector.

Response shape unchanged (same fields, same types) → OpenAPI gains only the `pricing` query param
description. (Set 2026-07-30.)

## `pipeline-activity` signup/form-submission `.actual` = REAL observed conversions, NEVER `clicks × rate` (PR #513)

The signup + form-submission daily bars split cleanly: **`.actual` (today + past days) = the REAL,
deduped, attributed per-day conversion count from lead-service; `.expected` (future days) = the
`clicks × visit→signup / visit→form` projection.** A projection MUST NEVER sit in `.actual` — that was
the bug (prod showed "1 form submission today" = `5 clicks × 25%` while the brand had 0 tracked form
submissions and `/revenue spend.formSubmissionsCount` read 0). `buildDayBuckets` reads
`observed.byDay[event][date] ?? 0` for `date <= today`, null on future days; the old `clicks × rate`
fabrication is GONE. Same observed/projected doctrine as `cost-engine.ts` — a rankable/forecast number
belongs in `.expected`, a measured number in `.actual`; do NOT re-introduce a modeled `.actual`.

Source: lead-service `GET /internal/brands/:brandId/conversion-counts-by-day` (service-auth) via
`src/lib/conversion-counts-by-day-client.ts` (fail-loud client) wrapped **fail-SOFT** in the route
(`fetchConversionCountsByDaySoft`) — the observed conversion series is DISPLAY ENRICHMENT on the forecast
graph (like the `/revenue` conversion-count tiles + `sequences`), so a lead-service blip degrades the two
ACTUAL bars to null ("-", never a fabricated count) rather than 502-ing the whole graph. `clicks`/`opens`/
`outreach` actuals are untouched. **Undated** conversions (`received_at IS NULL` — 0 in practice) are
counted on `summary.undatedSignups` / `undatedFormSubmissions` — NEVER dropped, NEVER assigned a
fabricated day in `days[]`. A per-day actual never exceeds the deduped total by construction
(`sum(byDay) + undated === /conversion-counts total`). **PAST days are not in pipeline-activity's range
(today→future); the dashboard fills past bars from the `/revenue` daily series and reads only
pipeline-activity's TODAY bucket `.actual`** — so fixing today's `.actual` fixes the symptom; the
`date <= today` guard keeps the logic correct if the range ever extends. Producer `conversion-counts-by-day`
was staging-only at ship; the fail-soft client makes prod safe (fabrication removed → "-"), fully
self-activating to real counts once lead-service promotes the endpoint to prod. (Set 2026-07-10.)

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

**...but `pnpm` is unusable on the default node 20.19.1 — use node 22 for the install + the local
gates.** The corepack shim dies before doing anything: `TypeError
[ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING]: A dynamic import callback was not specified` out of
`corepack/v1/pnpm/11.18.0/bin/pnpm.cjs`. It is a corepack/node incompatibility, NOT a repo or
lockfile problem, so re-running or switching to `npm ci` is the wrong move (npm's tree ≠ CI's).
Prefix the whole session instead — `export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"` —
then `pnpm install --frozen-lockfile` succeeds (it exits 1 on an `ERR_PNPM_IGNORED_BUILDS` warning
about esbuild; deps ARE installed and the suite runs fine). Same PATH for `./node_modules/.bin/tsc`
and `./node_modules/.bin/vitest`. pnpm 11 also drops a `pnpm-workspace.yaml` `allowBuilds` stub in
the repo root — an install artifact, delete it, never commit it.

**A workspace branch is cut from `origin/main` but PRs target `staging`, so a staging-only change to
a function you CALL breaks only after the merge.** The release skill's base-branch check
(`git diff origin/staging <branch> --stat` shows only your files) does NOT catch this: your diff is
clean, and the break is that staging changed a signature your NEW code calls with the OLD arity. It
surfaces as a red CI on the merge commit, not on your PR. So when writing a new caller of an
internal client, check the signature on the branch you are MERGING INTO — `git show
origin/staging:src/lib/<client>.ts` — not the one in your working tree. Cost 2026-08-01 (#717): a new
test called `fetchBrandSavedEconomicsWithGoal(brandId)` while staging's #715 had org-scoped it to
`(brandId, orgId)`.

## CI test flake — `EnvironmentTeardownError` (FIXED v0.41.3)

**Fixed.** `vitest.config.ts` now sets `include: ["src/**/*.test.ts"]` so vitest collects
tests from `src` ONLY. Previously CI ran `pnpm build` (emits `dist/*.test.js`) before
`pnpm test`, and vitest's default glob picked up BOTH src and dist — running every suite
**twice**, doubling console output and intermittently tripping a vitest worker-teardown race:
`EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`. It surfaced as
**1 unhandled error with ALL tests passing** + exit 1. The src-only `include` halves runtime
and removes the flake at the source. If a teardown error ever recurs despite this, confirm no
new `include`/dist glob crept back in (`pnpm exec vitest list` must show only `src/` files).

## A "pure-logic" test that imports a bucket/compute helper transitively pulls the DB module → `vi.mock("../db/index.js")` or CI fails

`src/db/index.ts` THROWS at import time when `FEATURES_SERVICE_DATABASE_URL` is unset. Many "pure"
compute libs are not import-pure: `active-users-compute.ts` (and anything reaching a `REAL_DEPS` that
calls `buildAccountsAudit`) transitively imports `accounts-compute.ts → pipeline-activity.ts →
db/index.ts`. So a new **pure-logic** test that imports ANY bucket/helper from those files
(`bucketOf`/`enumerateBuckets` from active-users-compute, etc.) loads the DB module — and CI (no DB env)
fails the whole suite with `Error: FEATURES_SERVICE_DATABASE_URL is not set` even though every assertion
is DB-free. **Local passes (the Conductor workspace has the env), CI fails** — a false-green trap.

Fix: add `vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));` at the top of the test (mirrors
`revenue-history-compute.test.ts` / `committed-mrr-compute.test.ts`). Verify BEFORE push by running the
new suite with the env UNSET: `env -u FEATURES_SERVICE_DATABASE_URL npx vitest run <file>`. (Set 2026-07-15,
committed-mrr-compute.test.ts hit this on PR #581 → CI red → fixed by the db mock.)

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
new branch, since you can't push to a merged PR's branch). Cost it three times in 2026-06/07 (#389→#391,
#476→#477 across 19 refs, #481→#483) — twice by guessing the next sequential number, which landed on an
unrelated sync PR and an unrelated issue. **HARD RULE: never type a `features-service#NNN` from memory or
arithmetic — create the issue (or open the PR) FIRST and paste the REAL number; `gh {issue,pr} view <n>`
before baking is mandatory.**

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

## `workflow-cost-per-outcome` per-workflow RECENT rate — the OFF-request-path warm pattern (4 cold-Neon failure modes; features-service#526)

The per-workflow `recentCostPerOutcomeUsd` (trailing-window moving average) can NOT be computed on the
request path: it needs, PER dynasty, a dated-spend timeseries (runs) + dated outcomes (email-gateway), and
neither producer exposes a single `(day × dynasty)` call (runs' timeseries only FILTERS by dynasty;
email-gateway `groupBy` is single-dimension), so it is an O(dynasty-count) cross-service fan-out. Running it
on the request path 500s/timeouts (PR #521 regression). It runs as a background SWR **warm** in
`handleWorkflowCostPerOutcome` (`src/routes/public.ts`) that overwrites the cache entry + a persisted
recent-rate store. That warm hits the Neon-scale-to-zero siblings and went through FOUR cold-start failure
modes before it populated reliably in prod — **any new off-request-path fan-out warm MUST carry all four**
(do NOT re-discover them one prod hotfix at a time, v0.87.1→v0.87.4):

1. **Per-dynasty resilience** (`try/catch` per item, not one all-or-nothing `Promise.all`) — one failing
   dynasty nulls only itself, never the whole set.
2. **Per-item timeout** (`withTimeout`, 45s) — a HUNG fetch (cold Neon TCP stall, no reject) would leave the
   outer `Promise.all` pending forever → the warm never settles → its `.finally()` never clears the
   single-flight flag → NO future warm runs → recent permanently null. The timeout guarantees the warm
   always settles + clears its flag.
3. **Capped concurrency** (`mapWithConcurrency`, 6) — firing all ~25 dynasties' fan-outs at once = ~50
   connections that OVERWHELM cold-start siblings, making every fetch slow enough to trip the timeout →
   all-null. The cap keeps each fetch fast enough to beat the timeout. (Timeout + concurrency are a PAIR:
   the timeout without the cap is what turned a slow-cold warm into an all-null one.)
4. **Variable store TTL + serve-from-store** — the served payload is seeded from the persisted store (a
   payload-TTL miss never re-nulls the column, no flicker); a CLEAN warm (0 failures) is trusted 10 min
   (no re-warm → no contention with the request-path lifetime fan-out for the same cold siblings), a
   DEGRADED warm (≥1 failure) only ~90s so it self-heals on the next read WITHOUT hammering. Do NOT gate
   re-warm on "store empty" alone with a single long TTL — that pins a degraded all-null result; and do NOT
   re-warm on every miss — that contends with the request path.

Genuinely-unbacked dynasty (no recent clicks) → null, never a false $0. Depends on the org-less dynasty
resolution chain: workflow-service `/workflows/dynasty/slugs` api-key-only (v0.38.0) + email-gateway
sending `workflowDynastySlug` (v0.25.1). (Set 2026-07-10.)

## `workflow-cost-per-outcome` 0-outcome = OWN SPEND (crossOrg is the top grain — NO cross-workflow fleet parent); the LANDING headlines the best model, filtered observed>0 (features-service#612)

`buildWorkflowCostPerOutcome` (`cross-org-cost-per-outcome.ts`) is per-WORKFLOW at the crossOrg
org-scope, and **crossOrg is the TOP grain of the cost cascade**: a workflow's cost has NO coarser
parent (the fleet-pooled cross-workflow rate is NOT its parent). So a 0-outcome workflow floors to its
**OWN spend** (`projectedFloor(spent, 0, null) = max(spent, 0) = spent`), matching the
workflow-projection ladder base case — NEVER a `totalSpend/totalOutcomes` pooled average summed over all
dynasties. Do NOT re-introduce a `fleetParentClickUsd`/`fleetParentReplyUsd` floor here (removed
v0.95.2): it conflated cross-org with cross-workflow and made a barely-spent 0-outcome workflow read the
fleet average instead of the honest "spent $X, produced nothing". (`meanFleetEconomics`/`fleetEcon` is a
different thing — cross-BRAND rate mean for the 4 PROJECTED objectives — and stays.)

**Consumers that pick a "best" per outcome MUST filter `observed>0`, NOT a cost threshold.** Because a
0-outcome workflow now reads its own (possibly low) spend, a dormant ~$48 husk (spent once, 0 clicks/0
replies, never climbs) would be crowned "best cost per reply" PERMANENTLY if `min()` ran over all rows.
The public landing (distribute.you `apps/landing`, PR #2791) headlines the best cross-org workflow per
outcome = `min(costPerOutcomeUsd)` over workflows with the objective's OBSERVED base outcome > 0
(`websiteVisit`→`observedClicks>0`, `positiveReply`→`observedPositiveReplies>0`) — the count filter is
correct on BOTH the pre- and post-v0.95.2 backend; a cost-threshold filter would break. The landing is
restricted to the 2 OBSERVED outcomes; it KILLED the goal-bucketed pooled-average / trend / histogram
surfaces (a pooled avg headline diluted across brands/workflows that oscillate between goals). A workflow
with 0 of the outcome is not the best AT producing it. (Set 2026-07-19.)

## Cross-org cost-per-outcome trio — ALL objectives, dated trend, per-workflow ratio (features-service#485)

Three PLATFORM-WIDE (all-org, no-auth) cost-per-outcome surfaces for the staff admin analytics page,
all single-sourced through `src/lib/cross-org-cost-per-outcome.ts` — ONE objective vocabulary
(`OBJECTIVES` = the brand optimization-goal set) + ONE objective→cost mapping
(`objectiveCostPerOutcome`), so the three surfaces never disagree on what an objective's cost means.
**websiteVisit / positiveReply map to the RAW unit cost (CPC / CPPR — the visit / reply IS the outcome,
matching audience-stats' sort metric); signup / formSubmission / meetingBooked / purchase project
through `projectOutcomeCosts`.** Objective params accept every fleet spelling via `normalizeObjective`
(camel / snake / kebab; `self-serve` aliases signup).

- **Gap #1 — `GET /public/stats/cost-projection` EXTENDED** with `avgCostPerOutcomeByObjective`
  (`{websiteVisit, positiveReply, signup, formSubmission, meetingBooked, purchase}`, null where no brand
  is backed). Additive: legacy `avgCostPerMeetingBooked`/`avgCostPerPurchase` stay as byte-equal aliases
  of `.meetingBooked`/`.purchase` (Wave 1 admin cards unbroken). Same per-brand-best → mean-across-brands
  methodology as before (`buildObjectiveAverages`). brandCount = brands contributing ≥1 non-null objective.
- **Gap #2 — `GET /public/stats/cost-per-outcome-trend?featureSlug=&objective=&days=&windowOutcomes=`**
  (NEW). Dated moving-average series: each display day anchors a trailing window that walks backward until
  it holds ~`windowOutcomes` (default 100) of the objective's base outcomes; the point = that window's
  fleet spend ÷ outcomes (projected objectives push the window unit costs through the fleet-MEAN economics
  `meanFleetEconomics`). `buildCostPerOutcomeTrend` is pure. **DEPENDS on runs-service dated cross-org
  spend** — the public cost aggregation had NO time dimension, so runs-service shipped a NEW
  `GET /v1/stats/public/costs/timeseries?interval=day` (dated buckets by run started_at, `buckets[].period`
  = YYYY-MM-DD; runs-service#177). features reads it via `fetchFleetSpendByDay` and joins it to
  email-gateway `groupBy=day` outcomes. Cost points null where the window is unbacked — never a false $0.
- **Gap #3 — `GET /public/stats/workflow-cost-per-outcome?featureSlug=&objective=`** (NEW). Per-workflow
  (dynasty) cross-org ratio, guaranteed to POPULATE when the workflow has spend: unit costs run through
  the PROJECTED cost-engine (`projectedCostPerOutcome`), flooring to `max(spent, fleet-parent unit cost)`
  when the outcome denominator is 0 (the fix for `ranked` reading null cross-org). Same crossOrg dynasty
  rollup as `/public/stats/best`. Sorted by spend desc. `buildWorkflowCostPerOutcome` is pure.
  **The per-row RECENT trailing-window rate (`recentCostPerOutcomeUsd`, #521) is WARMED OFF the request
  path — do NOT move it back on-path.** That rate needs, PER dynasty, a dated-spend timeseries (runs) + a
  dated-outcomes fetch (email-gateway), and neither producer exposes a single-call (day × dynasty) split,
  so it is an O(dynasty-count) cross-service fan-out. Running it inside the request-path `Promise.all`
  (as #521 first shipped) pushed the endpoint past the gateway timeout — and rejected the whole batch on
  any ONE transient Neon cold-start sub-failure — → prod HTTP 500 on every objective (v0.86.1 hotfix,
  PR #524). Fix: the handler serves the lifetime rows IMMEDIATELY with `recentCostPerOutcomeUsd = null`,
  then runs the fan-out in a SINGLE-FLIGHT background warm (`workflowRecentWarmInFlight`, `__awaitWorkflowRecentWarm`
  test seam) that overwrites the SAME cache entry; reads within the fresh window get the populated rate. The warm
  is PER-DYNASTY resilient (each dynasty's fan-out independently try/caught → null + loud log; one failure
  never nulls the other 24 — stat-families doctrine). If you add a NEW per-dynasty dated metric here, warm
  it the same way; keep it off-path. The dated fetches filter `workflowDynastySlug`, which the producers
  resolve via workflow-service `/workflows/dynasty/slugs` — org-less since v0.38.0 (features-service#526).
  Do NOT resolve dynasty→slugs locally + pass raw slug lists if it ever regresses: the timeseries endpoint
  has no `groupBy`, so there is no local-derive path, and it would reimplement the producer's job.

Each surface uses the shared `servedPublicCached` memo on `LIFETIME_AGGREGATE_WINDOWS`, `__reset*Cache` test seams. **The api-service
gateway forwards `/public/stats/X` → `/v1/public/features/X` via EXPLICIT per-route proxies, NOT a
wildcard — any NEW `/public/stats/*` endpoint needs a matching api-service proxy route or it 404s at the
gateway.** The two new paths got their proxies in api-service#686. Triage: STAGING (staff-internal
analytics, dormant until distribute.you #2486 conforms). (Set 2026-07-08.)

## Lifetime (all-history) cross-org avg cost-per-outcome — the trend's window→∞ limit, NOT a 4th methodology

`GET /public/stats/cost-per-outcome-lifetime?featureSlug=` (extends #485) serves the staff admin table's
**"All-time avg"** column: cross-org (no-auth) LIFETIME pooled average cost-per-outcome for ALL 6
objectives in ONE call (`buildLifetimeObjectiveAverages`, `cross-org-cost-per-outcome.ts`). It is a
BACKEND-owned field because a true lifetime average can NOT be recovered from the moving-average trend
windows (avg-of-windows ≠ lifetime avg) — do NOT push this to the consumer.

**It is DEFINED as the window→∞ limit of `cost-per-outcome-trend` — same data sources, summed over ALL
days.** The handler reuses `fetchFleetSpendByDay` (runs-service dated fleet spend) + `fetchPublicEmailStats(_, "day")`
(dated outcomes), sums every day → pooled `clickUsd = totalSpentUsd/totalClicks`,
`replyUsd = totalSpentUsd/totalPositiveReplies`, then per objective `objectiveCostPerOutcome` (websiteVisit /
positiveReply = pooled CPC / CPPR; the rest project through `meanFleetEconomics`). So each objective's
all-time number is EXACTLY where its trend line converges — coherent by construction. Null (never a false
$0) per objective when its denominator is 0 or its rate is absent (mirrors a trend point).

**Do NOT reuse `cost-projection`'s `avgCostPerOutcomeByObjective` for the all-time column, and do NOT add a
differently-computed lifetime field.** `cost-projection` uses per-brand-best→mean-across-brands (a distinct
projection methodology); the "All-time avg" must be the POOLED total-spend/total-outcomes value so it agrees
with the trend it terminates. Two different "averages" on the same page that don't converge is an
internally-incoherent output. Response: `{ featureSlug, avgCostPerOutcomeByObjective{6}, totalSpentUsd,
totalClicks, totalPositiveReplies, brandCount }`. Cached via the shared `PublicCache`
(`__resetCostPerOutcomeLifetimeCache` seam). api-service gateway proxy
`GET /v1/public/features/cost-per-outcome-lifetime` shipped in api-service#688 (mirror of the sibling
`/public/stats/X` → `/v1/public/features/X` per-route pattern). Triage: STAGING → promoted to main
(features-service v0.84.0 / api-service v0.83.0). (Set 2026-07-09, PR #496.)

### Trend + lifetime + distribution are GOAL-BUCKETED — EXCEPT `positiveReply` which is GOAL-AGNOSTIC (raw measured, fleet-wide, "observed across every brand")

`cost-per-outcome-trend` + `cost-per-outcome-lifetime` + `cost-per-outcome-distribution` DO NOT sum
fleet-wide spend/outcomes for the BUCKETED objectives — each sums ONLY the brands whose `optimizationGoal`
sits in that objective's bucket, so a meeting/reply-optimizing brand no longer dilutes the CPC card. Buckets
(`OBJECTIVE_GOAL_BUCKET`, `cross-org-cost-per-outcome.ts`): **cpc(websiteVisit) = {websiteVisit, signup,
formSubmission}** (every click-driven goal except reply/meeting — purchase closes via a meeting so it is
NOT here); **signup/formSubmission/purchase/sales/whatsapp = own goal only**; **meetingBooked =
{meetingBooked, purchase}**. A brand may fall in several buckets (a signup brand feeds cpc AND
cost-per-signup) — intended; each card is a distinct ratio over a distinct denominator.

**`positiveReply` is the EXCEPTION — GOAL-AGNOSTIC (`GOAL_AGNOSTIC_OBJECTIVES` = `["positiveReply"]`,
`isGoalAgnosticObjective`).** A positive reply is a RAW MEASURED fact produced by EVERY cold-email brand
(anyone can hit reply to any brand's outreach), and the public homepage headlines its cost as the fleet-wide
average CAC ("the average cost of acquisition observed across every brand we run"). So `bucketBrandsForObjective`
returns the WHOLE dataset for `positiveReply` — its trend/lifetime/distribution pool spend + replies over ALL
contributing brands, NOT only `optimizationGoal=positiveReply` brands. Scoping it to the tiny reply-goal subset
(PR #499) made the headline a biased, small-denominator metric whose weekly delta swung on noise — contradicting
the "every brand" claim. **Reconciliation with PR #499 (which ADDED the bucketing on purpose):** #499 conflated
two concerns. Its dilution fix stays CORRECT + RETAINED for the PROJECTED objectives (signup/formSubmission/
meetingBooked/purchase/sales — pushing a brand's spend through economics is only meaningful for brands whose
funnel those economics describe) AND for **websiteVisit CPC** (a click is also raw-measured, but #499 deliberately
excludes reply/meeting brands whose link-light copy yields incidental, artificially-low click rates, and the CPC
card carries NO fleet-wide public claim — the metric's scope matches its consumer's claim). **whatsappConversation**
stays own-goal because its outcome (a WhatsApp-link click) requires a WhatsApp link in the email → NOT produced
fleet-wide. So only `positiveReply` flips to goal-agnostic; everything else keeps #499's scoping. Husk/false-$0
handling unchanged (a brand with 0 replies contributes its spend to the pooled denominator but no distribution
data point; 0 fleet replies → null, never $0).

**Bucketing is CONSUMER-SIDE composition, not a read-side derivation of a missing tag** — runs/email cost
rows carry NO goal tag (0 of ~42k), so features-service enumerates the feature's brands
(`fetchGoalBucketDataset`), resolves each brand's goal + saved economics from brand-service INTERNAL
`GET /internal/brands/:id/sales-economics` (`optimizationGoal` mapped via `matchBrandServiceGoal` — the
STORED enum `signups|booked_meetings|sales|website_purchase|combined_sales|website_visits|positive_replies|form_submissions`,
whose multi-step spellings differ from the runtime CurrentGoal AND whose `sales` means WEBSITE PURCHASE,
not combined sales — see the entry-point section above), then fetches each brand's dated spend (runs
timeseries, `brandId`-filtered — runs filters `= ANY(r.brand_ids)`, NOT comma-split, so ONE brand per
call) + dated clicks/replies (email-gateway `/public/stats`, comma-`brandId`), and aggregates per bucket
(`bucketBrandsForObjective` + `mergeSpendByDay`/`mergeOutcomesByDay`; `buildBucketedLifetimeAverages` is
pure). A brand with no saved goal/economics is OMITTED (can't be bucketed). The objective-INDEPENDENT
per-brand dataset is cached feature-level (`__resetGoalBucketDatasetCache`) so trend (per-objective) +
lifetime share ONE fan-out. Response shapes UNCHANGED (same fields, only the numbers narrow to the
bucket) → no OpenAPI regen. cost-projection (Gap#1 projection avg) + workflow-cost-per-outcome are NOT
bucketed (different methodology/axis). Triage: HOTFIX → main (shape-stable, staff-internal). (Set 2026-07-09.)

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
  ONE shared in-memory primitive in `public.ts` — `servedPublicCached({cache, key, windows, label,
  compute})` over `type PublicCache = Map<string, {payload, freshUntil, staleUntil}>`. **Every read on
  every cross-org surface goes through it; there is no `getPublicCache`/`setPublicCache`-style direct
  read left** (the one remaining direct `setPublicCache` is the workflow recent-rate warm overwriting its
  own entry). Per-endpoint `__reset*` seams stay and now clear the in-flight map too (`clearPublicCache`).
  Do NOT re-add a bespoke per-cache get/set/TTL, and do NOT hand-roll a second in-flight map beside a
  `PublicCache` — the helper owns single-flight.

  **It is stale-while-revalidate with TWO windows per entry, and they do DIFFERENT jobs — the same split
  `view-cache.ts` documents for the Gold layer.** FRESH = serve with zero work, so FRESH is what governs
  how often the expensive fan-out RE-RUNS (once per fresh window per VIEWED key; an unread key never
  refreshes). STALE = still served INSTANTLY while a single-flight refresh runs BEHIND the response; only
  past STALE, or on a cold key, does a reader wait. **So no caller ever blocks while a previous value
  exists**, and lengthening FRESH cuts call count without leaving anyone on a number more than one refresh
  cycle old. A failed BACKGROUND refresh keeps the prior entry (never zeroes real data) + logs loud; a
  cold/past-STALE compute failure propagates → 502, nothing fabricated.

  **Two window sets, and which one a surface takes is a judgement about the DATA, not about the cost:**
  - `LIFETIME_AGGREGATE_WINDOWS` (**15 min fresh / 6 h stale**) — the cross-org COST surfaces: ranked,
    best, public-revenue, cost-projection, cost-per-outcome trend/lifetime/distribution,
    workflow-cost-per-outcome, best-model trend, and the shared goal-bucket dataset. Every figure on
    these is a fleet-LIFETIME aggregate (cross-org totals over all history) and every miss costs
    runs-service one of three unbounded ledger scans measured at **11-14 s** (runs-service#206,
    features-service#706). At the old 60 s window that scan re-ran every minute *per replica* for numbers
    that cannot visibly move in a minute — a lifetime pooled cost moves by the fleet's few minutes of
    spend against months of it. 15 min is the honest freshness of the quantity (~15× fewer scans, nothing
    observable changes); 6 h stale is sized for the low-traffic public landing, where the alternative for
    the first visitor after a quiet night is a ~13 s cold build on the request path (#547 residual).
  - `FLEET_AUDIT_WINDOWS` (**60 s fresh / 30 min stale**) — the staff audits: send-forecast, accounts,
    active-users, active-users-by-user, revenue history, plus workflow engagement latency. These describe
    MUTABLE operational state a staff member changes and then re-reads (a budget, a pause, an account
    going active), so their freshness deliberately stays where it was; they gain only the stale half.
    **Do NOT "harmonise" these onto the lifetime windows** — buying call-count here is paid for in "I
    changed it and the audit still shows the old value".

  **Single-flight is load-bearing on a COLD key and is now in the helper, not per-surface.** A plain
  check-then-fetch stampedes: the entry only dedups AFTER the first fan-out finishes, so while it is empty
  every concurrent caller runs its own. The admin page loads several public cost surfaces AT ONCE (trend
  once per objective + lifetime + distribution all share `getGoalBucketDatasetCached`, ~3 cross-service
  calls × N brands), so a cold load fired 6× that fan-out simultaneously → ~6×90 concurrent calls
  stampeding runs-service / email-gateway → gateway `HEADERS_TIMEOUT` / `SOCKET` (v0.87.6, prod incident
  2026-07-10). The helper's in-flight map (keyed off the cache object) also guards the background refresh,
  so a burst of stale reads kicks exactly ONE rebuild. Still cap the fan-out ITSELF with
  `mapWithConcurrency` (`src/lib/concurrency.ts`) so even the single build does not burst ~3×N sockets at
  cold-Neon siblings. `setPublicCache` prunes past-STALE entries on write — these keys are
  (featureSlug × objective × window params) on NO-AUTH routes, so an arbitrary caller could otherwise mint
  unbounded keys that each pin a payload for the (now much longer) stale window.

  Guard suite: `src/routes/public-cache-swr.test.ts` (repeated reads = ONE ledger scan; 5 min on still no
  re-scan — this one fails if the window goes back to 60 s; past-fresh serves the last value with the
  rescan behind it; past-stale recomputes synchronously; 4 concurrent cold readers = ONE scan; a failed
  background refresh keeps the last value; a cold failure 500s). Seams:
  `__expirePublicCacheFreshWindowsForTest()` + `__awaitPublicCacheRefreshForTest()`.

**It is DERIVED + rebuildable** — dropping every row is safe (next read recomputes); siblings stay SoT.
**Eventual-consistency is the accepted CQRS tradeoff**: a served body is "as-of `computed_at`". The cache
is an OPTIMISATION, never SoT: a snapshot-table read error logs loud and falls through to a live compute
(correct answer, just slow) — that fall-through is legitimate degradation, NOT a silent swallow.

**Env (optional, sane defaults):** `FEATURE_VIEW_SNAPSHOT_TTL_MS` (default `30000`) and
`FEATURE_VIEW_CACHE_ENABLED` (default on; set `"false"` to bypass — tests that assert the pure
live-compute path set it false).

### The two windows do DIFFERENT jobs — `TTL` sets the refresh RATE, `maxStale` decides WHO WAITS

Read them as one pair; tuning either alone regresses the other.

- **`TTL` = 30s** — the FRESH window. Past it a read still serves instantly but ALSO kicks one background
  revalidation, so **TTL is what governs how often the expensive fan-out actually re-runs** — once per
  ~TTL per VIEWED cell. Idle cells never refresh.
- **`maxStale` = 30min** — the HARD cap. Beyond it a read stops serving the snapshot and recomputes
  SYNCHRONOUSLY, making the caller wait.

**`maxStale` was 60s, and that was the dashboard's entire cold-load problem.** The dashboard polls while a
tab is open but PAUSES on an idle/hidden tab, so ANY revisit more than a minute later fell into the
blocking branch and each of the ~5 brand-page views recomputed its full cross-service fan-out on the
request path. Measured in prod 2026-07-30: **5.76s / 5.65s / 5.90s** for workflow-projection /
audience-stats / revenue, versus **0.37s / 0.20s / 0.36s** warm — and the page barriers on the SLOWEST
(`useCoordinatedReveal`), so the user waits for the max.

Raising `maxStale` does NOT make steady-state data staler — it moves the refresh OFF the request path.
The dashboard's 15s poll still delivers a fresh number within one cycle, and the front end already paints
last-known content from IndexedDB first (`persist-cache.ts`, `maxAge: Infinity`, "local-first SWR"), so a
backend that blocked to look fresh was fighting its only consumer. Only the very first paint after a long
absence can show an older value, for the seconds until the background refresh lands.

**Do NOT drop the TTL back toward 5s while the dashboard polls at 15s** — every poll would then be a stale
hit and trigger the fan-out, doubling load on the Neon-backed siblings. TTL ≥ poll interval is the rule.

### A third window — `RETENTION` (7d) deletes cells nobody reads; the sweep rides write traffic, never a timer

`TTL` and `maxStale` decide how a cell is SERVED. Neither ever removes one, so the table grows forever:
every input that changes a body is folded into `scope_key` (query params, `pricing`, `timezone`, the
economics fingerprint), so one brand legitimately mints a NEW cell whenever any of those move and the
superseded ones are orphaned by construction — never read again, never overwritten. Measured on prod
2026-07-31: `revenue` held 326 cells / 36 MB with only 68 touched in 24h, plus 91 fully orphaned
`workflow-projection` cells left by the evidence/projection split.

`computed_at` advances ONLY on a read (miss / too-stale / background revalidate all go through
`upsertSnapshot`), so its age is exactly "time since anyone last looked at this cell". Past
`FEATURE_VIEW_SNAPSHOT_RETENTION_MS` (default 7 days) the row is deleted; if it is ever read again the
existing miss path recomputes it. Retired VIEWS age out under the same rule, so this needs no list of
live view names — such a list would rot the moment a view is renamed.

**The sweep piggybacks on a successful persist, at most once an hour per process — do NOT convert it to a
`setInterval`.** A timer keeps the Neon compute awake around the clock for a table that needs touching
once a day, which is the exact anti-pattern the fleet's scale-to-zero notes call out (reap on-read, never
on a clock). It is also fire-and-forget: a prune failure is logged and dropped, which is NOT the swallowed
error the fail-loud rule forbids — pruning produces no value any caller reads, its only failure
consequence is a larger table, and propagating would turn janitorial work into a 502 on a request whose
answer was already computed correctly.

### Economics-dependent views key on `economicsFingerprint`, NOT on a cross-service invalidation hook

`scope_key` is built from query params, and **economics are not a query param** — so a snapshot computed
before an economics write would keep being served after it. At the old 60s cap the window was small; with
a minutes-scale cap it is long enough to show a customer their pre-write ROI. That is the exact bug #659
fixed for `workflow-projection` (which reads economics LIVE and caches only the evidence fan-out).

The other economics-driven views instead fold `economicsFingerprint(effective)`
(`sales-economics-client.ts`) into their `scope_key`: **different economics ⇒ different cell ⇒ guaranteed
fresh compute**. Correct by construction, no new endpoint, no brand-service caller, no new failure mode.
Superseded snapshot rows simply orphan — the Gold layer is derived and rebuildable. Wired on `revenue` /
`revenue-grouped` / `revenue-lens` (threaded down as `economicsOverride`, so it stays ONE brand-service
read), `pipeline-activity` (threaded into `computeExpectedActivity`), and `audience-stats`.

The fingerprint hashes the WHOLE object with sorted keys, so a field added to `SalesEconomics` is covered
automatically; `source` is in the hash on purpose (`"user"` vs `"cross-brand-average"` is a different
answer for surfaces that gate on provenance).

**`audience-stats`' fingerprint read is deliberately FAIL-SOFT** — it feeds a cache KEY, not the response,
and that route's parameter validation lives INSIDE `computeAudienceStats` (i.e. AFTER the fingerprint
read), so a hard failure there would turn an invalid-parameter **400 into a 502**. Degrading to "no
fingerprint in the key" keeps all three outcomes right: invalid request still 400s from the compute, a
genuinely unreachable brand-service still 502s (the compute's own economics read fails loud), nominal
still gets the fingerprint. `revenue` / `pipeline-activity` read it AFTER their own validation, so they
stay fail-loud. If you add a pre-cache read to a route, check which side of validation it lands on.

Future: event-driven invalidation (siblings publish domain events → incremental refresh) is the next
medallion step beyond SWR if staleness ever bites. (PR #293, refined by features-service#304; windows +
economics fingerprint 2026-07-30.)

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
