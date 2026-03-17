// ============================================
// New Callisto Property Map
// ============================================
let ncMap = null;
let ncMarkers = [];
let ncProperties = [];
let ncLabelsVisible = false;

const NC_PROPERTY_JSON_URL = 'https://raw.githubusercontent.com/jalhf/New-Callisto-Property-Register/main/converted_properties.json';
const NC_TYPE_COLORS = {
    'Residential': '#183dde',
    'Commercial': '#2c7d27',
    'Government': '#9e42f5'
};

async function loadNewCallisto() {
    if (ncMap) {
        ncMap.invalidateSize();
        return;
    }

    // Image overlay bounds: MC X [-4608, -512], Z [6144, 10240]
    // Leaflet CRS.Simple: lat = -MC_Z, lng = MC_X
    const ncBounds = [[-10240, -4608], [-6144, -512]]; // [[south,west],[north,east]]

    ncMap = L.map('ncMap', {
        crs: L.CRS.Simple,
        minZoom: -3,
        maxZoom: 3,
        zoomSnap: 0.5,
        zoomDelta: 1,
        attributionControl: false,
        zoomControl: false,
        doubleClickZoom: false,
        maxBounds: [[-10500, -4900], [-5900, -200]],
        maxBoundsViscosity: 0.8
    });

    L.imageOverlay('nc-terrain.jpg', ncBounds).addTo(ncMap);

    // Center on New Callisto — lat = -minecraft_z, lng = minecraft_x
    ncMap.setView([-8227, -3268], 0);

    // Live coordinate display on hover
    const coordsEl = document.getElementById('ncCoords');
    coordsEl.textContent = 'X: —  Z: —';
    ncMap.getContainer().addEventListener('mousemove', (e) => {
        const pt = ncMap.containerPointToLatLng(L.point(e.layerX, e.layerY));
        const mcX = Math.round(pt.lng);
        const mcZ = Math.round(-pt.lat);
        coordsEl.textContent = `X: ${mcX}  Z: ${mcZ}`;
    });

    // Double-click to create new property row in spreadsheet (admin/surveyor only)
    ncMap.on('dblclick', (e) => {
        if (ncShopMode) return;
        if (!ncCanEdit()) return;
        const mcX = Math.round(e.latlng.lng);
        const mcZ = Math.round(-e.latlng.lat);
        if (!confirm(`Create new property at X: ${mcX}, Z: ${mcZ}?`)) return;
        // Open table overlay + enter edit mode
        const overlay = document.getElementById('ncTableOverlay');
        overlay.classList.add('open');
        if (!ncEditMode) {
            ncDirtyRows.clear();
            ncEditMode = true;
        }
        // Add new row with coordinates pre-filled
        ncProperties.push({ name: 'New Property', type: 'Residential', address: '', owner: '',
            tenant: null, discord_contact: null, x: mcX, z: mcZ, color: '#888',
            appraised_value: null, status: 'Good Standing', last_surveyed: null, image_url: null, trust_deposit: 0 });
        ncHasUnsaved = true;
        ncDirtyRows.add(ncProperties.length - 1);
        ncUpdateToolbar();
        renderNCTable(ncProperties, document.getElementById('ncTableSearch').value);
        // Scroll table to the new row
        const wrap = document.querySelector('.nc-table-wrap');
        if (wrap) setTimeout(() => wrap.scrollTop = wrap.scrollHeight, 50);
    });

    // Unified popup handler — all popup setup in one listener
    ncMap.on('popupopen', (e) => {
        const container = e.popup.getElement();
        if (!container) return;
        const canEdit = ncCanEdit();

        // --- Layout: center map on property, lower bottom controls ---
        document.getElementById('newCallistoView').classList.add('popup-open');
        const latlng = e.popup.getLatLng();
        if (latlng) {
            const zoom = ncMap.getZoom();
            const px = ncMap.project(latlng, zoom);
            const mapH = ncMap.getSize().y;
            const panelH = document.getElementById('ncPanel')?.offsetHeight || 120;
            px.y -= (mapH / 2 - panelH - 80);
            ncMap.panTo(ncMap.unproject(px, zoom));
        }

        // --- Portrait image detection ---
        const img = container.querySelector('.nc-popup-img-wrap img');
        if (img) {
            const popup = container.querySelector('.nc-popup');
            const applyPortrait = () => {
                if (img.naturalHeight > img.naturalWidth) {
                    popup.classList.add('nc-popup-portrait');
                    e.popup.update();
                }
            };
            if (img.complete) applyPortrait();
            else img.addEventListener('load', applyPortrait);
        }

        // --- Click-to-copy: coords, name, owner, discord ---
        const coordsEl = container.querySelector('.nc-coords-copy');
        if (coordsEl) {
            coordsEl.addEventListener('click', () => {
                navigator.clipboard.writeText(coordsEl.dataset.coords).then(() => {
                    const tip = document.createElement('div');
                    tip.className = 'nc-copy-toast';
                    tip.textContent = 'Cords Copied to Clipboard';
                    coordsEl.style.position = 'relative';
                    coordsEl.appendChild(tip);
                    setTimeout(() => tip.remove(), 1500);
                });
            });
        }
        container.querySelectorAll('.nc-popup-copyable').forEach(cel => {
            cel.style.cursor = 'pointer';
            cel.addEventListener('click', () => {
                navigator.clipboard.writeText(cel.dataset.copy).then(() => {
                    const tip = document.createElement('div');
                    tip.className = 'nc-copy-toast';
                    tip.textContent = 'Copied!';
                    cel.style.position = 'relative';
                    cel.appendChild(tip);
                    setTimeout(() => tip.remove(), 1500);
                });
            });
        });

        // --- Signage / Shopchests / Historic toggle (admin/surveyor) ---
        container.querySelectorAll('.nc-popup-toggle').forEach(el => {
            if (canEdit) {
                el.style.cursor = 'pointer';
                el.addEventListener('click', async () => {
                    const pi = parseInt(el.dataset.pi);
                    const field = el.dataset.field;
                    const prop = ncProperties[pi];
                    const oldVal = prop[field];
                    prop[field] = !prop[field];
                    el.textContent = prop[field] ? '\u2705' : '\u274C';
                    if (prop.id) {
                        const now = new Date().toISOString();
                        prop.last_surveyed = now;
                        await fetch(`${CONFIG.supabaseUrl}/rest/v1/nc_properties?id=eq.${prop.id}`, {
                            method: 'PATCH', headers: restHeaders(),
                            body: JSON.stringify({ [field]: prop[field], last_surveyed: now, updated_at: now })
                        });
                        ncLogChange(prop.id, field, String(oldVal), String(prop[field]));
                    }
                    // Re-style marker border for historic toggle
                    if (field === 'historic' && ncMarkers[pi]) {
                        const comp = ncGetCompliance(prop);
                        ncMarkers[pi].setStyle({
                            color: prop.historic ? 'rgba(212,160,23,0.8)' : (comp && !comp.compliant) ? 'rgba(224,64,64,0.7)' : 'rgba(255,255,255,0.5)',
                            weight: (prop.historic || (comp && !comp.compliant)) ? 2 : 1
                        });
                    }
                });
            }
        });

        // --- Shop link confirm/dismiss/unlink/restore (admin/surveyor) ---
        if (canEdit) {
            container.querySelectorAll('.nc-shop-link-btn').forEach(btn => {
                btn.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    const action = btn.dataset.action;
                    const key = btn.dataset.key;
                    const pi = parseInt(btn.dataset.pi);
                    const prop = ncProperties[pi];
                    if (!prop?.id) return;
                    const [sx, sy, sz] = key.split(',').map(Number);
                    try {
                        const existing = prop._shopLinks.find(l => l.shop_x === sx && l.shop_y === sy && l.shop_z === sz);
                        if (action === 'confirm') {
                            if (existing) {
                                await supabaseUpdate('nc_property_shops', existing.id, { dismissed: false });
                                existing.dismissed = false;
                            } else {
                                const rows = await supabaseInsert('nc_property_shops', {
                                    property_id: prop.id, shop_x: sx, shop_y: sy, shop_z: sz,
                                    confirmed_by: currentUser?.id || null,
                                    confirmed_by_name: userProfile?.discord_username || 'Unknown'
                                });
                                prop._shopLinks.push(rows?.[0] || { property_id: prop.id, shop_x: sx, shop_y: sy, shop_z: sz, dismissed: false });
                            }
                        } else if (action === 'dismiss') {
                            if (existing) {
                                await supabaseUpdate('nc_property_shops', existing.id, { dismissed: true });
                                existing.dismissed = true;
                            } else {
                                const rows = await supabaseInsert('nc_property_shops', {
                                    property_id: prop.id, shop_x: sx, shop_y: sy, shop_z: sz,
                                    confirmed_by: currentUser?.id || null,
                                    confirmed_by_name: userProfile?.discord_username || 'Unknown',
                                    dismissed: true
                                });
                                prop._shopLinks.push(rows?.[0] || { property_id: prop.id, shop_x: sx, shop_y: sy, shop_z: sz, dismissed: true });
                            }
                        } else if (action === 'unlink' || action === 'restore') {
                            if (existing?.id) {
                                await supabaseDelete('nc_property_shops', existing.id);
                            } else {
                                const found = await supabaseRest('nc_property_shops',
                                    `select=id&property_id=eq.${prop.id}&shop_x=eq.${sx}&shop_y=eq.${sy}&shop_z=eq.${sz}`);
                                if (found?.[0]) await supabaseDelete('nc_property_shops', found[0].id);
                            }
                            prop._shopLinks = prop._shopLinks.filter(l => !(l.shop_x === sx && l.shop_y === sy && l.shop_z === sz));
                        }
                        // Refresh popup in-place
                        const marker = ncMarkers[pi];
                        if (marker) {
                            marker.setPopupContent(buildPopupHTML(prop, true, pi));
                            // Re-bind event handlers by closing and reopening
                            const latlng = marker.getLatLng();
                            ncMap.closePopup();
                            setTimeout(() => marker.openPopup(), 50);
                        }
                    } catch (err) {
                        console.error('Shop link action failed:', err);
                    }
                });
            });
        }

        // --- Click shop row → navigate to shop mode ---
        container.querySelectorAll('.nc-shop-link-goto').forEach(el => {
            el.style.cursor = 'pointer';
            el.addEventListener('click', () => {
                const row = el.closest('.nc-shop-link-row');
                if (!row) return;
                const sx = parseInt(row.dataset.shopX), sy = parseInt(row.dataset.shopY), sz = parseInt(row.dataset.shopZ);
                ncMap.closePopup();
                if (typeof ncGoToShop === 'function') ncGoToShop(sx, sy, sz);
            });
        });

        // --- Log buttons (all users) ---
        const txnBtn = container.querySelector('.nc-popup-txn-btn');
        if (txnBtn) {
            const pi = parseInt(txnBtn.dataset.pi);
            txnBtn.addEventListener('click', () => { ncMap.closePopup(); ncShowTransactionLog(ncProperties[pi]); });
        }
        const logBtn = container.querySelector('.nc-popup-log-btn');
        if (logBtn) {
            const pi = parseInt(logBtn.dataset.pi);
            logBtn.addEventListener('click', () => { ncMap.closePopup(); ncShowSurveyorLog(ncProperties[pi]); });
        }
        const fineBtn = container.querySelector('.nc-popup-fine-btn');
        if (fineBtn) {
            const pi = parseInt(fineBtn.dataset.pi);
            fineBtn.addEventListener('click', () => { ncMap.closePopup(); ncShowFineLog(ncProperties[pi]); });
        }

        // --- Admin/surveyor only: image upload, dropdowns, inline editing ---
        if (canEdit) {
            // Helper: upload and save image for property in popup
            async function popupUploadImage(file, prop, pi, statusEl) {
                if (statusEl) statusEl.textContent = 'Uploading...';
                try {
                    const ext = file.name ? file.name.split('.').pop() : (file.type === 'image/png' ? 'png' : 'jpg');
                    const fname = `prop_${prop.id || pi}_${Date.now()}.${ext}`;
                    const uploadResp = await fetch(`${CONFIG.supabaseUrl}/storage/v1/object/nc-images/${fname}`, {
                        method: 'POST',
                        headers: {
                            'apikey': CONFIG.supabaseKey,
                            'Authorization': `Bearer ${currentAccessToken || CONFIG.supabaseKey}`,
                            'Content-Type': file.type
                        },
                        body: file
                    });
                    if (!uploadResp.ok) throw new Error(await uploadResp.text());
                    prop.image_url = `${CONFIG.supabaseUrl}/storage/v1/object/public/nc-images/${fname}`;
                    if (prop.id) {
                        await fetch(`${CONFIG.supabaseUrl}/rest/v1/nc_properties?id=eq.${prop.id}`, {
                            method: 'PATCH', headers: restHeaders(),
                            body: JSON.stringify({ image_url: prop.image_url, updated_at: new Date().toISOString() })
                        });
                    }
                    ncMap.closePopup();
                    ncRefreshAll();
                } catch (err) {
                    console.error('Popup image upload failed:', err);
                    if (statusEl) statusEl.textContent = 'Upload failed!';
                }
            }

            // Add-image zone (no image yet)
            const zone = container.querySelector('.nc-popup-img-zone');
            if (zone) {
                const pi = parseInt(zone.dataset.pi);
                const prop = ncProperties[pi];
                const statusEl = zone.querySelector('.nc-popup-img-status');
                zone.addEventListener('click', () => {
                    const fileInput = document.createElement('input');
                    fileInput.type = 'file';
                    fileInput.accept = 'image/*';
                    fileInput.addEventListener('change', async () => {
                        if (fileInput.files[0]) await popupUploadImage(fileInput.files[0], prop, pi, statusEl);
                    });
                    fileInput.click();
                });
                zone.tabIndex = 0;
                zone.addEventListener('paste', async (ev) => {
                    ev.preventDefault();
                    const items = ev.clipboardData?.items;
                    if (!items) return;
                    for (const item of items) {
                        if (item.type.startsWith('image/')) {
                            const file = item.getAsFile();
                            if (file) { await popupUploadImage(file, prop, pi, statusEl); return; }
                        }
                    }
                    if (statusEl) statusEl.textContent = 'No image in clipboard';
                });
            }

            // Change-image button
            const changeBtn = container.querySelector('.nc-popup-img-change');
            if (changeBtn) {
                const popupEl = container.querySelector('.nc-popup');
                const pi = popupEl ? parseInt(popupEl.dataset.pi) : null;
                if (pi != null) {
                    const prop = ncProperties[pi];
                    changeBtn.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        const fileInput = document.createElement('input');
                        fileInput.type = 'file';
                        fileInput.accept = 'image/*';
                        fileInput.addEventListener('change', async () => {
                            if (fileInput.files[0]) await popupUploadImage(fileInput.files[0], prop, pi, null);
                        });
                        fileInput.click();
                    });
                }
            }

            // Remove-image button
            const removeBtn = container.querySelector('.nc-popup-img-remove');
            if (removeBtn) {
                const popupEl = container.querySelector('.nc-popup');
                const pi = popupEl ? parseInt(popupEl.dataset.pi) : null;
                if (pi != null) {
                    const prop = ncProperties[pi];
                    removeBtn.addEventListener('click', async (ev) => {
                        ev.stopPropagation();
                        if (!confirm('Remove this image?')) return;
                        prop.image_url = null;
                        if (prop.id) {
                            await fetch(`${CONFIG.supabaseUrl}/rest/v1/nc_properties?id=eq.${prop.id}`, {
                                method: 'PATCH', headers: restHeaders(),
                                body: JSON.stringify({ image_url: null, updated_at: new Date().toISOString() })
                            });
                        }
                        ncMap.closePopup();
                        ncRefreshAll();
                    });
                }
            }

            // Status dropdown
            const statusDD = container.querySelector('.nc-popup-status-dd');
            if (statusDD) {
                const pi = parseInt(statusDD.dataset.pi);
                const prop = ncProperties[pi];
                const statusColors = { 'Good Standing': '#4caf50', 'Warning': '#e6a817', 'Derelict': '#e04040' };
                statusDD.addEventListener('change', async () => {
                    const oldStatus = prop.status || 'Good Standing';
                    const newStatus = statusDD.value;
                    if (oldStatus === newStatus) return;
                    prop.status = newStatus;
                    statusDD.style.background = statusColors[newStatus] || '#888';
                    if (prop.id) {
                        await fetch(`${CONFIG.supabaseUrl}/rest/v1/nc_properties?id=eq.${prop.id}`, {
                            method: 'PATCH', headers: restHeaders(),
                            body: JSON.stringify({ status: newStatus, updated_at: new Date().toISOString() })
                        });
                        ncLogChange(prop.id, 'status', oldStatus, newStatus);
                    }
                });
            }

            // Type dropdown
            const typeDD = container.querySelector('.nc-popup-type-dd');
            if (typeDD) {
                const pi = parseInt(typeDD.dataset.pi);
                const prop = ncProperties[pi];
                typeDD.addEventListener('change', async () => {
                    const oldType = prop.type || 'Residential';
                    const newType = typeDD.value;
                    if (oldType === newType) return;
                    prop.type = newType;
                    typeDD.style.background = NC_TYPE_COLORS[newType] || '#888';
                    if (ncMarkers[pi]) {
                        const compliance = ncGetCompliance(prop);
                        ncMarkers[pi].setStyle({
                            fillColor: NC_TYPE_COLORS[newType] || prop.color || '#888',
                            color: prop.historic ? 'rgba(212,160,23,0.8)' : (compliance && !compliance.compliant) ? 'rgba(224,64,64,0.7)' : 'rgba(255,255,255,0.5)',
                            weight: (prop.historic || (compliance && !compliance.compliant)) ? 2 : 1
                        });
                    }
                    renderNCPanel(ncProperties);
                    if (prop.id) {
                        await fetch(`${CONFIG.supabaseUrl}/rest/v1/nc_properties?id=eq.${prop.id}`, {
                            method: 'PATCH', headers: restHeaders(),
                            body: JSON.stringify({ type: newType, updated_at: new Date().toISOString() })
                        });
                        ncLogChange(prop.id, 'type', oldType, newType);
                    }
                });
            }

            // Inline-editable fields (name, address)
            const pendingEdits = [];
            container.querySelectorAll('.nc-popup-editable').forEach(el => {
                el.addEventListener('click', () => {
                    if (el.querySelector('input')) return;
                    const field = el.dataset.field;
                    const pi = parseInt(el.dataset.pi);
                    const prop = ncProperties[pi];
                    const oldVal = prop[field] || '';
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'nc-popup-inline-input';
                    input.value = oldVal;
                    el.textContent = '';
                    el.appendChild(input);
                    L.DomEvent.disableClickPropagation(input);
                    L.DomEvent.on(input, 'keydown keypress keyup', L.DomEvent.stopPropagation);
                    input.focus();
                    input.select();
                    let saved = false;
                    const save = async () => {
                        if (saved) return;
                        saved = true;
                        input._changed = false;
                        const rawVal = input.value.trim();
                        const newVal = (field === 'trust_deposit' || field === 'appraised_value') ? (rawVal ? Number(rawVal) : null) : rawVal;
                        if (String(newVal ?? '') === String(oldVal ?? '')) return;
                        input._changed = true;
                        prop[field] = newVal;
                        if (prop.id) {
                            await fetch(`${CONFIG.supabaseUrl}/rest/v1/nc_properties?id=eq.${prop.id}`, {
                                method: 'PATCH', headers: restHeaders(),
                                body: JSON.stringify({ [field]: newVal, updated_at: new Date().toISOString() })
                            });
                            ncLogChange(prop.id, field, oldVal, newVal);
                        }
                        if (field === 'name' && ncMarkers[pi]) {
                            ncMarkers[pi].unbindTooltip();
                            ncMarkers[pi].bindTooltip(newVal || 'Unnamed', {
                                className: 'nc-tooltip',
                                direction: 'top',
                                offset: [0, -8],
                                permanent: ncLabelsVisible
                            });
                        }
                        renderNCPanel(ncProperties);
                    };
                    pendingEdits.push({ input, save });
                    input.addEventListener('keydown', (ev) => {
                        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
                        if (ev.key === 'Escape') { input.value = oldVal; input.blur(); }
                    });
                });
            });
            ncMap.once('popupclose', async () => {
                await Promise.all(pendingEdits.map(({ save }) => save()));
                if (pendingEdits.some(({ input }) => input._changed)) {
                    renderNCMarkers(ncProperties);
                }
            });
        }
    });
    ncMap.on('popupclose', () => document.getElementById('newCallistoView').classList.remove('popup-open'));

    try {
        // Load from Supabase (source of truth)
        let props = await supabaseRest('nc_properties', 'select=*&order=id.asc');

        // Auto-seed from GitHub JSON if table is empty
        if ((!props || props.length === 0) && ncCanEdit()) {
            console.log('nc_properties empty — seeding from GitHub JSON...');
            const resp = await fetch(NC_PROPERTY_JSON_URL);
            const data = await resp.json();
            const features = (data.features || data).filter(f => f.x != null && f.z != null);
            const seedRows = features.map(f => ({
                name: f.name || null, type: f.type || null, address: f.address || null,
                owner: f.owner || null, x: f.x, z: f.z, color: f.color || null, sale_link: f.sale_link || null
            }));
            await fetch(`${CONFIG.supabaseUrl}/rest/v1/nc_properties`, {
                method: 'POST', headers: restHeaders(), body: JSON.stringify(seedRows)
            });
            props = await supabaseRest('nc_properties', 'select=*&order=id.asc');
        }

        // Fallback to GitHub JSON if Supabase is empty and user can't seed
        if (!props || props.length === 0) {
            const resp = await fetch(NC_PROPERTY_JSON_URL);
            const data = await resp.json();
            props = data.features || data;
        }

        ncProperties = props;

        // Load confirmed shop links and attach to properties
        try {
            const links = await supabaseRest('nc_property_shops', 'select=*');
            const linkMap = {};
            (links || []).forEach(l => {
                if (!linkMap[l.property_id]) linkMap[l.property_id] = [];
                linkMap[l.property_id].push(l);
            });
            ncProperties.forEach(p => { p._shopLinks = linkMap[p.id] || []; });
        } catch (e) {
            console.error('Failed to load shop links:', e);
            ncProperties.forEach(p => { p._shopLinks = []; });
        }

        // Background-fetch Tradex data for proximity matching
        ncEnsureShopData();

        ncRefreshAll();
        const countEl = document.getElementById('ncPropsCount');
        if (countEl) countEl.textContent = `${ncProperties.length} properties`;
    } catch (err) {
        console.error('Failed to load NC properties:', err);
        // Fallback to GitHub JSON
        try {
            const resp = await fetch(NC_PROPERTY_JSON_URL);
            const data = await resp.json();
            ncProperties = data.features || data;
            ncRefreshAll();
        } catch (e) { console.error('GitHub fallback also failed:', e); }
    }
}

