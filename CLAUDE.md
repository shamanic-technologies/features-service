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

## Key Files

| File | Purpose |
|------|---------|
| `src/db/schema.ts` | Drizzle table definition (source of truth for DB shape) |
| `src/lib/schemas.ts` | Zod schemas for request validation |
| `src/lib/openapi.ts` | OpenAPI spec generation (response schemas + path registration) |
| `src/lib/signature.ts` | Signature computation, slugify, versioned name/slug helpers |
| `src/lib/stats-registry.ts` | Stats key registry (raw + derived keys) |
| `src/routes/features.ts` | All feature CRUD endpoints |
| `src/routes/stats.ts` | Stats computation endpoints |
| `src/seed/features.ts` | Seed feature definitions (registered at cold start) |
| `src/middleware/auth.ts` | API key + identity header auth |
| `openapi.json` | Generated — never edit manually |

## OpenAPI Rule

Every new or changed endpoint requires THREE changes in the same PR:
1. Zod schema in `src/lib/schemas.ts`
2. Path entry in `src/lib/openapi.ts`
3. Re-generated `openapi.json` (run `npm run generate:openapi`)

---

# Dynasty Model — Design Specification

## Overview

Features-service uses a **dynasty model** for feature versioning, aligned with workflow-service. Each feature belongs to a **dynasty** — a lineage of versions sharing a stable identity. Upgrades increment the version within the same dynasty. Forks create a new dynasty with an auto-generated codename.

This model enables:
- Stable identifiers for workflow-service to compose workflow names
- Full lineage tracking across upgrades and forks
- Stats aggregation across entire upgrade chains, including convergence of multiple dynasties

---

## Column Layout

| Column | Type | Nullable | Exposed in API | Description |
|--------|------|----------|----------------|-------------|
| `id` | uuid | NOT NULL | yes | Primary key |
| `base_name` | text | NOT NULL | **no** | Root concept name, shared across forked dynasties (e.g. "Sales Cold Email") |
| `fork_name` | text | NULL | **no** | Auto-generated codename for forked dynasties (e.g. "Sophia"). NULL for the original dynasty |
| `dynasty_name` | text | NOT NULL | yes | Composed: `base_name + (fork_name ? " " + fork_name : "")`. Stable across versions |
| `dynasty_slug` | text | NOT NULL | yes | `slugify(dynasty_name)`. Stable across versions |
| `version` | integer | NOT NULL | yes | Version number within the dynasty (1-based) |
| `name` | text | NOT NULL | yes | Composed: `dynasty_name + (version > 1 ? " v" + version : "")`. Globally unique |
| `slug` | text | NOT NULL | yes | Composed: `dynasty_slug + (version > 1 ? "-v" + version : "")`. Globally unique |
| `signature` | text | NOT NULL | yes | SHA-256 hash of sorted(input keys) + sorted(output keys) |
| `description` | text | NOT NULL | yes | |
| `icon` | text | NOT NULL | yes | Lucide icon name |
| `category` | text | NOT NULL | yes | Feature category (sales, pr, discovery, outlets) |
| `channel` | text | NOT NULL | yes | Communication channel |
| `audience_type` | text | NOT NULL | yes | Form layout type |
| `implemented` | boolean | NOT NULL | yes | |
| `display_order` | integer | NOT NULL | yes | |
| `status` | text | NOT NULL | yes | "active" / "draft" / "deprecated" |
| `inputs` | jsonb | NOT NULL | yes | Input field definitions |
| `outputs` | jsonb | NOT NULL | yes | Output metric definitions |
| `charts` | jsonb | NOT NULL | yes | Chart definitions |
| `entities` | jsonb | NOT NULL | yes | Entity type definitions |
| `forked_from` | uuid | NULL | yes | Parent feature ID (set on fork) |
| `upgraded_to` | uuid | NULL | yes | Successor feature ID (set when deprecated) |
| `created_at` | timestamptz | NOT NULL | yes | |
| `updated_at` | timestamptz | NOT NULL | yes | |

### Naming Composition Rules

```
dynasty_name  =  base_name  +  (fork_name ? " " + fork_name : "")
dynasty_slug  =  slugify(dynasty_name)
name          =  dynasty_name  +  (version > 1 ? " v" + version : "")
slug          =  dynasty_slug  +  (version > 1 ? "-v" + version : "")
```

