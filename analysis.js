// ============================================
// Price Analysis — Market Research (Admin only)
// ============================================

const ANLYS_DB_NAME = 'mf_analysis';
const ANLYS_DB_VERSION = 1;
const ANLYS_AUTO_INTERVAL = 30 * 60 * 1000; // 30 minutes
const ANLYS_RETENTION_DAYS = 90;

let anlysCurrentTab = 'snapshots';
let anlysAutoTimerId = null;
let anlysSnapshots = [];        // metadata from Supabase
let anlysCommodityData = [];    // latest snapshot's trade prices
let anlysRawListings = {};      // { "commodity|enchants": [{price, x, y, z, city, stock, time, side}] }
let anlysSortCol = 'commodity';
let anlysSortAsc = true;

// Diamond-type materials for price normalization
// Tradex API uses "Block of X" naming (not "X Block")
const DIAMOND_TYPES = { 'Diamond': 1, 'Diamond Block': 9, 'Block of Diamond': 9 };
const BLOCK_MULTIPLIERS = {
    'Diamond Block': 9, 'Block of Diamond': 9,
    'Iron Block': 9, 'Block of Iron': 9,
    'Gold Block': 9, 'Block of Gold': 9,
    'Emerald Block': 9, 'Block of Emerald': 9,
    'Lapis Lazuli Block': 9, 'Block of Lapis Lazuli': 9,
    'Redstone Block': 9, 'Block of Redstone': 9,
    'Copper Block': 9, 'Block of Copper': 9,
};

// Ticker commodities — key exchange rates shown at top of commodity browser
// Include both naming variants so we match whichever the API uses
const TICKER_COMMODITIES = [
    { label: 'Iron Ingot', names: ['Iron Ingot'] },
    { label: 'Gold Block', names: ['Gold Block', 'Block of Gold'] },
    { label: 'Emerald Block', names: ['Emerald Block', 'Block of Emerald'] },
    { label: 'Ancient Debris', names: ['Ancient Debris'] },
];