function ncRefreshAll() {
    renderNCMarkers(ncProperties);
    renderNCPanel(ncProperties);
    renderNCTable(ncProperties, document.getElementById('ncTableSearch')?.value || '');
}

function buildPopupHTML(prop, canEdit, pi) {
    const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null;
    const esc = s => (s || '').replace(/"/g, '&quot;');
    let h = `<div class="nc-popup" data-pi="${pi}">`;

    // Image
    const safeImgUrl = sanitizeUrl(prop.image_url);
    if (safeImgUrl) {
        h += `<div class="nc-popup-img-wrap"><img src="${safeImgUrl}" alt="">`;
        if (canEdit) h += `<div class="nc-popup-img-actions"><button class="nc-popup-img-action nc-popup-img-change" title="Change image">&#x270E;</button><button class="nc-popup-img-action nc-popup-img-remove" title="Remove image">&times;</button></div>`;
        h += `</div>`;
    } else if (canEdit) {
        h += `<div class="nc-popup-img-zone" data-pi="${pi}"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><span class="nc-popup-img-hint">Click here &amp; paste (Ctrl+V)</span><div class="nc-popup-img-status"></div></div>`;
    }

    // Title
    h += `<div class="nc-popup-body">`;
    if (canEdit) {
        h += `<h3 class="nc-popup-editable" data-pi="${pi}" data-field="name" title="Click to edit">${ncEsc(prop.name) || 'Unnamed Property'}</h3>`;
    } else {
        h += `<h3 class="nc-popup-copyable" data-copy="${esc(prop.name)}" title="Click to copy">${ncEsc(prop.name) || 'Unnamed Property'}</h3>`;
    }

    // Type + Status badges
    const curType = prop.type || 'Residential';
    const tc = NC_TYPE_COLORS[curType] || prop.color || '#888';
    const curStatus = prop.status || 'Good Standing';
    const sc = curStatus === 'Good Standing' ? '#4caf50' : curStatus === 'Warning' ? '#e6a817' : curStatus === 'Derelict' ? '#e04040' : '#888';
    h += `<div class="nc-prop-badges">`;
    if (canEdit) {
        h += `<select class="nc-popup-type-dd" data-pi="${pi}" style="background:${tc};">`;
        Object.keys(NC_TYPE_COLORS).forEach(t => { h += `<option value="${t}"${t === curType ? ' selected' : ''}>${t.toUpperCase()}\u00A0\u00A0</option>`; });
        h += `</select>`;
        h += `<select class="nc-popup-status-dd" data-pi="${pi}" style="background:${sc};">`;
        ['Good Standing', 'Warning', 'Derelict'].forEach(s => { h += `<option value="${s}"${s === curStatus ? ' selected' : ''}>${s.toUpperCase()}\u00A0\u00A0\u00A0\u00A0</option>`; });
        h += `</select>`;
    } else {
        h += `<span class="nc-prop-type" style="background: ${tc};">${curType.toUpperCase()}</span>`;
        h += `<span class="nc-prop-status-badge" style="background: ${sc};">${curStatus.toUpperCase()}</span>`;
    }
    h += `</div>`;

    // Details
    if (canEdit) {
        h += `<div class="nc-prop-detail"><span>Address</span><span class="value nc-popup-editable" data-pi="${pi}" data-field="address" title="Click to edit">${ncEsc(prop.address)}</span></div>`;
    } else if (prop.address) {
        h += `<div class="nc-prop-detail"><span>Address</span><span class="value">${ncEsc(prop.address)}</span></div>`;
    }
    if (prop.owner) h += `<div class="nc-prop-detail"><span>Owner</span><span class="value nc-popup-copyable" data-copy="${esc(prop.owner)}" title="Click to copy">${ncEsc(prop.owner)}</span></div>`;
    if (prop.tenant) h += `<div class="nc-prop-detail"><span>Tenant</span><span class="value">${ncEsc(prop.tenant)}</span></div>`;
    if (prop.discord_contact) h += `<div class="nc-prop-detail"><span>Discord</span><span class="value nc-popup-copyable" data-copy="${esc(prop.discord_contact)}" title="Click to copy">${ncEsc(prop.discord_contact)}</span></div>`;
    h += `<div class="nc-prop-detail"><span>Coords</span><span class="value nc-coords-copy" data-coords="${prop.x}, ${prop.z}" title="Click to copy">${prop.x}, ${prop.z}</span></div>`;
    if (prop.appraised_value) h += `<div class="nc-prop-detail"><span>Value</span><span class="value">${prop.appraised_value}d</span></div>`;

    // Signage, Shopchests (commercial only)
    if (prop.type === 'Commercial') {
        h += `<div class="nc-prop-detail"><span>Signage</span><span class="value nc-popup-toggle" data-pi="${pi}" data-field="signage">${prop.signage ? '\u2705' : '\u274C'}</span></div>`;
        h += `<div class="nc-prop-detail"><span>Shopchests</span><span class="value nc-popup-toggle" data-pi="${pi}" data-field="shopchests">${prop.shopchests ? '\u2705' : '\u274C'}</span></div>`;
    }

    // Compliance
    const comp = ncGetCompliance(prop);
    if (comp) {
        const badge = comp.compliant
            ? '<span style="background:rgba(76,175,80,0.25);color:#4caf50;padding:0.1rem 0.4rem;border-radius:3px;font-size:0.62rem;text-transform:uppercase;letter-spacing:0.04em;">Compliant</span>'
            : '<span style="background:rgba(224,64,64,0.25);color:#e04040;padding:0.1rem 0.4rem;border-radius:3px;font-size:0.62rem;text-transform:uppercase;letter-spacing:0.04em;">Non-Compliant</span>';
        h += `<div class="nc-prop-detail"><span>Compliance</span><span class="value">${badge}</span></div>`;
    }

    // Historic designation
    h += `<div class="nc-prop-detail"><span>Protected</span><span class="value nc-popup-toggle" data-pi="${pi}" data-field="historic">${prop.historic ? '\u2705' : '\u274C'}</span></div>`;

    if (prop.last_surveyed) h += `<div class="nc-prop-detail"><span>Surveyed</span><span class="value">${fmtDate(prop.last_surveyed)}</span></div>`;
    const safeSaleLink = sanitizeUrl(prop.sale_link);
    if (safeSaleLink) h += `<div style="margin-top: 0.3rem;"><a href="${safeSaleLink}" target="_blank" rel="noopener" style="color: #a8d4a0; font-size: 0.8rem; text-decoration: none; border-bottom: 1px solid rgba(168,212,160,0.3);">View Listing</a></div>`;

    // Nearby Shops section
    const nearbyShops = ncFindNearbyShops(prop);
    const confirmedKeys = new Set(
        (prop._shopLinks || []).filter(l => !l.dismissed).map(l => `${l.shop_x},${l.shop_y},${l.shop_z}`)
    );
    const dismissedKeys = new Set(
        (prop._shopLinks || []).filter(l => l.dismissed).map(l => `${l.shop_x},${l.shop_y},${l.shop_z}`)
    );
    if (nearbyShops.length > 0) {
        const activeCount = nearbyShops.filter(s => !dismissedKeys.has(`${s.pos.x},${s.pos.y},${s.pos.z}`)).length;
        h += `<div class="nc-popup-shops-section">`;
        h += `<div class="nc-popup-shops-header"><span>Nearby Shops</span><span class="nc-popup-shops-count">${confirmedKeys.size} linked / ${activeCount} nearby</span></div>`;
        h += `<div class="nc-popup-shops-list">`;
        nearbyShops.forEach(shop => {
            const key = `${shop.pos.x},${shop.pos.y},${shop.pos.z}`;
            const isConfirmed = confirmedKeys.has(key);
            const isDismissed = dismissedKeys.has(key);
            if (isDismissed && !canEdit) return;
            const tradeCount = shop.exchanges.length;
            const stockedCount = shop.exchanges.filter(e => e.stock > 0).length;
            const distStr = Math.round(shop.dist);
            const stateClass = isConfirmed ? 'confirmed' : isDismissed ? 'dismissed' : 'suggested';
            // Build compact trade summary (input → output for each exchange)
            const tradeSummary = shop.exchanges.map(ex => {
                const inName = (typeof ncMatName === 'function' ? ncMatName(ex.input) : (ex.input?.customName || ex.input?.material || '?')).replace(/_/g, ' ');
                const outName = (typeof ncMatName === 'function' ? ncMatName(ex.output) : (ex.output?.customName || ex.output?.material || '?')).replace(/_/g, ' ');
                return `<span class="nc-shop-link-trade-detail">${ncEsc(inName)} &rarr; ${ncEsc(outName)}</span>`;
            }).join('');
            h += `<div class="nc-shop-link-row ${stateClass}" data-shop-key="${key}" data-pi="${pi}" data-shop-x="${shop.pos.x}" data-shop-y="${shop.pos.y}" data-shop-z="${shop.pos.z}">`;
            h += `<div class="nc-shop-link-info nc-shop-link-goto" title="View in Shop Explorer">`;
            h += `<div class="nc-shop-link-trades-col">${tradeSummary}<span class="nc-shop-link-trades">${tradeCount} trade${tradeCount !== 1 ? 's' : ''}</span></div>`;
            h += `<span class="nc-shop-link-stock">${stockedCount} in stock</span>`;
            h += `<span class="nc-shop-link-dist">${distStr}m</span>`;
            h += `<span class="nc-shop-link-coords">${shop.pos.x}, ${shop.pos.z}</span>`;
            h += `</div>`;
            if (canEdit && typeof ncShopMode !== 'undefined' && ncShopMode) {
                if (isConfirmed) {
                    h += `<button class="nc-shop-link-btn unlink" data-action="unlink" data-key="${key}" data-pi="${pi}">&#10005;</button>`;
                } else if (isDismissed) {
                    h += `<button class="nc-shop-link-btn restore" data-action="restore" data-key="${key}" data-pi="${pi}">&#8617;</button>`;
                } else {
                    h += `<button class="nc-shop-link-btn confirm" data-action="confirm" data-key="${key}" data-pi="${pi}">&#10003;</button>`;
                    h += `<button class="nc-shop-link-btn dismiss" data-action="dismiss" data-key="${key}" data-pi="${pi}">&#10005;</button>`;
                }
            }
            h += `</div>`;
        });
        h += `</div></div>`;
    }

    // Actions
    h += `<div class="nc-popup-actions">`;
    h += `<button class="nc-popup-edit-btn" onclick="ncEditPropertyInTable(${pi})">Edit in Table</button>`;
    if (ncCanEdit()) {
        h += `<button class="nc-popup-edit-btn nc-popup-txn-btn" data-pi="${pi}">Transaction Log</button>`;
        h += `<button class="nc-popup-edit-btn nc-popup-log-btn" data-pi="${pi}">Surveyor's Log</button>`;
        h += `<button class="nc-popup-edit-btn nc-popup-fine-btn" data-pi="${pi}">Fine Log</button>`;
    }
    h += `</div></div></div>`;
    return h;
}

function renderNCMarkers(properties) {
    ncMarkers.forEach(m => ncMap.removeLayer(m));
    ncMarkers = [];

    properties.forEach((prop, pi) => {
        if (prop.x == null || prop.z == null) return;

        const dotColor = NC_TYPE_COLORS[prop.type] || prop.color || '#888';
        const compliance = ncGetCompliance(prop);
        const markerBorder = prop.historic ? 'rgba(212,160,23,0.8)'
            : (compliance && !compliance.compliant) ? 'rgba(224,64,64,0.7)' : 'rgba(255,255,255,0.5)';
        const markerWeight = (prop.historic || (compliance && !compliance.compliant)) ? 2 : 1;
        const marker = L.circleMarker([-prop.z, prop.x], {
            radius: 6,
            fillColor: dotColor,
            color: markerBorder,
            weight: markerWeight,
            fillOpacity: 0.85
        }).addTo(ncMap);

        marker.bindTooltip(prop.name || 'Unnamed', {
            className: 'nc-tooltip',
            direction: 'top',
            offset: [0, -8],
            permanent: ncLabelsVisible
        });

        marker.bindPopup(buildPopupHTML(prop, (typeof ncSurveyMode !== 'undefined' ? ncSurveyMode : true) && ncCanEdit(), pi), { maxWidth: 580, minWidth: 440, autoPan: false, className: 'nc-leaflet-popup' });
        marker._ncData = prop;
        marker._ncIndex = pi;
        ncMarkers.push(marker);
    });
}

function ncToggleLabels() {
    ncLabelsVisible = !ncLabelsVisible;
    const btn = document.getElementById('ncLabelToggle');
    if (btn) {
        btn.textContent = ncLabelsVisible ? 'Hide Labels' : 'Show Labels';
        btn.classList.toggle('active', ncLabelsVisible);
    }
    ncMarkers.forEach(marker => {
        if (!ncMap.hasLayer(marker)) return;
        const name = marker._ncData?.name || 'Unnamed';
        marker.unbindTooltip();
        marker.bindTooltip(name, {
            className: 'nc-tooltip',
            direction: 'top',
            offset: [0, -8],
            permanent: ncLabelsVisible
        });
    });
}

document.getElementById('ncLabelToggle').addEventListener('click', ncToggleLabels);

let ncActiveMarker = null;

function renderNCPanel(properties) {
    const list = document.getElementById('ncPanelList');
    if (!list) return;
    const scrollLeft = list.scrollLeft;
    list.innerHTML = '';
    properties.forEach((prop, i) => {
        if (prop.x == null || prop.z == null) return;
        const card = document.createElement('div');
        card.className = 'nc-panel-card';
        card.dataset.index = i;
        const tc = NC_TYPE_COLORS[prop.type] || prop.color || '#888';
        const sc = NC_STATUS_COLORS[prop.status] || '';
        card.innerHTML = `
            <div class="nc-panel-card-top">
                <div class="nc-panel-card-name">${ncEsc(prop.name) || 'Unnamed'}</div>
                <span class="nc-panel-card-coords">${prop.x}, ${prop.z}</span>
            </div>
            <div class="nc-panel-card-mid">
                ${prop.type ? `<span class="nc-panel-card-type" style="background:${tc};">${ncEsc(prop.type)}</span>` : ''}
                ${prop.status ? `<span class="nc-panel-card-status" style="background:${sc};">${ncEsc(prop.status)}</span>` : ''}
            </div>
            <div class="nc-panel-card-bottom">
                <div class="nc-panel-card-addr">${ncEsc(prop.address)}</div>
                ${prop.owner ? `<span class="nc-panel-card-owner">${ncEsc(prop.owner)}</span>` : ''}
            </div>
        `;
        card.addEventListener('click', () => highlightNCProperty(i, card));
        list.appendChild(card);
    });
    list.scrollLeft = scrollLeft;
}

function highlightNCProperty(index, card) {
    // Clear previous highlight
    if (ncActiveMarker) {
        ncActiveMarker.setStyle({ radius: 6, weight: 1, color: 'rgba(255,255,255,0.5)' });
        ncActiveMarker.closePopup();
    }
    document.querySelectorAll('.nc-panel-card.active').forEach(c => c.classList.remove('active'));

    const marker = ncMarkers.find(m => m._ncIndex === index);
    if (!marker) return;

    // Highlight card
    card.classList.add('active');

    // Highlight marker
    marker.setStyle({ radius: 10, weight: 3, color: '#fff' });
    ncActiveMarker = marker;

    // Open popup — popupopen handler will pan to correct position
    ncMap.setZoom(Math.max(ncMap.getZoom(), 0));
    marker.openPopup();

    // Scroll card into view
    card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

// Edit property from map popup — opens table in edit mode and scrolls to row
function ncEditPropertyInTable(propIndex) {
    if (!ncCanEdit()) { alert('You must be logged in as admin or surveyor to edit.'); return; }
    // Close popup
    ncMap.closePopup();
    // Open table overlay
    const overlay = document.getElementById('ncTableOverlay');
    overlay.classList.add('open');
    // Enable edit mode
    ncEditMode = true;
    ncUpdateToolbar();
    renderNCTable(ncProperties, '');
    document.getElementById('ncTableSearch').value = '';
    // Scroll to the row after render
    setTimeout(() => {
        const row = document.querySelector(`#ncTableBody tr[data-prop-idx="${propIndex}"]`);
        if (row) {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.classList.add('nc-row-highlight');
            setTimeout(() => row.classList.remove('nc-row-highlight'), 2000);
        }
    }, 100);
}

// Carousel arrow buttons — cycle through visible cards
function ncCyclePanel(direction) {
    const visibleCards = Array.from(document.querySelectorAll('.nc-panel-card:not(.nc-clone)'))
        .filter(c => c.style.display !== 'none');
    if (visibleCards.length === 0) return;

    const activeIdx = visibleCards.findIndex(c => c.classList.contains('active'));
    let nextIdx;
    if (activeIdx === -1) {
        nextIdx = direction > 0 ? 0 : visibleCards.length - 1;
    } else {
        nextIdx = (activeIdx + direction + visibleCards.length) % visibleCards.length;
    }

    const card = visibleCards[nextIdx];
    const propIndex = parseInt(card.dataset.index);
    highlightNCProperty(propIndex, card);
}

document.getElementById('ncPanelLeft').addEventListener('click', () => ncCyclePanel(-1));
document.getElementById('ncPanelRight').addEventListener('click', () => ncCyclePanel(1));

// Carousel drag-to-scroll
(function () {
    const list = document.getElementById('ncPanelList');
    if (!list) return;
    let isDown = false, startX, scrollLeft;
    list.addEventListener('mousedown', (e) => {
        isDown = true;
        list.style.cursor = 'grabbing';
        startX = e.pageX - list.offsetLeft;
        scrollLeft = list.scrollLeft;
    });
    list.addEventListener('mouseleave', () => { isDown = false; list.style.cursor = ''; });
    list.addEventListener('mouseup', () => { isDown = false; list.style.cursor = ''; });
    list.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        e.preventDefault();
        const x = e.pageX - list.offsetLeft;
        list.scrollLeft = scrollLeft - (x - startX);
    });
})();

