-- INDEX-SLUGS-SEO-1019 (owner 2026-10-19): the public fleet indexes move off the "sceo-" prefix onto SEO slugs.
-- Every recorded day is carried to the new slug; a day the new slug already holds keeps the new row.
UPDATE "fleet_index_points" AS p SET "index_slug" = m."new_slug"
FROM (VALUES
	('sceo-cost-per-click', 'cold-email-cost-per-click'),
	('sceo-click-rate', 'cold-email-click-rate'),
	('sceo-cost-per-interest', 'cold-email-cost-per-positive-reply'),
	('sceo-interest-rate', 'cold-email-positive-reply-rate'),
	('sceo-cost-per-meeting', 'cold-email-cost-per-meeting'),
	('sceo-meeting-rate', 'cold-email-meeting-rate')
) AS m("old_slug", "new_slug")
WHERE p."index_slug" = m."old_slug"
	AND NOT EXISTS (SELECT 1 FROM "fleet_index_points" q WHERE q."index_slug" = m."new_slug" AND q."day" = p."day");
--> statement-breakpoint
DELETE FROM "fleet_index_points" WHERE "index_slug" LIKE 'sceo-%';
