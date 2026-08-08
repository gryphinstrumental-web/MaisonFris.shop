// ============================================
// Shop Explorer — Tradex Integration
// ============================================

let ncShopMode = false;
let ncSurveyMode = true; // surveyors see edit buttons by default
let ncShopMarkers = [];
let ncShopExchanges = [];  // raw API data (within NC bounds)
let ncShopFiltered = [];   // after client-side filtering
let ncShopDataReady = false;
let ncShopLinks = {};      // keyed by "x,y,z" → link row from nc_property_shops
let ncShopShowSavedOnly = false; // cart "Show Saved" map filter

const NC_SHOP_CENTER = { x: -3163, z: 8168 };
const NC_SHOP_BOUNDS = { minX: -3550, maxX: -2750, minZ: 7750, maxZ: 8550 };
const TRADEX_API = 'https://api.tradex.civinfo.net/exchanges/search';
const NC_SHOP_LINK_RADIUS = 15;

// ============================================
// Tradex API Fetch with 429 Retry
// ============================================
async function tradexFetch(body, { retries = 3, baseDelay = 3000 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const resp = await fetch(TRADEX_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (resp.status === 429 && attempt < retries) {
            const delay = baseDelay * Math.pow(2, attempt);
            console.warn(`Tradex 429 — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${retries})`);
            await new Promise(r => setTimeout(r, delay));
            continue;
        }
        if (!resp.ok) throw new Error('Tradex API ' + resp.status);
        return resp.json();
    }
}

// ============================================
// Shared Tradex Data Cache
// ============================================
let tradexCachedExchanges = [];   // full dataset from last fetch
let tradexCacheTime = 0;          // timestamp of last fetch
const TRADEX_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function tradexEnsureCache(force) {
    if (!force && tradexCachedExchanges.length && (Date.now() - tradexCacheTime) < TRADEX_CACHE_TTL) return;
    const data = await tradexFetch({
        pos: { server: 'play.civmc.net', world: 'overworld', x: 0, y: 64, z: 0 },
        sortMode: 'closest', limit: 10000, allowUnstocked: true
    });
    tradexCachedExchanges = data.exchanges || [];
    tradexCacheTime = Date.now();
    console.log(`[Tradex] Cached ${tradexCachedExchanges.length} exchanges`);
}

function tradexGetCached() { return tradexCachedExchanges; }
function tradexGetStocked() { return tradexCachedExchanges.filter(e => e.stock > 0); }
function tradexGetNC() {
    return tradexCachedExchanges.filter(e => {
        const p = e.pos;
        return p.x >= NC_SHOP_BOUNDS.minX && p.x <= NC_SHOP_BOUNDS.maxX &&
               p.z >= NC_SHOP_BOUNDS.minZ && p.z <= NC_SHOP_BOUNDS.maxZ;
    });
}

// ============================================
// Saved Deals (Supabase + localStorage fallback)
// Key → quantity map
// ============================================
let ncSavedDeals = new Map(); // key → qty
let ncSavedDealsLoaded = false;
(function() {
    try {
        const raw = JSON.parse(localStorage.getItem('mf_saved_deals') || '{}');
        if (Array.isArray(raw)) { raw.forEach(k => ncSavedDeals.set(k, 1)); } // migrate old format
        else { Object.entries(raw).forEach(([k, v]) => ncSavedDeals.set(k, v)); }
    } catch {}
})();

function ncIsCompacted(item) {
    return item?.lore?.includes('Compacted Item');
}

const NC_ENCHANT_ABBR = {
    'Efficiency': 'Eff', 'Unbreaking': 'Unb', 'Fortune': 'Fort', 'Silk Touch': 'ST',
    'Sharpness': 'Sharp', 'Smite': 'Smite', 'Bane of Arthropods': 'BoA',
    'Protection': 'Prot', 'Fire Protection': 'FP', 'Blast Protection': 'BP',
    'Projectile Protection': 'PP', 'Feather Falling': 'FF', 'Thorns': 'Thorns',
    'Respiration': 'Resp', 'Aqua Affinity': 'AA', 'Depth Strider': 'DS',
    'Fire Aspect': 'FA', 'Knockback': 'KB', 'Looting': 'Loot',
    'Sweeping Edge': 'Sweep', 'Power': 'Pow', 'Punch': 'Punch',
    'Flame': 'Flame', 'Infinity': 'Inf', 'Mending': 'Mend',
    'Channeling': 'Chan', 'Riptide': 'Ript', 'Loyalty': 'Loyal',
    'Impaling': 'Imp', 'Piercing': 'Pierce', 'Quick Charge': 'QC',
    'Multishot': 'Multi', 'Frost Walker': 'FW', 'Soul Speed': 'SS',
    'Swift Sneak': 'SwSn', 'Luck of the Sea': 'Luck', 'Lure': 'Lure',
};

function ncEnchantStr(item) {
    const ench = item?.requiredEnchants || item?.storedEnchants || {};
    const entries = Object.entries(ench);
    if (entries.length === 0) return '';
    return entries.map(([name, lvl]) => (NC_ENCHANT_ABBR[name] || name) + lvl).join(' ');
}

function ncMatName(item) {
    let name = item?.customName || item?.material || '?';
    if (ncIsCompacted(item)) name += ' [C]';
    const ench = ncEnchantStr(item);
    if (ench) name += ' [' + ench + ']';
    return name;
}

function ncDealKey(e) {
    const inC = ncIsCompacted(e.input) ? '[C]' : '';
    const outC = ncIsCompacted(e.output) ? '[C]' : '';
    const inE = ncEnchantStr(e.input);
    const outE = ncEnchantStr(e.output);
    return `${e.pos.x},${e.pos.y},${e.pos.z}|${e.input?.material || ''}${inC}${inE ? '{' + inE + '}' : ''}|${e.output?.material || ''}${outC}${outE ? '{' + outE + '}' : ''}`;
}

async function ncLoadSavedDeals() {
    if (ncSavedDealsLoaded) return;
    ncSavedDealsLoaded = true;
    if (!currentUser) return;
    try {
        const rows = await supabaseRest('nc_saved_deals', `user_id=eq.${currentUser.id}&select=deal_key,quantity`);
        rows.forEach(r => {
            const existing = ncSavedDeals.get(r.deal_key) || 0;
            ncSavedDeals.set(r.deal_key, Math.max(existing, r.quantity || 1));
        });
        ncPersistSavedDeals();
    } catch (err) {
        console.error('Failed to load saved deals:', err);
    }
}

function ncToggleSavedDeal(key) {
    if (ncSavedDeals.has(key)) {
        ncSavedDeals.delete(key);
        ncSavedDealRemoteDelete(key);
    } else {
        ncSavedDeals.set(key, 1);
        ncSavedDealRemoteUpsert(key, 1);
    }
    ncPersistSavedDeals();
}

function ncSavedDealSetQty(key, qty) {
    if (qty <= 0) {
        ncSavedDeals.delete(key);
        ncSavedDealRemoteDelete(key);
    } else {
        ncSavedDeals.set(key, qty);
        ncSavedDealRemoteUpsert(key, qty);
    }
    ncPersistSavedDeals();
}

function ncPersistSavedDeals() {
    const obj = {};
    ncSavedDeals.forEach((v, k) => { obj[k] = v; });
    localStorage.setItem('mf_saved_deals', JSON.stringify(obj));
    ncUpdateCartBadge();
}

async function ncSavedDealRemoteUpsert(key, qty) {
    if (!currentUser) return;
    try {
        // Upsert: insert on conflict update quantity
        const resp = await fetch(`${CONFIG.supabaseUrl}/rest/v1/nc_saved_deals`, {
            method: 'POST',
            headers: { ...restHeaders(), 'Prefer': 'resolution=merge-duplicates,return=representation' },
            body: JSON.stringify({ user_id: currentUser.id, deal_key: key, quantity: qty })
        });
        if (!resp.ok) console.error('Failed to upsert saved deal:', resp.status);
    } catch (err) { console.error('Failed to upsert deal remotely:', err); }
}

async function ncSavedDealRemoteDelete(key) {
    if (!currentUser) return;
    try {
        const resp = await fetch(
            `${CONFIG.supabaseUrl}/rest/v1/nc_saved_deals?user_id=eq.${currentUser.id}&deal_key=eq.${encodeURIComponent(key)}`,
            { method: 'DELETE', headers: restHeaders() }
        );
        if (!resp.ok) console.error('Failed to delete saved deal:', resp.status);
    } catch (err) { console.error('Failed to delete deal remotely:', err); }
}

async function ncSavedDealRemoteClearAll() {
    if (!currentUser) return;
    try {
        const resp = await fetch(
            `${CONFIG.supabaseUrl}/rest/v1/nc_saved_deals?user_id=eq.${currentUser.id}`,
            { method: 'DELETE', headers: restHeaders() }
        );
        if (!resp.ok) console.error('Failed to clear saved deals:', resp.status);
    } catch (err) { console.error('Failed to clear deals remotely:', err); }
}

function ncUpdateCartBadge() {
    const badge = document.getElementById('ncCartBadge');
    if (badge) {
        let total = 0;
        ncSavedDeals.forEach(v => { total += v; });
        badge.textContent = total;
        badge.style.display = total > 0 ? '' : 'none';
    }
}

// ============================================
// Background Fetch & Proximity
// ============================================
async function ncEnsureShopData(force) {
    if (!force && ncShopDataReady) return;
    try {
        await tradexEnsureCache(force);
        ncShopExchanges = tradexGetNC();
        ncShopDataReady = true;
        ncUpdateCartBadge();
    } catch (err) {
        console.error('Background Tradex fetch failed:', err);
    }
}

function ncFindNearbyShops(prop) {
    if (!ncShopDataReady || prop.x == null || prop.z == null) return [];
    const grouped = {};
    ncShopExchanges.forEach(e => {
        const key = `${e.pos.x},${e.pos.y},${e.pos.z}`;
        if (!grouped[key]) grouped[key] = { pos: e.pos, exchanges: [] };
        grouped[key].exchanges.push(e);
    });
    const hasBoundary = Array.isArray(prop.boundary) && prop.boundary.length >= 3;
    return Object.values(grouped)
        .map(g => ({ ...g, dist: Math.hypot(g.pos.x - prop.x, g.pos.z - prop.z) }))
        .filter(g => g.dist <= NC_SHOP_LINK_RADIUS
            || (hasBoundary && ncPointInBoundary(g.pos.x, g.pos.z, prop.boundary)))
        .sort((a, b) => a.dist - b.dist);
}

// Navigate from registry to a specific shop chest in shop mode
function ncGoToShop(x, y, z) {
    // Clear shop filters so the target exchange is visible
    const searchEl = document.getElementById('ncShopSearch');
    const payEl = document.getElementById('ncShopPayWith');
    if (searchEl) searchEl.value = '';
    if (payEl) payEl.value = '';
    ncShopShowSavedOnly = false;
    const savedBtn = document.getElementById('ncCartShowSaved');
    if (savedBtn) savedBtn.textContent = 'Show Saved';

    if (!ncShopMode) ncEnterShopMode();

    // Poll until data + markers are ready, then select the shop
    const trySelect = () => {
        if (!ncShopDataReady) { setTimeout(trySelect, 200); return; }
        // Re-filter with cleared inputs to ensure target is in ncShopFiltered
        ncFilterShops();
        const idx = ncShopFiltered.findIndex(ex => ex.pos.x === x && ex.pos.y === y && ex.pos.z === z);
        if (idx >= 0) {
            ncShopSelectCard(idx);
        } else {
            // Exchange might be unstocked or otherwise not in filtered — center map on it
            ncMap.setView([-z, x], 2);
        }
    };
    setTimeout(trySelect, 150);
}

// Navigate from shop popup to registry and highlight property
function ncGoToRegistry(propId) {
    if (typeof ncProperties === 'undefined') return;
    const propIdx = ncProperties.findIndex(p => String(p.id) === String(propId));
    if (propIdx < 0) return;
    ncMap.closePopup();
    if (typeof ncClearAllFilters === 'function') ncClearAllFilters();
    ncExitShopMode();
    filterNCMarkers('');
    setTimeout(() => {
        const card = document.querySelector(`.nc-panel-card[data-index="${propIdx}"]`);
        if (card) {
            card.style.display = '';
            highlightNCProperty(propIdx, card);
        }
    }, 350);
}

// ============================================
// Mode Toggle
// ============================================
document.getElementById('ncModeToggle').addEventListener('click', () => {
    if (ncShopMode) {
        ncExitShopMode();
    } else {
        ncEnterShopMode();
    }
});

function ncUpdateSurveyToggle() {
    const btn = document.getElementById('ncSurveyToggle');
    if (typeof ncCanEdit === 'function' && ncCanEdit()) {
        btn.style.display = 'flex';
        btn.classList.toggle('active', ncSurveyMode);
        btn.classList.toggle('registry-mode', !ncShopMode);
    } else {
        btn.style.display = 'none';
    }
}

// Survey mode toggle (wrench icon)
document.getElementById('ncSurveyToggle').addEventListener('click', () => {
    ncSurveyMode = !ncSurveyMode;
    document.getElementById('ncSurveyToggle').classList.toggle('active', ncSurveyMode);
    if (ncShopMode) {
        // Refresh shop popups and cards
        ncFilterShops();
    } else {
        // Re-render registry markers with updated canEdit
        renderNCMarkers(ncProperties);
        filterNCMarkers(document.getElementById('ncSearchInput').value);
    }
});

async function ncLoadShopLinks() {
    try {
        const rows = await supabaseRest('nc_property_shops', 'select=*');
        ncShopLinks = {};
        (rows || []).forEach(r => {
            const key = `${r.shop_x},${r.shop_y},${r.shop_z}`;
            ncShopLinks[key] = r;
        });
    } catch (err) {
        console.error('Failed to load shop links:', err);
    }
}

function ncGetShopLink(pos) {
    return ncShopLinks[`${pos.x},${pos.y},${pos.z}`] || null;
}

function ncGetLinkedProperty(link) {
    if (!link || !link.property_id) return null;
    if (typeof ncProperties === 'undefined') return null;
    return ncProperties.find(p => p.id === link.property_id) || null;
}

function ncEnterShopMode() {
    ncShopMode = true;
    document.getElementById('ncModeToggle').textContent = 'View Registry';
    // Cancel any in-progress boundary drawing
    if (typeof ncTeardownDraw === 'function' && ncDrawState) ncTeardownDraw();
    // Hide registrar UI
    document.querySelectorAll('.nc-registrar-ui').forEach(el => el.style.display = 'none');
    // Hide property markers + boundaries
    ncMarkers.forEach(m => ncMap.removeLayer(m));
    ncBoundaryPolys.forEach(p => ncMap.removeLayer(p));
    // Show shop UI
    document.querySelectorAll('.nc-shop-ui').forEach(el => el.style.display = 'flex');
    // Show survey toggle for surveyors/admins
    ncUpdateSurveyToggle();
    // Fetch shop links + shop data + saved deals
    ncLoadShopLinks();
    ncFetchShops();
    ncLoadSavedDeals();
}

function ncExitShopMode() {
    ncShopMode = false;
    document.getElementById('ncModeToggle').textContent = 'Go Shopping';
    // Hide shop UI
    document.querySelectorAll('.nc-shop-ui').forEach(el => el.style.display = 'none');
    // Clear shop markers
    ncShopMarkers.forEach(m => ncMap.removeLayer(m));
    ncShopMarkers = [];
    // Show registrar UI
    document.querySelectorAll('.nc-registrar-ui').forEach(el => el.style.display = '');
    // Re-render property markers
    renderNCMarkers(ncProperties);
    filterNCMarkers(document.getElementById('ncSearchInput').value);
    // Keep survey toggle visible
    ncUpdateSurveyToggle();
    // Offer to resume an interrupted boundary drawing
    if (typeof ncMaybeResumeDraft === 'function') ncMaybeResumeDraft();
}

// ============================================
// Fetch & Filter
// ============================================
async function ncFetchShops() {
    const results = document.getElementById('ncShopResults');

    if (ncShopDataReady && ncShopExchanges.length > 0) {
        ncFilterShops();
        return;
    }

    results.innerHTML = '<div class="nc-shop-loading">Loading shops...</div>';
    try {
        await ncEnsureShopData();
        ncFilterShops();
    } catch (err) {
        console.error('Tradex fetch error:', err);
        results.innerHTML = '<div class="nc-shop-empty">Failed to load shop data.</div>';
    }
}

function ncFilterShops() {
    const searchQ = (document.getElementById('ncShopSearch').value || '').toLowerCase().trim();
    const payWithQ = (document.getElementById('ncShopPayWith').value || '').toLowerCase().trim();
    const showUnstocked = document.getElementById('ncShopUnstocked').classList.contains('active');
    const hideMissing = !document.getElementById('ncShopMapMissing').classList.contains('active');
    const exactMap = document.getElementById('ncShopMapExact').classList.contains('active');
    const mMatch = (val, q) => exactMap ? val === q : val.includes(q);

    ncShopFiltered = ncShopExchanges.filter(e => {
        const link = ncGetShopLink(e.pos);
        if (link && link.stale) return false;
        if (!showUnstocked && e.stock <= 0) return false;

        if (hideMissing) {
            const nearest = ncShopNearestProperty(e.pos);
            const assoc = ncGetLinkedProperty(link) || ncShopBoundaryProperty(e.pos)
                || (nearest && typeof ncProperties !== 'undefined' ? ncProperties.find(p => p.id === nearest.id) : null);
            if (!assoc) return false;
        }

        if (searchQ) {
            const outName = (e.output?.material || '').toLowerCase();
            const outCustom = (e.output?.customName || '').toLowerCase();
            if (!mMatch(outName, searchQ) && !mMatch(outCustom, searchQ)) return false;
        }

        if (payWithQ) {
            const inName = (e.input?.material || '').toLowerCase();
            const inCustom = (e.input?.customName || '').toLowerCase();
            if (!mMatch(inName, payWithQ) && !mMatch(inCustom, payWithQ)) return false;
        }

        return true;
    });

    // Cart "Show Saved" filter — only keep saved deals on map
    if (ncShopShowSavedOnly) {
        ncShopFiltered = ncShopFiltered.filter(e => ncSavedDeals.has(ncDealKey(e)));
    }

    // Sort by distance from NC center
    ncShopFiltered.sort((a, b) => {
        const dA = Math.hypot(a.pos.x - NC_SHOP_CENTER.x, a.pos.z - NC_SHOP_CENTER.z);
        const dB = Math.hypot(b.pos.x - NC_SHOP_CENTER.x, b.pos.z - NC_SHOP_CENTER.z);
        return dA - dB;
    });

    ncRenderShopResults();
    ncRenderShopMarkers();
}

// ============================================
// Render Results (horizontal cards like registrar)
// ============================================
function ncRenderShopResults() {
    const container = document.getElementById('ncShopResults');
    const count = document.getElementById('ncShopCount');
    count.textContent = `${ncShopFiltered.length} trade${ncShopFiltered.length !== 1 ? 's' : ''}`;

    if (ncShopFiltered.length === 0) {
        container.innerHTML = '<div class="nc-shop-empty">No shops match your filters.</div>';
        return;
    }

    let html = '';
    ncShopFiltered.forEach((e, i) => {
        const inName = ncMatName(e.input);
        const outName = ncMatName(e.output);
        const inCount = e.input?.count || 1;
        const outCount = e.output?.count || 1;
        const stockClass = e.stock > 0 ? 'in-stock' : 'out-stock';
        const stockText = e.stock > 0 ? `In Stock (${e.stock})` : 'Out of Stock';

        const age = Date.now() - e.time;
        const freshClass = age < 86400000 ? 'fresh-new' : age < 604800000 ? 'fresh-mid' : 'fresh-old';
        const freshText = ncFormatAge(e.time);

        const link = ncGetShopLink(e.pos);
        const linkedProp = ncGetLinkedProperty(link);
        const isStale = link && link.stale;
        let nearLine = '';
        if (linkedProp && !isStale) {
            nearLine = `<div class="nc-shop-near" style="color:#4caf50;">&#x2714; ${ncEsc(linkedProp.name)}</div>`;
        } else if (isStale) {
            nearLine = `<div class="nc-shop-near" style="color:var(--text-muted);font-style:italic;">Inactive</div>`;
        } else {
            const bProp = ncShopBoundaryProperty(e.pos);
            if (bProp) {
                nearLine = `<div class="nc-shop-near" style="color:#00bcd4;">&#x25A3; ${ncEsc(bProp.name)}</div>`;
            } else {
                const nearest = ncShopNearestProperty(e.pos);
                if (nearest) nearLine = `<div class="nc-shop-near">Near ${ncEsc(nearest.name)} (${nearest.dist}m)</div>`;
            }
        }
        const staleClass = isStale ? ' nc-shop-stale' : '';

        html += `<div class="nc-shop-card${staleClass}" data-idx="${i}">
            <div class="nc-shop-trade">
                <span class="nc-shop-item-count">${inCount}x</span>
                <span class="nc-shop-item-name">${ncEsc(inName)}</span>
                <span class="arrow">&rarr;</span>
                <span class="nc-shop-item-count">${outCount}x</span>
                <span class="nc-shop-item-name">${ncEsc(outName)}</span>
            </div>
            <div class="nc-shop-meta">
                <span class="nc-shop-stock ${stockClass}">${stockText}</span>
                <span class="nc-shop-fresh ${freshClass}">${freshText}</span>
                <span class="nc-shop-coords" data-x="${e.pos.x}" data-z="${e.pos.z}">${e.pos.x}, ${e.pos.y}, ${e.pos.z}</span>
            </div>
            ${nearLine}
        </div>`;
    });

    container.innerHTML = html;
}

function ncFormatAge(timestamp) {
    const secs = Math.floor((Date.now() - timestamp) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    if (secs < 2592000) return `${Math.floor(secs / 86400)}d ago`;
    return `${Math.floor(secs / 2592000)}mo ago`;
}

// ============================================
// Render Map Markers
// ============================================
function ncRenderShopMarkers() {
    ncShopMarkers.forEach(m => ncMap.removeLayer(m));
    ncShopMarkers = [];

    const grouped = {};
    ncShopFiltered.forEach(e => {
        const key = `${e.pos.x},${e.pos.y},${e.pos.z}`;
        if (!grouped[key]) grouped[key] = { pos: e.pos, exchanges: [], key: key };
        grouped[key].exchanges.push(e);
    });

    Object.values(grouped).forEach(group => {
        const p = group.pos;
        const hasStock = group.exchanges.some(e => e.stock > 0);
        const link = ncGetShopLink(p);
        const isStale = link && link.stale;
        const marker = L.circleMarker([-p.z, p.x], {
            radius: 5,
            fillColor: isStale ? '#666' : (hasStock ? '#4caf50' : '#aa0000'),
            color: isStale ? 'rgba(150,150,150,0.4)' : 'rgba(255,255,255,0.6)',
            weight: 1,
            fillOpacity: isStale ? 0.4 : 0.9
        }).addTo(ncMap);

        marker.bindTooltip(`${group.exchanges.length} trade${group.exchanges.length !== 1 ? 's' : ''}`, {
            className: 'nc-tooltip',
            direction: 'top',
            offset: [0, -6]
        });

        marker.bindPopup(ncShopPopupHTML(group.exchanges), {
            maxWidth: 600,
            minWidth: 450,
            autoPan: false,
            className: 'nc-leaflet-popup'
        });

        marker._ncShopKey = group.key;

        // Clicking a marker → same behavior as selecting from scroll
        marker.on('click', function() {
            const firstIdx = ncShopFiltered.findIndex(ex =>
                `${ex.pos.x},${ex.pos.y},${ex.pos.z}` === group.key
            );
            if (firstIdx >= 0) {
                ncShopSelectCard(firstIdx);
            }
        });

        ncShopMarkers.push(marker);
    });
}

function ncShopNearestProperty(pos) {
    if (typeof ncProperties === 'undefined' || ncProperties.length === 0) return null;
    let best = null, bestDist = Infinity;
    ncProperties.forEach(prop => {
        if (prop.x == null || prop.z == null) return;
        const d = Math.hypot(prop.x - pos.x, prop.z - pos.z);
        if (d < bestDist) { bestDist = d; best = prop; }
    });
    return best ? { id: best.id, name: best.name, dist: Math.round(bestDist) } : null;
}

// Point-in-polygon (ray cast) against a boundary's [[x,z],...] block corners.
// Shop coords are block positions — test the block center (+0.5).
function ncPointInBoundary(px, pz, poly) {
    const x = px + 0.5, z = pz + 0.5;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], zi = poly[i][1];
        const xj = poly[j][0], zj = poly[j][1];
        if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

// ============================================
// Property Activity — live verdict from the Tradex chests tagged to a
// property (boundary containment + confirmed links). Computed on demand,
// never stored, so it is always as fresh as the Tradex cache.
// ============================================
const NC_ACTIVITY_STALE_DAYS = 14;
const NC_ACTIVITY_COLORS = { active: '#4caf50', unstocked: '#e6a817', stale: '#e08080', noshop: '#888' };

function ncGetActivity(prop) {
    if (prop.type !== 'Commercial') return null;
    if (!ncShopDataReady) return null;
    const hasBoundary = Array.isArray(prop.boundary) && prop.boundary.length >= 3;
    const links = (prop._shopLinks || []).filter(l => !l.dismissed);
    if (!hasBoundary && !links.length) return null; // no way to attribute chests yet
    const exs = ncShopExchanges.filter(e =>
        (hasBoundary && ncPointInBoundary(e.pos.x, e.pos.z, prop.boundary)) ||
        links.some(l => l.shop_x === e.pos.x && l.shop_y === e.pos.y && l.shop_z === e.pos.z)
    );
    if (!exs.length) {
        return { verdict: 'noshop', label: 'No Chests', color: NC_ACTIVITY_COLORS.noshop,
            stocked: 0, total: 0, lastSeen: null, detail: 'no Tradex chests on property' };
    }
    const lastSeen = Math.max(...exs.map(e => e.time));
    const stocked = exs.filter(e => e.stock > 0).length;
    const ageDays = (Date.now() - lastSeen) / 86400000;
    let verdict, label;
    if (ageDays > NC_ACTIVITY_STALE_DAYS) { verdict = 'stale'; label = 'Stale'; }
    else if (!stocked) { verdict = 'unstocked'; label = 'Unstocked'; }
    else { verdict = 'active'; label = 'Active'; }
    return {
        verdict, label, color: NC_ACTIVITY_COLORS[verdict], stocked, total: exs.length, lastSeen,
        detail: `${stocked}/${exs.length} stocked · seen ${ncFormatAge(lastSeen)}`
    };
}

// Property whose drawn boundary contains this shop position (smallest wins if nested)
function ncShopBoundaryProperty(pos) {
    if (typeof ncProperties === 'undefined') return null;
    let best = null, bestArea = Infinity;
    for (const prop of ncProperties) {
        const b = prop.boundary;
        if (!Array.isArray(b) || b.length < 3) continue;
        if (!ncPointInBoundary(pos.x, pos.z, b)) continue;
        let area = 0;
        for (let i = 0, j = b.length - 1; i < b.length; j = i++) {
            area += (b[j][0] + b[i][0]) * (b[j][1] - b[i][1]);
        }
        area = Math.abs(area / 2);
        if (area < bestArea) { bestArea = area; best = prop; }
    }
    return best;
}

function ncCopyText(el, text) {
    navigator.clipboard.writeText(text);
    const orig = el.textContent;
    el.textContent = 'Copied!';
    setTimeout(() => { el.textContent = orig; }, 1200);
}

function ncShopPopupHTML(exchanges) {
    const p = exchanges[0].pos;
    const coordStr = `${p.x}, ${p.y}, ${p.z}`;
    const posKey = `${p.x},${p.y},${p.z}`;
    const link = ncGetShopLink(p);
    const linkedProp = ncGetLinkedProperty(link);
    const boundaryProp = ncShopBoundaryProperty(p);
    const nearest = ncShopNearestProperty(p);
    const canEdit = ncSurveyMode && typeof ncCanEdit === 'function' && ncCanEdit();
    const isStale = link && link.stale;

    const assocProp = linkedProp || boundaryProp || (nearest ? (typeof ncProperties !== 'undefined' ? ncProperties.find(p => p.id === nearest.id) : null) : null);
    const imgUrl = assocProp && sanitizeUrl(assocProp.image_url);

    let h = `<div class="nc-shop-popup" data-key="${posKey}">`;
    // Property image (top, same style as registry)
    if (imgUrl) {
        h += `<div class="nc-popup-img-wrap"><img src="${imgUrl}" alt=""></div>`;
    }
    h += `<div style="padding:0.4rem;max-height:${exchanges.length > 1 ? 400 : 220}px;overflow-y:auto;font-family:'Raleway',sans-serif;">`;

    // Property association header (clickable → go to registry)
    if (linkedProp && !isStale) {
        h += `<div style="font-size:0.8rem;margin-bottom:0.15rem;"><span style="color:#4caf50;font-weight:600;">Confirmed</span> <strong onclick="ncGoToRegistry('${linkedProp.id}')" style="cursor:pointer;text-decoration:underline dotted;color:#00bcd4;" title="View in registry">${ncEsc(linkedProp.name)}</strong></div>`;
    } else if (isStale) {
        h += `<div style="font-size:0.75rem;margin-bottom:0.15rem;color:var(--text-muted);font-style:italic;">Marked inactive</div>`;
    } else if (boundaryProp) {
        h += `<div style="font-size:0.8rem;margin-bottom:0.15rem;"><span style="color:#00bcd4;font-weight:600;">Inside</span> <strong onclick="ncGoToRegistry('${boundaryProp.id}')" style="cursor:pointer;text-decoration:underline dotted;color:#00bcd4;" title="View in registry">${ncEsc(boundaryProp.name)}</strong></div>`;
    } else if (nearest) {
        h += `<div style="font-size:0.75rem;margin-bottom:0.15rem;"><span style="color:#00bcd4;">Nearby</span> <strong onclick="ncGoToRegistry('${nearest.id}')" style="cursor:pointer;text-decoration:underline dotted;color:#00bcd4;" title="View in registry">${ncEsc(nearest.name)}</strong> <span style="color:var(--text-muted);">(${nearest.dist}m)</span></div>`;
    }
    // Owner + Discord (from link overrides, or associated/nearest property)
    const ownerIgn = (link && link.owner_ign) || (assocProp && assocProp.owner) || '';
    const discord = (link && link.discord_contact) || (assocProp && assocProp.discord_contact) || '';
    if (ownerIgn) {
        h += `<div style="font-size:0.8rem;margin-bottom:0.1rem;">Owner: <span style="cursor:pointer;text-decoration:underline dotted;" onclick="ncCopyText(this,'${ncEsc(ownerIgn)}')" title="Click to copy">${ncEsc(ownerIgn)}</span></div>`;
    }
    if (discord) {
        h += `<div style="font-size:0.8rem;margin-bottom:0.1rem;">Discord: <span style="cursor:pointer;text-decoration:underline dotted;" onclick="ncCopyText(this,'${ncEsc(discord)}')" title="Click to copy">${ncEsc(discord)}</span></div>`;
    }

    // Coordinates + trade count
    h += `<div style="margin-bottom:0.4rem;"><span style="font-size:0.85rem;font-weight:600;cursor:pointer;" onclick="ncCopyText(this,'${coordStr}')" title="Click to copy">${coordStr}</span> <span style="font-size:0.7rem;color:var(--text-muted);">&middot; ${exchanges.length} trade${exchanges.length !== 1 ? 's' : ''}</span></div>`;

    // Trades list — each trade gets its own View on Table + Save to Cart buttons
    exchanges.forEach((e, i) => {
        const inName = ncMatName(e.input);
        const outName = ncMatName(e.output);
        const stockStyle = e.stock > 0 ? 'color:#4caf50' : 'color:#e04040';
        const stockText = e.stock > 0 ? `In Stock (${e.stock})` : 'Out of Stock';

        if (i > 0) h += `<div style="border-top:1px solid rgba(184,180,204,0.1);"></div>`;
        h += `<div style="padding:0.25rem 0;">`;
        // Stock + age line
        h += `<div style="font-size:0.75rem;display:flex;justify-content:space-between;margin-bottom:0.15rem;">`;
        h += `<span style="${stockStyle};font-weight:600;">${stockText}</span>`;
        h += `<span style="color:var(--text-muted);">${ncFormatAge(e.time)}</span>`;
        h += `</div>`;
        // Trade line (larger, centered)
        h += `<div style="font-size:1rem;white-space:normal;text-align:center;">`;
        h += `<strong>${e.input?.count || 1}x</strong> ${ncEsc(inName)}`;
        h += ` <span style="color:var(--text-muted);">&rarr;</span> `;
        h += `<strong>${e.output?.count || 1}x</strong> ${ncEsc(outName)}`;
        h += `</div>`;
        // Per-trade View on Table + Save to Cart buttons
        const dk = ncDealKey(e);
        const qty = ncSavedDeals.get(dk) || 0;
        const isSaved = qty > 0;
        const vtBg = e.stock > 0 ? 'rgba(76,175,80,0.2)' : 'rgba(224,64,64,0.2)';
        const vtBorder = e.stock > 0 ? '#4caf50' : '#e04040';
        const pmStyle = `font-family:'Raleway',sans-serif;font-size:1rem;width:2rem;height:2rem;border-radius:4px;border:1px solid rgba(255,255,255,0.6);background:transparent;cursor:pointer;color:#fff;display:${isSaved ? 'flex' : 'none'};align-items:center;justify-content:center;`;
        h += `<div style="display:flex;align-items:center;justify-content:center;gap:0.3rem;margin-top:0.2rem;">`;
        h += `<button class="nc-shop-view-table-btn" data-key="${posKey}" style="font-family:'Raleway',sans-serif;font-size:0.7rem;padding:0.3rem 0.8rem;background:${vtBg};border:1px solid ${vtBorder};border-radius:4px;color:#fff;cursor:pointer;">View on Table</button>`;
        h += `<button class="nc-shop-popup-qty-btn" data-deal-key="${ncEsc(dk)}" data-action="minus" style="${pmStyle}">&minus;</button>`;
        h += `<button class="nc-shop-popup-save" data-deal-key="${ncEsc(dk)}" style="font-family:'Raleway',sans-serif;font-size:0.7rem;padding:0.3rem 0.8rem;background:${isSaved ? 'rgba(76,175,80,0.3)' : 'rgba(76,175,80,0.15)'};border:1px solid #4caf50;border-radius:4px;color:#fff;cursor:pointer;">${isSaved ? 'Saved (' + qty + ')' : 'Save to Cart'}</button>`;
        h += `<button class="nc-shop-popup-qty-btn" data-deal-key="${ncEsc(dk)}" data-action="plus" style="${pmStyle}">&plus;</button>`;
        h += `</div>`;
        h += `</div>`;
    });

    // Surveyor/admin edit button
    if (canEdit) {
        h += `<div style="margin-top:0.4rem;border-top:1px solid rgba(184,180,204,0.15);padding-top:0.3rem;display:flex;gap:0.3rem;flex-wrap:wrap;justify-content:center;">`;
        if (!link || !linkedProp) {
            // No confirmed link — show confirm button with nearest pre-selected
            const confirmTarget = boundaryProp || nearest;
            h += `<button class="nc-shop-link-btn" data-action="confirm" data-key="${posKey}" style="font-size:0.62rem;padding:0.2rem 0.5rem;background:rgba(76,175,80,0.2);border:1px solid #4caf50;border-radius:4px;color:#4caf50;cursor:pointer;">Confirm${confirmTarget ? ' (' + ncEsc(confirmTarget.name) + ')' : ''}</button>`;
            h += `<button class="nc-shop-link-btn" data-action="assign" data-key="${posKey}" style="font-size:0.62rem;padding:0.2rem 0.5rem;background:rgba(0,188,212,0.15);border:1px solid #00bcd4;border-radius:4px;color:#00bcd4;cursor:pointer;">Assign Other</button>`;
            h += `<button class="nc-shop-link-btn" data-action="stale" data-key="${posKey}" style="font-size:0.62rem;padding:0.2rem 0.5rem;background:rgba(224,64,64,0.15);border:1px solid #e04040;border-radius:4px;color:#e04040;cursor:pointer;">Mark Inactive</button>`;
        } else {
            h += `<button class="nc-shop-link-btn" data-action="edit" data-key="${posKey}" style="font-size:0.62rem;padding:0.2rem 0.5rem;background:rgba(138,92,246,0.15);border:1px solid #a78bfa;border-radius:4px;color:#a78bfa;cursor:pointer;">Edit Link</button>`;
            if (!isStale) {
                h += `<button class="nc-shop-link-btn" data-action="stale" data-key="${posKey}" style="font-size:0.62rem;padding:0.2rem 0.5rem;background:rgba(224,64,64,0.15);border:1px solid #e04040;border-radius:4px;color:#e04040;cursor:pointer;">Mark Inactive</button>`;
            } else {
                h += `<button class="nc-shop-link-btn" data-action="unstale" data-key="${posKey}" style="font-size:0.62rem;padding:0.2rem 0.5rem;background:rgba(76,175,80,0.15);border:1px solid #4caf50;border-radius:4px;color:#4caf50;cursor:pointer;">Mark Active</button>`;
            }
            h += `<button class="nc-shop-link-btn" data-action="unlink" data-key="${posKey}" style="font-size:0.62rem;padding:0.2rem 0.5rem;background:rgba(184,180,204,0.1);border:1px solid rgba(184,180,204,0.3);border-radius:4px;color:var(--text-muted);cursor:pointer;">Unlink</button>`;
        }
        h += `</div>`;
    }

    h += `</div></div>`;
    return h;
}

// ============================================
// Card Selection, Zoom & Carousel
// ============================================
let ncShopSelectedIdx = -1;
let _ncShopFromCard = false;

function ncShopHighlightCard(idx) {
    ncShopSelectedIdx = idx;
    const container = document.getElementById('ncShopResults');
    container.querySelectorAll('.nc-shop-card').forEach(c => c.classList.remove('active'));
    const card = container.querySelector(`.nc-shop-card[data-idx="${idx}"]`);
    if (card) {
        card.classList.add('active');
        const containerRect = container.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const scrollOffset = card.offsetLeft - container.offsetLeft - (containerRect.width / 2) + (cardRect.width / 2);
        container.scrollTo({ left: scrollOffset, behavior: 'smooth' });
    }
}

function ncShopCenterOnPoint(pos, withPopup) {
    const targetLatLng = L.latLng(-pos.z, pos.x);
    const bar = document.getElementById('ncShopBar');
    const panel = document.getElementById('ncShopPanel');
    const barH = bar ? bar.offsetHeight : 0;
    const panelH = panel ? panel.offsetHeight : 0;
    // Push dot down by bar height, pull up by popup height so popup is visible
    const popupH = withPopup ? 80 : 0;
    const offsetPx = (barH + panelH) * 0.15 - popupH;
    const targetPoint = ncMap.project(targetLatLng, 3);
    const adjustedCenter = ncMap.unproject(L.point(targetPoint.x, targetPoint.y + offsetPx), 3);
    ncMap.setView(adjustedCenter, 3, { animate: false });
}

function ncRefreshOpenShopPopup() {
    // Refresh any currently open shop popup + table save buttons
    for (const marker of ncShopMarkers) {
        if (marker.isPopupOpen && marker.isPopupOpen()) {
            const key = marker._ncShopKey;
            const exchanges = ncShopExchanges.filter(e => `${e.pos.x},${e.pos.y},${e.pos.z}` === key);
            if (exchanges.length > 0) marker.setPopupContent(ncShopPopupHTML(exchanges));
            break;
        }
    }
    // Update table save buttons
    document.querySelectorAll('.nc-shop-table-save').forEach(btn => {
        const tr = btn.closest('tr');
        if (!tr) return;
        const key = tr.dataset.dealKey;
        if (ncSavedDeals.has(key)) btn.classList.add('saved');
        else btn.classList.remove('saved');
    });
}

function ncOpenShopMarkerPopup(pos) {
    const key = `${pos.x},${pos.y},${pos.z}`;
    for (const marker of ncShopMarkers) {
        if (marker._ncShopKey === key) {
            marker.openPopup();
            return;
        }
    }
}

function ncShopSelectCard(idx) {
    ncShopHighlightCard(idx);
    const ex = ncShopFiltered[idx];
    if (ex) {
        _ncShopFromCard = true;
        ncOpenShopMarkerPopup(ex.pos);
        ncShopCenterOnPoint(ex.pos, true);
        setTimeout(() => { _ncShopFromCard = false; }, 50);
    }
}

// Click on result card → select it
document.getElementById('ncShopResults').addEventListener('click', (e) => {
    const card = e.target.closest('.nc-shop-card');
    if (card) {
        ncShopSelectCard(parseInt(card.dataset.idx));
    }
});

// Scroll arrows — infinite wrap
document.getElementById('ncShopPanelLeft').addEventListener('click', () => {
    if (ncShopFiltered.length === 0) return;
    let next = ncShopSelectedIdx - 1;
    if (next < 0) next = ncShopFiltered.length - 1;
    ncShopSelectCard(next);
});
document.getElementById('ncShopPanelRight').addEventListener('click', () => {
    if (ncShopFiltered.length === 0) return;
    let next = ncShopSelectedIdx + 1;
    if (next >= ncShopFiltered.length) next = 0;
    ncShopSelectCard(next);
});

// Touch swipe support
(function() {
    const container = document.getElementById('ncShopResults');
    let startX = 0;
    let startScrollLeft = 0;
    let isDragging = false;

    container.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        startScrollLeft = container.scrollLeft;
        isDragging = true;
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const dx = e.touches[0].clientX - startX;
        container.scrollLeft = startScrollLeft - dx;
    }, { passive: true });

    container.addEventListener('touchend', () => {
        isDragging = false;
    });

    // Mouse drag support
    container.addEventListener('mousedown', (e) => {
        startX = e.clientX;
        startScrollLeft = container.scrollLeft;
        isDragging = true;
        container.style.cursor = 'grabbing';
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        container.scrollLeft = startScrollLeft - dx;
    });

    window.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            container.style.cursor = '';
        }
    });
})();