Example chain:

```
Original:    base="Sales Cold Email", fork=null
             → dynasty_name="Sales Cold Email", slug="sales-cold-email", v1

Upgrade:     same dynasty
             → dynasty_name="Sales Cold Email", slug="sales-cold-email-v2", v2

Fork:        base="Sales Cold Email", fork="Sophia"
             → dynasty_name="Sales Cold Email Sophia", slug="sales-cold-email-sophia", v1

Fork of fork: base="Sales Cold Email", fork="Berlin"
             → dynasty_name="Sales Cold Email Berlin", slug="sales-cold-email-berlin", v1
```

### Uniqueness Constraints

| Constraint | Scope | Purpose |
|------------|-------|---------|
| `UNIQUE(slug)` | Global | One feature per slug |
| `UNIQUE(name)` | Global | One feature per name |
| `UNIQUE(dynasty_slug, version)` | Per dynasty | One version N per dynasty |
| `UNIQUE(signature)` | Global | Forces convergence when two dynasties produce the same definition |

### Renamed Column

The old `display_name` column was renamed to `dynasty_name`. This is a breaking API change — clients that read `displayName` must read `dynastyName` instead.

---

## Operations

### 1. Creation (new feature, no existing dynasty)

- Client provides `name` in the request body
- `base_name = name`
- Check if any feature with the same `base_name` exists
- If NO collision: `fork_name = null`, `dynasty_name = base_name`, `version = 1`
- If collision: auto-generate a `fork_name` from the codename list, `dynasty_name = base_name + " " + fork_name`, `version = 1`

### 2. Batch Upsert (PUT /features, cold-start registration)

Same as creation, with signature-based dedup:
- Compute signature from inputs + outputs
- If signature already exists in DB → update metadata in-place (no version/dynasty change)
- If signature is new:
  - Match dynasty by `base_name` + `fork_name` (seed features always have fork_name = null)
  - If matching dynasty has an active feature → **upgrade**: deprecate old, create new with `version + 1`, same dynasty identity
  - If no matching dynasty → create new dynasty

**Cold-start guarantee:** Seed features are controlled by us with stable names. On repeated boots with the same signature, metadata updates in-place (no-op). On boots with changed signature, upgrade within the same dynasty.

### 3. Upgrade (signature changes within a dynasty)

Triggered by PUT /features/:slug when new inputs/outputs produce a different signature:
- If new signature already exists globally → **convergence** (see below)
- Otherwise: create new feature in **same dynasty**, inherit `base_name`, `fork_name`, `dynasty_name`, `dynasty_slug`, `version = max(version in dynasty) + 1`. Deprecate old feature (status → deprecated, upgradedTo → new feature).

### 4. Fork (creates a new dynasty)

Triggered by forking an existing feature:
- `base_name` = parent's `base_name`
- Generate new unique `fork_name` (see Fork Name Generation below)
- `dynasty_name = base_name + " " + fork_name`
- `version = 1`
- `forked_from = parent.id`

### 5. Convergence (two dynasties produce the same signature)

When Dynasty B upgrades and the new signature matches an existing feature (in Dynasty A):
1. Do NOT create a new feature record
2. Deprecate Dynasty B's current active feature
3. Set `upgradedTo` → the existing feature with the matching signature
4. Both lineages now converge on a single active feature

```
Dynasty A: v1 (deprecated, upgradedTo → A v2) ──→ A v2 (active, sig: DEF)
                                                        ↑
Dynasty B: v1 (deprecated, upgradedTo → A v2) ─────────┘
```

Stats aggregation for A v2 traverses BOTH ancestor branches.

---

## Fork Name Generation

A curated list of ~100+ codenames is embedded in the codebase (in `src/lib/signature.ts`):

```typescript
const CODENAMES = [
  "Sophia", "Berlin", "Atlas", "Nova", "Ember",
  "Coral", "Summit", "Prism", "Velvet", "Zenith",
  "Aurora", "Cascade", "Horizon", "Onyx", "Quartz",
  // ... 100+ names
];
```

**Algorithm:**
1. Query all `fork_name` values WHERE `base_name = targetBaseName`
2. Filter codenames to exclude already-used ones
3. Pick the first available codename
4. If all exhausted (100+ forks of the same concept — extremely unlikely): fallback to `{codename}-{short_uuid_4chars}`

