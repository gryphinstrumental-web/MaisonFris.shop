// ============================================
// Pavian Exchange — App JavaScript
// ============================================

// Configuration
const CONFIG = {
    supabaseUrl: 'https://ubuypxqueqxvugstmtkx.supabase.co',
    supabaseKey: 'sb_publishable_ndTGBxW3c2bOdMzgOVvy7w_9py3MLUs',
    discordWebhook: 'https://discord.com/api/webhooks/1472730251372003474/aWcIylD6Ew7gOI1KyCLToj8aQfd7hsDJ8YqUdxniBmxSFaa_YwGAQKqwZH-gQEPLUv7Y'
};

// Initialize Supabase
const sb = supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce'
    }
});

let currentUser = null;
let isAdmin = false;

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
    const views = document.querySelectorAll('.view');
    views.forEach(v => v.classList.remove('active'));

    if (path === '/orderbook') {
        document.getElementById('orderbookView').classList.add('active');
        document.body.classList.remove('landing');
        loadEquities();
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
// SPA Redirect (from 404.html)
// ============================================
const isAuthCallback = window.location.search.includes('code=') || window.location.hash.includes('access_token');
const redirectPath = sessionStorage.getItem('redirect');

if (redirectPath) {
    sessionStorage.removeItem('redirect');
    if (!isAuthCallback) {
        history.replaceState(null, '', redirectPath);
    }
}

// ============================================
// Auth
// ============================================
async function checkAdmin() {
    if (!currentUser) { isAdmin = false; return; }
    const { data } = await sb.from('profiles').select('is_admin').eq('id', currentUser.id).single();
    isAdmin = data?.is_admin || false;
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
    if (window.location.pathname === '/orderbook') loadEquities();
}

async function loginWithDiscord() {
    const { error } = await sb.auth.signInWithOAuth({
        provider: 'discord',
        options: {
            redirectTo: window.location.origin
        }
    });
    if (error) console.error('Login error:', error);
}

async function logoutUser() {
    await sb.auth.signOut();
    currentUser = null;
    isAdmin = false;
    updateAuthUI();
}

// Single source of truth: onAuthStateChange handles everything —
// initial session load, OAuth callback, and sign-out.
let authResolved = false;

sb.auth.onAuthStateChange(async (event, session) => {
    console.log('Auth event:', event, session ? 'has session' : 'no session');

    const isFirstEvent = !authResolved;
    authResolved = true;

    currentUser = session?.user || null;

    // Navigate IMMEDIATELY so the page isn't blank while we check admin
    if (isFirstEvent) {
        if (event === 'SIGNED_IN' && isAuthCallback) {
            history.replaceState(null, '', '/orderbook');
        }
        navigate();
    } else if (event === 'SIGNED_IN' && isAuthCallback) {
        history.replaceState(null, '', '/orderbook');
        navigate();
    }

    // Check admin + update UI after navigation (re-renders with admin controls if needed)
    try {
        await checkAdmin();
    } catch (e) {
        console.error('checkAdmin failed:', e);
        isAdmin = false;
    }

    updateAuthUI();
});

// Safety net: if onAuthStateChange never fires, navigate after 3s
setTimeout(() => {
    if (!authResolved) {
        console.warn('Auth did not resolve in time, navigating anyway');
        authResolved = true;
        navigate();
    }
}, 3000);

// ============================================
// Load Equities
// ============================================
async function loadEquities() {
    const equityData = document.getElementById('equityData');

    try {
        console.log('Loading equities...');
        const { data: equities, error: eqError } = await sb
            .from('equities')
            .select('*')
            .eq('is_active', true)
            .order('ticker');

        console.log('Equities response:', equities?.length ?? 'null', eqError || 'no error');
        if (eqError) throw eqError;

        let obQuery = sb.from('order_book').select('*');
        if (!isAdmin) obQuery = obQuery.gt('quantity_available', 0);
        const { data: orderBook, error: obError } = await obQuery;

        if (obError) throw obError;

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

            // Build bid (sell) offers HTML
            let bidHTML = '';
            if (isAdmin) {
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
                            <span class="offer-info"><span class="price">$${Number(e.price)}</span><span class="qty">${e.quantity_available} shares</span></span>
                            <button onclick='openOrderForm("SELL", "${eq.ticker}", ${tiers}, ${eq.id})'>Sell</button>
                        </div>`;
                });
            } else {
                bidHTML = '<span class="book-empty">No bids</span>';
            }

            // Build ask (buy) offers HTML
            let askHTML = '';
            if (isAdmin) {
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
                            <span class="offer-info"><span class="price">$${Number(e.price)}</span><span class="qty">${e.quantity_available} shares</span></span>
                            <button onclick='openOrderForm("BUY", "${eq.ticker}", ${tiers}, ${eq.id})'>Buy</button>
                        </div>`;
                });
            } else {
                askHTML = '<span class="book-empty">No asks</span>';
            }

            const showBody = isAdmin || !isUnavailable;

            html += `
                <div class="equity-card ${isUnavailable && !isAdmin ? 'unavailable' : ''}" data-ticker="${eq.ticker.toLowerCase()}" data-company="${eq.company_name.toLowerCase()}" data-equity-id="${eq.id}">
                    <div class="equity-card-header">
                        <span class="ticker-display">${eq.ticker}</span>
                        <span class="company-name">${eq.company_name}</span>
                    </div>
                    ${!showBody ? '<div class="unavailable-label">Not currently traded</div>' : `
                    <div class="equity-card-body">
                        <div class="book-side bid">
                            <div class="book-side-label">Bid</div>
                            ${bidHTML}
                        </div>
                        <div class="book-side ask">
                            <div class="book-side-label">Ask</div>
                            ${askHTML}
                        </div>
                    </div>
                    ${isAdmin ? `<div class="admin-actions" style="padding: 0 2rem 1rem; justify-content: center;">
                        <button class="admin-edit-btn save" onclick="adminSaveCard(${eq.id})">Save Changes</button>
                    </div>` : ''}`}
                </div>
            `;
            cardCount++;
        });

        html += '</div>'; // close carousel-stage
        html += '<button class="carousel-arrow" id="arrowRight" onclick="carouselNext()">&gt;</button>';
        html += '</div>'; // close carousel-wrapper

        equityData.innerHTML = html;

        carouselIndex = 0;
        updateCarousel();

    } catch (error) {
        console.error('Error loading equities:', error);
        equityData.innerHTML = '<p class="loading">Error loading equities. Please check console for details.</p>';
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
    const allCards = document.querySelectorAll('.equity-card');
    allCards.forEach(c => c.classList.remove('active-card'));

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

function carouselPrev() {
    carouselIndex--;
    updateCarousel();
}

function carouselNext() {
    carouselIndex++;
    updateCarousel();
}

// Keyboard navigation
document.addEventListener('keydown', (e) => {
    if (window.location.pathname !== '/orderbook') return;
    if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') carouselPrev();
    if (e.key === 'ArrowRight') carouselNext();
});

// Touch swipe
let touchStartX = 0;
document.addEventListener('touchstart', (e) => {
    if (window.location.pathname !== '/orderbook') return;
    touchStartX = e.touches[0].clientX;
}, { passive: true });

document.addEventListener('touchend', (e) => {
    if (window.location.pathname !== '/orderbook') return;
    const diff = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) {
        if (diff > 0) carouselNext();
        else carouselPrev();
    }
});

