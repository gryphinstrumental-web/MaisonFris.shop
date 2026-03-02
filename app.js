// ============================================
// Pavian Exchange — App JavaScript
// ============================================

const CONFIG = {
    supabaseUrl: 'https://ubuypxqueqxvugstmtkx.supabase.co',
    supabaseKey: 'sb_publishable_ndTGBxW3c2bOdMzgOVvy7w_9py3MLUs',
    workerUrl: 'https://maisonfris-auth.maisonfris.workers.dev',
    discordWebhook: 'https://discord.com/api/webhooks/1472730251372003474/aWcIylD6Ew7gOI1KyCLToj8aQfd7hsDJ8YqUdxniBmxSFaa_YwGAQKqwZH-gQEPLUv7Y'
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
    } else if (path === '/home') {
        document.getElementById('landingView').classList.add('active');
        document.body.classList.add('landing');
    } else {
        history.replaceState(null, '', '/home');
        document.getElementById('landingView').classList.add('active');
        document.body.classList.add('landing');
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
        const name = currentUser.user_metadata?.full_name || currentUser.user_metadata?.name || 'User';
        const avatar = currentUser.user_metadata?.avatar_url;
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
        const avatarUrl = p.discord_avatar || '';
        const isSurveyor = !!p.is_surveyor;
        const isPAdmin = !!p.is_admin;
        row.innerHTML = `
            ${avatarUrl ? `<img class="admin-user-avatar" src="${avatarUrl}" alt="">` : `<div class="admin-user-avatar" style="background:rgba(184,180,204,0.2);"></div>`}
            <div class="admin-user-info">
                <div class="admin-user-name">${p.discord_username || 'Unknown'}</div>
                ${p.minecraft_ign ? `<div class="admin-user-ign">${p.minecraft_ign}</div>` : ''}
            </div>
            <button class="admin-role-btn ${isSurveyor ? 'active' : ''}" data-role="surveyor" data-uid="${p.id}" title="Toggle surveyor">Surveyor</button>
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
        // Admin toggle
        row.querySelector('[data-role="admin"]').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const newVal = !isPAdmin;
            const action = newVal ? 'grant admin to' : 'revoke admin from';
            if (!confirm(`Are you sure you want to ${action} ${p.discord_username}?`)) return;
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
            const ticker = order.equities?.ticker || 'Unknown';
            const company = order.equities?.company_name || '';
            const discordUser = order.profiles?.discord_username || '';

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
                        ${order.minecraft_ign ? `<span>IGN: ${order.minecraft_ign}</span>` : ''}
                        <span>${date}</span>
                    </div>
                    ${adminHTML}
                </div>`;
        });
        html += '</div>';
        container.innerHTML = html;

    } catch (error) {
        console.error('Error loading order history:', error);
        container.innerHTML = `<p class="loading">Error loading orders: ${error.message}</p>`;
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
        equityData.innerHTML = `<p class="loading">Error loading equities: ${error.message}</p>`;
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

        fetch(CONFIG.discordWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title: `New ${currentOrder.type} Order - ${currentOrder.ticker}`,
                    color: currentOrder.type === 'BUY' ? 0xa8d4a0 : 0xd4a0a0,
                    fields: [
                        { name: 'Order ID', value: `#${order.id}`, inline: true },
                        { name: 'Ticker', value: currentOrder.ticker, inline: true },
                        { name: 'Type', value: currentOrder.type, inline: true },
                        { name: 'Price per Share', value: `$${currentOrder.selectedTier.price}`, inline: true },
                        { name: 'Quantity', value: quantity, inline: true },
                        { name: 'Total Value', value: `$${total}`, inline: true },
                        { name: 'Discord', value: discordName, inline: true },
                        { name: 'Minecraft IGN', value: ign || 'Not set', inline: true },
                        { name: 'Nation', value: nation || 'Not set', inline: true },
                        { name: 'Monument Bank', value: mbAccount || 'Not set', inline: true }
                    ],
                    timestamp: new Date().toISOString(),
                    footer: { text: 'Pavian Exchange — Approve in Supabase dashboard' }
                }]
            })
        }).catch(err => console.warn('Discord webhook failed:', err));

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
    ncMap.setView([-8168, -3163], -1);

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

        // --- Signage / Shopchests toggle (admin/surveyor) ---
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
                });
            }
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
                            color: (compliance && !compliance.compliant) ? 'rgba(224,64,64,0.7)' : 'rgba(255,255,255,0.5)',
                            weight: (compliance && !compliance.compliant) ? 2 : 1
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
    if (prop.image_url) {
        h += `<div class="nc-popup-img-wrap"><img src="${prop.image_url}" alt="">`;
        if (canEdit) h += `<div class="nc-popup-img-actions"><button class="nc-popup-img-action nc-popup-img-change" title="Change image">&#x270E;</button><button class="nc-popup-img-action nc-popup-img-remove" title="Remove image">&times;</button></div>`;
        h += `</div>`;
    } else if (canEdit) {
        h += `<div class="nc-popup-img-zone" data-pi="${pi}"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><span class="nc-popup-img-hint">Click here &amp; paste (Ctrl+V)</span><div class="nc-popup-img-status"></div></div>`;
    }

    // Title
    h += `<div class="nc-popup-body">`;
    if (canEdit) {
        h += `<h3 class="nc-popup-editable" data-pi="${pi}" data-field="name" title="Click to edit">${prop.name || 'Unnamed Property'}</h3>`;
    } else {
        h += `<h3 class="nc-popup-copyable" data-copy="${esc(prop.name)}" title="Click to copy">${prop.name || 'Unnamed Property'}</h3>`;
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
        h += `<div class="nc-prop-detail"><span>Address</span><span class="value nc-popup-editable" data-pi="${pi}" data-field="address" title="Click to edit">${prop.address || ''}</span></div>`;
    } else if (prop.address) {
        h += `<div class="nc-prop-detail"><span>Address</span><span class="value">${prop.address}</span></div>`;
    }
    if (prop.owner) h += `<div class="nc-prop-detail"><span>Owner</span><span class="value nc-popup-copyable" data-copy="${esc(prop.owner)}" title="Click to copy">${prop.owner}</span></div>`;
    if (prop.tenant) h += `<div class="nc-prop-detail"><span>Tenant</span><span class="value">${prop.tenant}</span></div>`;
    if (prop.discord_contact) h += `<div class="nc-prop-detail"><span>Discord</span><span class="value nc-popup-copyable" data-copy="${esc(prop.discord_contact)}" title="Click to copy">${prop.discord_contact}</span></div>`;
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

    if (prop.last_surveyed) h += `<div class="nc-prop-detail"><span>Surveyed</span><span class="value">${fmtDate(prop.last_surveyed)}</span></div>`;
    if (prop.sale_link) h += `<div style="margin-top: 0.3rem;"><a href="${prop.sale_link}" target="_blank" rel="noopener" style="color: #a8d4a0; font-size: 0.8rem; text-decoration: none; border-bottom: 1px solid rgba(168,212,160,0.3);">View Listing</a></div>`;

    // Actions
    h += `<div class="nc-popup-actions">`;
    h += `<button class="nc-popup-edit-btn" onclick="ncEditPropertyInTable(${pi})">Edit in Table</button>`;
    h += `<button class="nc-popup-edit-btn nc-popup-txn-btn" data-pi="${pi}">Transaction Log</button>`;
    h += `<button class="nc-popup-edit-btn nc-popup-log-btn" data-pi="${pi}">Surveyor's Log</button>`;
    h += `<button class="nc-popup-edit-btn nc-popup-fine-btn" data-pi="${pi}">Fine Log</button>`;
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
        const markerBorder = (compliance && !compliance.compliant) ? 'rgba(224,64,64,0.7)' : 'rgba(255,255,255,0.5)';
        const markerWeight = (compliance && !compliance.compliant) ? 2 : 1;
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

        marker.bindPopup(buildPopupHTML(prop, ncCanEdit(), pi), { maxWidth: 580, minWidth: 440, autoPan: false, className: 'nc-leaflet-popup' });
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
                <div class="nc-panel-card-name">${prop.name || 'Unnamed'}</div>
                <span class="nc-panel-card-coords">${prop.x}, ${prop.z}</span>
            </div>
            <div class="nc-panel-card-mid">
                ${prop.type ? `<span class="nc-panel-card-type" style="background:${tc};">${prop.type}</span>` : ''}
                ${prop.status ? `<span class="nc-panel-card-status" style="background:${sc};">${prop.status}</span>` : ''}
            </div>
            <div class="nc-panel-card-bottom">
                <div class="nc-panel-card-addr">${prop.address || ''}</div>
                ${prop.owner ? `<span class="nc-panel-card-owner">${prop.owner}</span>` : ''}
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

    const marker = ncMarkers[index];
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
        // Check text search
        const s = [p.name, p.owner, p.type, p.address, p.status].filter(Boolean).join(' ').toLowerCase();
        const match = !q || s.includes(q);
        if (match) {
            if (!ncMap.hasLayer(marker)) marker.addTo(ncMap);
            visibleIndices.add(String(i));
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
        // Clear status + unoccupied + compliance filters
        ncFilterStatus = null;
        ncFilterUnoccupied = false;
        ncFilterNonCompliant = false;
        document.querySelectorAll('#ncStatusLegend .nc-legend-item.active').forEach(el => el.classList.remove('active'));
        const uf = document.getElementById('ncUnoccupiedFilter');
        if (uf) { uf.classList.remove('active'); uf.textContent = 'Hide Occupied'; }
        const cf = document.getElementById('ncComplianceFilter');
        if (cf) cf.classList.remove('active');
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
    // Clear type, status, and compliance filters
    ncFilterType = null;
    ncFilterStatus = null;
    ncFilterNonCompliant = false;
    document.querySelectorAll('#ncLegend .nc-legend-item[data-type].active').forEach(e => e.classList.remove('active'));
    document.querySelectorAll('#ncStatusLegend .nc-legend-item.active').forEach(e => e.classList.remove('active'));
    const cf = document.getElementById('ncComplianceFilter');
    if (cf) cf.classList.remove('active');
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
        // Clear type + unoccupied + compliance filters
        ncFilterType = null;
        ncFilterUnoccupied = false;
        ncFilterNonCompliant = false;
        document.querySelectorAll('#ncLegend .nc-legend-item.active').forEach(el => el.classList.remove('active'));
        const uf = document.getElementById('ncUnoccupiedFilter');
        if (uf) { uf.classList.remove('active'); uf.textContent = 'Hide Occupied'; }
        const cf2 = document.getElementById('ncComplianceFilter');
        if (cf2) cf2.classList.remove('active');
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
    el.classList.toggle('active', ncFilterNonCompliant);
    filterNCMarkers('');
});

