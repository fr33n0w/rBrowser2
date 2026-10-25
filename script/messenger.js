// The LXMF messenger: the Messages tab. Server side in rbrowser/messenger.py,
// which does the sending, receiving and storing through LXMF itself; this
// file only shows it. Loaded after rbrowser.js and uses its helpers
// (escapeHtml, showNotification, switchToTab, cachedNodes, ...).

const Messenger = {
    state: null,            // GET /api/messenger
    open: false,            // the Messages tab is on screen
    peer: null,             // the conversation shown
    conversations: [],
    revision: -1,
    shownRevision: -1,
    ephemeralOk: false,     // "send anyway" for this session
    pollTimer: null,
    names: {},              // announced names read by the chat: {address: name}
    pending: [],            // files to go with the next message (File objects)
    pendingPeer: null,      // the conversation they belong to
    // Chats open as tabs, for the session: [{id: our identity, me: its
    // address, peer}]; and what each keeps while not shown: {key: {draft,
    // pending, replyTo, scroll}}.
    tabs: [],
    tabState: {},
};

const MSG_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5V11.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';

const GEAR_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';

// Settings opened at the Messenger section.
function openMessengerSettings() {
    showSettings('messenger');
}

function messengerEnabled() {
    return !!(Messenger.state && Messenger.state.settings && Messenger.state.settings.enabled);
}

// ─── The tab ────────────────────────────────────────────────

function ensureMessengerTab() {
    let tab = document.getElementById('messenger-tab');
    if (!tab) {
        tab = document.createElement('div');
        tab.className = 'tab tab-messages';
        tab.id = 'messenger-tab';
        tab.title = 'Messages (LXMF)';
        tab.innerHTML = `${MSG_ICON}<span class="tab-app-label">LXMF</span><span class="tab-messages-badge" hidden></span>`;
        tab.addEventListener('click', () => openAppTab('lxmf'));
        addAppTabOff(tab, 'LXMF Messenger', () => saveMessengerSettings({ enabled: false }), {
            close: () => closeMessenger(),
            disconnect: async () => { if (!(Messenger.state && Messenger.state.settings && Messenger.state.settings.offline)) await messengerToggleOffline(); },
            disconnectTip: 'goes offline: no identity listens, the chats stay readable (Go online in its bar)',
        });
        placeAppTab(tab);
    }
    let view = document.getElementById('messenger-view');
    if (!view) {
        view = document.createElement('div');
        view.className = 'tab-content messenger-view';
        view.id = 'messenger-view';
        view.innerHTML = `
            <div class="msg-bar">
                <!-- As wide as the conversation list below it. -->
                <div class="msg-bar-head">
                    <button class="nav-btn sidebar-toggle-btn" onclick="toggleSidebar()" title="Hide the node list">&laquo;</button>${appMainButton()}
                    <span class="msg-bar-title">${MSG_ICON}<span><span class="msg-lxmf">LXMF</span> Messenger</span></span>
                    ${clientListButton('lxmf')}
                    <button class="msg-bar-btn msg-settings-btn" onclick="openMessengerSettings()" title="Messenger settings" aria-label="Messenger settings">${GEAR_ICON}</button>
                    <button class="msg-close" onclick="closeMessenger()" title="Close Messages" aria-label="Close">&times;</button>
                </div>
                <div class="msg-bar-main">
                    <div class="msg-me" id="msg-me" hidden></div>
                    <span class="msg-identity-label">LXMF Identity in use:</span>
                    <div class="msg-identity-wrap" id="msg-identity-wrap">
                        <button class="msg-identity" id="msg-identity" title="The identity you write as - click to change"></button>
                        <div class="msg-identity-menu" id="msg-identity-menu" hidden></div>
                    </div>
                    <button class="msg-bar-btn primary" onclick="messengerNewMessage()" title="Write to an LXMF address">+ New</button>
                    <button class="msg-bar-btn" onclick="messengerAddContact()" title="Add an LXMF address to your conversations without writing to it">+ Contact</button>
                    <button class="msg-bar-btn msg-peers-toggle" id="msg-peers-toggle" onclick="toggleMessengerPeers()" title="LXMF peers heard announcing on the network, as LXMF clients list them">Peers</button>
                    <button class="msg-bar-btn" onclick="messengerAnnounceNow()" title="Announce your LXMF address and name now">Announce</button>
                    <button class="msg-bar-btn" id="msg-sync-btn" onclick="messengerBarSync()" title="Collect the messages waiting for you on the propagation node">Sync</button>
                    <button class="msg-bar-btn msg-offline-btn" id="msg-offline-btn" onclick="messengerToggleOffline()" title="Stop listening on all your LXMF identities, without turning the messenger off">Go offline</button>
                    <button class="msg-bar-btn auto-reply-btn" data-kind="messenger" onclick="toggleAutoReplyMenu(this, 'messenger')" title="Automatic replies: keywords, away, echo (green dot: one is on)">AutoReply</button>${awayButton('messenger')}
                </div>
            </div>
            <div class="msg-body" id="msg-body">
                <div class="msg-peers" id="msg-peers" hidden>
                    <div class="msg-search-wrap msg-peers-head">
                        <div class="msg-peers-title"><span>Announced peers</span><span class="msg-peers-count" id="msg-peers-count"></span>
                            <button class="msg-close" onclick="toggleMessengerPeers(false)" title="Close" aria-label="Close">&times;</button></div>
                        <input type="text" id="msg-peers-search" class="msg-search" placeholder="Search name or address"
                               spellcheck="false" autocomplete="off" aria-label="Search announced peers">
                    </div>
                    <div id="msg-peers-items"><div class="msg-search-none">Listening…</div></div>
                </div>
                <div class="msg-list" id="msg-list">
                    <div class="msg-search-wrap">
                        <div class="msg-search-box">
                            <input type="text" id="msg-search" class="msg-search" placeholder="Search contacts and messages"
                                   spellcheck="false" autocomplete="off" aria-label="Search contacts and messages">
                            <button class="search-clear msg-search-clear" id="msg-search-clear" type="button" hidden
                                    title="Clear the search (Esc)" aria-label="Clear the search">×</button>
                        </div>
                        <!-- The order of this list: here, where it acts. -->
                        <select class="msg-sort" id="msg-sort" title="Order of the conversations">
                            <option value="alphabetical">A-Z</option>
                            <option value="recent">Recent</option>
                            <option value="started">Started</option>
                        </select>
                    </div>
                    <div id="msg-list-items"></div>
                    <div id="msg-search-hits"></div>
                </div>
                <div class="msg-chat-col" id="msg-chat-col">
                    <div class="msg-incoming" id="msg-incoming" hidden></div>
                    <div class="msg-tabs" id="msg-tabs" hidden></div>
                    <div class="msg-chat" id="msg-chat"></div>
                </div>
            </div>`;
        document.getElementById('tab-content-wrapper').appendChild(view);
        const sort = document.getElementById('msg-sort');
        sort.value = messengerSortMode();
        sort.addEventListener('change', () => {
            try { localStorage.setItem(MSG_SORT_KEY, sort.value); } catch (e) {}
            renderConversationList();
        });
        bindMessengerSearch();
        // The sidebar toggle in this bar follows the others.
        applySidebarState(document.body.classList.contains('sidebar-collapsed'));
        applyClientList('lxmf');
    }
    return tab;
}

function applyMessengerVisibility() {
    const on = messengerEnabled();
    if (on) ensureMessengerTab();
    const tab = document.getElementById('messenger-tab');
    if (tab) tab.hidden = !on;
    layoutAppTabs();
    if (!on && Messenger.open) closeMessenger();
    updateMessengerBadge();
    // LXMF has no connection: green while the router runs and listens.
    if (tab && on) {
        const st = Messenger.state || {};
        const n = st.listening || 0;
        const offline = !!(st.settings && st.settings.offline);
        if (offline && !st.error) setAppTabState(tab, 'offline', 'LXMF: offline, not listening (Go online in the Messages bar)');
        else setAppTabState(tab, st.error ? 'failed' : st.running ? 'connected' : 'connecting',
            st.error ? `LXMF: ${st.error}` : st.running
                ? `LXMF: listening${n ? ` on ${n} identit${n === 1 ? 'y' : 'ies'}` : ''}` : 'LXMF: starting…');
    }
}

function updateMessengerBadge() {
    const badge = document.querySelector('#messenger-tab .tab-messages-badge');
    if (!badge) return;
    // Every identity listens: the tab counts them all.
    const n = ((Messenger.state && Messenger.state.unread) || 0) + ((Messenger.state && Messenger.state.unread_other) || 0);
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
    const tab = document.getElementById('messenger-tab');
    if (tab) tab.title = n ? `Messages (LXMF): ${n} unread` : 'Messages (LXMF)';
}

function openMessenger(peer) {
    if (!messengerEnabled()) {
        showNotification('The messenger is off: Settings > LXMF Messenger', 'info', 5000);
        return;
    }
    ensureMessengerTab();
    if (typeof RetiBBS !== 'undefined') RetiBBS.open = false;
    document.body.classList.remove('retibbs-open');
    if (typeof Rmap !== 'undefined') Rmap.open = false;
    document.body.classList.remove('rmap-open');
    if (typeof Rrc !== 'undefined') Rrc.open = false;
    document.body.classList.remove('rrc-open');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('messenger-tab').classList.add('active');
    document.getElementById('messenger-view').classList.add('active');
    document.body.classList.add('messenger-open');
    Messenger.open = true;
    Messenger.identityKey = null;
    // A conversation asked for opens; otherwise Messages comes back as it
    // was left (the chat that was open stays open). Only a fresh start of
    // the page begins from the list.
    if (peer) Messenger.peer = peer;
    renderMessengerIdentity();
    refreshMessenger(true);
}

function closeMessenger() {
    if (appWindowClose()) return;
    Messenger.open = false;
    document.body.classList.remove('messenger-open');
    const view = document.getElementById('messenger-view');
    if (view) view.classList.remove('active');
    const tab = document.getElementById('messenger-tab');
    if (tab) tab.classList.remove('active');
    if (activeTabId) switchToTab(activeTabId);
}

// A circle with the first letter of a name, its colour from the address:
// the same contact always looks the same.
// A colour picked for the contact (Settings are on the server, so every
// device shows the same) takes the place of the one from the address.
function autoAvatarHue(peer) {
    return parseInt(String(peer || '0').slice(0, 4), 16) % 360 || 210;
}

function avatarHue(peer) {
    const picked = Messenger.state && Messenger.state.colors && Messenger.state.colors[peer];
    return typeof picked === 'number' ? picked : autoAvatarHue(peer);
}

function avatarLetter(peer, name) {
    return (Array.from((nicknameOf(peer) || name || peer || '?').replace(/^[^\p{L}\p{N}\p{Extended_Pictographic}]+/u, ''))[0] || '?').toUpperCase();
}

// contact = false for your own identities (the identity menu): no info
// panel and no colour to pick there.
function avatarHtml(peer, name, cls = '', contact = true) {
    const data = contact && peer
        ? ` data-peer="${escapeHtml(peer)}" title="Click: customize - right-click: contact info"` : '';
    // Sideband's own look for the contact (FIELD_ICON_APPEARANCE) wins over
    // a colour picked here, unless switched off (Settings > LXMF Messenger).
    const st = Messenger.state || {};
    const useLook = !st.settings || st.settings.sideband_look !== false;
    const look = useLook && peer && st.appearances && st.appearances[peer];
    const valid = c => /^#[0-9a-f]{6}$/i.test(String(c || ''));
    const style = look && valid(look.bg) && valid(look.fg)
        ? `--av-h:${avatarHue(peer)};background:${look.bg};color:${look.fg};border-color:${look.bg}` : `--av-h:${avatarHue(peer)}`;
    const lookTip = look && look.icon ? ` data-icon="${escapeHtml(look.icon)}"` : '';
    const glyph = look && look.icon ? mdiGlyph(look.icon) : null;
    return `<span class="msg-avatar ${cls}${glyph ? ' mdi-icon' : ''}"${data}${lookTip} style="${style}">${
        glyph ? `<i class="mdi-glyph">${glyph}</i>` : escapeHtml(avatarLetter(peer, name))}</span>`;
}

// Sideband's icon (FIELD_ICON_APPEARANCE names a Material Design Icon):
// drawn with the MDI font kept in templates/fonts. The name -> character
// map (190 KB) is read the first time a contact has an icon; until then,
// and for a name it does not know, the letter.
const MDI = { map: null, loading: false };

function mdiGlyph(name) {
    if (!MDI.map) { loadMdiMap(); return null; }
    const cp = MDI.map[String(name).replace(/^mdi-/, '')];
    return cp ? String.fromCodePoint(parseInt(cp, 16)) : null;
}

function loadMdiMap() {
    if (MDI.loading) return;
    MDI.loading = true;
    fetch('/templates/fonts/mdi-map.json').then(r => r.json()).then(map => {
        MDI.map = map;
        applySidebandIcons();
    }).catch(() => { MDI.loading = false; });
}

function applySidebandIcons() {
    if (!MDI.map) return;
    document.querySelectorAll('.msg-avatar[data-icon]').forEach(a => {
        const glyph = mdiGlyph(a.dataset.icon);
        if (glyph && a.textContent !== glyph) {
            a.innerHTML = `<i class="mdi-glyph">${glyph}</i>`;
            a.classList.add('mdi-icon');
        }
    });
}

// Colours already on screen follow a change, here or from another device.
function applyAvatarColors() {
    document.querySelectorAll('.msg-avatar[data-peer]').forEach(a => {
        const hue = String(avatarHue(a.dataset.peer));
        if (a.style.getPropertyValue('--av-h') !== hue) a.style.setProperty('--av-h', hue);
    });
}

// Click on a contact's logo: customize it (colour, name) - it is the logo
// itself. Right-click: its info. Caught before the card's own click (open
// the chat) and right-click (menu).
document.addEventListener('click', e => {
    const avatar = e.target.closest('.msg-avatar[data-peer]');
    if (!avatar || e.defaultPrevented) return;
    e.stopPropagation();
    openAvatarColors(avatar.dataset.peer);
}, true);

document.addEventListener('contextmenu', e => {
    const avatar = e.target.closest('.msg-avatar[data-peer]');
    if (!avatar) return;
    e.preventDefault();
    e.stopPropagation();
    messengerPeerInfo(avatar.dataset.peer);
}, true);

// Nineteen hues evenly round the wheel: with Automatic, two rows of ten.
const AVATAR_HUES = Array.from({ length: 19 }, (_, i) => Math.round(i * 360 / 19));

// opts.self: our own address (the avatar in the Messages bar) - no star,
// and the pencil changes our announced name, not a contact's nickname.
function openAvatarColors(peer, opts = {}) {
    if (document.getElementById('avatar-colors-modal')) return;
    const self = !!opts.self;
    const conv = (Messenger.conversations || []).find(c => c.peer === peer);
    const name = self ? (opts.name || 'Anonymous Peer') : knownName(peer, conv);
    const picked = Messenger.state && Messenger.state.colors && Messenger.state.colors[peer];
    let hue = typeof picked === 'number' ? picked : null;      // null = automatic

    const overlay = document.createElement('div');
    overlay.className = 'auto-reload-modal';
    overlay.id = 'avatar-colors-modal';
    // The automatic one: the colour from the address, marked with a
    // "back to automatic" arrow rather than a letter.
    const AUTO_ICON = '<svg viewBox="0 0 16 16" width="60%" height="60%" fill="none" stroke="currentColor" stroke-width="1.8"'
        + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7"/>'
        + '<path d="M13 2.5v3h-3"/></svg>';
    const AUTO_LABEL = 'Automatic - the colour comes from the address';
    const swatch = h => {
        const label = h === 'auto' ? AUTO_LABEL : 'Custom colour';
        return `<button class="avatar-swatch${h === 'auto' ? ' auto' : ''}" data-hue="${h}" title="${label}"
            aria-label="${label}"><span class="msg-avatar" style="--av-h:${h === 'auto' ? autoAvatarHue(peer) : h}">${
            h === 'auto' ? AUTO_ICON : ''}</span></button>`;
    };
    overlay.innerHTML = `
        <div class="auto-reload-dialog avatar-colors-dialog">
            <div class="dialog-header">
                <h3>${self ? 'Customize me' : 'Customize contact'}</h3>
                <button class="modal-close" data-close title="Close" aria-label="Close">&times;</button>
            </div>
            <div class="avatar-colors-preview">
                <span class="msg-avatar avatar-colors-big" id="avatar-colors-sample">${escapeHtml(avatarLetter(peer, name))}</span>
                <div class="avatar-colors-name">${self ? escapeHtml(name) : starButton(peer) + escapeHtml(peerLabel(peer, name))}
                    <button class="msg-rename-btn" data-rename title="${self ? 'Change your name' : 'Rename contact'}"
                            aria-label="${self ? 'Change your name' : 'Rename contact'}">${PENCIL_ICON}</button></div>
                <code class="avatar-colors-addr">${escapeHtml(peer)}</code>
                <div class="avatar-colors-choice" id="avatar-colors-choice"></div>
            </div>
            <div class="avatar-colors-grid">
                ${swatch('auto')}
                ${AVATAR_HUES.map(h => swatch(h)).join('')}
            </div>
            <input type="range" class="avatar-colors-slider" min="0" max="359" step="1" aria-label="Fine hue">
            <div class="settings-hint">Kept in rBrowser: every device you open it from shows the same colour.
                Only you see it.</div>
            <div class="auto-reload-actions">
                <button class="btn-cancel" data-close>Cancel</button>
                <button class="btn-save" data-save>Save</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const sample = overlay.querySelector('#avatar-colors-sample');
    const choice = overlay.querySelector('#avatar-colors-choice');
    const slider = overlay.querySelector('.avatar-colors-slider');
    // The preview shows the choice, or while the pointer is over a swatch,
    // that swatch - with words saying which kind it is.
    const preview = h => {
        sample.style.setProperty('--av-h', h === null ? autoAvatarHue(peer) : h);
        choice.textContent = h === null ? AUTO_LABEL : 'Custom colour';
        choice.classList.toggle('auto', h === null);
    };
    const show = () => {
        preview(hue);
        slider.value = hue === null ? autoAvatarHue(peer) : hue;
        overlay.querySelectorAll('.avatar-swatch').forEach(b =>
            b.classList.toggle('active', hue === null ? b.dataset.hue === 'auto' : Number(b.dataset.hue) === hue));
    };
    show();
    const own = b => (b.dataset.hue === 'auto' ? null : Number(b.dataset.hue));
    overlay.querySelectorAll('.avatar-swatch').forEach(b =>
        b.addEventListener('click', () => { hue = own(b); show(); }));
    // Back to the choice only on leaving the whole grid: per swatch, the
    // gaps between them flipped the preview back and forth while moving
    // along a row.
    const grid = overlay.querySelector('.avatar-colors-grid');
    grid.addEventListener('pointerover', e => {
        const b = e.target.closest('.avatar-swatch');
        if (b) preview(own(b));
    });
    grid.addEventListener('pointerleave', () => preview(hue));
    slider.addEventListener('input', () => { hue = Number(slider.value); show(); });

    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
    overlay.querySelector('[data-rename]').addEventListener('click', () => { close(); self ? editMyName() : renameContact(peer); });
    overlay.querySelector('[data-save]').addEventListener('click', async () => {
        let res;
        try {
            res = await fetch(`/api/messenger/color/${encodeURIComponent(peer)}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hue }),
            }).then(r => r.json());
        } catch (e) {
            res = { status: 'error', error: e.message };
        }
        if (res.status !== 'success') {
            showNotification(`Colour not saved: ${escapeHtml(res.error || 'error')}`, 'error', 5000);
            return;
        }
        if (Messenger.state) Messenger.state.colors = res.colors;
        applyAvatarColors();
        if (self) renderMessengerIdentity();
        close();
    });
}

