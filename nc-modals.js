// ============================================
// Surveyor's Log — change tracking
// ============================================
// Auto-set last_surveyed to today when a change is logged
async function ncTouchSurveyed(propertyId) {
    const today = new Date().toISOString().slice(0, 10);
    try {
        await fetch(`${CONFIG.supabaseUrl}/rest/v1/nc_properties?id=eq.${propertyId}`, {
            method: 'PATCH', headers: restHeaders(),
            body: JSON.stringify({ last_surveyed: today })
        });
        // Update local data
        const prop = ncProperties.find(p => p.id === propertyId);
        if (prop) prop.last_surveyed = today;
    } catch (e) { console.error('Touch surveyed failed:', e); }
}

async function ncLogChange(propertyId, field, oldVal, newVal) {
    if (!currentUser || !propertyId) return;
    try {
        await supabaseInsert('nc_property_log', {
            property_id: propertyId,
            field_changed: field,
            old_value: oldVal != null ? String(oldVal) : null,
            new_value: newVal != null ? String(newVal) : null,
            changed_by: currentUser.id,
            changed_by_name: userProfile?.discord_username || currentUser.user_metadata?.full_name || 'Unknown'
        });
        ncTouchSurveyed(propertyId);
    } catch (e) { console.error('Log entry failed:', e); }
}

async function ncLogMultipleChanges(propertyId, changes) {
    if (!currentUser || !propertyId || changes.length === 0) return;
    const rows = changes.map(c => ({
        property_id: propertyId,
        field_changed: c.field,
        old_value: c.oldVal != null ? String(c.oldVal) : null,
        new_value: c.newVal != null ? String(c.newVal) : null,
        changed_by: currentUser.id,
        changed_by_name: userProfile?.discord_username || currentUser.user_metadata?.full_name || 'Unknown'
    }));
    try {
        await fetch(`${CONFIG.supabaseUrl}/rest/v1/nc_property_log`, {
            method: 'POST', headers: restHeaders(), body: JSON.stringify(rows)
        });
        ncTouchSurveyed(propertyId);
    } catch (e) { console.error('Batch log failed:', e); }
}

let ncLogCurrentProp = null;
let ncEditingLogId = null;

