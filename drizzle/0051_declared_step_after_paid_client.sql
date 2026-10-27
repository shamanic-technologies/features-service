-- CLIENT-SATISFIED-1027 (owner 2026-10-27): a step reached only AFTER Paid client ("Client Satisfied") leads to no
-- step on the way to a paid client, so a declared step may state no toward step: it then has no value (null), never a
-- made-up share of a paying client's value.
ALTER TABLE "declared_steps" ALTER COLUMN "toward_step" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "declared_steps" ALTER COLUMN "toward_rate_pct" DROP NOT NULL;