let ncFilterType = null;   // active type filter
let ncFilterStatus = null; // active status filter
let ncFilterUnoccupied = false; // show only unoccupied
let ncFilterNonCompliant = false; // show only non-compliant commercial
let ncFilterProtected = false;    // show only historically protected

function filterNCMarkers(query) {
    const q = query.toLowerCase().trim();
    let visible = 0;
    const visibleIndices = new Set();
    ncMarkers.forEach((marker, i) => {
        const p = marker._ncData;
        // Check type filter
        if (ncFilterType && p.type !== ncFilterType) {
            ncMap.removeLayer(marker);
            return;
        }
        // Check status filter
        if (ncFilterStatus && p.status !== ncFilterStatus) {
            ncMap.removeLayer(marker);
            return;
        }
        // Check unoccupied filter
        if (ncFilterUnoccupied && p.owner && p.owner.trim()) {
            ncMap.removeLayer(marker);
            return;
        }
        // Check non-compliant filter
        if (ncFilterNonCompliant) {
            const comp = ncGetCompliance(p);
            if (!comp || comp.compliant) { ncMap.removeLayer(marker); return; }
        }
        // Check protected filter
        if (ncFilterProtected && !p.historic) {
            ncMap.removeLayer(marker); return;
        }
        // Check text search
        const s = [p.name, p.owner, p.type, p.address, p.status].filter(Boolean).join(' ').toLowerCase();
        const match = !q || s.includes(q);
        if (match) {
            if (!ncMap.hasLayer(marker)) marker.addTo(ncMap);
            visibleIndices.add(String(marker._ncIndex));
            visible++;
        } else {
            ncMap.removeLayer(marker);
        }
    });
    // Remove infinite-scroll clones so only originals remain
    document.querySelectorAll('.nc-panel-card.nc-clone').forEach(c => c.remove());
    document.querySelectorAll('.nc-panel-card').forEach(card => {
        card.style.display = visibleIndices.has(card.dataset.index) ? '' : 'none';
    });
    const countEl = document.getElementById('ncPropsCount');
    const total = ncMarkers.length;
    if (countEl) countEl.textContent = (q || ncFilterType || ncFilterStatus || ncFilterUnoccupied || ncFilterNonCompliant) ? `${visible} of ${total} properties` : `${total} properties`;
}

