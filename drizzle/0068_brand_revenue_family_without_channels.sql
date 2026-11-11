-- MON-PAGE-SPEED-1111: `channels` joined the view-cache fingerprint parts (`familyKeyOf`), so a brand revenue
-- cell's family no longer carries it. Stored rows are re-keyed so the brand's newest cell is found before
-- its campaign list is read (`latestFamilyCellJson`). `channels` is never the first part (`channelSpend`
-- sorts before it), so it always follows a `&`.
UPDATE "feature_view_snapshots"
SET "family_key" = regexp_replace("family_key", '&channels=[^&]*', '')
WHERE "view" = 'brand-revenue' AND "family_key" LIKE '%&channels=%';
