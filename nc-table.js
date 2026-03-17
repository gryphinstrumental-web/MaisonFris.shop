
// Table view
let ncTableSort = { col: null, asc: true };
const NC_TABLE_COLS = ['name', 'address', 'owner', 'discord_contact', 'hs_account', 'trust_deposit', 'appraised_value', 'tenant', 'type', 'status', 'signage', 'shopchests', 'historic', 'last_surveyed', 'x', 'z'];
const NC_STATUS_COLORS = { 'Good Standing': '#4caf50', 'Warning': '#e6a817', 'Derelict': '#e04040' };
let ncDirtyRows = new Set(); // track modified property ids/indices for save
let ncVisibleCols = new Set(NC_TABLE_COLS); // all visible by default
let ncTableFilterType = null;   // active type filter for table
let ncTableFilterStatus = null; // active status filter for table

function renderNCTable(properties, filter = '') {
    const body = document.getElementById('ncTableBody');
    if (!body) return;
    body.innerHTML = '';
    const q = filter.toLowerCase().trim();

    // Build sortable list with original indices
    let rows = properties.map((prop, i) => ({ prop, i })).filter(r => r.prop.x != null && r.prop.z != null);

    // Filter by text
    if (q) {
        rows = rows.filter(r => {
            const p = r.prop;
            return [p.name, p.type, p.address, p.owner, p.tenant, p.discord_contact, p.appraised_value != null ? String(p.appraised_value) : '', p.status, p.last_surveyed, String(p.x), String(p.z)].filter(Boolean).join(' ').toLowerCase().includes(q);
        });
    }
    // Filter by occupancy
    if (ncOccupancyFilter === 'occupied') {
        rows = rows.filter(r => r.prop.owner && r.prop.owner.trim());
    } else if (ncOccupancyFilter === 'available') {
        rows = rows.filter(r => !r.prop.owner || !r.prop.owner.trim());
    }
    // Filter by type
    if (ncTableFilterType) {
        rows = rows.filter(r => r.prop.type === ncTableFilterType);
    }
    // Filter by status
    if (ncTableFilterStatus) {
        rows = rows.filter(r => r.prop.status === ncTableFilterStatus);
    }

    // Sort
    if (ncTableSort.col !== null) {
        const key = NC_TABLE_COLS[ncTableSort.col];
        rows.sort((a, b) => {
            let va = a.prop[key] ?? '', vb = b.prop[key] ?? '';
            if (typeof va === 'number' && typeof vb === 'number') return ncTableSort.asc ? va - vb : vb - va;
            va = String(va).toLowerCase(); vb = String(vb).toLowerCase();
            return ncTableSort.asc ? va.localeCompare(vb) : vb.localeCompare(va);
        });
    }

    // Rebuild header based on visible columns
    const thead = document.querySelector('#ncTable thead tr');
    if (thead) {
        thead.innerHTML = '';
        // Locate column first (far left)
        const locTh = document.createElement('th'); locTh.textContent = ''; thead.appendChild(locTh);
        const labels = { name: 'Name', address: 'Address', owner: 'Owner', tenant: 'Tenant', discord_contact: 'Discord', hs_account: 'Bank', trust_deposit: 'Trust', appraised_value: 'Value', type: 'Type', status: 'Status', signage: 'Signage', shopchests: 'Shopchests', historic: 'Protected', last_surveyed: 'Surveyed', x: 'X', z: 'Z' };
        NC_TABLE_COLS.forEach((col, ci) => {
            const th = document.createElement('th');
            if (!ncVisibleCols.has(col)) { th.style.display = 'none'; }

            // Type and Status columns get a filter dropdown
            if (col === 'type' || col === 'status') {
                const activeFilter = col === 'type' ? ncTableFilterType : ncTableFilterStatus;
                const sel = document.createElement('select');
                sel.className = 'nc-th-filter';
                sel.innerHTML = `<option value="">${labels[col]}</option>`;
                const values = col === 'type' ? Object.keys(NC_TYPE_COLORS) : Object.keys(NC_STATUS_COLORS);
                values.forEach(v => { sel.innerHTML += `<option value="${v}"${activeFilter === v ? ' selected' : ''}>${v}</option>`; });
                sel.addEventListener('change', () => {
                    if (col === 'type') ncTableFilterType = sel.value || null;
                    else ncTableFilterStatus = sel.value || null;
                    renderNCTable(ncProperties, document.getElementById('ncTableSearch').value);
                });
                sel.addEventListener('click', e => e.stopPropagation()); // don't trigger sort
                th.appendChild(sel);
                th.classList.toggle('sorted', ncTableSort.col === ci);
                const arrow = document.createElement('span');
                arrow.className = 'sort-arrow';
                arrow.textContent = ncTableSort.col === ci ? (ncTableSort.asc ? '\u25B2' : '\u25BC') : '\u25B4';
                th.appendChild(arrow);
                th.addEventListener('click', () => {
                    if (ncTableSort.col === ci) { ncTableSort.asc = !ncTableSort.asc; }
                    else { ncTableSort.col = ci; ncTableSort.asc = true; }
                    renderNCTable(ncProperties, document.getElementById('ncTableSearch').value);
                });
            } else {
                th.textContent = labels[col] || col;
                th.classList.toggle('sorted', ncTableSort.col === ci);
                const arrow = document.createElement('span');
                arrow.className = 'sort-arrow';
                arrow.textContent = ncTableSort.col === ci ? (ncTableSort.asc ? '\u25B2' : '\u25BC') : '\u25B4';
                th.appendChild(arrow);
                th.addEventListener('click', () => {
                    if (ncTableSort.col === ci) { ncTableSort.asc = !ncTableSort.asc; }
                    else { ncTableSort.col = ci; ncTableSort.asc = true; }
                    renderNCTable(ncProperties, document.getElementById('ncTableSearch').value);
                });
            }
            thead.appendChild(th);
        });
        // Image + txn + log + fine + compliance columns
        const imgTh = document.createElement('th'); imgTh.textContent = ''; thead.appendChild(imgTh);
        if (ncCanEdit()) {
            const txnTh = document.createElement('th'); txnTh.textContent = 'Txn'; thead.appendChild(txnTh);
            const logTh = document.createElement('th'); logTh.textContent = 'Log'; thead.appendChild(logTh);
            const fineTh = document.createElement('th'); fineTh.textContent = 'Fine'; thead.appendChild(fineTh);
        }
        const compTh = document.createElement('th'); compTh.textContent = 'Comp'; compTh.title = 'Compliance'; thead.appendChild(compTh);
    }

    rows.forEach(({ prop, i }) => {
        const tc = NC_TYPE_COLORS[prop.type] || prop.color || '#888';
        const tr = document.createElement('tr');
        tr.dataset.propIdx = i;
        const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
        const sc = NC_STATUS_COLORS[prop.status] || '#888';
        const vis = col => ncVisibleCols.has(col) ? '' : ' style="display:none"';
        const signIcon = prop.signage ? '\u2705' : '\u274C';
        const shopIcon = prop.shopchests ? '\u2705' : '\u274C';
        const histIcon = prop.historic ? '\u2705' : '\u274C';
        tr.innerHTML = `
            <td><button class="nc-table-locate" title="Show on map"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="10" r="3"/><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg></button></td>
            <td data-field="name"${vis('name')}>${ncEsc(prop.name) || 'Unnamed'}</td>
            <td data-field="address"${vis('address')}>${ncEsc(prop.address)}</td>
            <td data-field="owner"${vis('owner')}>${ncEsc(prop.owner)}</td>
            <td data-field="discord_contact"${vis('discord_contact')}>${ncEsc(prop.discord_contact)}</td>
            <td data-field="hs_account"${vis('hs_account')}>${ncEsc(prop.hs_account)}</td>
            <td data-field="trust_deposit"${vis('trust_deposit')}>${(prop.type === 'Commercial') ? ((prop.trust_deposit === -1) ? '<span style="color:var(--text-muted);font-style:italic;">Waived</span>' : `<span style="color:${(prop.trust_deposit ?? 0) >= 50 ? '#4caf50' : (prop.trust_deposit ?? 0) > 0 ? '#e6a817' : '#e04040'}">${prop.trust_deposit ?? 0}d</span>`) : '<span style="color:var(--text-muted);">—</span>'}</td>
            <td data-field="appraised_value"${vis('appraised_value')}>${prop.appraised_value != null ? prop.appraised_value : ''}</td>
            <td data-field="tenant"${vis('tenant')}>${ncEsc(prop.tenant)}</td>
            <td data-field="type"${vis('type')}>${prop.type ? `<span class="nc-table-type" style="background:${tc};">${ncEsc(prop.type)}</span>` : ''}</td>
            <td data-field="status"${vis('status')}>${prop.status ? `<span class="nc-status-badge" style="background:${sc};">${ncEsc(prop.status)}</span>` : ''}</td>
            <td data-field="signage"${vis('signage')}><span class="nc-binary-icon">${signIcon}</span></td>
            <td data-field="shopchests"${vis('shopchests')}><span class="nc-binary-icon">${shopIcon}</span></td>
            <td data-field="historic"${vis('historic')}><span class="nc-binary-icon">${histIcon}</span></td>
            <td data-field="last_surveyed"${vis('last_surveyed')}>${fmtDate(prop.last_surveyed)}</td>
            <td data-field="x"${vis('x')}>${prop.x}</td>
            <td data-field="z"${vis('z')}>${prop.z}</td>
            <td class="nc-img-cell">${prop.image_url ? '<span class="nc-has-img" title="Has image">&#x1f5bc;</span>' : '<span class="nc-no-img">—</span>'}</td>
            ${ncCanEdit() ? `<td><button class="nc-table-log nc-table-txn" data-prop-idx="${i}" title="Transaction Log">Txn</button></td>
            <td><button class="nc-table-log" data-prop-idx="${i}" title="Surveyor's Log">Log</button></td>
            <td><button class="nc-table-log nc-table-fine" data-prop-idx="${i}" title="Fine Log">Fine</button></td>` : ''}
            <td>${(() => { const c = ncGetCompliance(prop); return c ? (c.compliant ? '<span title="Compliant" style="color:#4caf50;">\u2705</span>' : '<span title="Non-Compliant (' + c.passed + '/' + c.total + ')" style="color:#e04040;">\u274C</span>') : '<span style="color:var(--text-muted);">—</span>'; })()}</td>
        `;

        // Locate button
        tr.querySelector('.nc-table-locate').addEventListener('click', (e) => {
            e.stopPropagation();
            document.getElementById('ncTableOverlay').classList.remove('open');
            const card = document.querySelectorAll('.nc-panel-card:not(.nc-clone)')[i];
            if (card) highlightNCProperty(i, card);
        });

        if (ncCanEdit()) {
            // Transaction Log button
            tr.querySelector('.nc-table-txn').addEventListener('click', (e) => {
                e.stopPropagation();
                ncShowTransactionLog(prop);
            });

            // Surveyor's Log button
            tr.querySelector('.nc-table-log:not(.nc-table-txn):not(.nc-table-fine)').addEventListener('click', (e) => {
                e.stopPropagation();
                ncShowSurveyorLog(prop);
            });

            // Fine Log button
            tr.querySelector('.nc-table-fine').addEventListener('click', (e) => {
                e.stopPropagation();
                ncShowFineLog(prop);
            });
        }

        // Click-to-expand for truncated text cells (owner, name, address)
        ['owner', 'name', 'address', 'tenant', 'discord_contact'].forEach(field => {
            const td = tr.querySelector(`td[data-field="${field}"]`);
            if (!td) return;
            td.style.cursor = 'pointer';
            td.addEventListener('click', (e) => {
                if (!ncEditMode) return; // only show popup in edit mode
                e.stopPropagation();
                ncShowCellPopup(td, prop, field, i);
            });
        });

        // Make cells editable when edit mode is on
        if (ncEditMode) {
            const markDirty = () => { ncHasUnsaved = true; ncDirtyRows.add(i); };
            tr.querySelectorAll('td[data-field]').forEach(td => {
                const field = td.dataset.field;
                // Type field gets a colored dropdown
                if (field === 'type') {
                    td.innerHTML = '';
                    const sel = document.createElement('select');
                    sel.className = 'nc-type-select';
                    Object.keys(NC_TYPE_COLORS).forEach(t => {
                        const opt = document.createElement('option');
                        opt.value = t; opt.textContent = t;
                        if (t === prop.type) opt.selected = true;
                        sel.appendChild(opt);
                    });
                    sel.style.backgroundColor = NC_TYPE_COLORS[prop.type] || '#888';
                    sel.addEventListener('change', () => {
                        sel.style.backgroundColor = NC_TYPE_COLORS[sel.value] || '#888';
                        if (prop.type !== sel.value) { prop.type = sel.value; markDirty(); }
                    });
                    td.appendChild(sel);
                    return;
                }
                // Status field gets colored dropdown
                if (field === 'status') {
                    td.innerHTML = '';
                    const sel = document.createElement('select');
                    sel.className = 'nc-status-select';
                    const emptyOpt = document.createElement('option');
                    emptyOpt.value = ''; emptyOpt.textContent = '—';
                    sel.appendChild(emptyOpt);
                    Object.keys(NC_STATUS_COLORS).forEach(s => {
                        const opt = document.createElement('option');
                        opt.value = s; opt.textContent = s;
                        if (s === prop.status) opt.selected = true;
                        sel.appendChild(opt);
                    });
                    sel.style.backgroundColor = NC_STATUS_COLORS[prop.status] || 'rgba(90,90,128,0.5)';
                    sel.addEventListener('change', () => {
                        sel.style.backgroundColor = NC_STATUS_COLORS[sel.value] || 'rgba(90,90,128,0.5)';
                        if (prop.status !== (sel.value || null)) { prop.status = sel.value || null; markDirty(); }
                    });
                    td.appendChild(sel);
                    return;
                }
                // Signage / Shopchests get toggle buttons
                if (field === 'signage' || field === 'shopchests' || field === 'historic') {
                    td.innerHTML = '';
                    td.style.textAlign = 'center';
                    const btn = document.createElement('button');
                    btn.className = 'nc-binary-toggle';
                    btn.textContent = prop[field] ? '\u2705' : '\u274C';
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        prop[field] = !prop[field];
                        btn.textContent = prop[field] ? '\u2705' : '\u274C';
                        markDirty();
                    });
                    td.appendChild(btn);
                    return;
                }
                // HS Account gets text input with placeholder
                if (field === 'hs_account') {
                    td.innerHTML = '';
                    const inp = document.createElement('input');
                    inp.type = 'text';
                    inp.className = 'nc-text-input';
                    inp.value = prop.hs_account || '';
                    inp.placeholder = 'HS-XXXX';
                    inp.addEventListener('change', () => {
                        prop.hs_account = inp.value.trim() || null;
                        markDirty();
                    });
                    td.appendChild(inp);
                    return;
                }
                // Date field gets date input
                if (field === 'last_surveyed') {
                    td.innerHTML = '';
                    const inp = document.createElement('input');
                    inp.type = 'date';
                    inp.className = 'nc-date-input';
                    inp.value = prop[field] ? prop[field].slice(0, 10) : '';
                    inp.addEventListener('change', () => {
                        prop[field] = inp.value || null;
                        markDirty();
                    });
                    td.appendChild(inp);
                    return;
                }
                // Trust deposit gets number input
                if (field === 'trust_deposit') {
                    td.innerHTML = '';
                    const inp = document.createElement('input');
                    inp.type = 'number';
                    inp.className = 'nc-num-input';
                    inp.value = prop.trust_deposit ?? '';
                    inp.placeholder = '0';
                    inp.addEventListener('change', () => {
                        prop.trust_deposit = inp.value ? Number(inp.value) : null;
                        markDirty();
                    });
                    td.appendChild(inp);
                    return;
                }
                // Appraised value gets number input
                if (field === 'appraised_value') {
                    td.innerHTML = '';
                    const inp = document.createElement('input');
                    inp.type = 'number';
                    inp.className = 'nc-num-input';
                    inp.value = prop.appraised_value ?? '';
                    inp.placeholder = '0';
                    inp.addEventListener('change', () => {
                        prop.appraised_value = inp.value ? Number(inp.value) : null;
                        markDirty();
                    });
                    td.appendChild(inp);
                    return;
                }
                td.contentEditable = 'true';
                td.addEventListener('blur', () => {
                    const val = td.textContent.trim();
                    const parsed = (field === 'x' || field === 'z') ? Number(val) : val;
                    if (prop[field] !== parsed) { prop[field] = parsed; markDirty(); }
                });
                td.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); td.blur(); }
                });
            });
            // Image cell — + to upload, x to remove
            const imgCell = tr.querySelector('.nc-img-cell');
            if (imgCell) {
                imgCell.innerHTML = '';
                if (prop.image_url) {
                    const rmBtn = document.createElement('button');
                    rmBtn.className = 'nc-img-action-btn nc-img-remove';
                    rmBtn.textContent = '\u00d7';
                    rmBtn.title = 'Remove image';
                    rmBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        prop.image_url = null;
                        markDirty();
                        renderNCTable(ncProperties, document.getElementById('ncTableSearch').value);
                    });
                    imgCell.appendChild(rmBtn);
                } else {
                    const addBtn = document.createElement('button');
                    addBtn.className = 'nc-img-action-btn nc-img-add';
                    addBtn.textContent = '+';
                    addBtn.title = 'Upload image';
                    addBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        ncShowImageUploadPopup(imgCell, prop, i, markDirty);
                    });
                    imgCell.appendChild(addBtn);
                }
            }
            // Row selection
            tr.classList.toggle('nc-row-selected', ncSelectedRow === i);
            tr.addEventListener('click', (e) => {
                if (e.target.closest('.nc-table-locate') || e.target.contentEditable === 'true' || e.target.tagName === 'SELECT') return;
                ncSelectedRow = (ncSelectedRow === i) ? null : i;
                body.querySelectorAll('tr').forEach(r => r.classList.remove('nc-row-selected'));
                if (ncSelectedRow === i) tr.classList.add('nc-row-selected');
            });
        }

        body.appendChild(tr);
    });
}