function ncClearAllFilters() {
    ncFilterType = null;
    ncFilterStatus = null;
    ncFilterUnoccupied = false;
    ncFilterNonCompliant = false;
    ncFilterProtected = false;
    document.querySelectorAll('.nc-legend-item.active').forEach(el => el.classList.remove('active'));
    document.getElementById('ncSearchInput').value = '';
    const uf = document.getElementById('ncUnoccupiedFilter');
    if (uf) { uf.classList.remove('active'); uf.textContent = 'Hide Occupied'; }
    const cf = document.getElementById('ncComplianceFilter');
    if (cf) cf.classList.remove('active');
}

document.getElementById('ncSearchInput').addEventListener('input', (e) => {
    ncFilterType = null;
    ncFilterStatus = null;
    ncFilterUnoccupied = false;
    ncFilterNonCompliant = false;
    ncFilterProtected = false;
    document.querySelectorAll('.nc-legend-item.active').forEach(el => el.classList.remove('active'));
    const uf = document.getElementById('ncUnoccupiedFilter');
    if (uf) { uf.classList.remove('active'); uf.textContent = 'Hide Occupied'; }
    const cf = document.getElementById('ncComplianceFilter');
    if (cf) cf.classList.remove('active');
    filterNCMarkers(e.target.value);
});