// The identity you write as, and a menu to switch to another at once.
function renderMessengerIdentity() {
    const box = document.getElementById('msg-identity');
    const st = Messenger.state;
    if (!box || !st) return;
    const myName = st.settings ? st.settings.display_name || '' : '';
    const key = [st.running, st.address, st.identity_name, st.ephemeral, (st.identities || []).length, st.error,
                 myName, st.address ? avatarHue(st.address) : '', st.unread_other || 0].join('|');
    if (key === Messenger.identityKey) return;
    Messenger.identityKey = key;
    if (!st.running) {
        box.className = 'msg-identity off';
        box.innerHTML = `<span class="msg-identity-name">${escapeHtml(st.error || 'Not listening')}</span><span class="msg-caret">▾</span>`;
    } else {
        box.className = 'msg-identity' + (st.ephemeral ? ' ephemeral' : '');
        // Narrow bar: only the dot and this icon show (style.css, msgbar).
        box.title = `Writing as ${st.identity_name} (${st.address}) - click to change`;
        box.innerHTML = `<span class="msg-dot"></span>`
            + `<span class="msg-identity-icon" aria-hidden="true">${IDENTITY_ICON}</span>`
            + `<span class="msg-identity-name">${escapeHtml(st.identity_name)}</span>`
            + `<code>${escapeHtml(st.address)}</code>`
            + (st.ephemeral ? '<span class="msg-eph-timer" id="msg-eph-timer"></span>' : '')
            // Unread on our other identities: they listen too.
            + (st.unread_other ? `<span class="msg-other-unread" title="${st.unread_other} unread on your other identities - open the menu">${
                st.unread_other > 99 ? '99+' : st.unread_other}</span>` : '')
            + '<span class="msg-caret">▾</span>';
    }
    box.onclick = e => { e.stopPropagation(); toggleIdentityMenu(); };
    renderMessengerMe(st, myName);
    tickEphemeralTimer();
}

// The ephemeral identity's change, in the identity button: a countdown when
// it is on a timer (ticks every second between polls), else when it goes.
function tickEphemeralTimer() {
    const els = document.querySelectorAll('.msg-eph-timer');
    const st = Messenger.state || {};
    if (!els.length || !st.ephemeral) return;
    const rot = st.ephemeral_rotation || {};
    let text, title;
    if (rot.mode === 'timed' && rot.seconds != null) {
        const left = Math.max(0, Math.round((Messenger.ephDue - Date.now()) / 1000));
        text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        title = `The ephemeral identity changes in ${durationText(left)}: replies that arrive after that are lost`;
    } else {
        text = rot.mode === 'reload' ? 'until reload' : 'until restart';
        title = `The ephemeral identity changes ${ephemeralChangeText(st)}`;
    }
    els.forEach(el => {
        if (el.textContent !== text) el.textContent = text;
        el.title = title;
    });
}

// The ephemeral identity in use becomes a saved one: same address, its
// chats kept on disk, reachable from now on (messenger.keep_ephemeral).
async function messengerKeepEphemeral() {
    const st = Messenger.state || {};
    const name = await askText('Keep this ephemeral identity',
        `It becomes a saved identity with the same address <code>${escapeHtml(shortAddr(st.address || ''))}</code>: `
        + 'its conversations are kept, it no longer changes, and people can write to it later. Name of the identity:',
        (st.settings && st.settings.display_name) || 'Kept identity', 'Keep');
    if (name === null || name === undefined) return;
    const res = await fetch('/api/messenger/keep-ephemeral', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
    if (res.status !== 'success') {
        showNotification(`Not kept: ${escapeHtml(res.error || 'error')}`, 'error', 5000);
        return;
    }
    showNotification(`Kept as <b>${escapeHtml(res.name)}</b>: same address, now a saved identity`, 'success', 4500);
    if (typeof loadIdentityState === 'function') loadIdentityState();
    Messenger.identityKey = null;
    await pollMessenger();
    refreshMessenger(false);
}

setInterval(tickEphemeralTimer, 1000);

// Us, before the identity: our avatar (click = customize, like a contact's)
// and the name announced for this identity, with the pencil to change it.
function renderMessengerMe(st, myName) {
    const me = document.getElementById('msg-me');
    if (!me) return;
    me.hidden = !st.running;
    if (!st.running) { me.innerHTML = ''; return; }
    me.innerHTML = avatarHtml(st.address, myName || 'Anonymous Peer', 'small msg-me-avatar', false)
        + `<span class="msg-me-name${myName ? '' : ' unnamed'}" title="Your name in announces - what others see">${
            escapeHtml(myName || 'Anonymous Peer')}</span>`
        + `<button class="msg-rename-btn" data-my-name title="Change your name for this identity" aria-label="Change your name">${PENCIL_ICON}</button>`;
    const avatar = me.querySelector('.msg-avatar');
    avatar.title = 'Your avatar - click to customize';
    avatar.onclick = e => { e.stopPropagation(); openAvatarColors(st.address, { self: true, name: myName }); };
    me.querySelector('[data-my-name]').onclick = () => editMyName();
    me.querySelector('.msg-me-name').ondblclick = () => editMyName();
}

async function editMyName() {
    const st = Messenger.state || {};
    if (!st.running || !st.settings) return;
    const identity = st.settings.identity;
    const current = st.settings.display_name || '';
    const html = (st.ephemeral
        ? 'The name of this ephemeral identity. It goes out only when you press Announce; '
          + 'empty: back to <b>eph_</b> and the first 4 characters of the address.'
        : `The name others see for <b>${escapeHtml(st.identity_name || '')}</b>: it is announced at once. `
          + 'Empty: Anonymous Peer.')
        + ' Each identity keeps its own.';
    const name = await askText('Your name', html, current, 'Save');
    if (name === null || name === undefined) return;
    let res;
    try {
        res = await fetch('/api/messenger/name', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identity, name }),
        }).then(r => r.json());
    } catch (e) {
        res = { status: 'error', error: e.message };
    }
    if (res.status !== 'success') {
        showNotification(`Name not saved: ${escapeHtml(res.error || 'error')}`, 'error', 5000);
        return;
    }
    showNotification(`Your name: <b>${escapeHtml(res.name || 'Anonymous Peer')}</b>`
        + (res.announced ? '<br>Announced' : (st.ephemeral ? '<br>Press Announce to send it' : '')), 'success', 3500);
    Messenger.identityKey = null;
    await pollMessenger();
    renderMessengerIdentity();
}

function toggleIdentityMenu(force) {
    const menu = document.getElementById('msg-identity-menu');
    const st = Messenger.state || {};
    if (!menu) return;
    const open = force !== undefined ? force : menu.hidden;
    menu.hidden = !open;
    if (!open) return;
    const current = st.settings ? st.settings.identity : '';
    menu.innerHTML = '<div class="msg-menu-head">Write as</div>'
        + (st.identities || []).map(i => `
            <button class="msg-menu-item${i.id === current ? ' current' : ''}${i.id === 'ephemeral' ? ' ephemeral' : ''}" data-id="${escapeHtml(i.id)}">
                ${avatarHtml(i.address, i.name, 'small', false)}
                <span class="msg-menu-text"><b>${escapeHtml(i.name)}${i.id === 'ephemeral' && st.ephemeral
                    ? ' <span class="msg-eph-timer"></span>' : ''}</b>${i.display_name
                    ? `<span class="msg-menu-nick">as ${escapeHtml(i.display_name)}</span>` : ''}<code>${escapeHtml(i.address)}</code></span>
                ${i.unread && i.id !== current ? `<span class="msg-conv-unread" title="${i.unread} unread">${i.unread > 99 ? '99+' : i.unread}</span>` : ''}
                ${i.id === current ? '<span class="msg-menu-check">✓</span>' : ''}
            </button>`).join('')
        + (st.address ? `<div class="msg-menu-sep"></div>
            <button class="msg-menu-item plain" data-copy="1">Copy my LXMF address</button>` : '')
        + (st.ephemeral && st.running ? `<button class="msg-menu-item plain" data-keep="1"
            title="Same address, no longer changing: its conversations are kept">Keep this ephemeral as a saved identity…</button>` : '')
        + '<button class="msg-menu-item plain" data-settings="1">Messenger settings…</button>';
    tickEphemeralTimer();
    menu.querySelectorAll('.msg-menu-item').forEach(btn => btn.onclick = async e => {
        e.stopPropagation();
        toggleIdentityMenu(false);
        if (btn.dataset.copy) return copyText(st.address, 'Your LXMF address copied');
        if (btn.dataset.keep) return messengerKeepEphemeral();
        if (btn.dataset.settings) return openMessengerSettings();
        if (btn.dataset.id === current) return;
        // The chat open stays open: the same contact, now as the other
        // identity (it used to close, and the contact had to be found again).
        await switchMessengerIdentity(btn.dataset.id, Messenger.peer || null);
        showNotification(`Now writing as ${escapeHtml(btn.querySelector('b').textContent)}`, 'success', 3000);
    });
}

// Write as another identity, and look at its conversations. All of them
// listen all the time: this only changes which one is in use.
async function switchMessengerIdentity(id, peer = null) {
    await saveMessengerSettings({ identity: id });
    Messenger.peer = peer;
    Messenger.identityKey = null;
    await pollMessenger();
    refreshMessenger(true);
}

document.addEventListener('click', e => {
    if (!e.target.closest('#msg-identity-wrap')) toggleIdentityMenu(false);
});

// ─── Polling ────────────────────────────────────────────────

async function pollMessenger() {
    try {
        Messenger.state = await fetch('/api/messenger').then(r => r.json());
        if (typeof syncAutoReplyButton === 'function') syncAutoReplyButton('messenger');
        syncOfflineButton();
    } catch (e) {
        return;
    }
    const rot = Messenger.state.ephemeral_rotation;
    if (rot && rot.seconds != null) Messenger.ephDue = Date.now() + rot.seconds * 1000;
    applyMessengerVisibility();
    applyAvatarColors();
    notifyIncoming(Messenger.state.incoming);
    if (Messenger.open) {
        renderMessengerIdentity();
        renderIncomingTransfers();
        renderChatTabs();
        renderPropagationControls();
        if (Messenger.state.revision !== Messenger.shownRevision) refreshMessenger(false);
        // LXMF announces heard: one may name the open contact. Read again,
        // at most every 10 s (announces can come in by the hundred).
        else if (Messenger.peer && Messenger.state.peers_revision !== Messenger.peersRevision
                 && Date.now() - (Messenger.namesReadAt || 0) > 10000) {
            Messenger.peersRevision = Messenger.state.peers_revision;
            Messenger.namesReadAt = Date.now();
            refreshMessenger(false);
        }
        // The path to the open contact can change at any time (a new
        // announce, another route): read again every other poll.
        Messenger.pathTick = (Messenger.pathTick || 0) + 1;
        if (Messenger.peer && Messenger.pathTick % 2 === 0) renderChatPath(Messenger.peer);
    } else if (messengerEnabled() && Messenger.state.revision !== Messenger.listRevision) {
        // Closed: the list is still wanted, for the marks on the node cards
        // and the node menus.
        Messenger.listRevision = Messenger.state.revision;
        try {
            const data = await fetch('/api/messenger/conversations').then(r => r.json());
            Messenger.conversations = data.conversations || [];
        } catch (e) {}
    }
    applyUnreadMarks();
}

// The Sync button in the bar and the 📮 "via propagation node" switch next to
// Send: usable with a propagation node and a saved identity only.
function propagationUsable() {
    const p = (Messenger.state && Messenger.state.propagation) || {};
    return !!(Messenger.state && Messenger.state.running && p.node && !p.ephemeral);
}

function renderPropagationControls() {
    const p = (Messenger.state && Messenger.state.propagation) || {};
    const sync = p.sync || {};
    const btn = document.getElementById('msg-sync-btn');
    if (btn) {
        const busy = sync.kind === 'busy';
        // Disabled only while a sync runs: when it cannot sync, a click
        // says why (a tooltip alone went unnoticed).
        btn.disabled = busy;
        btn.classList.toggle('unusable', !propagationUsable());
        btn.textContent = busy ? 'Syncing…' : 'Sync';
        btn.title = propagationBlocker()
            || `Collect the messages waiting for you on ${p.node.name || 'the propagation node'}`
               + (sync.last_sync ? ` - last sync ${durationText(Date.now() / 1000 - sync.last_sync)} ago` : '');
    }
    const via = document.querySelector('.msg-via-pn');
    if (via) {
        via.hidden = !propagationUsable();
        if (via.hidden) via.classList.remove('active');
    }
}

// Why a sync cannot be done now, or '' when it can.
function propagationBlocker() {
    const p = (Messenger.state && Messenger.state.propagation) || {};
    if (!Messenger.state || !Messenger.state.running) return 'The messenger is off';
    if (p.ephemeral) return 'Propagation nodes are for saved identities only, not the ephemeral one';
    if (!p.node) return p.mode === 'off' ? 'Propagation is off (Settings > LXMF Messenger)'
                                         : 'No propagation node heard yet (Settings > LXMF Messenger)';
    return '';
}

async function messengerBarSync() {
    const why = propagationBlocker();
    if (why) {
        showNotification(escapeHtml(why), 'error', 5000);
        return;
    }
    if (typeof messengerSyncNow === 'function') await messengerSyncNow();
    pollMessenger();
}

// A red envelope after the operator's LXMF address on a node card, when
// that address has written and the message is still unread. Re-applied on
// each poll: the node list redraws its cards on its own.
function applyUnreadMarks() {
    const unread = new Map();
    if (messengerEnabled()) {
        for (const c of Messenger.conversations || []) if (c.unread) unread.set(c.peer, c.unread);
    }
    document.querySelectorAll('.node-item').forEach(item => {
        const node = (typeof cachedNodes !== 'undefined' ? cachedNodes : []).find(n => n.hash === item.dataset.hash);
        const address = node && node.operator_lxmf_address;
        const n = address ? unread.get(address) : 0;
        const row = item.querySelector('.node-operator');
        if (!row) return;
        let mark = row.querySelector('.lxmf-unread');
        if (!n) { if (mark) mark.remove(); return; }
        if (!mark) {
            mark = document.createElement('span');
            mark.className = 'lxmf-unread';
            mark.innerHTML = MSG_ICON;
            mark.addEventListener('click', e => { e.stopPropagation(); openMessenger(address); });
            row.appendChild(mark);
        }
        mark.title = `${n} unread message${n === 1 ? '' : 's'} from ${node.operator_name || 'this operator'} - click to read`;
        mark.dataset.count = n > 9 ? '9+' : String(n);
    });
}

// A pop-up for each message that arrives, unless its conversation is the
// one on screen. Click it to open the conversation.
function notifyIncoming(incoming) {
    if (!incoming || typeof incoming.seq !== 'number') return;
    if (Messenger.lastSeq == null || incoming.seq < Messenger.lastSeq) {
        Messenger.lastSeq = incoming.seq;       // first look, or rBrowser restarted
        return;
    }
    if (incoming.seq === Messenger.lastSeq) return;
    const more = incoming.seq - Messenger.lastSeq - 1;
    Messenger.lastSeq = incoming.seq;
    if (!incoming.peer) return;
    // Written to another of our identities: not on screen even with that
    // contact's chat open (it is the chat of the identity in use).
    const other = !!incoming.other;
    // Looking = on screen AND the window has the focus (behind another window: a sound).
    const looking = !other && Messenger.open && Messenger.peer === incoming.peer && document.visibilityState === 'visible' && document.hasFocus();
    if (looking) return;
    if (typeof playSound === 'function') playSound('messenger');
    const who = escapeHtml(peerLabel(incoming.peer, incoming.name));
    const text = escapeHtml(String(incoming.preview || '').slice(0, 120));
    const to = other ? `<span class="msg-toast-to">to <b>${escapeHtml(incoming.identity_name || '')}</b>, not the identity in use</span><br>` : '';
    const note = showNotification(
        `<span class="msg-toast">${MSG_ICON}<b>${who}</b></span><br>${to}${text}`
        + (more > 0 ? `<br><i>and ${more} more</i>` : '')
        + `<br><span class="msg-toast-open">${other ? 'Click to switch to it and open' : 'Click to open'}</span>`, 'info', other ? 12000 : 8000);
    if (note && note.addEventListener) {
        note.style.cursor = 'pointer';
        note.addEventListener('click', async () => {
            note.remove();
            if (other && incoming.identity) {
                openMessenger();
                await switchMessengerIdentity(incoming.identity, incoming.peer);
                showNotification(`Now writing as ${escapeHtml(incoming.identity_name || '')}`, 'success', 3000);
            } else {
                openMessenger(incoming.peer);
            }
        });
    }
}

function startMessengerPolling() {
    pollMessenger();
    clearInterval(Messenger.pollTimer);
    Messenger.pollTimer = setInterval(pollMessenger, 3000);
}

async function refreshMessenger(scrollToEnd) {
    const revision = Messenger.state ? Messenger.state.revision : -1;
    // Only the latest refresh draws: an older one coming back late would
    // put back what was just closed.
    const turn = Messenger.refreshTurn = (Messenger.refreshTurn || 0) + 1;
    let data;
    try {
        data = await fetch('/api/messenger/conversations').then(r => r.json());
    } catch (e) {
        return;
    }
    if (turn !== Messenger.refreshTurn) return;
    Messenger.conversations = data.conversations || [];
    Messenger.shownRevision = revision;
    Messenger.listRevision = revision;
    applyUnreadMarks();
    // Called from the node list too, before the Messages tab was ever built.
    if (!document.getElementById('msg-body')) return;
    renderConversationList();
    // Before the chat is drawn: on a phone it is hidden until then, and the
    // input measures its height as it is drawn.
    document.getElementById('msg-body').classList.toggle('chat-open', !!Messenger.peer);
    if (Messenger.peer) await renderChat(Messenger.peer, scrollToEnd);
    else renderChatEmpty();
}

// ─── Conversation list ──────────────────────────────────────