// (Sort handlers are now built dynamically inside renderNCTable)

// Image upload — shared helper
async function ncUploadImageFile(file, prop, idx, markDirty, statusEl) {
    if (statusEl) statusEl.textContent = 'Uploading...';
    try {
        const ext = file.name ? file.name.split('.').pop() : (file.type === 'image/png' ? 'png' : 'jpg');
        const fname = `prop_${prop.id || idx}_${Date.now()}.${ext}`;
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
        markDirty();
        document.querySelectorAll('.nc-img-upload-popup').forEach(p => p.remove());
        renderNCTable(ncProperties, document.getElementById('ncTableSearch').value);
    } catch (err) {
        console.error('Image upload failed:', err);
        if (statusEl) statusEl.textContent = 'Upload failed!';
    }
}

// Image upload popup — paste or browse
function ncShowImageUploadPopup(cell, prop, idx, markDirty) {
    document.querySelectorAll('.nc-img-upload-popup').forEach(p => p.remove());
    const overlay = document.getElementById('ncTableOverlay');
    const rect = cell.getBoundingClientRect();
    const oRect = overlay.getBoundingClientRect();

    const popup = document.createElement('div');
    popup.className = 'nc-img-upload-popup';
    popup.style.top = (rect.bottom - oRect.top + 4) + 'px';
    popup.style.right = (oRect.right - rect.right) + 'px';

    const pasteZone = document.createElement('div');
    pasteZone.className = 'nc-paste-zone';
    pasteZone.tabIndex = 0;
    pasteZone.textContent = 'Click here & paste (Ctrl+V)';

    const status = document.createElement('div');
    status.className = 'nc-img-upload-status';

    const browseBtn = document.createElement('button');
    browseBtn.className = 'nc-img-browse-btn';
    browseBtn.textContent = 'Browse File';
    browseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files[0];
            if (!file) return;
            await ncUploadImageFile(file, prop, idx, markDirty, status);
        });
        fileInput.click();
    });

    pasteZone.addEventListener('paste', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                    await ncUploadImageFile(file, prop, idx, markDirty, status);
                    return;
                }
            }
        }
        status.textContent = 'No image in clipboard';
    });

    popup.appendChild(pasteZone);
    popup.appendChild(browseBtn);
    popup.appendChild(status);
    overlay.appendChild(popup);

    // Auto-focus so paste works immediately
    pasteZone.focus();

    // Close on outside click
    setTimeout(() => {
        const closer = (ev) => {
            if (!popup.contains(ev.target)) {
                popup.remove();
                document.removeEventListener('mousedown', closer);
            }
        };
        document.addEventListener('mousedown', closer);
    }, 0);
}

