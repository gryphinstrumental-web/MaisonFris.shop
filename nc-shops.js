// ============================================
// Shop Explorer — Tradex Integration
// ============================================

let ncShopMode = false;
let ncShopMarkers = [];
let ncShopExchanges = [];  // raw API data (within NC bounds)
let ncShopFiltered = [];   // after client-side filtering

const NC_SHOP_CENTER = { x: -3163, z: 8168 };
const NC_SHOP_BOUNDS = { minX: -3550, maxX: -2750, minZ: 7750, maxZ: 8550 };
const TRADEX_API = 'https://api.tradex.civinfo.net/exchanges/search';

// ============================================
// Mode Toggle
// ============================================
document.getElementById('ncModeToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.nc-mode-btn');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if ((mode === 'shops' && ncShopMode) || (mode === 'registrar' && !ncShopMode)) return;

    document.querySelectorAll('.nc-mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (mode === 'shops') {
        ncEnterShopMode();
    } else {
        ncExitShopMode();
    }
});

function ncEnterShopMode() {
    ncShopMode = true;
    // Hide registrar UI
    document.querySelectorAll('.nc-registrar-ui').forEach(el => el.style.display = 'none');
    // Hide property markers
    ncMarkers.forEach(m => ncMap.removeLayer(m));
    // Show shop UI
    document.querySelectorAll('.nc-shop-ui').forEach(el => el.style.display = 'flex');
    // Fetch shop data
    ncFetchShops();
}

function ncExitShopMode() {
    ncShopMode = false;
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
}

// ============================================
// Fetch & Filter
// ============================================
async function ncFetchShops() {
    const results = document.getElementById('ncShopResults');
    results.innerHTML = '<div class="nc-shop-loading">Loading shops...</div>';

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

        // Filter to NC bounds
        ncShopExchanges = (data.exchanges || []).filter(e => {
            const p = e.pos;
            return p.x >= NC_SHOP_BOUNDS.minX && p.x <= NC_SHOP_BOUNDS.maxX &&
                   p.z >= NC_SHOP_BOUNDS.minZ && p.z <= NC_SHOP_BOUNDS.maxZ;
        });

        ncFilterShops();
    } catch (err) {
        console.error('Tradex fetch error:', err);
        results.innerHTML = '<div class="nc-shop-empty">Failed to load shop data.</div>';
    }
}

function ncFilterShops() {
    const searchQ = (document.getElementById('ncShopSearch').value || '').toLowerCase().trim();
    const payWithQ = (document.getElementById('ncShopPayWith').value || '').toLowerCase().trim();
    const sortMode = document.getElementById('ncShopSort').value;
    const freshDays = parseInt(document.getElementById('ncShopFreshness').value) || 0;
    const showUnstocked = document.getElementById('ncShopUnstocked').checked;

    const now = Date.now();
    const freshCutoff = freshDays > 0 ? now - (freshDays * 86400000) : 0;

    ncShopFiltered = ncShopExchanges.filter(e => {
        if (!showUnstocked && e.stock <= 0) return false;
        if (freshCutoff && e.time < freshCutoff) return false;

        if (searchQ) {
            const outName = (e.output?.material || '').toLowerCase();
            const outCustom = (e.output?.customName || '').toLowerCase();
            if (!outName.includes(searchQ) && !outCustom.includes(searchQ)) return false;
        }

        if (payWithQ) {
            const inName = (e.input?.material || '').toLowerCase();
            const inCustom = (e.input?.customName || '').toLowerCase();
            if (!inName.includes(payWithQ) && !inCustom.includes(payWithQ)) return false;
        }

        return true;
    });

    // Sort
    if (sortMode === 'cheapest') {
        ncShopFiltered.sort((a, b) => {
            const ratioA = (a.input?.count || 1) / (a.output?.count || 1);
            const ratioB = (b.input?.count || 1) / (b.output?.count || 1);
            return ratioA - ratioB;
        });
    } else if (sortMode === 'newest') {
        ncShopFiltered.sort((a, b) => b.time - a.time);
    } else {
        ncShopFiltered.sort((a, b) => {
            const dA = Math.hypot(a.pos.x - NC_SHOP_CENTER.x, a.pos.z - NC_SHOP_CENTER.z);
            const dB = Math.hypot(b.pos.x - NC_SHOP_CENTER.x, b.pos.z - NC_SHOP_CENTER.z);
            return dA - dB;
        });
    }

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

        html += `<div class="nc-shop-card" data-idx="${i}">
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
                <span class="nc-shop-coords" data-x="${e.pos.x}" data-z="${e.pos.z}">${e.pos.x}, ${e.pos.z}</span>
            </div>
        </div>`;
    });

    container.innerHTML = html;
}