// ============================================
// IndexedDB Helpers
// ============================================
function anlysOpenDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(ANLYS_DB_NAME, ANLYS_DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('snapshots')) {
                const store = db.createObjectStore('snapshots', { keyPath: 'id' });
                store.createIndex('taken_at', 'taken_at', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function anlysSaveRawSnapshot(id, takenAt, exchanges) {
    const db = await anlysOpenDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('snapshots', 'readwrite');
        tx.objectStore('snapshots').put({ id, taken_at: takenAt, exchanges });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function anlysGetRawSnapshot(id) {
    const db = await anlysOpenDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('snapshots', 'readonly');
        const req = tx.objectStore('snapshots').get(id);
        req.onsuccess = () => { db.close(); resolve(req.result); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

async function anlysListRawSnapshots() {
    const db = await anlysOpenDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('snapshots', 'readonly');
        const req = tx.objectStore('snapshots').getAll();
        req.onsuccess = () => {
            db.close();
            resolve((req.result || []).map(s => ({ id: s.id, taken_at: s.taken_at, count: s.exchanges?.length || 0 })));
        };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

async function anlysDeleteRawSnapshot(id) {
    const db = await anlysOpenDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('snapshots', 'readwrite');
        tx.objectStore('snapshots').delete(id);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function anlysPruneOldSnapshots() {
    const cutoff = Date.now() - ANLYS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const all = await anlysListRawSnapshots();
    for (const s of all) {
        if (new Date(s.taken_at).getTime() < cutoff) {
            await anlysDeleteRawSnapshot(s.id);
        }
    }
}

// ============================================
// Price Normalization
// ============================================
function anlysEffectiveCount(item) {
    if (!item) return 1;
    let count = item.count || 1;
    // Compacted = 64x base
    if (ncIsCompacted(item)) count *= 64;
    // NOTE: Block multipliers NOT applied here — diamond blocks are already
    // handled by anlysDiamondCount(). Applying 9x to non-diamond blocks
    // (emerald, iron, gold) would show "per-ingot" price under the block name,
    // which is confusing. Blocks are their own commodity at full-block price.
    return count;
}

function anlysDiamondCount(item) {
    if (!item) return null;
    const mat = item.material;
    if (mat === 'Diamond') {
        let c = item.count || 1;
        if (ncIsCompacted(item)) c *= 64;
        return c;
    }
    if (mat === 'Diamond Block' || mat === 'Block of Diamond') {
        let c = (item.count || 1) * 9;
        if (ncIsCompacted(item)) c *= 64;
        return c;
    }
    return null;
}

function anlysIsDiamond(mat) {
    return mat === 'Diamond' || mat === 'Diamond Block' || mat === 'Block of Diamond';
}

function anlysCommodityKey(item) {
    if (!item) return '?';
    let name = item.customName || item.material || '?';
    const ench = ncEnchantStr(item);
    if (ench) name += ' [' + ench + ']';
    return name;
}

function anlysMedian(sortedArr) {
    const n = sortedArr.length;
    if (n === 0) return 0;
    const mid = Math.floor(n / 2);
    return n % 2 ? sortedArr[mid] : (sortedArr[mid - 1] + sortedArr[mid]) / 2;
}

// ============================================
// Aggregation Pipeline (Two-Pass Diamond Normalization)
// ============================================
function anlysAggregateExchanges(exchanges) {
    const groups = {};
    let stocked = 0;
    const nonDiamondTrades = [];

    // ---- Pass 1: Direct diamond trades ----
    // Build a price lookup so we can derive diamond prices for non-diamond trades
    const directPrices = {}; // { commodityKey: [diamondPrices] }

    for (const e of exchanges) {
        if (!e.input?.material || !e.output?.material) continue;
        if (e.stock > 0) stocked++;

        const inDiamonds = anlysDiamondCount(e.input);
        const outDiamonds = anlysDiamondCount(e.output);

        if (inDiamonds != null && !anlysIsDiamond(e.output.material)) {
            // Customer BUYS commodity with diamonds
            const commodity = anlysCommodityKey(e.output);
            const effectiveOut = anlysEffectiveCount(e.output);
            const priceD = inDiamonds / effectiveOut;
            const enchants = ncEnchantStr(e.output);
            const compacted = ncIsCompacted(e.output);
            const key = `${commodity}|buy|${enchants}|${compacted}`;
            if (!groups[key]) groups[key] = { commodity, side: 'buy', enchants, is_compacted: compacted, commodity_in: e.input.material, commodity_out: e.output.material, prices: [], stocks: [] };
            groups[key].prices.push(priceD);
            groups[key].stocks.push(e.stock || 0);
            // Track for lookup
            if (!directPrices[commodity]) directPrices[commodity] = [];
            directPrices[commodity].push(priceD);
        } else if (outDiamonds != null && !anlysIsDiamond(e.input.material)) {
            // Customer SELLS commodity for diamonds
            const commodity = anlysCommodityKey(e.input);
            const effectiveIn = anlysEffectiveCount(e.input);
            const priceD = outDiamonds / effectiveIn;
            const enchants = ncEnchantStr(e.input);
            const compacted = ncIsCompacted(e.input);
            const key = `${commodity}|sell|${enchants}|${compacted}`;
            if (!groups[key]) groups[key] = { commodity, side: 'sell', enchants, is_compacted: compacted, commodity_in: e.input.material, commodity_out: e.output.material, prices: [], stocks: [] };
            groups[key].prices.push(priceD);
            groups[key].stocks.push(e.stock || 0);
            // Track for lookup
            if (!directPrices[commodity]) directPrices[commodity] = [];
            directPrices[commodity].push(priceD);
        } else if (!anlysIsDiamond(e.input.material) && !anlysIsDiamond(e.output.material)) {
            // Non-diamond trade — defer to pass 2
            nonDiamondTrades.push(e);
        }
    }

    // Build median diamond price lookup from pass 1 (median is immune to outliers)
    const avgLookup = {};
    for (const [commodity, rawPrices] of Object.entries(directPrices)) {
        const sorted = rawPrices.slice().sort((a, b) => a - b);
        avgLookup[commodity] = anlysMedian(sorted);
    }

    // ---- Pass 2: Derive diamond prices for non-diamond trades ----
    for (const e of nonDiamondTrades) {
        const inCommodity = anlysCommodityKey(e.input);
        const outCommodity = anlysCommodityKey(e.output);
        const inPrice = avgLookup[inCommodity];
        const outPrice = avgLookup[outCommodity];
        const effectiveIn = anlysEffectiveCount(e.input);
        const effectiveOut = anlysEffectiveCount(e.output);

        if (inPrice != null) {
            // Value input in diamonds → derive output buy price
            const priceD = (effectiveIn * inPrice) / effectiveOut;
            const commodity = outCommodity;
            const enchants = ncEnchantStr(e.output);
            const compacted = ncIsCompacted(e.output);
            const key = `${commodity}|buy|${enchants}|${compacted}`;
            if (!groups[key]) groups[key] = { commodity, side: 'buy', enchants, is_compacted: compacted, commodity_in: e.input.material, commodity_out: e.output.material, prices: [], stocks: [] };
            groups[key].prices.push(priceD);
            groups[key].stocks.push(e.stock || 0);
        } else if (outPrice != null) {
            // Value output in diamonds → derive input sell price
            const priceD = (effectiveOut * outPrice) / effectiveIn;
            const commodity = inCommodity;
            const enchants = ncEnchantStr(e.input);
            const compacted = ncIsCompacted(e.input);
            const key = `${commodity}|sell|${enchants}|${compacted}`;
            if (!groups[key]) groups[key] = { commodity, side: 'sell', enchants, is_compacted: compacted, commodity_in: e.input.material, commodity_out: e.output.material, prices: [], stocks: [] };
            groups[key].prices.push(priceD);
            groups[key].stocks.push(e.stock || 0);
        }
        // If neither side has a known diamond price, trade is excluded
    }

    // ---- Compute aggregates (median price — immune to outliers/troll listings) ----
    const results = [];
    for (const g of Object.values(groups)) {
        const prices = g.prices.sort((a, b) => a - b);
        const n = prices.length;
        const med = anlysMedian(prices);
        results.push({
            commodity: g.commodity,
            side: g.side,
            price_d: med,
            enchants: g.enchants || '',
            is_compacted: g.is_compacted || false,
            commodity_in: g.commodity_in,
            commodity_out: g.commodity_out,
            avg_price: med,
            min_price: prices[0],
            max_price: prices[n - 1],
            num_listings: n,
            total_stock: g.stocks.reduce((a, b) => a + b, 0),
            ratio: null
        });
    }

    return { results, stocked, uniquePairs: results.length };
}

// Build per-listing data from raw exchanges (with city/location info)
function anlysBuildRawListings(exchanges) {
    const listings = {};
    const directPrices = {};

    // Pass 1: direct diamond trades
    for (const e of exchanges) {
        if (!e.input?.material || !e.output?.material) continue;
        const inD = anlysDiamondCount(e.input);
        const outD = anlysDiamondCount(e.output);
        const city = (typeof terminalClosestCity === 'function') ? terminalClosestCity(e.pos.x, e.pos.z).name : 'Unknown';
        const time = e.time || 0;

        if (inD != null && !anlysIsDiamond(e.output.material)) {
            const commodity = anlysCommodityKey(e.output);
            const enchants = ncEnchantStr(e.output);
            const effectiveOut = anlysEffectiveCount(e.output);
            const priceD = inD / effectiveOut;
            const key = `${commodity}|${enchants}`;
            if (!listings[key]) listings[key] = [];
            listings[key].push({ price: priceD, x: e.pos.x, y: e.pos.y, z: e.pos.z, city, stock: e.stock || 0, time, side: 'buy' });
            if (!directPrices[commodity]) directPrices[commodity] = [];
            directPrices[commodity].push(priceD);
        } else if (outD != null && !anlysIsDiamond(e.input.material)) {
            const commodity = anlysCommodityKey(e.input);
            const enchants = ncEnchantStr(e.input);
            const effectiveIn = anlysEffectiveCount(e.input);
            const priceD = outD / effectiveIn;
            const key = `${commodity}|${enchants}`;
            if (!listings[key]) listings[key] = [];
            listings[key].push({ price: priceD, x: e.pos.x, y: e.pos.y, z: e.pos.z, city, stock: e.stock || 0, time, side: 'sell' });
            if (!directPrices[commodity]) directPrices[commodity] = [];
            directPrices[commodity].push(priceD);
        }
    }

    // Pass 2: non-diamond trades (derive via lookup)
    const avgLookup = {};
    for (const [c, p] of Object.entries(directPrices)) {
        const sorted = p.slice().sort((a, b) => a - b);
        avgLookup[c] = anlysMedian(sorted);
    }
    for (const e of exchanges) {
        if (!e.input?.material || !e.output?.material) continue;
        if (anlysIsDiamond(e.input.material) || anlysIsDiamond(e.output.material)) continue;
        const inC = anlysCommodityKey(e.input);
        const outC = anlysCommodityKey(e.output);
        const inP = avgLookup[inC];
        const outP = avgLookup[outC];
        const city = (typeof terminalClosestCity === 'function') ? terminalClosestCity(e.pos.x, e.pos.z).name : 'Unknown';
        const time = e.time || 0;

        if (inP != null) {
            const commodity = outC;
            const enchants = ncEnchantStr(e.output);
            const effectiveOut = anlysEffectiveCount(e.output);
            const effectiveIn = anlysEffectiveCount(e.input);
            const priceD = (effectiveIn * inP) / effectiveOut;
            const key = `${commodity}|${enchants}`;
            if (!listings[key]) listings[key] = [];
            listings[key].push({ price: priceD, x: e.pos.x, y: e.pos.y, z: e.pos.z, city, stock: e.stock || 0, time, side: 'buy' });
        } else if (outP != null) {
            const commodity = inC;
            const enchants = ncEnchantStr(e.input);
            const effectiveOut = anlysEffectiveCount(e.output);
            const effectiveIn = anlysEffectiveCount(e.input);
            const priceD = (effectiveOut * outP) / effectiveIn;
            const key = `${commodity}|${enchants}`;
            if (!listings[key]) listings[key] = [];
            listings[key].push({ price: priceD, x: e.pos.x, y: e.pos.y, z: e.pos.z, city, stock: e.stock || 0, time, side: 'sell' });
        }
    }
    return listings;
}

// ============================================
// Snapshot Capture
// ============================================
async function analysisTakeSnapshot(statusEl) {
    const id = crypto.randomUUID();
    const takenAt = new Date().toISOString();

    if (statusEl) statusEl.textContent = 'Fetching Tradex data...';

    // Use shared cache, force refresh to get fresh data
    await tradexEnsureCache(true);
    const exchanges = tradexGetCached();

    if (statusEl) statusEl.textContent = `Got ${exchanges.length} exchanges. Saving raw data...`;

    // Store raw in IndexedDB
    await anlysSaveRawSnapshot(id, takenAt, exchanges);

    if (statusEl) statusEl.textContent = 'Aggregating prices...';

    // Aggregate
    const { results, stocked, uniquePairs } = anlysAggregateExchanges(exchanges);

    if (statusEl) statusEl.textContent = `Uploading ${results.length} price records to Supabase...`;

    // Insert snapshot metadata
    await fetch(`${CONFIG.supabaseUrl}/rest/v1/tradex_snapshots`, {
        method: 'POST',
        headers: restHeaders(),
        body: JSON.stringify({
            id, taken_at: takenAt,
            total_exchanges: exchanges.length,
            stocked_exchanges: stocked,
            unique_pairs: uniquePairs,
            taken_by: currentUser?.id || null
        })
    });

    // Bulk insert trade prices (batch in chunks of 200 to avoid payload limits)
    const rows = results.map(r => ({
        snapshot_id: id,
        commodity: r.commodity,
        side: r.side,
        price_d: r.price_d,
        is_compacted: r.is_compacted,
        enchants: r.enchants,
        commodity_in: r.commodity_in,
        commodity_out: r.commodity_out,
        avg_price: r.avg_price,
        min_price: r.min_price,
        max_price: r.max_price,
        num_listings: r.num_listings,
        total_stock: r.total_stock,
        ratio: null
    }));

    for (let i = 0; i < rows.length; i += 200) {
        await fetch(`${CONFIG.supabaseUrl}/rest/v1/tradex_trade_prices`, {
            method: 'POST',
            headers: restHeaders(),
            body: JSON.stringify(rows.slice(i, i + 200))
        });
    }

    if (statusEl) statusEl.textContent = `Snapshot complete: ${exchanges.length} exchanges, ${results.length} price records.`;

    // Prune old IndexedDB snapshots
    await anlysPruneOldSnapshots();

    return { id, takenAt, total: exchanges.length, stocked, uniquePairs, priceRows: results.length };
}

// ============================================
// Auto-Capture
// ============================================
function anlysStartAutoCapture() {
    if (anlysAutoTimerId) return;
    anlysAutoTimerId = setInterval(async () => {
        try {
            console.log('[Analysis] Auto-capture starting...');
            await analysisTakeSnapshot(null);
            console.log('[Analysis] Auto-capture complete.');
            if (anlysCurrentTab === 'snapshots') anlysRenderSnapshots();
        } catch (err) {
            console.error('[Analysis] Auto-capture failed:', err);
        }
    }, ANLYS_AUTO_INTERVAL);
}

function anlysStopAutoCapture() {
    if (anlysAutoTimerId) {
        clearInterval(anlysAutoTimerId);
        anlysAutoTimerId = null;
    }
}

// ============================================
// Main Entry
// ============================================
async function loadAnalysis() {
    const content = document.getElementById('analysisContent');
    if (!content) return;

    // Wire up tabs
    document.querySelectorAll('.anlys-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.anlys-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            anlysCurrentTab = tab.dataset.tab;
            anlysRenderCurrentTab();
        });
    });

    // Start auto-capture
    anlysStartAutoCapture();

    // Load initial tab
    await anlysRenderCurrentTab();
}

async function anlysRenderCurrentTab() {
    if (anlysCurrentTab === 'snapshots') await anlysRenderSnapshots();
    else if (anlysCurrentTab === 'commodities') await anlysRenderCommodities();
    else if (anlysCurrentTab === 'history') await anlysRenderHistory();
}

// ============================================
// Tab 1: Snapshot Manager
// ============================================
async function anlysRenderSnapshots() {
    const content = document.getElementById('analysisContent');
    content.innerHTML = '<div class="anlys-loading">Loading snapshots...</div>';

    try {
        // Get snapshots from Supabase
        anlysSnapshots = await supabaseRest('tradex_snapshots', 'select=*&order=taken_at.desc&limit=100');
        const localSnaps = await anlysListRawSnapshots();
        const localIds = new Set(localSnaps.map(s => s.id));

        let html = `
            <div class="anlys-actions">
                <button class="anlys-btn primary" id="anlysSnapBtn">Take Snapshot</button>
                <button class="anlys-btn" id="anlysExportBtn">Export Backup</button>
                <button class="anlys-btn" id="anlysImportBtn">Import Backup</button>
                <input type="file" id="anlysImportFile" accept=".json" style="display:none;">
                <span class="anlys-status" id="anlysSnapStatus">${anlysAutoTimerId ? 'Auto-capture: ON (hourly)' : 'Auto-capture: OFF'}</span>
                <button class="anlys-btn" id="anlysAutoToggle">${anlysAutoTimerId ? 'Stop Auto' : 'Start Auto'}</button>
            </div>
            <div class="anlys-snapshot-list">
        `;

        if (anlysSnapshots.length === 0) {
            html += '<div class="anlys-loading">No snapshots yet. Click "Take Snapshot" to capture market data.</div>';
        } else {
            for (const s of anlysSnapshots) {
                const dt = new Date(s.taken_at);
                const timeStr = dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString();
                const hasLocal = localIds.has(s.id);
                html += `
                    <div class="anlys-snapshot-row">
                        <span class="snap-time">${timeStr}</span>
                        <span class="snap-stat">${s.total_exchanges} exchanges</span>
                        <span class="snap-stat">${s.stocked_exchanges} stocked</span>
                        <span class="snap-stat">${s.unique_pairs} pairs</span>
                        <span class="snap-stat">${hasLocal ? 'raw: local' : 'raw: pruned'}</span>
                        <span class="snap-del" data-id="${s.id}">delete</span>
                    </div>
                `;
            }
        }
        html += '</div>';
        content.innerHTML = html;

        // Wire up buttons
        document.getElementById('anlysSnapBtn').addEventListener('click', async () => {
            const btn = document.getElementById('anlysSnapBtn');
            const status = document.getElementById('anlysSnapStatus');
            btn.disabled = true;
            btn.textContent = 'Capturing...';
            try {
                await analysisTakeSnapshot(status);
                await anlysRenderSnapshots();
            } catch (err) {
                status.textContent = 'Error: ' + err.message;
                console.error('Snapshot failed:', err);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Take Snapshot';
            }
        });

        document.getElementById('anlysAutoToggle').addEventListener('click', () => {
            if (anlysAutoTimerId) { anlysStopAutoCapture(); } else { anlysStartAutoCapture(); }
            anlysRenderSnapshots();
        });

        document.getElementById('anlysExportBtn').addEventListener('click', anlysExportBackup);

        document.getElementById('anlysImportBtn').addEventListener('click', () => {
            document.getElementById('anlysImportFile').click();
        });
        document.getElementById('anlysImportFile').addEventListener('change', anlysImportBackup);

        // Delete handlers
        content.querySelectorAll('.snap-del').forEach(el => {
            el.addEventListener('click', async () => {
                const id = el.dataset.id;
                if (!confirm('Delete this snapshot and its price data?')) return;
                try {
                    // Delete from Supabase (cascade deletes trade_prices)
                    await fetch(`${CONFIG.supabaseUrl}/rest/v1/tradex_snapshots?id=eq.${id}`, {
                        method: 'DELETE', headers: restHeaders()
                    });
                    // Delete from IndexedDB
                    await anlysDeleteRawSnapshot(id);
                    await anlysRenderSnapshots();
                } catch (err) {
                    console.error('Delete failed:', err);
                }
            });
        });
    } catch (err) {
        content.innerHTML = `<div class="anlys-loading">Error loading snapshots: ${err.message}</div>`;
    }
}

// ============================================
// Tab 2: Commodity Browser
// ============================================
async function anlysRenderCommodities() {
    const content = document.getElementById('analysisContent');
    content.innerHTML = '<div class="anlys-loading">Loading commodity data...</div>';

    try {
        // Load from live Tradex cache (shared with shop explorer)
        content.innerHTML = '<div class="anlys-loading">Fetching Tradex data...</div>';
        await tradexEnsureCache();
        const exchanges = tradexGetCached();
        if (!exchanges || !exchanges.length) {
            content.innerHTML = '<div class="anlys-loading">No exchange data available. Try refreshing.</div>';
            return;
        }

        // Build raw listings (per-listing with city info) and aggregated data
        anlysRawListings = anlysBuildRawListings(exchanges);
        const { results } = anlysAggregateExchanges(exchanges);
        anlysCommodityData = results;

        // Merge buy/sell into single rows per commodity
        anlysMergedData = anlysMergeForDisplay(anlysCommodityData);

        // Build ticker
        const tickerHtml = anlysRenderTicker(anlysMergedData);

        // Count unclassified items
        const uncatCount = anlysMergedData.filter(r => !r.category).length;
        const uncatNote = uncatCount > 0 ? ` <small style="color:var(--text-muted)">(${uncatCount} unclassified)</small>` : '';

        let html = `
            ${tickerHtml}
            <input type="text" class="um-search anlys-search" id="anlysCommoditySearch" placeholder="Search material name...">
            <div class="anlys-filters">
                <button class="anlys-btn anlys-filter-btn active" data-filter="all">All</button>
                <button class="anlys-btn anlys-filter-btn" data-filter="stocked">In Stock</button>
                <span style="border-left:1px solid var(--border);margin:0 0.3rem"></span>
                <button class="anlys-btn anlys-cat-btn" data-cat="xp" style="border-color:${ANLYS_CAT_COLORS.xp}">XP</button>
                <button class="anlys-btn anlys-cat-btn" data-cat="building" style="border-color:${ANLYS_CAT_COLORS.building}">Building</button>
                <button class="anlys-btn anlys-cat-btn" data-cat="tools" style="border-color:${ANLYS_CAT_COLORS.tools}">Tools/Armor</button>
                <button class="anlys-btn anlys-cat-btn" data-cat="currency" style="border-color:${ANLYS_CAT_COLORS.currency}">Currency</button>
                <button class="anlys-btn anlys-cat-btn" data-cat="ore" style="border-color:${ANLYS_CAT_COLORS.ore}">Ore</button>
                <button class="anlys-btn anlys-cat-btn" data-cat="food" style="border-color:${ANLYS_CAT_COLORS.food}">Food</button>
                <button class="anlys-btn anlys-cat-btn" data-cat="raw" style="border-color:${ANLYS_CAT_COLORS.raw}">Raw Materials</button>
                <button class="anlys-btn anlys-cat-btn" data-cat="aesthetics" style="border-color:${ANLYS_CAT_COLORS.aesthetics}">Aesthetics</button>
                <button class="anlys-btn anlys-cat-btn" data-cat="lore" style="border-color:${ANLYS_CAT_COLORS.lore}">Lore</button>
                <button class="anlys-btn anlys-cat-btn" data-cat="none">Uncat${uncatNote}</button>
                <span style="border-left:1px solid var(--border);margin:0 0.3rem"></span>
                <button class="anlys-btn anlys-farm-btn" data-farm="farmable">Farmable</button>
                <button class="anlys-btn anlys-farm-btn" data-farm="nonfarmable">Non-farm</button>
                <span style="border-left:1px solid var(--border);margin:0 0.3rem"></span>
                <button class="anlys-btn anlys-city-btn" data-city="Pavia">Pavia</button>
                <button class="anlys-btn anlys-city-btn" data-city="New Callisto">New Callisto</button>
            </div>
            <div id="anlysCommodityTable"></div>
        `;
        content.innerHTML = html;

        anlysSortCol = 'commodity';
        anlysSortAsc = true;
        anlysFilterCommodities();

        // Search handler
        document.getElementById('anlysCommoditySearch').addEventListener('input', anlysFilterCommodities);

        // Stock/all filter buttons
        content.querySelectorAll('.anlys-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const f = btn.dataset.filter;
                if (f === 'stocked') {
                    btn.classList.toggle('active');
                } else {
                    content.querySelectorAll('.anlys-filter-btn:not([data-filter="stocked"])').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                }
                anlysFilterCommodities();
            });
        });

        // Category filter buttons (toggle, multi-select)
        content.querySelectorAll('.anlys-cat-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.classList.toggle('active');
                anlysFilterCommodities();
            });
        });

        // Farmable filter buttons (toggle)
        content.querySelectorAll('.anlys-farm-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.classList.toggle('active');
                // Only one farmable filter at a time
                content.querySelectorAll('.anlys-farm-btn').forEach(b => { if (b !== btn) b.classList.remove('active'); });
                anlysFilterCommodities();
            });
        });

        // City filter buttons (toggle, single-select)
        content.querySelectorAll('.anlys-city-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.classList.toggle('active');
                content.querySelectorAll('.anlys-city-btn').forEach(b => { if (b !== btn) b.classList.remove('active'); });
                anlysFilterCommodities();
            });
        });
    } catch (err) {
        content.innerHTML = `<div class="anlys-loading">Error: ${err.message}</div>`;
    }
}

