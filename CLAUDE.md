# Features Service — CLAUDE.md

## A BOUNCE IS THE PROOF A SEND HAPPENED — REACH and the PIPELINE BASE are two questions, and both are served

A customer 5 days into a campaign reported that some leads looked contacted twice: their screen said
876 outreaches against 836 people. Nobody was contacted twice — 883 rows in lead-service, 883 distinct
lead ids, 883 distinct emails, 876 matched 1:1 against instantly, zero repeats. **876 − 40 bounced =
836, exactly.** The 40 people whose mailbox refused the email were being dropped from the count of
people we emailed, and the customer read the gap as duplicates.

The cause was one line: `leads-client.ts` treated a bounced or unsubscribed lead as DEAD and zeroed its
WHOLE signal set — `contacted` and `sent` with it — after which the lead also fell out of `leads[]`,
since the engine keeps a person only when it has expected value or reached a delivery milestone. That
answer is right about the future and wrong about the past, and it made the response contradict itself:
`recipientsBounced: 40` beside a `recipientsContacted` that excluded those same 40. A lead counted as
bounced but never as contacted is not a state that can exist.

- **THE DELIVERY LADDER IS A SET OF FACTS ABOUT OUR OWN SENDING, AND A FACT IS NEVER ZEROED.**
  `contacted` / `sent` / `delivered` / `bounced` / `unsubscribed` come straight from the producer now.
  We queued the email, we sent it, we PAID for it — a bounce is the proof a send happened, not a reason
  to forget it. None of the ladder is a step of any funnel (they are `SALES_MILESTONES`, which carry no
  revenue field at all), so stating them truthfully adds **exactly zero** expected value.
- **"CANNOT CONVERT" IS SAID ON THE CONVERSION LEGS, AND NOWHERE ELSE.** A dead lead still carries
  `clicked` / `positiveReply` / `negativeReply` / `neutralReply` false, so the EV math is BYTE-UNCHANGED:
  a lead that clicked and then bounced is worth 0, exactly as before. Do NOT "simplify" this back to
  one flag over the whole signal map — that IS the bug, and the two halves answer different questions.
- **`outcomes` ANSWERS BOTH, and neither is inferred from the other.** `recipientsContacted` is REACH
  (bounces and unsubscribes included) — "how many unique people did we reach out to", the number a
  customer's spend bought. `recipientsConvertible` is THE PIPELINE BASE — reach minus everyone a bounce
  or an unsubscribe removed — and every expected-value figure on the grain rests on those people and no
  others. `recipientsBounced` / `recipientsUnsubscribed` ride beside them.
- **THE BASE IS SERVED BECAUSE IT IS A UNION, NOT A SUBTRACTION.** A lead can be BOTH bounced and
  unsubscribed, so `contacted − bounced − unsubscribed` subtracts that person twice and reports a base
  smaller than the truth. Only the per-lead set knows the union, so a consumer cannot compute it — which
  is the client-computed-metric bug this service exists to prevent, in its purest form.
- **A DEAD LEAD STAYS IN `leads[]` AT 0, SAYING WHY.** `bounced` and `unsubscribed` are booleans on the
  row, beside `contacted`. The row a customer opens has to say the same thing as the counts above it,
  and a contacted lead that mysteriously never progressed says nothing at all. It contributes to no
  organisation, no event, no time-series step and no total — the same treatment the merely-delivered
  lead already had.
- **THE FUNNEL'S FIRST RUNG CONVERTS FROM REACH** (`funnelSteps.contactedRecipients`, now 876 not 836),
  with `convertibleRecipients` stated beside it. See that section for why reach is the right base.
- **EVERY GRAIN MOVED AT ONCE, because a grain left behind reproduces the bug one click away** — the
  brand read, `?campaignId=`, `?groupBy=campaignId`, `?groupBy=workflow`, the offer / channel / funnel
  reads, and `/stats` (whose `recipientsContacted` came off the same overlay).
- **NOTHING WAS RENAMED OR REMOVED**, so no consumer had to be repointed to fix the reported bug:
  `recipientsContacted` keeps its name and simply stops under-counting. The new fields are additive.
- Guards: `src/routes/reach-vs-pipeline-base.test.ts` — ONE fixture shaped like the campaign that
  reported it (10 emailed, 2 bounced, 1 unsubscribed, 1 BOTH, 1 positive reply, and a bounced lead that
  clicked first): reach equals the people emailed; the base is stated separately; the both-lead leaves
  the base once while the naive subtraction gets it wrong; no row is bounced-without-contacted; the
  first rung's rate divides by 10 and not by 6; the EV math unchanged; and a clean campaign reads the
  same number for both. Plus the three cases in `routes/revenue.test.ts`. (Set 2026-08-29,
  features-service#862.)

## `funnelSteps` — A FUNNEL READ STEP BY STEP: who reached each rung, what reaching it cost, and what share of the rung before converted

A customer opening ONE of their sales funnels asks a narrower question than "is this working": walk me
down MY funnel, in ITS order, and tell me where people fall out. Two of that question's three columns
had no answer anywhere on the response, and the gaps sat exactly where the page is unreadable without
them — **"Meeting attended" had a per-lead flag and no count and no cost anywhere**, so a
reply-to-meeting funnel (reply → booked → attended → paid) rendered three rungs and a blank, and
nothing stated the conversion between two consecutive rungs at all. The dashboard is forbidden from
dividing two served counts in the browser, so the rate had to be served or it could not be shown.

- **ONE BASIS FOR EVERY RUNG, WHICH IS THE WHOLE DESIGN.** Every count is DISTINCT LEADS off the SAME
  deduped persons `outcomes` counts, in the SAME scope, with the SAME committed cents behind every
  cost — so `funnelSteps.committedSpentCents === outcomes.committedSpentCents ===
  costEconomics.committedCostUsd × 100`, and each rung's count equals `leads[].filter(leadField)` row
  for row (`leadField` is on every step so a reader can reconcile by hand). A chain whose rungs came
  from different bases — the brand-scoped `spend.salesMeetingsCount` above a funnel-scoped attended
  count — can state a rate above 100% between two rungs of one funnel, which is not a rate at all.
  That is why the count is NOT taken from the conversion-counts read the tiles use.
- **THE RUNGS ARE THE FUNNEL'S OWN LEGS, ZIPPED TO ITS OWN LABELS.** `FUNNEL_LEG_SIGNALS[key]` (now
  exported) beside `SALES_FUNNELS[key].steps`, position for position — 4 rungs for either meeting
  funnel, 3 for `website_purchases` and `form_magnet`. A length mismatch is a `FunnelStepShapeError`
  and a leg with no lead field is an `UnknownFunnelLegSignalError`: both FAIL LOUD, because the
  alternative is a rung silently mislabelled or dropped out of the middle of somebody's funnel.
- **EACH RUNG ALSO STATES WHAT THE CUSTOMER'S OWN WORK ON IT COST — `customerCost`, per rung.** The
  platform automates the first link and CHARGES for it; the customer runs the meeting and closes the
  deal, and every time somebody moves a lead across an arrow on the dashboard they are asked what that
  step cost them. That was answerable for a WHOLE FUNNEL (`customerCost` on the offer × funnel page)
  and nowhere finer — but the question is per ARROW ("what does a booked meeting cost me?"), and one
  funnel-wide total covers every arrow at once, so it cannot answer it. A statement already NAMES its
  step (lead-service `/internal/brands/:brandId/step-costs` carries `step`), so the per-rung answer is
  a PARTITION of the same rows (`customerCostsByStep`): no second producer, no inference, and the
  funnel-wide figure is **byte-unchanged** beside it. It carries `costCents` / `statedCount` /
  `unstatedCount` / `coverage` and **`costPerReachCents` — the stated total ÷ the rung's count**, the
  average per person who crossed it, SERVED because a browser dividing two served numbers is the
  client-computed metric this service exists to prevent. **NEVER folded into what we charged**: it
  rides BESIDE `costPerReachCents`, exactly as the funnel-wide figure rides beside `costEconomics`,
  and none of it reaches billing. **A rung nobody has been asked about reads ZEROS with
  `platform_spend_only` and a NULL average, never a $0 that would say their work was free** — and the
  two engagement rungs are always that, because nobody is asked what a website visit or a positive
  reply cost them. The whole block is `null` only when the statements could not be READ (fail-soft,
  loud log) or were never fetched on this path. **Statements are scoped by the SAME campaigns the
  committed cents are** — so a campaign-scoped read answers for its campaign IDENTITY (both members'
  statements, as its money totals), and a brand-wide read, whose spend leg is the brand's whole spend,
  counts every statement including the ones naming no campaign. The read happens ONCE per request:
  the offer × funnel page passes down the statements it already read for the funnel-wide figure, and a
  plain `/revenue` reads them itself only when it both WALKS a funnel and is a full page (a lean
  `?groupBy=` group discards `funnelSteps`, so fetching for it would buy nothing).
- **COSTS ARE OBSERVED AND NEVER FLOORED.** `costPerReachCents` is committed spend ÷ the rung's count
  through the same OBSERVED engine `outcomes.cpcCents` rides — accounting, so a rung nobody reached is
  **null, never 0 and never a benchmark**. Every rung divides the SAME committed total on purpose: the
  spend bought the whole funnel, not one rung of it. Projection has its own surfaces.
- **THE FIRST RUNG CONVERTS FROM OUTREACH, AND OUTREACH MEANS REACH.** `fromStep: "Contacted"` over
  `contactedRecipients`, which is a real measured number — the alternative (a null first rate) drops
  the one conversion a customer most wants. It counts the people who BOUNCED and the ones who
  UNSUBSCRIBED: a bounce is a real loss at the very first rung and it was paid for, so a rate that
  quietly divided by the survivors would hide the people the campaign bought and never reached. The
  smaller base rides the block beside it as `convertibleRecipients` (= `outcomes.recipientsConvertible`)
  so nobody has to work out which of the two a rate divided by. Every later rung converts from the rung
  before it, and the base rides the row (`fromRecipientsReached`) so a consumer renders "3 of 40"
  without a lookup.
- **ABSENT AND ZERO ARE DIFFERENT STATEMENTS, and `StepEvidence` is what tells them apart.** `0` is
  MEASURED. `null` is "the producer behind this rung's signal was unreadable on this request, or was
  never fetched on this path" — and a null count nulls its cost AND both rates that touch it. The
  evidence map mirrors the overlay's own precedence: booked and paid have TWO producers (the
  statements and the LEGACY instantly qualifications) and either alone is a real answer, while
  **`meetingAttended` has only the statements** — nothing else in the fleet can observe somebody
  showing up — so a degraded statements read nulls attended while booked still answers. The two
  engagement rungs ride the fail-loud core lead read and are always measured.
- **NULL ONLY WHEN THERE IS NO ONE FUNNEL TO WALK** — no funnel wired for the channel (the leads were
  never read), the lensed `?lens=` read (a lead SUBSET beside the brand's whole spend, the same gate as
  `spend`), or a read priced on SEVERAL declared funnels at once, which has several chains and no
  single one to state. A read that NAMES its funnel (`?funnel=`, or
  `GET /offers/:offerId/funnels/:funnelKey/revenue`) always carries it **whether or not it can be
  PRICED**: "we could not price this" and "this reached nobody" are different statements, and the
  volume half does not wait on the terms. The cold-start path walks it too, with every
  statement-backed rung honestly null (that path short-circuits before the overlays are read).
- **IT RIDES `RevenueBody`**, so the brand / offer / channel / per-funnel reads all carry it at ZERO
  extra IO — the persons and the cents were already in hand. NOT added to any lean group shape (the
  `?groupBy=` groups and the per-channel rows are byte-unchanged), and no query parameter: a consumer
  that has to opt in is a consumer that renders the money without the chain by default.
- Guards: `src/routes/funnel-step-breakdown.test.ts` — ONE fixture (4 contacted, 3 replied, 2 booked,
  2 attended, 1 closed, 12000¢) drives every rung of the conversation funnel answering with a distinct
  count and a distinct rate; the counts checked against the response's own `leads[]`; the one committed
  basis; the three other chains; a measured 0 with a null cost beside a null count from a degraded
  producer; booked/paid null only when BOTH producers fail; an unpriced funnel still walking its chain;
  the lensed and several-funnel reads stating none; and every existing field untouched. Plus the
  per-rung customer-cost suite in the same file (a distinct stated total and average per rung; a
  partial rung and an unanswered one; a platform-worked leg stating none; the charged figures and the
  funnel-wide answer byte-unchanged beside it; a stated zero told from nobody-asked; the fail-soft
  degrade to null; and the identity / brand scoping) and the step-partition cases in
  `lib/funnel-customer-costs.test.ts`, where the per-rung rows sum to the funnel-wide row.
  (Set 2026-08-28; per-rung customer cost same day.)

## A LEAD IS WORTH WHAT A HUMAN OBSERVED, NOT WHAT WE FORECAST — the observed rung replaces the rate ladder, a ruled-out step is worth nothing, and a priced deal is worth what somebody said