async function ncShowSurveyorLog(prop) {
    if (!prop?.id) { alert('Property must be saved first.'); return; }
    ncLogCurrentProp = prop;
    ncEditingLogId = null;
    const modal = document.getElementById('ncLogModal');
    const body = document.getElementById('ncLogBody');
    const title = document.getElementById('ncLogTitle');
    const noteForm = document.getElementById('ncLogNoteForm');
    title.textContent = `Surveyor's Log — ${prop.name || 'Unnamed'}`;

    // Show note form for admin/surveyor
    if (ncCanEdit()) {
        noteForm.classList.add('open');
        document.getElementById('ncLogNoteInput').value = '';
        document.getElementById('ncLogNoteSaveBtn').textContent = 'Add Note';
    } else {
        noteForm.classList.remove('open');
    }

    body.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:1rem;">Loading...</div>';
    modal.classList.add('open');
    try {
        const logs = await supabaseRest('nc_property_log', `select=*&property_id=eq.${prop.id}&order=changed_at.desc`);
        if (!logs || logs.length === 0) {
            body.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:1rem;">No log entries yet.</div>';
            return;
        }
        body.innerHTML = '';
        const canEdit = ncCanEdit();
        const fieldLabels = { name: 'Name', address: 'Address', owner: 'Owner', tenant: 'Tenant', type: 'Type', status: 'Status',
            appraised_value: 'Value', last_surveyed: 'Surveyed', x: 'X', z: 'Z', image_url: 'Image',
            discord_contact: 'Discord', sale_link: 'Sale Link', _created: 'Created' };
        logs.forEach(log => {
            const row = document.createElement('div');
            row.className = 'nc-log-entry';
            const date = new Date(log.changed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const field = fieldLabels[log.field_changed] || log.field_changed;
            let desc;
            if (log.field_changed === '_created') {
                desc = `Property created`;
            } else if (log.field_changed === '_note') {
                desc = `<em style="color:var(--text);">${ncEsc(log.new_value)}</em>`;
            } else {
                desc = `<strong>${ncEsc(field)}</strong> changed`;
                if (log.old_value) desc += ` from <span class="nc-log-old">${ncEsc(log.old_value)}</span>`;
                desc += ` to <span class="nc-log-new">${ncEsc(log.new_value) || '(empty)'}</span>`;
            }
            let actions = '';
            if (canEdit) {
                actions = `<span class="nc-log-actions">`;
                if (log.field_changed === '_note') {
                    actions += `<button class="nc-log-edit-btn" data-log-id="${log.id}" data-note-value="${(log.new_value || '').replace(/"/g, '&quot;')}" title="Edit note"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`;
                }
                actions += `<button class="nc-log-del-btn" data-log-id="${log.id}" title="Delete entry"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>`;
                actions += `</span>`;
            }
            row.innerHTML = `
                <div class="nc-log-meta">
                    <span class="nc-log-date">${date}</span>
                    ${actions}
                    <span class="nc-log-user">${ncEsc(log.changed_by_name) || 'Unknown'}</span>
                </div>
                <div class="nc-log-desc">${desc}</div>
            `;
            body.appendChild(row);
        });

        // Edit/delete handlers are attached once via _ncLogDelegation below
    } catch (e) {
        console.error('Failed to load log:', e);
        body.innerHTML = '<div style="text-align:center;color:#d4a0a0;padding:1rem;">Failed to load log.</div>';
    }
}

// One-time delegation for surveyor log edit/delete buttons
document.getElementById('ncLogBody').addEventListener('click', async (e) => {
    if (!ncCanEdit()) return;
    const editBtn = e.target.closest('.nc-log-edit-btn');
    const delBtn = e.target.closest('.nc-log-del-btn');
    if (editBtn) {
        document.getElementById('ncLogNoteInput').value = editBtn.dataset.noteValue || '';
        ncEditingLogId = editBtn.dataset.logId;
        document.getElementById('ncLogNoteSaveBtn').textContent = 'Update Note';
        document.getElementById('ncLogNoteInput').focus();
    } else if (delBtn) {
        if (!confirm('Delete this log entry?')) return;
        try {
            await supabaseDelete('nc_property_log', delBtn.dataset.logId);
            await ncShowSurveyorLog(ncLogCurrentProp);
        } catch (e2) {
            console.error('Delete log entry failed:', e2);
            alert('Failed to delete: ' + e2.message);
        }
    }
});

// Save surveyor's note (insert new or update existing)
document.getElementById('ncLogNoteSaveBtn').addEventListener('click', async () => {
    const prop = ncLogCurrentProp;
    if (!prop?.id) return;
    const noteInput = document.getElementById('ncLogNoteInput');
    const note = noteInput.value.trim();
    if (!note) { alert('Please enter a note.'); return; }
    const btn = document.getElementById('ncLogNoteSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
        if (ncEditingLogId) {
            await supabaseUpdate('nc_property_log', ncEditingLogId, { new_value: note });
            ncEditingLogId = null;
        } else {
            await supabaseInsert('nc_property_log', {
                property_id: prop.id,
                field_changed: '_note',
                old_value: null,
                new_value: note,
                changed_by: currentUser?.id || null,
                changed_by_name: userProfile?.discord_username || currentUser?.user_metadata?.full_name || 'Unknown'
            });
            ncTouchSurveyed(prop.id);
        }
        await ncShowSurveyorLog(prop);
    } catch (e) {
        console.error('Save note failed:', e);
        alert('Failed to save note: ' + e.message);
    }
    btn.disabled = false;
    btn.textContent = 'Add Note';
});

// Re-open a property's map popup by reference
function ncReopenPopup(prop) {
    if (!prop) return;
    const pi = ncProperties.indexOf(prop);
    if (pi >= 0 && ncMarkers[pi]) {
        ncMarkers[pi].openPopup();
    }
}

// Close log modal → return to popup
document.getElementById('ncLogClose').addEventListener('click', () => {
    document.getElementById('ncLogModal').classList.remove('open');
    ncReopenPopup(ncLogCurrentProp);
});
document.getElementById('ncLogModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
        e.currentTarget.classList.remove('open');
        ncReopenPopup(ncLogCurrentProp);
    }
});

// ============================================
// Transaction Log
// ============================================
let ncTxnCurrentProp = null;
let ncEditingTxnId = null;

