// ============================================
// Pavian Exchange — App JavaScript
// ============================================

const CONFIG = {
    supabaseUrl: 'https://ubuypxqueqxvugstmtkx.supabase.co',
    supabaseKey: 'sb_publishable_ndTGBxW3c2bOdMzgOVvy7w_9py3MLUs',
    workerUrl: 'https://maisonfris-auth.maisonfris.workers.dev'
};

// Supabase client — used ONLY for real-time subscriptions (auth handled by Worker)
const sb = supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

let currentUser = null;
let currentAccessToken = null;
let isAdmin = false;
let adminViewMode = true; // true = admin editing, false = client preview
let userProfile = null;

// ============================================
// Security Utilities
// ============================================
function ncEsc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML.replace(/'/g, '&#39;');
}

function sanitizeUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') return url;
    } catch {}
    return '';
}

// ============================================
// Direct REST helpers (fully bypass Supabase JS client for data)
// ============================================
function restHeaders() {
    const token = currentAccessToken || CONFIG.supabaseKey;
    return {
        'apikey': CONFIG.supabaseKey,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
    };
}

async function supabaseRest(table, params = '') {
    const resp = await fetch(`${CONFIG.supabaseUrl}/rest/v1/${table}?${params}`, { headers: restHeaders() });
    if (!resp.ok) throw new Error(`REST ${resp.status}: ${await resp.text()}`);
    return resp.json();
}

async function supabaseInsert(table, row) {
    const resp = await fetch(`${CONFIG.supabaseUrl}/rest/v1/${table}`, { method: 'POST', headers: restHeaders(), body: JSON.stringify(row) });
    if (!resp.ok) throw new Error(`REST ${resp.status}: ${await resp.text()}`);
    return resp.json();
}

async function supabaseUpdate(table, id, updates) {
    const resp = await fetch(`${CONFIG.supabaseUrl}/rest/v1/${table}?id=eq.${id}`, { method: 'PATCH', headers: restHeaders(), body: JSON.stringify(updates) });
    if (!resp.ok) throw new Error(`REST ${resp.status}: ${await resp.text()}`);
    return resp.json();
}

async function supabaseDelete(table, id) {
    const resp = await fetch(`${CONFIG.supabaseUrl}/rest/v1/${table}?id=eq.${id}`, { method: 'DELETE', headers: restHeaders() });
    if (!resp.ok) throw new Error(`REST ${resp.status}: ${await resp.text()}`);
    const data = await resp.json().catch(() => null);
    if (Array.isArray(data) && data.length === 0) throw new Error('Delete blocked by RLS policy — no rows removed.');
}

// ============================================
// JWT helpers
// ============================================
function parseJWT(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (payload.exp && payload.exp < Date.now() / 1000) return null;
        return payload;
    } catch { return null; }
}

// ============================================
// Menu Toggle
// ============================================
const hamburger = document.getElementById('hamburger');
const sideMenu = document.getElementById('sideMenu');
const orderModal = document.getElementById('orderModal');

hamburger.addEventListener('click', () => {
    hamburger.classList.toggle('active');
    sideMenu.classList.toggle('active');
});

sideMenu.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
        sideMenu.classList.remove('active');
        hamburger.classList.remove('active');
    });
});

// ============================================
// Router
// ============================================
function navigateTo(path) {
    history.pushState(null, '', path);
    navigate();
}