// The announced name of an address: its conversation's, or the one the chat
// last read (an address never written to has no conversation).
function knownName(peer, conv) {
    return (conv && conv.name) || (Messenger.names && Messenger.names[peer]) || '';
}

// Our nickname for the contact first (Rename), then the announced name.
function nicknameOf(peer) {
    return (Messenger.state && Messenger.state.nicknames && Messenger.state.nicknames[peer]) || '';
}

function peerLabel(peer, name) {
    return nicknameOf(peer) || name || `${peer.slice(0, 8)}…${peer.slice(-4)}`;
}

const IDENTITY_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="5.5" r="2.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 14c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const PENCIL_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z M9.5 4l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

// A name of our own for a contact: local only, like the colour. Empty = the announced name again.
async function renameContact(peer) {
    const conv = (Messenger.conversations || []).find(c => c.peer === peer);
    const announced = knownName(peer, conv);
    const current = nicknameOf(peer);
    const nick = await new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'auto-reload-modal';
        overlay.innerHTML = `<div class="auto-reload-dialog msg-warn-dialog">
            <div class="dialog-header"><h3>Rename contact</h3></div>
            <div class="settings-hint">Shown here only, instead of the announced name${announced ? ` <b>${escapeHtml(announced)}</b>` : ''}.
                Empty: back to the announced name.</div>
            <input class="settings-input msg-rename-input" type="text" maxlength="48" spellcheck="false"
                   value="${escapeHtml(current)}" placeholder="${escapeHtml(announced || 'Nickname')}">
            <code class="avatar-colors-addr">${escapeHtml(peer)}</code>
            <div class="auto-reload-actions">
                <button class="btn-cancel">Cancel</button>
                <button class="btn-save">Save</button>
            </div></div>`;
        const input = overlay.querySelector('input');
        const done = value => { overlay.remove(); resolve(value); };
        overlay.querySelector('.btn-cancel').onclick = () => done(null);
        overlay.querySelector('.btn-save').onclick = () => done(input.value);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') done(input.value);
            if (e.key === 'Escape') done(null);
        });
        overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
        document.body.appendChild(overlay);
        input.focus();
        input.select();
    });
    if (nick === null) return;
    const d = await fetch(`/api/messenger/nickname/${encodeURIComponent(peer)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nick })
    }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
    if (d.status !== 'success') {
        showNotification(escapeHtml(d.error || 'Not renamed'), 'error', 5000);
        return;
    }
    if (Messenger.state) Messenger.state.nicknames = d.nicknames || {};
    // Every place showing the name: list, open chat, node cards.
    const items = document.getElementById('msg-list-items');
    if (items) delete items.dataset.html;
    renderConversationList();
    const chat = document.getElementById('msg-chat');
    if (chat && chat.dataset.peer === peer) { chat.dataset.redraw = '1'; refreshMessenger(false); }
    applyAvatarColors();
}

function shortTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

// How the conversations are ordered, remembered like the node list's sort.
// A-Z by default: the cards stay put while messages come in.
const MSG_SORT_KEY = 'rbrowser_messenger_sort';
const MSG_SORTS = {
    alphabetical: (a, b) => peerLabel(a.peer, a.name).localeCompare(peerLabel(b.peer, b.name), undefined, { sensitivity: 'base' })
                            || a.peer.localeCompare(b.peer),
    recent: (a, b) => (b.updated || 0) - (a.updated || 0),
    started: (a, b) => (b.started || b.updated || 0) - (a.started || a.updated || 0),
};

function messengerSortMode() {
    let mode = null;
    try { mode = localStorage.getItem(MSG_SORT_KEY); } catch (e) {}
    return MSG_SORTS[mode] ? mode : 'alphabetical';
}

function renderConversationList() {
    const list = document.getElementById('msg-list');
    if (!list) return;
    if (!list.dataset.bound) {
        list.dataset.bound = '1';
        list.addEventListener('click', e => {
            const row = e.target.closest('.msg-conv');
            if (!row) return;
            // An identity chip: straight to that identity's conversation.
            const chip = e.target.closest('[data-msg-chip]');
            if (chip) {
                e.stopPropagation();
                if (chip.dataset.inUse) {
                    Messenger.peer = row.dataset.peer;
                    refreshMessenger(true);
                } else {
                    switchMessengerIdentity(chip.dataset.msgChip, row.dataset.peer)
                        .then(() => showNotification(`Now writing as ${escapeHtml(chip.dataset.name)}`, 'success', 3000));
                }
                return;
            }
            if (row.dataset.identity) { openSharedConversation(row.dataset.identity, row.dataset.peer); return; }
            Messenger.peer = row.dataset.peer;
            list.querySelectorAll('.msg-conv.active').forEach(r => r.classList.remove('active'));
            row.classList.add('active');
            refreshMessenger(true);
        });
    }
    const items = document.getElementById('msg-list-items');
    if (!items) return;
    const query = messengerSearchQuery();
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = words.length
        ? Messenger.conversations.filter(c => {
            const hay = `${nicknameOf(c.peer)} ${c.name || ''} ${c.peer}`.toLowerCase();
            return words.every(w => hay.includes(w));
        })
        : Messenger.conversations;
    const html = !Messenger.conversations.length
        ? `<div class="msg-empty">No conversations yet.<br>
            Use <b>+ New</b>, or right-click an LXMF address in the node list.</div>`
        : words.length && !shown.length ? '<div class="msg-search-none">No contact matches</div>'
        : (words.length ? '<div class="msg-search-head">Contacts</div>' : '') + ownContactsHead()
          + sharedContactsHtml(shown);
    // Rewritten only when something in it changed: the poll comes every
    // few seconds, and rebuilding the rows each time made them flicker.
    if (items.dataset.html !== html) {
        items.dataset.html = html;
        const scroll = list.scrollTop;
        items.innerHTML = html;
        list.scrollTop = scroll;
    }
}

// ─── Favourite contacts: first in the list, a thin line under them ───

// The favourite star, the same on the card, in the chat's bar and in
// Customize contact: a click anywhere toggles it, every copy follows.
function starButton(peer) {
    const fav = isFavoriteContact(peer);
    return `<button class="msg-conv-star${fav ? ' on' : ''}" data-star-peer="${escapeHtml(peer)}"
        title="${fav ? 'Remove from favourites' : 'Add to favourites: shown first'}"
        aria-label="${fav ? 'Remove from favourites' : 'Add to favourites'}">${fav ? '★' : '☆'}</button>`;
}

document.addEventListener('click', e => {
    const star = e.target.closest && e.target.closest('[data-star-peer]');
    if (!star) return;
    e.preventDefault();
    e.stopPropagation();
    toggleFavoriteContact(star.dataset.starPeer);
}, true);

function refreshStars() {
    document.querySelectorAll('[data-star-peer]').forEach(b => {
        const tmp = document.createElement('template');
        tmp.innerHTML = starButton(b.dataset.starPeer).trim();
        b.replaceWith(tmp.content.firstElementChild);
    });
}

function isFavoriteContact(peer) {
    return ((Messenger.state && Messenger.state.favorites) || []).includes(peer);
}

function favoritesFirst(convs) {
    const sorted = [...convs].sort(MSG_SORTS[messengerSortMode()]);
    const favs = sorted.filter(c => isFavoriteContact(c.peer));
    const rest = sorted.filter(c => !isFavoriteContact(c.peer));
    return favs.map(conversationCard).join('')
        + (favs.length && rest.length ? '<div class="msg-fav-sep" role="separator"></div>' : '')
        + rest.map(conversationCard).join('');
}

// Share contact list between identities (Settings > LXMF Messenger): after our
// own conversations, the contacts of each other identity under its name.
// Writing to one starts the conversation with the identity in use.
// With the lists shared, every group says whose it is: the identity in use
// first, even when the others have nothing to add.
function ownContactsHead() {
    const st = Messenger.state;
    if (!st || !st.settings || !st.settings.share_contacts) return '';
    return `<div class="msg-share-sep msg-share-own" role="separator" title="Conversations of the identity you write with">
        <span>Contacts of <b>${escapeHtml(st.identity_name || 'this identity')}</b> · in use</span></div>`;
}

// A contact several identities talk to is one card, not one per identity:
// under the identity in use when it has the conversation, else under the
// identity with the latest message. Chips on the card name every identity
// with that contact (with its unread); a chip opens that identity's
// conversation. The preview is the latest message of any of them.
function sharedContactsHtml(shown) {
    const own = shown.filter(c => !c.shared_from);
    const others = shown.filter(c => c.shared_from);
    if (!others.length) return favoritesFirst(own);
    const st = Messenger.state || {};
    const inUse = { id: (st.settings && st.settings.identity) || '', name: st.identity_name || 'this identity' };
    const byPeer = new Map();
    for (const c of others) {
        if (!byPeer.has(c.peer)) byPeer.set(c.peer, []);
        byPeer.get(c.peer).push(c);
    }
    const chip = (x, mine) => ({ id: mine ? inUse.id : x.shared_id, name: mine ? inUse.name : x.shared_from,
                                 unread: x.unread || 0, inUse: mine });
    const merged = (main, rest, mine) => {
        if (!rest.length) return main;
        const all = [main, ...rest];
        const latest = all.reduce((a, b) => ((b.updated || 0) > (a.updated || 0) ? b : a));
        return { ...main, updated: latest.updated,
                 _latest: latest === main ? null : latest,
                 _chips: [chip(main, mine), ...rest.map(x => chip(x, false))] };
    };
    let html = favoritesFirst(own.map(c => merged(c, byPeer.get(c.peer) || [], true)));
    const ownPeers = new Set(own.map(c => c.peer));
    const groups = new Map();
    for (const [peer, list] of byPeer) {
        if (ownPeers.has(peer)) continue;
        list.sort((a, b) => (b.updated || 0) - (a.updated || 0));
        const main = list[0];
        if (!groups.has(main.shared_id)) groups.set(main.shared_id, []);
        groups.get(main.shared_id).push(merged(main, list.slice(1), false));
    }
    for (const list of groups.values()) {
        const who = list[0].shared_from;
        const unread = list.reduce((n, c) => n + (c.unread || 0), 0);
        list.sort(MSG_SORTS[messengerSortMode()]);
        html += `<div class="msg-share-sep" role="separator" title="Conversations of the identity ${escapeHtml(who)}: click one to switch to ${escapeHtml(who)}, or to write to that contact as the identity in use">
                <span>Contacts of <b>${escapeHtml(who)}</b>${unread ? ` <span class="msg-conv-unread msg-share-unread">${unread}</span>` : ''}</span></div>`
            + list.map(conversationCard).join('');
    }
    return html;
}

async function toggleFavoriteContact(peer) {
    const on = !isFavoriteContact(peer);
    const d = await fetch(`/api/messenger/favorite/${encodeURIComponent(peer)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite: on })
    }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
    if (d.status !== 'success') {
        showNotification(escapeHtml(d.error || 'Not saved'), 'error', 5000);
        return;
    }
    if (Messenger.state) Messenger.state.favorites = d.favorites || [];
    renderConversationList();
    refreshStars();
}