// Type legend click-to-filter
document.querySelectorAll('.nc-legend-item[data-type]').forEach(item => {
    item.addEventListener('click', () => {
        const type = item.dataset.type;
        document.getElementById('ncSearchInput').value = '';
        // Clear status + unoccupied + compliance + protected filters
        ncFilterStatus = null;
        ncFilterUnoccupied = false;
        ncFilterNonCompliant = false;
        ncFilterProtected = false;
        document.querySelectorAll('#ncStatusLegend .nc-legend-item.active').forEach(el => el.classList.remove('active'));
        const uf = document.getElementById('ncUnoccupiedFilter');
        if (uf) { uf.classList.remove('active'); uf.textContent = 'Hide Occupied'; }
        const cf = document.getElementById('ncComplianceFilter');
        if (cf) cf.classList.remove('active');
        document.getElementById('ncProtectedFilter').classList.remove('active');
        if (ncFilterType === type) {
            ncFilterType = null;
            item.classList.remove('active');
        } else {
            ncFilterType = type;
            document.querySelectorAll('#ncLegend .nc-legend-item[data-type].active').forEach(el => el.classList.remove('active'));
            item.classList.add('active');
        }
        filterNCMarkers('');
    });
});

// Unoccupied filter
document.getElementById('ncUnoccupiedFilter').addEventListener('click', () => {
    const el = document.getElementById('ncUnoccupiedFilter');
    document.getElementById('ncSearchInput').value = '';
    // Clear type, status, compliance, and protected filters
    ncFilterType = null;
    ncFilterStatus = null;
    ncFilterNonCompliant = false;
    ncFilterProtected = false;
    document.querySelectorAll('#ncLegend .nc-legend-item[data-type].active').forEach(e => e.classList.remove('active'));
    document.querySelectorAll('#ncStatusLegend .nc-legend-item.active').forEach(e => e.classList.remove('active'));
    const cf = document.getElementById('ncComplianceFilter');
    if (cf) cf.classList.remove('active');
    document.getElementById('ncProtectedFilter').classList.remove('active');
    ncFilterUnoccupied = !ncFilterUnoccupied;
    el.classList.toggle('active', ncFilterUnoccupied);
    el.textContent = ncFilterUnoccupied ? 'Show Occupied' : 'Hide Occupied';
    filterNCMarkers('');
});

