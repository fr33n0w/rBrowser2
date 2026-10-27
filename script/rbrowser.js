/*
 * rBrowser front-end.
 *
 * Lifted out of templates/index.html so the browser can cache it instead
 * of re-parsing ~150 KB of inline script on every page load, and so Flask
 * stops pushing it through the template renderer each time.
 * The <script> tag stays where the inline block was and carries no defer
 * or async, so execution order is unchanged.
 */

// Access password (Settings > System): a call answered 401 means the
// session is gone (password changed, or switched on from another browser):
// back to the login page, once.
(function watchAuth() {
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
        const response = await original(...args);
        if (response.status === 401 && !window.__rbToLogin) {
            const url = String(args[0] && args[0].url || args[0] || '');
            if (url.startsWith('/api/') || url.includes(location.host + '/api/')) {
                window.__rbToLogin = true;
                location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
            }
        }
        // Guest mode: a change refused by the server says so (once every few
        // seconds; reads refused, like the messenger's polling, stay quiet,
        // and so do the preferences this browser keeps for itself).
        if (response.status === 403 && window.rbGuest) {
            const url = String(args[0] && args[0].url || args[0] || '');
            const method = String((args[1] && args[1].method) || (args[0] && args[0].method) || 'GET').toUpperCase();
            if (method !== 'GET' && !/\/api\/(ui-prefs|sounds)\b/.test(url)
                && Date.now() - (window.__rbGuestNoteAt || 0) > 4000 && typeof showNotification === 'function') {
                window.__rbGuestNoteAt = Date.now();
                response.clone().json().then(d => showNotification(escapeHtml(d.error || 'Guest mode: read only'), 'warning', 4000))
                    .catch(() => {});
            }
        }
        return response;
    };
})();

// Guest mode (Settings > Guest mode): who this session is. A guest reads
// the settings but cannot change them; the server refuses the rest anyway.
window.rbGuest = null;
(function readRole() {
    try {
        // Written into the page by the server (routes.py render_index).
        const st = JSON.parse(document.getElementById('rb-auth').textContent || '{}');
        if (st.role === 'guest') window.rbGuest = st.guest || {};
    } catch (e) {}
    if (!window.rbGuest) return;
    const mark = () => {
        document.body.classList.add('guest-mode');
        if (!window.rbGuest.messenger) document.body.classList.add('guest-no-lxmf');
        const row = document.querySelector('.status-bar .sb-row');
        if (row && !document.getElementById('sb-guest')) {
            const tag = document.createElement('span');
            tag.id = 'sb-guest';
            tag.className = 'sb-guest';
            tag.innerHTML = 'Guest · read only <a href="/logout" title="Log out, to log in again with the owner password">log in as owner</a>';
            row.appendChild(tag);
        }
    };
    if (document.body) mark(); else document.addEventListener('DOMContentLoaded', mark);
})();

// The page's preferences live on the server, in settings/ui_prefs.json, not
// only in this browser: localStorage is per browser and per address, so a
// phone, Firefox or another port each had their own settings.
// Read once, before anything else reads localStorage (written into the
// page by the server, routes.py render_index); every later change of
// one of these keys is written to the file at once. Kept local: what
// belongs to this screen (sidebar width, page zoom, open windows).
(function syncPrefsWithServer() {
    const LOCAL_ONLY = /^rbrowser_(app_alive_|page_zoom_factor$|sidebar_width$|sidebar_collapsed$|list_collapsed_|settings_category$)/;
    const synced = key => typeof key === 'string' && key.startsWith('rbrowser_') && !LOCAL_ONLY.test(key);
    let store;
    try { store = window.localStorage; } catch (e) { return; }
    if (!store) return;
    let fromServer = null;
    try {
        const prefs = JSON.parse(document.getElementById('rb-ui-prefs').textContent);
        if (prefs && typeof prefs === 'object') fromServer = prefs;
    } catch (e) { /* not in the page: this browser's own values for now */ }
    const setItem = Storage.prototype.setItem;
    const removeItem = Storage.prototype.removeItem;
    let pending = {};
    let timer = null;
    if (fromServer) {
        // First run with the file: what this browser had goes to it.
        const mine = {};
        for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (synced(key) && !(key in fromServer)) mine[key] = store.getItem(key);
        }
        for (const [key, value] of Object.entries(fromServer)) {
            if (synced(key) && store.getItem(key) !== value) {
                try { setItem.call(store, key, value); } catch (e) { /* full: only the server has it */ }
            }
        }
        if (Object.keys(mine).length) queue(mine);
    }
    function queue(changes) {
        Object.assign(pending, changes);
        clearTimeout(timer);
        timer = setTimeout(() => {
            const body = JSON.stringify(pending);
            pending = {};
            fetch('/api/ui-prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
                                     keepalive: true }).catch(() => {});
        }, 150);
    }
    Storage.prototype.setItem = function (key, value) {
        setItem.call(this, key, value);
        if (this === store && synced(key)) queue({ [key]: String(value) });
    };
    Storage.prototype.removeItem = function (key) {
        removeItem.call(this, key);
        if (this === store && synced(key)) queue({ [key]: null });
    };
})();

// Browser-side preferences (zoom, sidebar, sort...) live in localStorage,
// which belongs to one origin: host AND port. When a restart from the
// settings page moves rBrowser to another port, the page hands them over in
// the URL fragment, and they are put back here - first thing, before any
// other code reads them. The fragment never reaches the server.
(function importPrefsAfterRestart() {
    const prefix = '#rb-prefs=';
    if (!location.hash.startsWith(prefix)) return;
    try {
        const prefs = JSON.parse(decodeURIComponent(atob(location.hash.slice(prefix.length))));
        for (const [key, value] of Object.entries(prefs || {})) {
            if (key.startsWith('rbrowser_') && typeof value === 'string') {
                localStorage.setItem(key, value);
            }
        }
    } catch (e) {
        console.warn('Could not import preferences after restart:', e);
    }
    history.replaceState(null, '', location.pathname + location.search);
})();

        let selectedNode = null;
        let currentRequest = null;
        let currentRawContent = '';
        let isRawView = false;
        let micronParser = null;
        let micronParserLight = null;      // the same, without one cell per character
        let isOriginalParser = false;
        let navigationHistory = [];
        let historyIndex = -1;
        let currentUrl = '';
        let cachedNodes = [];
        let favoriteNodes = [];
        let tabs = [];
        let activeTabId = null;
        let tabCounter = 0;
        let lastStatusFetch = 0;
        let statusFetchFailures = 0;
        let maxStatusFailures = 3; // Allow 3 failures before marking as connection error
        // Auto-reload system variables
        let autoReloadTimers = {}; // Store timers per tab
        let autoReloadSettings = {}; // Store settings per tab


// The page tabs' icon, a screen with lines of text (the BBS one before).
const NOMAD_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="9" rx="1"/><path d="M5 14h6M4.5 5.5h4M4.5 8h6"/></svg>';

// Reticulum's state for the empty tabs' dot (updateConnectionStatus).
let nomadNetState = 'closed';

class BrowserTab {
    constructor(id) {
        this.id = id;
        this.title = 'New Tab';
        this.url = '';
        this.loading = false;
        this.selectedNode = null;
        this.currentRequest = null;
        this.currentRawContent = '';
        this.isRawView = false;
        this.navigationHistory = [];
        this.historyIndex = -1;
        this.currentUrl = '';
        this.knownNodeName = null;
        this.autoReloadEnabled = false;
        this.autoReloadInterval = 60;
        this.autoReloadTimer = null;
        this.autoReloadCountdown = 0;
        this.notificationShown = false;
        this.savedFormData = {}; // Add this line
    }
    
    setTitle(title) {
        this.title = title || 'New Tab';
        this.updateTabDisplay();
    }

    setUrl(url) {
        this.url = url;
        this.currentUrl = url;
        this.updateAddressBar();
    }
    
    setLoading(loading) {
        this.loading = loading;
        if (loading) this.failed = false;      // a new load: the dot goes yellow, not red
        this.updateTabDisplay();
        // The reload button spins for as long as a page is on its way, so a
        // click on it (or on anything that loads) visibly did something.
        const reload = document.querySelector(`#${this.id} .reload-btn`);
        if (reload) reload.classList.toggle('is-loading', !!loading);
    }
    
    addToHistory(url) {
        if (url !== this.currentUrl) {
            this.navigationHistory = this.navigationHistory.slice(0, this.historyIndex + 1);
            this.navigationHistory.push(url);
            this.historyIndex = this.navigationHistory.length - 1;
            this.currentUrl = url;
            this.updateNavigationButtons();
        }
    }
    
    updateTabDisplay() {
        const tabElement = document.querySelector(`[data-tab-id="${this.id}"]`);
        if (tabElement) {
            const titleElement = tabElement.querySelector('.tab-title');
            // An empty tab is NomadNet, as the client tabs carry their name
            //; its dot is Reticulum's state, as in the status bar.
            const empty = !this.loading && !this.url && this.title === 'New Tab';
            titleElement.textContent = this.loading ? 'Loading...' : empty ? 'NomadNet' : this.title;
            tabElement.classList.toggle('loading', this.loading);
            tabElement.classList.toggle('tab-nomadnet-home', empty);
            // The page at a glance, as on the app tabs: loading (yellow), it
            // answered (green), error or unreachable (red).
            const state = this.loading ? 'connecting' : empty ? nomadNetState : !this.url ? '' : this.failed ? 'failed' : 'connected';
            let dot = tabElement.querySelector('.page-tab-state');
            let icon = tabElement.querySelector('.page-tab-icon');
            if (!state) { if (dot) dot.remove(); if (icon) icon.remove(); }
            else {
                // Dot, icon, title: as on the app tabs.
                if (!icon) {
                    icon = document.createElement('span');
                    icon.className = 'page-tab-icon';
                    icon.innerHTML = NOMAD_ICON;
                    tabElement.insertBefore(icon, dot ? dot.nextSibling : tabElement.firstChild);
                }
                if (!dot) { dot = document.createElement('span'); tabElement.insertBefore(dot, tabElement.firstChild); }
                dot.className = `bbs-state app-tab-state page-tab-state bbs-state-${state}`;
                dot.title = empty
                    ? { connected: 'Reticulum connected', connecting: 'Reticulum connecting…', failed: 'Reticulum not connected' }[state] || 'Reticulum'
                    : { connecting: 'Loading…', connected: 'The page answered', failed: 'Error: the page did not load' }[state];
            }
        }
        if (this.id === activeTabId) updateFullscreenBar();
    }
    
    updateAddressBar() {
        if (this.id === activeTabId) {
            const addressBar = document.querySelector(`#${this.id} .address-bar`);
            if (addressBar) {
                addressBar.value = this.url;
            }
            updateFullscreenBar();
        }
    }
    updateNavigationButtons() {
        if (this.id === activeTabId) {
            const backBtn = document.querySelector(`#${this.id} .back-btn`);
            const forwardBtn = document.querySelector(`#${this.id} .forward-btn`);
            
            if (backBtn) backBtn.disabled = this.historyIndex <= 0;
            if (forwardBtn) forwardBtn.disabled = this.historyIndex >= this.navigationHistory.length - 1;
        }
    }

    startAutoReload() {
        this.stopAutoReload();
        this.autoReloadEnabled = true;
        this.autoReloadCountdown = this.autoReloadInterval;
        this.notificationShown = false;
        
        this.autoReloadTimer = setInterval(() => {
            this.autoReloadCountdown--;
            
            // Only update button if this is the active tab
            if (this.id === activeTabId) {
                updateAutoReloadButton();
            }
            
            // Show notification 2 seconds before reload
            if (this.autoReloadCountdown === 2 && !this.notificationShown) {
                this.notificationShown = true;
                showNotification(
                    '⏱️ Auto-reloading page in 2 seconds...',
                    'info',
                    2000
                );
            }
            
            if (this.autoReloadCountdown <= 0) {
                this.autoReloadCountdown = this.autoReloadInterval;
                this.notificationShown = false;
                
                if (this.currentUrl) {
                    
                    // Show notification higher on the screen (stack position 1)
                    showNotification(
                        '🔄 Auto-reloading page now...',
                        'info',
                        1500,
                        1  // Stack position parameter - shows higher
                    );
                    
                    // Reload THIS specific tab, not the active one
                    this.reloadPage();
                }
            }
        }, 1000);
        
    }

    reloadPage() {
        if (!this.currentUrl) return;
        
        // Store the current view state before reloading
        const wasRawView = this.isRawView || false;
        
        // Save form data before reload
        this.saveFormData();
        
        // Temporarily switch to this tab to reload it
        const previousActiveTab = activeTabId;
        const needsSwitch = (this.id !== activeTabId);
        
        if (needsSwitch) {
            // Silently switch to this tab
            activeTabId = this.id;
        }
        
        // Not a visit: the node's visit count is what you opened yourself.
        this.skipVisitCount = true;

        // Perform the reload. A reload means "go and look again", so it
        // always goes to the node even when the page is in the cache -
        // otherwise auto-reload would be refreshing from the local disk.
        backgroundReload = true;
        try {
            navigateToUrlInternalTab(this.currentUrl, false, true);
        } finally {
            backgroundReload = false;
        }

        // Wait for content to load, then restore view state and form data
        setTimeout(() => {
            const content = document.querySelector(`#${this.id} .page-content`);
            const viewToggle = document.querySelector(`#${this.id} .view-toggle`);

            // Restore raw view if it was enabled
            if (wasRawView && this.currentRawContent && viewToggle) {
                content.innerHTML = escapeHtml(this.currentRawContent);
                content.className = 'page-content raw';
                setViewToggleLabel(viewToggle, true);
                this.isRawView = true;
            }
            
            // Store the view state back to the tab
            this.isRawView = wasRawView;
            
            // Restore form data immediately - no additional delay
            this.restoreFormDataFast();
            
            // Switch back to the previous tab if we switched
            if (needsSwitch) {
                activeTabId = previousActiveTab;
                
                // Update UI to show the correct active tab
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                
                const tabElement = document.querySelector(`[data-tab-id="${previousActiveTab}"]`);
                const contentElement = document.getElementById(previousActiveTab);
                
                if (tabElement && contentElement) {
                    tabElement.classList.add('active');
                    contentElement.classList.add('active');
                }
            }
        }, 300); // Reduced from 500ms to 300ms
    }    

    stopAutoReload() {
        if (this.autoReloadTimer) {
            clearInterval(this.autoReloadTimer);
            this.autoReloadTimer = null;
        }
        this.autoReloadEnabled = false;
        this.autoReloadCountdown = 0;
    }

    setAutoReloadInterval(seconds) {
        this.autoReloadInterval = seconds;
        if (this.autoReloadEnabled) {
            this.startAutoReload();
        }
    }
    
    saveFormData() {
        const formData = {};
        const inputs = document.querySelectorAll(`#${this.id} .page-content input, #${this.id} .page-content textarea`);
        
        inputs.forEach(input => {
            if (input.name || input.id) {
                const key = input.name || input.id;
                
                if (input.type === 'checkbox') {
                    formData[key] = {
                        type: 'checkbox',
                        checked: input.checked,
                        value: input.value
                    };
                } else if (input.type === 'radio') {
                    if (input.checked) {
                        formData[key] = {
                            type: 'radio',
                            value: input.value,
                            checked: true
                        };
                    }
                } else {
                    formData[key] = {
                        type: input.type || 'text',
                        value: input.value
                    };
                }
            }
        });
        
        this.savedFormData = formData;
        return formData;
    }

    restoreFormDataFast() {
        if (!this.savedFormData || Object.keys(this.savedFormData).length === 0) {
            return;
        }
        
        const content = document.querySelector(`#${this.id} .page-content`);
        if (!content) return;
        
        let restoredCount = 0;
        
        // Function to attempt restoration
        const attemptRestore = () => {
            for (const [key, data] of Object.entries(this.savedFormData)) {
                let input = null;
                
                // Try to find the input field
                input = document.querySelector(`#${this.id} .page-content input[name="${key}"]`) ||
                        document.querySelector(`#${this.id} .page-content textarea[name="${key}"]`) ||
                        document.querySelector(`#${this.id} .page-content input[id="${key}"]`) ||
                        document.querySelector(`#${this.id} .page-content textarea[id="${key}"]`);
                
                if (!input && data.placeholder) {
                    input = document.querySelector(`#${this.id} .page-content input[placeholder="${data.placeholder}"]`) ||
                            document.querySelector(`#${this.id} .page-content textarea[placeholder="${data.placeholder}"]`);
                }
                
                if (!input && key.startsWith('input_')) {
                    const index = parseInt(key.split('_')[1]);
                    const allInputs = document.querySelectorAll(`#${this.id} .page-content input, #${this.id} .page-content textarea`);
                    input = allInputs[index];
                }
                
                if (input && !input.dataset.restored) {
                    if (data.type === 'checkbox') {
                        input.checked = data.checked;
                        if (data.value) input.value = data.value;
                    } else if (data.type === 'radio') {
                        if (data.checked && input.value === data.value) {
                            input.checked = true;
                        }
                    } else {
                        input.value = data.value;
                    }
                    input.dataset.restored = 'true'; // Mark as restored
                    restoredCount++;
                }
            }
        };
        
        // Observe DOM changes and restore immediately when inputs appear
        const observer = new MutationObserver((mutations) => {
            attemptRestore();
            
            // Stop observing after successful restoration
            if (restoredCount >= Object.keys(this.savedFormData).length) {
                observer.disconnect();
                if (restoredCount > 0 && this.id === activeTabId) {
                    showNotification(
                        `✅ Restored ${restoredCount} form field${restoredCount > 1 ? 's' : ''}`,
                        'success',
                        2000,
                        2
                    );
                }
            }
        });
        
        observer.observe(content, {
            childList: true,
            subtree: true
        });
        
        // Also try immediate restoration
        attemptRestore();
        
        // Disconnect observer after 2 seconds as fallback
        setTimeout(() => observer.disconnect(), 2000);
    }

}

// TAB MANAGEMENT FUNCTIONS
function createNewTab() {
    const tabId = `tab-${++tabCounter}`;
    const tab = new BrowserTab(tabId);
    // End of the array as well as end of the bar, so Ctrl+Left/Right
    // walk the tabs in the order you actually see them.
    tabs.push(tab);
    
    createTabElement(tab);
    tab.updateTabDisplay();         // empty: "NomadNet", dot and icon
    createTabContent(tab);
    switchToTab(tabId);
    
    // Hide auto-reload button on new empty tabs
    setTimeout(() => {
        updateAutoReloadButton();
        updateAutoIdentifyButton();
    }, 100);

    // A new tab comes out of the template with default controls; bring them
    // in line with the preferences already in force.
    applySidebarState(document.body.classList.contains('sidebar-collapsed'));
    applyPageZoom();
    applyCenterPages(document.body.classList.contains('center-pages'));

    // The new tab has its own scroll area and hint element.
    initScrollHint(tab);

    return tab;
}

function createTabElement(tab) {
    const tabsContainer = document.getElementById('tabs-container');
    
    const tabElement = document.createElement('div');
    tabElement.className = 'tab';
    tabElement.setAttribute('data-tab-id', tab.id);
    tabElement.innerHTML = `
        <span class="tab-title">${escapeHtml(tab.title)}</span>
        <span class="tab-close" onclick="closeTab('${tab.id}', event)">&times;</span>
    `;
    
    tabElement.addEventListener('click', (e) => {
        if (!e.target.classList.contains('tab-close')) {
            // A click on a tab brings the node list back to its card, the
            // tab already active included (the list may have been scrolled).
            updateNodeSelection.lastShown = null;
            switchToTab(tab.id);
        }
    });
    
    // As in a desktop browser: new tabs go at the end of the pages, just
    // before the "+". With many tabs open the new one would land past the
    // edge of the bar, so the bar scrolls to show it.
    // The app icons (Messages, RRC, BBS, RMAP) and Settings come after "+".
    const newTabControl = document.getElementById('new-tab-control');
    const before = (newTabControl && newTabControl.parentNode === tabsContainer)
        ? newTabControl : null;
    tabsContainer.insertBefore(tabElement, before);
    tabsContainer.scrollLeft = tabsContainer.scrollWidth;
}

// Many tabs open: the strip has no scrollbar (it took height from the tabs),
// it scrolls with the mouse wheel and by dragging it sideways. A drag of a
// few pixels is not a click, so the tab under the mouse does not open.
function setupTabStripScroll() {
    const strip = document.getElementById('tabs-container');
    if (!strip || strip.dataset.scrollReady) return;
    strip.dataset.scrollReady = '1';
    strip.addEventListener('wheel', (e) => {
        if (strip.scrollWidth <= strip.clientWidth) return;
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (!d) return;
        e.preventDefault();
        strip.scrollLeft += d;
    }, { passive: false });
    let drag = null;
    strip.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        drag = { x: e.clientX, left: strip.scrollLeft, moved: false };
    });
    window.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        if (!drag.moved && Math.abs(dx) < 6) return;
        drag.moved = true;
        strip.classList.add('dragging');
        strip.scrollLeft = drag.left - dx;
    });
    window.addEventListener('pointerup', () => {
        if (!drag) return;
        if (drag.moved) {
            strip.classList.remove('dragging');
            // The click that follows the drag is swallowed (none comes if
            // the mouse was released outside the strip).
            const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
            strip.addEventListener('click', swallow, { capture: true, once: true });
            setTimeout(() => strip.removeEventListener('click', swallow, { capture: true }), 0);
        }
        drag = null;
    });
}
document.addEventListener('DOMContentLoaded', setupTabStripScroll);

// #!bg= of a Micron page: the background of the whole page box, as NomadNet
// paints the whole page (MicronParser.pageColors; #!fg= is the parser's).
function applyPageColors(content, markup) {
    if (!content) return;
    const P = window.MicronParser;
    const bg = P && P.pageColors ? P.pageColors(markup).bg : null;
    const css = bg && P.prototype.colorToCss.call(null, bg);
    if (css) content.style.setProperty('background-color', css);
    else content.style.removeProperty('background-color');
}

function createTabContent(tab) {
    const wrapper = document.getElementById('tab-content-wrapper');
    const template = document.getElementById('tab-content-template');
    const clone = template.content.cloneNode(true);
    try { clone.querySelectorAll('.rb-version').forEach(el => { el.textContent = `rBrowser v${RB_VERSION}`; }); } catch (e) {}

    const content = clone.querySelector('.tab-content');
    content.id = tab.id;
    
    const backBtn = content.querySelector('.back-btn');
    const forwardBtn = content.querySelector('.forward-btn');
    const refreshBtn = content.querySelector('.refresh-btn');
    const homeBtn = content.querySelector('.home-btn');
    const goBtn = content.querySelector('.go-btn');
    const addressBar = content.querySelector('.address-bar');
    const viewToggle = content.querySelector('.view-toggle');
    
    if (backBtn) backBtn.onclick = () => navigateBackTab();
    if (forwardBtn) forwardBtn.onclick = () => navigateForwardTab();
    if (refreshBtn) refreshBtn.onclick = () => userReloadPageTab();
    if (homeBtn) homeBtn.onclick = () => navigateHome();  // Add this line
    if (goBtn) goBtn.onclick = () => navigateToUrlTab();
    if (addressBar) addressBar.onkeypress = (e) => handleAddressBarEnterTab(e);
    if (viewToggle) viewToggle.onclick = () => toggleViewTab();
    
    wrapper.appendChild(content);
}

function switchToTab(tabId) {
    activeTabId = tabId;
    // A page tab replaces the Messages view on screen.
    if (typeof Messenger !== 'undefined') Messenger.open = false;
    document.body.classList.remove('messenger-open');
    if (typeof RetiBBS !== 'undefined') RetiBBS.open = false;
    document.body.classList.remove('retibbs-open');
    if (typeof Rmap !== 'undefined') Rmap.open = false;
    document.body.classList.remove('rmap-open');
    if (typeof Rrc !== 'undefined') Rrc.open = false;
    document.body.classList.remove('rrc-open');
    // Fit is per page, and the hint belongs to the area now on screen.
    setTimeout(() => {
        const tab = getActiveTab();
        if (tab) { refitPageZoom(); initScrollHint(tab); updateScrollHint(tab); }
    }, 0);

    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    const tabElement = document.querySelector(`[data-tab-id="${tabId}"]`);
    const contentElement = document.getElementById(tabId);
    
    if (tabElement && contentElement) {
        tabElement.classList.add('active');
        contentElement.classList.add('active');
        
        const activeTab = getActiveTab();
        if (activeTab) {
            activeTab.updateAddressBar();
            activeTab.updateNavigationButtons();
            
            updateNodeSelection();
            setTimeout(updateStarButtonState, 100);
            updateAutoReloadButton(); // Update auto-reload button
            updateAutoIdentifyButton();
        }
    }
}

// The shortcuts bar is fixed to the bottom of the window and starts where
// the page area starts (style.css, --content-left). The page area moves
// when the node list is dragged, hidden or the window resized.
function trackContentLeft() {
    const content = document.querySelector('.content');
    if (!content) return;
    const update = () => document.documentElement.style.setProperty(
        '--content-left', Math.round(content.getBoundingClientRect().left) + 'px');
    update();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(update).observe(content);
    window.addEventListener('resize', update);
}

function updateNodeListPosition() {
    const searchContainer = document.querySelector('.search-container');
    const favoritesSection = document.querySelector('.favorites-section');
    const sortContainer = document.querySelector('.sort-container');
    const nodeListContainer = document.querySelector('.node-list-container');
    
    if (!nodeListContainer) return;
    
    // Right below the sort row, wherever it has ended up. Adding up the
    // heights above it missed margins and borders.
    let topPosition = 0;
    if (sortContainer && sortContainer.offsetParent === nodeListContainer.offsetParent) {
        topPosition = sortContainer.offsetTop + sortContainer.offsetHeight;
    } else {
        if (searchContainer) topPosition += searchContainer.offsetHeight;
        if (favoritesSection) topPosition += favoritesSection.offsetHeight;
        if (sortContainer) topPosition += sortContainer.offsetHeight;
    }
    nodeListContainer.style.top = `${topPosition}px`;

    // This used to run once, at startup. Opening the favorites, or adding
    // or removing one, changed the height above the list and the list did
    // not move: its first node slid under the sort row. Watching the sizes
    // keeps it in place whatever changes them.
    if (!updateNodeListPosition.observer && typeof ResizeObserver !== 'undefined') {
        updateNodeListPosition.observer = new ResizeObserver(() => updateNodeListPosition());
        [searchContainer, favoritesSection, sortContainer].forEach(el => {
            if (el) updateNodeListPosition.observer.observe(el);
        });
    }
}

function closeTab(tabId, event) {
    if (event) {
        event.stopPropagation();
    }
    
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;

    // Closing the last tab used to do nothing at all, so the final page you
    // had open could never be got rid of. It closes like any other now, and
    // an empty tab takes its place - the window is never left with none.
    const wasLast = (tabs.length === 1);

    // Stop auto-reload timer before removing tab
    const tab = tabs[tabIndex];
    if (tab) {
        tab.stopAutoReload();
        // A closed tab must stop asking the node for its partials, otherwise
        // the refresh interval outlives the page that declared it and keeps
        // generating traffic for a tab nobody is looking at.
        stopPartials(tab.id);
    }
    
    tabs.splice(tabIndex, 1);
    
    document.querySelector(`[data-tab-id="${tabId}"]`)?.remove();
    document.getElementById(tabId)?.remove();

    if (wasLast) {
        createNewTab();
        return;
    }

    if (activeTabId === tabId) {
        const nextTab = tabs[Math.max(0, tabIndex - 1)];
        switchToTab(nextTab.id);
    }
}

function getActiveTab() {
    return tabs.find(t => t.id === activeTabId);
}

// Favorites system //

function addCurrentPageToFavorites() {
    const tab = getActiveTab();
    if (!tab || !tab.currentUrl) {
        showNotification('No current page to add to favorites', 'warning', 4000);
        return;
    }
   
    const parsed = parseNomadNetUrl(tab.currentUrl);
    if (!parsed) {
        showNotification('Cannot parse current URL', 'error', 4000);
        return;
    }
   
    // Check if already favorited - if so, remove it
    const existingIndex = favoriteNodes.findIndex(fav => fav.hash === parsed.hash);
    if (existingIndex >= 0) {
        const removedName = favoriteLabel(favoriteNodes[existingIndex]);
        favoriteNodes.splice(existingIndex, 1);
        saveFavorites();
        updateFavoritesDisplay();
        syncFavorites();
        showNotification(`Removed "${escapeHtml(removedName)}" from favorites`, 'info', 4000);
        return;
    }
    
    // Add to favorites
    // A node whose name we do not know: ask for one.
    const name = tab.knownNodeName;
    if (!name) {
        showFavoriteDialog({ hash: parsed.hash });
        return;
    }

    favoriteNodes.push({ hash: parsed.hash, name: name, prefer: 'network', network_name: true });
    saveFavorites();
    updateFavoritesDisplay();
    syncFavorites();

    showNotification(`Added "${escapeHtml(name)}" to favorites!`, 'success', 4000);
}

function isFavorite(hash) {
    return favoriteNodes.some(fav => fav.hash === hash);
}

// One place that makes every star agree with favoriteNodes.
//
// There were three: the navigation bar used a CSS class, the node list used
// an inline colour plus a ★/☆ character, and each caller poked whichever
// one it happened to think of. removeFavorite() updated neither of the
// first two, so deleting a favourite from the sidebar left the navigation
// bar still showing the page as favourited until something else happened to
// refresh it. Every mutation now ends here instead.
function syncFavorites() {
    // Navigation bar: every tab, not just the active one. Two tabs can show
    // the same node, and the inactive one was never updated.
    for (const tab of tabs) {
        const starBtn = document.querySelector(`#${tab.id} .star-btn`);
        if (!starBtn) continue;

        let favorited = false;
        if (tab.currentUrl) {
            const parsed = parseNomadNetUrl(tab.currentUrl);
            favorited = !!(parsed && isFavorite(parsed.hash));
        }
        starBtn.classList.toggle('favorited', favorited);
        starBtn.title = favorited ? 'Remove from favorites' : 'Add current page to favorites';
    }

    // Node list: driven by the data, never by whoever clicked.
    document.querySelectorAll('#node-list .star-btn').forEach(btn => {
        const favorited = isFavorite(btn.getAttribute('data-hash'));
        const icon = favorited ? '★' : '☆';
        if (btn.textContent !== icon) btn.textContent = icon;
        btn.style.color = favorited ? '#ffa657' : '#7d8590';
    });
}

// Kept as the old name so existing call sites still work.
function updateStarButtonState() {
    syncFavorites();
}

function showAddFavoriteDialog() {
    showFavoriteDialog();
}

// The node hash in what was typed or pasted: a bare hash, <hash>, or a
// full address with a page path. Null when there is none.
function favoriteHashFrom(text) {
    const value = String(text || '').trim().replace(/^<|>$/g, '');
    if (/^[a-fA-F0-9]{32}$/.test(value)) return value.toLowerCase();
    if (value.includes(':')) {
        const parsed = parseNomadNetUrl(value);
        if (parsed && /^[a-fA-F0-9]{32}$/.test(parsed.hash)) return parsed.hash.toLowerCase();
    }
    return null;
}

function closeFavoriteDialog() {
    const modal = document.getElementById('favorite-modal');
    if (modal) modal.remove();
}

// Add a favorite: address and name in one dialog, in the browser's own
// style. It replaces the browser prompt() boxes, which asked one question
// at a time and could not say what was wrong with an address.
//
// With a hash already known (the current page), only the name is asked.
function showFavoriteDialog(options = {}) {
    closeFavoriteDialog();
    if (typeof setFavoritesOpen === 'function') setFavoritesOpen(false);

    const fixedHash = options.hash ? String(options.hash).toLowerCase() : '';

    const overlay = document.createElement('div');
    overlay.className = 'auto-reload-modal';
    overlay.id = 'favorite-modal';

    const dialog = document.createElement('div');
    dialog.className = 'auto-reload-dialog favorite-dialog';
    dialog.innerHTML = `
        <div class="dialog-header">
            <h3><span class="favorite-dialog-star">★</span> Add favorite</h3>
            <button class="modal-close" title="Close" aria-label="Close">&times;</button>
        </div>
        <label class="settings-label" for="favorite-address">Address</label>
        <input type="text" id="favorite-address" class="favorite-input favorite-input-mono"
               placeholder="Node hash or hash:/page/index.mu" autocomplete="off" spellcheck="false">
        <div class="favorite-field-note" id="favorite-address-note"></div>
        <label class="settings-label" for="favorite-name">Name</label>
        <input type="text" id="favorite-name" class="favorite-input"
               placeholder="Empty: taken from the node's announce" autocomplete="off" maxlength="120">
        <div class="favorite-prefer" role="radiogroup" aria-label="Which name to keep">
            <label class="favorite-prefer-option">
                <input type="radio" name="favorite-prefer" value="network" checked>
                <span>Prefer network name</span>
            </label>
            <label class="favorite-prefer-option">
                <input type="radio" name="favorite-prefer" value="custom">
                <span>Prefer custom name</span>
            </label>
        </div>
        <div class="favorite-field-note" id="favorite-name-note"></div>
        <div class="auto-reload-actions">
            <button class="btn-cancel" type="button">Cancel</button>
            <button class="btn-save" type="button" disabled>Add</button>
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const address = dialog.querySelector('#favorite-address');
    const addressNote = dialog.querySelector('#favorite-address-note');
    const nameInput = dialog.querySelector('#favorite-name');
    const nameNote = dialog.querySelector('#favorite-name-note');
    const save = dialog.querySelector('.btn-save');

    // The name follows the address until it is typed in by hand.
    let nameTouched = false;
    let suggested = '';
    // The name the node announces, when known here: what "prefer network
    // name" would show right away.
    let networkName = '';
    // Once a preference is clicked it is left alone; until then it follows
    // the name - an own name is kept, a suggested one follows the network.
    let preferChosen = false;

    const preferInputs = Array.from(dialog.querySelectorAll('input[name="favorite-prefer"]'));
    const preferValue = () => (preferInputs.find(i => i.checked) || {}).value || 'network';
    const setPrefer = (value) => preferInputs.forEach(i => { i.checked = i.value === value; });

    const updatePrefer = () => {
        const name = nameInput.value.trim();
        const custom = preferInputs.find(i => i.value === 'custom');
        // No name typed: there is nothing custom to keep.
        custom.disabled = !name;
        custom.closest('label').classList.toggle('disabled', !name);
        if (!name) setPrefer('network');
        else if (!preferChosen) setPrefer(networkName && name === networkName ? 'network' : 'custom');

        if (preferValue() === 'custom') {
            nameNote.textContent = 'This name is kept as it is.';
        } else if (!name) {
            nameNote.textContent = 'Looked up on the network. The list shows the hash until then.';
        } else if (networkName && name === networkName) {
            nameNote.textContent = 'Follows the node if it changes its name.';
        } else {
            nameNote.textContent = 'Temporary: replaced by the name the node announces.';
        }
    };

    const check = () => {
        const raw = address.value.trim();
        const hash = favoriteHashFrom(raw);
        addressNote.className = 'favorite-field-note';
        addressNote.textContent = '';

        // No valid address: a name suggested for the previous one goes too.
        const clearSuggestion = () => {
            if (!nameTouched) { suggested = ''; nameInput.value = ''; }
        };

        if (!raw) {
            clearSuggestion();
            save.disabled = true;
            return null;
        }
        if (!hash) {
            clearSuggestion();
            // While a hash is still being typed it is not an error yet.
            const finished = raw.includes(':') || raw.replace(/^<|>$/g, '').length >= 32
                             || /[^a-fA-F0-9<>]/.test(raw);
            if (finished) {
                addressNote.classList.add('is-error');
                addressNote.textContent = 'Not a node address. A hash is 32 hex characters.';
            } else {
                addressNote.textContent = `${raw.replace(/^<|>$/g, '').length} of 32 characters`;
            }
            save.disabled = true;
            return null;
        }
        if (favoriteNodes.some(fav => fav.hash === hash)) {
            addressNote.classList.add('is-error');
            addressNote.textContent = 'Already in favorites.';
            save.disabled = true;
            return null;
        }

        const suggest = (name) => {
            networkName = name;
            if (!nameTouched) { suggested = name; nameInput.value = name; }
            updatePrefer();
        };

        const known = getNodeName(hash);
        if (known && known !== hash) {
            addressNote.textContent = `Known node: ${known}`;
            suggest(known);
        } else {
            // Not in the list: the server may still remember its announce.
            // Nothing is sent to the network for this.
            addressNote.textContent = 'Not in the node list.';
            suggest('');
            fetch(`/api/node-name/${hash}`)
                .then(r => r.json())
                .then(data => {
                    if (favoriteHashFrom(address.value) !== hash) return;   // address changed since
                    if (data && data.name) {
                        addressNote.textContent = `Known node: ${data.name}`;
                        suggest(data.name);
                    } else {
                        addressNote.textContent = 'Name not known yet.';
                    }
                })
                .catch(() => {});
        }
        save.disabled = false;
        return hash;
    };

    const submit = () => {
        const hash = check();
        if (!hash) return;
        // An empty name is allowed: the server looks it up (see
        // rbrowser/favorites.py) and the list shows the hash until then.
        const name = nameInput.value.trim();
        const prefer = name ? preferValue() : 'network';
        const entry = { hash: hash, name: name, prefer: prefer };
        if (prefer === 'network' && name && name === networkName) entry.network_name = true;
        favoriteNodes.push(entry);
        saveFavorites();
        updateFavoritesDisplay();
        syncFavorites();
        closeFavoriteDialog();
        if (isFavoritePending(entry)) {
            showNotification('Added to favorites. Looking up its name on the network.', 'info', 4000);
        } else {
            showNotification(`Added "${escapeHtml(name)}" to favorites`, 'success', 3000);
        }
    };

    address.addEventListener('input', check);
    nameInput.addEventListener('input', () => {
        nameTouched = nameInput.value !== suggested;
        updatePrefer();
    });
    preferInputs.forEach(i => i.addEventListener('change', () => {
        preferChosen = true;
        updatePrefer();
    }));
    [address, nameInput].forEach(el => el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
    }));
    dialog.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); closeFavoriteDialog(); }
    });
    save.addEventListener('click', submit);
    dialog.querySelector('.btn-cancel').addEventListener('click', closeFavoriteDialog);
    dialog.querySelector('.modal-close').addEventListener('click', closeFavoriteDialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeFavoriteDialog(); });

    if (fixedHash) {
        address.value = fixedHash;
        address.readOnly = true;
        address.classList.add('readonly');
        check();
        // The name of the page's node is the one it announces.
        if (options.name) {
            networkName = options.name;
            suggested = options.name;
            nameInput.value = options.name;
        }
        updatePrefer();
        nameInput.focus();
        nameInput.select();
    } else {
        updatePrefer();
        address.focus();
    }
}

function addFavoriteFromUrl() {
    const tab = getActiveTab();
    if (!tab || !tab.currentUrl) {
        showNotification(
            "No current page to add to favorites",
            'warning',
            4000
        );
        return;
    }
   
    const parsed = parseNomadNetUrl(tab.currentUrl);
    if (!parsed) {
        showNotification(
            "Cannot parse current URL",
            'error',
            4000
        );
        return;
    }
   
    if (favoriteNodes.some(fav => fav.hash === parsed.hash)) {
        showNotification(
            "This node is already in your favorites",
            'warning',
            4000
        );
        return;
    }

    showFavoriteDialog({ hash: parsed.hash, name: tab.knownNodeName || '' });
}

// Navigation bar

function navigateBackTab() {
    const tab = getActiveTab();
    if (tab && tab.historyIndex > 0) {
        tab.historyIndex--;
        const url = tab.navigationHistory[tab.historyIndex];
        tab.setUrl(url);
        navigateToUrlInternalTab(url, false);
        tab.updateNavigationButtons();
    }
}

function navigateForwardTab() {
    const tab = getActiveTab();
    if (tab && tab.historyIndex < tab.navigationHistory.length - 1) {
        tab.historyIndex++;
        const url = tab.navigationHistory[tab.historyIndex];
        tab.setUrl(url);
        navigateToUrlInternalTab(url, false);
        tab.updateNavigationButtons();
    }
}

function refreshPageTab() {
    const tab = getActiveTab();
    if (tab && tab.currentUrl) {
        // The reload button bypasses the cache, the way it does in any
        // other browser.
        navigateToUrlInternalTab(tab.currentUrl, false, true);
    }
}

function navigateToUrlTab() {
    const tab = getActiveTab();
    if (tab) {
        const addressBar = document.querySelector(`#${tab.id} .address-bar`);
        if (addressBar) {
            const url = addressBar.value.trim();
            if (!url) {
                showNotification('Please enter a URL in the address bar', 'warning', 3000);
                return;
            }
            navigateToUrlInternalTab(url, true);
        }
    }
}

function handleAddressBarEnterTab(event) {
    if (event.key === 'Enter') {
        navigateToUrlTab();
    }
}

// Set while reloadPage() runs: an auto-reload on its timer is not the user
// asking for the page, and must not take the screen from the Messages view.
let backgroundReload = false;

async function navigateToUrlInternalTab(url, addHistory = true, forceFresh = false) {
    const tab = getActiveTab();
    if (!tab) return;

    // Opening a page (node list, search, favorites, history...) while the
    // Messages view is in front: the page comes to the front. Without this it
    // loaded behind the chat, in the page tab the chat was covering.
    if (!backgroundReload && (document.body.classList.contains('messenger-open')
                              || document.body.classList.contains('retibbs-open')
                              || document.body.classList.contains('rmap-open')
                              || document.body.classList.contains('rrc-open'))) {
        switchToTab(tab.id);
    }

    const parsed = parseNomadNetUrl(url);
    if (!parsed) {
        showNotification(
            'Invalid NomadNet URL format.<br><br><strong>Examples:</strong><br>• abcd1234...:/page/index.mu<br>• nomadnetwork://abcd1234.../page/index.mu',
            'error',
            6000
        );
        return;
    }

    if (addHistory) {
        tab.addToHistory(url);
    }

    tab.setUrl(url);
    // Loading from the click on: the node list is refreshed first, and on a
    // slow link that alone took long enough for a reload to look ignored.
    tab.setLoading(true);

    try {
        const response = await fetch('/api/nodes');
        const nodes = await response.json();
        cachedNodes = nodes;

    } catch (error) {
        console.warn('Failed to refresh cached nodes:', error);
    }

    if (parsed.formData && Object.keys(parsed.formData).length > 0) {
        fetchPageByUrlTabWithFormData(parsed.hash, parsed.path, url, parsed.formData, false, tab); // false = URL params (var_)
    } else {
        fetchPageByUrlTab(parsed.hash, parsed.path, url, forceFresh, tab);
    }
    
    updateStarButtonState();
}

function toggleViewTab() {
    const tab = getActiveTab();
    if (!tab) return;
    
    const content = document.querySelector(`#${tab.id} .page-content`);
    const toggle = document.querySelector(`#${tab.id} .view-toggle`);
    
    if (tab.isRawView) {
        // Switching back to rendered view
        const renderedHtml = parseMicronContent(tab.currentRawContent);
        content.innerHTML = renderedHtml;
        content.className = 'page-content';
        applyPageColors(content, tab.currentRawContent);
        
        
        addClickHandlersToCurrentTab();
        hydrateMicronMedia(tab);
        refitPageZoom();
        initScrollHint(tab);
        updateScrollHint(tab);
        
        setViewToggleLabel(toggle, false);
        tab.isRawView = false;
        
    } else {
        // Switching to raw view
        content.innerHTML = escapeHtml(tab.currentRawContent);
        content.className = 'page-content raw';
        setViewToggleLabel(toggle, true);
        tab.isRawView = true;
        
    }
}

// The raw/rendered switch says where a click takes you. One label in two
// lengths: the short one is shown on phones, where the button row must stay
// on one line. It used to read "Raw View" or "Raw Page" depending on which
// code path had set it last.
function setViewToggleLabel(button, showingRaw) {
    const [long, short] = showingRaw ? ['Rendered', 'Page'] : ['Raw View', 'Raw'];
    button.innerHTML = `<span class="label-long">${long}</span><span class="label-short">${short}</span>`;
}

// Notification system
// Notifications: all, errors and warnings only, or none - a setting, since
// a stream of "page loaded" boxes is not to everyone's taste. A suppressed
// notification still returns an element, never attached, so callers that
// keep the returned box to remove it later keep working.
const NOTIFICATIONS_KEY = 'rbrowser_notifications';   // all | errors | none

function getNotificationPolicy() {
    try {
        const v = localStorage.getItem(NOTIFICATIONS_KEY);
        if (v === 'all' || v === 'errors' || v === 'none') return v;
    } catch (e) {}
    return 'all';
}

// ─── Sounds (Settings > System > Sounds) ───
// Short tones made with WebAudio, no sound files: one per kind of news, each
// switched on or off, plus a switch for all and a volume. Kept in this
// browser: sound belongs to the device. A browser plays nothing before the
// first click or key on the page; until then they are skipped quietly.
const SOUNDS_KEY = 'rbrowser_sounds';
const SOUND_KINDS = [
    // key, label, on by default, notes [frequency Hz, start s, length s]
    ['messenger', 'LXMF Messenger: a new message', true, [[660, 0, 0.12], [880, 0.13, 0.18]]],
    ['rrc_mention', 'RRC Client: someone names you', true, [[880, 0, 0.09], [1175, 0.1, 0.09], [1568, 0.2, 0.16]]],
    ['rrc_message', 'RRC Client: a message in your rooms', false, [[520, 0, 0.07]]],
    ['rrc_state', 'RRC Client: a hub connects or drops', true, [[440, 0, 0.08], [330, 0.1, 0.12]]],
    ['rrc_join', 'RRC Client: someone joins one of your rooms', false, [[392, 0, 0.06], [523, 0.07, 0.08]]],
    ['bbs', 'BBS client: a server writes while you are elsewhere', false, [[1200, 0, 0.06], [2200, 0.08, 0.06]]],
];
let soundContext = null;
const soundLast = {};

function soundSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SOUNDS_KEY)) || {}; } catch (e) {}
    const kinds = {};
    for (const [key, , def] of SOUND_KINDS) kinds[key] = s.kinds && key in s.kinds ? !!s.kinds[key] : def;
    return { on: s.on !== false, volume: typeof s.volume === 'number' ? Math.min(1, Math.max(0.05, s.volume)) : 0.5, kinds };
}

// The truth is settings/sounds.json on the server (same for every port and
// address); localStorage is only the copy read when a sound plays.
function saveSoundSettings(s) {
    try { localStorage.setItem(SOUNDS_KEY, JSON.stringify(s)); } catch (e) {}
    fetch('/api/sounds', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                           body: JSON.stringify(s) }).catch(() => {});
}

function loadSoundSettingsFromServer() {
    return fetch('/api/sounds').then(r => r.json()).then(d => {
        if (d && d.sounds) {
            try { localStorage.setItem(SOUNDS_KEY, JSON.stringify(d.sounds)); } catch (e) {}
        } else {
            // First run with the file: what this browser had becomes the file.
            let local = null;
            try { local = JSON.parse(localStorage.getItem(SOUNDS_KEY)); } catch (e) {}
            if (local) saveSoundSettings(local);
        }
    }).catch(() => {});
}
loadSoundSettingsFromServer();

// Settings dialog: every switch and the volume apply and save at once.
function saveSoundSettingsFromDialog() {
    const soundsOn = document.getElementById('setting-sounds-on');
    if (!soundsOn) return;
    const kinds = {};
    for (const [key] of SOUND_KINDS) {
        const t = document.getElementById(`setting-sound-${key}`);
        kinds[key] = !!(t && t.classList.contains('active'));
    }
    saveSoundSettings({ on: soundsOn.classList.contains('active'), kinds,
                        volume: Number(document.getElementById('setting-sounds-volume').value) || 0.5 });
}

// test: from Settings, played whatever the switches say.
// What sounded while the window was in the background ("something beeped,
// but what?"): one notice when you come back, with how many and when.
const soundsMissed = [];

function tellSoundsMissed() {
    if (!soundsMissed.length || !document.hasFocus()) return;
    const by = new Map();
    for (const m of soundsMissed.splice(0)) {
        const e = by.get(m.label) || { n: 0, at: 0 };
        by.set(m.label, { n: e.n + 1, at: Math.max(e.at, m.at) });
    }
    const when = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const rows = [...by].map(([label, e]) => `${e.n > 1 ? `<b>${e.n}×</b> ` : ''}${escapeHtml(label)} <span style="opacity:.7">(last ${when(e.at)})</span>`);
    showNotification(`🔔 While you were away:<br>${rows.join('<br>')}`, 'info', 9000);
}
window.addEventListener('focus', () => setTimeout(tellSoundsMissed, 300));

// The "while you were away" notice follows the clients' own notification
// switches: with RRC's popups off it still told of every RRC beep.
function soundTold(kind) {
    const rrc = { rrc_message: ['notify_messages', false], rrc_mention: ['notify_mentions', true],
                  rrc_state: ['notify_events', true], rrc_join: null };
    if (!(kind in rrc)) return true;
    if (!rrc[kind] || typeof rrcSetting !== 'function') return false;
    return !!rrcSetting(...rrc[kind]);
}

function playSound(kind, test = false) {
    const def = SOUND_KINDS.find(k => k[0] === kind);
    if (!def) return;
    const s = soundSettings();
    if (!test && (!s.on || !s.kinds[kind])) return;
    const now = Date.now();
    if (!test && now - (soundLast[kind] || 0) < 1500) return;     // a burst is one sound
    soundLast[kind] = now;
    // Played while you were in another window: told when you come back.
    if (!test && !document.hasFocus() && soundTold(kind)) soundsMissed.push({ label: def[1], at: now });
    try {
        soundContext = soundContext || new (window.AudioContext || window.webkitAudioContext)();
        // Suspended (phones, until a touch; a tab put to sleep): the notes
        // are timed once it runs again, not before - they were late or lost.
        if (soundContext.state !== 'running') {
            soundContext.resume().then(() => playNotes(def, s)).catch(() => {});
            return;
        }
        playNotes(def, s);
    } catch (e) { /* no audio here: silently nothing */ }
}

// Phones let a page make sound only after a touch: the first one anywhere
// unlocks it, so a sound that comes later plays at once.
['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, function unlockAudio() {
    try {
        soundContext = soundContext || new (window.AudioContext || window.webkitAudioContext)();
        if (soundContext.state !== 'running') soundContext.resume().catch(() => {});
    } catch (e) { /* no audio here */ }
}, { once: true, capture: true, passive: true }));
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && soundContext && soundContext.state !== 'running') soundContext.resume().catch(() => {});
});

function playNotes(def, s) {
    try {
        const t0 = soundContext.currentTime + 0.01;
        for (const [freq, start, length] of def[3]) {
            const osc = soundContext.createOscillator();
            const gain = soundContext.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, t0 + start);
            gain.gain.linearRampToValueAtTime(0.25 * s.volume, t0 + start + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + length);
            osc.connect(gain).connect(soundContext.destination);
            osc.start(t0 + start);
            osc.stop(t0 + start + length + 0.02);
        }
    } catch (e) { /* no audio here: silently nothing */ }
}

// On a phone the stack sits just above whatever bar is at the bottom of the
// screen: the LXMF or RRC input bar (taller, and it grows with the text) or
// the status bar. Measured each time, and again when the screen resizes
// (the keyboard opening).
const BOTTOM_BARS = '.msg-compose, #rrc-input-row, .bbs-input-row, .status-bar';
function placeNotificationStack() {
    const stack = document.getElementById('notification-stack');
    if (!stack) return;
    if (!window.matchMedia('(max-width: 600px)').matches) { stack.style.bottom = ''; return; }
    const height = window.innerHeight;
    let top = height;
    document.querySelectorAll(BOTTOM_BARS).forEach(bar => {
        const r = bar.getBoundingClientRect();
        if (r.height && r.bottom >= height - 4 && r.top < top) top = r.top;
    });
    stack.style.bottom = `${Math.round(height - top) + 8}px`;
}
window.addEventListener('resize', placeNotificationStack);
// A tap can switch view (RRC -> LXMF, a taller bar) while one is showing.
document.addEventListener('click', () => {
    const stack = document.getElementById('notification-stack');
    if (stack && stack.children.length) setTimeout(placeNotificationStack, 300);
}, true);

function showNotification(message, type = 'info', duration = 4000, stackPosition = null) {
    const notification = document.createElement('div');
    const policy = getNotificationPolicy();
    if (policy === 'none' || (policy === 'errors' && type !== 'error' && type !== 'warning')) {
        return notification;
    }
    
    const styles = {
        info: { bg: '#0969da', color: 'white' },
        warning: { bg: '#fb8500', color: 'white' },
        error: { bg: '#da3633', color: 'white' },
        success: { bg: '#238636', color: 'white' }
    };
    
    const style = styles[type] || styles.info;

    // Every notification used to be fixed at the very same spot, so two at
    // once (two pages loading together) sat exactly on top of each other and
    // read as one. They now go into a single stack that grows upwards; the
    // old stackPosition argument is no longer needed and is ignored.
    let stack = document.getElementById('notification-stack');
    if (!stack) {
        stack = document.createElement('div');
        stack.id = 'notification-stack';
        document.body.appendChild(stack);
    }

    notification.className = 'notification';
    notification.style.cssText = `
        background: ${style.bg}; color: ${style.color};
        padding: 12px 16px; border-radius: 6px; font-size: 13px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        line-height: 1.4; transition: opacity 0.3s ease; pointer-events: auto; position: relative; padding-right: 30px;
        overflow-wrap: anywhere;
    `;
    notification.innerHTML = message;
    // An x to send it away at once (a burst of them can cover the page).
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'notification-close';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', e => { e.stopPropagation(); notification.remove(); });
    notification.prepend(close);
    stack.appendChild(notification);
    placeNotificationStack();
    // A burst: only the newest few stay (3 on a phone, where they cover the page).
    const keep = window.matchMedia('(max-width: 600px)').matches ? 3 : 6;
    while (stack.children.length > keep) stack.firstElementChild.remove();
    
    setTimeout(() => {
        if (notification.parentNode) {
            notification.style.opacity = '0';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }
    }, duration);
    
    return notification;
}

function showCurrentNodeInfo() {
    const tab = getActiveTab();
    if (!tab || !tab.selectedNode) {
        showNotification(
            'No current node selected',
            'warning',
            4000
        );
        return;
    }

    const nodeHash = tab.selectedNode;
    const nodeName = tab.knownNodeName || getNodeName(nodeHash);
    
    // Get node data from cached nodes
    const nodeData = cachedNodes.find(n => n.hash === nodeHash);
    
    if (nodeData) {
        showNodeInfo(
            nodeData.hash, 
            nodeData.name, 
            nodeData.last_seen, 
            nodeData.app_data_length, 
            nodeData.announce_count, 
            nodeData.last_seen_relative
        );
    } else {
        // Not announced since startup: the panel still opens, for the name,
        // the hash and what the cache holds, with the announce fields saying
        // why they are empty.
        showNodeInfo(nodeHash, nodeName, undefined, '?', undefined, 'not heard since startup');
    }
}

function showConfirmDialog(message, onConfirm, onCancel = null) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 10001;
        background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center;
    `;
    
    const dialog = document.createElement('div');
    dialog.style.cssText = `
        background: #161b22; border: 2px solid #30363d; color: #e6edf3;
        padding: 20px; border-radius: 8px; max-width: 400px; min-width: 300px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    `;
    
    dialog.innerHTML = `
        <div style="margin-bottom: 16px; line-height: 1.5; font-size: 14px;">${message}</div>
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
            <button id="cancel-btn" style="
                background: #6e7681; color: white; border: none; 
                padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px;
            ">Cancel</button>
            <button id="confirm-btn" style="
                background: #238636; color: white; border: none; 
                padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px;
            ">Open</button>
        </div>
    `;
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    dialog.querySelector('#confirm-btn').addEventListener('click', () => {
        document.body.removeChild(overlay);
        onConfirm();
    });
    
    dialog.querySelector('#cancel-btn').addEventListener('click', () => {
        document.body.removeChild(overlay);
        if (onCancel) onCancel();
    });
    
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            document.body.removeChild(overlay);
            if (onCancel) onCancel();
        }
    });
    
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            document.removeEventListener('keydown', escapeHandler);
            if (overlay.parentNode) {
                document.body.removeChild(overlay);
                if (onCancel) onCancel();
            }
        }
    };
    document.addEventListener('keydown', escapeHandler);
}

// ─────────────────────────────────────────────────────────────────────────
// NomadNet 1.4.x: inline images and page partials
//
// The Micron parser leaves placeholders behind because it does not know
// which node the page came from and must not touch the network. Everything
// that needs a node hash or an HTTP call happens here.
// ─────────────────────────────────────────────────────────────────────────

const partialTimers = new Map();   // tabId -> [intervalId, ...]

function stopPartials(tabId) {
    const timers = partialTimers.get(tabId);
    if (timers) {
        timers.forEach(clearInterval);
        partialTimers.delete(tabId);
    }
}

// Split "hash:/media/pic.webp" or "/media/pic.webp" into [hash, path],
// falling back to the node the current page belongs to.
function resolveMicronTarget(rawUrl, fallbackHash) {
    let url = String(rawUrl || '').replace(/^nomadnetwork:\/\//, '');
    const match = url.match(/^([a-fA-F0-9<>:]{32,})[:\/](.*)$/);
    if (match) {
        const hash = match[1].replace(/[<>:]/g, '');
        let path = match[2];
        if (!path.startsWith('/')) path = '/' + path;
        return [hash, path];
    }
    // ":/media/pic.webp" means "on this node". The colon used to stay in,
    // giving "/:/media/..." - and the server then put another /media/ in
    // front of that, so the node was asked for a file that does not exist
    // and every image written this way failed to load.
    url = url.replace(/^:/, '');
    if (!url.startsWith('/')) url = '/' + url;
    return [fallbackHash, url];
}

// Image sizes in NomadNet's units, not pixels. In NomadNet "w=18" is 18
// character columns and "h=6" six text rows, "n" is the picture's own size
// and "50%" a share of the page (width) or of the screen (height). These
// were read as pixels, so a logo the author made 18 columns wide came out
// as an 18px thumbnail. Columns and rows follow the page font, so the image
// scales with the zoom like the text around it. With neither given the
// picture keeps its own size, capped at the page width.
function applyMicronImageSize(img, w, h) {
    const size = (spec, axis) => {
        if (!spec || spec === 'n') return null;
        const pct = /^(\d+(?:\.\d+)?)%$/.exec(spec);
        if (pct) return axis === 'w' ? `${pct[1]}%` : `${pct[1]}vh`;
        if (!/^\d+$/.test(spec)) return null;
        return axis === 'w' ? `${spec}ch` : `calc(${spec} * 1lh)`;
    };
    const width = size(w, 'w');
    const height = size(h, 'h');
    if (width) img.style.width = width;
    if (height) {
        img.style.height = height;
        // Browsers without the lh unit drop the value; rows of about 1.2em.
        if (!img.style.height && /^\d+$/.test(h)) img.style.height = `${h * 1.2}em`;
    }
    // Only one side given: keep the picture's proportions.
    if (width && !height) img.style.height = 'auto';
    if (height && !width) img.style.width = 'auto';
}

function hydrateMicronMedia(tab) {
    if (!tab) return;
    const root = document.querySelector(`#${tab.id} .page-content`);
    if (!root) return;

    stopPartials(tab.id);

    const parsed = tab.currentUrl ? parseNomadNetUrl(tab.currentUrl) : null;
    const pageHash = parsed ? parsed.hash : null;

    hydrateMicronImages(root, pageHash);
    hydrateMicronPartials(root, pageHash, tab);

    if (typeof MicronParser !== 'undefined' && MicronParser.applyFolds) {
        MicronParser.applyFolds(root);
    }
}

async function hydrateMicronImages(root, pageHash) {
    const holders = root.querySelectorAll('[data-micron-image="1"]');
    if (!holders.length) return;

    // Is this link worth pulling images over? On a fast path they just
    // appear; on a slow one an unattended image download is somebody else's
    // airtime, so we ask first. Same thresholds NomadNet uses.
    const policy = (typeof getImagePolicy === 'function') ? getImagePolicy() : 'auto';
    if (policy === 'never') {
        holders.forEach(holder => {
            const button = holder.querySelector('.micron-image-placeholder');
            if (!button) return;
            const alt = holder.dataset.imageAlt || 'image';
            button.textContent = `\u{1F5BC} ${alt} \u2014 images are off`;
            button.title = 'Image loading is set to Never in Settings';
        });
        return;
    }

    let fast = policy === 'always';
    if (!fast && pageHash) {
        try {
            const resp = await fetch(`/api/link-quality/${pageHash}`);
            const quality = await resp.json();
            fast = !!quality.fast;
        } catch (e) {
            fast = false;
        }
    }

    holders.forEach(holder => {
        const [hash, path] = resolveMicronTarget(holder.dataset.imageUrl, pageHash);
        if (!hash) return;

        const src = `/api/media/${hash}?path=${encodeURIComponent(path)}`;
        const alt = holder.dataset.imageAlt || path.split('/').pop();

        const load = () => {
            holder.innerHTML = '';
            const img = document.createElement('img');
            img.className = 'micron-img';
            img.alt = alt;
            img.title = alt;
            applyMicronImageSize(img, holder.dataset.imageWidth, holder.dataset.imageHeight);
            img.style.maxWidth = '100%';
            img.onerror = () => {
                holder.innerHTML = '';
                const failed = document.createElement('span');
                failed.className = 'micron-image-placeholder';
                failed.textContent = `⚠ Could not load image: ${alt}`;
                holder.appendChild(failed);
            };
            img.src = src;
            holder.appendChild(img);
        };

        if (fast) {
            load();
        } else {
            const button = holder.querySelector('.micron-image-placeholder');
            if (!button) return;
            button.textContent = `🖼 ${alt} — click to load`;
            button.style.cursor = 'pointer';
            button.title = 'This link is slow or its speed is unknown; '
                         + 'the image is only fetched if you ask for it.';
            button.addEventListener('click', load, { once: true });
        }
    });
}

function hydrateMicronPartials(root, pageHash, tab) {
    const holders = root.querySelectorAll('[data-micron-partial="1"]');
    if (!holders.length) return;

    const timers = [];

    holders.forEach(holder => {
        const [hash, path] = resolveMicronTarget(holder.dataset.partialUrl, pageHash);
        if (!hash) return;

        // Fields declared on the partial are sent as var_ values, the same
        // convention links use.
        const fields = (holder.dataset.partialFields || '').split('|').filter(Boolean);
        const formData = {};
        for (const field of fields) {
            const eq = field.indexOf('=');
            if (eq > 0) formData['var_' + field.slice(0, eq)] = field.slice(eq + 1);
        }

        // A partial always goes to the node, as in NomadNet, which never
        // reads one from its cache: it is the live part of a page (counters,
        // latest news), with or without a refresh interval. If the node does
        // not answer, the server still falls back to the saved copy.

        const loadPartial = async () => {
            try {
                const options = Object.keys(formData).length
                    ? {method: 'POST', headers: {'Content-Type': 'application/json'},
                       body: JSON.stringify(formData)}
                    : {};
                const resp = await fetch(
                    `/api/fetch/${hash}?path=${encodeURIComponent(path)}`
                    + '&fresh=1&partial=1', options);
                const data = await resp.json();

                // Where the reader is, before the partial changes. The new
                // content comes in at full size, and the browser scrolls to
                // keep the text in view while it is taller; the fit then
                // shrinks it back but the scroll stayed moved. On rmap,
                // whose animated header reloads every second, the page slid
                // 119px down every second, on its own.
                const area = holder.closest('.browser-area');
                const top = area ? area.scrollTop : 0;
                const before = holder.offsetHeight;
                const above = area ? holder.getBoundingClientRect().bottom <= area.getBoundingClientRect().top : false;

                holder.innerHTML = '';
                if (data.status === 'success') {
                    const rendered = parseMicronContent(data.content);
                    holder.innerHTML = rendered;
                    // New lines in the page: sort them into prose and layout
                    // and fit again (the chat in a refreshing partial is
                    // mostly long prose lines).
                    const active = getActiveTab();
                    const mine = active && area && area.closest(`#${active.id}`);
                    refitPageZoom(mine ? top : undefined);
                    // A partial above the reader that really changed height
                    // moves what is read by that much.
                    if (area && above) {
                        const grown = holder.offsetHeight - before;
                        if (grown) area.scrollTop = top + grown;
                    }
                } else {
                    const err = document.createElement('span');
                    err.className = 'micron-partial-error';
                    err.textContent = `Could not load partial ${holder.dataset.partialUrl}`;
                    holder.appendChild(err);
                }
            } catch (e) {
                holder.innerHTML = '';
                const err = document.createElement('span');
                err.className = 'micron-partial-error';
                err.textContent = `Could not load partial: ${e.message}`;
                holder.appendChild(err);
            }
        };

        loadPartial();

        // A refresh below 1s is ignored, as in NomadNet: a partial that
        // reloads faster than that is a denial of service against the node.
        const refresh = parseFloat(holder.dataset.partialRefresh);
        if (!isNaN(refresh) && refresh >= 1) {
            timers.push(setInterval(loadPartial, refresh * 1000));
        }
    });

    if (timers.length) partialTimers.set(tab.id, timers);
}

// Enter in a text field of a page sends it, as a click on its button would:
// a chat line goes with Enter instead of hunting for "Send" with the mouse.
// The "button" is a link that submits fields: the one that names this field
// or sends them all ("*"), the first after the field when there are several.
// In a multi-line box Enter is a new line, so there it is Ctrl+Enter.
function submitLinkForField(field) {
    const page = field.closest('.page-content');
    if (!page || !field.name) return null;
    const links = Array.from(page.querySelectorAll('a[data-fields]')).filter(a => {
        const names = a.getAttribute('data-fields').split('|').map(f => f.trim());
        return names.includes(field.name) || names.includes('*');
    });
    if (!links.length) return null;
    const after = links.find(a => field.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
    return after || links[0];
}

document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.altKey) return;
    const field = e.target;
    if (!field || !field.closest || !field.closest('.page-content')) return;
    const multiLine = field.tagName === 'TEXTAREA';
    const singleLine = field.tagName === 'INPUT' && /^(text|password|search|)$/i.test(field.type);
    if (!(singleLine && !e.ctrlKey && !e.metaKey) && !(multiLine && (e.ctrlKey || e.metaKey))) return;
    const link = submitLinkForField(field);
    if (!link) return;
    e.preventDefault();
    link.click();
}, true);   // capture: first, so nothing on the page can swallow the key

function addClickHandlersToCurrentTab(targetTab = null) {
    const tab = targetTab || getActiveTab();
    if (!tab) return;
    
    const links = document.querySelectorAll(`#${tab.id} .page-content a`);
    
    function handleClick(event) {
        event.preventDefault();
        const href = this.getAttribute('href');
        const action = this.getAttribute('data-action');
        const destination = lxmfUrlToAt(this.getAttribute('data-destination'));
        const fields = this.getAttribute('data-fields');
        

        // Nothing to open in rBrowser: the menu says what it is instead.
        // A link that leaves the page viewer (messenger, RRC, web, mail,
        // another app): asked first, never opened on a single click.
        const linkInfo = pageLinkInfo(this, tab);
        if (LINK_ASK_KINDS.includes(linkInfo.kind)) {
            showLinkOpenDialog(this, linkInfo);
            return;
        }
        
        // Check if this is a link with fields specification
        if (fields && destination) {
            
            // Parse the fields to determine if it's a form submission or URL parameters
            const fieldsList = fields.split('|').filter(f => f.trim());
            
            // Check if any field references form inputs:
            // - Contains "*" (wildcard for all form fields)
            // - Contains field names without "=" (references to form inputs)
            const hasFormFieldReferences = fieldsList.some(field => {
                const trimmed = field.trim();
                return trimmed === '*' || (!trimmed.includes('=') && trimmed.length > 0);
            });
            
            if (hasFormFieldReferences) {
                // This is a form submission - references actual form fields
                handleFormSubmit(destination, fields);
                return;
            } else {
                // Only static parameters (like "var=value"), treat as URL navigation
                let urlWithParams = destination;
                if (fields) {
                    urlWithParams += '`' + fields.replace(/\|/g, '|');
                }
                navigateToLinkTab(urlWithParams);
                return;
            }
        }

        if ((destination && destination.includes(':/file/')) || (href && href.includes(':/file/'))) {
            const fileUrl = destination || href;
            this.setAttribute('href', fileUrl);
            handleFileClick.call(this, event);
            return;
        }
        
        // Check if this is a NomadNet URL with parameters (even if it contains HTTP)
        const urlToCheck = destination || href;
        if (isNomadNetUrlWithParams(urlToCheck)) {
            navigateToLinkTab(urlToCheck);
            return;
        }
        
        // "rrc@<hash>" and the like: the address of another application
        // (an RRC hub...), not a page. Read as a path on this node it
        // only failed with "Request failed". lxmf@ has its own text below.
        const appAddress = String(destination || '').trim()
            .match(/^([a-z][a-z0-9_.-]*)@([0-9a-f]{32})$/i);
        // nnn@ is NomadNet's own shorthand for a node.
        if (appAddress && ['nnn', 'nomadnetwork.node'].includes(appAddress[1].toLowerCase())) {
            navigateToLinkTab(`${appAddress[2].toLowerCase()}:/page/index.mu`);
            return;
        }
        if (appAddress && ['lxmf', 'lxmf.delivery'].includes(appAddress[1].toLowerCase())
                && typeof messengerEnabled === 'function' && messengerEnabled()) {
            openLxmfLink(this, appAddress[2].toLowerCase());
            return;
        }
        if (appAddress && !['lxmf', 'lxmf.delivery'].includes(appAddress[1].toLowerCase())) {
            const proto = appAddress[1].toLowerCase();
            const what = {
                rrc: 'an RRC chat hub address. Turn on RRC chat in Settings to open it in rBrowser',
            }[proto] || `a "${escapeHtml(proto)}" address, for another application`;
            showNotification(`This is ${what}: it is not a NomadNet page.`, 'warning', 7000, 1);
            copyText(appAddress[0],
                     `Address copied to clipboard!<br><br><strong>${escapeHtml(appAddress[0])}</strong>`);
            return;
        }

        // Handle other link types with notifications
        if (destination && destination.includes('lxmf@')) {
            const lxmfAddress = destination.match(/lxmf@[a-fA-F0-9]+/)?.[0] || destination;
            
            showNotification(
                "This is an LXMF address. Turn on the messenger in Settings > LXMF Messenger to write to it from rBrowser.",
                'warning',
                7000,
                1
            );
            
            copyText(lxmfAddress,
                     `LXMF address copied to clipboard!<br><br><strong>${escapeHtml(lxmfAddress)}</strong>`);
            return;
        }

        if (destination && destination.includes('[')) {
            showNotification(
                "Error! This is not a valid link or address!",
                'error'
            );
            return;
        }

        // Now check for standalone HTTP URLs (not part of NomadNet URLs)
        if (destination && isStandaloneHttpUrl(destination)) {
            let httpUrl = destination;
            if (destination.startsWith('nomadnetwork://')) {
                httpUrl = destination.replace('nomadnetwork://', '');
            }
            
            showConfirmDialog(
                `Open HTTP/HTTPS URL in a new window?<br><br><strong>URL:</strong> ${escapeHtml(httpUrl)}`,
                () => {
                    window.open(httpUrl, '_blank', 'noopener,noreferrer');
                }
            );
            return;
        }
        
        const urlToNavigate = destination || href;
        if (urlToNavigate) {
            navigateToLinkTab(urlToNavigate);
        }
    }
    
    // Right-click (or a long press on a phone): the link's menu, with what
    // fits its kind (showPageLinkMenu). The browser's own menu had only the
    // relative ":/path" to work with and made it http://localhost:5000/:/...
    function handleLinkMenu(event) {
        if (showPageLinkMenu(this, tab)) event.preventDefault();
    }

    links.forEach(link => {
        link.addEventListener('click', handleClick);
        link.addEventListener('contextmenu', handleLinkMenu);
    });

    addFileDownloadHandlers();
}

// "lxmf://<hash>" (sent by "Send address to..." and other clients) is the
// same address as NomadNet's "lxmf@<hash>": read as that everywhere.
function lxmfUrlToAt(value) {
    if (value == null) return value;
    return String(value).replace(/^\s*lxmf:\/\/([0-9a-f]{32})\/?\s*$/i, 'lxmf@$1');
}

// What a link in a page points at, as NomadNet reads it (Browser.handle_link):
// "#name" an anchor, "p:id" a partial, "rrc://" or "rrc@hash" an RRC hub,
// "lxmf@hash" an LXMF address, "nnn@hash" a node, another "proto@hash" some
// other application, otherwise a NomadNet page or file, relative to the
// node or with its hash. Web links are ours to add.
function pageLinkInfo(link, tab) {
    const raw = String(link.getAttribute('data-destination') || link.getAttribute('href') || '').trim();
    const target = lxmfUrlToAt(raw.replace(/^nomadnetwork:\/\//i, ''));
    const label = (link.textContent || '').replace(/\s+/g, ' ').trim();
    const base = { label, raw };
    if (!target || target === '#') return { ...base, kind: 'none' };
    if (target.startsWith('#')) return { ...base, kind: 'anchor' };
    if (/^p:/i.test(target)) return { ...base, kind: 'partial' };
    if (/^rrc:\/\//i.test(target)) return { ...base, kind: 'rrc', address: target };
    const relay = relayUrlToRrc(target);
    if (relay) return { ...base, kind: 'rrc', address: relay };
    const app = target.match(/^([a-z][a-z0-9_.-]*)@([0-9a-f]{32})(.*)$/i);
    if (app) {
        const proto = app[1].toLowerCase(), hash = app[2].toLowerCase();
        if (proto === 'lxmf' || proto === 'lxmf.delivery') return { ...base, kind: 'lxmf', address: hash };
        if (proto === 'nnn' || proto === 'nomadnetwork.node') {
            return { ...base, kind: 'nomadnet', hash, address: `${hash}:${app[3] && app[3].startsWith(':') ? app[3].slice(1) : '/page/index.mu'}` };
        }
        if (proto === 'rrc' || proto === 'rrc.hub.session') return { ...base, kind: 'rrc', address: `${proto}@${hash}` };
        return { ...base, kind: 'app', proto, address: `${proto}@${hash}` };
    }
    // An e-mail address: not Reticulum, offered to the mail program.
    const mail = target.match(/^(?:mailto:)?([^@\s:/`]+@[^@\s:/`]+\.[a-z]{2,})$/i);
    if (mail) return { ...base, kind: 'email', address: mail[1] };
    if (/^(https?|ftp|gemini|gopher):/i.test(target) && !target.includes('`')) {
        return { ...base, kind: 'web', address: target };
    }
    // Another application's own link (meshchatx://relay?hub=<hash>&name=...):
    // not NomadNet, but the Reticulum addresses in it can be checked.
    const appUrl = target.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
    if (appUrl && !/^(nomadnetwork|rbrowser|lxm|rrc)$/i.test(appUrl[1])) {
        const hashes = [...new Set((appUrl[2].match(/[0-9a-f]{32}/gi) || []).map(h => h.toLowerCase()))];
        const params = {};
        try {
            new URLSearchParams(appUrl[2].split('?')[1] || '').forEach((v, k) => { params[k] = v; });
        } catch (e) {}
        return { ...base, kind: 'appurl', scheme: appUrl[1].toLowerCase(), address: target, hashes, params };
    }
    let address = nomadnetAddressOf(link, tab);
    // Written wrong (a hash too short, a typo...): said so, and the text copied if wanted.
    if (!address) return { ...base, kind: 'invalid', address: raw };
    // A bare hash is the node's index, as NomadNet opens it; the URL form
    // "nomadnetwork://hash/page/x.mu" (rmap) gets its colon.
    if (/^[0-9a-f]{32}$/i.test(address)) address += ':/page/index.mu';
    address = address.replace(/^([0-9a-f]{32})\//i, '$1:/');
    const hash = address.slice(0, 32).toLowerCase();
    if (link.getAttribute('data-fields') && /(^|\|)\s*(\*|[^=|]+)\s*(\||$)/.test(link.getAttribute('data-fields'))) {
        return { ...base, kind: 'form', hash, address };
    }
    if (/:\/file\//.test(address)) return { ...base, kind: 'file', hash, address };
    return { ...base, kind: 'nomadnet', hash, address };
}

// The menu of a link in a page. Returns false when there is none (anchors,
// partials): then the browser's own menu shows.
function showPageLinkMenu(link, tab) {
    const info = pageLinkInfo(link, tab);
    const nodeName = hash => ((cachedNodes || []).find(n => n.hash === hash) || {}).name || '';
    const copy = (text, what) => ({ label: `Copy ${what}`, run: () => copyText(text, `${what[0].toUpperCase() + what.slice(1)} copied:<br><code>${escapeHtml(text)}</code>`) });
    const copyLabel = info.label && info.label !== info.address ? [copy(info.label, 'link text')] : [];
    const title = info.label || info.address || 'Link';
    // The address's own hash, to check what it really is.
    const hashOf = (String(info.hash || info.address || '').match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase();
    const check = hashOf ? ['-', aspectCheckItem(link, hashOf, DECLARED_ASPECT[info.kind] || null)] : [];
    switch (info.kind) {
    case 'nomadnet': {
        const name = nodeName(info.hash);
        const isFavorite = favoriteNodes.some(f => f.hash === info.hash);
        const inList = (cachedNodes || []).some(n => n.hash === info.hash);
        openNodeMenu(link, title, info.address, [
            { label: 'Open link', run: () => link.click() },
            { label: 'Open in a new tab', run: () => openQuickAddress(info.address, name, true),
              tip: 'A new rBrowser tab; this page stays' },
            { label: 'Open in a new tab in background', run: () => openInBackgroundTab(info.address, name),
              tip: 'Loads in a new tab while you keep reading this page' },
            { label: 'Open in a new window', run: () => window.open(`${location.origin}/?url=${encodeURIComponent(info.address)}`, '_blank'),
              tip: 'rBrowser in a new browser window' },
            '-',
            { label: isFavorite ? 'Remove node from favorites' : 'Add node to favorites',
              run: () => toggleFavorite(info.hash, name || info.label) },
            copy(info.address, 'address'),
            ...copyLabel,
            '-',
            { label: 'Node info', disabled: !inList, run: () => showNodeMenuInfo(info.hash),
              tip: inList ? 'The node as heard in the list' : 'Not in the node list: it has not announced' },
            { label: 'Ping node', run: () => pingNode(info.hash, name) },
            { label: 'Check path', run: () => checkPath(info.hash, name),
              tip: 'The path held to this node now. Nothing is sent' },
            aspectCheckItem(link, info.hash, 'nomadnetwork.node'),
        ]);
        return true;
    }
    case 'file':
        openNodeMenu(link, title, info.address, [
            { label: 'Download', run: () => link.click() },
            copy(info.address, 'address'),
            ...copyLabel,
            ...check,
        ]);
        return true;
    case 'form':
        openNodeMenu(link, title, info.address, [
            { label: 'Send', run: () => link.click(), tip: 'Sends the fields this link names, as a click does' },
            copy(info.address, 'address'),
            ...copyLabel,
            ...check,
        ]);
        return true;
    case 'lxmf':
        // The same menu as an operator's LXMF address in the node list,
        // with the check first: the page may be wrong about it.
        showLxmfMenu(link, info.address, info.label !== `lxmf@${info.address}` ? info.label : '', 'LXMF address',
                     [aspectCheckItem(link, info.address, 'lxmf.delivery'), '-']);
        return true;
    case 'rrc':
        openNodeMenu(link, title, info.address, [
            rrcMenuItem(info.address),
            copy(info.address, 'address'),
            ...copyLabel,
            ...check,
        ]);
        return true;
    case 'app':
        openNodeMenu(link, title, info.address, [
            { label: `"${info.proto}" address`, disabled: true, run: () => {},
              tip: 'For another Reticulum application, not a NomadNet page' },
            copy(info.address, 'address'),
            ...copyLabel,
            ...check,
        ]);
        return true;
    case 'appurl': {
        // What the parameters say ("hub", "name"...), then each address in it
        // to check: the page is not trusted, the address's identity is.
        const said = Object.entries(info.params).filter(([k, v]) => !/^[0-9a-f]{32}$/i.test(v))
            .map(([k, v]) => `${k}: ${v}`).join(', ');
        openNodeMenu(link, info.params.name || title, info.address, [
            { label: `A link for the "${info.scheme}" app`, disabled: true, run: () => {},
              tip: `Not a NomadNet link: made for ${info.scheme}${said ? ` (${said})` : ''}` },
            { label: `Open with ${info.scheme}`, run: () => { window.location.href = info.address; },
              tip: `Hands the link to ${info.scheme}, if it is installed on this computer` },
            ...info.hashes.map(h => {
                const role = Object.keys(info.params).find(k => String(info.params[k]).toLowerCase() === h);
                return { ...aspectCheckItem(link, h, null),
                         label: `Check address aspect type${role ? ` (${role})` : ''}: ${h.slice(0, 8)}…` };
            }),
            '-',
            ...info.hashes.map(h => copy(h, `address ${h.slice(0, 8)}…`)),
            copy(info.address, 'link'),
            ...copyLabel,
        ]);
        return true;
    }
    case 'email':
        openNodeMenu(link, title, info.address, [
            { label: 'Write an e-mail', run: () => { window.location.href = `mailto:${info.address}`; },
              tip: 'Opens your mail program: this is internet mail, not Reticulum' },
            copy(info.address, 'e-mail address'),
        ]);
        return true;
    case 'invalid':
        openNodeMenu(link, title, info.address, [
            { label: 'Not a valid address', disabled: true, run: () => {},
              tip: 'The page links to something rBrowser cannot read: a hash of the wrong length, a typo...' },
            copy(info.address, 'link as written'),
            ...copyLabel,
        ]);
        return true;
    case 'web':
        openNodeMenu(link, title, info.address, [
            { label: 'Open in the web browser', run: () => window.open(info.address, '_blank', 'noopener,noreferrer'),
              tip: 'Leaves Reticulum: this goes over the internet' },
            copy(info.address, 'URL'),
            ...copyLabel,
        ]);
        return true;
    default:
        return false;
    }
}

// ─── Addresses written as plain text in a page ───
// "RNS Community hub at 28c7c1a6...": not a link, but a right-click on it
// (long press on a phone) gives a menu. What it is comes from the server
// (/api/hash-kind: the identity of its announce, if heard - nothing sent);
// the ways to open it are offered anyway, the likely one first.

// The block-level element holding the clicked text: one line of the page.
function textLineOf(el) {
    let node = el && el.nodeType === 3 ? el.parentElement : el;
    while (node && node !== document.body) {
        const display = getComputedStyle(node).display;
        if (!display.startsWith('inline') && display !== 'contents') return node;
        node = node.parentElement;
    }
    return null;
}

// A web address written as text: up to a space or a quote, without the
// punctuation that usually ends a sentence after it.
const TEXT_URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const URL_TRAILING = '.,;:!?)]>' + String.fromCharCode(125);   // and the closing curly brace
function trimUrl(url) {
    let end = url.length;
    while (end > 0 && URL_TRAILING.includes(url[end - 1])) end--;
    return url.slice(0, end);
}

// What is written under the pointer: { type: 'hash' | 'url', value }, or null.
// The URL first: a hash inside a web address belongs to the address.
function textTargetAtPoint(event) {
    const url = urlAtPoint(event);
    if (url) return { type: 'url', value: url };
    const hash = addressAtPoint(event);
    return hash ? { type: 'hash', value: hash } : null;
}

// The clicked line's text and the index of the clicked character in it.
function clickedLineText(event) {
    let node = null, offset = 0;
    if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(event.clientX, event.clientY);
        if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(event.clientX, event.clientY);
        if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    // Desktop pages have one cell per character: the line is read whole and
    // the clicked character found in it.
    const line = textLineOf(node && node.nodeType === 3 ? node : event.target);
    if (!line || !node || node.nodeType !== 3 || !line.contains(node)) return null;
    let at = 0;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t && t !== node; t = walker.nextNode()) at += t.data.length;
    return { text: line.textContent, at: at + offset };
}

function urlAtPoint(event) {
    const clicked = clickedLineText(event);
    if (!clicked) {
        const selected = String((window.getSelection && window.getSelection()) || '').match(TEXT_URL_RE);
        return selected ? trimUrl(selected[0]) : null;
    }
    for (const m of clicked.text.matchAll(TEXT_URL_RE)) {
        if (clicked.at >= m.index && clicked.at <= m.index + m[0].length) return trimUrl(m[0]);
    }
    return null;
}

function showTextUrlMenu(anchor, url) {
    openNodeMenu(anchor, 'Web address', url, [
        { label: 'Open in a new browser window', run: () => window.open(url, '_blank', 'noopener,noreferrer'),
          tip: 'Leaves Reticulum: this goes over the internet' },
        { label: 'Copy URL', run: () => copyText(url, `URL copied:<br><code>${escapeHtml(url)}</code>`) },
    ]);
}

// The 32-hex address under the pointer, or in the selection.
function addressAtPoint(event) {
    const fromText = text => {
        const m = String(text || '').match(/(?:^|[^0-9a-f])([0-9a-f]{32})(?![0-9a-f])/i);
        return m ? m[1].toLowerCase() : null;
    };
    const clicked = clickedLineText(event);
    // The line could not be read (no caret API): the selection, if any.
    if (!clicked) return fromText(window.getSelection && window.getSelection());
    const { text, at } = clicked;
    for (const m of text.matchAll(/[0-9a-f]{32}/gi)) {
        const before = text[m.index - 1], after = text[m.index + 32];
        if ((before && /[0-9a-f]/i.test(before)) || (after && /[0-9a-f]/i.test(after))) continue;
        if (at >= m.index && at <= m.index + 32) return m[0].toLowerCase();
    }
    return null;
}

const HASH_KIND_TEXT = {
    'nomadnetwork.node': 'NomadNet node', 'lxmf.delivery': 'LXMF address', 'lxmf.propagation': 'LXMF propagation node',
    'rrc.hub': 'RRC chat hub', 'retibbs.bbs': 'RetiBBS board', 'partyline.relay': 'Party Line relay',
};

// kind: already worked out (after Check address aspect type), else asked here.
async function showTextAddressMenu(anchor, hash, kind = null) {
    if (!kind) {
        kind = { known: false };
        try { kind = await fetch(`/api/hash-kind/${hash}`).then(r => r.json()); } catch (e) {}
    }
    const aspect = kind.known ? kind.aspect : null;
    // The server's own words when it knows more (an interface: LoRa, 433 MHz).
    const serverWords = String(kind.label || '').replace(/^an? /, '').replace(/:.*$/, '');
    const what = !kind.known ? 'Not heard yet: kind unknown'
        : aspect === 'rnstransport.discovery.interface' || !HASH_KIND_TEXT[aspect]
            ? (serverWords ? serverWords[0].toUpperCase() + serverWords.slice(1) : 'Unknown Reticulum destination')
            : HASH_KIND_TEXT[aspect];
    const name = kind.name || '';
    const messenger = typeof messengerEnabled === 'function' && messengerEnabled();
    // Known for sure: the ways that cannot work are shown off, with why.
    const isNot = wanted => kind.known && aspect !== wanted;
    const asNode = [
        { label: 'Open as NomadNet page', run: () => openQuickAddress(`${hash}:/page/index.mu`, name, true),
          disabled: isNot('nomadnetwork.node'),
          tip: isNot('nomadnetwork.node') ? `It is ${kind.label}: it has no pages` : 'Opens its index.mu in a new tab' },
    ];
    const asLxmf = [
        { label: messenger ? 'Write with the messenger' : 'Write with the messenger (turn it on in Settings)',
          disabled: !messenger || isNot('lxmf.delivery'), run: () => openMessenger(hash),
          tip: isNot('lxmf.delivery') ? `It is ${kind.label}, not an LXMF address` : 'As an LXMF address' },
    ];
    const asRrc = [{ ...rrcMenuItem(hash), ...(isNot('rrc.hub') ? { disabled: true, tip: `It is ${kind.label}, not an RRC hub` } : {}) }];
    const asPropagation = [
        { label: 'Use as propagation node', run: () => usePropagationNode(hash),
          tip: 'Settings > LXMF Messenger > Propagation node: this one, chosen' },
    ];
    // The likely way first; the others stay, for when it was not heard.
    const ways = aspect === 'lxmf.delivery' ? [...asLxmf, ...asNode, ...asRrc]
               : aspect === 'rrc.hub' ? [...asRrc, ...asNode, ...asLxmf]
               : aspect === 'lxmf.propagation' ? [...asPropagation, ...asNode, ...asLxmf]
               : [...asNode, ...asLxmf, ...asRrc];
    openNodeMenu(anchor, name || what, hash, [
        ...(name ? [{ label: what, disabled: true, run: () => {} }] : []),
        aspectCheckItem(anchor, hash, null),
        ...ways,
        '-',
        { label: 'Copy address', run: () => copyText(hash, `Address copied:<br><code>${hash}</code>`) },
        { label: 'Check path', run: () => checkPath(hash, name),
          tip: 'The path held to this address now. Nothing is sent' },
    ]);
}

// What a page says an address is. People write links by hand and get them
// wrong ("lxmf@" in front of an RRC hub): only the address's own identity
// tells, so every menu with an address offers to check.
const DECLARED_ASPECT = { nomadnet: 'nomadnetwork.node', file: 'nomadnetwork.node', form: 'nomadnetwork.node',
                          lxmf: 'lxmf.delivery', rrc: 'rrc.hub' };

function aspectCheckItem(anchor, hash, declared) {
    return { label: 'Check address aspect type', run: () => checkAddressAspect(anchor, hash, declared),
             tip: 'Find out what this address really is, from its own identity. Asks the network once (a path request) only if it was never heard' };
}

// One path request; the answer brings the announce, so the identity, so
// the aspect. Then the menu again, with the right way first.
// declared: what the page said it is, to say so when it is wrong.
async function checkAddressAspect(anchor, hash, declared = null) {
    const waiting = showNotification(`Asking the network what ${hash.slice(0, 8)}… is…`, 'info', 60000);
    let kind;
    try {
        kind = await fetch(`/api/hash-kind/${hash}`, { method: 'POST' }).then(r => r.json());
    } catch (e) {
        kind = { status: 'error', error: e.message };
    } finally {
        if (waiting && waiting.parentNode) waiting.parentNode.removeChild(waiting);
    }
    if (kind.status !== 'success') {
        showNotification(`Could not ask: ${escapeHtml(kind.error || 'error')}`, 'error', 5000);
        return;
    }
    if (!kind.known) {
        showNotification(`No answer for ${hash.slice(0, 8)}… in ${Math.round(kind.elapsed || 0)} s: offline, or not on this network.`,
                         'warning', 7000);
        return;
    }
    const declaredText = declared && (HASH_KIND_TEXT[declared] || declared);
    if (declared && kind.aspect !== declared) {
        showNotification(`The page calls it ${escapeHtml(declaredText)}, but ${hash.slice(0, 8)}… is `
                         + `<b>${escapeHtml(kind.label)}</b>${kind.name ? ` (${escapeHtml(kind.name)})` : ''}.`, 'warning', 9000);
    } else {
        showNotification(`${hash.slice(0, 8)}… is ${escapeHtml(kind.label)}${kind.name ? `: <b>${escapeHtml(kind.name)}</b>` : ''}`,
                         'success', 6000);
    }
    showTextAddressMenu(anchor, hash, kind);
}

// The kinds of page link a click asks about instead of opening.
const LINK_ASK_KINDS = ['lxmf', 'rrc', 'app', 'appurl', 'web', 'email', 'invalid'];

// The question on a click: Cancel / Copy link / Check link type / Open,
// Open going to the client that fits the kind. Check and Copy are the
// same as in the right-click menu.
async function showLinkOpenDialog(link, info) {
    const messenger = typeof messengerEnabled === 'function' && messengerEnabled();
    const rrc = typeof rrcEnabled === 'function' && rrcEnabled();
    const hash = (String(info.hash || info.address || '').match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase();
    const ask = {
        lxmf: { title: 'Open LXMF link', q: 'Open this LXMF address in the messenger?',
                off: messenger ? '' : 'The messenger is off: turn it on in Settings > LXMF Messenger.',
                open: messenger ? () => openLxmfLink(link, info.address) : null },
        rrc: { title: 'Open RRC link', q: 'Open this hub in the RRC client?',
               off: rrc ? '' : 'The RRC client is off: turn it on in Settings > RRC Client.',
               open: rrc ? () => openLinkTarget({ kind: 'rrc', address: rrcLinkOf(info.address) }) : null },
        web: { title: 'Open web link', q: 'Open this web address in a new browser window? It goes over the internet, not Reticulum.',
               open: () => window.open(info.address, '_blank', 'noopener,noreferrer') },
        email: { title: 'E-mail link', q: 'Write an e-mail to this address with your mail program?',
                 open: () => { window.location.href = `mailto:${info.address}`; } },
        appurl: { title: `Link for ${escapeHtml(info.scheme || 'another app')}`,
                  q: `Not a NomadNet link: open it with ${escapeHtml(info.scheme || 'its app')}, if installed on this computer?`,
                  open: () => { window.location.href = info.address; } },
        app: { title: 'Application address', q: `A "${escapeHtml(info.proto || '')}" address, for another Reticulum application: rBrowser cannot open it.` },
        invalid: { title: 'Invalid link', q: 'rBrowser cannot read this link: a hash of the wrong length, a typo...' },
    }[info.kind];
    const declared = DECLARED_ASPECT[info.kind] || null;
    const shown = info.address || info.raw || '';
    const labelLine = info.label && info.label !== shown ? `<div class="link-ask-label">${escapeHtml(info.label)}</div>` : '';
    const buttons = [{ label: 'Cancel', value: null },
                     { label: 'Copy link', value: 'copy' }];
    if (hash) buttons.push({ label: 'Check link type', value: 'check' });
    if (ask.open) buttons.push({ label: 'Open', value: 'open', primary: true });
    const choice = await showChoiceDialog({
        title: ask.title,
        html: `<p>${ask.q}</p>${labelLine}<code class="link-ask-address">${escapeHtml(shown)}</code>`
              + (ask.off ? `<p class="link-ask-off">${ask.off}</p>` : ''),
        buttons,
    });
    if (choice === 'copy') copyText(shown, `Link copied:<br><code>${escapeHtml(shown)}</code>`);
    else if (choice === 'check') checkAddressAspect(link, hash, declared);
    else if (choice === 'open') ask.open();
}

// A click on "lxmf@hash": the messenger, unless the address is known to be
// something else (a page called an RRC hub "lxmf@"). Checked here, locally:
// nothing is sent.
async function openLxmfLink(link, hash) {
    let kind = { known: false };
    try { kind = await fetch(`/api/hash-kind/${hash}`).then(r => r.json()); } catch (e) {}
    if (kind.known && kind.aspect !== 'lxmf.delivery') {
        showNotification(`This link says LXMF, but ${hash.slice(0, 8)}… is <b>${escapeHtml(kind.label)}</b>`
                         + `${kind.name ? ` (${escapeHtml(kind.name)})` : ''}: not opened in the messenger.`, 'warning', 9000);
        showTextAddressMenu(link, hash, kind);
        return;
    }
    openLinkTarget({ kind: 'lxmf', address: hash });
}

// "Open in RRC chat": rBrowser's own client (script/rrc.js); the address may
// carry a room ("rrc://<hash>/general").
function rrcMenuItem(address) {
    const on = typeof rrcEnabled === 'function' && rrcEnabled();
    return { label: on ? 'Open in RRC chat' : 'Open in RRC chat (turn it on in Settings)', disabled: !on,
             run: () => openLinkTarget({ kind: 'rrc', address: rrcLinkOf(address) }),
             tip: 'Connects to the hub in rBrowser\'s RRC client' };
}

// "rrc@<hash>", a bare hash or rrc://<hash>/room: the rrc:// form.
function rrcLinkOf(address) {
    const a = String(address || '').trim();
    if (/^rrc:\/\//i.test(a)) return a;
    const h = a.match(/[0-9a-f]{32}/i);
    return h ? `rrc://${h[0].toLowerCase()}` : a;
}

// ─── Automatic replies: the "Auto" menu in the LXMF and RRC bars ───
// The same three switches as Settings > LXMF Messenger / RRC Client >
// Automatic replies (rbrowser/autoreply.py); Config opens that section.
const AUTO_REPLY_PLACES = {
    messenger: { url: '/api/messenger/settings', state: () => typeof Messenger !== 'undefined' && Messenger.state,
                 poll: () => typeof pollMessenger === 'function' && pollMessenger() },
    rrc: { url: '/api/rrc/settings', state: () => typeof Rrc !== 'undefined' && Rrc.state,
           poll: () => typeof pollRrc === 'function' && pollRrc() },
};

function autoReplySettings(kind) {
    const st = AUTO_REPLY_PLACES[kind].state();
    return (st && st.settings) || {};
}

function autoReplyAnyOn(kind) {
    const s = autoReplySettings(kind);
    return !!(s.autoreply_on || s.echo_on || (s.away_mode && s.away_mode !== 'off'));
}

// The button shows a green dot while any of them is on.
function syncAutoReplyButton(kind) {
    document.querySelectorAll(`.auto-reply-btn[data-kind="${kind}"]`).forEach(btn =>
        btn.classList.toggle('on', autoReplyAnyOn(kind)));
    const away = (autoReplySettings(kind).away_mode || 'off') !== 'off';
    document.querySelectorAll(`.away-btn[data-kind="${kind}"]`).forEach(btn => {
        btn.classList.toggle('on', away);
        btn.title = away ? 'Away: on (click: back)' : 'Away now (the away message in Settings)';
    });
}

async function autoReplySave(kind, body) {
    const res = await fetch(AUTO_REPLY_PLACES[kind].url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
    if (res.status === 'error') { showNotification(`Not saved: ${escapeHtml(res.error || 'error')}`, 'error', 5000); return; }
    Object.assign(autoReplySettings(kind), body);
    syncAutoReplyButton(kind);
    AUTO_REPLY_PLACES[kind].poll();
}

// The moon next to AutoReply: away on/off with one click.
function awayButton(kind) {
    const away = (autoReplySettings(kind).away_mode || 'off') !== 'off';
    return `<button class="msg-bar-btn away-btn${away ? ' on' : ''}" data-kind="${kind}" onclick="toggleAwayQuick('${kind}')" aria-label="Away"
        title="${away ? 'Away: on (click: back)' : 'Away now (the away message in Settings)'}"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="currentColor"/></svg></button>`;
}

function toggleAwayQuick(kind) {
    const away = (autoReplySettings(kind).away_mode || 'off') !== 'off';
    autoReplySave(kind, { away_mode: away ? 'off' : 'on' });
}

function closeAutoReplyMenu() {
    const old = document.getElementById('auto-reply-menu');
    if (old) old.remove();
}

function toggleAutoReplyMenu(btn, kind) {
    const open = document.getElementById('auto-reply-menu');
    closeAutoReplyMenu();
    if (open && open.dataset.kind === kind) return;
    const s = autoReplySettings(kind);
    const menu = document.createElement('div');
    menu.id = 'auto-reply-menu';
    menu.className = 'auto-reply-menu';
    menu.dataset.kind = kind;
    const sw = (key, label, tip) => `<div class="settings-row" title="${tip}"><span>${label}</span>
        <div class="toggle-switch${s[key] ? ' active' : ''}" data-ar-key="${key}"><div class="toggle-slider"></div></div></div>`;
    // RRC, replies only in the chosen rooms (Settings): this room in or out.
    const rrcRoomKey = kind === 'rrc' && s.autoreply_scope === 'selected' && typeof Rrc !== 'undefined'
        && Rrc.active && Rrc.active.room ? `${Rrc.active.hub}/${Rrc.active.room}` : '';
    const rrcRooms = Array.isArray(s.autoreply_rooms) ? s.autoreply_rooms : [];
    const rrcRoomRow = kind !== 'rrc' || s.autoreply_scope !== 'selected' ? ''
        : rrcRoomKey
            ? `<div class="settings-row" title="The replies above act only in the rooms switched on here (Settings > RRC Client > Where)"><span>In #${escapeHtml(Rrc.active.room)}</span>
                <div class="toggle-switch${rrcRooms.includes(rrcRoomKey) ? ' active' : ''}" data-ar-room><div class="toggle-slider"></div></div></div>`
            : '<div class="settings-hint">Only in the chosen rooms: open a room to switch it on.</div>';
    menu.innerHTML = `<div class="auto-reply-head">Automatic replies</div>
        ${sw('autoreply_on', 'Reply to keywords', 'The rules (word = reply) in Settings')}
        <div class="settings-row" title="Replies once per person while you are away. On: away from now; the daily hours and the rest in Config${s.away_mode === 'scheduled' ? ' (now: every day, from - to)' : ''}"><span>Away</span>
            <div class="toggle-switch${s.away_mode && s.away_mode !== 'off' ? ' active' : ''}" data-ar-away><div class="toggle-slider"></div></div></div>
        ${sw('echo_on', 'Echo bot', 'Sends back what it gets')}
        ${rrcRoomRow}
        <button class="msg-bar-btn auto-reply-config" type="button">Config…</button>`;
    const save = body => autoReplySave(kind, body);
    menu.querySelectorAll('[data-ar-key]').forEach(t => t.addEventListener('click', () => {
        t.classList.toggle('active');
        save({ [t.dataset.arKey]: t.classList.contains('active') });
    }));
    const roomSwitch = menu.querySelector('[data-ar-room]');
    if (roomSwitch) roomSwitch.addEventListener('click', () => {
        roomSwitch.classList.toggle('active');
        const rest = rrcRooms.filter(k => k !== rrcRoomKey);
        save({ autoreply_rooms: roomSwitch.classList.contains('active') ? [...rest, rrcRoomKey] : rest });
    });
    // Quick on/off; "every day, from - to" is chosen in Config.
    menu.querySelector('[data-ar-away]').addEventListener('click', e => {
        const t = e.currentTarget;
        t.classList.toggle('active');
        save({ away_mode: t.classList.contains('active') ? 'on' : 'off' });
    });
    menu.querySelector('.auto-reply-config').addEventListener('click', () => {
        closeAutoReplyMenu();
        showSettings(kind);
        // To the "Automatic replies" part of that category.
        setTimeout(() => {
            const head = [...document.querySelectorAll(`#settings-modal .auto-reload-setting[data-cat="${kind}"] .settings-subhead`)]
                .find(h => h.textContent.trim() === 'Automatic replies');
            if (head) head.scrollIntoView({ block: 'start' });
        }, 150);
    });
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
}

document.addEventListener('mousedown', e => {
    if (e.target.closest && !e.target.closest('#auto-reply-menu, .auto-reply-btn')) closeAutoReplyMenu();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAutoReplyMenu(); });

async function usePropagationNode(hash) {
    let d;
    try {
        d = await fetch('/api/messenger/settings', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ propagation_mode: 'manual', propagation_node: hash })
        }).then(r => r.json());
    } catch (e) {
        d = { status: 'error', error: e.message };
    }
    if (d.status !== 'success') {
        showNotification(`Not set: ${escapeHtml(d.error || 'error')}`, 'error', 5000);
        return;
    }
    showNotification(`Propagation node set: <code>${hash}</code>`, 'success', 5000);
}

document.addEventListener('contextmenu', e => {
    if (!e.target.closest || !e.target.closest('.page-content') || e.target.closest('a, input, textarea, select')) return;
    const found = textTargetAtPoint(e);
    if (!found) return;
    e.preventDefault();
    // A small box where the pointer is, for the menu to sit by.
    const spot = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 }) };
    if (found.type === 'url') showTextUrlMenu(spot, found.value);
    else showTextAddressMenu(spot, found.value);
});

// Node info of a node in the list, from anywhere (its card's ℹ button).
function showNodeMenuInfo(hash) {
    const btn = document.querySelector(`.node-item[data-hash="${CSS.escape(hash)}"] .info-btn`);
    if (btn) btn.click();
}

// The full NomadNet address a page link points at. Links in a page are
// relative to its node (":/page/x.mu"); the node's hash is put in front.
function nomadnetAddressOf(link, tab) {
    let target = link.getAttribute('data-destination') || link.getAttribute('href') || '';
    target = lxmfUrlToAt(target.replace(/^nomadnetwork:\/\//, '').replace(/^<([0-9a-f]{32})>/i, '$1'));
    if (!target || /^(https?:|mailto:|#)/i.test(target) || target.includes('lxmf@')
        || /^[a-z][a-z0-9_.-]*@[0-9a-f]{32}$/i.test(target)) return null;
    const nodeHash = (tab && (tab.selectedNode
        || (parseNomadNetUrl(tab.currentUrl || '') || {}).hash)) || '';
    if (target.startsWith(':')) return nodeHash ? nodeHash + target : null;
    if (target.startsWith('/')) return nodeHash ? nodeHash + ':' + target : null;
    return /^[0-9a-f]{32}/i.test(target) ? target : null;
}

function isNomadNetUrlWithParams(url) {
    // Check if it's a NomadNet URL format with backtick parameters
    // Examples: hash:/page/web.mu`url=https://example.com
    //          /page/web.mu`url=https://example.com
    
    if (!url) return false;
    
    // Check for backtick indicating parameters
    if (url.includes('`')) {
        // Split at backtick to get the base path
        const basePath = url.split('`')[0];
        
        // Check if base path looks like a NomadNet URL
        return (
            basePath.match(/^[a-fA-F0-9<>:]{32,}[:\/]/) ||  // Full hash format
            basePath.startsWith('/page/') ||                 // Relative page path
            basePath.startsWith(':') ||                      // Relative with colon
            basePath.match(/\.mu$/)                          // Ends with .mu
        );
    }
    
    return false;
}

function isStandaloneHttpUrl(url) {
    // Check if it's a standalone HTTP URL (not part of NomadNet parameters)
    if (!url) return false;
    
    // If it contains a backtick, it's likely a NomadNet URL with parameters
    if (url.includes('`')) {
        return false;
    }
    
    // Check for HTTP/HTTPS URLs
    return url.includes('http://') || url.includes('https://');
}

function navigateToLinkTab(url, addHistory = true) {
    let tab = getActiveTab();
    if (!tab) return;
   
    const parsedCurrent = parseNomadNetUrl(tab.currentUrl);
    if (!parsedCurrent) {
        showNotification(
            'Invalid NomadNet URL format.<br><br><strong>Examples:</strong><br>• abcd1234...:/page/index.mu<br>• nomadnetwork://abcd1234.../page/index.mu',
            'error',
            6000
        );
        return;
    }
    
    let parsed = parseNomadNetUrl(url);
    if (!parsed) {
        if (url.startsWith(':')) {
            const relativePath = url.substring(1);
            const fullUrl = `${parsedCurrent.hash}:${relativePath}`;
            parsed = parseNomadNetUrl(fullUrl);
            url = fullUrl; 
        } else if (url.startsWith('/')) {
            const fullUrl = `${parsedCurrent.hash}:${url}`;
            parsed = parseNomadNetUrl(fullUrl);
            url = fullUrl; 
        } else {
            const fullUrl = `${parsedCurrent.hash}:/${url}`;
            parsed = parseNomadNetUrl(fullUrl);
            url = fullUrl; 
        }
    }
    
    if (!parsed) {
        console.error('Failed to parse URL after all attempts:', url);
        return;
    }
    
    // A link to another node opens in a tab of its own, so the page it was
    // found on (often a directory of nodes) stays where it was.
    if (parsed.hash.toLowerCase() !== parsedCurrent.hash.toLowerCase()) {
        tab = createNewTab();
        const addressBar = document.querySelector(`#${tab.id} .address-bar`);
        if (addressBar) addressBar.value = url;
    }

    if (addHistory) {
        tab.addToHistory(url);
    }
    
   
    tab.setUrl(url);
    
    // Check if we have form data - these are URL parameters, NOT form submissions
    if (parsed.formData && Object.keys(parsed.formData).length > 0) {
        fetchPageByUrlTabWithFormData(parsed.hash, parsed.path, url, parsed.formData, false); // false = URL params
    } else {
        fetchPageByUrlTab(parsed.hash, parsed.path, url);
    }
}

function navigateHome() {
    const tab = getActiveTab();
    if (!tab) return;
    
    const currentParsed = parseNomadNetUrl(tab.currentUrl);
    if (!currentParsed) {
        showNotification(
            'No current node - please browse to a node first',
            'warning',
            4000
        );
        return;
    }
    
    const homeUrl = `${currentParsed.hash}:/page/index.mu`;
    
    const addressBar = document.querySelector(`#${tab.id} .address-bar`);
    if (addressBar) addressBar.value = homeUrl;
    
    navigateToUrlInternalTab(homeUrl, true);
}

// ─────────────────────────────────────────────────────────────
// Page screenshot
//
// The whole NomadNet page, not only the part on screen, drawn by
// html2canvas into a PNG that the browser downloads. html2canvas is ~200 KB
// and most sessions never take a screenshot, so it is fetched the first
// time one is asked for - from rBrowser itself, not a CDN.
// ─────────────────────────────────────────────────────────────

let html2canvasLoading = null;

// Settings > Screenshots, per browser like the zoom. Quality is the scale
// the page is drawn at: Medium is the screen's own sharpness (up to 2x),
// what rBrowser always did; Low half of it, High double. A phone draws
// slowly, so it starts on Low.
const SCREENSHOT_ENABLED_KEY = 'rbrowser_screenshots';
const SCREENSHOT_QUALITY_KEYS = { desktop: 'rbrowser_screenshot_quality_desktop',
                                  mobile: 'rbrowser_screenshot_quality_mobile' };
const SCREENSHOT_QUALITY_DEFAULTS = { desktop: 'medium', mobile: 'low' };
const SCREENSHOT_QUALITIES = ['low', 'medium', 'high'];

function screenshotsEnabled() {
    try { return localStorage.getItem(SCREENSHOT_ENABLED_KEY) !== 'off'; } catch (e) { return true; }
}

function getScreenshotQuality(kind) {
    let value = null;
    try { value = localStorage.getItem(SCREENSHOT_QUALITY_KEYS[kind]); } catch (e) {}
    return SCREENSHOT_QUALITIES.includes(value) ? value : SCREENSHOT_QUALITY_DEFAULTS[kind];
}

function screenshotScale(quality) {
    const medium = Math.min(2, window.devicePixelRatio || 1);
    if (quality === 'low') return Math.max(0.75, medium / 2);
    if (quality === 'high') return Math.min(4, medium * 2);
    return medium;
}

// Off: the camera buttons go away (style.css, body.screenshots-off).
function applyScreenshotsEnabled() {
    document.body.classList.toggle('screenshots-off', !screenshotsEnabled());
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyScreenshotsEnabled);
else applyScreenshotsEnabled();

function loadHtml2canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (!html2canvasLoading) {
        html2canvasLoading = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/script/html2canvas.min.js';
            script.onload = () => window.html2canvas ? resolve(window.html2canvas)
                                                     : reject(new Error('html2canvas did not load'));
            script.onerror = () => { html2canvasLoading = null; reject(new Error('html2canvas not found')); };
            document.head.appendChild(script);
        });
    }
    return html2canvasLoading;
}

async function confirmPageScreenshot() {
    if (!screenshotsEnabled()) return;
    const tab = getActiveTab();
    const content = tab && document.querySelector(`#${tab.id} .page-content`);
    if (!tab || !tab.currentUrl || !content || tab.loading) {
        showNotification(tab && tab.loading ? 'Wait for the page to finish loading'
                                            : 'Open a page first', 'warning', 3000);
        return;
    }
    const ok = await showChoiceDialog({
        title: 'Take full page screenshot?',
        html: 'The whole page, top to bottom, saved as a PNG in your downloads.',
        buttons: [{ label: 'Cancel', value: false },
                  { label: 'Yes', value: true, primary: true }]
    });
    if (ok) takePageScreenshot(tab, content);
}

async function takePageScreenshot(tab, content) {
    const working = showNotification('Taking screenshot...', 'info', 30000);
    try {
        const html2canvas = await loadHtml2canvas();
        // The page area as it is on screen, not just the page box: with
        // Center on, the box sits in the middle of the area and the shot has
        // to show it there. Full height, as wide as the area (or the page,
        // if that is wider).
        const area = content.closest('.browser-area') || content;
        const width = Math.ceil(Math.max(area.clientWidth, content.scrollWidth));
        const height = Math.ceil(Math.max(area.scrollHeight,
                                          content.offsetTop + content.scrollHeight));
        // A canvas has limits: about 32000 px on a side and 268 million
        // pixels in all (Chrome). A very long page is drawn at a smaller
        // scale rather than failing.
        let scale = screenshotScale(getScreenshotQuality(isMobileDevice() ? 'mobile' : 'desktop'));
        scale = Math.min(scale, 32000 / width, 32000 / height,
                         Math.sqrt(250e6 / (width * height)));

        const canvas = await html2canvas(area, {
            backgroundColor: '#000000',
            scale,
            width, height,
            windowWidth: Math.max(document.documentElement.clientWidth, width),
            logging: false,
            useCORS: true,
            // The page is drawn from a copy of the document. In the copy, the
            // scrolling area is unrolled to its full height and scrolled to
            // the top, or only the visible part (and the wrong part) came out.
            onclone: doc => {
                const area = doc.querySelector(`#${tab.id} .browser-area`);
                if (area) {
                    area.scrollTop = 0;
                    area.style.overflow = 'visible';
                    area.style.height = 'auto';
                    area.style.maxHeight = 'none';
                }
                // Browser furniture, not page: the hover box, the "more
                // below" arrow.
                doc.querySelectorAll('#source-tip, .scroll-hint').forEach(el => el.remove());
            }
        });

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('the page is too large to draw');
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = screenshotFileName(tab);
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 10000);
        if (working && working.remove) working.remove();
        showNotification(`Screenshot saved: <strong>${escapeHtml(link.download)}</strong>`
                         + (scale < 1 ? '<br>Long page: drawn at a smaller scale to fit.' : ''),
                         'success', 4000);
    } catch (error) {
        if (working && working.remove) working.remove();
        showNotification(`Screenshot failed: ${escapeHtml(error.message || String(error))}`, 'error', 6000);
    }
}

// rbrowser_<node>_<page>_<date-time>.png, safe on every file system.
function screenshotFileName(tab) {
    const parsed = parseNomadNetUrl(tab.currentUrl || '') || {};
    const node = tab.knownNodeName || getNodeName(parsed.hash || '') || parsed.hash || 'page';
    const page = String(parsed.path || '').replace(/^\/?page\//, '').replace(/\.mu$/, '') || 'index';
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
                + `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const safe = s => String(s).normalize('NFKD').replace(/[^\w.-]+/g, '_')
                               .replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'x';
    return `rbrowser_${safe(node)}_${safe(page)}_${stamp}.png`;
}

// ─────────────────────────────────────────────────────────────
// Small dialog helper
//
// One shape for every question the identity code asks: a title, some
// HTML, and a row of buttons. Resolves with the chosen button's value, or
// null for Escape / a click outside. A button with takesInput resolves
// with the text typed in the field instead.
// ─────────────────────────────────────────────────────────────

function showChoiceDialog({ title, html = '', buttons, input = null }) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'auto-reload-modal choice-modal';
        const dialog = document.createElement('div');
        dialog.className = 'auto-reload-dialog choice-dialog';
        dialog.innerHTML = `
            <h3>${title}</h3>
            <div class="choice-body">${html}</div>
            ${input ? `<input class="choice-input" type="text" maxlength="40"
                              value="${escapeHtml(input.value || '')}"
                              placeholder="${escapeHtml(input.placeholder || '')}">` : ''}
            <div class="auto-reload-actions"></div>`;

        const field = dialog.querySelector('.choice-input');
        const actions = dialog.querySelector('.auto-reload-actions');
        let primary = null;

        const finish = value => {
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve(value);
        };
        const onKey = e => {
            if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
            else if (e.key === 'Enter' && primary && (field || document.activeElement === primary)) {
                e.preventDefault(); primary.click();
            }
        };

        buttons.forEach(b => {
            const btn = document.createElement('button');
            btn.textContent = b.label;
            btn.className = b.primary ? 'btn-save' : (b.danger ? 'btn-cancel choice-danger' : 'btn-cancel');
            btn.onclick = () => {
                if (b.takesInput) {
                    const text = field ? field.value.trim() : '';
                    finish(text);
                } else {
                    finish(b.value === undefined ? null : b.value);
                }
            };
            if (b.primary) primary = btn;
            actions.appendChild(btn);
        });

        overlay.appendChild(dialog);
        overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(overlay);
        (field || primary || actions.lastChild).focus();
        if (field) field.select();
    });
}

function askText(title, html, value = '', okLabel = 'OK') {
    return showChoiceDialog({
        title, html,
        input: { value, placeholder: 'Name' },
        buttons: [{ label: 'Cancel', value: null },
                  { label: okLabel, primary: true, takesInput: true }]
    });
}

// Every copy button goes through here. navigator.clipboard only exists in a
// secure context, and rBrowser opened from a phone or another PC on the LAN
// is plain http: calling it directly threw before any fallback could run,
// and nothing was copied.
// The bar, always in this order: page tabs, "+", Messages, RRC,
// BBS, RMAP, Settings. Each app tab is put in its place when created; "+",
// the apps and Settings are kept in view at the right edge, side by side.
const APP_TAB_ORDER = ['messenger-tab', 'rrc-tab', 'retibbs-tab', 'rmap-tab'];

// The state of an app at a glance, a dot on its tab, the same colours as the
// hub and server lists: 'connected' green, 'connecting' yellow, 'failed' red,
// '' grey (off, or nothing open). The title says it in words.
function setAppTabState(tab, state, title) {
    if (!tab) return;
    let dot = tab.querySelector('.app-tab-state');
    if (!dot) {
        dot = document.createElement('span');
        tab.insertBefore(dot, tab.firstChild);          // before the icon and the name
    }
    const cls = `bbs-state app-tab-state${state ? ' bbs-state-' + state : ''}`;
    if (dot.className !== cls) dot.className = cls;
    if (dot.title !== title) dot.title = title;
}

// × at the end of an app tab: not a close (an app has no page to close) but
// switching the client off, as in its Settings, after asking. Not on phones:
// there the tabs are only icons, the clients are managed in Settings.
// The x on a client's tab, the same for every client: Cancel, Close
// tab (the client stays connected, in the background; back to the pages),
// Disconnect (only where there is something to disconnect; the client stays
// open) and Switch off.
// opts: { close() - hides the client, disconnect() - async, disconnectTip }
function addAppTabOff(tab, name, disable, opts = {}) {
    if (!tab || tab.querySelector('.app-tab-off')) return;
    const x = document.createElement('span');
    x.className = 'app-tab-off';
    x.textContent = '×';
    x.title = `Close the ${name} tab, disconnect or switch the client off`;
    x.addEventListener('click', async e => {
        e.stopPropagation();
        const choice = await appTabOffDialog(name, opts);
        try {
            if (choice === 'close') { if (opts.close) opts.close(); }
            else if (choice === 'disconnect') { await opts.disconnect(); showNotification(`${escapeHtml(name)}: disconnected`, 'info', 3000); }
            else if (choice === 'off') await disable();
        } catch (err) { showNotification(`${escapeHtml(name)}: ${escapeHtml(err.message || String(err))}`, 'error', 5000); }
    });
    tab.appendChild(x);
}

function appTabOffDialog(name, opts) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'auto-reload-modal';
        const n = escapeHtml(name);
        overlay.innerHTML = `<div class="auto-reload-dialog msg-warn-dialog app-off-dialog">
            <div class="dialog-header"><h3>${n}</h3></div>
            <div class="settings-hint"><b>Close tab</b>: the client stays connected in the background, back to the pages.
                ${opts.disconnect ? `<br><b>Disconnect</b>: ${escapeHtml(opts.disconnectTip || 'closes its connections, the client stays open')}.` : ''}
                <br><b>Switch off</b>: the client stops and its tab goes away (on again in Settings).</div>
            <div class="auto-reload-actions app-off-actions">
                <button class="btn-cancel" data-c="">Cancel</button>
                <button class="btn-cancel" data-c="close">Close tab</button>
                ${opts.disconnect ? '<button class="btn-cancel" data-c="disconnect">Disconnect</button>' : ''}
                <button class="btn-save btn-danger" data-c="off">Switch off</button>
            </div></div>`;
        const done = c => { overlay.remove(); document.removeEventListener('keydown', esc); resolve(c || null); };
        const esc = e => { if (e.key === 'Escape') done(null); };
        overlay.querySelectorAll('[data-c]').forEach(b => { b.onclick = () => done(b.dataset.c); });
        overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
        document.addEventListener('keydown', esc);
        document.body.appendChild(overlay);
        overlay.querySelector('[data-c="close"]').focus();
    });
}

function placeAppTab(tab) {
    const after = APP_TAB_ORDER.slice(APP_TAB_ORDER.indexOf(tab.id) + 1)
        .map(id => document.getElementById(id)).find(Boolean);
    const before = after || document.getElementById('tab-bar-settings');
    before.parentNode.insertBefore(tab, before);
    layoutAppTabs();
}

// On the desktop each tab is icon + name, so as wide as its text; on a
// phone only the icon, 30px (style.css), to leave room for the pages.
// Settings is hidden on phones (display none: width 0, it takes no room).
function layoutAppTabs() {
    const gear = document.getElementById('tab-bar-settings');
    if (gear && !gear.innerHTML && typeof GEAR_ICON !== 'undefined') gear.innerHTML = GEAR_ICON;
    let right = gear ? gear.offsetWidth : 0;
    for (const id of [...APP_TAB_ORDER].reverse()) {
        const tab = document.getElementById(id);
        if (!tab || tab.hidden) continue;
        tab.style.right = `${right}px`;
        right += tab.offsetWidth;
    }
    const plus = document.getElementById('new-tab-control');
    if (plus) plus.style.right = `${right}px`;
}
document.addEventListener('DOMContentLoaded', () => layoutAppTabs());
window.addEventListener('resize', () => layoutAppTabs());
// The names change width once the web font has loaded.
if (document.fonts) document.fonts.ready.then(() => layoutAppTabs());

function copyText(text, message) {
    const done = () => showNotification(message || `Copied:<br><code>${escapeHtml(text)}</code>`,
                                        'success', 3000);
    const fallback = () => {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
        area.remove();
    };
    // navigator.clipboard only exists in a secure context; opened from
    // another device on the LAN (plain http) it is undefined.
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
        fallback();
    }
}

// ─────────────────────────────────────────────────────────────
// Identities
//
// A node only knows who you are once you identify to it (the fingerprint,
// RNS link.identify()), and it keys accounts on that identity. Several
// identities are several accounts. The identities themselves, which one is
// in use, and which one each node was first identified to with all live on
// the server (rbrowser/identities.py); this keeps a copy of that state for
// the UI and refreshes it after every change.
// ─────────────────────────────────────────────────────────────

let identityState = null;

function shortAddr(hex) {
    return hex ? hex.slice(0, 10) + '…' : '';
}

function identityLabel(state = identityState) {
    if (!state) return 'your identity';
    return state.active === 'ephemeral'
        ? `Ephemeral ${shortAddr(state.active_identity.lxmf_address)}`
        : state.active_name;
}

function applyIdentityState(state) {
    if (!state || state.status !== 'success') return identityState;
    const before = identityState && identityState.active_identity.identity_hash;
    identityState = state;
    // A different identity has not identified anywhere yet in this session.
    if (before && before !== state.active_identity.identity_hash) {
        autoIdentifyState.clear();
    }
    updateAutoIdentifyButton();
    if (document.getElementById('identity-body')) renderIdentitySettings();
    scheduleEphemeralCheck();
    return state;
}

function loadIdentityState() {
    return fetch('/api/identities')
        .then(r => r.json())
        .then(applyIdentityState)
        .catch(err => { console.warn('Could not read identities:', err); return identityState; });
}

async function identityRequest(url, body = {}, isForm = false) {
    const options = { method: 'POST' };
    if (isForm) {
        options.body = body;
    } else {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({ status: 'error', error: `HTTP ${response.status}` }));
    if (data.status !== 'success') throw new Error(data.error || 'Request failed');
    applyIdentityState(data);
    return data;
}

function bindingFor(hash) {
    if (!identityState || !hash) return null;
    const wanted = String(hash).toLowerCase();
    return identityState.bindings.find(b => b.node === wanted) || null;
}

function updateIdentityChip() {
    const label = identityLabel();
    const ephemeral = identityState && identityState.active === 'ephemeral';
    document.querySelectorAll('.identity-chip').forEach(chip => {
        const name = chip.querySelector('.identity-chip-name');
        // Just "Ephemeral" on the button - the colour says it is a throwaway
        // identity; the address with it made the button too wide. The
        // address and identity hash are in the tooltip.
        if (name) name.textContent = identityState ? (ephemeral ? 'Ephemeral' : label) : '…';
        chip.classList.toggle('ephemeral', !!ephemeral);
        chip.title = identityState
            ? `Identity in use: ${label}\nLXMF ${identityState.active_identity.lxmf_address}\n`
              + `Identity hash ${identityState.active_identity.identity_hash}\n`
              + 'Visible to a node after identify. Click = choose another.'
            : 'Identity';
    });
}

// The identity button in the page bar: a menu to browse as another
// identity, like "Write as" in the messenger and "Chat as" in RRC.
function toggleBrowserIdentityMenu(chip, force) {
    let menu = document.getElementById('identity-chip-menu');
    const open = force !== undefined ? force : !menu;
    if (menu) menu.remove();
    if (!open || !chip) return;
    const s = identityState;
    if (!s) { loadIdentityState().then(() => toggleBrowserIdentityMenu(chip, true)); return; }
    const current = s.ephemeral_on ? 'ephemeral' : s.active;
    const avatar = (addr, name) => typeof avatarHtml === 'function' ? avatarHtml(addr, name, 'small', false) : '';
    const item = (id, name, addr, extra = '') => `
        <button class="msg-menu-item${id === current ? ' current' : ''}${id === 'ephemeral' ? ' ephemeral' : ''}" data-id="${escapeHtml(id)}">
            ${avatar(addr, name)}
            <span class="msg-menu-text"><b>${escapeHtml(name)}</b>${extra}<code>${escapeHtml(addr || '')}</code></span>
            ${id === current ? '<span class="msg-menu-check">✓</span>' : ''}
        </button>`;
    menu = document.createElement('div');
    menu.id = 'identity-chip-menu';
    menu.className = 'msg-identity-menu identity-chip-menu';
    menu.innerHTML = '<div class="msg-menu-head">Browse as</div>'
        + s.profiles.filter(p => p.loadable).map(p => item(p.id, p.name, p.lxmf_address)).join('')
        + item('ephemeral', 'Ephemeral', s.ephemeral ? s.ephemeral.lxmf_address : '',
               '<span class="msg-menu-nick">a throwaway identity, renewed</span>')
        + '<div class="msg-menu-sep"></div>'
        + (s.ephemeral_on ? '<button class="msg-menu-item plain" data-act="rotate">New ephemeral identity now</button>' : '')
        + '<button class="msg-menu-item plain" data-act="copy">Copy my identity hash</button>'
        + '<button class="msg-menu-item plain" data-act="settings">Identity settings…</button>';
    document.body.appendChild(menu);
    const r = chip.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.position = 'fixed';
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    menu.addEventListener('click', async e => {
        const btn = e.target.closest('.msg-menu-item');
        if (!btn) return;
        e.stopPropagation();
        menu.remove();
        const act = btn.dataset.act;
        if (act === 'copy') return copyText(s.active_identity.identity_hash, 'Identity hash copied');
        if (act === 'settings') return showSettings('identity');
        if (act === 'rotate') return rotateEphemeral();
        const id = btn.dataset.id;
        if (!id || id === current) return;
        if (id === 'ephemeral') return toggleEphemeral(true);
        if (s.ephemeral_on) {
            await toggleEphemeral(false);
            if (identityState && identityState.active === id) return;
        }
        await useIdentity(id);
    });
}

document.addEventListener('mousedown', e => {
    if (!e.target.closest('#identity-chip-menu, .identity-chip')) toggleBrowserIdentityMenu(null, false);
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('identity-chip-menu')) toggleBrowserIdentityMenu(null, false);
});

// ─────────────────────────────────────────────────────────────
// Fingerprint
// ─────────────────────────────────────────────────────────────

async function sendFingerprintToNode(hash, name) {
    if (!identityState) await loadIdentityState();
    const safeName = escapeHtml(name || hash);
    const label = escapeHtml(identityLabel());
    const lxmf = identityState ? identityState.active_identity.lxmf_address : '';
    const binding = bindingFor(hash);
    const otherAccount = binding && identityState && binding.profile_id !== identityState.active;

    let html = `
        <strong>Node:</strong> ${safeName}<br>
        <strong>Hash:</strong> <span class="mono">${escapeHtml(hash)}</span><br><br>
        You will identify as <strong>${label}</strong><br>
        <span class="choice-sub">LXMF <span class="mono">${escapeHtml(lxmf)}</span></span><br><br>
        The node operator will see this identity hash and LXMF address.`;
    const buttons = [{ label: 'Cancel', value: null }];

    if (otherAccount) {
        html += `<div class="choice-warning">You first identified to this node as
            <strong>${escapeHtml(binding.profile_name)}</strong>. Identifying as
            <strong>${label}</strong> makes the node see a different user: a separate account.</div>`;
        buttons.push({ label: `Switch to ${binding.profile_name} and send`, value: 'switch' });
        buttons.push({ label: 'Send as new user', value: 'send', primary: true });
    } else {
        buttons.push({ label: 'Send', value: 'send', primary: true });
    }

    const choice = await showChoiceDialog({ title: 'Send identity fingerprint?', html, buttons });
    if (!choice) return;
    if (choice === 'switch') {
        try {
            await identityRequest('/api/identities/active', { id: binding.profile_id });
        } catch (e) {
            showNotification(`Could not switch identity: ${escapeHtml(e.message)}`, 'error', 5000);
            return;
        }
    }
    performFingerprintSend(hash, name);
}

function performFingerprintSend(hash, name) {
    const notification = showNotification(
        `Sending identity fingerprint to ${escapeHtml(name)}...<br>Please wait while your identity is transmitted.`,
        'info',
        10000
    );

    fetch(`/api/fingerprint/${hash}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    .then(response => response.json())
    .then(data => {
        if (notification.parentNode) notification.parentNode.removeChild(notification);

        if (data.status === 'success') {
            autoIdentifyState.set(hash, 'done');
            // The server bound this node to the identity if it was the first
            // one used here; pick that up for the auto-identify button.
            loadIdentityState();

            showNotification(
                `Identified to ${escapeHtml(name)} as <strong>${escapeHtml(data.profile_name || identityLabel())}</strong>.`
                + '<br><br>Page reloaded.',
                'success',
                6000
            );
            // Reload so the node can show the page for the identified user.
            setTimeout(() => refreshPageTab(), 1000);
        } else {
            showNotification(
                `Failed to send identity fingerprint to ${escapeHtml(name)}<br><br><strong>Error:</strong> ${escapeHtml(data.error || 'Unknown error')}`,
                'error',
                8000
            );
        }
    })
    .catch(error => {
        if (notification.parentNode) notification.parentNode.removeChild(notification);
        console.error('Identity fingerprint send error:', error);
        showNotification(
            `Network error sending identity fingerprint to ${escapeHtml(name)}<br><br><strong>Error:</strong> ${escapeHtml(error.message)}`,
            'error',
            6000
        );
    });
}

// ─────────────────────────────────────────────────────────────
// Auto-identify
//
// Each node remembers the identity you first identified to it with (on the
// server, so it survives a change of port, which would empty localStorage).
// With the switch on, opening one of its pages sends the fingerprint on its
// own - with that identity. If a different one is in use, it asks before
// switching, because the switch applies to every tab.
//
// The identity lives on the link, not on the node: when the link times out
// (or rBrowser restarts) the next one is anonymous again. So each page load
// says whether its link is identified, and an unidentified one is identified
// again. Per node: 'pending' while the request is out (two page loads close
// together must not both send), 'done' after it worked, 'skip' after a
// refusal or a "Not now" - those are not retried this session.
// ─────────────────────────────────────────────────────────────

const LEGACY_AUTO_IDENTIFY_KEY = 'rbrowser_auto_identify';
const LEGACY_IDENTIFIED_NODES_KEY = 'rbrowser_identified_nodes';
const autoIdentifyState = new Map();

function isAutoIdentifyEnabled() {
    return !!(identityState && identityState.auto_identify);
}

function getIdentifiedNodes() {
    return identityState ? identityState.bindings.map(b => b.node) : [];
}

function updateAutoIdentifyButton() {
    updateIdentityChip();
    const button = document.querySelector(`#${activeTabId} .auto-identify-btn`);
    if (!button) return;

    const on = isAutoIdentifyEnabled();
    const remembered = getIdentifiedNodes().length;

    button.classList.toggle('active', on);
    button.title = on
        ? `Auto-identify is ON (${remembered} node${remembered === 1 ? '' : 's'} `
          + 'remembered). Opening a page from one of them sends the fingerprint on '
          + 'its own, with the identity you first used there. Click to turn off.'
        : 'Auto-identify is OFF. Turn it on and rBrowser sends your fingerprint on '
          + 'its own when you open a page from a node you have identified to, with '
          + 'the identity you first used there.';
}

async function toggleAutoIdentify() {
    if (!identityState) await loadIdentityState();
    const turningOn = !isAutoIdentifyEnabled();
    try {
        await identityRequest('/api/identities/options', { auto_identify: turningOn });
    } catch (e) {
        showNotification(`Could not change auto-identify: ${escapeHtml(e.message)}`, 'error', 5000);
        return;
    }
    if (turningOn) {
        const remembered = getIdentifiedNodes().length;
        showNotification(
            'Auto-identify is on.<br>Nodes you identify to are remembered with the identity you used'
            + (remembered ? ` (${remembered} already)` : '')
            + ', and the fingerprint goes out on its own when you open their pages.',
            'success', 5000);
    } else {
        showNotification('Auto-identify is off', 'info', 3000);
    }
}

async function forgetIdentifiedNodes() {
    const nodes = getIdentifiedNodes();
    for (const node of nodes) {
        try { await identityRequest('/api/identities/bindings', { node, profile_id: null }); } catch (e) {}
    }
    autoIdentifyState.clear();
    showNotification(`Forgot ${nodes.length} remembered node${nodes.length === 1 ? '' : 's'}`, 'success', 3000);
}

function autoIdentifyToNode(hash, name) {
    // Marked before the request, not after: two page loads arriving close
    // together must not both decide they are the first.
    autoIdentifyState.set(hash, 'pending');

    fetch(`/api/fingerprint/${hash}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
        .then(r => r.json())
        .then(data => {
            if (data.status === 'success') {
                autoIdentifyState.set(hash, 'done');
                showNotification(
                    `Identified automatically to ${escapeHtml(name)} as `
                    + `<strong>${escapeHtml(data.profile_name || identityLabel())}</strong> - reloading the page`,
                    'success', 3500);
                setTimeout(() => refreshPageTab(), 900);
            } else {
                // Leave it marked: a node that refuses the fingerprint will
                // refuse it again, and retrying on every page is noise on
                // the radio for nothing.
                autoIdentifyState.set(hash, 'skip');
                showNotification(
                    `Auto-identify to ${escapeHtml(name)} failed: `
                    + escapeHtml(data.error || 'unknown error'),
                    'warning', 5000);
            }
        })
        .catch(err => {
            autoIdentifyState.set(hash, 'skip');
            showNotification(`Auto-identify to ${escapeHtml(name)} failed: `
                             + escapeHtml(err.message), 'warning', 5000);
        });
}

// linkIdentified: what the server said about the link the page came on -
// true, false, or undefined when it does not know (a page from the cache).
async function maybeAutoIdentify(hash, name, linkIdentified) {
    if (!hash) return;
    if (linkIdentified === true) { autoIdentifyState.set(hash, 'done'); return; }
    const state = autoIdentifyState.get(hash);
    // Identified earlier, but this page came on a link that is not: the
    // identified one has closed since. Identify again.
    if (state === 'done' && linkIdentified === false) autoIdentifyState.delete(hash);
    else if (state) return;
    if (!identityState) await loadIdentityState();
    if (!isAutoIdentifyEnabled()) return;

    const binding = bindingFor(hash);
    if (!binding) return;

    if (binding.profile_id === identityState.active) {
        autoIdentifyToNode(hash, name);
        return;
    }

    // Asked once per node per session: "Not now" means not on every page.
    autoIdentifyState.set(hash, 'skip');
    const current = escapeHtml(identityLabel());
    const wanted = escapeHtml(binding.profile_name);
    const choice = await showChoiceDialog({
        title: 'Switch identity?',
        html: `You first identified to <strong>${escapeHtml(name)}</strong> as
               <strong>${wanted}</strong>, and you are using <strong>${current}</strong> now.<br><br>
               Auto-identify will switch to <strong>${wanted}</strong> and identify.
               <div class="choice-warning">The switch applies to every tab: nodes you are
               identified to as ${current} will see you as anonymous until you identify again.</div>`,
        buttons: [{ label: 'Not now', value: null },
                  { label: `Switch to ${binding.profile_name}`, value: 'switch', primary: true }]
    });
    if (choice !== 'switch') return;

    try {
        await identityRequest('/api/identities/active', { id: binding.profile_id });
    } catch (e) {
        showNotification(`Could not switch identity: ${escapeHtml(e.message)}`, 'error', 5000);
        return;
    }
    autoIdentifyToNode(hash, name);
}

// The page used to keep the auto-identify switch and node list in
// localStorage. Hand them to the server once, bound to the default identity
// (the only one there was), then drop the local copy.
async function migrateLegacyAutoIdentify() {
    let nodes = [];
    let flag = null;
    try {
        nodes = JSON.parse(localStorage.getItem(LEGACY_IDENTIFIED_NODES_KEY) || '[]');
        const raw = localStorage.getItem(LEGACY_AUTO_IDENTIFY_KEY);
        flag = raw === null ? null : raw === '1';
    } catch (e) {
        return;
    }
    if (!Array.isArray(nodes)) nodes = [];
    if (!nodes.length && flag === null) return;
    try {
        await identityRequest('/api/identities/migrate', { nodes, auto_identify: flag });
        localStorage.removeItem(LEGACY_IDENTIFIED_NODES_KEY);
        localStorage.removeItem(LEGACY_AUTO_IDENTIFY_KEY);
    } catch (e) {
        console.warn('Could not migrate the auto-identify list:', e);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadIdentityState();
    await migrateLegacyAutoIdentify();
});

// ─────────────────────────────────────────────────────────────
// Reload, as pressed by the user
//
// With the ephemeral identity set to "new at every reload", this is where
// it is replaced: the reload button and Alt+B only. Following links keeps
// it, so a node you identified to does not log you out on every click, and
// the reload a successful identify triggers goes through refreshPageTab()
// directly and keeps it too.
// ─────────────────────────────────────────────────────────────

async function confirmDropEphemeral(actionLabel) {
    const used = (identityState && identityState.ephemeral.used_on) || [];
    if (!used.length) return 'replace';
    const names = used.map(u => escapeHtml(u.node_name || u.node.slice(0, 16))).join(', ');
    return showChoiceDialog({
        title: 'Replace the ephemeral identity?',
        html: `The current ephemeral identity identified to <strong>${names}</strong>.
               Once it is replaced, those accounts can never be reached again.<br><br>
               Keep it as a saved identity to be able to come back to them.`,
        buttons: [{ label: 'Cancel', value: null },
                  { label: actionLabel, value: 'replace', danger: true },
                  { label: 'Keep it first', value: 'keep', primary: true }]
    });
}

async function keepEphemeral() {
    const name = await askText('Keep the ephemeral identity',
        'It becomes a saved identity, stays in use, and the nodes it identified to '
        + 'remember it for auto-identify.', 'Kept identity', 'Keep');
    if (name === null) return false;
    try {
        const state = await identityRequest('/api/identities/ephemeral/keep', { name });
        showNotification(`Saved as <strong>${escapeHtml(state.active_name)}</strong>, now in use`, 'success', 4000);
        return true;
    } catch (e) {
        showNotification(`Could not keep the identity: ${escapeHtml(e.message)}`, 'error', 5000);
        return false;
    }
}

async function rotateEphemeral(actionLabel = 'Replace it') {
    const choice = await confirmDropEphemeral(actionLabel);
    if (!choice) return false;
    if (choice === 'keep') return (await keepEphemeral()) ? 'kept' : false;
    try {
        const state = await identityRequest('/api/identities/ephemeral/rotate');
        if (state.active === 'ephemeral') {
            showNotification(`New ephemeral identity ${escapeHtml(shortAddr(state.active_identity.lxmf_address))}`,
                             'info', 2500);
        }
        return 'rotated';
    } catch (e) {
        showNotification(`Could not replace the ephemeral identity: ${escapeHtml(e.message)}`, 'error', 5000);
        return false;
    }
}

async function userReloadPageTab() {
    const s = identityState;
    if (s && s.active === 'ephemeral' && s.ephemeral_mode === 'reload') {
        const outcome = await rotateEphemeral('Replace and reload');
        if (!outcome) return;
    }
    refreshPageTab();
}

function sendFingerprintToCurrentNode() {
    const tab = getActiveTab();
    if (!tab || !tab.selectedNode) {
        showNotification(
            'No current node selected for fingerprint',
            'warning',
            4000
        );
        return;
    }

    const nodeName = tab.knownNodeName || getNodeName(tab.selectedNode);
    sendFingerprintToNode(tab.selectedNode, nodeName);
}

// ─────────────────────────────────────────────────────────────────────────
// Load report
//
// Over Reticulum a page can take anywhere from a fraction of a second to
// most of a minute depending on the path, and the only thing that explains
// the difference is how far away the node is and how big the page is. Both
// numbers are worth seeing.
// ─────────────────────────────────────────────────────────────────────────

function formatLoadTime(ms) {
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 10000) return (ms / 1000).toFixed(2) + ' s';
    return (ms / 1000).toFixed(1) + ' s';
}

// ─────────────────────────────────────────────────────────────
// Where the page came from
//
// With a cache in the way, "this page loaded in 40 ms" is only honest if
// you can also see that those 40 ms were a disk read. The badge sits in
// the header next to the path, and the reload button is what turns a
// cached page back into a fetched one.
// ─────────────────────────────────────────────────────────────

function formatAge(seconds) {
    if (seconds == null || isNaN(seconds)) return '';
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago';
    return Math.round(seconds / 86400) + ' d ago';
}

function sourceBadgeHtml(response) {
    if (!response) return '';
    const source = response.source;

    // The copy on screen was removed from the cache afterwards
    // (removeNodeFromCache): it is still shown, but no longer on disk.
    const gone = response.cache_removed ? ' - deleted from disk' : '';
    if (source === 'cache') {
        const age = formatAge(response.age_seconds);
        return ` <span class="source-badge from-cache" title="Read from the local cache, stored when you last visited this page. Press reload to fetch it from the node again.">from cache${age ? ' - ' + escapeHtml(age) : ''}${gone}</span>`;
    }
    if (source === 'cache-fallback') {
        const age = formatAge(response.age_seconds);
        const why = response.fetch_error ? ' (' + escapeHtml(String(response.fetch_error)) + ')' : '';
        return ` <span class="source-badge from-stale" title="The node could not be reached${why}, so the copy stored on your disk is being shown instead.">cached copy - node unreachable${age ? ', ' + escapeHtml(age) : ''}${gone}</span>`;
    }
    if (source === 'network') {
        const kept = response.cached ? ' and saved' : '';
        return ` <span class="source-badge from-network" title="Fetched from the node over Reticulum${kept ? ' and stored in the local cache' : ''}.">live${kept}</span>`;
    }
    return '';
}

// The pill before the address bar, like a browser's padlock: always says
// whether the page on screen is live, a saved copy, or the copy shown
// because the node did not answer. A copy is one click from the live page.
// response null = loading or failed, nothing to say.
function setPageSource(tab, response) {
    // Kept for removeNodeFromCache, which redraws the pill and the badge.
    tab.pageResponse = response;
    const pill = document.querySelector(`#${tab.id} .source-pill`);
    if (!pill) return;
    const source = response ? response.source : null;
    const age = response ? formatAge(response.age_seconds) : '';
    const gone = response && response.cache_removed
        ? '\nThis copy has since been deleted from the disk.' : '';
    // Never disabled, even when live: Chrome shows no tooltip on a
    // disabled button. The click does nothing then (sourcePillClick).
    pill.className = 'source-pill';

    if (source === 'network') {
        pill.classList.add('is-live');
        pill.textContent = 'LIVE';
        pill.dataset.tip = liveSourceTitle(response);
    } else if (source === 'cache') {
        const keep = response.cache_time ? formatDuration(response.cache_time) : '';
        const left = response.cache_time && response.age_seconds != null
            ? formatDuration(Math.max(60, response.cache_time - response.age_seconds)) : '';
        pill.classList.add('is-cache');
        setPillLabel(pill, 'CACHE' + (response.cache_removed ? ' · deleted' : (age ? ' · ' + age : '')));
        pill.dataset.tip = `Saved copy, from ${age || 'an earlier visit'}. Not fetched from the node.`
            + (keep && !gone ? `\nThe node lets its pages be reused for ${keep}: valid for ${left} more, then read live again.` : '')
            + gone
            + '\nClick to load the live page.';
    } else if (source === 'cache-fallback') {
        pill.classList.add('is-offline');
        setPillLabel(pill, 'OFFLINE COPY' + (age ? ' · ' + age : ''));
        pill.dataset.tip = 'The node did not answer'
            + (response.fetch_error ? ` (${response.fetch_error})` : '')
            + `.\nThis is the copy saved on your disk${age ? ' ' + age : ''}, it may be out of date.`
            + (response.cache_time === 0 ? '\nThe page is normally always read live (#!c=0).' : '')
            + gone
            + '\nClick to try the node again.';
    } else {
        pill.hidden = true;
        hideSourceTip();
        return;
    }
    pill.hidden = false;
    // A page just loaded may have changed what the cache holds.
    scheduleNodeCacheSummary();
}

// Word for desktop, floppy for phones (the CSS picks one): "CACHE · 3 h ago"
// does not fit the phone nav bar.
const PILL_DISK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 3A1.5 1.5 0 0 1 4 1.5h6.8l2.7 2.7V12A1.5 1.5 0 0 1 12 13.5H4A1.5 1.5 0 0 1 2.5 12z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 1.8v3h5v-3M5 13.3V9.5h6v3.8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
function setPillLabel(pill, text) {
    pill.innerHTML = `<span class="pill-text"></span><span class="pill-icon">${PILL_DISK}</span>`;
    pill.firstChild.textContent = text;
    pill.setAttribute('aria-label', text);
}

// Live: why it went to the node, and what the cache now holds.
function liveSourceTitle(response) {
    const lines = ['Live: fetched from the node just now.'];
    const prev = formatAge(response.previous_age_seconds);
    const why = {
        'reload': 'Reloaded: a reload always asks the node.',
        'not-saved': 'First visit: there was no saved copy.',
        'expired': `The saved copy${prev ? ' (' + prev + ')' : ''} was older than the node allows.`,
        'no-cache-header': 'The page says #!c=0: it is always read live.',
        'serving-off': 'Showing saved copies is off in Settings.',
        'auto-identify': 'Auto-identify is on for this node, so it is read live.',
        'identified': 'You are identified on this node: its pages are yours and are never cached.',
        'form': 'The answer to a form is never cached.',
        'cache-off': 'The cache is off in Settings.'
    }[response.live_reason];
    if (why) lines.push(why);

    if (response.cached) {
        const keep = response.cache_time ? formatDuration(response.cache_time) : '';
        if (!keep) {
            lines.push('Saved in the cache, for search and for when the node is offline only.');
        } else if (response.cache_serving) {
            lines.push(`Saved in the cache: visits in the next ${keep} use the saved copy.`);
        } else {
            lines.push('Saved in the cache, for search and for when the node is offline.');
        }
    } else if (!['identified', 'form', 'cache-off'].includes(response.live_reason)) {
        lines.push('Not saved in the cache.');
    }
    return lines.join('\n');
}

function formatDuration(seconds) {
    if (seconds < 3600) return Math.round(seconds / 60) + ' min';
    if (seconds < 86400) return Math.round(seconds / 3600) + ' h';
    return Math.round(seconds / 86400) + ' d';
}

// The pill's explanation, in a themed box right under it. The native
// title tooltip came late, small, and not at all on a disabled button.
function showSourceTip(pill) {
    const text = pill.matches('.node-dot, .node-cache') ? nodeDotTip(pill) : pill.dataset.tip;
    if (!text || pill.hidden) return;
    let tip = document.getElementById('source-tip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'source-tip';
        tip.className = 'source-tip';
        document.body.appendChild(tip);
    }
    tip.textContent = text;
    const r = pill.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 420)) + 'px';
    tip.classList.add('open');
    // Above the element when there is no room below (cards low in the list).
    const below = r.bottom + 6;
    tip.style.top = (below + tip.offsetHeight > window.innerHeight - 8
        ? Math.max(8, r.top - tip.offsetHeight - 6) : below) + 'px';
}

function hideSourceTip() {
    const tip = document.getElementById('source-tip');
    if (tip) tip.classList.remove('open');
}

document.addEventListener('mouseover', e => {
    const pill = e.target.closest && e.target.closest('.source-pill, .node-dot, .node-cache, .node-visits, .node-hops');
    if (pill) showSourceTip(pill);
});
document.addEventListener('mouseout', e => {
    const pill = e.target.closest && e.target.closest('.source-pill, .node-dot, .node-cache, .node-visits, .node-hops');
    if (pill && !pill.contains(e.relatedTarget)) hideSourceTip();
});

// Saved pages per node, for the dots in the node list: a ring on the dot
// when the node has pages, amber when a visit would open them from the
// cache now. Refreshed every 30 s and after each page load.
let nodeCacheSummary = {};
let nodeCacheServing = true;
let nodeCacheSummaryTimer = null;

async function refreshNodeCacheSummary() {
    try {
        const data = await fetch('/api/cache/summary').then(r => r.json());
        nodeCacheSummary = data.nodes || {};
        nodeCacheServing = data.serving !== false;
    } catch (e) {
        return;
    }
    document.querySelectorAll('#node-list .node-item').forEach(applyNodeCacheMark);
}

function scheduleNodeCacheSummary(delay = 1500) {
    clearTimeout(nodeCacheSummaryTimer);
    nodeCacheSummaryTimer = setTimeout(refreshNodeCacheSummary, delay);
}

function nodeCacheState(hash) {
    const entry = nodeCacheSummary[String(hash).toLowerCase()];
    if (!entry) return '';
    return entry.usable && nodeCacheServing ? 'usable' : 'saved';
}

function applyNodeCacheMark(item) {
    const hash = String(item.getAttribute('data-hash')).toLowerCase();
    const state = nodeCacheState(hash);
    if ((item.getAttribute('data-cache') || '') !== state) {
        if (state) item.setAttribute('data-cache', state);
        else item.removeAttribute('data-cache');
    }
    // The foot of the card: a disk and the number of saved pages.
    const badge = item.querySelector('.node-cache');
    if (badge) {
        const entry = nodeCacheSummary[hash];
        badge.hidden = !entry;
        const count = badge.querySelector('.node-cache-count');
        const text = entry ? String(entry.count) : '';
        if (count && count.textContent !== text) count.textContent = text;
    }
}

// Shared by the dot and the disk at the foot of the card.
function nodeDotTip(el) {
    const item = el.closest('.node-item');
    const hash = item ? String(item.getAttribute('data-hash')).toLowerCase() : '';
    const dot = item ? item.querySelector('.node-dot') : null;
    const lines = [(dot && dot.dataset.tip) || ''];
    const node = cachedNodes.find(n => String(n.hash).toLowerCase() === hash);
    const visits = node && node.visits ? node.visits : 0;
    lines.push(visits ? `You opened its pages ${visits} time${visits === 1 ? '' : 's'}.`
                      : 'You have not opened it yet.');

    const entry = nodeCacheSummary[hash];
    const n = k => `${k} page${k === 1 ? '' : 's'}`;
    if (!entry) {
        lines.push('Cache: no copies saved on this computer.');
    } else {
        lines.push(`Cache: ${n(entry.count)} copied on this computer.`);
        if (!nodeCacheServing) {
            lines.push('Using copies is off in Settings: pages always come from the node,'
                       + '\nthe copies are only shown if the node is offline.');
        } else {
            const usable = entry.usable || 0;
            const expired = entry.expired || 0;
            const liveOnly = entry.live_only || 0;
            const one = k => k === 1;
            lines.push('Opening them now:');
            if (usable) {
                lines.push(`- ${usable} from the copy, instantly`
                           + ` (${one(usable) ? 'it is' : 'they are'} recent enough for the node).`);
            }
            if (expired) {
                lines.push(`- ${expired} from the node: the copy is older than the node allows.`);
            }
            if (liveOnly) {
                lines.push(`- ${liveOnly} from the node, always (marked as changing, #!c=0).`);
            }
            lines.push('If the node is offline, the copies are shown instead.');
        }
    }
    const open = tabs.filter(t => t.selectedNode && String(t.selectedNode).toLowerCase() === hash);
    open.forEach(t => {
        const pill = document.querySelector(`#${t.id} .source-pill`);
        if (pill && !pill.hidden) {
            lines.push(`Open in a tab: ${pill.textContent}${t.currentUrl ? ' - ' + (t.currentUrl.split(':').slice(1).join(':') || '') : ''}`);
        }
    });
    return lines.filter(Boolean).join('\n');
}

function sourcePillClick(pill) {
    hideSourceTip();
    if (pill.classList.contains('is-cache') || pill.classList.contains('is-offline')) {
        refreshPage();
    }
}

// Two lines: which page (node and path) on top, how it loaded underneath.
// With several pages loading at once, a bare "Page loaded in 2 s" did not
// say which one had arrived.
function reportPageLoad(content, startedAt, source, nodeName, path) {
    const elapsed = formatLoadTime(performance.now() - startedAt);
    // Byte length, not character count: a Micron page is UTF-8 on the wire
    // and box drawing characters are three bytes each, so counting
    // characters would understate an artwork page by a factor of three.
    let bytes = 0;
    try {
        bytes = new TextEncoder().encode(content || '').length;
    } catch (e) {
        bytes = (content || '').length;
    }
    const size = formatFileSize(bytes);
    const labels = {
        'cache': ' - from cache',
        'cache-fallback': ' - cached copy, node unreachable',
        'network': ' - live'
    };
    const where = labels[source] || (source ? ` (${escapeHtml(source)})` : '');
    const which = [nodeName, path].filter(Boolean).map(escapeHtml).join(' ');
    showNotification(
        (which ? `<strong>${which}</strong><br>` : '')
        + `Loaded in ${elapsed} - ${size}${where}`,
        'success', 3500);
}

function fetchPageByUrlTab(hash, path, originalUrl, forceFresh = false, targetTab = null) {
    // The tab is passed in by callers that awaited something first: by then
    // the user may have switched or opened a tab, and getActiveTab() would
    // load the page into the wrong one (and abort that tab's own load).
    const tab = targetTab || getActiveTab();
    if (!tab) return;
    
    if (tab.currentRequest) {
        tab.currentRequest.abort();
        tab.currentRequest = null;
    }
    
    tab.selectedNode = hash;
    tab.setLoading(true);
    setPageSource(tab, null);

    let nodeName = getNodeName(hash);
    tab.knownNodeName = nodeName;
    
    const pageTitle = document.querySelector(`#${tab.id} .page-title`);
    const pageUrl = document.querySelector(`#${tab.id} .page-url`);
    const pageContent = document.querySelector(`#${tab.id} .page-content`);
    const viewToggle = document.querySelector(`#${tab.id} .view-toggle`);
    const addressBar = document.querySelector(`#${tab.id} .address-bar`);
    
    if (pageTitle) {
        pageTitle.innerHTML = `<span class="label">Loading:</span> <span class="value">${escapeHtml(nodeName)}</span>`;
    }
    const pageDetails = document.querySelector(`#${tab.id} .page-details`);
    if (pageDetails) {
        pageDetails.innerHTML = `<span class="label">Page Path:</span> <span class="value">${escapeHtml(path)}</span> <span class="label">Full Address:</span> <span class="value">${escapeHtml(originalUrl)}</span>`;
    }
    applyPageColors(pageContent, "");
    if (pageContent) pageContent.innerHTML = `<div class="page-loading">Loading NomadNet page:<br><br><strong>${escapeHtml(nodeName)}</strong><br><br>Please wait...</div>`;
    if (viewToggle) viewToggle.style.display = 'none';
    if (addressBar) addressBar.value = originalUrl;
    
    // Only update tab title if this is the active tab
    if (tab.id === activeTabId) {
        tab.setTitle(`Loading ${nodeName}...`);
    } else {
        // Silently update without triggering display changes
        tab.title = `Loading ${nodeName}...`;
    }
    
    // Only the tab on screen decides what the node list highlights; a page
    // arriving in a background tab must not move the selection.
    if (tab.id === activeTabId) updateNodeSelection();
    
    const controller = new AbortController();
    tab.currentRequest = controller;
    const loadStartedAt = performance.now();

    const fetchUrl = `/api/fetch/${hash}?path=${encodeURIComponent(path)}`
                   + (forceFresh ? '&fresh=1' : '')
                   + (tab.skipVisitCount ? '&visit=0' : '');
    tab.skipVisitCount = false;

    fetch(fetchUrl, { signal: controller.signal })
        .then(r => r.json())
        .then(response => {
            if (tab.currentRequest === controller) {
                if (response.status === 'success') {
                    tab.currentRawContent = response.content;
                    tab.isRawView = false;
                    
                    const renderedHtml = parseMicronContent(response.content);
                    if (pageContent) pageContent.innerHTML = renderedHtml;
                    if (pageContent) pageContent.className = 'page-content';
                    applyPageColors(pageContent, response.content);
                    
                    // A node not heard since startup: the server knows its name from the cache.
                    nodeName = adoptNodeName(hash, nodeName, response.node_name, tab);
                    if (pageTitle) {
                        pageTitle.innerHTML = `<span class="node-name">${escapeHtml(nodeName)}</span>`;
                    }
                    const pageDetails = document.querySelector(`#${tab.id} .page-details`);
                    if (pageDetails) {
                        pageDetails.innerHTML = `<span class="path-info">${escapeHtml(path)}</span> <span class="label">- Address:</span> <span class="address-info">${escapeHtml(originalUrl)}</span>` + sourceBadgeHtml(response);
                    }
                    setPageSource(tab, response);

                    if (viewToggle) {
                        viewToggle.style.display = 'block';
                        setViewToggleLabel(viewToggle, false);
                    }


                    // Auto-detect and apply

                    // Only update title if this tab is still active
                    if (tab.id === activeTabId) {
                        tab.setTitle(nodeName);
                    } else {
                        // Silently update title without triggering display update
                        tab.title = nodeName;
                    }
                    
                    updateAutoReloadButton();
                    updateAutoIdentifyButton();
                    addClickHandlersToCurrentTab(tab);
                    hydrateMicronMedia(tab);
                    refitPageZoom();
                    requestAnimationFrame(() => refitPageZoom());
                    initScrollHint(tab);
                    updateScrollHint(tab);
                    reportPageLoad(response.content, loadStartedAt, response.source, nodeName, path);
                    // An old copy because the node is unreachable: an identify
                    // now would fail, and a failure is not retried this session.
                    if (response.source !== 'cache-fallback') {
                        maybeAutoIdentify(hash, nodeName, response.identified);
                    }

                } else if (response.not_a_node) {
                    // A page linked an RRC hub, an LXMF address... as if it
                    // were a node: the network is fine, there is just no
                    // page there. Answered at once, nothing to wait for.
                    if (pageContent) pageContent.innerHTML = `<div class="error">${escapeHtml(response.error)}<br><br>The address was reached, but it belongs to something that does not serve pages. The link on the page that brought you here points to it as if it were a node.</div>`;
                    if (pageTitle) pageTitle.textContent = `Not a NomadNet node: ${originalUrl}`;
                    if (pageUrl) pageUrl.textContent = '';
                    if (viewToggle) viewToggle.style.display = 'none';
                    updateAutoReloadButton();
                    tab.failed = true;
                    if (tab.id === activeTabId) tab.setTitle('Not a node');
                    else { tab.title = 'Not a node'; tab.updateTabDisplay(); }
                } else {
                    if (pageContent) pageContent.innerHTML = `<div class="error">Failed to load page: ${escapeHtml(response.error)}<br><br>This could be due to network issues or, more commonly, the node being offline / unreachable.<br><br>Check your connection and logs to ensure you are connected and script is running.<br><br>Send a ping to the remote host to check if it's alive or not.</div>`;
                    if (pageTitle) pageTitle.textContent = `Error loading ${originalUrl}`;
                    if (pageUrl) pageUrl.textContent = '';
                    if (viewToggle) viewToggle.style.display = 'none';
                    
                    updateAutoReloadButton();

                    // Only update title if this tab is still active
                    if (tab.id === activeTabId) {
                        tab.failed = true; tab.setTitle('Error');
                    } else {
                        tab.failed = true; tab.title = 'Error'; tab.updateTabDisplay();
                    }
                }
                tab.currentRequest = null;
                tab.setLoading(false);
            }
        })
        .catch(err => {
            if (tab.currentRequest === controller && !controller.signal.aborted) {
                if (pageContent) pageContent.innerHTML = `<div class="error">Network error: ${escapeHtml(err.message)}<br><br>Please check your connection and try again.</div>`;
                if (pageTitle) pageTitle.textContent = `Error loading ${originalUrl}`;
                if (pageUrl) pageUrl.textContent = '';
                if (viewToggle) viewToggle.style.display = 'none';
                tab.currentRequest = null;
                tab.setLoading(false);
                
                // Only update title if this tab is still active
                if (tab.id === activeTabId) {
                    tab.failed = true; tab.setTitle('Network Error');
                } else {
                    tab.failed = true; tab.title = 'Network Error'; tab.updateTabDisplay();
                }
            }
        });
}

        // Names learned from page responses, for nodes that are not in the
        // announce list (not heard since startup) but whose name the page
        // cache remembers.
        const knownNodeNames = {};

        function getNodeName(hash) {
            const nodeItem = document.querySelector(`.node-item[data-hash="${hash}"]`);
            if (nodeItem && nodeItem.getAttribute('data-name')) {
                return nodeItem.getAttribute('data-name');
            }
            const cachedNode = cachedNodes.find(node => node.hash === hash);
            if (cachedNode && cachedNode.name) return cachedNode.name;
            const remembered = knownNodeNames[String(hash).toLowerCase()];
            if (remembered) return remembered;
            // A favorite knows the name of a node that may not have
            // announced since startup - unless it is still a placeholder.
            const fav = favoriteNodes.find(f => f.hash === String(hash).toLowerCase());
            if (fav && fav.name && !isFavoritePending(fav)) return fav.name;
            return hash;
        }

        // Take the name the server sent with a page when all we had was the
        // bare hash, and remember it so the next "Loading ..." says it too.
        function adoptNodeName(hash, current, fromServer, tab) {
            if (!fromServer) return current;
            knownNodeNames[String(hash).toLowerCase()] = fromServer;
            if (!current || current === hash) {
                if (tab) tab.knownNodeName = fromServer;
                return fromServer;
            }
            return current;
        }

        async function initializeMicronParser() {
            try {
                
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    // Absolute: opened as /<hash>:/page/x.mu, a relative
                    // path resolved under that URL and got the app page back.
                    script.src = '/script/micron-parser_original.js';
                    script.onload = resolve;
                    script.onerror = reject;
                    document.head.appendChild(script);
                });
                
                await new Promise(resolve => setTimeout(resolve, 200));

                if (typeof window.MicronParser === 'function') {
                    // One cell element per character keeps ASCII art on an
                    // exact grid, but on touch devices Chrome froze when text
                    // in those nested inline-blocks was selected and the
                    // page tapped again. There the page is plain text in the
                    // bundled monospace font, which keeps box and block art
                    // aligned on its own, and selection is the native one.
                    const touchDevice = window.matchMedia('(pointer: coarse)').matches
                        || (typeof isMobileDevice === 'function' && isMobileDevice());
                    micronParser = new window.MicronParser(true, !touchDevice);
                    // For long pages on a desktop (Light rendering): no cells.
                    micronParserLight = touchDevice ? micronParser : new window.MicronParser(true, false);
                    isOriginalParser = true;
                } else {
                    throw new Error('MicronParser not available');
                }
            } catch (error) {
                console.warn('⚠️ Original parser failed, using fallback:', error.message);
                micronParser = createFallbackParser();
                isOriginalParser = false;
            }
        }

        function createFallbackParser() {
            return {
                convertMicronToHtml: function(text) {
                    let html = text;

                    html = html.replace(/`!([^`]*)`!/g, '<strong style="color: #58a6ff; font-weight: bold;">$1</strong>');
                    html = html.replace(/`\*([^`]*)`\*/g, '<em style="color: #ffa657; font-style: italic;">$1</em>');
                    html = html.replace(/`_([^`]*)`_/g, '<span style="text-decoration: underline; color: #79c0ff;">$1</span>');
                    html = html.replace(/^>([^\n]*)/gm, '<div style="color: #58a6ff; font-weight: bold; font-size: 18px; margin: 16px 0 8px 0; border-bottom: 1px solid #30363d; padding-bottom: 4px;">$1</div>');
                    html = html.replace(/\n/g, '<br>');

                    html = escapeHtml(html);
                    
                    return `<div style="font-family: 'Courier New', 'Liberation Mono', 'DejaVu Sans Mono', Courier, monospace; line-height: 1.6;">${html}</div>`;
                }
            };
        }

        function parseMicronContent(content) {
            if (!content) return '';
            
            
            if (micronParser) {
                const light = micronParserLight && lightRenderingOn() && content.length > lightRenderingChars();
                let html = (light ? micronParserLight : micronParser).convertMicronToHtml(content);
                
                html = addClickHandlersToLinks(html);
                
                return html;
            } else {
                return escapeHtml(content);
            }
        }

        function handleFormSubmit(path, fieldsSpec) {
            const tab = getActiveTab();
            if (!tab) return;
            
            
            const currentParsed = parseNomadNetUrl(tab.currentUrl);
            if (!currentParsed) {
                showNotification('Cannot submit form - no current node context', 'error', 4000);
                return;
            }
            
            
            // Parse the path to check if it already contains a hash
            let fullPath = path;
            let targetHash = currentParsed.hash;
            
            const hashMatch = path.match(/^([a-fA-F0-9]{32}):(.*)/);
            if (hashMatch) {
                targetHash = hashMatch[1];
                fullPath = hashMatch[2];
            } else if (path.startsWith(':')) {
                fullPath = path.substring(1);
            } else if (!path.startsWith('/')) {
                fullPath = '/' + path;
            }
            
            let cleanPath = fullPath;
            let urlStaticParams = {};
            
            if (fullPath.includes('`')) {
                const [pathPart, paramsPart] = fullPath.split('`', 2);
                cleanPath = pathPart;
                
                if (paramsPart) {
                    const params = paramsPart.split('|');
                    params.forEach(param => {
                        if (param.includes('=')) {
                            const [key, value] = param.split('=', 2);
                            urlStaticParams[key.trim()] = value.trim();
                        }
                    });
                }
            }
            
            
            // Collect form data from inputs
            const formData = {};
            const inputs = document.querySelectorAll(`#${tab.id} .page-content input[name], #${tab.id} .page-content textarea[name]`);
            
            inputs.forEach(input => {
                if (input.type === 'radio' && !input.checked) return;
                if (input.type === 'checkbox') {
                    // NomadNet OMITS an unchecked box rather than sending a
                    // value for it (Browser.__get_link_request_data), and
                    // joins several checked boxes sharing a name with commas.
                    // Sending '0' made a node see the field as submitted and
                    // set, and keeping only the last value silently dropped
                    // every other tick in a multiple-choice group.
                    if (!input.checked) return;
                    const value = input.value || '1';
                    formData[input.name] = formData[input.name]
                        ? formData[input.name] + ',' + value
                        : value;
                } else {
                    formData[input.name] = input.value;
                }
            });
            
            
            // Process fieldsSpec
            const fields = fieldsSpec.split('|').filter(f => f.trim());
            let submitData = {};
            const metadata = {}; // Track which params are static vs form fields
            
            // Add URL static params with metadata
            for (const [key, value] of Object.entries(urlStaticParams)) {
                submitData[key] = value;
                metadata[key] = 'static';
            }
            
            fields.forEach(field => {
                const trimmedField = field.trim();
                
                if (trimmedField.includes('=')) {
                    // Static assignment
                    const [key, value] = trimmedField.split('=', 2);
                    const k = key.trim();
                    submitData[k] = value.trim();
                    metadata[k] = 'static';
                } else if (trimmedField === '*') {
                    // Include all form fields
                    for (const [key, value] of Object.entries(formData)) {
                        submitData[key] = value;
                        metadata[key] = 'field';
                    }
                } else if (formData.hasOwnProperty(trimmedField)) {
                    // Include specific form field
                    submitData[trimmedField] = formData[trimmedField];
                    metadata[trimmedField] = 'field';
                } else {
                    console.warn(`Field '${trimmedField}' referenced but not found in form. Sending empty value.`);
                    submitData[trimmedField] = '';
                    metadata[trimmedField] = 'field';
                }
            });
            
            // Add metadata to submitData
            submitData._meta = metadata;
            
            
            submitFormData(targetHash, cleanPath, submitData);
        }

        function submitFormData(nodeHash, path, data) {
            const tab = getActiveTab();
            if (!tab) return;
            
            
            const cleanPath = path.startsWith(':') ? path.substring(1) : path;
            const fullUrl = `${nodeHash}:${cleanPath}`;
            
            
            navigateToUrlInternalTabWithFormData(fullUrl, data, true); // true = form submission (field_)
        }

        function navigateToUrlInternalTabWithFormData(url, formData, addHistory = true) {
            const tab = getActiveTab();
            if (!tab) return;
            
            const parsed = parseNomadNetUrl(url);
            if (!parsed) {
                showNotification(
                    'Invalid NomadNet URL format',
                    'error',
                    4000
                );
                return;
            }

            if (addHistory) {
                tab.addToHistory(url);
            }

            tab.setUrl(url);
            
            fetchPageByUrlTabWithFormData(parsed.hash, parsed.path, url, formData, true); // true = form submission
        }

        function addClickHandlersToLinks(html) {
            return html.replace(/<a([^>]*?)href=["']([^"']*?)["']([^>]*?)>/g, function(match, before, href, after) {
                if (isNomadNetUrl(href)) {
                    const url = normalizeNomadNetUrl(href);
                    return `<a${before} href="#" class="nomadnet-link" onclick="navigateToNomadNetUrl('${jsAttr(url)}'); return false;" title="Navigate to ${escapeHtml(url)}"${after}>`;
                }
                return match; 
            });
        }

        function isNomadNetUrl(url) {
            return url.match(/^(nomadnetwork:\/\/|[a-fA-F0-9<>:]{32,}[:\/])/);
        }

        function normalizeNomadNetUrl(url) {
            if (url.startsWith('nomadnetwork://')) {
                const match = url.match(/nomadnetwork:\/\/([a-fA-F0-9<>:]+)(\/.*)?/);
                if (match) {
                    const cleanHash = match[1].replace(/[<>:]/g, '').toLowerCase();  // as the list stores it
                    const path = match[2] || '/page/index.mu';
                    return `${cleanHash}:${path}`;
                }
            }
            return url;
        }

        function navigateToNomadNetUrl(url) {
            const tab = getActiveTab();
            if (tab) {
                const addressBar = document.querySelector(`#${tab.id} .address-bar`);
                if (addressBar) addressBar.value = url;
                navigateToUrl();
            }
        }

        function parseNomadNetUrl(url) {

            // Remove nomadnetwork:// prefix if present
            url = url.replace(/^nomadnetwork:\/\//, '');

            // Match hash and everything after the colon/slash
            const match = url.match(/^([a-fA-F0-9<>:]{32,})(?:[:\/](.*))?$/);
            if (match) {
                const cleanHash = match[1].replace(/[<>:]/g, '').toLowerCase();  // as the list stores it
                let fullPath = match[2];

                if (!fullPath || fullPath === '') {
                    fullPath = 'page/index.mu';
                }

                let path = fullPath;
                let formData = {};

                // Check if there are backtick parameters
                if (fullPath.includes('`')) {
                    // Find the LAST occurrence of .mu to split path from parameters
                    const muIndex = fullPath.lastIndexOf('.mu');
                    
                    if (muIndex !== -1) {
                        // Check if there's a backtick after .mu
                        const afterMu = fullPath.substring(muIndex + 3); // +3 for ".mu"
                        
                        if (afterMu.startsWith('`')) {
                            // Split at this point
                            path = fullPath.substring(0, muIndex + 3); // Include .mu
                            const varsPart = afterMu.substring(1); // Remove leading backtick
                            
                            if (varsPart) {
                                // Split by pipe to get individual parameters
                                const vars = varsPart.split('|');
                                for (const varPair of vars) {
                                    if (varPair.includes('=')) {
                                        const [key, value] = varPair.split('=', 2);
                                        formData[key.trim()] = value.trim();
                                    }
                                }
                            }
                        } else {
                            // No backtick after .mu, treat entire thing as path
                            path = fullPath;
                        }
                    } else {
                        // No .mu found, use original splitting logic
                        const [pathPart, varsPart] = fullPath.split('`', 2);
                        path = pathPart;
                        
                        if (varsPart) {
                            const vars = varsPart.split('|');
                            for (const varPair of vars) {
                                if (varPair.includes('=')) {
                                    const [key, value] = varPair.split('=', 2);
                                    formData[key] = value;
                                }
                            }
                        }
                    }
                }

                // Ensure path starts with /
                if (!path.startsWith('/')) {
                    path = '/' + path;
                }

                if (Object.keys(formData).length > 0) {
                }
                
                return { hash: cleanHash, path: path, formData: formData };
            }

            return null;
        }

        function addToHistory(url) {
            const tab = getActiveTab();
            if (tab) {
                tab.addToHistory(url);
            }
        }

        function updateNavigationButtons() {
            const tab = getActiveTab();
            if (tab) {
                tab.updateNavigationButtons();
            }
        }

        function navigateBack() {
            navigateBackTab();
        }

        function navigateForward() {
            navigateForwardTab();
        }

        function refreshPage() {
            userReloadPageTab();
        }

        function handleAddressBarEnter(event) {
            if (event.key === 'Enter') {
                navigateToUrlTab();
            }
        }

        function navigateToUrl() {
            navigateToUrlTab();
        }

        // ─────────────────────────────────────────────────────────────
        // Node list
        //
        // The list is UPDATED IN PLACE and never silently reordered. It used
        // to rebuild list.innerHTML from scratch whenever any node appeared,
        // which threw away the scroll position, the selection highlight and
        // the DOM order all at once: a node you were watching jumped
        // somewhere else, or off screen, every time a stranger announced.
        //
        // So: existing rows are only ever updated in place, rows for nodes
        // that went away are removed, and a genuinely new node is inserted
        // where the chosen sort says it belongs - without moving anything
        // else. Re-sorting the whole list happens only when YOU change the
        // sort, never on an incoming announce.
        // ─────────────────────────────────────────────────────────────

        function buildNodeItem(node) {
            const isFavorite = favoriteNodes.some(fav => fav.hash === node.hash);
            const starIcon = isFavorite ? '★' : '☆';
            const starColor = isFavorite ? '#ffa657' : '#7d8590';

            const item = document.createElement('div');
            item.className = 'node-item';
            item.setAttribute('data-hash', node.hash);
            item.setAttribute('data-name', node.name || '');
            item.setAttribute('data-fresh', nodeFreshness(node));
            item.title = 'Click to open - right-click or long press for more';

            item.innerHTML = `
                <div class="node-head">
                    <span class="node-dot" data-tip="${escapeHtml(nodeDotText(node))}"></span>
                    <div class="node-title" title="NomadNet name - right-click for more">${escapeHtml(node.name)}</div>
                    <div class="node-actions">
                        <button class="info-btn"
                                data-hash="${escapeHtml(node.hash)}"
                                data-name="${escapeHtml(node.name)}"
                                data-last-seen="${escapeHtml(String(node.last_seen))}"
                                data-data-length="${escapeHtml(String(node.app_data_length))}"
                                data-announce-count="${escapeHtml(String(node.announce_count))}"
                                data-relative-time="${escapeHtml(String(node.last_seen_relative))}"
                                title="Show node information">${NODE_ICONS.info}</button>
                        <button class="hide-btn"
                                data-hash="${escapeHtml(node.hash)}"
                                data-name="${escapeHtml(node.name)}"
                                title="Hide this node from the list">${NODE_ICONS.hide}</button>
                        <button class="star-btn"
                                data-hash="${escapeHtml(node.hash)}"
                                data-name="${escapeHtml(node.name)}"
                                style="color: ${starColor};"
                                title="Toggle favorite">${starIcon}</button>
                    </div>
                </div>
                <div class="node-hash">
                    <span class="hash-dot" aria-hidden="true"></span>
                    <span class="copy-icon" onclick="copyHashToClipboard('${jsAttr(node.hash)}'); event.stopPropagation();"
                        title="Copy hash to clipboard">${NODE_ICONS.copy}</span>
                    <span class="hash-text" title="Node address - right-click for more">${escapeHtml(node.hash)}</span>
                </div>
                <div class="node-operator">${operatorRowHtml(node)}</div>
                <div class="node-info">
                    <span class="node-bytes">${escapeHtml(String(node.app_data_length))} bytes announced</span>
                    <span class="node-visits" data-tip="${escapeHtml(nodeVisitsTip(node))}">${NODE_ICONS.eye}<span class="node-visits-count">${escapeHtml(String(node.visits || 0))}</span></span>
                    <span class="node-cache" hidden>${NODE_ICONS.disk}<span class="node-cache-count"></span></span>
                    <span class="node-hops" data-tip="${escapeHtml(nodeHopsTitle(node) + '\nClick for node info.')}">${escapeHtml(nodeHopsText(node))}</span>
                    <span class="node-seen">${escapeHtml(String(node.last_seen_relative))}</span>
                </div>`;
            return item;
        }

        // Line icons for the node rows. Emoji ignore `color` and come out in
        // a different style on every system; these follow the row's colours,
        // selected and hovered states included.
        const NODE_ICONS = {
            copy: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
            mail: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 4.5l6 4.5 6-4.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
            info: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="4.9" r="0.95" fill="currentColor"/></svg>',
            // Times you opened the node's pages, at the foot of the card.
            eye: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.2 8S3.7 3.5 8 3.5 14.8 8 14.8 8 12.3 12.5 8 12.5 1.2 8 1.2 8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
            // Hide the node from the list (hideNode).
            hide: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.2 8S3.7 3.5 8 3.5 14.8 8 14.8 8 12.3 12.5 8 12.5 1.2 8 1.2 8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
            // Saved pages, at the foot of the card (applyNodeCacheMark).
            disk: '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M2.5 3A1.5 1.5 0 0 1 4 1.5h6.8l2.7 2.7V12A1.5 1.5 0 0 1 12 13.5H4A1.5 1.5 0 0 1 2.5 12z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 1.8v3h5v-3M5 13.3V9.5h6v3.8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>'
        };

        // Hop count for the foot of the card, and on hover the interface the
        // path leaves by. Both come from the server (hops_to, and the next
        // hop interface the shared instance reports).
        // The eye at the foot of the card: only how often you opened it.
        function nodeVisitsTip(node) {
            const v = node.visits || 0;
            return v ? `You opened this node's pages ${v} time${v === 1 ? '' : 's'}.`
                     : 'You have never opened this node.';
        }

        function nodeHopsKnown(node) {
            return typeof node.hops === 'number' && node.hops < 128;
        }

        function nodeHopsText(node) {
            return `Hops: ${nodeHopsKnown(node) ? node.hops : '?'}`;
        }

        function nodeHopsTitle(node) {
            if (!nodeHopsKnown(node)) return 'No path known yet';
            const hops = `${node.hops} ${node.hops === 1 ? 'hop' : 'hops'}`;
            const via = String(node.next_hop_interface || '').replace(/^via\s+/, '');
            if (!via || via === 'Unknown') return hops;
            return node.interface && node.interface !== via
                ? `${hops} via ${via}\n${node.interface}`
                : `${hops} via ${via}`;
        }

        // How fresh the last announce is, for the dot by the name: heard in
        // the last minute, within the hour, or longer ago. Read from the
        // relative time the server already works out.
        // The dot's words. A node listed from Reticulum's known announces
        // (Settings > NomadNet Browser > Node list) has not announced since rBrowser started.
        function nodeDotText(node) {
            if (node.from_known) return 'From RNS cache - not announced yet';
            return `Last announce: ${node.last_seen_relative}`;
        }

        function nodeFreshness(node) {
            if (node.from_known) return 'known';
            const rel = String(node.last_seen_relative || '');
            if (/just now/i.test(rel)) return 'now';
            if (/m ago$/.test(rel)) return 'recent';
            return 'old';
        }

        // Who runs this node.
        //
        // The address is not announced; it is worked out from the identity
        // in the announce, because NomadNet builds the node destination and
        // the operator's LXMF destination from the same identity. The name
        // is only known once that operator announces on LXMF too, so the row
        // shows the address alone until then, and fills in the name later
        // without the row being rebuilt.
        function operatorRowHtml(node) {
            const address = node.operator_lxmf_address;
            if (!address) return '';

            const name = node.operator_name;
            const shown = name
                ? `${escapeHtml(name)} <span class="operator-addr">${escapeHtml(address.slice(0, 16))}…</span>`
                : `<span class="operator-addr">${escapeHtml(address)}</span>`;

            // Only the envelope copies. The address text used to copy too,
            // but together with the hash text that made most of the row a
            // copy target, and a click meant to open the node kept copying
            // instead. The text is now part of the row and opens the node.
            const copy = `onclick="copyOperatorAddress('${jsAttr(address)}'); event.stopPropagation();"`;
            const hint = `title="Copy operator LXMF address ${escapeHtml(address)}"`;

            return `
                <span class="hash-dot" aria-hidden="true"></span>
                <span class="operator-icon" ${copy} ${hint}>${NODE_ICONS.mail}</span>
                <span class="operator-text" title="Operator LXMF address - click for the LXMF menu">${shown}</span>`;
        }

        // Refresh the mutable parts of an existing row without replacing it,
        // so the element the user may be hovering or has selected survives.
        function refreshNodeItem(item, node) {
            applyNodeCacheMark(item);
            // Every poll rewrote every row's attributes and read back each
            // operator row's innerHTML: ~35 ms per poll with 80 nodes, a
            // stutter every few seconds while typing anywhere.
            // A row whose data did not change is left alone.
            const isFavorite = favoriteNodes.some(fav => fav.hash === node.hash);
            const operatorHtml = operatorRowHtml(node);
            const sig = [node.app_data_length, nodeHopsText(node), nodeHopsTitle(node), node.last_seen_relative,
                         nodeFreshness(node), nodeDotText(node), node.visits, nodeVisitsTip(node), node.name,
                         node.last_seen, node.announce_count, isFavorite, operatorHtml].join('|');
            if (item._sig === sig) return;
            item._sig = sig;
            const bytes = item.querySelector('.node-bytes');
            if (bytes) {
                const text = `${node.app_data_length} bytes announced`;
                if (bytes.textContent !== text) bytes.textContent = text;
            }
            const hopsEl = item.querySelector('.node-hops');
            if (hopsEl) {
                const text = nodeHopsText(node);
                if (hopsEl.textContent !== text) hopsEl.textContent = text;
                hopsEl.dataset.tip = nodeHopsTitle(node) + '\nClick for node info.';
            }
            const seen = item.querySelector('.node-seen');
            if (seen) {
                const text = String(node.last_seen_relative);
                if (seen.textContent !== text) seen.textContent = text;
            }
            const fresh = nodeFreshness(node);
            if (item.getAttribute('data-fresh') !== fresh) item.setAttribute('data-fresh', fresh);
            const dot = item.querySelector('.node-dot');
            if (dot) dot.dataset.tip = nodeDotText(node);
            const visitsEl = item.querySelector('.node-visits');
            if (visitsEl) {
                const count = visitsEl.querySelector('.node-visits-count');
                const text = String(node.visits || 0);
                if (count && count.textContent !== text) count.textContent = text;
                visitsEl.dataset.tip = nodeVisitsTip(node);
            }
            const title = item.querySelector('.node-title');
            if (title) {
                const text = String(node.name);
                if (title.textContent !== text) title.textContent = text;
            }
            if (item.getAttribute('data-name') !== (node.name || '')) {
                item.setAttribute('data-name', node.name || '');
            }
            const infoBtn = item.querySelector('.info-btn');
            if (infoBtn) {
                infoBtn.setAttribute('data-name', node.name || '');
                infoBtn.setAttribute('data-last-seen', String(node.last_seen));
                infoBtn.setAttribute('data-data-length', String(node.app_data_length));
                infoBtn.setAttribute('data-announce-count', String(node.announce_count));
                infoBtn.setAttribute('data-relative-time', String(node.last_seen_relative));
            }
            const starBtn = item.querySelector('.star-btn');
            if (starBtn) {
                const icon = isFavorite ? '★' : '☆';
                if (starBtn.textContent !== icon) {
                    starBtn.textContent = icon;
                    starBtn.style.color = isFavorite ? '#ffa657' : '#7d8590';
                }
                starBtn.setAttribute('data-name', node.name || '');
            }
            // The operator's name can arrive long after the node did, so
            // this row is rewritten only when it actually changes - the
            // list must not flicker while somebody is reading it.
            const operator = item.querySelector('.node-operator');
            if (operator && operator._html !== operatorHtml) {
                operator._html = operatorHtml;
                operator.innerHTML = operatorHtml;
            }
        }

        // Where a newly discovered node belongs under the current sort. The
        // existing rows keep their relative order whatever this returns.
        function insertionPointFor(list, node) {
            const select = document.getElementById('node-sort');
            const sortBy = select ? select.value : 'original';
            if (sortBy === 'original') return null;   // discovery order: append

            const byHash = new Map();
            for (const n of cachedNodes) byHash.set(n.hash, n);

            for (const item of list.querySelectorAll('.node-item')) {
                const existing = byHash.get(item.getAttribute('data-hash'));
                if (!existing) continue;
                if (compareNodes(sortBy, node, existing) < 0) return item;
            }
            return null;
        }

        function updateNodes() {
            if (nodeListPaused) return Promise.resolve();
            return fetch('/api/nodes')
                .then(r => {
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    return r.json();
                })
                .then(nodes => {
                    cachedNodes = nodes;

                    const list = document.getElementById('node-list');
                    if (!list) return;
                    const sortSelect = document.getElementById('node-sort');

                    const counter = document.getElementById('node-count');
                    if (counter && counter.textContent !== String(nodes.length)) {
                        counter.textContent = nodes.length;
                    }

                    if (nodes.length === 0) {
                        if (!list.querySelector('.node-list-empty')) {
                            list.innerHTML = '<div class="node-list-empty" style="text-align: center; padding: 20px; color: #7d8590; font-size: 12px;">Scanning for NomadNet Nodes...</div>';
                        }
                        return;
                    }

                    // Clear anything in the list that is not a node row. The
                    // "Scanning for nodes..." placeholder is one of these:
                    // the old code wiped the whole list on every update so it
                    // disappeared by accident, and the incremental version
                    // left it sitting above the nodes forever.
                    Array.from(list.children).forEach(child => {
                        if (!child.classList.contains('node-item')) child.remove();
                    });

                    const existing = new Map();
                    list.querySelectorAll('.node-item').forEach(
                        el => existing.set(el.getAttribute('data-hash'), el));

                    // Whatever changes below, the node you are visiting
                    // stays put on screen (captureNodeListAnchor).
                    const restoreAnchor = captureNodeListAnchor();
                    // "N new nodes" was clicked: this time the list goes to
                    // them instead of staying where it was.
                    const revealing = nodeListShowPending;
                    const seen = new Set();
                    let added = 0;
                    // Held while you are on it (nodeListInUse): new rows
                    // wait, gone rows stay, only the text in place updates.
                    // After the first batch, so the list is never held empty.
                    const hold = nodeSortApplied && nodeListInUse();
                    let waiting = 0;
                    // The list refilling after an empty answer (the server
                    // restarted meanwhile) is not news.
                    const restock = !existing.size;

                    for (const node of nodes) {
                        seen.add(node.hash);
                        const item = existing.get(node.hash);
                        if (item) {
                            refreshNodeItem(item, node);
                            nodeListAcked.delete(node.hash);
                            // Announced again: under a sort that moves it
                            // up for that, it counts with the new nodes.
                            // Not while held: the row only moves when the
                            // hold ends, so the change is taken then.
                            if (!hold) {
                                const before = nodeListLastSeen.get(node.hash);
                                if (before !== undefined && before !== node.last_seen && !restock
                                        && NODE_SORTS_BY_ANNOUNCE.includes(sortSelect && sortSelect.value)) {
                                    nodeListNew.add(node.hash);
                                    nodeListMoved.add(node.hash);
                                }
                                nodeListLastSeen.set(node.hash, node.last_seen);
                            }
                            continue;
                        }
                        nodeListLastSeen.set(node.hash, node.last_seen);
                        // New since the first batch: counted by "N new
                        // nodes", held or not, unless closed with its x.
                        // Not one from the RNS cache (Start with recent
                        // nodes): it was not just heard.
                        if (nodeSortApplied && !restock && !nodeListAcked.has(node.hash) && !node.from_known) {
                            nodeListNew.add(node.hash);
                            nodeListMoved.delete(node.hash);
                        }
                        if (hold) {
                            waiting++;
                        } else {
                            const fresh = buildNodeItem(node);
                            applyNodeCacheMark(fresh);
                            const before = insertionPointFor(list, node);
                            if (before) list.insertBefore(fresh, before);
                            else list.appendChild(fresh);
                            nodeListAcked.delete(node.hash);
                            added++;
                        }
                    }
                    // A new node the daemon dropped again is no longer new.
                    for (const hash of nodeListNew) {
                        if (!seen.has(hash)) nodeListNew.delete(hash);
                    }
                    for (const hash of nodeListLastSeen.keys()) {
                        if (!seen.has(hash)) nodeListLastSeen.delete(hash);
                    }

                    // Nodes the daemon dropped (TTL) lose their row.
                    if (!hold) {
                        for (const [hash, el] of existing) {
                            if (!seen.has(hash)) el.remove();
                        }
                        nodeListShowPending = false;
                    }

                    if (added > 0) filterNodes();

                    // One sort pass once the first batch has arrived, so a
                    // sort order restored from last time is applied to rows
                    // that were inserted before there was anything to place
                    // them against.
                    //
                    // After that the order is re-applied on every poll: a
                    // node that announces again has to move up under
                    // "recent", and one that changes its name has to move
                    // under "alphabetical". Applying it once only left the
                    // list frozen in the order it had when the page opened.
                    // When nothing changed the DOM is not touched. The
                    // re-sort waits while the list is being used, so a row
                    // does not move under the pointer.
                    if (!nodeSortApplied && nodes.length) {
                        nodeSortApplied = true;
                        sortAndFilterNodes();
                    } else if (!nodeListInUse()) {
                        sortAndFilterNodes();
                    }
                    // After a click on "N new nodes": go to them, wherever
                    // they are, the ones that waited and the ones already in.
                    const reveal = revealing && nodeListRevealHashes
                        ? Array.from(nodeListRevealHashes, hash =>
                              list.querySelector(`.node-item[data-hash="${hash}"]`)).filter(Boolean)
                        : [];
                    if (revealing) nodeListRevealHashes = null;
                    if (reveal.length) {
                        revealNewNodes(reveal);
                    } else {
                        restoreAnchor();
                    }
                    // After the sort: what is out of sight is judged where
                    // the rows really are now.
                    setNodeListPending(nodes);

                    updateNodeSelection();
                })
                .catch(error => {
                    console.warn('Nodes API error:', error);
                });
            updateStarButtonState();
        }
        function updateStatus() {
            fetch(statusUrl())
                .then(r => {
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    return r.json();
                })
                .then(data => {
                    document.getElementById('announce-count').textContent = data.total_announces;
                    checkFavoritesRevision(data.favorites_revision);
                    openDeliveredLinks(data.open_links);
                })
                .catch(error => {
                    console.warn('Basic status API error:', error);
                });
            
            fetch('/api/connection-status')
                .then(r => {
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    return r.json();
                })
                .then(data => {

                    const wasInErrorState = statusFetchFailures >= maxStatusFailures;
                    statusFetchFailures = 0;
                    lastStatusFetch = Date.now();

                    if (wasInErrorState) {
                    }

                    updateConnectionStatus(data.status, data.message, data.color);
                })
                .catch(error => {
                    statusFetchFailures++;
                    const currentTime = Date.now();
                    
                    console.warn(`Connection status fetch failed (${statusFetchFailures}/${maxStatusFailures}):`, error);
                    
                    if (statusFetchFailures >= maxStatusFailures) {
                        updateConnectionStatus('connerror', 'Error! Python script stopped?', 'red');
                    } else {
                        if (statusFetchFailures === 1) {
                            updateConnectionStatus('waiting', 'Checking connection...', 'yellow');
                        } else if (statusFetchFailures === 2) {
                            updateConnectionStatus('waiting', 'Retrying connection check...', 'yellow');
                        }
                    }
                });
        }

        function updateConnectionStatus(status, message, color) {
            const state = { green: 'connected', yellow: 'connecting', red: 'failed' }[color] || 'closed';
            if (state !== nomadNetState) {
                nomadNetState = state;
                tabs.forEach(t => { if (!t.url) t.updateTabDisplay(); });
            }
            const statusElement = document.getElementById('connection-status') || document.querySelector('.status-indicator');
            if (statusElement) {
                statusElement.className = `status-indicator ${status}`;
                // A dot in the colour of the state, then the words.
                statusElement.innerHTML = `<span class="sb-dot" style="background: ${getStatusColor(color)}; box-shadow: 0 0 6px ${getStatusColor(color)}99;"></span><span class="sb-text">${message}</span>`;
                // The bar is one line; a Reticulum error can be longer than
                // that. Hovering the bar shows the whole of it.
                const bar = statusElement.closest('.status-bar');
                if (bar) bar.title = statusElement.textContent.trim();
            }
        }

        function getStatusColor(color) {
            switch(color) {
                case 'green': return '#40ed3a';
                case 'yellow': return '#f59e0b'; 
                case 'red': return '#ef4444';
                default: return '#7d8590';
            }
        }
        
        function browseNode(hash, name) {
            const url = `${hash}:/page/index.mu`;
            
            const currentTab = getActiveTab();
            let targetTab;
            
            if (currentTab && currentTab.title === 'New Tab' && !currentTab.currentUrl) {
                targetTab = currentTab;
            } else {
                targetTab = createNewTab();
            }
            
            const addressBar = document.querySelector(`#${targetTab.id} .address-bar`);
            if (addressBar) addressBar.value = url;
            
            targetTab.knownNodeName = name;
            
            navigateToUrlInternalTab(url, true);
        }
                
        // Safe in text AND inside quoted attributes. The old version went
        // through textContent/innerHTML, which escapes & < > but not quotes:
        // every data-name="${escapeHtml(node.name)}" could be closed early
        // by a node announcing a name with a double quote in it, and a name
        // like  x" onmouseover="...  ran script in every open rBrowser,
        // since the node list fills itself from announces.
        function escapeHtml(text) {
            return String(text ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        // For a value that goes inside a JS string literal which itself sits
        // in an HTML attribute: onclick="f('${jsAttr(x)}')". JS escaping
        // first (backslash, quotes, line breaks), HTML escaping second.
        function jsAttr(text) {
            const js = String(text ?? '')
                .replace(/\\/g, '\\\\')
                .replace(/'/g, "\\'")
                .replace(/"/g, '\\"')
                .replace(/\r/g, '\\r')
                .replace(/\n/g, '\\n')
                .replace(/</g, '\\x3c')
                .replace(/>/g, '\\x3e');
            return escapeHtml(js);
        }

    // The name to show (and save under, until the node reports its own) for
    // a file link. A link like "/file/artifact`g=reticulum|a=Reticulum+Manual.pdf"
    // was shown whole; the file is the variable that looks like a file name,
    // the same choice the server makes in _fallback_filename.
    function displayFileName(filePath) {
        const [pathPart, vars] = filePath.split('`', 2);
        if (vars) {
            for (const field of vars.split('|')) {
                const value = field.split('=').slice(1).join('=');
                if (/\.[A-Za-z0-9]{1,8}$/.test(value)) {
                    try { return decodeURIComponent(value.replace(/\+/g, ' ')); }
                    catch (e) { return value.replace(/\+/g, ' '); }
                }
            }
        }
        return pathPart.split('/').filter(Boolean).pop() || 'file';
    }

    function handleFileDownload(nodeHash, filePath) {
        const startUrl = `/api/download/${nodeHash}/start?path=${encodeURIComponent(filePath)}`;
        const filename = displayFileName(filePath);
        const touchDevice = window.matchMedia('(pointer: coarse)').matches
            || (typeof isMobileDevice === 'function' && isMobileDevice());

        // Sized by the stylesheet (.download-box): the old fixed 320px width
        // 60px from the edge ran off the side of a phone screen.
        const notification = document.createElement('div');
        notification.className = 'download-box';
        
        notification.innerHTML = `
            <div style="display:flex; align-items:flex-start; gap:10px;">
                <div class="dl-title" style="flex:1;">📁 Downloading ${escapeHtml(filename)}...</div>
                <button class="dl-close" title="Close"
                        style="background:none; border:none; color:#7d8590; cursor:pointer;
                               font-size:18px; line-height:1; padding:0 2px;">×</button>
            </div>
            <div style="margin: 8px 0; background: #333; height: 6px; border-radius: 3px; overflow: hidden;">
                <div class="dl-bar" style="background: #58a6ff; height: 100%; width: 0%; transition: width 0.3s;"></div>
            </div>
            <div class="dl-text" style="font-size: 12px; color: #7d8590;">Connecting to node...</div>
        `;

        document.body.appendChild(notification);

        // Scoped to this notification. These used to be looked up by id, so
        // two concurrent downloads both drove the first one's progress bar.
        const progressBar = notification.querySelector('.dl-bar');
        const progressText = notification.querySelector('.dl-text');
        const titleEl = notification.querySelector('.dl-title');

        let pollInterval = null;
        let closed = false;

        // One way out, used by every ending - success, refusal, network
        // error, or the user closing it. Before this, only the success path
        // ever removed the box: a failed download left it on screen forever
        // with no way to dismiss it, and its poll timer still running.
        const finish = (autoCloseMs) => {
            if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
            if (autoCloseMs === null) return;
            setTimeout(() => {
                if (!closed && notification.parentNode) {
                    closed = true;
                    notification.parentNode.removeChild(notification);
                }
            }, autoCloseMs);
        };

        // Closing the box is the cancel button: it stops the transfer on the
        // server too. It used to only hide the box while the file kept coming
        // over the mesh. Not once the file is saved - on a phone the browser
        // may still be reading the server's copy.
        let downloadId = null;
        let saved = false;
        const cancelOnServer = () => {
            if (!downloadId || saved) return;
            fetch(`/api/download/cancel/${downloadId}`, { method: 'POST' }).catch(() => {});
        };

        notification.querySelector('.dl-close').addEventListener('click', () => {
            closed = true;
            if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
            cancelOnServer();
            if (notification.parentNode) notification.parentNode.removeChild(notification);
        });

        const fail = (title, detail) => {
            progressBar.style.background = '#ff7b72';
            progressBar.style.width = '100%';
            titleEl.innerHTML = `❌ ${escapeHtml(title)}`;
            progressText.textContent = detail || '';
            finish(8000);
        };

        // Start the download
        fetch(startUrl)
            .then(r => r.json())
            .then(data => {
                if (data.error) {
                    throw new Error(data.error);
                }
                
                downloadId = data.download_id;
                // Closed while the request to start was still on its way.
                if (closed) { cancelOnServer(); return; }
                let pollFailures = 0;

                // Half a second, not a tenth. The old interval put ten HTTP
                // requests a second on the server for the whole transfer -
                // which over LoRa can be minutes - to move a progress bar
                // nobody can read that fast.
                pollInterval = setInterval(() => {
                    if (closed) { finish(null); return; }

                    fetch(`/api/download/progress/${downloadId}`)
                        .then(r => r.json())
                        .then(progressData => {
                            pollFailures = 0;
                            const progress = progressData.progress || 0;
                            const status = progressData.status;

                            progressBar.style.width = progress + '%';

                            if (status === 'starting') {
                                progressText.textContent = 'Connecting to node...';
                            } else if (status === 'downloading') {
                                progressText.textContent = `Downloading from network... ${progress.toFixed(1)}%`;
                            } else if (status === 'complete') {
                                clearInterval(pollInterval);
                                pollInterval = null;
                                progressText.textContent = 'Saving file...';

                                let savedName = filename;
                                fetch(`/api/download/result/${downloadId}`)
                                    .then(r => {
                                        if (!r.ok) {
                                            return r.json()
                                                .then(j => { throw new Error(j.error || 'Download failed'); },
                                                      () => { throw new Error(`Download failed (HTTP ${r.status})`); });
                                        }
                                        // The name the serving node reported,
                                        // which can differ from the one in the
                                        // URL when the node converted the file.
                                        // Percent-encoded by the server (a
                                        // header must be latin-1).
                                        const reported = r.headers.get('X-Download-Filename');
                                        try {
                                            savedName = reported ? decodeURIComponent(reported) : filename;
                                        } catch (e) {
                                            savedName = reported || filename;
                                        }
                                        return r.blob();
                                    })
                                    .then(blob => {
                                        saved = true;
                                        progressBar.style.background = '#7c3aed';
                                        progressText.textContent =
                                            `Download completed (${formatFileSize(blob.size)})`;
                                        titleEl.innerHTML = `✅ Downloaded ${escapeHtml(savedName)}`;

                                        // Attached to the page, and the blob URL
                                        // kept for a minute. Android Chrome starts
                                        // the save asynchronously: revoking the URL
                                        // straight after click() left it nothing to
                                        // read, so on phones the bar finished and
                                        // the save then failed.
                                        // On a phone not even that was enough:
                                        // Android's downloader would not save
                                        // the blob. There the browser is pointed
                                        // at the server's copy instead, which it
                                        // saves like any other download (the
                                        // server keeps it for a few minutes and
                                        // names it in Content-Disposition).
                                        const url = touchDevice
                                            ? `/api/download/result/${downloadId}`
                                            : window.URL.createObjectURL(blob);
                                        const link = document.createElement('a');
                                        link.href = url;
                                        link.download = savedName;
                                        link.style.display = 'none';
                                        document.body.appendChild(link);
                                        link.click();
                                        setTimeout(() => {
                                            link.remove();
                                            if (!touchDevice) window.URL.revokeObjectURL(url);
                                        }, 60000);

                                        finish(4000);
                                    })
                                    .catch(err => {
                                        console.error(err);
                                        fail(`Could not save ${filename}`, err.message);
                                    });
                            } else if (status === 'error') {
                                clearInterval(pollInterval);
                                pollInterval = null;
                                fail(`Download of ${filename} failed`,
                                     progressData.error || 'The node did not deliver the file');
                            }
                        })
                        .catch(err => {
                            console.error('Progress poll error:', err);
                            // A few dropped polls are nothing; a server that
                            // has stopped answering must not leave the box
                            // spinning forever.
                            if (++pollFailures >= 10) {
                                clearInterval(pollInterval);
                                pollInterval = null;
                                fail(`Lost contact while downloading ${filename}`,
                                     'The local server stopped responding');
                            }
                        });
                }, 500);
            })
            .catch(err => {
                console.error(err);
                fail(`Could not start download of ${filename}`, err.message);
            });
    }

    function formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }        

    function parseFileURL(url) {
        
        let nodeHash = '';
        let filePath = '';
        
        if (url.startsWith('nomadnetwork://')) {
            const parts = url.replace('nomadnetwork://', '').split(':');
            nodeHash = parts[0] || '';
            filePath = parts.slice(1).join(':');
        } else if (url.includes(':/file/')) {
            const parts = url.split(':');
            nodeHash = parts[0];
            filePath = parts.slice(1).join(':');
        }
        
        return { nodeHash, filePath };
    }

    function addFileDownloadHandlers() {
        const tab = getActiveTab();
        if (!tab) return;
        
        const fileLinks = document.querySelectorAll(`#${tab.id} .page-content a[href*=":/file/"]`);
        
        fileLinks.forEach(link => {
            link.removeEventListener('click', handleFileClick);
            link.addEventListener('click', handleFileClick);
        });
    }

    function handleFileClick(event) {
        event.preventDefault();
        const href = this.getAttribute('href');
        const tab = getActiveTab();
        
        if (!tab) return;
        
        const parsed = parseFileURL(href);
        let nodeHash = parsed.nodeHash;
        let filePath = parsed.filePath;

        if (!nodeHash && tab.selectedNode) {
            nodeHash = tab.selectedNode;
        }

        if (!nodeHash && tab.currentUrl) {
            const currentParsed = parseNomadNetUrl(tab.currentUrl);
            if (currentParsed) {
                nodeHash = currentParsed.hash;
            }
        }
        
        if (nodeHash && filePath) {
            handleFileDownload(nodeHash, filePath);
        } else {
            console.warn('Could not parse file URL:', href);
            showNotification(
                'Unable to download file - invalid URL format',
                'error',
                4000
            );
        }
    }

        // filterNodes() is with the quick search, near the end of the file.

        function toggleClearButton() {
            const searchInput = document.getElementById('node-search');
            const clearButton = document.getElementById('search-clear');
            
            if (searchInput.value.length > 0) {
                clearButton.style.display = 'flex';
            } else {
                clearButton.style.display = 'none';
            }
        }

        function clearSearch() {
            const searchInput = document.getElementById('node-search');
            const clearButton = document.getElementById('search-clear');
            
            searchInput.value = '';
            clearButton.style.display = 'none';
            filterNodes();
            searchInput.focus();
        }

        // A search result was picked: the search is done, the whole list
        // comes back. No focus on the field (a phone would raise its
        // keyboard over the page that is opening).
        function closeSearchAfterPick() {
            const searchInput = document.getElementById('node-search');
            if (!searchInput || !searchInput.value || !clearSearchOnPick()) return;
            searchInput.value = '';
            const clearButton = document.getElementById('search-clear');
            if (clearButton) clearButton.style.display = 'none';
            searchInput.blur();
            filterNodes();
        }

        function saveFavorites() {
            fetch('/api/favorites', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({favorites: favoriteNodes})
            })
            .then(r => r.json())
            .then(data => {
                if (data.status === 'success') {
                    // Our own save moves the revision too; it is not news.
                    if (typeof data.revision === 'number') favoritesRevision = data.revision;
                    // The server may have kept a name found meanwhile.
                    if (Array.isArray(data.favorites)) applyServerFavorites(data.favorites);
                } else {
                    console.error('Failed to save favorites:', data.error);
                }
            })
            .catch(err => {
                console.error('Error saving favorites:', err);
            });
        }

        function loadFavorites() {
            // The menu starts closed.
            setFavoritesOpen(false);

            fetch('/api/favorites')
                .then(r => r.json())
                .then(data => {
                    if (data.status === 'success') {
                        favoriteNodes = data.favorites || [];
                        if (typeof data.revision === 'number') favoritesRevision = data.revision;
                        updateFavoritesDisplay();
                        syncFavorites();
                    } else {
                        console.error('Failed to load favorites:', data.error);
                        favoriteNodes = [];
                        updateFavoritesDisplay();
                    }
                })
                .catch(err => {
                    console.error('Error loading favorites:', err);
                    favoriteNodes = [];
                    updateFavoritesDisplay();
                });
        }

        // The server's copy of the favorites changes on its own when it finds
        // the name of one added by hash alone. /api/status carries the
        // revision; when it moves, the names are taken over from the server.
        let favoritesRevision = null;

        function checkFavoritesRevision(revision) {
            if (typeof revision !== 'number') return;
            if (favoritesRevision === null) { favoritesRevision = revision; return; }
            if (revision === favoritesRevision) return;
            favoritesRevision = revision;
            fetch('/api/favorites')
                .then(r => r.json())
                .then(data => {
                    if (data.status !== 'success') return;
                    if (typeof data.revision === 'number') favoritesRevision = data.revision;
                    applyServerFavorites(data.favorites || []);
                })
                .catch(() => {});
        }

        // Fill in names the server found. Only names: the list itself is
        // the page's, and an add or remove still on its way to the server
        // must not be undone by an older copy coming back.
        //
        // Only favorites that prefer the network name take it; a custom
        // name is never touched.
        function applyServerFavorites(serverFavorites) {
            const named = new Map();
            serverFavorites.forEach(fav => {
                if (fav && fav.network_name && fav.name) named.set(fav.hash, fav.name);
            });
            const found = [];
            let changed = false;
            // The server only marks a name as the network's when it applied
            // it - a custom one too, with Settings > Favorites "Update names"
            // on - so its word is taken, prefer included: an older copy saved
            // from here must not bring the old name back.
            favoriteNodes.forEach(fav => {
                if (!named.has(fav.hash)) return;
                const name = named.get(fav.hash);
                if (fav.prefer === 'network' && fav.network_name && fav.name === name) return;
                if (isFavoritePending(fav)) found.push(name);
                fav.name = name;
                fav.prefer = 'network';
                fav.network_name = true;
                changed = true;
            });
            if (!changed) return;
            updateFavoritesDisplay();
            found.forEach(name =>
                showNotification(`Favorite named: ${escapeHtml(name)}`, 'success', 4000));
        }

        // What a favorite is called in the list until its name is known.
        function favoriteLabel(fav) {
            return fav.name || `${fav.hash.substring(0, 8)}…`;
        }

        // Waiting for the name the node announces (rbrowser/favorites.py).
        function isFavoritePending(fav) {
            return !!fav && fav.prefer === 'network' && !fav.network_name;
        }

        function toggleFavorite(hash, name) {
            const existing = favoriteNodes.findIndex(fav => fav.hash === hash);

            if (existing >= 0) {
                favoriteNodes.splice(existing, 1);
            } else {
                favoriteNodes.push(name ? { hash: hash, name: name, prefer: 'network', network_name: true }
                                       : { hash: hash, name: '', prefer: 'network' });
            }

            saveFavorites();
            updateFavoritesDisplay();
            syncFavorites();
        }

        function updateFavoritesDisplay() {
            const list = document.getElementById('favorites-list');
            const count = document.getElementById('favorites-count');
            if (count) count.textContent = favoriteNodes.length;

            if (favoriteNodes.length === 0) {
                list.innerHTML = '<div class="favorites-empty">No favorites yet.<br>Use ☆ on a node or + above.</div>';
                return;
            }

            let html = '';
            favoriteNodes.forEach((fav) => {
                // The name came from a node announce: anyone's text. It sits
                // in a JS string inside an attribute, so jsAttr(), not the
                // quote-only escaping this used to do.
                //
                // Choosing a favorite closes the menu: it covers the top of
                // the node list, and the page is what you went there for.
                //
                // A favorite added by hash alone has no name until the
                // server finds one; it says so instead of showing nothing.
                // A placeholder name waiting for the network one is shown
                // as such.
                const nameHtml = !fav.name
                    ? `<span class="favorite-name pending">Looking up name…</span>`
                    : isFavoritePending(fav)
                        ? `<span class="favorite-name pending" title="Temporary, until the node's announced name is known">${escapeHtml(fav.name)}</span>`
                        : `<span class="favorite-name">${escapeHtml(fav.name)}</span>`;
                html += `
                    <div class="favorite-item" onclick="setFavoritesOpen(false); browseNode('${jsAttr(fav.hash)}', '${jsAttr(favoriteLabel(fav))}')"
                         title="${escapeHtml(favoriteLabel(fav))}&#10;${escapeHtml(fav.hash)}">
                        <span class="favorite-star">★</span>
                        <span class="favorite-text">
                            ${nameHtml}
                            <span class="favorite-hash">${escapeHtml(fav.hash)}</span>
                        </span>
                        <button class="favorite-remove" onclick="removeFavorite('${jsAttr(fav.hash)}'); event.stopPropagation();" title="Remove from favorites">×</button>
                    </div>
                `;
            });

            list.innerHTML = html;
        }

        // The favorites are a drop-down over the top of the node list. It
        // used to open inside the sidebar and push the list down, which
        // moved every node card each time it opened or closed.
        function setFavoritesOpen(open) {
            const section = document.getElementById('favorites-section');
            const button = document.getElementById('favorites-toggle');
            if (!section || !button) return;
            if (open) setHistoryOpen(false);     // one drop-down at a time
            section.classList.toggle('open', open);
            button.setAttribute('aria-expanded', open ? 'true' : 'false');
            button.title = open ? 'Hide favorites' : 'Show favorites';
        }

        function toggleFavoritesSection() {
            const section = document.getElementById('favorites-section');
            setFavoritesOpen(!(section && section.classList.contains('open')));
        }

        // A click anywhere outside the menu, or Escape, closes it.
        document.addEventListener('click', (e) => {
            const section = document.getElementById('favorites-section');
            if (section && section.classList.contains('open') && !section.contains(e.target)) {
                setFavoritesOpen(false);
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const section = document.getElementById('favorites-section');
            if (section && section.classList.contains('open')) setFavoritesOpen(false);
        });

        function removeFavorite(hash) {
            const index = favoriteNodes.findIndex(fav => fav.hash === hash);
            
            if (index >= 0) {
                favoriteNodes.splice(index, 1);
                saveFavorites();
                updateFavoritesDisplay();
                // This was missing: removing a favourite from the sidebar
                // left the navigation bar star lit and the node list star
                // filled, because nothing told either of them. That is the
                // mismatch between the three places.
                syncFavorites();
            }
        }

        function fetchPageByUrlTabWithFormData(hash, path, originalUrl, formData, isFormSubmission = false, targetTab = null) {
            const tab = targetTab || getActiveTab();   // see fetchPageByUrlTab
            if (!tab) return;
            
            if (tab.currentRequest) {
                tab.currentRequest.abort();
                tab.currentRequest = null;
            }
            
            tab.selectedNode = hash;
            tab.setLoading(true);
            setPageSource(tab, null);

            let nodeName = getNodeName(hash);
            tab.knownNodeName = nodeName;

            const pageTitle = document.querySelector(`#${tab.id} .page-title`);
            const pageContent = document.querySelector(`#${tab.id} .page-content`);
            const viewToggle = document.querySelector(`#${tab.id} .view-toggle`);
            const addressBar = document.querySelector(`#${tab.id} .address-bar`);
            
            if (pageTitle) {
                pageTitle.innerHTML = `<span class="label">Loading:</span> <span class="value">${escapeHtml(nodeName)}</span>`;
            }
            const pageDetails = document.querySelector(`#${tab.id} .page-details`);
            if (pageDetails) {
                pageDetails.innerHTML = `<span class="label">Page Path:</span> <span class="value">${escapeHtml(path)}</span> <span class="label">Full Address:</span> <span class="value">${escapeHtml(originalUrl)}</span>`;
            }
            if (pageContent) {
                applyPageColors(pageContent, "");
                pageContent.innerHTML = `<div class="page-loading">
                    Loading page with parameters...<br><br>
                    <strong>${escapeHtml(nodeName)}</strong><br><br>
                    Sending ${Object.keys(formData).filter(k => k !== '_meta').length} parameter(s)
                </div>`;
            }
            if (viewToggle) viewToggle.style.display = 'none';
            if (addressBar) addressBar.value = originalUrl;
            
            if (tab.id === activeTabId) {
                tab.setTitle(`Loading ${nodeName}...`);
            } else {
                tab.title = `Loading ${nodeName}...`;
            }
            
            // Only the tab on screen decides what the node list highlights; a page
            // arriving in a background tab must not move the selection.
            if (tab.id === activeTabId) updateNodeSelection();
            
            const controller = new AbortController();
            tab.currentRequest = controller;
            const loadStartedAt = performance.now();

            // Extract metadata BEFORE processing
            const metadata = formData._meta || {};
            
            // PREFIX form data keys appropriately
            const prefixedFormData = {};
            
            for (const [key, value] of Object.entries(formData)) {
                // Skip the metadata object
                if (key === '_meta') continue;
                
                // Check if key already has a prefix
                if (key.startsWith('var_') || key.startsWith('field_')) {
                    prefixedFormData[key] = value;
                } else {
                    // Check metadata to determine type
                    if (metadata[key]) {
                        const type = metadata[key];
                        const prefix = type === 'static' ? 'var_' : 'field_';
                        prefixedFormData[prefix + key] = value;
                    } else {
                        // Default: if isFormSubmission, use field_, otherwise var_
                        const prefix = isFormSubmission ? 'field_' : 'var_';
                        prefixedFormData[prefix + key] = value;
                    }
                }
            }


            const noVisit = tab.skipVisitCount ? '&visit=0' : '';
            tab.skipVisitCount = false;
            fetch(`/api/fetch/${hash}?path=${encodeURIComponent(path)}${noVisit}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(prefixedFormData),
                signal: controller.signal
            })
            .then(r => {
                return r.json();
            })
            .then(response => {
                
                if (tab.currentRequest === controller) {
                    if (response.status === 'success') {
                        tab.currentRawContent = response.content;
                        tab.isRawView = false;
                        
                        const renderedHtml = parseMicronContent(response.content);
                        if (pageContent) pageContent.innerHTML = renderedHtml;
                        if (pageContent) pageContent.className = 'page-content';
                        applyPageColors(pageContent, response.content);
                        
                        // A node not heard since startup: the server knows its name from the cache.
                        nodeName = adoptNodeName(hash, nodeName, response.node_name, tab);
                        if (pageTitle) {
                            pageTitle.innerHTML = `<span class="node-name">${escapeHtml(nodeName)}</span>`;
                        }
                        const pageDetails = document.querySelector(`#${tab.id} .page-details`);
                        if (pageDetails) {
                            pageDetails.innerHTML = `<span class="path-info">${escapeHtml(path)}</span> <span class="label">- Address:</span> <span class="address-info">${escapeHtml(originalUrl)}</span>` + sourceBadgeHtml(response);
                        }
                        setPageSource(tab, response);

                        if (viewToggle) {
                            viewToggle.style.display = 'block';
                            setViewToggleLabel(viewToggle, false);
                        }





                        if (tab.id === activeTabId) {
                            tab.setTitle(nodeName);
                        } else {
                            tab.title = nodeName;
                        }
                        
                        addClickHandlersToCurrentTab(tab);
                        hydrateMicronMedia(tab);
                        refitPageZoom();
                        requestAnimationFrame(() => refitPageZoom());
                        initScrollHint(tab);
                        updateScrollHint(tab);
                        // Pages with parameters or a submitted form get the
                        // same load report as any other page.
                        reportPageLoad(response.content, loadStartedAt, response.source, nodeName, path);

                    } else {
                        console.error('❌ Page load failed:', response.error);
                        if (pageContent) {
                            // The path is shown because a form link can point
                            // to a page the node does not have (a typo in the
                            // page: "thechatrooom" for "thechatroom"), and then
                            // the request fails whatever the parameters are.
                            // Values were written raw here before: escaped now.
                            pageContent.innerHTML = `<div class="error">Failed to load page: ${escapeHtml(response.error)}<br><br>
                                Requested path: ${escapeHtml(path)}<br>
                                Parameters sent: ${Object.keys(prefixedFormData).length}<br>
                                ${Object.entries(prefixedFormData).map(([k,v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`).join('<br>')}
                            </div>`;
                        }
                        if (pageTitle) pageTitle.textContent = `Error loading ${originalUrl}`;
                        if (viewToggle) viewToggle.style.display = 'none';
                        

                        if (tab.id === activeTabId) {
                            tab.failed = true; tab.setTitle('Error');
                        } else {
                            tab.failed = true; tab.title = 'Error'; tab.updateTabDisplay();
                        }
                    }
                    tab.currentRequest = null;
                    tab.setLoading(false);
                }
            })
            .catch(err => {
                console.error('❌ Network error:', err);
                if (tab.currentRequest === controller && !controller.signal.aborted) {
                    if (pageContent) {
                        pageContent.innerHTML = `<div class="error">Network error: ${escapeHtml(err.message)}<br><br>
                            Please check your connection and try again.<br><br>
                            Parameters that were being sent: ${Object.keys(prefixedFormData).length}
                        </div>`;
                    }
                    if (pageTitle) pageTitle.textContent = `Error loading ${originalUrl}`;
                    if (viewToggle) viewToggle.style.display = 'none';
                    tab.currentRequest = null;
                    tab.setLoading(false);
                    
                    if (tab.id === activeTabId) {
                        tab.failed = true; tab.setTitle('Network Error');
                    } else {
                        tab.failed = true; tab.title = 'Network Error'; tab.updateTabDisplay();
                    }
                }
            });
        }

        document.addEventListener('keydown', (e) => {
            // In a text field these keys already mean something: Ctrl+X is
            // cut, Ctrl+Left/Right move by word. Taking them over there
            // closed every other tab while cutting text in the address bar.
            const el = e.target;
            const typing = el && (el.isContentEditable
                || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !typing) {
                switch (e.key) {
                    case 'ArrowLeft':
                        e.preventDefault();
                        switchToPreviousTab();
                        break;
                    case 'ArrowRight':
                        e.preventDefault();
                        switchToNextTab();
                        break;
                    case 'x': 
                        e.preventDefault();
                        closeOtherTabs();
                        break;
                }
            }
            
            if (e.altKey && !e.ctrlKey && !e.metaKey) {
                switch (e.key) {
                    case 'n':
                        e.preventDefault();
                        createNewTab();
                        break;
                    case 'x':
                        e.preventDefault();
                        if (activeTabId && tabs.length > 1) {
                            closeTab(activeTabId);
                        }
                        break;
                    case 'b':
                        e.preventDefault();
                        userReloadPageTab();
                        break;
                    case 'f':
                        e.preventDefault();
                        addFavoriteFromUrl();
                        break;
                    case 'i':
                        e.preventDefault();
                        sendFingerprintToCurrentNode();
                        break;

                }
            }
        });

        function switchToPreviousTab() {
            if (tabs.length <= 1) return;
            
            const currentIndex = tabs.findIndex(tab => tab.id === activeTabId);
            const previousIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
            switchToTab(tabs[previousIndex].id);
        }

        function switchToNextTab() {
            if (tabs.length <= 1) return;
            
            const currentIndex = tabs.findIndex(tab => tab.id === activeTabId);
            const nextIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
            switchToTab(tabs[nextIndex].id);
        }

        function closeOtherTabs() {
            if (tabs.length <= 1) return; 
            
            const currentActiveTab = getActiveTab();
            if (!currentActiveTab) return;
            
            const tabsToClose = tabs.filter(tab => tab.id !== activeTabId);

            tabsToClose.forEach(tab => {
                // The same cleanup closeTab() does. Without it, a closed tab
                // with auto-reload or page partials kept asking its node for
                // pages in the background, for a tab that no longer existed.
                tab.stopAutoReload();
                stopPartials(tab.id);
                if (tab.currentRequest) {
                    try { tab.currentRequest.abort(); } catch (err) {}
                    tab.currentRequest = null;
                }
                document.querySelector(`[data-tab-id="${tab.id}"]`)?.remove();
                document.getElementById(tab.id)?.remove();
            });
            
            tabs = [currentActiveTab];
            
        }

        function updateNodeSelection() {
            const activeTab = getActiveTab();
            // Cleared first and always: a tab with no node (a new one) must
            // not keep showing the previous tab's node as selected.
            document.querySelectorAll('.node-item').forEach(item => item.classList.remove('selected'));
            // Nothing shown in the list: forget the last one, so coming back
            // to it (A, then a node not in the list, then A) scrolls to it
            // again. It used to count as "still selected" and stay off screen.
            if (!activeTab || !activeTab.selectedNode) {
                updateNodeSelection.lastShown = null;
                return;
            }

            // .node-item, not just [data-hash]: the info and star buttons
            // and the favorites carry data-hash too.
            const selectedHash = String(activeTab.selectedNode).toLowerCase();
            const nodeItem = document.querySelector(`.node-item[data-hash="${selectedHash}"]`);
            if (!nodeItem) updateNodeSelection.lastShown = null;
            if (nodeItem) {
                nodeItem.classList.add('selected');
                // Bring it into view - it never was, so a node further down
                // the list was highlighted out of sight and it looked as if
                // nothing had happened. Only when the selection changes
                // (another node, another tab), not on every two-second
                // poll, or the list would fight whoever is scrolling it.
                // A node that only appears later (its first announce) is
                // scrolled to when its row arrives.
                const key = activeTab.id + ':' + activeTab.selectedNode;
                if (updateNodeSelection.lastShown !== key) {
                    updateNodeSelection.lastShown = key;
                    scrollNodeIntoView(nodeItem);
                }
            }
        }

        // Keep a row where it is on screen while the list changes around
        // it (new nodes above, a re-sort): the node you are visiting if it
        // is in view, otherwise the first row in view. Returns the function
        // that puts it back after the change.
        function captureNodeListAnchor() {
            const box = document.querySelector('.node-list-container');
            if (!box) return () => {};
            const view = box.getBoundingClientRect();
            const inView = el => {
                const r = el.getBoundingClientRect();
                return r.bottom > view.top && r.top < view.bottom;
            };
            let anchor = box.querySelector('.node-item.selected');
            // The card of the page open stays put, even with the list at the
            // top: new nodes go in above, out of sight, and "N new nodes"
            // says so. Without one on screen, at the very top the list stays
            // at the top, so what comes in above is shown.
            if ((!anchor || !inView(anchor)) && box.scrollTop <= 1) return () => {};
            if (!anchor || !inView(anchor)) {
                anchor = Array.from(box.querySelectorAll('.node-item'))
                    .find(el => el.style.display !== 'none' && inView(el)) || null;
            }
            if (!anchor) return () => {};
            const before = anchor.getBoundingClientRect().top;
            return () => {
                if (!anchor.isConnected) return;
                const moved = anchor.getBoundingClientRect().top - before;
                if (Math.abs(moved) >= 1) box.scrollTop += moved;
            };
        }

        // After "N new nodes" is clicked: scroll to the first of them (in
        // list order) and light them up for a few seconds, so you see what
        // came in wherever the sort put it.
        function revealNewNodes(items) {
            const visible = items.filter(el => el.isConnected && el.style.display !== 'none');
            if (!visible.length) return;
            const top = el => el.getBoundingClientRect().top;
            visible.sort((a, b) => top(a) - top(b));
            const box = document.querySelector('.node-list-container');
            if (box) {
                const pending = document.getElementById('node-list-pending');
                const margin = (pending && !pending.hidden ? pending.offsetHeight : 0) + 8;
                box.scrollTop = Math.max(0, box.scrollTop + top(visible[0])
                                            - box.getBoundingClientRect().top - margin);
            }
            visible.forEach(el => {
                el.classList.add('just-added');
                setTimeout(() => el.classList.remove('just-added'), 1200);   // + 0.8s fade (style.css): 2s in all
            });
        }

        // Within the node list only: scrollIntoView() would also scroll the
        // page and the sidebar around it.
        function scrollNodeIntoView(item) {
            const box = item.closest('.node-list-container') || item.parentElement;
            if (!box) return;
            // Measured against the screen, so it does not matter how the
            // container is positioned (it is absolute, and moves).
            const itemTop = item.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
            const itemBottom = itemTop + item.offsetHeight;
            const margin = 8;
            if (itemTop < box.scrollTop + margin) {
                box.scrollTop = Math.max(0, itemTop - margin);
            } else if (itemBottom > box.scrollTop + box.clientHeight - margin) {
                box.scrollTop = itemBottom - box.clientHeight + margin;
            }
        }

        // Saying which address was copied matters when two rows are next to
        // each other and the click could have landed on either.
        function copyHashToClipboard(hash) {
            copyText(hash, `Node address copied:<br><code>${escapeHtml(hash)}</code>`);
        }

        // rBrowser is not an LXMF client, so the address is handed over for
        // whatever client the user does write with.
        function copyOperatorAddress(address) {
            copyText(address, `Operator LXMF address copied:<br><code>${escapeHtml(address)}</code>`);
        }

        // The operator block for the node info popup. Separate from the
        // node-list row because this one has room to show the address in
        // full and say where it came from.
        // A row of an info panel (node or contact): label, then value.
        function infoRow(label, value) {
            return `<div class="msg-info-row"><span>${label}</span><span>${value}</span></div>`;
        }

        // An address in an info panel; click to copy.
        function infoCode(value) {
            return value
                ? `<code class="msg-info-copy" data-copy="${escapeHtml(value)}" title="Click to copy">${escapeHtml(value)}</code>`
                : '<i class="muted">unknown</i>';
        }

        function operatorInfoHtml(nodeData) {
            if (!nodeData || !nodeData.operator_lxmf_address) return '';
            const address = nodeData.operator_lxmf_address;
            const name = nodeData.operator_name;
            return infoRow('Operator', name ? escapeHtml(name) : '<i class="muted">name not announced</i>')
                + infoRow('LXMF address', infoCode(address)
                    + '<div class="msg-info-note">Worked out from the identity in the node\'s announce, not requested from it.</div>');
        }

        // The node info panel: same frame as the contact info in Messages
        // (messengerPeerInfo), with the orange labels it always had.
        function showNodeInfo(hash, name, lastSeen, dataLength, announceCount, relativeTime) {
            // Live: the rows are drawn again each second from the node list's
            // data (refreshed by its own polling), so a new announce, another
            // path or the time since the last one show while the panel is open.
            const rowsHtml = () => {
                const nodeData = cachedNodes.find(n => n.hash === hash);
                const hops = nodeData ? nodeData.hops : 'Unknown';
                const nextHopInterface = nodeData ? nodeData.next_hop_interface : 'Unknown';
                const nodeAnnounceCount = nodeData ? nodeData.node_announce_count : 'Unknown';
                const seen = nodeData ? nodeData.last_seen : lastSeen;
                const length = nodeData ? nodeData.app_data_length : dataLength;

                let formattedTime = 'Unknown';
                let ago = relativeTime;
                if (seen && seen !== 'undefined') {
                    const date = new Date(seen);
                    if (!isNaN(date)) {
                        formattedTime = date.toLocaleString();
                        ago = `${durationText((Date.now() - date.getTime()) / 1000)} ago`;
                    } else {
                        formattedTime = seen;
                    }
                }

                const hopsText = hops === 'Unknown' || hops == null ? '<i class="muted">unknown</i>'
                    : escapeHtml(String(hops)) + (hops === 1 ? ' hop' : ' hops') + ' away';
                return infoRow('Node name', escapeHtml((nodeData && nodeData.name) || name))
                    + infoRow('Address', infoCode(hash))
                    + infoRow('Network hops', hopsText)
                    + infoRow('Interface', escapeHtml(String(nextHopInterface)))
                    + infoRow('Announce data', length === '?' || length == null ? 'not heard since startup' : escapeHtml(String(length)) + ' bytes')
                    + infoRow('Last announced', escapeHtml(String(ago)))
                    + infoRow('Last received', escapeHtml(formattedTime))
                    + infoRow('Announced', escapeHtml(String(nodeAnnounceCount)) + ' time(s)')
                    + operatorInfoHtml(nodeData);
            };
            const firstRows = rowsHtml();
            const overlay = document.createElement('div');
            overlay.className = 'auto-reload-modal';
            overlay.innerHTML = `<div class="auto-reload-dialog msg-info-dialog">
                <div class="dialog-header">
                    <h3>Node information</h3>
                    <button class="modal-close" aria-label="Close">&times;</button>
                </div>
                <div class="dialog-scroll">
                    <div class="node-info-rows">${firstRows}</div>
                    <div class="msg-info-row msg-info-block node-cache-info"><strong>Cache:</strong> <span class="muted">checking…</span></div>
                </div>
                <div class="msg-info-actions">
                    <button class="msg-bar-btn" data-act="ping">Ping</button>
                    <button class="msg-bar-btn" data-act="path" title="Forget the path to this node and ask the network for a new one">Request path</button>
                    <button class="msg-bar-btn" data-act="copy">Copy address</button>
                    <button class="msg-bar-btn" data-act="close">Close</button>
                </div></div>`;
            const close = () => overlay.remove();
            overlay.addEventListener('click', e => {
                if (e.target === overlay || e.target.closest('.modal-close')) return close();
                const copy = e.target.closest('[data-copy]');
                if (copy) return copyText(copy.dataset.copy);
                const act = e.target.closest('[data-act]');
                if (!act) return;
                if (act.dataset.act === 'ping') { close(); pingNode(hash, name); }
                else if (act.dataset.act === 'path') { close(); requestPath(hash, name); }
                else if (act.dataset.act === 'copy') copyHashToClipboard(hash);
                else close();
            });
            document.body.appendChild(overlay);
            const cacheBox = overlay.querySelector('.node-cache-info');
            fillNodeCacheInfo(cacheBox, hash);
            const rows = overlay.querySelector('.node-info-rows');
            let last = firstRows, ticks = 0;
            const timer = setInterval(() => {
                if (!overlay.isConnected) return clearInterval(timer);
                // Rewritten only when something changed, so a selection or a
                // click on an address is not lost to the redraw.
                const html = rowsHtml();
                if (html !== last) rows.innerHTML = last = html;
                if (++ticks % 10 === 0) fillNodeCacheInfo(cacheBox, hash);
            }, 1000);
        }

        // The cache section of the node info panel: what this tab is
        // showing, how many of the node's pages are saved, and for each one
        // whether the next visit will use the copy or go live.
        async function fillNodeCacheInfo(box, hash) {
            if (!box) return;
            let data;
            try {
                data = await fetch(`/api/cache/node/${encodeURIComponent(hash)}`).then(r => r.json());
            } catch (e) {
                box.innerHTML = '<strong>Cache:</strong> <span class="muted">not available</span>';
                return;
            }
            const rows = [];

            const tab = getActiveTab();
            const pill = tab && tab.selectedNode === hash
                ? document.querySelector(`#${tab.id} .source-pill`) : null;
            if (pill && !pill.hidden) {
                const state = pill.classList.contains('is-live') ? 'is-live'
                            : pill.classList.contains('is-cache') ? 'is-cache' : 'is-offline';
                rows.push(`<div class="node-cache-line">This tab: <span class="node-cache-state ${state}">${escapeHtml(pill.textContent)}</span>`
                          + ` <span class="muted">${escapeHtml((pill.dataset.tip || "").split('\n')[0])}</span></div>`);
            }

            let summary;
            if (!data.enabled) {
                summary = 'off in Settings, nothing is saved';
            } else if (data.identified) {
                summary = 'you are identified here, its pages are not cached';
            } else if (!data.count) {
                summary = 'no pages saved';
            } else {
                summary = `${data.count} page${data.count === 1 ? '' : 's'} saved, ${formatFileSize(data.bytes)}`
                        + (data.serving ? '' : ' - saved copies are not shown (Settings), kept for search and offline');
            }
            rows.unshift(`<div><strong>Cache:</strong> ${escapeHtml(summary)}</div>`);

            if (data.count) {
                const list = data.pages.map(p => {
                    let state, cls;
                    if (p.partial) {
                        state = 'partial, always live'; cls = 'is-live';
                    } else if (!p.cache_time) {
                        state = 'always live (#!c=0)'; cls = 'is-live';
                    } else if (p.fresh && data.serving) {
                        state = `used for ${formatDuration(Math.max(60, p.cache_time - p.age_seconds))} more`; cls = 'is-cache';
                    } else if (p.fresh) {
                        state = 'valid, not shown'; cls = 'is-muted';
                    } else {
                        state = 'expired, next visit live'; cls = 'is-muted';
                    }
                    return `<div class="node-cache-page" title="${escapeHtml(p.title || '')}">`
                         + `<span class="node-cache-path">${escapeHtml(p.path)}</span>`
                         + `<span class="muted">${escapeHtml(formatAge(p.age_seconds))}</span>`
                         + `<span class="node-cache-state ${cls}">${escapeHtml(state)}</span></div>`;
                }).join('');
                rows.push(`<div class="node-cache-pages">${list}</div>`);
            }
            box.innerHTML = rows.join('');
        }

function pingCurrentNode() {
    const tab = getActiveTab();
    if (!tab || !tab.selectedNode) {
        showNotification(
            'No current node selected for ping',
            'warning',
            4000
        );
        return;
    }

    const nodeName = tab.knownNodeName || getNodeName(tab.selectedNode);
    pingNode(tab.selectedNode, nodeName);
}

function pingNode(hash, name) {
    const notification = showNotification(
        `Pinging ${escapeHtml(name)}...<br>Measuring round-trip time...`,
        'info',
        15000
    );

    const pingStart = Date.now();

    fetch(`/api/ping/${hash}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        }
    })
    .then(response => response.json())
    .then(data => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }

        if (data.status === 'success') {
            const rtt = data.rtt || ((Date.now() - pingStart) / 1000);
            
            // Get hop information
            const nodeData = cachedNodes.find(n => n.hash === hash);
            const hops = nodeData ? nodeData.hops : 'Unknown';
            
            showPingAlert(name, hash, rtt, hops);
        } else {
            showNotification(
                `❌ Ping failed to ${escapeHtml(name)}<br><br><strong>Error:</strong> ${escapeHtml(data.error || 'Unknown error')}`
                + `<br><button class="notif-action" onclick="requestPath('${jsAttr(hash)}', '${jsAttr(name)}'); this.closest('.notification').remove();">Request a new path</button>`,
                'error',
                12000
            );
        }
    })
    .catch(error => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }

        console.error('Ping error:', error);
        showNotification(
            `Network error pinging ${escapeHtml(name)}<br><br><strong>Error:</strong> ${escapeHtml(error.message)}`,
            'error',
            6000
        );
    });
}

// A new path to a node: the old one is forgotten (here and in the shared
// instance) and the network is asked again. For a node that has announced
// and still cannot be reached - the path held may run through a hop that
// is gone. Offered in the nav bar, the node info panel and a failed ping.
function requestPathCurrentNode() {
    const tab = getActiveTab();
    const parsed = tab && parseNomadNetUrl(tab.currentUrl || '');
    const hash = (tab && tab.selectedNode) || (parsed && parsed.hash);
    if (!hash) {
        showNotification('No current node to request a path to', 'warning', 4000);
        return;
    }
    requestPath(hash, tab.knownNodeName || getNodeName(hash));
}

function pathText(info) {
    if (!info || typeof info.hops !== 'number' || info.hops >= 128) return 'no path';
    const via = String(info.next_hop_interface || '').replace(/^via\s+/, '');
    return `${info.hops} ${info.hops === 1 ? 'hop' : 'hops'}${via && via !== 'Unknown' ? ' via ' + via : ''}`;
}

function durationText(seconds) {
    const s = Math.abs(Math.round(seconds));
    if (s < 90) return `${s} s`;
    if (s < 5400) return `${Math.round(s / 60)} min`;
    if (s < 172800) return `${Math.round(s / 3600)} h`;
    return `${Math.round(s / 86400)} days`;
}

// What the path table holds for a node, read from rnsd: no packet goes out.
async function checkPath(hash, name) {
    const label = escapeHtml(name || hash.slice(0, 8) + '…');
    let data;
    try {
        data = await fetch(`/api/path-check/${encodeURIComponent(hash)}`).then(r => r.json());
    } catch (e) {
        data = { status: 'error', error: e.message };
    }
    if (data.status !== 'success') {
        showNotification(`Could not read the path to ${label}: ${escapeHtml(data.error || 'unknown error')}`, 'error', 6000);
        return;
    }
    if (!data.known) {
        showNotification(`No path to ${label} is held now.<br>Opening a page or Request a new path asks the network for one.`,
                         'info', 7000);
        return;
    }
    const lines = [`Path to ${label}: <strong>${escapeHtml(pathText({ hops: data.hops, next_hop_interface: data.via }))}</strong>`];
    if (data.learned_ago != null) lines.push(`Learned ${durationText(data.learned_ago)} ago`);
    if (data.expires_in != null) {
        lines.push(data.expires_in > 0 ? `Expires in ${durationText(data.expires_in)}`
                                       : `Expired ${durationText(data.expires_in)} ago: Request a new path`);
    }
    lines.push('A held path is not proof the node is up: Ping checks that.');
    showNotification(lines.join('<br>'), data.expires_in != null && data.expires_in <= 0 ? 'error' : 'success', 9000);
}

const pathRequestsRunning = new Set();

async function requestPath(hash, name) {
    if (pathRequestsRunning.has(hash)) return;
    pathRequestsRunning.add(hash);
    const label = escapeHtml(name || hash.slice(0, 8) + '…');
    const buttons = document.querySelectorAll('.path-btn');
    buttons.forEach(b => b.classList.add('busy'));
    const waiting = showNotification(`Requesting a new path to ${label}…`, 'info', 120000);
    let data;
    try {
        data = await fetch(`/api/path/${encodeURIComponent(hash)}`, { method: 'POST' }).then(r => r.json());
    } catch (e) {
        data = { status: 'error', error: e.message };
    } finally {
        pathRequestsRunning.delete(hash);
        if (!pathRequestsRunning.size) buttons.forEach(b => b.classList.remove('busy'));
        if (waiting && waiting.parentNode) waiting.parentNode.removeChild(waiting);
    }
    const was = data.had_path ? `<br>Before: ${escapeHtml(pathText(data.before))}` : '<br>There was no path before.';
    if (data.status === 'success') {
        showNotification(`New path to ${label}: <strong>${escapeHtml(pathText(data.after))}</strong>`
            + ` in ${(data.elapsed || 0).toFixed(1)} s${was}`, 'success', 8000);
        updateNodes();
    } else {
        showNotification(`No path to ${label}: ${escapeHtml(data.error || 'no answer')}${was}`
            + '<br>No answer yet: the node or a hop on the way may be offline or very slow.', 'error', 9000);
    }
}

function showPingAlert(nodeName, nodeHash, rtt, hops) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 10001;
        background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center;
    `;
    
    const dialog = document.createElement('div');
    dialog.style.cssText = `
        background: #161b22; border: 2px solid #30363d; color: #e6edf3;
        padding: 20px; border-radius: 8px; max-width: 450px; min-width: 350px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    `;
    
    const hopsDisplay = hops === 'Unknown' ? 'Unknown' : `${hops} ${hops === 1 ? 'hop' : 'hops'}`;
    
    dialog.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <h3 style="margin: 0; color: #3fb950; font-size: 18px;">✓ Valid Ping Reply!</h3>
            <button onclick="this.parentElement.parentElement.parentElement.remove()" 
                    style="background: none; border: none; color: #7d8590; cursor: pointer; font-size: 20px; padding: 0;">&times;</button>
        </div>
        <div style="line-height: 1.8; font-size: 14px;">
            <div style="margin-bottom: 10px;">
                <strong style="color: #ffa657;">Node:</strong> 
                <span style="color: #e6edf3;">${escapeHtml(nodeName)}</span>
            </div>
            <div style="margin-bottom: 10px;">
                <strong style="color: #ffa657;">Address:</strong> 
                <span style="font-family: monospace; font-size: 12px; background: #21262d; padding: 2px 6px; border-radius: 3px;">${nodeHash}</span>
            </div>
            <div style="margin-bottom: 10px;">
                <strong style="color: #ffa657;">Ping Duration:</strong> 
                <span style="color: #3fb950; font-weight: bold;">${rtt.toFixed(3)}s</span>
            </div>
            <div style="margin-bottom: 10px;">
                <strong style="color: #ffa657;">Hops There:</strong> 
                <span style="color: #58a6ff;">${hopsDisplay}</span>
            </div>
            <div style="margin-bottom: 10px;">
                <strong style="color: #ffa657;">Hops Back:</strong> 
                <span style="color: #58a6ff;">${hopsDisplay}</span>
            </div>
        </div>
        <div style="margin-top: 20px; text-align: center;">
            <button onclick="this.parentElement.parentElement.parentElement.remove();" 
                    style="background: #238636; color: white; border: none; padding: 8px 24px; border-radius: 4px; cursor: pointer; font-size: 13px;">
                OK
            </button>
        </div>
    `;
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            document.body.removeChild(overlay);
        }
    });
    
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            document.removeEventListener('keydown', escapeHandler);
            if (overlay.parentNode) {
                document.body.removeChild(overlay);
            }
        }
    };
    document.addEventListener('keydown', escapeHandler);
}

// How the node list is ordered is a preference, not a per-visit choice:
// somebody who sorts alphabetically wants it alphabetical tomorrow too.
// The select itself is the source of truth; this only remembers it.
const NODE_SORT_KEY = 'rbrowser_node_sort';
const NODE_SORT_VALUES = ['original', 'recent', 'frequent', 'visited', 'alphabetical'];
let savedNodeSort = null;    // what settings/node_list.json holds (persistNodeSort)
let nodeSortApplied = false;
let nodeListHovered = false;        // pointer over the list: hold it still
let nodeListShowPending = false;    // "N new nodes" clicked: let them in once

// "N new nodes" counts the nodes that came in since it was last clicked or
// closed, whether they wait (pointer on the list) or are already in it. It
// stays until clicked (go to them) or closed with its x. Closed ones are
// acknowledged: not counted again while they wait to come in.
const nodeListNew = new Set();
const nodeListAcked = new Set();
// Under Most Recent and Most Announced a node that announces again moves to
// the top: it counts too ("updated"), so away from the top the button tells
// you the top has changed. last_seen per node, to notice the new announce.
const NODE_SORTS_BY_ANNOUNCE = ['recent', 'frequent'];
const nodeListMoved = new Set();
const nodeListLastSeen = new Map();
let nodeListRevealHashes = null;    // the click: what the next update goes to
const NEW_NODES_BADGE_KEY = 'rbrowser_new_nodes_badge';

function newNodesBadgeEnabled() {
    try { return localStorage.getItem(NEW_NODES_BADGE_KEY) !== '0'; } catch (e) { return true; }
}

// Settings > NomadNet Browser > Node list: picking a search result clears the search (default),
// or keeps it to open the next result from the same list.
const CLEAR_SEARCH_KEY = 'rbrowser_clear_search_on_pick';
function clearSearchOnPick() {
    try { return localStorage.getItem(CLEAR_SEARCH_KEY) !== '0'; } catch (e) { return true; }
}

// The name as sorted: leading symbols and emoji skipped, so "~ Alpha ~"
// files under A and not above every letter.
function sortableNodeName(node) {
    const name = String(node.name || '');
    const trimmed = name.replace(/^[^\p{L}\p{N}]+/u, '');
    return trimmed || name;
}

// The one comparison both the full sort and the placing of a new node use,
// so a node inserted on arrival is already where the next sort would put it.
// Negative: a goes before b.
function compareNodes(sortBy, a, b) {
    let result = 0;
    switch (sortBy) {
        case 'recent':
            // ISO timestamps of identical format sort chronologically as
            // plain strings.
            result = String(b.last_seen || '').localeCompare(String(a.last_seen || ''));
            break;
        case 'frequent':
            result = (b.node_announce_count || 0) - (a.node_announce_count || 0);
            // Most nodes have announced the same few times; among those the
            // one heard last comes first, not whichever hash sorts first.
            if (result === 0) {
                result = String(b.last_seen || '').localeCompare(String(a.last_seen || ''));
            }
            break;
        case 'visited':
            // The nodes you open most, by the server's visit count; never
            // opened ones after them, most recently heard first.
            result = (b.visits || 0) - (a.visits || 0);
            if (result === 0) {
                result = String(b.last_seen || '').localeCompare(String(a.last_seen || ''));
            }
            break;
        case 'alphabetical':
            // numeric: "Node 2" before "Node 10". base: case and accents
            // do not split the list in two.
            result = sortableNodeName(a).localeCompare(sortableNodeName(b), undefined,
                                                        { numeric: true, sensitivity: 'base' });
            break;
        case 'original':
        default:
            // The announce counter when the node was first heard: discovery order.
            result = (a.announce_count || 0) - (b.announce_count || 0);
            break;
    }
    // Deterministic tiebreak, so equal nodes keep a fixed order instead of
    // swapping places on every refresh.
    if (result === 0) result = String(a.hash).localeCompare(String(b.hash));
    return result;
}

// While the mouse is over the list it holds still: no re-sort, no new rows,
// no rows removed, so what you are reading does not jump. No timers: it
// holds exactly while the pointer is there. A touch screen has no hover,
// so there the list is never held.
// (nodeListHovered and nodeListShowPending are declared with the sort state.)

// A finger on the list counts as the mouse over it, for NODE_TOUCH_HOLD ms
// after the last touch: rows moved under it and the tap hit the node
// below.
const NODE_TOUCH_HOLD = 4000;
let nodeListTouchedAt = 0;

function nodeListInUse() {
    if (nodeListShowPending) return false;
    return nodeListHovered || Date.now() - nodeListTouchedAt < NODE_TOUCH_HOLD;
}

function watchNodeListUse() {
    const container = document.querySelector('.node-list-container');
    if (!container) return;
    container.addEventListener('pointerenter', e => {
        if (e.pointerType === 'mouse') nodeListHovered = true;
    });
    container.addEventListener('pointerleave', () => {
        nodeListHovered = false;
        updateNodes();          // what waited comes in now
    });
    const touched = () => {
        nodeListTouchedAt = Date.now();
        clearTimeout(watchNodeListUse.release);
        watchNodeListUse.release = setTimeout(updateNodes, NODE_TOUCH_HOLD + 50);
    };
    container.addEventListener('touchstart', touched, { passive: true });
    container.addEventListener('touchmove', touched, { passive: true });
    // Scrolling to the new nodes counts as seeing them: "N new nodes"
    // goes down (or away) as they come into view.
    let pendingFrame = 0;
    container.addEventListener('scroll', () => {
        if (pendingFrame) return;
        pendingFrame = requestAnimationFrame(() => {
            pendingFrame = 0;
            setNodeListPending(cachedNodes);
        });
    }, { passive: true });
}

// "3 new nodes" while the list is held. Clicking it lets them in and
// scrolls to them (revealNewNodes).
//
// It sits over the Sort row: always in sight, and it covers neither a card
// nor moves the list being read. Sticky over the list it hid half of the
// first card; at the top of the list it was out of sight as soon as the
// list was scrolled.
const PENDING_ARROWS = {
    up: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3.5 8.5L8 13l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    both: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.5v13M4.5 5L8 1.5 11.5 5M4.5 11L8 14.5 11.5 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    here: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
};

// Where the new nodes are, or would land under the sort in force if they
// are still waiting, against the part of the list on screen: above it,
// below it, both, or in sight.
function pendingDirection(nodes) {
    const box = document.querySelector('.node-list-container');
    const list = document.getElementById('node-list');
    if (!box || !list || !nodes.length) return 'here';
    const top = box.getBoundingClientRect().top;
    const height = box.clientHeight;
    let above = 0, below = 0;
    for (const node of nodes) {
        const row = list.querySelector(`.node-item[data-hash="${node.hash}"]`);
        if (row && row.style.display === 'none') continue;
        const before = row || insertionPointFor(list, node);
        const y = before ? before.getBoundingClientRect().top - top
                         : list.getBoundingClientRect().bottom - top;
        if (y < 0) above++;
        else if (y > height) below++;
    }
    if (above && below) return 'both';
    if (above) return 'up';
    if (below) return 'down';
    return 'here';
}

// "new nodes", "updated" (announced again and moved up) or both.
function pendingLabel(count) {
    const moved = nodeListMoved.size;
    if (!moved) return `new node${count === 1 ? '' : 's'}`;
    if (moved >= nodeListNew.size) return 'updated';
    return 'new / updated';
}

// Shown while there are new nodes (nodeListNew) out of sight: above or below
// the part of the list on screen, wherever the sort put them (top under
// Most Recent, bottom under Original...), or waiting while the pointer is
// on the list. A new node that comes into view has been seen and is no
// longer counted, so at the top of a Most Recent list it never shows. Off
// in Settings if you do not want it. Closed with its x it comes back only
// for nodes that arrive after.
function setNodeListPending(nodes = []) {
    let badge = document.getElementById('node-list-pending');
    if (!newNodesBadgeEnabled()) nodeListNew.clear();
    const box = document.querySelector('.node-list-container');
    let count = 0;
    // At the top of a list sorted by announces the news arrive right where
    // you look: more than fit on screen (a night left open: "178 new nodes",
    // arrow down) is not news to go to. Seen.
    const sortSelect = document.getElementById('node-sort');
    // Nothing new: no reading of positions, which forced a layout of the
    // whole page at every poll.
    if (!nodeListNew.size) {
        nodeListMoved.clear();
        if (badge) badge.hidden = true;
        return;
    }
    if (box && box.clientHeight && box.scrollTop < 5 && !nodeListInUse()
            && NODE_SORTS_BY_ANNOUNCE.includes(sortSelect && sortSelect.value)) {
        nodeListNew.clear();
    }
    if (box) {
        const view = box.getBoundingClientRect();
        for (const hash of Array.from(nodeListNew)) {
            const row = box.querySelector(`.node-item[data-hash="${hash}"]`);
            if (!row) { count++; continue; }                  // waiting
            if (row.style.display === 'none') continue;       // filtered out by the search
            const r = row.getBoundingClientRect();
            if (r.bottom > view.top && r.top < view.bottom) nodeListNew.delete(hash);
            else count++;
        }
    } else {
        count = nodeListNew.size;
    }
    for (const hash of nodeListMoved) {
        if (!nodeListNew.has(hash)) nodeListMoved.delete(hash);
    }
    if (!count) {
        if (badge) badge.hidden = true;
        return;
    }
    if (!badge) {
        // A div, not a button: it holds the x, and a button cannot
        // hold another one.
        badge = document.createElement('div');
        badge.id = 'node-list-pending';
        badge.className = 'node-list-pending';
        badge.setAttribute('role', 'button');
        badge.tabIndex = 0;
        const open = () => {
            badge.hidden = true;
            nodeListRevealHashes = new Set(nodeListNew);
            nodeListNew.clear();
            nodeListShowPending = true;
            updateNodes();
        };
        badge.addEventListener('click', e => {
            if (e.target.closest('.pending-close')) {
                e.stopPropagation();
                badge.hidden = true;
                nodeListNew.forEach(hash => nodeListAcked.add(hash));
                nodeListNew.clear();
                return;
            }
            open();
        });
        badge.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
        const sidebar = document.querySelector('.sidebar');
        if (sidebar) sidebar.appendChild(badge);
    }
    const where = pendingDirection(nodes.filter(node => nodeListNew.has(node.hash)));
    const tip = { up: 'Above what you see', down: 'Below what you see',
                  both: 'Some above, some below', here: 'Where you are looking' }[where];
    badge.className = `node-list-pending dir-${where}`;
    badge.title = `${tip} - click to go there`;
    badge.innerHTML = `<span class="pending-count">${count}</span>`
        + `<span class="pending-text">${pendingLabel(count)}</span>`
        + `<span class="pending-arrow">${PENDING_ARROWS[where]}</span>`
        + `<span class="pending-close" role="button" title="Close (Settings - NomadNet Browser - Node list to turn it off)">&times;</span>`;
    const sort = document.querySelector('.sort-container');
    if (sort) {
        // 26px high, centred on the Sort row.
        badge.style.top = `${sort.offsetTop + Math.max(0, (sort.offsetHeight - 26) / 2)}px`;
        badge.style.height = '26px';
    }
    badge.hidden = false;
}

// The order is kept on the server (settings/node_list.json, /api/node-sort):
// localStorage is one per address, so 127.0.0.1, localhost and
// rbrowser.local each started from "original". localStorage stays as the
// fallback when the server cannot be reached. Written only when it changes:
// sortAndFilterNodes runs on every poll.
function persistNodeSort(value) {
    try { localStorage.setItem(NODE_SORT_KEY, value); } catch (e) {}
    if (value === savedNodeSort) return;
    savedNodeSort = value;
    fetch('/api/node-sort', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sort: value }),
    }).catch(() => { savedNodeSort = null; });
}

async function restoreNodeSort() {
    const select = document.getElementById('node-sort');
    if (!select) return;

    let stored = null;
    try {
        const data = await fetch('/api/node-sort').then(r => r.json());
        if (data && data.status === 'success' && data.sort) {
            stored = data.sort;
            savedNodeSort = stored;
        }
    } catch (e) {}
    if (!stored) {
        try { stored = localStorage.getItem(NODE_SORT_KEY); } catch (e) {}
    }

    // Anything not in the list is ignored rather than assigned: a stale or
    // hand-edited value would otherwise leave the select blank and the
    // comparator falling through to its default with no way to tell.
    if (stored && NODE_SORT_VALUES.includes(stored)) {
        select.value = stored;
    }
}

function sortAndFilterNodes() {
    const select = document.getElementById('node-sort');
    const list = document.getElementById('node-list');
    if (!select || !list) return;

    const sortBy = select.value;
    persistNodeSort(sortBy);
    const nodeItems = Array.from(list.querySelectorAll('.node-item'));
    if (!nodeItems.length) return;

    // Index the data once. The old version called cachedNodes.find() inside
    // the comparator, so every single comparison walked the whole node array:
    // with 200 nodes that is a scan per comparison, thousands of them per
    // sort.
    const byHash = new Map();
    for (const node of cachedNodes) byHash.set(node.hash, node);

    const compare = (a, b) => {
        const nodeA = byHash.get(a.getAttribute('data-hash'));
        const nodeB = byHash.get(b.getAttribute('data-hash'));
        if (!nodeA || !nodeB) return 0;
        return compareNodes(sortBy, nodeA, nodeB);
    };

    const sorted = nodeItems.slice().sort(compare);

    // Only touch the DOM when the order actually changed. This runs on every
    // poll now, and re-appending two hundred elements twice a second for no
    // reason is exactly the kind of thing that made the UI feel sticky.
    let changed = false;
    for (let i = 0; i < sorted.length; i++) {
        if (sorted[i] !== nodeItems[i]) { changed = true; break; }
    }
    if (changed) {
        const fragment = document.createDocumentFragment();
        sorted.forEach(item => fragment.appendChild(item));
        list.appendChild(fragment);
        filterNodes();
    }
}


// ─────────────────────────────────────────────────────────────────────────
// Sidebar collapse, for reading a page at full width.
//
// The button lives in the navigation bar rather than in the sidebar itself,
// because a control that hides its own container cannot bring it back.
// ─────────────────────────────────────────────────────────────────────────

const SIDEBAR_COLLAPSED_KEY = 'rbrowser_sidebar_collapsed';
const SIDEBAR_WIDTH_KEY = 'rbrowser_sidebar_width';
const SIDEBAR_DEFAULT_WIDTH = 210;
const SIDEBAR_MIN_WIDTH = 140;   // below this the node rows stop being readable
const SIDEBAR_MAX_WIDTH = 600;

// On a desktop the list is never narrower than a card's bottom row
// (bytes announced, visits, saved pages, hops, last seen) needs to show in
// full; measured, since it depends on the font. Phones keep the fixed one.
let sidebarMinWidth = SIDEBAR_MIN_WIDTH;

function measureNodeRowWidth() {
    const sidebar = document.querySelector('.sidebar');
    const list = document.getElementById('node-list');
    if (!sidebar || !list || typeof buildNodeItem !== 'function') return null;
    // A full row as cards show it in practice: three-digit announces, two-
    // digit visits, saved pages, two-digit hops.
    const probe = buildNodeItem({
        hash: '0'.repeat(32), name: 'probe', app_data_length: 999, visits: 99,
        hops: 12, last_seen_relative: 'Just now',
    });
    const cache = probe.querySelector('.node-cache');
    if (cache) { cache.hidden = false; cache.querySelector('.node-cache-count').textContent = '9'; }
    // In the list, so its own styles apply, but taking no height and unseen.
    probe.style.cssText += ';visibility:hidden;height:0;overflow:hidden;margin-top:0;margin-bottom:0;'
        + 'padding-top:0;padding-bottom:0;border-top-width:0;border-bottom-width:0;pointer-events:none';
    list.prepend(probe);
    try {
        const info = probe.querySelector('.node-info');
        if (!info) return null;
        // What sits around the row: sidebar padding, the card's padding and
        // borders, and the list's scrollbar even while it has none yet.
        const scrollbar = list.offsetWidth - list.clientWidth > 0 ? 0 : 10;
        const around = sidebar.getBoundingClientRect().width - info.clientWidth + scrollbar;
        // Its full width: "bytes announced" ends in an ellipsis rather than
        // overflow when short of room, so overflow cannot tell.
        info.style.width = 'max-content';
        const natural = info.getBoundingClientRect().width;
        return Math.ceil(natural + around + 2);
    } finally {
        probe.remove();
    }
}

function updateSidebarMinWidth() {
    if (window.innerWidth < 768) {
        sidebarMinWidth = SIDEBAR_MIN_WIDTH;
        return;
    }
    const need = measureNodeRowWidth();
    if (!need) return;
    sidebarMinWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, need));
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10);
    if (!isNaN(current) && current < sidebarMinWidth) setSidebarWidth(sidebarMinWidth, false);
}

function setSidebarWidth(px, persist) {
    const width = Math.max(sidebarMinWidth, Math.min(SIDEBAR_MAX_WIDTH, Math.round(px)));
    document.documentElement.style.setProperty('--sidebar-w', width + 'px');
    if (persist) {
        try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch (e) {}
    }
    return width;
}

function applySidebarState(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    // Every tab has its own navigation bar, so every copy of the button has
    // to show the same state.
    document.querySelectorAll('.sidebar-toggle-btn').forEach(btn => {
        btn.textContent = collapsed ? '\u00bb' : '\u00ab';
        btn.title = collapsed ? 'Show the node list' : 'Hide the node list and read full width';
    });
}

// A client in its own window (Settings > each client > Open in a new window,
// off by default, remembered in this browser): its tab opens /?app=<kind>, a
// page with that client alone, kept open while rBrowser does other things.
// One window per client: clicking again brings it forward.
const APP_WINDOW_OPEN = { lxmf: () => openMessenger(), rrc: () => openRrc(), bbs: () => openRetibbs(), rmap: () => openRmap() };
const APP_WINDOW_CLOSE = { lxmf: () => closeMessenger(), rrc: () => closeRrc(), bbs: () => closeRetibbs(), rmap: () => closeRmap() };
const APP_WINDOW_TABS = { lxmf: 'messenger-tab', rrc: 'rrc-tab', bbs: 'retibbs-tab', rmap: 'rmap-tab' };
const APP_WINDOW_NAMES = { lxmf: 'LXMF Messenger', rrc: 'RRC Client', bbs: 'BBS Client', rmap: 'RMAP' };
const APP_WINDOW = (() => {
    const kind = new URLSearchParams(location.search).get('app');
    return kind && kind in APP_WINDOW_OPEN ? kind : '';
})();

// A client's window says it is alive (every few seconds, in this browser):
// while it is, the main page keeps quiet for that client, no sounds, popups
// or "while you were away" - you read them in the window.
if (APP_WINDOW) {
    const beat = () => { try { localStorage.setItem(`rbrowser_app_alive_${APP_WINDOW}`, String(Date.now())); } catch (e) {} };
    beat();
    setInterval(beat, 4000);
    window.addEventListener('pagehide', () => { try { localStorage.removeItem(`rbrowser_app_alive_${APP_WINDOW}`); } catch (e) {} });
}

function appWindowElsewhere(kind) {
    if (APP_WINDOW) return false;
    try { return Date.now() - Number(localStorage.getItem(`rbrowser_app_alive_${kind}`) || 0) < 12000; } catch (e) { return false; }
}

function appWindowOn(kind) {
    try { return localStorage.getItem(`rbrowser_app_window_${kind}`) === '1'; } catch (e) { return false; }
}

function appWindowRow(kind) {
    return `<div class="settings-row">
                <span title="Its tab opens the client alone in a new browser window, to keep it open while rBrowser does other things. Only in this browser">Open in a new window</span>
                <div class="toggle-switch${appWindowOn(kind) ? ' active' : ''}" id="setting-app-window-${kind}"><div class="toggle-slider"></div></div>
            </div>`;
}

// A client's tab clicked: here, or its own window.
function openAppTab(kind) {
    if (!APP_WINDOW && appWindowOn(kind)) {
        // Named: the window already open comes forward, not reloaded.
        const win = window.open('', `rbrowser-app-${kind}`);
        if (win) {
            let fresh = true;
            try { fresh = win.location.href === 'about:blank'; } catch (e) {}
            if (fresh) win.location.href = `/?app=${kind}`;
            win.focus();
            // Open here from before the switch: it leaves this page,
            // only hidden (the client stays connected, its window takes over).
            if (document.getElementById(APP_WINDOW_TABS[kind])?.classList.contains('active')) APP_WINDOW_CLOSE[kind]();
            return;
        }
        // A blocked pop-up: it opens here.
    }
    APP_WINDOW_OPEN[kind]();
}

// The main page answers to its name, so a client's window can bring it back.
if (!APP_WINDOW) window.name = 'rbrowser-main';

// In a client's own window, in place of the node list button: back to
// rBrowser, forward if open, opened again if it was closed.
function appMainButton() {
    if (!APP_WINDOW) return '';
    return `<button class="nav-btn app-main-btn" onclick="openMainWindow()" title="Back to rBrowser (opens it if it was closed)" aria-label="Back to rBrowser"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 7.5L8 2.5l6 5M3.8 6.2V13.5h3V10h2.4v3.5h3V6.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
}

function openMainWindow() {
    const win = window.open('', 'rbrowser-main');
    if (!win) { window.open('/', '_blank'); return; }
    let fresh = true;
    try { fresh = win.location.href === 'about:blank'; } catch (e) {}
    if (fresh) win.location.href = '/';
    win.focus();
}

// ─── Links between windows ──────────────────────────────────
// A link goes to the client it belongs to: a NomadNet page to the main
// page, an LXMF address to the messenger, an RRC hub to the RRC client -
// in this window when that client is here, else in the window it lives in
// (a client in its own window, or the main page). The other window gets it
// through localStorage (same browser), or opens with it in its address.
//   {kind: 'page', address: '<hash>:/page/x.mu'}
//   {kind: 'lxmf', address: '<hash>'}
//   {kind: 'rrc',  address: 'rrc://<hash>[/room]'}

const LINK_KEY = 'rbrowser_link_cmd';
const LINK_CLIENT = { page: 'main', lxmf: 'lxmf', rrc: 'rrc', bbs: 'bbs', propnode: 'main' };

if (!APP_WINDOW) {
    const beat = () => { try { localStorage.setItem('rbrowser_main_alive', String(Date.now())); } catch (e) {} };
    beat();
    setInterval(beat, 4000);
    window.addEventListener('pagehide', () => { try { localStorage.removeItem('rbrowser_main_alive'); } catch (e) {} });
}

// MeshChatX's links to a room: meshchatx://relay?hub=<hash>&room=<room>
// (meshchat:// too). The same as our rrc://<hash>/<room>.
function relayUrlToRrc(value) {
    const m = String(value || '').trim().match(/^(?:meshchatx|meshchat):\/\/relay\?(.*)$/i);
    if (!m) return null;
    let params;
    try { params = new URLSearchParams(m[1].replace(/&amp;/g, '&')); } catch (e) { return null; }
    const hub = String(params.get('hub') || '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hub)) return null;
    const room = String(params.get('room') || '').replace(/^#/, '').trim();
    return `rrc://${hub}${room ? '/' + room : ''}`;
}

function linkTargetValid(t) {
    if (!t || !Object.hasOwn(LINK_CLIENT, t.kind)) return false;
    const a = String(t.address || '');
    if (t.kind === 'lxmf' || t.kind === 'bbs' || t.kind === 'propnode') return /^[0-9a-f]{32}$/.test(a);
    if (t.kind === 'rrc') return /^rrc:\/\/[0-9a-f]{32}(:[\w.\-]+)?(\/[^<>"'\n]*)?$/i.test(a);
    return /^[0-9a-f]{32}:\/[^\s<>"']*$/i.test(a);
}

// A link from outside rBrowser (?link=, ?url=, links.py): any web page can
// make one, so only the well formed ones, as links.py link_target writes
// them - a NomadNet path, a room name, a bare address. Marked external, so
// joining a hub or a BBS is asked first (runLinkHere).
const EXT_PAGE = /^[0-9a-f]{32}(:\/(page|file)\/[A-Za-z0-9_\-./~]*(`[A-Za-z0-9_\-.=|:]*)?)?$/i;
function externalLinkTarget(t) {
    // hasOwn: "constructor", "toString"... are "in" any object too.
    if (!t || typeof t !== 'object' || typeof t.address !== 'string' || !Object.hasOwn(LINK_CLIENT, t.kind)) return null;
    const a = t.address;
    const ok = t.kind === 'page' ? EXT_PAGE.test(a) && !a.includes('..')
        : t.kind === 'rrc' ? /^rrc:\/\/[0-9a-f]{32}(\/[a-z0-9][a-z0-9_\-]{0,62})?$/.test(a)
        : /^[0-9a-f]{32}$/.test(a);
    return ok ? { kind: t.kind, address: a, external: true } : null;
}

function windowAlive(win) {
    if (win === 'main') {
        try { return Date.now() - Number(localStorage.getItem('rbrowser_main_alive') || 0) < 12000; } catch (e) { return false; }
    }
    try { return Date.now() - Number(localStorage.getItem(`rbrowser_app_alive_${win}`) || 0) < 12000; } catch (e) { return false; }
}

// Opens it here: the client it belongs to is in this window.
function runLinkHere(t) {
    if (t.kind === 'page') {
        if (APP_WINDOW) return false;
        openQuickAddress(t.address, null, true);
    } else if (t.kind === 'lxmf') {
        if (!(typeof messengerEnabled === 'function' && messengerEnabled())) {
            showNotification('The messenger is off: Settings > LXMF Messenger', 'info', 5000);
            return true;
        }
        openMessenger(t.address);
    } else if (t.kind === 'rrc') {
        // From a web page, a hub not open here: asked first (NomadNet asks too).
        const hub = t.address.slice(6, 38).toLowerCase();
        const known = typeof Rrc !== 'undefined' && Rrc.data && Rrc.data[hub];
        if (t.external && !known) {
            confirmDialog('RRC hub', `Connect to the RRC hub <code>${escapeHtml(hub)}</code>?`
                + ` It sees your nick and identity. (A link opened from outside rBrowser.)`, 'Connect')
                .then(ok => { if (ok) openRrcAddress(t.address); });
        } else {
            openRrcAddress(t.address);
        }
    } else if (t.kind === 'bbs') {
        if (typeof retibbsEnabled !== 'function' || !retibbsEnabled()) {
            showNotification('The BBS client is off: Settings > BBS Client', 'info', 5000);
            return true;
        }
        const go = () => { openRetibbs(); retibbsConnect(t.address); };
        if (t.external) {
            confirmDialog('BBS', `Connect to the BBS <code>${escapeHtml(t.address)}</code>? (A link opened from outside rBrowser.)`, 'Connect')
                .then(ok => { if (ok) go(); });
        } else {
            go();
        }
    } else if (t.kind === 'propnode') {
        // Asked first, as in RMAP: it changes Settings > LXMF Messenger.
        confirmDialog('Propagation node',
            `Use <code>${escapeHtml(t.address)}</code> as your default propagation node? (Settings > LXMF Messenger)`,
            'Use it').then(ok => { if (ok) usePropagationNode(t.address); });
    }
    return true;
}

function openLinkTarget(t) {
    if (!linkTargetValid(t)) return;
    const client = LINK_CLIENT[t.kind];
    const here = APP_WINDOW || 'main';
    // Where it lives: its own window when that is on, else the main page.
    const target = client === 'main' ? 'main' : (appWindowOn(client) ? client : 'main');
    if (target === here) { runLinkHere(t); return; }
    const name = target === 'main' ? 'rbrowser-main' : `rbrowser-app-${target}`;
    if (windowAlive(target)) {
        try {
            localStorage.setItem(LINK_KEY, JSON.stringify({ to: target, t, id: Math.random().toString(36).slice(2), at: Date.now() }));
        } catch (e) {}
        const win = window.open('', name);
        if (win) win.focus();
        return;
    }
    const base = target === 'main' ? '/' : `/?app=${target}`;
    const url = `${base}${base.includes('?') ? '&' : '?'}link=${encodeURIComponent(JSON.stringify(t))}`;
    if (!window.open(url, name)) runLinkHere(t) || showNotification('Allow pop-ups for rBrowser to open it in its window', 'warning', 6000);
}

window.addEventListener('storage', e => {
    if (e.key !== LINK_KEY || !e.newValue) return;
    let msg;
    try { msg = JSON.parse(e.newValue); } catch (err) { return; }
    if (!msg || msg.to !== (APP_WINDOW || 'main') || Date.now() - Number(msg.at || 0) > 10000) return;
    if (!linkTargetValid(msg.t)) return;
    runLinkHere(msg.t);
    window.focus();
});

// Opened by another window with a link in the address (?link=...): once the
// page has started, the link; then the address cleaned.
{
    let pending = null;
    try {
        const raw = new URLSearchParams(location.search).get('link');
        // From links.py, another rBrowser window, or typed by any web page
        // (?app= too): only a well formed one, treated as external.
        if (raw) pending = externalLinkTarget(JSON.parse(raw));
    } catch (e) {}
    if (pending && linkTargetValid(pending)) {
        const params = new URLSearchParams(location.search);
        params.delete('link');
        const clean = location.pathname + (params.toString() ? '?' + params : '') + location.hash;
        try { history.replaceState(null, '', clean); } catch (e) {}
        window.addEventListener('load', () => setTimeout(() => runLinkHere(pending), 2500));
    }
}

// Right-click on a link in a client (a chat line, a message): the same
// actions as on a NomadNet page link.
function showClientLinkMenu(anchor, t) {
    if (!linkTargetValid(t)) return;
    if (t.kind === 'lxmf') {
        showLxmfMenu(anchor, t.address, typeof peerLabel === 'function' ? peerLabel(t.address) : '', 'LXMF address',
                     [aspectCheckItem(anchor, t.address, 'lxmf.delivery'), '-']);
        return;
    }
    const hash = t.kind === 'rrc' ? t.address.slice(6, 38).toLowerCase() : t.address.slice(0, 32).toLowerCase();
    const copy = (text, what) => ({ label: `Copy ${what}`, run: () => copyText(text, `Copied:<br><code>${escapeHtml(text)}</code>`) });
    if (t.kind === 'rrc') {
        const on = typeof rrcEnabled === 'function' && rrcEnabled();
        openNodeMenu(anchor, 'RRC hub', t.address, [
            { label: on ? 'Open in RRC chat' : 'Open in RRC chat (turn it on in Settings)', disabled: !on,
              run: () => openLinkTarget(t), tip: 'Connects to the hub in rBrowser\'s RRC client' },
            aspectCheckItem(anchor, hash, 'rrc.hub'),
            '-',
            copy(t.address, 'link'),
            copy(hash, 'address'),
            { label: 'Check path', run: () => checkPath(hash, ''), tip: 'The path held to this address now. Nothing is sent' },
        ]);
        return;
    }
    openNodeMenu(anchor, 'NomadNet page', t.address, [
        { label: 'Open', run: () => openLinkTarget(t), tip: 'In a new page tab of rBrowser' },
        aspectCheckItem(anchor, hash, 'nomadnetwork.node'),
        '-',
        copy(t.address, 'address'),
        copy(hash, 'node hash'),
        { label: 'Ping node', run: () => pingNode(hash, ''), tip: 'Is it answering?' },
        { label: 'Check path', run: () => checkPath(hash, ''), tip: 'The path held to this address now. Nothing is sent' },
    ]);
}

// The client's x in its own window closes the window.
function appWindowClose() {
    if (!APP_WINDOW) return false;
    window.close();
    return true;
}

// This page is one client alone: no node list, no tabs; the client opens as
// soon as its tab exists (that is, once its settings say it is on).
if (APP_WINDOW) {
    document.addEventListener('DOMContentLoaded', () => {
        document.body.classList.add('app-window');
        document.title = `${APP_WINDOW_NAMES[APP_WINDOW]} - rBrowser`;
        // The page's own start opens a blank page tab over it: opened again
        // until it stays open for 2 s.
        const started = Date.now();
        let openSince = 0;
        const wait = setInterval(() => {
            const tab = document.getElementById(APP_WINDOW_TABS[APP_WINDOW]);
            if (tab && !tab.hidden) {
                if (tab.classList.contains('active')) {
                    openSince = openSince || Date.now();
                    if (Date.now() - openSince > 2000) clearInterval(wait);
                } else {
                    openSince = 0;
                    APP_WINDOW_OPEN[APP_WINDOW]();
                }
            } else if (Date.now() - started > 15000) {
                clearInterval(wait);
                showNotification(`${APP_WINDOW_NAMES[APP_WINDOW]} is off in Settings`, 'warning', 8000);
            }
        }, 300);
    });
}

// Phones: the clients' top bars show icons, not words (the words took
// too much room); the word stays as the tooltip and for screen readers.
// The bars are re-rendered at will, so a watcher puts the icon in each new
// button; the CSS decides which of the two shows.
const BAR_ICON_PATHS = [
    [/^\+ ?new$|^send message$/, '<path d="M8 3v10M3 8h10"/>'],
    [/^\+ ?contact$/, '<circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 14c.4-2.8 2.2-4.3 4.5-4.3s4.1 1.5 4.5 4.3M12.5 5v5M10 7.5h5"/>'],
    [/^peers$|^who$/, '<circle cx="5.5" cy="5.5" r="2.3"/><circle cx="11" cy="6" r="1.9"/><path d="M1.5 13.5c.4-2.5 2-3.8 4-3.8s3.6 1.3 4 3.8M10 10c2.3-.4 4 .9 4.5 3.2"/>'],
    [/^announce$/, '<path d="M2 6.5v3h2.5L9 13V3L4.5 6.5zM11.5 5.5a3.5 3.5 0 0 1 0 5M13 3.5a6 6 0 0 1 0 9"/>'],
    [/^sync/, '<path d="M13 6.5A5 5 0 0 0 3.6 5M3 9.5A5 5 0 0 0 12.4 11M3.5 2.5V5H6M12.5 13.5V11H10"/>'],
    [/^refresh|^again/, '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5"/>'],
    [/^go (offline|online)/, '<path d="M8 2v6M4.5 4.5a5 5 0 1 0 7 0"/>'],
    [/^autoreply/, '<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6 9h.01M10 9h.01"/>'],
    [/^rooms$/, '<path d="M6 2.5L4.5 13.5M11.5 2.5L10 13.5M2.5 6h11M2 10.5h11"/>'],
    [/menu$/, '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'],
    [/^nick$/, '<path d="M10.5 2.5l3 3L6 13H3v-3z"/>'],
    // A plug pulled out of its socket.
    [/^disconnect$/, '<path d="M8.5 5h2.5a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H8.5zM8.5 6.5H6.5M8.5 9.5H6.5M13 8h1.5M3.5 4.5v7M1.5 6.5h2M1.5 9.5h2"/>'],
    [/^connect$/, '<path d="M6 3v3M10 3v3M4.5 6h7v2.5a3.5 3.5 0 0 1-7 0zM8 12v2"/>'],
    [/^help$/, '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1M8 11.5h.01"/>'],
];

function barIconFor(label) {
    const key = label.trim().toLowerCase();
    const hit = BAR_ICON_PATHS.find(([re]) => re.test(key));
    return hit ? `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${hit[1]}</svg>` : '';
}

function iconizeBar(bar) {
    bar.querySelectorAll('button.msg-bar-btn:not(.msg-settings-btn)').forEach(btn => {
        if (btn.querySelector('.bar-ico')) return;
        const label = btn.textContent.trim();
        if (!label || btn.querySelector('svg')) return;
        const icon = barIconFor(label);
        if (!icon) return;
        if (!btn.title) btn.title = label;
        btn.innerHTML = `<span class="bar-ico">${icon}</span><span class="bar-txt">${btn.innerHTML}</span>`;
        btn.classList.add('bar-iconized');
    });
}

// Text set later on a button (Sync -> Syncing…) replaces the icon: put back.
function watchBarIcons(bar) {
    if (!bar || bar.dataset.iconWatch) return;
    bar.dataset.iconWatch = '1';
    iconizeBar(bar);
    new MutationObserver(() => iconizeBar(bar)).observe(bar, { childList: true, subtree: true });
}

document.addEventListener('DOMContentLoaded', () => {
    // The bars come and go with the clients: looked for every 2 s, cheap.
    setInterval(() => {
        document.querySelectorAll('#messenger-view .msg-bar-main, #rrc-head, #bbs-head, #rmap-view .rmap-bar, #rmap-view .rmap-head')
            .forEach(watchBarIcons);
    }, 2000);
});

// The clients' own lists (LXMF conversations, RRC hubs, BBS servers): a
// button hides them to use the chat full width, remembered per client.
// Phones show list or chat one at a time already: there the CSS ignores it.
const CLIENT_LIST_VIEWS = { lxmf: 'messenger-view', rrc: 'rrc-view', bbs: 'retibbs-view' };
const CLIENT_LIST_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 2.5v11" stroke="currentColor" stroke-width="1.4"/></svg>';

function clientListButton(kind) {
    return `<button class="list-toggle-btn" data-list-kind="${kind}" onclick="toggleClientList('${kind}')" aria-label="Hide or show the list">${CLIENT_LIST_ICON}</button>`;
}

const clientListState = {};     // this page's state; storage only remembers it

function clientListCollapsed(kind) {
    if (!(kind in clientListState)) {
        try { clientListState[kind] = localStorage.getItem(`rbrowser_list_collapsed_${kind}`) === '1'; }
        catch (e) { clientListState[kind] = false; }
    }
    return clientListState[kind];
}

function applyClientList(kind) {
    const view = document.getElementById(CLIENT_LIST_VIEWS[kind]);
    if (!view) return;
    const collapsed = clientListCollapsed(kind);
    view.classList.toggle('list-collapsed', collapsed);
    view.querySelectorAll(`.list-toggle-btn[data-list-kind="${kind}"]`).forEach(btn => {
        btn.title = collapsed ? 'Show the list' : 'Hide the list and use the chat full width';
        btn.classList.toggle('on', collapsed);
    });
}

function toggleClientList(kind) {
    const collapsed = clientListState[kind] = !clientListCollapsed(kind);
    try { localStorage.setItem(`rbrowser_list_collapsed_${kind}`, collapsed ? '1' : '0'); } catch (e) {}
    applyClientList(kind);
}

function toggleSidebar() {
    const collapsed = !document.body.classList.contains('sidebar-collapsed');
    applySidebarState(collapsed);
    try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch (e) {
        // Private mode or storage disabled: the toggle still works, it just
        // will not be remembered.
    }
}

function restoreSidebarState() {
    // The node list always starts open: rBrowser is little use without it,
    // and hiding it is for reading one page full width. Only its width is
    // remembered (the collapsed flag is still written, but no longer read).
    const collapsed = false;
    let width = SIDEBAR_DEFAULT_WIDTH;
    try {
        const stored = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
        if (!isNaN(stored)) width = stored;
    } catch (e) {
        // no storage: defaults are fine
    }
    setSidebarWidth(width, false);
    applySidebarState(collapsed);
    // Measured with the page's font: again once the web fonts are in.
    updateSidebarMinWidth();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(updateSidebarMinWidth);
}

// ─────────────────────────────────────────────────────────────────────────
// Drag the sidebar edge to resize it
//
// Pointer events rather than mouse events, so a touchpad, a pen and a touch
// screen all work with one code path, and setPointerCapture keeps the drag
// alive when the cursor outruns the handle - which it will, because the
// handle is a few pixels wide and the pointer moves faster than layout.
// ─────────────────────────────────────────────────────────────────────────

function initSidebarResizer() {
    const resizer = document.querySelector('.sidebar-resizer');
    const sidebar = document.querySelector('.sidebar');
    if (!resizer || !sidebar) return;

    let dragging = false;

    const onMove = (event) => {
        if (!dragging) return;
        // Width measured from the window edge, not from a delta, so the
        // handle cannot drift away from the pointer over a long drag.
        const width = event.clientX - sidebar.getBoundingClientRect().left;

        // Dragging it below the minimum collapses it rather than leaving a
        // useless sliver - the obvious meaning of dragging it shut.
        if (width < sidebarMinWidth * 0.6) {
            if (!document.body.classList.contains('sidebar-collapsed')) {
                applySidebarState(true);
                try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1'); } catch (e) {}
            }
            return;
        }

        if (document.body.classList.contains('sidebar-collapsed')) {
            applySidebarState(false);
            try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '0'); } catch (e) {}
        }
        setSidebarWidth(width, false);
    };

    const stop = (event) => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('sidebar-resizing');
        try { resizer.releasePointerCapture(event.pointerId); } catch (e) {}
        // Persist once, at the end: writing to localStorage on every
        // pointermove would be hundreds of writes per drag.
        const current = parseInt(
            getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10);
        if (!isNaN(current)) setSidebarWidth(current, true);
    };

    resizer.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        dragging = true;
        document.body.classList.add('sidebar-resizing');
        try { resizer.setPointerCapture(event.pointerId); } catch (e) {}
        event.preventDefault();
    });

    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', stop);
    resizer.addEventListener('pointercancel', stop);

    // Double-click the edge: hide, or bring it back at its last width.
    resizer.addEventListener('dblclick', () => toggleSidebar());
}

// ─────────────────────────────────────────────────────────────────────────
// Page zoom and centring
//
// Both are reader preferences, not properties of the page, so they are
// global, persisted, and applied through CSS custom properties on the root
// element rather than by touching each tab.
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// "More below" hint
//
// The page scrollbar is hidden, so something has to say that the page does
// not end where the window does. A chevron at the bottom centre appears
// only while there is content past the fold, and gets out of the way as
// soon as you reach the end.
// ─────────────────────────────────────────────────────────────────────────

function updateScrollHint(tab) {
    if (!tab) return;
    const area = document.querySelector(`#${tab.id} .browser-area`);
    const hint = document.querySelector(`#${tab.id} .scroll-hint`);
    if (!area || !hint) return;

    // A couple of pixels of slack: sub-pixel layout means scrollTop +
    // clientHeight rarely lands exactly on scrollHeight at the bottom.
    const more = area.scrollHeight - area.clientHeight - area.scrollTop > 4;
    hint.classList.toggle('visible', more);
}

function initScrollHint(tab) {
    const area = document.querySelector(`#${tab.id} .browser-area`);
    const hint = document.querySelector(`#${tab.id} .scroll-hint`);
    if (!area || !hint || area.dataset.hintBound === '1') return;
    area.dataset.hintBound = '1';

    area.addEventListener('scroll', () => updateScrollHint(tab), {passive: true});

    const page = () => {
        area.scrollBy({top: Math.max(100, area.clientHeight - 60), behavior: 'smooth'});
    };
    hint.addEventListener('click', page);
    hint.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); page(); }
    });

    updateScrollHint(tab);
}

// The stored value is the zoom FACTOR, not a position in ZOOM_STEPS.
// It used to be the index, and inserting 40% at the front of the steps
// silently reinterpreted every value already saved: a browser remembering
// "index 5" went from 100% to 90%, and a low index landed on 40%. A factor
// means the same thing no matter how the steps change. New key, so the old
// index is simply ignored rather than misread.
const PAGE_ZOOM_KEY = 'rbrowser_page_zoom_factor';
const CENTER_PAGES_KEY = 'rbrowser_center_pages';

// Light rendering: on a desktop each character of a page is its own cell, so
// ASCII art stays on an exact grid - but a list of 2000 lines is ~90 000
// elements and takes many seconds. Past a size, the page is drawn as plain
// monospace text, as phones always do (same parser, cells off): about ten
// times faster, links and fields all work.
const LIGHT_RENDER_KEY = 'rbrowser_light_render';
const LIGHT_RENDER_CHARS_KEY = 'rbrowser_light_render_chars';
const LIGHT_RENDER_CHOICES = [10000, 20000, 50000, 100000];
const LIGHT_RENDER_DEFAULT = 20000;

function lightRenderingOn() {
    try { return localStorage.getItem(LIGHT_RENDER_KEY) !== 'off'; } catch (e) { return true; }
}

function lightRenderingChars() {
    let n = NaN;
    try { n = Number(localStorage.getItem(LIGHT_RENDER_CHARS_KEY)); } catch (e) {}
    return LIGHT_RENDER_CHOICES.includes(n) ? n : LIGHT_RENDER_DEFAULT;
}

// Fixed steps rather than a free slider: these are the sizes that actually
// land on whole pixels for a 15px base, so the monospace grid stays even.
// A continuous control would let you pick 1.07 and get uneven columns.
const ZOOM_STEPS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.4, 1.6, 1.8, 2.0, 2.5, 3.0];
const ZOOM_DEFAULT_INDEX = 6;        // 1.0, what the label button toggles to
const ZOOM_FIT = -1;                 // not a step: "whatever makes this page fit"


let pageZoomIndex = ZOOM_DEFAULT_INDEX;

// How much the page has to shrink for its widest line to fit.
//
// Measured, not guessed from a column count: the page is briefly switched to
// white-space:pre so nothing wraps, its natural width is read, and the
// wrapping is put back. One forced reflow per page load, which is the only
// way to know how wide the content really is - the source line length does
// not account for markup, and once it has wrapped it is too late to ask.
// Which lines of a rendered page are running prose (safe to wrap) and which
// are layout (art, menus, aligned columns - must keep their shape). Each
// Micron line is a <div> child of .page-content; prose ones get the class
// mu-prose, which the phone stylesheet lets wrap. Returns the line divs.
//
// Prose: several words separated by single spaces, and no box-drawing or
// block characters and no runs of spaces (both mean something is aligned).
// Box drawing, block elements and braille: the characters that draw. Not
// the geometric shapes block - bullets like ▪ ● ■ start ordinary list items.
const BOX_OR_BLOCK = /[─-▟⠀-⣿]/;
// The line divs of a page, looking inside page partials: a partial is a
// block of lines of its own (a chat that refreshes, say), and treating it as
// one line made the whole block one 4000-character "line".
function collectLines(container, out = []) {
    for (const el of container.children) {
        if (el.tagName !== 'DIV') continue;
        if (el.classList.contains('micron-partial')) collectLines(el, out);
        else out.push(el);
    }
    return out;
}

function markProseLines(content) {
    const lines = collectLines(content);
    for (const line of lines) {
        const text = (line.textContent || '').replace(/\s+$/, '');
        const trimmed = text.trim();
        // A divider: one character repeated (a run of - or ━ drawn wider
        // than any screen). It is clipped at the edge of the page instead of
        // setting its width - and on a desktop no longer wraps onto a second
        // line either.
        // Also short repeated patterns: =-=-=-, -~-~-, .:.:.: (up to 4).
        const squeezed = trimmed.replace(/ /g, '');
        // Only past 120 columns - wider than any terminal NomadNet runs in.
        // Under that, a line of one repeated character is as likely to be
        // art: a picture drawn in coloured blocks is all █ on every row, and
        // clipping those rows cut the picture.
        const rule = trimmed.length > 120
            && (new Set(squeezed).size === 1 || /^(.{1,4})\1{5,}.{0,4}$/u.test(squeezed));
        const words = trimmed.split(' ').filter(Boolean);
        // Runs of three or more spaces mean alignment; two can be a typo or
        // a habit after a full stop, and chat logs are full of them.
        // One gap of 3+ spaces in a long run of words is a typo or a pause,
        // not columns; tables and art have many.
        const gaps = (trimmed.match(/ {3,}/g) || []).length;
        const prose = !rule
            && words.length >= 6
            && (gaps === 0 || (gaps === 1 && words.length >= 12))
            && !BOX_OR_BLOCK.test(text)
            && !line.querySelector('table, input, textarea, select');
        line.classList.toggle('mu-prose', prose);
        line.classList.toggle('mu-rule', rule);
    }
    return lines;
}

// Width of the widest LAYOUT line at the zoom in force, in px; prose lines
// (see markProseLines) do not count, since on a phone they wrap. The page
// is briefly unwrapped to measure it. Also hands the result to the
// stylesheet as --layout-w: on a phone the page box is that wide (or the
// screen, if wider), so prose wraps inside it while layout keeps its shape.
// It used to be width:max-content, which grew the box to the longest
// paragraph - nothing could wrap, and the page ran off the side.
function measureLayoutWidth(content) {
    // Unwrapped and unconstrained while measuring. setProperty with
    // 'important', because the phone stylesheet sizes this box with
    // !important and a plain inline style would lose - the measurement then
    // ran at the previous width and fed on itself.
    const saved = {
        ws: [content.style.getPropertyValue('white-space'), content.style.getPropertyPriority('white-space')],
        w: [content.style.getPropertyValue('width'), content.style.getPropertyPriority('width')],
    };
    content.style.removeProperty('--layout-w');
    content.style.setProperty('white-space', 'pre', 'important');
    content.style.setProperty('width', 'max-content', 'important');

    const lines = markProseLines(content);
    // For the centred width on a desktop (stylesheet): a page with prose
    // gets a minimum width, so its text has room to wrap.
    content.toggleAttribute('data-has-prose', lines.some(l => l.classList.contains('mu-prose')));
    let natural = 0;
    if (lines.length) {
        // The extent of the TEXT on each line, from its text nodes. Measuring
        // the line element itself would count blocks that simply stretch to
        // the box (a centred line is one), not what is drawn.
        const range = document.createRange();
        for (const line of lines) {
            if (isFlowLine(line)) continue;
            // Images take the width they are given (max 100%): measured in a
            // max-content box, a 70% image came out at its full 960px and
            // set the page that wide, then grew to 70% of it.
            if (line.classList.contains('micron-image')) continue;
            natural = Math.max(natural, lineExtent(line, range));
        }
        natural = Math.ceil(natural);
    } else {
        natural = content.scrollWidth;
    }

    content.style.setProperty('white-space', saved.ws[0], saved.ws[1]);
    content.style.setProperty('width', saved.w[0], saved.w[1]);
    if (!saved.ws[0]) content.style.removeProperty('white-space');
    if (!saved.w[0]) content.style.removeProperty('width');
    if (lines.length) content.style.setProperty('--layout-w', natural + 'px');
    return natural;
}

// Lines that wrap instead of setting the page width: prose, dividers, and a
// lone layout line that Fit let wrap (mu-wrap, see fitLayoutBlocks).
function isFlowLine(line) {
    return line.classList.contains('mu-prose') || line.classList.contains('mu-rule')
        || line.classList.contains('mu-wrap');
}

// Drawn width of one line, in px. From where the line's text starts (leading
// spaces count: they are indentation) to its last VISIBLE character.
// Trailing spaces do not count - pages pad art lines with them, and a line
// of 76 drawn characters padded to 190 made the page 2.5 times wider than
// anything on it. The text nodes are measured, not the line element: a
// centred line is a block that simply stretches to the box.
// Only the first and the last drawn text node are measured: a page painted
// in coloured characters has one text node per cell (419,000 on one 1.4 MB
// page), and asking each for its box took half a minute.
function lineExtent(line, range = document.createRange()) {
    const nodes = [];
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) if (node.nodeValue) nodes.push(node);
    let left = Infinity, right = -Infinity;
    for (const n of nodes) {
        range.selectNodeContents(n);
        const whole = range.getBoundingClientRect();
        if (whole.width === 0 && whole.height === 0) continue;   // not drawn
        left = whole.left;
        break;
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        // U+2800, the blank braille cell, pads braille art the way spaces
        // pad block art (partisans: lines of 163 columns, most of it blank).
        const end = n.nodeValue.replace(/[\s⠀]+$/, '').length;
        if (end === 0) continue;                 // spaces only
        range.setStart(n, 0);
        range.setEnd(n, end);
        const r = range.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        right = r.right;
        break;
    }
    // Inline images have no text node; count their boxes. Form fields
    // do not count: they do not scale with the zoom, so a 48-column
    // field would hold the whole page at the floor. On a phone they
    // are capped at the page width instead (stylesheet).
    line.querySelectorAll('img').forEach(el => {
        const r = el.getBoundingClientRect();
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
    });
    return right > left ? right - left : 0;
}

// Fit, block by block. Shrinking the whole page until its widest line fit
// made a page with one wide logo unreadable on a phone (rmap: a 92-column
// header and a 158-column menu took every line down to 6px), while pages of
// plain text stayed full size. Now the text stays at 100% and only what
// does not fit gives way:
//  - a lone layout line with nothing drawn in it (a menu, a row of
//    counters) wraps, as NomadNet wraps it at the terminal edge;
//  - a block of layout lines (art, a table) wider than the screen shrinks
//    by itself, just enough to fit: a wide logo no longer takes the table
//    under it down to its size.
// Returns what it did, for the zoom button's tooltip.
const FIT_BLOCK_MIN_PX = 5;
// Drawings (box, block or braille characters) may go further: they are
// looked at, not read, and a 150-column braille picture (partisans) needs
// about 4px on a phone. Below the browser's minimum font size the scale in
// setSize does it. Text tables stay at 5px and pan instead.
const FIT_ART_MIN_PX = 2;
const FIT_SCALE_PROPS = ['transform', 'transform-origin', 'width', 'margin-bottom'];
function unshrinkLine(el) {
    el.classList.remove('mu-shrunk');
    el.style.removeProperty('font-size');
    el.style.removeProperty('line-height');
    FIT_SCALE_PROPS.forEach(p => el.style.removeProperty(p));
    delete el.dataset.fitPx;
    delete el.dataset.fitSize;
}
function clearLayoutFit(tab) {
    const content = tab && document.querySelector(`#${tab.id} .page-content`);
    if (!content) return;
    content.querySelectorAll('.mu-wrap, .mu-shrunk, .mu-clip').forEach(el => {
        el.classList.remove('mu-wrap', 'mu-clip');
        unshrinkLine(el);
    });
}

// What the browser does to font sizes on its own, measured: a text zoom
// (Android's font size, 104% on one phone: 15px drawn at 15.6px) and a
// minimum size (8px in Android's WebView: art set to 5px was drawn at 8.32px
// and stayed 449px wide on a 392px screen). Sizes in the fit are the ones
// written in CSS; below the minimum the rest is done with a scale, which
// the minimum does not touch.
function fontSizeLimits(container) {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;font-size:100px';
    container.appendChild(probe);
    const zoom = (parseFloat(getComputedStyle(probe).fontSize) || 100) / 100;
    probe.style.fontSize = '1px';
    const min = (parseFloat(getComputedStyle(probe).fontSize) || 1) / zoom;
    probe.remove();
    return { zoom, min: Math.max(1, Math.ceil(min - 0.01)) };
}
function fitLayoutBlocks(tab) {
    const area = document.querySelector(`#${tab.id} .browser-area`);
    const content = document.querySelector(`#${tab.id} .page-content`);
    const done = { wrapped: 0, shrunk: 0, px: null };
    if (!area || !content) return done;

    // Start over from the page unwrapped. Sizes already set are kept and
    // measured as they are: changing a font size makes the browser shape
    // every glyph again, 14 s on a page of 419,000 coloured cells, and a
    // refit (a partial reloading, the phone turning) mostly lands on the
    // same sizes anyway.
    content.querySelectorAll('.mu-wrap, .mu-clip').forEach(el => el.classList.remove('mu-wrap', 'mu-clip'));
    const cs = getComputedStyle(content);
    const available = area.clientWidth
        - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (available <= 0) return done;

    const saved = [content.style.getPropertyValue('white-space'), content.style.getPropertyPriority('white-space'),
                   content.style.getPropertyValue('width'), content.style.getPropertyPriority('width')];
    content.style.setProperty('white-space', 'pre', 'important');
    content.style.setProperty('width', 'max-content', 'important');
    markProseLines(content);
    // Where text can start; a line inside a section is indented from there
    // and has that much less room.
    const inner = content.getBoundingClientRect().left + content.clientLeft
        + (parseFloat(cs.paddingLeft) || 0);

    // Consecutive layout lines with something on them. A blank line (a <br>,
    // not a line div), a divider, prose or the edge of a partial ends the
    // block.
    const blocks = [];
    let block = null;
    const range = document.createRange();
    const limits = fontSizeLimits(content);
    // The page size as written in CSS (the computed one includes the
    // browser's text zoom).
    const base = (parseFloat(cs.fontSize) / limits.zoom) || MICRON_BASE_FONT;
    // A line's width at the page size, from its width at the size it has
    // now (monospace cells scale with the font). fitSize is the size the
    // fit chose, which can be below the browser's minimum (then drawn with
    // a scale, see setSize).
    const sizeOf = line => parseFloat(line.dataset.fitSize) || parseFloat(line.style.fontSize) || base;
    const walk = container => {
        for (const el of container.children) {
            if (el.tagName !== 'DIV') { block = null; continue; }
            if (el.classList.contains('micron-partial')) { block = null; walk(el); block = null; continue; }
            // An image fits on its own (max-width 100%). Sized in % of its
            // line, shrinking the line made it grow: the scale widens the
            // line, the image followed, and the rmap page went 1059px wide.
            if (el.classList.contains('micron-image')) { block = null; continue; }
            const flow = el.classList.contains('mu-prose') || el.classList.contains('mu-rule');
            if (flow || !el.textContent.trim() && !el.querySelector('img')) { block = null; continue; }
            const width = lineExtent(el, range) * base / sizeOf(el);
            const room = available - Math.max(0, el.getBoundingClientRect().left - inner);
            // A text line too wide even at the smallest size (a 200-character
            // pear:// link under "Keet P2P Room:") wraps on its own: shrinking
            // its block could not fit it, and the page ran off the phone.
            if (width * FIT_BLOCK_MIN_PX / base > room && !BOX_OR_BLOCK.test(el.textContent)
                    && !el.querySelector('img, table, input, textarea, select')) {
                el.classList.add('mu-wrap');
                done.wrapped++;
                block = null;
                continue;
            }
            if (!block) blocks.push(block = { lines: [], width: 0, room: available });
            block.lines.push(el);
            block.width = Math.max(block.width, width);
            block.room = Math.min(block.room, room);
        }
    };
    walk(content);
    blocks.forEach(b => {
        b.min = b.lines.some(l => BOX_OR_BLOCK.test(l.textContent)) ? FIT_ART_MIN_PX : FIT_BLOCK_MIN_PX;
    });

    content.style.setProperty('white-space', saved[0], saved[1]);
    content.style.setProperty('width', saved[2], saved[3]);
    if (!saved[0]) content.style.removeProperty('white-space');
    if (!saved[2]) content.style.removeProperty('width');

    // Under the browser's minimum font size the font stays at the minimum
    // and a scale does the rest: the line is drawn at px/font of its size,
    // made 1/scale as wide first so centring still works, and the space the
    // unscaled row would leave below it is taken back with a negative margin.
    const setSize = (b, px) => {
        const font = Math.max(px, limits.min);
        const scale = px / font;
        const lh = Math.max(1, Math.floor(font * MICRON_CELL_RATIO));
        for (const line of b.lines) {
            line.classList.add('mu-shrunk');
            line.dataset.fitSize = String(px);
            line.style.setProperty('font-size', font + 'px');
            line.style.setProperty('line-height', lh + 'px');
            if (scale < 1) {
                line.style.setProperty('transform', `scale(${scale})`);
                line.style.setProperty('transform-origin', '0 0');
                line.style.setProperty('width', (100 / scale) + '%');
            } else {
                FIT_SCALE_PROPS.forEach(p => line.style.removeProperty(p));
            }
        }
        if (scale < 1) {
            // One layout read for the block, after all its writes.
            const h = b.lines[0].offsetHeight;
            const back = -(h * (1 - scale)) + 'px';
            b.lines.forEach(line => line.style.setProperty('margin-bottom', back));
        }
    };
    const shrink = [];
    const keep = new Set();
    for (const b of blocks) {
        if (b.width <= b.room) continue;
        const only = b.lines[0];
        if (b.lines.length === 1 && !BOX_OR_BLOCK.test(only.textContent)
                && !only.querySelector('img, table, input, textarea, select')) {
            only.classList.add('mu-wrap');
            b.wrapped = true;
            done.wrapped++;
            continue;
        }
        const px = Math.max(b.min, Math.floor(base * b.room / b.width + 1e-6));
        // Same target as the last fit (the check below may have taken it a
        // pixel or two lower then): leave it as it is.
        const now = sizeOf(b.lines[0]);
        b.changed = !b.lines.every(l => l.classList.contains('mu-shrunk')
                                        && l.dataset.fitPx === String(px) && sizeOf(l) === now);
        b.px = b.changed ? px : now;
        if (b.changed) {
            setSize(b, b.px);
            b.lines.forEach(l => { l.dataset.fitPx = String(px); });
        }
        b.lines.forEach(l => keep.add(l));
        shrink.push(b);
    }
    // Shrunk by an earlier fit and fitting at full size now (a wider screen):
    // back to the page size.
    content.querySelectorAll('.mu-shrunk').forEach(line => {
        if (!keep.has(line)) unshrinkLine(line);
    });
    // Rounded down, then checked on screen a pixel at a time: a phone can
    // draw wider than predicted (its own text scaling, a fallback font).
    // Every block is checked in one pass and then resized, so each round
    // costs one layout, not one per line.
    let pending = shrink.filter(b => b.changed);
    for (let round = 0; round < 6 && pending.length; round++) {
        pending = pending.filter(b => b.px > b.min
            && b.lines.some(l => lineExtent(l, range) > b.room + 0.5));
        pending.forEach(b => setSize(b, --b.px));
    }

    // Safety net, from what is drawn on screen. A phone can draw text wider
    // than the measurement above predicts (system text size, the browser's
    // own font scaling), and a line predicted to fit at 100% was never
    // checked again: on a phone the page scrolled sideways, on a desktop it
    // fitted. Every block still past the edge now gives way by the ratio
    // measured on screen - a lone line wraps, art shrinks. Measured in one
    // pass, then resized (see the clip step below).
    for (let round = 0; round < 4; round++) {
        const over = [];
        for (const b of blocks) {
            if (b.wrapped) continue;
            let worst = 1;
            for (const l of b.lines) {
                if (l.querySelector('input, textarea, select, table')) continue;
                const room = available - Math.max(0, l.getBoundingClientRect().left - inner);
                const drawn = lineExtent(l, range);
                if (drawn > room + 0.5) worst = Math.min(worst, room / drawn);
            }
            if (worst < 1) over.push([b, worst]);
        }
        if (!over.length) break;
        for (const [b, ratio] of over) {
            const only = b.lines[0];
            if (b.lines.length === 1 && !BOX_OR_BLOCK.test(only.textContent)
                    && !only.querySelector('img')) {
                only.classList.add('mu-wrap');
                b.wrapped = true;
                done.wrapped++;
                continue;
            }
            const now = sizeOf(only);
            if (now <= b.min) continue;
            const px = Math.max(b.min, Math.min(now - 1, Math.floor(now * ratio + 1e-6)));
            b.px = px;
            setSize(b, px);
            b.lines.forEach(l => { l.dataset.fitPx = String(px); });
            if (!shrink.includes(b)) shrink.push(b);
        }
    }
    for (const b of shrink) {
        done.shrunk += b.lines.length;
        done.px = done.px === null ? b.px : Math.min(done.px, b.px);
    }

    // What is left past the edge on a line whose drawn part fits is only
    // spaces: art padded to 190 columns, blank lines of 99 spaces. Invisible,
    // but it made the phone page scroll sideways. Clipped (mu-clip); a line
    // still too wide at the smallest size keeps its overflow and pans.
    // All measured first, then all marked: adding a class between two
    // measurements forces a fresh layout of the whole page each time, and on
    // a chat of a few thousand lines that froze the browser.
    const clip = collectLines(content).filter(line => {
        if (line.querySelector('img, table, input, textarea, select')) return false;
        const indent = Math.max(0, line.getBoundingClientRect().left - inner);
        return lineExtent(line, range) <= available - indent + 0.5;
    });
    clip.forEach(line => line.classList.add('mu-clip'));
    return done;
}

// After a zoom change or a page render: the layout width has to follow.
function updateLayoutWidth(tab) {
    const content = tab && document.querySelector(`#${tab.id} .page-content`);
    if (!content) return;
    // The measurement shortens the page for a moment; keep the scroll
    // position (see refitPageZoom).
    const area = content.closest('.browser-area');
    const top = area ? area.scrollTop : 0;
    measureLayoutWidth(content);
    if (area && area.scrollTop !== top) area.scrollTop = top;
}

// Does any layout line (not prose, not a divider) run past the edge of the
// page, or wrap onto a second row? Read from the real layout on screen.
function layoutOverflows(tab) {
    const area = document.querySelector(`#${tab.id} .browser-area`);
    const content = document.querySelector(`#${tab.id} .page-content`);
    if (!area || !content) return false;
    if (area.scrollWidth > area.clientWidth + 1) return true;
    const lineHeight = parseFloat(getComputedStyle(content).lineHeight) || 0;
    if (!lineHeight) return false;
    for (const line of collectLines(content)) {
        if (isFlowLine(line)) continue;
        if (!line.textContent.trim() || line.querySelector('img, input, textarea, select, table, hr')) continue;
        if (line.getBoundingClientRect().height > lineHeight * 1.8) return true;
    }
    return false;
}

// Cell geometry, aimed at the shape NomadNet actually draws.
//
// A terminal cell is the glyph box: FULL BLOCK fills it, so artwork tiles
// with no gaps however tall the cell is. A browser glyph is only as tall as
// its own outline, and line-height adds leading the glyph cannot cover - a
// transparent stripe through every row of artwork. Those were the
// scanlines. So the row must never be taller than the block glyph draws.
//
// But it need not be as tall as the block glyph CAN be: anything up to that
// height is gap-free, which leaves room to pick the height that reproduces
// NomadNet's cell shape rather than whatever the font happens to allow.
//
//     line-height = min(block glyph height, advance / target aspect)
//
// Measured from the font files (U+2588 bounding box over units per em):
//
//                   advance   block    aspect at max   can hit 0.481?
//   Cascadia Mono    0.586    1.321       0.444        yes, at 1.218
//   Consolas         0.550    1.171       0.470        yes, at 1.143
//   Courier New      0.600    1.133       0.530        no, caps at 0.530
//
// The target comes from measuring the same page rendered by both: NomadNet
// 948x538 against rBrowser 1070x487 with a known 0.600 cell, which puts
// NomadNet's cell aspect at 0.481.
const MICRON_TARGET_ASPECT = 0.481;

// Cascadia Mono ships with rBrowser, so everyone gets the same cells
// whatever is installed. The rest are what a system is likely to have if
// the bundled font fails to load for some reason.
const MICRON_FONT_PREFERENCE = [
    "Cascadia Mono", "Consolas", "Menlo", "DejaVu Sans Mono",
    "Liberation Mono", "Noto Sans Mono", "Ubuntu Mono", "Courier New",
];

const MICRON_RATIO_MIN = 1.0;
const MICRON_RATIO_MAX = 1.6;

let MICRON_CELL_RATIO = MICRON_RATIO_MIN;
const MICRON_BASE_FONT = 15;

// Measure the font that actually resolved, rather than trusting a table:
// rBrowser runs on machines whose fonts we have never seen.
// actualBoundingBoxAscent/Descent give the glyph's ink extent, which is the
// number that matters - the em box and the declared ascent both lie about
// where the paint ends.
function measureCellRatio(family) {
    try {
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx) return null;
        const probe = 100;
        ctx.font = `${probe}px "${family}", monospace`;

        const advance = ctx.measureText('0').width / probe;
        const block = ctx.measureText('\u2588');
        if (!advance || !block || block.actualBoundingBoxAscent === undefined) return null;

        const blockHeight = (block.actualBoundingBoxAscent + block.actualBoundingBoxDescent) / probe;
        if (!(blockHeight > 0)) return null;

        // If the font has no block glyph the browser substitutes one from
        // elsewhere, and the giveaway is that it is not cell width.
        if (Math.abs(block.width / probe - advance) / advance > 0.05) return null;

        // As tall as NomadNet's cell, but never taller than the glyph.
        return Math.min(blockHeight, advance / MICRON_TARGET_ASPECT);
    } catch (e) {
        return null;
    }
}

function fontAvailable(family) {
    try {
        return !!(document.fonts && document.fonts.check(`16px "${family}"`));
    } catch (e) {
        return false;
    }
}

// The page font is forced from here because the global "*" rule in
// style.css sets font-family with !important, which a plain rule on
// .page-content cannot beat - that is why the page rendered in Courier New
// for so long even though it asked for something else.
function chooseMicronFont() {
    let chosen = null;
    for (const family of MICRON_FONT_PREFERENCE) {
        if (fontAvailable(family)) { chosen = family; break; }
    }

    const family = chosen || 'monospace';
    document.documentElement.style.setProperty(
        '--micron-font', chosen ? `"${chosen}", monospace` : 'monospace');

    const measured = measureCellRatio(family);
    MICRON_CELL_RATIO = measured === null
        ? MICRON_RATIO_MIN
        : Math.max(MICRON_RATIO_MIN, Math.min(MICRON_RATIO_MAX, measured));
}

// The bundled font has to be loaded before it can be measured or even
// detected: document.fonts.check() reports false for a face the browser
// has not fetched yet.
function initMicronFont() {
    const done = () => { chooseMicronFont(); applyPageZoom(); };
    try {
        if (document.fonts && document.fonts.load) {
            Promise.all([
                document.fonts.load('15px "Cascadia Mono"'),
                document.fonts.load('bold 15px "Cascadia Mono"'),
            ]).then(done).catch(done);
            return;
        }
    } catch (e) {
        // fall through
    }
    done();
}

function applyCellMetrics(factor, roundDown = false) {
    const root = document.documentElement;
    // Fit rounds DOWN: rounding to nearest could land a pixel above what fits
    // and push the widest line past the edge.
    const exact = MICRON_BASE_FONT * factor;
    const fontPx = Math.max(6, roundDown ? Math.floor(exact + 1e-6) : Math.round(exact));
    // Rounded DOWN, never to nearest. The row must not exceed the height
    // the block glyph actually draws: at 15px and a ratio of 1.17 the glyph
    // is 17.56px tall, and rounding to 18 would leave 0.44px of every row
    // uncovered - the scanline back again, from a rounding decision.
    const linePx = Math.max(1, Math.floor(fontPx * MICRON_CELL_RATIO));
    root.style.setProperty('--micron-fs', fontPx + 'px');
    root.style.setProperty('--micron-lh', linePx + 'px');
}

function applyPageZoom() {
    // Fit keeps the text at 100% and fits the page block by block
    // (fitLayoutBlocks); a chosen percentage applies to everything.
    const fit = pageZoomIndex === ZOOM_FIT;
    const factor = fit ? 1 : ZOOM_STEPS[pageZoomIndex];
    const label = fit ? 'Fit' : Math.round(factor * 100) + '%';
    const tab = getActiveTab();

    document.documentElement.style.setProperty('--page-zoom', String(factor));
    applyCellMetrics(factor);

    let fitInfo = '';
    if (fit && tab) {
        const done = fitLayoutBlocks(tab);
        const overflows = layoutOverflows(tab);
        fitInfo = 'Fit: text at 100%'
            + (done.wrapped ? `, ${done.wrapped} long ${done.wrapped === 1 ? 'line' : 'lines'} wrapped` : '')
            + (done.shrunk ? `, ${done.shrunk} lines of art shrunk to fit (smallest ${done.px}px)` : '')
            + (overflows ? ' - still too wide at the smallest size' : '')
            + ' - click for 100%';
    } else if (tab) {
        clearLayoutFit(tab);
    }
    updateLayoutWidth(tab);
    document.querySelectorAll('.zoom-level').forEach(el => {
        if (el.textContent !== label) el.textContent = label;
        el.title = pageZoomIndex === ZOOM_FIT
            ? fitInfo
            : 'Current text size - click to fit the page to the window';
    });
    // Grey out the end stops so it is obvious there is nothing further.
    document.querySelectorAll('.zoom-out').forEach(
        b => b.disabled = pageZoomIndex === 0);
    document.querySelectorAll('.zoom-in').forEach(
        b => b.disabled = pageZoomIndex === ZOOM_STEPS.length - 1);
}

// Re-fit after a page loads or the window changes shape. Only does anything
// while the zoom is set to fit; a chosen percentage is left alone.
// keepTop: the scroll position to keep, when the caller read it before the
// page changed (a partial reloading, see hydrateMicronPartials).
function refitPageZoom(keepTop) {
    // Never while text is selected. Fitting resizes the page for a moment
    // to measure it; on a phone that moved the selection, Chrome scrolled to
    // keep it in view, its toolbar showed or hid, the window resized, and
    // the resize fitted again - round and round until the whole browser
    // froze. Wait until the selection is gone.
    if (textIsSelected()) {
        refitPageZoom.pending = true;
        return;
    }
    // Measuring unwraps the page for a moment, so it gets shorter, and the
    // browser pulls the scroll position up to the new end - where it stayed.
    // Firefox fits again whenever a font finishes loading (the bold face,
    // once bold text scrolls into view), so a page read halfway down jumped
    // back towards the top now and then. Put the reader back where they were.
    //
    // Better still, the page is held at its height while it is measured, so
    // it never gets shorter and the browser never moves the scroll at all.
    // Putting it back was not enough on a phone: rmap's animated header is a
    // partial reloaded every second, each reload fitted the page again, and
    // setting scrollTop stopped a finger scroll mid-swipe - the page jerked,
    // or moved on its own, once a second.
    const tab = getActiveTab();
    const area = tab && document.querySelector(`#${tab.id} .browser-area`);
    const content = area && area.querySelector('.page-content');
    const top = typeof keepTop === 'number' ? keepTop : (area ? area.scrollTop : 0);
    const left = area ? area.scrollLeft : 0;
    const heldMin = content ? [content.style.getPropertyValue('min-height'), content.style.getPropertyPriority('min-height')] : null;
    if (content) content.style.setProperty('min-height', content.offsetHeight + 'px', 'important');
    try {
        if (pageZoomIndex === ZOOM_FIT) applyPageZoom();
        else updateLayoutWidth(tab);
    } finally {
        if (content) {
            if (heldMin[0]) content.style.setProperty('min-height', heldMin[0], heldMin[1]);
            else content.style.removeProperty('min-height');
        }
    }
    if (area && (area.scrollTop !== top || area.scrollLeft !== left)) {
        area.scrollTop = top;
        area.scrollLeft = left;
    }
}

function textIsSelected() {
    const sel = window.getSelection && window.getSelection();
    return !!(sel && sel.rangeCount && !sel.isCollapsed);
}

// Full screen page view: only the page, under a one line bar with the
// page's title, its address and a button to leave. The browser around it
// (node list, tabs, address bar, buttons) is hidden by CSS on
// body.page-fullscreen; where the browser allows it the window goes truly
// full screen as well, so on a phone the system bars go too. Same on
// desktop and mobile.
function togglePageFullscreen(on) {
    const want = on === undefined ? !document.body.classList.contains('page-fullscreen') : !!on;
    document.body.classList.toggle('page-fullscreen', want);
    const native = document.fullscreenElement;
    if (want) {
        updateFullscreenBar();
        const root = document.documentElement;
        if (!native && root.requestFullscreen) {
            root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
        }
    } else if (native && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
    }
    // The page has a new width: fit it again.
    requestAnimationFrame(() => refitPageZoom());
}

function updateFullscreenBar() {
    if (!document.body.classList.contains('page-fullscreen')) return;
    const bar = document.getElementById('fullscreen-bar');
    const tab = getActiveTab();
    if (!bar) return;
    const url = (tab && (tab.currentUrl || tab.url)) || '';
    const pageName = url.includes(':') ? url.slice(url.indexOf(':') + 1) : '';
    bar.querySelector('.fullscreen-title').textContent =
        (tab && tab.title && tab.title !== 'New Tab') ? tab.title : (pageName || 'rBrowser');
    bar.querySelector('.fullscreen-address').textContent = url;
}

// Esc in true full screen is taken by the browser itself, which leaves full
// screen; follow it out of the page view too rather than leave the page
// alone on screen with the browser half hidden.
document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('page-fullscreen')) {
        togglePageFullscreen(false);
    }
});

// Where there was no true full screen (iPhone, or refused), Esc still leaves.
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !e.defaultPrevented
            && document.body.classList.contains('page-fullscreen')) {
        togglePageFullscreen(false);
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const address = document.querySelector('#fullscreen-bar .fullscreen-address');
    if (address) address.addEventListener('click', () => {
        if (address.textContent) copyText(address.textContent, 'Address copied');
    });
});

document.addEventListener('selectionchange', () => {
    if (refitPageZoom.pending && !textIsSelected()) {
        refitPageZoom.pending = false;
        requestAnimationFrame(() => refitPageZoom());
    }
});

// The first fit of a page can run before the page font has loaded, with a
// wider fallback in its place, and settle on a width that is then too big.
// So fit again once the fonts are ready, and once more a frame after any
// fit triggered by a page load.
if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => refitPageZoom());
    document.fonts.addEventListener && document.fonts.addEventListener('loadingdone', () => refitPageZoom());
}

// Default zoom, one for desktops and one for phones, chosen in Settings >
// Page rendering. The - and + buttons change the zoom for the moment only;
// every start uses these. (They used to overwrite the one saved default.)
const ZOOM_DESKTOP_KEY = 'rbrowser_zoom_desktop';
const ZOOM_MOBILE_KEY = 'rbrowser_zoom_mobile';

function isMobileWidth() {
    return window.innerWidth < 768;
}

// 'fit' or a factor string, as stored.
function getZoomDefault(kind) {
    try {
        const v = localStorage.getItem(kind === 'mobile' ? ZOOM_MOBILE_KEY : ZOOM_DESKTOP_KEY);
        if (v) return v;
        // The single default of earlier versions becomes the desktop one.
        if (kind !== 'mobile') {
            const old = localStorage.getItem(PAGE_ZOOM_KEY);
            if (old) return old;
        }
    } catch (e) {}
    return kind === 'mobile' ? 'fit' : '1';
}

function setZoomDefault(kind, value) {
    try {
        localStorage.setItem(kind === 'mobile' ? ZOOM_MOBILE_KEY : ZOOM_DESKTOP_KEY, value);
    } catch (e) {}
}

function zoomIndexFor(value) {
    if (value === 'fit') return ZOOM_FIT;
    const idx = ZOOM_STEPS.indexOf(parseFloat(value));
    return idx >= 0 ? idx : ZOOM_DEFAULT_INDEX;
}

function zoomValueFor(index) {
    return index === ZOOM_FIT ? 'fit' : String(ZOOM_STEPS[index]);
}

function changePageZoom(direction) {
    let next;
    if (pageZoomIndex === ZOOM_FIT) {
        // Stepping out of fit starts from whatever fit had settled on, so
        // the first press is a small change rather than a jump to 100%.
        const current = parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--page-zoom')) || 1;
        let nearest = 0;
        for (let i = 0; i < ZOOM_STEPS.length; i++) {
            if (Math.abs(ZOOM_STEPS[i] - current) < Math.abs(ZOOM_STEPS[nearest] - current)) nearest = i;
        }
        next = nearest + direction;
    } else {
        next = pageZoomIndex + direction;
    }
    if (next < 0 || next >= ZOOM_STEPS.length) return;
    pageZoomIndex = next;
    applyPageZoom();
}

// The percentage label toggles between fit and 100%.
function resetPageZoom() {
    pageZoomIndex = (pageZoomIndex === ZOOM_FIT) ? ZOOM_DEFAULT_INDEX : ZOOM_FIT;
    applyPageZoom();
}

function applyCenterPages(centered) {
    document.body.classList.toggle('center-pages', centered);
    document.querySelectorAll('.center-toggle').forEach(btn => {
        btn.classList.toggle('active', centered);
        btn.title = centered
            ? 'Pages are centred - click to align them to the left edge'
            : 'Center all pages: a page narrower than the window sits in the '
              + 'middle instead of against the left edge';
    });
}

function toggleCenterPages() {
    const centered = !document.body.classList.contains('center-pages');
    applyCenterPages(centered);
    try { localStorage.setItem(CENTER_PAGES_KEY, centered ? '1' : '0'); } catch (e) {}
}

function restoreViewPreferences() {
    let centered = false;
    try {
        centered = localStorage.getItem(CENTER_PAGES_KEY) === '1';
    } catch (e) {
        // no storage: defaults
    }

    // The default for this kind of screen (Settings > Page rendering).
    pageZoomIndex = zoomIndexFor(getZoomDefault(isMobileWidth() ? 'mobile' : 'desktop'));

    applyPageZoom();
    applyCenterPages(centered);
}

// Ctrl +/-/0 drive the page zoom instead of the browser's own, which would
// scale the whole interface - sidebar, tabs and all - rather than the page
// being read.
function handleZoomShortcut(event) {
    if (!event.ctrlKey && !event.metaKey) return;
    if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        changePageZoom(1);
    } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        changePageZoom(-1);
    } else if (event.key === '0') {
        event.preventDefault();
        resetPageZoom();
    }
}

// Dynamic sidebar resizing
function adjustSidebarWidth() {
    const screenWidth = window.innerWidth;
    const sidebar = document.querySelector('.sidebar');
    const content = document.querySelector('.content');
    
    if (!sidebar || !content) return;
    
    // Don't adjust on mobile
    if (isMobileDevice() || screenWidth <= 767) return;
    
    let sidebarWidth = 320; // default
    
    if (screenWidth >= 1920) {
        sidebarWidth = 400;
    } else if (screenWidth >= 1440) {
        sidebarWidth = 320;
    } else if (screenWidth >= 1200) {
        sidebarWidth = 280;
    } else if (screenWidth >= 768) {
        sidebarWidth = 260;
    }
    
    sidebar.style.width = sidebarWidth + 'px';
    sidebar.style.minWidth = sidebarWidth + 'px';
    sidebar.style.maxWidth = sidebarWidth + 'px';
    
    const contentWidth = screenWidth - sidebarWidth;
    content.style.width = contentWidth + 'px';
    content.style.minWidth = contentWidth + 'px';
    content.style.maxWidth = contentWidth + 'px';
}

// Enhanced mobile detection including Ubuntu Touch/Morph browser
function isMobileDevice() {
    // Check multiple conditions
    const touchDevice = ('ontouchstart' in window) || 
                       (navigator.maxTouchPoints > 0) || 
                       (navigator.msMaxTouchPoints > 0);
    
    const smallScreen = window.innerWidth <= 768;
    
    // Enhanced user agent detection including Ubuntu Touch
    const mobileUserAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Ubuntu.*Mobile|Mobile.*Ubuntu/i.test(navigator.userAgent);
    
    const noHover = window.matchMedia('(hover: none)').matches;
    
    // Pocophone F1 and similar devices detection
    const pointerCoarse = window.matchMedia('(pointer: coarse)').matches;
    
    // Specific Ubuntu Touch/Morph browser detection
    const isUbuntuTouch = /Ubuntu.*Touch|QtWebEngine/i.test(navigator.userAgent);
    
    // Check for Morph browser specifically
    const isMorphBrowser = navigator.userAgent.includes('QtWebEngine') || 
                          navigator.userAgent.includes('Ubuntu') ||
                          (window.navigator.platform === 'Linux armv7l');
    
    return (touchDevice && smallScreen) || 
           mobileUserAgent || 
           (noHover && pointerCoarse) || 
           isUbuntuTouch || 
           isMorphBrowser;
}

// Create mobile nodes button function
function createMobileNodesButton() {
    
    // Remove any existing button first
    const existingBtn = document.querySelector('.mobile-nodes-btn');
    if (existingBtn) {
        existingBtn.remove();
    }
    
    const nodesBtn = document.createElement('button');
    nodesBtn.className = 'mobile-nodes-btn';
    // On a narrow phone only the icon: the room goes to the page tabs.
    nodesBtn.innerHTML = '📋<span class="mobile-nodes-label"> Nodes</span>';
    nodesBtn.title = 'Nodes';
    nodesBtn.style.display = 'block';
    
    const tabBar = document.querySelector('.tab-bar');

    if (tabBar) {
        // The new-tab control used to be a button at the end of the bar and
        // this sat in front of it; now that it is the first tab, the nodes
        // button goes at the end instead.
        tabBar.appendChild(nodesBtn);
    } else {
        console.error('Could not find tab-bar');
    }
    
    const sidebar = document.querySelector('.sidebar');
    
    nodesBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        sidebar.classList.toggle('mobile-show');
        nodesBtn.innerHTML = sidebar.classList.contains('mobile-show') ? '✕ Close' : '📋 Nodes';
    });
    
    // Close when clicking outside sidebar
    document.addEventListener('click', (e) => {
        if (sidebar.classList.contains('mobile-show') && 
            !sidebar.contains(e.target) && 
            !nodesBtn.contains(e.target)) {
            sidebar.classList.remove('mobile-show');
            // On a narrow phone only the icon: the room goes to the page tabs.
    nodesBtn.innerHTML = '📋<span class="mobile-nodes-label"> Nodes</span>';
    nodesBtn.title = 'Nodes';
        }
    });
    
    // A swipe from the left edge opens the list, a swipe to the left closes
    // it - the same as the Nodes / Close button.
    let swipe = null;
    document.addEventListener('touchstart', e => {
        const t = e.touches[0];
        const open = sidebar.classList.contains('mobile-show');
        swipe = e.touches.length === 1 && (open || t.clientX < 24) ? { x: t.clientX, y: t.clientY, open } : null;
    }, { passive: true });
    document.addEventListener('touchend', e => {
        if (!swipe) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
        const was = swipe;
        swipe = null;
        if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
        if ((!was.open && dx > 0) || (was.open && dx < 0)) {
            // A menu opened by the finger resting before the swipe goes too.
            if (typeof closeNodeMenu === 'function') closeNodeMenu();
            nodesBtn.click();
        }
    }, { passive: true });

    // Close when node clicked
    document.getElementById('node-list').addEventListener('click', (e) => {
        if (e.target.closest('.node-item')) {
            setTimeout(() => {
                sidebar.classList.remove('mobile-show');
                // On a narrow phone only the icon: the room goes to the page tabs.
    nodesBtn.innerHTML = '📋<span class="mobile-nodes-label"> Nodes</span>';
    nodesBtn.title = 'Nodes';
            }, 200);
        }
    });
}

// Apply mobile class if detected
if (isMobileDevice()) {
    document.documentElement.classList.add('mobile-device');
    document.body.classList.add('mobile-device');
}

// Call on load and resize
window.addEventListener('resize', adjustSidebarWidth);

document.addEventListener('DOMContentLoaded', async function() {
    
    // FORCE mobile mode detection - aggressive approach
    const forceMinimalMobile = window.innerWidth <= 768 || 
                               ('ontouchstart' in window && window.innerWidth <= 1024);
    
    if (forceMinimalMobile || isMobileDevice()) {
        document.documentElement.classList.add('mobile-device');
        document.body.classList.add('mobile-device');
        
        // Create mobile nodes button immediately
        setTimeout(() => {
            createMobileNodesButton();
        }, 100);
    }
    
    await initializeMicronParser();
    loadFavorites();
    // Before the first poll: insertionPointFor() reads this select to decide
    // where a newly announced node belongs, so restoring it afterwards would
    // file the first batch of nodes under the wrong order.
    await restoreNodeSort();
    watchNodeListUse();
    trackContentLeft();
    refreshNodeCacheSummary();
    setInterval(refreshNodeCacheSummary, 30000);
    updateNodeListPosition();
    document.getElementById('node-list').addEventListener('click', function(e) {

        // closest(), not e.target: the info button holds an SVG icon, and
        // a click on the icon has the icon as its target.
        // "Hops: N" opens the same panel, so it borrows the card's info button.
        const hopsEl = e.target.closest('.node-hops');
        const infoBtn = e.target.closest('.info-btn')
            || (hopsEl && hopsEl.closest('.node-item').querySelector('.info-btn'));
        if (infoBtn) {
            e.preventDefault();
            e.stopPropagation();

            const hash = infoBtn.getAttribute('data-hash');
            const name = infoBtn.getAttribute('data-name');
            const lastSeen = infoBtn.getAttribute('data-last-seen');
            const dataLength = infoBtn.getAttribute('data-data-length');
            const announceCount = infoBtn.getAttribute('data-announce-count');
            const relativeTime = infoBtn.getAttribute('data-relative-time');

            showNodeInfo(hash, name, lastSeen, dataLength, announceCount, relativeTime);
            return;
        }

        const hideBtn = e.target.closest('.hide-btn');
        if (hideBtn) {
            e.preventDefault();
            e.stopPropagation();
            hideNode(hideBtn.getAttribute('data-hash'), hideBtn.getAttribute('data-name'));
            return;
        }

        const starBtn = e.target.closest('.star-btn');
        if (starBtn) {
            e.preventDefault();
            e.stopPropagation();

            const hash = starBtn.getAttribute('data-hash');
            const name = starBtn.getAttribute('data-name');
            toggleFavorite(hash, name);
            return;
        }

        // Anything that copies to the clipboard must not also open the
        // node. The inline handlers already stop propagation; these are
        // listed again so the rule is visible from the one place that
        // decides whether a click on a row means "browse".
        const copyTargets = '.copy-icon, .operator-icon';

        // The node's menu is on right-click / long press (initNodeCardMenu).
        // The operator's address keeps its menu on a mouse click; a finger
        // tapping a small card hits it by mistake, so a tap opens the node
        // like the rest of the card and a long press gives the menu.
        const operatorText = e.target.closest('.operator-text');
        if (operatorText && lastPointerType !== 'touch' && e.target.closest('.node-item')) {
            e.preventDefault();
            e.stopPropagation();
            showOperatorMenu(operatorText, e.target.closest('.node-item').dataset.hash);
            return;
        }

        const nodeItem = e.target.closest('.node-item');
        if (nodeItem && !e.target.closest('.star-btn') && !e.target.closest('.info-btn')
                     && !e.target.closest('.hide-btn') && !e.target.closest(copyTargets)) {
            const hash = nodeItem.getAttribute('data-hash');
            const name = nodeItem.getAttribute('data-name');
            closeSearchAfterPick();
            browseNode(hash, name);
        }

        if (e.target.classList.contains('fingerprint-btn')) {
            e.preventDefault();
            e.stopPropagation();
            
            const hash = e.target.getAttribute('data-hash');
            const name = e.target.getAttribute('data-name');
            sendFingerprintToNode(hash, name);
            return;
        }

    });

    createNewTab();
    // After the first tab exists, so its toggle button gets the right arrow.
    restoreSidebarState();
    initSidebarResizer();
    restoreViewPreferences();
    initMicronFont();
    document.addEventListener('keydown', handleZoomShortcut);

    // Rotating a phone changes the available width by a factor of two, and
    // a page fitted to portrait is tiny in landscape and vice versa.
    let refitQueued = false;
    let lastViewportWidth = window.innerWidth;
    const onViewportChange = () => {
        // Width only. On a phone the browser's own toolbar showing or hiding
        // changes the HEIGHT on every scroll and tap - refitting on that is
        // what fed the freeze described in refitPageZoom().
        if (window.innerWidth === lastViewportWidth) return;
        lastViewportWidth = window.innerWidth;
        if (refitQueued) return;
        refitQueued = true;
        requestAnimationFrame(() => {
            refitQueued = false;
            refitPageZoom();
            const tab = getActiveTab();
            if (tab) updateScrollHint(tab);
        });
    };
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);

    setInterval(() => {
        updateNodes();
        updateStatus();

        if (statusFetchFailures >= maxStatusFailures) {
            if (Math.random() < 0.2) {  
                setTimeout(() => {
                    statusFetchFailures = Math.max(0, statusFetchFailures - 1); 
                    updateStatus();
                }, 1000); 
            }
        }
    }, 2000);

    updateNodes();
    updateStatus();


    // Enhanced URL Parameter Support - Multiple formats
    function checkAndLoadURLParameter() {
        // Check for ?url= parameter first
        const urlParams = new URLSearchParams(window.location.search);
        const urlParam = urlParams.get('url');
        
        if (urlParam) {
            // A link clicked elsewhere (rbrowser/links.py) comes as
            // nomadnetwork://...; the address bar shows hash:/page/... .
            loadPageFromParameter(normalizeNomadNetUrl(urlParam));
            return;
        }
        
        // Check for path-based hash (e.g., /hash or /hash/page/path)
        const path = window.location.pathname;
        if (path && path !== '/' && path.length > 1) {
            const pathWithoutSlash = path.substring(1); // Remove leading /
            
            // Check if it starts with a valid hash (32 hex characters)
            const hashMatch = pathWithoutSlash.match(/^([a-fA-F0-9]{32})(.*)?$/);
            
            if (hashMatch) {
                const hash = hashMatch[1];
                const pagePath = hashMatch[2]; // Could be empty, /page/about.mu, etc.
                
                let nomadnetUrl;
                if (pagePath && pagePath.length > 0) {
                    // Has a specific page path: /hash/page/about.mu
                    nomadnetUrl = `${hash}:${pagePath}`;
                } else {
                    // Just hash: /hash → default to index.mu
                    nomadnetUrl = `${hash}:/page/index.mu`;
                }
                
                loadPageFromParameter(nomadnetUrl);
                return;
            }
        }
    }

    function loadPageFromParameter(nomadnetUrl) {
        // ?url= and /<hash>/... can be typed by any web page: only a well
        // formed NomadNet address (as externalLinkTarget).
        if (!EXT_PAGE.test(nomadnetUrl) || nomadnetUrl.includes('..')) {
            window.history.replaceState({}, document.title, window.location.origin);
            showNotification('Link not opened: not a well formed NomadNet address', 'warning', 5000);
            return;
        }
        // Wait for the first tab to be created and ready
        setTimeout(() => {
            const tab = getActiveTab();
            if (tab) {
                const addressBar = document.querySelector(`#${tab.id} .address-bar`);
                if (addressBar) {
                    addressBar.value = nomadnetUrl;
                    
                    // Navigate to the URL
                    navigateToUrlInternalTab(nomadnetUrl, true);
                    
                    // Clean the URL bar (remove parameters/path) without page reload
                    window.history.replaceState({}, document.title, window.location.origin);
                }
            }
        }, 500);
    }

    // Call the function after initialization
    checkAndLoadURLParameter();

    // There used to be an orange "please rotate your device to landscape"
    // banner here on every portrait start. Portrait is the better fit now
    // (two-row nav bar, Fit zoom, prose that wraps), so it is gone.
});

// mobile devices support

// Swipe to change tab used to live here. It fired on an 80px horizontal
// movement starting near either screen edge, which is also what selecting
// text or scrolling a wide page looks like on a phone: tabs changed under
// your thumb while you were reading. There is no gesture that reliably
// distinguishes "change tab" from "drag across the page", so the gesture is
// gone and the tab bar is the way to change tabs.

// Auto-reload Functions
// ─────────────────────────────────────────────────────────────────────────
// Settings
//
// Preferences had accumulated with no place to see or change them: zoom and
// centring were only reachable through their own buttons, the image policy
// was hardcoded, and the identity file was created silently on first run
// with no way to find out what was in it.
// ─────────────────────────────────────────────────────────────────────────

const IMAGE_POLICY_KEY = 'rbrowser_image_policy';
const IMAGE_POLICY_DEFAULT = 'auto';   // auto | always | never

function getImagePolicy() {
    try {
        const stored = localStorage.getItem(IMAGE_POLICY_KEY);
        if (stored === 'auto' || stored === 'always' || stored === 'never') return stored;
    } catch (e) {}
    return IMAGE_POLICY_DEFAULT;
}

function setImagePolicy(value) {
    try { localStorage.setItem(IMAGE_POLICY_KEY, value); } catch (e) {}
}

function closeSettings() {
    const modal = document.getElementById('settings-modal');
    if (modal) modal.remove();
    document.removeEventListener('keydown', settingsEscape, true);
}

// ─── Unsaved changes ───
// What Save writes is tracked: a field's value is noted the first time you
// touch it, and it counts as changed while it differs from that. Identity
// and auto-identify, the Links switch, Restore and Unblock apply on their
// own and are left out.
const SETTINGS_IMMEDIATE = '[data-cat="identity"], [data-cat="guest"], #settings-links-section, #hidden-nodes-body, #messenger-blocked, .settings-nav';
const SETTINGS_FIELDS = '.toggle-switch, input, select, textarea';
let settingsBaseline = new Map();

function settingsFieldState(el) {
    if (el.classList.contains('toggle-switch')) return el.classList.contains('active');
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
    return el.value;
}

function trackSettingsChanges(dialog) {
    settingsBaseline = new Map();
    const note = target => {
        const el = target && target.closest && target.closest(SETTINGS_FIELDS);
        // A click on a checkbox's label changes the checkbox inside it.
        const field = el || (target && target.closest && target.closest('label')?.querySelector('input'));
        if (!field || field.closest(SETTINGS_IMMEDIATE) || settingsBaseline.has(field)) return;
        settingsBaseline.set(field, settingsFieldState(field));
    };
    // Before the change: pointerdown comes before a toggle's click, focus
    // before typing or picking.
    dialog.addEventListener('pointerdown', e => note(e.target), true);
    dialog.addEventListener('focusin', e => note(e.target), true);
    dialog.addEventListener('keydown', e => note(e.target), true);
    // After it.
    ['click', 'input', 'change'].forEach(type =>
        dialog.addEventListener(type, () => setTimeout(updateSettingsDirty, 0)));
    document.addEventListener('keydown', settingsEscape, true);
}

function settingsChanges() {
    const cats = new Set();
    for (const [field, before] of settingsBaseline) {
        if (!field.isConnected || settingsFieldState(field) === before) continue;
        const section = field.closest('.auto-reload-setting[data-cat]');
        if (section) cats.add(section.dataset.cat);
    }
    // Host or port different from what is saved: a restart is needed.
    // Only once the fields hold what is saved: empty, they would read as changed.
    const loaded = document.getElementById('setting-host')?.dataset.loaded;
    const server = loaded ? readServerFields() : null;
    const restart = !!(server && 'host' in server);
    if (restart || (server && 'local_name' in server)) cats.add('system');
    return { cats, restart };
}

function updateSettingsDirty() {
    const dialog = document.querySelector('#settings-modal .settings-dialog');
    if (!dialog) return;
    const { cats, restart } = settingsChanges();
    dialog.querySelectorAll('.settings-nav-item').forEach(item => {
        item.classList.toggle('dirty', cats.has(item.dataset.cat));
        item.classList.toggle('needs-restart', restart && item.dataset.cat === 'system');
    });
    const dirtyNote = document.getElementById('settings-dirty-note');
    if (dirtyNote) {
        dirtyNote.hidden = !cats.size;
        dirtyNote.textContent = restart ? 'Unsaved changes - restart needed' : 'Unsaved changes';
    }
    const restartNote = document.getElementById('server-restart-note');
    if (restartNote) restartNote.hidden = !restart;
    dialog.querySelector('.btn-save')?.classList.toggle('pending', cats.size > 0);
}

// Close, x, Escape or a click outside: with changes not saved, ask first.
async function requestCloseSettings() {
    if (!document.getElementById('settings-modal') || document.querySelector('.choice-modal')) return;
    const { cats, restart } = settingsChanges();
    if (!cats.size) { closeSettings(); return; }
    const names = SETTINGS_CATEGORIES.filter(c => cats.has(c[0])).map(c => c[1]);
    const choice = await showChoiceDialog({
        title: 'Save your changes?',
        html: `Changed and not saved: <strong>${names.map(escapeHtml).join(', ')}</strong>.`
            + (restart ? '<div class="choice-warning">The web server change needs a restart of rBrowser:'
                         + ' it is offered after saving.</div>' : ''),
        buttons: [{ label: 'Discard', value: 'discard', danger: true },
                  { label: 'Keep editing', value: null },
                  { label: 'Save', value: 'save', primary: true }],
    });
    if (choice === 'save') saveSettings({ close: true });
    else if (choice === 'discard') closeSettings();
}

function settingsEscape(e) {
    if (e.key !== 'Escape' || !document.getElementById('settings-modal')) return;
    if (document.querySelector('.choice-modal')) return;     // that dialog takes its own Escape
    e.stopPropagation();
    requestCloseSettings();
}

// The kinds of line rBrowser writes to the terminal (rbrowser/console_log.py).
const TERMINAL_LOG_CATEGORIES = [
    ['errors', 'Errors and warnings', 'Anything that went wrong'],
    ['connection', 'Connection', 'Reticulum connection, restarts'],
    ['identity', 'Identity changes', 'Switching to another identity'],
    ['ephemeral', 'New ephemeral identities', 'A line every time the ephemeral identity is renewed'],
    ['announces', 'Announces', 'A line for every NomadNet announce heard'],
    ['messenger', 'Messenger (LXMF)', 'Messages in and out, LXMF announces, blocked senders'],
    ['propagation', 'Propagation nodes', 'Propagation nodes heard and chosen, syncs'],
    ['rrc', 'RRC chat', 'Client on, hubs connected and lost'],
    ['bbs', 'BBS client', 'Client on, servers connected'],
    ['rmap', 'RMAP', 'The node list fetched from rmap.world'],
    ['activity', 'Requests and activity', 'Page requests, links, downloads, cache, name lookups'],
];

function readTerminalLogChoice(box) {
    const out = {};
    box.querySelectorAll('input[data-cat]').forEach(cb => { out[cb.dataset.cat] = cb.checked; });
    return out;
}

// Settings categories: the column on the left of the dialog. Each section of
// the dialog says which one it belongs to with data-cat.
const SETTINGS_CATEGORIES = [
    ['identity', 'Identity', '<circle cx="8" cy="5.5" r="2.8"/><path d="M2.5 14c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/>'],
    ['pages', 'Pages', '<path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13M6 8h5M6 10.5h5"/>'],
    ['nomadnet', 'NomadNet Browser', '<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.5" cy="4" r=".8"/><circle cx="2.5" cy="8" r=".8"/><circle cx="2.5" cy="12" r=".8"/>'],
    ['messenger', 'LXMF Messenger', '<path d="M2 3h12v8H7l-3.5 2.5V11H2z"/>'],
    ['rrc', 'RRC Client', '<path d="M5.5 2.5l-1.5 11M11 2.5l-1.5 11M2.5 6h11M2 10.5h11"/>'],
    ['retibbs', 'BBS Client', '<rect x="2" y="2.5" width="12" height="9" rx="1"/><path d="M5 14h6M4.5 5.5h4M4.5 8h6"/>'],
    ['rmap', 'RMAP', '<path d="M1.5 3.5l4-1.5 5 2 4-1.5v10l-4 1.5-5-2-4 1.5z"/><path d="M5.5 2v10M10.5 4v10"/>'],
    ['system', 'System', '<rect x="2" y="2.5" width="12" height="4" rx="1"/><rect x="2" y="9.5" width="12" height="4" rx="1"/><path d="M4.5 4.5h.01M4.5 11.5h.01"/>'],
    ['advanced', 'Advanced', '<path d="M3 4h10M3 8h10M3 12h10"/><circle cx="6" cy="4" r="1.4"/><circle cx="10.5" cy="8" r="1.4"/><circle cx="5" cy="12" r="1.4"/>'],
    ['guest', 'Guest mode', '<circle cx="6" cy="5.5" r="2.4"/><path d="M1.5 13.5c.5-2.6 2.3-4 4.5-4s4 1.4 4.5 4"/><path d="M11 3.5h3.5M11 6h3.5M12.5 8.5H14.5"/>'],
    ['about', 'About', '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.8h.01"/>'],
];

// Settings > System > Apps in the tab bar: copies of each app's own
// "Enable" switch, all in one place. A click on the copy clicks
// the original, so loading and Save stay as they were (wireAppBarSwitches).
const APP_BAR_SWITCHES = [
    ['lxmf', 'LXMF Messenger', 'messenger', 'setting-msg-enabled'],
    ['rrc', 'RRC Client', 'rrc', 'setting-rrc-enabled'],
    ['bbs', 'BBS Client', 'retibbs', 'setting-bbs-enabled'],
    ['rmap', 'RMAP', 'rmap', 'setting-rmap-enabled'],
];

function wireAppBarSwitches(dialog) {
    for (const [key, , , id] of APP_BAR_SWITCHES) {
        const copy = dialog.querySelector(`#setting-appbar-${key}`);
        const original = dialog.querySelector(`#${id}`);
        if (!copy || !original) continue;
        const sync = () => copy.classList.toggle('active', original.classList.contains('active'));
        sync();
        // The originals are filled in later, from the server.
        new MutationObserver(sync).observe(original, { attributes: true, attributeFilter: ['class'] });
        copy.addEventListener('click', () => original.click());
    }
}

function settingsIcon(paths) {
    return `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor"
        stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function readSettingsCategory() {
    try {
        const cat = localStorage.getItem('rbrowser_settings_category') || 'identity';
        return cat === 'saved' || cat === 'nodes' ? 'nomadnet' : cat;   // merged into NomadNet Browser
    } catch (e) { return 'identity'; }
}

// Shows one category; the search box, while it holds text, shows every
// section that mentions it instead, whatever its category.
function showSettingsCategory(cat) {
    const dialog = document.querySelector('#settings-modal .settings-dialog');
    if (!dialog) return;
    const known = [...dialog.querySelectorAll('.settings-nav-item')]
        .filter(item => !item.hidden).map(item => item.dataset.cat);
    if (!known.includes(cat)) cat = known[0];
    dialog.dataset.category = cat;
    try { localStorage.setItem('rbrowser_settings_category', cat); } catch (e) {}
    const search = dialog.querySelector('.settings-search');
    if (search) search.value = '';
    filterSettings();
    dialog.querySelector('.settings-pane').scrollTop = 0;
    // On a phone the categories are a row wider than the screen.
    const list = dialog.querySelector('.settings-nav-list');
    const item = dialog.querySelector('.settings-nav-item.active');
    if (list && item && list.scrollWidth > list.clientWidth) {
        list.scrollLeft = item.offsetLeft - (list.clientWidth - item.offsetWidth) / 2;
    }
}

function filterSettings() {
    const dialog = document.querySelector('#settings-modal .settings-dialog');
    if (!dialog) return;
    const query = (dialog.querySelector('.settings-search').value || '').trim().toLowerCase();
    const pane = dialog.querySelector('.settings-pane');
    pane.classList.toggle('searching', !!query);
    let shown = 0;
    pane.querySelectorAll('.auto-reload-setting[data-cat]').forEach(section => {
        const match = query ? section.textContent.toLowerCase().includes(query)
                            : section.dataset.cat === dialog.dataset.category;
        section.classList.toggle('settings-off', !match);
        if (match && !section.hidden) shown++;
    });
    dialog.querySelectorAll('.settings-nav-item').forEach(item =>
        item.classList.toggle('active', !query && item.dataset.cat === dialog.dataset.category));
    const title = SETTINGS_CATEGORIES.find(c => c[0] === dialog.dataset.category);
    const heading = query ? (shown ? `Results for "${query}"` : `Nothing found for "${query}"`) : (title ? title[1] : '');
    pane.querySelector('.settings-pane-title').textContent = heading;
    // A section named like its category does not say it twice.
    pane.querySelectorAll('.auto-reload-setting[data-cat] > .settings-label').forEach(label =>
        label.classList.toggle('same-as-title', !query && label.textContent.trim() === heading));
}

// A category whose sections are all hidden (Advanced while locked) has no
// entry in the column.
function syncSettingsNav() {
    const dialog = document.querySelector('#settings-modal .settings-dialog');
    if (!dialog) return;
    dialog.querySelectorAll('.settings-nav-item').forEach(item => {
        const sections = dialog.querySelectorAll(`.auto-reload-setting[data-cat="${item.dataset.cat}"]`);
        item.hidden = ![...sections].some(s => !s.hidden);
    });
    const current = dialog.querySelector(`.settings-nav-item[data-cat="${dialog.dataset.category}"]`);
    if (!current || current.hidden) showSettingsCategory('about');
    else filterSettings();
}

// Settings > System > Access password: its own Apply, at once (not Save):
// a change asks for the current password and must not wait for the dialog.
async function loadAuthSettings() {
    let st;
    try { st = await fetch('/api/auth').then(r => r.json()); } catch (e) { return; }
    if (st.status !== 'success') return;
    const set = (id, on) => { const el = document.getElementById(id); if (el) el.classList.toggle('active', !!on); };
    set('setting-auth-on', st.enabled);
    set('setting-auth-local', st.ask_local);
    const cur = document.getElementById('setting-auth-current-row');
    if (cur) cur.hidden = !st.has_password;
    const state = document.getElementById('setting-auth-state');
    if (state) state.textContent = !st.has_password ? 'No password set yet.'
        : st.enabled ? (st.local && !st.ask_local ? 'On: other devices are asked (this computer is not).' : 'On.')
        : 'A password is set, but not asked.';
    const out = document.getElementById('setting-auth-logout');
    if (out) out.onclick = () => { location.href = '/logout'; };
    const apply = document.getElementById('setting-auth-apply');
    if (apply) apply.onclick = async () => {
        const on = id => document.getElementById(id).classList.contains('active');
        const body = { enabled: on('setting-auth-on'), ask_local: on('setting-auth-local'),
                       password: document.getElementById('setting-auth-new').value,
                       current: document.getElementById('setting-auth-current').value };
        const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                               body: JSON.stringify(body) }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
        if (res.status !== 'success') { showNotification(escapeHtml(res.error), 'error', 5000); return; }
        document.getElementById('setting-auth-new').value = '';
        document.getElementById('setting-auth-current').value = '';
        showNotification(res.enabled ? 'Access password on' : 'Access password off', 'success', 3000);
        loadAuthSettings();
    };
}

// Settings > Guest mode (rbrowser/auth.py): its own Apply, like the password.
async function loadGuestSettings() {
    const state = document.getElementById('setting-guest-state');
    if (!state) return;
    let st;
    try { st = await fetch('/api/auth').then(r => r.json()); } catch (e) { return; }
    if (st.status !== 'success') return;
    const g = st.guest || {};
    const toggles = { 'setting-guest-on': g.enabled, 'setting-guest-chat': g.chat, 'setting-guest-lxmf': g.messenger };
    for (const [id, on] of Object.entries(toggles)) {
        const el = document.getElementById(id);
        el.classList.toggle('active', !!on);
        el.onclick = () => el.classList.toggle('active');
    }
    state.textContent = st.role === 'guest' ? 'You are a guest: these settings are read only.'
        : !st.has_password ? 'Set the access password first (System).'
        : !g.has_password ? 'No guest password set yet.'
        : g.active ? 'On: the login page takes the guest password too.'
        : g.enabled ? 'On, but the access password is off: nobody is asked, so there are no guests.'
        : 'Off.';
    document.getElementById('setting-guest-apply').onclick = async () => {
        const on = id => document.getElementById(id).classList.contains('active');
        const body = { guest_enabled: on('setting-guest-on'), guest_chat: on('setting-guest-chat'),
                       guest_messenger: on('setting-guest-lxmf'),
                       guest_password: document.getElementById('setting-guest-new').value,
                       current: document.getElementById('setting-guest-current').value };
        const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                               body: JSON.stringify(body) }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
        if (res.status !== 'success') { showNotification(escapeHtml(res.error), 'error', 5000); return; }
        document.getElementById('setting-guest-new').value = '';
        document.getElementById('setting-guest-current').value = '';
        showNotification(res.guest && res.guest.enabled ? 'Guest mode on' : 'Guest mode off', 'success', 3000);
        loadGuestSettings();
    };
}

// A guest sees every setting but changes none: fields and buttons in the
// pane are switched off (the server refuses the changes anyway), Save goes.
// The categories, the search box and Close keep working.
function lockSettingsForGuest(dialog) {
    dialog.classList.add('guest-readonly');
    const pane = dialog.querySelector('.settings-pane');
    const note = document.createElement('div');
    note.className = 'settings-guest-note';
    note.innerHTML = 'Guest mode: you can read the settings, not change them. '
        + '<a href="/logout">Log in as owner</a>';
    pane.prepend(note);
    const off = root => root.querySelectorAll('input, select, textarea, button').forEach(el => {
        el.disabled = true;
        el.tabIndex = -1;
    });
    off(pane);
    // Parts filled in later (identity list, hubs, terminal log...).
    new MutationObserver(records => records.forEach(r => r.addedNodes.forEach(n => {
        if (n.nodeType === 1) { if (n.matches('input, select, textarea, button')) n.disabled = true; off(n); }
    }))).observe(pane, { childList: true, subtree: true });
    dialog.querySelector('.dialog-footer .btn-save')?.remove();
}

// Settings > System > Remote access + Dynamic DNS (rbrowser/remote.py):
// applied at once, like the password. The state is asked again every few
// seconds while the dialog is open (the tunnel takes a moment to start).
async function loadRemoteSettings(first = true) {
    const box = document.getElementById('setting-remote-state');
    if (!box) return;
    let st;
    try { st = await fetch('/api/remote').then(r => r.json()); } catch (e) { return; }
    if (st.status !== 'success') return;
    const s = st.settings, t = st.tunnel, d = st.ddns;
    const tunnel = document.getElementById('setting-remote-tunnel');
    if (tunnel) tunnel.classList.toggle('active', !!s.tunnel_on);
    box.textContent = !s.tunnel_on ? (st.password_ready ? 'Off.' : 'Off. Switch the access password on first.')
        : t.state === 'on' ? t.url
        : t.state === 'downloading' ? 'Downloading cloudflared (once)…'
        : t.state === 'error' ? `Problem: ${t.error} (trying again)`
        : 'Starting the tunnel…';
    const live = s.tunnel_on && t.state === 'on' && t.url;
    const copy = document.getElementById('setting-remote-copy'), open = document.getElementById('setting-remote-open');
    copy.hidden = open.hidden = !live;
    copy.onclick = () => copyText(t.url, 'Remote link copied');
    open.onclick = () => window.open(t.url, '_blank', 'noopener');
    const ddnsState = document.getElementById('setting-ddns-state');
    ddnsState.textContent = !s.ddns_on ? 'Off.' : d.state === 'ok' ? `OK: ${d.ip}`
        : d.state === 'error' ? `Problem: ${d.result}` : 'Checking…';
    if (first) {
        const val = (id, v) => { document.getElementById(id).value = v || ''; };
        document.getElementById('setting-ddns-on').classList.toggle('active', !!s.ddns_on);
        val('setting-ddns-provider', s.ddns_provider);
        val('setting-ddns-url', s.ddns_url);
        val('setting-ddns-domain', s.ddns_domain);
        val('setting-ddns-token', s.ddns_token);
        const fields = () => {
            const afraid = document.getElementById('setting-ddns-provider').value === 'afraid';
            document.querySelectorAll('[data-ddns="afraid"]').forEach(el => { el.hidden = !afraid; });
            document.querySelectorAll('[data-ddns="token"]').forEach(el => { el.hidden = afraid; });
        };
        document.getElementById('setting-ddns-provider').onchange = fields;
        fields();
        const send = async body => {
            const res = await fetch('/api/remote', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                     body: JSON.stringify(body) }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
            if (res.status !== 'success') showNotification(escapeHtml(res.error), 'error', 6000);
            loadRemoteSettings(false);
            return res;
        };
        // The toggle acts at once (the dialog's generic click handler flips it first).
        tunnel.addEventListener('click', () => setTimeout(async () => {
            const res = await send({ tunnel_on: tunnel.classList.contains('active') });
            if (res.status !== 'success') tunnel.classList.remove('active');
        }, 0));
        const ddnsApply = async () => {
            const on = document.getElementById('setting-ddns-on');
            const res = await send({ ddns_on: on.classList.contains('active'),
                                     ddns_provider: document.getElementById('setting-ddns-provider').value,
                                     ddns_url: document.getElementById('setting-ddns-url').value,
                                     ddns_domain: document.getElementById('setting-ddns-domain').value,
                                     ddns_token: document.getElementById('setting-ddns-token').value });
            if (res.status === 'success') showNotification('Dynamic DNS saved', 'success', 3000);
            return res;
        };
        document.getElementById('setting-ddns-apply').onclick = ddnsApply;
        // The switch saves at once too, like the tunnel's (switched off
        // without Apply, it came back on at the next start).
        const ddnsOn = document.getElementById('setting-ddns-on');
        ddnsOn.addEventListener('click', () => setTimeout(async () => {
            const res = await ddnsApply();
            if (res.status !== 'success') ddnsOn.classList.remove('active');
        }, 0));
    }
    setTimeout(() => { if (document.getElementById('setting-remote-state')) loadRemoteSettings(false); }, 3000);
}

function showSettings(category) {
    closeSettings();

    const overlay = document.createElement('div');
    overlay.className = 'auto-reload-modal';
    overlay.id = 'settings-modal';

    const dialog = document.createElement('div');
    dialog.className = 'auto-reload-dialog settings-dialog settings-v2';

    const zoomOptions = ZOOM_STEPS.map(f =>
        `<option value="${f}">${Math.round(f * 100)}%</option>`).join('');
    const policy = getImagePolicy();
    const centered = document.body.classList.contains('center-pages');
    const catLabel = Object.fromEntries(SETTINGS_CATEGORIES.map(([key, label]) => [key, label]));

    dialog.innerHTML = `
        <div class="dialog-header">
            <h3>&#9881; Settings</h3>
            <button class="modal-close" onclick="requestCloseSettings()" title="Close" aria-label="Close">&times;</button>
        </div>
        <div class="settings-body">
        <nav class="settings-nav">
            <input class="settings-search" type="search" placeholder="Search settings" spellcheck="false"
                   oninput="filterSettings()" aria-label="Search settings">
            <div class="settings-nav-list">
            ${SETTINGS_CATEGORIES.map(([key, label, icon]) => `
                <button class="settings-nav-item" data-cat="${key}" onclick="showSettingsCategory('${key}')">
                    ${settingsIcon(icon)}<span>${label}</span>
                </button>`).join('')}
            </div>
        </nav>
        <div class="dialog-scroll settings-pane">
        <div class="settings-pane-title"></div>

        <div class="auto-reload-setting" data-cat="identity" id="settings-identity-section">
            <label class="settings-label">Identity</label>
            <div class="settings-hint">Nodes see your identity only after you identify. Each identity is a
                separate account. Changes here apply immediately.</div>
            <div id="identity-body" class="settings-identity">Loading...</div>
        </div>

        <div class="auto-reload-setting" data-cat="identity">
            <label class="settings-label">Auto-identify</label>
            <div id="autoid-body" class="settings-identity">Loading...</div>
        </div>

        <div class="auto-reload-setting" data-cat="system">
            <label class="settings-label">Apps in the tab bar</label>
            <div class="settings-hint">Each app has its icon next to the page tabs while it is on. The same
                switches as "Enable" at the top of each app's own settings. Saved with Save.</div>
            ${APP_BAR_SWITCHES.map(([key, label, cat, original]) => `
            <div class="settings-row">
                <span>${escapeHtml(label)} <button class="settings-link-btn" type="button" onclick="showSettingsCategory('${cat}')" title="Open its settings">›</button></span>
                <div class="toggle-switch" id="setting-appbar-${key}" data-mirror="${original}"><div class="toggle-slider"></div></div>
            </div>`).join('')}
        </div>

        <div class="auto-reload-setting" data-cat="system">
            <label class="settings-label">Notifications and log</label>
            <div class="settings-row">
                <span>Notifications</span>
                <select id="setting-notifications" class="settings-select">
                    <option value="all">All</option>
                    <option value="errors">Errors and warnings only</option>
                    <option value="none">None</option>
                </select>
            </div>
            <div class="settings-row settings-subhead"><span>Sounds</span></div>
            <div class="settings-hint">A short tone for news, kept in this browser. ▶ plays it.</div>
            <div class="settings-row">
                <span>Sounds</span>
                <div class="toggle-switch" id="setting-sounds-on"><div class="toggle-slider"></div></div>
            </div>
            ${SOUND_KINDS.map(([key, label]) => `
            <div class="settings-row settings-sound-row">
                <span><button class="sound-test" type="button" onclick="playSound('${key}', true)" title="Play it">▶</button> ${escapeHtml(label)}</span>
                <div class="toggle-switch" id="setting-sound-${key}"><div class="toggle-slider"></div></div>
            </div>`).join('')}
            <div class="settings-row">
                <span>Volume</span>
                <select id="setting-sounds-volume" class="settings-select">
                    <option value="0.2">Low</option><option value="0.5">Medium</option><option value="1">High</option>
                </select>
            </div>
            <div class="settings-row settings-subhead"><span>Terminal log</span></div>
            <div class="settings-hint">What rBrowser writes in the terminal. The page already shows
                the same as notifications. Applies on Save, no restart; <code>--log</code> takes priority for one run.</div>
            <div id="setting-terminal-log" class="terminal-log-options">
                ${TERMINAL_LOG_CATEGORIES.map(([key, label, tip]) => `
                <label class="terminal-log-option" title="${escapeHtml(tip)}">
                    <input type="checkbox" data-cat="${key}"> ${escapeHtml(label)}
                </label>`).join('')}
            </div>
        </div>

        <div class="auto-reload-setting" data-cat="system">
            <label class="settings-label">Access password</label>
            <div class="settings-hint">rBrowser listens on your network, so a phone can use it: anyone on the same
                network can open it too, read your messages and use your identities. On a network that is not
                yours, switch this on. Only a hash of the password is kept. Applied with its own button, at once.</div>
            <div class="settings-row">
                <span title="Every page and every call needs the password first (a session lasts 30 days in that browser)">Ask for a password</span>
                <div class="toggle-switch" id="setting-auth-on"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Off: this computer (localhost) gets in without asking. On: here too. A tunnel or reverse proxy on this computer arrives as localhost: with one, switch this on">Ask on this computer too</span>
                <div class="toggle-switch" id="setting-auth-local"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span>New password</span>
                <input type="password" id="setting-auth-new" class="settings-input" autocomplete="new-password" placeholder="unchanged">
            </div>
            <div class="settings-row" id="setting-auth-current-row">
                <span title="Needed for any change once a password is set">Current password</span>
                <input type="password" id="setting-auth-current" class="settings-input" autocomplete="current-password">
            </div>
            <div class="settings-row">
                <span id="setting-auth-state" class="settings-hint" style="margin:0"></span>
                <span>
                    <button type="button" class="msg-bar-btn" id="setting-auth-logout" title="End the session in this browser">Log out</button>
                    <button type="button" class="msg-bar-btn primary" id="setting-auth-apply">Apply</button>
                </span>
            </div>
        </div>

        <div class="auto-reload-setting" data-cat="system">
            <label class="settings-label">Remote access</label>
            <div class="settings-hint">Use rBrowser from outside your network with a link, no router port to open:
                a free Cloudflare tunnel (cloudflared, downloaded once, no account). The link is https and changes
                each time the tunnel starts. Cloudflare carries the traffic: the access password above must be on.
                Applied at once.</div>
            <div class="settings-row">
                <span title="Off: nothing reaches rBrowser from outside. Remembered: on again at the next start">Remote access tunnel</span>
                <div class="toggle-switch" id="setting-remote-tunnel"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span id="setting-remote-state" class="settings-hint" style="margin:0;word-break:break-all"></span>
                <span>
                    <button type="button" class="msg-bar-btn" id="setting-remote-copy" hidden>Copy link</button>
                    <button type="button" class="msg-bar-btn" id="setting-remote-open" hidden>Open</button>
                </span>
            </div>
        </div>

        <div class="auto-reload-setting" data-cat="system">
            <label class="settings-label">Dynamic DNS</label>
            <div class="settings-hint">Only if you opened a port on your router by hand: a free name kept pointed
                at your public IP (checked every 5 minutes). Not needed for the tunnel. Without https on that port
                the password travels in clear: prefer the tunnel.</div>
            <div class="settings-row">
                <span>Keep my name updated</span>
                <div class="toggle-switch" id="setting-ddns-on"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span>Service</span>
                <select id="setting-ddns-provider" class="settings-select">
                    <option value="afraid">FreeDNS (afraid.org)</option>
                    <option value="duckdns">DuckDNS (duckdns.org)</option>
                    <option value="dynv6">dynv6 (dynv6.com)</option>
                </select>
            </div>
            <div class="settings-row" data-ddns="afraid">
                <span title="afraid.org > Dynamic DNS > your subdomain > Direct URL (or the v2 one: sync.afraid.org/u/...)">Update URL</span>
                <input id="setting-ddns-url" class="settings-input" type="text" spellcheck="false"
                       placeholder="https://freedns.afraid.org/dynamic/update.php?TOKEN">
            </div>
            <div class="settings-row" data-ddns="token">
                <span title="DuckDNS: the subdomain (myname or myname.duckdns.org). dynv6: the full name (myname.dynv6.net)">Domain</span>
                <input id="setting-ddns-domain" class="settings-input" type="text" spellcheck="false" placeholder="myname.duckdns.org">
            </div>
            <div class="settings-row" data-ddns="token">
                <span title="The token shown on the service's page once logged in">Token</span>
                <input id="setting-ddns-token" class="settings-input" type="password" spellcheck="false" autocomplete="off">
            </div>
            <div class="settings-row">
                <span id="setting-ddns-state" class="settings-hint" style="margin:0;word-break:break-all"></span>
                <button type="button" class="msg-bar-btn primary" id="setting-ddns-apply">Apply</button>
            </div>
        </div>

        <div class="auto-reload-setting" data-cat="system">
            <label class="settings-label">Web server</label>
            <div class="settings-hint">Same as the <code>--host</code> and <code>--port</code> options.
                Changes require a restart, offered when you save.</div>
            <div class="settings-row">
                <span>Host</span>
                <input id="setting-host" class="settings-input" type="text" spellcheck="false"
                       placeholder="0.0.0.0">
            </div>
            <div class="settings-row">
                <span>Port</span>
                <input id="setting-port" class="settings-input settings-input-port" type="number"
                       min="1" max="65535" placeholder="5000">
            </div>
            <div class="settings-hint" style="margin-top: 8px;"><code>0.0.0.0</code>: reachable from your network.
                <code>127.0.0.1</code>: this computer only.</div>
            <div class="settings-row">
                <span>Local network name</span>
                <div class="toggle-switch" id="setting-local-name-on"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span>Name</span>
                <span class="settings-inline"><input id="setting-local-name" class="settings-input" type="text"
                       spellcheck="false" placeholder="rbrowser" maxlength="63"><span>.local</span></span>
            </div>
            <div id="local-name-note" class="settings-hint"></div>
            <div id="server-restart-note" class="settings-restart-note" hidden>Restart needed: rBrowser moves to
                the new address after a restart, offered when you save.</div>
            <div id="server-note" class="settings-hint"></div>
            <button class="settings-export" onclick="confirmRestart()">Restart rBrowser</button>
        </div>

        <div class="auto-reload-setting" data-cat="system" id="settings-links-section">
            <label class="settings-label">Links</label>
            <div class="settings-hint"><code>nomadnetwork://</code>, <code>rrc://</code> and <code>rbrowser://</code>
                links in web pages (rmap.world's "Open in rBrowser2") and other programs open in rBrowser, which
                starts if it is not running. On by default, for the links no other program opens. Set on the
                computer rBrowser runs on. Applies immediately.</div>
            <div class="settings-row">
                <span>Open links in rBrowser</span>
                <div class="toggle-switch" id="setting-links" onclick="toggleLinks(this)"><div class="toggle-slider"></div></div>
            </div>
            <div id="links-note" class="settings-hint"></div>
        </div>

        <div class="auto-reload-setting" data-cat="pages">
            <label class="settings-label">Page rendering</label>
            <div class="settings-hint">Zoom applied when a page opens. Desktop applies to windows 768px and
                wider. The - and + buttons affect the current page only. Fit scales
                the page to the window width.</div>
            <div class="settings-row">
                <span>Desktop zoom</span>
                <select id="setting-zoom-desktop" class="settings-select">
                    <option value="fit">Fit to window</option>
                    ${zoomOptions}
                </select>
            </div>
            <div class="settings-row">
                <span>Mobile zoom</span>
                <select id="setting-zoom-mobile" class="settings-select">
                    <option value="fit">Fit to window</option>
                    ${zoomOptions}
                </select>
            </div>
            <div class="settings-row">
                <span>Center narrow pages</span>
                <div class="toggle-switch ${centered ? 'active' : ''}" id="setting-center">
                    <div class="toggle-slider"></div>
                </div>
            </div>
            <div class="settings-row">
                <span title="Long pages (big lists, git indexes) are drawn as plain monospace text instead of one cell per character: many times faster, links all work. Phones always draw this way">Light rendering for long pages</span>
                <div class="settings-inline">
                    <div class="toggle-switch ${lightRenderingOn() ? 'active' : ''}" id="setting-light-render"><div class="toggle-slider"></div></div>
                    <select id="setting-light-chars" class="settings-select" title="From this size on">
                        ${LIGHT_RENDER_CHOICES.map(n => `<option value="${n}"${n === lightRenderingChars() ? ' selected' : ''}>over ${n / 1000}k characters</option>`).join('')}
                    </select>
                </div>
            </div>
        </div>

        <div class="auto-reload-setting" data-cat="pages">
            <label class="settings-label">Images in pages</label>
            <div class="settings-hint">Each image is a separate transfer. On slow links it uses shared airtime.</div>
            <div class="settings-row">
                <select id="setting-images" class="settings-select settings-select-wide">
                    <option value="auto">Fast link only</option>
                    <option value="always">Always load</option>
                    <option value="never">Never load</option>
                </select>
            </div>
        </div>

        <div class="auto-reload-setting" data-cat="pages">
            <label class="settings-label">Screenshots</label>
            <div class="settings-hint">The camera button saves the whole page as a PNG. Quality is how
                sharp it is drawn; this browser uses the Desktop or Mobile one by its device.
                On phones, Medium and High can be slow.</div>
            <div class="settings-row">
                <span>Enable screenshots</span>
                <div class="toggle-switch ${screenshotsEnabled() ? 'active' : ''}" id="setting-screenshots">
                    <div class="toggle-slider"></div>
                </div>
            </div>
            <div class="settings-row">
                <span>Desktop quality</span>
                <select id="setting-shot-desktop" class="settings-select">
                    <option value="low">Low</option>
                    <option value="medium">Medium (default)</option>
                    <option value="high">High</option>
                </select>
            </div>
            <div class="settings-row">
                <span>Mobile quality</span>
                <select id="setting-shot-mobile" class="settings-select">
                    <option value="low">Low (default)</option>
                    <option value="medium">Medium - may be slow</option>
                    <option value="high">High - may be slow</option>
                </select>
            </div>
        </div>

        <div class="auto-reload-setting" data-cat="nomadnet">
            <label class="settings-label">Visited pages (Local Search Engine)</label>
            <div class="settings-hint">Pages you open are saved locally and can be searched. Nothing is
                downloaded in the background.</div>
            <div class="settings-row">
                <span>Save visited pages</span>
                <div class="toggle-switch" id="setting-cache-enabled">
                    <div class="toggle-slider"></div>
                </div>
            </div>
            <div class="settings-row">
                <span title="As NomadNet does: for as long as the node allows (#!c= on the page, 12 h if it says nothing, never for #!c=0 pages). Reload always goes live.">Show saved copy while still valid</span>
                <div class="toggle-switch" id="setting-cache-serve">
                    <div class="toggle-slider"></div>
                </div>
            </div>
            <div class="settings-hint">Reload always fetches the page from the node.</div>
            <div class="settings-row">
                <span>Forget pages older than</span>
                <select id="setting-cache-age" class="settings-select">
                    <option value="0">never</option>
                    <option value="1">1 day</option>
                    <option value="7">1 week</option>
                    <option value="30">30 days</option>
                    <option value="365">1 year</option>
                </select>
            </div>
            <div class="settings-row">
                <span>Keep at most</span>
                <select id="setting-cache-size" class="settings-select">
                    <option value="5">5 MB</option>
                    <option value="20">20 MB</option>
                    <option value="50">50 MB</option>
                    <option value="200">200 MB</option>
                    <option value="0">no limit</option>
                </select>
            </div>
            <div class="settings-row settings-cache-stats" id="cache-stats">Reading the cache...</div>
            <div class="settings-row settings-cache-buttons">
                <button class="settings-export" onclick="showCacheSearch()">Local Search Engine</button>
            </div>
            <div class="settings-row">
                <span title="A window over the page, or a tab of its own (the pages found then open in a new tab). Saved in this browser, at once">Local Search Engine opens in</span>
                <select id="setting-search-in" class="settings-select" onchange="setCacheSearchMode(this.value)">
                    <option value="modal">a window</option>
                    <option value="tab">a tab</option>
                </select>
            </div>
            <div class="settings-row settings-cache-buttons">
                <button class="settings-export settings-danger" onclick="clearPageCache()">Delete all stored pages</button>
            </div>
        </div>

        <div class="auto-reload-setting" data-cat="nomadnet">
            <label class="settings-label">Node list</label>
            <div class="settings-hint">A button over the list counts the nodes that came in; click it to
                go to them, or close it with its x.</div>
            <div class="settings-row">
                <span>Show "N new nodes"</span>
                <div class="toggle-switch ${newNodesBadgeEnabled() ? 'active' : ''}" id="setting-new-nodes">
                    <div class="toggle-slider"></div>
                </div>
            </div>
            <div class="settings-row">
                <span>Clear the search after opening a result</span>
                <div class="toggle-switch ${clearSearchOnPick() ? 'active' : ''}" id="setting-clear-search">
                    <div class="toggle-slider"></div>
                </div>
            </div>
            <div class="settings-row settings-subhead">
                <span>Start with recent nodes</span>
                <div class="toggle-switch" id="setting-prefill"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-hint">Off: the list fills as nodes announce, so every node in it was heard
                since rBrowser started. On: it starts with the nodes Reticulum heard announce within the
                time below, marked with an empty ring until they announce again - they may be offline.</div>
            <div class="settings-row" id="setting-prefill-hours-row">
                <span>Announced within</span>
                <select id="setting-prefill-hours" class="settings-select"></select>
            </div>
        </div>

        <div class="auto-reload-setting" data-cat="nomadnet">
            <label class="settings-label">Favorites</label>
            <div class="settings-hint">The Favorites menu over the node list and the stars to add to it.
                Turned off, your favorites are kept and come back when it is on again.</div>
            <div class="settings-row">
                <span>Show favorites</span>
                <div class="toggle-switch ${favoritesSettings.enabled ? 'active' : ''}" id="setting-favorites-enabled">
                    <div class="toggle-slider"></div>
                </div>
            </div>
            <div class="settings-row">
                <span title="When a favorite node announces a new name, the favorite takes it - names you typed included. Off: a name never changes once it is there.">Update names from the node's newest announce</span>
                <div class="toggle-switch ${favoritesSettings.follow_announced_names ? 'active' : ''}" id="setting-favorites-follow">
                    <div class="toggle-slider"></div>
                </div>
            </div>
        </div>

        <div class="auto-reload-setting" data-cat="nomadnet">
            <label class="settings-label">History</label>
            <div class="settings-hint">The pages you open, in the History menu beside Favorites. Kept on
                this computer only.</div>
            <div class="settings-row">
                <span>Keep a history</span>
                <div class="toggle-switch ${historySettings.enabled ? 'active' : ''}" id="setting-history-enabled">
                    <div class="toggle-slider"></div>
                </div>
            </div>
            <div class="settings-row">
                <span>Pages to keep</span>
                <select id="setting-history-max" class="settings-select">
                    ${[50, 100, 200, 500, 1000].map(n => `<option value="${n}">${n}</option>`).join('')}
                </select>
            </div>
            <div class="settings-row">
                <span>Delete pages older than</span>
                <select id="setting-history-age" class="settings-select">
                    <option value="0">Never</option>
                    <option value="1">1 day</option>
                    <option value="7">7 days</option>
                    <option value="30">30 days</option>
                </select>
            </div>
            <button class="settings-export settings-danger" onclick="clearHistoryFromSettings()">Clear history</button>
        </div>

        <div class="auto-reload-setting" data-cat="nomadnet">
            <label class="settings-label">Hidden nodes</label>
            <div class="settings-hint">Left out of the node list. Their pages still open from an address,
                a link or a favorite. Restore applies immediately.</div>
            <div id="hidden-nodes-body" class="hidden-nodes-list">Loading...</div>
        </div>

        <div class="auto-reload-setting" data-cat="messenger" id="settings-messenger-section">
            <label class="settings-label">LXMF Messenger</label>
            <div class="settings-hint">Send and receive LXMF messages, like NomadNet and Sideband. While on,
                your messenger identity's LXMF address can be reached. Saved with Save.</div>
            <div class="settings-row">
                <span>Enable the messenger</span>
                <div class="toggle-switch" id="setting-msg-enabled"><div class="toggle-slider"></div></div>
            </div>
            ${appWindowRow('lxmf')}
            <div class="settings-row">
                <span>Identity</span>
                <select id="setting-msg-identity" class="settings-select"></select>
            </div>
            <div class="settings-row">
                <span title="Each identity has its own name; ephemeral ones are eph_ and 4 characters of the address unless renamed">Name in announces (this identity)</span>
                <input id="setting-msg-name" class="settings-input" type="text" maxlength="64"
                       spellcheck="false" placeholder="Anonymous Peer">
            </div>
            <div class="settings-row">
                <span title="Fixed identities only: an ephemeral one is never announced on its own">Announce at start</span>
                <div class="toggle-switch" id="setting-msg-announce-start"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Fixed identities only. Never more often than every 20 minutes">Announce every</span>
                <div class="settings-inline">
                    <div class="toggle-switch" id="setting-msg-announce-periodic"><div class="toggle-slider"></div></div>
                    <select id="setting-msg-announce-minutes" class="settings-select"></select>
                </div>
            </div>
            <div id="messenger-status" class="settings-hint">Loading...</div>
            <button class="settings-export" id="messenger-announce-now" onclick="messengerAnnounceNow()">Announce now</button>
            <div class="settings-row">
                <span title="Received messages marked as markdown are shown formatted, and yours are marked as markdown (FIELD_RENDERER, as Sideband). Off: plain text both ways">Markdown in messages</span>
                <div class="toggle-switch" id="setting-msg-markdown"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Images received and sent are shown in the chat. Off: listed like any other file, opened from their menu">Show image previews</span>
                <div class="toggle-switch" id="setting-msg-previews"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Files picked, dropped or pasted in a chat are sent at once, with any text already typed. Off: they wait above the text box for Enter">Send files without confirming</span>
                <div class="toggle-switch" id="setting-msg-autosend"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Contacts using Sideband send their icon colours with their messages: shown on their avatar, before a colour picked here">Use Sideband contact colours</span>
                <div class="toggle-switch" id="setting-msg-sideband-look"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Add contact first checks what the address is (one path request if it was never heard) and asks before adding something that is not an LXMF address">Check new contacts</span>
                <div class="toggle-switch" id="setting-msg-check-contacts"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="A short message goes as one packet, without opening a link first: faster, and it gets through where links struggle. Longer messages and files still go by link">Send short messages in one packet (opportunistic)</span>
                <div class="toggle-switch" id="setting-msg-opportunistic"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Every saved identity lists the contacts of the others too, under the name of the identity they belong to. Messages stay with their identity: writing to a shared contact starts a conversation with the identity in use">Share contact list between identities</span>
                <div class="toggle-switch" id="setting-msg-share-contacts"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row settings-subhead"><span>Automatic replies</span></div>
            <div class="settings-hint">One reply per message at most: a matching rule first, then the away
                message (once per contact while you are away), then the echo bot. Never to other automatic
                replies, old messages from a sync, or a contact writing too fast.
                In replies: {name} your name, {msg} their message, {sender} their name, {time}.</div>
            <div class="settings-row">
                <span title="One rule per line, word = reply. The first that matches wins; hel* matches what starts with hel, * matches anything (put it last)">Reply to keywords</span>
                <div class="toggle-switch" id="setting-msg-autoreply"><div class="toggle-slider"></div></div>
            </div>
            <textarea id="setting-msg-rules" class="settings-input settings-textarea" rows="4" spellcheck="false"
                      placeholder="ping = pong"></textarea>
            <div class="settings-row">
                <span>Away</span>
                <div class="settings-inline">
                    <select id="setting-msg-away-mode" class="settings-select">
                        <option value="off">Off</option>
                        <option value="on">On</option>
                        <option value="scheduled">Every day, from - to</option>
                    </select>
                    <input id="setting-msg-away-from" class="settings-input settings-time" type="time">
                    <input id="setting-msg-away-to" class="settings-input settings-time" type="time">
                </div>
            </div>
            <textarea id="setting-msg-away-text" class="settings-input settings-textarea" rows="2" maxlength="1000"
                      placeholder="I'm away right now: I will read your message later."></textarea>
            <div class="settings-row">
                <span title="When no rule and no away message answered: the message goes back. With a text, that text ({msg} = their message)">Echo bot</span>
                <div class="toggle-switch" id="setting-msg-echo"><div class="toggle-slider"></div></div>
            </div>
            <input id="setting-msg-echo-text" class="settings-input" type="text" maxlength="1000" spellcheck="false"
                   placeholder="Empty: their message back. Example: Echo: {msg}">
            <div class="settings-row settings-subhead"><span>Stamp for incoming messages</span></div>
            <div class="settings-hint">Anti-spam. Senders must compute a stamp before writing to you; the cost
                is sent in your announce. Contacts you write to get a ticket and skip it.
                Saved identities only. Cost 8 takes under a second, every +1 doubles the work.</div>
            <div class="settings-row">
                <span>Stamp cost</span>
                <select id="setting-msg-stamp-cost" class="settings-select"></select>
            </div>
            <div class="settings-row">
                <span title="Off: the cost is announced, but messages without a stamp are accepted anyway">Drop messages without a valid stamp</span>
                <div class="toggle-switch" id="setting-msg-enforce-stamps"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row settings-subhead">
                <span>Propagation node</span>
                <div class="toggle-switch" id="setting-msg-pn-on" title="Off: messages go directly only, nothing is collected from a node"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-hint">A propagation node keeps messages for people who are offline. Messages
                that cannot be delivered directly are left there, and a sync collects the ones waiting for you.
                Nodes are found from their announces: nothing is sent to look for them.</div>
            <div id="msg-pn-body">
            <div class="settings-row">
                <span>Node</span>
                <select id="setting-msg-pn-node" class="settings-select settings-select-node" onchange="renderPropagationChoice()"></select>
                <select id="setting-msg-pn-mode" hidden>
                    <option value="auto">Automatic</option>
                    <option value="manual">Chosen</option>
                </select>
            </div>
            <div class="settings-row" id="msg-pn-hash-row">
                <span>Address</span>
                <input id="setting-msg-pn-hash" class="settings-input" type="text" maxlength="32"
                       spellcheck="false" placeholder="32 hex characters">
            </div>
            <div class="settings-row">
                <span title="As NomadNet does: tried once, if a node is set">If direct delivery fails, leave it on the node</span>
                <div class="toggle-switch" id="setting-msg-pn-fallback"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="A sync that fails, or a message the node does not take: that node is set aside for 30 minutes and the next one is used (the chosen one too)">If the node does not answer, try another</span>
                <div class="toggle-switch" id="setting-msg-pn-failover"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Automatic only: every so often the most recently heard reachable node, instead of the nearest">Change node every</span>
                <select id="setting-msg-pn-rotate" class="settings-select">
                    <option value="0">Never (nearest)</option>
                    <option value="1">1 h</option><option value="6">6 h</option>
                    <option value="12">12 h</option><option value="24">24 h</option>
                </select>
            </div>
            <div class="settings-row">
                <span title="Saved identities only. Never more often than every 10 minutes">Sync every</span>
                <div class="settings-inline">
                    <div class="toggle-switch" id="setting-msg-sync-periodic"><div class="toggle-slider"></div></div>
                    <select id="setting-msg-sync-minutes" class="settings-select"></select>
                </div>
            </div>
            <div id="messenger-pn-status" class="settings-hint"></div>
            <div class="settings-inline">
                <button class="settings-export" id="messenger-sync-now" onclick="messengerSyncNow()">Sync now</button>
                <button class="settings-export" id="messenger-sync-cancel" onclick="messengerSyncCancel()" hidden>Cancel sync</button>
            </div>
            </div>
            <div class="settings-row settings-subhead"><span>Blocked contacts</span></div>
            <div class="settings-hint">Their messages are dropped as they arrive. Block from a conversation.</div>
            <div id="messenger-blocked" class="hidden-nodes-list"></div>
        </div>

        <div class="auto-reload-setting" data-cat="rrc">
            <label class="settings-label">RRC Client (Reticulum Relay Chat)</label>
            <div class="settings-hint">Live chat rooms on RRC hubs, IRC style, like the Channels of NomadNet.
                While on, a chat icon sits next to the page tabs: hubs are found from their announces,
                favourites and the ones you visited are kept with their rooms. Nothing said is stored:
                if you were not there, you did not hear it. Saved with Save.</div>
            <div class="settings-row">
                <span>Enable the RRC client</span>
                <div class="toggle-switch" id="setting-rrc-enabled"><div class="toggle-slider"></div></div>
            </div>
            ${appWindowRow('rrc')}
            <div class="settings-row">
                <span title="Used on the hubs where you chose no nick (Hubs, below, or /nick). Off: those hubs see only your identity hash. A nick is a label, not who you are: your identity is">Default nick</span>
                <span class="rrc-nick-default">
                    <input type="text" id="setting-rrc-nick" class="settings-input" maxlength="64" spellcheck="false" autocomplete="off" placeholder="Anonymous Peer">
                    <div class="toggle-switch" id="setting-rrc-nick-on"><div class="toggle-slider"></div></div>
                </span>
            </div>
            <div class="settings-row">
                <span title="On RRC you are your identity: hubs know you, and keep bans and ops, by it. An RRC identity is made for RRC alone; a Messenger identity lets people write to you on LXMF">Chat as</span>
                <select id="setting-rrc-identity" class="settings-select"></select>
            </div>
            <div class="settings-row">
                <span title="New: one more identity for RRC alone (a new person for the hubs). Delete: gone for good, the ops and bans hubs gave it are lost with it">RRC identities</span>
                <span class="rrc-id-actions">
                    <button type="button" class="msg-bar-btn" id="setting-rrc-id-new">New…</button>
                    <button type="button" class="msg-bar-btn danger" id="setting-rrc-id-delete">Delete…</button>
                </span>
            </div>
            <div class="settings-row rrc-hubset-head">
                <span title="The hubs you have been on: who you are on each. Identity: one chosen for that hub, or the one of Chat as. Nick: wins over the Default nick on that hub; /nick in the chat writes the same box. Saved at once">Saved hubs</span>
            </div>
            <div id="rrc-hub-settings" class="rrc-hubset"></div>
            <div class="settings-row">
                <span title="Lines saying who joined and left a room">Show joins and parts</span>
                <div class="toggle-switch" id="setting-rrc-joins"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="A link that drops is opened again, and the rooms joined again">Reconnect when the link drops</span>
                <div class="toggle-switch" id="setting-rrc-reconnect"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="When rBrowser starts, every favourite hub is connected and its rooms of last time joined again">Connect to all favourite hubs at start</span>
                <div class="toggle-switch" id="setting-rrc-autoconnect"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="When rBrowser starts, only the favourites marked with ⚡ (under their star, in the hub list) are connected">Connect to the selected favourite hubs at start (⚡)</span>
                <div class="toggle-switch" id="setting-rrc-autoconnect-sel"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="On connect, the rooms you were in last time on that hub are joined again. Off: you start in the hub tab and join what you want (after a dropped link the open rooms are joined again anyway)">Remember and join the last rooms</span>
                <div class="toggle-switch" id="setting-rrc-rejoin"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="People joining and leaving one after the other, on one line: → a, b joined · ← c left. The hub's own messages stay as they are">Compact joins and parts</span>
                <div class="toggle-switch" id="setting-rrc-compact"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Every notice of the hub (people's +o/+v, kicks, answers) goes to the hub tab: the rooms keep only the chat, with their own topic and modes">Send all server notifications to the hub tab</span>
                <div class="toggle-switch" id="setting-rrc-notices-hub"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="What the client asks by itself is shown in the hub tab: the /who for the room counts in Rooms and for the people lists. Off: read, not shown. The link check (a ping after 60 s of silence) is always silent">Show automatic requests in the hub tab</span>
                <div class="toggle-switch" id="setting-rrc-show-auto"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Words that light a line up and notify you, like your nick: comma separated, whole words">Highlight words</span>
                <input type="text" id="setting-rrc-highlight" class="settings-input" maxlength="300" spellcheck="false" autocomplete="off" placeholder="callsign, rbrowser">
            </div>
            <div class="settings-row settings-subhead"><span>Automatic replies</span></div>
            <div class="settings-hint">Only to messages that name you (your nick or a highlight word), in the
                same room. As in the Messenger: a matching rule first (matched without your name: "@you ping"
                is "ping"), then the away message (once per person while you are away), then the echo bot.
                Never to someone writing too fast.
                In replies: {name} your nick, {msg} their message, {sender} their nick, {time}.</div>
            <div class="settings-row">
                <span title="Where the replies below (keywords, away, echo, away in the rooms) act. Only the chosen rooms: switch each one on in the AutoReply menu while in that room">Where</span>
                <select id="setting-rrc-autoreply-scope" class="settings-select">
                    <option value="all">In every room</option>
                    <option value="selected">Only the chosen rooms</option>
                </select>
            </div>
            <div class="settings-row">
                <span title="One rule per line, word = reply. The first that matches wins; hel* matches what starts with hel, * matches anything (put it last)">Reply to keywords</span>
                <div class="toggle-switch" id="setting-rrc-autoreply"><div class="toggle-slider"></div></div>
            </div>
            <textarea id="setting-rrc-rules" class="settings-input settings-textarea" rows="4" spellcheck="false"
                      placeholder="ping = pong"></textarea>
            <div class="settings-row">
                <span>Away</span>
                <div class="settings-inline">
                    <select id="setting-rrc-away-mode" class="settings-select">
                        <option value="off">Off</option>
                        <option value="on">On</option>
                        <option value="scheduled">Every day, from - to</option>
                    </select>
                    <input id="setting-rrc-away-from" class="settings-input settings-time" type="time">
                    <input id="setting-rrc-away-to" class="settings-input settings-time" type="time">
                </div>
            </div>
            <textarea id="setting-rrc-away-text" class="settings-input settings-textarea" rows="2" maxlength="1000"
                      placeholder="I'm away right now: I will read your message later."></textarea>
            <div class="settings-row">
                <span title="While away you are seen with this nick (from your next message: the away notice below, if on). {nick} = your usual nick. Mentions of the usual nick still count">Away nick</span>
                <div class="toggle-switch" id="setting-rrc-away-nick-on"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="{nick} is your usual nick: {nick}|Away becomes F.rrc|Away (empty: this one)">Nick while away</span>
                <input id="setting-rrc-away-nick" class="settings-input" type="text" maxlength="64" spellcheck="false"
                       placeholder="{nick}|Away">
            </div>
            <div class="settings-row">
                <span title="While away, '/me is away (text)' in every room you are in: when away starts and when you join a room. Whoever names you still gets the away reply above, once">Say it in the rooms</span>
                <div class="toggle-switch" id="setting-rrc-away-notice"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Added in brackets: * nick is away (back at 18:00). Empty: * nick is away">Text in the rooms</span>
                <input id="setting-rrc-away-notice-text" class="settings-input" type="text" maxlength="200" spellcheck="false"
                       placeholder="e.g. back at 18:00 (can stay empty)">
            </div>
            <div class="settings-row">
                <span title="Said again in the rooms while you stay away; at most once an hour, the rooms are not ours to fill">Say it again</span>
                <select id="setting-rrc-away-notice-every" class="settings-select">
                    <option value="0">Only once</option>
                    ${[1, 2, 3, 4, 6, 8, 12, 24].map(h => `<option value="${h}">Every ${h} h</option>`).join('')}
                </select>
            </div>
            <div class="settings-row">
                <span title="When away ends (switched off, or the schedule is over): '/me is back' (or your text) in the rooms told you were away, or in every room you are in if none was">Back from away message</span>
                <div class="toggle-switch" id="setting-rrc-back-notice"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Said as an action: * nick is back. Empty: is back">Back text</span>
                <input id="setting-rrc-back-notice-text" class="settings-input" type="text" maxlength="200" spellcheck="false"
                       placeholder="is back">
            </div>
            <div class="settings-row">
                <span title="When no rule and no away message answered: the message goes back. With a text, that text ({msg} = their message)">Echo bot</span>
                <div class="toggle-switch" id="setting-rrc-echo"><div class="toggle-slider"></div></div>
            </div>
            <input id="setting-rrc-echo-text" class="settings-input" type="text" maxlength="1000" spellcheck="false"
                   placeholder="Empty: their message back. Example: Echo: {msg}">
            <div class="settings-row settings-subhead"><span>Pop-ups</span></div>
            <div class="settings-row">
                <span title="A pop-up when someone names you or writes a highlight word, unless that room is on screen. Click it to go there">When someone names you</span>
                <div class="toggle-switch" id="setting-rrc-notify-mentions"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="A pop-up for every message in the rooms you are in, unless that room is on screen (one every few seconds per room)">Messages in your rooms</span>
                <div class="toggle-switch" id="setting-rrc-notify-messages"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="A pop-up when a hub connects, drops or fails, and when you are kicked or banned from a room">Hub events</span>
                <div class="toggle-switch" id="setting-rrc-notify-events"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-hint">Each pop-up has its switch; the sounds for them are in System &gt; Sounds.</div>
        </div>
        <div class="auto-reload-setting" data-cat="retibbs">
            <label class="settings-label">BBS Client</label>
            <div class="settings-hint">Bulletin boards over Reticulum. While on, a BBS icon sits next to the
                page tabs: servers are found from their announces, favourites and the ones you visited are kept,
                and several can be open at once, as tabs. Saved with Save.</div>
            <div class="settings-row">
                <span>Enable the BBS client</span>
                <div class="toggle-switch" id="setting-bbs-enabled"><div class="toggle-slider"></div></div>
            </div>
            ${appWindowRow('bbs')}
            <div class="settings-row settings-subhead"><span>Listen for</span></div>
            <div class="settings-row">
                <span title="RetiBBS servers (github.com/kc1awv/RetiBBS, in the Reticulum manual): found from their retibbs.bbs announces">RetiBBS</span>
                <div class="toggle-switch" id="setting-bbs-proto-retibbs"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Nodes in the node list with BBS in their name, listed under Found on NomadNet. Their boards are pages: they open in a new tab">NomadNet nodes named BBS</span>
                <div class="toggle-switch" id="setting-bbs-proto-nomadnet"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-hint">More kinds of BBS will be added here.</div>
            <div class="settings-row">
                <span title="Dialing like a modem while connecting, text scrolling in line by line, a CRT glow. A key or a click skips the effect">Terminal Effect (80s/90s GFX)</span>
                <div class="toggle-switch" id="setting-bbs-fx"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="A RetiBBS account is the identity you log in with: the same identity next time, the same account">Log in as</span>
                <select id="setting-bbs-identity" class="settings-select"></select>
            </div>
        </div>
        <div class="auto-reload-setting" data-cat="rmap">
            <label class="settings-label">RMAP</label>
            <div class="settings-hint">The nodes heard by rmap.world, like a remote listener: on a map and in
                lists by kind. NomadNet pages open, propagation nodes can be used, RRC hubs open in RRC chat, BBS in the BBS client,
                backbone and TCP servers can be copied into the Reticulum config. Needs internet; fetched
                only while on. Saved with Save.</div>
            <div class="settings-row">
                <span>Enable RMAP integration</span>
                <div class="toggle-switch" id="setting-rmap-enabled"><div class="toggle-slider"></div></div>
            </div>
            ${appWindowRow('rmap')}
            <div class="settings-row">
                <span title="The list is fetched from rmap.world when rBrowser starts, then this often. Not more often than every 30 minutes: many rBrowsers asking every few minutes would weigh on rmap.world">Refresh every</span>
                <select id="setting-rmap-refresh" class="settings-select"></select>
            </div>
            <div class="settings-row">
                <span title="Older nodes are left out: most of the nodes rmap knows have not announced for days">Show nodes heard within</span>
                <select id="setting-rmap-age" class="settings-select"></select>
            </div>
            <div class="settings-row">
                <span title="Offline: country borders built into rBrowser (680 KB), no requests, light or dark. Online: detailed map from Esri (Light Gray or Dark Gray), fetched while RMAP is open. The ☾/☀ button in the RMAP bar switches light and dark">Map</span>
                <select id="setting-rmap-map" class="settings-select">
                    <option value="offline-light">Offline, light (country borders, default)</option>
                    <option value="offline-dark">Offline, dark (country borders)</option>
                    <option value="online-light">Online, light (Esri Light Gray)</option>
                    <option value="online-dark">Online, dark (Esri Dark Gray)</option>
                </select>
            </div>
            <div class="settings-hint">Online, the map's tiles come from Esri: streets, cities and names, with
                internet. Offline, the map is drawn from country borders built into rBrowser: nothing is asked of
                anyone for it. Downloading the detailed map for offline use is not offered: the map providers'
                terms forbid it. The node list itself always comes from rmap.world. With RMAP off, rBrowser makes
                no request outside Reticulum.</div>
        </div>
        <div class="auto-reload-setting" data-cat="advanced" id="settings-advanced-section" hidden>
            <label class="settings-label">Advanced</label>
            <div class="settings-hint">Options for people who know what they do. Unlocked from About;
                described in the README.</div>
            <div class="settings-row">
                <span>Allow ephemeral identity messages</span>
                <div class="toggle-switch" id="setting-msg-allow-ephemeral"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-hint">Lets the messenger write with the ephemeral identity. It changes at restart,
                at reload or on its timer: replies that arrive after the change are lost. Kept in memory only,
                never announced on its own, at most one message every 10 s and 20 an hour. Recipients can still
                ignore you or ask for a stamp.</div>
            <button class="settings-export" onclick="lockAdvanced()">Hide Advanced</button>
        </div>

        <div class="auto-reload-setting" data-cat="guest">
            <label class="settings-label">Guest mode</label>
            <div class="settings-hint">Let other people try this rBrowser, for example through the Remote access
                link: they log in with a guest password and can browse and open the Settings to read them, but
                change nothing - the server refuses it, whatever page they use. They use the identity you have
                chosen here, and cannot switch it or see its keys. Needs the access password on (System); your
                password keeps giving full access. Applied with its own button, at once.</div>
            <div class="settings-row">
                <span title="The login page also takes the guest password, for a read-only session">Allow guests</span>
                <div class="toggle-switch" id="setting-guest-on"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Guests can connect to RRC hubs and BBS servers and write there, with your identity and nick">Guests can chat (RRC, BBS)</span>
                <div class="toggle-switch" id="setting-guest-chat"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="Off: the LXMF tab is hidden from guests and the server refuses it. On: they read and write YOUR messages">Guests can use the LXMF messenger</span>
                <div class="toggle-switch" id="setting-guest-lxmf"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span>Guest password</span>
                <input type="password" id="setting-guest-new" class="settings-input" autocomplete="new-password" placeholder="unchanged">
            </div>
            <div class="settings-row">
                <span title="Your access password: needed for any change">Your password</span>
                <input type="password" id="setting-guest-current" class="settings-input" autocomplete="current-password">
            </div>
            <div class="settings-row">
                <span id="setting-guest-state" class="settings-hint" style="margin:0"></span>
                <button type="button" class="msg-bar-btn primary" id="setting-guest-apply">Apply</button>
            </div>
        </div>

        <div class="auto-reload-setting" data-cat="about">
            <label class="settings-label">About</label>
            <div class="settings-about" id="settings-version" onclick="aboutVersionTap()">rBrowser v2.0.3b</div>
            <div class="settings-hint">Beta: some parts of the interface may still have bugs; they are fixed as soon as possible.</div>
            <div class="settings-hint" id="settings-usage" title="rBrowser's Python process; page = this browser tab (Chrome/Edge only)"></div>
            <div class="settings-hint">Standalone Reticulum Browser: NomadNet, LXMF, RRC, BBS &amp; RMAP WebUI Clients</div>
            <div class="settings-row">
                <span title="At start rBrowser reads version.txt on GitHub (only that file, nothing is downloaded): a newer version puts a mark on About">Check for updates at start</span>
                <div class="toggle-switch" id="setting-update-check"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-row">
                <span title="While the page stays open, it asks again for a newer version every so often (GitHub is asked at most every 10 minutes)">Auto-check every</span>
                <div class="settings-inline">
                    <select id="setting-update-every" class="settings-select" title="How often">
                        ${UPDATE_EVERY_CHOICES.map(h => `<option value="${h}"${h === updateEveryHours() ? ' selected' : ''}>${h} hour${h > 1 ? 's' : ''}</option>`).join('')}
                    </select>
                    <div class="toggle-switch ${updateAutoOn() ? 'active' : ''}" id="setting-update-auto"><div class="toggle-slider"></div></div>
                </div>
            </div>
            <div class="settings-row">
                <span title="When the check finds a newer version: a window says so, with the link to the GitHub page">Tell me in a window when an update is out</span>
                <div class="toggle-switch" id="setting-update-popup"><div class="toggle-slider"></div></div>
            </div>
            <div class="settings-update" id="settings-update" hidden></div>
            <button class="settings-export" id="setting-update-now" type="button">Check now</button>
            <div class="settings-hint settings-update-howto"><strong>How to update</strong>
                (your identities and settings stay: they are not in the files that change):
                <ul>
                    <li>Installed with <code>git clone</code>: <strong>Update now</strong> (shown when an
                        update is out) does the <code>git pull</code> and restarts rBrowser. By hand: stop rBrowser (Ctrl+C), then in its folder
                        <code>git pull</code> and <code>pip install -r requirements.txt</code>
                        (or <code>bash install.sh</code> / <code>install.bat</code>), and start it again.
                        As a service: <code>sudo systemctl restart rbrowser</code> after the pull.</li>
                    <li>Downloaded as a zip: download the new one, unzip it over the old folder
                        (or copy into the new one your <code>settings</code>, <code>identities</code>,
                        <code>cache</code> and <code>downloads</code> folders and the
                        <code>nomadnet_browser_identity</code> file),
                        run the installer again and start rBrowser.</li>
                    <li>Docker: <code>git pull</code>, then <code>bash docker.sh</code> rebuilds and restarts it
                        (the volumes keep your data).</li>
                </ul>
            </div>
        </div>

        </div>
        </div>
        <div class="auto-reload-actions dialog-footer">
            <span class="settings-dirty-note" id="settings-dirty-note" hidden>Unsaved changes</span>
            <button class="btn-cancel" onclick="requestCloseSettings()" title="Close">Close</button>
            <button class="btn-save" onclick="saveSettings()">Save</button>
        </div>
    `;

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) requestCloseSettings(); });
    document.body.appendChild(overlay);
    trackSettingsChanges(dialog);
    setupUpdateSettings();
    refreshUsage();

    dialog.querySelectorAll('.auto-reload-setting[data-cat]').forEach(section => {
        section.dataset.catLabel = catLabel[section.dataset.cat] || '';
    });
    dialog.dataset.category = category || readSettingsCategory();
    syncSettingsNav();
    showSettingsCategory(dialog.dataset.category);
    // Advanced appears and disappears (About, Hide Advanced) after this.
    new MutationObserver(syncSettingsNav).observe(dialog.querySelector('.settings-pane'),
        { attributes: true, attributeFilter: ['hidden'], subtree: true });

    dialog.querySelector('#setting-zoom-desktop').value = zoomValueFor(zoomIndexFor(getZoomDefault('desktop')));
    dialog.querySelector('#setting-zoom-mobile').value = zoomValueFor(zoomIndexFor(getZoomDefault('mobile')));
    dialog.querySelector('#setting-images').value = policy;
    dialog.querySelector('#setting-shot-desktop').value = getScreenshotQuality('desktop');
    dialog.querySelector('#setting-shot-mobile').value = getScreenshotQuality('mobile');
    fillHiddenNodes(dialog.querySelector('#hidden-nodes-body'));

    dialog.querySelector('#setting-history-max').value = String(historySettings.max_entries);
    dialog.querySelector('#setting-history-age').value = String(historySettings.max_age_days);

    dialog.querySelectorAll('#setting-center, #setting-light-render, #setting-screenshots, #setting-local-name-on, #setting-new-nodes, #setting-clear-search, #setting-prefill, #setting-history-enabled, #setting-cache-enabled, #setting-cache-serve, #setting-msg-enabled, #setting-msg-announce-start, #setting-msg-announce-periodic, #setting-msg-allow-ephemeral, #setting-msg-enforce-stamps, #setting-msg-markdown, #setting-msg-check-contacts, #setting-msg-sideband-look, #setting-msg-autosend, #setting-msg-previews, #setting-msg-autoreply, #setting-msg-echo, #setting-msg-opportunistic, #setting-msg-share-contacts, #setting-bbs-enabled, #setting-bbs-proto-retibbs, #setting-bbs-proto-nomadnet, #setting-bbs-fx, #setting-rmap-enabled, #setting-auth-on, #setting-auth-local, #setting-remote-tunnel, #setting-ddns-on, #setting-rrc-enabled, #setting-rrc-nick-on, #setting-rrc-joins, #setting-rrc-reconnect, #setting-rrc-autoconnect, #setting-rrc-autoconnect-sel, #setting-rrc-rejoin, #setting-rrc-compact, #setting-rrc-notices-hub, #setting-rrc-show-auto, #setting-rrc-notify-mentions, #setting-rrc-notify-messages, #setting-rrc-notify-events, #setting-rrc-autoreply, #setting-rrc-echo, #setting-rrc-away-notice, #setting-rrc-away-nick-on, #setting-rrc-back-notice, #setting-msg-pn-on, #setting-msg-pn-fallback, #setting-msg-pn-failover, #setting-msg-sync-periodic, #setting-favorites-enabled, #setting-favorites-follow, #setting-app-window-lxmf, #setting-app-window-rrc, #setting-app-window-bbs, #setting-app-window-rmap')
          .forEach(toggle => toggle.addEventListener('click', function () {
              this.classList.toggle('active');
          }));
    wireAppBarSwitches(dialog);
    dialog.querySelector('#setting-msg-pn-on').addEventListener('click', renderPropagationChoice);

    dialog.querySelector('#setting-notifications').value = getNotificationPolicy();
    {
        const sounds = soundSettings();
        dialog.querySelector('#setting-sounds-on').classList.toggle('active', sounds.on);
        for (const [key] of SOUND_KINDS) dialog.querySelector(`#setting-sound-${key}`).classList.toggle('active', sounds.kinds[key]);
        const vol = dialog.querySelector('#setting-sounds-volume');
        vol.value = sounds.volume <= 0.3 ? '0.2' : sounds.volume >= 0.8 ? '1' : '0.5';
        dialog.querySelectorAll('#setting-sounds-on, [id^="setting-sound-"]').forEach(t => {
            if (t.classList.contains('toggle-switch')) t.addEventListener('click', function () {
                this.classList.toggle('active');
                saveSoundSettingsFromDialog();
            });
        });
        vol.addEventListener('change', saveSoundSettingsFromDialog);
    }
    fetch('/api/console-settings').then(r => r.json()).then(s => {
        const box = document.getElementById('setting-terminal-log');
        if (!box || !s.categories) return;
        box.querySelectorAll('input[data-cat]').forEach(cb => {
            cb.checked = !!s.categories[cb.dataset.cat];
        });
        box.dataset.loaded = JSON.stringify(readTerminalLogChoice(box));
    }).catch(() => {});

    renderIdentitySettings();
    loadIdentityState();
    loadServerSettings();
    loadNodeListSettings();
    loadLinkSettings();
    loadCacheSettings();
    loadMessengerSettings();
    if (typeof loadRetibbsSettings === 'function') loadRetibbsSettings();
    loadAuthSettings();
    loadRemoteSettings();
    loadGuestSettings();
    if (window.rbGuest) lockSettingsForGuest(dialog);
    if (typeof loadRmapSettings === 'function') loadRmapSettings();
    if (typeof loadRrcSettings === 'function') loadRrcSettings();
}

// ─── Settings > NomadNet Browser > Node list > Start with recent nodes (rbrowser/node_prefill.py) ───

async function loadNodeListSettings() {
    let data;
    try { data = await fetch('/api/node-list-settings').then(r => r.json()); } catch (e) { return; }
    const toggle = document.getElementById('setting-prefill');
    const hours = document.getElementById('setting-prefill-hours');
    if (!toggle || !hours || !data.settings) return;
    toggle.classList.toggle('active', !!data.settings.prefill);
    hours.innerHTML = (data.choices || []).map(h => `<option value="${h}">${h} h</option>`).join('');
    hours.value = String(data.settings.prefill_hours);
    hours.dataset.loaded = JSON.stringify(data.settings);
}

function saveNodeListSettings() {
    const toggle = document.getElementById('setting-prefill');
    const hours = document.getElementById('setting-prefill-hours');
    if (!toggle || !hours || !hours.dataset.loaded) return;
    const wanted = { prefill: toggle.classList.contains('active'), prefill_hours: Number(hours.value) };
    const before = JSON.parse(hours.dataset.loaded);
    if (wanted.prefill === before.prefill && wanted.prefill_hours === before.prefill_hours) return;
    fetch('/api/node-list-settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wanted),
    }).then(r => r.json()).then(data => {
        if (data.status !== 'success') throw new Error(data.error || 'not saved');
        if (data.added) {
            showNotification(`${data.added} recent node${data.added === 1 ? '' : 's'} added to the list`, 'success', 3500);
            // Already known, not newly heard: not for the "N new nodes" count.
            Promise.resolve(updateNodes()).then(() => {
                nodeListNew.clear();
                setNodeListPending();
            });
        }
    }).catch(e => showNotification(`Node list setting not saved: ${escapeHtml(e.message)}`, 'error', 5000));
}

// ─── Settings > System > Links (rbrowser/links.py) ───

function renderLinkSettings(st) {
    const toggle = document.getElementById('setting-links');
    const note = document.getElementById('links-note');
    if (!toggle || !note) return;
    toggle.classList.toggle('active', !!st.registered);
    toggle.classList.toggle('disabled', !st.supported);
    const schemes = st.schemes || {};
    const list = state => Object.keys(schemes).filter(s => schemes[s] === state).map(s => `<code>${s}://</code>`).join(', ');
    if (!st.supported) {
        note.textContent = `Not available: ${st.reason}.`;
    } else if (st.registered) {
        // Some may be another program's: the start never takes those.
        note.innerHTML = `Open here: ${list('ours')}.`
            + (list('copy') ? ` Another rBrowser folder opens ${list('copy')}: restart this one to take them.` : '')
            + (list('other') ? ` Another program opens ${list('other')}: turn this off and on to take them too.` : '');
    } else if (st.other) {
        note.innerHTML = `Another program opens them now: <code>${escapeHtml(st.other)}</code>. Turning this on replaces it.`;
    } else {
        note.textContent = '';
    }
}

async function loadLinkSettings() {
    try {
        renderLinkSettings(await fetch('/api/links').then(r => r.json()));
    } catch (e) {
        const note = document.getElementById('links-note');
        if (note) note.textContent = `Could not read the link setting: ${e.message}`;
    }
}

async function toggleLinks(toggle) {
    if (toggle.classList.contains('disabled') || toggle.dataset.busy) return;
    toggle.dataset.busy = '1';
    const enabled = !toggle.classList.contains('active');
    try {
        const st = await fetch('/api/links', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        }).then(r => r.json());
        if (st.status === 'error') throw new Error(st.error);
        renderLinkSettings(st);
        showNotification(enabled ? 'nomadnetwork://, rrc:// and rbrowser:// links now open in rBrowser'
                                 : 'Links no longer open in rBrowser', 'success', 3000);
    } catch (e) {
        showNotification(`Links: ${escapeHtml(e.message)}`, 'error', 5000);
    } finally {
        delete toggle.dataset.busy;
    }
}

// ─────────────────────────────────────────────────────────────
// Messenger settings (rbrowser/messenger.py), Advanced and About
// ─────────────────────────────────────────────────────────────

let messengerState = null;

async function loadMessengerSettings() {
    let state, ids;
    try {
        [state, ids] = await Promise.all([
            fetch('/api/messenger').then(r => r.json()),
            fetch('/api/identities').then(r => r.json()),
        ]);
    } catch (e) {
        const box = document.getElementById('messenger-status');
        if (box) box.textContent = `Could not read the messenger settings: ${e.message}`;
        return;
    }
    messengerState = state;
    const s = state.settings || {};
    loadedMessengerSettings = JSON.parse(JSON.stringify(s));
    const setToggle = (id, on) => { const el = document.getElementById(id); if (el) el.classList.toggle('active', !!on); };
    setToggle('setting-msg-enabled', s.enabled);
    // Read from the server: only now may Save send these fields back
    // (readMessengerFields). Before, they hold the dialog's defaults, all off.
    const enabledToggle = document.getElementById('setting-msg-enabled');
    if (enabledToggle && state.settings) enabledToggle.dataset.loaded = '1';
    setToggle('setting-msg-announce-start', s.announce_at_start);
    setToggle('setting-msg-announce-periodic', s.announce_periodic);
    setToggle('setting-msg-allow-ephemeral', s.allow_ephemeral);
    setToggle('setting-msg-enforce-stamps', s.enforce_stamps !== false);
    setToggle('setting-msg-markdown', s.markdown !== false);
    setToggle('setting-msg-check-contacts', s.check_new_contacts !== false);
    setToggle('setting-msg-sideband-look', s.sideband_look !== false);
    setToggle('setting-msg-autosend', !!s.autosend_files);
    setToggle('setting-msg-previews', s.image_previews !== false);
    setToggle('setting-msg-autoreply', !!s.autoreply_on);
    setToggle('setting-msg-opportunistic', !!s.opportunistic);
    setToggle('setting-msg-share-contacts', !!s.share_contacts);
    setToggle('setting-msg-echo', !!s.echo_on);
    const setValue = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    setValue('setting-msg-rules', s.autoreply_rules);
    setValue('setting-msg-away-mode', s.away_mode || 'off');
    setValue('setting-msg-away-from', s.away_from);
    setValue('setting-msg-away-to', s.away_to);
    setValue('setting-msg-away-text', s.away_text);
    setValue('setting-msg-echo-text', s.echo_text);
    const stamp = document.getElementById('setting-msg-stamp-cost');
    if (stamp) {
        const label = c => c ? `${c}` : 'Off';
        stamp.innerHTML = (state.stamp_choices || [0]).map(c => `<option value="${c}">${label(c)}</option>`).join('');
        // A value set by hand in the file may not be one of the steps.
        if (![...stamp.options].some(o => o.value === String(s.stamp_cost || 0))) {
            stamp.add(new Option(label(s.stamp_cost), String(s.stamp_cost)));
        }
        stamp.value = String(s.stamp_cost || 0);
    }

    const select = document.getElementById('setting-msg-identity');
    if (select) {
        const options = (ids.profiles || []).filter(p => p.loadable)
            .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`);
        if (s.allow_ephemeral) options.push('<option value="ephemeral">Ephemeral (replies lost when it changes)</option>');
        select.innerHTML = options.join('');
        select.value = s.identity;
    }
    // Each identity has its own name: the field follows the one chosen.
    const name = document.getElementById('setting-msg-name');
    if (name) name.value = s.display_name || '';
    if (select && name) {
        select.onchange = () => {
            const chosen = (state.identities || []).find(i => i.id === select.value);
            name.value = chosen ? chosen.display_name || '' : '';
        };
    }
    const minutes = document.getElementById('setting-msg-announce-minutes');
    if (minutes) {
        const label = m => m < 60 ? `${m} min` : `${m / 60} h`;
        minutes.innerHTML = (state.announce_choices || []).map(m => `<option value="${m}">${label(m)}</option>`).join('');
        if (![...minutes.options].some(o => o.value === String(s.announce_minutes))) {
            minutes.add(new Option(label(s.announce_minutes), String(s.announce_minutes)));
        }
        minutes.value = String(s.announce_minutes);
    }
    const advanced = document.getElementById('settings-advanced-section');
    if (advanced) advanced.hidden = !s.advanced_unlocked;
    renderMessengerStatus();
    renderBlockedContacts(state.blocked || []);
    await loadPropagationSettings(s);
}

// ─── Settings > LXMF Messenger > Propagation node ───

let propagationNodes = [];

async function loadPropagationSettings(s) {
    const mode = document.getElementById('setting-msg-pn-mode');
    if (!mode) return;
    let data = { nodes: [], propagation: {} };
    try { data = await fetch('/api/messenger/propagation-nodes').then(r => r.json()); } catch (e) {}
    propagationNodes = data.nodes || [];
    // Off is the switch; the menu keeps how the node is picked, shown as it
    // will be when switched back on.
    const off = s.propagation_mode === 'off';
    document.getElementById('setting-msg-pn-on').classList.toggle('active', !off);
    mode.value = off ? (s.propagation_node ? 'manual' : 'auto') : (s.propagation_mode || 'auto');
    document.getElementById('setting-msg-pn-fallback').classList.toggle('active', !!s.propagation_fallback);
    document.getElementById('setting-msg-pn-failover').classList.toggle('active', s.propagation_failover !== false);
    document.getElementById('setting-msg-pn-rotate').value = String(s.propagation_rotate_hours || 0);
    document.getElementById('setting-msg-sync-periodic').classList.toggle('active', !!s.sync_periodic);
    const minutes = document.getElementById('setting-msg-sync-minutes');
    const label = m => m < 60 ? `${m} min` : `${m / 60} h`;
    const choices = (data.propagation && data.propagation.sync_choices) || [10, 15, 30, 60, 120, 360, 720, 1440];
    minutes.innerHTML = choices.map(m => `<option value="${m}">${label(m)}</option>`).join('');
    if (![...minutes.options].some(o => o.value === String(s.sync_minutes))) {
        minutes.add(new Option(label(s.sync_minutes), String(s.sync_minutes)));
    }
    minutes.value = String(s.sync_minutes);

    // One menu: Automatic (with the node it would pick now), every node heard
    // on the network, and a typed address.
    const select = document.getElementById('setting-msg-pn-node');
    const name = n => n.name || n.hash.slice(0, 12) + '…';
    const nodeLabel = n => `${name(n)} - `
        + (n.hops != null ? `${n.hops} ${n.hops === 1 ? 'hop' : 'hops'}` : 'no path')
        + (n.active ? '' : ' (not active)');
    const nearest = propagationNodes.filter(n => n.active && n.hops != null)
        .sort((a, b) => a.hops - b.hops)[0];
    const autoLabel = 'Automatic - nearest heard' + (nearest ? ` (now ${name(nearest)})` : '');
    // Every node ever heard is kept: the ones with a path first, by hops.
    const group = (label, nodes) => nodes.length
        ? `<optgroup label="${label} (${nodes.length})">`
          + nodes.map(n => `<option value="${escapeHtml(n.hash)}">${escapeHtml(nodeLabel(n))}</option>`).join('')
          + '</optgroup>'
        : '';
    const reachable = propagationNodes.filter(n => n.hops != null).sort((a, b) => a.hops - b.hops);
    select.innerHTML = `<option value="auto">${escapeHtml(autoLabel)}</option>`
        + group('Reachable', reachable)
        + group('No path now', propagationNodes.filter(n => n.hops == null))
        + '<option value="">Another address…</option>';
    const chosen = s.propagation_node || '';
    select.value = mode.value === 'auto' ? 'auto'
        : (propagationNodes.some(n => n.hash === chosen) ? chosen : (chosen ? '' : 'auto'));
    document.getElementById('setting-msg-pn-hash').value = chosen;
    renderPropagationChoice();
    renderPropagationStatus(data.propagation || {});
    // While Settings is open, the sync state follows on its own.
    clearInterval(loadPropagationSettings.timer);
    loadPropagationSettings.timer = setInterval(async () => {
        if (!document.getElementById('messenger-pn-status')) return clearInterval(loadPropagationSettings.timer);
        try {
            const st = await fetch('/api/messenger').then(r => r.json());
            renderPropagationStatus(st.propagation || {});
        } catch (e) {}
    }, 2000);
}

function renderPropagationChoice() {
    const mode = document.getElementById('setting-msg-pn-mode');
    if (!mode) return;
    document.getElementById('msg-pn-body').hidden =
        !document.getElementById('setting-msg-pn-on').classList.contains('active');
    const select = document.getElementById('setting-msg-pn-node');
    mode.value = select.value === 'auto' ? 'auto' : 'manual';
    const manual = mode.value === 'manual';
    document.getElementById('msg-pn-hash-row').hidden = !manual || select.value !== '';
    if (manual && select.value) document.getElementById('setting-msg-pn-hash').value = select.value;
}

function renderPropagationStatus(p) {
    const box = document.getElementById('messenger-pn-status');
    if (!box) return;
    const sync = p.sync || {};
    const node = p.node;
    let html;
    if (p.mode === 'off') {
        html = 'Off: messages go directly only, nothing is collected from a node.';
    } else if (!node) {
        html = p.mode === 'auto'
            ? `No propagation node heard yet (${p.heard || 0} known). It is picked as soon as one announces.`
            : 'No node chosen.';
    } else {
        const hops = node.hops != null ? `${node.hops} ${node.hops === 1 ? 'hop' : 'hops'}` : 'no path yet';
        const facts = [hops];
        if (node.stamp_cost != null) facts.push(`stamp cost ${node.stamp_cost}`);
        if (node.transfer_limit_kb) facts.push(`up to ${node.transfer_limit_kb} KB per message`);
        if (node.software) facts.push(`${node.software}${node.version ? ' ' + node.version : ''}`);
        html = `<div class="messenger-identity"><span class="messenger-identity-label">In use</span>`
            + `<span class="messenger-identity-name">${escapeHtml(node.name || 'Propagation node')}</span>`
            + `<code>${escapeHtml(node.hash)}</code></div>`
            + `<div>${escapeHtml(facts.join(', '))}${p.mode !== 'auto' ? ''
                : p.rotate_hours ? ` - most recently heard, changed every ${p.rotate_hours} h` : ' - nearest heard'}.</div>`;
    }
    const aside = Object.keys(p.set_aside || {}).length;
    if (aside && p.mode !== 'off') {
        html += `<div>${aside} node${aside === 1 ? '' : 's'} set aside: did not answer (tried again in at most 30 min).</div>`;
    }
    let line = '';
    if (sync.kind === 'busy') {
        line = `Sync: ${escapeHtml(sync.text)}${sync.progress ? ` (${Math.round(sync.progress * 100)}%)` : ''}…`;
    } else if (sync.kind === 'failed') {
        line = `<span class="settings-warning-inline">Last sync: ${escapeHtml(sync.text)}</span>`;
    } else if (sync.last_sync) {
        const got = sync.kind === 'done' && sync.last_result != null
            ? `, ${sync.last_result} new message${sync.last_result === 1 ? '' : 's'}` : '';
        line = `Last sync ${durationText(Date.now() / 1000 - sync.last_sync)} ago${got}.`;
    } else if (node) {
        line = 'Not synced yet.';
    }
    if (p.ephemeral) {
        line = '<span class="settings-warning-inline">The ephemeral identity is in use: propagation nodes are'
             + ' for saved identities only, nothing is left on a node or collected from one.</span>';
    }
    box.innerHTML = html + (line ? `<div>${line}</div>` : '');
    const now = document.getElementById('messenger-sync-now');
    const cancel = document.getElementById('messenger-sync-cancel');
    if (now) now.disabled = !node || sync.kind === 'busy' || !!p.ephemeral;
    if (cancel) cancel.hidden = sync.kind !== 'busy';
}

async function messengerSyncNow() {
    const data = await fetch('/api/messenger/sync', { method: 'POST' }).then(r => r.json())
        .catch(e => ({ status: 'error', error: e.message }));
    if (data.status !== 'success') {
        showNotification(escapeHtml(data.error || 'Sync failed'), 'error', 5000);
        return;
    }
    showNotification('Asking the propagation node for your messages…', 'info', 3000);
    // Say how it ended: with nothing waiting, nothing else on screen changes.
    const started = Date.now();
    clearInterval(messengerSyncNow.timer);
    messengerSyncNow.timer = setInterval(async () => {
        const p = await fetch('/api/messenger').then(r => r.json()).then(d => d.propagation || {}).catch(() => null);
        const sync = (p && p.sync) || {};
        if (sync.kind === 'busy' && Date.now() - started < 180000) return;
        clearInterval(messengerSyncNow.timer);
        if (sync.kind === 'done') {
            const got = sync.last_result || 0;
            showNotification(got ? `Sync done: ${got} new message${got === 1 ? '' : 's'}`
                                 : 'Sync done: no messages waiting', 'success', 4000);
        } else if (sync.kind === 'failed') {
            showNotification(`Sync: ${escapeHtml(sync.text)}`, 'error', 5000);
        }
    }, 1500);
}

async function messengerSyncCancel() {
    await fetch('/api/messenger/sync/cancel', { method: 'POST' }).catch(() => {});
}

function renderBlockedContacts(blocked) {
    const box = document.getElementById('messenger-blocked');
    if (!box) return;
    if (!blocked.length) {
        box.innerHTML = '<div class="settings-hint">Nobody blocked.</div>';
        return;
    }
    box.innerHTML = blocked.map(b => `
        <div class="hidden-node-row">
            <span class="hidden-node-text">
                <span class="hidden-node-name">${escapeHtml(b.name || 'Unknown')}</span>
                <span class="hidden-node-hash">${escapeHtml(b.address)}</span>
            </span>
            <button class="settings-export hidden-node-restore" data-unblock="${escapeHtml(b.address)}">Unblock</button>
        </div>`).join('');
    box.querySelectorAll('[data-unblock]').forEach(btn => btn.onclick = () => messengerUnblock(btn.dataset.unblock));
}

function renderMessengerStatus() {
    const box = document.getElementById('messenger-status');
    if (!box || !messengerState) return;
    const st = messengerState;
    if (st.error) {
        box.textContent = st.error;
    } else if (!st.running) {
        box.textContent = 'Off: nothing listens on your LXMF address.';
    } else {
        const announced = st.last_announce
            ? `last announce ${new Date(st.last_announce * 1000).toLocaleTimeString()}` : 'not announced yet';
        box.innerHTML = `<div class="messenger-identity${st.ephemeral ? ' ephemeral' : ''}">`
            + `<span class="messenger-identity-label">In use</span>`
            + `<span class="messenger-identity-name">${escapeHtml(st.identity_name)}</span>`
            + `<code>${escapeHtml(st.address)}</code></div>`
            + `<div>${escapeHtml(announced)}${st.ephemeral ? ' - ephemeral: replies are lost when it changes' : ''}.</div>`;
    }
    const button = document.getElementById('messenger-announce-now');
    if (button) button.disabled = !st.running;
}

function readMessengerFields() {
    const enabled = document.getElementById('setting-msg-enabled');
    // Not read from the server (rBrowser restarting, say): nothing is sent,
    // or the defaults of the dialog would switch the messenger off.
    if (!enabled || !enabled.dataset.loaded) return null;
    const on = id => document.getElementById(id).classList.contains('active');
    const pn = {};
    const mode = document.getElementById('setting-msg-pn-mode');
    if (mode && mode.options.length) {
        pn.propagation_mode = on('setting-msg-pn-on') ? mode.value : 'off';
        pn.propagation_fallback = on('setting-msg-pn-fallback');
        pn.propagation_failover = on('setting-msg-pn-failover');
        pn.propagation_rotate_hours = Number(document.getElementById('setting-msg-pn-rotate').value) || 0;
        pn.sync_periodic = on('setting-msg-sync-periodic');
        const minutes = Number(document.getElementById('setting-msg-sync-minutes').value);
        if (minutes) pn.sync_minutes = minutes;
        if (mode.value === 'manual') {
            pn.propagation_node = (document.getElementById('setting-msg-pn-node').value
                || document.getElementById('setting-msg-pn-hash').value).trim().toLowerCase();
        }
    }
    return {
        ...pn,
        enabled: on('setting-msg-enabled'),
        identity: document.getElementById('setting-msg-identity').value,
        display_name: document.getElementById('setting-msg-name').value,
        announce_at_start: on('setting-msg-announce-start'),
        announce_periodic: on('setting-msg-announce-periodic'),
        announce_minutes: Number(document.getElementById('setting-msg-announce-minutes').value),
        allow_ephemeral: on('setting-msg-allow-ephemeral'),
        ...(document.getElementById('setting-msg-stamp-cost').options.length ? {
            stamp_cost: Number(document.getElementById('setting-msg-stamp-cost').value),
            enforce_stamps: on('setting-msg-enforce-stamps'),
            markdown: on('setting-msg-markdown'),
            check_new_contacts: on('setting-msg-check-contacts'),
            sideband_look: on('setting-msg-sideband-look'),
            autosend_files: on('setting-msg-autosend'),
            image_previews: on('setting-msg-previews'),
            autoreply_on: on('setting-msg-autoreply'),
            opportunistic: on('setting-msg-opportunistic'),
            share_contacts: on('setting-msg-share-contacts'),
            autoreply_rules: document.getElementById('setting-msg-rules').value,
            echo_on: on('setting-msg-echo'),
            echo_text: document.getElementById('setting-msg-echo-text').value,
            away_mode: document.getElementById('setting-msg-away-mode').value,
            away_from: document.getElementById('setting-msg-away-from').value,
            away_to: document.getElementById('setting-msg-away-to').value,
            away_text: document.getElementById('setting-msg-away-text').value,
        } : {}),
    };
}

// What the Settings dialog showed when it opened. Save sends only the fields
// changed since: the dialog holds every switch of every client, and saving
// them all wrote back values changed meanwhile elsewhere (the AutoReply menu,
// a client in its own window, another browser) - the RRC echo went off
// when the LXMF one was switched off.
let loadedMessengerSettings = null;

function changedSettings(fields, loaded) {
    if (!fields || !loaded) return fields;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b) || String(a) === String(b);
    return Object.fromEntries(Object.entries(fields).filter(([k, v]) => !(k in loaded) || !same(v, loaded[k])));
}

function saveMessengerSettings(fields) {
    if (!fields || !Object.keys(fields).length) return Promise.resolve();
    return fetch('/api/messenger/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields)
    }).then(r => r.json()).then(state => {
        if (state.status === 'error') throw new Error(state.error);
        messengerState = state;
        // The dialog stays open: the next Save compares with what is saved now.
        if (state.settings) loadedMessengerSettings = JSON.parse(JSON.stringify(state.settings));
        // The Messages tab and the menu entries follow at once.
        if (typeof pollMessenger === 'function') pollMessenger();
    }).catch(err => showNotification(`Messenger settings not saved: ${escapeHtml(err.message)}`, 'error', 6000));
}

async function messengerAnnounceNow() {
    const data = await fetch('/api/messenger/announce', { method: 'POST' }).then(r => r.json())
        .catch(e => ({ status: 'error', error: e.message }));
    if (data.status === 'success') {
        showNotification('LXMF announce sent', 'success', 3000);
        loadMessengerSettings();
    } else {
        showNotification(escapeHtml(data.error || 'Announce failed'), 'error', 5000);
    }
}

// Like Android's developer options: seven taps on the version. Nothing is
// secret about it - the README says what it unlocks.
let aboutTaps = 0;
let aboutTapTimer = null;

// ─── Check for updates (rbrowser/updates.py) ───
// version.txt here against the one on GitHub; at start when switched on
// (remembered in this browser). Newer: a mark on About, and there the
// link and the command (nothing is downloaded or run by rBrowser).
let updateInfo = null;

function updateCheckOn() {
    // On unless switched off: it only reads version.txt on GitHub.
    try { return localStorage.getItem('rbrowser_update_check') !== '0'; } catch (e) { return true; }
}

async function checkForUpdates(force = false) {
    const url = `/api/version?check=1${force ? '&force=1' : ''}`;
    updateInfo = await fetch(url).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
    renderUpdateInfo();
    return updateInfo;
}

// What is new (CHANGELOG.md on GitHub, rbrowser/updates.py changelog_news):
// text from the internet, so escaped, `code` kept as code and nothing else.
function updateNewsHtml(info) {
    const news = Array.isArray(info && info.news) ? info.news : [];
    if (!news.length) return '';
    const text = s => escapeHtml(String(s || '')).replace(/`([^`]+)`/g, '<code>$1</code>');
    return `<div class="update-news">${news.map(s => `
        <div class="update-news-version">v${escapeHtml(String(s.version || ''))}${s.title ? ` <span>${escapeHtml(String(s.title))}</span>` : ''}</div>
        <ul>${(Array.isArray(s.items) ? s.items : []).map(i => `<li>${text(i)}</li>`).join('')}</ul>`).join('')}</div>`;
}

function renderUpdateInfo() {
    const info = updateInfo || {};
    const nav = document.querySelector('.settings-nav-item[data-cat="about"]');
    if (nav) nav.classList.toggle('has-update', !!info.update);
    const version = document.getElementById('settings-version');
    if (version && info.local) version.textContent = `rBrowser v${info.local}`;
    const box = document.getElementById('settings-update');
    if (!box) return;
    if (info.update) {
        box.hidden = false;
        box.innerHTML = `<b>rBrowser v${escapeHtml(info.remote)} is out</b> (you have v${escapeHtml(info.local)}).<br>
            <a href="${escapeHtml(info.repo)}" target="_blank" rel="noopener noreferrer">${escapeHtml(info.repo)}</a><br>
            In the rBrowser folder: <code>${escapeHtml(info.command)}</code>, then restart rBrowser.${updateNewsHtml(info)}
            ${updateNowHtml(info)}`;
        const btn = box.querySelector('.update-now-btn');
        if (btn) btn.onclick = () => confirmSelfUpdate(info);
    } else if (info.checked) {
        box.hidden = false;
        box.textContent = info.status === 'success' ? `Up to date (v${info.local}).` : (info.error || 'Check failed');
    } else {
        box.hidden = true;
    }
}

function setupUpdateSettings() {
    const toggle = document.getElementById('setting-update-check');
    if (toggle) {
        toggle.classList.toggle('active', updateCheckOn());
        toggle.addEventListener('click', () => {
            const on = !toggle.classList.contains('active');
            toggle.classList.toggle('active', on);
            try { localStorage.setItem('rbrowser_update_check', on ? '1' : '0'); } catch (e) {}
        });
    }
    const popup = document.getElementById('setting-update-popup');
    if (popup) {
        popup.classList.toggle('active', updatePopupOn());
        popup.addEventListener('click', () => {
            const on = !popup.classList.contains('active');
            popup.classList.toggle('active', on);
            try { localStorage.setItem('rbrowser_update_popup', on ? '1' : '0'); } catch (e) {}
        });
    }
    const auto = document.getElementById('setting-update-auto');
    if (auto) auto.addEventListener('click', () => {
        const on = !auto.classList.contains('active');
        auto.classList.toggle('active', on);
        try { localStorage.setItem('rbrowser_update_auto', on ? '1' : '0'); } catch (e) {}
        scheduleUpdateAutoCheck();
    });
    const every = document.getElementById('setting-update-every');
    if (every) every.addEventListener('change', () => {
        try { localStorage.setItem('rbrowser_update_every', every.value); } catch (e) {}
        scheduleUpdateAutoCheck();
    });
    const now = document.getElementById('setting-update-now');
    if (now) now.onclick = async () => {
        now.disabled = true;
        const info = await checkForUpdates(true);
        info.checked = true;
        renderUpdateInfo();
        now.disabled = false;
    };
    if (!updateInfo) fetch('/api/version').then(r => r.json()).then(info => {
        if (!updateInfo) { updateInfo = info; renderUpdateInfo(); }
    }).catch(() => {});
    else renderUpdateInfo();
}

async function autoCheckForUpdates() {
    const info = await checkForUpdates(false);
    if (info && info.update && updatePopupOn()) showUpdatePopup(info);
}

// Settings > About > "Auto-check every": a page left open for days still
// hears about a new version. On unless switched off, every 6 hours.
const UPDATE_EVERY_CHOICES = [1, 2, 3, 4, 6, 8, 12];
let updateAutoTimer = null;

function updateAutoOn() {
    try { return localStorage.getItem('rbrowser_update_auto') !== '0'; } catch (e) { return true; }
}

function updateEveryHours() {
    let h = 6;
    try { h = parseInt(localStorage.getItem('rbrowser_update_every'), 10) || 6; } catch (e) {}
    return UPDATE_EVERY_CHOICES.includes(h) ? h : 6;
}

function scheduleUpdateAutoCheck() {
    clearInterval(updateAutoTimer);
    updateAutoTimer = null;
    if (APP_WINDOW || !updateAutoOn()) return;
    updateAutoTimer = setInterval(autoCheckForUpdates, updateEveryHours() * 3600000);
}

window.addEventListener('load', () => {
    if (!APP_WINDOW && updateCheckOn()) setTimeout(autoCheckForUpdates, 5000);
    scheduleUpdateAutoCheck();
});

// Settings > About > "Tell me in a window": on unless switched off.
function updatePopupOn() {
    try { return localStorage.getItem('rbrowser_update_popup') !== '0'; } catch (e) { return true; }
}

// Once per new version: closing it is enough until the next one.
function showUpdatePopup(info) {
    try { if (localStorage.getItem('rbrowser_update_told') === info.remote) return; } catch (e) {}
    if (document.querySelector('.update-popup')) return;   // still open from the last check
    const overlay = document.createElement('div');
    overlay.className = 'auto-reload-modal update-popup';
    overlay.innerHTML = `<div class="auto-reload-dialog msg-warn-dialog">
        <div class="dialog-header"><h3>rBrowser v${escapeHtml(info.remote)} is out</h3></div>
        <div class="settings-hint">You have v${escapeHtml(info.local)}. In the rBrowser folder:
            <code>${escapeHtml(info.command)}</code>, then restart rBrowser.${updateNewsHtml(info)}</div>
        <div class="auto-reload-actions">
            <button class="btn-cancel">Later</button>
            <a class="btn-save" href="${escapeHtml(info.repo)}" target="_blank" rel="noopener noreferrer">Open GitHub</a>
            ${selfUpdateCan(info) ? '<button class="btn-save update-now-btn">Update now</button>' : ''}
        </div></div>`;
    const done = () => {
        overlay.remove();
        try { localStorage.setItem('rbrowser_update_told', info.remote); } catch (e) {}
    };
    overlay.querySelector('.btn-cancel').onclick = done;
    overlay.querySelector('a.btn-save').addEventListener('click', done);
    const now = overlay.querySelector('.update-now-btn');
    if (now) now.onclick = () => { done(); confirmSelfUpdate(info); };
    overlay.addEventListener('click', e => { if (e.target === overlay) done(); });
    document.body.appendChild(overlay);
}

// ─── Update now (rbrowser/selfupdate.py) ───
// git pull in the rBrowser folder, then the usual restart (doRestart). Only
// for a git clone with git installed; otherwise the reason is shown and the
// update stays by hand.
function selfUpdateCan(info) {
    return !!(info && info.update && info.self_update && info.self_update.can);
}

function updateNowHtml(info) {
    const s = info && info.self_update;
    if (!s) return '';
    if (s.can) return '<button class="settings-export update-now-btn" type="button">Update now</button>';
    return `<div class="settings-hint update-now-off">Update now: ${escapeHtml(s.reason || 'not available here')}</div>`;
}

function confirmSelfUpdate(info) {
    const restart = !!(info.self_update && info.self_update.can_restart);
    const overlay = document.createElement('div');
    overlay.className = 'auto-reload-modal choice-modal';
    overlay.innerHTML = `<div class="auto-reload-dialog choice-dialog">
        <h3>Update to rBrowser v${escapeHtml(info.remote)}?</h3>
        <div class="choice-body">rBrowser downloads the new version with <code>git pull</code>${restart
            ? ' and then <strong>restarts by itself</strong>. Open chats, transfers and downloads are interrupted.'
            : '. It cannot restart itself here (started by waitress-serve or as a service): restart it by hand afterwards.'}
            Your identities, settings and messages stay.</div>
        <div class="auto-reload-actions">
            <button class="btn-cancel">Cancel</button>
            <button class="btn-save">${restart ? 'Update and restart' : 'Update'}</button>
        </div></div>`;
    overlay.querySelector('.btn-cancel').onclick = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.btn-save').onclick = () => { overlay.remove(); runSelfUpdate(restart); };
    document.body.appendChild(overlay);
}

async function runSelfUpdate(restart) {
    // Blocks the page: no click goes through until it is over.
    const overlay = document.createElement('div');
    overlay.className = 'auto-reload-modal choice-modal restart-overlay';
    overlay.innerHTML = `<div class="auto-reload-dialog choice-dialog">
        <h3>Updating rBrowser…</h3>
        <div class="update-progress"><div></div></div>
        <div class="choice-body" id="update-status">Starting git pull.</div>
        <div class="auto-reload-actions" hidden><button class="btn-save">Close</button></div>
        </div>`;
    document.body.appendChild(overlay);
    const bar = overlay.querySelector('.update-progress > div');
    const status = overlay.querySelector('#update-status');
    const actions = overlay.querySelector('.auto-reload-actions');
    const finish = html => {
        status.innerHTML = html;
        actions.hidden = false;
        actions.querySelector('button').onclick = () => overlay.remove();
    };

    try {
        const data = await fetch('/api/update/start', { method: 'POST' }).then(r => r.json());
        if (data.status !== 'success') throw new Error(data.error || 'Refused');
    } catch (e) {
        finish(`The update could not start: ${escapeHtml(e.message)}`);
        return;
    }

    const started = Date.now();
    let s = {};
    while (Date.now() - started < 360000) {
        await new Promise(r => setTimeout(r, 400));
        try { s = await fetch('/api/update/status', { cache: 'no-store' }).then(r => r.json()); } catch (e) { continue; }
        const pct = Math.max(0, Math.min(100, Number(s.percent) || 0));
        bar.style.width = `${pct}%`;
        if (s.state === 'running') {
            status.textContent = `${s.phase || 'Downloading'}: ${pct}%`;
            continue;
        }
        break;
    }

    if (s.state === 'error') return finish(escapeHtml(s.error || 'The update failed'));
    if (s.state !== 'done') return finish('No answer from git pull: look at the rBrowser console.');
    bar.style.width = '100%';
    if (!s.updated) return finish('Already up to date: nothing to download.');
    if (s.requirements) {
        return finish(`Downloaded. This version needs new Python packages: stop rBrowser, run
            <code>pip install -r requirements.txt</code> (or <code>install.bat</code> /
            <code>bash install.sh</code>) in its folder, then start it again.`);
    }
    if (!restart) return finish('Downloaded. Restart rBrowser to use the new version.');
    overlay.remove();
    doRestart(location.origin, location.origin);
}

// rBrowser's version on the empty pages of the clients (version.txt, via
// /api/version): "rBrowser v2.0.0" and the client's name under it, as its title.
let RB_VERSION = '2.0.3b';

function clientWelcome(icon, name) {
    return `<div class="client-welcome"><h2 class="rb-version">rBrowser v${RB_VERSION}</h2>
        <span class="bbs-title">${icon}<span>${name}</span></span></div>`;
}

fetch('/api/version').then(r => r.json()).then(info => {
    if (!info || !info.local || info.local === '?') return;
    RB_VERSION = info.local;
    document.querySelectorAll('.rb-version').forEach(el => { el.textContent = `rBrowser v${RB_VERSION}`; });
}).catch(() => {});

function aboutVersionTap() {
    if (messengerState && messengerState.settings && messengerState.settings.advanced_unlocked) {
        showNotification('Advanced options are already shown', 'info', 2500);
        return;
    }
    aboutTaps += 1;
    clearTimeout(aboutTapTimer);
    aboutTapTimer = setTimeout(() => { aboutTaps = 0; }, 3000);
    const left = 7 - aboutTaps;
    if (left > 0) {
        if (aboutTaps >= 3) showNotification(`${left} more tap${left === 1 ? '' : 's'} to show Advanced options`, 'info', 1200);
        return;
    }
    aboutTaps = 0;
    saveMessengerSettings({ advanced_unlocked: true }).then(() => {
        showNotification('Advanced options are now shown in Settings', 'success', 4000);
        loadMessengerSettings();
    });
}

function lockAdvanced() {
    saveMessengerSettings({ advanced_unlocked: false }).then(() => {
        showNotification('Advanced options hidden; ephemeral messages are off again', 'info', 4000);
        loadMessengerSettings();
    });
}

// ─────────────────────────────────────────────────────────────
// Visited page cache
// ─────────────────────────────────────────────────────────────

function loadCacheSettings() {
    const searchIn = document.getElementById('setting-search-in');
    if (searchIn) searchIn.value = cacheSearchMode();
    fetch('/api/cache/stats')
        .then(r => r.json())
        .then(info => {
            const settings = info.settings || {};
            const setToggle = (id, on) => {
                const el = document.getElementById(id);
                if (el) el.classList.toggle('active', !!on);
            };
            const setSelect = (id, value) => {
                const el = document.getElementById(id);
                if (!el) return;
                const wanted = String(value);
                // A value saved by hand in the settings file may not be one
                // of the offered steps; show it rather than silently
                // snapping to the first option.
                if (![...el.options].some(o => o.value === wanted)) {
                    el.add(new Option(wanted, wanted));
                }
                el.value = wanted;
            };

            setToggle('setting-cache-enabled', settings.enabled !== false);
            setToggle('setting-cache-serve', settings.serve_from_cache !== false);
            setSelect('setting-cache-age', settings.max_age_days ?? 30);
            setSelect('setting-cache-size', settings.max_total_mb ?? 50);
            const enabledToggle = document.getElementById('setting-cache-enabled');
            if (enabledToggle) enabledToggle.dataset.loaded = '1';

            const stats = document.getElementById('cache-stats');
            if (stats) {
                stats.textContent = info.pages
                    ? `${info.pages} page${info.pages === 1 ? '' : 's'} from `
                      + `${info.nodes} node${info.nodes === 1 ? '' : 's'}, `
                      + formatFileSize(info.bytes)
                    : 'Nothing stored yet.';
            }
        })
        .catch(err => {
            const stats = document.getElementById('cache-stats');
            if (stats) stats.textContent = `Could not read the cache: ${err.message}`;
        });
}

function saveCacheSettings() {
    // Fields never filled from the server hold the dialog's defaults
    // (cache off, 5 MB): saving them would overwrite the real settings.
    if (!document.getElementById('setting-cache-enabled')?.dataset.loaded) return Promise.resolve();
    const toggleOn = id => {
        const el = document.getElementById(id);
        return el ? el.classList.contains('active') : undefined;
    };
    const selectValue = id => {
        const el = document.getElementById(id);
        return el ? parseInt(el.value, 10) : undefined;
    };

    const payload = {};
    const enabled = toggleOn('setting-cache-enabled');
    const serve = toggleOn('setting-cache-serve');
    const age = selectValue('setting-cache-age');
    const size = selectValue('setting-cache-size');

    if (enabled !== undefined) payload.enabled = enabled;
    if (serve !== undefined) payload.serve_from_cache = serve;
    if (age !== undefined && !isNaN(age)) payload.max_age_days = age;
    if (size !== undefined && !isNaN(size)) payload.max_total_mb = size;
    if (!Object.keys(payload).length) return Promise.resolve();

    return fetch('/api/cache/settings', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    }).catch(err => {
        showNotification(`Could not save the cache settings: ${err.message}`, 'error', 5000);
    });
}

// ─────────────────────────────────────────────────────────────
// Search over what has been visited
//
// This is what replaced the crawler. Version 1 shipped a spider that
// walked the network looking for pages, which on a LoRa segment means
// spending other people's airtime without asking. This searches the pages
// that are already on this disk because somebody here opened them, and it
// cannot reach the network at all.
// ─────────────────────────────────────────────────────────────

function closeCacheSearch() {
    const modal = document.getElementById('cache-search-modal');
    if (modal) modal.remove();
}

// Settings > NomadNet Browser > Visited pages: the Local Search Engine in
// a window over the page (default) or in a tab of its own. Kept on the
// server: localStorage is per address (127.0.0.1, rbrowser.local, the
// tunnel...), so the choice seemed forgotten.
let cacheSearchInTab = null;
fetch('/api/cache/settings').then(r => r.json()).then(s => { cacheSearchInTab = !!s.search_in_tab; }).catch(() => {});

function cacheSearchMode() {
    if (cacheSearchInTab !== null) return cacheSearchInTab ? 'tab' : 'modal';
    try { return localStorage.getItem('rbrowser_search_in') === 'tab' ? 'tab' : 'modal'; } catch (e) { return 'modal'; }
}

function setCacheSearchMode(mode) {
    cacheSearchInTab = mode === 'tab';
    try { localStorage.setItem('rbrowser_search_in', mode === 'tab' ? 'tab' : 'modal'); } catch (e) { /* only now */ }
    fetch('/api/cache/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ search_in_tab: cacheSearchInTab }) })
        .catch(err => showNotification(`Not saved: ${escapeHtml(err.message)}`, 'error', 5000));
}

// The search in a tab: one tab, found again on the next search; the
// pages found open in a new tab, the search stays.
// How many results at most (Local Search Engine): 0 = all. This browser only.
function cacheSearchMax() {
    try { const v = localStorage.getItem('rbrowser_search_max'); return v === null ? 50 : Number(v) || 0; } catch (e) { return 50; }
}

const CACHE_SEARCH_CONTROLS = `
        <div class="cache-search-bar">
            <div class="msg-search-box">
                <input type="text" id="cache-search-input" class="cache-search-input"
                       placeholder="Words, a node name, an operator, a hash or a page path" autocomplete="off">
                <button class="search-clear msg-search-clear" id="cache-search-clear" type="button" hidden
                        title="Clear the search" aria-label="Clear the search">×</button>
            </div>
            <button class="btn-save" id="cache-search-go">Search</button>
        </div>
        <div class="cache-search-options">
            <label class="cache-search-exact"><input type="checkbox" id="cache-search-whole"> whole words only</label>
            <label class="cache-search-exact" title="How many results to show at most">show
                <select id="cache-search-max" class="settings-select">
                    <option value="25">25</option><option value="50">50</option><option value="100">100</option>
                    <option value="200">200</option><option value="0">all</option>
                </select></label>
        </div>`;

// The search box searches while you type (a moment after the last key),
// Enter or Search at once.
function bindCacheSearch(root, query) {
    const input = root.querySelector('#cache-search-input');
    const whole = root.querySelector('#cache-search-whole');
    const max = root.querySelector('#cache-search-max');
    max.value = String(cacheSearchMax());
    if (!max.value) max.value = '50';
    const run = () => { clearTimeout(bindCacheSearch.timer); runCacheSearch(input.value, whole.checked); };
    root.querySelector('#cache-search-go').addEventListener('click', run);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    const clear = root.querySelector('#cache-search-clear');
    const showClear = () => { clear.hidden = !input.value; };
    input.addEventListener('input', () => {
        showClear();
        clearTimeout(bindCacheSearch.timer);
        bindCacheSearch.timer = setTimeout(run, 350);
    });
    clear.addEventListener('click', () => { input.value = ''; showClear(); run(); input.focus(); });
    whole.addEventListener('change', run);
    max.addEventListener('change', () => {
        try { localStorage.setItem('rbrowser_search_max', max.value); } catch (e) { /* only now */ }
        run();
    });
    input.value = typeof query === 'string' ? query : '';
    showClear();
    input.focus();
    runCacheSearch(input.value, false);
}

// The tab's search fits the window: only the results scroll.
function fitSearchTab() {
    document.querySelectorAll('.cache-search-page').forEach(page => {
        if (!page.offsetParent) return;
        const top = page.getBoundingClientRect().top;
        const bar = document.querySelector('.shortcuts-bar');
        const bottom = bar && bar.offsetParent ? bar.getBoundingClientRect().top : window.innerHeight;
        page.style.height = `${Math.max(240, bottom - top - 8)}px`;
    });
}
window.addEventListener('resize', fitSearchTab);

function openSearchTab(query = '') {
    closeSettings();
    closeCacheSearch();
    let tab = tabs.find(t => t.isSearch && !t.currentUrl);
    if (tab) switchToTab(tab.id);
    else {
        tab = getActiveTab();
        if (!(tab && tab.title === 'New Tab' && !tab.currentUrl)) tab = createNewTab();
        tab.isSearch = true;
        tab.title = 'Search Engine';
        tab.updateTabDisplay();
    }
    const page = document.querySelector(`#${tab.id} .page-content`);
    if (!page) return;
    // The tab may have held a Micron page: its measured width (--layout-w)
    // and zoom stayed on the box and, with Center on, squeezed the search
    // into a 249px strip.
    page.removeAttribute('style');
    page.removeAttribute('data-has-prose');
    page.innerHTML = `<div class="cache-search-page">
        <h2>Local Search Engine</h2>
        <div class="settings-hint">Searches text, titles, node names, hashes, operators and paths of
            visited pages. Nothing is fetched from the network. Results open in a new tab.</div>
        ${CACHE_SEARCH_CONTROLS}
        <div class="cache-search-results" id="cache-search-results">Loading...</div>
    </div>`;
    bindCacheSearch(page, query);
    requestAnimationFrame(fitSearchTab);
}

function showCacheSearch(query = '') {
    if (cacheSearchMode() === 'tab') { openSearchTab(query); return; }
    closeSettings();
    closeCacheSearch();

    const overlay = document.createElement('div');
    overlay.className = 'auto-reload-modal';
    overlay.id = 'cache-search-modal';

    const dialog = document.createElement('div');
    dialog.className = 'auto-reload-dialog cache-search-dialog';
    dialog.innerHTML = `
        <div class="dialog-header">
            <h3>Local Search Engine</h3>
            <button class="modal-close" onclick="closeCacheSearch()" title="Close" aria-label="Close">&times;</button>
        </div>
        <div class="settings-hint">Searches text, titles, node names, hashes, operators and paths of
            visited pages. Nothing is fetched from the network.</div>
        ${CACHE_SEARCH_CONTROLS}
        <div class="cache-search-results" id="cache-search-results">Loading...</div>
        <div class="auto-reload-actions">
            <button class="btn-cancel" onclick="closeCacheSearch()">Close</button>
        </div>
    `;

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCacheSearch(); });
    document.body.appendChild(overlay);

    // Opened from the sidebar search with its words already in.
    bindCacheSearch(dialog, query);
}

// The words a result is marked up against. Normalised exactly as the
// server normalises them, so what gets highlighted is what actually
// matched - a hash pasted as <5f:a6:...> is searched, and highlighted, as
// bare hex.
function searchWords(query) {
    return (query || '')
        .replace(/[<>:]/g, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Escape and highlight in one pass.
//
// Escaping first and then inserting <mark> around matches would be wrong:
// after escaping, a search for "amp" would find the middle of "&amp;" and
// split an entity in half. So the raw text is walked, each span between
// matches is escaped on its way into the output, and the markup is only
// ever added at boundaries the search really found.
function highlightMatches(text, words, wholeWords) {
    const raw = String(text == null ? '' : text);
    if (!raw) return '';
    if (!words || !words.length) return escapeHtml(raw);

    const alternation = words.map(escapeRegex).join('|');
    const pattern = wholeWords
        ? new RegExp(`\\b(${alternation})\\b`, 'gi')
        : new RegExp(`(${alternation})`, 'gi');

    let out = '';
    let last = 0;
    let match;

    while ((match = pattern.exec(raw)) !== null) {
        if (match[0].length === 0) {        // never loop forever on an empty match
            pattern.lastIndex++;
            continue;
        }
        out += escapeHtml(raw.slice(last, match.index));
        out += `<mark class="search-hit">${escapeHtml(match[0])}</mark>`;
        last = match.index + match[0].length;
    }

    return out + escapeHtml(raw.slice(last));
}

function runCacheSearch(query, wholeWords) {
    const box = document.getElementById('cache-search-results');
    if (!box) return;
    // Typing fast: only the last search draws its answer.
    const ask = runCacheSearch.seq = (runCacheSearch.seq || 0) + 1;
    if (!box.querySelector('.cache-hit')) box.textContent = 'Searching...';

    const trimmed = (query || '').trim();
    const limit = cacheSearchMax();
    // In a tab there is room: longer snippets.
    const span = box.closest('.cache-search-page') ? 320 : 160;
    // An empty box is not an empty search: it means "show me everything I
    // have read", which is the history view.
    const url = trimmed
        ? `/api/cache/search?q=${encodeURIComponent(trimmed)}&limit=${limit}&span=${span}`
          + (wholeWords ? '&exact=1' : '')
        : `/api/cache/pages?limit=${limit}`;

    fetch(url)
        .then(r => r.json())
        .then(data => {
            if (!document.getElementById('cache-search-results') || ask !== runCacheSearch.seq) return;
            const results = data.results || [];
            const total = data.total || results.length;

            if (!results.length) {
                box.innerHTML = trimmed
                    ? `<div class="cache-search-empty">Nothing stored here matches
                       "${escapeHtml(trimmed)}". Only pages you have already
                       opened can be found.</div>`
                    : `<div class="cache-search-empty">No pages stored yet. Visit
                       a few and they will show up here.</div>`;
                return;
            }

            // Which field each hit matched on, so a result that looks
            // unrelated to the query explains itself instead of looking
            // like a bug.
            const fieldLabels = {
                title: 'title',
                node_name: 'node name',
                operator_name: 'operator',
                operator_lxmf_address: 'operator address',
                path: 'path',
                node_hash: 'hash',
                content: 'page text'
            };

            const words = searchWords(trimmed);
            const mark = text => highlightMatches(text, words, wholeWords);

            box.innerHTML = results.map(hit => {
                const target = `${hit.node_hash}:${hit.path}`;
                const name = hit.node_name || hit.node_hash.slice(0, 16);
                const title = hit.title || hit.path;
                const age = hit.cached_at
                    ? formatAge((Date.now() / 1000) - hit.cached_at) : '';
                const operator = hit.operator_name
                    ? `<span class="cache-hit-operator" title="Node operator">✉ ${mark(hit.operator_name)}</span>`
                    : '';
                const matched = (hit.matched || [])
                    .map(f => fieldLabels[f] || f)
                    .join(', ');
                const why = matched
                    ? `<span class="cache-hit-why" title="Where the search matched">matched: ${escapeHtml(matched)}</span>`
                    : '';
                return `
                    <div class="cache-hit" onclick="openCachedPage('${jsAttr(target)}')"
                         title="Open ${escapeHtml(target)}">
                        <div class="cache-hit-title">${mark(title)}</div>
                        <div class="cache-hit-meta">
                            <span class="cache-hit-node">${mark(name)}</span>
                            ${operator}
                            <span class="cache-hit-path">${mark(hit.path)}</span>
                            <span class="cache-hit-age">${escapeHtml(age)}</span>
                            <span class="cache-hit-size">${formatFileSize(hit.size || 0)}</span>
                            ${why}
                        </div>
                        ${hit.snippet ? `<div class="cache-hit-snippet">${mark(hit.snippet)}</div>` : ''}
                    </div>`;
            }).join('');

            const header = document.createElement('div');
            header.className = 'cache-search-count';
            header.textContent = (total > results.length ? `${results.length} of ${total} pages` : `${results.length} page${results.length === 1 ? '' : 's'}`)
                               + (trimmed ? ' found' : ' stored')
                               + (total > results.length ? ' - "show" for more' : '');
            box.insertBefore(header, box.firstChild);
        })
        .catch(err => {
            if (box) box.textContent = `Search failed: ${err.message}`;
        });
}

function openCachedPage(url) {
    // From the search tab: a new tab, the search stays where it is.
    if (!document.getElementById('cache-search-modal')) { openQuickAddress(url, null, true); return; }
    closeCacheSearch();
    const addressBar = document.querySelector(`#${activeTabId} .address-bar`);
    if (addressBar) addressBar.value = url;
    navigateToUrlInternalTab(url, true);
}

function clearPageCache() {
    if (!confirm('Delete every page stored on disk?\n\n'
               + 'They are only copies - any page you visit again will be '
               + 'fetched from its node and stored once more. What you lose '
               + 'is the ability to search and read them offline.')) return;

    fetch('/api/cache/clear', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({})
    })
        .then(r => r.json())
        .then(result => {
            showNotification(`Deleted ${result.removed} stored page`
                             + (result.removed === 1 ? '' : 's'), 'success', 3000);
            loadCacheSettings();
        })
        .catch(err => showNotification(`Could not clear the cache: ${err.message}`,
                                       'error', 5000));
}

// ─────────────────────────────────────────────────────────────
// Settings: identities
// ─────────────────────────────────────────────────────────────

function identityValueRow(label, value) {
    // Hashes are hex, so they are safe inside the attribute as they are.
    const hex = String(value || '').replace(/[^0-9a-f]/gi, '');
    return `
        <div class="identity-row">
            <span class="identity-label">${label}</span>
            <span class="identity-value mono" onclick="copyText('${hex}')"
                  title="Click to copy">${hex}</span>
        </div>`;
}

function renderIdentitySettings() {
    const body = document.getElementById('identity-body');
    if (!body) return;
    const s = identityState;
    if (!s) { body.textContent = 'Loading...'; return; }

    const profileRows = s.profiles.map(p => {
        const inUse = p.id === s.active;
        const tags = (p.is_default ? ' <span class="identity-tag">default</span>' : '')
                   + (inUse ? ' <span class="identity-tag in-use">in use</span>' : '')
                   + (p.loadable ? '' : ' <span class="identity-tag bad">unreadable</span>');
        return `
            <div class="identity-profile ${inUse ? 'current' : ''}">
                <div class="identity-profile-main">
                    <span class="identity-profile-name">${escapeHtml(p.name)}${tags}</span>
                    <span class="identity-profile-addr mono" onclick="copyText('${p.lxmf_address}')"
                          title="LXMF address - click to copy">${p.lxmf_address || ''}</span>
                </div>
                <div class="identity-profile-actions">
                    ${!inUse && p.loadable ? `<button onclick="useIdentity('${p.id}')">Use</button>` : ''}
                    <button onclick="renameIdentity('${p.id}')">Rename</button>
                    <button onclick="window.location='/api/identities/${p.id}/export'"
                            title="Download the key file (a private key)">Export</button>
                    ${!p.is_default && !inUse
                        ? `<button class="danger" onclick="deleteIdentity('${p.id}')">Delete</button>` : ''}
                </div>
            </div>`;
    }).join('');

    const eph = s.ephemeral;
    const usedNames = eph.used_on.map(u => escapeHtml(u.node_name || u.node.slice(0, 16))).join(', ');
    const saved = s.profiles.find(p => !p.is_default);
    const folder = saved
        ? `<code>${escapeHtml(saved.file_path.replace(/[\\/][^\\/]+$/, ''))}</code>`
        : 'the <code>identities</code> folder';

    body.innerHTML = `
        <div class="settings-row">
            <span>Saved identity in use</span>
            <select id="identity-active" class="settings-select" onchange="useIdentity(this.value)"
                    ${s.ephemeral_on ? 'disabled title="Switch ephemeral off to choose a saved identity"' : ''}>
                ${s.profiles.map(p => `<option value="${p.id}" ${p.loadable ? '' : 'disabled'}>${escapeHtml(p.name)}</option>`).join('')}
            </select>
        </div>
        ${s.ephemeral_on ? `<div class="settings-hint settings-warning-inline" style="margin-top: 6px;">
            Ephemeral identity in use: the details below are temporary.</div>` : ''}
        <div style="margin-top: 8px;">
            ${identityValueRow('LXMF address', s.active_identity.lxmf_address)}
            ${identityValueRow('Identity hash', s.active_identity.identity_hash)}
        </div>

        <div class="identity-subhead">Saved identities</div>
        ${profileRows}
        <div class="settings-row settings-cache-buttons">
            <button class="settings-export" onclick="createIdentity()">New identity</button>
            <button class="settings-export" onclick="importIdentity()">Import identity file</button>
            <button class="settings-export" onclick="window.location='/api/identities/export-all'"
                    title="Download every saved identity in one zip (private keys)">Export all</button>
        </div>

        <div class="identity-subhead">Ephemeral</div>
        <div class="settings-hint">A temporary identity kept in memory only. Use Keep to save it;
            once replaced it cannot be recovered.</div>
        <div class="settings-row">
            <span>Use ephemeral identity</span>
            <div class="toggle-switch ${s.ephemeral_on ? 'active' : ''}" id="ephemeral-switch"
                 onclick="toggleEphemeral(!identityState.ephemeral_on)">
                <div class="toggle-slider"></div>
            </div>
        </div>
        <div class="settings-hint" style="margin-top: 6px;">${s.ephemeral_on
            ? `Saved identities are paused. Turn off to return to <strong>${escapeHtml(s.last_fixed_name)}</strong>.`
            : 'Turn on to browse with a temporary identity.'}</div>
        <div class="settings-row">
            <span>Replace</span>
            <select id="ephemeral-mode" class="settings-select" onchange="setEphemeralMode(this.value)">
                <option value="session">At every rBrowser start</option>
                <option value="reload">At every page reload</option>
                <option value="timed">Timed</option>
            </select>
        </div>
        ${s.ephemeral_mode === 'timed' ? `
        <div class="settings-row">
            <span>Interval</span>
            <select id="ephemeral-interval" class="settings-select" onchange="setEphemeralInterval(this.value)">
                ${(s.ephemeral_intervals || []).map(v => `<option value="${v}">${formatInterval(v)}</option>`).join('')}
            </select>
        </div>` : ''}
        <div class="settings-hint" style="margin-top: 6px;">${{
            session: 'Replaced each time rBrowser starts.',
            reload: 'Replaced when you press Reload (Alt+B). Following links keeps it.',
            timed: (s.ephemeral_on && s.ephemeral_rotates_in !== null
                    ? `Next change at ${new Date(Date.now() + s.ephemeral_rotates_in * 1000).toLocaleTimeString()}. `
                    : 'Replaced automatically at the set interval. ')
                   + 'Open pages are not reloaded.',
        }[s.ephemeral_mode] || ''}</div>
        ${identityValueRow('LXMF address', eph.lxmf_address)}
        ${identityValueRow('Identity hash', eph.identity_hash)}
        <div class="identity-row">
            <span class="identity-label">Identified to</span>
            <span class="identity-value">${usedNames || 'no node yet'}</span>
        </div>
        <div class="settings-row settings-cache-buttons">
            <button class="settings-export" onclick="keepEphemeral()">Keep as saved identity</button>
            <button class="settings-export" onclick="rotateEphemeral()">New ephemeral now</button>
        </div>

        <div class="settings-hint settings-warning">Identity files are private keys. Back them up and never share them.
            Default: <code>nomadnet_browser_identity</code>. Others: ${folder}.</div>`;

    body.querySelector('#identity-active').value = s.ephemeral_on ? s.last_fixed : s.active;
    body.querySelector('#ephemeral-mode').value = s.ephemeral_mode;
    const interval = body.querySelector('#ephemeral-interval');
    if (interval) interval.value = String(s.ephemeral_interval);
    renderAutoIdentifySettings();
}

function renderAutoIdentifySettings() {
    const body = document.getElementById('autoid-body');
    if (!body || !identityState) return;
    const s = identityState;

    const choices = s.profiles.filter(p => p.loadable)
        .map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    const rows = s.bindings.map(b => `
        <div class="identity-binding">
            <span class="binding-node" title="${b.node}">${escapeHtml(b.node_name || b.node.slice(0, 16) + '…')}</span>
            <select class="settings-select" data-node="${b.node}"
                    onchange="setBinding('${b.node}', this.value)">
                ${b.profile_id === 'ephemeral' ? '<option value="ephemeral">Ephemeral (not kept)</option>' : ''}
                ${choices}
            </select>
            <button class="binding-forget" onclick="setBinding('${b.node}', '')"
                    title="Forget this node">&times;</button>
        </div>`).join('');

    body.innerHTML = `
        <div class="settings-row">
            <span>Identify automatically to known nodes</span>
            <div class="toggle-switch ${s.auto_identify ? 'active' : ''}" onclick="toggleAutoIdentify()">
                <div class="toggle-slider"></div>
            </div>
        </div>
        <div class="settings-hint" style="margin-top: 8px;">Identifies automatically to nodes you have identified to before, with
            the identity you used there first. Asks before switching identity.</div>
        ${rows || '<div class="settings-hint">No nodes yet.</div>'}
        ${rows ? '<button class="settings-export" onclick="forgetIdentifiedNodes()">Forget all remembered nodes</button>' : ''}`;

    body.querySelectorAll('select[data-node]').forEach(select => {
        const binding = s.bindings.find(b => b.node === select.dataset.node);
        if (binding) select.value = binding.profile_id;
    });
}

// The ephemeral switch: on uses the throwaway identity, off goes back to the
// saved identity that was in use before (the server remembers which).
async function toggleEphemeral(on) {
    try {
        const state = await identityRequest('/api/identities/ephemeral/toggle', { on: !!on });
        showNotification(on
            ? 'Ephemeral on.'
            : `Ephemeral off: <strong>${escapeHtml(state.active_name)}</strong> in use.`,
            'success', 4000);
    } catch (e) {
        showNotification(`Could not switch: ${escapeHtml(e.message)}`, 'error', 5000);
        renderIdentitySettings();
    }
}

async function useIdentity(id) {
    if (!identityState || id === identityState.active) return;
    if (id !== 'ephemeral') {
        const target = identityState.profiles.find(p => p.id === id);
        if (!target) return;
    }
    try {
        await identityRequest('/api/identities/active', { id });
        showNotification(`Now using <strong>${escapeHtml(identityLabel())}</strong>.<br>`
            + 'Nodes you were identified to with the previous identity see you as anonymous until you identify again.',
            'success', 5000);
    } catch (e) {
        showNotification(`Could not switch identity: ${escapeHtml(e.message)}`, 'error', 5000);
        renderIdentitySettings();
    }
}

async function createIdentity() {
    const name = await askText('New identity',
        'A new key, created now and saved with the others. To a node it is a brand new user.',
        '', 'Create');
    if (name === null) return;
    try {
        const state = await identityRequest('/api/identities/create', { name });
        const created = state.profiles.find(p => p.id === state.created);
        showNotification(`Created <strong>${escapeHtml(created ? created.name : name)}</strong>. `
                         + 'Select it under "Identity in use" to start using it.', 'success', 4500);
    } catch (e) {
        showNotification(`Could not create the identity: ${escapeHtml(e.message)}`, 'error', 5000);
    }
}

function importIdentity() {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.onchange = async () => {
        const file = picker.files && picker.files[0];
        if (!file) return;
        const name = await askText('Import identity',
            `From <code>${escapeHtml(file.name)}</code>. Any RNS identity file works,
             for instance one exported from NomadNet or MeshChat.`,
            file.name.replace(/\.[^.]*$/, '').slice(0, 40), 'Import');
        if (name === null) return;
        const form = new FormData();
        form.append('file', file);
        form.append('name', name);
        try {
            await identityRequest('/api/identities/import', form, true);
            showNotification('Identity imported', 'success', 3000);
        } catch (e) {
            showNotification(`Could not import: ${escapeHtml(e.message)}`, 'error', 5000);
        }
    };
    picker.click();
}

async function renameIdentity(id) {
    const profile = identityState && identityState.profiles.find(p => p.id === id);
    if (!profile) return;
    const name = await askText('Rename identity', 'Only you see this name.', profile.name, 'Rename');
    if (name === null || !name) return;
    try {
        await identityRequest(`/api/identities/${id}/rename`, { name });
    } catch (e) {
        showNotification(`Could not rename: ${escapeHtml(e.message)}`, 'error', 5000);
    }
}

async function deleteIdentity(id) {
    const profile = identityState && identityState.profiles.find(p => p.id === id);
    if (!profile) return;
    const choice = await showChoiceDialog({
        title: 'Delete identity?',
        html: `<strong>${escapeHtml(profile.name)}</strong> and its key file will be deleted.
               Accounts made with it on any node are lost for good, unless you exported
               the file first.`,
        buttons: [{ label: 'Cancel', value: null },
                  { label: 'Export first', value: 'export' },
                  { label: 'Delete', value: 'delete', danger: true }]
    });
    if (choice === 'export') { window.location = `/api/identities/${id}/export`; return; }
    if (choice !== 'delete') return;
    try {
        await identityRequest(`/api/identities/${id}/delete`);
        showNotification(`Deleted ${escapeHtml(profile.name)}`, 'success', 3000);
    } catch (e) {
        showNotification(`Could not delete: ${escapeHtml(e.message)}`, 'error', 5000);
    }
}

async function setEphemeralMode(mode) {
    try {
        await identityRequest('/api/identities/options', { ephemeral_mode: mode });
    } catch (e) {
        showNotification(`Could not save: ${escapeHtml(e.message)}`, 'error', 5000);
    }
}

async function setEphemeralInterval(seconds) {
    try {
        await identityRequest('/api/identities/options', { ephemeral_interval: Number(seconds) });
    } catch (e) {
        showNotification(`Could not save: ${escapeHtml(e.message)}`, 'error', 5000);
    }
}

// 30 -> "30 s", 300 -> "5 min", 3600 -> "1 h", 95 -> "1 min 35 s".
function formatInterval(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    if (seconds < 60) return `${seconds} s`;
    if (seconds % 3600 === 0) return `${seconds / 3600} h`;
    const m = Math.floor(seconds / 60), s = seconds % 60;
    return s ? `${m} min ${s} s` : `${m} min`;
}

// Timed ephemeral: the server changes the identity on its own. Read the
// new state when it is due, so the identity button and settings show the
// new one. Only that: the page is not reloaded.
function scheduleEphemeralCheck() {
    clearTimeout(scheduleEphemeralCheck.timer);
    const s = identityState;
    if (!s || s.ephemeral_rotates_in === null || s.ephemeral_rotates_in === undefined) return;
    scheduleEphemeralCheck.timer = setTimeout(async () => {
        const before = identityState && identityState.active_identity.identity_hash;
        await loadIdentityState();
        const after = identityState && identityState.active_identity.identity_hash;
        if (before && after && before !== after) {
            showNotification(`New ephemeral identity: <span class="mono">${escapeHtml(shortAddr(identityState.active_identity.lxmf_address))}</span>`,
                             'info', 3000);
        }
    }, (s.ephemeral_rotates_in + 1.5) * 1000);
}

async function setBinding(node, profileId) {
    try {
        await identityRequest('/api/identities/bindings', { node, profile_id: profileId || null });
    } catch (e) {
        showNotification(`Could not save: ${escapeHtml(e.message)}`, 'error', 5000);
        renderAutoIdentifySettings();
    }
}

// ─────────────────────────────────────────────────────────────
// Settings: web server (the command line options) and restart
// ─────────────────────────────────────────────────────────────

let serverSettingsState = null;

function loadServerSettings() {
    return fetch('/api/server-settings')
        .then(r => r.json())
        .then(s => {
            if (s.status !== 'success') return;
            serverSettingsState = s;
            const host = document.getElementById('setting-host');
            const port = document.getElementById('setting-port');
            if (host) { host.value = s.saved.host; host.dataset.loaded = '1'; }
            if (port) port.value = s.saved.port;
            const ln = s.local_name || {};
            const lnOn = document.getElementById('setting-local-name-on');
            const lnName = document.getElementById('setting-local-name');
            if (lnOn) lnOn.classList.toggle('active', !!ln.name);
            if (lnName) lnName.value = ln.name || 'rbrowser';
            renderServerNote();
        })
        .catch(err => {
            const note = document.getElementById('server-note');
            if (note) note.textContent = `Could not read the server settings: ${err.message}`;
        });
}

function renderServerNote() {
    const note = document.getElementById('server-note');
    const s = serverSettingsState;
    if (!note || !s) return;
    if (!s.can_restart) {
        note.innerHTML = `Started by Docker or <code>waitress-serve</code>. Change host and port there.`;
        return;
    }
    renderLocalNameNote();
    const parts = [`Running on <code>${escapeHtml(s.running.host)}:${s.running.port}</code>.`];
    const forced = Object.keys(s.cli || {});
    if (forced.length) {
        const typed = forced.map(k => `<code>--${k} ${escapeHtml(String(s.cli[k]))}</code>`).join(' ');
        parts.push(`Started with ${typed}, which takes priority when launched manually.`);
    }
    if (s.restart_required) {
        parts.push(`<span class="settings-warning-inline">Saved
                    <code>${escapeHtml(s.saved.host)}:${s.saved.port}</code> saved. Applies after restart.</span>`);
    }
    note.innerHTML = parts.join(' ');
}

// <name>.local (rbrowser/mdns.py): what is announced now, or why not. It
// also says who can reach it: anyone on the network, without a password.
function renderLocalNameNote() {
    const note = document.getElementById('local-name-note');
    const s = serverSettingsState;
    if (!note || !s) return;
    const ln = s.local_name || {};
    if (!ln.name) {
        note.innerHTML = 'Off. On: phones and computers on your home network open rBrowser at '
            + `<code>http://rbrowser.local:${s.running.port || s.saved.port}</code>, without its IP.`;
        return;
    }
    const url = `http://${escapeHtml(ln.name)}.local:${s.running.port || s.saved.port}`;
    if (ln.active) {
        note.innerHTML = `Announced: <a href="${url}" target="_blank" rel="noopener">${url}</a>`
            + ` (${escapeHtml((ln.addresses || []).join(', '))}).`
            + ' <span class="settings-warning-inline">Anyone on your network can open it, with no password:'
            + ' your identities and messages included.</span>';
    } else {
        note.innerHTML = `<span class="settings-warning-inline">Not announced: ${escapeHtml(ln.error || 'unknown reason')}</span>`;
    }
}

function readServerFields() {
    const host = document.getElementById('setting-host');
    const port = document.getElementById('setting-port');
    if (!host || !port || !serverSettingsState) return null;
    const wanted = { host: host.value.trim() || '0.0.0.0', port: parseInt(port.value, 10) };
    const saved = serverSettingsState.saved;
    const lnOn = document.getElementById('setting-local-name-on');
    const lnName = document.getElementById('setting-local-name');
    const name = lnOn && lnOn.classList.contains('active')
        ? (lnName.value.trim().toLowerCase().replace(/\.local$/, '') || 'rbrowser') : '';
    const nameChanged = lnOn && name !== ((serverSettingsState.local_name || {}).name || '');
    if (wanted.host === saved.host && wanted.port === saved.port) {
        return nameChanged ? { local_name: name } : null;
    }
    if (nameChanged) wanted.local_name = name;
    return wanted;
}

async function saveServerSettings(wanted) {
    let s;
    try {
        const response = await fetch('/api/server-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(wanted)
        });
        s = await response.json();
        if (s.status !== 'success') throw new Error(s.error || 'Not saved');
    } catch (e) {
        showNotification(`Web server settings not saved: ${escapeHtml(e.message)}`, 'error', 6000);
        return;
    }
    serverSettingsState = s;
    // The local name applies at once: say what came of it.
    if ('local_name' in wanted) {
        const ln = s.local_name || {};
        if (!ln.name) showNotification('Local network name turned off', 'success', 3000);
        else if (ln.active) showNotification(`Announced on your network: <strong>${escapeHtml(ln.name)}.local</strong>`, 'success', 5000);
        else showNotification(`${escapeHtml(ln.name)}.local not announced: ${escapeHtml(ln.error || '')}`, 'error', 8000);
    }
    if (!('host' in wanted)) return;
    if (!s.can_restart) {
        showNotification('Saved, but this rBrowser was not started with rBrowser.py: '
                         + 'restart it from Docker / waitress-serve.', 'warning', 7000);
        return;
    }
    if (s.restart_required) confirmRestart(true);
}

function isLoopbackHost(host) {
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

function restartTargetOrigin(target) {
    const wildcard = target.host === '0.0.0.0' || target.host === '::';
    let host = wildcard ? location.hostname : target.host;
    if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
    return `${location.protocol}//${host}:${target.port}`;
}

async function confirmRestart(justSaved = false) {
    try {
        const response = await fetch('/api/server-settings');
        serverSettingsState = await response.json();
    } catch (e) {
        showNotification(`Cannot reach rBrowser: ${escapeHtml(e.message)}`, 'error', 5000);
        return;
    }
    if (!serverSettingsState.can_restart) {
        showNotification('This rBrowser was not started with rBrowser.py: restart it from '
                         + 'Docker / waitress-serve.', 'warning', 6000);
        return;
    }
    const target = serverSettingsState.saved;
    const origin = restartTargetOrigin(target);
    const moving = origin !== location.origin;

    let html = justSaved
        ? `The new web server settings need a restart to take effect.<br><br>`
        : '';
    html += `rBrowser will restart and listen on <strong>${escapeHtml(target.host)}:${target.port}</strong>.
             This page reconnects by itself${moving ? ` at <strong>${escapeHtml(origin)}</strong>` : ''}.
             Pages loading in other tabs are interrupted, and links to nodes are set up again
             (identify again where you need to).`;
    if (isLoopbackHost(target.host) && !isLoopbackHost(location.hostname)) {
        html += `<div class="choice-warning">You are connected from another device, and
                 <code>${escapeHtml(target.host)}</code> only accepts connections from the
                 computer running rBrowser: after the restart this device will not reach it.</div>`;
    }

    const choice = await showChoiceDialog({
        title: 'Restart rBrowser?',
        html,
        buttons: [{ label: justSaved ? 'Later' : 'Cancel', value: null },
                  { label: 'Restart now', value: 'restart', primary: true }]
    });
    if (choice !== 'restart') {
        if (justSaved) {
            showNotification('Saved. The web server settings apply at the next restart.', 'info', 5000);
        }
        return;
    }
    doRestart(target, origin);
}

function prefsFragment() {
    const prefs = {};
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('rbrowser_')) prefs[key] = localStorage.getItem(key);
        }
    } catch (e) {
        return '';
    }
    return '#rb-prefs=' + btoa(encodeURIComponent(JSON.stringify(prefs)));
}

async function doRestart(target, origin) {
    closeSettings();
    const overlay = document.createElement('div');
    overlay.className = 'auto-reload-modal choice-modal restart-overlay';
    overlay.innerHTML = `
        <div class="auto-reload-dialog choice-dialog">
            <h3>Restarting rBrowser…</h3>
            <div class="choice-body" id="restart-status">Asking rBrowser to restart.</div>
        </div>`;
    document.body.appendChild(overlay);
    const status = overlay.querySelector('#restart-status');

    let oldInstance = null;
    try { oldInstance = (await (await fetch('/api/status', { cache: 'no-store' })).json()).instance; } catch (e) {}

    try {
        const response = await fetch('/api/restart', { method: 'POST' });
        const data = await response.json();
        if (data.status !== 'success') throw new Error(data.error || 'Refused');
    } catch (e) {
        status.innerHTML = `The restart could not be started: ${escapeHtml(e.message)}`;
        setTimeout(() => overlay.remove(), 5000);
        return;
    }

    const sameOrigin = origin === location.origin;
    status.innerHTML = `Waiting for rBrowser to come back${sameOrigin ? '' : ` at <strong>${escapeHtml(origin)}</strong>`}.<br>
                        Reticulum takes a few seconds to start.`;

    const alive = async () => {
        if (sameOrigin) {
            // The old process may still answer for a moment; only a new
            // instance id means the restart happened.
            const r = await fetch('/api/status', { cache: 'no-store' });
            const s = await r.json();
            return s.instance !== oldInstance;
        }
        // Another origin cannot be read from here, but no-cors still tells
        // "something answered" from "nothing is listening".
        await fetch(`${origin}/api/status`, { mode: 'no-cors', cache: 'no-store' });
        return true;
    };

    const started = Date.now();
    await new Promise(r => setTimeout(r, 2500));
    while (Date.now() - started < 120000) {
        try {
            if (await alive()) {
                status.textContent = 'Back. Reloading the page…';
                if (sameOrigin) location.reload();
                else location.href = `${origin}/${prefsFragment()}`;
                return;
            }
        } catch (e) { /* not up yet */ }
        await new Promise(r => setTimeout(r, 1000));
    }
    status.innerHTML = `rBrowser did not answer at <strong>${escapeHtml(origin)}</strong> within two
        minutes. Look at the console window where it runs: the new address may be taken,
        or Reticulum may have failed to start.<br><br>
        <a href="${escapeHtml(origin)}/">Try ${escapeHtml(origin)}</a>`;
}

// Save keeps the dialog open (Close, x and Escape close it); from the
// "Save your changes?" question it saves and closes.
function saveSettings({ close = false } = {}) {
    const zoomDesktop = document.getElementById('setting-zoom-desktop');
    const zoomMobile = document.getElementById('setting-zoom-mobile');
    if (zoomDesktop && zoomMobile) {
        setZoomDefault('desktop', zoomDesktop.value);
        setZoomDefault('mobile', zoomMobile.value);
        // Apply the one for this screen right away.
        pageZoomIndex = zoomIndexFor(isMobileWidth() ? zoomMobile.value : zoomDesktop.value);
        applyPageZoom();
    }

    const centerToggle = document.getElementById('setting-center');
    if (centerToggle) {
        const centered = centerToggle.classList.contains('active');
        applyCenterPages(centered);
        try { localStorage.setItem(CENTER_PAGES_KEY, centered ? '1' : '0'); } catch (e) {}
    }

    const lightToggle = document.getElementById('setting-light-render');
    if (lightToggle) {
        try {
            localStorage.setItem(LIGHT_RENDER_KEY, lightToggle.classList.contains('active') ? 'on' : 'off');
            localStorage.setItem(LIGHT_RENDER_CHARS_KEY, document.getElementById('setting-light-chars').value);
        } catch (e) {}
    }

    const historyToggle = document.getElementById('setting-history-enabled');
    if (historyToggle) {
        fetch('/api/history/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: historyToggle.classList.contains('active'),
                max_entries: Number(document.getElementById('setting-history-max').value),
                max_age_days: Number(document.getElementById('setting-history-age').value),
            })
        }).then(r => r.json()).then(data => {
            if (data.settings) historySettings = data.settings;
            applyHistoryEnabled();
        }).catch(() => {});
    }

    const favoritesToggle = document.getElementById('setting-favorites-enabled');
    if (favoritesToggle) {
        fetch('/api/favorites/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: favoritesToggle.classList.contains('active'),
                follow_announced_names: document.getElementById('setting-favorites-follow').classList.contains('active'),
            })
        }).then(r => r.json()).then(data => {
            if (data.settings) favoritesSettings = data.settings;
            applyFavoritesEnabled();
            // Names already heard are applied at once: reload them shortly.
            setTimeout(loadFavorites, 1500);
        }).catch(() => {});
    }

    for (const kind of Object.keys(APP_WINDOW_OPEN)) {
        const t = document.getElementById(`setting-app-window-${kind}`);
        if (t) try { localStorage.setItem(`rbrowser_app_window_${kind}`, t.classList.contains('active') ? '1' : '0'); } catch (e) {}
        // Switched on while the client is open here: it moves to its window.
        if (t && t.classList.contains('active') && !APP_WINDOW
            && document.getElementById(APP_WINDOW_TABS[kind])?.classList.contains('active')) openAppTab(kind);
    }

    const newNodesToggle = document.getElementById('setting-new-nodes');
    if (newNodesToggle) {
        const on = newNodesToggle.classList.contains('active');
        try { localStorage.setItem(NEW_NODES_BADGE_KEY, on ? '1' : '0'); } catch (e) {}
        setNodeListPending();
    }

    saveNodeListSettings();

    const clearSearchToggle = document.getElementById('setting-clear-search');
    if (clearSearchToggle) {
        const on = clearSearchToggle.classList.contains('active');
        try { localStorage.setItem(CLEAR_SEARCH_KEY, on ? '1' : '0'); } catch (e) {}
    }

    const images = document.getElementById('setting-images');
    if (images) setImagePolicy(images.value);

    const shots = document.getElementById('setting-screenshots');
    if (shots) {
        try {
            localStorage.setItem(SCREENSHOT_ENABLED_KEY, shots.classList.contains('active') ? 'on' : 'off');
            for (const kind of ['desktop', 'mobile']) {
                const select = document.getElementById(`setting-shot-${kind}`);
                if (select) localStorage.setItem(SCREENSHOT_QUALITY_KEYS[kind], select.value);
            }
        } catch (e) {}
        applyScreenshotsEnabled();
    }

    const notifications = document.getElementById('setting-notifications');
    if (notifications) {
        try { localStorage.setItem(NOTIFICATIONS_KEY, notifications.value); } catch (e) {}
    }
    saveSoundSettingsFromDialog();

    // Server side, applies at once. Only sent when it changed, so opening
    // and saving the settings does not end a --log override by accident.
    const terminalLog = document.getElementById('setting-terminal-log');
    const terminalChoice = terminalLog ? readTerminalLogChoice(terminalLog) : null;
    if (terminalLog && terminalLog.dataset.loaded
            && JSON.stringify(terminalChoice) !== terminalLog.dataset.loaded) {
        fetch('/api/console-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ categories: terminalChoice })
        }).catch(err => showNotification(`Terminal log setting not saved: ${escapeHtml(err.message)}`,
                                         'error', 5000));
    }

    // Read before the dialog goes away with the fields in it.
    const serverChange = readServerFields();
    if (serverChange && 'port' in serverChange && !(serverChange.port >= 1 && serverChange.port <= 65535)) {
        showNotification('The port must be a number between 1 and 65535', 'error', 5000);
        return;
    }

    // The cache settings live on the server, so this one is a round trip.
    // A failure announces itself through its own notification.
    saveCacheSettings();
    saveMessengerSettings(changedSettings(readMessengerFields(), loadedMessengerSettings));
    if (typeof saveRetibbsSettings === 'function') saveRetibbsSettings();
    if (typeof saveRmapSettings === 'function') saveRmapSettings();
    if (typeof saveRrcSettings === 'function') saveRrcSettings();

    if (close) closeSettings();
    else {
        // What is in the fields now is the saved state: nothing left to warn about.
        settingsBaseline = new Map();
        updateSettingsDirty();
    }
    showNotification('Settings saved', 'success', 2500);

    // Host/port: saved, then the restart question, always asked.
    if (serverChange) saveServerSettings(serverChange).then(updateSettingsDirty);
}

function showAutoReloadSettings() {
    const tab = getActiveTab();
    if (!tab) return;
    
    const overlay = document.createElement('div');
    overlay.className = 'auto-reload-modal';
    overlay.id = 'auto-reload-modal';
    
    const dialog = document.createElement('div');
    dialog.className = 'auto-reload-dialog';
    
    dialog.innerHTML = `
        <h3>⏱️ Auto-Reload Settings</h3>
        
        <div class="auto-reload-setting">
            <div class="auto-reload-toggle">
                <label>Enable Auto-Reload</label>
                <div class="toggle-switch ${tab.autoReloadEnabled ? 'active' : ''}" onclick="toggleAutoReloadInModal()">
                    <div class="toggle-slider"></div>
                </div>
            </div>
        </div>
        
        <div class="auto-reload-setting" id="interval-setting" style="${tab.autoReloadEnabled ? '' : 'opacity: 0.5; pointer-events: none;'}">
            <label>Reload Interval (seconds)</label>
            <input type="number" class="interval-input" id="reload-interval-input" 
                   min="5" max="3600" value="${tab.autoReloadInterval}"
                   placeholder="Enter seconds (5-3600)">
            
            <div class="interval-presets">
                <button class="preset-btn" onclick="setIntervalPreset(10)">10s</button>
                <button class="preset-btn" onclick="setIntervalPreset(30)">30s</button>
                <button class="preset-btn" onclick="setIntervalPreset(60)">1m</button>
                <button class="preset-btn" onclick="setIntervalPreset(120)">2m</button>
                <button class="preset-btn" onclick="setIntervalPreset(300)">5m</button>
                <button class="preset-btn" onclick="setIntervalPreset(600)">10m</button>
            </div>
        </div>
        
        <div class="auto-reload-info">
            ℹ️ The current page will automatically reload at the specified interval. This is useful for monitoring live content.
        </div>
        
        <div class="auto-reload-actions">
            <button class="btn-cancel" onclick="closeAutoReloadModal()">Cancel</button>
            <button class="btn-save" onclick="saveAutoReloadSettings()">Save Settings</button>
        </div>
    `;
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    // Close on overlay click
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            closeAutoReloadModal();
        }
    });
    
    // Close on Escape key
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            document.removeEventListener('keydown', escapeHandler);
            closeAutoReloadModal();
        }
    };
    document.addEventListener('keydown', escapeHandler);
}

function toggleAutoReloadInModal() {
    const toggle = document.querySelector('.toggle-switch');
    const intervalSetting = document.getElementById('interval-setting');
    
    toggle.classList.toggle('active');
    
    if (toggle.classList.contains('active')) {
        intervalSetting.style.opacity = '1';
        intervalSetting.style.pointerEvents = 'auto';
    } else {
        intervalSetting.style.opacity = '0.5';
        intervalSetting.style.pointerEvents = 'none';
    }
}

function setIntervalPreset(seconds) {
    document.getElementById('reload-interval-input').value = seconds;
}

function saveAutoReloadSettings() {
    const tab = getActiveTab();
    if (!tab) return;
    
    const toggle = document.querySelector('.toggle-switch');
    const intervalInput = document.getElementById('reload-interval-input');
    const interval = parseInt(intervalInput.value) || 60;
    
    // Validate interval
    if (interval < 5 || interval > 3600) {
        showNotification('Interval must be between 5 and 3600 seconds', 'error', 3000);
        return;
    }
    
    const enabled = toggle.classList.contains('active');
    
    tab.setAutoReloadInterval(interval);
    
    if (enabled) {
        tab.startAutoReload();
        showNotification(
            `Auto-reload enabled: ${interval}s interval`,
            'success',
            3000
        );
    } else {
        tab.stopAutoReload();
        showNotification('Auto-reload disabled', 'info', 3000);
    }
    
    updateAutoReloadButton();
    closeAutoReloadModal();
}

function closeAutoReloadModal() {
    const modal = document.getElementById('auto-reload-modal');
    if (modal) {
        modal.remove();
    }
}

function updateAutoReloadButton() {
    const tab = getActiveTab();
    if (!tab) return;
    
    const btn = document.querySelector(`#${tab.id} .auto-reload-btn`);
    const countdown = document.querySelector(`#${tab.id} .reload-countdown`);
    
    if (!btn || !countdown) return;
    
    // Hide button if no page is loaded (new tab or error state)
    if (!tab.currentUrl || tab.currentUrl === '') {
        btn.style.display = 'none';
        return;
    }
    
    // Show button when a page is loaded
    btn.style.display = 'flex';
    
    if (tab.autoReloadEnabled) {
        btn.classList.add('active');
        countdown.textContent = `${tab.autoReloadCountdown}s`;
        btn.title = `Auto-reload active: ${tab.autoReloadCountdown}s until next reload`;
    } else {
        btn.classList.remove('active');
        countdown.textContent = '';
        btn.title = 'Auto-reload settings (click to configure)';
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Quick search: the sidebar search and the address bar suggestions
//
// One search over everything the browser already knows, without touching
// the network: the favorites, the nodes in the list (name, hash, operator,
// LXMF address, interface) and the saved pages (title, path, node). The
// text of the saved pages is searched on the server (/api/cache/search),
// which comes back a moment later and is added when it arrives.
// ─────────────────────────────────────────────────────────────────────────

const QUICK_MIN_CHARS = 2;
let savedPagesIndex = [];
let savedPagesLoadedAt = 0;
let savedPagesLoading = null;

// The list of saved pages, refreshed at most every 30 s while searching.
function loadSavedPages() {
    if (Date.now() - savedPagesLoadedAt < 30000) return Promise.resolve(savedPagesIndex);
    if (savedPagesLoading) return savedPagesLoading;
    savedPagesLoading = fetch('/api/cache/pages')
        .then(r => r.json())
        .then(data => {
            if (data.status === 'success') savedPagesIndex = data.results || [];
            savedPagesLoadedAt = Date.now();
            return savedPagesIndex;
        })
        .catch(() => savedPagesIndex)
        .finally(() => { savedPagesLoading = null; });
    return savedPagesLoading;
}

function quickWords(term) {
    return String(term || '').toLowerCase().split(/\s+/).filter(Boolean);
}

function quickHit(haystack, words) {
    const hay = haystack.toLowerCase();
    return words.every(w => hay.includes(w));
}

// Not the interface the path leaves by: most nodes share the same one or
// two, and a search for its name ("rmap") came back with half the list.
function nodeHaystack(node) {
    return [node.name, node.hash, node.operator_name, node.operator_lxmf_address]
        .filter(Boolean).join(' ');
}

// What the browser knows about a node hash, from the list or the cache.
function knownNodeName(hash) {
    const node = cachedNodes.find(n => n.hash === hash);
    if (node && node.name) return node.name;
    const fav = favoriteNodes.find(f => f.hash === hash);
    if (fav && fav.name) return fav.name;
    const page = savedPagesIndex.find(p => p.node_hash === hash && p.node_name);
    return page ? page.node_name : '';
}

// Favorites, nodes and saved pages matching every word of the term.
// contentHits: results of /api/cache/search for the same term (or []).
function quickSearch(term, contentHits = []) {
    const words = quickWords(term);
    const out = { favorites: [], nodes: [], pages: [] };
    if (!words.length) return out;

    const byHash = new Map(cachedNodes.map(n => [n.hash, n]));
    out.favorites = favoriteNodes.filter(fav => {
        const node = byHash.get(fav.hash);
        return quickHit([fav.name, fav.hash, node ? nodeHaystack(node) : ''].join(' '), words);
    });
    out.nodes = cachedNodes.filter(node => quickHit(nodeHaystack(node), words));

    // Pages: the server's content search first (it ranks and has the
    // snippet), then pages whose title, path or node match here.
    const seen = new Set();
    for (const hit of contentHits) {
        const key = hit.node_hash + ':' + hit.path;
        if (seen.has(key)) continue;
        seen.add(key);
        out.pages.push(hit);
    }
    for (const page of savedPagesIndex) {
        const key = page.node_hash + ':' + page.path;
        if (seen.has(key)) continue;
        const hay = [page.title, page.path, page.node_name, page.node_hash,
                     page.operator_name, page.operator_lxmf_address].join(' ');
        if (quickHit(hay, words)) { seen.add(key); out.pages.push(page); }
    }
    return out;
}

// The text of the saved pages, searched on the server. Only the latest
// request counts: an older answer arriving late is dropped.
const contentSearchSeq = { sidebar: 0, omnibox: 0 };
function searchSavedContent(term, who) {
    const seq = ++contentSearchSeq[who];
    return fetch(`/api/cache/search?q=${encodeURIComponent(term)}`)
        .then(r => r.json())
        .then(data => (seq === contentSearchSeq[who] && data.status === 'success')
            ? (data.results || []) : null)
        .catch(() => null);
}

// The part of a snippet from just before the first word found: in a
// one-line row the start is all that shows.
function snippetAround(text, words, before = 24) {
    text = String(text || '');
    const lower = text.toLowerCase();
    let at = -1;
    for (const w of words) {
        const i = lower.indexOf(w);
        if (i !== -1 && (at === -1 || i < at)) at = i;
    }
    if (at === -1) return '';          // the match was elsewhere (title, path)
    if (at <= before) return text;
    const cut = text.lastIndexOf(' ', at - before);
    return '…' + text.slice(cut > 0 ? cut : at - before);
}

// A saved page found by a search, as three lines of text: the node's name,
// the page (its title if it has one, and its path), the words found.
function pageResultLines(page, words) {
    const node = page.node_name || knownNodeName(page.node_hash) || page.node_hash.slice(0, 8) + '…';
    const path = page.path || '/page/index.mu';
    const title = String(page.title || '').trim();
    const found = snippetAround(page.snippet, words);
    // A title the found words already show (the page's first line) is not said twice.
    const repeated = title && found.replace(/^…\s*/, '').startsWith(title);
    return {
        node,
        page: title && title !== node && !repeated ? `${title} · ${path}` : path,
        found,
    };
}

function pageAddress(page) {
    return `${page.node_hash}:${page.path || '/page/index.mu'}`;
}

// ─── nomadnetwork:// links clicked elsewhere on this computer ───
// rBrowser.py --open hands the link to the server (rbrowser/links.py,
// LinkInbox), which gives it to the page in use here on its next status
// poll: it opens as a new tab in this page instead of a new browser tab.
const PAGE_ID = Math.random().toString(36).slice(2, 12);

function statusUrl() {
    const visible = document.visibilityState === 'visible' ? '1' : '0';
    const focused = document.hasFocus() ? '1' : '0';
    return `/api/status?page=${PAGE_ID}&visible=${visible}&focused=${focused}`;
}

function openDeliveredLinks(urls) {
    if (!Array.isArray(urls) || !urls.length) return;
    for (const url of urls) {
        // A client's link (links.py link_target) comes as JSON, a page as its address.
        const text = String(url);
        if (text.startsWith('{')) {
            let t = null;
            try { t = externalLinkTarget(JSON.parse(text)); } catch (e) {}
            if (t) openLinkTarget(t);
        } else {
            openQuickAddress(normalizeNomadNetUrl(text), null, true);
        }
    }
    try { window.focus(); } catch (e) {}
    flagPageTitle();
}

// The browser window comes forward from rBrowser.py when it can; when this
// is not the tab on screen, its title blinks until it is looked at. It
// still starts with "rBrowser": that is how the window is found next time.
function flagPageTitle() {
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    if (flagPageTitle.timer) return;
    const original = document.title;
    let on = false;
    flagPageTitle.timer = setInterval(() => {
        if (document.visibilityState === 'visible' && document.hasFocus()) {
            clearInterval(flagPageTitle.timer);
            flagPageTitle.timer = null;
            document.title = original;
            return;
        }
        on = !on;
        document.title = on ? 'rBrowser ● new page opened' : original;
    }, 1000);
}

// Open an address. In the tab on screen if it is empty, in a new one
// otherwise (newTab), or always in the tab on screen (the address bar).
// A new tab that loads behind the one you are reading: the page goes on
// loading in its own tab (rendering never depends on which tab is in front,
// as for auto-reload), and the tab you were on comes straight back.
function openInBackgroundTab(url, name) {
    const back = activeTabId;
    const tab = createNewTab();
    const parsed = parseNomadNetUrl(url);
    if (name && parsed) tab.knownNodeName = name;
    const addressBar = document.querySelector(`#${tab.id} .address-bar`);
    if (addressBar) addressBar.value = url;
    navigateToUrlInternalTab(url, true);
    if (back && tabs.some(t => t.id === back)) switchToTab(back);
    const el = document.querySelector(`[data-tab-id="${tab.id}"]`);
    if (el) {
        el.classList.add('tab-bg-new');
        setTimeout(() => el.classList.remove('tab-bg-new'), 1500);
    }
}

function openQuickAddress(url, name, newTab) {
    let tab = getActiveTab();
    if (newTab && !(tab && tab.title === 'New Tab' && !tab.currentUrl)) tab = createNewTab();
    if (!tab) return;
    const parsed = parseNomadNetUrl(url);
    if (name && parsed) tab.knownNodeName = name;
    const addressBar = document.querySelector(`#${tab.id} .address-bar`);
    if (addressBar) addressBar.value = url;
    navigateToUrlInternalTab(url, true);
}

// The words found, marked. Found on the plain text and escaped piece by
// piece, so a word can never land inside an entity or a tag.
function quickHighlight(text, words) {
    text = String(text || '');
    const lower = text.toLowerCase();
    const marks = new Array(text.length).fill(false);
    for (const w of words) {
        for (let at = lower.indexOf(w); at !== -1 && w; at = lower.indexOf(w, at + w.length)) {
            for (let k = at; k < at + w.length; k++) marks[k] = true;
        }
    }
    let html = '';
    for (let i = 0; i < text.length;) {
        let j = i;
        while (j < text.length && marks[j] === marks[i]) j++;
        const piece = escapeHtml(text.slice(i, j));
        html += marks[i] ? `<mark>${piece}</mark>` : piece;
        i = j;
    }
    return html;
}

// ── Sidebar ──────────────────────────────────────────────────────────────

let sidebarContentHits = [];
let sidebarContentTerm = '';
let sidebarSearchTimer = null;

function filterNodes() {
    const input = document.getElementById('node-search');
    const term = input ? input.value.trim() : '';
    const words = quickWords(term);
    const contentNodes = new Set(term === sidebarContentTerm
        ? sidebarContentHits.map(h => h.node_hash) : []);
    const byHash = new Map(cachedNodes.map(n => [n.hash, n]));

    let shown = 0;
    document.querySelectorAll('.node-item').forEach(item => {
        const hash = item.getAttribute('data-hash') || '';
        const node = byHash.get(hash);
        const hay = node ? nodeHaystack(node) : `${item.getAttribute('data-name') || ''} ${hash}`;
        const match = !words.length || quickHit(hay, words) || contentNodes.has(hash);
        item.style.display = match ? 'block' : 'none';
        item.classList.toggle('content-match', !!words.length && match && !quickHit(hay, words));
        if (match) shown++;
    });

    renderSidebarExtra(term, shown);

    // The text of the saved pages, a moment after the typing stops.
    clearTimeout(sidebarSearchTimer);
    if (term.length >= QUICK_MIN_CHARS && term !== sidebarContentTerm) {
        sidebarSearchTimer = setTimeout(async () => {
            await loadSavedPages();
            const hits = await searchSavedContent(term, 'sidebar');
            if (hits === null) return;
            const now = document.getElementById('node-search');
            if (!now || now.value.trim() !== term) return;
            sidebarContentHits = hits;
            sidebarContentTerm = term;
            filterNodes();
        }, 250);
    } else if (!term) {
        sidebarContentHits = [];
        sidebarContentTerm = '';
    }
}

// Above the filtered list: the favorites and the saved pages that match.
function renderSidebarExtra(term, nodesShown) {
    const container = document.querySelector('.node-list-container');
    if (!container) return;
    let box = document.getElementById('search-extra');
    if (term.length < QUICK_MIN_CHARS) {
        if (box) box.remove();
        return;
    }
    if (!box) {
        box = document.createElement('div');
        box.id = 'search-extra';
        box.className = 'search-extra';
        container.insertBefore(box, container.firstChild);
        box.addEventListener('click', e => {
            const row = e.target.closest('[data-open]');
            if (!row) return;
            const address = row.dataset.open, name = row.dataset.name || '';
            closeSearchAfterPick();
            openQuickAddress(address, name, true);
        });
    }
    const words = quickWords(term);
    const found = quickSearch(term, term === sidebarContentTerm ? sidebarContentHits : []);
    const pages = found.pages.slice(0, 8);
    const searching = term !== sidebarContentTerm;

    let html = '';
    if (found.favorites.length) {
        html += `<div class="search-extra-head">Favorites <span>${found.favorites.length}</span></div>`;
        html += found.favorites.map(fav => `
            <div class="search-extra-row" data-open="${escapeHtml(fav.hash)}:/page/index.mu" data-name="${escapeHtml(fav.name || '')}"
                 title="${escapeHtml(fav.hash)}">
                <span class="search-extra-icon fav">★</span>
                <span class="search-extra-text">
                    <span class="search-extra-name">${quickHighlight(favoriteLabel(fav), words)}</span>
                    <span class="search-extra-sub">${quickHighlight(fav.hash, words)}</span>
                </span>
            </div>`).join('');
    }
    if (pages.length) {
        html += `<div class="search-extra-head">Saved pages <span>${found.pages.length > pages.length ? pages.length + '+' : pages.length}</span></div>`;
        // Three lines: the node, then the page (title and path), then the
        // words found in it.
        html += pages.map(page => {
            const r = pageResultLines(page, words);
            return `
            <div class="search-extra-row" data-open="${escapeHtml(pageAddress(page))}" data-name="${escapeHtml(page.node_name || '')}"
                 title="${escapeHtml(pageAddress(page))}">
                <span class="search-extra-icon">${NODE_ICONS.disk}</span>
                <span class="search-extra-text">
                    <span class="search-extra-name">${quickHighlight(r.node, words)}</span>
                    <span class="search-extra-page">${quickHighlight(r.page, words)}</span>
                    ${r.found ? `<span class="search-extra-sub">${quickHighlight(r.found, words)}</span>` : ''}
                </span>
            </div>`;
        }).join('');
        if (found.pages.length > pages.length) {
            html += `<button class="search-extra-more" onclick="showCacheSearch('${jsAttr(term)}')">All saved pages matching…</button>`;
        }
    }
    html += `<div class="search-extra-head">Node list <span>${nodesShown}</span>${searching ? ' <i>searching page text…</i>' : ''}</div>`;
    box.innerHTML = html;
}

// ── Address bar suggestions ──────────────────────────────────────────────

const omnibox = { input: null, menu: null, items: [], index: -1, timer: null, term: '', hits: [], hitsTerm: '' };

function omniboxMenu() {
    if (!omnibox.menu) {
        const menu = document.createElement('div');
        menu.className = 'omnibox-menu';
        menu.hidden = true;
        // mousedown, not click: the address bar loses focus on mousedown
        // and the menu closes on blur.
        menu.addEventListener('mousedown', e => {
            const row = e.target.closest('.omnibox-row');
            if (!row) return;
            e.preventDefault();
            omniboxChoose(Number(row.dataset.i));
        });
        document.body.appendChild(menu);
        omnibox.menu = menu;
    }
    return omnibox.menu;
}

function omniboxClose() {
    clearTimeout(omnibox.timer);
    if (omnibox.menu) omnibox.menu.hidden = true;
    omnibox.items = [];
    omnibox.index = -1;
}

// A full address being typed or pasted gets no suggestions in its way.
function looksLikeAddress(text) {
    return /^[0-9a-f]{32}:/i.test(text) || /^nomadnetwork:\/\//i.test(text);
}

function omniboxUpdate(input) {
    omnibox.input = input;
    const term = input.value.trim();
    omnibox.term = term;
    if (term.length < QUICK_MIN_CHARS || looksLikeAddress(term)) { omniboxClose(); return; }
    omniboxRender();
    clearTimeout(omnibox.timer);
    omnibox.timer = setTimeout(async () => {
        await loadSavedPages();
        omniboxRender();
        if (omnibox.hitsTerm === term) return;
        const hits = await searchSavedContent(term, 'omnibox');
        if (hits === null || omnibox.term !== term) return;
        omnibox.hits = hits;
        omnibox.hitsTerm = term;
        omniboxRender();
    }, 200);
}

function omniboxRender() {
    const input = omnibox.input;
    const term = omnibox.term;
    if (!input || document.activeElement !== input) return;
    const words = quickWords(term);
    const found = quickSearch(term, omnibox.hitsTerm === term ? omnibox.hits : []);

    // Favorites first, then nodes not already shown as a favorite, then pages.
    const items = [];
    const favHashes = new Set(found.favorites.map(f => f.hash));
    found.favorites.slice(0, 5).forEach(fav => items.push({
        kind: 'fav', url: `${fav.hash}:/page/index.mu`, name: fav.name || '',
        label: favoriteLabel(fav), sub: fav.hash }));
    found.nodes.filter(n => !favHashes.has(n.hash)).slice(0, 6).forEach(node => items.push({
        kind: 'node', url: `${node.hash}:/page/index.mu`, name: node.name || '',
        label: node.name || node.hash, sub: node.hash }));
    found.pages.slice(0, 7).forEach(page => {
        const r = pageResultLines(page, words);
        items.push({ kind: 'page', url: pageAddress(page), name: page.node_name || '',
                     label: r.node, page: r.page, sub: r.found });
    });

    const menu = omniboxMenu();
    omnibox.items = items;
    if (omnibox.index >= items.length) omnibox.index = -1;
    if (!items.length) {
        menu.innerHTML = omnibox.hitsTerm === term
            ? '<div class="omnibox-empty">Nothing in favorites, node list or saved pages</div>'
            : '<div class="omnibox-empty">Searching…</div>';
    } else {
        const icons = { fav: '<span class="omnibox-icon fav">★</span>',
                        node: '<span class="omnibox-icon node">●</span>',
                        page: `<span class="omnibox-icon">${NODE_ICONS.disk}</span>` };
        const kinds = { fav: 'Favorite', node: 'Node list', page: 'Saved page' };
        menu.innerHTML = items.map((it, i) => `
            <div class="omnibox-row${i === omnibox.index ? ' active' : ''}" data-i="${i}" title="${escapeHtml(it.url)}">
                ${icons[it.kind]}
                <span class="omnibox-text">
                    <span class="omnibox-label">${quickHighlight(it.label, words)}</span>
                    ${it.page ? `<span class="omnibox-page">${quickHighlight(it.page, words)}</span>` : ''}
                    ${it.sub ? `<span class="omnibox-sub">${quickHighlight(it.sub, words)}</span>` : ''}
                </span>
                <span class="omnibox-kind">${kinds[it.kind]}</span>
            </div>`).join('');
    }
    const r = input.getBoundingClientRect();
    menu.style.left = `${Math.max(4, r.left)}px`;
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.width = `${Math.min(Math.max(r.width, 320), window.innerWidth - Math.max(4, r.left) - 4)}px`;
    menu.hidden = false;
}

function omniboxChoose(i) {
    const it = omnibox.items[i];
    if (!it) return;
    const input = omnibox.input;
    omniboxClose();
    if (input) input.blur();
    openQuickAddress(it.url, it.name, false);
}

// Arrow keys move through the suggestions, Enter opens the one chosen
// (or, with none chosen, what is typed - as before), Escape closes.
function omniboxKeydown(e) {
    const open = omnibox.menu && !omnibox.menu.hidden && omnibox.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!open) return;
        e.preventDefault();
        const n = omnibox.items.length;
        omnibox.index = e.key === 'ArrowDown'
            ? (omnibox.index + 1) % n
            : (omnibox.index <= 0 ? n - 1 : omnibox.index - 1);
        omniboxRender();
    } else if (e.key === 'Enter') {
        if (open && omnibox.index >= 0) {
            e.preventDefault();
            e.stopImmediatePropagation();
            omniboxChoose(omnibox.index);
        } else {
            omniboxClose();
        }
    } else if (e.key === 'Escape') {
        // First Esc closes the suggestions, the next one empties the field.
        if (omnibox.menu && !omnibox.menu.hidden) { e.preventDefault(); omniboxClose(); }
        else if (e.target.value) { e.preventDefault(); clearAddressBar(e.target); }
    }
}

// ─── × in the address bar ───
// One button floating over the right end of the address bar in use, shown
// while it is focused or under the mouse and holds text. Floating, so the
// many layouts of the nav bar (desktop, two rows on phones) stay as they are.
let addressClearFor = null;

function addressClearButton() {
    let btn = document.getElementById('address-clear');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'address-clear';
        btn.className = 'search-clear address-clear';
        btn.type = 'button';
        btn.title = 'Clear the address bar (Esc)';
        btn.setAttribute('aria-label', 'Clear the address bar');
        btn.textContent = '×';
        btn.hidden = true;
        // pointerdown, not click: the field keeps the focus.
        btn.addEventListener('pointerdown', e => {
            e.preventDefault();
            if (addressClearFor) clearAddressBar(addressClearFor);
        });
        document.body.appendChild(btn);
    }
    return btn;
}

function clearAddressBar(input) {
    input.value = '';
    omniboxClose();
    input.focus();
    placeAddressClear(input);
}

function placeAddressClear(input) {
    const btn = addressClearButton();
    const r = input && input.getBoundingClientRect();
    const show = !!(input && input.value && r.width > 60
                    && (document.activeElement === input || input.matches(':hover')));
    btn.hidden = !show;
    if (!show) return;
    addressClearFor = input;
    btn.style.left = `${r.right - 28}px`;
    btn.style.top = `${r.top + (r.height - 22) / 2}px`;
}

['focusin', 'input', 'mouseover'].forEach(type => document.addEventListener(type, e => {
    if (e.target.classList && e.target.classList.contains('address-bar')) placeAddressClear(e.target);
}));
['focusout', 'mouseout'].forEach(type => document.addEventListener(type, e => {
    if (!(e.target.classList && e.target.classList.contains('address-bar'))) return;
    // Leaving the field for the × itself keeps it.
    if (e.relatedTarget && e.relatedTarget.id === 'address-clear') return;
    setTimeout(() => placeAddressClear(document.activeElement && document.activeElement.classList
        && document.activeElement.classList.contains('address-bar') ? document.activeElement : null), 0);
}));
window.addEventListener('resize', () => { const b = document.getElementById('address-clear'); if (b) b.hidden = true; });
window.addEventListener('scroll', () => { const b = document.getElementById('address-clear'); if (b) b.hidden = true; }, true);

// Esc empties the node list search too, the focus stays in it.
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !e.target || e.target.id !== 'node-search' || !e.target.value) return;
    e.preventDefault();
    e.stopPropagation();
    clearSearch();
}, true);

// One set of listeners for every tab's address bar.
document.addEventListener('input', e => {
    if (e.target.classList && e.target.classList.contains('address-bar')) omniboxUpdate(e.target);
});
document.addEventListener('keydown', e => {
    if (e.target.classList && e.target.classList.contains('address-bar')) omniboxKeydown(e);
}, true);
document.addEventListener('focusout', e => {
    if (e.target === omnibox.input) setTimeout(() => {
        if (document.activeElement !== omnibox.input) omniboxClose();
    }, 0);
});
window.addEventListener('resize', () => omniboxClose());

// ─────────────────────────────────────────────────────────────────────────
// Hidden nodes
//
// The eye on a card takes the node out of the list (server side, kept in
// settings/hidden_nodes.json); Settings > Hidden nodes brings it back.
// ─────────────────────────────────────────────────────────────────────────

async function setNodeHidden(hash, hidden, name = '') {
    try {
        const data = await fetch('/api/hidden-nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hash, hidden, name })
        }).then(r => r.json());
        return data.status === 'success' ? data.hidden : null;
    } catch (e) {
        return null;
    }
}

async function hideNode(hash, name) {
    const done = await setNodeHidden(hash, true, name);
    if (!done) {
        showNotification('Could not hide the node', 'error', 4000);
        return;
    }
    // Out of the list at once: the list holds still while the pointer is
    // over it, and would otherwise keep the row until the pointer left.
    document.querySelectorAll(`.node-item[data-hash="${CSS.escape(hash)}"]`).forEach(el => el.remove());
    cachedNodes = cachedNodes.filter(n => n.hash !== hash);
    const label = escapeHtml(name || hash.slice(0, 8) + '…');
    showNotification(`Hidden: ${label}<br><span style="opacity:.8">Settings &gt; Hidden nodes to restore.</span>`
        + `<br><button class="notif-action" onclick="unhideNode('${jsAttr(hash)}'); this.closest('.notification').remove();">Undo</button>`,
        'info', 8000);
}

async function unhideNode(hash) {
    const done = await setNodeHidden(hash, false);
    if (!done) {
        showNotification('Could not restore the node', 'error', 4000);
        return null;
    }
    nodeListShowPending = true;      // in now, even with the pointer on the list
    nodeListAcked.add(hash);         // restored, not new: no "new nodes" for it
    updateNodes();
    return done;
}

async function fillHiddenNodes(box) {
    if (!box) return;
    let list;
    try {
        const data = await fetch('/api/hidden-nodes').then(r => r.json());
        list = data.hidden || [];
    } catch (e) {
        box.textContent = 'Not available';
        return;
    }
    renderHiddenNodes(box, list);
}

function renderHiddenNodes(box, list) {
    if (!list.length) {
        box.innerHTML = '<div class="settings-hint">No hidden nodes. Use the crossed eye on a node in the list.</div>';
        return;
    }
    box.innerHTML = list.map(n => `
        <div class="hidden-node-row">
            <span class="hidden-node-text">
                <span class="hidden-node-name">${escapeHtml(n.name || 'Unnamed node')}</span>
                <span class="hidden-node-hash">${escapeHtml(n.hash)}</span>
            </span>
            <button class="settings-export hidden-node-restore" data-hash="${escapeHtml(n.hash)}">Restore</button>
        </div>`).join('')
        + (list.length > 1 ? '<button class="settings-export hidden-node-restore-all">Restore all</button>' : '');
    box.querySelectorAll('.hidden-node-restore').forEach(btn => btn.addEventListener('click', async () => {
        btn.disabled = true;
        const rest = await unhideNode(btn.dataset.hash);
        if (rest) renderHiddenNodes(box, rest);
        else btn.disabled = false;
    }));
    const all = box.querySelector('.hidden-node-restore-all');
    if (all) all.addEventListener('click', async () => {
        all.disabled = true;
        let rest = list;
        for (const n of list) rest = (await unhideNode(n.hash)) || rest;
        renderHiddenNodes(box, rest);
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Node menu
//
// A click on a node's hash in the list opens the things that can be done
// with the node; a click on the operator's LXMF address, those that can be
// done with that address. One small menu next to what was clicked.
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// History
//
// The pages you opened, newest first, in a drop-down beside Favorites. The
// server keeps it (rbrowser/history.py) and writes it on every page visit;
// this only shows it, and asks for it again each time it is opened.
// ─────────────────────────────────────────────────────────────────────────

let historySettings = { enabled: false, max_entries: 200, max_age_days: 0 };

function applyHistoryEnabled() {
    document.body.classList.toggle('history-off', !historySettings.enabled);
    if (!historySettings.enabled) setHistoryOpen(false);
}

// Settings > Favorites (rbrowser/favorites.py keeps them).
let favoritesSettings = { enabled: true, follow_announced_names: true };

function applyFavoritesEnabled() {
    document.body.classList.toggle('favorites-off', !favoritesSettings.enabled);
    if (!favoritesSettings.enabled) setFavoritesOpen(false);
}

fetch('/api/favorites/settings').then(r => r.json()).then(data => {
    if (data.settings) favoritesSettings = data.settings;
    applyFavoritesEnabled();
}).catch(() => {});

async function loadHistory() {
    try {
        const data = await fetch('/api/history').then(r => r.json());
        historySettings = data.settings || historySettings;
        applyHistoryEnabled();
        return data.entries || [];
    } catch (e) {
        return null;
    }
}

async function clearHistoryFromSettings() {
    try {
        const data = await fetch('/api/history/clear', { method: 'POST' }).then(r => r.json());
        const n = data.removed || 0;
        showNotification(`History cleared (${n} page${n === 1 ? '' : 's'})`, 'success', 3000);
    } catch (e) {
        showNotification('Could not clear the history', 'error', 4000);
    }
}

function setHistoryOpen(open) {
    const section = document.getElementById('favorites-section');
    const button = document.getElementById('history-toggle');
    if (!section || !button) return;
    if (open) setFavoritesOpen(false);
    section.classList.toggle('history-open', open);
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    button.title = open ? 'Hide the history' : 'Show the pages you opened';
    if (open) refreshHistoryList();
}

function toggleHistorySection() {
    const section = document.getElementById('favorites-section');
    setHistoryOpen(!(section && section.classList.contains('history-open')));
}

// "Today", "Yesterday" or the date, for the headings between the days.
function historyDayLabel(ts) {
    const day = new Date(ts * 1000);
    const today = new Date();
    const start = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((start(today) - start(day)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return day.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

async function refreshHistoryList() {
    const list = document.getElementById('history-list');
    if (!list) return;
    const entries = await loadHistory();
    if (entries === null) {
        list.innerHTML = '<div class="favorites-empty">Could not read the history.</div>';
        return;
    }
    if (!entries.length) {
        list.innerHTML = '<div class="favorites-empty">No history yet.<br>Pages you open show up here.</div>';
        return;
    }
    let html = '';
    let lastDay = '';
    for (const entry of entries) {
        const day = historyDayLabel(entry.time);
        if (day !== lastDay) {
            html += `<div class="history-day">${escapeHtml(day)}</div>`;
            lastDay = day;
        }
        const when = new Date(entry.time * 1000)
            .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const name = entry.name || knownNodeName(entry.node_hash) || entry.node_hash.slice(0, 16) + '…';
        html += `
            <div class="history-item" data-url="${escapeHtml(entry.url)}" data-name="${escapeHtml(name)}"
                 title="${escapeHtml(name)}&#10;${escapeHtml(entry.url)}">
                <span class="favorite-text">
                    <span class="favorite-name">${escapeHtml(name)}</span>
                    <span class="favorite-hash">${escapeHtml(entry.path || '')}</span>
                </span>
                <span class="history-when">${escapeHtml(when)}</span>
                <button class="favorite-remove history-remove" title="Remove from the history">×</button>
            </div>`;
    }
    html += '<div class="history-footer"><button class="history-clear">Clear history</button></div>';
    list.innerHTML = html;
}

// One handler for the whole list, set once: rows come and go with each refresh.
function watchHistoryList() {
    const list = document.getElementById('history-list');
    if (!list) return;
    list.addEventListener('click', async e => {
        if (e.target.closest('.history-clear')) {
            e.stopPropagation();
            await fetch('/api/history/clear', { method: 'POST' });
            refreshHistoryList();
            return;
        }
        const item = e.target.closest('.history-item');
        if (!item) return;
        if (e.target.closest('.history-remove')) {
            e.stopPropagation();
            await fetch('/api/history/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: item.dataset.url })
            });
            refreshHistoryList();
            return;
        }
        setHistoryOpen(false);
        openQuickAddress(item.dataset.url, item.dataset.name, false);
    });
}

// A click outside the row or Escape closes it, as with Favorites.
document.addEventListener('click', e => {
    const section = document.getElementById('favorites-section');
    if (section && section.classList.contains('history-open') && !section.contains(e.target)) {
        setHistoryOpen(false);
    }
});
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const section = document.getElementById('favorites-section');
    if (section && section.classList.contains('history-open')) setHistoryOpen(false);
});

document.addEventListener('DOMContentLoaded', () => {
    watchHistoryList();
    loadHistory();          // only to know whether History is on
});

function closeNodeMenu() {
    const menu = document.getElementById('node-menu');
    if (menu) menu.remove();
}

function openNodeMenu(anchor, title, sub, actions) {
    closeNodeMenu();
    const menu = document.createElement('div');
    menu.id = 'node-menu';
    menu.className = 'node-menu';
    menu.innerHTML = `
        <div class="node-menu-head">
            <button class="node-menu-close" title="Close" aria-label="Close">&times;</button>
            <div class="node-menu-title">${escapeHtml(title)}</div>
            <div class="node-menu-sub">${escapeHtml(sub)}</div>
        </div>
        ${actions.map((a, i) => a === '-' ? '<div class="node-menu-sep"></div>'
            : a.group ? `<div class="node-menu-group">${escapeHtml(a.group)}</div>`
            : `<button class="node-menu-item${a.danger ? ' danger' : ''}" data-i="${i}"${a.disabled ? ' disabled' : ''}
                       title="${escapeHtml(a.tip || '')}">${a.check !== undefined ? `<span class="node-menu-check">${a.check ? '✓' : ''}</span>` : ''}${escapeHtml(a.label)}</button>`).join('')}`;
    menu.addEventListener('click', e => {
        // Opened by mistake: the x closes it without doing anything.
        if (e.target.closest('.node-menu-close')) {
            e.stopPropagation();
            closeNodeMenu();
            return;
        }
        const btn = e.target.closest('.node-menu-item');
        if (!btn || btn.disabled) return;
        e.stopPropagation();
        closeNodeMenu();
        actions[Number(btn.dataset.i)].run();
    });
    document.body.appendChild(menu);

    // Beside the clicked text, kept inside the window.
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - w - 8);
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${top}px`;
}

function showNodeMenu(anchor, hash, name) {
    const node = cachedNodes.find(n => n.hash === hash) || {};
    const isFavorite = favoriteNodes.some(f => f.hash === hash);
    const info = () => {
        const btn = document.querySelector(`.node-item[data-hash="${CSS.escape(hash)}"] .info-btn`);
        if (btn) btn.click();
    };
    const cached = nodeCacheSummary[String(hash).toLowerCase()];
    const cachedCount = cached ? cached.count : 0;
    openNodeMenu(anchor, name || hash, hash, [
        { label: 'Open', run: () => browseNode(hash, name) },
        { label: 'Open in a new tab', run: () => openQuickAddress(`${hash}:/page/index.mu`, name, true),
          tip: 'Always a new tab, even if this one is empty' },
        { label: 'Open in a new tab in background', run: () => openInBackgroundTab(`${hash}:/page/index.mu`, name),
          tip: 'Loads in a new tab; you stay where you are' },
        '-',
        { label: 'Node info', run: info },
        // The operator's LXMF address, opened straight in a chat to write to it.
        ...(node.operator_lxmf_address ? [{
            label: 'Message the operator (LXMF)',
            disabled: !(typeof messengerEnabled === 'function' && messengerEnabled()),
            run: () => openMessenger(node.operator_lxmf_address),
            tip: (typeof messengerEnabled === 'function' && messengerEnabled())
                ? `Write to ${node.operator_name || 'the operator'} (${node.operator_lxmf_address.slice(0, 8)}…) in Messages`
                : 'Turn on the messenger in Settings > LXMF Messenger' }] : []),
        ...(node.operator_lxmf_address && typeof messengerEnabled === 'function' && messengerEnabled()
            && !(Messenger.conversations || []).some(c => c.peer === node.operator_lxmf_address) ? [{
            label: 'Add the operator to contacts',
            run: () => addContactChecked(node.operator_lxmf_address, node.operator_name || ''),
            tip: 'Keep the operator in your conversations without writing first' }] : []),
        { label: 'Copy address', run: () => copyHashToClipboard(hash) },
        { label: 'Ping', run: () => pingNode(hash, name) },
        { label: 'Check path', run: () => checkPath(hash, name),
          tip: 'The path held to this node now: hops, next hop, age, expiry. Nothing is sent' },
        { label: 'Request a new path', run: () => requestPath(hash, name),
          tip: 'Forget the path to this node and ask the network for a new one' },
        '-',
        { label: isFavorite ? 'Remove from favorites' : 'Add to favorites', run: () => toggleFavorite(hash, name) },
        { label: cachedCount ? `Remove from cache (${cachedCount} page${cachedCount === 1 ? '' : 's'})`
                             : 'Remove from cache',
          disabled: !cachedCount, run: () => removeNodeFromCache(hash, name),
          tip: cachedCount ? 'Delete the saved pages of this node from disk: the next visit fetches them fresh'
                           : 'No pages of this node are saved' },
        { label: 'Hide from the list', danger: true, run: () => hideNode(hash, name) },
    ]);
}

// The saved pages of one node off the disk: old pages gone, and the next
// visit fetches them fresh from the node instead of opening the copy.
async function removeNodeFromCache(hash, name) {
    try {
        const result = await fetch('/api/cache/clear', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ node_hash: hash })
        }).then(r => r.json());
        const n = result.removed || 0;
        showNotification(`Removed ${n} saved page${n === 1 ? '' : 's'} of ${name || hash.slice(0, 16)}`,
                         'success', 3000);
    } catch (err) {
        showNotification(`Could not remove from the cache: ${err.message}`, 'error', 5000);
        return;
    }
    savedPagesLoadedAt = 0;          // the search list reloads without them
    refreshNodeCacheSummary();       // the ring and the disk on the card go

    // A page of this node open in a tab: its badge ("live and saved") and
    // pill say what the disk holds now. Live pages are no longer saved; a
    // copy on screen stays, marked as deleted.
    const target = String(hash).toLowerCase();
    for (const tab of tabs) {
        const response = tab.pageResponse;
        const url = String(tab.currentUrl || '').toLowerCase();
        if (!response || !url.startsWith(target + ':')) continue;
        const updated = response.source === 'network'
            ? { ...response, cached: false }
            : { ...response, cache_removed: true };
        setPageSource(tab, updated);
        const badge = document.querySelector(`#${tab.id} .source-badge`);
        const html = sourceBadgeHtml(updated).trim();
        if (badge) {
            if (html) badge.outerHTML = html;
            else badge.remove();
        }
    }
}

function showOperatorMenu(anchor, hash) {
    const node = cachedNodes.find(n => n.hash === hash) || {};
    if (node.operator_lxmf_address) showLxmfMenu(anchor, node.operator_lxmf_address, node.operator_name);
}

// The menu of an LXMF address: on the operator's address in the node list,
// and on a conversation card in Messages.
// title: the heading when there is no name (a link in a page is not a node operator).
function showLxmfMenu(anchor, address, name, title = 'Node operator', first = []) {
    const messenger = typeof messengerEnabled === 'function' && messengerEnabled();
    const conv = messenger ? (Messenger.conversations || []).find(c => c.peer === address) : null;
    const blocked = messenger && ((Messenger.state && Messenger.state.blocked) || []).some(b => b.address === address);
    const unread = conv && conv.unread ? ` (${conv.unread} new)` : '';
    // The same actions as the conversation's header in Messages.
    openNodeMenu(anchor, name || title, address, [
        ...first,
        ...(messenger ? [{ label: 'Open messenger', run: () => openMessenger(),
                           tip: 'Messages, on the list of conversations' }, '-',
                         { label: 'Send message' + unread, run: () => openMessenger(address),
                           tip: 'Open a conversation with this address in Messages' }, '-'] : []),
        { label: 'Copy LXMF address', run: () => copyOperatorAddress(address) },
        ...(messenger ? [{ label: 'Send address to…', run: () => sendAddressTo(address, name || ''),
                           tip: 'Send this address to one of your contacts: name, hash and lxmf:// link in a message' }] : []),
        ...(messenger && !conv ? [{ label: 'Add to contacts', run: () => addContactChecked(address, name || ''),
                                    tip: 'Keep it in your conversations without writing to it first' }] : []),
        ...(messenger ? [{ label: 'Customize contact', run: () => openAvatarColors(address),
                           tip: 'Its colour, and the name you give it' },
                         { label: 'Rename contact', run: () => renameContact(address),
                           tip: 'A name of your own for this contact, shown instead of the announced one' },
                         isFavoriteContact(address)
                             ? { label: 'Remove from favourite contacts', run: () => toggleFavoriteContact(address) }
                             : { label: 'Add to favourite contacts', run: () => toggleFavoriteContact(address),
                                 tip: 'Shown first in Messages, above a thin line' }] : []),
        '-',
        ...(messenger ? [{ label: 'Peer info', run: () => messengerPeerInfo(address),
                           tip: 'Everything known about this contact: node, path, keys' },
                         { label: 'Ping', run: () => messengerPing(address),
                           tip: 'Open a link to this address and time the answer. No message is sent' }] : []),
        { label: 'Check if reachable', run: () => checkLxmfReachable(address, name),
          tip: 'One path request: does anything answer on this address?' },
        ...(messenger ? [
            blocked ? { label: 'Unblock', run: () => messengerUnblock(address),
                        tip: 'Accept messages from this address again' }
                    : { label: 'Block', danger: true, run: () => messengerBlock(address),
                        tip: 'Drop every message from this address' },
            { label: 'Delete conversation', danger: true, disabled: !conv,
              run: () => messengerDeleteConversation(address),
              tip: conv ? 'Delete this conversation from this computer' : 'No conversation with this address' },
        ] : []),
    ]);
}

// The address always exists, worked out from the node's identity, but only
// NomadNet listens on it; other page servers do not, and a message there
// fails. One path request tells which.
const lxmfChecksRunning = new Set();

async function checkLxmfReachable(address, name) {
    if (lxmfChecksRunning.has(address)) return;
    lxmfChecksRunning.add(address);
    const label = escapeHtml(name || address.slice(0, 16) + '…');
    const waiting = showNotification(`Asking the network for ${label}…`, 'info', 120000);
    let data;
    try {
        data = await fetch(`/api/lxmf-check/${encodeURIComponent(address)}`, { method: 'POST' }).then(r => r.json());
    } catch (e) {
        data = { status: 'error', error: e.message };
    } finally {
        lxmfChecksRunning.delete(address);
        if (waiting && waiting.parentNode) waiting.parentNode.removeChild(waiting);
    }
    if (data.status !== 'success') {
        showNotification(`Could not check ${label}: ${escapeHtml(data.error || 'unknown error')}`, 'error', 6000);
    } else if (data.reachable) {
        const how = data.known ? 'path already known' : `answered in ${(data.elapsed || 0).toFixed(1)} s`;
        showNotification(`LXMF ${label} is reachable: <strong>${escapeHtml(pathText(data.path))}</strong>, ${how}.`,
                         'success', 7000);
    } else {
        showNotification(`No answer on LXMF ${label} in ${(data.elapsed || 0).toFixed(0)} s.`
            + '<br>The node may run a page server without LXMF, or be offline: a message would likely fail.',
            'error', 9000);
    }
}

document.addEventListener('click', e => {
    const menu = document.getElementById('node-menu');
    if (menu && !menu.contains(e.target)) closeNodeMenu();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNodeMenu(); });
window.addEventListener('resize', closeNodeMenu);

// Mouse, pen or finger, from the last press: a click event alone does not
// say it in every browser.
let lastPointerType = 'mouse';
document.addEventListener('pointerdown', e => { lastPointerType = e.pointerType || 'mouse'; }, true);

// Right-click on a node card, or a long press on a phone, opens the node's
// menu (on the operator's address, the operator's menu). Android sends the
// long press as a contextmenu event; iOS does not, hence the timer.
// A conversation card in Messages gets the same LXMF menu.
(function initNodeCardMenu() {
    const LONG_PRESS_MS = 500;
    const CARDS = '.node-item, .msg-conv';
    let openedAt = 0;
    let swallowClick = false;
    let press = null;

    function openFor(target, x, y) {
        const item = target.closest(CARDS);
        if (!item || Date.now() - openedAt < 800) return false;
        if (target.closest('button, .copy-icon, .operator-icon')) return false;
        openedAt = Date.now();
        // The contact's round logo: its colour, not the menu.
        const avatar = target.closest('.msg-avatar[data-peer]');
        if (avatar) {
            openAvatarColors(avatar.dataset.peer);
            return true;
        }
        // A point, so the menu comes up where the mouse or finger is.
        const at = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }) };
        if (item.classList.contains('msg-conv')) {
            const conv = (Messenger.conversations || []).find(c => c.peer === item.dataset.peer);
            showLxmfMenu(at, item.dataset.peer, peerLabel(item.dataset.peer, conv && conv.name));
            return true;
        }
        const operatorText = target.closest('.operator-text');
        if (operatorText) showOperatorMenu(at, item.dataset.hash);
        else showNodeMenu(at, item.dataset.hash, item.dataset.name);
        return true;
    }

    // Not a long press (the menu came up opening the list with a swipe,
    // and taking a screenshot): a touch that started at the left edge (the
    // swipe zone), moved, or had more than one finger. Android sends its
    // contextmenu for those too, when the finger rests half a second first.
    let gesture = { x: 0, y: 0, moved: false, edge: false, multi: false };

    document.addEventListener('contextmenu', e => {
        const item = e.target.closest(CARDS);
        if (!item || e.target.closest('button, .copy-icon, .operator-icon')) return;
        e.preventDefault();
        if (lastPointerType === 'touch' && (gesture.moved || gesture.edge || gesture.multi)) return;
        if (openFor(e.target, e.clientX, e.clientY) && lastPointerType === 'touch') swallowClick = true;
    });

    document.addEventListener('touchstart', e => {
        swallowClick = false;       // a new touch: whatever comes next is real
        const first = e.touches[0];
        if (e.touches.length === 1) {
            gesture = { x: first.clientX, y: first.clientY, moved: false, edge: first.clientX < 24, multi: false };
        } else {
            gesture.multi = true;
        }
        if (e.touches.length !== 1 || gesture.edge || !e.target.closest(CARDS)) { cancel(); return; }
        const t = e.touches[0];
        const target = e.target;
        press = { x: t.clientX, y: t.clientY, timer: setTimeout(() => {
            if (openFor(target, t.clientX, t.clientY)) swallowClick = true;
            press = null;
        }, LONG_PRESS_MS) };
    }, { passive: true });

    function cancel() { if (press) { clearTimeout(press.timer); press = null; } }
    document.addEventListener('touchmove', e => {
        const t = e.touches[0];
        if (e.touches.length > 1) gesture.multi = true;
        if (Math.abs(t.clientX - gesture.x) > 10 || Math.abs(t.clientY - gesture.y) > 10) gesture.moved = true;
        if (press && (gesture.moved || gesture.multi)) cancel();
    }, { passive: true });
    document.addEventListener('touchend', cancel, { passive: true });
    document.addEventListener('touchcancel', cancel, { passive: true });

    // Lifting the finger after a long press must not also open the node,
    // nor close the menu that just appeared.
    document.addEventListener('click', e => {
        if (!swallowClick) return;
        swallowClick = false;
        if (Date.now() - openedAt > 2000) return;
        e.preventDefault();
        e.stopPropagation();
    }, true);
})();

// Esc in a search box with its × clears it, as the × does: the node
// search, the Local Search Engine, the LXMF search. A second Esc, on the
// empty box, does what Esc did before (closes the window it is in).
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.isComposing) return;
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || !input.value || !input.parentElement) return;
    const clear = input.parentElement.querySelector(':scope > .search-clear');
    if (!clear || clear.classList.contains('address-clear')) return;
    e.preventDefault();
    e.stopPropagation();
    clear.click();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
}, true);

// The pause button in the nav bar: the node list stands still while you read
// it. Announces are still heard and stored by the server; they come
// into the list as soon as it runs again.
var nodeListPaused = false;   // var: read by updateNodes, which may run first

function toggleNodeListPause() {
    nodeListPaused = !nodeListPaused;
    const btn = document.getElementById('announce-pause-btn');
    if (btn) {
        btn.classList.toggle('paused', nodeListPaused);
        btn.title = nodeListPaused
            ? 'Node list paused: press to let the new announces in'
            : 'Pause the node list: new announces wait until you press it again';
    }
    const status = document.getElementById('node-count');
    if (status) status.classList.toggle('paused', nodeListPaused);
    showNotification(nodeListPaused ? 'Node list paused' : 'Node list running', 'info', 2000);
    if (!nodeListPaused) updateNodes();
}

// CPU and RAM in the status bar: the Python
// process of rBrowser (/api/usage) and, in Chrome/Edge, this page's own JS
// memory. Every 10 s while the page is in sight; the same in About.
function usageText(u) {
    if (!u || u.status !== 'success') return '';
    const page = performance.memory ? ` · page ${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB` : '';
    return `CPU ${u.cpu}% · RAM ${Math.round(u.rss_mb)} MB${page}`;
}

async function refreshUsage() {
    if (document.hidden || APP_WINDOW) return;
    const u = await fetch('/api/usage').then(r => r.json()).catch(() => null);
    const badge = document.getElementById('sb-usage');
    if (badge) {
        const text = usageText(u);
        badge.hidden = !text;
        // Built like the rows above: grey label, blue value.
        const stat = (label, value) => `<span class="sb-stat"><span class="sb-label">${label}:</span><span class="count">${value}</span></span>`;
        badge.innerHTML = text ? stat('CPU', `${u.cpu}%`) + stat('RAM', `${Math.round(u.rss_mb)} MB`)
            + (performance.memory ? stat('Page', `${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB`) : '') : '';
        badge.title = text ? `rBrowser (Python, PID ${u.pid}): CPU ${u.cpu}% of the machine, RAM ${u.rss_mb} MB, ${u.threads} threads`
            + (performance.memory ? `\nThis page (browser tab): ${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB of JavaScript memory` : '') : '';
    }
    const about = document.getElementById('settings-usage');
    if (about) about.textContent = usageText(u) || (u && u.error) || '';
}
setTimeout(refreshUsage, 1000);
setInterval(refreshUsage, 10000);
// A reading skipped while the page was out of sight (a phone switching
// apps) would leave the row empty until the next one: one now instead.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshUsage(); });
