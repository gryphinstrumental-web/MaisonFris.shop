-- ============================================
-- Pavian Exchange - Supabase Database Schema
-- Run this in: Supabase Dashboard > SQL Editor
-- ============================================

-- 1. PROFILES TABLE (linked to Supabase Auth)
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    discord_username TEXT,
    discord_avatar TEXT,
    minecraft_ign TEXT,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO profiles (id, discord_username, discord_avatar)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', 'Unknown'),
        NEW.raw_user_meta_data->>'avatar_url'
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- 2. EQUITIES TABLE
CREATE TABLE equities (
    id SERIAL PRIMARY KEY,
    ticker TEXT UNIQUE NOT NULL,
    company_name TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. ORDER BOOK TABLE (the live inventory)
CREATE TABLE order_book (
    id SERIAL PRIMARY KEY,
    equity_id INTEGER NOT NULL REFERENCES equities(id) ON DELETE CASCADE,
    side TEXT NOT NULL CHECK (side IN ('bid', 'ask')),
    price NUMERIC NOT NULL CHECK (price > 0),
    quantity_available INTEGER NOT NULL CHECK (quantity_available >= 0),
    tier INTEGER NOT NULL DEFAULT 1
);

-- 4. ORDERS TABLE
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profiles(id),
    equity_id INTEGER NOT NULL REFERENCES equities(id),
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    price NUMERIC NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    minecraft_ign TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- 5. TRANSACTIONS TABLE (created on approval)
CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    equity_id INTEGER NOT NULL REFERENCES equities(id),
    user_id UUID NOT NULL REFERENCES profiles(id),
    side TEXT NOT NULL,
    price NUMERIC NOT NULL,
    quantity INTEGER NOT NULL,
    executed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE equities ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_book ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read/update their own
CREATE POLICY "Public profiles are viewable by everyone"
    ON profiles FOR SELECT USING (true);

CREATE POLICY "Users can update own profile"
    ON profiles FOR UPDATE USING (auth.uid() = id);

-- Equities: everyone can read, admin can modify
CREATE POLICY "Equities are viewable by everyone"
    ON equities FOR SELECT USING (true);

CREATE POLICY "Admins can manage equities"
    ON equities FOR ALL USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
    );

-- Order book: everyone can read, admin can modify
CREATE POLICY "Order book is viewable by everyone"
    ON order_book FOR SELECT USING (true);

CREATE POLICY "Admins can manage order book"
    ON order_book FOR ALL USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
    );

-- Orders: users can insert their own and read their own, admins can read/update all
CREATE POLICY "Users can create their own orders"
    ON orders FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view their own orders"
    ON orders FOR SELECT USING (
        auth.uid() = user_id OR
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
    );

CREATE POLICY "Admins can update orders"
    ON orders FOR UPDATE USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
    );

-- Transactions: users can read their own, admins can read all
CREATE POLICY "Users can view their own transactions"
    ON transactions FOR SELECT USING (
        auth.uid() = user_id OR
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
    );

CREATE POLICY "Admins can insert transactions"
    ON transactions FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
    );

-- ============================================
-- TRIGGER: Auto-handle order approval
-- When an order status changes to 'approved':
--   1. Decrease quantity_available in order_book
--   2. Create a transaction record
--   3. Set resolved_at timestamp
-- ============================================

CREATE OR REPLACE FUNCTION handle_order_approval()
RETURNS TRIGGER AS $$
DECLARE
    book_side TEXT;
BEGIN
    -- Only act when status changes to 'approved'
    IF NEW.status = 'approved' AND OLD.status != 'approved' THEN
        -- Determine which side of the order book to decrement
        -- If user is buying, decrement the 'ask' side
        -- If user is selling, decrement the 'bid' side
        IF NEW.side = 'buy' THEN
            book_side := 'ask';
        ELSE
            book_side := 'bid';
        END IF;

        -- Decrement quantity in order book (find matching price tier)
        UPDATE order_book
        SET quantity_available = GREATEST(quantity_available - NEW.quantity, 0)
        WHERE equity_id = NEW.equity_id
          AND side = book_side
          AND price = NEW.price;

        -- Create transaction record
        INSERT INTO transactions (order_id, equity_id, user_id, side, price, quantity)
        VALUES (NEW.id, NEW.equity_id, NEW.user_id, NEW.side, NEW.price, NEW.quantity);

        -- Set resolved timestamp
        NEW.resolved_at := NOW();
    END IF;

    -- Handle rejection
    IF NEW.status = 'rejected' AND OLD.status != 'rejected' THEN
        NEW.resolved_at := NOW();
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_order_status_change
    BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION handle_order_approval();

-- ============================================
-- ENABLE REALTIME on order_book
-- ============================================

ALTER PUBLICATION supabase_realtime ADD TABLE order_book;

-- ============================================
-- SEED DATA
-- ============================================

INSERT INTO equities (ticker, company_name) VALUES
    ('$TUSK', 'Tusk Armory'),         -- id 1
    ('$AGOR', 'Agora Corporation'),    -- id 2
    ('$MG', 'Monument Group'),         -- id 3
    ('$PVTC', 'Pan-Voldi Trading Corporation'), -- id 4
    ('$ZEAL', 'Zeal Corp'),           -- id 5
    ('$SETF', 'Starboard ETF'),       -- id 6
    ('$GW', 'Gabon & Westmore'),      -- id 7
    ('$NORD', 'Nord Co.'),            -- id 8
    ('$LYRA', 'Lyrean Rail'),         -- id 9
    ('$RAC', 'Royal Anvard Corporation'); -- id 10

-- Order book: bid = what you buy at, ask = what you sell at
INSERT INTO order_book (equity_id, side, price, quantity_available, tier) VALUES
    -- $TUSK: Buy 500 x1, Sell 250 x1
    (1, 'bid', 500, 1, 1),
    (1, 'ask', 250, 1, 1),
    -- $AGOR: No bid, Sell 80 x1
    (2, 'ask', 80, 1, 1),
    -- $MG: Buy 1200 x1, Sell 1000 x1
    (3, 'bid', 1200, 1, 1),
    (3, 'ask', 1000, 1, 1),
    -- $PVTC: Buy 90 x5, Sell 120 x5
    (4, 'bid', 90, 5, 1),
    (4, 'ask', 120, 5, 1),
    -- $ZEAL: Buy 700 x1, Sell 500 x1
    (5, 'bid', 700, 1, 1),
    (5, 'ask', 500, 1, 1),
    -- $SETF: No bid, Sell 400 x1
    (6, 'ask', 400, 1, 1),
    -- $GW: No bid, Sell 50 x1
    (7, 'ask', 50, 1, 1),
    -- $NORD: No bid, Sell 200 x1
    (8, 'ask', 200, 1, 1),
    -- $LYRA: No bid, Sell 400 x1
    (9, 'ask', 400, 1, 1),
    -- $RAC: Buy 500 x1, Sell 300 x1
    (10, 'bid', 500, 1, 1),
    (10, 'ask', 300, 1, 1);