function conversationCard(c) {
        const from = c._latest;
        const last = (from || c).last || {};
        const mine = (from ? `${from.shared_from}: ` : '') + (last.dir === 'out' ? 'You: ' : '');
        const fav = isFavoriteContact(c.peer);
        const other = !!c.shared_id;
        const chips = c._chips || [];
        const anyUnread = c.unread || chips.some(x => x.unread);
        const chipsHtml = chips.length ? `<div class="msg-conv-ids">${chips.map(x => `
                <span class="msg-id-chip${x.inUse ? ' in-use' : ''}${x.unread ? ' has-unread' : ''}" data-msg-chip="${escapeHtml(x.id)}"
                      data-name="${escapeHtml(x.name)}"${x.inUse ? ' data-in-use="1"' : ''}
                      title="${x.inUse ? `Open the conversation of ${escapeHtml(x.name)}, the identity in use` : `Switch to ${escapeHtml(x.name)} and open its conversation`}">${escapeHtml(x.name)}${x.unread ? ` <b>${x.unread > 99 ? '99+' : x.unread}</b>` : ''}</span>`).join('')}</div>` : '';
        return `<div class="msg-conv${c.peer === Messenger.peer && !other ? ' active' : ''}${anyUnread ? ' unread' : ''}${fav ? ' favorite' : ''}${other ? ' msg-conv-other' : ''}"
                     data-peer="${escapeHtml(c.peer)}"${other ? ` data-identity="${escapeHtml(c.shared_id)}"` : ''}
                     title="${other ? `A conversation of ${escapeHtml(c.shared_from)} - click to switch to it, or to write as the identity in use` : 'Click to open - right-click or long press for more'}">
            ${avatarHtml(c.peer, c.name, 'large')}
            <div class="msg-conv-main">
                <div class="msg-conv-top">
                    ${starButton(c.peer)}
                    <span class="msg-conv-name">${escapeHtml(peerLabel(c.peer, c.name))}</span>
                    <span class="msg-conv-time">${escapeHtml(shortTime(c.updated))}</span>
                </div>
                <code class="msg-conv-addr">${escapeHtml(c.peer)}</code>
                <div class="msg-conv-bottom">
                    <span class="msg-conv-icon">${MSG_ICON}</span>
                    <span class="msg-conv-last">${escapeHtml(mine + (last.content || ''))}</span>
                    ${c.unread ? `<span class="msg-conv-unread" title="${c.unread} unread">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
                </div>
                ${chipsHtml}
            </div>
        </div>`;
}

// ─── Search ─────────────────────────────────────────────────
// The box filters the contacts at once; the messages of every conversation
// are searched on the server (messenger.search), a moment after typing.

function messengerSearchQuery() {
    const box = document.getElementById('msg-search');
    return box ? box.value.trim() : '';
}

function bindMessengerSearch() {
    const box = document.getElementById('msg-search');
    const hitsBox = document.getElementById('msg-search-hits');
    if (!box || !hitsBox) return;
    let timer = null, asked = 0;
    const run = async () => {
        const q = messengerSearchQuery();
        const mine = ++asked;
        if (!q) { hitsBox.innerHTML = ''; return; }
        let hits = [];
        try {
            hits = (await fetch(`/api/messenger/search?q=${encodeURIComponent(q)}`).then(r => r.json())).hits || [];
        } catch (e) {}
        if (mine !== asked) return;
        const words = q.split(/\s+/).filter(Boolean);
        const label = h => {
            const c = Messenger.conversations.find(x => x.peer === h.peer);
            return peerLabel(h.peer, c && c.name);
        };
        hitsBox.innerHTML = `<div class="msg-search-head">Messages${hits.length ? ` (${hits.length >= 100 ? '100+' : hits.length})` : ''}</div>`
            + (hits.length ? hits.map(h => `<div class="msg-hit" data-peer="${escapeHtml(h.peer)}" data-local="${escapeHtml(h.local_id || '')}">
                ${avatarHtml(h.peer, label(h), 'small', false)}
                <div class="msg-hit-main">
                    <div class="msg-hit-top"><span class="msg-hit-name">${escapeHtml(label(h))}</span>
                        <span class="msg-conv-time">${escapeHtml(shortTime(h.ts))}</span></div>
                    <div class="msg-hit-text">${h.dir === 'out' ? 'You: ' : ''}${quickHighlight(hitSnippet(h.text, words), words)}</div>
                </div></div>`).join('')
            : '<div class="msg-search-none">No message matches</div>');
    };
    const clearBtn = document.getElementById('msg-search-clear');
    box.addEventListener('input', () => {
        if (clearBtn) clearBtn.hidden = !box.value;
        renderConversationList();
        clearTimeout(timer);
        timer = setTimeout(run, 250);
    });
    if (clearBtn) clearBtn.addEventListener('click', () => {
        box.value = '';
        box.dispatchEvent(new Event('input'));
        box.focus();
    });
    box.addEventListener('keydown', e => {
        if (e.key === 'Escape' && box.value) { e.stopPropagation(); box.value = ''; box.dispatchEvent(new Event('input')); }
    });
    hitsBox.addEventListener('click', async e => {
        const hit = e.target.closest('.msg-hit');
        if (!hit) return;
        Messenger.peer = hit.dataset.peer;
        renderConversationList();
        await refreshMessenger(false);
        focusMessage(hit.dataset.local);
    });
}

// The words found in a long message: a piece around the first one.
function hitSnippet(text, words) {
    const lower = text.toLowerCase();
    const at = Math.min(...words.map(w => lower.indexOf(w.toLowerCase())).filter(i => i >= 0), text.length);
    const start = Math.max(0, at - 40);
    return (start ? '…' : '') + text.slice(start, start + 140) + (start + 140 < text.length ? '…' : '');
}

// "Add to contacts" in a chat's bar: only while the address is not among the
// conversations yet (opened from a node's menu, a link, the Peers panel).
function showAddContactButton(chat, peer) {
    const btn = chat.querySelector('[data-add-contact]');
    if (btn) btn.hidden = (Messenger.conversations || []).some(c => c.peer === peer);
}

// ─── Announced peers ───
// Every lxmf.delivery announce heard (rbrowser/lxmf_peers.py), as LXMF
// clients list them: people who only use LXMF can be found too, not only
// NomadNet operators. Closed by default; read every 15 s while open. The
// server sends at most 200 of each group, so thousands of announces cost
// nothing here.

function toggleMessengerPeers(force) {
    const panel = document.getElementById('msg-peers');
    if (!panel) return;
    const open = force === undefined ? panel.hidden : force;
    panel.hidden = !open;
    document.getElementById('msg-peers-toggle')?.classList.toggle('active', open);
    clearInterval(toggleMessengerPeers.timer);
    if (!open) return;
    const box = document.getElementById('msg-peers-search');
    if (!box.dataset.bound) {
        box.dataset.bound = '1';
        let t = null;
        box.addEventListener('input', () => { clearTimeout(t); t = setTimeout(loadMessengerPeers, 250); });
        box.addEventListener('keydown', e => {
            if (e.key === 'Escape' && box.value) { e.stopPropagation(); box.value = ''; loadMessengerPeers(); }
        });
        document.getElementById('msg-peers-items').addEventListener('click', e => {
            const row = e.target.closest('[data-peer-row]');
            if (!row) return;
            // A phone: the list covers the chat, which opened behind it
            // and nothing seemed to happen.
            if (window.matchMedia('(max-width: 700px)').matches) toggleMessengerPeers(false);
            openMessenger(row.dataset.peerRow);
        });
        document.getElementById('msg-peers-items').addEventListener('contextmenu', e => {
            const row = e.target.closest('[data-peer-row]');
            if (!row) return;
            e.preventDefault();
            showLxmfMenu(row, row.dataset.peerRow, row.dataset.name || '', 'LXMF peer');
        });
    }
    loadMessengerPeers();
    toggleMessengerPeers.timer = setInterval(() => {
        if (document.getElementById('msg-peers')?.hidden) return clearInterval(toggleMessengerPeers.timer);
        loadMessengerPeers();
    }, 15000);
}

async function loadMessengerPeers() {
    const items = document.getElementById('msg-peers-items');
    if (!items) return;
    const q = (document.getElementById('msg-peers-search') || {}).value || '';
    let d;
    try { d = await fetch(`/api/messenger/peers?q=${encodeURIComponent(q)}`).then(r => r.json()); }
    catch (e) { items.innerHTML = `<div class="msg-search-none">Could not read: ${escapeHtml(e.message)}</div>`; return; }
    Messenger.announced = d;
    const count = document.getElementById('msg-peers-count');
    if (count) count.textContent = d.total ? String(d.total) : '';
    const words = q.split(/\s+/).filter(Boolean);
    const row = p => {
        const label = p.name || `${p.address.slice(0, 8)}…`;
        const hops = p.hops != null ? `${p.hops} ${p.hops === 1 ? 'hop' : 'hops'}` : 'no path';
        return `<div class="msg-hit msg-peer-row" data-peer-row="${escapeHtml(p.address)}" data-name="${escapeHtml(p.name || '')}"
                     title="Click to write - right-click for more">
            ${avatarHtml(p.address, p.name, 'small', false)}
            <div class="msg-hit-main">
                <div class="msg-hit-top"><span class="msg-hit-name">${quickHighlight(label, words)}</span>
                    <span class="msg-conv-time">${escapeHtml(shortTime(p.heard))}</span></div>
                <div class="msg-hit-text"><code>${quickHighlight(p.address, words)}</code> · ${escapeHtml(hops)}${p.stamp_cost ? ` · stamp ${p.stamp_cost}` : ''}
                    ${p.node_name ? `<br>NomadNet: ${escapeHtml(p.node_name)}` : ''}</div>
            </div></div>`;
    };
    const group = (key, title, tip) => {
        const list = (d.groups && d.groups[key]) || [];
        const total = (d.totals && d.totals[key]) || 0;
        return `<div class="msg-search-head" title="${escapeHtml(tip)}">${title} <span>${total}</span></div>`
            + (list.length ? list.map(row).join('') : '<div class="msg-search-none">None heard yet</div>')
            + (total > list.length ? `<div class="msg-search-none">${total - list.length} more: search to find them</div>` : '');
    };
    const html = group('lxmf_only', 'LXMF only', 'People heard on LXMF who do not run a NomadNet node')
        + group('with_nomad', 'Also running a NomadNet node', 'Their node is in the node list too');
    if (items.dataset.html !== html) {
        items.dataset.html = html;
        items.innerHTML = html;
    }
}

// ─── Keeping the text box in reach ───
// Typing while nothing editable has the focus goes to the chat's text box;
// a click on the messages (not a selection) gives it the focus back. Never
// taken from another field, a dialog or a menu: those keep their keys.

function chatInput() {
    if (!Messenger.open) return null;
    const input = document.querySelector('#msg-chat .msg-input');
    return input && input.offsetParent !== null ? input : null;
}

function somethingElseTyping() {
    const el = document.activeElement;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return true;
    return !!document.querySelector('.auto-reload-modal, #node-menu, .msg-react-picker, .omnibox-menu:not([hidden])');
}

document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.key.length !== 1) return;
    const input = chatInput();
    if (!input || somethingElseTyping()) return;
    // Focused now, the key lands in the box as it is typed.
    input.focus();
}, true);

document.addEventListener('click', e => {
    if (isMobileDevice() || !e.target.closest || !e.target.closest('#msg-chat .msg-log')) return;
    if (e.target.closest('a, button, input, textarea, [data-file], [data-goto]')) return;
    if (String(window.getSelection && window.getSelection()).length) return;   // copying text
    setTimeout(() => {
        const input = chatInput();
        if (input && !somethingElseTyping()) input.focus({ preventScroll: true });
    }, 0);
});

// ─── Reply ───
// The message being answered, shown above the text box until sent or
// dismissed. Sent as FIELD_REPLY_TO (its hash) and FIELD_REPLY_QUOTE.

function flashRow(row) {
    row.classList.remove('msg-flash');
    void row.offsetWidth;
    row.classList.add('msg-flash');
}

async function startReply(chat, peer, id) {
    let msgs = [];
    try { msgs = (await fetch(`/api/messenger/messages/${encodeURIComponent(peer)}`).then(r => r.json())).messages || []; } catch (e) {}
    const m = msgs.find(x => x.id === id);
    if (!m) return;
    const settings = (Messenger.state && Messenger.state.settings) || {};
    const conv = (Messenger.conversations || []).find(c => c.peer === peer);
    const from = m.dir === 'out' ? (settings.display_name ? `${settings.display_name} (you)` : 'You')
                                 : peerLabel(peer, conv && conv.name);
    const text = String(m.content || '').trim() || (m.files || []).map(f => f.name).join(', ');
    Messenger.replyTo = { peer, id, from, text };
    renderReplyBar(chat);
    const input = chat.querySelector('.msg-input');
    if (input) input.focus();
}

function renderReplyBar(chat) {
    const bar = chat.querySelector('.msg-reply-bar');
    if (!bar) return;
    const r = Messenger.replyTo;
    if (!r || r.peer !== chat.dataset.peer) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    bar.innerHTML = `<span class="msg-reply-icon">${REPLY_ICON}</span>
        <span class="msg-reply-main"><span class="msg-quote-from">Reply to ${escapeHtml(r.from)}</span>
            <span class="msg-quote-text">${escapeHtml(r.text.slice(0, 200))}</span></span>
        <button title="Cancel the reply (Esc)" aria-label="Cancel the reply">&times;</button>`;
    bar.querySelector('button').onclick = () => { Messenger.replyTo = null; renderReplyBar(chat); };
}

function focusMessage(localId) {
    const log = document.querySelector('#msg-chat .msg-log');
    const row = log && localId && log.querySelector(`[data-key="${CSS.escape(localId)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.remove('msg-flash');
    void row.offsetWidth;
    row.classList.add('msg-flash');
}

// ─── Chat ───────────────────────────────────────────────────

const STATE_TEXT = {
    sending: ['⏳', 'Sending'],
    waiting: ['⏳', 'Asking the network for the recipient or a path to it'],
    delivered: ['✓✓', 'Delivered'],
    failed: ['✕', 'Not delivered'],
    cancelled: ['⊘', 'Cancelled before it was sent'],
    // The propagation node took it: the recipient gets it at their next sync.
    sent: ['📮', 'Left on the propagation node: delivered when the recipient syncs'],
    propagating: ['⏳', 'Direct delivery failed: handing it to the propagation node'],
};

// How a message went out: the icon after the ticks.
const METHOD_TEXT = {
    opportunistic: ['⚡', 'in one packet (opportunistic)'],
    direct: ['🔗', 'over a link'],
    propagated: ['📮', 'via the propagation node'],
};

function renderChatEmpty() {
    const chat = document.getElementById('msg-chat');
    if (!chat) return;
    saveTabState(chat);
    delete chat.dataset.peer;
    delete chat.dataset.tabKey;
    const welcome = typeof clientWelcome === 'function' ? clientWelcome(settingsIcon('<path d="M2 3h12v8H7l-3.5 2.5V11H2z"/>'), 'LXMF Client') : '';
    chat.innerHTML = `<div class="msg-empty">${welcome}Pick a conversation, or start a new one.</div>`;
    renderChatTabs();
}

// Messages with files still arriving: who (once the sender has identified
// on the link), to which of our identities, how far. × cancels it.
function renderIncomingTransfers() {
    const box = document.getElementById('msg-incoming');
    if (!box) return;
    const list = (Messenger.state && Messenger.state.incoming_transfers) || [];
    box.hidden = !list.length;
    const size = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
    const many = ((Messenger.state && Messenger.state.identities) || []).filter(i => i.listening).length > 1;
    const html = list.map(t => {
        const pct = Math.round((t.progress || 0) * 100);
        const who = t.from ? escapeHtml(t.from_name || t.from) : 'a contact';
        const to = many && t.identity_name ? ` <span class="msg-tab-id">to ${escapeHtml(t.identity_name)}</span>` : '';
        return `<div class="msg-incoming-row">
            <span class="msg-incoming-text">⬇ Receiving a message from <b>${who}</b>${to}</span>
            <span class="msg-progress msg-incoming-bar"><span style="width:${pct}%"></span></span>
            <span class="msg-incoming-pct">${pct}%${t.size ? ` of ${size(t.size)}` : ''}</span>
            <button class="msg-tab-close" data-cancel-incoming="${escapeHtml(t.id)}" title="Stop receiving it" aria-label="Stop receiving">&times;</button>
        </div>`;
    }).join('');
    if (box.dataset.html !== html) {
        box.dataset.html = html;
        box.innerHTML = html;
    }
}

document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-cancel-incoming]');
    if (!btn) return;
    btn.disabled = true;
    const d = await fetch(`/api/messenger/cancel-incoming/${encodeURIComponent(btn.dataset.cancelIncoming)}`, { method: 'POST' })
        .then(r => r.json()).catch(err => ({ status: 'error', error: err.message }));
    if (d.status !== 'success') showNotification(escapeHtml(d.error || 'Not stopped'), 'error', 4000);
    pollMessenger();
});

// ─── Chat tabs ──────────────────────────────────────────────
// Several chats open at once, like the page tabs. A tab is a contact as
// seen from one of our identities (they all listen): opening a tab of
// another identity switches to it. Each tab keeps its draft, the files
// waiting to go, the reply being written and where it was scrolled.

function currentIdentityId() {
    return (Messenger.state && Messenger.state.settings && Messenger.state.settings.identity) || '';
}

function chatTabKey(id, peer) {
    return `${id}|${peer}`;
}

function ensureChatTab(peer) {
    const id = currentIdentityId();
    const me = Messenger.state ? Messenger.state.address : '';
    const tab = Messenger.tabs.find(t => t.id === id && t.peer === peer);
    if (tab) { tab.me = me; return; }
    Messenger.tabs.push({ id, me, peer });
}

// What a chat leaves behind when another is shown.
function saveTabState(chat) {
    const key = chat && chat.dataset.tabKey;
    if (!key) return;
    const peer = chat.dataset.peer;
    const input = chat.querySelector('.msg-input');
    const log = chat.querySelector('.msg-log');
    Messenger.tabState[key] = {
        draft: input ? input.value : '',
        pending: Messenger.pendingPeer === peer ? [...(Messenger.pending || [])] : [],
        replyTo: Messenger.replyTo && Messenger.replyTo.peer === peer ? Messenger.replyTo : null,
        scroll: log ? { top: log.scrollTop, atBottom: log.scrollHeight - log.scrollTop - log.clientHeight < 60 } : null,
    };
}

function tabUnread(tab) {
    const st = Messenger.state || {};
    return ((st.unread_peers || {})[tab.id] || {})[tab.peer] || 0;
}

function tabIdentityName(tab) {
    const i = ((Messenger.state && Messenger.state.identities) || []).find(x => x.id === tab.id);
    return i ? (i.display_name || i.name) : tab.id;
}