// Keyboard left/right arrow support
document.addEventListener('keydown', (e) => {
    if (!ncShopMode || ncShopFiltered.length === 0) return;
    if (e.key === 'ArrowLeft') {
        let next = ncShopSelectedIdx - 1;
        if (next < 0) next = ncShopFiltered.length - 1;
        ncShopSelectCard(next);
    } else if (e.key === 'ArrowRight') {
        let next = ncShopSelectedIdx + 1;
        if (next >= ncShopFiltered.length) next = 0;
        ncShopSelectCard(next);
    }
});

// Filter change handlers
document.getElementById('ncShopSearch').addEventListener('input', () => { if (ncShopMode) ncFilterShops(); });
document.getElementById('ncShopPayWith').addEventListener('input', () => { if (ncShopMode) ncFilterShops(); });
document.getElementById('ncShopUnstocked').addEventListener('click', function() {
    this.classList.toggle('active');
    this.textContent = this.classList.contains('active') ? 'Hide Unstocked' : 'Show Unstocked';
    if (ncShopMode) ncFilterShops();
});
document.getElementById('ncShopMapMissing').addEventListener('click', function() {
    this.classList.toggle('active');
    this.textContent = this.classList.contains('active') ? 'Hide Missing' : 'Show Missing';
    if (ncShopMode) ncFilterShops();
});
document.getElementById('ncShopMapExact').addEventListener('click', function() {
    this.classList.toggle('active');
    this.textContent = this.classList.contains('active') ? 'Filter All' : 'Filter Exact';
    if (ncShopMode) ncFilterShops();
});