// Merge buy/sell rows into one row per commodity for display
// Uses anlysRawListings for city-specific prices (stocked only)
let anlysMergedData = [];
function anlysMergeForDisplay(data) {
    const merged = {};
    for (const r of data) {
        const key = `${r.commodity}|${r.enchants || ''}`;
        if (!merged[key]) {
            merged[key] = {
                commodity: r.commodity,
                enchants: r.enchants || '',
                is_compacted: r.is_compacted || false,
                weightedPrice: 0, totalListings: 0,
                totalStock: 0, primarySide: r.side
            };
        }
        const m = merged[key];
        m.weightedPrice += (r.avg_price || 0) * (r.num_listings || 1);
        m.totalListings += r.num_listings || 1;
        m.totalStock += r.total_stock || 0;
        if (r.side === 'buy' && (r.num_listings || 0) > 0) m.primarySide = 'buy';
    }
    return Object.values(merged).map(m => {
        const price = m.totalListings > 0 ? m.weightedPrice / m.totalListings : 0;
        const isSub1d = price > 0 && price < 1;
        const key = `${m.commodity}|${m.enchants}`;
        // Get stocked listings for city-specific prices
        const raw = (anlysRawListings[key] || []).filter(l => l.stock > 0);
        const buyListings = raw.filter(l => l.side === 'buy');
        // Best = cheapest stocked buy listing anywhere
        const cheapest = buyListings.length ? Math.min(...buyListings.map(l => l.price)) : null;
        // Pavia price = cheapest stocked buy in Pavia
        const paviaListings = buyListings.filter(l => l.city === 'Pavia');
        const paviaPrice = paviaListings.length ? Math.min(...paviaListings.map(l => l.price)) : null;
        // NC price = cheapest stocked buy in New Callisto
        const ncListings = buyListings.filter(l => l.city === 'New Callisto');
        const ncPrice = ncListings.length ? Math.min(...ncListings.map(l => l.price)) : null;

        return {
            commodity: m.commodity,
            enchants: m.enchants,
            is_compacted: m.is_compacted,
            raw_price: price,
            per_diamond: isSub1d ? 1 / price : 0,
            is_sub1d: isSub1d,
            cheapest_price: cheapest,
            pavia_price: paviaPrice,
            nc_price: ncPrice,
            category: anlysGetCategory(m.commodity),
            farmable: anlysIsFarmable(m.commodity),
            num_listings: m.totalListings,
            total_stock: m.totalStock,
            side: m.primarySide
        };
    });
}