// Cell expand popup — click truncated text to see full value + edit
function ncShowCellPopup(td, prop, field, idx) {
    // Remove any existing popup
    document.querySelectorAll('.nc-cell-popup').forEach(p => p.remove());

    const popup = document.createElement('div');
    popup.className = 'nc-cell-popup';

    const labels = { name: 'Name', owner: 'Owner', address: 'Address' };
    const label = document.createElement('div');
    label.className = 'nc-cell-popup-label';
    label.textContent = labels[field] || field;
    popup.appendChild(label);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'nc-cell-popup-input';
    input.value = prop[field] || '';
    popup.appendChild(input);

    const btns = document.createElement('div');
    btns.className = 'nc-cell-popup-btns';

    if (ncCanEdit()) {
        const saveBtn = document.createElement('button');
        saveBtn.className = 'nc-toolbar-btn primary';
        saveBtn.textContent = 'Save';
        saveBtn.style.fontSize = '0.6rem';
        saveBtn.style.padding = '0.25rem 0.5rem';
        saveBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const newVal = input.value.trim();
            if (newVal !== (prop[field] || '')) {
                prop[field] = newVal || null;
                try {
                    if (prop.id && field !== 'discord_contact') {
                        await supabaseUpdate('nc_properties', prop.id, { [field]: prop[field], updated_at: new Date().toISOString() });
                    }
                    td.textContent = newVal || '';
                } catch (err) {
                    console.error('Save failed:', err);
                    alert('Save failed: ' + err.message);
                }
            }
            popup.remove();
        });
        btns.appendChild(saveBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'nc-toolbar-btn';
    closeBtn.textContent = 'Close';
    closeBtn.style.fontSize = '0.6rem';
    closeBtn.style.padding = '0.25rem 0.5rem';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); popup.remove(); });
    btns.appendChild(closeBtn);
    popup.appendChild(btns);

    // Position near the cell
    const rect = td.getBoundingClientRect();
    const overlay = document.getElementById('ncTableOverlay');
    const overlayRect = overlay.getBoundingClientRect();
    popup.style.top = (rect.bottom - overlayRect.top + 4) + 'px';
    popup.style.left = Math.max(8, rect.left - overlayRect.left) + 'px';

    overlay.appendChild(popup);
    input.focus();
    input.select();

    if (!ncCanEdit()) input.readOnly = true;

    // Close on outside click
    const outsideHandler = (e) => {
        if (!popup.contains(e.target) && e.target !== td) {
            popup.remove();
            document.removeEventListener('click', outsideHandler);
        }
    };
    setTimeout(() => document.addEventListener('click', outsideHandler), 0);
}