function renderChatTabs() {
    const strip = document.getElementById('msg-tabs');
    if (!strip) return;
    const st = Messenger.state || {};
    // An identity that is gone, or an ephemeral one that has changed: its
    // chats went with it.
    const ids = st.identities || [];
    Messenger.tabs = Messenger.tabs.filter(t => {
        const i = ids.find(x => x.id === t.id);
        return i && (t.id !== 'ephemeral' || !t.me || t.me === i.address);
    });
    strip.hidden = !Messenger.tabs.length;
    const current = currentIdentityId();
    const activeKey = Messenger.peer ? chatTabKey(current, Messenger.peer) : '';
    const html = Messenger.tabs.map(t => {
        const key = chatTabKey(t.id, t.peer);
        const conv = t.id === current ? (Messenger.conversations || []).find(c => c.peer === t.peer) : null;
        const label = peerLabel(t.peer, knownName(t.peer, conv));
        const unread = key === activeKey ? 0 : tabUnread(t);
        const other = t.id !== current;
        return `<div class="msg-tab${key === activeKey ? ' active' : ''}${other ? ' other' : ''}" data-key="${escapeHtml(key)}"
                     title="${escapeHtml(label)}${other ? ` - as ${escapeHtml(tabIdentityName(t))} (click to switch to it)` : ''}">
            ${avatarHtml(t.peer, label, 'tiny', false)}
            <span class="msg-tab-name">${escapeHtml(label)}</span>
            ${other ? `<span class="msg-tab-id">${escapeHtml(tabIdentityName(t))}</span>` : ''}
            ${unread ? `<span class="msg-conv-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
            <button class="msg-tab-close" data-close-tab="${escapeHtml(key)}" title="Close this chat" aria-label="Close">&times;</button>
        </div>`;
    }).join('');
    if (strip.dataset.html !== html) {
        strip.dataset.html = html;
        strip.innerHTML = html;
        const active = strip.querySelector('.msg-tab.active');
        if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
}

async function openChatTab(key) {
    const tab = Messenger.tabs.find(t => chatTabKey(t.id, t.peer) === key);
    if (!tab) return;
    if (tab.id !== currentIdentityId()) {
        await switchMessengerIdentity(tab.id, tab.peer);
        showNotification(`Now writing as ${escapeHtml(tabIdentityName(tab))}`, 'success', 2500);
        return;
    }
    Messenger.peer = tab.peer;
    refreshMessenger(false);
}

// Close a chat tab; if it was the one shown, the next one takes its place.
function closeChatTab(key) {
    const index = Messenger.tabs.findIndex(t => chatTabKey(t.id, t.peer) === key);
    if (index < 0) return;
    Messenger.tabs.splice(index, 1);
    delete Messenger.tabState[key];
    const chat = document.getElementById('msg-chat');
    if (chat && chat.dataset.tabKey === key) {
        delete chat.dataset.tabKey;      // nothing to keep of it
        const next = Messenger.tabs[index] || Messenger.tabs[index - 1];
        if (next) { openChatTab(chatTabKey(next.id, next.peer)); return; }
        Messenger.peer = null;
        refreshMessenger(false);
        return;
    }
    renderChatTabs();
}

document.addEventListener('click', e => {
    const strip = e.target.closest('#msg-tabs');
    if (!strip) return;
    const close = e.target.closest('[data-close-tab]');
    if (close) { e.stopPropagation(); closeChatTab(close.dataset.closeTab); return; }
    const tab = e.target.closest('.msg-tab');
    if (tab && !tab.classList.contains('active')) openChatTab(tab.dataset.key);
});

// Middle click closes a tab, as in a browser.
document.addEventListener('auxclick', e => {
    const tab = e.button === 1 && e.target.closest('#msg-tabs .msg-tab');
    if (tab) { e.preventDefault(); closeChatTab(tab.dataset.key); }
});

async function renderChat(peer, scrollToEnd) {
    const chat = document.getElementById('msg-chat');
    if (!chat) return;
    let data;
    try {
        data = await fetch(`/api/messenger/messages/${encodeURIComponent(peer)}`).then(r => r.json());
    } catch (e) {
        if (Messenger.peer === peer) chat.innerHTML = `<div class="msg-empty">Could not load the conversation: ${escapeHtml(e.message)}</div>`;
        return;
    }
    // Closed, or another chat opened, while the messages were on their way:
    // drawing them now reopened it for a moment.
    if (Messenger.peer !== peer) return;
    const conv = Messenger.conversations.find(c => c.peer === peer);
    if (conv && conv.unread) {
        fetch(`/api/messenger/read/${encodeURIComponent(peer)}`, { method: 'POST' }).catch(() => {});
        conv.unread = 0;
        renderConversationList();
    }

    const tabKey = chatTabKey(currentIdentityId(), peer);
    // redraw: the same chat drawn again from scratch (a rename), its draft kept.
    const same = chat.dataset.tabKey === tabKey && !chat.dataset.redraw;
    delete chat.dataset.redraw;
    let log = chat.querySelector('.msg-log');
    const atBottom = log && same ? (log.scrollHeight - log.scrollTop - log.clientHeight < 60) : true;
    const name = data.name || (conv && conv.name) || '';
    // The name heard last for this address, also for one never written to
    // (no conversation): Customize, Rename and the avatar use it.
    if (data.name) Messenger.names[peer] = data.name;
    const items = logItems(data.messages || [], peerLabel(peer, name), peer);

    // Already showing this conversation: only what changed is touched, so
    // the bubbles on screen stay put and the text being typed keeps its
    // cursor and focus.
    if (log && same) {
        renderChatTabs();
        const added = updateLog(log, items, true);
        const nameBox = chat.querySelector('.msg-chat-name');
        if (nameBox.textContent !== peerLabel(peer, name)) nameBox.textContent = peerLabel(peer, name);
        // An announce that came in meanwhile: the bar's logo follows the name.
        const headAvatar = chat.querySelector('.msg-chat-head .msg-avatar');
        if (headAvatar && headAvatar.textContent !== avatarLetter(peer, name)) {
            headAvatar.outerHTML = avatarHtml(peer, name, 'large');
        }
        showAddContactButton(chat, peer);
        // Just sent: straight to the bottom, whatever was being read.
        if (pinnedToBottom()) log.scrollTop = log.scrollHeight;
        else if (added && (scrollToEnd || atBottom)) log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
        // A bubble that grew (a reaction, a progress bar) stays in view, but
        // only for someone already at the bottom: scrolling up is never undone.
        else if (scrollToEnd || atBottom) log.scrollTop = log.scrollHeight;
        return;
    }
    // Another chat (or the same contact from another identity): what the
    // one shown leaves behind is kept in its tab, and this one gets its own.
    saveTabState(chat);
    ensureChatTab(peer);
    const saved = Messenger.tabState[tabKey] || null;
    chat.dataset.peer = peer;
    chat.dataset.tabKey = tabKey;
    chat.innerHTML = `
        <div class="msg-chat-head">
            <button class="msg-back" title="Back to the conversations" onclick="messengerBack()">&larr;</button>
            ${avatarHtml(peer, name, 'large')}
            <div class="msg-chat-who">
                <div class="msg-chat-name-row">${starButton(peer)}<span class="msg-chat-name">${escapeHtml(peerLabel(peer, name))}</span><button class="msg-rename-btn" data-rename-chat title="Rename contact" aria-label="Rename contact">${PENCIL_ICON}</button></div>
                <code class="msg-chat-addr" title="Click to copy">${escapeHtml(peer)}</code>
                <div class="msg-chat-path" id="msg-chat-path">Reading the path…</div>
            </div>
            <div class="msg-chat-actions">
                <button class="msg-bar-btn primary" data-add-contact hidden onclick="addContactChecked('${jsAttr(peer)}')"
                        title="Keep this address in your conversations without writing to it first">Add to contacts</button>
                <button class="msg-bar-btn" id="msg-info" onclick="messengerPeerInfo('${jsAttr(peer)}')"
                        title="Everything known about this contact: node, path, keys">Info</button>
                <button class="msg-bar-btn" id="msg-ping" onclick="messengerPing('${jsAttr(peer)}')"
                        title="Open a link to this address and time the answer. No message is sent">Ping</button>
                <button class="msg-bar-btn" onclick="checkLxmfReachable('${jsAttr(peer)}', '${jsAttr(name)}')"
                        title="One path request: does anything answer on this address?">Check</button>
                <button class="msg-bar-btn danger" onclick="messengerBlock('${jsAttr(peer)}')"
                        title="Drop every message from this address (Settings > LXMF Messenger lists them)">Block</button>
                <button class="msg-bar-btn" onclick="messengerClearConversation('${jsAttr(peer)}')"
                        title="Clear the messages, keep the contact in the list">Clear</button>
                <button class="msg-bar-btn danger" onclick="messengerDeleteConversation('${jsAttr(peer)}')"
                        title="Delete this conversation and the contact from the list">Delete</button>
                <button class="msg-close" onclick="closeChatTab('${jsAttr(tabKey)}')" title="Close this chat" aria-label="Close this chat">&times;</button>
            </div>
        </div>
        <div class="msg-log"></div>
        <div class="msg-reply-bar" hidden></div>
        <div class="msg-attach" hidden></div>
        <div class="msg-compose">
            <button class="msg-clip" title="Attach files - or drop them on the chat, or paste an image" aria-label="Attach files">${CLIP_ICON}</button>
            <input type="file" class="msg-file-input" multiple hidden>
            <textarea class="msg-input" rows="1" placeholder="Message - Enter sends, Shift+Enter for a new line"></textarea>
            <button class="msg-via-pn" hidden title="Send straight to the propagation node, without trying direct delivery (useful for tests). Click to switch on or off" aria-label="Send via the propagation node">📮</button>
            <button class="msg-send" title="Send (Enter)" aria-label="Send"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 8l11-5.5L9.5 14 7.5 9z" fill="currentColor"/></svg></button>
        </div>`;
    chat.querySelector('.msg-chat-addr').onclick = () => copyText(peer, 'LXMF address copied');
    chat.querySelector('[data-rename-chat]').onclick = () => renameContact(peer);
    showAddContactButton(chat, peer);
    renderChatPath(peer);
    log = chat.querySelector('.msg-log');
    updateLog(log, items, false);
    log.addEventListener('click', e => {
        const cancelBtn = e.target.closest('[data-cancel]');
        if (cancelBtn) {
            cancelBtn.disabled = true;
            fetch(`/api/messenger/cancel/${encodeURIComponent(peer)}/${encodeURIComponent(cancelBtn.dataset.cancel)}`, { method: 'POST' })
                .then(r => r.json()).catch(err => ({ status: 'error', error: err.message }))
                .then(d => {
                    if (d.status !== 'success') showNotification(escapeHtml(d.error || 'Not cancelled'), 'error', 5000);
                    refreshMessenger(false);
                });
            return;
        }
        const replyBtn = e.target.closest('[data-reply]');
        if (replyBtn) { startReply(chat, peer, replyBtn.dataset.reply); return; }
        const quote = e.target.closest('[data-goto]');
        if (quote) {
            const target = log.querySelector(`[data-msgid="${CSS.escape(quote.dataset.goto)}"]`);
            if (target) { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); flashRow(target); }
            else showNotification('The message answered is not in this conversation', 'info', 3000);
            return;
        }
        const reactBtn = e.target.closest('.msg-react-btn');
        if (reactBtn) { showReactionPicker(reactBtn, peer, reactBtn.dataset.react); return; }
        const pill = e.target.closest('.msg-reaction');
        if (pill) {
            if (pill.dataset.who === 'me') messengerReact(peer, pill.dataset.reactId, '');
            else showReactionPicker(pill, peer, pill.dataset.reactId);
            return;
        }
        const retry = e.target.closest('.msg-retry');
        if (retry) {
            // Sent again by the server, in the same bubble (files from the copies kept).
            messengerRetry(peer, retry.dataset.local);
            return;
        }
        const file = e.target.closest('[data-file]');
        if (!file) return;
        e.preventDefault();
        if (file.classList.contains('msg-audio') && !e.target.closest('.msg-file-more')) {
            if (e.target.closest('.msg-audio-bar')) seekAudio(file, e);
            else if (e.target.closest('.msg-audio-play')) toggleAudio(file);
            return;
        }
        if (file.classList.contains('msg-image') && !e.target.closest('.msg-file-more')) {
            if (!file.classList.contains('deleted')) window.open(fileUrl(peer, file.dataset.local, file.dataset.file), '_blank', 'noopener');
            return;
        }
        showFileMenu(file, peer, file.dataset.local, Number(file.dataset.file));
    });
    log.addEventListener('contextmenu', e => {
        const file = e.target.closest('[data-file]');
        if (!file) return;
        e.preventDefault();
        showFileMenu(file, peer, file.dataset.local, Number(file.dataset.file));
    });
    // The tab's own files and reply, as it left them (nothing for a new one).
    Messenger.pending = saved ? [...saved.pending] : [];
    Messenger.pendingPeer = peer;
    Messenger.replyTo = saved ? saved.replyTo : null;
    renderPendingFiles(chat);
    bindFileInputs(chat);
    renderReplyBar(chat);
    // Back to a tab scrolled up: where it was; else the end.
    const keepTop = saved && saved.scroll && !saved.scroll.atBottom && !scrollToEnd ? saved.scroll.top : null;
    if (keepTop !== null) log.scrollTop = keepTop;
    else if (scrollToEnd || atBottom) log.scrollTop = log.scrollHeight;
    renderChatTabs();
    // Images finish loading later and make their bubble taller: whoever was
    // at the bottom stays there; whoever scrolled up is left where they are.
    let stick = keepTop === null && (scrollToEnd || atBottom);
    log.addEventListener('scroll', () => { stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60; });
    log.addEventListener('load', e => {
        if (e.target.tagName === 'IMG' && (stick || pinnedToBottom())) log.scrollTop = log.scrollHeight;
    }, true);
    // Not only images: the log gets shorter when the bars under it settle,
    // a player or a reaction makes a bubble taller. Each change of size, of
    // the log or of a bubble, keeps whoever is at the bottom there, before
    // the screen is painted (it used to wait for the next poll, a jump).
    if (chat._logSizeWatch) chat._logSizeWatch.disconnect();
    if (chat._logRowsWatch) chat._logRowsWatch.disconnect();
    if (window.ResizeObserver) {
        const sizeWatch = new ResizeObserver(() => {
            if (stick || pinnedToBottom()) log.scrollTop = log.scrollHeight;
        });
        sizeWatch.observe(log);
        Array.from(log.children).forEach(row => sizeWatch.observe(row));
        const rowsWatch = new MutationObserver(changes => changes.forEach(c =>
            c.addedNodes.forEach(n => { if (n.nodeType === 1) sizeWatch.observe(n); })));
        rowsWatch.observe(log, { childList: true });
        chat._logSizeWatch = sizeWatch;
        chat._logRowsWatch = rowsWatch;
    }
    // Scrolling by hand ends the pin a send puts on the bottom.
    const unpin = () => { Messenger.pinBottomUntil = 0; };
    log.addEventListener('wheel', unpin, { passive: true });
    log.addEventListener('touchmove', unpin, { passive: true });
    log.addEventListener('keydown', e => { if (/^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End)$/.test(e.key)) unpin(); });

    const input = chat.querySelector('.msg-input');
    // Height to the text. Folding it to "auto" relaid the whole log (every
    // message) twice per key: slow in long chats. The browser sizes it
    // where it can (field-sizing); else measured only when the rows change.
    const native = CSS.supports && CSS.supports('field-sizing', 'content');
    let rows = -1;
    const grow = () => {
        if (native) return;
        const n = input.value.length ? (input.value.match(/\n/g) || []).length + Math.ceil(input.value.length / 40) : 0;
        if (n === rows && input.scrollHeight <= input.clientHeight) return;
        rows = n;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    };
    if (saved && saved.draft) input.value = saved.draft;
    input.addEventListener('input', grow);
    grow();
    input.addEventListener('keydown', e => {
        if (e.key === 'Escape' && Messenger.replyTo) {
            e.stopPropagation();
            Messenger.replyTo = null;
            renderReplyBar(chat);
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            messengerSend(peer, input);
        }
    });
    chat.querySelector('.msg-send').onclick = () => messengerSend(peer, input);
    const via = chat.querySelector('.msg-via-pn');
    via.onclick = () => {
        via.classList.toggle('active');
        input.placeholder = via.classList.contains('active')
            ? 'Message via the propagation node - Enter sends'
            : 'Message - Enter sends, Shift+Enter for a new line';
        input.focus();
    };
    renderPropagationControls();
    if (scrollToEnd && !isMobileDevice()) input.focus();
}

// The rows of a conversation: a heading for each day, then the messages.
// A message right after another from the same side, within five minutes,
// continues its group (closer, no tail). Each row has a key that stays the
// same across reloads and a signature of what it shows. Every message
// carries the sender's name, also inside a group.
function logItems(messages, peerName, peer = Messenger.peer) {
    if (!messages.length) return [{ key: 'empty', sig: '', html: '<div class="msg-empty">No messages yet. Say hello!</div>' }];
    const settings = (Messenger.state && Messenger.state.settings) || {};
    const me = settings.display_name ? `${settings.display_name} (you)` : 'You';
    const items = [];
    let lastDay = '', prev = null;
    // A reply shows who it answers: the message quoted, if it is here.
    const byId = new Map(messages.filter(x => x.id).map(x => [x.id, x]));
    // In time order: a message arriving late (propagation node) was drawn
    // at the bottom, its day heading twice with the same key, and the log
    // put those rows in again at every poll - they flashed.
    messages = [...messages].sort((a, b) => (a.ts || 0) - (b.ts || 0));
    for (const raw of messages) {
        const quoted = raw.reply_to ? byId.get(raw.reply_to) : null;
        const m = raw.reply_to ? { ...raw, _quotedFrom: quoted ? (quoted.dir === 'out' ? me : peerName) : '' } : raw;
        const d = new Date((m.ts || 0) * 1000);
        const day = d.toDateString();
        if (day !== lastDay) {
            lastDay = day;
            prev = null;
            items.push({ key: 'day-' + day, sig: day,
                         html: `<div class="msg-day"><span>${escapeHtml(dayLabel(d))}</span></div>` });
        }
        const cont = !!(prev && prev.dir === m.dir && (m.ts - prev.ts) < 300);
        prev = m;
        const from = m.dir === 'out' ? me : peerName;
        items.push({
            key: m.local_id || m.id || String(m.ts),
            sig: [m.state, m.error || '', m.verified, cont, from, m.progress ?? '',
                  (m.files || []).map(f => f.deleted ? 'x' : 'o').join(''),
                  JSON.stringify(m.reactions || {}), m.renderer === 'markdown' && markdownOn(),
                  nicknameOf(peer), m.reply_to || '', m._quotedFrom || '',
                  settings.image_previews !== false].join('|'),
            html: messageHtml(m, cont, from, peer),
        });
    }
    return items;
}

function dayLabel(d) {
    const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(new Date()) - start(d)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// Bring the log in line with the items without rebuilding it: rows that
// did not change are left alone, changed ones are replaced in place, new
// ones are inserted where they belong. Nothing already on screen moves or
// animates again. Returns how many rows were added.
function updateLog(log, items, animate) {
    let added = 0;
    const make = (item, fresh) => {
        const tpl = document.createElement('template');
        tpl.innerHTML = item.html.trim();
        const el = tpl.content.firstElementChild;
        el.dataset.key = item.key;
        el.dataset.sig = item.sig;
        if (fresh) el.classList.add('fresh');
        return el;
    };
    const wanted = new Set(items.map(i => i.key));
    [...log.children].forEach(el => { if (!wanted.has(el.dataset.key)) el.remove(); });
    items.forEach((item, i) => {
        const here = log.children[i];
        if (here && here.dataset.key === item.key) {
            if (here.dataset.sig !== item.sig) here.replaceWith(make(item, false));
            return;
        }
        const existing = [...log.children].find(el => el.dataset.key === item.key);
        if (existing) {
            if (existing.dataset.sig !== item.sig) existing.replaceWith(make(item, false));
            log.insertBefore(log.querySelector(`[data-key="${CSS.escape(item.key)}"]`), here || null);
            return;
        }
        log.insertBefore(make(item, animate), here || null);
        added += 1;
    });
    return added;
}

// "Local RNSD - 0 Hops" for another program on the same rnsd (its
// "interface" is only a local port), "Network - via X - N Hops" otherwise.
function pathLabel(p) {
    const hops = `${p.hops} ${p.hops === 1 ? 'Hop' : 'Hops'}`;
    if (p.hops === 0) return `Local RNSD - ${hops}`;
    const via = String(p.via || '').replace(/^via\s+/, '');
    return via ? `Network - via ${via} - ${hops}` : `Network - ${hops}`;
}

// Hops and interface of the path held to the contact: read from rnsd's
// table, nothing is sent.
async function renderChatPath(peer) {
    const box = document.getElementById('msg-chat-path');
    if (!box) return;
    let data;
    try {
        data = await fetch(`/api/path-check/${encodeURIComponent(peer)}`).then(r => r.json());
    } catch (e) {
        box.textContent = '';
        return;
    }
    if (document.getElementById('msg-chat')?.dataset.peer !== peer) return;
    let html = '<span class="msg-chip muted">no path held</span>';
    let heard = '';
    if (data.status === 'success' && data.known) {
        html = `<span class="msg-chip">${escapeHtml(pathLabel(data))}</span>`;
        if (data.learned_ago != null) {
            heard = String(Date.now() / 1000 - data.learned_ago);
            html += '<span class="msg-chip muted msg-heard"></span>';
        }
    }
    // Rewritten only when the path itself changed; the age ticks on its own.
    if (box.dataset.html !== html) {
        box.dataset.html = html;
        box.innerHTML = html;
    }
    box.dataset.heard = heard;
    tickHeard();
}

// "heard N ago" counts up every second, from the time the path was learned.
function tickHeard() {
    const box = document.getElementById('msg-chat-path');
    const chip = box && box.querySelector('.msg-heard');
    if (!chip || !box.dataset.heard) return;
    const text = `heard ${durationText(Math.max(0, Date.now() / 1000 - Number(box.dataset.heard)))} ago`;
    if (chip.textContent !== text) chip.textContent = text;
}
setInterval(tickHeard, 1000);

async function messengerBlock(peer) {
    const conv = Messenger.conversations.find(c => c.peer === peer);
    const ok = await confirmDialog('Block this contact',
        `Messages from <b>${escapeHtml(peerLabel(peer, conv && conv.name))}</b> will be dropped as they arrive.
         The conversation stays; Settings > LXMF Messenger lists blocked contacts and unblocks them.`, 'Block');
    if (!ok) return;
    const data = await fetch(`/api/messenger/block/${encodeURIComponent(peer)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blocked: true })
    }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
    if (data.status === 'success') showNotification('Contact blocked', 'success', 3000);
    else showNotification(escapeHtml(data.error || 'Could not block'), 'error', 5000);
    pollMessenger();
}