function navigate() {
    const path = window.location.pathname;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

    if (path === '/orderbook' || path === '/orderhistory') {
        // Orderbook hidden — Monument Bank exchange is now primary
        history.replaceState(null, '', '/home');
        document.getElementById('landingView').classList.add('active');
        document.body.classList.add('landing');
        return;
    } else if (path === '/profile') {
        if (!currentUser) {
            history.replaceState(null, '', '/home');
            document.getElementById('landingView').classList.add('active');
            document.body.classList.add('landing');
            return;
        }
        document.getElementById('profileView').classList.add('active');
        document.body.classList.remove('landing');
        loadProfile().then(() => fillProfileForm());
    } else if (path === '/new-callisto') {
        document.getElementById('newCallistoView').classList.add('active');
        document.body.classList.remove('landing');
        setTimeout(() => loadNewCallisto(), 100);
    } else if (path === '/usermanagement') {
        if (!currentUser || !isAdmin) {
            history.replaceState(null, '', '/home');
            document.getElementById('landingView').classList.add('active');
            document.body.classList.add('landing');
            return;
        }
        document.getElementById('userMgmtView').classList.add('active');
        document.body.classList.remove('landing');
        loadAdminUsers();
    } else if (path === '/terminal') {
        document.getElementById('terminalView').classList.add('active');
        document.body.classList.remove('landing');
        if (typeof loadTerminal === 'function') loadTerminal();
    } else if (path === '/terminal-admin') {
        if (!currentUser || !isAdmin) {
            history.replaceState(null, '', '/home');
            document.getElementById('landingView').classList.add('active');
            document.body.classList.add('landing');
            return;
        }
        document.getElementById('terminalAdminView').classList.add('active');
        document.body.classList.remove('landing');
        if (typeof loadTerminalAdmin === 'function') loadTerminalAdmin();
    } else if (path === '/analysis') {
        if (!currentUser || !(isAdmin || (userProfile && userProfile.is_surveyor))) {
            history.replaceState(null, '', '/home');
            document.getElementById('landingView').classList.add('active');
            document.body.classList.add('landing');
            return;
        }
        document.getElementById('analysisView').classList.add('active');
        document.body.classList.remove('landing');
        if (typeof loadAnalysis === 'function') loadAnalysis();
    } else if (path === '/home') {
        document.getElementById('landingView').classList.add('active');
        document.body.classList.add('landing');
    } else {
        // Default view: the New Callisto registry
        history.replaceState(null, '', '/new-callisto');
        document.getElementById('newCallistoView').classList.add('active');
        document.body.classList.remove('landing');
        setTimeout(() => loadNewCallisto(), 100);
    }
}

window.addEventListener('popstate', navigate);

// ============================================
// Auth
// ============================================
async function checkAdmin() {
    if (!currentUser) { isAdmin = false; return; }
    try {
        const rows = await supabaseRest('profiles', `select=is_admin&id=eq.${currentUser.id}`);
        console.log('Admin check:', rows);
        isAdmin = rows?.[0]?.is_admin || false;
    } catch (e) {
        console.error('checkAdmin failed:', e);
        isAdmin = false;
    }
}

function updateAuthUI() {
    const authBar = document.getElementById('authBar');
    if (currentUser) {
        const name = ncEsc(currentUser.user_metadata?.full_name || currentUser.user_metadata?.name || 'User');
        const avatar = sanitizeUrl(currentUser.user_metadata?.avatar_url);
        authBar.innerHTML = `
            <div class="user-info">
                ${avatar ? `<img src="${avatar}" alt="">` : ''}
                <span>${name}</span>
                ${isAdmin ? '<span class="admin-badge">Admin</span>' : ''}
            </div>
            <button class="logout-btn" onclick="logoutUser()">Sign Out</button>
        `;
    } else {
        authBar.innerHTML = '<button class="login-btn" id="loginBtn" onclick="loginWithDiscord()">Sign in with Discord</button>';
    }
    const comeInBtn = document.getElementById('comeInBtn');
    if (comeInBtn) comeInBtn.style.display = currentUser ? 'none' : '';

    // Show/hide logged-in nav links
    const profileLink = document.getElementById('profileLink');
    if (profileLink) profileLink.style.display = currentUser ? '' : 'none';
    const orderHistoryLink = document.getElementById('orderHistoryLink');
    if (orderHistoryLink) orderHistoryLink.style.display = currentUser ? '' : 'none';

    // Show/hide admin view toggle
    const toggleBtn = document.getElementById('adminViewToggle');
    if (toggleBtn) {
        toggleBtn.style.display = isAdmin ? '' : 'none';
        toggleBtn.textContent = adminViewMode ? 'Client View' : 'Admin View';
    }

    // Orderbook gate removed — Monument Bank exchange is now primary

    // Show/hide admin user management nav link
    const userMgmtLink = document.getElementById('userMgmtLink');
    if (userMgmtLink) userMgmtLink.style.display = isAdmin ? '' : 'none';

    // Show/hide terminal admin nav link (admin only)
    const terminalAdminLink = document.getElementById('terminalAdminLink');
    if (terminalAdminLink) terminalAdminLink.style.display = isAdmin ? '' : 'none';

    // Show/hide analysis nav link (admin + surveyor)
    const analysisLink = document.getElementById('analysisLink');
    if (analysisLink) analysisLink.style.display = (isAdmin || (userProfile && userProfile.is_surveyor)) ? '' : 'none';
}

function toggleAdminView() {
    adminViewMode = !adminViewMode;
    const toggleBtn = document.getElementById('adminViewToggle');
    if (toggleBtn) toggleBtn.textContent = adminViewMode ? 'Client View' : 'Admin View';
    loadEquities();
}

