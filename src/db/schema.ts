import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const features = pgTable(
  "features",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull().unique(),
    description: text("description").notNull(),
    icon: text("icon").notNull(),
    implemented: boolean("implemented").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    status: text("status").notNull().default("active"),
    inputs: jsonb("inputs").notNull(),
    outputs: jsonb("outputs").notNull(),
    charts: jsonb("charts").notNull(),
    entities: jsonb("entities").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_features_slug").on(table.slug),
    uniqueIndex("idx_features_name").on(table.name),
  ]
);

export type Feature = typeof features.$inferSelect;