async function messengerUnblock(peer) {
    await fetch(`/api/messenger/block/${encodeURIComponent(peer)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blocked: false })
    }).catch(() => {});
    showNotification('Contact unblocked', 'success', 3000);
    await pollMessenger();
    if (typeof loadMessengerSettings === 'function') loadMessengerSettings();
}

// All that is known here about a contact, in one panel. Nothing is sent.
async function messengerPeerInfo(peer) {
    // On a slow network the answer takes a while: say so, as Ping and Check do.
    const btn = Messenger.peer === peer ? document.getElementById('msg-info') : null;
    if (btn) { if (btn.disabled) return; btn.disabled = true; btn.textContent = 'Reading…'; }
    const waiting = showNotification(`Reading what is known about ${pingWho(peer)}…`, 'info', 60000);
    let d;
    try {
        d = await fetch(`/api/messenger/peer/${encodeURIComponent(peer)}`).then(r => r.json());
    } catch (e) {
        showNotification(`Could not read the contact: ${escapeHtml(e.message)}`, 'error', 5000);
        return;
    } finally {
        if (waiting) waiting.remove();
        if (btn) { btn.disabled = false; btn.textContent = 'Info'; }
    }
    if (d.status !== 'success') {
        showNotification(escapeHtml(d.error || 'Unknown contact'), 'error', 5000);
        return;
    }
    const row = (label, value) => `<div class="msg-info-row"><span>${label}</span><span>${value}</span></div>`;
    const code = v => v ? `<code class="msg-info-copy" data-copy="${escapeHtml(v)}" title="Click to copy">${escapeHtml(v)}</code>` : '<i>unknown</i>';
    const when = ts => ts ? new Date(ts * 1000).toLocaleString() : '';
    // Live while open: read again every 5 s, and the ages count each second
    // from the moment of the last read.
    let readAt = Date.now();
    const rowsHtml = () => {
        const p = d.path || {};
        const since = (Date.now() - readAt) / 1000;
        let path = '<i>no path held</i>';
        if (p.known) {
            path = escapeHtml(pathLabel(p));
            if (p.learned_ago != null) path += `, heard ${durationText(p.learned_ago + since)} ago`;
            if (p.expires_in != null) path += p.expires_in - since > 0 ? `, expires in ${durationText(p.expires_in - since)}` : ', expired';
        }
        const nodes = d.nodes.length
            ? d.nodes.map(n => `<div class="msg-info-node">
                    <b>${escapeHtml(n.name || 'NomadNet node')}</b> ${code(n.hash)}
                    <button class="msg-bar-btn" data-open="${escapeHtml(n.hash)}">Open</button></div>`).join('')
            : '<i>none heard with this identity</i>';
        return row('LXMF address', code(d.address))
            + row('Identity', code(d.identity_hash))
            + row('Name', d.name ? escapeHtml(d.name) : '<i>not announced</i>')
            + row('Nickname', `${d.nickname ? escapeHtml(d.nickname) : '<i>none</i>'}
                <button class="msg-rename-btn" data-rename title="Rename contact" aria-label="Rename contact">${PENCIL_ICON}</button>`)
            + row('LXMF announce', d.announced ? 'heard' : '<i>not heard</i>')
            + row('Keys', d.keys_known ? 'known: messages can be sent and signatures checked' : '<i>not known yet</i>')
            + row('Stamp cost', d.stamp_cost ? `${d.stamp_cost} (computed for each message)` : 'none asked')
            + row('Path', path)
            + row('Next hop', p.next_hop ? code(p.next_hop) : '<i>-</i>')
            + row('NomadNet node', nodes)
            + row('Messages', `${d.messages_in} received, ${d.messages_out} sent${d.first ? `, since ${escapeHtml(when(d.first))}` : ''}`)
            + row('Blocked', d.blocked ? `yes <button class="msg-bar-btn" data-unblock="1">Unblock</button>` : 'no');
    };
    let last = rowsHtml();
    const overlay = document.createElement('div');
    overlay.className = 'auto-reload-modal';
    overlay.innerHTML = `<div class="auto-reload-dialog msg-info-dialog">
        <div class="dialog-header">
            <h3>${avatarHtml(peer, d.name, 'small', false)} ${escapeHtml(peerLabel(peer, d.name))}</h3>
            <button class="modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="dialog-scroll">${last}</div>
        <div class="msg-info-actions">
            <button class="msg-bar-btn" data-act="write">Send message</button>
            <button class="msg-bar-btn" data-act="ping">Ping</button>
            <button class="msg-bar-btn" data-act="check">Check if reachable</button>
            <button class="msg-bar-btn" data-act="close">Close</button>
        </div></div>`;
    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').onclick = close;
    overlay.addEventListener('click', e => {
        if (e.target === overlay) return close();
        const copy = e.target.closest('[data-copy]');
        if (copy) return copyText(copy.dataset.copy, 'Copied');
        const open = e.target.closest('[data-open]');
        if (open) { close(); openQuickAddress(`${open.dataset.open}:/page/index.mu`, null, true); return; }
        if (e.target.closest('[data-unblock]')) { close(); messengerUnblock(peer); return; }
        if (e.target.closest('[data-rename]')) { close(); renameContact(peer); return; }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        close();
        if (act.dataset.act === 'write') openMessenger(peer);
        else if (act.dataset.act === 'ping') messengerPing(peer);
        else if (act.dataset.act === 'check') checkLxmfReachable(peer, d.name || '');
    });
    document.body.appendChild(overlay);
    const scroll = overlay.querySelector('.dialog-scroll');
    const title = overlay.querySelector('.dialog-header h3');
    let ticks = 0, lastHead = `${avatarHtml(peer, d.name, 'small', false)} ${escapeHtml(peerLabel(peer, d.name))}`;
    const timer = setInterval(async () => {
        if (!overlay.isConnected) return clearInterval(timer);
        if (++ticks % 5 === 0) {
            try {
                const fresh = await fetch(`/api/messenger/peer/${encodeURIComponent(peer)}`).then(r => r.json());
                if (fresh.status === 'success') { d = fresh; readAt = Date.now(); }
            } catch (e) {}
            if (!overlay.isConnected) return;
            const head = `${avatarHtml(peer, d.name, 'small', false)} ${escapeHtml(peerLabel(peer, d.name))}`;
            if (head !== lastHead) title.innerHTML = lastHead = head;
        }
        // Rewritten only when something changed, so a selection or a click
        // on an address is not lost to the redraw.
        const html = rowsHtml();
        if (html !== last) scroll.innerHTML = last = html;
    }, 1000);
}

// Who a ping is for, in its notifications: several can run at once.
function pingWho(peer) {
    const conv = (Messenger.conversations || []).find(c => c.peer === peer);
    const groups = (Messenger.announced && Messenger.announced.groups) || {};
    const heard = [...(groups.lxmf_only || []), ...(groups.with_nomad || [])].find(p => p.address === peer);
    const name = nicknameOf(peer) || knownName(peer, conv) || (heard && heard.name) || '';
    const hash = `<code>${escapeHtml(peer.slice(0, 8))}…${escapeHtml(peer.slice(-4))}</code>`;
    return name ? `<strong>${escapeHtml(name)}</strong> ${hash}` : hash;
}

async function messengerPing(peer) {
    const who = pingWho(peer);
    const btn = Messenger.peer === peer ? document.getElementById('msg-ping') : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Pinging…'; }
    const waiting = showNotification(`Pinging ${who}…`, 'info', 120000);
    let data;
    try {
        data = await fetch(`/api/messenger/ping/${encodeURIComponent(peer)}`, { method: 'POST' }).then(r => r.json());
    } catch (e) {
        data = { status: 'error', error: e.message };
    } finally {
        if (waiting && waiting.parentNode) waiting.parentNode.removeChild(waiting);
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Ping'; }
    if (data.status === 'success') {
        const hops = data.hops != null ? `, ${data.hops} ${data.hops === 1 ? 'hop' : 'hops'}` : '';
        showNotification(`${who}<br>LXMF client online: <strong>${data.rtt_ms != null ? data.rtt_ms + ' ms' : 'answered'}</strong>${hops}`,
                         'success', 6000);
        if (Messenger.peer === peer) renderChatPath(peer);
    } else {
        showNotification(`${who}<br>${escapeHtml(data.error || 'No answer')}`, 'error', 7000);
    }
}

function messageHtml(m, cont, from, peer = Messenger.peer) {
    const out = m.dir === 'out';
    const [icon, label] = STATE_TEXT[m.state] || ['', ''];
    const d = m.ts ? new Date(m.ts * 1000) : null;
    const when = d ? d.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    const full = d ? d.toLocaleString([], { dateStyle: 'full', timeStyle: 'medium' }) : '';
    // After the ticks, how it went: always on screen, not only on hover.
    const [mIcon, mText] = METHOD_TEXT[m.method] || ['', m.method || ''];
    const method = out && m.method && !m.error && !(m.method === 'propagated' && m.state === 'sent')
        ? `<span class="msg-method" title="Sent ${escapeHtml(mText)}">${mIcon}</span>` : '';
    const status = out
        ? `<span class="msg-state msg-state-${escapeHtml(m.state)}" title="${escapeHtml(m.error || label)}${
            m.method && !m.error ? ` - ${escapeHtml(mText)}` : ''}">${icon}</span>${method}`
        : (m.verified === false ? '<span class="msg-state msg-unverified" title="The sender\'s keys are not known yet: the signature could not be checked">unverified</span>' : '')
          // How it came, and when, if long after it was written (the
          // sender's client delivered it late: we were unreachable).
          + (m.method && mIcon ? `<span class="msg-method" title="Received ${escapeHtml(mText)}">${mIcon}</span>` : '')
          + (m.received && m.ts && m.received - m.ts > 300
              ? `<span class="msg-late" title="Written ${escapeHtml(full)}, arrived here ${escapeHtml(new Date(m.received * 1000).toLocaleString([], { dateStyle: 'full', timeStyle: 'medium' }))}">arrived ${escapeHtml(new Date(m.received * 1000).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</span>` : '');
    const hasFiles = !!(m.files && m.files.length);
    // × on a message of ours still going out: cancel it (messenger.cancel).
    const cancelBtn = out && ['sending', 'waiting', 'propagating'].includes(m.state)
        ? `<button class="msg-cancel" data-cancel="${escapeHtml(m.local_id)}" title="Cancel: it is not sent" aria-label="Cancel sending">&times;</button>` : '';
    const retry = out && (m.state === 'failed' || m.state === 'cancelled')
        ? `<button class="msg-retry" data-local="${escapeHtml(m.local_id)}"
                   title="${escapeHtml(m.error || '')}">Retry</button>` : '';
    const title = m.title ? `<div class="msg-title">${escapeHtml(m.title)}</div>` : '';
    const md = m.renderer === 'markdown' && markdownOn();
    const text = (m.content || !hasFiles)
        ? `<div class="msg-text${md ? ' md' : ''}">${md ? markdownHtml(m.content || '') : linkify(m.content || '')}</div>` : '';
    const reactions = reactionsHtml(m);
    const reactBtn = m.id && m.state !== 'failed'
        ? `<span class="msg-actions"><button class="msg-react-btn" data-react="${escapeHtml(m.id)}" title="React" aria-label="React">${SMILE_ICON}</button>`
          + `<button class="msg-react-btn msg-reply-btn" data-reply="${escapeHtml(m.id)}" title="Reply" aria-label="Reply">${REPLY_ICON}</button></span>` : '';
    // The message this one answers (FIELD_REPLY_TO / FIELD_REPLY_QUOTE); a click goes to it.
    const replyBox = m.reply_to
        ? `<div class="msg-quote" data-goto="${escapeHtml(m.reply_to)}" title="Go to the message answered">
            ${m._quotedFrom ? `<span class="msg-quote-from">${escapeHtml(m._quotedFrom)}</span>` : ''}
            <span class="msg-quote-text">${escapeHtml(m.reply_quote || '…')}</span></div>` : '';
    const unsupported = (m.unsupported || []).map(u =>
        `<div class="msg-unsupported" title="Sent from Sideband or similar">(${escapeHtml(u === 'voice message'
            ? 'voice message - received before rBrowser played them' : u)})</div>`).join('');
    const progress = (m.progress != null && out && (m.state === 'sending' || m.state === 'propagating'))
        ? `<div class="msg-progress" title="Sending: ${Math.round(m.progress * 100)}%"><span style="width:${Math.round(m.progress * 100)}%"></span></div>` : '';
    return `<div class="msg-row ${out ? 'out' : 'in'}${cont ? ' cont' : ''}${m.state === 'failed' ? ' failed' : ''}${m.state === 'cancelled' ? ' cancelled' : ''}"${m.id ? ` data-msgid="${escapeHtml(m.id)}"` : ''}>
        <div class="msg-bubble">${cancelBtn}${from ? `<div class="msg-from">${escapeHtml(from)}</div>` : ''}${replyBox}${title}${filesHtml(peer, m)}${unsupported}${text}${progress}
            <div class="msg-meta">${m.tries > 1 ? `<span class="msg-tries" title="Sent again with Retry">try ${Number(m.tries)}</span> ` : ''}<span title="${escapeHtml(full)}">${escapeHtml(when)}</span> ${status}</div>${retry}${reactions}</div>${reactBtn}
    </div>`;
}

// ─── Reactions (FIELD_REACTION) ─────────────────────────────

const REPLY_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M6.5 4L2.5 8l4 4M2.8 8h6.7a4 4 0 0 1 4 4v1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SMILE_ICON ='<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5.9" cy="6.6" r=".9" fill="currentColor"/><circle cx="10.1" cy="6.6" r=".9" fill="currentColor"/><path d="M5.3 9.6c.7 1.1 1.6 1.6 2.7 1.6s2-.5 2.7-1.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

function reactionsHtml(m) {
    const r = m.reactions || {};
    if (!r.me && !r.peer) return '';
    const pill = (who, emoji) => `<button class="msg-reaction${who === 'me' ? ' mine' : ''}" data-react-id="${escapeHtml(m.id || '')}"
        data-who="${who}" title="${who === 'me' ? 'Your reaction - click to take it back' : 'Their reaction'}">${escapeHtml(emoji)}</button>`;
    return `<div class="msg-reactions">${r.peer ? pill('peer', r.peer) : ''}${r.me ? pill('me', r.me) : ''}</div>`;
}