// ============================================
// Shop Link Actions (Surveyor/Admin)
// ============================================
// "Save to Cart" + +/- qty buttons in shop popups
document.addEventListener('click', function(e) {
    // Expand per-trade list
    const expandBtn = e.target.closest('.nc-shop-popup-save-expand');
    if (expandBtn) {
        e.stopPropagation();
        const list = expandBtn.parentElement.querySelector('.nc-shop-popup-save-list');
        if (list) {
            list.style.display = list.style.display === 'none' ? 'block' : 'none';
            expandBtn.textContent = list.style.display === 'none' ? 'Save to Cart' : 'Hide Deals';
        }
        return;
    }
    // +/- quantity buttons
    const qtyBtn = e.target.closest('.nc-shop-popup-qty-btn');
    if (qtyBtn) {
        e.stopPropagation();
        const key = qtyBtn.dataset.dealKey;
        const action = qtyBtn.dataset.action;
        if (!key) return;
        const cur = ncSavedDeals.get(key) || 0;
        if (action === 'plus') {
            ncSavedDealSetQty(key, cur + 1);
        } else if (action === 'minus') {
            ncSavedDealSetQty(key, cur - 1); // removes at 0
        }
        const wrap = qtyBtn.parentElement;
        const saveBtn = wrap.querySelector('.nc-shop-popup-save');
        const newQty = ncSavedDeals.get(key) || 0;
        if (saveBtn) {
            saveBtn.textContent = newQty > 0 ? 'Saved (' + newQty + ')' : 'Save to Cart';
            saveBtn.style.background = newQty > 0 ? 'rgba(76,175,80,0.3)' : 'rgba(76,175,80,0.15)';
        }
        // Hide +/- if removed
        if (newQty <= 0) {
            wrap.querySelectorAll('.nc-shop-popup-qty-btn').forEach(btn => { btn.style.display = 'none'; });
        }
        ncRenderCartPanel();
        return;
    }
    // Save/unsave a deal
    const saveBtn = e.target.closest('.nc-shop-popup-save');
    if (saveBtn) {
        e.stopPropagation();
        const key = saveBtn.dataset.dealKey;
        if (key) {
            ncToggleSavedDeal(key);
            const isSaved = ncSavedDeals.has(key);
            const qty = ncSavedDeals.get(key) || 0;
            saveBtn.textContent = isSaved ? 'Saved (' + qty + ')' : 'Save to Cart';
            saveBtn.style.background = isSaved ? 'rgba(76,175,80,0.3)' : 'rgba(76,175,80,0.15)';
            const wrap = saveBtn.parentElement;
            wrap.querySelectorAll('.nc-shop-popup-qty-btn').forEach(btn => {
                btn.style.display = isSaved ? 'flex' : 'none';
            });
            ncRenderCartPanel();
        }
        return;
    }
});

// ============================================
// "View on Table" button in shop popups
document.addEventListener('click', function(e) {
    const vtBtn = e.target.closest('.nc-shop-view-table-btn');
    if (!vtBtn) return;
    e.stopPropagation();
    const key = vtBtn.dataset.key;
    const [x, y, z] = key.split(',').map(Number);
    // Clear all table filters first
    document.querySelectorAll('.nc-shop-col-filter').forEach(f => { if (f.tagName === 'SELECT') f.value = ''; else f.value = ''; });
    // Set coords filter to show this chest's rows
    const coordsFilter = document.querySelector('.nc-shop-col-filter[data-col="coords"]');
    if (coordsFilter) coordsFilter.value = `${x}, ${y}, ${z}`;
    // Open table overlay and render
    document.getElementById('ncShopTableOverlay').classList.add('open');
    ncRenderShopTable();
});

document.addEventListener('click', async function(e) {
    const btn = e.target.closest('.nc-shop-link-btn');
    if (!btn) return;
    e.stopPropagation();
    const action = btn.dataset.action;
    const key = btn.dataset.key;
    if (!key) return;

    const [x, y, z] = key.split(',').map(Number);
    try {
        switch (action) {
            case 'confirm': await ncShopLinkConfirm(x, y, z); break;
            case 'assign':  await ncShopLinkAssign(x, y, z); break;
            case 'edit':    await ncShopLinkEdit(x, y, z); break;
            case 'stale':   await ncShopLinkSetStale(x, y, z, true); break;
            case 'unstale': await ncShopLinkSetStale(x, y, z, false); break;
            case 'unlink':  await ncShopLinkUnlink(x, y, z); break;
        }
    } catch (err) {
        console.error('Shop link action error:', err);
        alert('Error: ' + err.message);
    }
});

async function ncShopLinkConfirm(x, y, z) {
    const bProp = ncShopBoundaryProperty({ x, z });
    if (bProp) { await ncShopLinkSave(bProp.id, x, y, z); return; }
    const nearest = ncShopNearestProperty({ x, z });
    if (!nearest) { alert('No nearby properties found.'); return; }
    await ncShopLinkSave(nearest.id, x, y, z);
}

async function ncShopLinkAssign(x, y, z) {
    if (typeof ncProperties === 'undefined' || !ncProperties.length) { alert('No properties loaded.'); return; }
    const names = ncProperties.map(p => p.name).sort();
    const input = prompt('Enter property name to assign:\n\n' + names.join(', '));
    if (!input) return;
    const match = ncProperties.find(p => p.name.toLowerCase() === input.toLowerCase().trim());
    if (!match) { alert('Property not found: ' + input); return; }
    await ncShopLinkSave(match.id, x, y, z);
}

async function ncShopLinkSave(propertyId, x, y, z) {
    const displayName = currentUser?.user_metadata?.full_name || currentUser?.user_metadata?.name || 'Unknown';
    const key = `${x},${y},${z}`;
    const existing = ncShopLinks[key];
    if (existing) {
        await supabaseDelete('nc_property_shops', existing.id);
    }
    await supabaseInsert('nc_property_shops', {
        property_id: propertyId,
        shop_x: x, shop_y: y, shop_z: z,
        confirmed_by: currentUser.id,
        confirmed_by_name: displayName
    });
    await ncLoadShopLinks();
    ncRefreshShopPopup(key);
}

async function ncShopLinkEdit(x, y, z) {
    const key = `${x},${y},${z}`;
    const link = ncShopLinks[key];
    if (!link) return;
    const ownerIgn = prompt('Owner IGN:', link.owner_ign || '');
    if (ownerIgn === null) return;
    const discord = prompt('Discord contact:', link.discord_contact || '');
    if (discord === null) return;
    await supabaseUpdate('nc_property_shops', link.id, {
        owner_ign: ownerIgn || null,
        discord_contact: discord || null
    });
    await ncLoadShopLinks();
    ncRefreshShopPopup(key);
}

async function ncShopLinkSetStale(x, y, z, stale) {
    const key = `${x},${y},${z}`;
    const link = ncShopLinks[key];
    if (link) {
        await supabaseUpdate('nc_property_shops', link.id, { stale });
    } else {
        // No link yet — create one with stale flag using nearest property
        const nearest = ncShopNearestProperty({ x, z });
        if (!nearest) { alert('No nearby property to associate with.'); return; }
        const displayName = currentUser?.user_metadata?.full_name || currentUser?.user_metadata?.name || 'Unknown';
        await supabaseInsert('nc_property_shops', {
            property_id: nearest.id,
            shop_x: x, shop_y: y, shop_z: z,
            confirmed_by: currentUser.id,
            confirmed_by_name: displayName,
            stale: true
        });
    }
    await ncLoadShopLinks();
    ncRefreshShopPopup(key);
}

async function ncShopLinkUnlink(x, y, z) {
    const key = `${x},${y},${z}`;
    const link = ncShopLinks[key];
    if (!link) return;
    if (!confirm('Unlink this shop from its property?')) return;
    await supabaseDelete('nc_property_shops', link.id);
    await ncLoadShopLinks();
    ncRefreshShopPopup(key);
}

function ncRefreshShopPopup(key) {
    const exchanges = ncShopFiltered.filter(e => `${e.pos.x},${e.pos.y},${e.pos.z}` === key);
    if (exchanges.length === 0) return;
    for (const marker of ncShopMarkers) {
        if (marker._ncShopKey === key) {
            marker.setPopupContent(ncShopPopupHTML(exchanges));
            return;
        }
    }
}

// ============================================
// Shop Spreadsheet / Table View
// ============================================
let ncShopTableSort = { col: 'store', asc: true };
const ncShopColLabels = { store: 'Store', discord: 'Discord', sellQty: 'Qty', selling: 'Output', buyQty: 'Qty', buyItem: 'Input', stock: 'Stock', coords: 'Coords', age: 'Updated' };

document.getElementById('ncShopTableBtn').addEventListener('click', () => {
    document.getElementById('ncShopTableOverlay').classList.add('open');
    ncRenderShopTable();
});

document.getElementById('ncShopTableClose').addEventListener('click', () => {
    document.getElementById('ncShopTableOverlay').classList.remove('open');
});

// Column filter inputs
document.querySelectorAll('.nc-shop-col-filter').forEach(input => {
    input.addEventListener('input', () => ncRenderShopTable());
});
document.getElementById('ncShopDateFilter').addEventListener('change', () => ncRenderShopTable());

// Clear Filters button in table
document.getElementById('ncShopTableClearFilters').addEventListener('click', function() {
    // Reset all column filter inputs
    document.querySelectorAll('.nc-shop-col-filter').forEach(f => {
        if (f.tagName === 'SELECT') f.value = '';
        else f.value = '';
    });
    // Reset all toggle buttons to default (inactive)
    const unstocked = document.getElementById('ncShopTableUnstocked');
    unstocked.classList.remove('active');
    unstocked.textContent = 'Show Unstocked';
    const missing = document.getElementById('ncShopTableMissing');
    missing.classList.remove('active');
    missing.textContent = 'Show Missing';
    const exact = document.getElementById('ncShopTableExact');
    exact.classList.remove('active');
    exact.textContent = 'Filter Exact';
    const saved = document.getElementById('ncShopTableSaved');
    saved.classList.remove('active');
    saved.textContent = 'Show Saved';
    ncRenderShopTable();
});

// Unstocked toggle in table
document.getElementById('ncShopTableUnstocked').addEventListener('click', function() {
    this.classList.toggle('active');
    this.textContent = this.classList.contains('active') ? 'Hide Unstocked' : 'Show Unstocked';
    ncRenderShopTable();
});

// Missing chests toggle (chests with no associated store)
document.getElementById('ncShopTableMissing').addEventListener('click', function() {
    this.classList.toggle('active');
    this.textContent = this.classList.contains('active') ? 'Hide Missing' : 'Show Missing';
    ncRenderShopTable();
});

// Exact matches toggle
document.getElementById('ncShopTableExact').addEventListener('click', function() {
    this.classList.toggle('active');
    this.textContent = this.classList.contains('active') ? 'Filter All' : 'Filter Exact';
    ncRenderShopTable();
});

// Show Saved toggle
document.getElementById('ncShopTableSaved').addEventListener('click', function() {
    this.classList.toggle('active');
    this.textContent = this.classList.contains('active') ? 'Show All' : 'Show Saved';
    ncRenderShopTable();
});

document.getElementById('ncShopTable').querySelector('thead tr:first-child').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const col = th.dataset.sort;
    if (ncShopTableSort.col === col) {
        ncShopTableSort.asc = !ncShopTableSort.asc;
    } else {
        ncShopTableSort = { col, asc: true };
    }
    ncRenderShopTable();
});

function ncShopColFilter(col) {
    const input = document.querySelector(`.nc-shop-col-filter[data-col="${col}"]`);
    return input ? input.value.toLowerCase().trim() : '';
}

function ncShopTableRow(e) {
    const link = ncGetShopLink(e.pos);
    const linkedProp = ncGetLinkedProperty(link);
    const nearest = ncShopNearestProperty(e.pos);
    const assocProp = linkedProp || ncShopBoundaryProperty(e.pos)
        || (nearest && typeof ncProperties !== 'undefined' ? ncProperties.find(p => p.id === nearest.id) : null);
    const propName = assocProp ? assocProp.name : '';
    const propId = assocProp ? assocProp.id : null;
    const discordContact = (link && link.discord_contact) || (assocProp && assocProp.discord_contact) || '';
    const outName = ncMatName(e.output);
    const inName = ncMatName(e.input);
    const inCount = e.input?.count || 1;
    const outCount = e.output?.count || 1;
    return { e, propName, propId, discordContact, outName, outCount, inName, inCount };
}

