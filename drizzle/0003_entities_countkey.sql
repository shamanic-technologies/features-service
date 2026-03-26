-- Migrate entities column from string[] to {name, countKey?}[] format
-- Each string "foo" becomes {"name": "foo"}
UPDATE "features"
SET "entities" = (
  SELECT jsonb_agg(jsonb_build_object('name', elem.value #>> '{}'))
  FROM jsonb_array_elements("entities") AS elem(value)
  WHERE jsonb_typeof(elem.value) = 'string'
)
WHERE jsonb_typeof("entities"->0) = 'string';