// Show All buttons
document.getElementById('ncTypeShowAll').addEventListener('click', () => {
    ncFilterType = null;
    ncFilterStatus = null;
    ncFilterUnoccupied = false;
    ncFilterNonCompliant = false;
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
    document.getElementById('ncSearchInput').value = '';
    document.querySelectorAll('.nc-legend-item.active').forEach(el => el.classList.remove('active'));
    const uf2 = document.getElementById('ncUnoccupiedFilter');
    if (uf2) { uf2.classList.remove('active'); uf2.textContent = 'Hide Occupied'; }
    filterNCMarkers('');
});

// Table view
let ncTableSort = { col: null, asc: true };
const NC_TABLE_COLS = ['name', 'address', 'owner', 'discord_contact', 'hs_account', 'trust_deposit', 'appraised_value', 'tenant', 'type', 'status', 'signage', 'shopchests', 'last_surveyed', 'x', 'z'];
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
        const labels = { name: 'Name', address: 'Address', owner: 'Owner', tenant: 'Tenant', discord_contact: 'Discord', hs_account: 'Bank', trust_deposit: 'Trust', appraised_value: 'Value', type: 'Type', status: 'Status', signage: 'Signage', shopchests: 'Shopchests', last_surveyed: 'Surveyed', x: 'X', z: 'Z' };
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
        const txnTh = document.createElement('th'); txnTh.textContent = 'Txn'; thead.appendChild(txnTh);
        const logTh = document.createElement('th'); logTh.textContent = 'Log'; thead.appendChild(logTh);
        const fineTh = document.createElement('th'); fineTh.textContent = 'Fine'; thead.appendChild(fineTh);
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
        tr.innerHTML = `
            <td><button class="nc-table-locate" title="Show on map"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="10" r="3"/><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg></button></td>
            <td data-field="name"${vis('name')}>${prop.name || 'Unnamed'}</td>
            <td data-field="address"${vis('address')}>${prop.address || ''}</td>
            <td data-field="owner"${vis('owner')}>${prop.owner || ''}</td>
            <td data-field="discord_contact"${vis('discord_contact')}>${prop.discord_contact || ''}</td>
            <td data-field="hs_account"${vis('hs_account')}>${prop.hs_account || ''}</td>
            <td data-field="trust_deposit"${vis('trust_deposit')}>${(prop.type === 'Commercial') ? ((prop.trust_deposit === -1) ? '<span style="color:var(--text-muted);font-style:italic;">Waived</span>' : `<span style="color:${(prop.trust_deposit ?? 0) >= 50 ? '#4caf50' : (prop.trust_deposit ?? 0) > 0 ? '#e6a817' : '#e04040'}">${prop.trust_deposit ?? 0}d</span>`) : '<span style="color:var(--text-muted);">—</span>'}</td>
            <td data-field="appraised_value"${vis('appraised_value')}>${prop.appraised_value != null ? prop.appraised_value : ''}</td>
            <td data-field="tenant"${vis('tenant')}>${prop.tenant || ''}</td>
            <td data-field="type"${vis('type')}>${prop.type ? `<span class="nc-table-type" style="background:${tc};">${prop.type}</span>` : ''}</td>
            <td data-field="status"${vis('status')}>${prop.status ? `<span class="nc-status-badge" style="background:${sc};">${prop.status}</span>` : ''}</td>
            <td data-field="signage"${vis('signage')}><span class="nc-binary-icon">${signIcon}</span></td>
            <td data-field="shopchests"${vis('shopchests')}><span class="nc-binary-icon">${shopIcon}</span></td>
            <td data-field="last_surveyed"${vis('last_surveyed')}>${fmtDate(prop.last_surveyed)}</td>
            <td data-field="x"${vis('x')}>${prop.x}</td>
            <td data-field="z"${vis('z')}>${prop.z}</td>
            <td class="nc-img-cell">${prop.image_url ? '<span class="nc-has-img" title="Has image">&#x1f5bc;</span>' : '<span class="nc-no-img">—</span>'}</td>
            <td><button class="nc-table-log nc-table-txn" data-prop-idx="${i}" title="Transaction Log">Txn</button></td>
            <td><button class="nc-table-log" data-prop-idx="${i}" title="Surveyor's Log">Log</button></td>
            <td><button class="nc-table-log nc-table-fine" data-prop-idx="${i}" title="Fine Log">Fine</button></td>
            <td>${(() => { const c = ncGetCompliance(prop); return c ? (c.compliant ? '<span title="Compliant" style="color:#4caf50;">\u2705</span>' : '<span title="Non-Compliant (' + c.passed + '/' + c.total + ')" style="color:#e04040;">\u274C</span>') : '<span style="color:var(--text-muted);">—</span>'; })()}</td>
        `;

        // Locate button
        tr.querySelector('.nc-table-locate').addEventListener('click', (e) => {
            e.stopPropagation();
            document.getElementById('ncTableOverlay').classList.remove('open');
            const card = document.querySelectorAll('.nc-panel-card:not(.nc-clone)')[i];
            if (card) highlightNCProperty(i, card);
        });

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
                if (field === 'signage' || field === 'shopchests') {
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
                desc = `<em style="color:var(--text);">${log.new_value}</em>`;
            } else {
                desc = `<strong>${field}</strong> changed`;
                if (log.old_value) desc += ` from <span class="nc-log-old">${log.old_value}</span>`;
                desc += ` to <span class="nc-log-new">${log.new_value || '(empty)'}</span>`;
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
                    <span class="nc-log-user">${log.changed_by_name || 'Unknown'}</span>
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
            let html = `<div class="nc-log-meta"><span class="nc-log-date">${date}</span><span class="nc-log-user">${txn.recorded_by_name || 'Unknown'}</span></div>`;
            html += `<div class="nc-txn-detail"><span class="lbl">Seller</span> ${txn.seller || '—'}</div>`;
            html += `<div class="nc-txn-detail"><span class="lbl">Buyer</span> ${txn.buyer || '—'}</div>`;
            html += `<div class="nc-txn-detail"><span class="lbl">Broker</span> ${txn.broker || '—'}</div>`;
            html += `<div class="nc-txn-detail"><span class="lbl">Amount</span> <span class="nc-txn-amount">${txn.amount != null ? txn.amount + 'd' : '—'}</span></div>`;
            if (txn.new_name) html += `<div class="nc-txn-detail"><span class="lbl">Renamed</span> ${txn.new_name}</div>`;
            if (txn.notes) html += `<div class="nc-txn-notes">${txn.notes}</div>`;
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
        // Initialize trust deposit for new owner of commercial/mixed-use properties (60d deposit - 10d fee = 50d)
        if (prop.type === 'Commercial') {
            updates.trust_deposit = 50;
        }

        await fetch(`${CONFIG.supabaseUrl}/rest/v1/nc_properties?id=eq.${prop.id}`, {
            method: 'PATCH', headers: restHeaders(), body: JSON.stringify(updates)
        });

        // Log the changes in surveyor's log too
        const changes = [];
        if (prop.owner !== buyer) changes.push({ field: 'owner', oldVal: prop.owner, newVal: buyer });
        if (prop.appraised_value !== amount) changes.push({ field: 'appraised_value', oldVal: prop.appraised_value, newVal: amount });
        if (rename && rename !== prop.name) changes.push({ field: 'name', oldVal: prop.name, newVal: rename });
        if ((prop.type === 'Commercial') && prop.trust_deposit !== 50) {
            changes.push({ field: 'trust_deposit', oldVal: prop.trust_deposit, newVal: 50 });
        }
        if (changes.length > 0) ncLogMultipleChanges(prop.id, changes);

        // Update local data
        prop.owner = buyer;
        prop.appraised_value = amount;
        if (rename) prop.name = rename;
        if (prop.type === 'Commercial') prop.trust_deposit = 50;

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
            let html = `<div class="nc-log-meta"><span class="nc-log-date">${date}</span> <span class="nc-fine-status ${statusClass}">${fine.status || 'pending'}</span><span class="nc-log-user">${fine.issued_by_name || ''}</span></div>`;
            html += `<div class="nc-txn-detail"><span class="lbl">Amount</span> <span style="color:#d4a0a0;font-weight:500;">${fine.amount}d</span></div>`;
            if (fine.reason) html += `<div class="nc-txn-detail"><span class="lbl">Reason</span> ${fine.reason}</div>`;
            if (fine.reporter) {
                html += `<div class="nc-txn-detail"><span class="lbl">Reporter</span> ${fine.reporter}</div>`;
                if (fine.bounty_amount) html += `<div class="nc-fine-bounty">Bounty: ${fine.bounty_amount}d</div>`;
            }
            if (fine.notes) html += `<div class="nc-txn-notes">${fine.notes}</div>`;
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
            // Deduct from trust_deposit (skip if waived)
            const oldTrust = prop.trust_deposit ?? 0;
            if (oldTrust !== -1) {
                const newTrust = Math.max(0, oldTrust - amount);
                await fetch(`${CONFIG.supabaseUrl}/rest/v1/nc_properties?id=eq.${prop.id}`, {
                    method: 'PATCH', headers: restHeaders(),
                    body: JSON.stringify({ trust_deposit: newTrust, updated_at: new Date().toISOString() })
                });
                ncLogChange(prop.id, 'trust_deposit', oldTrust, newTrust);
                prop.trust_deposit = newTrust;
            }
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

// Column visibility toggle popup
document.getElementById('ncColToggleBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const popup = document.getElementById('ncColPopup');
    popup.classList.toggle('open');
    if (popup.classList.contains('open')) {
        popup.innerHTML = '';
        const labels = { name: 'Name', address: 'Address', owner: 'Owner', tenant: 'Tenant', discord_contact: 'Discord', appraised_value: 'Value', type: 'Type', status: 'Status', last_surveyed: 'Surveyed', x: 'X', z: 'Z' };
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
        const logFields = ['name', 'address', 'owner', 'tenant', 'discord_contact', 'appraised_value', 'trust_deposit', 'type', 'status', 'signage', 'shopchests', 'hs_account', 'last_surveyed', 'x', 'z', 'image_url'];
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
                    signage: prop.signage || false, shopchests: prop.shopchests || false,
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

// ============================================
// Init — Session bootstrap (replaces Supabase Auth)
// ============================================
(async function init() {
    const url = new URL(window.location.href);
    const tokenParam = url.searchParams.get('token');
    let authRedirect = null;

    // Pick up JWT from Worker callback
    if (tokenParam) {
        localStorage.setItem('mf_token', tokenParam);
        authRedirect = url.searchParams.get('redirect') || '/new-callisto';
        url.searchParams.delete('token');
        url.searchParams.delete('redirect');
        url.searchParams.delete('auth_error');
        const cleanUrl = url.pathname + (url.search || '') + url.hash;
        history.replaceState(null, '', cleanUrl || '/');
    }

    // Check for auth error from Worker
    const authError = url.searchParams.get('auth_error');
    if (authError) {
        console.error('Auth error:', authError);
        url.searchParams.delete('auth_error');
        history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
    }

    // Load existing token from storage
    const token = localStorage.getItem('mf_token');
    if (token) {
        const payload = parseJWT(token);
        if (payload) {
            currentAccessToken = token;
            currentUser = {
                id: payload.sub,
                user_metadata: payload.user_metadata || {}
            };
        } else {
            // Token expired or invalid
            localStorage.removeItem('mf_token');
        }
    }

    // Handle SPA redirect from 404.html
    const spaRedirect = sessionStorage.getItem('redirect');
    if (spaRedirect) {
        sessionStorage.removeItem('redirect');
        if (!authRedirect) {
            history.replaceState(null, '', spaRedirect);
        }
    }

    // Auth callback redirect takes priority
    if (authRedirect) {
        history.replaceState(null, '', authRedirect);
    }

    // Load admin status + profile if logged in
    if (currentUser) {
        await checkAdmin();
        await loadProfile();
    }

    updateAuthUI();
    navigate();
})();