async function ncShowTransactionLog(prop) {
    if (!prop?.id) { alert('Property must be saved first.'); return; }
    ncTxnCurrentProp = prop;
    ncEditingTxnId = null;
    const modal = document.getElementById('ncTxnModal');
    const body = document.getElementById('ncTxnBody');
    const title = document.getElementById('ncTxnTitle');
    const form = document.getElementById('ncTxnForm');
    const saveBtn = document.getElementById('ncTxnSaveBtn');
    saveBtn.textContent = 'Record Transaction';
    title.textContent = `Transactions — ${prop.name || 'Unnamed'}`;

    // Show form only for admin/surveyor
    if (ncCanEdit()) {
        form.classList.add('open');
        document.getElementById('ncTxnSeller').value = prop.owner || '';
        document.getElementById('ncTxnBuyer').value = '';
        document.getElementById('ncTxnBroker').value = 'New Callisto City Government';
        document.getElementById('ncTxnAmount').value = '';
        document.getElementById('ncTxnDate').value = new Date().toISOString().slice(0, 10);
        document.getElementById('ncTxnRename').value = '';
        document.getElementById('ncTxnNotes').value = '';
    } else {
        form.classList.remove('open');
    }

    body.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:1rem;">Loading...</div>';
    modal.classList.add('open');

    try {
        const txns = await supabaseRest('nc_transactions', `select=*&property_id=eq.${prop.id}&order=transaction_date.desc,created_at.desc`);
        if (!txns || txns.length === 0) {
            body.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:1rem;">No transactions recorded.</div>';
            return;
        }
        body.innerHTML = '';
        const canEdit = ncCanEdit();
        txns.forEach(txn => {
            const el = document.createElement('div');
            el.className = 'nc-txn-entry';
            const date = txn.transaction_date ? new Date(txn.transaction_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
            let html = `<div class="nc-log-meta"><span class="nc-log-date">${date}</span><span class="nc-log-user">${ncEsc(txn.recorded_by_name) || 'Unknown'}</span></div>`;
            html += `<div class="nc-txn-detail"><span class="lbl">Seller</span> ${ncEsc(txn.seller) || '—'}</div>`;
            html += `<div class="nc-txn-detail"><span class="lbl">Buyer</span> ${ncEsc(txn.buyer) || '—'}</div>`;
            html += `<div class="nc-txn-detail"><span class="lbl">Broker</span> ${ncEsc(txn.broker) || '—'}</div>`;
            html += `<div class="nc-txn-detail"><span class="lbl">Amount</span> <span class="nc-txn-amount">${txn.amount != null ? ncEsc(txn.amount) + 'd' : '—'}</span></div>`;
            if (txn.new_name) html += `<div class="nc-txn-detail"><span class="lbl">Renamed</span> ${ncEsc(txn.new_name)}</div>`;
            if (txn.notes) html += `<div class="nc-txn-notes">${ncEsc(txn.notes)}</div>`;
            if (canEdit) {
                html += `<div class="nc-txn-actions">`;
                html += `<button class="nc-txn-edit-btn" data-txn-id="${txn.id}">Edit</button>`;
                html += `<button class="nc-txn-del-btn" data-txn-id="${txn.id}">Delete</button>`;
                html += `</div>`;
            }
            el.innerHTML = html;
            body.appendChild(el);
        });

        // Attach edit/delete handlers
        if (canEdit) {
            body.querySelectorAll('.nc-txn-edit-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const txnId = btn.dataset.txnId;
                    const txn = txns.find(t => t.id === txnId);
                    if (!txn) return;
                    // Fill form with existing values for editing
                    document.getElementById('ncTxnSeller').value = txn.seller || '';
                    document.getElementById('ncTxnBuyer').value = txn.buyer || '';
                    document.getElementById('ncTxnBroker').value = txn.broker || '';
                    document.getElementById('ncTxnAmount').value = txn.amount != null ? txn.amount : '';
                    document.getElementById('ncTxnDate').value = txn.transaction_date || '';
                    document.getElementById('ncTxnRename').value = txn.new_name || '';
                    document.getElementById('ncTxnNotes').value = txn.notes || '';
                    // Set editing mode — save button will update instead of insert
                    ncEditingTxnId = txnId;
                    const saveBtn = document.getElementById('ncTxnSaveBtn');
                    saveBtn.textContent = 'Update Transaction';
                    form.classList.add('open');
                });
            });
            body.querySelectorAll('.nc-txn-del-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const txnId = btn.dataset.txnId;
                    if (!confirm('Delete this transaction entry?')) return;
                    try {
                        await supabaseDelete('nc_transactions', txnId);
                        await ncShowTransactionLog(prop);
                    } catch (e) {
                        console.error('Delete transaction failed:', e);
                        alert('Failed to delete: ' + e.message);
                    }
                });
            });
        }
    } catch (e) {
        console.error('Failed to load transactions:', e);
        body.innerHTML = '<div style="text-align:center;color:#d4a0a0;padding:1rem;">Failed to load transactions.</div>';
    }
}