async function messengerReact(peer, id, reaction) {
    const d = await fetch(`/api/messenger/react/${encodeURIComponent(peer)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, reaction })
    }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
    if (d.status !== 'success') showNotification(escapeHtml(d.error || 'Reaction not sent'), 'error', 5000);
    refreshMessenger(false);
}

// The quick reactions, and a box for any other emoji (Win+. or the
// phone's emoji keyboard).
function showReactionPicker(anchor, peer, id) {
    document.querySelectorAll('.msg-react-picker').forEach(p => p.remove());
    const quick = (Messenger.state && Messenger.state.quick_reactions) || ['👍', '❤️', '😂', '😮', '😢', '🙏'];
    const picker = document.createElement('div');
    picker.className = 'msg-react-picker';
    picker.innerHTML = quick.map(e => `<button data-emoji="${escapeHtml(e)}">${escapeHtml(e)}</button>`).join('')
        + '<input type="text" maxlength="8" placeholder="+" title="Any other emoji, then Enter" aria-label="Other emoji">';
    document.body.appendChild(picker);
    const r = anchor.getBoundingClientRect();
    const w = picker.offsetWidth, h = picker.offsetHeight;
    picker.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8))}px`;
    picker.style.top = `${r.top - h - 6 > 8 ? r.top - h - 6 : r.bottom + 6}px`;
    const close = () => { picker.remove(); document.removeEventListener('pointerdown', outside, true); };
    const outside = e => { if (!picker.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    picker.addEventListener('click', e => {
        const b = e.target.closest('[data-emoji]');
        if (!b) return;
        close();
        messengerReact(peer, id, b.dataset.emoji);
    });
    const input = picker.querySelector('input');
    input.addEventListener('keydown', e => {
        if (e.key === 'Escape') close();
        if (e.key === 'Enter' && input.value.trim()) { close(); messengerReact(peer, id, input.value.trim()); }
    });
}

// ─── Markdown (FIELD_RENDERER) ──────────────────────────────

function markdownOn() {
    const s = Messenger.state && Messenger.state.settings;
    return !s || s.markdown !== false;
}

// Someone else's text: escaped first, then only these marks become tags.
// No raw HTML, no images, links only http(s) and NomadNet addresses.
function markdownHtml(src) {
    const keep = [];
    const stash = html => `\u0000${keep.push(html) - 1}\u0000`;
    let text = escapeHtml(String(src)).replace(/\r\n?/g, '\n');
    text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (all, code) => stash(`<pre class="md-pre"><code>${code.replace(/\n$/, '')}</code></pre>`));
    text = text.replace(/`([^`\n]+)`/g, (all, code) => stash(`<code class="md-code">${code}</code>`));
    text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (all, label, url) =>
        stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`));
    text = linkifyEscaped(text, stash);
    const inline = s => s
        .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (a, x, y) => `<b>${x || y}</b>`)
        .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)|(^|[^\w_])_([^_\n]+)_(?!\w)/g,
                 (a, p1, x, p2, y) => `${p1 ?? p2 ?? ''}<i>${x || y}</i>`)
        .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    const out = [];
    let list = null;
    for (const line of text.split('\n')) {
        const item = line.match(/^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/);
        if (item) {
            const kind = item[1] ? 'ol' : 'ul';
            if (list !== kind) { if (list) out.push(`</${list}>`); out.push(`<${kind} class="md-list">`); list = kind; }
            out.push(`<li>${inline(item[2])}</li>`);
            continue;
        }
        if (list) { out.push(`</${list}>`); list = null; }
        const head = line.match(/^(#{1,6})\s+(.*)$/);
        if (head) { out.push(`<div class="md-h md-h${head[1].length}">${inline(head[2])}</div>`); continue; }
        const quote = line.match(/^&gt;\s?(.*)$/);
        if (quote) { out.push(`<div class="md-quote">${inline(quote[1])}</div>`); continue; }
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr class="md-hr">'); continue; }
        out.push(inline(line) + '\n');
    }
    if (list) out.push(`</${list}>`);
    return out.join('').replace(/\n$/, '').replace(/\u0000(\d+)\u0000/g, (a, i) => keep[Number(i)]);
}

// ─── Files ──────────────────────────────────────────────────
// Sent as Sideband does (FIELD_IMAGE / FIELD_FILE_ATTACHMENTS, messenger.py).
// Received ones are in downloads/<contact>/ on the computer rBrowser runs on.

const CLIP_ICON = '<svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true"><path d="M13.5 7.5l-5.6 5.6a3.3 3.3 0 0 1-4.7-4.7l6-6a2.2 2.2 0 0 1 3.1 3.1l-6 6a1.1 1.1 0 0 1-1.6-1.6l5.5-5.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FILE_ICON = '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

function sizeText(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fileUrl(peer, localId, index, download) {
    return `/api/messenger/file/${encodeURIComponent(peer)}/${encodeURIComponent(localId)}/${index}${download ? '?download=1' : ''}`;
}

// ─── Audio in messages ──────────────────────────────────────
// Voice messages (Sideband) and audio files: ▶/⏸, a bar to jump, the time.
// One sound at a time; the chat is redrawn often, so the state lives here
// and every drawing of the same file (data-src) is brought up to it.

const AUDIO_PLAY_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 3l8 5-8 5z" fill="currentColor"/></svg>';
const AUDIO_PAUSE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor"/></svg>';
const AUDIO_EXT = /\.(ogg|oga|opus|wav|mp3|m4a|aac|flac|weba)$/i;
const MsgAudio = { player: null, src: null, durations: new Map() };

function isAudioFile(f) {
    return f.kind === 'audio' || /^audio\//.test(f.mime || '') || AUDIO_EXT.test(f.name || '');
}

function clockText(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const s = Math.floor(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function audioTimeText(src) {
    const total = MsgAudio.durations.get(src);
    if (MsgAudio.src === src && MsgAudio.player) {
        return `${clockText(MsgAudio.player.currentTime)} / ${clockText(total || MsgAudio.player.duration)}`;
    }
    return total ? clockText(total) : '--:--';
}

// Every drawing of the file playing (or just stopped) shows its state.
function syncAudioViews(src) {
    const p = MsgAudio.src === src ? MsgAudio.player : null;
    const playing = !!(p && !p.paused);
    const total = MsgAudio.durations.get(src) || (p && p.duration);
    const done = p && isFinite(total) && total > 0 ? Math.min(1, p.currentTime / total) : 0;
    document.querySelectorAll('.msg-audio').forEach(el => {
        if (el.dataset.src !== src) return;
        el.classList.toggle('playing', playing);
        const btn = el.querySelector('.msg-audio-play');
        btn.innerHTML = playing ? AUDIO_PAUSE_ICON : AUDIO_PLAY_ICON;
        btn.title = playing ? 'Pause' : 'Play';
        el.querySelector('.msg-audio-fill').style.width = `${(done * 100).toFixed(1)}%`;
        el.querySelector('.msg-audio-time').textContent = audioTimeText(src);
    });
}

function toggleAudio(el) {
    const src = el.dataset.src;
    if (MsgAudio.src === src && MsgAudio.player) {
        if (MsgAudio.player.paused) MsgAudio.player.play().catch(e => showNotification(`Cannot play: ${escapeHtml(e.message)}`, 'error', 5000));
        else MsgAudio.player.pause();
        return;
    }
    if (MsgAudio.player) {
        const old = MsgAudio.src;
        MsgAudio.player.pause();
        MsgAudio.player = null;
        MsgAudio.src = null;
        syncAudioViews(old);
    }
    const p = new Audio(src);
    MsgAudio.player = p;
    MsgAudio.src = src;
    const sync = () => { if (MsgAudio.player === p) syncAudioViews(src); };
    p.addEventListener('loadedmetadata', () => {
        if (isFinite(p.duration)) MsgAudio.durations.set(src, p.duration);
        sync();
    });
    ['timeupdate', 'play', 'pause'].forEach(ev => p.addEventListener(ev, sync));
    p.addEventListener('ended', () => { p.currentTime = 0; sync(); });
    p.addEventListener('error', () => {
        showNotification('This audio cannot be played in this browser: download it from the ⋯ menu', 'error', 6000);
        sync();
    });
    p.play().catch(() => {});
    sync();
}

function seekAudio(el, event) {
    const bar = el.querySelector('.msg-audio-bar');
    const r = bar.getBoundingClientRect();
    const at = Math.min(1, Math.max(0, (event.clientX - r.left) / r.width));
    if (MsgAudio.src !== el.dataset.src) toggleAudio(el);
    const p = MsgAudio.player;
    const jump = () => { if (isFinite(p.duration)) { p.currentTime = at * p.duration; syncAudioViews(el.dataset.src); } };
    if (p.readyState >= 1) jump(); else p.addEventListener('loadedmetadata', jump, { once: true });
}

// The length of each file, read once (only the start of it is fetched).
function readAudioDurations() {
    document.querySelectorAll('.msg-audio:not([data-dur-asked])').forEach(el => {
        el.dataset.durAsked = '1';
        const src = el.dataset.src;
        if (MsgAudio.durations.has(src)) return;
        const probe = new Audio();
        probe.preload = 'metadata';
        probe.addEventListener('loadedmetadata', () => {
            if (isFinite(probe.duration)) {
                MsgAudio.durations.set(src, probe.duration);
                syncAudioViews(src);
            }
            probe.removeAttribute('src');
        }, { once: true });
        probe.src = src;
    });
}
{
    let pending = null;
    new MutationObserver(() => {
        if (pending) return;
        pending = setTimeout(() => {
            pending = null;
            if (document.querySelector('.msg-audio:not([data-dur-asked])')) readAudioDurations();
            if (MsgAudio.src) syncAudioViews(MsgAudio.src);
        }, 250);
    }).observe(document.documentElement, { childList: true, subtree: true });
}

function filesHtml(peer, m) {
    if (!m.files || !m.files.length || !m.local_id) return '';
    return `<div class="msg-files">${m.files.map((f, i) => {
        const attrs = `data-file="${i}" data-local="${escapeHtml(m.local_id)}"`;
        const tip = `${f.name} - ${sizeText(f.size || 0)}${f.error ? ' - ' + f.error : ''}`;
        // Settings > LXMF Messenger > Show image previews: off, an image is a file like the others.
        const previews = !(Messenger.state && Messenger.state.settings && Messenger.state.settings.image_previews === false);
        if (f.kind === 'image' && !f.deleted && previews) {
            return `<a href="#" class="msg-image" ${attrs} title="${escapeHtml(tip)} - click to open, right-click for more">
                <img src="${fileUrl(peer, m.local_id, i)}" alt="${escapeHtml(f.name)}" loading="lazy">
                <span class="msg-file-more" title="More">&#8943;</span></a>`;
        }
        if (isAudioFile(f) && !f.deleted) {
            const src = fileUrl(peer, m.local_id, i);
            const voice = /^voice-/.test(f.name);
            return `<div class="msg-audio" ${attrs} data-src="${escapeHtml(src)}" title="${escapeHtml(tip)}">
                <button type="button" class="msg-audio-play" title="Play">${AUDIO_PLAY_ICON}</button>
                <div class="msg-audio-body">
                    <div class="msg-audio-bar" title="Click to jump there"><div class="msg-audio-fill"></div></div>
                    <div class="msg-audio-meta"><span class="msg-audio-time">${audioTimeText(src)}</span>
                        <span class="msg-audio-name">${voice ? 'Voice message' : escapeHtml(f.name)} · ${sizeText(f.size || 0)}</span></div>
                </div>
                <span class="msg-file-more" title="More">&#8943;</span></div>`;
        }
        return `<a href="#" class="msg-file${f.deleted ? ' deleted' : ''}" ${attrs} title="${escapeHtml(tip)}">
            <span class="msg-file-icon">${FILE_ICON}</span>
            <span class="msg-file-main"><span class="msg-file-name">${escapeHtml(f.name)}</span>
                <span class="msg-file-size">${f.deleted ? (f.error ? 'not saved' : 'deleted') : sizeText(f.size || 0)}</span></span>
            <span class="msg-file-more" title="More">&#8943;</span></a>`;
    }).join('')}</div>`;
}

function rbrowserIsLocal() {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
}

async function showFileMenu(anchor, peer, localId, index) {
    let msgs = [];
    try {
        msgs = (await fetch(`/api/messenger/messages/${encodeURIComponent(peer)}`).then(r => r.json())).messages || [];
    } catch (e) {}
    const m = msgs.find(x => x.local_id === localId);
    const f = m && m.files && m.files[index];
    if (!f) return;
    const gone = !!f.deleted;
    const where = m.dir === 'in' ? (f.path ? `downloads/${f.path}` : 'kept in memory (ephemeral identity)')
                                 : 'copy of a file you sent';
    openNodeMenu(anchor, f.name, `${sizeText(f.size || 0)} - ${where}`, [
        { label: 'Open', disabled: gone, run: () => window.open(fileUrl(peer, localId, index), '_blank', 'noopener'),
          tip: 'In a new browser tab (images and PDF), otherwise it is saved' },
        { label: 'Download', disabled: gone, run: () => {
              const a = document.createElement('a');
              a.href = fileUrl(peer, localId, index, true);
              a.download = f.name;
              document.body.appendChild(a);
              a.click();
              a.remove();
          }, tip: 'Save it with the browser, on this device' },
        ...(rbrowserIsLocal() && f.path ? [{ label: 'Show in folder', disabled: gone,
            run: () => fetch(fileUrl(peer, localId, index) + '/show', { method: 'POST' }).then(r => r.json())
                .then(d => { if (d.status !== 'success') showNotification(escapeHtml(d.error || 'Not found'), 'error', 5000); }),
            tip: 'Open the downloads folder on this computer' }] : []),
        { label: 'Copy name', run: () => copyText(f.name, 'File name copied') },
        '-',
        { label: 'Delete file', danger: true, disabled: gone, run: async () => {
              const ok = await confirmDialog('Delete file', `<b>${escapeHtml(f.name)}</b> is removed from
                  ${m.dir === 'in' && f.path ? 'the downloads folder' : 'this computer'}. The message stays.`, 'Delete');
              if (!ok) return;
              const d = await fetch(fileUrl(peer, localId, index) + '/delete', { method: 'POST' })
                  .then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
              if (d.status !== 'success') showNotification(escapeHtml(d.error || 'Not deleted'), 'error', 5000);
              refreshMessenger(false);
          }, tip: 'Remove the file; the message stays, marked deleted' },
    ]);
}

// Files waiting to go with the next message, shown above the text box.
function renderPendingFiles(chat) {
    const box = chat.querySelector('.msg-attach');
    if (!box) return;
    const files = Messenger.pending || [];
    box.hidden = !files.length;
    box.innerHTML = files.map((f, i) => `<span class="msg-attach-chip" title="${escapeHtml(f.name)}">
        ${f.type.startsWith('image/') ? '🖼' : '📎'} <span class="msg-attach-name">${escapeHtml(f.name)}</span>
        <span class="msg-attach-size">${sizeText(f.size)}</span>
        <button data-i="${i}" title="Remove" aria-label="Remove">&times;</button></span>`).join('')
        + (files.length ? `<span class="msg-attach-total">${sizeText(files.reduce((s, f) => s + f.size, 0))}</span>` : '');
    box.querySelectorAll('button[data-i]').forEach(b => b.onclick = () => {
        Messenger.pending.splice(Number(b.dataset.i), 1);
        renderPendingFiles(chat);
    });
}

function addPendingFiles(chat, list) {
    const limits = (Messenger.state && Messenger.state.attach_limits) || { bytes: 10485760, files: 10 };
    const files = [...(Messenger.pending || [])];
    for (const f of list) {
        if (!f) continue;            // any file goes, an empty one too
        if (files.length >= limits.files) {
            showNotification(`At most ${limits.files} files in one message`, 'error', 5000);
            break;
        }
        if (files.reduce((s, x) => s + x.size, 0) + f.size > limits.bytes) {
            showNotification(`${escapeHtml(f.name)} left out: at most ${sizeText(limits.bytes)} in one message`, 'error', 6000);
            continue;
        }
        files.push(f);
    }
    Messenger.pending = files;
    renderPendingFiles(chat);
    const input = chat.querySelector('.msg-input');
    if (input && !isMobileDevice()) input.focus();
    // Settings > LXMF Messenger > Send files at once: no Enter needed.
    const settings = (Messenger.state && Messenger.state.settings) || {};
    if (settings.autosend_files && files.length && input && chat.dataset.peer) messengerSend(chat.dataset.peer, input);
}

// Paperclip, paste, and files dropped anywhere on the chat (Telegram Web).
function bindFileInputs(chat) {
    const picker = chat.querySelector('.msg-file-input');
    chat.querySelector('.msg-clip').onclick = () => picker.click();
    picker.onchange = () => { addPendingFiles(chat, picker.files); picker.value = ''; };
    chat.querySelector('.msg-input').addEventListener('paste', e => {
        const files = [...((e.clipboardData && e.clipboardData.files) || [])];
        if (!files.length) return;
        e.preventDefault();
        // A pasted screenshot is called "image.png": give it a better name.
        addPendingFiles(chat, files.map(f => f.name === 'image.png'
            ? new File([f], `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`, { type: f.type })
            : f));
    });
    if (chat.dataset.dropBound) return;
    chat.dataset.dropBound = '1';
    // The drop area shows while a file is over the chat. Counting enter and
    // leave got stuck (the chat redrawn under the pointer, a file dragged
    // past on its way to another window): it stayed up for good. Now it
    // lives on dragover, which the browser repeats while the file is over
    // the chat - when they stop it goes - and Esc or a click closes it.
    const hasFiles = e => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
    let lastOver = 0;
    let watch = null;
    const hide = () => {
        chat.classList.remove('dropping');
        clearInterval(watch);
        watch = null;
    };
    const show = () => {
        lastOver = Date.now();
        if (watch) return;
        chat.classList.add('dropping');
        watch = setInterval(() => { if (Date.now() - lastOver > 400) hide(); }, 150);
    };
    chat.addEventListener('dragenter', e => {
        if (!hasFiles(e) || !chat.querySelector('.msg-compose')) return;
        e.preventDefault();
        show();
    });
    chat.addEventListener('dragover', e => {
        if (!hasFiles(e) || !chat.querySelector('.msg-compose')) return;
        e.preventDefault();
        show();
    });
    chat.addEventListener('dragleave', e => {
        if (!e.relatedTarget || !chat.contains(e.relatedTarget)) hide();
    });
    chat.addEventListener('drop', e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        hide();
        if (chat.querySelector('.msg-compose')) addPendingFiles(chat, e.dataTransfer.files);
    });
    chat.addEventListener('click', () => { if (chat.classList.contains('dropping')) hide(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && chat.classList.contains('dropping')) hide(); });
    window.addEventListener('blur', hide);
}

// What we send always shows at the bottom, also when the bubble grows after
// (an image loading, a progress bar): pinned there for a few seconds, until
// scrolled by hand. Messages that arrive never move someone reading higher up.
const PIN_BOTTOM_MS = 8000;

function pinBottom() {
    Messenger.pinBottomUntil = Date.now() + PIN_BOTTOM_MS;
    const log = document.querySelector('#msg-chat .msg-log');
    if (log) log.scrollTop = log.scrollHeight;
}

function pinnedToBottom() {
    return (Messenger.pinBottomUntil || 0) > Date.now();
}

async function messengerRetry(peer, localId) {
    if (!(await confirmEphemeralSend())) return;
    const d = await fetch(`/api/messenger/retry/${encodeURIComponent(peer)}/${encodeURIComponent(localId)}`, { method: 'POST' })
        .then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
    if (d.status !== 'success') showNotification(escapeHtml(d.error || 'Not sent'), 'error', 5000);
    // The bubble stays where it is: no jump to the bottom.
    await refreshMessenger(false);
    pollMessenger();
}

// Message text is someone else's: escaped, with addresses and web links
// made clickable and nothing else interpreted.
function linkify(text) {
    return linkifyEscaped(escapeHtml(text));
}

// The same on text already escaped. wrap: what each link becomes (markdown
// sets it aside, so its marks never touch a link).
// One pass, so a link made never gets another one inside it:
//   lxmf://<hash> (Sideband), lxmf@<hash> (NomadNet) or a bare 32-hex hash:
//     the LXMF menu (send a message, add to contacts, check...);
//   <hash>:/path: a NomadNet page; http(s)://: the web.
//   rrc://<hash>[/room] and MeshChatX's meshchatx://relay?hub=...: RRC chat.
const MSG_LINKS = /(\blxmf(?:@|:\/\/)([0-9a-f]{32})(?![0-9a-z])\/?)|(\b(?:rrc:\/\/[0-9a-f]{32}(?:\/[^\s<\u0000]*)?|(?:meshchatx|meshchat):\/\/relay\?[^\s<\u0000]+))|\b([0-9a-f]{32}):(\/[\w\-./%~]*)|(\bhttps?:\/\/[^\s<\u0000]+)|\b([0-9a-f]{32})\b/gi;

function linkifyEscaped(html, wrap = x => x) {
    return html.replace(MSG_LINKS, (all, lxmf, lxmfHash, rrc, pageHash, path, url, bare) => {
        if (lxmf || bare) {
            const hash = (lxmfHash || bare).toLowerCase();
            return wrap(`<a href="#" class="msg-lxmf-link" data-lxmf="${hash}">${all}</a>`);
        }
        if (rrc) {
            const address = typeof relayUrlToRrc === 'function' && relayUrlToRrc(rrc.replace(/&amp;/g, '&')) || rrc;
            return wrap(`<a href="#" class="msg-rrc-link" data-rrc="${escapeHtml(address)}">${all}</a>`);
        }
        if (pageHash) return wrap(`<a href="#" class="msg-link" data-url="${pageHash}:${path}">${all}</a>`);
        return wrap(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    });
}

// The links of a message: a click opens them in their client (in its own
// window when it has one), a right-click gives their menu.
function msgLinkTarget(link) {
    if (link.classList.contains('msg-lxmf-link')) return { kind: 'lxmf', address: link.dataset.lxmf };
    if (link.classList.contains('msg-rrc-link')) return { kind: 'rrc', address: link.dataset.rrc };
    if (link.classList.contains('msg-link')) return { kind: 'page', address: link.dataset.url };
    return null;
}

document.addEventListener('contextmenu', e => {
    const link = e.target.closest('.msg-link, .msg-lxmf-link, .msg-rrc-link');
    if (!link) return;
    e.preventDefault();
    showClientLinkMenu(link, msgLinkTarget(link));
});

document.addEventListener('click', e => {
    const link = e.target.closest('.msg-link, .msg-lxmf-link, .msg-rrc-link');
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    openLinkTarget(msgLinkTarget(link));
});

function messengerBack() {
    Messenger.peer = null;
    refreshMessenger(false);
}

// ─── Sending ────────────────────────────────────────────────

function ephemeralChangeText(st) {
    const rot = st.ephemeral_rotation || {};
    if (rot.mode === 'timed' && rot.seconds != null) return `in ${durationText(rot.seconds)}`;
    if (rot.mode === 'reload') return 'when this page is reloaded';
    return 'when rBrowser restarts';
}

function confirmEphemeralSend() {
    const st = Messenger.state || {};
    if (!st.ephemeral || Messenger.ephemeralOk) return Promise.resolve(true);
    // Enter in the text box while the question is up asked it again, one
    // dialog over the other, and each one sent: one question at a time,
    // and Enter / Esc answer it.
    if (Messenger.ephemeralAsking) return Promise.resolve(false);
    Messenger.ephemeralAsking = true;
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'auto-reload-modal';
        overlay.innerHTML = `<div class="auto-reload-dialog msg-warn-dialog">
            <div class="dialog-header"><h3>Ephemeral identity</h3></div>
            <div class="settings-hint">You are writing as a throwaway identity. It changes
                <b>${escapeHtml(ephemeralChangeText(st))}</b>: replies that arrive after that are lost,
                and nobody can write to this address again.</div>
            <label class="cache-search-exact"><input type="checkbox" class="msg-warn-session"> don't ask again until the page is reloaded</label>
            <div class="auto-reload-actions">
                <button class="btn-cancel">Cancel</button>
                <button class="btn-save">Send</button>
            </div></div>`;
        const onKey = e => {
            if (e.key !== 'Enter' && e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            done(e.key === 'Enter');
        };
        const done = ok => {
            if (ok && overlay.querySelector('.msg-warn-session').checked) Messenger.ephemeralOk = true;
            document.removeEventListener('keydown', onKey, true);
            Messenger.ephemeralAsking = false;
            overlay.remove();
            resolve(ok);
        };
        overlay.querySelector('.btn-cancel').onclick = () => done(false);
        overlay.querySelector('.btn-save').onclick = () => done(true);
        overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(overlay);
        overlay.querySelector('.btn-save').focus();
    });
}

async function messengerSend(peer, input) {
    const content = input.value;
    const chat = input.closest('#msg-chat');
    const files = (Messenger.pendingPeer === peer && Messenger.pending) || [];
    if (!content.trim() && !files.length) return;
    if (!(await confirmEphemeralSend())) return;
    const via = input.closest('.msg-compose') && input.closest('.msg-compose').querySelector('.msg-via-pn');
    const propagated = !!(via && !via.hidden && via.classList.contains('active'));
    const reply = Messenger.replyTo && Messenger.replyTo.peer === peer ? Messenger.replyTo : null;
    let body, headers = {};
    if (files.length) {
        body = new FormData();
        body.append('peer', peer);
        body.append('content', content);
        if (reply) body.append('reply_to', reply.id);
        if (propagated) body.append('propagated', '1');
        files.forEach(f => body.append('file', f, f.name));
    } else {
        headers = { 'Content-Type': 'application/json' };
        body = JSON.stringify({ peer, content, propagated, reply_to: reply ? reply.id : null });
    }
    const sendBtn = chat && chat.querySelector('.msg-send');
    if (sendBtn) sendBtn.disabled = true;
    let data;
    try {
        data = await fetch('/api/messenger/send', { method: 'POST', headers, body }).then(r => r.json());
    } catch (e) {
        data = { status: 'error', error: e.message };
    } finally {
        if (sendBtn) sendBtn.disabled = false;
    }
    if (data.status !== 'success') {
        showNotification(escapeHtml(data.error || 'Not sent'), 'error', 5000);
        return;
    }
    if (data.warning) showNotification(escapeHtml(data.warning), 'warning', 7000);
    if (files.length) {
        Messenger.pending = [];
        if (chat) renderPendingFiles(chat);
    }
    if (reply) {
        Messenger.replyTo = null;
        if (chat) renderReplyBar(chat);
    }
    input.value = '';
    input.dispatchEvent(new Event('input'));     // back to one line
    Messenger.peer = peer;
    pinBottom();
    // Drawn at once; the poll after it changes only what moved (updateLog).
    await refreshMessenger(true);
    pollMessenger();
}

// Clear: the messages go, the contact stays in the list and the chat open
// (Delete takes the contact away, to be found again among the peers).
async function messengerClearConversation(peer) {
    const conv = Messenger.conversations.find(c => c.peer === peer);
    const who = escapeHtml(peerLabel(peer, conv && conv.name));
    const ok = await confirmDialog('Clear conversation',
        `Clear the messages with ${who} from this computer? The contact stays in the list. Messages already delivered stay with the other side.`,
        'Clear');
    if (!ok) return;
    const res = await fetch(`/api/messenger/clear/${encodeURIComponent(peer)}`, { method: 'POST' })
        .then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
    if (res.status !== 'success') { showNotification(escapeHtml(res.error || 'Not cleared'), 'error', 5000); return; }
    await pollMessenger();
    refreshMessenger(true);
}

async function messengerDeleteConversation(peer) {
    const conv = Messenger.conversations.find(c => c.peer === peer);
    const who = escapeHtml(peerLabel(peer, conv && conv.name));
    // The same contact may have a chat with several of our identities.
    const owners = await fetch(`/api/messenger/owners/${encodeURIComponent(peer)}`).then(r => r.json())
        .then(d => d.owners || []).catch(() => []);
    let everywhere = false;
    if (owners.length > 1) {
        const names = owners.map(o => `<b>${escapeHtml(o.name || o.address.slice(0, 8))}</b>${o.active ? ' (in use)' : ''}`).join(', ');
        const c = await choiceDialog('Delete conversation',
            `${who} has a conversation with ${owners.length} of your identities: ${names}. Delete only the one of the identity in use, or all of them? Messages already delivered stay with the other side.`,
            `All ${owners.length} identities`, 'Only this identity');
        if (!c) return;
        everywhere = c === 'a';
    } else {
        const ok = await confirmDialog('Delete conversation',
            `Delete the conversation with ${who} from this computer? Messages already delivered stay with the other side.`,
            'Delete');
        if (!ok) return;
    }
    await fetch(`/api/messenger/delete/${encodeURIComponent(peer)}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: everywhere }) }).catch(() => {});
    // Its tab goes with it (nothing to keep of a deleted chat).
    const key = chatTabKey(currentIdentityId(), peer);
    Messenger.tabs = Messenger.tabs.filter(t => chatTabKey(t.id, t.peer) !== key);
    delete Messenger.tabState[key];
    const chat = document.getElementById('msg-chat');
    if (chat && chat.dataset.tabKey === key) delete chat.dataset.tabKey;
    // Another chat on screen stays open: only the deleted one closes.
    if (Messenger.peer === peer) Messenger.peer = null;
    await pollMessenger();
    refreshMessenger(false);
}