function ncRenderShopTable() {
    const tbody = document.getElementById('ncShopTableBody');
    const showUnstocked = document.getElementById('ncShopTableUnstocked').classList.contains('active');
    const hideMissing = !document.getElementById('ncShopTableMissing').classList.contains('active');
    const exactMatch = document.getElementById('ncShopTableExact').classList.contains('active');
    const showSavedOnly = document.getElementById('ncShopTableSaved').classList.contains('active');
    const match = (val, filter) => exactMatch ? val.toLowerCase() === filter : val.toLowerCase().includes(filter);

    // Column filters
    const fStore = ncShopColFilter('store');
    const fDiscord = ncShopColFilter('discord');
    const fSelling = ncShopColFilter('selling');
    const fBuyItem = ncShopColFilter('buyItem');
    const fCoords = ncShopColFilter('coords');
    const fSellQty = ncShopColFilter('sellQty');
    const fBuyQty = ncShopColFilter('buyQty');
    const fStock = ncShopColFilter('stock');

    let rows = ncShopExchanges
        .filter(e => {
            const lk = ncGetShopLink(e.pos);
            if (lk && lk.stale) return false;
            if (!fCoords && !showUnstocked && e.stock <= 0) return false;
            return true;
        })
        .map(e => ncShopTableRow(e));

    // Hide missing (no associated store) — skip when coord filter is active
    if (!fCoords && hideMissing) rows = rows.filter(r => r.propName !== '');

    // Apply column filters (all active at once)
    if (fStore) rows = rows.filter(r => match(r.propName, fStore));
    if (fDiscord) rows = rows.filter(r => match(r.discordContact, fDiscord));
    if (fSelling) rows = rows.filter(r => match(r.outName, fSelling));
    if (fBuyItem) rows = rows.filter(r => match(r.inName, fBuyItem));
    if (fCoords) rows = rows.filter(r => `${r.e.pos.x}, ${r.e.pos.y}, ${r.e.pos.z}`.includes(fCoords));
    if (fSellQty) rows = rows.filter(r => String(r.outCount).includes(fSellQty));
    if (fBuyQty) rows = rows.filter(r => String(r.inCount).includes(fBuyQty));
    if (fStock) rows = rows.filter(r => String(r.e.stock != null ? r.e.stock : '').includes(fStock));
    const fDate = document.getElementById('ncShopDateFilter').value;
    if (fDate) {
        const now = Date.now();
        const ms = fDate.endsWith('h') ? parseInt(fDate) * 3600000 : parseInt(fDate) * 86400000;
        rows = rows.filter(r => r.e.time >= now - ms);
    }
    if (showSavedOnly) rows = rows.filter(r => ncSavedDeals.has(ncDealKey(r.e)));

    const dir = ncShopTableSort.asc ? 1 : -1;
    rows.sort((a, b) => {
        switch (ncShopTableSort.col) {
            case 'store': return dir * a.propName.localeCompare(b.propName);
            case 'discord': return dir * a.discordContact.localeCompare(b.discordContact);
            case 'sellQty': return dir * (a.outCount - b.outCount);
            case 'selling': return dir * a.outName.localeCompare(b.outName);
            case 'buyQty': return dir * (a.inCount - b.inCount);
            case 'buyItem': return dir * a.inName.localeCompare(b.inName);
            case 'stock': return dir * (a.e.stock - b.e.stock);
            case 'coords': return dir * (a.e.pos.x - b.e.pos.x || a.e.pos.z - b.e.pos.z);
            case 'age': return dir * (a.e.time - b.e.time);
            default: return 0;
        }
    });

    // Update sort indicators on headers
    document.querySelectorAll('#ncShopTable thead tr:first-child th[data-sort]').forEach(th => {
        th.style.cursor = 'pointer';
        const col = th.dataset.sort;
        const label = ncShopColLabels[col] || col;
        const arrow = ncShopTableSort.col === col ? (ncShopTableSort.asc ? ' \u25B2' : ' \u25BC') : '';
        th.textContent = label + arrow;
    });

    const locateSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="10" r="3"/><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>';
    const checkSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

    let html = '';
    rows.forEach(r => {
        const e = r.e;
        const coordStr = `${e.pos.x}, ${e.pos.y}, ${e.pos.z}`;
        const dealKey = ncDealKey(e);
        const isSaved = ncSavedDeals.has(dealKey);
        const isUnstocked = e.stock <= 0;
        const isMissing = !r.propName;
        const rowClass = isMissing ? ' class="nc-shop-row-missing"' : isUnstocked ? ' class="nc-shop-row-unstocked"' : '';
        html += `<tr${rowClass} data-x="${e.pos.x}" data-y="${e.pos.y}" data-z="${e.pos.z}" data-prop-id="${r.propId || ''}" data-deal-key="${ncEsc(dealKey)}">`;
        const qty = ncSavedDeals.get(dealKey) || 1;
        const qtyBtns = isSaved ? `<button class="nc-shop-table-qty-btn" data-delta="-1" title="Decrease">&minus;</button><span style="font-size:0.7rem;min-width:1.2rem;text-align:center;">${qty}</span><button class="nc-shop-table-qty-btn" data-delta="1" title="Increase">+</button>` : '';
        html += `<td><div class="nc-shop-table-save-cell"><button class="nc-shop-table-save${isSaved ? ' saved' : ''}" title="Save deal">${checkSvg}</button>${qtyBtns}</div></td>`;
        html += `<td><button class="nc-table-locate nc-shop-table-locate" title="Show on map">${locateSvg}</button></td>`;
        html += `<td class="nc-shop-table-copy" style="cursor:pointer;white-space:nowrap;" title="Click to copy" data-copy="${coordStr}">${coordStr}</td>`;
        html += `<td style="font-weight:600;white-space:nowrap;">${r.outCount}</td>`;
        html += `<td class="nc-shop-table-copy" style="cursor:pointer;white-space:nowrap;" title="Click to copy" data-copy="${ncEsc(r.outName)}">${ncEsc(r.outName)}</td>`;
        html += `<td style="font-weight:600;white-space:nowrap;">${r.inCount}</td>`;
        html += `<td class="nc-shop-table-copy" style="cursor:pointer;white-space:nowrap;" title="Click to copy" data-copy="${ncEsc(r.inName)}">${ncEsc(r.inName)}</td>`;
        html += `<td style="white-space:nowrap;">${e.stock != null ? e.stock : '—'}</td>`;
        html += `<td class="nc-shop-table-prop" style="cursor:pointer;text-decoration:underline dotted;color:#00bcd4;white-space:nowrap;" title="View in registry">${ncEsc(r.propName)}</td>`;
        html += `<td class="nc-shop-table-copy" style="cursor:pointer;white-space:nowrap;" title="Click to copy" data-copy="${ncEsc(r.discordContact)}">${ncEsc(r.discordContact)}</td>`;
        html += `<td style="white-space:nowrap;">${ncFormatAge(e.time)}</td>`;
        html += `</tr>`;
    });

    tbody.innerHTML = html || '<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:2rem;">No deals found.</td></tr>';
    ncUpdateTableCartBadge();
}

// Click handlers for shop table
document.getElementById('ncShopTableBody').addEventListener('click', (e) => {
    // +/- qty buttons
    if (e.target.closest('.nc-shop-table-qty-btn')) {
        const btn = e.target.closest('.nc-shop-table-qty-btn');
        const tr = btn.closest('tr');
        if (!tr) return;
        const key = tr.dataset.dealKey;
        const delta = parseInt(btn.dataset.delta);
        if (key && ncSavedDeals.has(key)) {
            const cur = ncSavedDeals.get(key) || 1;
            const next = cur + delta;
            if (next <= 0) {
                ncSavedDeals.delete(key);
                ncPersistSavedDeals();
                ncSavedDealRemoteDelete(key);
            } else {
                ncSavedDeals.set(key, next);
                ncPersistSavedDeals();
            }
            ncRenderShopTable();
            ncRenderCartPanel();
            ncUpdateCartBadge();
            ncUpdateTableCartBadge();
        }
        return;
    }

    // Save button → toggle saved deal
    if (e.target.closest('.nc-shop-table-save')) {
        const tr = e.target.closest('tr');
        if (!tr) return;
        const key = tr.dataset.dealKey;
        if (key) {
            ncToggleSavedDeal(key);
            ncRenderShopTable();
            ncRenderCartPanel();
            ncUpdateTableCartBadge();
        }
        return;
    }

    // Locate button → jump to chest on map
    if (e.target.closest('.nc-shop-table-locate')) {
        const tr = e.target.closest('tr');
        if (!tr) return;
        const x = parseInt(tr.dataset.x), y = parseInt(tr.dataset.y), z = parseInt(tr.dataset.z);
        document.getElementById('ncShopTableOverlay').classList.remove('open');
        const idx = ncShopFiltered.findIndex(ex => ex.pos.x === x && ex.pos.y === y && ex.pos.z === z);
        if (idx >= 0) ncShopSelectCard(idx);
        return;
    }

    // Property name → switch to registry and highlight property
    if (e.target.closest('.nc-shop-table-prop')) {
        const tr = e.target.closest('tr');
        const propId = tr && tr.dataset.propId;
        if (!propId || typeof ncProperties === 'undefined') return;
        // dataset values are always strings; p.id may be number — use == for comparison
        const propIdx = ncProperties.findIndex(p => String(p.id) === propId);
        if (propIdx < 0) return;
        document.getElementById('ncShopTableOverlay').classList.remove('open');
        // Clear all registry filters so the property is guaranteed visible
        if (typeof ncClearAllFilters === 'function') ncClearAllFilters();
        ncExitShopMode();
        filterNCMarkers('');
        setTimeout(() => {
            const card = document.querySelector(`.nc-panel-card[data-index="${propIdx}"]`);
            if (card) {
                card.style.display = '';
                highlightNCProperty(propIdx, card);
            }
        }, 350);
        return;
    }

    // Click-to-copy cells
    if (e.target.closest('.nc-shop-table-copy')) {
        const cell = e.target.closest('.nc-shop-table-copy');
        const text = cell.dataset.copy;
        if (text) ncCopyText(cell, text);
        return;
    }
});

// Table cart badge update (no-op, button removed)
function ncUpdateTableCartBadge() {}

