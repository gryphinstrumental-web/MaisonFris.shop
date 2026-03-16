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
let anlysSortCol = 'commodity';
let anlysSortAsc = true;

// Diamond-type materials for price normalization
const DIAMOND_TYPES = { DIAMOND: 1, DIAMOND_BLOCK: 9 };
const BLOCK_MULTIPLIERS = { DIAMOND_BLOCK: 9, IRON_BLOCK: 9, GOLD_BLOCK: 9, EMERALD_BLOCK: 9, LAPIS_BLOCK: 9, REDSTONE_BLOCK: 9, COPPER_BLOCK: 9 };

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
    // Block types = 9x base (diamond block = 9 diamonds, etc.)
    const mult = BLOCK_MULTIPLIERS[item.material];
    if (mult) count *= mult;
    return count;
}

function anlysDiamondCount(item) {
    if (!item) return null;
    const mat = item.material;
    if (mat === 'DIAMOND') {
        let c = item.count || 1;
        if (ncIsCompacted(item)) c *= 64;
        return c;
    }
    if (mat === 'DIAMOND_BLOCK') {
        let c = (item.count || 1) * 9;
        if (ncIsCompacted(item)) c *= 64;
        return c;
    }
    return null;
}

function anlysIsDiamond(mat) {
    return mat === 'DIAMOND' || mat === 'DIAMOND_BLOCK';
}

function anlysCommodityKey(item) {
    if (!item) return '?';
    let name = item.material || '?';
    // Don't include compacted/block in the name since we normalize quantities
    const ench = ncEnchantStr(item);
    if (ench) name += ' [' + ench + ']';
    return name;
}

// ============================================
// Aggregation Pipeline
// ============================================
function anlysAggregateExchanges(exchanges) {
    // Groups: keyed by "commodity|side|enchants"
    const groups = {};
    let stocked = 0;

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
        } else if (!anlysIsDiamond(e.input.material) && !anlysIsDiamond(e.output.material)) {
            // Barter trade — no diamond involved
            const effectiveIn = anlysEffectiveCount(e.input);
            const effectiveOut = anlysEffectiveCount(e.output);
            const ratio = effectiveOut / effectiveIn;
            const commodity = anlysCommodityKey(e.output);
            const enchants = ncEnchantStr(e.output);
            const compacted = ncIsCompacted(e.output);
            const key = `${e.input.material}→${e.output.material}|barter|${enchants}|${compacted}`;
            if (!groups[key]) groups[key] = { commodity, side: 'barter', enchants, is_compacted: compacted, commodity_in: e.input.material, commodity_out: e.output.material, prices: [], stocks: [], ratios: [] };
            if (!groups[key].ratios) groups[key].ratios = [];
            groups[key].ratios.push(ratio);
            groups[key].prices.push(ratio); // use ratio as price for aggregation
            groups[key].stocks.push(e.stock || 0);
        }
    }

    // Compute aggregates
    const results = [];
    for (const g of Object.values(groups)) {
        const prices = g.prices.sort((a, b) => a - b);
        const mid = Math.floor(prices.length / 2);
        const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
        results.push({
            commodity: g.commodity,
            side: g.side,
            enchants: g.enchants || '',
            is_compacted: g.is_compacted || false,
            commodity_in: g.commodity_in,
            commodity_out: g.commodity_out,
            avg_price: prices.reduce((a, b) => a + b, 0) / prices.length,
            min_price: prices[0],
            max_price: prices[prices.length - 1],
            num_listings: prices.length,
            total_stock: g.stocks.reduce((a, b) => a + b, 0),
            ratio: g.side === 'barter' ? (g.ratios.reduce((a, b) => a + b, 0) / g.ratios.length) : null
        });
    }

    return { results, stocked, uniquePairs: results.length };
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
        price_d: r.side !== 'barter' ? r.avg_price : null,
        is_compacted: r.is_compacted,
        enchants: r.enchants,
        commodity_in: r.commodity_in,
        commodity_out: r.commodity_out,
        avg_price: r.avg_price,
        min_price: r.min_price,
        max_price: r.max_price,
        num_listings: r.num_listings,
        total_stock: r.total_stock,
        ratio: r.ratio
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
        // Get latest snapshot ID
        const snaps = await supabaseRest('tradex_snapshots', 'select=id&order=taken_at.desc&limit=1');
        if (!snaps.length) {
            content.innerHTML = '<div class="anlys-loading">No snapshots yet. Take a snapshot first.</div>';
            return;
        }
        const latestId = snaps[0].id;
        anlysCommodityData = await supabaseRest('tradex_trade_prices', `select=*&snapshot_id=eq.${latestId}&order=commodity`);

        let html = `
            <input type="text" class="um-search anlys-search" id="anlysCommoditySearch" placeholder="Search material name...">
            <div class="anlys-filters">
                <button class="anlys-btn anlys-filter-btn active" data-filter="all">All</button>
                <button class="anlys-btn anlys-filter-btn" data-filter="buy">Buy (d)</button>
                <button class="anlys-btn anlys-filter-btn" data-filter="sell">Sell (d)</button>
                <button class="anlys-btn anlys-filter-btn" data-filter="barter">Barter</button>
                <button class="anlys-btn anlys-filter-btn" data-filter="stocked">In Stock</button>
            </div>
            <div id="anlysCommodityTable"></div>
        `;
        content.innerHTML = html;

        anlysSortCol = 'commodity';
        anlysSortAsc = true;
        anlysFilterCommodities();

        // Search handler
        document.getElementById('anlysCommoditySearch').addEventListener('input', anlysFilterCommodities);

        // Filter buttons
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
    } catch (err) {
        content.innerHTML = `<div class="anlys-loading">Error: ${err.message}</div>`;
    }
}