// Status legend click-to-filter
document.querySelectorAll('.nc-legend-item[data-status]').forEach(item => {
    item.addEventListener('click', () => {
        const status = item.dataset.status;
        document.getElementById('ncSearchInput').value = '';
        // Clear type + unoccupied + compliance + protected filters
        ncFilterType = null;
        ncFilterUnoccupied = false;
        ncFilterNonCompliant = false;
        ncFilterProtected = false;
        document.querySelectorAll('#ncLegend .nc-legend-item.active').forEach(el => el.classList.remove('active'));
        const uf = document.getElementById('ncUnoccupiedFilter');
        if (uf) { uf.classList.remove('active'); uf.textContent = 'Hide Occupied'; }
        const cf2 = document.getElementById('ncComplianceFilter');
        if (cf2) cf2.classList.remove('active');
        document.getElementById('ncProtectedFilter').classList.remove('active');
        if (ncFilterStatus === status) {
            ncFilterStatus = null;
            item.classList.remove('active');
        } else {
            ncFilterStatus = status;
            document.querySelectorAll('#ncStatusLegend .nc-legend-item.active').forEach(el => el.classList.remove('active'));
            item.classList.add('active');
        }
        filterNCMarkers('');
    });
});

// Non-compliant filter
document.getElementById('ncComplianceFilter').addEventListener('click', () => {
    const el = document.getElementById('ncComplianceFilter');
    document.getElementById('ncSearchInput').value = '';
    // Clear type, status, and unoccupied filters
    ncFilterType = null;
    ncFilterStatus = null;
    ncFilterUnoccupied = false;
    document.querySelectorAll('#ncLegend .nc-legend-item[data-type].active').forEach(e => e.classList.remove('active'));
    document.querySelectorAll('#ncStatusLegend .nc-legend-item[data-status].active').forEach(e => e.classList.remove('active'));
    const uf = document.getElementById('ncUnoccupiedFilter');
    if (uf) { uf.classList.remove('active'); uf.textContent = 'Hide Occupied'; }
    ncFilterNonCompliant = !ncFilterNonCompliant;
    ncFilterProtected = false;
    document.getElementById('ncProtectedFilter').classList.remove('active');
    el.classList.toggle('active', ncFilterNonCompliant);
    filterNCMarkers('');
});