// ============================================
// Cart Panel
// ============================================
document.getElementById('ncCartBtn').addEventListener('click', () => {
    const panel = document.getElementById('ncCartPanel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) ncRenderCartPanel();
});

document.getElementById('ncCartClose').addEventListener('click', () => {
    document.getElementById('ncCartPanel').classList.remove('open');
});

document.getElementById('ncCartClear').addEventListener('click', () => {
    ncSavedDeals.clear();
    ncPersistSavedDeals();
    ncSavedDealRemoteClearAll();
    ncRenderCartPanel();
    ncRefreshOpenShopPopup();
});

// Show Saved / Show All toggle in cart panel — filters the map
document.getElementById('ncCartShowSaved').addEventListener('click', function() {
    ncShopShowSavedOnly = !ncShopShowSavedOnly;
    this.classList.toggle('active', ncShopShowSavedOnly);
    this.textContent = ncShopShowSavedOnly ? 'Show All' : 'Show Saved';
    ncFilterShops();
});

document.getElementById('ncCartList').addEventListener('click', (e) => {
    // +/- quantity buttons in cart rows
    const qtyBtn = e.target.closest('.nc-shop-cart-qty-btn');
    if (qtyBtn) {
        const key = qtyBtn.dataset.key;
        const action = qtyBtn.dataset.action;
        if (!key) return;
        const cur = ncSavedDeals.get(key) || 0;
        if (action === 'plus') {
            ncSavedDealSetQty(key, cur + 1);
        } else if (action === 'minus') {
            ncSavedDealSetQty(key, cur - 1); // removes at 0
        }
        ncRenderCartPanel();
        ncRefreshOpenShopPopup();
        return;
    }
    if (e.target.closest('.nc-shop-cart-remove')) {
        const key = e.target.closest('.nc-shop-cart-remove').dataset.key;
        if (key) {
            ncSavedDeals.delete(key);
            ncSavedDealRemoteDelete(key);
            ncPersistSavedDeals();
            ncRenderCartPanel();
            ncRefreshOpenShopPopup();
        }
        return;
    }
    // Click deal row → navigate to popup on map
    const goto = e.target.closest('.nc-shop-cart-goto');
    if (goto) {
        const x = parseInt(goto.dataset.x), y = parseInt(goto.dataset.y), z = parseInt(goto.dataset.z);
        document.getElementById('ncCartPanel').classList.remove('open');
        const idx = ncShopFiltered.findIndex(ex => ex.pos.x === x && ex.pos.y === y && ex.pos.z === z);
        if (idx >= 0) ncShopSelectCard(idx);
    }
});

function ncRenderCartPanel() {
    const summaryEl = document.getElementById('ncCartSummary');
    const listEl = document.getElementById('ncCartList');

    // Find matching exchanges for saved keys
    const saved = [];
    ncSavedDeals.forEach((qty, key) => {
        const ex = ncShopExchanges.find(e => ncDealKey(e) === key);
        if (ex) saved.push({ key, qty, e: ex });
    });

    // Summary: aggregate inputs and outputs (multiplied by qty)
    const inputs = {};
    const outputs = {};
    saved.forEach(({ e, qty }) => {
        const inMat = ncMatName(e.input);
        const outMat = ncMatName(e.output);
        const inCount = (e.input?.count || 1) * qty;
        const outCount = (e.output?.count || 1) * qty;
        inputs[inMat] = (inputs[inMat] || 0) + inCount;
        outputs[outMat] = (outputs[outMat] || 0) + outCount;
    });

    let summaryHtml = '';
    if (saved.length > 0) {
        summaryHtml += '<div class="nc-shop-cart-summary-label">Total Inputs (You Pay)</div>';
        summaryHtml += Object.entries(inputs).map(([mat, q]) => `<div>${q}x ${ncEsc(mat)}</div>`).join('');
        summaryHtml += '<div class="nc-shop-cart-summary-label" style="margin-top:0.4rem;">Total Outputs (You Get)</div>';
        summaryHtml += Object.entries(outputs).map(([mat, q]) => `<div>${q}x ${ncEsc(mat)}</div>`).join('');
    } else {
        summaryHtml = '<div style="color:var(--text-muted);font-style:italic;">No deals saved yet.</div>';
    }
    summaryEl.innerHTML = summaryHtml;

    // Deal list
    let listHtml = '';
    saved.forEach(({ key, qty, e }) => {
        const inName = ncMatName(e.input);
        const outName = ncMatName(e.output);
        const coordStr = `${e.pos.x}, ${e.pos.y}, ${e.pos.z}`;
        const stockStyle = e.stock > 0 ? 'color:#4caf50' : 'color:#e04040';
        const stockLabel = e.stock > 0 ? `In Stock (${e.stock})` : 'Out';
        const qtyLabel = qty > 1 ? ` <span style="color:var(--accent);">×${qty}</span>` : '';
        listHtml += `<div class="nc-shop-cart-row">`;
        listHtml += `<div class="nc-shop-cart-goto" data-x="${e.pos.x}" data-y="${e.pos.y}" data-z="${e.pos.z}" style="flex:1;min-width:0;cursor:pointer;">`;
        listHtml += `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><strong>${e.input?.count || 1}x</strong> ${ncEsc(inName)} → <strong>${e.output?.count || 1}x</strong> ${ncEsc(outName)}${qtyLabel}</div>`;
        listHtml += `<div style="font-size:0.6rem;color:var(--text-muted);">${coordStr} · <span style="${stockStyle}">${stockLabel}</span> · ${ncFormatAge(e.time)}</div>`;
        listHtml += `</div>`;
        listHtml += `<div class="nc-shop-cart-row-btns">`;
        listHtml += `<button class="nc-shop-cart-qty-btn" data-key="${ncEsc(key)}" data-action="minus" title="Decrease">&minus;</button>`;
        listHtml += `<button class="nc-shop-cart-qty-btn" data-key="${ncEsc(key)}" data-action="plus" title="Increase">&plus;</button>`;
        listHtml += `<button class="nc-shop-cart-remove" data-key="${ncEsc(key)}" title="Remove">&times;</button>`;
        listHtml += `</div>`;
        listHtml += `</div>`;
    });
    listEl.innerHTML = listHtml;

    ncUpdateCartBadge();
}

// ============================================
// Terminal — Market Intelligence Dashboard
// ============================================
const TERMINAL_CITIES = [
    { name: 'New Callisto', x: -3272, z: 8100 },
    { name: 'Pavia', x: 662, z: -3039 },
    { name: 'Icenia', x: -3849, z: -4363 },
    { name: 'Volterra', x: -1070, z: -1173 },
    { name: 'Danzilona', x: 5251, z: 4530 },
    { name: 'Shiroyama', x: 3367, z: 5045 },
    { name: 'Kallopolis', x: -961, z: -3552 },
    { name: 'Blue Cove', x: -9140, z: -404 },
    { name: 'Suramir', x: 1, z: -600 },
    { name: 'Shockton', x: -1603, z: -1137 },
    { name: 'Adria', x: 2599, z: -3999 },
    { name: 'Mosskow', x: 5852, z: -6530 },
    { name: 'Roma', x: 3088, z: -5376 },
    { name: 'England', x: 3774, z: -5937 },
    { name: 'Altepetl', x: 7609, z: -738 },
    { name: "Ila'Kyavul", x: 7053, z: 3655 },
    { name: 'Santiago', x: 6462, z: 3036 },
    { name: 'Brunsvik', x: -7309, z: 4697 },
    { name: 'Kardyia', x: -8152, z: 1342 },
    { name: 'Withervale', x: -6550, z: 6840 },
    { name: 'Groveheart', x: -5971, z: 5529 },
    { name: 'Regenburg', x: -3500, z: 8901 },
    { name: 'Florabis', x: -3350, z: 9244 },
    { name: 'Lambat City', x: 3829, z: -1350 },
];

let terminalCurrentTool = null;

// --- World Map state ---
let worldMap = null;
let worldMapExchanges = [];
let worldMapMarkers = [];
let worldMapCityLabels = [];
let worldMapDataReady = false;
let worldMapFiltered = [];     // filtered exchanges for carousel
let worldMapSelectedIdx = -1;  // selected carousel card index
let worldMapTableSort = { col: 'city', asc: true };
const worldMapColLabels = { city: 'City', coords: 'Coords', sellQty: 'Qty', selling: 'Output', buyQty: 'Qty', buyItem: 'Input', stock: 'Stock', age: 'Updated' };

// --- Custom Cities (Supabase-persisted) ---
let terminalCustomCities = [];
let terminalCustomCitiesLoaded = false;

async function terminalLoadCustomCities() {
    try {
        const rows = await supabaseRest('terminal_cities', 'select=id,name,x,z&order=name');
        terminalCustomCities = rows.map(r => ({ id: r.id, name: r.name, x: r.x, z: r.z, _isCustom: true }));
        terminalCustomCitiesLoaded = true;
    } catch (e) {
        console.warn('Failed to load custom cities:', e);
        terminalCustomCitiesLoaded = true;
    }
}

function terminalAllCities() {
    return [...TERMINAL_CITIES, ...terminalCustomCities];
}

function loadTerminal() {
    const toolsEl = document.getElementById('terminalTools');
    const panelEl = document.getElementById('terminalPanel');
    if (!toolsEl) return;
    panelEl.style.display = 'none';
    toolsEl.style.display = '';
    terminalCurrentTool = null;

    const showGetTerminal = !currentUser || !userProfile?.terminal;

    const consultDisabled = showGetTerminal ? ' terminal-tool-disabled' : '';
    toolsEl.innerHTML = `
        <div class="terminal-tool-card" data-tool="arbitrage">
            <div class="terminal-tool-icon">&#x21C4;</div>
            <h3>Arbitrage Finder</h3>
            <p>Live cross-market profit identification and routing tool for CivMc. Free Samples.</p>
        </div>
        <div class="terminal-tool-card terminal-tool-disabled" data-tool="intel">
            <span class="terminal-ribbon">Coming Soon</span>
            <div class="terminal-tool-icon">&#x2637;</div>
            <h3>Market Intelligence</h3>
            <p>Investment-grade information and analysis of equities listed on the Pavian Stock Exchange.</p>
        </div>
        <div class="terminal-tool-card${consultDisabled}" data-tool="consult">
            <div class="terminal-tool-icon">&#x2709;</div>
            <h3>Schedule a Consultation</h3>
            <p>Terminal entitles you to two monthly confidential consultations. Schedule here.</p>
        </div>
        <div class="terminal-tool-card terminal-tool-disabled" data-tool="notifications">
            <span class="terminal-ribbon">Coming Soon</span>
            <div class="terminal-tool-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></div>
            <h3>Price Notifications</h3>
            <p>Create standing orders for goods or exchange rates and choose how you would like to be notified.</p>
        </div>
        <div class="terminal-tool-card terminal-tool-disabled" data-tool="deals">
            <span class="terminal-ribbon">Coming Soon</span>
            <div class="terminal-tool-icon">&#x2616;</div>
            <h3>Off-Market Deals</h3>
            <p>List, access, and execute real estate, fixed income, private equities, and bulk goods off market.</p>
        </div>
        <div class="terminal-tool-card terminal-tool-disabled" data-tool="oracle">
            <span class="terminal-ribbon">Coming Soon</span>
            <div class="terminal-tool-icon">&#x25C8;</div>
            <h3>Doug</h3>
            <p>Chat with an A.I. trained on live CivMC data.</p>
        </div>
    ` + (isAdmin ? `
        <div class="terminal-tool-card worldmap-tool-admin" data-tool="worldmap">
            <div class="terminal-tool-icon">&#x1F5FA;</div>
            <h3>World Map</h3>
            <p>Interactive map of all shop chests across CivMC. Admin tool.</p>
        </div>
    ` : '')
    + (showGetTerminal ? '<div class="terminal-get-btn-wrap"><button class="terminal-get-btn" id="terminalGetBtn">Get Terminal</button></div>' : '');

    toolsEl.querySelectorAll('.terminal-tool-card').forEach(card => {
        card.addEventListener('click', () => {
            if (card.classList.contains('terminal-tool-disabled')) return;
            const tool = card.dataset.tool;
            if (tool === 'arbitrage') terminalOpenArbitrage();
            if (tool === 'consult') terminalOpenConsultation();
            if (tool === 'worldmap') terminalOpenWorldMap();
        });
    });

    // "Get Terminal" popup
    const getBtn = document.getElementById('terminalGetBtn');
    if (getBtn) getBtn.addEventListener('click', () => {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const dayOfMonth = now.getDate();
        const daysRemaining = daysInMonth - dayOfMonth + 1;
        const prorated = Math.round((daysRemaining / daysInMonth) * 50);
        const total = prorated + 50;

        const existing = document.getElementById('terminalGetPopup');
        if (existing) existing.remove();
        const popup = document.createElement('div');
        popup.id = 'terminalGetPopup';
        popup.className = 'terminal-trade-popup';
        popup.innerHTML = '<div class="terminal-trade-popup-inner">'
            + '<button class="terminal-trade-popup-close">&times;</button>'
            + '<h3>Get Terminal</h3>'
            + '<p style="font-size:1.1rem;text-align:center;margin-bottom:1rem;"><strong style="color:#d4c8a0;font-size:1.3rem;">50 Diamonds / Month</strong></p>'
            + '<p>Send <strong>' + total + ' Diamonds</strong> (' + prorated + 'd prorated for remainder of ' + now.toLocaleString('en-US', { month: 'long' }) + ' + 50d for next month) to <strong>HS-FRIS</strong> to unlock all of Maison Fris Terminal for this month and next.</p>'
            + '<p style="font-size:0.75rem;color:var(--text-muted);text-align:center;margin-top:0.75rem;">Monthly price will raise to 100 diamonds a month upon completion of current shown features.</p>'
            + '<ul style="font-size:0.75rem;color:var(--text-muted);margin:1rem 0;padding-left:1.2rem;line-height:1.8;">'
            + '<li>Monthly subscription. Payments required at least 24 hours prior to the 1st of each month.</li>'
            + '<li>Allow up to 24 hours for confirmation and access.</li>'
            + '<li>Limit one user per license.</li>'
            + '<li>Sharing data or abuse will result in a ban and a bounty.</li>'
            + '<li>Enterprise rates available upon request.</li>'
            + '</ul>'
            + '<p style="font-size:0.65rem;color:var(--text-muted);font-style:italic;margin-top:1rem;line-height:1.6;">Terminal is an evolving product and functionality is intended but not always guaranteed. Certain features may be limited or greyed out depending on the needs of the firm.</p>'
            + '</div>';
        document.body.appendChild(popup);
        popup.querySelector('.terminal-trade-popup-close').addEventListener('click', () => popup.remove());
        popup.addEventListener('click', (ev) => { if (ev.target === popup) popup.remove(); });
    });

    document.getElementById('terminalBackBtn').onclick = () => {
        if (terminalCurrentTool === 'worldmap' && worldMap) {
            worldMap.remove();
            worldMap = null;
        }
        document.querySelector('.terminal-container')?.classList.remove('terminal-worldmap-active');
        panelEl.style.display = 'none';
        toolsEl.style.display = '';
        terminalCurrentTool = null;
        document.getElementById('terminalSubtitle').textContent = 'by Maison Fris';
        document.getElementById('terminalRefreshBtn').style.display = '';
    };

    // Pre-fetch arbitrage data in background
    terminalPrefetch();
}

// --- Arbitrage state ---
let terminalArbData = [];       // all computed arb opportunities (unfiltered)
let terminalCityTrades = {};    // trades grouped by city
let terminalTotalExchanges = 0;
let terminalArbSort = { col: 'netProfit', dir: 'desc' };
let terminalArbFilters = { city: '', material: '', sameCity: false, hideStale: false, diamondStart: false, staleHours: 48, maxDist: false, maxDistBlocks: 3000 };
let terminalAutoRefreshId = null;
let terminalPrefetchPromise = null; // background fetch promise

// Server-verified terminal gate (closure-protected, tamper-resistant)
const _terminalGate = (() => {
    let _paid = false;
    function _showTamperToast() {
        let t = document.getElementById('terminalTamperToast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'terminalTamperToast';
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#d4c8a0;color:#1a1730;padding:10px 24px;border-radius:6px;font-family:Raleway,sans-serif;font-size:0.85rem;font-weight:600;z-index:99999;opacity:0;transition:opacity 0.3s;';
            document.body.appendChild(t);
        }
        t.textContent = 'Terminal access required.';
        t.style.opacity = '1';
        clearTimeout(t._tid);
        t._tid = setTimeout(() => { t.style.opacity = '0'; }, 3000);
    }
    // Honeypot: trap the obvious global name
    Object.defineProperty(window, '_terminalVerifiedPaid', {
        get() { return _paid; },
        set() { _showTamperToast(); },
        configurable: false, enumerable: false
    });
    return Object.freeze({
        async verify() {
            if (!currentUser || !currentAccessToken) { _paid = false; return false; }
            try {
                const rows = await supabaseRest('profiles', `select=terminal&id=eq.${currentUser.id}`);
                _paid = rows?.[0]?.terminal === true;
            } catch { _paid = false; }
            return _paid;
        },
        get isPaid() { return _paid; }
    });
})();

function terminalPrefetch() {
    terminalPrefetchPromise = terminalFetchArbitrage();
}

async function terminalOpenArbitrage() {
    const toolsEl = document.getElementById('terminalTools');
    const panelEl = document.getElementById('terminalPanel');
    toolsEl.style.display = 'none';
    panelEl.style.display = '';
    terminalCurrentTool = 'arbitrage';
    document.getElementById('terminalSubtitle').textContent = 'Arbitrage Finder';
    // Verify terminal status server-side first
    await _terminalGate.verify();

    const refreshBtn = document.getElementById('terminalRefreshBtn');
    if (_terminalGate.isPaid) {
        refreshBtn.style.display = '';
        refreshBtn.onclick = () => loadTerminalArbitrage(true);
    } else {
        refreshBtn.style.display = 'none';
    }

    // Use prefetched data if available, otherwise fetch fresh
    if (terminalPrefetchPromise) {
        const body = document.getElementById('terminalPanelBody');
        body.innerHTML = '<div class="terminal-loading">Scanning markets...</div>';
        terminalPrefetchPromise.then(() => {
            if (terminalCurrentTool === 'arbitrage') terminalRenderArbitrage();
        }).catch(() => {
            body.innerHTML = '<div class="terminal-loading">Failed to fetch market data. Try refreshing.</div>';
        });
        terminalPrefetchPromise = null;
    } else {
        loadTerminalArbitrage();
    }

    // Auto-refresh every 5 minutes (paid users only)
    if (terminalAutoRefreshId) clearInterval(terminalAutoRefreshId);
    if (_terminalGate.isPaid) {
        terminalAutoRefreshId = setInterval(() => {
            if (terminalCurrentTool === 'arbitrage') loadTerminalArbitrage();
        }, 300000);
    }
}

function terminalTimeAgo(epochMs) {
    if (!epochMs) return 'unknown';
    const diff = Date.now() - epochMs;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    return days + 'd ago';
}

function terminalFreshClass(epochMs) {
    if (!epochMs) return 'stale';
    const hrs = (Date.now() - epochMs) / 3600000;
    if (hrs < 6) return 'fresh';
    if (hrs < 48) return 'aging';
    return 'stale';
}

function terminalClosestCity(x, z) {
    let best = 'Unknown';
    let bestDist = Infinity;
    for (const c of terminalAllCities()) {
        const dx = x - c.x;
        const dz = z - c.z;
        const dist = dx * dx + dz * dz;
        if (dist < bestDist) { bestDist = dist; best = c.name; }
    }
    return { name: best, dist: Math.round(Math.sqrt(bestDist)) };
}

function terminalDistance(p1, p2) {
    const dx = p1.x - p2.x;
    const dz = p1.z - p2.z;
    return Math.round(Math.sqrt(dx * dx + dz * dz));
}

function terminalCopyCoords(x, y, z) {
    const text = x + ' ' + y + ' ' + z;
    navigator.clipboard.writeText(text).then(() => {
        // Brief flash feedback
        const el = document.querySelector('.terminal-copy-flash');
        if (el) { el.style.opacity = '1'; setTimeout(() => el.style.opacity = '0', 1200); }
    }).catch(() => {});
}

async function terminalFetchArbitrage() {
    // Ensure custom cities are loaded before city assignment
    if (!terminalCustomCitiesLoaded) await terminalLoadCustomCities();
    await tradexEnsureCache();
    const allExchanges = tradexGetStocked();
    terminalTotalExchanges = allExchanges.length;

    // Assign each trade to closest city, accounting for compacted items + enchantments
    const trades = [];
    terminalCityTrades = {};
    for (const e of allExchanges) {
        if (!e.stock || e.stock <= 0) continue;
        let inMat = e.input?.material;
        let outMat = e.output?.material;
        if (!inMat || !outMat) continue;
        if (ncIsCompacted(e.input)) inMat += ' [C]';
        if (ncIsCompacted(e.output)) outMat += ' [C]';
        const inEnch = ncEnchantStr(e.input);
        const outEnch = ncEnchantStr(e.output);
        if (inEnch) inMat += ' [' + inEnch + ']';
        if (outEnch) outMat += ' [' + outEnch + ']';
        const closest = terminalClosestCity(e.pos.x, e.pos.z);
        const city = closest.name;
        const cityDist = closest.dist;
        if (!terminalCityTrades[city]) terminalCityTrades[city] = [];
        terminalCityTrades[city].push(e);
        trades.push({
            city, cityDist, inputMat: inMat, outputMat: outMat,
            inCount: e.input?.count || 1, outCount: e.output?.count || 1,
            pos: e.pos, stock: e.stock, time: e.time
        });
    }

    // Circular arbitrage
    const byInput = {};
    for (const t of trades) {
        if (!byInput[t.inputMat]) byInput[t.inputMat] = [];
        byInput[t.inputMat].push(t);
    }

    const circulars = [];
    for (const t1 of trades) {
        const reverses = byInput[t1.outputMat] || [];
        for (const t2 of reverses) {
            if (t2.outputMat !== t1.inputMat) continue;
            const maxStep1 = t1.stock;
            const outputFromStep1 = t1.outCount * maxStep1;
            const maxStep2FromOutput = Math.floor(outputFromStep1 / t2.inCount);
            const maxStep2 = Math.min(maxStep2FromOutput, t2.stock);
            const netReturn = (t1.outCount / t2.inCount) * t2.outCount;
            const profit = netReturn / t1.inCount;
            if (profit <= 1.05) continue;
            const realizableCycles = Math.min(maxStep1, Math.ceil(maxStep2 * t2.inCount / t1.outCount));
            const step2Trades = Math.min(Math.floor(realizableCycles * t1.outCount / t2.inCount), t2.stock);
            const spent = realizableCycles * t1.inCount;
            const back = step2Trades * t2.outCount;
            const netProfit = back - spent;
            if (netProfit <= 0) continue;
            const dist = terminalDistance(t1.pos, t2.pos);
            circulars.push({ t1, t2, profit, netProfit, realizableCycles, step2Trades, spent, back, dist });
        }
    }

    // Deduplicate
    const seen = new Set();
    terminalArbData = [];
    for (const c of circulars) {
        const key = c.t1.pos.x + ',' + c.t1.pos.z + '|' + c.t2.pos.x + ',' + c.t2.pos.z + '|' + c.t1.inputMat + '|' + c.t1.outputMat;
        if (seen.has(key)) continue;
        seen.add(key);
        terminalArbData.push(c);
    }
}

async function loadTerminalArbitrage(forceRefresh) {
    const body = document.getElementById('terminalPanelBody');
    body.innerHTML = '<div class="terminal-loading">Scanning markets...</div>';
    try {
        await _terminalGate.verify();
        if (forceRefresh) tradexCacheTime = 0; // invalidate shared cache
        if (forceRefresh || !terminalArbData.length) await terminalFetchArbitrage();
        terminalRenderArbitrage();
    } catch (err) {
        console.error('Terminal arbitrage error:', err);
        const msg = err.message?.includes('429') ? 'Tradex API is rate-limited. Try again in a minute.' : 'Failed to fetch market data. Try refreshing.';
        body.innerHTML = '<div class="terminal-loading">' + msg + '</div>';
    }
}

function terminalGetFilteredSorted(forceOnlyDiamond) {
    let rows = terminalArbData.slice();
    const f = terminalArbFilters;

    // Free users: diamond only, max 10 net profit
    if (forceOnlyDiamond) {
        rows = rows.filter(c => c.t1.inputMat.toLowerCase().includes('diamond') && c.netProfit <= 10);
    }
    // Filter: city
    if (f.city) {
        rows = rows.filter(c => c.t1.city === f.city || c.t2.city === f.city);
    }
    // Filter: material search
    if (f.material) {
        const q = f.material.toLowerCase();
        rows = rows.filter(c => c.t1.inputMat.toLowerCase().includes(q) || c.t1.outputMat.toLowerCase().includes(q));
    }
    // Filter: same city
    if (f.sameCity) {
        rows = rows.filter(c => c.t1.city === c.t2.city);
    }
    // Filter: hide stale (>48h)
    if (f.hideStale) {
        const cutoff = Date.now() - terminalArbFilters.staleHours * 3600000;
        rows = rows.filter(c => (c.t1.time || 0) > cutoff && (c.t2.time || 0) > cutoff);
    }
    // Filter: diamond start
    if (f.diamondStart) {
        rows = rows.filter(c => c.t1.inputMat.toLowerCase().includes('diamond'));
    }
    // Filter: max distance
    if (f.maxDist) {
        rows = rows.filter(c => c.dist <= f.maxDistBlocks);
    }

    // Sort
    const dir = terminalArbSort.dir === 'asc' ? 1 : -1;
    const col = terminalArbSort.col;
    rows.sort((a, b) => {
        let va, vb;
        switch (col) {
            case 'route': va = a.t1.inputMat; vb = b.t1.inputMat; return va.localeCompare(vb) * dir;
            case 'profit': va = a.profit; vb = b.profit; break;
            case 'buy': va = a.t1.city; vb = b.t1.city; return va.localeCompare(vb) * dir;
            case 'sell': va = a.t2.city; vb = b.t2.city; return va.localeCompare(vb) * dir;
            case 'dist': va = a.dist; vb = b.dist; break;
            case 'exchanges': va = a.realizableCycles + a.step2Trades; vb = b.realizableCycles + b.step2Trades; break;
            case 'netProfit': va = a.netProfit; vb = b.netProfit; break;
            case 'fresh': va = Math.min(a.t1.time || 0, a.t2.time || 0); vb = Math.min(b.t1.time || 0, b.t2.time || 0); break;
            case 'updated': va = Math.min(a.t1.time || 0, a.t2.time || 0); vb = Math.min(b.t1.time || 0, b.t2.time || 0); break;
            default: va = a.netProfit; vb = b.netProfit;
        }
        return (va - vb) * dir;
    });

    return forceOnlyDiamond ? rows.slice(0, 6) : rows;
}

function terminalSortIcon(col) {
    if (terminalArbSort.col !== col) return ' <span style="opacity:0.3;">&#x25B4;&#x25BE;</span>';
    return terminalArbSort.dir === 'asc' ? ' <span>&#x25B4;</span>' : ' <span>&#x25BE;</span>';
}

function terminalRenderArbitrage() {
    const body = document.getElementById('terminalPanelBody');

    // Ticker
    const cityNames = terminalAllCities().map(c => c.name).filter(n => terminalCityTrades[n]);
    const citySummary = cityNames.map(name => {
        const exs = terminalCityTrades[name] || [];
        const stocked = exs.filter(e => e.stock > 0).length;
        const newest = exs.reduce((max, e) => Math.max(max, e.time || 0), 0);
        const freshCls = terminalFreshClass(newest);
        const ago = newest ? terminalTimeAgo(newest) : 'no data';
        return '<span class="terminal-ticker-item"><span class="terminal-fresh-dot ' + freshCls + '"></span>' + ncEsc(name) + ' <span style="color:var(--text-muted);">' + stocked + ' &middot; ' + ago + '</span></span>';
    });
    const tickerContent = citySummary.join('') + citySummary.join('');

    let html = '<div class="terminal-ticker"><div class="terminal-ticker-track">' + tickerContent + '</div></div>';

    // Filtered data
    const isFreeUser = !_terminalGate.isPaid;

    // Filter bar (hidden for free users)
    const cityOpts = terminalAllCities().map(c => c.name).filter(n => terminalCityTrades[n]).sort()
        .map(n => '<option value="' + ncEsc(n) + '"' + (terminalArbFilters.city === n ? ' selected' : '') + '>' + ncEsc(n) + '</option>').join('');

    if (!isFreeUser) {
    html += '<div class="terminal-filter-bar">';
    html += '<select id="termArbCity" class="terminal-filter-select"><option value="">All Cities</option>' + cityOpts + '</select>';
    html += '<input type="text" id="termArbMaterial" class="terminal-filter-input" placeholder="Search material..." value="' + ncEsc(terminalArbFilters.material) + '">';
    html += '<button id="termArbDiamond" class="terminal-filter-toggle' + (terminalArbFilters.diamondStart ? ' active' : '') + '">Diamond Profit</button>';
    html += '<button id="termArbSameCity" class="terminal-filter-toggle' + (terminalArbFilters.sameCity ? ' active' : '') + '">Same City</button>';
    html += '<button id="termArbHideStale" class="terminal-filter-toggle' + (terminalArbFilters.hideStale ? ' active' : '') + '">Hide Stale</button>';
    const staleOpts = [6,12,24,48,72,168].map(h => {
        const label = h < 24 ? h + 'h' : (h / 24) + 'd';
        return '<option value="' + h + '"' + (terminalArbFilters.staleHours === h ? ' selected' : '') + '>' + label + '</option>';
    }).join('');
    html += '<select id="termArbStaleHours" class="terminal-filter-select" style="min-width:auto;width:auto;padding:0.25rem 0.3rem;font-size:0.65rem;" title="Stale cutoff">' + staleOpts + '</select>';
    html += '<button id="termArbMaxDist" class="terminal-filter-toggle' + (terminalArbFilters.maxDist ? ' active' : '') + '">Max Dist</button>';
    const distOpts = [500,1000,2000,3000,5000,10000].map(d => {
        const label = d >= 1000 ? (d / 1000) + 'k' : d;
        return '<option value="' + d + '"' + (terminalArbFilters.maxDistBlocks === d ? ' selected' : '') + '>' + label + '</option>';
    }).join('');
    html += '<select id="termArbMaxDistBlocks" class="terminal-filter-select" style="min-width:auto;width:auto;padding:0.25rem 0.3rem;font-size:0.65rem;" title="Max distance">' + distOpts + '</select>';
    html += '<span class="terminal-copy-flash">Copied!</span>';
    html += '<span style="font-size:0.6rem;color:var(--text-muted);opacity:0.6;margin-left:auto;">Auto-refresh 5m</span>';
    html += '</div>';
    } // end filter bar (paid users only)

    const filtered = terminalGetFilteredSorted(isFreeUser);

    html += '<div style="text-align:center;margin-bottom:0.5rem;"><span style="font-size:0.65rem;color:var(--text-muted);opacity:0.7;">' + terminalTotalExchanges + ' trades scanned &middot; ' + filtered.length + ' of ' + terminalArbData.length + ' opportunities shown</span></div>';

    // Table with sortable headers + column filters
    html += '<div class="terminal-arb-wrap"><table class="terminal-arb-table"><thead><tr>';
    html += '<th class="terminal-sort-th" data-sort="fresh">' + terminalSortIcon('fresh') + '</th>';
    html += '<th class="terminal-sort-th" data-sort="route">Route' + terminalSortIcon('route') + '</th>';
    html += '<th class="terminal-sort-th" data-sort="profit">Profit' + terminalSortIcon('profit') + '</th>';
    html += '<th class="terminal-sort-th" data-sort="buy">Buy' + terminalSortIcon('buy') + '</th>';
    html += '<th class="terminal-sort-th" data-sort="sell">Sell' + terminalSortIcon('sell') + '</th>';
    html += '<th class="terminal-sort-th" data-sort="dist">Dist' + terminalSortIcon('dist') + '</th>';
    html += '<th class="terminal-sort-th" data-sort="exchanges">Exchanges' + terminalSortIcon('exchanges') + '</th>';
    html += '<th class="terminal-sort-th" data-sort="netProfit">Net Profit' + terminalSortIcon('netProfit') + '</th>';
    html += '<th class="terminal-sort-th" data-sort="updated">Updated' + terminalSortIcon('updated') + '</th>';
    html += '<th></th>';
    html += '</tr></thead><tbody>';

    for (let idx = 0; idx < filtered.length; idx++) {
        const c = filtered[idx];
        const pct = ((c.profit - 1) * 100).toFixed(0);
        const inName = c.t1.inputMat.replace(/_/g, ' ');
        const midName = c.t1.outputMat.replace(/_/g, ' ');
        const freshBuy = terminalFreshClass(c.t1.time);
        const freshSell = terminalFreshClass(c.t2.time);
        const oldestFresh = (freshBuy === 'stale' || freshSell === 'stale') ? 'stale' : (freshBuy === 'aging' || freshSell === 'aging') ? 'aging' : 'fresh';
        const sameCity = c.t1.city === c.t2.city;
        const buyRural = c.t1.cityDist > 600 ? '<br><span class="terminal-rural">600m+ Away, Nearest City</span>' : '';
        const sellRural = c.t2.cityDist > 600 ? '<br><span class="terminal-rural">600m+ Away, Nearest City</span>' : '';
        const oldestTime = Math.min(c.t1.time || 0, c.t2.time || 0);

        // Free user: 6 rows total — first 2 blurred, next 2 visible (no %), last 2 blurred
        let blurred = false;
        let hideProfit = false;
        if (isFreeUser) {
            if (idx >= 6) continue;
            if (idx < 2 || idx >= 4) {
                blurred = true;
            } else {
                hideProfit = true;
            }
        }

        if (blurred) {
            // Render placeholder data — no real info in DOM
            html += '<tr class="terminal-row-blurred">';
            html += '<td><span class="terminal-fresh-dot aging"></span></td>';
            html += '<td>Diamond &rarr; ??? &rarr; Diamond</td>';
            html += '<td><span class="terminal-arb-pct">??%</span></td>';
            html += '<td><span class="terminal-arb-city">???</span><br><span class="terminal-arb-coords">[?, ?, ?]</span><br><span class="terminal-arb-coords">stock: ?</span></td>';
            html += '<td><span class="terminal-arb-city">???</span><br><span class="terminal-arb-coords">[?, ?, ?]</span><br><span class="terminal-arb-coords">stock: ?</span></td>';
            html += '<td>?</td>';
            html += '<td>? buy<br>? sell</td>';
            html += '<td><span class="terminal-arb-profit">+?</span><br><span class="terminal-arb-coords">Diamond</span></td>';
            html += '<td style="white-space:nowrap;font-size:0.7rem;color:var(--text-muted);">?</td>';
            html += '<td></td>';
            html += '</tr>';
        } else {
            const rowClass = 'terminal-row-clickable';
            html += '<tr class="' + rowClass + '" data-arb-idx="' + idx + '">';
            html += '<td><span class="terminal-fresh-dot ' + oldestFresh + '" title="Buy: ' + terminalTimeAgo(c.t1.time) + ', Sell: ' + terminalTimeAgo(c.t2.time) + '"></span></td>';
            html += '<td>' + ncEsc(inName) + ' &rarr; ' + ncEsc(midName) + ' &rarr; ' + ncEsc(inName) + '</td>';
            html += '<td><span class="terminal-arb-pct">' + (hideProfit ? '&mdash;' : pct + '%') + '</span></td>';
            html += '<td><span class="terminal-arb-city">' + ncEsc(c.t1.city) + buyRural + '</span><br><span class="terminal-arb-coords terminal-clickable-coords" onclick="terminalCopyCoords(' + c.t1.pos.x + ',' + c.t1.pos.y + ',' + c.t1.pos.z + ')" title="Click to copy">[' + c.t1.pos.x + ', ' + c.t1.pos.y + ', ' + c.t1.pos.z + ']</span><br><span class="terminal-arb-coords">stock: ' + c.t1.stock + '</span></td>';
            html += '<td><span class="terminal-arb-city">' + ncEsc(c.t2.city) + sellRural + '</span><br><span class="terminal-arb-coords terminal-clickable-coords" onclick="terminalCopyCoords(' + c.t2.pos.x + ',' + c.t2.pos.y + ',' + c.t2.pos.z + ')" title="Click to copy">[' + c.t2.pos.x + ', ' + c.t2.pos.y + ', ' + c.t2.pos.z + ']</span><br><span class="terminal-arb-coords">stock: ' + c.t2.stock + '</span></td>';
            html += '<td>' + (sameCity ? '<span style="color:#a8d4a0;">' + c.dist + '</span>' : c.dist) + '</td>';
            html += '<td>' + c.realizableCycles + ' buy<br>' + c.step2Trades + ' sell</td>';
            html += '<td><span class="terminal-arb-profit">+' + c.netProfit + '</span><br><span class="terminal-arb-coords">' + ncEsc(inName) + '</span></td>';
            html += '<td style="white-space:nowrap;font-size:0.7rem;color:var(--text-muted);">' + terminalTimeAgo(oldestTime) + '</td>';
            html += '<td><button class="terminal-flag-btn" data-buy="' + c.t1.pos.x + ',' + c.t1.pos.y + ',' + c.t1.pos.z + '" data-sell="' + c.t2.pos.x + ',' + c.t2.pos.y + ',' + c.t2.pos.z + '" data-route="' + ncEsc(c.t1.inputMat) + '|' + ncEsc(c.t1.outputMat) + '" title="Flag this route">&#x2691;</button></td>';
            html += '</tr>';
        }
    }

    html += '</tbody></table></div>';

    if (filtered.length === 0) {
        html += '<div class="terminal-loading">No opportunities match your filters.</div>';
    }

    if (isFreeUser) {
        html += '<div class="terminal-upsell">Subscribe to Terminal to unlock all trades, filters, and consultations.</div>';
    }

    body.innerHTML = html;

    // Store only visible trades for row click popups
    const filteredRef = {};
    if (isFreeUser) {
        // Only indices 2 and 3 are visible (unblurred)
        if (filtered[2]) filteredRef[2] = filtered[2];
        if (filtered[3]) filteredRef[3] = filtered[3];
        // Scrub all in-memory data — console/DevTools access is useless
        terminalArbData = [];
        terminalCityTrades = {};
        terminalPrefetchPromise = null;
    } else {
        for (let i = 0; i < filtered.length; i++) filteredRef[i] = filtered[i];
    }

    // Bind filter events (paid users only)
    if (!isFreeUser) {
        document.getElementById('termArbCity').addEventListener('change', e => {
            terminalArbFilters.city = e.target.value;
            terminalRenderArbitrage();
        });
        let matTimer;
        document.getElementById('termArbMaterial').addEventListener('input', e => {
            clearTimeout(matTimer);
            matTimer = setTimeout(() => {
                terminalArbFilters.material = e.target.value.trim();
                terminalRenderArbitrage();
            }, 300);
        });
        document.getElementById('termArbDiamond').addEventListener('click', e => {
            terminalArbFilters.diamondStart = !terminalArbFilters.diamondStart;
            terminalRenderArbitrage();
        });
        document.getElementById('termArbSameCity').addEventListener('click', e => {
            terminalArbFilters.sameCity = !terminalArbFilters.sameCity;
            terminalRenderArbitrage();
        });
        document.getElementById('termArbHideStale').addEventListener('click', e => {
            terminalArbFilters.hideStale = !terminalArbFilters.hideStale;
            terminalRenderArbitrage();
        });
        document.getElementById('termArbStaleHours').addEventListener('change', e => {
            terminalArbFilters.staleHours = parseInt(e.target.value);
            terminalArbFilters.hideStale = true;
            terminalRenderArbitrage();
        });
        document.getElementById('termArbMaxDist').addEventListener('click', e => {
            terminalArbFilters.maxDist = !terminalArbFilters.maxDist;
            terminalRenderArbitrage();
        });
        document.getElementById('termArbMaxDistBlocks').addEventListener('change', e => {
            terminalArbFilters.maxDistBlocks = parseInt(e.target.value);
            terminalArbFilters.maxDist = true;
            terminalRenderArbitrage();
        });
    }

    // Bind sort headers
    body.querySelectorAll('.terminal-sort-th').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (terminalArbSort.col === col) {
                terminalArbSort.dir = terminalArbSort.dir === 'desc' ? 'asc' : 'desc';
            } else {
                terminalArbSort.col = col;
                terminalArbSort.dir = 'desc';
            }
            terminalRenderArbitrage();
        });
    });

    // Bind flag buttons
    body.querySelectorAll('.terminal-flag-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const route = btn.dataset.route;
            const buy = btn.dataset.buy;
            const sell = btn.dataset.sell;
            const reason = prompt('Flag this route \u2014 what\'s wrong?\n(e.g. "out of stock", "wrong price", "chest broken")');
            if (!reason) return;
            btn.textContent = '...';
            btn.disabled = true;
            try {
                await fetch(CONFIG.supabaseUrl + '/rest/v1/nc_terminal_flags', {
                    method: 'POST',
                    headers: restHeaders(),
                    body: JSON.stringify({
                        user_id: currentUser.id,
                        username: currentUser.user_metadata?.full_name || currentUser.user_metadata?.name || 'Unknown',
                        route, buy_coords: buy, sell_coords: sell, reason
                    })
                });
                btn.textContent = '\u2691';
                btn.classList.add('flagged');
                btn.title = 'Flagged: ' + reason;
            } catch (err) {
                console.error('Flag failed:', err);
                btn.textContent = '\u2691';
                btn.disabled = false;
            }
        });
    });

    // Bind row click → trade detail popup
    body.querySelectorAll('.terminal-row-clickable').forEach(row => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('.terminal-flag-btn') || e.target.closest('.terminal-clickable-coords')) return;
            const idx = parseInt(row.dataset.arbIdx);
            const c = filteredRef[idx];
            if (!c) return;
            const inName = c.t1.inputMat.replace(/_/g, ' ');
            const midName = c.t1.outputMat.replace(/_/g, ' ');
            const buyCoords = c.t1.pos.x + ', ' + c.t1.pos.y + ', ' + c.t1.pos.z;
            const sellCoords = c.t2.pos.x + ', ' + c.t2.pos.y + ', ' + c.t2.pos.z;
            const existing = document.getElementById('terminalTradePopup');
            if (existing) existing.remove();
            const popup = document.createElement('div');
            popup.id = 'terminalTradePopup';
            popup.className = 'terminal-trade-popup';
            popup.innerHTML = '<div class="terminal-trade-popup-inner">'
                + '<button class="terminal-trade-popup-close">&times;</button>'
                + '<h3>Trade Route</h3>'
                + '<p>To complete this trade, take <strong>' + ncEsc(inName) + '</strong> (' + c.spent + ') to <strong>' + ncEsc(c.t1.city) + '</strong> at '
                + '<span class="terminal-clickable-coords" onclick="terminalCopyCoords(' + c.t1.pos.x + ',' + c.t1.pos.y + ',' + c.t1.pos.z + ')" title="Click to copy">[' + buyCoords + ']</span>'
                + ', exchange it for <strong>' + ncEsc(midName) + '</strong>.</p>'
                + '<p>Then take the <strong>' + ncEsc(midName) + '</strong> to <strong>' + ncEsc(c.t2.city) + '</strong> at '
                + '<span class="terminal-clickable-coords" onclick="terminalCopyCoords(' + c.t2.pos.x + ',' + c.t2.pos.y + ',' + c.t2.pos.z + ')" title="Click to copy">[' + sellCoords + ']</span>'
                + ' and exchange for <strong>' + ncEsc(inName) + '</strong>.</p>'
                + '<p>By doing this, you will have turned <strong>' + c.spent + ' ' + ncEsc(inName) + '</strong> into <strong>' + c.back + ' ' + ncEsc(inName) + '</strong> — a net profit of <strong>+' + c.netProfit + ' ' + ncEsc(inName) + '</strong>.</p>'
                + '</div>';
            document.body.appendChild(popup);
            popup.querySelector('.terminal-trade-popup-close').addEventListener('click', () => popup.remove());
            popup.addEventListener('click', (ev) => { if (ev.target === popup) popup.remove(); });
        });
    });
}

