// ============================================
// Shop Explorer — Tradex Integration
// ============================================

let ncShopMode = false;
let ncShopMarkers = [];
let ncShopExchanges = [];  // raw API data (within NC bounds)
let ncShopFiltered = [];   // after client-side filtering
let ncShopDataReady = false;

const NC_SHOP_CENTER = { x: -3163, z: 8168 };
const NC_SHOP_BOUNDS = { minX: -3550, maxX: -2750, minZ: 7750, maxZ: 8550 };
const TRADEX_API = 'https://api.tradex.civinfo.net/exchanges/search';
const NC_SHOP_LINK_RADIUS = 15;

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

function ncEnterShopMode() {
    ncShopMode = true;
    document.getElementById('ncModeToggle').textContent = 'View Registry';
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
            maxWidth: 500,
            minWidth: 350,
            autoPan: false,
            className: 'nc-leaflet-popup'
        });

        marker._ncShopKey = group.key;

        // Clicking a marker → sync carousel and center
        marker.on('popupopen', function() {
            if (_ncShopFromCard) return;
            const firstIdx = ncShopFiltered.findIndex(ex =>
                `${ex.pos.x},${ex.pos.y},${ex.pos.z}` === group.key
            );
            if (firstIdx >= 0) {
                ncShopHighlightCard(firstIdx);
                ncShopCenterOnPoint(group.pos);
            }
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

function ncShopCenterOnPoint(pos) {
    const targetLatLng = L.latLng(-pos.z, pos.x);
    const bar = document.getElementById('ncShopBar');
    const panel = document.getElementById('ncShopPanel');
    const barH = bar ? bar.offsetHeight : 0;
    const panelH = panel ? panel.offsetHeight : 0;
    const offsetPx = (barH + panelH) / 2;
    if (offsetPx > 0) {
        const targetPoint = ncMap.project(targetLatLng, 3);
        const adjustedCenter = ncMap.unproject(L.point(targetPoint.x, targetPoint.y + offsetPx), 3);
        ncMap.setView(adjustedCenter, 3, { animate: false });
    } else {
        ncMap.setView(targetLatLng, 3, { animate: false });
    }
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
        ncShopCenterOnPoint(ex.pos);
        _ncShopFromCard = true;
        ncOpenShopMarkerPopup(ex.pos);
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
document.getElementById('ncShopSort').addEventListener('change', () => { if (ncShopMode) ncFilterShops(); });
document.getElementById('ncShopFreshness').addEventListener('change', () => { if (ncShopMode) ncFilterShops(); });
document.getElementById('ncShopUnstocked').addEventListener('change', () => { if (ncShopMode) ncFilterShops(); });