function loginWithDiscord() {
    const redirect = (window.location.pathname === '/home' || window.location.pathname === '/')
        ? '/new-callisto' : window.location.pathname;
    window.location.href = `${CONFIG.workerUrl}/auth/discord?redirect=${encodeURIComponent(redirect)}&origin=${encodeURIComponent(window.location.origin)}`;
}

function logoutUser() {
    localStorage.removeItem('mf_token');
    currentUser = null;
    currentAccessToken = null;
    isAdmin = false;
    userProfile = null;
    updateAuthUI();
    navigateTo('/home');
}

// ============================================
// Admin User Management (/usermanagement)
// ============================================
let adminAllProfiles = [];

async function loadAdminUsers() {
    if (!isAdmin) return;
    try {
        adminAllProfiles = await supabaseRest('profiles', 'select=*&order=discord_username');
        renderAdminUsers('');
    } catch (e) {
        console.error('Failed to load users:', e);
    }
}

function renderAdminUsers(filter) {
    const list = document.getElementById('adminUsersList');
    if (!list) return;
    const q = (filter || '').toLowerCase().trim();
    const filtered = adminAllProfiles.filter(p => {
        if (!q) return true;
        return [p.discord_username, p.minecraft_ign].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
    list.innerHTML = '';
    filtered.forEach(p => {
        const row = document.createElement('div');
        row.className = 'admin-user-row';
        const avatarUrl = sanitizeUrl(p.discord_avatar);
        const isSurveyor = !!p.is_surveyor;
        const isPAdmin = !!p.is_admin;
        const isTerminal = !!p.terminal;
        row.innerHTML = `
            ${avatarUrl ? `<img class="admin-user-avatar" src="${avatarUrl}" alt="">` : `<div class="admin-user-avatar" style="background:rgba(184,180,204,0.2);"></div>`}
            <div class="admin-user-info">
                <div class="admin-user-name">${ncEsc(p.discord_username || 'Unknown')}</div>
                ${p.minecraft_ign ? `<div class="admin-user-ign">${ncEsc(p.minecraft_ign)}</div>` : ''}
            </div>
            <button class="admin-role-btn ${isSurveyor ? 'active' : ''}" data-role="surveyor" data-uid="${p.id}" title="Toggle surveyor">Surveyor</button>
            <button class="admin-role-btn terminal-btn ${isTerminal ? 'active' : ''}" data-role="terminal" data-uid="${p.id}" title="Toggle terminal">Terminal</button>
            <button class="admin-role-btn admin-btn ${isPAdmin ? 'active' : ''}" data-role="admin" data-uid="${p.id}" title="Toggle admin">Admin</button>
        `;
        // Surveyor toggle
        row.querySelector('[data-role="surveyor"]').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const newVal = !isSurveyor;
            btn.textContent = '...';
            try {
                await fetch(`${CONFIG.supabaseUrl}/rest/v1/profiles?id=eq.${p.id}`, {
                    method: 'PATCH', headers: restHeaders(), body: JSON.stringify({ is_surveyor: newVal })
                });
                p.is_surveyor = newVal;
                renderAdminUsers(document.getElementById('adminUsersSearch').value);
            } catch (err) {
                console.error('Toggle surveyor failed:', err);
                alert('Failed to update role: ' + err.message);
                btn.textContent = 'Surveyor';
            }
        });
        // Terminal toggle
        row.querySelector('[data-role="terminal"]').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const newVal = !isTerminal;
            btn.textContent = '...';
            try {
                await fetch(`${CONFIG.supabaseUrl}/rest/v1/profiles?id=eq.${p.id}`, {
                    method: 'PATCH', headers: restHeaders(), body: JSON.stringify({ terminal: newVal })
                });
                p.terminal = newVal;
                renderAdminUsers(document.getElementById('adminUsersSearch').value);
            } catch (err) {
                console.error('Toggle terminal failed:', err);
                alert('Failed to update role: ' + err.message);
                btn.textContent = 'Terminal';
            }
        });
        // Admin toggle
        row.querySelector('[data-role="admin"]').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const newVal = !isPAdmin;
            const action = newVal ? 'grant admin to' : 'revoke admin from';
            if (!confirm(`Are you sure you want to ${action} ${p.discord_username || 'this user'}?`)) return;
            btn.textContent = '...';
            try {
                await fetch(`${CONFIG.supabaseUrl}/rest/v1/profiles?id=eq.${p.id}`, {
                    method: 'PATCH', headers: restHeaders(), body: JSON.stringify({ is_admin: newVal })
                });
                p.is_admin = newVal;
                renderAdminUsers(document.getElementById('adminUsersSearch').value);
            } catch (err) {
                console.error('Toggle admin failed:', err);
                alert('Failed to update role: ' + err.message);
                btn.textContent = 'Admin';
            }
        });
        list.appendChild(row);
    });
}

