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

function ncDealKey(e) {
    return `${e.pos.x},${e.pos.y},${e.pos.z}|${e.input?.material || ''}|${e.output?.material || ''}`;
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
async function ncEnsureShopData() {
    if (ncShopDataReady) return;
    try {
        const resp = await fetch(TRADEX_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pos: { server: 'play.civmc.net', world: 'overworld', x: NC_SHOP_CENTER.x, y: 64, z: NC_SHOP_CENTER.z },
                sortMode: 'closest',
                limit: 500,
                allowUnstocked: true
            })
        });
        if (!resp.ok) throw new Error(`Tradex API ${resp.status}`);
        const data = await resp.json();
        ncShopExchanges = (data.exchanges || []).filter(e => {
            const p = e.pos;
            return p.x >= NC_SHOP_BOUNDS.minX && p.x <= NC_SHOP_BOUNDS.maxX &&
                   p.z >= NC_SHOP_BOUNDS.minZ && p.z <= NC_SHOP_BOUNDS.maxZ;
        });
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
    return Object.values(grouped)
        .map(g => ({ ...g, dist: Math.hypot(g.pos.x - prop.x, g.pos.z - prop.z) }))
        .filter(g => g.dist <= NC_SHOP_LINK_RADIUS)
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
    // Hide registrar UI
    document.querySelectorAll('.nc-registrar-ui').forEach(el => el.style.display = 'none');
    // Hide property markers
    ncMarkers.forEach(m => ncMap.removeLayer(m));
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
            const assoc = ncGetLinkedProperty(link) || (nearest && typeof ncProperties !== 'undefined' ? ncProperties.find(p => p.id === nearest.id) : null);
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
        const inName = e.input?.customName || e.input?.material || '?';
        const outName = e.output?.customName || e.output?.material || '?';
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
            const nearest = ncShopNearestProperty(e.pos);
            if (nearest) nearLine = `<div class="nc-shop-near">Near ${ncEsc(nearest.name)} (${nearest.dist}m)</div>`;
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
    const nearest = ncShopNearestProperty(p);
    const canEdit = ncSurveyMode && typeof ncCanEdit === 'function' && ncCanEdit();
    const isStale = link && link.stale;

    const assocProp = linkedProp || (nearest ? (typeof ncProperties !== 'undefined' ? ncProperties.find(p => p.id === nearest.id) : null) : null);
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
        const inName = e.input?.customName || e.input?.material || '?';
        const outName = e.output?.customName || e.output?.material || '?';
        const stockStyle = e.stock > 0 ? 'color:#4caf50' : 'color:#e04040';
        const stockText = e.stock > 0 ? `In Stock (${e.stock})` : 'Out of Stock';
        const enchants = e.output?.storedEnchants || {};
        const enchList = Object.entries(enchants);
        const enchStr = enchList.length > 0 ? ` <span style="color:#a78bfa;font-size:0.7rem;">${enchList.map(([n, l]) => `${n} ${l}`).join(', ')}</span>` : '';

        if (i > 0) h += `<div style="border-top:1px solid rgba(184,180,204,0.1);"></div>`;
        h += `<div style="padding:0.25rem 0;">`;
        // Stock + age line
        h += `<div style="font-size:0.75rem;display:flex;justify-content:space-between;margin-bottom:0.15rem;">`;
        h += `<span style="${stockStyle};font-weight:600;">${stockText}</span>`;
        h += `<span style="color:var(--text-muted);">${ncFormatAge(e.time)}</span>`;
        h += `</div>`;
        // Trade line (larger, centered)
        h += `<div style="font-size:1rem;white-space:nowrap;text-align:center;">`;
        h += `<strong>${e.input?.count || 1}x</strong> ${ncEsc(inName)}`;
        h += ` <span style="color:var(--text-muted);">&rarr;</span> `;
        h += `<strong>${e.output?.count || 1}x</strong> ${ncEsc(outName)}${enchStr}`;
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
            h += `<button class="nc-shop-link-btn" data-action="confirm" data-key="${posKey}" style="font-size:0.62rem;padding:0.2rem 0.5rem;background:rgba(76,175,80,0.2);border:1px solid #4caf50;border-radius:4px;color:#4caf50;cursor:pointer;">Confirm${nearest ? ' (' + ncEsc(nearest.name) + ')' : ''}</button>`;
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
    const assocProp = linkedProp || (nearest && typeof ncProperties !== 'undefined' ? ncProperties.find(p => p.id === nearest.id) : null);
    const propName = assocProp ? assocProp.name : '';
    const propId = assocProp ? assocProp.id : null;
    const discordContact = (link && link.discord_contact) || (assocProp && assocProp.discord_contact) || '';
    const outName = e.output?.customName || e.output?.material || '?';
    const inName = e.input?.customName || e.input?.material || '?';
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
        const inMat = e.input?.customName || e.input?.material || '?';
        const outMat = e.output?.customName || e.output?.material || '?';
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
        const inName = e.input?.customName || e.input?.material || '?';
        const outName = e.output?.customName || e.output?.material || '?';
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