// ============================================
// Terminal — Consultation Scheduler
// ============================================

function terminalOpenConsultation() {
    const toolsEl = document.getElementById('terminalTools');
    const panelEl = document.getElementById('terminalPanel');
    toolsEl.style.display = 'none';
    panelEl.style.display = '';
    terminalCurrentTool = 'consult';
    document.getElementById('terminalSubtitle').textContent = 'Consultation';
    document.getElementById('terminalRefreshBtn').style.display = 'none';
    terminalLoadConsultation();
}

async function terminalLoadConsultation() {
    const body = document.getElementById('terminalPanelBody');
    body.innerHTML = '<div class="terminal-loading">Loading...</div>';
    try {
        const consults = currentUser
            ? await supabaseRest('nc_terminal_consultations', 'select=*&user_id=eq.' + currentUser.id + '&order=requested_date.desc')
            : [];
        const allConsults = currentUser
            ? await supabaseRest('nc_terminal_consultations', 'select=requested_date,requested_time,status&status=neq.cancelled')
            : [];
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const thisMonth = consults.filter(c => c.created_at >= monthStart && c.status !== 'cancelled');
        const remaining = currentUser ? Math.max(0, 2 - thisMonth.length) : 0;

        // Build set of reserved date+time slots
        const reserved = new Set(allConsults.map(c => c.requested_date + '|' + c.requested_time));

        let html = '<div class="terminal-consult-wrap">';
        html += '<div class="terminal-consult-disclaimer">Maison Fris will make a good faith effort to reschedule if scheduling conflicts emerge.</div>';
        const dateOpts = [];
        for (let i = 2; i <= 14; i++) {
            const d = new Date(now.getTime() + i * 86400000);
            dateOpts.push('<option value="' + d.toISOString().split('T')[0] + '">' + d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + '</option>');
        }
        html += '<div class="terminal-consult-form">';
        html += '<div><label>Preferred Date</label><select id="termConsultDate">' + dateOpts.join('') + '</select></div>';
        html += '<div><label>Preferred Time (US-Central)</label><select id="termConsultTime"></select></div>';
        html += '<div><label>Topic</label><select id="termConsultTopic"><option value="Market Strategy">Market Strategy</option><option value="Arbitrage Guidance">Arbitrage Guidance</option><option value="Shop Setup">Shop Setup &amp; Pricing</option><option value="Trade Routes">Trade Route Planning</option><option value="Other">Other</option></select></div>';
        html += '<div><label>Notes (optional)</label><textarea id="termConsultNotes" placeholder="Describe what you\'d like to discuss..."></textarea></div>';
        if (!userProfile?.terminal) {
            html += '<button class="terminal-consult-submit" disabled>Contact Directly</button>';
        } else if (remaining > 0) {
            html += '<button class="terminal-consult-submit" id="termConsultSubmit">Request Consultation</button>';
        } else {
            html += '<button class="terminal-consult-submit" disabled>Contact Directly</button>';
        }
        html += '</div>';
        if (consults.length > 0) {
            html += '<div class="terminal-consult-history"><h4>Your Consultations</h4>';
            for (const c of consults) {
                const dateStr = new Date(c.requested_date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                html += '<div class="terminal-consult-row"><div><div style="font-weight:600;">' + ncEsc(c.topic) + '</div>';
                html += '<div style="color:var(--text-muted);font-size:0.65rem;">' + dateStr + ' at ' + c.requested_time + (c.notes ? ' &middot; ' + ncEsc(c.notes.substring(0, 60)) : '') + '</div></div>';
                html += '<span class="terminal-consult-status ' + c.status + '">' + c.status + '</span></div>';
            }
            html += '</div>';
        }
        html += '</div>';
        body.innerHTML = html;

        // Populate time slots based on selected date, filtering out reserved
        function updateTimeSlots() {
            const dateSel = document.getElementById('termConsultDate');
            const timeSel = document.getElementById('termConsultTime');
            if (!dateSel || !timeSel) return;
            const date = dateSel.value;
            timeSel.innerHTML = '';
            let hasOptions = false;
            for (let h = 9; h <= 21; h++) {
                const val = (h < 10 ? '0' : '') + h + ':00 CT';
                if (reserved.has(date + '|' + val)) continue;
                const label = (h > 12 ? (h - 12) : h) + ':00 ' + (h >= 12 ? 'PM' : 'AM') + ' CT';
                timeSel.innerHTML += '<option value="' + val + '">' + label + '</option>';
                hasOptions = true;
            }
            if (!hasOptions) {
                timeSel.innerHTML = '<option value="" disabled selected>No availability</option>';
            }
            const submitBtn = document.getElementById('termConsultSubmit');
            if (submitBtn) submitBtn.disabled = !hasOptions;
        }
        const dateSel = document.getElementById('termConsultDate');
        if (dateSel) { dateSel.addEventListener('change', updateTimeSlots); updateTimeSlots(); }

        const submitBtn = document.getElementById('termConsultSubmit');
        if (submitBtn) submitBtn.addEventListener('click', async () => {
            submitBtn.disabled = true; submitBtn.textContent = 'Submitting...';
            try {
                const resp = await fetch(CONFIG.workerUrl + '/api/consultation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('mf_token') },
                    body: JSON.stringify({
                        requested_date: document.getElementById('termConsultDate').value,
                        requested_time: document.getElementById('termConsultTime').value,
                        topic: document.getElementById('termConsultTopic').value,
                        notes: document.getElementById('termConsultNotes').value.trim() || null
                    })
                });
                if (!resp.ok) throw new Error((await resp.json()).error || 'Submission failed');
                terminalLoadConsultation();
            } catch (err) { console.error('Consult submit error:', err); submitBtn.disabled = false; submitBtn.textContent = 'Request Consultation'; }
        });
    } catch (err) { console.error('Consult load error:', err); body.innerHTML = '<div class="terminal-loading">Failed to load consultations.</div>'; }
}

// ============================================
// ============================================
// World Map Tool (Admin Only)
// ============================================

function worldMapMcToLatLng(x, z) {
    return [-(z + 0.5), x + 0.5];
}