document.getElementById('adminUsersSearch').addEventListener('input', (e) => {
    renderAdminUsers(e.target.value);
});

// ============================================
// Profile
// ============================================
async function loadProfile() {
    if (!currentUser) { userProfile = null; return; }
    try {
        const rows = await supabaseRest('profiles', `select=*&id=eq.${currentUser.id}`);
        userProfile = rows?.[0] || null;
    } catch (e) {
        console.error('loadProfile failed:', e);
        userProfile = null;
    }
}

function fillProfileForm() {
    if (!userProfile) return;
    const ign = document.getElementById('profileIGN');
    const nation = document.getElementById('profileNation');
    const mb = document.getElementById('profileMB');
    if (ign) ign.value = userProfile.minecraft_ign || '';
    if (nation) nation.value = userProfile.nation || '';
    if (mb) mb.value = userProfile.monument_bank || '';
    setProfileEditable(false);
}

function setProfileEditable(editable) {
    const inputs = document.querySelectorAll('#profileForm input[type="text"]');
    inputs.forEach(i => { if (editable) i.removeAttribute('readonly'); else i.setAttribute('readonly', ''); });
    const editBtn = document.getElementById('profileEditBtn');
    const saveBtn = document.getElementById('profileSaveBtn');
    if (editBtn) editBtn.style.display = editable ? 'none' : '';
    if (saveBtn) saveBtn.style.display = editable ? '' : 'none';
}

function toggleProfileEdit() {
    setProfileEditable(true);
    document.getElementById('profileIGN')?.focus();
}

async function saveProfile(e) {
    e.preventDefault();
    if (!currentUser) return;

    const data = {
        minecraft_ign: document.getElementById('profileIGN').value.trim() || null,
        nation: document.getElementById('profileNation').value.trim() || null,
        monument_bank: document.getElementById('profileMB').value.trim() || null
    };

    try {
        await fetch(`${CONFIG.supabaseUrl}/rest/v1/profiles?id=eq.${currentUser.id}`, {
            method: 'PATCH', headers: restHeaders(), body: JSON.stringify(data)
        });
        userProfile = { ...userProfile, ...data };
        setProfileEditable(false);
        const msg = document.getElementById('profileSaveMsg');
        if (msg) { msg.style.display = 'block'; setTimeout(() => { msg.style.display = 'none'; }, 2000); }
    } catch (err) {
        console.error('saveProfile error:', err);
        alert('Error saving profile: ' + err.message);
    }
}

// ============================================
// Order History
// ============================================
async function loadOrderHistory() {
    const container = document.getElementById('orderHistoryData');
    container.innerHTML = '<p class="loading">Loading orders...</p>';

    try {
        let params, orders;
        if (isAdmin) {
            params = 'select=*,equities(ticker,company_name),profiles(discord_username)&order=created_at.desc';
            orders = await supabaseRest('orders', params);
        } else {
            params = `select=*,equities(ticker,company_name)&user_id=eq.${currentUser.id}&order=created_at.desc`;
            orders = await supabaseRest('orders', params);
        }

        if (!orders || orders.length === 0) {
            container.innerHTML = '<p class="loading">No orders yet.</p>';
            return;
        }

        let html = '<div class="order-history-list">';
        orders.forEach(order => {
            const date = new Date(order.created_at).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            const total = (Number(order.price) * order.quantity).toFixed(2);
            const ticker = ncEsc(order.equities?.ticker || 'Unknown');
            const company = ncEsc(order.equities?.company_name || '');
            const discordUser = ncEsc(order.profiles?.discord_username || '');

            const searchStr = [
                ticker, company, order.side, order.status,
                order.minecraft_ign || '', discordUser
            ].join(' ').toLowerCase();

            let adminHTML = '';
            if (isAdmin) {
                adminHTML = `<div class="oh-row oh-admin-actions">`;
                if (order.status !== 'approved') {
                    adminHTML += `<button class="oh-action-btn approve" onclick="adminUpdateOrder(${order.id}, 'approved')">Approve</button>`;
                }
                if (order.status !== 'pending') {
                    adminHTML += `<button class="oh-action-btn pending" onclick="adminUpdateOrder(${order.id}, 'pending')">Pending</button>`;
                }
                adminHTML += `<button class="oh-action-btn delete" onclick="adminDeleteOrder(${order.id})">Delete</button>`;
                adminHTML += `</div>`;
            }

            html += `
                <div class="order-history-item" data-search="${searchStr.replace(/"/g, '&quot;')}" data-order-id="${order.id}">
                    <div class="oh-row">
                        <span class="oh-ticker">${ticker}</span>
                        <span class="oh-side ${order.side}">${order.side.toUpperCase()}</span>
                        <span class="oh-status ${order.status}">${order.status}</span>
                    </div>
                    <div class="oh-row oh-details">
                        <span>${order.quantity} @ $${Number(order.price)}</span>
                        <span>Total: $${total}</span>
                    </div>
                    <div class="oh-row oh-meta">
                        ${isAdmin && discordUser ? `<span>${discordUser}</span>` : ''}
                        ${order.minecraft_ign ? `<span>IGN: ${ncEsc(order.minecraft_ign)}</span>` : ''}
                        <span>${date}</span>
                    </div>
                    ${adminHTML}
                </div>`;
        });
        html += '</div>';
        container.innerHTML = html;

    } catch (error) {
        console.error('Error loading order history:', error);
        container.innerHTML = `<p class="loading">Error loading orders: ${ncEsc(error.message)}</p>`;
    }
}