function ncEsc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
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
        if (!grouped[key]) grouped[key] = { pos: e.pos, exchanges: [] };
        grouped[key].exchanges.push(e);
    });

    Object.values(grouped).forEach(group => {
        const p = group.pos;
        const marker = L.circleMarker([-p.z, p.x], {
            radius: 5,
            fillColor: '#00bcd4',
            color: 'rgba(255,255,255,0.6)',
            weight: 1,
            fillOpacity: 0.9
        }).addTo(ncMap);

        marker.bindTooltip(`${group.exchanges.length} trade${group.exchanges.length !== 1 ? 's' : ''}`, {
            className: 'nc-tooltip',
            direction: 'top',
            offset: [0, -6]
        });

        marker.bindPopup(ncShopPopupHTML(group.exchanges), {
            maxWidth: 400,
            minWidth: 280,
            className: 'nc-leaflet-popup'
        });

        ncShopMarkers.push(marker);
    });
}

function ncShopPopupHTML(exchanges) {
    let h = '<div style="max-height: 300px; overflow-y: auto;">';
    h += `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:0.5rem;">\u{1F4CD} ${exchanges[0].pos.x}, ${exchanges[0].pos.z} &middot; ${exchanges.length} trade${exchanges.length !== 1 ? 's' : ''}</div>`;

    exchanges.forEach(e => {
        const inName = e.input?.customName || e.input?.material || '?';
        const outName = e.output?.customName || e.output?.material || '?';
        const stockClass = e.stock > 0 ? 'color:#4caf50' : 'color:#e04040';
        const stockText = e.stock > 0 ? `In Stock (${e.stock})` : 'Out of Stock';

        h += `<div style="padding:0.3rem 0;border-bottom:1px solid rgba(184,180,204,0.1);">`;
        h += `<div style="font-size:0.78rem;"><strong>${e.input?.count || 1}x</strong> ${ncEsc(inName)} <span style="color:var(--text-muted);">&rarr;</span> <strong>${e.output?.count || 1}x</strong> ${ncEsc(outName)}</div>`;
        h += `<div style="font-size:0.65rem;margin-top:0.15rem;"><span style="${stockClass};font-weight:600;">${stockText}</span> &middot; ${ncFormatAge(e.time)}</div>`;

        const enchants = e.output?.storedEnchants || {};
        const enchList = Object.entries(enchants);
        if (enchList.length > 0) {
            h += `<div style="font-size:0.62rem;color:#a78bfa;margin-top:0.1rem;">${enchList.map(([n, l]) => `${n} ${l}`).join(', ')}</div>`;
        }

        h += '</div>';
    });

    h += '</div>';
    return h;
}

// ============================================
// Event Handlers
// ============================================

// Click on result card → pan to location
document.getElementById('ncShopResults').addEventListener('click', (e) => {
    const coords = e.target.closest('.nc-shop-coords');
    if (coords) {
        const x = parseFloat(coords.dataset.x);
        const z = parseFloat(coords.dataset.z);
        ncMap.setView([-z, x], 1);
        return;
    }
    const card = e.target.closest('.nc-shop-card');
    if (card) {
        const idx = parseInt(card.dataset.idx);
        const ex = ncShopFiltered[idx];
        if (ex) ncMap.setView([-ex.pos.z, ex.pos.x], 1);
    }
});

// Scroll arrows for shop panel
document.getElementById('ncShopPanelLeft').addEventListener('click', () => {
    document.getElementById('ncShopResults').scrollBy({ left: -400, behavior: 'smooth' });
});
document.getElementById('ncShopPanelRight').addEventListener('click', () => {
    document.getElementById('ncShopResults').scrollBy({ left: 400, behavior: 'smooth' });
});

// Filter change handlers
document.getElementById('ncShopSearch').addEventListener('input', () => { if (ncShopMode) ncFilterShops(); });
document.getElementById('ncShopPayWith').addEventListener('input', () => { if (ncShopMode) ncFilterShops(); });
document.getElementById('ncShopSort').addEventListener('change', () => { if (ncShopMode) ncFilterShops(); });
document.getElementById('ncShopFreshness').addEventListener('change', () => { if (ncShopMode) ncFilterShops(); });
document.getElementById('ncShopUnstocked').addEventListener('change', () => { if (ncShopMode) ncFilterShops(); });