// Table search
document.getElementById('ncTableSearch').addEventListener('input', (e) => {
    renderNCTable(ncProperties, e.target.value);
});

// Occupancy filter: 'all' | 'occupied' | 'available'
let ncOccupancyFilter = 'all';
document.getElementById('ncOccupancyBtn').addEventListener('click', () => {
    const btn = document.getElementById('ncOccupancyBtn');
    if (ncOccupancyFilter === 'all') { ncOccupancyFilter = 'occupied'; btn.textContent = 'Show Occupied'; }
    else if (ncOccupancyFilter === 'occupied') { ncOccupancyFilter = 'available'; btn.textContent = 'Show Available'; }
    else { ncOccupancyFilter = 'all'; btn.textContent = 'Show All'; }
    renderNCTable(ncProperties, document.getElementById('ncTableSearch').value);
});

document.getElementById('ncTableBtn').addEventListener('click', () => {
    const overlay = document.getElementById('ncTableOverlay');
    overlay.classList.add('open');
    ncUpdateToolbar();
    renderNCTable(ncProperties, document.getElementById('ncTableSearch').value);
});

// (ncTableClose handler is in toolbar section above)

// Infinite scroll on bottom panel
(function setupInfiniteScroll() {
    const list = document.getElementById('ncPanelList');
    if (!list) return;
    list.addEventListener('scroll', () => {
        const { scrollLeft, scrollWidth, clientWidth } = list;
        if (scrollLeft + clientWidth >= scrollWidth - 5) {
            // At the end — clone all original cards and append
            const origCards = list.querySelectorAll('.nc-panel-card:not(.nc-clone)');
            origCards.forEach(card => {
                const clone = card.cloneNode(true);
                clone.classList.add('nc-clone');
                const idx = parseInt(card.dataset.index);
                clone.dataset.index = idx;
                clone.addEventListener('click', () => highlightNCProperty(idx, clone));
                list.appendChild(clone);
            });
        }
        if (scrollLeft <= 0) {
            list.scrollLeft = 1;
        }
    });
})();