document.getElementById('orderHistorySearch').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    document.querySelectorAll('.order-history-item').forEach(item => {
        const match = !query || (item.dataset.search || '').includes(query);
        item.classList.toggle('filtered-out', !match);
    });
});

async function adminUpdateOrder(orderId, newStatus) {
    if (!isAdmin) return;
    try {
        const result = await supabaseUpdate('orders', orderId, { status: newStatus });
        if (!result || result.length === 0) {
            alert('Update failed. Make sure the admin RLS policies exist in Supabase.');
            return;
        }
        loadOrderHistory();
    } catch (err) {
        console.error('Error updating order:', err);
        alert('Error updating order: ' + err.message);
    }
}

async function adminDeleteOrder(orderId) {
    if (!isAdmin) return;
    if (!confirm('Delete this order? This cannot be undone.')) return;
    try {
        const resp = await fetch(`${CONFIG.supabaseUrl}/rest/v1/orders?id=eq.${orderId}`, {
            method: 'DELETE',
            headers: restHeaders()
        });
        if (!resp.ok) throw new Error(`REST ${resp.status}: ${await resp.text()}`);
        const text = await resp.text();
        const deleted = text ? JSON.parse(text) : [];
        if (deleted.length === 0) {
            alert('Delete failed. Make sure the admin DELETE policy exists in Supabase.');
            return;
        }
        loadOrderHistory();
    } catch (err) {
        console.error('Error deleting order:', err);
        alert('Error deleting order: ' + err.message);
    }
}