function anlysRenderTicker(mergedData) {
    const items = [];
    for (const { label, names } of TICKER_COMMODITIES) {
        const matches = mergedData.filter(r => names.includes(r.commodity) && !r.enchants);
        if (matches.length) {
            const r = matches[0];
            let priceDisplay;
            if (r.is_sub1d) {
                priceDisplay = `${Math.round(r.per_diamond)}:1d`;
            } else {
                priceDisplay = `${anlysFormatPrice(r.raw_price)}d`;
            }
            items.push(`<span class="anlys-ticker-item"><span class="ticker-name">${anlysEscape(label)}</span> <span class="ticker-price">${priceDisplay}</span></span>`);
        } else {
            items.push(`<span class="anlys-ticker-item"><span class="ticker-name">${anlysEscape(label)}</span> <span class="ticker-nodata">no data</span></span>`);
        }
    }
    const inner = items.join('');
    // Repeat enough times to fill wide screens, then duplicate for seamless loop
    const set = inner.repeat(6);
    return `<div class="anlys-ticker-wrap"><div class="anlys-ticker"><span class="anlys-ticker-set">${set}</span><span class="anlys-ticker-set">${set}</span></div></div>`;
}

function anlysFilterCommodities() {
    const searchEl = document.getElementById('anlysCommoditySearch');
    const query = (searchEl?.value || '').toLowerCase().trim();
    const container = document.getElementById('anlysCommodityTable');
    if (!container) return;

    const stockedOnly = document.querySelector('.anlys-filter-btn[data-filter="stocked"]')?.classList.contains('active');

    // Category filters (multi-select)
    const activeCats = [];
    document.querySelectorAll('.anlys-cat-btn.active').forEach(b => activeCats.push(b.dataset.cat));

    // Farmable filter
    const farmBtn = document.querySelector('.anlys-farm-btn.active');
    const farmFilter = farmBtn ? farmBtn.dataset.farm : null;

    // City filter
    const cityBtn = document.querySelector('.anlys-city-btn.active');
    const cityFilter = cityBtn ? cityBtn.dataset.city : null;

    let rows = anlysMergedData.filter(r => {
        if (query && !r.commodity.toLowerCase().includes(query)) return false;
        if (stockedOnly && r.total_stock <= 0) return false;
        // Category filter
        if (activeCats.length > 0) {
            if (activeCats.includes('none')) {
                if (r.category && !activeCats.includes(r.category)) return false;
            } else {
                if (!activeCats.includes(r.category)) return false;
            }
        }
        // Farmable filter
        if (farmFilter === 'farmable' && r.farmable !== true) return false;
        if (farmFilter === 'nonfarmable' && r.farmable !== false) return false;
        // City filter — only show items that have stocked listings in the selected city
        if (cityFilter) {
            const key = `${r.commodity}|${r.enchants || ''}`;
            const cityListings = (anlysRawListings[key] || []).filter(l => l.stock > 0 && l.city === cityFilter);
            if (!cityListings.length) return false;
        }
        return true;
    });

    // Sort — use raw_price for price columns
    const sortKeyMap = { cheapest_price: 'cheapest_price', pavia_price: 'pavia_price', nc_price: 'nc_price' };
    const sortKey = sortKeyMap[anlysSortCol] || anlysSortCol;
    rows.sort((a, b) => {
        let va = a[sortKey], vb = b[sortKey];
        // nulls sort last
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === 'string') va = va.toLowerCase();
        if (typeof vb === 'string') vb = vb.toLowerCase();
        if (va < vb) return anlysSortAsc ? -1 : 1;
        if (va > vb) return anlysSortAsc ? 1 : -1;
        return 0;
    });

    const cols = [
        { key: 'category', label: 'Cat' },
        { key: 'commodity', label: 'Commodity' },
        { key: 'cheapest_price', label: 'Cheapest' },
        { key: 'pavia_price', label: 'Pavia' },
        { key: 'nc_price', label: 'New Callisto' },
        { key: 'num_listings', label: 'Listings' },
        { key: 'total_stock', label: 'Stock' }
    ];

    let html = '<table class="anlys-table"><thead><tr>';
    for (const c of cols) {
        const arrow = anlysSortCol === c.key ? (anlysSortAsc ? ' ▲' : ' ▼') : '';
        html += `<th data-sort="${c.key}">${c.label}${arrow}</th>`;
    }
    html += '<th></th></tr></thead><tbody>';

    for (const r of rows) {
        const fmtP = (p) => {
            if (p == null) return '<span style="color:var(--text-muted)">—</span>';
            if (r.is_sub1d) return `${Math.round(1 / p)}:1d`;
            return anlysFormatPrice(p) + 'd';
        };
        const cheapCell = fmtP(r.cheapest_price);
        const paviaCell = fmtP(r.pavia_price);
        const ncCell = fmtP(r.nc_price);
        // Category: always show dropdown
        const comEsc = anlysEscape(r.commodity);
        const sel = r.category || '';
        const catCell = `<select class="anlys-cat-select" data-commodity="${comEsc}">
            <option value=""${!sel ? ' selected' : ''}>?</option>
            <option value="xp"${sel === 'xp' ? ' selected' : ''}>XP</option>
            <option value="building"${sel === 'building' ? ' selected' : ''}>BLD</option>
            <option value="tools"${sel === 'tools' ? ' selected' : ''}>T&A</option>
            <option value="currency"${sel === 'currency' ? ' selected' : ''}>CUR</option>
            <option value="ore"${sel === 'ore' ? ' selected' : ''}>ORE</option>
            <option value="food"${sel === 'food' ? ' selected' : ''}>FOOD</option>
            <option value="raw"${sel === 'raw' ? ' selected' : ''}>RAW</option>
            <option value="aesthetics"${sel === 'aesthetics' ? ' selected' : ''}>AES</option>
            <option value="lore"${sel === 'lore' ? ' selected' : ''}>LORE</option>
        </select>`;
        // Farmable: always show dropdown
        const farmVal = r.farmable === true ? 'true' : r.farmable === false ? 'false' : '';
        const farmCell = `<select class="anlys-farm-select" data-commodity="${comEsc}">
            <option value=""${!farmVal ? ' selected' : ''}>?</option>
            <option value="true"${farmVal === 'true' ? ' selected' : ''}>F</option>
            <option value="false"${farmVal === 'false' ? ' selected' : ''}>NF</option>
        </select>`;

        html += `<tr>
            <td>${catCell}${farmCell}</td>
            <td>${anlysEscape(r.commodity)}${r.enchants ? ' <small>' + anlysEscape(r.enchants) + '</small>' : ''}</td>
            <td>${cheapCell}</td>
            <td>${paviaCell}</td>
            <td>${ncCell}</td>
            <td><span class="anlys-listings-link" data-commodity="${comEsc}" data-enchants="${anlysEscape(r.enchants || '')}" style="color:var(--accent);cursor:pointer;text-decoration:underline;">${r.num_listings}</span></td>
            <td>${r.total_stock}</td>
            <td><span class="snap-del" data-commodity="${anlysEscape(r.commodity)}" data-side="${r.side}" data-enchants="${anlysEscape(r.enchants || '')}" style="color:var(--accent);cursor:pointer;">chart</span></td>
        </tr>`;
    }
    html += '</tbody></table>';
    html += `<div class="anlys-status" style="margin-top:0.5rem;">${rows.length} commodities</div>`;
    container.innerHTML = html;

    // Sort handlers
    container.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (anlysSortCol === col) anlysSortAsc = !anlysSortAsc;
            else { anlysSortCol = col; anlysSortAsc = true; }
            anlysFilterCommodities();
        });
    });

    // Listings popup handlers
    container.querySelectorAll('.anlys-listings-link').forEach(el => {
        el.addEventListener('click', () => {
            anlysShowListingsPopup(el.dataset.commodity, el.dataset.enchants);
        });
    });

    // Chart link handlers
    container.querySelectorAll('.snap-del[data-commodity]').forEach(el => {
        el.addEventListener('click', () => {
            anlysCurrentTab = 'history';
            document.querySelectorAll('.anlys-tab').forEach(t => t.classList.remove('active'));
            document.querySelector('.anlys-tab[data-tab="history"]')?.classList.add('active');
            anlysRenderHistory(el.dataset.commodity, el.dataset.side, el.dataset.enchants);
        });
    });

    // Category dropdown handlers
    container.querySelectorAll('.anlys-cat-select').forEach(sel => {
        sel.addEventListener('change', () => {
            const name = sel.dataset.commodity;
            if (!anlysCustomCats[name]) anlysCustomCats[name] = {};
            anlysCustomCats[name].cat = sel.value || null;
            if (!sel.value) delete anlysCustomCats[name].cat;
            if (!anlysCustomCats[name].cat && anlysCustomCats[name].farm === undefined) delete anlysCustomCats[name];
            anlysSaveCustomCats();
            // Re-merge to update categories
            anlysMergedData = anlysMergeForDisplay(anlysCommodityData);
            // Update uncat count in filter button
            const uncatBtn = document.querySelector('.anlys-cat-btn[data-cat="none"]');
            if (uncatBtn) {
                const uncatCount = anlysMergedData.filter(r => !r.category).length;
                uncatBtn.textContent = uncatCount > 0 ? `Uncat (${uncatCount})` : 'Uncat';
            }
            anlysFilterCommodities();
        });
    });

    // Farmable dropdown handlers
    container.querySelectorAll('.anlys-farm-select').forEach(sel => {
        sel.addEventListener('change', () => {
            const name = sel.dataset.commodity;
            if (!anlysCustomCats[name]) anlysCustomCats[name] = {};
            if (sel.value === 'true') anlysCustomCats[name].farm = true;
            else if (sel.value === 'false') anlysCustomCats[name].farm = false;
            else delete anlysCustomCats[name].farm;
            if (!anlysCustomCats[name].cat && anlysCustomCats[name].farm === undefined) delete anlysCustomCats[name];
            anlysSaveCustomCats();
            anlysMergedData = anlysMergeForDisplay(anlysCommodityData);
            anlysFilterCommodities();
        });
    });
}