// Protected (historic) filter
document.getElementById('ncProtectedFilter').addEventListener('click', () => {
    const el = document.getElementById('ncProtectedFilter');
    document.getElementById('ncSearchInput').value = '';
    ncFilterType = null;
    ncFilterStatus = null;
    ncFilterUnoccupied = false;
    ncFilterNonCompliant = false;
    document.querySelectorAll('#ncLegend .nc-legend-item[data-type].active').forEach(e => e.classList.remove('active'));
    document.querySelectorAll('#ncStatusLegend .nc-legend-item[data-status].active').forEach(e => e.classList.remove('active'));
    document.getElementById('ncComplianceFilter').classList.remove('active');
    const uf = document.getElementById('ncUnoccupiedFilter');
    if (uf) { uf.classList.remove('active'); uf.textContent = 'Hide Occupied'; }
    ncFilterProtected = !ncFilterProtected;
    el.classList.toggle('active', ncFilterProtected);
    filterNCMarkers('');
});

// Show All buttons
document.getElementById('ncTypeShowAll').addEventListener('click', () => {
    ncFilterType = null;
    ncFilterStatus = null;
    ncFilterUnoccupied = false;
    ncFilterNonCompliant = false;
    ncFilterProtected = false;
    document.getElementById('ncSearchInput').value = '';
    document.querySelectorAll('.nc-legend-item.active').forEach(el => el.classList.remove('active'));
    const uf1 = document.getElementById('ncUnoccupiedFilter');
    if (uf1) { uf1.classList.remove('active'); uf1.textContent = 'Hide Occupied'; }
    filterNCMarkers('');
});
document.getElementById('ncStatusShowAll').addEventListener('click', () => {
    ncFilterType = null;
    ncFilterStatus = null;
    ncFilterUnoccupied = false;
    ncFilterNonCompliant = false;
    ncFilterProtected = false;
    document.getElementById('ncSearchInput').value = '';
    document.querySelectorAll('.nc-legend-item.active').forEach(el => el.classList.remove('active'));
    const uf2 = document.getElementById('ncUnoccupiedFilter');
    if (uf2) { uf2.classList.remove('active'); uf2.textContent = 'Hide Occupied'; }
    filterNCMarkers('');
});