// Search
document.getElementById('searchInput').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const cards = document.querySelectorAll('.equity-card');

    cards.forEach(card => {
        const ticker = card.dataset.ticker || '';
        const company = card.dataset.company || '';
        const match = !query || ticker.includes(query) || company.includes(query);
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
    if (!currentUser) {
        loginWithDiscord();
        return;
    }

    const availableTiers = type === 'BUY' ? tiers.buy : tiers.sell;
    if (availableTiers.length === 0) return;

    currentOrder = { type, ticker, tiers: availableTiers, equityId };

    const orderTitle = document.getElementById('orderTitle');
    const orderSummary = document.getElementById('orderSummary');

    orderTitle.textContent = `${type} ${ticker}`;

    let tierHTML = '<p style="margin-bottom: 1rem;"><span class="label">Select Price Tier:</span></p>';
    availableTiers.forEach((tier, index) => {
        const isFirst = index === 0;
        tierHTML += `
            <div style="margin-bottom: 0.75rem;">
                <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 0.75rem; background: rgba(255,255,255,0.05); border-radius: 4px; border: 2px solid ${isFirst ? 'var(--accent)' : 'transparent'};" id="tierLabel${index}">
                    <input type="radio" name="tier" value="${index}" ${isFirst ? 'checked' : ''} style="width: auto; cursor: pointer;" onchange="updateOrderTier(${index})">
                    <span style="flex: 1;">
                        <strong style="color: var(--text);">${tier.qty} shares</strong> @
                        <strong style="color: ${type === 'BUY' ? '#a8d4a0' : '#d4a0a0'};">$${tier.price}</strong> each
                    </span>
                </label>
            </div>
        `;
    });

    orderSummary.innerHTML = tierHTML;
    updateOrderTier(0);
    orderModal.classList.add('active');
}

function updateOrderTier(tierIndex) {
    const tier = currentOrder.tiers[tierIndex];
    currentOrder.selectedTier = tier;
    currentOrder.selectedTierIndex = tierIndex;

    currentOrder.tiers.forEach((_, index) => {
        const label = document.getElementById(`tierLabel${index}`);
        if (label) {
            label.style.borderColor = index === tierIndex ? 'var(--accent)' : 'transparent';
        }
    });

    const qtyInput = document.getElementById('quantity');
    const maxQtyLabel = document.getElementById('maxQtyLabel');
    if (qtyInput) {
        qtyInput.max = tier.qty;
        qtyInput.value = Math.min(qtyInput.value || 1, tier.qty);
    }
    if (maxQtyLabel) {
        maxQtyLabel.textContent = `(max ${tier.qty})`;
    }
}

function validateQuantity() {
    const qtyInput = document.getElementById('quantity');
    if (!currentOrder.selectedTier) return;
    const qty = parseInt(qtyInput.value);
    if (qty > currentOrder.selectedTier.qty) qtyInput.value = currentOrder.selectedTier.qty;
    if (qty < 1) qtyInput.value = 1;
}

// Cancel order
document.getElementById('cancelOrder').addEventListener('click', () => {
    orderModal.classList.remove('active');
    document.getElementById('orderForm').reset();
});

// Submit order
document.getElementById('orderForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const ign = document.getElementById('minecraftIGN').value;
    const quantity = document.getElementById('quantity').value;
    const notes = document.getElementById('notes').value;

    if (!currentOrder.selectedTier) {
        alert('Please select a price tier');
        return;
    }

    if (parseInt(quantity) > currentOrder.selectedTier.qty) {
        alert(`Maximum quantity for this tier is ${currentOrder.selectedTier.qty} shares`);
        return;
    }

    const total = (parseFloat(currentOrder.selectedTier.price) * parseFloat(quantity)).toFixed(2);
    const discordName = currentUser?.user_metadata?.full_name || currentUser?.user_metadata?.name || 'Unknown';

    try {
        // Insert order into Supabase
        const { data: order, error: orderError } = await sb
            .from('orders')
            .insert({
                user_id: currentUser.id,
                equity_id: currentOrder.equityId,
                side: currentOrder.type.toLowerCase(),
                price: currentOrder.selectedTier.price,
                quantity: parseInt(quantity),
                minecraft_ign: ign,
                notes: notes || null
            })
            .select()
            .single();

        if (orderError) throw orderError;

        // Also send Discord notification
        const payload = {
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
                    { name: 'Minecraft IGN', value: ign, inline: true },
                    { name: 'Notes', value: notes || 'None', inline: false }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: 'Pavian Exchange — Approve in Supabase dashboard' }
            }]
        };

        fetch(CONFIG.discordWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).catch(err => console.warn('Discord webhook failed:', err));

        alert('Order submitted! You will be notified via Discord when it is approved.');
        orderModal.classList.remove('active');
        document.getElementById('orderForm').reset();

    } catch (error) {
        console.error('Error submitting order:', error);
        alert('Error submitting order. Please try again.');
    }
});