No AI/LLM call. Deterministic, fast, readable names.

---

## Stats Aggregation — BFS Predecessor Map

The `collectLineageSlugs` function in `src/routes/stats.ts` must handle convergence where one feature has multiple predecessors.

### Algorithm

```
1. Load all features with status = "deprecated" that have upgradedTo set
2. Build predecessor map: upgradedTo → [predecessor_ids]
   (Map<string, string[]> because convergence means one successor can have multiple predecessors)
3. BFS from the target feature's ID:
   - Start with target ID in a queue
   - Pop from front, look up all predecessors in the map
   - Add predecessors to queue if not in visited set
   - Collect all slugs from visited features
4. Also walk upgradedTo forward (handles case when querying a deprecated feature)
5. A visited set prevents double-counting when branches converge
6. Return all collected slugs
```

---

## Dynasty Resolution Endpoint

```
GET /features/dynasty?slug=sales-cold-email-sophia-v2
```

Response:
```json
{
  "feature_dynasty_name": "Sales Cold Email Sophia",
  "feature_dynasty_slug": "sales-cold-email-sophia"
}
```

Used by workflow-service to resolve stable dynasty identifiers from a versioned feature slug.
- Authenticated (x-api-key + identity headers)
- 404 if slug not found
- Works for both active and deprecated features

---

## API Response Shape

Features returned by the API expose dynasty fields but NOT `base_name` or `fork_name`:

```json
{
  "id": "uuid",
  "slug": "sales-cold-email-sophia-v2",
  "name": "Sales Cold Email Sophia v2",
  "dynastyName": "Sales Cold Email Sophia",
  "dynastySlug": "sales-cold-email-sophia",
  "version": 2,
  "signature": "a3f8...",
  "status": "active",
  "forkedFrom": "uuid-or-null",
  "upgradedTo": "uuid-or-null",
  "description": "...",
  "icon": "envelope",
  "category": "sales",
  "channel": "email",
  "audienceType": "cold-outreach",
  "implemented": true,
  "displayOrder": 0,
  "inputs": [...],
  "outputs": [...],
  "charts": [...],
  "entities": [...],
  "createdAt": "...",
  "updatedAt": "..."
}
```

---

## Edge Cases

| Case | Behavior |
|------|----------|
| First creation, no collision | `fork_name = null`, `version = 1` |
| Creation, base_name collision | Auto-generate `fork_name`, new dynasty, `version = 1` |
| Upgrade, same signature | Metadata update in-place, no version/dynasty change |
| Upgrade, new signature, no global collision | Same dynasty, `version + 1`, deprecate old |
| Upgrade, new signature, global collision (convergence) | Deprecate old, point `upgradedTo` → existing feature with matching sig |
| Fork | New dynasty with auto-generated `fork_name`, `version = 1`, `forkedFrom` set |
| Fork, all codenames exhausted | Fallback: `{codename}-{short_uuid}` |
| Stats query on converged feature | BFS traverses ALL predecessor branches |
| Stats query on deprecated feature | Walks both up and down the chain |
| Dynasty endpoint, slug not found | 404 |
| Dynasty endpoint, deprecated slug | Returns dynasty info normally |
| Batch upsert, repeated boot, same signature | No-op metadata update |
| Batch upsert, repeated boot, changed signature | Upgrade within same dynasty |

---

## Migration (drizzle/0004_dynasty_model.sql)

1. `ALTER TABLE features RENAME COLUMN display_name TO dynasty_name`
2. `ALTER TABLE features ADD COLUMN base_name text`
3. `ALTER TABLE features ADD COLUMN fork_name text`
4. `ALTER TABLE features ADD COLUMN dynasty_slug text`
5. `ALTER TABLE features ADD COLUMN version integer NOT NULL DEFAULT 1`
6. Backfill existing data:
   - `base_name = dynasty_name` (all existing features are originals)
   - `dynasty_slug = slugify(dynasty_name)` via SQL regex
   - `version` = parsed from slug suffix (`-v2` → 2, no suffix → 1)
7. `ALTER TABLE features ALTER COLUMN base_name SET NOT NULL`
8. `ALTER TABLE features ALTER COLUMN dynasty_slug SET NOT NULL`
9. Add `UNIQUE(dynasty_slug, version)` constraint
10. Add index on `base_name` for fork_name queries