// Offline: no identity listens, nothing is announced, synced or sent; the
// chats stay readable. The LXMF tab's dot goes grey.
function syncOfflineButton() {
    const btn = document.getElementById('msg-offline-btn');
    if (!btn) return;
    const off = !!(Messenger.state && Messenger.state.settings && Messenger.state.settings.offline);
    btn.textContent = off ? 'Go online' : 'Go offline';
    btn.classList.toggle('on', off);
    btn.title = off ? 'You are offline: click to listen again on all your identities (and announce)'
                    : 'Stop listening on all your LXMF identities, without turning the messenger off';
}

async function messengerToggleOffline() {
    const off = !(Messenger.state && Messenger.state.settings && Messenger.state.settings.offline);
    const res = await fetch('/api/messenger/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offline: off }) }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
    if (res.status === 'error') { showNotification(`Not changed: ${escapeHtml(res.error || 'error')}`, 'error', 5000); return; }
    showNotification(off ? 'LXMF offline: not listening on any identity' : 'LXMF back online: listening and announced', 'info', 4000);
    await pollMessenger();
    if (typeof applyMessengerVisibility === 'function') applyMessengerVisibility();
}

function confirmDialog(title, html, okLabel) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'auto-reload-modal';
        overlay.innerHTML = `<div class="auto-reload-dialog msg-warn-dialog">
            <div class="dialog-header"><h3>${escapeHtml(title)}</h3></div>
            <div class="settings-hint">${html}</div>
            <div class="auto-reload-actions">
                <button class="btn-cancel">Cancel</button>
                <button class="btn-save">${escapeHtml(okLabel)}</button>
            </div></div>`;
        const done = ok => { overlay.remove(); resolve(ok); };
        overlay.querySelector('.btn-cancel').onclick = () => done(false);
        overlay.querySelector('.btn-save').onclick = () => done(true);
        overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
        document.body.appendChild(overlay);
    });
}

// ─── Send address to... ──────────────────────────────────────
// Another peer's address, sent as a message to someone: the name, the hash
// and the lxmf:// link Sideband uses, so the one who gets it can tap it.
// The one to send to: one of your contacts, a peer heard announcing (search)
// or a hash pasted in the box.

function contactCardText(address, name) {
    return `${name || 'Contact'}\n${address}\nlxmf://${address}`;
}

async function sendAddressTo(address, name) {
    address = String(address || '').toLowerCase();
    const conv = (Messenger.conversations || []).find(c => c.peer === address);
    const cardName = knownName(address, conv) || name || nicknameOf(address) || '';
    const target = await pickRecipient(address, cardName);
    if (!target) return;
    const text = contactCardText(address, cardName);
    const ok = await confirmDialog('Send address',
        `To <b>${escapeHtml(target.label)}</b> <code>${escapeHtml(target.peer)}</code>, this message:`
        + `<pre class="send-addr-preview">${escapeHtml(text)}</pre>`, 'Send');
    if (!ok || !(await confirmEphemeralSend())) return;
    let data;
    try {
        data = await fetch('/api/messenger/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ peer: target.peer, content: text }) }).then(r => r.json());
    } catch (e) {
        data = { status: 'error', error: e.message };
    }
    if (data.status !== 'success') {
        showNotification(`Not sent: ${escapeHtml(data.error || 'error')}`, 'error', 5000);
        return;
    }
    showNotification(`Address of <b>${escapeHtml(cardName || address.slice(0, 8) + '…')}</b> sent to `
        + `<b>${escapeHtml(target.label)}</b>`, 'success', 5000);
    pollMessenger();
}

// Resolves {peer, label} or null.
function pickRecipient(skip, cardName) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'auto-reload-modal';
        overlay.innerHTML = `<div class="auto-reload-dialog msg-warn-dialog send-addr-dialog">
            <div class="dialog-header"><h3>Send address of ${escapeHtml(cardName || skip.slice(0, 8) + '…')} to…</h3></div>
            <input class="settings-input send-addr-search" type="text" spellcheck="false"
                   placeholder="Search contacts and peers, or paste an LXMF address">
            <div class="send-addr-list"></div>
            <div class="auto-reload-actions"><button class="btn-cancel">Cancel</button></div></div>`;
        const input = overlay.querySelector('input');
        const list = overlay.querySelector('.send-addr-list');
        let seq = 0;
        const done = value => { overlay.remove(); document.removeEventListener('keydown', esc); resolve(value); };
        const esc = e => { if (e.key === 'Escape') done(null); };
        const row = (peer, name, note) => `<div class="msg-hit send-addr-row" data-peer="${escapeHtml(peer)}"
                data-label="${escapeHtml(peerLabel(peer, name))}">
            ${avatarHtml(peer, name, 'small', false)}
            <div class="msg-hit-main">
                <div class="msg-hit-top"><span class="msg-hit-name">${escapeHtml(peerLabel(peer, name))}</span></div>
                <div class="msg-hit-text"><code>${escapeHtml(peer)}</code>${note ? ` · ${escapeHtml(note)}` : ''}</div>
            </div></div>`;
        const draw = async () => {
            const mine = ++seq;
            const q = input.value.trim().toLowerCase();
            const words = q.split(/\s+/).filter(Boolean);
            const fits = (peer, name) => words.every(w => `${peer} ${peerLabel(peer, name)} ${name || ''}`.toLowerCase().includes(w));
            const seen = new Set([skip]);
            let html = '';
            if (/^[0-9a-f]{32}$/.test(q) && q !== skip) {
                html += '<div class="msg-search-head">Address</div>' + row(q, knownName(q), 'the address you pasted');
                seen.add(q);
            }
            const contacts = (Messenger.conversations || []).filter(c => !seen.has(c.peer) && fits(c.peer, c.name));
            contacts.forEach(c => seen.add(c.peer));
            html += `<div class="msg-search-head">Contacts <span>${contacts.length}</span></div>`
                + (contacts.length ? contacts.map(c => row(c.peer, c.name, '')).join('')
                                   : '<div class="msg-search-none">None</div>');
            list.innerHTML = html;
            if (words.length) {
                let d = null;
                try { d = await fetch(`/api/messenger/peers?q=${encodeURIComponent(q)}`).then(r => r.json()); } catch (e) {}
                if (mine !== seq || !d) return;
                const peers = [...((d.groups && d.groups.lxmf_only) || []), ...((d.groups && d.groups.with_nomad) || [])]
                    .filter(p => !seen.has(p.address));
                list.insertAdjacentHTML('beforeend', `<div class="msg-search-head">Heard announcing <span>${peers.length}</span></div>`
                    + (peers.length ? peers.map(p => row(p.address, p.name, p.node_name ? `NomadNet: ${p.node_name}` : '')).join('')
                                    : '<div class="msg-search-none">None</div>'));
            }
        };
        list.addEventListener('click', e => {
            const r = e.target.closest('.send-addr-row');
            if (r) done({ peer: r.dataset.peer, label: r.dataset.label });
        });
        input.addEventListener('input', draw);
        overlay.querySelector('.btn-cancel').onclick = () => done(null);
        overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
        document.addEventListener('keydown', esc);
        document.body.appendChild(overlay);
        draw();
        input.focus();
    });
}

// A choice of two ways (and Cancel): resolves 'a', 'b' or null.
function choiceDialog(title, html, labelA, labelB) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'auto-reload-modal';
        overlay.innerHTML = `<div class="auto-reload-dialog msg-warn-dialog">
            <div class="dialog-header"><h3>${escapeHtml(title)}</h3></div>
            <div class="settings-hint">${html}</div>
            <div class="auto-reload-actions">
                <button class="btn-cancel" data-c="">Cancel</button>
                <button class="btn-cancel" data-c="b">${escapeHtml(labelB)}</button>
                <button class="btn-save" data-c="a">${escapeHtml(labelA)}</button>
            </div></div>`;
        const done = c => { overlay.remove(); document.removeEventListener('keydown', esc); resolve(c || null); };
        const esc = e => { if (e.key === 'Escape') done(null); };
        overlay.querySelectorAll('[data-c]').forEach(b => { b.onclick = () => done(b.dataset.c); });
        overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
        document.addEventListener('keydown', esc);
        document.body.appendChild(overlay);
        overlay.querySelector('.btn-save').focus();
    });
}

// A card of another identity (Share contact list between identities): its
// conversation is that identity's. Read and answer it as that identity, or
// write to the same contact as the identity in use.
async function openSharedConversation(identityId, peer) {
    const c = Messenger.conversations.find(x => x.shared_id === identityId && x.peer === peer);
    const owner = c ? c.shared_from : identityId;
    const me = (Messenger.state && Messenger.state.identity_name) || 'the identity in use';
    const who = escapeHtml(peerLabel(peer, c && c.name));
    const unread = c && c.unread ? ` <b>${c.unread} unread</b>.` : '';
    const choice = await choiceDialog(`A conversation of ${owner}`,
        `The messages with <b>${who}</b> belong to <b>${escapeHtml(owner)}</b>.${unread}<br><br>`
        + `Switch to ${escapeHtml(owner)} to read them and reply as ${escapeHtml(owner)}, or write to ${who} as `
        + `<b>${escapeHtml(me)}</b> (a separate conversation). Every identity keeps listening either way.`,
        `Switch to ${owner}`, `Write as ${me}`);
    if (choice === 'a') {
        await switchMessengerIdentity(identityId, peer);
        showNotification(`Now writing as ${escapeHtml(owner)}`, 'success', 3000);
    } else if (choice === 'b') {
        Messenger.peer = peer;
        refreshMessenger(true);
    }
}

// ─── New message ────────────────────────────────────────────

// People to suggest: your conversations, then node operators whose LXMF
// announce gave a name. All of it already here; nothing is fetched.
function messengerContacts() {
    const seen = new Set();
    const out = [];
    for (const c of Messenger.conversations) {
        seen.add(c.peer);
        out.push({ peer: c.peer, name: c.name || '', from: 'Conversation' });
    }
    for (const n of (typeof cachedNodes !== 'undefined' ? cachedNodes : [])) {
        const peer = n.operator_lxmf_address;
        if (!peer || seen.has(peer)) continue;
        seen.add(peer);
        out.push({ peer, name: n.operator_name || '', from: `Operator of ${n.name || n.hash.slice(0, 8)}` });
    }
    // Heard announcing on LXMF only (no NomadNet node): the Peers panel's list.
    const announced = (Messenger.announced && Messenger.announced.groups) || {};
    for (const p of (announced.lxmf_only || [])) {
        if (seen.has(p.address)) continue;
        seen.add(p.address);
        out.push({ peer: p.address, name: p.name || '', from: 'LXMF announce' });
    }
    return out;
}

// Add contact: an address (and a name of your own) in the list, without
// writing to it. Unless switched off (Settings > LXMF Messenger), what the
// address is gets checked first - one path request if it was never heard -
// and anything that is not an LXMF address is added only if confirmed.
async function messengerAddContact(prefill = '') {
    const form = await new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'auto-reload-modal';
        overlay.innerHTML = `<div class="auto-reload-dialog msg-warn-dialog">
            <div class="dialog-header"><h3>Add contact</h3></div>
            <input class="settings-input msg-rename-input msg-contact-address" type="text" spellcheck="false"
                   placeholder="LXMF address (32 hex characters)" value="${escapeHtml(prefill)}">
            <input class="settings-input msg-rename-input msg-contact-nick" type="text" maxlength="48" spellcheck="false"
                   placeholder="Name (optional, shown instead of the announced one)">
            <div class="settings-hint msg-contact-note"></div>
            <div class="auto-reload-actions">
                <button class="btn-cancel">Cancel</button>
                <button class="btn-save">Add</button>
            </div></div>`;
        const addr = overlay.querySelector('.msg-contact-address');
        const nick = overlay.querySelector('.msg-contact-nick');
        const done = value => { overlay.remove(); resolve(value); };
        overlay.querySelector('.btn-cancel').onclick = () => done(null);
        overlay.querySelector('.btn-save').onclick = () => done({ address: addr.value, nickname: nick.value });
        overlay.addEventListener('keydown', e => {
            if (e.key === 'Enter') done({ address: addr.value, nickname: nick.value });
            if (e.key === 'Escape') done(null);
        });
        overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
        document.body.appendChild(overlay);
        (prefill ? nick : addr).focus();
    });
    if (!form) return;
    await addContactChecked(form.address, form.nickname || '');
}

// Add an address to the conversations, checked first unless switched off
// (Check new contacts). Used by + Contact, the chat's "Add to contacts" and
// the contact menus.
async function addContactChecked(rawAddress, nickname = '') {
    const address = (String(rawAddress).toLowerCase().match(/[0-9a-f]{32}/) || [''])[0];
    if (!address) {
        showNotification('Not an LXMF address: 32 hex characters', 'error', 5000);
        return;
    }
    const settings = (Messenger.state && Messenger.state.settings) || {};
    if (settings.check_new_contacts !== false) {
        const waiting = showNotification(`Checking what ${address.slice(0, 8)}… is…`, 'info', 60000);
        let kind = { known: false };
        try {
            kind = await fetch(`/api/hash-kind/${address}`, { method: 'POST' }).then(r => r.json());
        } catch (e) {} finally {
            if (waiting && waiting.parentNode) waiting.parentNode.removeChild(waiting);
        }
        let doubt = '';
        if (kind.known && kind.aspect !== 'lxmf.delivery') {
            doubt = `This address is <b>${escapeHtml(kind.label)}</b>${kind.name ? ` (${escapeHtml(kind.name)})` : ''}, not an LXMF address: messages to it would be refused.`;
        } else if (!kind.known) {
            doubt = 'Nobody answered on this address: it may be offline, or not exist. Messages may not arrive.';
        }
        if (doubt && !(await confirmDialog('Add anyway?', doubt, 'Add anyway'))) return;
    }
    const d = await fetch(`/api/messenger/contact/${address}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nickname || '' })
    }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
    if (d.status !== 'success') {
        showNotification(escapeHtml(d.error || 'Not added'), 'error', 5000);
        return;
    }
    showNotification(d.existed ? 'Already in your conversations' : 'Contact added', 'success', 3000);
    await pollMessenger();
    await refreshMessenger(false);
}

function messengerNewMessage(prefill) {
    // The peers heard announcing, for the suggestions (the panel may be closed).
    fetch('/api/messenger/peers').then(r => r.json()).then(d => { Messenger.announced = d; }).catch(() => {});
    const overlay = document.createElement('div');
    overlay.className = 'auto-reload-modal';
    overlay.innerHTML = `<div class="auto-reload-dialog msg-new-dialog">
        <div class="dialog-header"><h3>New message</h3>
            <button class="modal-close" aria-label="Close">&times;</button></div>
        <div class="settings-hint">An LXMF address (32 hex characters), or a name heard on the network.</div>
        <input class="cache-search-input msg-new-input" type="text" spellcheck="false" autocomplete="off"
               placeholder="Address or name">
        <div class="msg-new-results"></div>
        </div>`;
    const input = overlay.querySelector('.msg-new-input');
    const results = overlay.querySelector('.msg-new-results');
    const close = () => overlay.remove();
    const contacts = messengerContacts();
    const pick = peer => { close(); openMessenger(peer); };
    const render = () => {
        const q = input.value.trim().toLowerCase().replace(/[<>:]/g, '');
        const rows = [];
        if (/^[0-9a-f]{32}$/.test(q)) rows.push({ peer: q, name: '', from: 'This address' });
        for (const c of contacts) {
            if (rows.length >= 30) break;
            if (!q || c.peer.includes(q) || c.name.toLowerCase().includes(q)) {
                if (!rows.some(r => r.peer === c.peer)) rows.push(c);
            }
        }
        results.innerHTML = rows.map(r => `<div class="msg-new-row" data-peer="${escapeHtml(r.peer)}">
            <span class="msg-new-name">${escapeHtml(r.name || peerLabel(r.peer, ''))}</span>
            <span class="msg-new-from">${escapeHtml(r.from)}</span>
            <code>${escapeHtml(r.peer)}</code></div>`).join('')
            || '<div class="msg-empty">Nothing matches. Paste a full LXMF address.</div>';
        results.querySelectorAll('.msg-new-row').forEach(row => row.onclick = () => pick(row.dataset.peer));
    };
    input.addEventListener('input', render);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            const first = results.querySelector('.msg-new-row');
            if (first) pick(first.dataset.peer);
        } else if (e.key === 'Escape') close();
    });
    overlay.querySelector('.modal-close').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    input.value = prefill || '';
    render();
    input.focus();
}

document.addEventListener('DOMContentLoaded', startMessengerPolling);
if (document.readyState !== 'loading') startMessengerPolling();