document.getElementById('ncTxnSaveBtn').addEventListener('click', async () => {
    const prop = ncTxnCurrentProp;
    if (!prop?.id) return;
    const seller = document.getElementById('ncTxnSeller').value.trim();
    const buyer = document.getElementById('ncTxnBuyer').value.trim();
    const broker = document.getElementById('ncTxnBroker').value.trim();
    const amountStr = document.getElementById('ncTxnAmount').value.trim();
    const txnDate = document.getElementById('ncTxnDate').value;
    const rename = document.getElementById('ncTxnRename').value.trim();
    const notes = document.getElementById('ncTxnNotes').value.trim();

    if (!amountStr) { alert('Amount is required.'); return; }
    if (!buyer) { alert('Buyer is required.'); return; }
    const amount = Number(amountStr);

    const btn = document.getElementById('ncTxnSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        const txnData = {
            property_id: prop.id,
            seller: seller || null,
            buyer: buyer,
            broker: broker || null,
            amount: amount,
            new_name: rename || null,
            notes: notes || null,
            transaction_date: txnDate || new Date().toISOString().slice(0, 10),
            recorded_by: currentUser?.id || null,
            recorded_by_name: userProfile?.discord_username || currentUser?.user_metadata?.full_name || 'Unknown'
        };

        if (ncEditingTxnId) {
            // Update existing transaction
            await supabaseUpdate('nc_transactions', ncEditingTxnId, txnData);
            ncEditingTxnId = null;
        } else {
            // Insert new transaction
            await supabaseInsert('nc_transactions', txnData);
        }

        // Update property: value, owner (buyer becomes new owner), optionally name
        const updates = { appraised_value: amount, owner: buyer, updated_at: new Date().toISOString() };
        if (rename) updates.name = rename;

        await fetch(`${CONFIG.supabaseUrl}/rest/v1/nc_properties?id=eq.${prop.id}`, {
            method: 'PATCH', headers: restHeaders(), body: JSON.stringify(updates)
        });

        // Log the changes in surveyor's log too
        const changes = [];
        if (prop.owner !== buyer) changes.push({ field: 'owner', oldVal: prop.owner, newVal: buyer });
        if (prop.appraised_value !== amount) changes.push({ field: 'appraised_value', oldVal: prop.appraised_value, newVal: amount });
        if (rename && rename !== prop.name) changes.push({ field: 'name', oldVal: prop.name, newVal: rename });
        if (changes.length > 0) ncLogMultipleChanges(prop.id, changes);

        // Update local data
        prop.owner = buyer;
        prop.appraised_value = amount;
        if (rename) prop.name = rename;

        // Refresh UI
        ncRefreshAll();

        // Reload the transaction list
        await ncShowTransactionLog(prop);
    } catch (e) {
        console.error('Save transaction failed:', e);
        alert('Failed to save transaction: ' + e.message);
    }
    btn.disabled = false;
    btn.textContent = 'Record Transaction';
});

// Close transaction modal
document.getElementById('ncTxnClose').addEventListener('click', () => {
    document.getElementById('ncTxnModal').classList.remove('open');
    ncReopenPopup(ncTxnCurrentProp);
});
document.getElementById('ncTxnModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
        e.currentTarget.classList.remove('open');
        ncReopenPopup(ncTxnCurrentProp);
    }
});

// ============================================
// Fine Log
// ============================================
let ncFineCurrentProp = null;
let ncEditingFineId = null;