// Close order modal when clicking outside
orderModal.addEventListener('click', (e) => {
    if (e.target === orderModal) {
        orderModal.classList.remove('active');
        document.getElementById('orderForm').reset();
    }
});

// ============================================
// Admin Functions
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
            const { error } = await sb.from('order_book').update(data).eq('id', parseInt(id));
            if (error) throw error;
        }
        const btn = card.querySelector('.admin-edit-btn.save');
        if (btn) {
            btn.textContent = 'Saved!';
            setTimeout(() => { btn.textContent = 'Save Changes'; }, 1500);
        }
    } catch (err) {
        console.error('Admin save error:', err);
        alert('Error saving changes: ' + err.message);
    }
}

async function adminAddTier(equityId, side) {
    if (!isAdmin) return;

    const { data: existing } = await sb.from('order_book')
        .select('tier')
        .eq('equity_id', equityId)
        .eq('side', side)
        .order('tier', { ascending: false })
        .limit(1);

    const nextTier = existing && existing.length > 0 ? existing[0].tier + 1 : 1;

    try {
        const { error } = await sb.from('order_book').insert({
            equity_id: equityId,
            side: side,
            price: 0,
            quantity_available: 0,
            tier: nextTier
        });
        if (error) throw error;
    } catch (err) {
        console.error('Add tier error:', err);
        alert('Error adding tier: ' + err.message);
    }
}

async function adminRemoveTier(bookId) {
    if (!isAdmin) return;
    if (!confirm('Remove this tier?')) return;

    try {
        const { error } = await sb.from('order_book').delete().eq('id', bookId);
        if (error) throw error;
    } catch (err) {
        console.error('Remove tier error:', err);
        alert('Error removing tier: ' + err.message);
    }
}