async function terminalOpenWorldMap() {
    const toolsEl = document.getElementById('terminalTools');
    const panelEl = document.getElementById('terminalPanel');
    toolsEl.style.display = 'none';
    panelEl.style.display = '';
    terminalCurrentTool = 'worldmap';
    document.getElementById('terminalSubtitle').textContent = 'World Map';
    document.querySelector('.terminal-container')?.classList.add('terminal-worldmap-active');
    document.getElementById('terminalRefreshBtn').style.display = 'none';

    const body = document.getElementById('terminalPanelBody');
    body.innerHTML = `
        <div id="worldMapWrap" style="position:relative;">
        <div class="worldmap-filter-bar">
            <div style="display:flex;gap:0.4rem;flex:1;min-width:200px;">
                <input type="text" id="worldmapSearchOutput" placeholder="Search Output..." style="flex:1;min-width:100px;">
                <input type="text" id="worldmapSearchInput" placeholder="Search Input..." style="flex:1;min-width:100px;">
            </div>
            <button class="nc-shop-toggle" id="worldmapUnstocked">Show Unstocked</button>
            <button class="nc-shop-toggle" id="worldmapExact">Filter Exact</button>
            <select id="worldmapFreshness">
                <option value="0" selected>All ages</option>
                <option value="6">Updated &lt; 6h</option>
                <option value="24">Updated &lt; 24h</option>
                <option value="48">Updated &lt; 48h</option>
                <option value="168">Updated &lt; 7d</option>
            </select>
        </div>
        <div id="worldMapContainer"></div>
        <button id="worldmapFullscreen" style="position:absolute;bottom:3.5rem;left:50%;transform:translateX(-50%);z-index:500;font-size:0.7rem;padding:0.3rem 0.8rem;background:rgba(26,23,48,0.85);border:1px solid rgba(184,180,204,0.2);border-radius:4px;color:var(--text);cursor:pointer;font-family:'Raleway',sans-serif;backdrop-filter:blur(4px);">&#x26F6; Fullscreen</button>
        <div class="nc-panel" id="worldmapCarousel" style="display:none;">
            <button class="nc-panel-arrow nc-panel-arrow-left" id="worldmapCarouselLeft">&#8249;</button>
            <div class="nc-panel-list" id="worldmapCarouselList"></div>
            <button class="nc-panel-arrow nc-panel-arrow-right" id="worldmapCarouselRight">&#8250;</button>
        </div>
        <button id="worldmapTableBtn" title="Spreadsheet View">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
        </button>
        <div class="worldmap-stats" id="worldmapStats"></div>
        <div class="worldmap-legend">
            <span><span class="worldmap-legend-dot" style="background:#4caf50;"></span> Stocked</span>
            <span><span class="worldmap-legend-dot" style="background:#aa0000;"></span> Out of stock</span>
            <span><span class="worldmap-legend-dot" style="background:#f5c542;"></span> Stale (&gt;48h)</span>
        </div>
        </div>
        <div id="worldmapTableOverlay">
            <div class="worldmap-table-header">
                <h3>World Marketplace</h3>
                <button class="worldmap-table-close" id="worldmapTableClose">&times;</button>
            </div>
            <div class="worldmap-table-toolbar">
                <button class="nc-shop-toggle" id="wmTableClearFilters">Clear Filters</button>
                <button class="nc-shop-toggle" id="wmTableUnstocked">Show Unstocked</button>
                <button class="nc-shop-toggle" id="wmTableExact">Filter Exact</button>
            </div>
            <div class="worldmap-table-wrap">
                <table class="nc-table" id="worldmapTable">
                    <thead>
                        <tr>
                            <th data-sort="city" style="white-space:nowrap;width:1%;">City</th>
                            <th data-sort="coords" style="white-space:nowrap;width:1%;">Coords</th>
                            <th data-sort="sellQty" style="white-space:nowrap;width:1%;">Qty</th>
                            <th data-sort="selling" style="white-space:nowrap;width:1%;">Output</th>
                            <th data-sort="buyQty" style="white-space:nowrap;width:1%;">Qty</th>
                            <th data-sort="buyItem" style="white-space:nowrap;width:1%;">Input</th>
                            <th data-sort="stock" style="white-space:nowrap;width:1%;">Stock</th>
                            <th data-sort="age" style="white-space:nowrap;width:1%;">Updated</th>
                        </tr>
                        <tr class="wm-filter-row">
                            <th><input type="text" class="wm-col-filter" data-col="city" placeholder="Filter..."></th>
                            <th><input type="text" class="wm-col-filter" data-col="coords" placeholder="Filter..."></th>
                            <th><input type="text" class="wm-col-filter" data-col="sellQty" placeholder="#"></th>
                            <th><input type="text" class="wm-col-filter" data-col="selling" placeholder="Filter..."></th>
                            <th><input type="text" class="wm-col-filter" data-col="buyQty" placeholder="#"></th>
                            <th><input type="text" class="wm-col-filter" data-col="buyItem" placeholder="Filter..."></th>
                            <th><input type="text" class="wm-col-filter" data-col="stock" placeholder="#"></th>
                            <th><select class="wm-col-filter" id="wmDateFilter" data-col="age"><option value="">All</option><option value="1h">1h</option><option value="6h">6h</option><option value="24h">24h</option><option value="7d">7d</option><option value="30d">30d</option></select></th>
                        </tr>
                    </thead>
                    <tbody id="worldmapTableBody"></tbody>
                </table>
            </div>
        </div>
    `;

    // Load custom cities before init
    if (!terminalCustomCitiesLoaded) await terminalLoadCustomCities();

    worldMapInit();

    if (!worldMapDataReady) {
        document.getElementById('worldmapStats').textContent = 'Fetching shop data...';
        await worldMapFetchData();
    }
    worldMapRenderMarkers();

    // Fullscreen toggle
    document.getElementById('worldmapFullscreen').addEventListener('click', () => {
        const wrap = document.getElementById('worldMapWrap');
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            wrap.requestFullscreen();
        }
    });
    document.addEventListener('fullscreenchange', () => {
        const container = document.getElementById('worldMapContainer');
        const carousel = document.getElementById('worldmapCarousel');
        const fsBtn = document.getElementById('worldmapFullscreen');
        if (document.fullscreenElement) {
            container.style.height = 'calc(100vh - 42px)';
            document.getElementById('worldMapWrap').style.background = '#1a1730';
            if (carousel) carousel.style.display = '';
            if (fsBtn) fsBtn.style.display = 'none';
        } else {
            container.style.height = '70vh';
            container.style.paddingTop = '';
            document.getElementById('worldMapWrap').style.background = '';
            if (carousel) carousel.style.display = 'none';
            if (fsBtn) fsBtn.style.display = '';
        }
        if (worldMap) setTimeout(() => worldMap.invalidateSize(), 100);
    });

    // Search inputs — debounced
    let searchTimeout;
    const triggerFilter = () => { clearTimeout(searchTimeout); searchTimeout = setTimeout(worldMapRenderMarkers, 200); };
    document.getElementById('worldmapSearchOutput').addEventListener('input', triggerFilter);
    document.getElementById('worldmapSearchInput').addEventListener('input', triggerFilter);
    document.getElementById('worldmapFreshness').addEventListener('change', worldMapRenderMarkers);

    // Toggle buttons (map-level)
    document.getElementById('worldmapUnstocked').addEventListener('click', function() {
        this.classList.toggle('active');
        this.textContent = this.classList.contains('active') ? 'Hide Unstocked' : 'Show Unstocked';
        worldMapRenderMarkers();
    });
    document.getElementById('worldmapExact').addEventListener('click', function() {
        this.classList.toggle('active');
        this.textContent = this.classList.contains('active') ? 'Filter All' : 'Filter Exact';
        worldMapRenderMarkers();
    });

    // Carousel card click
    document.getElementById('worldmapCarouselList').addEventListener('click', (ev) => {
        const card = ev.target.closest('.nc-shop-card[data-wm-idx]');
        if (card) worldMapSelectCard(parseInt(card.dataset.wmIdx));
    });

    // Carousel arrows
    document.getElementById('worldmapCarouselLeft').addEventListener('click', () => {
        const idx = worldMapSelectedIdx <= 0 ? worldMapFiltered.length - 1 : worldMapSelectedIdx - 1;
        worldMapSelectCard(idx);
    });
    document.getElementById('worldmapCarouselRight').addEventListener('click', () => {
        const idx = worldMapSelectedIdx >= worldMapFiltered.length - 1 ? 0 : worldMapSelectedIdx + 1;
        worldMapSelectCard(idx);
    });

    // Keyboard arrows for carousel navigation
    document.addEventListener('keydown', (ev) => {
        if (terminalCurrentTool !== 'worldmap' || !document.fullscreenElement) return;
        if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT' || ev.target.tagName === 'TEXTAREA') return;
        if (ev.key === 'ArrowLeft') {
            ev.preventDefault();
            const idx = worldMapSelectedIdx <= 0 ? worldMapFiltered.length - 1 : worldMapSelectedIdx - 1;
            worldMapSelectCard(idx);
        } else if (ev.key === 'ArrowRight') {
            ev.preventDefault();
            const idx = worldMapSelectedIdx >= worldMapFiltered.length - 1 ? 0 : worldMapSelectedIdx + 1;
            worldMapSelectCard(idx);
        }
    });

    // Table view button + close
    document.getElementById('worldmapTableBtn').addEventListener('click', () => {
        document.getElementById('worldmapTableOverlay').classList.add('open');
        worldMapRenderTable();
    });
    document.getElementById('worldmapTableClose').addEventListener('click', () => {
        document.getElementById('worldmapTableOverlay').classList.remove('open');
    });

    // Table toolbar toggles
    document.getElementById('wmTableClearFilters').addEventListener('click', function() {
        document.querySelectorAll('.wm-col-filter').forEach(f => {
            if (f.tagName === 'SELECT') f.value = '';
            else f.value = '';
        });
        const unstocked = document.getElementById('wmTableUnstocked');
        unstocked.classList.remove('active'); unstocked.textContent = 'Show Unstocked';
        const exact = document.getElementById('wmTableExact');
        exact.classList.remove('active'); exact.textContent = 'Filter Exact';
        worldMapRenderTable();
    });
    document.getElementById('wmTableUnstocked').addEventListener('click', function() {
        this.classList.toggle('active');
        this.textContent = this.classList.contains('active') ? 'Hide Unstocked' : 'Show Unstocked';
        worldMapRenderTable();
    });
    document.getElementById('wmTableExact').addEventListener('click', function() {
        this.classList.toggle('active');
        this.textContent = this.classList.contains('active') ? 'Filter All' : 'Filter Exact';
        worldMapRenderTable();
    });

    // Table column sort
    document.getElementById('worldmapTable').querySelector('thead tr:first-child').addEventListener('click', (ev) => {
        const th = ev.target.closest('th[data-sort]');
        if (!th) return;
        const col = th.dataset.sort;
        if (worldMapTableSort.col === col) worldMapTableSort.asc = !worldMapTableSort.asc;
        else worldMapTableSort = { col, asc: true };
        worldMapRenderTable();
    });

    // Table column filter inputs
    document.querySelectorAll('.wm-col-filter').forEach(f => {
        f.addEventListener('input', worldMapRenderTable);
        f.addEventListener('change', worldMapRenderTable);
    });

    // Table body click — copy cells
    document.getElementById('worldmapTableBody').addEventListener('click', (ev) => {
        const cell = ev.target.closest('.wm-table-copy');
        if (cell) {
            const text = cell.dataset.copy;
            if (text) {
                navigator.clipboard.writeText(text).catch(() => {});
                const orig = cell.textContent;
                cell.textContent = 'Copied!';
                setTimeout(() => { cell.textContent = orig; }, 1200);
            }
        }
    });

    // Event delegation for add/delete city buttons (inside Leaflet popups)
    document.getElementById('worldMapWrap').addEventListener('click', async (e) => {
        // Add city button
        if (e.target.id === 'worldmapAddCityBtn') {
            const nameInput = document.getElementById('worldmapAddCityName');
            const name = (nameInput?.value || '').trim();
            if (!name) { nameInput?.focus(); return; }
            const x = parseInt(e.target.dataset.x);
            const z = parseInt(e.target.dataset.z);
            e.target.disabled = true;
            e.target.textContent = 'Adding...';
            try {
                const rows = await supabaseInsert('terminal_cities', {
                    name, x, z,
                    added_by: userProfile?.discord_username || 'admin'
                });
                if (rows && rows[0]) {
                    terminalCustomCities.push({ id: rows[0].id, name, x, z, _isCustom: true });
                    worldMap.closePopup();
                    worldMapAddCityLabels();
                }
            } catch (err) {
                console.error('Failed to add city:', err);
                e.target.textContent = 'Error';
            }
            return;
        }
        // Delete city button
        if (e.target.classList.contains('worldmap-delete-city-btn')) {
            const cityId = e.target.dataset.cityId;
            if (!cityId) return;
            e.target.disabled = true;
            e.target.textContent = 'Deleting...';
            try {
                await supabaseDelete('terminal_cities', cityId);
                terminalCustomCities = terminalCustomCities.filter(c => c.id !== cityId);
                worldMap.closePopup();
                worldMapAddCityLabels();
            } catch (err) {
                console.error('Failed to delete city:', err);
                e.target.textContent = 'Error';
            }
        }
    });
}

function worldMapInit() {
    if (worldMap) { worldMap.remove(); worldMap = null; }

    worldMap = L.map('worldMapContainer', {
        crs: L.CRS.Simple,
        minZoom: -5,
        maxZoom: 3,
        zoomSnap: 1,
        attributionControl: false,
        zoomControl: true,
        preferCanvas: true,
        doubleClickZoom: false
    });

    L.tileLayer('https://civmc-map.duckdns.org/tiles/terrain/z{z}/{x},{y}.png', {
        minZoom: -5,
        maxZoom: 3,
        maxNativeZoom: 0,
        minNativeZoom: -5,
        tileSize: 256,
        noWrap: true,
        updateWhenIdle: false,
        updateWhenZooming: true,
        keepBuffer: 6
    }).addTo(worldMap);

    // Fresh Survey overlay — locally generated JourneyMap tiles (tools/generate-nc-tiles.ps1).
    // Transparent where unexplored, so the CivMC base shows through.
    L.tileLayer('tiles/nc/z{z}/{x},{y}.png', {
        minZoom: -5,
        maxZoom: 3,
        minNativeZoom: -3,
        maxNativeZoom: 0,
        tileSize: 256,
        noWrap: true,
        zIndex: 2,
        bounds: [[-9216, -6656], [512, 8704]],
        errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        updateWhenIdle: false,
        updateWhenZooming: true,
        keepBuffer: 6
    }).addTo(worldMap);

    worldMap.setView(worldMapMcToLatLng(0, 0), -3);

    worldMapCityLabels = [];
    worldMapAddCityLabels();

    // Double-click to add a custom city (admin only)
    if (userProfile?.is_admin) {
        worldMap.on('dblclick', (e) => {
            const mcX = Math.round(e.latlng.lng - 0.5);
            const mcZ = Math.round(-(e.latlng.lat + 0.5));
            worldMapShowAddCityPopup(e.latlng, mcX, mcZ);
        });
    }

    worldMap.on('mousemove', (e) => {
        const mcX = Math.round(e.latlng.lng - 0.5);
        const mcZ = Math.round(-(e.latlng.lat + 0.5));
        const stats = document.getElementById('worldmapStats');
        if (stats && stats._baseText) {
            stats.textContent = stats._baseText + '  |  X: ' + mcX + '  Z: ' + mcZ;
        }
    });
}

function worldMapAddCityLabels() {
    // Remove existing labels
    worldMapCityLabels.forEach(l => worldMap.removeLayer(l));
    worldMapCityLabels = [];

    for (const city of terminalAllCities()) {
        const isCustom = !!city._isCustom;
        const label = L.marker(worldMapMcToLatLng(city.x, city.z), {
            icon: L.divIcon({
                className: 'worldmap-city-label' + (isCustom ? ' worldmap-city-custom' : ''),
                html: '<span style="transform:translateX(-50%);display:inline-block;">' + ncEsc(city.name) + '</span>',
                iconSize: [0, 0],
                iconAnchor: [0, 12]
            }),
            interactive: true
        }).addTo(worldMap);
        label._cityName = city.name;
        label._isCustom = isCustom;
        label._cityId = city.id || null;

        // Right-click custom city to delete
        if (isCustom && userProfile?.is_admin) {
            label.on('contextmenu', (e) => {
                L.DomEvent.stopPropagation(e);
                L.DomEvent.preventDefault(e);
                const popup = L.popup({ closeOnClick: true, className: 'worldmap-delete-popup' })
                    .setLatLng(label.getLatLng())
                    .setContent('<div style="text-align:center;font-size:0.85rem;"><b>' + ncEsc(city.name) + '</b><br><span style="color:var(--text-muted);font-size:0.7rem;">x: ' + city.x + ', z: ' + city.z + '</span><br><button class="worldmap-delete-city-btn" style="margin-top:8px;padding:4px 16px;font-size:0.8rem;cursor:pointer;background:#aa0000;color:#fff;border:none;border-radius:4px;font-family:Raleway,sans-serif;" data-city-id="' + ncEsc(city.id) + '">Delete City</button></div>')
                    .openOn(worldMap);
            });
        }

        worldMapCityLabels.push(label);
    }
}

function worldMapShowAddCityPopup(latlng, mcX, mcZ) {
    // Remove any existing add-city popup
    const existing = document.getElementById('worldmapAddCityPopup');
    if (existing) existing.remove();

    const popup = L.popup({ closeOnClick: true, className: 'worldmap-add-popup', closeButton: true })
        .setLatLng(latlng)
        .setContent(
            '<div style="text-align:center;font-size:0.85rem;">'
            + '<div style="margin-bottom:6px;font-weight:600;">Add City</div>'
            + '<div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:8px;">x: ' + mcX + ', z: ' + mcZ + '</div>'
            + '<input type="text" id="worldmapAddCityName" placeholder="City name..." style="width:160px;font-size:0.8rem;padding:4px 8px;font-family:Raleway,sans-serif;background:rgba(255,255,255,0.08);border:1px solid rgba(184,180,204,0.3);border-radius:4px;color:var(--text);margin-bottom:8px;display:block;margin-left:auto;margin-right:auto;">'
            + '<button id="worldmapAddCityBtn" data-x="' + mcX + '" data-z="' + mcZ + '" style="padding:4px 16px;font-size:0.8rem;cursor:pointer;background:var(--accent);color:#fff;border:none;border-radius:4px;font-family:Raleway,sans-serif;">Add</button>'
            + '</div>'
        )
        .openOn(worldMap);

    // Focus the input after popup opens
    setTimeout(() => {
        const input = document.getElementById('worldmapAddCityName');
        if (input) {
            input.focus();
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') document.getElementById('worldmapAddCityBtn')?.click();
            });
        }
    }, 50);
}

async function worldMapFetchData() {
    try {
        await tradexEnsureCache();
        worldMapExchanges = tradexGetCached();
        worldMapDataReady = true;
    } catch (err) {
        console.error('World map fetch failed:', err);
        const stats = document.getElementById('worldmapStats');
        if (stats) stats.textContent = err.message?.includes('429') ? 'Tradex API is rate-limited. Try again later.' : 'Failed to fetch shop data. Try refreshing.';
    }
}

function worldMapGetFiltered() {
    const outputQ = (document.getElementById('worldmapSearchOutput')?.value || '').toLowerCase().trim();
    const inputQ = (document.getElementById('worldmapSearchInput')?.value || '').toLowerCase().trim();
    const showUnstocked = document.getElementById('worldmapUnstocked')?.classList.contains('active');
    const exactMatch = document.getElementById('worldmapExact')?.classList.contains('active');
    const freshnessHrs = parseInt(document.getElementById('worldmapFreshness')?.value || '0');
    const now = Date.now();
    const mMatch = (val, q) => exactMatch ? val === q : val.includes(q);

    let filtered = worldMapExchanges;
    if (!showUnstocked) filtered = filtered.filter(e => e.stock > 0);
    if (freshnessHrs > 0) {
        const cutoff = now - (freshnessHrs * 3600000);
        filtered = filtered.filter(e => e.time >= cutoff);
    }
    if (outputQ) {
        filtered = filtered.filter(e => {
            const outName = (e.output?.material || '').toLowerCase();
            const outCustom = (e.output?.customName || '').toLowerCase();
            return mMatch(outName, outputQ) || mMatch(outCustom, outputQ);
        });
    }
    if (inputQ) {
        filtered = filtered.filter(e => {
            const inName = (e.input?.material || '').toLowerCase();
            const inCustom = (e.input?.customName || '').toLowerCase();
            return mMatch(inName, inputQ) || mMatch(inCustom, inputQ);
        });
    }
    return filtered;
}