function anlysFilterCommodities() {
    const searchEl = document.getElementById('anlysCommoditySearch');
    const query = (searchEl?.value || '').toLowerCase().trim();
    const container = document.getElementById('anlysCommodityTable');
    if (!container) return;

    const sideFilter = document.querySelector('.anlys-filter-btn.active:not([data-filter="stocked"])')?.dataset.filter || 'all';
    const stockedOnly = document.querySelector('.anlys-filter-btn[data-filter="stocked"]')?.classList.contains('active');

    let rows = anlysCommodityData.filter(r => {
        if (query && !r.commodity.toLowerCase().includes(query) &&
            !(r.commodity_in || '').toLowerCase().includes(query) &&
            !(r.commodity_out || '').toLowerCase().includes(query)) return false;
        if (sideFilter !== 'all' && r.side !== sideFilter) return false;
        if (stockedOnly && r.total_stock <= 0) return false;
        return true;
    });

    // Sort
    rows.sort((a, b) => {
        let va = a[anlysSortCol], vb = b[anlysSortCol];
        if (typeof va === 'string') va = va.toLowerCase();
        if (typeof vb === 'string') vb = vb.toLowerCase();
        if (va < vb) return anlysSortAsc ? -1 : 1;
        if (va > vb) return anlysSortAsc ? 1 : -1;
        return 0;
    });

    const cols = [
        { key: 'commodity', label: 'Commodity' },
        { key: 'side', label: 'Side' },
        { key: 'avg_price', label: 'Avg Price' },
        { key: 'min_price', label: 'Min' },
        { key: 'max_price', label: 'Max' },
        { key: 'num_listings', label: 'Listings' },
        { key: 'total_stock', label: 'Stock' }
    ];

    let html = '<table class="anlys-table"><thead><tr>';
    for (const c of cols) {
        const arrow = anlysSortCol === c.key ? (anlysSortAsc ? ' ▲' : ' ▼') : '';
        html += `<th data-sort="${c.key}">${c.label}${arrow}</th>`;
    }
    html += '<th>Detail</th></tr></thead><tbody>';

    for (const r of rows) {
        const sideClass = r.side === 'buy' ? 'price-buy' : r.side === 'sell' ? 'price-sell' : 'price-barter';
        const priceLabel = r.side === 'barter' ? 'ratio' : 'd';
        const displayCommodity = r.side === 'barter' ? `${r.commodity_in} → ${r.commodity_out}` : r.commodity;
        html += `<tr>
            <td>${anlysEscape(displayCommodity)}${r.enchants ? ' <small>' + anlysEscape(r.enchants) + '</small>' : ''}${r.is_compacted ? ' <small>[C]</small>' : ''}</td>
            <td class="${sideClass}">${r.side}</td>
            <td>${anlysFormatPrice(r.avg_price)} ${priceLabel}</td>
            <td>${anlysFormatPrice(r.min_price)} ${priceLabel}</td>
            <td>${anlysFormatPrice(r.max_price)} ${priceLabel}</td>
            <td>${r.num_listings}</td>
            <td>${r.total_stock}</td>
            <td><span class="snap-del" data-commodity="${anlysEscape(r.commodity)}" data-side="${r.side}" data-enchants="${anlysEscape(r.enchants || '')}" style="color:var(--accent);cursor:pointer;">chart</span></td>
        </tr>`;
    }
    html += '</tbody></table>';
    html += `<div class="anlys-status" style="margin-top:0.5rem;">${rows.length} results</div>`;
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

    // Chart link handlers
    container.querySelectorAll('span[data-commodity]').forEach(el => {
        el.addEventListener('click', () => {
            // Switch to history tab with this commodity pre-selected
            anlysCurrentTab = 'history';
            document.querySelectorAll('.anlys-tab').forEach(t => t.classList.remove('active'));
            document.querySelector('.anlys-tab[data-tab="history"]')?.classList.add('active');
            anlysRenderHistory(el.dataset.commodity, el.dataset.side, el.dataset.enchants);
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
        const priceUnit = side === 'barter' ? '' : 'd';

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
    ctx.fillText(side === 'barter' ? 'Ratio' : 'Price (d)', 0, 0);
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