function anlysFormatPrice(n) {
    if (n == null) return '-';
    if (n >= 100) return Math.round(n).toLocaleString();
    if (n >= 1) return n.toFixed(2);
    if (n >= 0.01) return n.toFixed(3);
    return n.toFixed(4);
}

function anlysEscape(s) {
    if (!s) return '';
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
}

// ============================================
// Listings Detail Popup
// ============================================
function anlysShowListingsPopup(commodity, enchants) {
    const key = `${commodity}|${enchants || ''}`;
    const raw = anlysRawListings[key] || [];
    // Sort by price ascending (cheapest first)
    const sorted = raw.slice().sort((a, b) => a.price - b.price);

    // Remove existing popup
    document.querySelector('.anlys-listings-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'anlys-listings-overlay';
    const isSub1d = sorted.length > 0 && sorted[0].price < 1;

    let html = `<div class="anlys-listings-popup">
        <div class="anlys-listings-header">
            <h3>${anlysEscape(commodity)}${enchants ? ' <small>' + anlysEscape(enchants) + '</small>' : ''}</h3>
            <span class="anlys-listings-close" style="cursor:pointer;font-size:1.2rem;">&times;</span>
        </div>
        <div class="anlys-listings-scroll">
        <table class="anlys-table" style="margin:0;">
            <thead><tr><th>Price</th><th>City</th><th>Coords</th><th>Stock</th><th>Side</th><th>Last Updated</th></tr></thead>
            <tbody>`;

    for (const l of sorted) {
        const priceStr = isSub1d ? `${Math.round(1 / l.price)}:1d` : anlysFormatPrice(l.price) + 'd';
        const stocked = l.stock > 0 ? l.stock : '<span style="color:var(--text-muted)">0</span>';
        const coords = `${l.x}, ${l.y}, ${l.z}`;
        const ago = l.time ? anlysTimeAgo(l.time) : '?';
        const sideLabel = l.side === 'buy' ? 'Buy' : 'Sell';
        const rowClass = l.stock <= 0 ? ' style="opacity:0.4"' : '';
        html += `<tr${rowClass}>
            <td>${priceStr}</td>
            <td>${anlysEscape(l.city)}</td>
            <td style="font-size:0.65rem;color:var(--text-muted);">${coords}</td>
            <td>${stocked}</td>
            <td>${sideLabel}</td>
            <td style="font-size:0.65rem;">${ago}</td>
        </tr>`;
    }

    html += `</tbody></table></div>
        <div style="padding:0.5rem;color:var(--text-muted);font-size:0.65rem;">${sorted.length} listings (${sorted.filter(l => l.stock > 0).length} stocked)</div>
    </div>`;

    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    // Close handlers
    overlay.querySelector('.anlys-listings-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function anlysTimeAgo(epochMs) {
    const diff = Date.now() - epochMs;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
}

// ============================================
// Tab 3: Price History
// ============================================
async function anlysRenderHistory(presetCommodity, presetSide, presetEnchants) {
    const content = document.getElementById('analysisContent');
    content.innerHTML = '<div class="anlys-loading">Loading price history...</div>';

    try {
        // Get unique commodities from latest snapshot for the dropdown
        const snaps = await supabaseRest('tradex_snapshots', 'select=id&order=taken_at.desc&limit=1');
        if (!snaps.length) {
            content.innerHTML = '<div class="anlys-loading">No snapshots yet.</div>';
            return;
        }
        const commodities = await supabaseRest('tradex_trade_prices',
            `select=commodity,side,enchants&snapshot_id=eq.${snaps[0].id}&order=commodity`);

        // Deduplicate
        const seen = new Set();
        const unique = [];
        for (const c of commodities) {
            const key = `${c.commodity}|${c.side}|${c.enchants || ''}`;
            if (!seen.has(key)) { seen.add(key); unique.push(c); }
        }

        let html = `
            <div class="anlys-pair-select">
                <select id="anlysHistCommodity">
                    <option value="">Select commodity...</option>
                    ${unique.map(c => {
                        const label = `${c.commodity} (${c.side})${c.enchants ? ' [' + c.enchants + ']' : ''}`;
                        const val = `${c.commodity}|${c.side}|${c.enchants || ''}`;
                        const sel = (presetCommodity === c.commodity && presetSide === c.side && (presetEnchants || '') === (c.enchants || '')) ? ' selected' : '';
                        return `<option value="${anlysEscape(val)}"${sel}>${anlysEscape(label)}</option>`;
                    }).join('')}
                </select>
                <select id="anlysHistRange">
                    <option value="24">24 hours</option>
                    <option value="168">7 days</option>
                    <option value="720" selected>30 days</option>
                    <option value="2160">90 days</option>
                    <option value="0">All time</option>
                </select>
                <button class="anlys-btn" id="anlysHistLoad">Load Chart</button>
            </div>
            <div class="anlys-stats" id="anlysHistStats"></div>
            <div class="anlys-chart-wrap"><canvas id="anlysHistCanvas"></canvas></div>
        `;
        content.innerHTML = html;

        document.getElementById('anlysHistLoad').addEventListener('click', anlysLoadHistoryChart);

        // Auto-load if preset
        if (presetCommodity) anlysLoadHistoryChart();
    } catch (err) {
        content.innerHTML = `<div class="anlys-loading">Error: ${err.message}</div>`;
    }
}

async function anlysLoadHistoryChart() {
    const sel = document.getElementById('anlysHistCommodity');
    const rangeHrs = parseInt(document.getElementById('anlysHistRange').value);
    if (!sel?.value) return;

    const [commodity, side, enchants] = sel.value.split('|');
    const statsEl = document.getElementById('anlysHistStats');
    const canvas = document.getElementById('anlysHistCanvas');
    if (!statsEl || !canvas) return;

    statsEl.innerHTML = '<div class="anlys-loading">Loading...</div>';

    try {
        // Build query
        let query = `select=avg_price,min_price,max_price,total_stock,num_listings,snapshot_id,tradex_snapshots(taken_at)&commodity=eq.${encodeURIComponent(commodity)}&side=eq.${side}&enchants=eq.${encodeURIComponent(enchants || '')}&order=tradex_snapshots(taken_at).asc`;

        if (rangeHrs > 0) {
            const since = new Date(Date.now() - rangeHrs * 60 * 60 * 1000).toISOString();
            // Filter by snapshot time — need a different approach since we can't filter nested
            // Get snapshot IDs in range first
            const snapsInRange = await supabaseRest('tradex_snapshots', `select=id&taken_at=gte.${since}&order=taken_at`);
            if (!snapsInRange.length) {
                statsEl.innerHTML = '<div class="anlys-loading">No data in this time range.</div>';
                return;
            }
            const ids = snapsInRange.map(s => s.id);
            query = `select=avg_price,min_price,max_price,total_stock,num_listings,snapshot_id&commodity=eq.${encodeURIComponent(commodity)}&side=eq.${side}&enchants=eq.${encodeURIComponent(enchants || '')}&snapshot_id=in.(${ids.join(',')})&order=snapshot_id`;
        }

        const prices = await supabaseRest('tradex_trade_prices', query);

        if (!prices.length) {
            statsEl.innerHTML = '<div class="anlys-loading">No price data found for this commodity.</div>';
            return;
        }

        // Get snapshot timestamps for the data
        const snapIds = [...new Set(prices.map(p => p.snapshot_id))];
        const snapMeta = await supabaseRest('tradex_snapshots', `select=id,taken_at&id=in.(${snapIds.join(',')})&order=taken_at`);
        const snapTimeMap = {};
        for (const s of snapMeta) snapTimeMap[s.id] = new Date(s.taken_at);

        // Build chart data
        const chartData = prices.map(p => ({
            time: snapTimeMap[p.snapshot_id],
            avg: p.avg_price,
            min: p.min_price,
            max: p.max_price,
            stock: p.total_stock,
            listings: p.num_listings
        })).filter(d => d.time).sort((a, b) => a.time - b.time);

        if (!chartData.length) {
            statsEl.innerHTML = '<div class="anlys-loading">No chart data available.</div>';
            return;
        }

        // Stats
        const allAvgs = chartData.map(d => d.avg);
        const latest = chartData[chartData.length - 1];
        const earliest = chartData[0];
        const change = earliest.avg > 0 ? ((latest.avg - earliest.avg) / earliest.avg * 100) : 0;
        const priceUnit = 'd';

        statsEl.innerHTML = `
            <div class="anlys-stat-card">
                <div class="stat-label">Current Avg</div>
                <div class="stat-value">${anlysFormatPrice(latest.avg)}${priceUnit}</div>
            </div>
            <div class="anlys-stat-card">
                <div class="stat-label">Period Low</div>
                <div class="stat-value">${anlysFormatPrice(Math.min(...allAvgs))}${priceUnit}</div>
            </div>
            <div class="anlys-stat-card">
                <div class="stat-label">Period High</div>
                <div class="stat-value">${anlysFormatPrice(Math.max(...allAvgs))}${priceUnit}</div>
            </div>
            <div class="anlys-stat-card">
                <div class="stat-label">Change</div>
                <div class="stat-value" style="color:${change >= 0 ? '#6c6' : '#c66'}">${change >= 0 ? '+' : ''}${change.toFixed(1)}%</div>
            </div>
            <div class="anlys-stat-card">
                <div class="stat-label">Listings</div>
                <div class="stat-value">${latest.listings}</div>
            </div>
            <div class="anlys-stat-card">
                <div class="stat-label">Total Stock</div>
                <div class="stat-value">${latest.stock}</div>
            </div>
        `;

        // Draw chart
        anlysDrawChart(canvas, chartData, side);
    } catch (err) {
        statsEl.innerHTML = `<div class="anlys-loading">Error: ${err.message}</div>`;
        console.error('History chart error:', err);
    }
}

// ============================================
// Canvas Chart Renderer
// ============================================
function anlysDrawChart(canvas, data, side) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;

    const pad = { top: 20, right: 60, bottom: 40, left: 60 };
    const chartW = W - pad.left - pad.right;
    const chartH = H - pad.top - pad.bottom;

    // Clear
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.clearRect(0, 0, W, H);

    if (data.length < 2) {
        ctx.fillStyle = '#b8b4cc';
        ctx.font = '12px Raleway, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Need at least 2 data points for chart', W / 2, H / 2);
        return;
    }

    // Compute ranges
    const times = data.map(d => d.time.getTime());
    const minT = Math.min(...times), maxT = Math.max(...times);
    const avgs = data.map(d => d.avg);
    const mins = data.map(d => d.min);
    const maxs = data.map(d => d.max);
    const stocks = data.map(d => d.stock);

    const allPrices = [...avgs, ...mins, ...maxs];
    let minP = Math.min(...allPrices), maxP = Math.max(...allPrices);
    if (minP === maxP) { minP -= 1; maxP += 1; }
    const pRange = maxP - minP;
    minP -= pRange * 0.05;
    maxP += pRange * 0.05;

    let maxStock = Math.max(...stocks);
    if (maxStock === 0) maxStock = 1;

    const xScale = (t) => pad.left + (t - minT) / (maxT - minT) * chartW;
    const yPrice = (p) => pad.top + chartH - (p - minP) / (maxP - minP) * chartH;
    const yStock = (s) => pad.top + chartH - (s / maxStock) * chartH;

    // Grid lines
    ctx.strokeStyle = 'rgba(184, 180, 204, 0.1)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
        const y = pad.top + (chartH / 5) * i;
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    }

    // Min/Max fill area
    ctx.fillStyle = 'rgba(212, 200, 160, 0.08)';
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
        const x = xScale(times[i]);
        if (i === 0) ctx.moveTo(x, yPrice(maxs[i]));
        else ctx.lineTo(x, yPrice(maxs[i]));
    }
    for (let i = data.length - 1; i >= 0; i--) {
        ctx.lineTo(xScale(times[i]), yPrice(mins[i]));
    }
    ctx.closePath();
    ctx.fill();

    // Stock bars (background)
    ctx.fillStyle = 'rgba(100, 180, 255, 0.12)';
    const barW = Math.max(2, chartW / data.length * 0.6);
    for (let i = 0; i < data.length; i++) {
        const x = xScale(times[i]) - barW / 2;
        const h = (stocks[i] / maxStock) * chartH;
        ctx.fillRect(x, pad.top + chartH - h, barW, h);
    }

    // Avg price line
    ctx.strokeStyle = '#d4c8a0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
        const x = xScale(times[i]);
        const y = yPrice(avgs[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Data points
    ctx.fillStyle = '#d4c8a0';
    for (let i = 0; i < data.length; i++) {
        ctx.beginPath();
        ctx.arc(xScale(times[i]), yPrice(avgs[i]), 3, 0, Math.PI * 2);
        ctx.fill();
    }

    // Y-axis labels (price, left)
    ctx.fillStyle = '#b8b4cc';
    ctx.font = '10px Raleway, sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
        const val = minP + (maxP - minP) * (1 - i / 5);
        const y = pad.top + (chartH / 5) * i;
        ctx.fillText(anlysFormatPrice(val), pad.left - 8, y + 4);
    }

    // Y-axis labels (stock, right)
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(100, 180, 255, 0.6)';
    for (let i = 0; i <= 3; i++) {
        const val = Math.round(maxStock * (1 - i / 3));
        const y = pad.top + (chartH / 3) * i;
        ctx.fillText(val.toString(), W - pad.right + 8, y + 4);
    }

    // X-axis labels
    ctx.fillStyle = '#b8b4cc';
    ctx.textAlign = 'center';
    const tickCount = Math.min(6, data.length);
    for (let i = 0; i < tickCount; i++) {
        const idx = Math.round(i * (data.length - 1) / (tickCount - 1));
        const d = data[idx].time;
        const label = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
        ctx.fillText(label, xScale(times[idx]), H - pad.bottom + 16);
    }

    // Axis labels
    ctx.save();
    ctx.fillStyle = '#b8b4cc';
    ctx.font = '10px Raleway, sans-serif';
    ctx.translate(12, pad.top + chartH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Price (d)', 0, 0);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = 'rgba(100, 180, 255, 0.6)';
    ctx.font = '10px Raleway, sans-serif';
    ctx.translate(W - 12, pad.top + chartH / 2);
    ctx.rotate(Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Stock', 0, 0);
    ctx.restore();
}

// ============================================
// Import / Export
// ============================================
async function anlysExportBackup() {
    const db = await anlysOpenDB();
    const tx = db.transaction('snapshots', 'readonly');
    const req = tx.objectStore('snapshots').getAll();
    req.onsuccess = () => {
        db.close();
        const data = req.result || [];
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mf-analysis-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };
}

async function anlysImportBackup(e) {
    const file = e.target?.files?.[0];
    if (!file) return;
    const status = document.getElementById('anlysSnapStatus');

    try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!Array.isArray(data)) throw new Error('Invalid backup format');

        if (status) status.textContent = `Importing ${data.length} snapshots...`;

        const db = await anlysOpenDB();
        const tx = db.transaction('snapshots', 'readwrite');
        const store = tx.objectStore('snapshots');
        for (const snap of data) {
            store.put(snap);
        }
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });

        if (status) status.textContent = `Imported ${data.length} snapshots successfully.`;
        await anlysRenderSnapshots();
    } catch (err) {
        if (status) status.textContent = `Import failed: ${err.message}`;
        console.error('Import failed:', err);
    }

    // Reset file input
    e.target.value = '';
}