function worldMapRenderMarkers() {
    if (!worldMap) return;

    worldMapMarkers.forEach(m => worldMap.removeLayer(m));
    worldMapMarkers = [];

    const now = Date.now();
    const filtered = worldMapGetFiltered();

    // Group by position
    const grouped = {};
    filtered.forEach(e => {
        const key = e.pos.x + ',' + e.pos.y + ',' + e.pos.z;
        if (!grouped[key]) grouped[key] = { pos: e.pos, exchanges: [] };
        grouped[key].exchanges.push(e);
    });

    const groups = Object.values(grouped);
    for (const group of groups) {
        const p = group.pos;
        const hasStock = group.exchanges.some(e => e.stock > 0);
        const freshest = Math.max(...group.exchanges.map(e => e.time || 0));
        const isStale = (now - freshest) > 172800000;

        const marker = L.circleMarker(worldMapMcToLatLng(p.x, p.z), {
            radius: 5,
            fillColor: isStale ? '#f5c542' : (hasStock ? '#4caf50' : '#aa0000'),
            color: 'rgba(255,255,255,0.3)',
            weight: 0.5,
            fillOpacity: isStale ? 0.7 : 0.8
        }).addTo(worldMap);

        const city = terminalClosestCity(p.x, p.z);
        let popupHtml = '<div style="font-size:0.9rem;max-height:320px;overflow-y:auto;min-width:300px;">';
        popupHtml += '<div style="font-weight:600;font-size:1rem;margin-bottom:0.4rem;">' + ncEsc(city.name) + ' (' + city.dist + 'm)</div>';
        popupHtml += '<div style="font-size:0.8rem;color:#aaa;margin-bottom:0.5rem;">Coords: ' + p.x + ', ' + p.y + ', ' + p.z + '</div>';
        for (const ex of group.exchanges.slice(0, 15)) {
            const inName = ncMatName(ex.input);
            const outName = ncMatName(ex.output);
            const freshCls = terminalFreshClass(ex.time);
            const color = freshCls === 'fresh' ? '#4caf50' : (freshCls === 'aging' ? '#ff9800' : '#888');
            popupHtml += '<div style="display:flex;justify-content:space-between;gap:0.75rem;padding:0.25rem 0;border-top:1px solid rgba(255,255,255,0.08);font-size:0.85rem;">';
            popupHtml += '<span>' + ncEsc(inName) + ' x' + (ex.input?.count || 1) + ' &rarr; ' + ncEsc(outName) + ' x' + (ex.output?.count || 1) + '</span>';
            popupHtml += '<span style="white-space:nowrap;color:' + color + ';">stk ' + (ex.stock || 0) + ' &middot; ' + terminalTimeAgo(ex.time) + '</span>';
            popupHtml += '</div>';
        }
        if (group.exchanges.length > 15) {
            popupHtml += '<div style="font-size:0.75rem;color:#888;text-align:center;padding-top:0.4rem;">+' + (group.exchanges.length - 15) + ' more trades</div>';
        }
        popupHtml += '</div>';

        marker.bindPopup(popupHtml, { maxWidth: 500, minWidth: 320, className: 'nc-leaflet-popup' });
        marker._wmGroupIdx = worldMapMarkers.length;
        marker.on('click', () => {
            worldMapSelectCard(marker._wmGroupIdx);
        });
        worldMapMarkers.push(marker);
    }

    // Store filtered groups for carousel
    worldMapFiltered = groups;
    worldMapSelectedIdx = -1;
    worldMapRenderCarousel();

    const stats = document.getElementById('worldmapStats');
    if (stats) {
        const text = 'Showing ' + groups.length + ' locations (' + filtered.length + ' trades) of ' + worldMapExchanges.length + ' total';
        stats._baseText = text;
        stats.textContent = text;
    }
}

function worldMapRenderCarousel() {
    const container = document.getElementById('worldmapCarouselList');
    if (!container) return;

    if (worldMapFiltered.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:0.75rem;padding:0.5rem;">No locations match filters.</div>';
        return;
    }

    let html = '';
    worldMapFiltered.forEach((group, i) => {
        const p = group.pos;
        const city = terminalClosestCity(p.x, p.z);
        const tradeCount = group.exchanges.length;
        const hasStock = group.exchanges.some(e => e.stock > 0);
        const freshest = Math.max(...group.exchanges.map(e => e.time || 0));
        const stockClass = hasStock ? 'in-stock' : 'out-stock';
        const stockText = hasStock ? 'In Stock' : 'Out of Stock';

        // Show top trade preview
        const topEx = group.exchanges[0];
        const inName = ncMatName(topEx.input);
        const outName = ncMatName(topEx.output);
        const inCount = topEx.input?.count || 1;
        const outCount = topEx.output?.count || 1;

        html += `<div class="nc-shop-card" data-wm-idx="${i}">
            <div class="nc-shop-trade">
                <span class="nc-shop-item-count">${inCount}x</span>
                <span class="nc-shop-item-name">${ncEsc(inName)}</span>
                <span class="arrow">&rarr;</span>
                <span class="nc-shop-item-count">${outCount}x</span>
                <span class="nc-shop-item-name">${ncEsc(outName)}</span>
            </div>
            <div class="nc-shop-meta">
                <span class="nc-shop-stock ${stockClass}">${stockText}</span>
                <span class="nc-shop-fresh">${ncFormatAge(freshest)}</span>
                <span class="nc-shop-coords">${p.x}, ${p.y}, ${p.z}</span>
            </div>
            <div class="nc-shop-near" style="color:#00bcd4;">${ncEsc(city.name)}${tradeCount > 1 ? ' &middot; ' + tradeCount + ' trades' : ''}</div>
        </div>`;
    });

    container.innerHTML = html;
}

function worldMapSelectCard(idx) {
    if (idx < 0 || idx >= worldMapFiltered.length) return;
    worldMapSelectedIdx = idx;

    // Highlight card
    const container = document.getElementById('worldmapCarouselList');
    if (container) {
        container.querySelectorAll('.nc-shop-card').forEach((c, i) => {
            c.classList.toggle('active', i === idx);
        });
        const activeCard = container.querySelector(`.nc-shop-card[data-wm-idx="${idx}"]`);
        if (activeCard) activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }

    // Open popup and pan map
    const marker = worldMapMarkers[idx];
    if (marker && worldMap) {
        marker.openPopup();
        worldMap.panTo(marker.getLatLng(), { animate: true });
    }
}

// ============================================
// World Map Table View
// ============================================

function wmColFilter(col) {
    const input = document.querySelector(`.wm-col-filter[data-col="${col}"]`);
    return input ? input.value.toLowerCase().trim() : '';
}

function worldMapRenderTable() {
    const tbody = document.getElementById('worldmapTableBody');
    if (!tbody) return;
    const showUnstocked = document.getElementById('wmTableUnstocked').classList.contains('active');
    const exactMatch = document.getElementById('wmTableExact').classList.contains('active');
    const match = (val, filter) => exactMatch ? val.toLowerCase() === filter : val.toLowerCase().includes(filter);

    const fCity = wmColFilter('city');
    const fCoords = wmColFilter('coords');
    const fSelling = wmColFilter('selling');
    const fBuyItem = wmColFilter('buyItem');
    const fSellQty = wmColFilter('sellQty');
    const fBuyQty = wmColFilter('buyQty');
    const fStock = wmColFilter('stock');

    let rows = worldMapExchanges
        .filter(e => {
            if (!fCoords && !showUnstocked && e.stock <= 0) return false;
            return true;
        })
        .map(e => {
            const outName = ncMatName(e.output);
            const inName = ncMatName(e.input);
            const outCount = e.output?.count || 1;
            const inCount = e.input?.count || 1;
            const city = terminalClosestCity(e.pos.x, e.pos.z);
            return { e, outName, outCount, inName, inCount, cityName: city.name, cityDist: city.dist };
        });

    if (fCity) rows = rows.filter(r => match(r.cityName, fCity));
    if (fCoords) rows = rows.filter(r => `${r.e.pos.x}, ${r.e.pos.y}, ${r.e.pos.z}`.includes(fCoords));
    if (fSelling) rows = rows.filter(r => match(r.outName, fSelling));
    if (fBuyItem) rows = rows.filter(r => match(r.inName, fBuyItem));
    if (fSellQty) rows = rows.filter(r => String(r.outCount).includes(fSellQty));
    if (fBuyQty) rows = rows.filter(r => String(r.inCount).includes(fBuyQty));
    if (fStock) rows = rows.filter(r => String(r.e.stock != null ? r.e.stock : '').includes(fStock));
    const fDate = document.getElementById('wmDateFilter').value;
    if (fDate) {
        const now = Date.now();
        const ms = fDate.endsWith('h') ? parseInt(fDate) * 3600000 : parseInt(fDate) * 86400000;
        rows = rows.filter(r => r.e.time >= now - ms);
    }

    const dir = worldMapTableSort.asc ? 1 : -1;
    rows.sort((a, b) => {
        switch (worldMapTableSort.col) {
            case 'city': return dir * a.cityName.localeCompare(b.cityName);
            case 'coords': return dir * (a.e.pos.x - b.e.pos.x || a.e.pos.z - b.e.pos.z);
            case 'sellQty': return dir * (a.outCount - b.outCount);
            case 'selling': return dir * a.outName.localeCompare(b.outName);
            case 'buyQty': return dir * (a.inCount - b.inCount);
            case 'buyItem': return dir * a.inName.localeCompare(b.inName);
            case 'stock': return dir * ((a.e.stock || 0) - (b.e.stock || 0));
            case 'age': return dir * ((a.e.time || 0) - (b.e.time || 0));
            default: return 0;
        }
    });

    // Update sort indicators
    document.querySelectorAll('#worldmapTable thead tr:first-child th[data-sort]').forEach(th => {
        th.style.cursor = 'pointer';
        const col = th.dataset.sort;
        const label = worldMapColLabels[col] || col;
        const arrow = worldMapTableSort.col === col ? (worldMapTableSort.asc ? ' \u25B2' : ' \u25BC') : '';
        th.textContent = label + arrow;
    });

    let html = '';
    rows.forEach(r => {
        const e = r.e;
        const coordStr = `${e.pos.x}, ${e.pos.y}, ${e.pos.z}`;
        const isUnstocked = e.stock <= 0;
        const rowClass = isUnstocked ? ' class="wm-row-unstocked"' : '';
        html += `<tr${rowClass}>`;
        html += `<td style="white-space:nowrap;">${ncEsc(r.cityName)}</td>`;
        html += `<td class="wm-table-copy" style="cursor:pointer;white-space:nowrap;" title="Click to copy" data-copy="${coordStr}">${coordStr}</td>`;
        html += `<td style="font-weight:600;white-space:nowrap;">${r.outCount}</td>`;
        html += `<td class="wm-table-copy" style="cursor:pointer;white-space:nowrap;" title="Click to copy" data-copy="${ncEsc(r.outName)}">${ncEsc(r.outName)}</td>`;
        html += `<td style="font-weight:600;white-space:nowrap;">${r.inCount}</td>`;
        html += `<td class="wm-table-copy" style="cursor:pointer;white-space:nowrap;" title="Click to copy" data-copy="${ncEsc(r.inName)}">${ncEsc(r.inName)}</td>`;
        html += `<td style="white-space:nowrap;">${e.stock != null ? e.stock : '\u2014'}</td>`;
        html += `<td style="white-space:nowrap;">${ncFormatAge(e.time)}</td>`;
        html += `</tr>`;
    });

    tbody.innerHTML = html || '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:2rem;">No trades found.</td></tr>';
}

// Terminal Admin — Management Dashboard
// ============================================
let termAdminTab = 'flags';

async function loadTerminalAdmin() {
    termAdminTab = 'flags';
    renderTermAdminTabs();
    loadTermAdminFlags();

    // Tab switching
    document.querySelectorAll('.term-admin-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            termAdminTab = tab.dataset.tab;
            renderTermAdminTabs();
            if (termAdminTab === 'flags') loadTermAdminFlags();
            else if (termAdminTab === 'carts') loadTermAdminCarts();
            else if (termAdminTab === 'consults') loadTermAdminConsults();
        });
    });

    // Search
    const search = document.getElementById('termAdminSearch');
    if (search) {
        search.addEventListener('input', () => {
            if (termAdminTab === 'flags') loadTermAdminFlags();
            else if (termAdminTab === 'carts') loadTermAdminCarts();
            else if (termAdminTab === 'consults') loadTermAdminConsults();
        });
    }
}

function renderTermAdminTabs() {
    document.querySelectorAll('.term-admin-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === termAdminTab);
    });
}

async function loadTermAdminFlags() {
    const content = document.getElementById('termAdminContent');
    if (!content) return;
    content.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:0.8rem;">Loading flags...</div>';

    try {
        const flags = await supabaseRest('nc_terminal_flags', 'select=*&order=created_at.desc');
        const q = (document.getElementById('termAdminSearch')?.value || '').toLowerCase().trim();
        const filtered = flags.filter(f => {
            if (!q) return true;
            return [f.username, f.route, f.buy_coords, f.sell_coords, f.reason]
                .filter(Boolean).join(' ').toLowerCase().includes(q);
        });

        if (filtered.length === 0) {
            content.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:0.8rem;">No flags found.</div>';
            return;
        }

        content.innerHTML = '';
        filtered.forEach(f => {
            const row = document.createElement('div');
            row.className = 'term-admin-row';
            const route = (f.route || '').replace(/\|/g, ' \u2192 ').replace(/_/g, ' ');
            const when = f.created_at ? new Date(f.created_at).toLocaleString() : '';
            row.innerHTML = `
                <div class="term-admin-row-info">
                    <div><strong>${ncEsc(f.username || 'Unknown')}</strong> flagged: ${ncEsc(route)}</div>
                    <div class="term-admin-row-reason">"${ncEsc(f.reason || '')}"</div>
                    <div class="term-admin-row-meta">Buy: ${ncEsc(f.buy_coords || '')} &middot; Sell: ${ncEsc(f.sell_coords || '')} &middot; ${when}</div>
                </div>
                <button class="term-admin-delete" data-id="${f.id}" title="Dismiss flag">&times;</button>
            `;
            row.querySelector('.term-admin-delete').addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                btn.textContent = '...';
                try {
                    await fetch(CONFIG.supabaseUrl + '/rest/v1/nc_terminal_flags?id=eq.' + f.id, {
                        method: 'DELETE', headers: restHeaders()
                    });
                    row.remove();
                } catch (err) {
                    console.error('Delete flag failed:', err);
                    btn.textContent = '\u00d7';
                }
            });
            content.appendChild(row);
        });
    } catch (err) {
        console.error('Load flags failed:', err);
        content.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:0.8rem;">Failed to load flags.</div>';
    }
}

async function loadTermAdminCarts() {
    const content = document.getElementById('termAdminContent');
    if (!content) return;
    content.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:0.8rem;">Loading saved carts...</div>';

    try {
        const deals = await supabaseRest('nc_saved_deals', 'select=*,profiles(discord_username,minecraft_ign)&order=saved_at.desc');
        const q = (document.getElementById('termAdminSearch')?.value || '').toLowerCase().trim();

        // Group by user
        const byUser = {};
        for (const d of deals) {
            const uid = d.user_id;
            if (!byUser[uid]) {
                const profile = d.profiles || {};
                byUser[uid] = {
                    username: profile.discord_username || 'Unknown',
                    ign: profile.minecraft_ign || '',
                    deals: []
                };
            }
            byUser[uid].deals.push(d);
        }

        const users = Object.entries(byUser).filter(([uid, u]) => {
            if (!q) return true;
            const text = [u.username, u.ign, ...u.deals.map(d => d.deal_key)].join(' ').toLowerCase();
            return text.includes(q);
        });

        if (users.length === 0) {
            content.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:0.8rem;">No saved carts found.</div>';
            return;
        }

        content.innerHTML = '';
        for (const [uid, u] of users) {
            const row = document.createElement('div');
            row.className = 'term-admin-row';
            const dealList = u.deals.map(d => {
                const parts = d.deal_key.split('|');
                const coords = parts[0] || '';
                const inMat = (parts[1] || '').replace(/_/g, ' ');
                const outMat = (parts[2] || '').replace(/_/g, ' ');
                return '<div style="font-size:0.65rem;color:var(--text-muted);">' +
                    ncEsc(inMat) + ' \u2192 ' + ncEsc(outMat) +
                    ' <span style="opacity:0.6;">x' + (d.quantity || 1) + ' [' + ncEsc(coords) + ']</span></div>';
            }).join('');
            row.innerHTML = `
                <div class="term-admin-row-info">
                    <div><strong>${ncEsc(u.username)}</strong>${u.ign ? ' <span style="color:var(--text-muted);font-size:0.65rem;">(' + ncEsc(u.ign) + ')</span>' : ''} &mdash; ${u.deals.length} deals</div>
                    ${dealList}
                </div>
            `;
            content.appendChild(row);
        }
    } catch (err) {
        console.error('Load carts failed:', err);
        content.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:0.8rem;">Failed to load saved carts.</div>';
    }
}

async function loadTermAdminConsults() {
    const content = document.getElementById('termAdminContent');
    if (!content) return;
    content.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:0.8rem;">Loading consultations...</div>';
    try {
        const consults = await supabaseRest('nc_terminal_consultations', 'select=*&order=created_at.desc');
        const q = (document.getElementById('termAdminSearch')?.value || '').toLowerCase().trim();
        const filtered = consults.filter(c => {
            if (!q) return true;
            return [c.username, c.topic, c.requested_date, c.requested_time, c.notes, c.status]
                .filter(Boolean).join(' ').toLowerCase().includes(q);
        });
        if (filtered.length === 0) {
            content.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:0.8rem;">No consultations found.</div>';
            return;
        }
        let html = '';
        for (const c of filtered) {
            const dateStr = new Date(c.requested_date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            html += '<div class="term-admin-row" style="display:flex;justify-content:space-between;align-items:center;">';
            html += '<div style="flex:1;min-width:0;">';
            html += '<div style="font-weight:600;font-size:0.8rem;">' + ncEsc(c.username) + ' &mdash; ' + ncEsc(c.topic) + '</div>';
            html += '<div style="font-size:0.65rem;color:var(--text-muted);">' + dateStr + ' at ' + c.requested_time + ' UTC' + (c.notes ? ' &middot; ' + ncEsc(c.notes.substring(0, 80)) : '') + '</div>';
            html += '</div>';
            html += '<div style="display:flex;align-items:center;gap:0.4rem;">';
            html += '<select class="term-admin-status-select" data-id="' + c.id + '" style="font-size:0.65rem;padding:0.15rem 0.3rem;background:rgba(255,255,255,0.06);border:1px solid rgba(184,180,204,0.2);border-radius:3px;color:var(--text);">';
            ['pending', 'confirmed', 'completed', 'cancelled'].forEach(s => {
                html += '<option value="' + s + '"' + (c.status === s ? ' selected' : '') + '>' + s + '</option>';
            });
            html += '</select>';
            html += '<button class="term-admin-delete" data-id="' + c.id + '" title="Delete">&times;</button>';
            html += '</div></div>';
        }
        content.innerHTML = html;

        // Status change handlers
        content.querySelectorAll('.term-admin-status-select').forEach(sel => {
            sel.addEventListener('change', async () => {
                try {
                    await fetch(CONFIG.supabaseUrl + '/rest/v1/nc_terminal_consultations?id=eq.' + sel.dataset.id, {
                        method: 'PATCH', headers: restHeaders(), body: JSON.stringify({ status: sel.value })
                    });
                } catch (err) { console.error('Status update failed:', err); }
            });
        });
        // Delete handlers
        content.querySelectorAll('.term-admin-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this consultation?')) return;
                try {
                    await fetch(CONFIG.supabaseUrl + '/rest/v1/nc_terminal_consultations?id=eq.' + btn.dataset.id, {
                        method: 'DELETE', headers: restHeaders()
                    });
                    loadTermAdminConsults();
                } catch (err) { console.error('Delete failed:', err); }
            });
        });
    } catch (err) {
        console.error('Load consults failed:', err);
        content.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:0.8rem;">Failed to load consultations.</div>';
    }
}
