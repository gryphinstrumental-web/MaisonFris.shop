-- Shop/property boundary polygons drawn on the registry map.
-- Stored as a JSON array of [x, z] block-corner pairs, e.g. [[-3270, 8225], [-3260, 8225], [-3260, 8240]].
-- Run this in: Supabase Dashboard > SQL Editor

ALTER TABLE nc_properties ADD COLUMN IF NOT EXISTS boundary JSONB;