async function ncShowFineLog(prop) {
    if (!prop?.id) { alert('Property must be saved first.'); return; }
    ncFineCurrentProp = prop;
    ncEditingFineId = null;
    const modal = document.getElementById('ncFineModal');
    const body = document.getElementById('ncFineBody');
    const title = document.getElementById('ncFineTitle');
    const form = document.getElementById('ncFineForm');
    const saveBtn = document.getElementById('ncFineSaveBtn');
    saveBtn.textContent = 'Apply Fine';
    title.textContent = `Fines — ${prop.name || 'Unnamed'}`;

    if (ncCanEdit()) {
        form.classList.add('open');
        document.getElementById('ncFineAmount').value = '';
        document.getElementById('ncFineReason').value = '';
        document.getElementById('ncFineReporter').value = '';
        document.getElementById('ncFineNotes').value = '';
        document.querySelectorAll('.nc-fine-preset-btn').forEach(b => b.classList.remove('active'));
    } else {
        form.classList.remove('open');
    }

    body.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:1rem;">Loading...</div>';
    modal.classList.add('open');

    try {
        const fines = await supabaseRest('nc_fines', `select=*&property_id=eq.${prop.id}&order=issued_at.desc`);
        if (!fines || fines.length === 0) {
            body.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:1rem;">No fines recorded.</div>';
            return;
        }
        body.innerHTML = '';
        const canEdit = ncCanEdit();
        fines.forEach(fine => {
            const el = document.createElement('div');
            el.className = 'nc-txn-entry';
            const date = fine.issued_at ? new Date(fine.issued_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
            const statusClass = fine.status || 'pending';
            let html = `<div class="nc-log-meta"><span class="nc-log-date">${date}</span> <span class="nc-fine-status ${ncEsc(statusClass)}">${ncEsc(fine.status) || 'pending'}</span><span class="nc-log-user">${ncEsc(fine.issued_by_name)}</span></div>`;
            html += `<div class="nc-txn-detail"><span class="lbl">Amount</span> <span style="color:#d4a0a0;font-weight:500;">${ncEsc(fine.amount)}d</span></div>`;
            if (fine.reason) html += `<div class="nc-txn-detail"><span class="lbl">Reason</span> ${ncEsc(fine.reason)}</div>`;
            if (fine.reporter) {
                html += `<div class="nc-txn-detail"><span class="lbl">Reporter</span> ${ncEsc(fine.reporter)}</div>`;
                if (fine.bounty_amount) html += `<div class="nc-fine-bounty">Bounty: ${ncEsc(fine.bounty_amount)}d</div>`;
            }
            if (fine.notes) html += `<div class="nc-txn-notes">${ncEsc(fine.notes)}</div>`;
            if (canEdit) {
                html += `<div class="nc-txn-actions">`;
                html += `<button class="nc-txn-edit-btn nc-fine-edit" data-fine-id="${fine.id}">Edit</button>`;
                if (fine.status === 'pending') {
                    html += `<button class="nc-txn-edit-btn nc-fine-waive" data-fine-id="${fine.id}" style="background:rgba(184,180,204,0.15);border-color:rgba(184,180,204,0.3);">Waive</button>`;
                }
                html += `<button class="nc-txn-del-btn nc-fine-del" data-fine-id="${fine.id}">Delete</button>`;
                html += `</div>`;
            }
            el.innerHTML = html;
            body.appendChild(el);
        });

        // Attach event handlers
        if (canEdit) {
            body.querySelectorAll('.nc-fine-edit').forEach(btn => {
                btn.addEventListener('click', () => {
                    const fine = fines.find(f => f.id === btn.dataset.fineId);
                    if (!fine) return;
                    document.getElementById('ncFineAmount').value = fine.amount || '';
                    document.getElementById('ncFineReason').value = fine.reason || '';
                    document.getElementById('ncFineReporter').value = fine.reporter || '';
                    document.getElementById('ncFineNotes').value = fine.notes || '';
                    ncEditingFineId = fine.id;
                    saveBtn.textContent = 'Update Fine';
                    form.classList.add('open');
                });
            });
            body.querySelectorAll('.nc-fine-del').forEach(btn => {
                btn.addEventListener('click', async () => {
                    if (!confirm('Delete this fine entry?')) return;
                    try {
                        await supabaseDelete('nc_fines', btn.dataset.fineId);
                        await ncShowFineLog(prop);
                    } catch (e) { alert('Failed to delete: ' + e.message); }
                });
            });
            body.querySelectorAll('.nc-fine-waive').forEach(btn => {
                btn.addEventListener('click', async () => {
                    if (!confirm('Waive this fine?')) return;
                    try {
                        await supabaseUpdate('nc_fines', btn.dataset.fineId, {
                            status: 'waived', resolved_at: new Date().toISOString()
                        });
                        await ncShowFineLog(prop);
                    } catch (e) { alert('Failed to waive: ' + e.message); }
                });
            });
        }
    } catch (e) {
        console.error('Failed to load fines:', e);
        body.innerHTML = '<div style="text-align:center;color:#d4a0a0;padding:1rem;">Failed to load fines.</div>';
    }
}

// Fine preset buttons
document.querySelectorAll('.nc-fine-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.getElementById('ncFineAmount').value = btn.dataset.amount;
        document.querySelectorAll('.nc-fine-preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});

// Save Fine handler
document.getElementById('ncFineSaveBtn').addEventListener('click', async () => {
    const prop = ncFineCurrentProp;
    if (!prop?.id) return;
    const amount = Number(document.getElementById('ncFineAmount').value);
    const reason = document.getElementById('ncFineReason').value.trim();
    const reporter = document.getElementById('ncFineReporter').value.trim();
    const notes = document.getElementById('ncFineNotes').value.trim();

    if (!amount || amount <= 0) { alert('Amount is required.'); return; }

    const btn = document.getElementById('ncFineSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        const fineData = {
            property_id: prop.id,
            amount: amount,
            reason: reason || null,
            reporter: reporter || null,
            bounty_amount: reporter ? Math.floor(amount / 2) : null,
            notes: notes || null,
            issued_by: currentUser?.id || null,
            issued_by_name: userProfile?.discord_username || currentUser?.user_metadata?.full_name || 'Unknown'
        };

        if (ncEditingFineId) {
            await supabaseUpdate('nc_fines', ncEditingFineId, fineData);
            ncEditingFineId = null;
        } else {
            await supabaseInsert('nc_fines', fineData);
            ncRefreshAll();
        }
        await ncShowFineLog(prop);
    } catch (e) {
        alert('Failed to save fine: ' + e.message);
    }
    btn.disabled = false;
    btn.textContent = 'Apply Fine';
});

// Close Fine modal
document.getElementById('ncFineClose').addEventListener('click', () => {
    document.getElementById('ncFineModal').classList.remove('open');
    ncReopenPopup(ncFineCurrentProp);
});
document.getElementById('ncFineModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
        e.currentTarget.classList.remove('open');
        ncReopenPopup(ncFineCurrentProp);
    }
});

