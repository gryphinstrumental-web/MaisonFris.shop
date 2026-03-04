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