// ============================================
// Load Equities (direct REST — bypasses Supabase JS client)
// ============================================
async function loadEquities() {
    const equityData = document.getElementById('equityData');

    try {
        console.log('Fetching equities via REST...');

        const equities = await supabaseRest('equities', 'select=*&is_active=eq.true&order=ticker');
        console.log('Equities loaded:', equities.length);

        // showAdmin: render admin editing UI only when admin AND in admin view mode
        const showAdmin = isAdmin && adminViewMode;

        const obParams = isAdmin
            ? 'select=*'
            : 'select=*&quantity_available=gt.0';
        const orderBook = await supabaseRest('order_book', obParams);
        console.log('Order book loaded:', orderBook.length);

        if (!equities || equities.length === 0) {
            equityData.innerHTML = '<p class="loading">No equities listed yet.</p>';
            return;
        }

        // Group order book by equity
        const bookByEquity = {};
        orderBook.forEach(entry => {
            if (!bookByEquity[entry.equity_id]) bookByEquity[entry.equity_id] = { bid: [], ask: [] };
            bookByEquity[entry.equity_id][entry.side].push(entry);
        });

        let html = '<div class="carousel-wrapper">';
        html += '<button class="carousel-arrow" id="arrowLeft" onclick="carouselPrev()">&lt;</button>';
        html += '<div class="carousel-stage">';

        let cardCount = 0;
        equities.forEach(eq => {
            const book = bookByEquity[eq.id] || { bid: [], ask: [] };
            const bidEntries = book.bid.sort((a, b) => b.price - a.price);
            const askEntries = book.ask.sort((a, b) => a.price - b.price);
            const isUnavailable = bidEntries.length === 0 && askEntries.length === 0;

            const tiers = JSON.stringify({
                buy: askEntries.map(e => ({ price: Number(e.price), qty: e.quantity_available, id: e.id })),
                sell: bidEntries.map(e => ({ price: Number(e.price), qty: e.quantity_available, id: e.id }))
            }).replace(/"/g, '&quot;');

            let bidHTML = '';
            if (showAdmin) {
                bidEntries.forEach(e => {
                    bidHTML += `
                        <div class="admin-offer-row" data-id="${e.id}">
                            <label>$</label><input class="admin-inline-input" type="number" value="${Number(e.price)}" data-field="price" data-id="${e.id}" step="any" min="0">
                            <label>x</label><input class="admin-inline-input" type="number" value="${e.quantity_available}" data-field="qty" data-id="${e.id}" min="0">
                            <button class="admin-remove-tier" onclick="adminRemoveTier(${e.id})" title="Remove tier">&times;</button>
                        </div>`;
                });
                bidHTML += `<button class="admin-add-tier" onclick="adminAddTier(${eq.id}, 'bid')">+ Add bid tier</button>`;
            } else if (bidEntries.length > 0) {
                bidEntries.forEach(e => {
                    bidHTML += `
                        <div class="book-offer">
                            <span class="offer-info"><span class="price">$${Number(e.price)}</span><span class="qty">Available: ${e.quantity_available}</span></span>
                            <button onclick='openOrderForm("SELL", "${eq.ticker}", ${tiers}, ${eq.id})'>Sell</button>
                        </div>`;
                });
            } else {
                bidHTML = '<span class="book-empty">No offers</span>';
            }

            let askHTML = '';
            if (showAdmin) {
                askEntries.forEach(e => {
                    askHTML += `
                        <div class="admin-offer-row" data-id="${e.id}">
                            <label>$</label><input class="admin-inline-input" type="number" value="${Number(e.price)}" data-field="price" data-id="${e.id}" step="any" min="0">
                            <label>x</label><input class="admin-inline-input" type="number" value="${e.quantity_available}" data-field="qty" data-id="${e.id}" min="0">
                            <button class="admin-remove-tier" onclick="adminRemoveTier(${e.id})" title="Remove tier">&times;</button>
                        </div>`;
                });
                askHTML += `<button class="admin-add-tier" onclick="adminAddTier(${eq.id}, 'ask')">+ Add ask tier</button>`;
            } else if (askEntries.length > 0) {
                askEntries.forEach(e => {
                    askHTML += `
                        <div class="book-offer">
                            <span class="offer-info"><span class="price">$${Number(e.price)}</span><span class="qty">Available: ${e.quantity_available}</span></span>
                            <button onclick='openOrderForm("BUY", "${eq.ticker}", ${tiers}, ${eq.id})'>Buy</button>
                        </div>`;
                });
            } else {
                askHTML = '<span class="book-empty">No offers</span>';
            }

            const showBody = showAdmin || !isUnavailable;

            html += `
                <div class="equity-card ${showAdmin ? 'admin-card' : ''} ${isUnavailable && !showAdmin ? 'unavailable' : ''}" data-ticker="${eq.ticker.toLowerCase()}" data-company="${eq.company_name.toLowerCase()}" data-equity-id="${eq.id}">
                    <div class="equity-card-header">
                        <span class="ticker-display">${eq.ticker}</span>
                        <span class="company-name">${eq.company_name}</span>
                    </div>
                    ${!showBody ? '<div class="unavailable-label">Not currently traded</div>' : `
                    <div class="equity-card-body">
                        <div class="book-side ask">
                            <div class="book-side-label">Ask</div>
                            ${askHTML}
                        </div>
                        <div class="book-side bid">
                            <div class="book-side-label">Bid</div>
                            ${bidHTML}
                        </div>
                    </div>
                    ${showAdmin ? `<div class="admin-actions" style="padding: 0 2rem 1rem; justify-content: center;">
                        <button class="admin-edit-btn save" onclick="adminSaveCard(${eq.id})">Save Changes</button>
                    </div>` : ''}`}
                </div>
            `;
            cardCount++;
        });

        html += '</div>';
        html += '<button class="carousel-arrow" id="arrowRight" onclick="carouselNext()">&gt;</button>';
        html += '</div>';

        equityData.innerHTML = html;
        carouselIndex = 0;
        updateCarousel();

    } catch (error) {
        console.error('Error loading equities:', error);
        equityData.innerHTML = `<p class="loading">Error loading equities: ${ncEsc(error.message)}</p>`;
    }
}

// ============================================
// Real-time subscription
// ============================================
sb.channel('order_book_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_book' }, () => {
        if (window.location.pathname === '/orderbook') loadEquities();
    })
    .subscribe();

// ============================================
// Carousel
// ============================================
let carouselIndex = 0;

function getVisibleCards() {
    return Array.from(document.querySelectorAll('.equity-card:not(.filtered-out)'));
}