// ============================================
// Compliance check for commercial properties
// ============================================
function ncGetCompliance(prop) {
    if (prop.type !== 'Commercial') return null;
    const checks = {
        owner: !!(prop.owner && prop.owner.trim()),
        shopchests: !!prop.shopchests,
        signage: !!prop.signage,
        discord_contact: !!(prop.discord_contact && prop.discord_contact.trim())
    };
    const passed = Object.values(checks).filter(Boolean).length;
    const total = Object.keys(checks).length;
    return { checks, passed, total, compliant: passed === total };
}

// ============================================
// Ordinance modal open/close
// ============================================
document.getElementById('ncOrdinanceBtn').addEventListener('click', () => {
    document.getElementById('ncOrdinanceModal').classList.add('open');
});
document.getElementById('ncOrdinanceClose').addEventListener('click', () => {
    document.getElementById('ncOrdinanceModal').classList.remove('open');
});
document.getElementById('ncOrdinanceModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

function ncUpdateToolbar() {
    const editBtn = document.getElementById('ncEditToggleBtn');
    const addBtn = document.getElementById('ncAddRowBtn');
    const delBtn = document.getElementById('ncDeleteRowBtn');
    if (!editBtn) return;

    // Hide edit button entirely if user can't edit
    editBtn.classList.toggle('hidden', !ncCanEdit());

    if (ncEditMode) {
        editBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save`;
        editBtn.classList.add('primary');
        addBtn.classList.remove('hidden');
        delBtn.classList.remove('hidden');
    } else {
        editBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit`;
        editBtn.classList.remove('primary');
        addBtn.classList.add('hidden');
        delBtn.classList.add('hidden');
    }
}