// ============================================
// NC Table Toolbar — Edit, Save, Add Row, Delete, CSV Export
// ============================================
let ncEditMode = false;
let ncHasUnsaved = false;
let ncSelectedRow = null; // index of selected property
let ncEditSnapshots = {}; // snapshots of property values before editing
let ncPendingAction = null; // callback if user discards unsaved changes

function ncCanEdit() {
    if (!currentUser) return false;
    return isAdmin || (userProfile && userProfile.is_surveyor);
}


// Column visibility toggle popup
document.getElementById('ncColToggleBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const popup = document.getElementById('ncColPopup');
    popup.classList.toggle('open');
    if (popup.classList.contains('open')) {
        popup.innerHTML = '';
        const labels = { name: 'Name', address: 'Address', owner: 'Owner', tenant: 'Tenant', discord_contact: 'Discord', appraised_value: 'Value', type: 'Type', status: 'Status', historic: 'Protected', last_surveyed: 'Surveyed', x: 'X', z: 'Z' };
        NC_TABLE_COLS.forEach(col => {
            const label = document.createElement('label');
            label.className = 'nc-col-option';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = ncVisibleCols.has(col);
            cb.addEventListener('change', () => {
                if (cb.checked) ncVisibleCols.add(col);
                else ncVisibleCols.delete(col);
                renderNCTable(ncProperties, document.getElementById('ncTableSearch').value);
            });
            label.appendChild(cb);
            label.appendChild(document.createTextNode(' ' + (labels[col] || col)));
            popup.appendChild(label);
        });
    }
});