Every money figure this service reports about a lead was a FORECAST: its chance of one day becoming a
paying client, obtained by multiplying declared conversion rates through whatever the lead last did.
That was the only thing available — the website tracker sees roughly one conversion in ten and cannot
see a meeting somebody took or a deal closed on a call at all. lead-service now records what a HUMAN
states about a funnel step (sales-lead-service#448/#451), so for the steps somebody actually watched
happen there is nothing left to estimate.

- **AN OBSERVED RUNG REPLACES THE FORECAST POINTING AT IT, AND EXTINGUISHES IT.** The click and reply
  legs are two independent shots at ONE close, so on their own they still combine as independent
  probabilities bounded by one close value. But a booked meeting / an attended meeting / a won deal is
  not another shot at that close — it IS that close, further along, so once one fires the routes are
  DROPPED rather than combined. Keeping them adds the forecast of an event to the event itself. **A
  `max` alone does not do it**: a brand whose self-serve rate beats its booked→paid rate can have the
  click route out-value the meeting the lead is sitting in. `evForPerson` tracks positions separately
  (`maxPositionEv`) for exactly that reason.
- **"MEETING ATTENDED" IS A PRICED RUNG NOW, and that is the change with teeth.** It had no signal
  anywhere in the fleet, so it survived only FOLDED into the booked→paid rate
  (`meetingFunnelCloseRate` = attended% × show-up%) — which meant a no-show and a meeting somebody sat
  through were worth the same number. `SalesEconomics.meetingAttendedToPaidClientPct` carries the
  UN-composed rate (`meetingAttendedCloseRate`, brand-service's raw `meetingToClosePct`), so booked is
  priced through the show-up rate and attended is not. **A brand that declared no show-up rate has said
  nothing that tells the two apart, so the composed rate stands in and both rungs are worth the same** —
  honest, not a free 100%. The rung is statable BY HAND ONLY: attendance happens off the client's
  website, so no page-load tag can observe it, which is why the show-up rate brand-service has always
  priced with could never be checked against reality until now.
- **A `never` KILLS THE FUNNEL, NOT THE STEP** (`deadLegSignalsFor`). A human stating that a lead will
  never book a meeting has not removed one rung: they have said the lead has no path to a paying client
  through any funnel that goes through a booked meeting — so everything it already fired ON those funnels
  is worth nothing too, because that value was a forecast of the thing now ruled out. A funnel the dead
  step is NOT on survives untouched, which is why the expansion is per declared funnel: a brand selling
  both a conversation funnel and a self-serve website funnel keeps the website funnel's value for a lead
  who will never take a meeting. **`closeWin` is a leg of EVERY funnel, so a lost deal is worth 0** —
  never a lingering fraction of the meeting it once had. **NO DECLARATION ⇒ EVERY funnel is in play**,
  matching `restrictPathsToDeclaredLegs`; reading an empty declaration as "no funnel contains this step"
  would make a lost deal worth its meeting for the one kind of brand we know least about.
- **A STATED VALUE SCALES THE WHOLE LADDER, not only the rung it was stated at.** Every path EV is
  `value × a rate ladder`, so `EnginePerson.valueUsd` is a per-lead LTR OVERRIDE: a lead somebody priced
  at $49k is worth more at every rung than one priced on a $1k average, which is the point of stating
  it. The TERMINAL leg is special-cased (`ResolvedPath.terminal`): a won deal carrying an amount IS that
  amount, read straight rather than scaled, so realized revenue does not depend on the brand having
  declared a lifetime revenue at all. **Null is "nobody said", never 0** — a 0 would say the deal was
  worth nothing, which is a statement rather than a silence. The producer refuses a stated sale with no
  amount, so realized revenue is never an average.
- **THE DEFAULT VALUE IS THE OFFER'S, and the offer is the right grain — not the campaign.** A lifetime
  revenue is a property of what is SOLD, so two campaigns selling one offer through two channels must
  price a client identically or their ROIs stop being comparable, which is the entire job of the channel
  grain. A campaign resolves it by inheriting its offer's; a campaign that would price differently is a
  different OFFER. Resolution order, most precise first: **the lead's stated value → the offer's declared
  lifetime revenue → the funnel's → the brand's.** brand-service already stores it at that grain
  (`brand_sales_funnels` is keyed `(offer_id, funnel_key)` and carries its own `lifetime_revenue_usd`);
  what was missing was a way for a service-auth caller to NAME the offer, added in brand-service#473.
- **TWO PRODUCERS ANSWER "what happened", AND THE ORDER IS THE CONTRACT.** The instantly manual
  qualifications are the LEGACY source and lead-service's step statements are what is written to now, so
  a statement WINS wherever it exists and the legacy read only fills what nobody has restated.
  **This is a migration, not two truths** — the same `COALESCE(new, legacy)` shape the frozen-net cost
  read uses, and it empties itself as statements move over. **Do NOT "simplify" it by deleting the
  legacy read**: production carries **4 booked meetings and 4 closed deals** in
  `instantly_manual_qualifications_raw` against **zero** manual rows in lead-service (verified
  2026-08-26), so dropping it would erase measured outcomes from live brands' pipelines — a worse answer
  than a second read that is losing rows every week.
- **A ROW WE CANNOT JOIN IS SKIPPED, NOT DROPPED UPSTREAM.** The producer keeps an outcome whose lead has
  no email so its own counts stay self-consistent; we skip it because a lead we cannot join is one we
  cannot price, which is not the same as one that does not exist.
- **AN UNDATED OUTCOME STAYS UNDATED.** `occurredAt` is when the outcome HAPPENED (a human may state a
  past date), never when we heard about it, and null survives as null — the rung is still reached, it
  simply cannot be placed on the timeline. Never back-filled with the day the statement was made.
- **FAIL-SOFT with a loud log**, like every other display-enrichment read on the Overview: an unreadable
  statement set degrades to the forecast alone rather than 502-ing a page whose every other number is
  correct.
- **`meetingAttended` / `meetingAttendedAt` ride `leads[]`** so the row a customer opens says the same
  thing as the money above it. Without them a lead priced on having attended would show only "booked",
  and the drilldown would read as a smaller fact than the total it feeds.
- **Expect the pipeline to FALL.** Lost deals leave it, no-shows are depreciated, and real amounts
  replace the average. ROI and %CAC move with it. That is the end of an overstatement, not a regression.
- Guards: `src/routes/observed-step-value.test.ts` drives ONE lead and ONE set of economics through
  every case, so the numbers are comparable line by line (clicked $34.70, replied $120, booked $150,
  attended $300, closed $1,000): the forecast baseline unchanged; a booked meeting extinguishing the
  routes; attended worth exactly twice booked under a 50% show-up rate; a stated amount at the terminal
  rung and at an earlier one; a lost deal at 0; a dead meeting step killing the conversation funnel while
  the website funnel keeps its click; an empty disqualification set changing nothing; the legacy source
  still landing; a statement winning over it; and the fail-soft degrade. Plus `funnel-registry.test.ts`
  (the five legs, the per-funnel leg sets) and `declared-funnels.test.ts` (the composed rate beside its
  un-composed half). (Set 2026-08-26.)

## `?groupBy=campaignId` STATES HOW MUCH EVIDENCE ITS MONEY RESTS ON — `outcomes`, the volume half, at the CAMPAIGN grain

A customer looking at the Campaigns list asks one question of each row: is this campaign working. The
row answered in money alone — ROI, %CAC, expected pipeline, invested spend. All three ratios are
DERIVED from however many outcomes the campaign has produced so far, so with one or two behind them
they are decided by whichever one happened to land: they swing by whole multiples on the next reply
while the row presents them as a measurement. The dashboard states a "Learning" tag instead of a
number until enough outcomes have landed, and the campaign rows were the one surface it could not
apply the rule to — the group carried `campaignId`, `campaignIdentity`, `headline` and
`costEconomics`, and `expectedConversions` is lens-only.

- **THE BLOCK IS THE PER-WORKFLOW GRAIN'S, BY THE SAME CODE.** `lib/revenue-outcomes.ts` now owns the
  interface + builder that shipped for `?groupBy=workflow` (#776); `buildWorkflowOutcomes` /
  `WorkflowRevenueOutcomes` are aliases of it, so nothing about that grain moved. Same seven fields
  (`recipientsContacted` / `recipientsClicked` / `recipientsRepliesPositive`, `committedSpentCents`,
  the transitional `actualSpentCents`, `cpcCents`, `cpprCents`), same rules — one implementation, so
  the two grains cannot come to disagree about whether a lead clicked, for the reason
  `signal-overlays.ts` is one copy.
- **IT IS TOTALLED OVER THE IDENTITY, exactly as the money is.** The per-identity compute already runs
  over the family's WHOLE membership, so the block is built from those persons and deduped inside them
  — a lead served under two member rows is ONE person here as it is one person to the brand, and every
  member of an identity carries the identical block. **PEOPLE ARE COUNTED, NOT ADDED**: the
  #749 double-count came from folding email-gateway's per-campaign aggregates, and nothing is folded
  here, so an identity's count is a SUBSET of the brand's by construction rather than by a correction.
  Across identities the rows do not sum to the brand — the counting-people property the money already
  carries.
- **ONE COMMITTED BASIS, so the two halves cannot describe different dollars.**
  `committedSpentCents / 100 === costEconomics.committedCostUsd` for the same row and
  `cpprCents × recipientsRepliesPositive ≈ committedSpentCents`. Guarded with a fixture where committed
  and billed DIFFER, so a silent billed-basis regression cannot pass.
- **THE RATES ARE OBSERVED. 0 IS A MEASURED COUNT, NULL IS NOT.** A campaign that spent and bought no
  visit reports `recipientsClicked: 0` with `cpcCents: null` — never a $0 that reads as free, never a
  benchmark floor (projection has `/workflow-projection`).
- **NULL ONLY WHERE THE LEADS WERE NEVER READ** — the no-funnel short-circuit, whose money half is
  honestly null beside it. The COLD-START path (economics null) DID read the leads, so it answers the
  real volume: "we could not price this" and "this reached nobody" are different statements. The lens
  response nulls it on the same gate as `spend` (a lens is a lead SUBSET while its spend leg is the
  brand's whole spend).
- **IT RIDES `RevenueBody`, so it is on the un-grouped brand / offer / channel reads too** — the same
  scope's volume, truthfully — and it costs ZERO extra IO everywhere: the persons and the cents were
  already in hand. NOT added to the `?groupBy=offerId` or `?groupBy=workflow` group shapes (workflow
  already had it; the offer row was not asked for and its shape stays byte-unchanged).
- **NO QUERY PARAMETER.** A consumer that has to opt in is a consumer that renders the ratios without
  the volume by default, which is the bug.
- Guards: `src/routes/campaign-group-outcomes.test.ts` (identity totalling + shared lead counted once
  + the committed basis; no row exceeds the brand while the rows over-count when added; a one-campaign
  identity byte-equal to its own `?campaignId=` read; the measured 0 vs the null rate; the
  spent-and-reached-nobody row; the no-funnel null; the lens null) + the lean key-set case in
  `routes/revenue.test.ts`. (Set 2026-08-26.)


## COMPED SPEND SPLITS EVERY MONEY FIGURE IN TWO — `charged` is what the customer PAID, `incurred` is what the workflow COST, and the second one is the half that breaks silently

The platform sometimes COMPS a customer for spend that genuinely happened (2026-08-25: a provider
incident burned a brand's budget generating nothing, and the owner comped it). runs-service records
that as its own cost state. This service answers TWO different questions off that one ledger and they
want opposite treatment of a comped cost — the owner's line: **refunded money affects the ACCOUNTING
view, not the workflow PERFORMANCE view.**

- **CHARGED (accounting)** — what the customer was CHARGED: their spend, their invested total, their
  ROI, their %CAC, their cost per outcome. A comped cost VANISHES from these. **It fixes itself**:
  runs-service aggregates `status IN ('actual','provisioned')`, so a refunded row is simply not in
  `totalCostInUsdCents`. Nothing here had to change for this half, and `charged` is the DEFAULT of
  every selector precisely so it stays that way.
- **INCURRED (performance)** — what a workflow COSTS to produce an outcome: the cross-org fleet
  benchmark that ranks workflows, and anything that projects what a budget buys. A comped cost STAYS
  at FULL value. **This is the half that breaks SILENTLY** — real spend just disappears, no error,
  no red test, a comped brand reading artificially cheap, the fleet benchmark dragged down for every
  other customer and their budget projections under-priced. That silent half is the whole reason the
  axis exists.

- **IT IS NOT THE GROSS/NET AXIS AND MUST NEVER BE FOLDED INTO IT.** Gross-vs-net is a DISCOUNT
  question (what we charged vs list price); charged-vs-incurred is a COMPED question (did we charge it
  at all). They COMPOSE: a NET INCURRED figure is the discounted price of spend we comped. Guarded.
- **THE CLASSIFICATION IS BY SCOPE, WITH ONE DELIBERATE EXCEPTION.** Cross-org fleet aggregates are
  ALWAYS `incurred` — including the `crossOrg` grain INSIDE a customer's `/workflow-projection` and
  the fleet parent `/audience-stats` floors against, because that grain IS the fleet benchmark and one
  org being comped must not make a workflow look cheaper to everybody else. Org-scoped figures are
  ALWAYS `charged`. The exception is `pipeline-activity`'s brand-observed cost-per-outreach
  (`fetchBrandObservedOutreachUsd`): brand-scoped but read INCURRED, because it is the DIVISOR of
  `expected.outreach = dailyBudget / costPerOutreach` — a dollar buys the same number of sends whether
  or not we later comped it, so comping must never promise a brand more sends than its budget buys —
  and because it is `max()`-ed against the fleet benchmark, which is incurred. Mixing the two bases
  inside that `max` compares two currencies and can pick the wrong side.
- **EVERY SURFACE SAYS WHICH QUESTION IT ANSWERS, ON THE WIRE.** `/revenue`, `/stats`,
  `/audience-stats`, `/brands/:id/{revenue,offers}`, `/offers/:id/revenue` and `/public/stats/revenue`
  carry `costBasis: "charged"`; `pipeline-activity` and every `/public/stats/*` cost benchmark carry
  `costBasis: "incurred"`. `/workflow-projection` is the ONE payload holding both, so it states the
  basis PER GRAIN (`estimatesByGrain.<grain>.costBasis`) plus `resolved.costBasis` = the basis of the
  grain the resolved NUMBERS came from (`numberGrain`, not the provenance `grain` label; null on an
  unmeasured row, where the figure is an explore allowance rather than a measured cost).
  `/funnel-ranking` needs no marker of its own — it serves `ProjectionRow`s, which already carry it.
- **THE PRODUCER OWNS THE SHAPE AND THE READER IS TOLERANT OF ITS ABSENCE.** runs-service names every
  cost state `<state>CostInUsdCents` with a frozen-net twin `net<State>CostInUsdCents`
  (`total`/`actual`/`provisioned`/`cancelled` on the deployed contract, verified through api-registry),
  so the refunded bucket is read under that same convention (`lib/cost-basis.ts`). It is **OPTIONAL**:
  while the producer has not deployed, the field is absent, every read contributes ZERO comped cents,
  both bases are byte-identical to today, and the value fills in on its own the day runs ships. Do NOT
  make it required and do NOT fabricate one from another field.
- **A PROVISIONED HOLD CARRIES NO REFUND** — it was never charged, so it can never have been comped.
  Only the committed total and the billed figure take the bucket back.
- **NOTHING COMPED ⇒ BYTE-IDENTICAL, and it is byte-identical by construction, not by rounding**:
  `selectCostCentsString` returns the producer's string UNTOUCHED when the refunded figure is 0, so
  the 10-decimal precision is never reformatted.
- **NET falls back to the GROSS refunded figure** when the net twin is absent — the same
  `COALESCE(net, gross)` runs applies to pre-freeze rows. Safe here in a way a gross fallback on a
  customer PRICE is not: this figure is only ever ADDED to a benchmark, so the worst case OVERSTATES
  what a workflow costs, which under-promises rather than over-promises what a budget buys.
- **`/internal/stats/revenue`'s realized-revenue series stays CHARGED and must stay so** — that is OUR
  income, and money we comped is not revenue we earned.
- Guards: `src/routes/refunded-cost-basis.test.ts` — ONE downstream fixture ($100 billed + $400
  comped on the SAME runs group) driving `/workflow-projection`, asserting the brand grain reads $100
  while the crossOrg grain reads $500 and the two DIVERGE by exactly the comped amount. **A test that
  only checked "the customer's total went down" would pass on the design where the spend is erased
  from the benchmark too — which is the failure being prevented — so every case asserts the
  divergence.** Plus: nothing comped ⇒ same number both ways; the producer's bucket absent ⇒ still
  200, still today's number; the budget-projection read takes incurred while the displayed one does
  not; and the selectors compose with gross/net rather than replacing it. (Set 2026-08-25.)

## THERE IS ONE WORD FOR A SALES FUNNEL AND IT IS "FUNNEL" — "chain" is banned everywhere, including prose

A sales funnel is `funnelKey` in every producer, `SALES_FUNNELS` in this catalogue, brand-service's
declared set, and "Sales funnels" on the customer's own screen. It was ALSO called a **chain** for two
days — the route segment (`/offers/:offerId/chains`), the response key, the types, the unpriced reason,
the cache view, the dashboard folder and, most of all, the prose. Nothing was broken by it and every
test passed, which is exactly why it spread: a second word for one concept costs nothing until a reader
has to work out whether the two things are the same, and then it costs every reader forever.

- **The word is GONE, in identifiers AND in comments.** `git grep -i chain` over this repo returns
  nothing. Do NOT reintroduce it for a sales funnel, a funnel's legs, a funnel's rates, or a funnel's
  steps — those are the funnel, its legs, its rates and its steps. A ladder of rates is a **rate
  ladder**; a workflow's versions are a **dynasty** (`buildWorkflowDynasties` /
  `aggregateAcrossDynasties`, renamed from `buildUpgradeChains` / `aggregateAcrossChains` for the same
  reason); a sequence of service calls is a **path**.
- **The only justification for a different word is a different THING.** If it is a sales funnel, it is
  a funnel. There is no case where "chain" is the more precise word for one, and the rename found none.
- **The wire moved with it**, in three repos on the same day and with no alias on the producer side:
  `GET /offers/:offerId/funnels`, body key `funnels`, `unpricedReason: "funnel_not_declared"` (the same
  spelling `/workflow-projection` and `/audience-stats` already 404 with — one vocabulary, two
  contexts), cache view `offer-funnels`, and every type/file named for the grain. api-service mounted
  the new spelling beside the old and dropped the old once this shipped (api-service#886); the
  dashboard read the new key with a transitional fallback and then deleted it.
- Cost 2026-08-27: the grain shipped as "chain" in the morning and was renamed across
  features-service, api-service and distribute.you the same afternoon — three PRs, a transitional
  read, and a rollout window, for a word. Kevin: *"Pourquoi le mot chains, pourquoi avoir introduit un
  new concept?"* Name a new grain with the vocabulary the fleet already speaks, on the first ship.
  (Set 2026-08-27.)

## `GET /offers/:offerId/funnels/:funnelKey/{revenue,audience-stats,pipeline-activity}` — ONE SALES FUNNEL, ANSWERED IN MONEY AT ITS OWN GRAIN; the offer's three reads narrowed, never the offer's numbers under a funnel's name

`/offers/:offerId/funnels` answers at the grain of a TABLE — a lean row per funnel, four figures each.
That is the right shape for a list and the wrong shape for a funnel's own PAGE, which asks what an
offer's page asks. Three of those things are simply not on a lean row, and their absence was visible:
the funnel cost card read its total off the economics block because there was no spend breakdown to
read, and the funnel page drew NO CHART AT ALL — the consumer refusing, correctly, to render the
offer's series under the funnel's name.

- **THE SCOPE IS THE FUNNEL'S OWN CAMPAIGN SET, resolved before anything is computed.** `buildOfferFunnels`
  — the SAME partition the offer's table is built from, never re-derived and never inferred from a goal.
  So a funnel served by ONE campaign (every funnel in production today) issues the byte-same downstream
  reads that campaign's own `?campaignId=` read issues, and a funnel served by one campaign per STEP is
  the same read over a larger set. **PARTIAL COVERAGE IS NORMAL HERE BY CONSTRUCTION** — a funnel funded
  on two of its four legs answers with the two it has and says nothing about the rest; the per-channel
  breakdown inside the body is what states which legs are funded.
- **`revenue` IS `includeSpend: true` ON THE SAME COMPUTE THE ROW MAKES**, which is the whole difference:
  the `spend` breakdown per cost source, `roiHistory` (both legs cumulative, both measured, terminating
  on the headline ROI above it), and the dated ACTUAL series plus `leads[]` and the events ledger. Page
  and row are one statement at two levels of detail — guarded byte-for-byte against each other.
- **ONE PRICING RULE, SHARED — `priceFunnelRow` (`routes/offer-economics.ts`).** The funnel's own
  declared terms merged over the brand-wide record, the three `unpricedReason`s in the same order, and
  the brand-wide record NEVER borrowed as a fallback. Extracted from the `/funnels` row rather than
  restated, so this page and that table can never print two prices for one funnel. An unpriced funnel
  reports its REAL spend beside a null return; its volume half lives on `outcomes` (the cold-start path
  prices no lead, so it lists none either).
- **`pipeline-activity` IS WHY THE FUNNEL PAGE CAN DRAW A CHART AT ALL** — the same series under the
  funnel's OWN campaigns, so nothing is borrowed. The EXPECTED series, `summary.dailyBudgetUsd` and the
  conversion actuals stay NULL for the reasons the offer grain states one level up (a budget is funded
  per brand with no per-funnel ceiling; the tracker is brand-keyed). `computeOfferPipelineActivity` took
  an optional `funnelKey` — it names the SCOPE on the cache cell (view `offer-funnel-pipeline-activity`)
  so a funnel's chart and its offer's can never share one; the compute is byte-unchanged.
- **A FUNNEL THE OFFER DOES NOT SELL IS A NAMED 404** — `funnel_not_sold`, carrying `soldFunnelKeys` so
  a consumer can send the reader where the money actually is. Never an empty body (which would read as
  "this funnel produced nothing") and never the offer's figures. An unrecognised funnel WORD is a 400,
  with every pre-retirement spelling accepted forever.
- **The customer's declared money rides it exactly as it rides the row** (`customerCost`, `costCoverage`,
  `combinedCostEconomics`), scoped by the SAME campaign set. Only this funnel's bucket is asked for; the
  partition's leftovers are other funnels' statements, which the offer read is where to account for.
- **The api-service gateway forwards `/offers/*` per SUFFIX, explicitly, with no wildcard**, so these
  three need their own lines there or they 404 at the gateway.
- Guards: `src/routes/offer-funnel-grain.test.ts` — ONE fixture drives the page carrying what the row
  cannot, the funnel's own money against the offer's, the page byte-equal to its table row, the
  single-campaign identity, one-campaign-per-step with partial legs, the unpriced funnel, the customer's
  money, both named 404s, the 400s, a legacy spelling, and every existing grain unchanged.
  (Set 2026-08-28.)

## `GET /offers/:offerId/funnels` — WHAT EACH OF AN OFFER'S SALES FUNNELS COST AND RETURNED; the funnel is the smallest scope whose money divides into a RETURN, and one-campaign-per-step is why

Money answers at the brand grain, the offer grain, the campaign grain and the workflow grain. The grain
that was missing is **(offer × sales funnel)**, and it stops being optional the moment the product ships
ONE CAMPAIGN PER STEP of a funnel. A campaign then buys a single LINK — a reply, a booked meeting, an
attended meeting — so it has a cost per step and **no return of its own**: the lifetime revenue sits at
the END of the funnel, and hanging it on whichever link happened to be last would wildly overstate that
link. The funnel is the smallest scope that spans a whole path to a paying client, so it is the smallest
scope at which a return is computable at all.

- **CORRECT UNDER BOTH SHAPES WITH NO SWITCH, because the row is scoped to the funnel's CAMPAIGN SET.**
  A funnel served by ONE campaign — every funnel in production today — is **byte-equal to that campaign's
  own `/features/:slug/revenue?campaignId=` answer** (guarded), because the per-campaign read already
  prices on the funnel the campaign itself states. A funnel served by one campaign per step is the same
  row over a larger set: the money adds, the leads dedupe, and the return is the funnel's. Nothing
  branches on which shape is live.
- **THE PARTITION IS THE PRODUCER'S** (`lib/offer-funnels.ts`): a campaign states its own `funnelKey` and
  campaign-service owns it. **NEVER inferred from the goal** — both meeting funnels answer to
  `meetingBooked`, so that inference prints a funnel the campaign never stated. A campaign stating NO
  funnel (or one the catalogue does not know) is in NO row and its id rides `unattributedCampaignIds`:
  never parked on a default, never dropped in silence.
- **MONEY ADDS, PEOPLE DO NOT.** A campaign belongs to exactly one funnel, so `Σ funnels +
  Σ unattributed` IS the offer's own spend (guarded against `/offers/:offerId/revenue`). A lead worked
  through two funnels is ONE lead to the offer and is in BOTH rows, so the rows do not sum on the
  pipeline half — the counting-people property every grain here carries, and the reason the offer read
  stays the number to trust for "what did this offer do".
- **EACH FUNNEL IS PRICED ON ITS OWN DECLARED TERMS** — its own rates and its own lifetime revenue, via
  the SAME `priceOnDeclaredFunnel` merge every other funnel-narrowed read uses, with the funnel's key as
  the requested funnel. A $1k conversation contract and a $4k website one are never blended, and only
  the funnel's OWN legs carry expected value (`restrictPathsToDeclaredLegs`).
- **A FUNNEL WE CANNOT PRICE SAYS WHICH INGREDIENT IS MISSING** — `priced: false` +
  `unpricedReason`, checked in this order so the plain thing is said first: `no_channel_funnel` (no
  channel carrying it measures anything; the leads are never read, so `outcomes` is null too) →
  `no_economics_declared` (the brand states none, or the declaration could not be read) →
  `funnel_not_declared` (the declaration IS readable and does not contain this funnel). In all three the
  SPEND is real and reported and the pipeline / return / $CAC are **null, never 0**. **Do NOT fall back
  to the brand-wide economics record here** — the un-narrowed reads legitimately do, but every rate on
  that row is server-defaulted, so pricing funnel A on it is the retired-goal fiction one grain finer.
  The two unpriced-but-measurable reasons still read the leads (the engine's cold-start path), because
  "we could not price this" and "this reached nobody" are different statements.
- **THE CUSTOMER'S OWN MONEY IS IN THE COST OF ACQUISITION NOW, AND IT IS TOLD APART FROM WHAT WE
  CHARGED (supersedes the `platform_spend_only`-forever note).** The platform automates the first link
  and CHARGES for it; the customer runs the meeting and closes the deal, and lead-service records what
  those legs cost THEM (`GET /internal/brands/:brandId/step-costs`, service-auth, deployed). A funnel
  ending in a human leg used to read cheaper than it truly is and return better than it truly does,
  which is the single most misleading figure a customer can be shown about their own money. Three
  fields, never two: `costEconomics` (CHARGED — a billing fact, byte-unchanged, and none of their money
  is folded into it), `customerCost` (what THEY state, in no ledger of ours, reaching billing never),
  and `combinedCostEconomics` (the two together plus the return dividing by that sum, from the SAME
  lifetime revenue, so with nothing declared it IS the charged block). **`costCoverage` is now an
  ENUM and it is an admission**: `platform_spend_only` / `platform_and_customer_spend` /
  `platform_and_partial_customer_spend`, per ROW and — as the WEAKEST of its rows — for the payload.
  **A statement is attributed by CAMPAIGN** (it is made on a lead row, which belongs to a campaign,
  which states exactly one funnel), so the campaign set scoping a row's charged money scopes its
  declared money too; one naming no campaign, or a campaign in no funnel of this offer, rides
  `customerCost.unattributed` — never dropped, never parked. **A STATED ZERO IS AN ANSWER, AN UNSTATED
  LEG IS NOT**: null contributes nothing and raises `unstatedCount`, which is what flips the row to
  `partial` — a funnel we cannot fully cost says so instead of guessing. The read is FAIL-SOFT with a
  loud log, and its `null` ("could not read") is deliberately distinguishable from zeros ("nobody
  stated one"). Do NOT widen `committedCostUsd` to swallow it and do NOT let any of it reach billing.
- **NO CONSUMER-SIDE AGGREGATION.** The composition happens here; a grain the dashboard has to assemble
  from N campaign calls is not a grain. Rows are LEAN (`headline` + `costEconomics` + `outcomes`,
  `includeSpend: false`) because a table polls them.
- **The api-service gateway forwards `/offers/*` per SUFFIX, explicitly, with no wildcard**, so this
  read needs its own line there or it 404s at the gateway.
- Guards: `src/routes/offer-funnel-revenue.test.ts` — ONE fixture drives the grain, the single-campaign
  byte-equality, the one-campaign-per-step funnel, money-adds-while-people-do-not, each funnel on its own
  declared terms, both unpriced reasons, the unattributed campaign, the lean key set, the named 404,
  the fail-loud parses, and every existing grain answering unchanged; plus the customer-money suite in
  the same file (the combined return SMALLER than the charged one, a funnel with none byte-equal to
  today, the unstated leg turning the row partial, attribution by campaign, the unplaceable statement,
  and the degrade). Plus `lib/offer-funnels.ts` for the partition itself and
  `lib/funnel-customer-costs.test.ts` for the statement partition + the coverage marker.
  (Set 2026-08-27; customer-declared cost same day.)

## `GET /brands/:brandId/offers` — THE BRAND'S OFFERS TABLE, EACH ROW AT THE OFFER GRAIN; it is the offer read N times, LEAN, not a new computation

The brand Overview lists a brand's OFFERS one row each, with that offer's ROI, %CAC, revenue and
invested. The only way to ask for that was `/features/:slug/revenue?groupBy=offerId`, which names ONE
channel — so every row answered "what did this offer return THROUGH THIS ONE CHANNEL" while the table
presented it as the offer's whole result, **directly beneath brand cards that already read the whole
thing**. Prod 2026-08-23, brand `75d7e3e8…` / org `b645207b…`, its single offer `d5ecba00…` across four
channels: the offer's real money is **$2,668.47 committed / 2.623x / 38.121% CAC** and the table printed
**$2,625.44 / 2.666x** — the pitch channel alone. Both figures real, about different things, page
contradicting itself.

- **A ROW IS THE BYTE-SAME COMPUTATION `/offers/:offerId/revenue` MAKES FOR ITS TOTAL** — same channel
  set, same campaign scope, same brand pricing, ONE engine pass — with only the bulk dropped
  (`includeSpend: false`, so no `leads[]`, no `spend` block, no series). So the reconciliation is by
  construction, not by correction: `headline` + `costEconomics`, the lean shape the channel, campaign,
  workflow and per-feature offer groups already use. **Do NOT re-derive an offer's figures here** — a
  second implementation is what would drift from the standalone read the customer can open.
- **THE COMBINATION RULES ARE THE OFFER GRAIN'S, UNCHANGED AND BY THE SAME CODE.** Money adds (the
  offer's channel set goes to runs-service as its plural `featureSlugs` filter and the PRODUCER sums);
  people do not (one brand-scoped lead read, deduped before the engine); pipeline does not (one engine
  pass per offer); no ratio does (recomputed from the combined numerator and denominator).
- **WHY NEITHER CONSUMER-SIDE ROUTE WORKS.** Looping `/offers/:offerId/revenue` per row is correct
  arithmetic and unusable: that body is ~8 MB for the brand above (it carries the whole lead
  population) for a table rendering four numbers and polling every 30s. Summing the per-channel
  breakdown in the browser is cheap and WRONG — ratios do not add — and is the client-computed-metric
  bug this service exists to prevent.
- **`offers: []` AND THE 404 ARE DIFFERENT ANSWERS.** One `fetchBrandCampaignRows` read answers both:
  no campaign at all ⇒ named `brand_has_no_channels` 404 (we cannot tell which channels a figure should
  span); campaigns that state no offer ⇒ `offers: []`, the honest transition state while
  campaign-service fills `offerId` in. A campaign stating no offer is in NO row, with its spend and its
  leads — never parked on a default offer.
- **THE ROWS DO NOT SUM TO THE BRAND, and the brand read stays the number to trust for "what did this
  brand do"** — a lead served under two offers' campaigns is one lead to the brand and belongs to both,
  and the brand total narrows by nothing while a row narrows to its offer's campaigns. Same
  counting-people property the campaign, workflow and channel grains carry.
- **A brand selling ONE offer through every campaign that has runs reads its own figures**, and an offer
  sold through ONE channel reads that channel's own `?groupBy=offerId` group. Both guarded.
- **Each offer resolves its OWN funnel from its OWN channels** (`resolveOfferFunnel`, now exported from
  `offer-economics.ts`): an offer whose channels price two ways is a 409 `offer_channels_price_differently`
  NAMING THE OFFER, never one silently picked. Cannot happen today.
- **The WHOLE (offer × channel) partition rides the `scope_key`** (`offers=a>x+y,b>z`), not just the
  offer list: a newly funded channel on one offer changes that row's every figure while no other key
  part moves. Economics are read ONCE (brand-scoped) and shared by every row, fingerprint in the key.
- **Ordering is ascending `offerId`** — deterministic; a table sorts its own way.
- **The api-service gateway forwards it at `GET /v1/features/brands/:brandId/offers`, NOT under
  `/v1/brands/*` like its three siblings** (api-service#855) — `/v1/brands/:id/offers` was ALREADY taken
  there by brand-service's offer CATALOG, which mounts first, so a same-path forward would have been
  dead code. Two different questions sharing a noun. The DOWNSTREAM path is unchanged (`/brands/:brandId/offers`
  is what this service serves); only the gateway's own prefix differs. Do NOT "fix" the inconsistency by
  moving it — and note the gateway's per-suffix forward is EXPLICIT, no wildcard, so any NEW read at
  either grain needs its own line there or it 404s.
- Guards: `src/routes/brand-offers.test.ts` (a row spans every channel; row ≡ the standalone offer read;
  the one-offer brand ≡ the brand read; the one-channel offer ≡ that channel's group; money adds while a
  shared lead counts once; the unattributed campaign in no row; the lean key set; `[]` vs 404).
  (Set 2026-08-23.)

## A BRAND RUNS SEVERAL CHANNELS AT ONCE — `GET /brands/:brandId/{revenue,audience-stats,pipeline-activity}` answers for the BRAND; it is the offer grain ONE LEVEL UP, on the SAME code

A brand holds several OFFERS and sells each of them through several ACQUISITION CHANNELS. So neither a
per-feature read (one channel) nor an offer read (one offer's channels) can answer for the BRAND — and
the brand is what the customer's main screen presents.

**It showed up as a FRACTION with two grains in it.** The Overview read one channel's money and paired
it with billing's BRAND daily budget. Prod 2026-08-20, brand `75d7e3e8…` (org `b645207b…`):
`sales-cold-email-outreach` spent $40.07 today against its own $40 ceiling and
`feedback-request-cold-email-outreach` $10.32 against its own $10 — and the page read **"$40 / 50"**.
The denominator was right. The numerator was about one channel. Nothing errored: both numbers were
real, they were simply about different things.

- **EVERY COMBINATION RULE IS THE OFFER SECTION'S, UNCHANGED, AND IT IS THE SAME CODE** — money adds
  (a run carries one `feature_slug`, so the channel set goes to runs-service as its plural
  `featureSlugs` filter and the PRODUCER sums); people do not (one brand-scoped lead read, deduped
  before the engine); pipeline does not (ONE engine pass, the per-organisation combination is not
  additive across partitions); no ratio does (recomputed from the combined numerator and denominator);
  a benchmark is not combinable at all (`pickBestChannel`, the best-returning channel's taken whole).
  `computeFeatureRevenue` / `computeAudienceStats` / the day-bucket merge are the byte-same functions
  the offer grain calls — a second implementation is what would drift.
- **IT IS NOT THE SUM OF THE BRAND'S OFFERS AND NOT THE SUM OF ITS CHANNELS.** Only the additive half
  could be summed at all, and it would be assembled by a consumer that owns neither list.
- **THE SCOPE IS THE CHANNEL SET, NOT AN ENUMERATED CAMPAIGN LIST** (`lib/brand-channels.ts`, the offer
  partition read one narrowing wider). `brandId` is already a producer filter on every read here, so
  unlike the offer grain — where the campaign is the frozen link to the offer — nothing is narrowed by
  campaign. Two consequences, both wanted: a campaign campaign-service does not list still has its
  spend counted, and a brand running exactly ONE channel issues the byte-same downstream requests its
  per-feature read issues today, so its answer cannot move. The campaign ids still ride each breakdown
  row so a reader can see what a row is made of.
- **A CHANNEL ROW IS NARROWED TO ITS OWN CAMPAIGNS, unlike the brand body above it — and that is not
  an inconsistency, it is the only way its RETURN is its own.** The row's MONEY would be identical
  either way (the feature filter already isolates a channel's cost rows), but the lead read has never
  been feature-scoped, so an un-narrowed row would divide the BRAND's whole pipeline by ONE channel's
  spend and print a return that channel never earned. Σ rows IS the brand's spend (to the same sub-cent
  rounding the workflow and offer grains document: a row groups by workflow, the total's `spend` block
  by cost name, and runs-service returns fractional cents per group). The rows do NOT sum on the people
  half — a lead worked through two channels is one lead to the brand and belongs to both rows.
- **`pipeline-activity` STATES WHAT THIS GRAIN OWNS AND NULLS WHAT IT CANNOT COMBINE.** The DAILY
  BUDGET is the brand's (billing funds it per brand) and the OBSERVED conversions are the brand's (the
  tracker is brand-keyed), so both are answered here where the offer grain must null them — the budget
  is read on its own rather than taken off the forecast, precisely because the case where the forecast
  nulls is the case where the customer still needs the ceiling their day's spend is read against. The
  EXPECTED series is NOT combinable: `expected.outreach = dailyBudgetUsd / effectiveOutreachUsd` and
  that divisor is a property of ONE channel, with no per-channel ceiling to split the budget by. So
  with several channels the expected bars are null and the budget is still stated; with exactly one
  channel the ordinary forecast is computed, unchanged. **Do NOT "fix" the null by dividing the brand's
  budget by one channel's price — that IS the two-grain pairing this grain removes.**
- **A BRAND campaign-service LISTS NO CAMPAIGN FOR IS A NAMED 404** (`brand_has_no_channels`), never a
  figure about an unknown subset of channels. An unreadable channel set is FAIL-LOUD for the same
  reason. Two channels pricing on different `FUNNEL_REGISTRY` definitions is a **409
  `brand_channels_price_differently`** (it cannot happen today; both registered channels price on
  `salesFunnel`).
- **NOT SERVED AT THIS GRAIN, on purpose:** `?lens=` (a lens narrows to a subset of LEADS while its
  spend leg would still be the whole brand's) and `?groupBy=` (the only grouping here is the channel
  breakdown, which is unconditional). Both stay available per channel.
- **THE PER-FEATURE AND PER-OFFER READS ARE UNTOUCHED** and still mean exactly what they mean. Both
  have live consumers; nothing moves until one opts in.
- **The api-service gateway DOES proxy `/brands/*` now** (api-service#852, prod) — an EXPLICIT
  per-route forward per suffix, no wildcard, so a NEW `/brands/:brandId/<suffix>` read here needs its
  own line there or it 404s at the gateway.
- Guards: `src/routes/brand-cross-channel.test.ts` (both channels accounted for incl. TODAY's spend;
  money adds and Σ rows is the brand's spend while a shared lead counts once; a row states its own
  return; the one-channel identity on all three reads; the per-feature read unchanged; the named 404;
  the budget stated beside a null forecast), `src/lib/brand-channels.ts` for the partition itself.
  (Set 2026-08-20.)

## AN OFFER IS SOLD THROUGH SEVERAL CHANNELS AT ONCE — `GET /offers/:offerId/{revenue,audience-stats,pipeline-activity}` answers for the OFFER; MONEY is the only thing that adds

A brand sells one OFFER through several ACQUISITION CHANNELS at once. A channel IS a feature slug (this
fleet has no other name for one), each is funded and paced on its own money, each runs its own campaigns
against the same offer, the same funnel and the same audiences — and the customer looks at the offer as
one thing. Every read this service had names ONE feature slug in its path, so each one answers "what did
this offer return THROUGH THIS ONE CHANNEL" while the offer screen presents it as what the offer returned.

While a brand had exactly one channel those were the same answer. **The moment a second is funded they
diverge, and they diverge SILENTLY** — nothing errors, the figures are simply about less than they claim.
Prod 2026-08-20, brand `75d7e3e8…` offer `d5ecba00…`: months of `sales-cold-email-outreach` history, plus
`feedback-request-cold-email-outreach` funded 2026-08-19 and serving from 2026-08-20 12:45, plus
`ai-visibility-scoring` and `pr-expert-quote-opportunities`. Four channels, one offer, one screen.

- **WHICH FIGURES ADD, AND WHICH DO NOT — this is the whole design, and it is why the grain cannot live
  in the browser.**
  - **ADDITIVE — MONEY, and only money.** A run carries exactly one `feature_slug` and one `campaign_id`,
    so every cost row belongs to exactly one channel of one offer. Spend adds with nothing counted twice
    — and it is not added HERE either: the offer's feature scope goes to runs-service as its plural
    `featureSlugs` filter (comma-split server-side, verified in `runs-service/src/routes/stats.ts`), so
    the producer sums the same rows it would have returned per channel. Same for run counts and for any
    per-day SEND count.
  - **NOT ADDITIVE — PEOPLE.** A lead worked through two channels is ONE lead to the offer and belongs to
    both. Handled by never summing: the lead read is brand-scoped and campaign-filtered (it has NEVER
    been feature-scoped), so one read covers every channel and `dedupPersonsByLead` collapses the
    duplicate before the engine sees it. Same property that already makes the per-campaign and
    per-workflow groups not sum to their brand.
  - **NOT ADDITIVE — PIPELINE.** The engine combines a lead's paths per ORGANISATION, which is not
    additive across partitions. Handled by ONE engine pass over the offer's whole evidence set.
  - **NOT ADDITIVE — EVERY RATIO** (ROI, %CAC, $CAC, cost per click, cost per reply). A ratio of sums is
    neither the sum nor the average of the ratios; each is recomputed from the combined numerator and
    denominator, which the single pass already does.
  - **NOT COMBINABLE AT ALL — A BENCHMARK.** `fetchBrandProjectedParents` is a property of ONE channel.
    Several channels have several benchmarks and there is no benchmark of a mix; blending two would be
    the cross-org PLUS cross-workflow pooled estimate this service refuses to publish, and the blended
    object would stop being coherent (cost per click from one channel, cost per paid client from
    another). So the BEST-RETURNING channel's is taken WHOLE — `pickBestChannel` in `lib/offer-parents.ts`,
    ranking on `costPerPaidClientUsd` because it is the one figure every channel denominates the same
    way. Same doctrine as the combined-`sales` `min` over routes and the brand-level `max` over declared
    funnels' returns: a dollar buys the outcome through whichever route converts it best.
- **THE PER-FEATURE READS ARE UNTOUCHED AND STILL MEAN WHAT THEY MEAN.** A campaign row IS a channel and
  is priced on its own channel's money; live consumers rank real spend on those numbers. `?offerId=` on
  `/features/:slug/*` still narrows to that ONE channel — it is a different question, not a broken one.
- **AN OFFER SOLD THROUGH ONE CHANNEL ANSWERS IDENTICALLY TO THAT CHANNEL'S OWN READ**, by construction:
  one slug in the feature scope produces the byte-same `featureSlugs` value, the same campaign scope, the
  same brand pricing and the same engine, and `pickBestChannel` over one channel picks it. So every brand
  on one channel today sees no change whatsoever. Guarded in `routes/offer-cross-channel.test.ts`.
- **THE BREAKDOWN SHIPS IN THE SAME RESPONSE** (`channels[]`), because the consumer does not own which
  channels an offer sells through — the campaign row does, here — and an answer it assembled from N calls
  would be the browser-side re-derivation this grain exists to prevent. Each `/offers/:id/revenue` channel
  row carries the same figures that channel's own `/features/:slug/revenue?offerId=` read carries — same
  campaign scope, same brand pricing, same engine — so a row and the total above it are one statement at
  two grains. **Not to the cent, and for the reason the workflow grain already documents: a channel row
  reads its spend through `fetchRunsCostCents` (grouped by workflow) while the standalone read builds the
  `spend` block through `fetchSpendBreakdown` (grouped by cost name), and runs-service returns FRACTIONAL
  cents per group, so each rounds once per its own grouping.** Same ledger, different grouping. Prod
  2026-08-20, offer `d5ecba00…`: the pitch channel reads $2,506.50 in the breakdown against $2,506.37 on
  its own endpoint, and Σ channels is $2,516.46 against the offer's $2,516.33. Do NOT "fix" it by
  re-basing either side — the standalone read is the customer's number.
- **A CHANNEL THIS SERVICE CANNOT MEASURE STILL COSTS MONEY.** Several published channels declare no
  funnel (we measure email today; a channel declaring measurements it cannot make would report a
  fabricated zero). Their campaigns are in the offer's scope, so their SPEND counts — the customer paid
  it — and they contribute no pipeline, exactly as their own read reports them. Nothing special-cases
  them: the engine prices SIGNALS and a channel that sends no email produces none. The breakdown shows
  each with real spend and a null pipeline, so the caveat is visible rather than buried.
- **THE FUNNEL IS THE ONE EVERY FUNNEL-BEARING CHANNEL SHARES.** Two channels pointing at different
  `FUNNEL_REGISTRY` definitions would price one lead two ways in a single pass, so that is a **409
  `offer_channels_price_differently`** rather than a silent pick. It cannot happen today (both registered
  channels price on `salesFunnel`). No channel with a funnel ⇒ null pipeline, spend still reported.
- **`x-feature-slug` IS NOT FORWARDED on an offer read**, and neither is a single slug picked for the
  economics read: attributing a several-channel question to one of them would name a channel the caller
  never asked about.
- **THE CHANNEL SET RIDES EVERY CACHE `scope_key`** (`channels=a+b`). A newly funded channel changes every
  figure while no other key part moves, so without it the offer would keep replaying its pre-funding
  answer until the hard-stale cap — the same reasoning as the economics fingerprint beside it.
- **`fetchBrandCampaignRows` takes an OPTIONAL feature slug** so the offer read can ask for EVERY channel;
  narrowing by a slug it would have to guess first is the enumerate-then-ask-N-times shape being removed.
- **NOT SERVED AT THIS GRAIN, on purpose:** `?lens=` (a lens narrows to a subset of LEADS while its spend
  leg would still be the whole offer's) and `?groupBy=` (the only grouping here is the channel breakdown,
  which is unconditional). Both stay available per channel. On `pipeline-activity` the EXPECTED series,
  the daily budget and the conversion actuals are null for the reasons the per-feature offer read already
  states (a budget is funded per brand with no per-offer ceiling; the conversion tracker is brand-keyed).
- **The api-service gateway DOES proxy `/offers/*` now** — an EXPLICIT per-route forward per suffix, no
  wildcard, so a NEW `/offers/:offerId/<suffix>` read here needs its own line there or it 404s.
- Guards: `src/routes/offer-cross-channel.test.ts` (both channels accounted for; money adds while a
  shared lead counts once; a channel row byte-equal to its own read; the one-channel identity; the
  per-feature read unchanged; the named 404), `src/lib/offer-channels.ts` + `src/lib/offer-parents.ts` +
  `src/lib/feature-scope.ts` for the rules themselves. (Set 2026-08-20.)

## A SALES FUNNEL IS SOLD LEG BY LEG — a channel states which step it moves a lead FROM and which step it moves it TO, and "from nothing" is the SPECIAL case (supersedes the produces-an-entry-step model)

A four-step funnel used to be sellable only end to end, because a channel could state nothing but the
kinds of step it could PRODUCE, and every one of those is a step a funnel STARTS from. That reads as the
whole model only because it was the only kind of channel in the catalogue. It is not: booking a meeting
off a reply, getting that meeting actually held, and closing it are three separate things somebody does,
each with its own channel, its own daily budget and its own stats. Campaign provisioning already works
per funded (funnel, channel) pair, so the catalogue was the only thing in the way.

- **A CHANNEL STATES ITS `stepTransitions` — `{ from, to }` — AND `from: null` IS "FROM NOTHING".** The
  lead was not on the funnel at all until this channel produced its first step. Every channel published
  before this states only legs of that shape, which is written as one line by `producesFromNothing(...)`.
  Do NOT reintroduce a bare `producibleSteps` on the STORED blob: that is the special case wearing the
  clothes of the general one, which is exactly what made an internal leg unsayable.
- **`producibleSteps` SURVIVES ON THE WIRE, DERIVED, WITH ITS MEANING INTACT** (`producibleStepsOf` =
  the `to` of the `from: null` legs). A channel that only performs internal legs produces NOTHING, and
  `[]` there is a real answer rather than a gap.
- **THE JOIN IS STILL DERIVED — ONLY ITS GRAIN MOVED.** `sellableFunnelsFor` used to compare a channel's
  produced steps against each funnel's ENTRY step; it now compares its transitions against each funnel's
  LEGS, of which the entry (`{from: null, to: steps[0]}`) is simply the first. `funnelLegs` reads those
  straight off `SALES_FUNNELS[key].steps` through `FUNNEL_STEP_LABEL_TO_KEY`, and a funnel containing a
  step this catalogue cannot name THROWS (`UnknownFunnelStepLabelError`) rather than silently losing a
  leg — which would quietly stop a channel being sellable through a funnel it can genuinely serve.
- **EVERY CHANNEL PUBLISHED BEFORE THIS READS THE IDENTICAL LIST OF FUNNELS**, verified row by row
  against `origin/main` before shipping: 40 feature rows, zero drift. Cold email and CRM email still all
  four, the feedback request still `sales_meetings_from_conversation` alone, a non-channel still `[]`.
- **THE STEP VOCABULARY IS NOW THE UNION OF EVERY FUNNEL'S STEPS, not the entry subset**
  (`CHANNEL_STEP_KEYS`, nine): a channel performing an internal leg has to name the step it moves a lead
  OUT of, and that step is never one a funnel starts at. `meeting_booked` / `meeting_attended` / `signup`
  / `form_filled` / `paid_client` joined the four that were there. This is precisely why the `in_ad_`
  prefix was load-bearing all along — `form_filled` and `meeting_booked` are now real keys in the same
  list, so the shorter spellings would COLLIDE outright.
- **`operatedBy` SAYS WHO PUTS THE HOURS IN, and it is what makes a ZERO daily cost legible.** A leg a
  human performs can be run by US (`platform` — the daily operating cost is that specialist's day) or by
  the CUSTOMER (`customer` — their founder takes the call, their team confirms the meeting). A
  customer-run channel spends none of the platform's money, so its `dailyOperatingCostCents` is
  genuinely **0**, and the parser REFUSES a customer-operated channel that states anything else: we do
  not charge for a day of work we do not do. **Do NOT invent a flat daily figure for those to make the
  family look uniform** — what the leg costs THEM is stated per lead against lead-service, and a zero
  nobody can read is indistinguishable from a field nobody filled in. Every channel that FINDS people
  (any `from: null` leg) is `platform`-operated; a zero there WOULD be a hole, and is guarded.
- **THE SAME LEG IS PUBLISHED TWICE, ours and theirs**, because those are two different things to buy:
  `managed-meeting-booking` / `in-house-meeting-booking`, `managed-meeting-attendance` /
  `in-house-meeting-attendance`, `managed-closing-calls` / `founder-led-closing`,
  `managed-signup-conversion` / `in-house-signup-conversion`. Each pair states the IDENTICAL legs and
  therefore the identical sellable funnels; only the operator and the price differ. They carry the new
  `conversion` family — nothing here finds anybody.
- **A LEG CHANNEL IS PAIRED FROM DAY ONE AND ANSWERS `no_spend_recorded`.** `channel.salesFunnels` is
  what `/public/channel-funnel-economics` builds pairs from, so these get their rows immediately; with
  no run behind them the pooled evidence is empty and the pair states the honest missing ingredient.
  Nothing was special-cased for them, and nothing here reads the per-lead declared costs a parallel
  workspace is adding to lead-service — that reader belongs with the data.
- **STILL NO AVAILABILITY FLAG, still no channel table, and no "convertor" beside "channel"** — it is
  the CHANNEL that gained this capability, and the blob's key set is pinned to
  `{family, operatedBy, stepTransitions, terms}`.
- Guards: the widened-join cases in `src/lib/acquisition-channels.test.ts` (an internal leg sells its
  funnel; the two meeting funnels share every leg after the booking; a leg no funnel takes, and a backwards
  leg, sell nothing), `src/lib/channel-catalogue.test.ts` (an unstated `from` and a leg-to-itself both
  FAIL LOUD; a customer-operated channel with a daily cost fails; an internal-leg channel produces
  nothing and still sells), and the two new suites in
  `src/seed/acquisition-channel-catalogue.test.ts` (the three legs of a meeting funnel as three products;
  the ours-vs-theirs pairs agreeing on legs and disagreeing on price). (Set 2026-08-27.)

## A CHANNEL PUBLISHES ITS COMMERCIAL TERMS AND WHAT IT CAN PRODUCE; WHICH FUNNELS IT SELLS THROUGH IS DERIVED, NEVER A SECOND LIST

An acquisition channel IS a feature slug — still no channel table, still no channel concept, and none
may be introduced. What a feature now states is `acquisitionChannel`: the commercial terms a buyer
commits to before anything is measured, and the legs the channel can PERFORM (see the section above;
this section's "kinds of STEP it can PRODUCE" is the `from: null` half of that). Roughly forty channels
are published, all bookable from day one, and a public marketing site is generated from them.

- **`salesFunnels` IS DERIVED (`sellableFunnelsFor`) AND MUST STAY DERIVED.** A channel states which leg
  it performs; a funnel states its funnel (`funnelLegs`, mirrored from brand-service and pinned against
  `SALES_FUNNELS[key].steps`); a pairing is possible when the two meet. Hand-writing `salesFunnels`
  again would restore the drift the derivation removes. The wire field is UNCHANGED and every existing
  row reads byte-identically: cold email and CRM email still all four, the feedback request still
  `sales_meetings_from_conversation` alone, a non-channel still `[]`.
- **NULL ON `acquisitionChannel` IS A WRITTEN STATEMENT** — this feature is not an acquisition channel
  (hiring, VC and accelerator outreach, outlet discovery, press-kit generation, AI visibility). It
  acquires something other than a customer, or is internal tooling, so there is nothing to pair it with.
  Journalist outreach and both expert-quote features MOVED to the channel side: they are earned channels
  producing website visits, so they now sell through the three click-driven funnels where they used to
  sell through nothing.
- **THERE IS NO "COMING SOON", AND NO FLAG MAY BE ADDED FOR ONE.** Every published channel is
  `implemented: true` / `status: "active"`. A channel we are slower to deliver says so through its OWN
  terms — a high `dailyOperatingCostCents` (a phone channel carries the person on the line, LinkedIn Ads
  carries its own daily floor, SEO carries the specialist), a long `maxDaysToFirstProduction`, a long
  `minimumCommitmentDays`. Guard: the blob's key set is exactly `{family, producibleSteps, terms}` and
  `maxDaysToFirstProduction ≤ minimumCommitmentDays` (we never sell a booking that ends before it can
  produce).
- **THE TWO IN-AD STEPS ARE STATED BEFORE THEIR FUNNELS EXIST, ON PURPOSE.**
  `in_ad_form_submission` and `in_ad_booked_meeting` are produced INSIDE THE AD UNIT rather than on the
  brand's site, and no deployed funnel starts from either yet (brand-service ships them in parallel).
  A channel producing only those sells through nothing TODAY and starts selling the moment the funnel
  mirror gains the funnel, with no change here. What a channel can produce is a fact about the channel,
  not about what we happen to sell through it.
  **THE `in_ad_` PREFIX IS LOAD-BEARING — do not shorten it to `form_submission` / `booked_meeting`.**
  "Form filled" and "Meeting booked" ALREADY exist in the deployed catalogue as INTERMEDIATE steps
  (`form_magnet` step 2, both meeting funnels' milestone), reached through a click or a reply onto the
  brand's site; an ad produces an ENTRY step reached without ever getting there, so the bare names
  invite a consumer to read such a channel as able to START `form_magnet`, which it cannot. Since the
  leg-by-leg change those two are LITERAL KEYS in `CHANNEL_STEP_KEYS` (`form_filled`, `meeting_booked`),
  so the shorter spellings would now collide outright rather than merely mislead. `platform_`
  (the first spelling, renamed 2026-08-19) is wrong because `platform` is this fleet's word for OUR OWN
  platform, and `ad_` alone reads as "attributed to an ad" — i.e. filled on the brand's site after the
  click, the very reading the prefix blocks.
- **THE PRE-EXISTING SLUGS DID NOT MOVE.** `sales-cold-email-outreach` and `sales-crm-email-outreach`
  keep the legacy `sales-` prefix because live campaigns, live budgets and the cost ledger reference
  them. And no NEW slug ends in `-cold-email-outreach`: that suffix is what `coldEmailOutreachSlugs`
  derives the fleet audits' whole account universe from, so a new one landing in it would silently
  enrol the channel in send-forecast / accounts / customer-health. Guarded.
- **THE NEW CHANNELS DECLARE EMPTY `outputs`/`charts`/`entities`, AND THAT IS NOT A BOOKABILITY
  STATEMENT.** Those three are the MEASUREMENT surface, and this service measures email today. A
  cold-call channel declaring `recipientsOpened` would report 0 for ever, and a measured-looking zero is
  exactly the fabricated figure that is forbidden. Empty says the honest thing.
- **No new channel carries a free-text ICP input** — same rule as the audience-bandit note below: who a
  channel addresses is the audience entity, and a static "who we target" string would contradict it.

- **A RETIRED SLUG IS UNPUBLISHED, NEVER RENAMED OR DELETED — `features.superseded_by_slug` names its
  successor.** Live campaigns, live budgets and the cost ledger reference a retired slug, so its row,
  its stats and every authenticated per-brand / per-campaign read of it keep answering exactly as
  before. The ONE thing retirement changes is whether an anonymous caller can see it:
  `buildChannelCatalogue` skips any row whose `supersededBySlug` is non-null, and the per-pair
  economics is built from that catalogue, so an unlisted slug returns no pair (and 404s on
  `?channelSlug=`) by construction rather than by a second rule. `pr-expert-quote-opportunities` is
  the first one — the same offering on byte-identical terms is sold as `pr-expert-quote-outreach`, and
  publishing both rendered two identical channel pages, split one offering's measured evidence across
  two identities, and let a stranger book the dead spelling. **It is a general MARKER, not an
  exclusion list**: the next retirement states its own successor on its seed row and needs no code
  change here. Naming the successor rather than a bare boolean is what lets a consumer send a reader
  where the offering actually lives. Stated on EVERY seed row (`null` = current), so a missing answer
  can never read as a retirement nobody declared. Guards: the retirement cases in
  `src/lib/channel-catalogue.test.ts` (the marker, not the slug, is what excludes) and the
  `a RETIRED slug keeps working but is never published` suite in
  `src/seed/acquisition-channel-catalogue.test.ts` (published exactly once, the dead row keeps its
  terms, every successor is itself published and current). (Set 2026-08-19.)

### `GET /public/channels` + `GET /public/channel-funnel-economics` — NO AUTH, because the marketing site is generated from them

Both are public and identity-free by design: a site that restates the terms is a site that can drift
from what we actually charge and actually measured.

- **`/public/channels`** serves the catalogue: terms, `operatedBy`, the LEGS the channel performs (each
  side with buyer-facing wording, `from: null` for "from nothing"), the derived `producibleSteps`, and
  the derived funnels, each carrying its own funnel so a row renders without the consumer knowing the
  catalogue. The step vocabulary rides the payload under `steps` (renamed from `producibleSteps` when it
  widened past the entry subset; the gateway does not proxy `/public/*`, so it had no outside consumer)
  so nothing hardcodes it.
- **`/public/channel-funnel-economics`** serves ONE ROW PER PAIR — the grain the marketing site prints.
  A customer buys a PAIR, and the same funnel costs a very different amount through a phone channel than
  through paid search, so a brand-level or channel-level aggregate cannot answer it. `?channelSlug=`
  narrows; an unknown slug is a 404, never an empty pair list (which would read as "sells through
  nothing").
- **NOT ENOUGH DATA IS AN ANSWER AND IT NAMES THE MISSING INGREDIENT** — `measured: false` with
  `no_spend_recorded` / `no_entry_step_produced` / `no_economics_declared`, checked in that order so a
  fresh channel says the plain thing. The same rule runs one level down: a STEP whose rate nobody
  declared reads `costPerStepUsd: null` with its own `unpricedReason`, never 0. **"Meeting attended" is
  permanently unpriced** — brand-service folds the show-up rate into booked→paid
  (`meetingFunnelCloseRate`), so pricing it would assert a 100% show-up rate, the exact bug that
  composition exists to prevent.
- **A FUNNEL IS PRICED THROUGH ITS OWN CHANNEL**, via the same `projectOutcomeCosts` + channel mask every
  other cost surface uses, and `returnPerDollar` is the IDENTICAL definition `/funnel-ranking` ranks a
  brand's declared funnels on. So a public per-pair figure and a customer's own dashboard can never
  print two prices for one funnel. Evidence is the SAME cross-org per-brand dataset
  (`getFunnelBucketDatasetCached`) the other public cost surfaces read, so a channel nobody has run yet
  reaches "not enough data" by the data being absent, never by a special case.
- Both ride `LIFETIME_AGGREGATE_WINDOWS` through `servedPublicCached` (15 min fresh / 6 h stale,
  single-flighted), like every other cross-org surface. A malformed stored channel blob FAILS the whole
  read (`MalformedAcquisitionChannelError`) rather than half-publishing: a price list that silently
  degrades would publish terms nobody set.
- **The api-service gateway does NOT proxy these yet** — `/public/*` needs an EXPLICIT per-route proxy
  there (no wildcard), so a consumer outside the cluster needs that follow-up before it can read them.
- Vocabulary, owner-fixed: the terminal thing a customer buys is a **SALE**, each stage of a funnel is a
  **STEP**, the step a funnel is named after is its **MILESTONE**. "Outcome" is deprecated (it named a
  retired per-brand optimization goal) and nothing new here uses it.
- Guards: `src/lib/acquisition-channels.test.ts` (the join, and the entry-step mirror pinned against the
  funnel's own first step), `src/seed/acquisition-channel-catalogue.test.ts` (every named channel present,
  slugs unmoved, no availability flag, terms whole and self-consistent, `salesFunnels` derived, the
  cold-email family unwidened), `src/lib/channel-catalogue.test.ts` (fail-loud parsing) and
  `src/lib/channel-funnel-economics.test.ts` (the three unmeasured reasons, per-funnel pricing, the
  permanently-unpriced attended step, no false $0). (Set 2026-08-19.)


## A FREE-TEXT ICP INPUT CONTRADICTS THE AUDIENCE BANDIT — it is GONE from every bandit-fed channel, and KEPT on the two features where nothing else answers the question

Audiences are first-class: they are saved entities owned by human-service, a campaign points at them,
and a bandit picks ONE audience per run. A free-text "who we target" field typed once on the feature
form is therefore not merely REDUNDANT with the audience, it CONTRADICTS it — the run is addressing
the bandit-selected audience while the prompt carries a single static ICP describing different people.

- **Removed** from `sales-`, `feedback-request-`, `vc-`, `accelerators-` and `hiring-cold-email-outreach`
  (`targetAudience` / `targetInvestorProfile` / `targetAcceleratorProfile` / `targetProfile`). Removed
  means removed: no dead field left in place, no alias.
- **Kept, and it is not a duplicate of anything:** `ai-visibility-scoring`'s `audienceProfile` (that
  feature contacts NOBODY — the field frames the questions put to the LLMs from a realistic buyer's
  point of view, so there is no audience entity and no lead in play) and the whole
  `pr-cold-email-outreach` input set (its recipients come from journalists-service, a different
  mechanism with no audience entity to contradict).
- **Removing an input does NOT strip the key from brand extraction.** The extracted brand blob is
  assembled from field keys the workflow DAG asks brand-service for, independently of this catalogue,
  and of the 93 content-generation templates only three name a target-audience variable (one dead
  blind-discovery variant, two PR templates). So the blast radius is the customer-facing form and its
  prefill, not the generated emails.
- **No stored-value cleanup.** A campaign's stored `featureInputs` may still carry a removed key; it
  is simply never read again. Nothing 500s, nothing needs a migration.
- Guard: the `free-text ICP vs the audience bandit` suite in `src/seed/feature-sales-funnels.test.ts`
  (each bandit-fed slug exposes no ICP key and no "profile" label; the two keepers are pinned by
  exact key / exact input list). (Set 2026-08-19.)

## THE FEEDBACK REQUEST OFFERS A GIFT AND CHARGES IN FEEDBACK — the FORM of feedback is the PRICE TAG, and its eight inputs are the two halves of the offer plus the four levers

This channel does not pitch. It gives something away (free trial, product at cost, a service done for
them, early access) and asks for feedback in return, so Hormozi's value equation runs on BOTH sides at
once: the prospect pays in EFFORT rather than money.

```
(value of the GIFT) x (credibility they will actually get it)
-------------------------------------------------------------
(delay before they get it) x (effort of the FEEDBACK asked)
```

The inputs it shipped with were copied from the sales pitch and described neither half of that offer.
It now states exactly eight things and nothing else: `gift`, `giftValue`, `feedbackForm`,
`feedbackEffort`, `socialProof`, `scarcity`, `urgency`, `riskReversal`.

- **`feedbackForm` is the single most important field, because it IS the price.** A public video
  testimonial and a Google Maps rating are wildly different prices, so the email must ask for one
  specific thing: written testimonial (private or public), video testimonial (private or public), a
  call, or a review on a public platform (G2, Google Maps, Trustpilot, Capterra).
- **It is PLAIN TEXT whose placeholder enumerates the options, deliberately.** A multiple choice would
  fit it better, and the decision was taken NOT to introduce a new input type for this iteration. Do
  NOT add a select / multi-select / checkbox group. Guarded: the catalogue's whole input-type set is
  pinned to `text` + `textarea`.
- **`giftValue` anchors the gift to a real price AND covers what the relationship becomes afterwards**,
  which is why there is no separate follow-on-outcome field. Free is worth nothing without a number
  next to it.
- **`riskReversal` is the load-bearing lever here**, not an afterthought: a gift invites suspicion, and
  when the gift is a trial "no commitment, no credit card" is what answers it. `scarcity` is naturally
  strong for the same reason (giving the product away costs something, so tester seats are limited).
- **The four pitch questions are GONE** — `targetAudience` (the bandit owns it, see above),
  `problemToValidate` and `targetOutcome` and `valueForTarget` (redundant with the gift and its value).
- Guards: the eight-input list, the dead-key list, the plain-text-price case and the em-dash sweep (now
  covering descriptions, not only labels and placeholders) in `src/seed/feature-sales-funnels.test.ts`.
  (Set 2026-08-19.)

## A CHANNEL IS A FEATURE SLUG, and the catalogue states per feature WHICH SALES FUNNELS IT MAY BE SOLD THROUGH — `[]` and all four are two written statements, never an absence

distribute acquires through more than one channel, and a channel in this fleet's vocabulary IS a
feature slug. There is no channel table, no channel concept and none may be introduced: a second
cold-email offer is a second feature, measured by the machinery the first one already has.

`feedback-request-cold-email-outreach` is that second one. Same medium, same sending
infrastructure, same funnel in `FUNNEL_REGISTRY`, byte-identical outputs / charts / entities to
`sales-cold-email-outreach` — the only thing that differs is what the email ASKS FOR. It requests
feedback on the problem we solve instead of pitching, and the conversation it opens is what becomes
the sales meeting. GA (`implemented: true`, `status: "active"`), never gated behind alpha/beta.

**Every feature states `salesFunnels` — which sales funnels it may be SOLD THROUGH.** It is a product
statement about the feature, so this service owns it; the dashboard offers only valid (funnel, feature)
pairs from it and campaign-service refuses to provision a pair absent from it. Hardcoding the matrix in
each consumer was rejected (one product fact, four drifting copies — the way the staff-email allowlist
already drifts), and so was putting it in billing-service (a payments service does not hold a product
taxonomy). It rides `GET /features` + `GET /features/:slug` as a column on the row, so no consumer
needs a new call.

- **"SELLS THROUGH NONE" AND "SELLS THROUGH ALL" ARE DIFFERENT STATEMENTS, and BOTH are written out.**
  A consumer that could not tell them apart would offer nonsense pairs, so nothing is left unstated: a
  non-sales feature (PR, hiring, VC, accelerators, AI visibility, press kit, outlet discovery, expert
  quotes) states `[]`, and a sales feature sold through every declared funnel states all four keys
  explicitly. A SHORTER list is a real restriction, not a gap. The column is `NOT NULL DEFAULT '[]'`, so
  the only row the default can ever cover is one the seed has not reached — and it reads as the
  restrictive side, which is the recoverable mistake.
- **The feedback request states `sales_meetings_from_conversation` ALONE.** Its offer buys a
  CONVERSATION, and the other three funnels buy their first step with a website CLICK — it has no
  website step to sell. That single-funnel restriction is the whole reason the per-feature answer
  exists.
- **The keys are brand-service's, unchanged.** Nothing here invents a funnel; the values are
  `SALES_FUNNEL_KEYS` and a stored legacy spelling is a bug (guarded).
- **Being a `*-cold-email-outreach` slug is load-bearing**: `coldEmailOutreachSlugs` derives the fleet
  audits' account universe from that suffix, so the new channel enters send-forecast / accounts /
  customer-health with no further change.
- **The slug is `feedback-request-cold-email-outreach`, and the pre-rename
  `sales-feedback-request-cold-email-outreach` is GONE — no alias, no redirect.** It shipped under the
  longer name for about an hour, before any campaign or billing row could carry it, which is the only
  window in which this is a one-line change. Two names for one channel is exactly the second-vocabulary
  problem this feature line exists to avoid, so nothing accepts the old spelling. **The `sales-` prefix
  bought NOTHING** — every family/audit/registry keys on the `-cold-email-outreach` SUFFIX
  (`coldEmailOutreachSlugs`) or on the exact slug (`FUNNEL_REGISTRY`), never on the prefix; the
  membership is asserted rather than left to the name in the rename guard. The stale DB row needs no
  migration: `registerSeedFeatures` sweep-deletes every row whose slug is not in `SEED_FEATURES` on
  every cold start, so the old row is pruned by the first boot of this build (logged
  `Deleted stale feature: …`). (Set 2026-08-18.)
- **THE SEED PRUNES STALE ROWS BEFORE IT UPSERTS, and a SLUG RENAME is the reason — do not move the
  sweep back to the end of `registerSeedFeatures`.** A slug rename is a DELETE plus an INSERT, and
  while both rows exist they agree on every column but the slug — including `name`, which is UNIQUE
  in the schema. Upserting the new row first therefore trips `features_name_unique` (`23505`), and
  the seed runs on the BOOT path before `app.listen()`, so the process dies before it binds: the
  deploy health check fails and the box rolls the whole service back. Nothing about this is visible
  in the suite or the build — it needs a DB that already holds the OLD row, which only prod and
  staging do. Guard: `src/seed/register.test.ts` (the prune is the first write; every seed name is
  unique). Cost 2026-08-18 (#785): this rename's first prod deploy crash-looped on
  `Key (name)=(Sales Feedback Request Cold Email Outreach) already exists` and rolled back, so the
  rename shipped one build later than the merge.
- Guards: `src/seed/feature-sales-funnels.test.ts` (every feature answers, only catalogue keys, none/all
  distinguishable, the feedback funnel alone, the pitch's four unchanged, same funnel + same measurement
  as the pitch) + the new slug folded into the existing cold-email output/funnel-step suites in
  `seed/features.test.ts`. (Set 2026-08-18.)

## THE GOAL IS RETIRED — a brand has DECLARED SALES FUNNELS, and the objective is always maximise ROI

Nothing in this service reads a brand's `optimizationGoal` any more, and nothing may read one again.
Two reasons, and the second is why it could not wait: the goal could not say what it was for
(`sales_meetings_from_conversation` and `sales_meetings_from_website` both collapsed onto one
`meetingBooked`, so the two could not be priced apart), and it was **wrong at the source** —
brand-service's column is NOT NULL with a server default, so a brand that never chose a goal read back
as selling through website purchases. Nobody stated that; a default did. brand-service is dropping the
column, so a read left behind becomes a failure.

What a brand sells through is its **DECLARED SALES FUNNEL SET** (`GET /internal/brands/:brandId/sales-funnels`,
`sales-funnels-client.ts` → `brand-funnels.ts`). It is a real declaration with no default behind it:
either stated, or absent — and absent is a producer gap we surface, never fill.

- **`GET /features/:slug/funnel-ranking`** (was `/goal-arbitration`) — the name now says what it does. It
  arbitrates nothing and the objective is not a variable; it ranks the declared funnels by return per
  dollar. **`/goal-arbitration` stays mounted as a DEPRECATED ALIAS on the SAME handler**, byte-identical
  body, because campaign-service reads `arbitration` / `workflow` / `rows` off it in prod to pace the 4
  brands with a live campaign and no per-funnel budget row. Removing the alias is a SEPARATE change.
  Guard: the byte-identical-body case in `routes/funnel-ranking.test.ts`.
- **`?funnel=` is the canonical request parameter; `?goal=` is a DEPRECATION with a stated end.** On
  `/audience-stats` a funnel alone is now sufficient — the goal is DERIVED from it
  (`SALES_FUNNEL_GOAL_ECHO`) rather than demanded of the caller — and a named funnel WINS when both are
  sent. `/workflow-projection` already behaved this way. `/revenue` gained `?funnel=`, which prices the
  spend block's cost-per-outcome columns. Sending neither is a 400; an unrecognised funnel is a 400.
  Every pre-retirement funnel spelling stays accepted forever. **The dashboard sweep follows this PR and
  conforms to what is shipped here.**
- **The goal survives ONLY as an ECHO, derived FROM the funnel key, never the reverse.**
  `SALES_FUNNEL_GOAL_ECHO` (`sales-funnels.ts`) is lossy by construction (both meeting funnels echo
  `meetingBooked`) and must never be read as a row's identity. **Do NOT add the inverse map.** A
  goal→funnel table is exactly the compatibility layer this retirement exists to avoid, and it could not
  be written honestly anyway. The producer-payload resolvers (`matchBrandServiceGoal`,
  `matchBrandServiceWebsitePurchaseGoal`, `matchDeclaredCombinedSalesGoal`) are DELETED; their absence is
  asserted by `goals-entry-points.test.ts`, which is now a guard that the producer door stays shut.
- **`fetchBrandSavedEconomicsWithGoal` → `fetchBrandSavedEconomics`.** Same endpoint, same org-scoping
  rules (see the section below), no goal resolved. The payload may still carry the column while
  brand-service has it; passing it through is fine, BRANCHING on it is not.
- **`/revenue` spend cost parents** price on `?funnel=` when named, else the brand's **FIRST DECLARED
  funnel in catalogue order** — a deterministic pick over the brand's OWN declarations, not a default and
  not an inference. A funnel the brand never declared is ignored in favour of that pick. **No declared
  funnel ⇒ the columns stay OBSERVED (null at 0 outcomes)**, exactly as they did for a brand with no
  goal; a funnel is never substituted. Still fail-SOFT with a loud log (display enrichment on the
  Overview), and it still never degrades to the raw-spend floor.
- **`/internal/stats/customer-health`**: `optimizationGoal` is REPLACED by `salesFunnels` (the whole
  declared set) + `primarySalesFunnel` (the first, which the row's single-valued fields — conversion
  tracker, best audience, best workflow — are computed on). The tracker is needed for the funnels that
  convert on the CLIENT's own site (`website_purchases`, `form_magnet`); a meeting funnel qualifies on
  ours. An unreadable/empty declaration soft-degrades to `[]` and nulls the funnel-keyed fields — the row
  is still LISTED.
- **The cross-org cost buckets are keyed on DECLARED FUNNELS** (`OBJECTIVE_FUNNEL_BUCKET`,
  `funnelsInObjectiveBucket`, `fetchFunnelBucketDataset` — renamed from the goal-bucket trio). The
  objective vocabulary is UNCHANGED: it names the OUTCOME being priced, not a brand's goal, and the
  public/staff response contract is untouched. Only bucket MEMBERSHIP moved. CPC = every CLICK-bought
  funnel (the reply-bought meeting funnel stays excluded, same reasoning as #499); `signup` /
  `websitePurchase` = `website_purchases`; `formSubmission` = `form_magnet`; `meetingBooked` = BOTH
  meeting funnels; `sales` = every funnel (each terminates in a paying client); `positiveReply` stays
  FLEET-WIDE (raw measured, publicly claimed "across every brand"). **`whatsappConversation`'s bucket is
  EMPTY on purpose** — its outcome needs a WhatsApp link that no funnel expresses, so there is no honest
  way to identify those brands now; an empty bucket reads `null` ("could not compute"), which is the
  truth. Substituting "all brands" would print a fleet CPC under a WhatsApp label. A brand whose
  declaration is missing/unreadable is OMITTED from the dataset (loud log), the same treatment a brand
  with no goal used to get.
- **NO ranking was re-scored.** This is a vocabulary + contract change: `rankDeclaredFunnels` and the
  return-per-dollar basis are untouched. (Set 2026-08-12.)

## `GET /revenue?groupBy=workflow` — WHICH OF THE WORKFLOWS WE RAN FOR THIS BRAND MADE MONEY; a workflow is a DYNASTY, and BOTH legs are attributed by the producer that froze them

The same REALIZED-money answer `/revenue` already gives for a brand and for its campaigns, at the grain
of the workflow: one lean group per workflow the brand has run for the feature, carrying the four
figures the brand read carries — `headline.totalPipelineUsd`, `costEconomics.roiMultiple`,
`costOfAcquisitionPct`, `costPerAcquisitionUsd`. Nothing here is projected; the projected per-workflow
surface is `/workflow-projection`, and the two must not be conflated.

A consumer cannot roll this up from `?groupBy=campaignId`: prod brand `75d7e3e8…` runs ~20 campaigns
over ~15 workflows, several workflows carrying 2–4 campaigns, so the rollup would mean summing pipeline
and re-deriving the ratios in the browser — client-side money math that drifts from the brand Overview
the day either side changes.

- **A WORKFLOW IS A DYNASTY**, its identity across versions (`lib/workflow-revenue.ts`). Every other
  surface here means a dynasty by "a workflow" (workflow-projection's three grains, the Strategy pick,
  the cross-org per-workflow benchmark), and the consumer renders these figures BESIDE that
  dynasty-keyed benchmark — a version-grain answer would be a second, unjoinable vocabulary.
  `workflowSlugs` lists what was folded in, so nothing is hidden.
- **A slug workflow-service does not describe is its OWN dynasty of one** — never dropped, never folded
  on a guess. Do NOT reuse `buildWorkflowDynasties`/`aggregateAcrossDynasties` here: those are built from
  ACTIVE workflows and emit only funnels with runs, so a RETIRED lineage vanishes with its spend — and a
  retired workflow is exactly the one a "what burned money" question is asking about. workflow-service
  unreachable ⇒ every slug is its own dynasty (fail-SOFT, loud log): a poorer GROUPING of the same
  correct numbers, never a fabricated one.
- **NEVER attribute either leg from the campaign row's workflow.** campaign-service now SWITCHES the
  workflow of the campaign already alive on an identity instead of opening a new row, so its current
  workflow mis-attributes every lead and every dollar spent before the switch. Spend comes from
  runs-service `groupBy=workflowSlug` (`fetchRunsCostCentsByWorkflowSlug` — byte the same request
  `fetchRunsCostCents` already makes, kept SPLIT instead of summed, same rounding, so Σ slugs IS the
  brand's number to the cent); leads come from the `workflowSlug` lead-service froze on each
  `leads_campaigns` row at serve time, carried onto `EnginePerson` exactly as `campaignId` is.
- **ONE brand-wide lead read, ONE cost read, ONE overlay pair, then N pure engine passes** — the shape
  `/funnel-ranking` uses to rank N funnels off one fetch. Do NOT reuse the per-campaign machinery (one
  `computeFeatureRevenue` per group): that re-reads the brand's lead page once per workflow, under a
  384 MB heap.
- **A single-workflow brand reads identically at both grains, by construction** (same request, same
  engine, same brand-priced economics — a workflow states no funnel of its own). Across SEVERAL
  workflows the groups do NOT sum to the brand: a lead served under two workflows is ONE lead to the
  brand and belongs to both, and the engine's per-organisation combination is not additive across
  partitions. Same property the campaign grain already has — counting people, not an error to correct.
- **A lead the producer served under NO workflow is in NO group**, and unattributed spend is in no group
  either (loud log naming the cents). Parking either on a workflow would invent an attribution nobody
  recorded.
- **A workflow that spent and returned nothing reports `roiMultiple: 0`, not null** — that is a measured
  answer and the one the staff member is hunting. `costPerAcquisitionUsd` is null there (it won nobody);
  the pipeline is null only when there is no funnel wired / no economics at all.
- Two extractions came with it, both pure moves: `buildCostEconomics` + `CostEconomics` →
  `lib/cost-economics.ts` (so a lib can build them without importing a route; `routes/revenue.ts`
  re-exports both, so no existing importer changed) and the two per-lead overlay loops →
  `lib/signal-overlays.ts` (one copy, so the two grains cannot disagree about whether a lead opened).
- **Σ groups is the brand's spend to within sub-cent ROUNDING, not to the cent** — prod `75d7e3e8…`
  reads $2,142.35 across 24 workflows against the Overview's $2,142.32. runs-service returns fractional
  cents per group, and the Overview's spend rounds once per cost SOURCE (`fetchSpendBreakdown`) while
  this read rounds once per (workflowSlug × costName) group. Same ledger, different grouping. Do NOT
  "fix" it by re-basing the Overview's spend — that is the customer's number.
- **`outcomes` is the VOLUME half, and it rides the ONE COMMITTED basis.** The money block says what
  came back; `outcomes` says what it was made of — `recipientsContacted` / `recipientsClicked` /
  `recipientsRepliesPositive` (distinct leads), `committedSpentCents` (+ the transitional
  `actualSpentCents`), `cpcCents`, `cpprCents`. The same answers the un-grouped brand read gives for
  the whole brand, absent per workflow until now and underivable by a consumer (a group is a DYNASTY,
  so a browser would sum versions and re-divide — client-side money math). Every figure rides
  **COMMITTED** spend, the single basis `costEconomics` rides, so
  `cpcCents × recipientsClicked ≈ committedSpentCents` by construction and a workflow's ROI and its
  cost per click are two views of one number. This block once rode billed-only ON PURPOSE, to avoid a
  committed numerator inside a group whose ROI was realized; the ROI moved to committed
  (features-service#779), so that divergence would now BE the incoherence. The rates are **OBSERVED**
  (accounting) — a workflow with spend and
  no outcome of a kind reports **null**, never 0 and never a floored estimate; projection per workflow
  already has its own surface (`/workflow-projection`). Counts read off the SAME per-lead signals the
  brand's `recipients*` series read, after the engine's own `dedupPersonsByLead`, so a single-workflow
  brand reads its brand figure here by construction and a lead re-served under two VERSIONS counts
  once. Across several workflows they do NOT sum to the brand (a lead served under two workflows is
  one lead to the brand and belongs to both) — the counting-people property the money half carries.
  The volume half is funnel-INDEPENDENT: how many people a workflow reached is a measured fact, so it
  is answered even for a brand with no funnel wired, exactly the brand whose money half is null.
- **The un-grouped and per-campaign responses are byte-unchanged** — they are the customer dashboard's
  Overview and Campaigns table. Guard: `routes/workflow-revenue-grain.test.ts` drives all three from ONE
  fixture (dynasty folding, the burned-it group, the single-workflow equality with the brand read, the
  unattributed lead, the undescribed lineage, the workflow-service degrade, and the two untouched
  shapes). The api-service gateway already forwards `groupBy` on this read — no gateway change.
  (Set 2026-08-15.)

## A campaign's figures are its IDENTITY's figures — (org, brand, sales funnel, acquisition channel), read from campaign-service, never re-derived

campaign-service used to create a NEW campaign row every time workflow selection switched workflows,
so one real campaign arrives here split across many rows. Brand `f4d73dab…` showed **48 groups for
what is one campaign**, 27 of them at 0 pipeline / no ROI, beside the single row carrying six weeks
of history. Every figure keyed on a campaign is therefore reported for the campaign's whole
IDENTITY — campaign-service's own key (its `uniq_campaigns_org_brand_funnel_channel`, migration
0044), which the WORKFLOW is explicitly not part of.

- **Nothing is rewritten or repointed.** The stopped rows keep their runs and their costs in
  runs-service, keyed on their own campaign id. This service only decides which ids are TOTALLED
  together before anything is displayed.
- **All four parts come from campaign-service** (`GET /campaigns?brandId=&featureSlug=`,
  `src/lib/campaign-identity-client.ts` → `campaign-identity.ts`). **NEVER infer the funnel from the
  goal** — two funnels answer to `meetingBooked`, so that inference prints a funnel the campaign never
  stated. An UNSTATED funnel (`funnelKey: null`) is a REAL state: those pool together (the producer's
  own `coalesce(funnel_key,'')` rule) and never fold onto a campaign that DID state one.
- **A row that states no brand or no channel** (predating migration 0044) is its OWN family of one —
  campaign-service could not police it either, so pooling it would invent an identity nobody asserted.
- **Wired on `/revenue` (`?campaignId=` + `?groupBy=campaignId`) and `/stats` (both).** Every member
  id still answers, with the identity's total, and each carries `campaignIdentity`
  (`{key, funnelKey, acquisitionChannel, campaignIds, liveCampaignIds, representativeId}`) so the
  dashboard renders ONE line per identity on `representativeId` (the live campaign).
- **The scope is a `CampaignFilter`** (`campaign-scope.ts`): `undefined` / a string / a ONE-element
  list take every client's original path BYTE for byte, so a brand with one campaign per identity is
  unchanged. Only a genuine multi-member family aggregates, and it stays O(1) calls: runs co-groups
  `…,campaignId`, lead-service is read brand-wide and filtered on the row's `campaignId`,
  `/stats` folds its per-campaign maps by identity. email-gateway's `groupBy` is single-dimension, so
  the outreach day series alone fans out per member (capped 6).
- **A lead served under two members is ONE lead**, deduped by the engine's `dedupPersonsByLead`, and
  the family reads the BRAND-scoped delivery overlay — so a campaign's own total can never exceed the
  brand Overview's. Costs sum exactly (a cost row belongs to one campaign). Prod before: Σ
  per-campaign $218.36 pipeline / $1,122.43 spend vs the brand Overview's $217.84 / $1,122.41 — the
  $0.52 gap is exactly the leads the old per-row view counted twice.
- **PEOPLE ARE NOT ADDED — an identity's person-grain figures are COUNTED, on the brand's own basis.**
  Money and run counts are additive (a cost row belongs to exactly one campaign), so folding the
  members' rows is exact. PEOPLE are not: a person contacted under two members is ONE person, and
  email-gateway answers each campaign separately, so summing those answers counted them twice. That
  is how brand `75d7e3e8…` came to report **7,181 contacted / 15 positive replies** while its single
  46-member identity reported **9,695 / 16** — a campaign larger than the brand containing it. The
  error scales with how much history campaign-service consolidates onto an identity, so it was
  invisible while identities had one member. **`/stats` `groupBy=campaignId` (and the flattened
  `?campaignId=` read of a multi-member identity) now take every recipient count from
  `fetchEngagementSnapshotByIdentity`** (`engagement-snapshot.ts`): ONE brand-wide lead read, grouped
  by the identity each row's campaign belongs to, deduped WITHIN each identity. Both properties fall
  out by construction — a lead re-served under two members counts once, and an identity's distinct
  leads are a SUBSET of the brand's, for every signal. So the bound holds by definition, not by a
  correction applied afterwards. An identity whose members reached no lead reads **0** on this basis
  (not the email-gateway sum); a row stating no campaign belongs to no identity.
- **The snapshot now owns NINE keys, not six** — `recipientsBounced` / `RepliesNegative` /
  `RepliesNeutral` joined the original six, on BOTH the brand read and the per-identity read, because
  email-gateway's aggregate is a distinct count *at the grain it was asked for* and therefore
  over-counts the moment several campaigns are folded (prod: identity bounced 506 vs brand 495).
  Verified against prod before shipping: brand-grain lead-snapshot bounced is **495** — byte-equal to
  the number this replaced. **`recipientsRepliesAutoReply` is the ONE person-grain key that cannot
  join** (lead-service classifies a reply `positive|negative|neutral` and has no auto-reply class —
  verified on the deployed contract), so for a MULTI-MEMBER identity it is DROPPED → `null`, "we
  could not count this". A single-member identity is unaffected. Do NOT "fix" that null by summing
  it, and do NOT invent an auto-reply lead field — the producer owns that vocabulary.
- **`EnginePerson.campaignId`** is carried through `leads-client` purely so this grouping can happen
  BEFORE the dedup. The engine ignores it, and `dedupPersonsByLead` keeps the first row's value (a
  deduped person no longer belongs to one campaign).
- **The lead page is read ONCE per in-flight request — `sharedLeadPage` (`leads-client.ts`), and it
  is NOT a cache.** This process runs with **`--max-old-space-size=384`** (set in
  `/root/distribute/env/features-service.env`, not the Dockerfile) and a big brand's `/orgs/leads`
  page is the largest body it parses. Making the grouped read fetch leads gave the dashboard TWO
  surfaces wanting the SAME page at the same moment — the brand stat card and the campaign
  breakdown both revalidate in the background when a brand page opens — and two simultaneous parses
  of one page do not fit: prod `f4d73dab…` (7,683 leads) drove RSS to ~777 MB and the process was
  OOM-killed and restarted, reproducibly. Concurrent readers of the identical request now share one
  fetch + one parse and each maps its OWN persons (callers mutate signals, so the rows are shared
  read-only). The entry is dropped the moment the fetch settles, so no read is ever served a stale
  page and a failure fails every waiting reader loudly. **Do NOT turn this into a TTL cache** — the
  freshness rules live in the Gold snapshot layer, and a second cache under them would serve a
  number nobody can reason about. Guards: the four `one page, one parse` cases in
  `leads-client.test.ts`. If a brand ever outgrows a single 384 MB parse, the answer is the heap
  setting or a producer-side page, not a silently narrower read.
- **The cache key carries the IDENTITY, not the campaign**, so the dashboard's one call per rendered
  row lands on ONE cell instead of paying for N identical fan-outs.
- **Fail-SOFT with a loud log.** With campaign-service unreachable every campaign is its own family —
  the grouping degrades to what it was before this feature, and no number is ever fabricated.
- Guards: `src/lib/campaign-identity.test.ts` (the pooling rules, both meeting funnels apart, the
  unstated funnel distinguishable, an unplaceable row alone) + `src/lib/engagement-snapshot.test.ts`
  (several member campaigns having contacted the SAME person; no identity's figure exceeds the
  brand's, for every signal; ONE brand-wide read, never one per identity) +
  `src/routes/campaign-identity-aggregation.test.ts`
  (drives `/revenue` + `/stats` from ONE fixture: every member reports the whole campaign, a shared
  lead counts once, the brand and campaign views agree on contacted / sent / positive replies,
  one-campaign-per-identity is unchanged, campaign-service down degrades).
  (Set 2026-08-02; people-are-counted-not-added 2026-08-13, features-service#749.)

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

## `GET /features/:slug/funnel-ranking` (deprecated alias: `/goal-arbitration`) — RANKS every DECLARED sales funnel by RETURN PER DOLLAR. It is a RECOMMENDATION, not a selection, and an UNFUNDED funnel is still ranked

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
OWN funnel to the same terminal unit — a paying client's lifetime revenue — is what makes them commensurable.
Rankable funnels sort on `returnPerDollar` desc; ties break on the canonical funnel-catalogue order
(`salesFunnelIndex`), so the same evidence + the same economics always produce the same list.

- **Best workflow per funnel = `argmin resolved.costPerOutcomeUsd` over the BRAND-LEVEL rows**
  (`audienceId === null`) — byte-for-byte the ungated argmin `fetchBrandProjectedParents` and the Strategy
  page's `pickBestBrandRow` use, so this endpoint can never crown a different workflow than those surfaces
  for the same brand + goal. Ranking the workflow on the COST while ranking the funnel on the RETURN is not
  a mix-up: within one funnel `costPerPaidClient = costPerOutcome / (outcome→paid rate)` and that rate is a
  constant for it, so the two argmins are the SAME ordering — the cost keeps coherence with the live
  surfaces, and the return falls out of the winning row.
- **A funnel with no defined return is ranked LAST, never dropped.** A funnel whose own legs are
  undeclared or sit at 0 has no path to a paying client, so its return is undefined — not zero, and never
  "borrow another funnel's". Note a channel-scoped meeting funnel now lands here whenever ITS channel has
  no rate, which the blended score used to hide behind the other channel's contribution. It stays in
  `ranking` with `rankable: false` + `unrankableReason: "no_paid_client_path"`, carrying whatever IS known
  (its own outcome cost + best workflow). Same for `no_economics` / `no_workflow_evidence` (no history yet) / `no_return_defined` (a
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

**THE FUNNEL KEY IS THE PRICING KEY — a funnel carries no goal, and the goal could never have answered
this.** brand-service#434 retired the goal from every funnel read because it was the poorer word:
`sales_meetings_from_conversation` and `sales_meetings_from_website` both mapped onto one `meetingBooked`,
so this service charged a meeting won from a REPLY and one won on the WEBSITE the same blended
both-channel price, and a brand running the reply funnel was benchmarked against clicks it never buys.
`src/lib/sales-funnels.ts` mirrors the deployed catalogue (`sales_meetings_from_conversation`,
`sales_meetings_from_website`, `website_purchases`, `form_magnet`) and `funnelToProjectionInputs`
(`workflow-projection.ts`) maps each key to its compute inputs, incl. **`meetingChannel`** — the whole
difference between the two meeting funnels. Everything downstream MASKS the other channel's unit cost and
observed evidence away (`maskUnitCostsForChannel`), so the conversation funnel prices
`replyUsd / replyToMeetingPct` and the website one `clickUsd / visitToMeetingPct` against the identical
evidence, and they routinely crown DIFFERENT workflows. `goal` / `objective` survive as ECHOES derived
from the key; they are lossy by construction (both meeting funnels echo `meetingBooked`) and must never be
read as a row's identity — `funnelKey` is. Note `website_purchases` maps to the **signup** objective, not
the `websitePurchase` goal: its funnel is visit → signup → paid, and the purchase goal's rates are a
different funnel entirely.

**TRANSITION TOLERANCE, both directions.** On the way IN, `matchSalesFunnelKey` accepts the four
canonical keys AND the four pre-retirement spellings (`reply_meeting`, `visit_meeting`, `visit_signup`,
`visit_form`) forever, plus case/separator variance; a word naming NO funnel returns null and every caller
fails loud rather than guessing a funnel. On the way OUT, **a consumer that still sends `?goal=` gets a
byte-identical answer** — `goalToProjectionInputs` is untouched, `meetingChannel` defaults to null, and no
`funnelKey` appears on the body. Only `?funnel=` narrows. It is accepted on `/workflow-projection` and
`/audience-stats`, WINS over `goal` when both are sent, threads into the audience floor parent
(`fetchBrandProjectedParents`, so the two surfaces stay one number per funnel by construction — guarded in
`audience-cost-coherence.test.ts`), and rides the `audience-stats` scope key under its CANONICAL value so
`pricing=net` and gross can never collide and a legacy spelling does not fragment the cell.

**A `?funnel=` read prices on the funnel's OWN declared terms** — `declaredEconomicsForFunnel` +
`mergeFunnelEconomics` (`declared-funnels.ts`) apply the SAME merge the ranking does, on both
`/workflow-projection` and the `/audience-stats` floor parent, off the declared list those paths already
fetch (zero extra IO). Skipping it is a two-prices-for-one-thing bug, and prod caught it the day of the
first ship: `b97440f6…` declares `replyToMeetingPct: 100` on its conversation funnel, so the ranking read
**$73.74** per meeting while `?funnel=` — on the brand-wide ~31% — read **$237.87**. Guard: the
"`?funnel=` read prices on the funnel's OWN declared terms" case in `routes/goal-arbitration.test.ts`,
which drives both surfaces from one fixture and asserts they agree.

**A funnel the brand never DECLARED has no cost to serve** — both endpoints 404 with
`reason: "funnel_not_declared"` + `declaredFunnelKeys`, never a number. "We could not estimate this" and
"it costs zero" are different statements. The check fires ONLY on `?funnel=`, so no goal-keyed request
pays for it.

**The DECLARED SET is brand-service's to own** = the SALES FUNNELS a brand DECLARED it sells through,
read from **`GET /internal/brands/:brandId/sales-funnels`** (api-key + `x-org-id`, brandId in path — see
the org-scoping section below) via `src/lib/sales-funnels-client.ts` → mapped by
`src/lib/declared-funnels.ts`. **Never accepted from the caller** and **never inferred** — a brand's
single `optimizationGoal` is ONE goal, not a set, and brand-service is explicit that its brand-wide
economics row cannot stand in for a declaration (every rate on it is NOT NULL with a server default, so a
brand that configured nothing still reads back plausible-looking numbers and no absence signals
anything). Reading either as the set is a bug. An unrecognised funnel key fails loud
(`UnknownSalesFunnelError` → 502 `reason: "authorized_goal_unrecognised"`, the deployed spelling
campaign-service matches on) rather than being dropped from the ranking.

**The cross-org pooled goal BUCKETS are deliberately NOT funnel-keyed** (`cost-per-outcome-trend` /
`-lifetime` / `-distribution`): brand-service still serves `optimizationGoal` on its saved economics, that
axis is a fleet average rather than a per-brand price, and re-keying it needs a per-brand funnel read
across the whole fleet plus a mapping for the objectives that have no funnel at all (`positiveReply`,
`websiteVisit`, `sales`, `whatsapp`).

- **The LIST answers it alone — an EMPTY list is a PRODUCER GAP, not "I sell through nothing".** An org
  that has answered always keeps at least one funnel active (brand-service refuses to switch off the
  last), so "answered but sells through none" cannot occur. An empty list therefore joins every other
  read that cannot be ANSWERED (transport, non-OK, a brand-service predating the funnel model → 404) in
  throwing `SalesFunnelsUnavailableError` ⇒ **502 `reason: "authorized_goals_unavailable"`** naming what
  failed — never a substituted default set. The wire `reason` keeps that legacy spelling on purpose:
  campaign-service matches on it verbatim to tell "no ranking yet" from a genuine fault.
- **THE TWO MEETING FUNNELS are ranked SEPARATELY AND PRICED APART (supersedes #704–#711).**
  They used to collapse into one `meetingBooked` entry whose rates unioned
  and whose lifetime revenue took the LOWEST of the two, because a single-elected-goal answer had no
  place to put two funnels. The customer now funds them separately, so a merged row cannot answer "where
  should I move my budget?" for either. Nothing is lost: a rate a funnel does not state falls back to the
  brand's EFFECTIVE economics (never to zero, never to half a funnel), and each funnel is now priced on
  its OWN lifetime revenue — which is the whole point of per-funnel economics (a $200 self-serve plan and
  a $20k contract ranked on their own revenue, not one blend).
- **PER-FUNNEL economics** are merged OVER the brand's effective set for THAT funnel only. A rate the
  brand never declared arrives as `null` and is **DROPPED** — never coerced to 0, which would
  zero-collapse the funnel. Nothing declared ⇒ the brand's effective economics apply unchanged.
- **A SHARED FIELD NAME IS NOT A SHARED MEANING — the meeting funnel COMPOSES** (`meetingFunnelCloseRate`).
  Every funnel rate key lines up 1:1 with `SalesEconomics` EXCEPT `meetingToClosePct`. Our projection
  multiplies it by `visitToMeetingPct`/`replyToMeetingPct`, both of which produce a meeting **BOOKED**,
  so ours is BOOKED→paid. brand-service's funnels are `… → Meeting booked → Meeting attended → Paid
  client` with `legs[i]` between `steps[i]` and `steps[i+1]`, so ITS `meetingToClosePct` is
  **ATTENDED→paid** and `meetingBookedToAttendedPct` is the show-up rate in between. So the override is
  `booked→paid = attended% × close%`; the show-up rate never reaches `SalesEconomics` under its own name
  (there is no field for it), and a show-up rate with NO close rate contributes nothing (half a funnel is
  not a close rate). No show-up rate declared ⇒ the close rate stands alone — exactly the brand-wide
  semantics, whose economics row has no show-up column at all — never discarded.
  **Do NOT "simplify" this back to a name-match copy.** #707 did (reasoning that we model no show-up
  step, so importing it would rename a rate we never read) — but the effect of dropping it is asserting
  a **100% show-up rate**: a brand declaring 50% show-up and 40% attended→close scored 40% booked→paid
  instead of 20%, halving its cost per paid client and DOUBLING the return `meetingBooked` is ranked on.
  Guard: the `meetingFunnelCloseRate` cases in `declared-funnels.test.ts` + the route-level "not a free
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
`src/lib/declared-funnels.test.ts` (the catalogue, legacy-spelling tolerance, a goal is NOT a funnel, NO
merge, null rates dropped, meeting-funnel compose, entry shape carries neither a goal nor funding), `src/routes/goal-arbitration.test.ts` (drives BOTH endpoints from
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

**It takes the same `?funnel=` override the projection does** (last arg, canonical key) — priced on that
funnel's own channel, so the audience row and the projection row stay one number per funnel. Absent →
goal-keyed, byte-identical to before.

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
- **Version funnels collapse FIRST** via `buildWorkflowDynasties` + `aggregateAcrossDynasties` — the SAME rollup
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

## `/internal/stats/revenue` `netRevenueRetention` — the STANDARD aggregate NRR; the cohort is FIXED AT THE START of the period, and an unmeasurable period is `null`, never 0

`src/lib/nrr-compute.ts` serves NRR/NDR monthly + weekly beside the realized-revenue series.
`NRR(period) = (that period's revenue from the customers who had revenue in the PREVIOUS period) ÷
(those same customers' previous-period revenue) × 100`. Every benchmark source investors read (Stripe,
SaaS Capital, The SaaS CFO, a16z) states it that way, and a non-standard NRR is worse than none.

- **The cohort is fixed at the START of the period — a customer acquired DURING it is in NEITHER leg.**
  Including new logos turns NRR into a growth rate and inflates it; that is the usual way this ships wrong.
  Guard: the integration test where the realized July bucket is $580 (both orgs) while NRR reads 80%
  (the one-org cohort), not 580%.
- **Expansion / contraction / churn need no extra computation** — they ARE what the ratio measures. And it
  is the AGGREGATE method (all existing customers pooled); the per-acquisition-cohort curve is a different
  metric, do not substitute it.
- **`retentionPct: null` (with `cohortSize: 0`) = COULD NOT MEASURE; a measured 0 carries `cohortSize > 0`
  + `priorRevenueUsd > 0`.** "We could not measure this" and "the base shrank to nothing" are different
  statements a benchmark reader acts on differently. Never fabricate a value for an unmeasurable period and
  never carry the previous period forward across a gap.
- **Same NET realized cold-email revenue the series already sums** (the per-org day→cents maps
  `buildRevenueHistory` already holds) — one basis, so the two surfaces on the page reconcile, and it adds
  ZERO IO. Per-org resolution stays INTERNAL: only pooled cohort aggregates are on the wire.
- The OLDEST displayed period still forms a real cohort — `buildNrrSeries` enumerates `count + 1` buckets
  and uses the extra one as a denominator only, never emitting it.
- **No TTM NRR** — the first billed day is March 2026, so a trailing-twelve-month figure today would be
  assembled from months that do not exist.

Everything else on the payload (`totalRevenueUsd`, monthly/weekly/daily/sinceInceptionDaily, `committedMrr`,
`currentMrrUsd`) is byte-unchanged. Guards: `src/lib/nrr-compute.test.ts` (definition, new-logo exclusion,
churn-vs-unmeasurable, hand-recompute, weekly ISO grain) + the NRR case in `revenue-history-compute.test.ts`.
(Set 2026-08-02.)

## Staff admin metrics — DAILY BUDGET (+ its MRR/ARR projection) is the RAW configured value, NEVER discounted; realized-revenue stays NET (supersedes PR #592's discounted-budget)

The per-org usage discount is a modifier on CHARGES only (frozen gross+net per cost row in the runs/billing
ledger). The DAILY BUDGET is a **configuration ceiling, not a charge**, so the discount is NEVER applied to
it: two orgs with the same configured budget show the SAME daily budget regardless of their discounts.
PR #592 wrongly applied the discount to the budget display (an $8/day, 50%-discount org showed $4/day); that
is reverted — the net/gross budget split (`grossDailyBudgetUsd`, `stats.gross*`, `applyDiscount`,
`fetchOrgUsageDiscountPct`, the `usage-discount` fetch) is **DELETED** (a config budget has ONE true value,
no "net budget"; the admin only ever read `dailyBudgetUsd`, so the gross* twins had zero external consumers).

- **`/internal/stats/accounts` (`buildAccountsAudit`)** — both per-brand budgets
  (`configuredDailyBudgetUsd`, `runningDailyBudgetUsd`) are RAW, undiscounted figures. Fleet
  `stats.totalRunningDailyBudgetUsd`/`mrrUsd`/`arrUsd` are pure budget projections (Σ active **running**
  budget, × 30, × 365) → undiscounted too. The ACTIVE verdict + row sort gate on the running budget vs the
  actual balance (no separate gross field). `customer-health` reads both directly.
- **`/internal/stats/revenue`** — committed MRR/ARR (`currentMrrUsd`, `committedMrr.*`) are budget
  projections (Σ active **running** budget × 30) → **undiscounted** automatically (they read the
  accounts-audit `stats.mrrUsd`/`totalRunningDailyBudgetUsd`). **THE COMMITTED MRR/ARR SERIES BREAKS ON
  2026-08-27 AND THAT STEP DOWN IS NOT CHURN.** Every daily snapshot recorded before that day was written
  from the CONFIGURED budget — money posted on funnels with no ongoing campaign behind it — and a snapshot
  cannot be replayed, so the history is not restatable. Measured at the cutover: **$3,450 → $2,610** MRR,
  fleet daily budget **$138 configured → $87 running**. Anyone reading the curve, or writing copy about it,
  must state the basis change at that date rather than read a lost customer. **Realized-spend buckets STAY NET** (actual charges) — they read
  runs' **frozen-NET twin `netActualCostInUsdCents`** on `/v1/stats/public/costs/timeseries`
  (`selectBucketActualCents`, `revenue-history-client.ts`); those are real billed spend, so net is correct.
  The distinction: budget-derived = undiscounted (config projection), realized-charge = net (money we bill).

**Why in-place:** the admin renders the budget/`mrrUsd` figures verbatim (no discount math of its own), so
fixing the value at the source corrects the admin display with ZERO dashboard change (distribute.you
deploys to PROD straight off `main` — it has no staging buffer, so a dashboard-side fix could not be
smoke-tested before customers saw it).

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
| `/stats` `costPerRecipient*` (registry `type:"currency"`) | **observed** | DONE (PR3) — brand is the TOP grain here (no coarser grain fetched → no cascade), so observed (null on 0). Also killed a latent false-$0 (0 cost / >0 outcomes → was $0, now null). Its numerator is the registry's `totalCostInUsdCents` (COMMITTED) since features-service#779 — the observed/projected axis is orthogonal to the spend basis, and there is only one basis. |
| `/public/stats/cost-projection` | **projected** (already EV) | not yet routed through the module |
| `pipeline-activity` | n/a (no cost ratio) | It computes forecast **RATES** (`openPerOutreach`…) not costs; its local `ratio` returns `null` on 0-denom = correct for a displayed rate. Nothing to route. |
| `/revenue` `spend` — RAW (`total/actual/provisioned Cpc`, `cppr`) | **floored** (cascade brand/campaign → best-workflow benchmark, DISPLAY) | Was observed-only, which rendered as the brand's own total spend under a cost-per-outcome label. Now the AGGREGATE twin of the per-audience rows: `max(own committed spend, the goal-winning workflow's projected unit cost)`. Falls back to **observed** when the brand declares no goal, or when the projection read degrades (fail-soft). |
| `/revenue` `spend` — DERIVED/funnel (`cps`/`cpsm`/`cpfs`/`cpSale`) | **derived** (best-workflow projection, DISPLAY) | Same units rule as the per-audience funnel columns — a raw dollar total is never an answer to "cost per signup". `null` when the goal's projection does not resolve that column's rate (never the spend total), and **observed** on the no-goal / degraded paths. |

**Rate helpers are NOT part of the cost engine and legitimately differ by consumption — do NOT "homogenize" them.**
`pipeline-activity.ratio` returns **null** on 0-denom because its rates are DISPLAYED (0 contacted → unknown
rate, not 0%), while a rate that is MULTIPLIED into a product needs **0** on 0-denom or it poisons the
product with NaN. Same observed/projected-style polymorphism as cost: a multiplied rate needs a number, a
displayed rate needs null. Neither is buggy. (`platform-rates-client` was the multiplied case; it is
DELETED — the platform-global email rates existed only to funnel a delivery down to a close, and nothing
funnels down from a delivery any more. See the funnel-legs section.)

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

## Per-goal `costPerPaidClient` funnels through THAT goal's OWN funnel — coherent by construction (≥ the goal's outcome cost)

`workflow-projection`'s displayed **cost / paid client** (drives `roiMultiple` + `cacPct`) MUST funnel
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

- **brand-service PAYLOAD** (`salesEconomics.optimizationGoal` on `/internal/brands/:id/sales-economics`
  — the LAST goal-shaped read left, now that a declared funnel carries none) →
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
`src/lib/goals-entry-points.test.ts` drives both doors, pins all three cases, and pins that the
declared-funnel reader is no longer one of them. An unrecognised value still returns null and is excluded from every bucket —
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
`(rate/100) × LTR`. No multi-step composition, no orP — the OTHER channel does NOT fund it. A `0` rate is a
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

## AN ACTIVE WORKFLOW WITH NO HISTORY IS STILL REACHABLE — the EXPLORE ALLOWANCE, and it is what makes a channel's NEWEST workflow able to earn a first run

Every projection row rests on spend. A dynasty with no grain anywhere produced NO ROW, and a consumer
that picks a workflow by ranking rows cannot pick what it cannot see — so it never spent, which is the
one thing that would have given it a row. **It could not start because it had not started**, the same
sentence the section below writes for a whole channel.

**The guard below fires only when the ENTIRE channel has measured nothing, and that is not the case that
occurs.** Prod 2026-08-25: 75 cold-email workflows created 15-16 August inside
`sales-cold-email-outreach` — a channel with 18 workflows that DO have spend, so the whole-channel guard
never fired. Those 75 were active for eight days, logged **zero runs and zero emails**, while nine
already-spent, zero-outcome workflows (priced at their own small spend, hence cheapest) rotated on a live
customer's campaign. The MIXED channel is the case with no answer, and it is the one that costs money.

- **AN UNPROVEN DYNASTY IS OFFERED — its brand row plus one row per active audience** (both are needed:
  campaign-service picks the workflow from the rows and then reads the SAME rows filtered to that
  dynasty for its audience arms, so a brand-only row is chosen and then serveable to nobody).
- **THE NUMBER IS THE EXPLORE ALLOWANCE: the price of ONE OUTREACH in this channel**
  (`channelOutreachPriceUsd` = Σ measured spend ÷ Σ measured contacted — the BRAND's own measured
  evidence when it has any, else the fleet's), projected through the goal's funnel by `exploreResolved`.
  Read it for what it is: not a claim about how this workflow performs, but the smallest amount of real
  money that can buy it its FIRST evidence — the first rung of the same floor ladder every measured row
  stands on (`max(own spend, parent)`, and this workflow's own spend is still 0).
- **DO NOT price it at the channel's POOLED cost-per-outcome.** That figure is dominated by the
  workflows that already spent — prod brand `75d7e3e8…`: **$643/meeting against a $337 measured leader**
  — so an unproven workflow priced there is never picked and stays exactly as invisible as before. The
  pooled figure was tried on paper first; it is the obvious answer and it does nothing.
- **BOUNDED AND SELF-EXTINGUISHING, which is what keeps it from becoming the cheap-forever number.** It
  applies ONLY while the dynasty has no grain at all. One run gives it real spend, it leaves this path
  for good, and from then on its OWN floor prices it, rising as it spends — the documented explore /
  exploit mechanism, unchanged. A workflow can consume the allowance once.
- **IT STATES A COST FLOOR AND NOTHING ELSE** — `costPerPaidClientUsd`, `roiMultiple` and `cacPct` stay
  NULL, `grain` stays null, `estimatesByGrain` is `{}`. A return needs evidence that the workflow
  converts; a return computed off an exploration floor would print the biggest number on the page.
- **REACHABLE, NEVER RECOMMENDED, NEVER DISPLAYED AS A RESULT.** `recommendedWorkflowDynastySlug` /
  `recommendedBudgetUsd` skip unmeasured rows, and every DISPLAY / benchmark surface ranks
  `row.measured` only: `funnel-ranking`'s best-workflow argmin, the customer-health board's best
  workflow, and (out of repo) the dashboard's Strategy pick. `fetchBrandProjectedParents` builds its own
  brand rows and never sees these at all. **Anything new that argmins these rows must filter on
  `measured` — the flag exists so nobody has to probe for nulls.**
- **ONLY ACTIVE DYNASTIES ARE ENUMERATED**, so a deprecated / retired workflow stays unreachable, and a
  brand with no active audience enumerates nothing (that is the `no_active_audiences` brand fact).
- **EVERY MEASURED ROW IS BYTE-UNCHANGED**, and `measured` / `unmeasuredReason` on the RESPONSE are read
  off the measured rows only — an allowance row is not a measurement and must not let a history-less
  channel claim it has one. A channel with no measured evidence has no outreach price either, so its
  rows carry the all-null block: the section below's answer, byte for byte.
- **Expect the fleet to explore.** While unproven workflows exist, a cost-ranking consumer picks one per
  tick; it then has spend and rotates out. That is the intended behaviour — the complaint being fixed is
  that 75 of them sat idle — and the per-workflow exploration is bounded by the same cascade floor that
  already governs a barely-tried workflow.
- Guards: `src/routes/workflow-projection-explore-allowance.test.ts` (ONE prod-shaped fixture — the real
  spend / contacted / positive-reply aggregates of the measured leader, the zero-outcome husk and the
  channel's heavy spender, beside two active unproven dynasties and one deprecated one: the enumeration,
  the allowance's value and floor-only shape, campaign-service's own `selectWorkflowGreedy` replayed to
  prove reachability, the measured rows byte-identical with and without the unproven ones, and the
  deprecated one unreachable) + the mixed case in `workflow-projection-history-less.test.ts`.
  (Set 2026-08-25.)

## A CHANNEL WITH NO HISTORY STILL ANSWERS WHO IT COULD BE SERVED TO — `workflow-projection` enumerates the BRAND's active audiences, stated UNMEASURED, and `measured` / `unmeasuredReason` keep "no audiences" apart from "no measurements"

A brand sells through several acquisition channels at once, each a feature slug, each running its own
campaign against the SAME brand's audiences. campaign-service asks THIS service which audiences a
campaign could be served right now — per feature, because this service owns the audience set.

Every row of the ladder below rests on spend: a (audience × dynasty) couple with no grain has nothing
to project and is skipped. The day a customer funds a SECOND channel that skips EVERYTHING, and the
empty `rows` read downstream as "this brand has no serveable audience" — so the campaign served nobody,
so it accumulated no history, so it kept answering with nothing. **It could not start because it had
not started.** Prod 2026-08-19, brand `75d7e3e8…`: `sales-cold-email-outreach` answered 273 rows while
`feedback-request-cold-email-outreach` answered 0 for the same brand, same funnel, same pricing, with
twelve active workflows and the same active audiences behind both. The difference was history, not
audiences.

- **AUDIENCE MEMBERSHIP IS A PROPERTY OF THE BRAND**, not of what one channel has already spent. So a
  channel that has measured nothing answers with the brand's active audiences under its OWN active
  workflows: one row per (active audience × active dynasty), plus the brand-level row per dynasty.
- **NOTHING IS INVENTED.** An unmeasured row carries `measured: false`, an EMPTY `estimatesByGrain`, and
  a `resolved` whose every figure is `null` — `grain` included. No cost, no return, no rank, and nothing
  borrowed from the channel that does have a history. `costPerClickUsd` and `grain` became NULLABLE for
  exactly this; `0` would say a click is free and a borrowed grain label would say whose result it is.
  `recommendedWorkflowDynastySlug` stays null (an unmeasured row can never be recommended).
- **IT FIRES ONLY WHEN NO MEASURED ROW SURVIVED**, which IS the first-day case — and that is what keeps
  an established channel byte-unchanged. A channel with ANY spend already enumerates every active
  audience under every dynasty it has evidence for (prod: 12 audiences × 21 measured dynasties + 21
  brand rows = the 273), so it never reaches this path. Do NOT "generalise" it to emit an unmeasured row
  for every zero-spend dynasty of a channel that does have history: that brand has 93 active dynasties
  against 21 with evidence, so the same request would answer 1,209 rows and a consumer ranking them
  would start seeing history-less workflows mixed into a measured set.
- **`measured` + `unmeasuredReason` ON THE RESPONSE** are what stop an empty `rows` reading as "this
  brand has nobody to contact": `no_active_audiences` (a brand fact, true through EVERY channel),
  `no_active_workflows` (this feature ships none), `no_spend_recorded` (audiences AND workflows exist,
  the channel has simply never run — the enumerated case above). A caller acts very differently on each.
  `measured` also rides each ROW, so a ranking consumer tells them apart outright instead of by a null
  probe.
- **No feature slug is special-cased** — the rule is stated on evidence, so the third funded channel
  works the day it is funded, with no change here.
- **campaign-service needs NO change**: `selectWorkflowGreedy` already skips a null `costPerOutcomeUsd`,
  `toArm` reads a missing audience grain as a COLD arm, and `serveableAudienceIdsInProjection` collects
  `audienceId`s — which is the whole deadlock. Two ships already went out below this one and both stand:
  campaign-service no longer reads an empty answer as an exhausted audience, and lead-service states WHY
  a serve came back empty.
- Guard: `src/routes/workflow-projection-history-less.test.ts` drives all four cases from ONE mock
  harness — the enumeration + its all-null rows, the two distinguishable empty answers, and the
  established channel (fleet spend on ONE of two dynasties) whose row set and count are unchanged with
  the zero-evidence dynasty still absent. (Set 2026-08-20.)

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
- crossOrg + brand grains reuse `fetchPublicCosts` (version-grain) + `aggregateAcrossDynasties` local
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

## ONE SPEND BASIS, AND IT IS COMMITTED — every money figure derived from run spend divides by `total…` (actual + provisioned). `actual…` is REPORTED, never divided by (supersedes the ROI-stays-ACTUAL rule of #396/#403)

runs-service `/v1/stats/costs` returns BOTH `totalCostInUsdCents` (committed = actual + **provisioned
holds**) and `actualCostInUsdCents` (only `actual` is billable spend) per group. The service-wide naming
convention (a field name must never lie about its accounting):

- **`total…`** = COMMITTED = ACTUAL + PROVISIONED (money already reserved, incl. open holds for
  scheduled follow-up sends). The customer-facing "Total spent" / "Budget spent today" / "CPC". It
  legitimately **DIPS** when a hold releases (a follow-up actualizes → net-zero; a cancelled hold → drop).
- **`actual…`** = actualized / billed spend only. **REPORTED ONLY — nothing divides by it.**
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

**ROI/CAC + `costEconomics` RIDE COMMITTED SPEND, and so does everything else here. A SPLIT BASIS IS A
BUG, NOT A TRADEOFF (supersedes #396/#403's "ROI rides ACTUAL").** #403 deliberately put the `spend`
block on committed and left ROI on billed-only, reasoning that reserved-but-unbilled holds would
understate ROI. The consequence was that ONE payload answered "how much did this cost" TWO ways at
once — every cost-per-outcome column divided by committed while ROI, %CAC, $CAC, cost per conversion
and the ROI-history spend leg divided by billed. Prod, 2026-08-18, brand `6e21bb6c…` / org
`org_3G8ARUvJgV2CC97ulggyBXcoGwV` / `sales-cold-email-outreach`: the brand Overview read **"Total spent
$202"** while its campaigns table read **"$ Invested $191"** with ROI 7.2x and %CAC 14% computed off the
smaller figure — and that brand runs exactly ONE campaign, so the two figures describe the identical
scope and cannot legitimately differ. Owner ruling (Kevin): *"all stats must be homogenously on committed
values. Dont split, it would be too complicated."* / *"BTW all stats must be on commited, it is a bug if
it not!!!"*

- **`fetchRunsCostCents` returns BOTH** (`{committedCents, actualCents}`, one read, one runs group —
  zero extra IO). `buildCostEconomics` takes an OBJECT, not positional cents, precisely so a transposed
  `(actual, committed)` pair cannot compile and silently reinstate the split.
- **`costEconomics.committedCostUsd` is the basis and the field a consumer renders as "$ Invested".**
  `actualCostUsd` STAYS on the response and stays honestly BILLED-ONLY: a field whose name asserts
  "actual" must never start carrying a committed value, and a consumer reading the old field needs a
  gap-free path onto the new one. Same shape for the transitional twins added beside it:
  `outcomes.committedSpentCents` beside `actualSpentCents` (per-workflow) and
  `currentEconomics.committedSpendUsd` beside `realizedSpendUsd` (customer-health). **Drop the old names
  only once the dashboard + staff console have migrated — not in the same ship.**
- **It holds at EVERY grain**, because a grain left behind reproduces the bug one click away: the
  un-lensed brand read, `?lens=`, `?groupBy=campaignId`, `?groupBy=workflow`, and the cross-org public
  revenue. The per-workflow `outcomes` block moved too — it rode billed-only ON PURPOSE, to avoid a
  committed numerator beside a realized ROI; the ROI moved, so that divergence would now BE the
  incoherence.
- **`roiHistory`'s spend leg is dated COMMITTED spend** (`fetchBrandCommittedSpendByDay` reads
  `totalCostInUsdCents` / frozen `netTotalCostInUsdCents`), so the curve's last cumulative point IS the
  headline `roiMultiple` instead of charting a different currency under the ROI card.
- **NET is unchanged and still fail-loud**: a net request divides by the frozen `netTotalCostInUsdCents`,
  never falling back to gross, never to the net billed twin.
- **Expected numeric shift, intended:** every ROI moves DOWN and every CAC moves UP by the open-holds
  share. That prod brand: 7.2x → ~6.8x, 14% → ~15%, invested 191 → 202.
- **NO consumer-side reconciliation, NO basis query parameter, NO silent fallback.** A figure that cannot
  be computed is `null` ("we could not measure this"), never 0.
- **The one thing that legitimately stays billed-only is `/internal/stats/revenue`'s realized-revenue
  series** — that is OUR income (what we actually billed orgs), not a customer's acquisition spend. An
  open hold is money reserved to spend, not revenue we earned. Budget-derived MRR/ARR stay undiscounted
  config projections as documented in the staff-metrics section.
- `/stats` `systemStats` carries BOTH raw keys, and **every `costPer*Cents` derived numerator now points
  at `totalCostInUsdCents`** (incl. `costPerOutletCents`) so `/stats` and `/revenue` price one brand one
  way. Do NOT repoint them back at `actualCostInUsdCents`.
- Guard: `src/routes/committed-spend-basis.test.ts` drives brand / campaign / workflow / lens / ROI-curve
  / net from ONE fixture where committed ($202) and billed ($191) DIFFER — a fixture where they coincide
  cannot fail this way, which is why the pre-existing suites stayed green through the bug.
- `workflow-projection` `roiMultiple = LTR / resolved.costPerOutcomeUsd` (budget-independent,
  = 100/cacPct; the `resolved` pick is the finest-grain cost-per-outcome from the 3-grain ladder) —
  the dashboard renders it instead of inverting `cacPct` client-side.

Null-safe convention (mirrors per-audience `metrics.cpcCents`): a ratio is **null** (renders "-"), never
a false **$0.00**, when its denominator OR the attributed spend is 0. Do NOT add a smoothing/floor to
force a CPC number. The per-audience `/audience-stats metrics.*Cents` (and `pipeline-activity` cpc) still
key on `totalCostInUsdCents` (committed) and are INTENTIONALLY left untouched (provisioned component
negligible at that grain; **campaign-service consumes `metrics.cpcCents` byte-equal** via
`features-audience-client.ts`, so renaming there would break it — out of scope). (Set 2026-06-26;
committed-spend on `/revenue` + total/actual/provisioned naming 2026-06-27, PR #403; single COMMITTED
basis service-wide 2026-08-18, features-service#779.)

## `GET /internal/stats/send-forecast` — GLOBAL fleet email send forecast (api-key, staff-gated at api-service), 3 email-grain series stacked

Cross-org, fleet-wide projection of how many outreach emails will be SENT per calendar day over a
past+future window (`?days=N`, default 14 future + fixed 7-day past tail). Answers Kevin's question
"combien d'emails seront envoyés sur les N profunnels jours, sachant les brands actives + leur budget".
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
duplicate).** A (org, brand) enters `totalNewPerDay` iff
`accountStatus(configured, running, actualBalance, autoTopup) === "active"` — i.e. **RUNNING budget > 0**
AND the org can fund it (auto-topup, or actual credit above a day of it). This is THE fix for the forecast
OVER-count: before the gate, every brand that ever ran cold-email and still had a stale positive budget was
summed in — incl. churned orgs with $0 credits — inflating the projection ~6× above the observed send rate.
**`R_b` is built from the RUNNING budget too, not the configured one** — a ceiling with no ongoing campaign
behind it launches no sequences, so counting it forecasts mail nobody will send. Org balance is fetched
ONCE per org (shared across its brands); both budgets come from the one batched
campaign-service `POST /brands/spendable-budget` call the audit makes. Same status rule + same account
universe as `/internal/stats/accounts`.

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

Each row: `{ orgId, orgExternalId, ownerEmail, brandId, brandName, brandDomain,
configuredDailyBudgetUsd, runningDailyBudgetUsd, orgBalanceUsd, orgActualBalanceUsd, autoTopupEnabled,
status }`. Response also carries `stats { totalRunningDailyBudgetUsd, totalConfiguredDailyBudgetUsd,
mrrUsd, arrUsd, activeCount, pausedCount, inactiveCount, totalCount }` + `asOf`.

**AN ACCOUNT IS ACTIVE WHEN ITS MONEY IS RUNNING, NOT MERELY CONFIGURED — and the brand PAUSE FLAG is
GONE from the rule, not kept as an override (supersedes the pause-first precedence of #427/#502).**
Single source `accountStatus(configuredDailyBudgetUsd, runningDailyBudgetUsd, actualBalanceUsd,
autoTopupEnabled)`, precedence **active > paused > inactive**: (1) `runningDailyBudgetUsd > 0 &&
(autoTopupEnabled || orgActualBalanceUsd > runningDailyBudgetUsd)` → `"active"`; (2) else
`configuredDailyBudgetUsd > 0` → `"paused"` (money POSTED with nothing running against it — the honest
reading of a customer who set a ceiling and stopped, or never created, the campaign behind it); (3) else
`"inactive"`.
- **The pause flag LIED IN BOTH DIRECTIONS and is no longer written by any product surface.** That
  customer control was removed; the campaign-service brand-pause table holds 8 rows, none written since
  early August. Prod 2026-08-27: `a179bbd9` was flagged paused since 21 July while spending **$55.69 in
  the prior 7 days** behind an ongoing campaign — so its money was excluded from MRR — while two brands
  with a funded funnel and **no campaign at all** counted as active. Do NOT re-add it "just in case":
  a stale flag that contradicts the running money is worse than no flag, and the running figure already
  answers the question the flag was standing in for. `fetchBrandPause` is deleted, not disabled.
- **The credit test is still the ACTUAL balance** (credited − ACTUALIZED usage), **never the spendable**
  figure — a provisioned hold is in-flight ACTIVE spend, so subtracting it wrongly read the busiest
  accounts "inactive" (features-service#502, unchanged). It gates on the RUNNING budget now, because
  that is what a day of spending actually costs the org. An **auto-topup** org never runs dry → active
  regardless of the momentary balance (`has_auto_topup` OPTIONAL, absent ⇒ not-enabled).
- **All rows (active + paused + inactive) are LISTED — never dropped.** `stats.totalRunningDailyBudgetUsd`
  and MRR(×30)/ARR(×365) sum **RUNNING** budget over ACTIVE rows only; `totalConfiguredDailyBudgetUsd`
  rides alongside so a reader sees what those same customers POSTED and can never mistake one for the
  other. send-forecast's série-3 gate reuses `accountStatus` and counts only `"active"`, so it projects
  from the running budget too — a ceiling nobody spends against launches no sequences.
- **Expect the fleet numbers to STEP DOWN on the day this deploys, and it is not churn.** Prod
  2026-08-27, before → after: MRR **$3,450 → $2,610**, fleet daily budget **$138 configured → $87
  running**, activeCount → **4**, which is exactly the number of brands that billed cold-email spend in
  the prior 7 days. The committed MRR/ARR daily snapshots already recorded were written with the
  inflated figure and **cannot be replayed** — see the staff-metrics section, which states the same
  break beside the series it describes.
- Guards: `src/lib/accounts-compute.test.ts` (the rule at each branch, the three production shapes, the
  running-vs-configured split in `stats`) + `src/lib/accounts-client.test.ts` (pair keying, batching at
  the producer's cap, and the unavailable-pair THROW). (Set 2026-08-27, features-service#837.)

**Account universe = the SAME source send-forecast uses** — lead-service `/internal/feature-memberships`
over the cold-email slugs (`coldEmailOutreachSlugs`), deduped to distinct (org, brand). Org-level reads
(balance + Clerk id + owner email) run ONCE per org; both budgets come back for EVERY pair in ONE
batched call; brand name/domain is one batched brand-service call. Fail loud on any read error.

- **configuredDailyBudgetUsd / runningDailyBudgetUsd** = campaign-service **`POST
  /brands/spendable-budget`** (api-key, `{ brands: [{orgId, brandId}] }`, producer cap **500 pairs**
  per request — `fetchSpendableBudgets`, `accounts-client.ts`). **Do NOT read billing's brand daily
  budget here any more**: billing keys a ceiling on (funnel × channel × offer) and stores NO campaign
  status, so its total is status-BLIND and counts money sitting on funnels whose campaign is stopped or
  was never created. campaign-service owns the join of campaign status to per-funnel ceiling, so it is
  the only service that can answer "running", and it returns BOTH figures plus `campaigns[]`/`rows[]`
  decompositions — **never sum those; the producer already totalled them.** A ceiling written before the
  offer level (`offerId: null`) still counts as RUNNING when a campaign on its funnel and channel is
  ongoing. **A pair listed in the response's `unavailable[]` THROWS** — reading it as zero would
  silently shrink a fleet total, which is the same reason the producer refuses to send a zero. The
  BULK route exists precisely so a fleet audit does not fan out one request per brand.

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
- **orgExternalId** (Clerk `org_...`) = client-service `GET /internal/orgs/:orgId` (NEW producer read,
  client-service). **ownerEmail** = client-service `GET /internal/users?orgId=` → earliest-created
  user's email (owner proxy; no staff flag exposed, so earliest-createdAt is the heuristic). A
  feature-membership org can have NO client-service row (resolved directly in lead/billing, or staging
  drift) → **client-service 404 → null identity, row STILL listed** (both fields nullable; same
  documented-not-found→null pattern as balance 404→0 — do NOT fail-loud it, that 500s the whole audit).
- **brandName/brandDomain** = brand-service `GET /internal/brands?ids=` (batch, ≤100/req; missing ids
  omitted → null name/domain, still listed).

Rows sort active-first, then RUNNING budget desc, then CONFIGURED budget desc (a paused row runs
nothing, so its posted money is what ranks it), tiebreak brandId. **Depends on the NEW
client-service `GET /internal/orgs/:orgId` + the SHARED `CLIENT_SERVICE_URL`/`CLIENT_SERVICE_API_KEY`
in features-service's env file on the deploy host (`/root/distribute/env/features-service.env`), for
both prod and staging.** Additive/dormant (no dashboard consumer yet). Reuses
existing env vars otherwise (BILLING / LEAD / BRAND).

**VERIFY ON PROD, NOT STAGING — the balance path is prod-only.** `orgBalanceUsd` reads billing
`/v1/accounts/balance`, whose `computeBalance` calls **stripe-service, which has NO staging runtime**
(prod-only). So on staging billing 502s "Failed to compose account funds" fleet-wide → this endpoint
correctly fails loud → 500 on staging. That is NOT a features-service defect; it's the documented
prod-only-dependency gotcha — a sibling with no staging runtime makes every staging read of the path
that composes it fail, so verify this endpoint against PROD. Verified on prod v0.72.0. (Set 2026-07-01.)

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
audience `pctUsed ≥ 80`. The badge + its INPUTS are both returned (`health.inputs`). **`hasBudget` reads
the RUNNING budget** (`account.runningDailyBudgetUsd > 0`), the same rule `accountStatus` applies — a
customer whose posted ceiling stands behind no ongoing campaign is not a green account. The row states
BOTH budgets so a CSM can see the gap between what was posted and what is live.

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
re-introduce a `POSTHOG_*_API_KEY` env var on this service).** The fleet's single secret source is
key-service platform providers — the admin app (`distribute.you apps/admin/src/instrumentation.ts`)
registers each `{provider, envVar}` from its OWN env into key-service at startup.
`src/lib/key-service-client.ts` `getPlatformKey` (mirrors ahref-service) fetches the decrypted key via
`GET {KEY_SERVICE_URL}/keys/platform/posthog/decrypt` (`x-api-key` + `X-Caller-*`), so the secret lives in
ONE place and flows admin env → key-service → features-service.
`POSTHOG_API_HOST` (`https://eu.posthog.com`) + `POSTHOG_PROJECT_ID` (`171095`) are NON-secret and DEFAULT in
code (env-overridable) — the only runtime dep is the standard fleet `KEY_SERVICE_URL`/`KEY_SERVICE_API_KEY`.
**Self-activates** once the `posthog` provider is registered in key-service; until then `getPlatformKey`
404s → null fleet-wide (dormant-safe). NO features-service env secret needed. The api-service proxy
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

**Prod (2026-07-29, brand `b97440f6…`):** a $15/day budget returned `expected.outreach` 107.717/day =
$0.1393 implied per send against a real $14.67/36 = **$0.41**; at the user's $1/day that printed **7**
sends/day for a reality of ~2-3. (Set 2026-07-30.)

## `pipeline-activity` never answers an un-servable `timezone` with an opaque failure — it 400s NAMING the parameter, and it returns 500 (not 502) because the edge eats a 502's body

A timezone this service accepts as valid must be one the whole funnel can serve, and when it is not, the
caller has to be TOLD WHICH INPUT — not handed a gateway-shaped error that reads as an outage.

- **The funnel refuses a family of legacy IANA aliases.** `pipeline-activity` forwards the caller's
  `timezone` verbatim to email-gateway `/orgs/stats?groupBy=day` → instantly-service, and instantly 500s
  for `Asia/Saigon` / `Asia/Calcutta` / `Europe/Kiev` / `America/Buenos_Aires` / `Asia/Rangoon` /
  `US/Pacific` / `Japan` (and ~15 more) while answering for the MODERN spelling of the identical zone.
  The dashboard sends whatever the browser's `Intl.DateTimeFormat().resolvedOptions().timeZone` says, so
  whole countries had a permanently empty Overview chart while everyone else saw nothing wrong. The bug is
  instantly-service's (features-service#741); this service's job is to stop laundering it into a mystery.
- **Attribution, never a fallback.** On a non-OK day-bucket read `fetchDailyBroadcastActivity` re-runs the
  SAME request with `UTC` — the one spelling always servable. UTC answers ⇒ the fault is this timezone ⇒
  `TimezoneNotServableError` ⇒ **400** carrying `parameter: "timezone"`. UTC fails too ⇒ the funnel is
  genuinely down ⇒ the original error stands. The probe's buckets are DISCARDED: day boundaries are the
  entire point of the parameter, so serving UTC days under an `Asia/Saigon` request would be silently
  wrong data, which is worse than a loud refusal. The probe runs on the ERROR path only — a healthy
  request pays nothing.
- **DO NOT "fix" this by canonicalising the timezone before forwarding.** `resolvedOptions().timeZone`
  canonicalises in whichever direction the RUNTIME's ICU happens to encode, and it is not stable across
  versions: on Node 20.19 `Asia/Ho_Chi_Minh` canonicalises **to** `Asia/Saigon` — i.e. exactly onto the
  spelling that 500s. A canonicalising shim is therefore a coin-flip that can break every zone that works
  today, and it papers over another service's bug instead of fixing it.
- **500, not 502, and always with a body.** Cloudflare fronts this service and REPLACES an origin 502's
  body with its own bare `error code: 502` (16 bytes, text/plain) — so every diagnostic we wrote was
  destroyed in transit, which is why this took a day to place instead of five minutes. Measured against
  prod: instantly-service's **500** body reaches the caller intact through the same edge; our 502 body did
  not. The generic catch now returns 500 with `detail` + the `query` it was computed with. Fail-loud is
  unchanged — only the status and the body are.
- Guards (`pipeline-activity.test.ts`): both spellings of one zone driven from ONE fixture must produce
  identical `days` + `summary`; a funnel that refuses only the alias yields a 400 naming `timezone` and NO
  days; a funnel down for every timezone yields a 500 with a body and NO `parameter` (an outage is not the
  caller's fault).
- **Verifying a deploy of this service: `GET /openapi.json` is generated at RUNTIME from
  `src/lib/openapi.ts` (`res.json(openApiDocument)`), so grepping the SERVED document for a string only
  the new build contains is an exact "is my code live" discriminator** — it asks the RUNNING process what
  code it is executing, independent of the value under test and of whatever the deploy platform claims.
  Prefer it to any platform status/CLI read: this was learned when the Railway CLI (since retired) kept
  answering `Project is deleted` for a project that plainly existed, and the same reasoning holds for any
  control-plane that reports a deploy as green while the old build is still serving. **"A string only the
  new build contains" is the load-bearing half, and it has to be CHECKED, not assumed — run the grep
  against the CURRENTLY-SERVED document FIRST, and if it already hits, it is not a discriminator.** A
  block's own NAME is the tempting marker and routinely the wrong one: the name of a thing you are adding
  often already appears in the deployed spec as prose inside a neighbouring `.describe()`, so the poll
  reports DEPLOYED on its first tick against the old build. Pick a leaf FIELD name instead (they are not
  written into prose), and print the hit COUNT rather than a boolean so a false positive is visible.
  Cost 2026-08-28 (v0.147.1 `funnelSteps`): the name matched twice in the pre-deploy document, the poll
  said DEPLOYED immediately, and the clone was still on the previous commit with a 4-hour-old container;
  re-polling on `recipientsReached` (0 → 20) showed the deploy landed several minutes later. Same family
  as the "success pattern must not be matchable by its own error output" rule in the global config — a
  pattern that can match something which is not the event is not a monitor. Note the served
  document does NOT match the committed `openapi.json` byte for byte (different size); compare CONTENT,
  never length. (Set 2026-08-08.)
- **A code deploy does NOT change what a read returns — the Gold layer serves the PREVIOUS body first.
  Read a value TWICE before believing it, and never compare two endpoints' bodies from a single read
  each.** Past its fresh window a cell is served instantly from the snapshot and refreshed BEHIND the
  response, so the first read after a deploy legitimately returns the pre-deploy number and only the
  next one shows the new code's answer. Two endpoints hold SEPARATE cells that refresh independently,
  so a one-shot comparison can catch one cell before its refresh and the other after — which reads
  exactly like the incoherence you shipped a fix for. Poll until the value settles, then compare.
  Cost 2026-08-13 (#749 prod verification): the first post-deploy read showed the identity still
  over-reporting, and a fleet sweep flagged three "violations" — all were stale cells, and every one
  cleared on re-read (one brand's figure was even seen mid-flight at 7,177 vs 7,180 while the brand
  kept contacting people). Nothing was wrong; the reads were.

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

## `pipeline-activity.ts` — forecasting is AUDIENCE-grain; `customerProfileId` / brand-persona vocabulary is PURGED (PR #346/#349)

Candidates come from human-service active audiences (`fetchActiveAudiences`), cost from runs
`groupBy=audienceId` (`dimensions.audienceId`, no legacy id fallback), engagement from read-time
membership (explicit provenance — no send-tagging / inference). `fetchBestAudienceForecast` picks the
lowest-CPC active audience for the chosen workflow and derives ALL its rates from the SAME membership
tally in one pass — `openPerOutreach` / `clickPerOutreach` / `positiveReplyPerOutreach`. **Do not mix
grains**: a workflow-grain open rate beside an audience-grain click rate was a bug (#349). The caller
still falls back to the workflow's aggregate rates when NO audience qualifies (no clicks).
`fetchBrandPersonas` / `BrandPersona` are DELETED and `git grep -i customerprofile src` returns ZERO
matches; `fetchCurrentBrandProfile` stays (it still feeds the cost `brandProfileId` filter).

## MIGRATIONS RUN ON THE BOOT PATH AND NOWHERE ELSE — there is no CI migrate job, and re-adding one is a regression

`src/index.ts` runs `migrate(db, { migrationsFolder: "./drizzle" })` and then `registerSeedFeatures()`
BEFORE `app.listen()`, and the box's deploy is health-checked with automatic rollback. So a migration and
the code that needs it land together, atomically, and a migration that fails takes the deploy down with it
rather than leaving prod half-migrated.

A `migrate` job in `.github/workflows/ci.yml` used to run `pnpm db:migrate:prod` against a production
`FEATURES_SERVICE_DATABASE_URL` secret on every push to main. It was **deleted** (2026-08-19), along with
`scripts/migrate-prod.ts` and the `db:migrate:prod` package script. Three reasons, and the first alone is
decisive:

- **It could not work.** The fleet's Postgres is a container on the box publishing `127.0.0.1:5432`
  (loopback only), so a GitHub runner cannot reach it at all. The job had been failing on
  `password authentication failed for user 'neondb_owner'` since the Neon retirement — its secret still
  pointed at the decommissioned database. "Repointing the secret" is not available without exposing prod
  Postgres to the internet, which is not a trade worth making for a job that does nothing the boot path
  does not already do.
- **It was redundant.** Same migrator, same `./drizzle` folder, same files.
- **It inverted the ordering.** CI migrated on PUSH, i.e. BEFORE the deploy — so prod's schema could move
  ahead of the code that needed it, which is the one ordering a boot-path migration makes impossible.

**`migrate` was a REQUIRED status check on `main` and was removed from the required contexts in the same
change.** Deleting the job without that leaves every future PR to main blocked forever on a check that can
never report. If you ever re-add a job under that name, re-add the context too; if you delete another
required job, do the protection edit FIRST.

`npm run db:migrate` (drizzle-kit, local dev) is untouched.

## Migration gotcha — drizzle-kit meta snapshot is DRIFTED; strip spurious `features` drops

`drizzle/meta/` is out of sync with the live `features` table (a prior schema simplify edited
`schema.ts` without a matching migration). So **every** `npx drizzle-kit generate` re-emits
unrelated teardown of `features` — `DROP COLUMN display_name/category/channel/audience_type/
signature/forked_from/upgraded_to`, `DROP INDEX idx_features_signature`, and a **no-`IF EXISTS`
`ALTER TABLE features DROP CONSTRAINT features_signature_unique`** that will **crash-loop boot**
if those objects are already gone (migrations run at boot, so a throw kills the process before it
listens — the container then restart-loops and the deploy's health check never passes).

When you generate a new migration, **hand-strip the SQL down to ONLY your intended statements**
before committing (the runtime migrator checks journal `when`-ordering, not content, so editing the
`.sql` is safe; leave the `meta/*_snapshot.json` as the new baseline). Reference: `0006_gold_view_
snapshots.sql` was stripped to just its `CREATE TABLE`/`CREATE INDEX`. Reconciling the meta drift
fully (so generate stops re-emitting the `features` drops) is a deferred follow-up. (Set 2026-06-15, PR #293.)

## Stack

- TypeScript (strict), Express, Zod, Drizzle ORM, Postgres
- Tests: Vitest + Supertest
- OpenAPI: auto-generated from Zod schemas via `@asteasolutions/zod-to-openapi`
- Deployed from the Dockerfile onto the self-hosted box; deploys are a cron running `./deploy.sh --all`
  (health-checked, rolls back automatically on failure). Env lives in `/root/distribute/env/<svc>.env`
  on that box.

**The database is ONE self-hosted Postgres container shared by the whole fleet** — every service has its
own database inside it, reached over ssh with
`docker exec distribute-postgres-1 psql -U postgres -d features_service`. (It replaced a per-service Neon
project, which is why several notes below reason about Neon cold starts — see those notes for what
survived the move.)

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
the repo root — an install artifact, delete it, never commit it. **`git add -A` sweeps it in silently
and CI fails at SETUP, before a single test runs**: `actions/setup-node`'s pnpm cache step shells
`pnpm store path`, which reads the stub as a workspace manifest and dies with
`ERROR packages field missing or empty` — a message that names neither pnpm-workspace.yaml nor your
change, so it reads as broken CI rather than a stray file. `rm -f pnpm-workspace.yaml` BEFORE staging,
or stage explicit paths. It is not gitignored, so nothing catches it locally. (Cost 2026-08-18, #780:
one full red CI cycle + a force-push amend.)

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

## A CHANGE THAT SUPERSEDES A DOCUMENTED RULE UPDATES THIS FILE IN THE SAME PR

Most sections here open by stating an invariant and then say "do NOT re-litigate". That wording is what
makes the next agent trust them, so a section describing a rule the code no longer follows is worse than
no section: it is a premise someone will build on. `tsc` and the suite cannot catch it — the tests were
rewritten around the new rule and pass, while the doc keeps asserting the old one.

Before opening a PR that changes a RULE (a verdict, a precedence, a basis, a producer, a field name a
section names), `git grep` this file for the identifiers you touched and rewrite every section that
answers with the old rule — including the SIBLING surfaces that share the code (`accountStatus` is read
by the accounts audit, send-forecast and customer-health, so one rule change is three sections). State
what it supersedes and why, so the reasoning that produced the old rule is not re-derived later.

Cost 2026-08-27 (#837 → #838): the accounts audit moved to campaign-service's running budget and dropped
the brand pause flag, and this file went on documenting the pause-first precedence, `dailyBudgetUsd`, and
billing as the budget source in four places — a second PR the same day. Corollary the brief named
explicitly: when a change BREAKS a recorded series (a snapshot basis that cannot be replayed), say so
beside the section that DESCRIBES that series, not only in the section that caused it — a reader of the
curve will not be reading the section that moved it.

## A CHANGE THAT SUPERSEDES A DOCUMENTED RULE UPDATES THIS FILE IN THE SAME PR

Most sections here open by stating an invariant and then say "do NOT re-litigate". That wording is what
makes the next agent trust them, so a section describing a rule the code no longer follows is worse than
no section: it is a premise someone will build on. `tsc` and the suite cannot catch it — the tests were
rewritten around the new rule and pass, while the doc keeps asserting the old one.

Before opening a PR that changes a RULE (a verdict, a precedence, a basis, a producer, a field name a
section names), `git grep` this file for the identifiers you touched and rewrite every section that
answers with the old rule — including the SIBLING surfaces that share the code (`accountStatus` is read
by the accounts audit, send-forecast and customer-health, so one rule change is three sections). State
what it supersedes and why, so the reasoning that produced the old rule is not re-derived later.

Cost 2026-08-27 (#837 → #838): the accounts audit moved to campaign-service's running budget and dropped
the brand pause flag, and this file went on documenting the pause-first precedence, `dailyBudgetUsd`, and
billing as the budget source in four places — a second PR the same day. Corollary the brief named
explicitly: when a change BREAKS a recorded series (a snapshot basis that cannot be replayed), say so
beside the section that DESCRIBES that series, not only in the section that caused it — a reader of the
curve will not be reading the section that moved it.

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

## AT BRAND LEVEL THERE IS NO GOAL — `/audience-stats` with NEITHER `funnel` NOR `goal` prices each audience across EVERY funnel the brand DECLARED, combined as the BEST-RETURNING funnel

A brand runs several sales funnels at once, so the only thing that matters at that grain is return:
what came back per dollar. Until now exactly one of `funnel` / `goal` was REQUIRED, and the funnel
decides the whole cost basis — so a brand-level consumer had to PICK one of the brand's funnels and
price every audience through it. The dashboard picked the one the RETIRED brand column implies, which
is worse than arbitrary: that column is server-defaulted (`funnel-ranking` says so at the top of this
file), so a brand that chose nothing read as "website purchases" and its Audiences table was ranked and
priced through a funnel it may never have declared.

**Sending neither parameter is now a first-class request, not a missing one.** `goal` reads `null`,
`sortMetric` is `returnPerDollar` (DESCENDING, unmeasurable rows last), and every row's `projection`
carries `returnPerDollar` / `costPerPaidClientUsd` / `costOfAcquisitionPct` for the brand as a whole.

- **THE COMBINATION RULE IS THE BEST-RETURNING DECLARED FUNNEL — `max`, never a blend and never a sum.**
  A dollar buys a customer through whichever of the brand's funnels converts it best. Same doctrine as
  the combined-`sales` cost (`min` over channels ⟺ `max` over returns), and the reason no combined
  figure can read better than the honest single-funnel one. Ties break on the canonical funnel-catalogue
  order, so the same evidence always gives the same answer.
- **It RECONCILES by construction, both ways, and the test drives all three surfaces from ONE fixture**
  (`routes/audience-brand-return.test.ts`). `brandProjection.returnPerDollar` IS the head of
  `/funnel-ranking` (identical `returnPerDollar` definition, identical evidence, so the maximum over the
  declared set is the same number), and an audience's return IS its return on a `?funnel=` read of the
  funnel it was combined through. Nothing is asserted twice.
- **The row names its OWN funnel — `projection.basisFunnelKey` — and it is routinely NOT the brand's.**
  An audience whose replies are cheap pays through the conversation funnel while the brand's headline
  pays through the website one; inheriting the brand's basis would print a number the audience does not
  earn. `projection.lifetimeRevenueUsd` rides each row for the same reason: two audiences can be priced
  through funnels the brand values differently ($200 self-serve vs a $20k contract), so a consumer can
  never pair a return with an LTR this projection did not use.
- **The response STATES WHAT IT COVERS — `funnelCoverage`.** Every DECLARED funnel is listed with
  `priced` and, when false, its `reason` (`no_economics` / `no_workflow_evidence` /
  `no_paid_client_path` / `no_return_defined` — the SAME vocabulary `/funnel-ranking` reports, exported
  as `FunnelPricingReason` from `audience-stats-brand-projection.ts`). A reader who cannot tell what
  went in cannot trust the number.
- **COST COLUMNS are denominated in ONE funnel and the response names it** (`pricingBasisFunnelKey`):
  the best-returning declared funnel, else the FIRST declared in catalogue order. A cost per outcome is
  denominated in a funnel's own outcome, so unlike a return it cannot be combined across funnels. The
  funnel-denominated conversion columns (`cpfsCents`/`cpsCents`/`cpsaleCents`) stay `null` on this read
  — "cost per signup" is a question only a signup funnel asks.
- **ONE evidence fan-out, N pure projections.** `fetchBrandProjectedParents` split into
  `fetchBrandProjectionEvidence` (all the IO, goal- AND funnel-independent) + `projectBrandParents`
  (pure), exactly as `/funnel-ranking` ranks N funnels off one `WorkflowProjectionEvidence`. Pricing 4
  declared funnels costs the same IO as pricing one; fetching per funnel would multiply the per-audience
  email fan-out by the declared count. Do NOT re-merge them.
- **A brand that declared NOTHING has no answer here, and it is distinguishable: 502
  `reason: "declared_funnels_unavailable"`** — the same producer-gap doctrine as `/funnel-ranking` (an
  empty declaration is a gap, not "sells through nothing"), never a zero return and never a substituted
  set. A brand whose funnels price but state no lifetime revenue reads `null` on every return field with
  `reason: "no_return_defined"` — a different statement from an unreadable declaration, and neither is 0.
- **NAMING A FUNNEL IS UNCHANGED, byte for byte** — one funnel, its own cost columns, its own `cpc`/`cppr`
  order, no `funnelCoverage`, no `basisFunnelKey`. The campaign level genuinely sells ONE funnel, so that
  read stays correct and stays supported; this is an additional way to ask. Guarded by a case in the same
  suite. A NAMED-but-unrecognised `goal`/`funnel` is still a 400 — only omitting BOTH is the brand read.
- **The declared KEY SET rides the Gold `scope_key` as `decl`** (fail-soft, it feeds the key not the
  body), so re-declaring a funnel lands on a new cell instead of replaying a coverage block naming
  funnels the brand no longer sells through. Same reasoning as the economics fingerprint beside it.
- Consumers: distribute.you's brand Audiences table + the Overview's Top-audiences card, both of which
  rank on return and were pricing it through the retired column. (features-service#769, set 2026-08-14.)

## THE BRAND OVERVIEW ANSWERS "IS THIS WORKING?" IN MONEY — $CAC on the DEFAULT read, ROI over the brand's LIFE, ROI per AUDIENCE

A brand runs several acquisition channels and several sales funnels at once, so the honest answer at
brand level is money, not funnel steps: what the pipeline is worth, what it cost, and what the two
divide into. Three figures were unanswerable from what this service served, so the dashboard rendered
a dash beside real numbers — which reads as a broken card, not a scoping decision.

- **`costEconomics.costPerAcquisitionUsd` is on EVERY revenue body, the un-lensed brand read
  included.** It was NOT a new computation: pipeline is `expected paying clients × LTR`, so the client
  COUNT is `totalPipelineUsd / lifetimeRevenueUsd` and `$CAC = committedCostUsd ÷ that count =
  (costOfAcquisitionPct/100) × LTR = LTR / roiMultiple`. Pipeline, ROI, %CAC and $CAC are ONE statement
  in four units. It was previously reachable only via `?lens=` (`costPerConversionUsd`), and the brand
  Overview is not lensed — it is the whole brand, every funnel. The two AGREE by construction (the
  lens divides the same spend by `Σ per-lead probability`, which IS `lensPipeline / LTR`), guarded by a
  one-fixture case in `revenue.test.ts`. It rides the `?groupBy=campaignId` groups for free. NULL,
  never 0, with no LTR / no funnel / null pipeline. The CROSS-ORG public revenue read (`public.ts`)
  passes no LTR on purpose — orgs sharing a brand have their OWN economics, so there is no single
  correct answer to give.
- **`roiHistory` charts return on spend across the brand's whole life** — the Outcome card's replacement
  for a raw cumulative signal line. **BOTH LEGS ARE CUMULATIVE SINCE INCEPTION, and that is load-bearing:**
  spend on a day buys outcomes that land days or weeks later, so a period-grain ratio oscillates
  between 0 and absurd and describes nothing. The cumulative form converges, and its LAST `roiMultiple`
  IS `costEconomics.roiMultiple` for the same read.
  - **MEASURED on both legs, nothing modelled.** Spend is dated by runs-service
    `/v1/stats/public/costs/timeseries` (`brand-spend-by-day-client.ts` →
    `fetchBrandCommittedSpendByDay`, org+brand+feature filtered, **COMMITTED** `total` /
    frozen-`netTotal` per `pricing` — the SAME single basis the headline ROI rides, which is what makes
    the terminal point reconcile rather than chart a second currency); runs guarantees Σ buckets == the untimed total for the
    same filter, which is exactly why the curve terminates ON the headline instead of being corrected
    onto it. Pipeline is the engine's OWN `timeSeries` (each org steps the total up at its
    most-advanced event date). **Do NOT spread spend evenly over time** — that invents the shape of the
    thing the chart claims to show.
  - **The stale "dated columns are deferred until per-event timestamps exist" note is GONE from the
    OpenAPI description** — the timestamps have been there since #377; only dated SPEND was missing.
  - An org with no event timestamp sits on no day: reported as `undatedPipelineUsd`, never dropped and
    never parked on a fabricated day (`datedPipelineUsd + undatedPipelineUsd === totalPipelineUsd`).
  - `roiMultiple` is **null, never 0**, on a day whose cumulative spend is still 0.
  - OVERVIEW ONLY (same gate as `spend`): null on `?lens=` (the lens is a lead SUBSET; its spend leg
    would be the brand's whole spend), absent on `?groupBy=campaignId` groups. **Fail-SOFT** with a loud
    log, like `sequences` — a curve must never 502 an Overview whose every other number is correct.
  - Pure builder + guards: `src/lib/roi-history.ts` / `roi-history.test.ts`.
- **`/audience-stats` rows carry `projection.{costPerPaidClientUsd,returnPerDollar}` and the envelope
  carries `brandProjection`.** The Top-audiences card must lead with RETURN, not cost per outcome: cost
  per outcome ranks by CHEAPNESS, so an audience that converts to nothing outranks an expensive one
  that pays. `returnPerDollar = lifetimeRevenueUsd / costPerPaidClientUsd` is the **IDENTICAL**
  definition `/funnel-ranking` ranks a brand's declared funnels on — routed through the SAME
  `paidClientCostForGoal` (now exported from `workflow-projection.ts`), so an audience's return and the
  brand's return are one statistic at two grains and a brand cannot read two returns on two pages.
  - **PROJECTED, and the field name says so.** It prices the audience's OWN observed unit costs (the
    send-tag spend/clicks/replies on the workflow the Strategy page renders it under — the SAME
    `byAudience` pick the derived cost columns take) through the brand's OWN declared economics. It is
    NOT `/revenue`'s realized `roiMultiple`; do not rename either to look like the other.
  - **An audience with no MEASURED grain inherits `brandProjection` verbatim** — the same brand-level
    fallback every derived column already takes, so the two families can never disagree about which
    evidence priced the row. `brandProjection.lifetimeRevenueUsd` is surfaced so a consumer can never
    pair a return with an LTR this projection did not use.
  - Zero new IO: `fetchBrandProjectedParents` already resolved the economics and both grains.
  - **The THIRD unit of the same statement is `projection.costOfAcquisitionPct` (+ the
    `brandProjection` twin), and it is SERVED, not left to the browser.** It is what winning a
    customer from this audience costs as a SHARE of what that customer is worth:
    `100 × costPerPaidClientUsd / lifetimeRevenueUsd`, which is exactly `100 / returnPerDollar`. It is
    IMPLEMENTED as that reciprocal (`costOfAcquisitionPct` in `audience-stats-brand-projection.ts`
    calls `returnPerDollar`), so the two null together and can never disagree by a rounding step —
    the same relation `/workflow-projection` states between `roiMultiple` and `cacPct`. Being the
    reciprocal of a field already on the row is precisely WHY it is served: a consumer dividing one
    of our fields into another is how two surfaces come to print two numbers for one statistic the
    day either side changes.
  - **PROJECTED, and the OpenAPI says so on both fields.** Do NOT pair it with `/revenue`'s
    `costEconomics.costOfAcquisitionPct`, which is REALIZED (measured spend ÷ measured pipeline). Same
    projected-vs-realized split `returnPerDollar` already carries against `roiMultiple`.
  - Inheritance, nulling and grain are `returnPerDollar`'s verbatim: an audience with no measured
    grain takes `brandProjection`, and an unmeasurable value is `null` — never 0, which would say
    winning a customer costs nothing.
  - Guards: the `per-audience RETURN per dollar` block in `routes/audience-cost-coherence.test.ts`
    (same one fixture as the cost-coherence cases: the audience's `costPerPaidClientUsd` equals the
    `resolved.costPerPaidClientUsd` of the row the Strategy page RENDERS, its `returnPerDollar` equals
    that row's `roiMultiple`, the brand twin is the same formula, inheritance is verbatim, and a 0-LTR
    brand reads null on both). (Set 2026-08-14.)

## ONLY A DECLARED FUNNEL'S LEGS ARE PIPELINE — an outreach that produced no conversion carries no value

A brand's pipeline counts only what its OWN declared funnels say is worth counting. The paths that carry
expected value are exactly the LEGS of those funnels; a signal that is not a step of one contributes
nothing — it is not decayed, not discounted, it simply is not a priced path.

**The bug.** Verified on prod brand `75d7e3e8…`: pipeline $23,547, of which **$8,772 (37%) came from
5,122 organisations whose only signal was that an email REACHED them**, and another $525 from 42 that
clicked. That brand declares exactly ONE funnel — `sales_meetings_from_conversation`
(Positive reply → Meeting booked → Meeting attended → Paid client) — where neither a delivery nor a
click is a step at all. Every merely-delivered lead was earning a funneled-down slice of a lifetime
contract through the platform-global open/click/reply rates.

- **contacted / sent / delivered / opened are MILESTONES, not paths — for EVERY brand.** They are a step
  of no funnel in brand-service's catalogue, so `FunnelMilestone` (`revenue-engine.ts`) carries **no
  revenue field at all**: nothing on it can be zeroed or weighted down, because there is nothing on it to
  price. This is the ONE part of the change that is universal rather than declaration-scoped — a delivery
  is a step of no funnel for anybody, so there is no brand for whom it could be one. A milestone still
  does two jobs: it gives a lead its POSITION tag when the lead reached no leg (`["delivered"]`), and it
  keeps that lead in `leads[]` at `expectedRevenueUsd: 0`. **That second job is load-bearing** — every
  Overview count series (`recipientsContacted`, opens, clicks, replies) and `buildSpend`'s CPC/CPPR
  denominators are built from that same array, so dropping the lead would report a handful of contacted
  where the brand has 7,181. It is in no organisation, in no event, in no time-series step and in no
  total. Engine gate: a person enters `scored` when `ev > 0 || reachedMilestone`; ORGANIZATIONS, the
  series and the headline keep the pre-existing `ev > 0` filter.
- **A conversion leg prices a brand only when one of the funnels being priced contains it** —
  `FUNNEL_LEG_SIGNALS` + `restrictPathsToDeclaredLegs` (`funnel-registry.ts`), read straight off
  `SALES_FUNNELS[key].steps`: Positive reply→`positiveReply`, Website visit→`clicked`, Meeting
  booked→`meeting`, Signup→`signup`, Form filled→`formSubmission`, Paid client→`closeWin`. So a website
  visit prices a brand that declared a website-led funnel and prices NOTHING for one that declared only
  the conversation funnel. "Meeting attended" needs no entry (it is folded into the booked→paid rate by
  `meetingFunnelCloseRate`); `signup`/`formSubmission` are listed because they ARE legs, and no path
  scores them today — if one is added it prices exactly the right brands with no further change.
  **`closeWin` is always a leg** — every funnel terminates in a paid client.
- **Which funnels are "being priced"** is `FunnelPricedEconomics.pricedFunnelKeys` (`routes/revenue.ts`).
  A brand that declared SEVERAL is priced on the UNION of their legs. A read NARROWED to one funnel is
  priced on that funnel's legs alone, in this precedence: the caller's `?funnel=` when the brand declared
  it, else **the funnel the CAMPAIGN itself states** on a campaign-scoped read
  (`campaignIdentity.funnelKey`, `matchSalesFunnelKey`) — a campaign sells one funnel, so its figures are
  that funnel's figures, not the brand's first-declared one. The brand-scoped read keeps the deterministic
  first-declared pick for the TERMS.
- **NO DECLARED FUNNEL ⇒ every conversion leg is priced, exactly as before.** We do not know which funnel
  the brand sells, and inventing one to narrow against is the same fiction the defaulted goal produced.
  The only thing that changes for such a brand is the delivery milestones, which were never a funnel's
  step for anybody. Same for an unreadable declaration (fail-SOFT with a loud log,
  `fetchDeclaredFunnelsSoft`) — the Overview degrades, it never 502s.
- **The declaration is read ONCE per request** and reused by every campaign group
  (`priceOnDeclaredFunnel` is pure), so the grouped path stays at one brand-service call. The declared
  KEY SET rides the Gold `scope_key` as `decl`: two brands can share economics and declare different
  funnels, so the `econ` fingerprint cannot stand in for it.
- **`platform-rates-client.ts` is DELETED** and `FunnelInputs` no longer carries `platformRates`. Those
  rates existed only to funnel contacted→sent→delivered down to a close; nothing funnels down from a
  delivery now, so the whole read left Wave A (one fewer IO per Overview). `ResolvedPath.kind` is gone
  too — every path is a funnel leg, and "delivery" is `FunnelMilestone`.
- Guards: `funnel-registry.test.ts` (four legs only, a milestone has no revenue field, per-funnel leg sets,
  the union, closeWin always, no declaration ⇒ unchanged) + `revenue-engine.test.ts` (a milestone-only
  lead is tagged, present in `leads[]`, and in no org / event / series / total) +
  `routes/revenue.test.ts` (a merely-delivered lead is worth nothing while `recipientsContacted` still
  counts it; a conversion signal prices a brand only under a funnel that contains it, both directions and
  the union) + `campaign-identity-aggregation.test.ts` (each campaign priced on its own stated funnel,
  `?funnel=` still wins, an unstated funnel falls back to the brand pick). (Set 2026-08-13.)
## THE REVENUE ENGINE HAS NO DECAY, AND IS NOT TIME-DEPENDENT — an outcome that happened stays counted, and the pipeline is priced on the brand's DECLARED FUNNEL

Two independent bugs made a customer's Campaigns page report **0.7x ROI against 15 positive replies**.
Both are gone; neither may come back.

**1. Decay is DELETED (supersedes #212 / #214, which introduced it).** Every stage used to carry a
staleness window — contacted→sent 7d, sent→delivered 3d, delivered/open 14d, reply→meeting 14d,
meeting→close 30d — and a lead whose FURTHEST reached stage sat past its window was zeroed, tagged
`stale`, dropped from the events ledger and stepped back DOWN out of the cumulative series at a
computed "death date". On brand `75d7e3e8…` that zeroed **6,678 of 7,188 leads, including 13 of the
15 positive replies and all 3 booked meetings**. The cost side of ROI is LIFETIME spend, so the ratio
compared a 14-day numerator against an all-time denominator and fell under 1 purely by ageing.

- `ResolvedPath` no longer HAS a window field, `computeRevenue` no longer takes `now`, and there is no
  `dead` / `deathDate` / `evRaw` / `stale` tag. Guards: the "no decay" suite in
  `revenue-engine.test.ts` (an outcome from 200/400 days ago counts identically to yesterday's) and
  the "NO path carries a staleness window" case in `funnel-registry.test.ts`.
- **The cumulative time series is MONOTONE NON-DECREASING** — every delta is an org's positive EV at
  its event date; nothing steps it back down. Its final point equals the headline total.
- **Do NOT reintroduce it under another name: no freshness weight, no half-life, no recency
  multiplier, no "confidence" that falls with age.** If ageing should cost something, it belongs on
  the COST side or on a separate, labelled surface — not silently inside the pipeline total.
- Consequence to expect: the delivery-stage leads that decay used to suppress are pipeline again, so a
  brand's headline is materially larger than its engaged-lead contribution alone. That is the funnel
  behaving as documented (a delivered lead carries `LTR × pClose_delivered`), not an inflation.
- Test fixtures no longer rot with wall-clock, so the old "windowed stages need RELATIVE dates" rule is
  moot. Relative `daysAgo(n)` fixtures are still used, now purely to express "old" readably.

**2. The pipeline EV prices on the brand's DECLARED SALES FUNNEL** (`fetchFunnelPricedEconomics`,
`routes/revenue.ts`). Brand-level conversion rates no longer carry meaning — rates exist PER FUNNEL,
and the brand-wide record survives only as the legacy fallthrough + prefill for a brand that declared
none. The spend block's cost-per-outcome columns and both sibling surfaces (`/workflow-projection?funnel=`
and the `/audience-stats` floor parent) already priced this way; the EV did not, so one brand + one
funnel + one moment printed two prices. Prod on that same brand: the declared conversation funnel states
70% reply→meeting × 50% attended→paid = **35% reply→paid**, while the EV priced each reply off the
brand-wide 50% × 25% = **12.5%** — $312.50 a reply where the brand had stated **$875**.

- **SAME precedence, SAME merge helpers as the siblings, deliberately** (`declaredEconomicsForFunnel`
  + `mergeFunnelEconomics`): the caller's `?funnel=` when it named one the brand actually declared,
  else the brand's FIRST DECLARED funnel in catalogue order. Do NOT write a second resolution here —
  two implementations is exactly how the two prices appeared.
- A term the funnel does not state falls through to the brand-wide value, never to 0 (which would
  zero-collapse the funnel). The meeting funnel COMPOSES (`meetingFunnelCloseRate`): booked→paid =
  attended% × show-up%, so a declared show-up rate is never a free 100%.
- **NO declared funnel ⇒ byte-identical to before** — the brand-wide economics apply unchanged.
- Resolved ONCE in the route and threaded down as `economicsOverride`, so it costs one brand-service
  read and the funnel's own rates ride the `economicsFingerprint` in the Gold `scope_key` — a
  re-declared funnel lands on a new cell instead of replaying a price the brand no longer states.
- **Fail-SOFT with a loud log**, like the spend cost-parents read on this same path: an unreadable
  declaration degrades to the brand-wide economics (a real, if poorer, answer) rather than 502-ing the
  Overview. Note an EMPTY declaration THROWS at the client (a producer gap, not "sells through
  nothing") and lands here as that same degrade — which IS the required no-declared-funnel behaviour.
- Guards: the declared-funnel pricing block in `routes/revenue.test.ts` (own terms win, unstated terms
  fall through, the show-up rate composes, the funnel's own LTR is used, `?funnel=` selects the funnel,
  no declaration is unchanged). (Set 2026-08-13.)

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

## `workflow-cost-per-outcome` per-workflow RECENT rate — the OFF-request-path warm pattern (4 slow-sibling failure modes; features-service#526)

The per-workflow `recentCostPerOutcomeUsd` (trailing-window moving average) can NOT be computed on the
request path: it needs, PER dynasty, a dated-spend timeseries (runs) + dated outcomes (email-gateway), and
neither producer exposes a single `(day × dynasty)` call (runs' timeseries only FILTERS by dynasty;
email-gateway `groupBy` is single-dimension), so it is an O(dynasty-count) cross-service fan-out. Running it
on the request path 500s/timeouts (PR #521 regression). It runs as a background SWR **warm** in
`handleWorkflowCostPerOutcome` (`src/routes/public.ts`) that overwrites the cache entry + a persisted
recent-rate store. That warm hammers several sibling services at once, and it went through FOUR failure
modes before it populated reliably in prod (they were first hit against Neon computes that suspended when
idle; the same four bite any burst of concurrent calls to a sibling that answers slowly, which a shared
database instance under load still does) — **any new off-request-path fan-out warm MUST carry all four**
(do NOT re-discover them one prod hotfix at a time, v0.87.1→v0.87.4):

1. **Per-dynasty resilience** (`try/catch` per item, not one all-or-nothing `Promise.all`) — one failing
   dynasty nulls only itself, never the whole set.
2. **Per-item timeout** (`withTimeout`, 45s) — a HUNG fetch (a sibling that accepts the connection and
   then never answers, so nothing ever rejects) would leave the
   outer `Promise.all` pending forever → the warm never settles → its `.finally()` never clears the
   single-flight flag → NO future warm runs → recent permanently null. The timeout guarantees the warm
   always settles + clears its flag.
3. **Capped concurrency** (`mapWithConcurrency`, 6) — firing all ~25 dynasties' fan-outs at once = ~50
   connections that OVERWHELM the siblings, making every fetch slow enough to trip the timeout →
   all-null. The cap keeps each fetch fast enough to beat the timeout. (Timeout + concurrency are a PAIR:
   the timeout without the cap is what turned a slow warm into an all-null one.)
4. **Variable store TTL + serve-from-store** — the served payload is seeded from the persisted store (a
   payload-TTL miss never re-nulls the column, no flicker); a CLEAN warm (0 failures) is trusted 10 min
   (no re-warm → no contention with the request-path lifetime fan-out for the same cold siblings), a
   DEGRADED warm (≥1 failure) only ~90s so it self-heals on the next read WITHOUT hammering. Do NOT gate
   re-warm on "store empty" alone with a single long TTL — that pins a degraded all-null result; and do NOT
   re-warm on every miss — that contends with the request path.

Genuinely-unbacked dynasty (no recent clicks) → null, never a false $0. Depends on the org-less dynasty
resolution funnel: workflow-service `/workflows/dynasty/slugs` api-key-only (v0.38.0) + email-gateway
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
`leadId`) from the `leads[]` snapshot; `/stats` `recipientsClicked` was
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

**email-gateway is STILL fetched** for the replies Negative/Neutral/AutoReply (the snapshot only knows
`positiveReply` via `replyClassification`). `recipientsBounced` has been snapshot-owned since this
list was written (it is in `SNAPSHOT_ENGAGEMENT_KEYS`); the older wording here claimed email-gateway
still answered it, which was already untrue. Only the keys in that list are overridden. Open has NO lead-row
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
request. That fan-out — as slow as its slowest sibling, and paid on every page view — is the dashboard's
latency. The fix is
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
  the siblings. `setPublicCache` prunes past-STALE entries on write — these keys are
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
hit and trigger the fan-out, doubling load on the sibling services. TTL ≥ poll interval is the rule.

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
`setInterval`.** A timer fires on every replica, forever, at the same rate whether the service served a
million requests that hour or none — for a table that needs touching about once a day. Riding write
traffic scales the sweep to the traffic that actually creates the rows it prunes, and an idle service
does no work at all. (The rule was first written when the databases suspended while idle and a timer
would have kept them awake; the platform changed, the reasoning did not — reap on-read, never on a
clock.) It is also fire-and-forget: a prune failure is logged and dropped, which is NOT the swallowed
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
counts × per-stage-EV approximation — that loses company-dedup and reads "lower quality"):

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