function updateCarousel() {
    const cards = getVisibleCards();
    document.querySelectorAll('.equity-card').forEach(c => c.classList.remove('active-card'));

    let noResults = document.getElementById('noResults');
    if (cards.length === 0) {
        if (!noResults) {
            noResults = document.createElement('div');
            noResults.id = 'noResults';
            noResults.className = 'no-results';
            noResults.textContent = 'No equities match your search.';
            document.querySelector('.carousel-stage')?.appendChild(noResults);
        }
        noResults.style.display = 'block';
        return;
    } else if (noResults) {
        noResults.style.display = 'none';
    }

    if (carouselIndex >= cards.length) carouselIndex = 0;
    if (carouselIndex < 0) carouselIndex = cards.length - 1;
    cards[carouselIndex].classList.add('active-card');
}

function carouselPrev() { carouselIndex--; updateCarousel(); }
function carouselNext() { carouselIndex++; updateCarousel(); }

document.addEventListener('keydown', (e) => {
    if (window.location.pathname !== '/orderbook') return;
    if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') carouselPrev();
    if (e.key === 'ArrowRight') carouselNext();
});

let touchStartX = 0;
document.addEventListener('touchstart', (e) => {
    if (window.location.pathname !== '/orderbook') return;
    touchStartX = e.touches[0].clientX;
}, { passive: true });

document.addEventListener('touchend', (e) => {
    if (window.location.pathname !== '/orderbook') return;
    const diff = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) { diff > 0 ? carouselNext() : carouselPrev(); }
});

document.getElementById('searchInput').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    document.querySelectorAll('.equity-card').forEach(card => {
        const match = !query || (card.dataset.ticker || '').includes(query) || (card.dataset.company || '').includes(query);
        card.classList.toggle('filtered-out', !match);
    });
    carouselIndex = 0;
    updateCarousel();
});

// ============================================
// Order Form
// ============================================
let currentOrder = {};

function openOrderForm(type, ticker, tiers, equityId) {
    if (!currentUser) { loginWithDiscord(); return; }

    const availableTiers = type === 'BUY' ? tiers.buy : tiers.sell;
    if (availableTiers.length === 0) return;

    currentOrder = { type, ticker, tiers: availableTiers, equityId };
    document.getElementById('orderTitle').textContent = `${type} ${ticker}`;

    let tierHTML = '<p style="margin-bottom: 1rem;"><span class="label">Select Price Tier:</span></p>';
    availableTiers.forEach((tier, index) => {
        tierHTML += `
            <div style="margin-bottom: 0.75rem;">
                <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 0.75rem; background: rgba(255,255,255,0.05); border-radius: 4px; border: 2px solid ${index === 0 ? 'var(--accent)' : 'transparent'};" id="tierLabel${index}">
                    <input type="radio" name="tier" value="${index}" ${index === 0 ? 'checked' : ''} style="width: auto; cursor: pointer;" onchange="updateOrderTier(${index})">
                    <span style="flex: 1;">
                        <strong style="color: var(--text);">${tier.qty} shares</strong> @
                        <strong style="color: ${type === 'BUY' ? '#a8d4a0' : '#d4a0a0'};">$${tier.price}</strong> each
                    </span>
                </label>
            </div>`;
    });

    document.getElementById('orderSummary').innerHTML = tierHTML;
    updateOrderTier(0);

    // Auto-fill from profile
    const ignInput = document.getElementById('minecraftIGN');
    if (ignInput) ignInput.value = userProfile?.minecraft_ign || '';
    const nationInput = document.getElementById('orderNation');
    if (nationInput) nationInput.value = userProfile?.nation || '';
    const mbInput = document.getElementById('orderMB');
    if (mbInput) mbInput.value = userProfile?.monument_bank || '';

    orderModal.classList.add('active');
}

function updateOrderTier(tierIndex) {
    const tier = currentOrder.tiers[tierIndex];
    currentOrder.selectedTier = tier;
    currentOrder.tiers.forEach((_, i) => {
        const label = document.getElementById(`tierLabel${i}`);
        if (label) label.style.borderColor = i === tierIndex ? 'var(--accent)' : 'transparent';
    });
    const qtyInput = document.getElementById('quantity');
    const maxQtyLabel = document.getElementById('maxQtyLabel');
    if (qtyInput) { qtyInput.max = tier.qty; qtyInput.value = Math.min(qtyInput.value || 1, tier.qty); }
    if (maxQtyLabel) maxQtyLabel.textContent = `(max ${tier.qty})`;
}

function validateQuantity() {
    const qtyInput = document.getElementById('quantity');
    if (!currentOrder.selectedTier) return;
    const qty = parseInt(qtyInput.value);
    if (qty > currentOrder.selectedTier.qty) qtyInput.value = currentOrder.selectedTier.qty;
    if (qty < 1) qtyInput.value = 1;
}

