-- Dissolution of the New Callisto Property Trust (2026-08-08)
-- Trust balance of 492.33d was paid out in full: 475d of deposits refunded
-- plus a 17.33d surplus distributed pro-rata. Final ledger for the record:
--
--   Smagz          HS-6660   103.65d  (Headstone Flower Corp + Voxel)
--   Eledion        HS-8230    51.83d  (Karydian Goods)
--   Ghost_EXP      HS-4560    51.83d  (Oinkers Inc.)
--   oldman77s      HS-3023    51.83d  (Avalon General)
--   randomguys0101 HS-9762    51.82d  (Random's Shop of Randomness)
--   trottem        HS-9644    51.82d  (Devil's Due)
--   ripoffpingu    (direct)   51.82d  (Spider Bites Cafe)
--   zanzirbibley   (direct)   51.82d  (Big Digs)
--   e_mac_         (direct)   25.91d  (Ewan)
--
-- The trust_deposit column is no longer used anywhere in the site.

ALTER TABLE nc_properties DROP COLUMN IF EXISTS trust_deposit;
