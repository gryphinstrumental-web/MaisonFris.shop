-- ============================================
-- Price Analysis Tables
-- ============================================

-- Snapshot metadata (one row per Tradex pull)
CREATE TABLE tradex_snapshots (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    taken_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    total_exchanges INTEGER NOT NULL,
    stocked_exchanges INTEGER NOT NULL,
    unique_pairs    INTEGER NOT NULL,
    taken_by        UUID
);

CREATE INDEX idx_ts_taken_at ON tradex_snapshots(taken_at DESC);

-- Aggregated commodity prices per snapshot
CREATE TABLE tradex_trade_prices (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    snapshot_id     UUID NOT NULL REFERENCES tradex_snapshots(id) ON DELETE CASCADE,
    commodity       TEXT NOT NULL,
    side            TEXT NOT NULL CHECK (side IN ('buy', 'sell', 'barter')),
    price_d         NUMERIC,
    is_compacted    BOOLEAN DEFAULT false,
    enchants        TEXT DEFAULT '',
    commodity_in    TEXT,
    commodity_out   TEXT,
    avg_price       NUMERIC,
    min_price       NUMERIC,
    max_price       NUMERIC,
    num_listings    INTEGER NOT NULL,
    total_stock     INTEGER NOT NULL,
    ratio           NUMERIC
);

CREATE INDEX idx_ttp_snapshot ON tradex_trade_prices(snapshot_id);
CREATE INDEX idx_ttp_commodity_side ON tradex_trade_prices(commodity, side);
CREATE INDEX idx_ttp_snapshot_commodity ON tradex_trade_prices(snapshot_id, commodity);

-- RLS policies (admin-only)
ALTER TABLE tradex_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradex_trade_prices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin read snapshots" ON tradex_snapshots FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
);
CREATE POLICY "Admin insert snapshots" ON tradex_snapshots FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
);
CREATE POLICY "Admin delete snapshots" ON tradex_snapshots FOR DELETE USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

CREATE POLICY "Admin read prices" ON tradex_trade_prices FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
);
CREATE POLICY "Admin insert prices" ON tradex_trade_prices FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
);
CREATE POLICY "Admin delete prices" ON tradex_trade_prices FOR DELETE USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
);