document.getElementById('cancelOrder').addEventListener('click', () => {
    orderModal.classList.remove('active');
    document.getElementById('orderForm').reset();
});

document.getElementById('orderForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const ign = document.getElementById('minecraftIGN').value;
    const nation = document.getElementById('orderNation').value;
    const mbAccount = document.getElementById('orderMB').value;
    const quantity = document.getElementById('quantity').value;

    if (!currentOrder.selectedTier) { alert('Please select a price tier'); return; }
    if (parseInt(quantity) > currentOrder.selectedTier.qty) {
        alert(`Maximum quantity for this tier is ${currentOrder.selectedTier.qty} shares`);
        return;
    }

    const total = (parseFloat(currentOrder.selectedTier.price) * parseFloat(quantity)).toFixed(2);
    const discordName = currentUser?.user_metadata?.full_name || currentUser?.user_metadata?.name || 'Unknown';

    try {
        const rows = await supabaseInsert('orders', {
            user_id: currentUser.id,
            equity_id: currentOrder.equityId,
            side: currentOrder.type.toLowerCase(),
            price: currentOrder.selectedTier.price,
            quantity: parseInt(quantity),
            minecraft_ign: ign,
            monument_bank: mbAccount || null
        });
        const order = rows[0];

        // Update profile if any fields changed
        const profileUpdates = {};
        if (ign && ign !== (userProfile?.minecraft_ign || '')) profileUpdates.minecraft_ign = ign;
        if (nation && nation !== (userProfile?.nation || '')) profileUpdates.nation = nation;
        if (mbAccount && mbAccount !== (userProfile?.monument_bank || '')) profileUpdates.monument_bank = mbAccount;
        if (Object.keys(profileUpdates).length > 0) {
            fetch(`${CONFIG.supabaseUrl}/rest/v1/profiles?id=eq.${currentUser.id}`, {
                method: 'PATCH', headers: restHeaders(), body: JSON.stringify(profileUpdates)
            }).catch(err => console.warn('Profile update failed:', err));
            userProfile = { ...userProfile, ...profileUpdates };
        }

        alert('Order Sent. Maison Fris will be in touch.');
        orderModal.classList.remove('active');
        document.getElementById('orderForm').reset();

    } catch (error) {
        console.error('Error submitting order:', error);
        alert('Error. Contact @grphon_the on discord for help with this order. Please include all details.');
    }
});

orderModal.addEventListener('click', (e) => {
    if (e.target === orderModal) {
        orderModal.classList.remove('active');
        document.getElementById('orderForm').reset();
    }
});

// ============================================
// Admin Functions (using direct REST)
// ============================================
async function adminSaveCard(equityId) {
    if (!isAdmin) return;
    const card = document.querySelector(`.equity-card[data-equity-id="${equityId}"]`);
    if (!card) return;

    const inputs = card.querySelectorAll('.admin-inline-input');
    const updates = {};
    inputs.forEach(input => {
        const id = input.dataset.id;
        const field = input.dataset.field;
        if (!updates[id]) updates[id] = {};
        if (field === 'price') updates[id].price = parseFloat(input.value) || 0;
        if (field === 'qty') updates[id].quantity_available = parseInt(input.value) || 0;
    });

    try {
        for (const [id, data] of Object.entries(updates)) {
            await supabaseUpdate('order_book', id, data);
        }
        const btn = card.querySelector('.admin-edit-btn.save');
        if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save Changes'; }, 1500); }
    } catch (err) {
        console.error('Admin save error:', err);
        alert('Error saving changes: ' + err.message);
    }
}

async function adminAddTier(equityId, side) {
    if (!isAdmin) return;
    try {
        const existing = await supabaseRest('order_book', `select=tier&equity_id=eq.${equityId}&side=eq.${side}&order=tier.desc&limit=1`);
        const nextTier = existing.length > 0 ? existing[0].tier + 1 : 1;
        await supabaseInsert('order_book', {
            equity_id: equityId, side, price: 1, quantity_available: 0, tier: nextTier
        });
    } catch (err) {
        console.error('Add tier error:', err);
        alert('Error adding tier: ' + err.message);
    }
}

async function adminRemoveTier(bookId) {
    if (!isAdmin) return;
    if (!confirm('Remove this tier?')) return;
    try {
        await supabaseDelete('order_book', bookId);
    } catch (err) {
        console.error('Remove tier error:', err);
        alert('Error removing tier: ' + err.message);
    }
}

