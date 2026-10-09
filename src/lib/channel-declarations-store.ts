/**
 * IO for run-time declarations (`lib/channel-declarations.ts`): the four tables, and the ONE catalogue read
 * every client surface and every internal read goes through (`loadChannelCatalogue`), so a declared channel
 * is built by the same `buildChannelCatalogue` as a seeded one. Every read orders its rows (deterministic
 * catalogue, and the shape route suites mock).
 */
import { asc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { channelTriggerTypes, declaredChannelLegs, declaredChannels, declaredSalesPaths, features } from "../db/schema.js";
import { buildChannelCatalogue, type PublicChannel } from "./channel-catalogue.js";
import { channelShortDescription } from "./channel-short-descriptions.js";
import { channelTypeOf } from "./channel-types.js";
import {
  mergeDeclarations,
  type ChannelInput,
  type ChannelPatch,
  type DeclaredChannel,
  type DeclaredLeg,
  type DeclaredSalesPath,
  type DeclaredSalesPathLeg,
  type LegInput,
  type TriggerInput,
  type TriggerPatch,
  type TriggerTypeRecord,
} from "./channel-declarations.js";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

type ChannelRow = typeof declaredChannels.$inferSelect;
type LegRow = typeof declaredChannelLegs.$inferSelect;
type TriggerRow = typeof channelTriggerTypes.$inferSelect;

const channelOf = (r: ChannelRow): DeclaredChannel => ({
  ...r,
  channelType: r.channelType as DeclaredChannel["channelType"],
  operatedBy: r.operatedBy as DeclaredChannel["operatedBy"],
  performedBy: r.performedBy as DeclaredChannel["performedBy"],
  publishedAt: iso(r.publishedAt),
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const legOf = (r: LegRow): DeclaredLeg => ({
  ...r,
  fromStep: r.fromStep as DeclaredLeg["fromStep"],
  toStep: r.toStep as DeclaredLeg["toStep"],
  mode: r.mode as DeclaredLeg["mode"],
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const triggerOf = (r: TriggerRow): TriggerTypeRecord => ({
  id: r.id,
  label: r.label,
  description: r.description,
  icon: r.icon,
  fromStep: r.fromStep,
  firedBy: r.firedBy,
  coded: r.coded,
  origin: r.origin as TriggerTypeRecord["origin"],
  kind: r.kind as TriggerTypeRecord["kind"],
  params: (r.params as Record<string, unknown> | null) ?? null,
  displayOrder: r.displayOrder,
  createdBy: r.createdBy,
  requestedByOrgId: r.requestedByOrgId,
});

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────────

export async function listTriggerTypes(): Promise<TriggerTypeRecord[]> {
  return (await db.select().from(channelTriggerTypes).orderBy(asc(channelTriggerTypes.displayOrder))).map(triggerOf);
}

export async function listDeclaredChannels(): Promise<DeclaredChannel[]> {
  return (await db.select().from(declaredChannels).orderBy(asc(declaredChannels.displayOrder))).map(channelOf);
}

export async function listDeclaredLegs(): Promise<DeclaredLeg[]> {
  return (await db.select().from(declaredChannelLegs).orderBy(asc(declaredChannelLegs.createdAt))).map(legOf);
}

export async function listDeclaredSalesPaths(): Promise<DeclaredSalesPath[]> {
  return (await db.select().from(declaredSalesPaths).orderBy(asc(declaredSalesPaths.createdAt))).map((r) => ({
    combinationKey: r.combinationKey,
    legs: r.legs as DeclaredSalesPathLeg[],
    createdBy: r.createdBy,
    requestedByOrgId: r.requestedByOrgId,
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface LoadedCatalogue {
  channels: PublicChannel[];
  declared: { channels: DeclaredChannel[]; legs: DeclaredLeg[]; triggers: TriggerTypeRecord[] };
}

/**
 * THE catalogue: every active feature row + every declaration. `publishedOnly` on every client read (the
 * public catalogue, the offer sales paths); the internal declaration reads see everything.
 */
export async function loadChannelCatalogue(opts: { publishedOnly: boolean }): Promise<LoadedCatalogue> {
  const [rows, channels, legs, triggers] = await Promise.all([
    db.query.features.findMany({ where: eq(features.status, "active") }),
    listDeclaredChannels(),
    listDeclaredLegs(),
    listTriggerTypes(),
  ]);
  const declared = { channels, legs, triggers };
  const merged = mergeDeclarations(rows, declared, opts, { shortDescriptionOf: channelShortDescription, channelTypeOfSlug: channelTypeOf });
  return { channels: buildChannelCatalogue(merged.rows, merged.shortDescriptionOf, merged.channelTypeOfSlug, merged.triggerOf), declared };
}

/** Every slug and (lower-cased) name already taken by a feature (any status) or a declared channel. */
export async function takenChannelIdentities(): Promise<{ slugs: Set<string>; names: Set<string> }> {
  const [rows, channels] = await Promise.all([
    db.query.features.findMany({ columns: { slug: true, name: true } }),
    listDeclaredChannels(),
  ]);
  return {
    slugs: new Set([...rows.map((r) => r.slug), ...channels.map((c) => c.slug)]),
    names: new Set([...rows.map((r) => r.name.toLowerCase()), ...channels.map((c) => c.name.toLowerCase())]),
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────────────────────────────

/** After every seeded channel (display orders are small integers), in creation order. */
const DECLARED_DISPLAY_ORDER_BASE = 10_000;

export async function insertChannel(input: ChannelInput, createdBy: string, requestedByOrgId: string | null): Promise<DeclaredChannel> {
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${declaredChannels.displayOrder}) + 1, ${DECLARED_DISPLAY_ORDER_BASE})::int` })
    .from(declaredChannels);
  const [row] = await db
    .insert(declaredChannels)
    .values({ ...input, displayOrder: next, published: false, createdBy, requestedByOrgId })
    .returning();
  return channelOf(row);
}

export async function updateChannel(slug: string, patch: ChannelPatch, updatedBy: string, current: DeclaredChannel): Promise<DeclaredChannel> {
  const publishing = patch.published === true && !current.published;
  const unpublishing = patch.published === false && current.published;
  const [row] = await db
    .update(declaredChannels)
    .set({
      ...patch,
      ...(publishing ? { publishedAt: new Date(), publishedBy: updatedBy } : {}),
      ...(unpublishing ? { publishedAt: null, publishedBy: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(declaredChannels.slug, slug))
    .returning();
  return channelOf(row);
}

export async function insertLeg(channelSlug: string, input: LegInput, createdBy: string, requestedByOrgId: string | null): Promise<DeclaredLeg> {
  const [row] = await db
    .insert(declaredChannelLegs)
    .values({ channelSlug, ...input, published: false, createdBy, requestedByOrgId })
    .returning();
  return legOf(row);
}

export async function updateLeg(
  channelSlug: string,
  legKey: string,
  patch: Partial<Pick<DeclaredLeg, "published" | "mode" | "triggerId">>,
): Promise<DeclaredLeg> {
  const [row] = await db
    .update(declaredChannelLegs)
    .set({ ...patch, updatedAt: new Date() })
    .where(sql`${declaredChannelLegs.channelSlug} = ${channelSlug} AND ${declaredChannelLegs.legKey} = ${legKey}`)
    .returning();
  return legOf(row);
}

export async function insertTrigger(input: TriggerInput, createdBy: string, requestedByOrgId: string | null): Promise<TriggerTypeRecord> {
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${channelTriggerTypes.displayOrder}) + 1, 0)::int` })
    .from(channelTriggerTypes);
  const [row] = await db
    .insert(channelTriggerTypes)
    .values({
      id: input.id,
      label: input.label,
      description: input.description,
      icon: input.icon,
      fromStep: input.fromStep,
      firedBy: input.firedBy,
      // A declared trigger never claims a detector; `isTriggerCoded` reads its KIND.
      coded: false,
      displayOrder: next,
      origin: "declared",
      kind: input.kind,
      params: input.params,
      createdBy,
      requestedByOrgId,
    })
    .returning();
  return triggerOf(row);
}

export async function updateTrigger(id: string, patch: TriggerPatch): Promise<TriggerTypeRecord> {
  const [row] = await db
    .update(channelTriggerTypes)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(channelTriggerTypes.id, id))
    .returning();
  return triggerOf(row);
}

export async function insertSalesPath(
  combinationKey: string,
  legs: DeclaredSalesPathLeg[],
  createdBy: string,
  requestedByOrgId: string | null,
): Promise<DeclaredSalesPath> {
  const [row] = await db.insert(declaredSalesPaths).values({ combinationKey, legs, createdBy, requestedByOrgId }).returning();
  return { combinationKey: row.combinationKey, legs: row.legs as DeclaredSalesPathLeg[], createdBy: row.createdBy, requestedByOrgId: row.requestedByOrgId, createdAt: row.createdAt.toISOString() };
}