// Close popup when clicking elsewhere
document.addEventListener('click', (e) => {
    const popup = document.getElementById('ncColPopup');
    if (popup && !popup.contains(e.target) && !e.target.closest('#ncColToggleBtn')) {
        popup.classList.remove('open');
    }
});

// Edit / Save toggle
document.getElementById('ncEditToggleBtn').addEventListener('click', async () => {
    if (!ncCanEdit()) return;
    if (ncEditMode) {
        // Save changes to Supabase
        const editBtn = document.getElementById('ncEditToggleBtn');
        editBtn.textContent = 'Saving...';
        editBtn.disabled = true;
        const logFields = ['name', 'address', 'owner', 'tenant', 'discord_contact', 'appraised_value', 'trust_deposit', 'type', 'status', 'signage', 'shopchests', 'historic', 'hs_account', 'last_surveyed', 'x', 'z', 'image_url'];
        try {
            for (const idx of ncDirtyRows) {
                const prop = ncProperties[idx];
                if (!prop) continue;
                const row = {
                    name: prop.name || null, type: prop.type || null, address: prop.address || null,
                    owner: prop.owner || null, tenant: prop.tenant || null,
                    discord_contact: prop.discord_contact || null,
                    x: prop.x, z: prop.z, color: prop.color || null,
                    sale_link: prop.sale_link || null, appraised_value: prop.appraised_value || null,
                    status: prop.status || null, last_surveyed: prop.last_surveyed || null,
                    signage: prop.signage || false, shopchests: prop.shopchests || false, historic: prop.historic || false,
                    hs_account: prop.hs_account || null, trust_deposit: prop.trust_deposit ?? 0,
                    image_url: prop.image_url || null, updated_at: new Date().toISOString()
                };
                const isNew = !prop.id;
                if (prop.id) {
                    await supabaseUpdate('nc_properties', prop.id, row);
                } else {
                    const result = await supabaseInsert('nc_properties', row);
                    if (result?.[0]?.id) prop.id = result[0].id;
                }
                // Log changes
                if (isNew && prop.id) {
                    ncLogChange(prop.id, '_created', null, new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
                } else if (prop.id && ncEditSnapshots[idx]) {
                    const snap = ncEditSnapshots[idx];
                    const changes = [];
                    logFields.forEach(f => {
                        const oldV = snap[f] ?? null;
                        const newV = prop[f] ?? null;
                        if (String(oldV || '') !== String(newV || '')) {
                            changes.push({ field: f, oldVal: oldV, newVal: newV });
                        }
                    });
                    if (changes.length > 0) ncLogMultipleChanges(prop.id, changes);
                }
            }
            ncHasUnsaved = false;
            ncDirtyRows.clear();
            ncEditSnapshots = {};
            ncEditMode = false;
            ncSelectedRow = null;
            // Refresh markers and panel with saved data
            ncRefreshAll();
        } catch (err) {
            console.error('Save failed:', err);
            alert('Save failed: ' + err.message);
        }
        editBtn.disabled = false;
        ncUpdateToolbar();
        renderNCTable(ncProperties, document.getElementById('ncTableSearch').value);
    } else {
        ncDirtyRows.clear();
        // Snapshot current property values for change tracking
        ncEditSnapshots = {};
        ncProperties.forEach((prop, idx) => {
            if (prop.id) {
                ncEditSnapshots[idx] = { ...prop };
            }
        });
        ncEditMode = true;
        ncUpdateToolbar();
        renderNCTable(ncProperties, document.getElementById('ncTableSearch').value);
    }
});

// Add Row
document.getElementById('ncAddRowBtn').addEventListener('click', () => {
    if (!ncEditMode) return;
    ncProperties.push({ name: 'New Property', type: 'Residential', address: '', owner: '', tenant: null, discord_contact: null, x: 0, z: 0, color: '#888',
        appraised_value: null, status: 'Good Standing', last_surveyed: null, image_url: null, trust_deposit: 0 });
    ncHasUnsaved = true;
    ncDirtyRows.add(ncProperties.length - 1);
    renderNCTable(ncProperties, document.getElementById('ncTableSearch').value);
    // Scroll table to bottom
    const wrap = document.querySelector('.nc-table-wrap');
    if (wrap) setTimeout(() => wrap.scrollTop = wrap.scrollHeight, 50);
});

// Delete selected row
document.getElementById('ncDeleteRowBtn').addEventListener('click', async () => {
    if (!ncEditMode || ncSelectedRow === null) return;
    const prop = ncProperties[ncSelectedRow];
    if (prop?.id) {
        try { await supabaseDelete('nc_properties', prop.id); }
        catch (err) { console.error('Delete failed:', err); alert('Delete failed: ' + err.message); return; }
    }
    ncProperties.splice(ncSelectedRow, 1);
    ncSelectedRow = null;
    ncHasUnsaved = true;
    renderNCTable(ncProperties, document.getElementById('ncTableSearch').value);
});

// Export CSV
document.getElementById('ncExportBtn').addEventListener('click', () => {
    const headers = ['Name', 'Address', 'Owner', 'Tenant', 'Discord Contact', 'Bank', 'Trust Deposit', 'Appraised Value', 'Type', 'Status', 'Signage', 'Shopchests', 'Last Surveyed', 'X', 'Z', 'Image URL'];
    const csvRows = [headers.join(',')];
    ncProperties.forEach(p => {
        csvRows.push([p.name, p.address, p.owner, p.tenant, p.discord_contact, p.hs_account, p.trust_deposit, p.appraised_value, p.type, p.status, p.signage, p.shopchests, p.last_surveyed, p.x, p.z, p.image_url].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
    });
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'new-callisto-properties.csv';
    a.click();
    URL.revokeObjectURL(a.href);
});

// Unsaved changes guard — table close button
document.getElementById('ncTableClose').addEventListener('click', () => {
    if (ncEditMode && ncHasUnsaved) {
        ncPendingAction = () => {
            ncEditMode = false;
            ncHasUnsaved = false;
            ncSelectedRow = null;
            ncTableFilterType = null;
            ncTableFilterStatus = null;
            ncUpdateToolbar();
            document.getElementById('ncTableOverlay').classList.remove('open');
        };
        document.getElementById('ncUnsavedModal').classList.add('open');
    } else {
        if (ncEditMode) {
            ncEditMode = false;
            ncSelectedRow = null;
            ncUpdateToolbar();
        }
        ncTableFilterType = null;
        ncTableFilterStatus = null;
        document.getElementById('ncTableOverlay').classList.remove('open');
    }
});

// Unsaved changes guard — page navigation
const _origNavigateTo = navigateTo;
navigateTo = function(path) {
    if (ncEditMode && ncHasUnsaved) {
        ncPendingAction = () => {
            ncEditMode = false;
            ncHasUnsaved = false;
            ncSelectedRow = null;
            ncUpdateToolbar();
            document.getElementById('ncTableOverlay').classList.remove('open');
            _origNavigateTo(path);
        };
        document.getElementById('ncUnsavedModal').classList.add('open');
        return;
    }
    _origNavigateTo(path);
};

// Unsaved changes guard — browser beforeunload
window.addEventListener('beforeunload', (e) => {
    if (ncEditMode && ncHasUnsaved) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// Modal buttons
document.getElementById('ncUnsavedDiscard').addEventListener('click', () => {
    document.getElementById('ncUnsavedModal').classList.remove('open');
    if (ncPendingAction) { ncPendingAction(); ncPendingAction = null; }
});
document.getElementById('ncUnsavedCancel').addEventListener('click', () => {
    document.getElementById('ncUnsavedModal').classList.remove('open');
    ncPendingAction = null;
});

