// The RRC client. Server side in
// rbrowser/rrc.py, which holds the truth: the hubs open, their rooms (the
// windows), the people, the lines. This page only shows it and sends what is
// typed. The windows of a hub are its rooms as the server lists them, plus
// the hub window ("" = notices, MOTD, errors).

const Rrc = {
    state: null,            // GET /api/rrc
    hubList: null,          // GET /api/rrc/hubs
    hubsAt: 0,
    data: {},               // {address: {hub, seq, rev}} from /api/rrc/output
    panes: {},              // {"address|room": {el, last}}
    open: false,
    active: null,           // {hub, room}
    inputs: {},             // what was being typed, per window
    drafts: {},             // its own colours, per window (rrcDraftSync)
    draft: { text: '', st: [] },
    history: [],
    historyAt: -1,
    backStack: [],          // windows seen, for going back when one closes
    filter: '',
    users: (() => { try { return localStorage.getItem('rrc-users') !== '0'; } catch (e) { return true; } })(),
    usersPhone: (() => { try { return localStorage.getItem('rrc-users-phone') === '1'; } catch (e) { return false; } })(),
    dragging: false,
    cmdAt: 0,
    // Hub list sections folded: {connected, favorite, heard}, this page only;
    // Favourites closed at every start: opened by hand.
    collapsed: { favorite: true },
    states: {},             // {address: hub state at the last poll}: a change rings
    pollTimer: null,
    busy: false,
};

const RRC_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5h12v7.5H8l-3.5 2.5V11H2z"/><path d="M6.3 5.2l-.6 4.3M9.2 5.2l-.6 4.3M4.8 6.4h5.6M4.5 8.3h5.6"/></svg>';
const RRC_MSG_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M2.5 3h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H7l-3.5 2.8V11.5h-1a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="currentColor"/></svg>';
const RRC_USER_ICON ='<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="8" cy="5" r="3" fill="currentColor"/><path d="M2.5 14.5c.5-3.2 2.7-5 5.5-5s5 1.8 5.5 5z" fill="currentColor"/></svg>';
const RRC_COLORS = ['#ff7b72', '#ffa657', '#d29922', '#7ee787', '#3fb950', '#56d4dd', '#79c0ff',
                    '#a5d6ff', '#d2a8ff', '#bc8cff', '#f778ba', '#ffab70', '#e3b341', '#8ddb8c'];
const RRC_SIGN = { o: '@', v: '+' };

function rrcEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function rrcEnabled() {
    return !!(Rrc.state && Rrc.state.settings && Rrc.state.settings.enabled);
}

function rrcKey(hub, room) { return `${hub}|${room || ''}`; }

function rrcPost(url, body) {
    return fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
}

// The signs before hub notices, errors, joins and parts: small line icons,
// the same in every font (the old ℹ came out as an italic "i").
const RRC_SIGN_PATHS = {
    info: '<circle cx="8" cy="8" r="6.2"/><path d="M8 7.3v4M8 4.9h.01"/>',
    error: '<path d="M8 1.8l6.4 11.4H1.6z"/><path d="M8 6.4v3.2M8 11.4h.01"/>',
    join: '<path d="M6 3H3.5v10H6"/><path d="M7 8h7M11 5l3 3-3 3"/>',
    part: '<path d="M10 3h2.5v10H10"/><path d="M9 8H2M5 5L2 8l3 3"/>',
    fold: '<path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/>',
    system: '<circle cx="8" cy="8" r="1.6"/>',
};
function rrcSign(name) {
    return `<svg class="rrc-sign-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
        stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${RRC_SIGN_PATHS[name]}</svg>`;
}

function rrcColor(id) {
    let h = 0;
    for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return RRC_COLORS[h % RRC_COLORS.length];
}

function rrcHub(address) { return Rrc.data[address] ? Rrc.data[address].hub : null; }

function rrcRoomOf(address, room) {
    const hub = rrcHub(address);
    return hub ? hub.rooms.find(r => r.name === (room || '')) || null : null;
}

function rrcSetting(key, def) {
    const s = Rrc.state && Rrc.state.settings;
    return s && key in s ? s[key] : def;
}

// ─── The tab and the view ───────────────────────────────────

function ensureRrcTab() {
    let tab = document.getElementById('rrc-tab');
    if (!tab) {
        tab = document.createElement('div');
        tab.className = 'tab tab-messages tab-rrc';
        tab.id = 'rrc-tab';
        tab.title = 'RRC Chat';
        tab.innerHTML = `${RRC_ICON}<span class="tab-app-label">RRC</span><span class="tab-messages-badge" hidden></span>`;
        tab.addEventListener('click', () => { Rrc.toNews = true; openAppTab('rrc'); Rrc.toNews = false; });
        addAppTabOff(tab, 'RRC chat', async () => {
            const res = await rrcPost('/api/rrc/settings', { enabled: false });
            if (res && res.status === 'error') throw new Error(res.error);
            pollRrc();
        }, {
            close: () => closeRrc(),
            disconnect: async () => {
                await Promise.all(((Rrc.state && Rrc.state.hubs) || []).map(h => rrcPost(`/api/rrc/disconnect/${h.address}`)));
                pollRrc();
            },
            disconnectTip: 'every hub is disconnected, the client stays open',
        });
        placeAppTab(tab);
    }
    if (document.getElementById('rrc-view')) return;
    const view = document.createElement('div');
    view.className = 'tab-content rrc-view';
    view.id = 'rrc-view';
    view.innerHTML = `
        <div class="bbs-side rrc-side">
            <div class="bbs-side-head">
                <button class="nav-btn sidebar-toggle-btn" onclick="toggleSidebar()" title="Hide the node list">&laquo;</button>${appMainButton()}
                <span class="bbs-title rrc-title">${RRC_ICON}<span>RRC Chat</span></span>
                ${clientListButton('rrc')}
                <button class="msg-bar-btn msg-settings-btn" onclick="showSettings('rrc')" title="RRC settings" aria-label="RRC settings">${typeof GEAR_ICON !== 'undefined' ? GEAR_ICON : '⚙'}</button>
                <button class="msg-close" onclick="closeRrc()" title="Close RRC" aria-label="Close">&times;</button>
            </div>
            <div class="bbs-connect">
                <input aria-label="Hub address" type="text" id="rrc-address" class="msg-search" placeholder="Hub address (32 hex)" spellcheck="false" autocomplete="off">
                <button class="msg-bar-btn primary" id="rrc-address-go">Connect</button>
            </div>
            <input aria-label="Search hubs" type="text" id="rrc-filter" class="msg-search bbs-filter" placeholder="Search hubs" spellcheck="false" autocomplete="off">
            <div class="bbs-servers" id="rrc-hubs"><div class="msg-search-none">Listening for hubs…</div></div>
        </div>
        <div class="bbs-main rrc-main">
            <div class="msg-tabs rrc-tabs" id="rrc-tabs" hidden></div>
            <div class="bbs-head rrc-head" id="rrc-head" hidden></div>
            <div class="rrc-body">
                <div class="rrc-screens" id="rrc-screens">
                    <div class="msg-empty rrc-empty">${typeof clientWelcome === 'function' ? clientWelcome(RRC_ICON, 'RRC Client') : ''}Pick a hub on the left, or paste its address.<br>
                        Once connected: <b>/join general</b>, <b>/list</b> for the public rooms, <b>/help</b> for the commands.</div>
                </div>
                <div class="rrc-users-grip" id="rrc-users-grip" hidden title="Drag to resize" role="separator" aria-orientation="vertical"></div>
                <div class="rrc-users" id="rrc-users" hidden></div>
            </div>
            <div class="bbs-input-row rrc-input-row" id="rrc-input-row" hidden>
                <div class="rrc-cmds" id="rrc-cmds" hidden role="listbox"></div>
                <div class="rrc-emojis" id="rrc-emojis" hidden></div>
                <div class="rrc-stk-suggest" id="rrc-stk-suggest" hidden></div>
                <div class="rrc-stk-suggest rrc-stk-pending" id="rrc-stk-pending" hidden></div>
                <div class="rrc-stk-panel" id="rrc-stk-panel" hidden></div>
                <div class="rrc-style" id="rrc-style" hidden></div>
                <div class="rrc-sel" id="rrc-sel" hidden>
                    <button class="rrc-style-tog" data-rrc-tog="B" style="font-weight:700" title="Bold" tabindex="-1">B</button>
                    <button class="rrc-style-tog" data-rrc-tog="I" style="font-style:italic" title="Italic" tabindex="-1">I</button>
                    <button class="rrc-style-tog" data-rrc-tog="U" style="text-decoration:underline" title="Underline" tabindex="-1">U</button>
                    <button class="rrc-style-tog" data-rrc-sel-palette="1" title="Colours for the selection" tabindex="-1">🎨</button>
                    <button class="rrc-style-tog" data-rrc-reset="1" title="The selection plain again" tabindex="-1">⌀</button>
                </div>
                <div class="rrc-mirror" id="rrc-mirror" aria-hidden="true"></div>
                <span class="rrc-prompt" id="rrc-prompt"></span>
                <button class="rrc-emoji-btn rrc-cmds-btn" id="rrc-cmds-btn" title="Commands (or type /)" aria-label="Commands">/</button>
                <button class="rrc-emoji-btn rrc-style-btn" id="rrc-style-btn" title="Colours and styles: they stay on until Reset (only rBrowser shows them)" aria-label="Colours and styles">🎨</button>
                <textarea aria-label="Message" id="rrc-input" class="bbs-input rrc-input-area" rows="1" spellcheck="false" autocomplete="off"
                       placeholder="Message - Shift+Enter new line, /help for the commands, Tab completes a nick, ↑↓ earlier lines"></textarea>
                <button class="rrc-emoji-btn" id="rrc-emoji-btn" title="Emoji" aria-label="Emoji">😀</button>
                <button class="rrc-emoji-btn rrc-stk-btn" id="rrc-stk-btn" title="Stickers" aria-label="Stickers" hidden>${rrcStkIcon()}</button>
                <button class="msg-send" id="rrc-send" title="Send (Enter)" aria-label="Send"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 8l11-5.5L9.5 14 7.5 9z" fill="currentColor"/></svg></button>
            </div>
        </div>`;
    document.getElementById('tab-content-wrapper').appendChild(view);
    bindRrcView(view);
    // A narrow chat column (a small window, the browser's tools open): the
    // head's buttons as icons, as on a phone.
    const main = view.querySelector('.rrc-main');
    new ResizeObserver(() => {
        const w = main.clientWidth;
        if (w) main.classList.toggle('rrc-tight', w < 540);
    }).observe(main);
    watchRrcNodeList();
    applySidebarState(document.body.classList.contains('sidebar-collapsed'));
    applyClientList('rrc');
}

function bindRrcView(view) {
    const go = () => {
        const box = view.querySelector('#rrc-address');
        const parsed = rrcParseAddress(box.value);
        if (!parsed) { showNotification('An RRC hub address is 32 hex characters', 'error', 4000); return; }
        box.value = '';
        rrcConnect(parsed.hub, parsed.room);
    };
    view.querySelector('#rrc-address-go').addEventListener('click', go);
    view.querySelector('#rrc-address').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    view.querySelector('#rrc-filter').addEventListener('input', e => { Rrc.filter = e.target.value; renderRrcHubs(); });

    // The hub list: fold a section, star, forget, connect.
    view.querySelector('#rrc-hubs').addEventListener('click', e => {
        const head = e.target.closest('[data-rrc-section]');
        if (head) {
            const k = head.dataset.rrcSection;
            Rrc.collapsed[k] = !Rrc.collapsed[k];
            e.currentTarget.dataset.html = '';
            renderRrcHubs();
            return;
        }
        const star = e.target.closest('[data-rrc-star]');
        if (star) { e.stopPropagation(); rrcFavorite(star.dataset.rrcStar, star.dataset.on !== '1'); return; }
        const auto = e.target.closest('[data-rrc-auto]');
        if (auto) { e.stopPropagation(); rrcAutoconnect(auto.dataset.rrcAuto, auto.dataset.on !== '1'); return; }
        const forget = e.target.closest('[data-rrc-forget]');
        if (forget) {
            e.stopPropagation();
            rrcPost(`/api/rrc/forget/${forget.dataset.rrcForget}`).then(() => { Rrc.hubsAt = 0; pollRrc(); });
            return;
        }
        const win = e.target.closest('[data-rrc-win]');
        if (win) { showRrcRoom(win.dataset.hub, win.dataset.rrcWin); return; }
        const row = e.target.closest('[data-rrc-hub]');
        if (!row) return;
        const address = row.dataset.rrcHub;
        if (rrcHub(address)) showRrcRoom(address, '');
        else rrcConnect(address);
    });

    // Tabs: show, close.
    view.querySelector('#rrc-tabs').addEventListener('click', e => {
        const close = e.target.closest('[data-rrc-close]');
        if (close) { e.stopPropagation(); rrcCloseWindow(close.dataset.hub, close.dataset.rrcClose); return; }
        const tab = e.target.closest('[data-rrc-tab]');
        if (tab) showRrcRoom(tab.dataset.hub, tab.dataset.rrcTab);
    });
    // Right-click on a tab or a window in the tree: its menu.
    const winMenu = (e, sel, key) => {
        const t = e.target.closest(sel);
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        const room = t.dataset[key];
        if (room) rrcRoomMenu(t, t.dataset.hub, room);
        else rrcHubMenu(t, t.dataset.hub);
    };
    view.querySelector('#rrc-tabs').addEventListener('contextmenu', e => winMenu(e, '[data-rrc-tab]', 'rrcTab'));
    // Room tabs move by dragging them left or right; the hub's tab
    // stays first, a room moves only among its own hub's rooms.
    const strip = view.querySelector('#rrc-tabs');
    strip.addEventListener('dragstart', e => {
        const tab = e.target.closest('[data-rrc-tab]');
        if (!tab || !tab.dataset.rrcTab) { e.preventDefault(); return; }
        Rrc.draggingTab = { hub: tab.dataset.hub, room: tab.dataset.rrcTab };
        tab.classList.add('rrc-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', tab.dataset.rrcTab); } catch (err) { /* old browsers */ }
    });
    const target = e => {
        const d = Rrc.draggingTab;
        const tab = d && e.target.closest('[data-rrc-tab]');
        if (!tab || tab.dataset.hub !== d.hub || !tab.dataset.rrcTab) return null;
        const box = tab.getBoundingClientRect();
        return { tab, after: e.clientX > box.left + box.width / 2 };
    };
    strip.addEventListener('dragover', e => {
        const t = target(e);
        strip.querySelectorAll('.rrc-drop-before, .rrc-drop-after').forEach(x => x.classList.remove('rrc-drop-before', 'rrc-drop-after'));
        if (!t) return;
        e.preventDefault();
        t.tab.classList.add(t.after ? 'rrc-drop-after' : 'rrc-drop-before');
    });
    strip.addEventListener('drop', e => {
        const t = target(e);
        const d = Rrc.draggingTab;
        if (!t || !d) return;
        e.preventDefault();
        let before = t.tab.dataset.rrcTab;
        if (t.after) {
            const next = t.tab.nextElementSibling;
            before = next && next.dataset.hub === d.hub ? next.dataset.rrcTab : '';
        }
        if (before !== d.room) { Rrc.draggingTab = null; rrcMoveTab(d.hub, d.room, before); }
    });
    strip.addEventListener('dragend', () => {
        Rrc.draggingTab = null;
        strip.querySelectorAll('.rrc-dragging, .rrc-drop-before, .rrc-drop-after')
            .forEach(x => x.classList.remove('rrc-dragging', 'rrc-drop-before', 'rrc-drop-after'));
        renderRrcTabs();
    });
    view.querySelector('#rrc-hubs').addEventListener('contextmenu', e => winMenu(e, '[data-rrc-win]', 'rrcWin'));
    view.querySelector('#rrc-tabs').addEventListener('auxclick', e => {
        const tab = e.target.closest('[data-rrc-tab]');
        if (tab && e.button === 1) rrcCloseWindow(tab.dataset.hub, tab.dataset.rrcTab);
    });

    // The head's buttons.
    view.querySelector('#rrc-head').addEventListener('click', e => {
        const b = e.target.closest('[data-rrc-act]');
        if (!b || !Rrc.active) return;
        const { hub, room } = Rrc.active;
        const act = b.dataset.rrcAct;
        if (act === 'back') showRrcRoom(null);
        else if (act === 'connect') rrcConnect(hub);
        else if (act === 'disconnect') rrcPost(`/api/rrc/disconnect/${hub}`).then(pollRrc);
        else if (act === 'list') rrcShowRooms(hub);
        else if (act === 'who') rrcShowWho(hub, room);
        else if (act === 'users') {
            // A phone keeps its own choice (closed at first: the list covers the chat).
            const k = rrcNarrow() ? 'rrc-users-phone' : 'rrc-users';
            if (rrcNarrow()) Rrc.usersPhone = !Rrc.usersPhone; else Rrc.users = !Rrc.users;
            try { localStorage.setItem(k, (rrcNarrow() ? Rrc.usersPhone : Rrc.users) ? '1' : '0'); } catch (err) { /* only now */ }
            renderRrcUsers(); renderRrcHead();
        } else if (act === 'nick') rrcNickDialog(hub);
        else if (act === 'menu') { e.stopPropagation(); if (room) rrcRoomMenu(b, hub, room); else rrcHubMenu(b, hub); }
        else if (act === 'settings') showSettings('rrc');
        else if (act === 'close') rrcCloseWindow(hub, room);
        else if (act === 'copy') copyText(hub, 'Hub address copied');
        else if (act === 'copyme') copyText(rrcHub(hub).me, 'Your identity hash copied');
    });

    // People: a click (or right-click) opens their menu.
    const userMenu = e => {
        const u = e.target.closest('[data-rrc-user]');
        if (!u) return;
        e.preventDefault();
        e.stopPropagation();
        rrcUserMenu(u, u.dataset.rrcUser, u.dataset.nick);
    };
    view.querySelector('#rrc-users').addEventListener('click', userMenu);
    view.querySelector('#rrc-users').addEventListener('contextmenu', userMenu);
    const lineClick = e => {
        const link = e.target.closest('.rrc-link');
        if (link && e.type === 'click') { rrcOpenLink(link); return; }
        // Right-click on a link: its menu, as on a page link.
        if (link && e.type === 'contextmenu' && rrcLinkTarget(link)) {
            e.preventDefault();
            showClientLinkMenu(link, rrcLinkTarget(link));
            return;
        }
        const n = e.target.closest('[data-rrc-nick]');
        if (!n || !n.dataset.src) {
            // Right-click in the window (not on a nick, a link or selected
            // text): the menu of the room, or of the hub in its own window.
            if (e.type !== 'contextmenu' || link || !Rrc.active || String(window.getSelection() || '')) return;
            e.preventDefault();
            const at = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 }) };
            // On a message in a room: Reply / Copy first, the room's menu after.
            const said = e.target.closest('[data-reply-text]');
            if (said && Rrc.active.room) { rrcLineMenu(said, at); return; }
            if (Rrc.active.room) rrcRoomMenu(at, Rrc.active.hub, Rrc.active.room);
            else rrcHubMenu(at, Rrc.active.hub);
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        rrcUserMenu(n, n.dataset.src, n.dataset.rrcNick);
    };
    view.querySelector('#rrc-screens').addEventListener('click', lineClick);
    view.querySelector('#rrc-screens').addEventListener('contextmenu', lineClick);

    // Phones: a long press on a message opens the same Reply / Copy menu
    // (without it the press selected text, and iOS sends no contextmenu
    // at all).
    const screens = view.querySelector('#rrc-screens');
    let press = null, pressedAt = 0;
    const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
    screens.addEventListener('touchstart', e => {
        cancelPress();
        const said = e.touches.length === 1 && e.target.closest('[data-reply-text]');
        if (!said || e.target.closest('.rrc-link, [data-rrc-nick]') || !Rrc.active || !Rrc.active.room) return;
        const t = e.touches[0];
        press = { x: t.clientX, y: t.clientY, timer: setTimeout(() => {
            press = null;
            pressedAt = Date.now();
            const sel = window.getSelection && window.getSelection();
            if (sel) sel.removeAllRanges();
            rrcLineMenu(said, { getBoundingClientRect: () => ({ left: t.clientX, right: t.clientX, top: t.clientY, bottom: t.clientY, width: 0, height: 0 }) });
        }, 500) };
    }, { passive: true });
    screens.addEventListener('touchmove', e => {
        const t = e.touches[0];
        if (press && (Math.abs(t.clientX - press.x) > 10 || Math.abs(t.clientY - press.y) > 10)) cancelPress();
    }, { passive: true });
    screens.addEventListener('touchend', cancelPress, { passive: true });
    screens.addEventListener('touchcancel', cancelPress, { passive: true });
    // The contextmenu and click that follow the long press: not again.
    screens.addEventListener('contextmenu', e => {
        if (Date.now() - pressedAt < 1500) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    screens.addEventListener('click', e => {
        if (Date.now() - pressedAt < 1500) { e.preventDefault(); e.stopImmediatePropagation(); pressedAt = 0; }
    }, true);

    const input = view.querySelector('#rrc-input');
    view.querySelector('#rrc-send').addEventListener('click', rrcSend);
    const cmds = view.querySelector('#rrc-cmds');
    cmds.addEventListener('mousedown', e => {
        const person = e.target.closest('[data-rrc-at]');
        if (person) { e.preventDefault(); rrcPickMention(person.dataset.rrcAt); return; }
        const item = e.target.closest('[data-rrc-cmd]');
        if (!item) return;
        e.preventDefault();                 // the input keeps the focus
        rrcPickCommand(item.dataset.rrcCmd, true);
    });
    view.querySelector('#rrc-cmds-btn').addEventListener('mousedown', e => {
        e.preventDefault();
        if (cmds.hidden) renderRrcCommands(true);
        else cmds.hidden = true;
        input.focus();
    });
    bindRrcEmojis(view, input);
    bindRrcStickers(view, input);
    bindRrcStyle(view, input);
    document.addEventListener('mousedown', e => {
        if (!cmds.hidden && !e.target.closest('#rrc-cmds, #rrc-cmds-btn, #rrc-input')) cmds.hidden = true;
    });
    input.addEventListener('keydown', e => {
        // Shift+Enter: a new line in the message; the field grows.
        // Touch keyboards have no Shift+Enter: there Enter is the new line
        // and the green arrow sends, as in the phone chat apps.
        if (e.key === 'Enter' && (e.shiftKey || (cmds.hidden && window.matchMedia('(pointer: coarse)').matches))) {
            cmds.hidden = true;
            requestAnimationFrame(() => rrcGrow(input));
            return;
        }
        // Tab on an empty line (or a / being typed) opens the commands.
        if (cmds.hidden && e.key === 'Tab' && !e.shiftKey && (!input.value || /^\/\w*$/.test(input.value))) {
            e.preventDefault();
            if (!input.value) input.value = '/';
            renderRrcCommands();
            return;
        }
        // The command list, while open, takes the arrows, Tab, Enter, Esc.
        if (!cmds.hidden) {
            const items = [...cmds.querySelectorAll('[data-rrc-cmd], [data-rrc-at]')];
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                Rrc.cmdAt = (Rrc.cmdAt + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                items.forEach((el, i) => el.classList.toggle('active', i === Rrc.cmdAt));
                items[Rrc.cmdAt].scrollIntoView({ block: 'nearest' });
                return;
            }
            if ((e.key === 'Tab' || e.key === 'Enter') && items[Rrc.cmdAt] && items[Rrc.cmdAt].dataset.rrcAt) {
                e.preventDefault();
                rrcPickMention(items[Rrc.cmdAt].dataset.rrcAt);
                return;
            }
            if ((e.key === 'Tab' || e.key === 'Enter') && items[Rrc.cmdAt]) {
                const chosen = items[Rrc.cmdAt].dataset.rrcCmd;
                // Enter on a command typed in full sends it.
                if (!(e.key === 'Enter' && input.value.trim().toLowerCase() === `/${chosen}`)) {
                    e.preventDefault();
                    rrcPickCommand(chosen);
                    return;
                }
            }
            if (e.key === 'Escape') { e.preventDefault(); cmds.hidden = true; return; }
        }
        if (e.key === 'Enter') { e.preventDefault(); cmds.hidden = true; rrcSend(); }
        else if (e.key === 'Tab') { e.preventDefault(); rrcComplete(input); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            // Several lines: the arrows move between them, except up from the
            // first line or down from the last.
            const at = input.selectionStart;
            if (e.key === 'ArrowUp' ? input.value.lastIndexOf('\n', at - 1) >= 0 : input.value.indexOf('\n', at) >= 0) return;
            if (!Rrc.history.length) return;
            e.preventDefault();
            Rrc.historyAt = e.key === 'ArrowUp'
                ? Math.min(Rrc.history.length - 1, Rrc.historyAt + 1) : Math.max(-1, Rrc.historyAt - 1);
            input.value = Rrc.historyAt < 0 ? '' : Rrc.history[Rrc.historyAt];
            rrcDraftReset(input.value);
            rrcGrow(input);
        }
    });
    input.addEventListener('input', () => {
        rrcGrow(input);
        if (Rrc.active) Rrc.inputs[rrcKey(Rrc.active.hub, Rrc.active.room)] = input.value;
        renderRrcCommands();
    });

    // The people list: as wide as dragged, remembered in this browser.
    const grip = view.querySelector('#rrc-users-grip');
    const box = view.querySelector('#rrc-users');
    grip.addEventListener('pointerdown', e => {
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        Rrc.dragging = true;
        const right = box.getBoundingClientRect().right;
        const width = ev => Math.min(420, Math.max(120, right - ev.clientX));
        const move = ev => { box.style.width = `${width(ev)}px`; };
        const up = ev => {
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', up);
            try { localStorage.setItem('rrc-users-w', String(Math.round(width(ev)))); } catch (err) { /* only now */ }
            Rrc.dragging = false;
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
    });
}

// The message field as tall as its lines, up to six; then it scrolls.
// Lines are the Shift+Enter ones and the long text wrapping by itself.
// Measured once laid out: a draft put back while the view is still hidden
// measured 0 and the field stayed one line, the text out of sight.
function rrcGrow(input, retry = true) {
    if (!input) return;
    if (!input.clientHeight) {
        if (retry) requestAnimationFrame(() => rrcGrow(input, false));
        return;
    }
    input.style.height = '';                    // back to one line, then measure
    const tall = input.value.includes('\n') || input.scrollHeight > input.clientHeight + 2;
    input.classList.toggle('tall', tall);
    if (tall) input.style.height = `${Math.min(input.scrollHeight + 2, 6 * 20 + 18)}px`;
    rrcMirror(input);
}
window.addEventListener('resize', () => rrcGrow(document.getElementById('rrc-input'), false));

document.addEventListener('keydown', e => {
    if (!Rrc.open || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.getElementById('settings-modal')) return;
    const input = document.getElementById('rrc-input');
    if (input && !input.closest('[hidden]')) input.focus();
});

// Settings > RRC Client > Auto-close the NomadNet list: in a window under
// 1200 px (a phone has a layout of its own) opening RRC, or the window
// getting that narrow while RRC is open, closes the node list once; the
// button opens it again. Closed this way, it is back when you leave RRC.
const RRC_NODES_AUTOCLOSE_WIDTH = 1200;

function rrcSmallScreen() {
    return window.innerWidth < RRC_NODES_AUTOCLOSE_WIDTH && !window.matchMedia('(max-width: 767px), (pointer: coarse) and (max-height: 500px)').matches;
}

function rrcAutoCloseNodes() {
    if (!Rrc.open || APP_WINDOW || rrcSetting('autoclose_nodes', true) === false || !rrcSmallScreen()) return;
    if (document.body.classList.contains('sidebar-collapsed')) return;
    applySidebarState(true);
    Rrc.closedNodes = true;
}

function watchRrcNodeList() {
    let wasSmall = rrcSmallScreen();
    window.addEventListener('resize', () => {
        const small = rrcSmallScreen();
        if (small && !wasSmall) rrcAutoCloseNodes();
        wasSmall = small;
    });
    new MutationObserver(() => {
        if (!Rrc.closedNodes) return;
        const collapsed = document.body.classList.contains('sidebar-collapsed');
        // Opened again by hand: yours from now on.
        if (!collapsed) Rrc.closedNodes = false;
        else if (!document.body.classList.contains('rrc-open')) {
            Rrc.closedNodes = false;
            applySidebarState(false);
        }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

function openRrc() {
    if (!rrcEnabled()) {
        showNotification('The RRC client is off: Settings > RRC Client', 'info', 5000);
        return;
    }
    ensureRrcTab();
    if (typeof Messenger !== 'undefined') Messenger.open = false;
    document.body.classList.remove('messenger-open');
    if (typeof RetiBBS !== 'undefined') RetiBBS.open = false;
    document.body.classList.remove('retibbs-open');
    if (typeof Rmap !== 'undefined') Rmap.open = false;
    document.body.classList.remove('rmap-open');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('rrc-tab').classList.add('active');
    document.getElementById('rrc-view').classList.add('active');
    document.body.classList.add('rrc-open');
    Rrc.open = true;
    Rrc.hubsAt = 0;
    // Nothing on screen yet (a page reload): the first connected hub's tab
    // opens by itself, as soon as there is one (see pollRrc).
    Rrc.autoPick = !Rrc.active;
    rrcAutoCloseNodes();
    pollRrc();
    // News waiting (the badge on the RRC tab): each click takes you to the
    // next window that has some, mentions first.
    const next = Rrc.toNews ? rrcNextNews() : null;
    if (next) showRrcRoom(next.hub, next.room);
    else if (Rrc.active) showRrcRoom(Rrc.active.hub, Rrc.active.room);
    requestAnimationFrame(rrcToBottom);
}

function rrcNextNews() {
    const here = Rrc.active ? rrcKey(Rrc.active.hub, Rrc.active.room) : '';
    const wins = rrcWindows().filter(w => rrcKey(w.hub, w.room) !== here && w.room);
    return wins.find(w => w.r.mentions) || wins.find(w => w.r.unread) || wins.find(w => w.r.joins) || null;
}

function closeRrc() {
    if (appWindowClose()) return;
    Rrc.open = false;
    document.body.classList.remove('rrc-open');
    const view = document.getElementById('rrc-view');
    if (view) view.classList.remove('active');
    const tab = document.getElementById('rrc-tab');
    if (tab) tab.classList.remove('active');
    if (typeof activeTabId !== 'undefined' && activeTabId) switchToTab(activeTabId);
}

// Settings > RRC Client: the times in the room windows (the hub tab keeps
// them in full). Classes on #rrc-screens, style.css does the rest.
function rrcApplyTimes() {
    const box = document.getElementById('rrc-screens');
    if (!box) return;
    box.classList.toggle('rrc-ts-off-desktop', rrcSetting('room_ts_desktop', true) === false);
    box.classList.toggle('rrc-ts-off-mobile', rrcSetting('room_ts_mobile', true) === false);
    box.classList.toggle('rrc-ts-short', rrcSetting('room_ts_short', false) === true);
}

function applyRrcVisibility() {
    const on = rrcEnabled();
    if (on) ensureRrcTab();
    rrcApplyTimes();
    const tab = document.getElementById('rrc-tab');
    if (tab) tab.hidden = !on;
    layoutAppTabs();
    if (!on && Rrc.open) closeRrc();
    const badge = tab && tab.querySelector('.tab-messages-badge');
    if (badge) {
        const hubs = (Rrc.state && Rrc.state.hubs) || [];
        const mentions = hubs.reduce((n, h) => n + (h.mentions || 0), 0);
        // Only the rooms' new messages: the hub tab keeps its own count.
        const unread = hubs.reduce((n, h) => n + (h.room_unread ?? h.unread ?? 0), 0);
        // Only joins: a green +N, so a join sound has something to point at.
        const joins = hubs.reduce((n, h) => n + (h.room_joins || 0), 0);
        badge.hidden = !(mentions || unread || joins);
        badge.textContent = mentions ? `@${mentions}` : unread ? String(unread) : `+${joins}`;
        badge.title = mentions || unread ? '' : `${joins} joined your rooms`;
        badge.classList.toggle('rrc-badge-quiet', !mentions && !!unread);
        badge.classList.toggle('rrc-badge-join', !mentions && !unread && !!joins);
    }
    // The dot: connected to at least one hub (green), connecting (yellow),
    // failed and trying again (red), not connected anywhere (grey).
    if (tab && on) {
        const hubs = (Rrc.state && Rrc.state.hubs) || [];
        const count = s => hubs.filter(h => h.state === s).length;
        const [ok, trying, failed] = [count('connected'), count('connecting'), count('failed')];
        setAppTabState(tab, ok ? 'connected' : trying ? 'connecting' : failed ? 'failed' : '',
            ok ? `RRC: connected to ${ok} hub${ok === 1 ? '' : 's'}${trying ? `, ${trying} connecting` : ''}`
                : trying ? 'RRC: connecting…' : failed ? 'RRC: connection failed, trying again' : 'RRC: not connected');
    }
}

// ─── Polling ────────────────────────────────────────────────

// The size of the chat text (Settings > RRC), 13 px unless changed.
function rrcFontSize() {
    const px = parseInt(rrcSetting('font_size', 13), 10);
    document.documentElement.style.setProperty('--rrc-font', `${px >= 11 && px <= 24 ? px : 13}px`);
}

async function pollRrc() {
    if (Rrc.busy) return;
    Rrc.busy = true;
    try {
        try { Rrc.state = await fetch('/api/rrc').then(r => r.json()); } catch (e) { return; }
        rrcFontSize();
        rrcStkSync();
        if (typeof syncAutoReplyButton === 'function') syncAutoReplyButton('rrc');
        applyRrcVisibility();
        const live = (Rrc.state.hubs || []);
        for (const h of live) {
            const known = Rrc.data[h.address];
            if (!known || known.rev !== h.rev) await loadRrcOutput(h.address);
            rrcStateChanged(h.address, Rrc.states[h.address], h.state);
            Rrc.states[h.address] = h.state;
        }
        for (const address of Object.keys(Rrc.states)) if (!live.some(h => h.address === address)) delete Rrc.states[address];
        // Hubs closed: their windows go.
        for (const address of Object.keys(Rrc.data)) {
            if (live.some(h => h.address === address)) continue;
            delete Rrc.data[address];
            rrcDropPanes(address, () => true);
        }
        if (Rrc.active && !rrcRoomOf(Rrc.active.hub, Rrc.active.room)) {
            const prev = rrcBackTarget(Rrc.active.hub, Rrc.active.room);
            const hub = rrcHub(Rrc.active.hub);
            const first = Object.keys(Rrc.data)[0];
            if (prev) showRrcRoom(prev.hub, prev.room, true);
            else showRrcRoom(hub ? Rrc.active.hub : first || null, '', true);
        }
        const fj = Rrc.focusJoin;
        if (fj) {
            const r = rrcRoomOf(fj.hub, fj.room);
            if (!r || !r.joined) fj.gone = true;
            if (Date.now() > fj.until) Rrc.focusJoin = null;
            else if (fj.gone && r && r.joined) {
                Rrc.focusJoin = null;
                showRrcRoom(fj.hub, fj.room);
            }
        }
        if (!Rrc.open) return;
        if (Rrc.autoPick) {
            if (Rrc.active) Rrc.autoPick = false;           // the user picked something
            else {
                const first = live.find(h => h.state === 'connected' && Rrc.data[h.address]);
                if (first) { Rrc.autoPick = false; showRrcRoom(first.address, ''); }
            }
        }
        if (Date.now() - Rrc.hubsAt > 5000) {
            Rrc.hubsAt = Date.now();
            try { Rrc.hubList = await fetch('/api/rrc/hubs').then(r => r.json()); } catch (e) { /* next time */ }
        }
        renderRrcAll();
        renderRrcRoomsModal();
        renderRrcWho();
        rrcReadInFront();
    } finally {
        Rrc.busy = false;
    }
}

function startRrcPolling() {
    pollRrc();
    clearInterval(Rrc.pollTimer);
    Rrc.pollTimer = setInterval(pollRrc, 1500);
}

function rrcDropPanes(address, which) {
    for (const k of Object.keys(Rrc.panes)) {
        if (!k.startsWith(`${address}|`)) continue;
        if (!which(k.slice(address.length + 1))) continue;
        Rrc.panes[k].el.remove();
        delete Rrc.panes[k];
    }
}

async function loadRrcOutput(address) {
    const known = Rrc.data[address] || { seq: 0, rev: -1 };
    let data;
    try {
        data = await fetch(`/api/rrc/output/${address}?since=${known.seq}`).then(r => r.json());
    } catch (e) { return; }
    if (data.status !== 'success') return;
    // The server restarted the session (seq went back): start over.
    if (data.seq < known.seq) { rrcDropPanes(address, () => true); known.seq = 0; return loadRrcOutput(address); }
    Rrc.data[address] = { hub: data.hub, seq: data.seq, rev: data.rev };
    const rooms = new Set(data.hub.rooms.map(r => r.name));
    rrcDropPanes(address, room => !rooms.has(room));
    const firstLoad = known.seq === 0;
    for (const line of data.lines) {
        const pane = rrcPane(address, line.room);
        // At the bottom unless you scrolled up yourself (measured only while
        // on screen: a hidden pane has no heights) and are still at it.
        const stick = rrcSticks(pane);
        // News while you look elsewhere: a red line where they start, and
        // how many, until you have seen the room and leave it.
        if (!firstLoad && rrcCounts(line, data.hub.me) && !rrcLooking(address, line.room)) {
            if (!pane.marker) {
                pane.marker = document.createElement('div');
                pane.marker.className = 'rrc-newline';
                pane.marker.dataset.n = '0';
                pane.el.appendChild(pane.marker);
            }
            pane.marker.dataset.n = String(Number(pane.marker.dataset.n) + 1);
            pane.marker.textContent = `${pane.marker.dataset.n} new`;
        }
        if (!rrcFoldJoin(pane, line)) {
            const el = rrcLineEl(line, pane, data.hub.me);
            if (line.did) el.dataset.hub = address;
            pane.el.appendChild(el);
            rrcStartFold(pane, line, el);
        }
        while (pane.el.childElementCount > 1500) pane.el.firstElementChild.remove();
        if (stick || firstLoad) pane.el.scrollTop = pane.el.scrollHeight;
        if (!firstLoad) { rrcAlert(address, line, data.hub.me); rrcEventLine(address, line); }
    }
    rrcApplyDlv(address, data.dlv);
}

function rrcLooking(address, room) {
    return Rrc.open && !document.hidden && Rrc.active && Rrc.active.hub === address && Rrc.active.room === (room || '');
}

// A line from someone else: what counts as news.
function rrcCounts(line, me) {
    return !!line.src && line.src !== me && ['msg', 'action', 'notice'].includes(line.kind);
}

// The Sound button in the bar: RRC sounds off on the fly, popups stay.
let rrcMuted = (() => { try { return localStorage.getItem('rbrowser_rrc_mute') === '1'; } catch (e) { return false; } })();
const RRC_SOUND_ON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>';
const RRC_SOUND_OFF = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" stroke-width="1.4"/></svg>';

function rrcSound(name) {
    if (!rrcMuted && typeof playSound === 'function') playSound(name);
}

function rrcSoundButton() {
    return `<button class="msg-bar-btn rrc-sound-btn${rrcMuted ? ' muted' : ''}" onclick="toggleRrcSound()" aria-label="RRC sounds"
        title="${rrcMuted ? 'RRC sounds: off (click: on)' : 'RRC sounds: on (click: off, popups stay)'}">${rrcMuted ? RRC_SOUND_OFF : RRC_SOUND_ON}</button>`;
}

function toggleRrcSound() {
    rrcMuted = !rrcMuted;
    try { localStorage.setItem('rbrowser_rrc_mute', rrcMuted ? '1' : '0'); } catch (e) {}
    document.querySelectorAll('.rrc-sound-btn').forEach(b => { b.outerHTML = rrcSoundButton(); });
}

// News while you look elsewhere: the sound always (Settings > System Setup >
// Sounds decides if it plays), the popup as the RRC settings say.
function rrcAlert(address, line, me) {
    if (typeof appWindowElsewhere === 'function' && appWindowElsewhere('rrc')) return;   // its window tells
    // Someone comes into one of your rooms: a sound only (off by default).
    if (line.kind === 'join' && line.src && line.src !== me && line.room) {
        rrcSound('rrc_join');
        return;
    }
    if (!rrcCounts(line, me)) return;
    // The sound also in the window you are looking at; the popup
    // only for the others.
    if (rrcLooking(address, line.room) && document.hasFocus()) {
        rrcSound(line.mention ? 'rrc_mention' : 'rrc_message');
        return;
    }
    // Who and where only, never the text: a bot's long lines made huge popups.
    const where = line.room ? `Channel: #${line.room}` : `Hub: ${(rrcHub(address) || {}).name || 'RRC'}`;
    const text = `New message from: <b>${rrcEsc(line.nick)}</b><br>${rrcEsc(where)}`;
    if (line.mention) {
        rrcSound('rrc_mention');
        if (rrcSetting('notify_mentions', true)) showNotification(text, 'info', 6000);
    } else {
        rrcSound('rrc_message');
        if (rrcSetting('notify_messages', false)) showNotification(text, 'info', 4000);
    }
}

// A hub connects, drops or fails: a sound, and a word if you are elsewhere.
function rrcStateChanged(address, before, now) {
    if (!before || before === now || now === 'connecting') return;
    if (typeof appWindowElsewhere === 'function' && appWindowElsewhere('rrc')) return;
    rrcSound('rrc_state');
    const h = rrcHub(address);
    const name = (h && h.name) || address.slice(0, 12);
    const what = { connected: 'connected', closed: 'disconnected', failed: 'could not connect' }[now] || now;
    if (rrcSetting('notify_events', true) && !rrcLooking(address, ''))
        showNotification(`RRC: ${rrcEsc(name)} ${what}`, now === 'connected' ? 'info' : 'warning', 4000);
}

// Kicked or banned from a room: a hub event too (Settings: Hub events).
function rrcEventLine(address, line) {
    if (line.kind !== 'error' || !/^(kicked|banned) from /i.test(line.text)) return;
    if (typeof appWindowElsewhere === 'function' && appWindowElsewhere('rrc')) return;
    rrcSound('rrc_state');
    if (rrcSetting('notify_events', true)) showNotification(`RRC: ${rrcEsc(line.text)}`, 'warning', 6000);
}

// The window on screen is read (the counts go to zero on the server).
function rrcReadInFront() {
    if (!Rrc.active || !Rrc.open || document.hidden) return;
    const r = rrcRoomOf(Rrc.active.hub, Rrc.active.room);
    if (r && (r.unread || r.mentions || r.joins)) {
        r.unread = r.mentions = r.joins = 0;
        rrcPost(`/api/rrc/read/${Rrc.active.hub}`, { room: Rrc.active.room });
    }
}
window.addEventListener('focus', rrcReadInFront);
document.addEventListener('visibilitychange', rrcReadInFront);

// Back on the chat (RRC tab, window focus): the window on screen goes to the
// bottom, unless you had scrolled up to read.
function rrcToBottom() {
    if (!Rrc.active || !Rrc.open || document.hidden) return;
    const pane = Rrc.panes[rrcKey(Rrc.active.hub, Rrc.active.room)];
    if (!pane) return;
    if (rrcSticks(pane)) { pane.up = false; pane.el.scrollTop = pane.el.scrollHeight; }
}

// Scrolled up by hand, and touched the scroll in the last RRC_READING_MS:
// reading back, the window stays put. Otherwise new lines take it to the
// bottom.
const RRC_READING_MS = 20000;
function rrcSticks(pane) {
    return !pane.up || Date.now() - (pane.touchedAt || 0) > RRC_READING_MS;
}
window.addEventListener('focus', rrcToBottom);
document.addEventListener('visibilitychange', rrcToBottom);

// ─── Lines ──────────────────────────────────────────────────

function rrcPane(address, room) {
    const key = rrcKey(address, room);
    let pane = Rrc.panes[key];
    if (!pane) {
        const el = document.createElement('div');
        el.className = room ? 'rrc-screen rrc-room-screen' : 'rrc-screen';
        el.hidden = !(Rrc.active && rrcKey(Rrc.active.hub, Rrc.active.room) === key);
        el.setAttribute('role', 'log');
        document.getElementById('rrc-screens').appendChild(el);
        pane = Rrc.panes[key] = { el, last: null, up: false };
        el.addEventListener('scroll', () => {
            if (el.clientHeight) pane.up = el.scrollHeight - el.scrollTop - el.clientHeight > 40;
        });
        // Only the hand counts as reading (the scroll event fires for ours too).
        const touched = () => { pane.touchedAt = Date.now(); };
        for (const ev of ['wheel', 'touchmove', 'pointerdown']) el.addEventListener(ev, touched, { passive: true });
        el.addEventListener('keydown', touched);
    }
    return pane;
}

function rrcTime(ts) {
    const d = new Date(ts * 1000);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// [dd/mm hh:mm:ss] on a desktop; a phone hides the date, the seconds and the
// brackets (.rrc-ts-x in style.css), the whole time stays in the tooltip.
function rrcStamp(ts) {
    const t = rrcTime(ts);
    return `<span class="rrc-ts" title="${t}"><span class="rrc-ts-x">[${t.slice(0, 6)}</span>${t.slice(6, 11)}<span class="rrc-ts-x">${t.slice(11)}]</span></span>`;
}

// Links, as NomadNet's chat makes them: web addresses, lxmf@<hash> or lxmf://<hash> (the
// messenger), a 32 hex address with an optional :/page path (NomadNet), a
// #room (joined on this hub), an RRC hub (rrc://<hash>/room, MeshChatX's
// meshchatx://relay?hub=...). And `code`.
const RRC_LINKS = /(\bhttps?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]])|(?<![\w@])lxmf(?:@|:\/\/)([0-9a-f]{32})(?!\w)\/?|(?<![@\w/])([0-9a-f]{32}(?::\/[^\s<>"']*[^\s<>"'.,;:!?)\]])?)(?![\w])|(?<![\w&#])#([a-z0-9][a-z0-9_\-]{0,62})|`([^`\n]+)`|(\b(?:rrc:\/\/[0-9a-f]{32}(?::[\w.\-]+)?(?:\/[^\s<>"']*[^\s<>"'.,;:!?)\]])?|(?:meshchatx|meshchat):\/\/relay\?[^\s<>"']+))/gi;

function rrcText(text) {
    const src = String(text || '');
    let html = '';
    let last = 0;
    for (const m of src.matchAll(RRC_LINKS)) {
        html += rrcEsc(src.slice(last, m.index));
        const t = rrcEsc(m[0]);
        if (m[1]) html += `<a href="${t}" target="_blank" rel="noopener noreferrer">${t}</a>`;
        else if (m[2]) html += `<span class="rrc-link rrc-link-lxmf" data-rrc-lxmf="${rrcEsc(m[2].toLowerCase())}" title="Write to them in the Messenger">${t}</span>`;
        else if (m[3]) html += `<span class="rrc-link" data-rrc-page="${rrcEsc(m[3])}" title="Open in a new tab">${t}</span>`;
        else if (m[4]) html += `<span class="rrc-link rrc-link-room" data-rrc-room="${rrcEsc(m[4].toLowerCase())}" title="Join #${rrcEsc(m[4].toLowerCase())}">${t}</span>`;
        else if (m[6]) html += `<span class="rrc-link" data-rrc-url="${rrcEsc((typeof relayUrlToRrc === 'function' && relayUrlToRrc(m[6])) || m[6])}" title="Open this hub in RRC chat">${t}</span>`;
        else html += `<code>${rrcEsc(m[5])}</code>`;
        last = m.index + m[0].length;
    }
    return html + rrcEsc(src.slice(last));
}

// A reply as rBrowser writes it ("> nick: text" on the first line, the
// answer under it): the quote shown apart. Other clients see the plain text.
function rrcQuoted(text) {
    const m = /^> ([^\n]*)\n([\s\S]+)$/.exec(String(text || ''));
    if (!m) return rrcText(text);
    return `<span class="rrc-quote">${rrcText(m[1])}</span>${rrcText(m[2])}`;
}

// Reply to a line: its nick and text quoted in the box, the answer goes
// under it (Shift+Enter makes the new line; one line of quote, cut).
function rrcLineMenu(said, at) {
    if (!Rrc.active || !Rrc.active.room) return;
    const { hub, room } = Rrc.active;
    openNodeMenu(at, `<${said.dataset.replyNick}>`, said.dataset.replyText.slice(0, 60), [
        { label: 'Reply', tip: 'Reply to this message, quoting it',
          run: () => rrcReplyTo(said.dataset.replyNick, said.dataset.replyText) },
        { label: 'Copy text', run: () => copyText(said.dataset.replyText, 'Text copied'), tip: 'Copy the text of this message' },
        { label: 'Room menu…', run: () => rrcRoomMenu(at, hub, room), tip: 'Open the menu of this room' },
    ]);
}

function rrcReplyTo(nick, text) {
    const input = document.getElementById('rrc-input');
    if (!input) return;
    let quote = String(text || '').replace(/^> [^\n]*\n/, '').split('\n')[0].trim();
    if (quote.length > 100) quote = quote.slice(0, 99) + '…';
    input.value = `> ${nick}: ${quote}\n`;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    rrcGrow(input);
}

function rrcLineEl(line, pane, me) {
    const div = document.createElement('div');
    const own = me && line.src === me;
    const color = own ? '#58a6ff' : rrcColor(line.src || line.nick);
    const cont = false;     // every message shows its time and nick, even in a row
    // What a person says has a bar in their nick colour before the time
    //; a mention keeps its yellow one (style.css).
    const said = line.kind === 'msg' || line.kind === 'action' || (line.kind === 'notice' && line.src);
    div.className = `rrc-line rrc-${line.kind}${said ? ' rrc-said' : ''}${line.mention ? ' rrc-mention' : ''}${own ? ' rrc-own' : ''}${cont ? ' rrc-cont' : ''}`;
    if (said) div.style.setProperty('--rrc-bar', color);
    const ts = cont ? '<span class="rrc-ts"></span>' : rrcStamp(line.ts);
    const nick = rrcEsc(line.nick || '?');
    const nickHtml = `<span class="rrc-nick" style="color:${color}" data-rrc-nick="${nick}" data-src="${rrcEsc(line.src || '')}"
        title="${own ? 'you' : rrcEsc(line.src)} - click: menu">${nick}</span>`;
    const sign = s => `${ts}<span class="rrc-sign">${s}</span><span class="rrc-text">${rrcText(line.text)}</span>`;
    // Right-click on it: Reply (rrcReplyTo) quotes this nick and text.
    if (line.kind === 'msg' || line.kind === 'action') {
        div.dataset.replyNick = line.nick || (line.src || '').slice(0, 12);
        div.dataset.replyText = line.text || '';
    }
    if (line.kind === 'msg') {
        div.innerHTML = `${ts}<span class="rrc-who"${cont ? ' aria-hidden="true"' : ''}>&lt;${nickHtml}&gt;</span><span class="rrc-text">${rrcLineHtml(line, own)}</span>`;
        if (line.stk) rrcStkPaint(div);
    } else if (line.kind === 'action') {
        div.innerHTML = `${ts}<span class="rrc-text" style="color:${color}">* ${nickHtml} ${rrcLineHtml(line, own)}</span>`;
    } else if (line.kind === 'notice') {
        // From a person: "Notice: text (by nick)", the nick only here (other
        // clients show notices with no sender); from the hub: ℹ text.
        div.innerHTML = line.src ? `${ts}<span class="rrc-text">Notice: ${rrcText(line.text)} (by ${nickHtml})</span>` : sign(rrcSign('info'));
    } else if (line.kind === 'error') {
        div.innerHTML = sign(rrcSign('error'));
    } else if (line.kind === 'join' || line.kind === 'part') {
        // Bold, the nick in its colour from the people list.
        const what = line.kind === 'join' ? 'joined' : 'left';
        div.innerHTML = `${ts}<span class="rrc-sign">${rrcSign(line.kind)}</span><span class="rrc-text">${nickHtml} ${what}${rrcWhere(line)}</span>`;
    } else {
        div.innerHTML = sign(rrcSign('system'));
    }
    if (line.did) {
        div.dataset.did = line.did;
        rrcSetDlv(div, line.dlv, line.why);
    }
    pane.last = line;
    return div;
}

// Our message: waiting for the hub's echo, delivered, or not (Retry).
const RRC_DLV_WAIT = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const RRC_DLV_OK = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';

function rrcSetDlv(div, state, why) {
    let el = div.querySelector('.rrc-dlv');
    if (!el) {
        el = document.createElement('span');
        el.className = 'rrc-dlv';
        div.appendChild(el);
    }
    div.classList.toggle('rrc-dlv-wait', state === 'wait');
    div.classList.toggle('rrc-dlv-fail', state === 'fail');
    if (state === 'fail') {
        el.innerHTML = `<span class="rrc-dlv-no">Not delivered</span><button class="rrc-dlv-retry" onclick="rrcRetry(this)">Retry</button>`;
        el.title = why || 'The hub did not send it back';
    } else {
        el.innerHTML = state === 'ok' ? RRC_DLV_OK : RRC_DLV_WAIT;
        el.title = state === 'ok' ? 'Delivered: the hub sent it to the room' : 'Sent, waiting for the hub';
    }
    div.dataset.dlv = state || '';
    div.dataset.why = why || '';
}

function rrcApplyDlv(address, dlv) {
    if (!dlv) return;
    for (const [did, [state, why]] of Object.entries(dlv)) {
        document.querySelectorAll(`.rrc-line[data-did="${did}"]`).forEach(div => {
            if (div.dataset.hub === address && (div.dataset.dlv !== state || div.dataset.why !== (why || ''))) {
                rrcSetDlv(div, state, why);
            }
        });
    }
}

async function rrcRetry(btn) {
    const div = btn.closest('.rrc-line');
    if (!div) return;
    btn.disabled = true;
    const res = await rrcPost(`/api/rrc/retry/${div.dataset.hub}`, { did: div.dataset.did });
    if (res.status !== 'success' && !res.shown) {
        btn.disabled = false;
        showNotification(rrcEsc(res.error || 'Not sent'), 'error', 4000);
    }
    pollRrc();
}

// Joins and parts in a row, one line: "⇄ → a, b joined · ← c left"
// (Settings > RRC Client > Compact joins and parts). Anything else said, a
// "new" line, or ten minutes, starts a new one.
function rrcStartFold(pane, line, el) {
    const on = rrcSetting('compact_joins', false) === true;
    pane.fold = on && (line.kind === 'join' || line.kind === 'part')
        ? { el, ts: line.ts, joined: [], left: [], colors: {}, room: line.room } : null;
    if (pane.fold) {
        (line.kind === 'join' ? pane.fold.joined : pane.fold.left).push(rrcFoldName(line));
        if (line.src) pane.fold.colors[rrcFoldName(line)] = rrcColor(line.src);
    }
}

function rrcFoldName(line) {
    return line.nick || line.text.replace(/ (joined|left)( #\S+)?$/, '');
}

// " #room" after joined/left: a line in the wrong window shows at once.
function rrcWhere(line) {
    return line && line.room ? ` <span class="rrc-where">#${rrcEsc(line.room)}</span>` : '';
}

// A name in a folded line, in its colour (as in the people list).
function rrcFoldNick(name, colors) {
    const c = colors[name] || rrcColor(name);
    return `<span class="rrc-nick" style="color:${c}" data-rrc-nick="${rrcEsc(name)}">${rrcEsc(name)}</span>`;
}

function rrcFoldJoin(pane, line) {
    const g = pane.fold;
    if (!g || (line.kind !== 'join' && line.kind !== 'part') || pane.el.lastElementChild !== g.el
        || line.ts - g.ts > 600 || rrcSetting('compact_joins', false) !== true
        || (line.room || '') !== (g.room || '')) return false;    // another room's: its own line
    const list = line.kind === 'join' ? g.joined : g.left;
    const name = rrcFoldName(line);
    if (!list.includes(name)) list.push(name);
    if (line.src) g.colors[name] = rrcColor(line.src);
    const names = l => l.slice(0, 8).map(n => rrcFoldNick(n, g.colors)).join(', ') + (l.length > 8 ? ` +${l.length - 8}` : '');
    const parts = [];
    if (g.joined.length) parts.push(`<span class="rrc-g-join">${rrcSign('join')}</span> ${names(g.joined)} joined${rrcWhere(g)}`);
    if (g.left.length) parts.push(`<span class="rrc-g-part">${rrcSign('part')}</span> ${names(g.left)} left${rrcWhere(g)}`);
    g.el.className = 'rrc-line rrc-join rrc-joins';
    g.el.innerHTML = `${rrcStamp(g.ts)}<span class="rrc-sign">${rrcSign('fold')}</span><span class="rrc-text">${parts.join(' · ')}</span>`;
    const at = g.room ? ` #${g.room}` : '';
    g.el.title = [...g.joined.map(n => `${n} joined${at}`), ...g.left.map(n => `${n} left${at}`)].join('\n');
    pane.last = line;
    return true;
}

// ─── Windows ────────────────────────────────────────────────

// The windows seen, last on top: closing one goes back to the one before
//, not to the hub window. Windows gone since are skipped.
const RRC_HISTORY_MAX = 30;

function rrcBackTarget(hub, room) {
    const history = Rrc.backStack || [];
    while (history.length) {
        const p = history.pop();
        if (p.hub === hub && p.room === (room || '')) continue;
        if (rrcRoomOf(p.hub, p.room)) return p;
    }
    return null;
}

// back: going back in the history, the window left is not added to it.
function showRrcRoom(hub, room = '', back = false) {
    const key = hub ? rrcKey(hub, room) : '';
    if (Rrc.active && !back && rrcKey(Rrc.active.hub, Rrc.active.room) !== key) {
        const was = { hub: Rrc.active.hub, room: Rrc.active.room || '' };
        Rrc.backStack = (Rrc.backStack || []).filter(p => p.hub !== was.hub || p.room !== was.room);
        Rrc.backStack.push(was);
        if (Rrc.backStack.length > RRC_HISTORY_MAX) Rrc.backStack.shift();
    }
    if (Rrc.active) {
        const before = rrcKey(Rrc.active.hub, Rrc.active.room);
        const input = document.getElementById('rrc-input');
        if (input) Rrc.inputs[before] = input.value;
        // Left after seeing it: its "new" line has done its job.
        if (before !== key) rrcDropMarker(before);
    }
    Rrc.active = hub ? { hub, room: room || '' } : null;
    if (hub) rrcPane(hub, room);
    // The server sends here the hub's answers that name no room.
    if (hub) rrcPost(`/api/rrc/read/${hub}`, { room: room || '' });
    for (const [k, pane] of Object.entries(Rrc.panes)) {
        const on = k === key;
        if (pane.el.hidden === on) {
            pane.el.hidden = !on;
        }
    }
    // Every window opens at the bottom, where the news are (a long
    // /list, or a room with a mention, left you halfway up); the "N new"
    // line stays as a divider. After layout: on phones, and after a client
    // window was closed, the pane was hidden and had no heights.
    if (hub) {
        const pane = Rrc.panes[key];
        pane.up = false;
        pane.touchedAt = 0;
        if (!room) rrcDropMarker(key);
        const down = () => { pane.el.scrollTop = pane.el.scrollHeight; };
        down();
        requestAnimationFrame(down);
        setTimeout(down, 150);
    }
    const empty = document.querySelector('#rrc-screens .rrc-empty');
    if (empty) empty.hidden = !!hub;
    // Phones: the hub list or the chat, one at a time (← goes back).
    const view = document.getElementById('rrc-view');
    if (view) view.classList.toggle('rrc-has-session', !!hub);
    const row = document.getElementById('rrc-input-row');
    if (row) row.hidden = !hub;
    const input = document.getElementById('rrc-input');
    if (input && hub) {
        Rrc.draft = Rrc.drafts[key] || (Rrc.drafts[key] = { text: '', st: [] });
        input.value = Rrc.inputs[key] || '';
        rrcGrow(input);
        rrcStkSuggest();
        if (Rrc.open && !window.matchMedia('(max-width: 700px), (pointer: coarse) and (max-height: 500px)').matches) input.focus();
    }
    Rrc.historyAt = -1;
    rrcReadInFront();
    Rrc.hubsForce = true;
    renderRrcAll();
}

function rrcDropMarker(key) {
    const pane = Rrc.panes[key];
    if (pane && pane.marker) { pane.marker.remove(); pane.marker = null; }
}

function renderRrcAll() {
    renderRrcHubs();
    renderRrcTabs();
    renderRrcHead();
    renderRrcUsers();
}

function rrcBadge(r) {
    if (!r || !(r.unread || r.mentions || r.joins)) return '';
    // The hub window: /who, /list and the like grow its count for nothing,
    // a blue dot says enough.
    if (!r.name && !r.mentions) return r.unread ? '<span class="rrc-hub-dot" title="Something new in the hub window"></span>' : '';
    // New messages: orange, a balloon and how many; mentions: red, @N;
    // people who came in: green, a person and +N (the join sound's trace).
    const msgs = r.mentions
        ? `<span class="rrc-new-badge rrc-new-at" title="${r.mentions} new ${r.mentions === 1 ? 'mention' : 'mentions'}">@${r.mentions}</span>`
        : r.unread ? `<span class="rrc-new-badge" title="${r.unread} new ${r.unread === 1 ? 'message' : 'messages'}">${RRC_MSG_ICON}${r.unread}</span>` : '';
    const joins = r.joins
        ? `<span class="rrc-new-badge rrc-new-join" title="${r.joins} ${r.joins === 1 ? 'person' : 'people'} joined">${RRC_USER_ICON}+${r.joins}</span>` : '';
    return msgs + joins;
}

function rrcWindows() {
    const out = [];
    for (const [address, d] of Object.entries(Rrc.data)) {
        // Rooms in the order you dragged them to (rrcTabOrder); the hub
        // window stays first.
        const order = rrcTabOrder()[address] || [];
        const at = r => !r.name ? -1 : order.includes(r.name) ? order.indexOf(r.name) : order.length;
        const rooms = d.hub.rooms.map((r, i) => ({ r, i })).sort((a, b) => (at(a.r) - at(b.r)) || (a.i - b.i));
        for (const { r } of rooms) out.push({ hub: address, room: r.name, r, h: d.hub });
    }
    return out;
}

// The room tabs' order, per hub: {hub: [room, ...]} (Settings file, via
// the synced rbrowser_ preferences).
function rrcTabOrder() {
    try { return JSON.parse(localStorage.getItem('rbrowser_rrc_tab_order')) || {}; } catch (e) { return {}; }
}

function rrcMoveTab(hub, room, before) {
    const wins = rrcWindows().filter(w => w.hub === hub && w.room);
    const names = wins.map(w => w.room).filter(n => n !== room);
    const at = before ? names.indexOf(before) : -1;
    names.splice(at < 0 ? names.length : at, 0, room);
    const all = rrcTabOrder();
    all[hub] = names;
    try { localStorage.setItem('rbrowser_rrc_tab_order', JSON.stringify(all)); } catch (e) { /* only now */ }
    renderRrcTabs();
}

function renderRrcTabs() {
    const strip = document.getElementById('rrc-tabs');
    if (!strip) return;
    const wins = rrcWindows();
    strip.hidden = !wins.length;
    const many = Object.keys(Rrc.data).length > 1;
    const html = wins.map(({ hub, room, r, h }) => {
        const active = Rrc.active && Rrc.active.hub === hub && Rrc.active.room === room;
        const label = room ? `#${room}` : h.name || hub.slice(0, 8);
        return `<div${room ? ' draggable="true"' : ''} class="msg-tab rrc-tab${active ? ' active' : ''}${room ? '' : ' rrc-tab-hub'}${room && !r.joined ? ' rrc-tab-off' : ''}${r.unread && !active ? ' rrc-unread' : ''}${r.mentions && !active ? ' rrc-unread-at' : ''}${r.leaving ? ' rrc-tab-off' : ''}"
                     data-rrc-tab="${rrcEsc(room)}" data-hub="${hub}" title="${rrcEsc(label)}${r.topic ? ' - ' + rrcEsc(r.topic) : ''}${room ? `&#10;HUB: ${rrcEsc(h.name || hub)}` : ''}">
            ${room ? '' : `<span class="bbs-state bbs-state-${rrcEsc(h.state)}"></span>`}
            <span class="msg-tab-name">${room ? '' : '<span class="rrc-tab-hubtag">HUB:</span> '}${rrcEsc(label)}</span>
            ${room && r.joined ? `<span class="rrc-tab-users">${RRC_USER_ICON}${r.members.length}</span>` : ''}
            ${room && many ? `<span class="msg-tab-id">${rrcEsc(h.name || hub.slice(0, 6))}</span>` : ''}
            ${rrcBadge(r)}
            <button class="msg-tab-close" data-rrc-close="${rrcEsc(room)}" data-hub="${hub}"
                    title="${room ? 'Leave the room' : 'Close the hub (disconnects)'}" aria-label="Close">&times;</button>
        </div>`;
    }).join('');
    // Not while a tab is being dragged: redrawn under it, the drag stopped.
    if (strip.dataset.html !== html && !Rrc.draggingTab) { strip.dataset.html = html; strip.innerHTML = html; }
    rrcTabIntoView(strip);
}

// A window opened from elsewhere (the badge on the RRC tab, a #room link):
// on a phone its tab may be off the strip, so the strip scrolls to it. Only
// when the window changes, a strip scrolled by hand is left where it is.
function rrcTabIntoView(strip) {
    const key = Rrc.active ? rrcKey(Rrc.active.hub, Rrc.active.room) : '';
    if (strip.dataset.shown === key || !strip.clientWidth) return;
    const tab = strip.querySelector('.rrc-tab.active');
    if (!tab) return;
    strip.dataset.shown = key;
    const left = tab.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
    if (left < strip.scrollLeft || left + tab.offsetWidth > strip.scrollLeft + strip.clientWidth) {
        strip.scrollTo({ left: Math.max(0, left - (strip.clientWidth - tab.offsetWidth) / 2), behavior: 'smooth' });
    }
}

function renderRrcHead() {
    const head = document.getElementById('rrc-head');
    if (!head) return;
    const hub = Rrc.active ? rrcHub(Rrc.active.hub) : null;
    if (!hub) { head.innerHTML = ''; head.hidden = true; head.dataset.html = ''; return; }
    head.hidden = false;
    const room = Rrc.active.room;
    const r = rrcRoomOf(Rrc.active.hub, room);
    const on = hub.state === 'connected';
    const stateText = { connecting: 'Connecting…', connected: 'Connected', closed: 'Disconnected', failed: 'Failed' }[hub.state] || hub.state;
    const myRole = r && room ? (r.members.find(m => m.id === hub.me) || {}).role : '';
    const html = `
        <button class="msg-back" data-rrc-act="back" title="Back to the hubs (they stay connected)">&larr;</button>
        <div class="rrc-head-left">
            <div class="bbs-head-name">${room ? `#${rrcEsc(room)}` : rrcEsc(hub.name || 'RRC hub')}
                ${room ? `<span class="rrc-head-hub">${rrcEsc(hub.name || '')}</span>` : ''}
                <code class="rrc-head-addr" data-rrc-act="copy" title="The hub's address - click to copy">${rrcEsc(hub.address)}</code></div>
            ${room && r && r.topic ? `<div class="rrc-topic" title="${rrcEsc(r.topic)}">${rrcText(r.topic)}</div>` : ''}
            <div class="rrc-head-status">
                <span class="bbs-state bbs-state-${rrcEsc(hub.state)}"></span>${rrcEsc(stateText)}
                ${hub.version ? ` · rrcd ${rrcEsc(hub.version)}` : ''}
                ${hub.rtt != null && on ? ` · <span title="Round trip to the hub, live (pings and your messages coming back)">RTT ${Math.round(hub.rtt * 1000)} ms</span>` : ''}
                ${room && r && !r.joined && on ? ' · <b>not in the room</b>' : ''}
                ${room && r && r.modes ? ` · <span class="rrc-modes" title="The room's modes">${rrcEsc(r.modes)}</span>` : ''}
                ${myRole ? ` · <b>${myRole === 'o' ? '@ operator' : '+ voice'}</b>` : ''}
                ${hub.receiving ? ' · receiving…' : ''}
                · as <b>${rrcEsc(hub.nick || hub.me.slice(0, 12))}</b>
                <span class="rrc-nick-src" title="Where the nick comes from: Settings > RRC Client > Saved hubs (this hub) or the Default nick">(${
                    hub.nick_source === 'hub' ? 'nick of this hub' : hub.nick_source === 'default' ? 'Default nick' : hub.nick_source === 'away' ? 'away nick' : 'no nick, hash only'})</span>
                · identity ${rrcEsc(hub.identity_name)}
                <code class="rrc-head-me" data-rrc-act="copyme" title="Your identity hash: hubs know you by it - click to copy">${rrcEsc(hub.me)}</code>
            </div>
        </div>
        <div class="rrc-head-right"><div class="bbs-head-actions">
            ${on ? '<button class="msg-bar-btn" data-rrc-act="list" title="The hub\'s public rooms (/list)">Rooms</button>' : ''}
            ${on && room && r && r.joined ? '<button class="msg-bar-btn" data-rrc-act="who" title="Ask the hub who is here (/who)">Who</button>' : ''}
            <button class="msg-bar-btn" data-rrc-act="menu" title="${room ? 'The room\'s menu' : 'The hub\'s menu'} (also right-click on the tab or in the window)">${room ? '#Menu' : 'Hub Menu'}</button>
            ${room ? `<button class="msg-bar-btn${rrcUsersOn() ? ' on' : ''}" data-rrc-act="users" title="Show or hide the people">${RRC_USER_ICON} ${r ? r.members.length : 0}</button>` : ''}
            <button class="msg-bar-btn" data-rrc-act="nick" title="Your nick on this hub (/nick)">Nick</button>
            <button class="msg-bar-btn auto-reply-btn${typeof autoReplyAnyOn === 'function' && autoReplyAnyOn('rrc') ? ' on' : ''}" data-kind="rrc" onclick="toggleAutoReplyMenu(this, 'rrc')" title="Automatic replies: keywords, away, echo (green dot: one is on)">AutoReply</button>${awayButton('rrc')}${rrcSoundButton()}
            ${on || hub.state === 'connecting'
                ? '<button class="msg-bar-btn danger" data-rrc-act="disconnect">Disconnect</button>'
                : '<button class="msg-bar-btn primary" data-rrc-act="connect">Connect</button>'}
            <button class="msg-bar-btn msg-settings-btn" data-rrc-act="settings" title="RRC settings" aria-label="RRC settings">${typeof GEAR_ICON !== 'undefined' ? GEAR_ICON : '⚙'}</button>
            <button class="msg-close" data-rrc-act="close" title="${room ? 'Leave the room' : 'Close the hub (disconnects)'}" aria-label="Close">&times;</button>
        </div></div>`;
    if (head.dataset.html !== html) { head.dataset.html = html; head.innerHTML = html; }
    const prompt = document.getElementById('rrc-prompt');
    const p = `<span class="rrc-prompt-nick">${room ? rrcEsc(hub.nick || hub.me.slice(0, 12)) : `[${rrcEsc(hub.name || 'hub')}]`}</span>`;
    if (prompt && prompt.dataset.html !== p) { prompt.dataset.html = p; prompt.innerHTML = p; }
}

function rrcNarrow() { return window.matchMedia('(max-width: 700px), (pointer: coarse) and (max-height: 500px)').matches; }

function rrcUsersOn() { return rrcNarrow() ? Rrc.usersPhone : Rrc.users; }

function rrcUsersWidth() {
    let w = 190;
    try { w = Number(localStorage.getItem('rrc-users-w')) || 190; } catch (e) { /* default */ }
    return Math.min(420, Math.max(120, w));
}

function renderRrcUsers() {
    const box = document.getElementById('rrc-users');
    if (!box) return;
    const hub = Rrc.active ? rrcHub(Rrc.active.hub) : null;
    const r = Rrc.active && Rrc.active.room ? rrcRoomOf(Rrc.active.hub, Rrc.active.room) : null;
    box.hidden = !(r && r.joined && rrcUsersOn());
    const grip = document.getElementById('rrc-users-grip');
    if (grip) grip.hidden = box.hidden;
    if (box.hidden) return;
    if (!Rrc.dragging) box.style.width = window.matchMedia('(max-width: 700px), (pointer: coarse) and (max-height: 500px)').matches ? '' : `${rrcUsersWidth()}px`;
    // Two people with the same nick (a client's default, "Anonymous Peer"):
    // the start of the hash tells them apart.
    const seen = {};
    for (const m of r.members) if (m.nick) seen[m.nick] = (seen[m.nick] || 0) + 1;
    const label = m => (m.nick ? (seen[m.nick] > 1 ? `${m.nick} ·${m.id.slice(0, 4)}` : m.nick) : m.id.slice(0, 12));
    const rank = { o: 0, v: 1, '': 2 };
    const list = [...r.members].sort((a, b) => rank[a.role || ''] - rank[b.role || '']
        || label(a).localeCompare(label(b), undefined, { sensitivity: 'base' }));
    const ignored = (Rrc.state && Rrc.state.ignored) || {};
    const html = `<div class="rrc-users-head">Users <span>${list.length}</span></div>`
        + list.map(m => {
            const me = m.id === hub.me;
            return `<div class="rrc-user${me ? ' me' : ''}${m.id in ignored ? ' ignored' : ''}" data-rrc-user="${rrcEsc(m.id)}" data-nick="${rrcEsc(m.nick)}"
                title="${rrcEsc(m.id)}${m.partial ? ' (first 12 characters: the hub said only these)' : ''}${me ? ' (you)' : ''}">
            <span class="rrc-user-icon${me ? ' rrc-user-me' : ''}" style="color:${me ? '#58a6ff' : rrcColor(m.id)}">${me ? '▸' : RRC_USER_ICON}</span>
            <span class="rrc-user-sign rrc-sign-${m.role || 'none'}">${RRC_SIGN[m.role] || ''}</span><span class="rrc-user-name">${rrcEsc(label(m))}</span></div>`;
        }).join('');
    if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

function rrcAgo(ts) {
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 129600) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
}

function renderRrcHubs() {
    const box = document.getElementById('rrc-hubs');
    if (!box) return;
    // Not while the mouse is on it: rows would move under the pointer. Except
    // after a click of yours (showRrcRoom): the window picked lights up and
    // its badge goes at once, not when the mouse leaves.
    const forced = Rrc.hubsForce;
    Rrc.hubsForce = false;
    if (!forced && box.matches(':hover') && box.dataset.html) return;
    const words = Rrc.filter.toLowerCase().split(/\s+/).filter(Boolean);
    const match = s => !words.length || words.every(w => `${s.name} ${s.address}`.toLowerCase().includes(w));
    // Connected: each hub, then its windows.
    const tree = Object.entries(Rrc.data).map(([address, d]) => {
        const h = d.hub;
        return h.rooms.map(r => {
            const active = Rrc.active && Rrc.active.hub === address && Rrc.active.room === r.name;
            if (!r.name) {
                return `<div class="bbs-server rrc-tree-hub${active ? ' active' : ''}" data-rrc-win="" data-hub="${address}">
                    <span class="bbs-state bbs-state-${rrcEsc(h.state)}"></span>
                    <div class="bbs-server-text"><div class="bbs-server-name"><span class="bbs-server-title">${rrcEsc(h.name || address.slice(0, 12) + '…')}</span>${rrcBadge(r)}</div></div></div>`;
            }
            return `<div class="rrc-tree-room${active ? ' active' : ''}${r.joined && !r.leaving ? '' : ' off'}${r.unread && !active ? ' rrc-unread' : ''}" data-rrc-win="${rrcEsc(r.name)}" data-hub="${address}">
                <span>#${rrcEsc(r.name)}</span><span class="rrc-tree-side">${r.joined ? `<span class="rrc-tree-users">${r.members.length}</span>` : ''}${rrcBadge(r)}</span></div>`;
        }).join('');
    }).join('');
    const lists = Rrc.hubList || { favorites: [], history: [], heard: [] };
    const row = (s, kind) => `
        <div class="bbs-server${s.state ? ' open' : ''}" data-rrc-hub="${s.address}"
             title="Click: connect${s.rooms && s.rooms.length ? ' and join ' + s.rooms.map(r => '#' + r).join(' ') : ''}">
            <div class="rrc-star-col">
                <button class="bbs-star${s.favorite ? ' on' : ''}" data-rrc-star="${s.address}" data-on="${s.favorite ? '1' : '0'}"
                        title="${s.favorite ? 'Remove from favourites' : 'Add to favourites'}">${s.favorite ? '★' : '☆'}</button>
                ${s.favorite ? `<button class="rrc-auto${s.auto ? ' on' : ''}" data-rrc-auto="${s.address}" data-on="${s.auto ? '1' : '0'}"
                        title="${s.auto ? 'Connected at start: click to stop' : 'Connect at start (Settings > RRC Client > Connect to the selected favourite hubs)'}">⚡</button>` : ''}
            </div>
            <div class="bbs-server-text">
                <div class="bbs-server-name">${s.state === 'connected' || s.state === 'connecting' ? `<span class="bbs-state bbs-state-${s.state}"></span>` : ''}<span class="bbs-server-title">${rrcEsc(s.name || 'Unnamed hub')}</span></div>
                <code>${s.address}</code>
                <div class="bbs-server-meta">${[
                    s.hops != null ? `${s.hops} hop${s.hops === 1 ? '' : 's'}` : '',
                    s.heard ? `heard ${rrcAgo(s.heard)}` : '',
                    kind === 'history' && s.last ? `visited ${rrcAgo(s.last)}` : '',
                    s.rooms && s.rooms.length ? s.rooms.map(r => '#' + r).join(' ') : '',
                ].filter(Boolean).map(rrcEsc).join(' · ')}</div>
            </div>
            ${kind === 'history' ? `<button class="msg-tab-close" data-rrc-forget="${s.address}" title="Remove from the history">&times;</button>` : ''}
        </div>`;
    // A click on the title folds the section (open while searching).
    const section = (title, list, kind, empty) => {
        // Starred first, then the server's order (a stable sort).
        const shown = list.filter(match).sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));
        const closed = !!Rrc.collapsed[kind] && !words.length;
        return `<div class="bbs-section"><button class="bbs-section-title" data-rrc-section="${kind}" aria-expanded="${!closed}">
                <span><span class="bbs-caret">${closed ? '▸' : '▾'}</span>${title}</span><span>${shown.length}</span></button>
            ${closed ? '' : (shown.length ? shown.map(s => row(s, kind)).join('') : `<div class="msg-search-none">${empty}</div>`)}</div>`;
    };
    // What is connected first (folds like the others), then favourites, then the rest heard.
    const treeClosed = !!Rrc.collapsed.connected;
    const html = (tree ? `<div class="bbs-section rrc-tree"><button class="bbs-section-title rrc-tree-title" data-rrc-section="connected" aria-expanded="${!treeClosed}">
                <span><span class="bbs-caret">${treeClosed ? '▸' : '▾'}</span>Connected</span><span>${Object.keys(Rrc.data).length}</span></button>${treeClosed ? '' : tree}</div>` : '')
        + section('★ Favourites', lists.favorites, 'favorite', 'Star a hub to keep it here')
        + section('Heard', lists.heard, 'heard', 'No RRC hub announced yet');
    if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

// ─── Actions ────────────────────────────────────────────────

async function rrcFavorite(address, on) {
    if (guestNoFavorites()) return;
    // At once on screen, then from the server.
    const lists = Rrc.hubList || { favorites: [], history: [], heard: [] };
    for (const list of [lists.favorites, lists.history, lists.heard]) for (const s of list) if (s.address === address) s.favorite = on;
    const box = document.getElementById('rrc-hubs');
    if (box) box.dataset.html = '';
    renderRrcHubs();
    if (box) box.dataset.html = '';
    const res = await rrcPost(`/api/rrc/favorite/${address}`, { favorite: on });
    if (res.status !== 'success') showNotification(rrcEsc(res.error), 'error', 4000);
    try { Rrc.hubList = await fetch('/api/rrc/hubs').then(r => r.json()); Rrc.hubsAt = Date.now(); } catch (e) { /* next poll */ }
    if (box) box.dataset.html = '';
    renderRrcHubs();
}

async function rrcAutoconnect(address, on) {
    const lists = Rrc.hubList || { favorites: [], history: [], heard: [] };
    for (const list of [lists.favorites, lists.history, lists.heard]) for (const s of list) if (s.address === address) s.auto = on;
    const box = document.getElementById('rrc-hubs');
    if (box) box.dataset.html = '';
    renderRrcHubs();
    const res = await rrcPost(`/api/rrc/autoconnect/${address}`, { on });
    if (res.status !== 'success') showNotification(rrcEsc(res.error), 'error', 4000);
    else if (on && !rrcSetting('autoconnect_selected', true) && !rrcSetting('autoconnect_all', false))
        showNotification('Marked. Switch on "Connect to the selected favourite hubs at start" in Settings > RRC Client', 'info', 5000);
    try { Rrc.hubList = await fetch('/api/rrc/hubs').then(r => r.json()); Rrc.hubsAt = Date.now(); } catch (e) { /* next poll */ }
    if (box) box.dataset.html = '';
    renderRrcHubs();
}

function rrcParseAddress(text) {
    const s = String(text || '').trim();
    const m = s.match(/([0-9a-f]{32})/i);
    if (!m) return null;
    // NomadNet's rrc://<hub>:<dest_name>/<room>: the dest name is not the room.
    const after = s.slice(m.index + 32).replace(/^:[^/\s]*(?=\/)/, '').replace(/^[:/]+/, '').trim();
    const room = after.replace(/^#/, '').split(/[\s/?]/)[0] || '';
    return { hub: m[1].toLowerCase(), room };
}

async function rrcConnect(address, room) {
    const res = await rrcPost(`/api/rrc/connect/${address}`, room ? { room } : {});
    if (res.status !== 'success') {
        showNotification(rrcEsc(res.error || 'Could not connect'), 'error', 5000);
        return;
    }
    Rrc.hubsAt = 0;
    await pollRrc();
    showRrcRoom(address, '');
}

// From a page link, a text address, RMAP...: open the client on that hub.
function openRrcAddress(text) {
    const parsed = rrcParseAddress(text);
    if (!parsed) { showNotification('Not an RRC hub address', 'error', 4000); return; }
    if (!rrcEnabled()) {
        showNotification('The RRC client is off: Settings > RRC Client', 'info', 5000);
        return;
    }
    openRrc();
    rrcConnect(parsed.hub, parsed.room);
}

// A room: PART is sent, the tab goes when the hub answers (the poll sees the
// room gone). The hub window: the link is closed.
async function rrcCloseWindow(hub, room) {
    const res = room ? await rrcPost(`/api/rrc/part/${hub}`, { room }) : await rrcPost(`/api/rrc/close/${hub}`);
    if (res.waiting) { pollRrc(); return; }
    if (Rrc.active && Rrc.active.hub === hub && (!room || Rrc.active.room === room)) {
        // Back where you were before; the hub window when nothing is left.
        if (!room) Rrc.backStack = (Rrc.backStack || []).filter(p => p.hub !== hub);
        const prev = rrcBackTarget(hub, room);
        if (prev) showRrcRoom(prev.hub, prev.room, true);
        else showRrcRoom(room ? hub : (Object.keys(Rrc.data).find(a => a !== hub) || null), '', true);
    }
    Rrc.hubsAt = 0;
    pollRrc();
}

async function rrcRun(text, split = false, fmt = null, parts = null) {
    if (!Rrc.active) return;
    const { hub, room } = Rrc.active;
    const mc = fmt ? (split ? (parts ? rrcMicronFor(text, fmt, parts) : null) : rrcMicronFor(text, fmt)) : null;
    const res = await rrcPost(`/api/rrc/input/${hub}`, fmt ? { room, text, split, fmt, ...(mc ? { mc } : {}) } : { room, text, split });
    // Over the hub's limit: in parts "(1/3) ...", if you say so (NomadNet's way).
    if (res.too_long) {
        const ok = await confirmDialog('Message too long',
            `This hub takes ${res.max} bytes per message. Send it in <b>${res.parts} parts</b>, each starting with (1/${res.parts})…?`,
            `Send ${res.parts} parts`);
        if (ok) return rrcRun(text, true, fmt, res.texts);
        const input = document.getElementById('rrc-input');
        if (input && !input.value) input.value = text;
        return;
    }
    if (res.clear) rrcDropPanes(hub, r => r === room);
    // /join, /j, /rejoin: that room's tab comes to the front once the hub
    // has let you in (it opened at the end of the tabs, unseen).
    const joined = res.room || res.rejoin;
    if (joined && /^\/(join|j|rejoin)\b/i.test(text)) {
        // /rejoin: the room still open goes first, then comes back.
        Rrc.focusJoin = { hub, room: joined, until: Date.now() + 25000, gone: !res.rejoin };
        await pollRrc();
        return;
    }
    pollRrc();
}

async function rrcSend() {
    const input = document.getElementById('rrc-input');
    if (!input || !Rrc.active) return;
    const text = input.value.trim();
    if (!text) return;
    // A sticker waiting in the bar, its emoji untouched: it goes as the sticker.
    const pend = Rrc.stkPending?.[rrcKey(Rrc.active.hub, Rrc.active.room)];
    if (pend && pend.emoji === input.value) return rrcSendSticker(pend.pack, pend.cp, pend.emoji);
    const out = rrcOutgoing(input.value);
    input.value = '';
    rrcDraftReset('');
    rrcGrow(input);
    Rrc.inputs[rrcKey(Rrc.active.hub, Rrc.active.room)] = '';
    if (Rrc.history[0] !== text) Rrc.history.unshift(text);
    Rrc.history.length = Math.min(Rrc.history.length, 50);
    Rrc.historyAt = -1;
    rrcDropMarker(rrcKey(Rrc.active.hub, Rrc.active.room));      // you answered: seen
    await rrcRun(out.text, false, out.fmt);
    if (Rrc.active) showRrcRoom(Rrc.active.hub, Rrc.active.room);
}

// Tab: the nick being typed (with or without @), from the people in the
// room, written @nick: NomadNet counts a mention only so.
function rrcComplete(input) {
    const r = Rrc.active ? rrcRoomOf(Rrc.active.hub, Rrc.active.room) : null;
    if (!r) return;
    const before = input.value.slice(0, input.selectionStart);
    const m = before.match(/@?([^\s@]+)$/);
    if (!m) return;
    const part = m[1].toLowerCase();
    const names = r.members.map(x => x.nick).filter(Boolean);
    const hit = names.find(n => n.toLowerCase().startsWith(part));
    if (!hit) return;
    const start = before.length - m[0].length;
    const word = `@${hit} `;
    input.value = input.value.slice(0, start) + word + input.value.slice(input.selectionStart);
    const pos = start + word.length;
    input.setSelectionRange(pos, pos);
}

// ─── Windows over the chat: the rooms, the people ───────────

function rrcModal(id, title, body, onClose) {
    document.getElementById(id)?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'auto-reload-modal';
    overlay.id = id;
    overlay.innerHTML = `<div class="auto-reload-dialog rrc-people">
        <div class="dialog-header"><h3>${title}</h3>
            <button class="modal-close" data-close title="Close" aria-label="Close">&times;</button></div>${body}</div>`;
    const close = () => { overlay.remove(); document.removeEventListener('keydown', esc); if (onClose) onClose(); };
    const esc = e => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', e => { if (e.target === overlay || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', esc);
    document.body.appendChild(overlay);
    overlay.close = close;
    return overlay;
}

// The hub's public rooms: /list is asked, the answer fills the window.
function rrcShowRooms(hub) {
    const h = rrcHub(hub);
    const overlay = rrcModal('rrc-rooms-modal', `<span class="rrc-title-name" title="Rooms on ${rrcEsc((h && h.name) || 'this hub')}">${rrcEsc((h && h.name) || 'This hub')}</span> <span class="rrc-who-count"></span>`, `
        <input name="rrc-rooms-search" aria-label="Search rooms" type="text" class="rrc-who-search" placeholder="Search, or a room name + Enter to join" spellcheck="false" autocomplete="off">
        <div class="dialog-scroll rrc-who-list"></div>
        <div class="rrc-who-foot rrc-rooms-foot"><button class="msg-bar-btn" data-close>Close</button>
            <button class="msg-bar-btn" data-rrc-refresh>Ask again</button>
            <button class="msg-bar-btn primary" data-rrc-joinall title="/joinall: into every room of this hub, one every 1.5 s">Join all</button></div>`);
    overlay.dataset.hub = hub;
    const search = overlay.querySelector('.rrc-who-search');
    const join = async name => {
        const res = await rrcPost(`/api/rrc/join/${hub}`, { room: name });
        if (res.status !== 'success') { showNotification(rrcEsc(res.error), 'error', 4000); return; }
        overlay.close();
        await pollRrc();
        showRrcRoom(hub, res.room);
    };
    overlay.addEventListener('click', e => {
        const b = e.target.closest('[data-rrc-join]');
        const part = e.target.closest('[data-rrc-part]');
        if (b) join(b.dataset.rrcJoin);
        else if (part) rrcCloseWindow(hub, part.dataset.rrcPart).then(renderRrcRoomsModal);
        else if (e.target.closest('[data-rrc-goto]')) { overlay.close(); showRrcRoom(hub, e.target.closest('[data-rrc-goto]').dataset.rrcGoto); }
        else if (e.target.closest('[data-rrc-refresh]')) rrcPost(`/api/rrc/list/${hub}`);
        else if (e.target.closest('[data-rrc-joinall]')) {
            // Its progress goes to the window you are in on this hub, else the hub tab.
            const room = Rrc.active && Rrc.active.hub === hub ? Rrc.active.room : '';
            rrcPost(`/api/rrc/input/${hub}`, { room, text: '/joinall' }).then(res => {
                if (res.status === 'error') showNotification(rrcEsc(res.error), 'error', 4000);
                else { overlay.close(); pollRrc(); }
            });
        }
    });
    search.addEventListener('input', renderRrcRoomsModal);
    search.addEventListener('keydown', e => {
        const name = search.value.trim().replace(/^#/, '');
        if (e.key === 'Enter' && name) join(name);
    });
    renderRrcRoomsModal();
    rrcPost(`/api/rrc/list/${hub}`);
    search.focus();
}

function renderRrcRoomsModal() {
    const overlay = document.getElementById('rrc-rooms-modal');
    if (!overlay) return;
    const h = rrcHub(overlay.dataset.hub);
    const all = (h && h.room_list) || null;
    const words = overlay.querySelector('.rrc-who-search').value.toLowerCase().split(/\s+/).filter(Boolean);
    const mine = new Map(h ? h.rooms.filter(r => r.name).map(r => [r.name, r]) : []);
    // Your rooms first (private ones too: not in /list), then the public ones.
    const yours = [...mine.values()].filter(r => r.joined || r.leaving).map(r => ({ name: r.name, topic: r.topic }));
    const list = [...yours, ...(all || []).filter(p => !mine.has(p.name) || !(mine.get(p.name).joined || mine.get(p.name).leaving))]
        .filter(p => words.every(w => `${p.name} ${p.topic}`.toLowerCase().includes(w)));
    // Waiting for /list, then for the /who of each room: say so.
    overlay.querySelector('.rrc-who-count').textContent = all ? `(${all.length} ${all.length === 1 ? 'room' : 'rooms'})` : '(loading rooms…)';
    const buttons = name => {
        const r = mine.get(name);
        if (r && r.leaving) return '<span class="rrc-room-in">leaving…</span>';
        if (r && r.joined) return `<button class="msg-bar-btn" data-rrc-goto="${rrcEsc(name)}">Open</button>
            <button class="msg-bar-btn danger" data-rrc-part="${rrcEsc(name)}" title="/part #${rrcEsc(name)}: the tab closes when the hub answers">Part</button>`;
        return `<button class="msg-bar-btn primary" data-rrc-join="${rrcEsc(name)}">Join</button>`;
    };
    // "(N online)": from a silent /who per room after each /list (bots too).
    const users = (h && h.room_users) || {};
    const online = name => typeof users[name] === 'number'
        ? ` <span class="rrc-room-users">(${users[name]} online)</span>`
        : all ? ' <span class="rrc-room-users rrc-room-loading">(loading users…)</span>' : '';
    const html = list.length ? list.map(p => `<div class="rrc-room-row">
            <div class="rrc-room-text"><div><b>#${rrcEsc(p.name)}</b>${online(p.name)}</div>${p.topic ? `<span title="${rrcEsc(p.topic)}">${rrcEsc(p.topic)}</span>` : ''}</div>
            ${buttons(p.name)}</div>`).join('')
        : `<div class="rrc-who-empty">${!all ? 'Loading rooms…' : all.length ? 'Nothing matches: Enter joins that name' : 'No public rooms registered: type a name and Enter to join'}</div>`;
    const box = overlay.querySelector('.rrc-who-list');
    if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

// Who is in the room: /who is asked (its answer shows in the room too), the
// list is the room's people as the client has them. Click: names them.
function rrcShowWho(hub, room) {
    const overlay = rrcModal('rrc-who', `#${rrcEsc(room)} <span class="rrc-who-count"></span>`, `
        <input name="rrc-users-search" aria-label="Search users" type="text" class="rrc-who-search" placeholder="Search nick or hash" spellcheck="false" autocomplete="off">
        <div class="dialog-scroll rrc-who-list"></div>
        <div class="rrc-who-foot">Click: name them in the command line - right-click: their menu</div>`);
    overlay.dataset.hub = hub;
    overlay.dataset.room = room;
    overlay.addEventListener('contextmenu', e => {
        const row = e.target.closest('[data-rrc-who]');
        if (!row) return;
        e.preventDefault();
        e.stopPropagation();
        if (!Rrc.active || Rrc.active.hub !== hub || Rrc.active.room !== room) showRrcRoom(hub, room);
        rrcUserMenu(row, row.dataset.rrcWho, row.dataset.nick);
    });
    overlay.addEventListener('click', e => {
        const row = e.target.closest('[data-rrc-who]');
        if (!row) return;
        overlay.close();
        if (!Rrc.active || Rrc.active.hub !== hub || Rrc.active.room !== room) showRrcRoom(hub, room);
        const input = document.getElementById('rrc-input');
        const name = row.dataset.nick || row.dataset.rrcWho.slice(0, 12);
        input.value = rrcWithMention(input.value, name);
        input.focus();
    });
    const search = overlay.querySelector('.rrc-who-search');
    search.addEventListener('input', renderRrcWho);
    renderRrcWho();
    rrcPost(`/api/rrc/input/${hub}`, { room, text: `/who ${room}` }).then(() => pollRrc());
    search.focus();
}

function renderRrcWho() {
    const overlay = document.getElementById('rrc-who');
    if (!overlay) return;
    const { hub, room } = overlay.dataset;
    const r = rrcRoomOf(hub, room);
    const me = (rrcHub(hub) || {}).me;
    const label = m => m.nick || m.id.slice(0, 12);
    const rank = { o: 0, v: 1, '': 2 };
    const words = overlay.querySelector('.rrc-who-search').value.toLowerCase().split(/\s+/).filter(Boolean);
    const all = r ? [...r.members].sort((a, b) => rank[a.role || ''] - rank[b.role || '']
        || label(a).localeCompare(label(b), undefined, { sensitivity: 'base' })) : [];
    const list = all.filter(m => words.every(w => `${m.nick} ${m.id}`.toLowerCase().includes(w)));
    overlay.querySelector('.rrc-who-count').textContent = `(${all.length} ${all.length === 1 ? 'person' : 'people'})`;
    const html = list.length ? list.map(m => `<div class="rrc-who-row${m.id === me ? ' me' : ''}" data-rrc-who="${rrcEsc(m.id)}" data-nick="${rrcEsc(m.nick || '')}" title="${rrcEsc(m.id)}">
            <span class="rrc-user-icon" style="color:${m.id === me ? '#58a6ff' : rrcColor(m.id)}">${RRC_USER_ICON}</span>
            <span class="rrc-who-nick">${RRC_SIGN[m.role] || ''}${rrcEsc(label(m))}${m.id === me ? ' <i>(you)</i>' : ''}</span>
            <code>${rrcEsc(m.id.slice(0, 16))}${m.partial ? '…' : ''}</code></div>`).join('')
        : `<div class="rrc-who-empty">${all.length ? 'Nobody matches' : r && r.joined ? 'Asking the hub…' : 'Not in the room'}</div>`;
    const box = overlay.querySelector('.rrc-who-list');
    if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

// ─── A person: menu and info ────────────────────────────────

// "@nick " added to what is being typed: the form NomadNet counts as a
// mention (a bare "nick:" does not ring there).
function rrcWithMention(value, name) {
    const at = `@${name}`;
    return value.trim() ? `${value.replace(/\s*$/, ' ')}${at} ` : `${at} `;
}

// What can be done to someone, as rrcd allows it. The hub never says who is
// an operator: the moderation entries are always there, and the hub answers
// "not authorized" if you are not. Their @/+ is known only from /mode.
function rrcUserMenu(anchor, id, nick) {
    if (!Rrc.active || !id) return;
    const { hub, room } = Rrc.active;
    const h = rrcHub(hub);
    const isMe = !!h && id === h.me;
    const r = room ? rrcRoomOf(hub, room) : null;
    const member = r ? r.members.find(m => m.id === id || id.startsWith(m.id) || m.id.startsWith(id)) : null;
    const role = member ? member.role : '';
    const name = nick || (member && member.nick) || id.slice(0, 12);
    // For the hub always the hash, never the nick: rrcd finds a nick only
    // among the people connected (an unban after they left answered "target
    // not found"), and two people can share one ("Anonymous Peer").
    const target = id;
    const ignored = !!(Rrc.state && Rrc.state.ignored && id in Rrc.state.ignored);
    const run = text => rrcRun(text);
    const mod = (label, cmd, tip, danger) => ({ label, danger, run: () => run(cmd), tip: `${tip} (${cmd.split(' ')[0]})` });
    const actions = [
        { label: 'Info', run: () => rrcUserInfo(hub, id, name), tip: 'Show the details of this person' },
        { label: 'Mention', disabled: isMe || !room, run: () => {
            const input = document.getElementById('rrc-input');
            input.value = rrcWithMention(input.value, name);
            input.focus();
        }, tip: 'Add @nick of this person to your message' },
        { label: 'Message on LXMF', disabled: id.length !== 32 || isMe, run: () => rrcUserInfo(hub, id, name, 'lxmf'),
          tip: id.length === 32 ? 'Write a private LXMF message to this person' : 'Their full address is not known yet' },
        { label: 'Copy nick', disabled: !nick && !(member && member.nick), run: () => copyText(name, 'Nick copied'),
          tip: 'Copy the nick of this person' },
        { label: 'Copy identity hash', run: () => copyText(id, 'Identity hash copied'), tip: 'Copy the identity of this person' },
        { label: ignored ? 'Stop ignoring' : 'Ignore', disabled: isMe || !!window.rbGuest, danger: !ignored,
          run: () => rrcPost('/api/rrc/ignore', { id, on: !ignored, nick: name }).then(res => {
              if (res.status === 'success') showNotification(ignored ? `${rrcEsc(name)}: shown again` : `${rrcEsc(name)} ignored: their lines are hidden, on every hub`, 'info', 4000);
              else showNotification(rrcEsc(res.error), 'error', 4000);
              pollRrc();
          }), tip: ignored ? 'Show the messages of this person again' : 'Hide the messages of this person, only for you' },
    ];
    if (room) {
        actions.push('-', { group: 'Room operator (the hub refuses if you are not)' },
            role === 'o' ? mod(isMe ? 'Deop yourself' : 'Deop', `/mode ${room} -o ${target}`, isMe ? 'Stop being operator of this room' : 'Remove operator from this person')
                : mod('Op', `/mode ${room} +o ${target}`, 'Make this person operator of the room'),
            role === 'v' ? mod(isMe ? 'Devoice yourself' : 'Devoice', `/mode ${room} -v ${target}`, isMe ? 'Remove your voice in this room' : 'Remove voice from this person')
                : mod('Voice', `/mode ${room} +v ${target}`, 'Let this person talk in a moderated room'));
        if (!isMe) {
            actions.push(mod('Kick', `/kick ${room} ${target}`, 'Remove this person from the room', true),
                mod('Ban', `/ban ${room} add ${target}`, 'Ban this person from the room', true),
                mod('Unban', `/ban ${room} del ${target}`, 'Remove the ban of this person'),
                mod('Invite', `/invite ${room} add ${target}`, 'Invite this person to the room'));
        }
    }
    if (!isMe && id.length === 32) {
        actions.push({ group: 'Server operator' }, mod('K-line', `/kline add ${id}`, 'Ban this person from the whole hub', true));
    }
    openNodeMenu(anchor, (RRC_SIGN[role] || '') + name + (isMe ? ' (you)' : ''), id, actions);
}

// Everything known about a person: RRC (nick and rooms on every open hub)
// and, from the same identity, their LXMF address, NomadNet node and RRC hub
// as Reticulum knows them. Nothing is sent to ask. then: 'lxmf' opens the
// messenger straight away.
async function rrcUserInfo(address, id, nick, then) {
    let d;
    try { d = await fetch(`/api/rrc/peer/${address}/${id}`).then(r => r.json()); } catch (e) { d = { status: 'error', error: e.message }; }
    if (then === 'lxmf' && d.status === 'success' && d.lxmf) { openMessenger(d.lxmf.address); return; }
    const overlay = rrcModal('rrc-info', `<span class="rrc-user-icon" style="color:${rrcColor(id)}">${RRC_USER_ICON}</span> ${rrcEsc(nick || id.slice(0, 12))}`,
        '<div class="dialog-scroll rrc-info-body"></div>');
    overlay.querySelector('.auto-reload-dialog').classList.replace('rrc-people', 'rrc-info');
    const body = overlay.querySelector('.rrc-info-body');
    if (d.status !== 'success') { body.innerHTML = `<div class="rrc-who-empty">${rrcEsc(d.error || 'Not available')}</div>`; return; }
    const yes = (ok, a = 'yes', b = 'no') => ok ? `<span class="rrc-info-yes">${a}</span>` : `<span class="rrc-info-no">${b}</span>`;
    const row = (k, v) => `<div class="rrc-info-row"><span>${k}</span><span>${v}</span></div>`;
    const hash = h => `<code class="rrc-info-hash" data-copy="${rrcEsc(h)}" title="Click to copy">${rrcEsc(h)}</code>`;
    const path = x => x.path ? `${x.hops != null ? `${x.hops} hop${x.hops === 1 ? '' : 's'}` : 'known'}` : '<span class="rrc-info-no">none</span>';
    const btn = (act, label) => `<button class="msg-bar-btn" data-act="${act}">${label}</button>`;
    let html = '<div class="settings-subhead">RRC</div>'
        + row('Identity', hash(d.id) + (d.me ? ' <i>(you)</i>' : ''))
        + (d.hubs.length ? d.hubs.map(h => row(rrcEsc(h.name || h.address.slice(0, 12)),
            `${h.nick ? `<b>${rrcEsc(h.nick)}</b>` : '<span class="rrc-info-no">no nick</span>'}${h.rooms.length ? ' in ' + rrcEsc(h.rooms.map(r => '#' + r).join(' ')) : ''}`)).join('')
            : row('Seen', '<span class="rrc-info-no">not in a room you are in</span>'))
        + row('Ignored', yes(d.ignored));
    if (!d.full) {
        html += '<div class="rrc-info-note">Only the first 12 characters of the hash are known (from /who): the rest comes when they talk.</div>';
    } else {
        const l = d.lxmf, n = d.nomadnet, h = d.rrc_hub;
        html += '<div class="settings-subhead">Reticulum</div>'
            + row('Public key', yes(d.keys_known, 'known', 'not known yet'))
            + '<div class="settings-subhead">LXMF</div>'
            + row('Address', hash(l.address))
            + (l.name ? row('Name', rrcEsc(l.name)) : '')
            + row('Announced', yes(l.announced)) + row('Path', path(l))
            + `<div class="rrc-info-row" data-check-out="lxmf" hidden><span>Check</span><span></span></div>`
            + row('Conversation', l.conversation ? `yes${l.unread ? `, <b>${l.unread} unread</b>` : ''}` : '<span class="rrc-info-no">none</span>')
            + '<div class="settings-subhead">NomadNet node</div>'
            + row('Address', hash(n.address))
            + (n.name ? row('Name', rrcEsc(n.name)) : '')
            + row('Announced', yes(n.announced || !!n.name)) + row('Path', path(n))
            + `<div class="rrc-info-row" data-check-out="node" hidden><span>Check</span><span></span></div>`
            + (h.announced ? '<div class="settings-subhead">RRC hub</div>' + row('Address', hash(h.address))
                + (h.name ? row('Name', rrcEsc(h.name)) : '') + row('Path', path(h)) : '');
        // A node is visited only once it is known to be one: heard, or
        // checked here (a path request, then a link). Every identity has the
        // addresses on paper; only the programs that run answer on them.
        const nodeKnown = n.announced || !!n.name;
        html += `<div class="rrc-info-actions">
            ${d.me ? '' : btn('check-lxmf', 'Check LXMF')}
            ${nodeKnown ? btn('node', 'Visit node') : btn('check-node', 'Check node')}
            ${h.announced ? btn('hub', 'Connect to their hub') : ''}</div>`;
        html += '<div class="rrc-info-note">The addresses follow from the identity; only the programs that run answer on them. Check asks the network.</div>';
    }
    body.innerHTML = html;
    overlay.addEventListener('click', e => {
        const c = e.target.closest('[data-copy]');
        if (c) { copyText(c.dataset.copy, 'Copied'); return; }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const a = act.dataset.act;
        if (a === 'check-lxmf' || a === 'check-node') { rrcCheckAddress(overlay, d, act); return; }
        overlay.close();
        if (a === 'lxmf') openMessenger(d.lxmf.address);
        else if (a === 'node') { closeRrc(); openQuickAddress(`${d.nomadnet.address}:/page/index.mu`, d.nomadnet.name || '', true); }
        else if (a === 'hub') openRrcAddress(d.rrc_hub.address);
    });
}

// Check in the info window: is anyone answering on their LXMF address or
// node? One path request (the answer can only come from that destination:
// the address follows from their key); for the node then a link, as Ping
// does. While it asks, a spinning circle on the button; when they answer
// the button becomes the action: Send LXMF, Visit node.
async function rrcCheckAddress(overlay, d, button) {
    const node = button.dataset.act === 'check-node';
    const address = node ? d.nomadnet.address : d.lxmf.address;
    const label = button.textContent;
    const out = overlay.querySelector(`[data-check-out="${node ? 'node' : 'lxmf'}"]`);
    const show = html => { out.hidden = false; out.lastElementChild.innerHTML = html; };
    const busy = text => { button.disabled = true; button.innerHTML = `<span class="rrc-spin"></span>${text}`; };
    const failed = html => { show(html); button.disabled = false; button.textContent = label; };
    const answered = (html, act, text) => {
        show(html);
        button.disabled = false;
        button.dataset.act = act;
        button.textContent = text;
        button.classList.add('primary');
    };
    busy('Checking…');
    show('asking the network…');
    const post = url => fetch(url, { method: 'POST' }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
    const found = await post(`/api/lxmf-check/${address}?timeout=20`);
    if (found.status !== 'success' || !found.reachable) {
        failed(`<span class="rrc-info-no">no answer${found.elapsed ? ` in ${Math.round(found.elapsed)} s` : ''} (${node ? 'no node' : 'nobody listening'}, or off)</span>`);
        return;
    }
    if (!node) {
        answered('<span class="rrc-info-yes">answers</span>', 'lxmf', 'Send LXMF');
        return;
    }
    busy('Opening a link…');
    show('path found, opening a link…');
    const ping = await post(`/api/ping/${address}`);
    if (ping.status !== 'success') {
        failed(`<span class="rrc-info-no">path found, no link</span>`);
        return;
    }
    answered(`<span class="rrc-info-yes">node answers</span>${ping.rtt != null ? ` in ${Math.round(ping.rtt * 1000)} ms` : ''}`,
             'node', 'Visit node');
}

// Your nick on this hub: /nick, saved in Settings > RRC Client > Saved hubs (empty:
// back to the Default nick, or to the hash if that is off).
function rrcNickDialog(hub) {
    const h = rrcHub(hub);
    const guest = !!window.rbGuest;
    const fallback = guest ? 'your guest name' : h && h.nick_source === 'default' ? `the Default nick` : 'hash only (Default nick off)';
    const overlay = rrcModal('rrc-nick', guest ? 'Your nick' : `Nick on ${rrcEsc((h && h.name) || 'this hub')}`, `
        <input name="rrc-hub-nick" aria-label="Nick on this hub" type="text" class="rrc-who-search" maxlength="64" placeholder="Empty: ${rrcEsc(fallback)}" spellcheck="false" autocomplete="off">
        <div class="rrc-who-foot">${guest ? 'On every hub you are on, until you leave. The others see it from your next message.'
            : 'Only on this hub, saved in Settings > RRC Client > Saved hubs. A label: hubs know you by your identity, and show the new nick from your next message.'}
            <button class="msg-bar-btn primary" data-ok>Set</button></div>`);
    const field = overlay.querySelector('input');
    field.value = (h && (h.nick_source === 'hub' || h.nick_source === 'guest') && h.nick) || '';
    const ok = async () => {
        const res = await rrcPost(`/api/rrc/input/${hub}`, { room: Rrc.active ? Rrc.active.room : '', text: `/nick ${field.value.trim()}` });
        if (res.status !== 'success') { showNotification(rrcEsc(res.error), 'error', 4000); return; }
        overlay.close();
        pollRrc();
    };
    overlay.querySelector('[data-ok]').addEventListener('click', ok);
    field.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    field.focus();
    field.select();
}

// A link in a line: a room is joined (or shown), lxmf@ opens the messenger,
// a NomadNet address opens in a new tab.
function rrcLinkTarget(link) {
    if (link.dataset.rrcLxmf) return { kind: 'lxmf', address: link.dataset.rrcLxmf };
    if (link.dataset.rrcUrl) return { kind: 'rrc', address: link.dataset.rrcUrl };
    if (link.dataset.rrcPage) {
        const p = link.dataset.rrcPage;
        return { kind: 'page', address: p.includes(':') ? p : `${p}:/page/index.mu` };
    }
    return null;
}

async function rrcOpenLink(link) {
    const target = rrcLinkTarget(link);
    if (target) {
        // A page opens in the main page: here, the chat steps aside for it.
        if (target.kind === 'page' && !APP_WINDOW) closeRrc();
        openLinkTarget(target);
        return;
    }
    const room = link.dataset.rrcRoom;
    if (!room || !Rrc.active) return;
    const hub = Rrc.active.hub;
    const r = rrcRoomOf(hub, room);
    if (r && r.joined) { showRrcRoom(hub, room); return; }
    const res = await rrcPost(`/api/rrc/join/${hub}`, { room });
    if (res.status !== 'success') { showNotification(rrcEsc(res.error), 'error', 4000); return; }
    await pollRrc();
    showRrcRoom(hub, res.room);
}

// What the colours and signs in the chat mean.
function rrcShowLegend() {
    const row = (sample, text) => `<div class="rrc-legend-row"><span class="rrc-legend-sample">${sample}</span><span>${text}</span></div>`;
    const nicks = ['mark', 'burger', 'qbit'].map((n, i) =>
        `<span style="color:${rrcColor(['b1', 'c2', 'd3'][i].repeat(16))}">&lt;${n}&gt;</span>`).join(' ');
    const overlay = rrcModal('rrc-legend', 'RRC chat: what the colours mean', `<div class="dialog-scroll">
        <div class="settings-subhead">People</div>
        ${row(nicks, 'A colour per person, from their identity hash: the same person keeps it on every hub, whatever the nick. Two people can share a colour - the hash (hover the nick) tells them apart.')}
        ${row('<span style="color:#58a6ff">&lt;you&gt;</span>', 'You, always blue.')}
        ${row('<span class="rrc-action-sample">* mark waves</span>', 'An action (/me), in the person\'s colour.')}
        ${row('<span>@ +</span>', 'Operator and voice: shown only after the hub announces them (/mode +o, +v). The hub never says who already is.')}
        <div class="settings-subhead">Lines</div>
        ${row('<span style="color:#d670d6">· Connected…</span>', 'From the link and rBrowser: connecting, pongs, commands you sent.')}
        ${row('<span style="color:#e3b341">ℹ Welcome…</span>', 'A notice from the hub: welcome, room info, topics, answers to commands.')}
        ${row('<span style="color:#ff7b72">! Error</span>', 'Something refused or failed.')}
        ${row('<span><span style="color:#3fb950">→</span> <span style="color:#6e7681">alice joined</span></span>', 'Someone came in; ← someone left.')}
        ${row('<span style="color:#6e7681">⇄ → a, b joined · ← c left</span>', 'Several in a row, on one line (Settings: Compact joins and parts).')}
        ${row('<span class="rrc-legend-mention">&lt;qbit&gt; @you look</span>', 'You were named (@nick), or a highlight word was written.')}
        ${row('<span style="color:#f85149">── 3 new ──</span>', 'Where the news starts since you last looked at the room.')}
        <div class="settings-subhead">Tabs and the hub list</div>
        ${row('<span class="rrc-dot" style="display:inline-block"></span> <b>#room</b>', 'New messages; the dot is orange when you were named.')}
        ${row(`<span class="rrc-tab-users">${RRC_USER_ICON}6</span>`, 'People in the room.')}
        ${row('<span style="color:#6e7681;font-style:italic">#radio</span>', 'A room you are not in now (left, leaving, refused, or the link is down).')}
        ${row('<span class="bbs-state bbs-state-connected" style="display:inline-block"></span> <span class="bbs-state bbs-state-connecting" style="display:inline-block"></span> <span class="bbs-state bbs-state-failed" style="display:inline-block"></span>', 'Hub connected, connecting, failed.')}
        </div>`);
    overlay.querySelector('.auto-reload-dialog').classList.replace('rrc-people', 'rrc-legend');
}

// ─── Room and hub menus ─────────────────────────────────────

// A line to type, in a small window: resolves the text, or null.
function rrcAsk(title, hint, placeholder) {
    return new Promise(resolve => {
        let done = false;
        const overlay = rrcModal('rrc-ask', rrcEsc(title), `
            ${hint ? `<div class="settings-hint">${hint}</div>` : ''}
            <input name="rrc-ask" aria-label="${rrcEsc(title)}" type="text" class="rrc-who-search" placeholder="${rrcEsc(placeholder || '')}" spellcheck="false" autocomplete="off">
            <div class="rrc-who-foot"><button class="msg-bar-btn primary" data-ok>OK</button></div>`,
            () => { if (!done) resolve(null); });
        const field = overlay.querySelector('input');
        const ok = () => { const v = field.value.trim(); if (!v) return; done = true; overlay.close(); resolve(v); };
        overlay.querySelector('[data-ok]').addEventListener('click', ok);
        field.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
        field.focus();
    });
}

// Run a line in a window that may not be on screen.
async function rrcRunIn(hub, room, text) {
    if (!Rrc.active || Rrc.active.hub !== hub || Rrc.active.room !== room) showRrcRoom(hub, room);
    return rrcRun(text);
}

// What the room can do, as rrcd's commands: anyone (topic, who, ban list),
// then the operator's (the hub refuses if you are not one; it never says who
// is). The modes ticked are the ones the hub said at the join.
function rrcRoomMenu(anchor, hub, room) {
    const h = rrcHub(hub);
    const r = rrcRoomOf(hub, room);
    if (!h || !r) return;
    const on = h.state === 'connected';
    const run = text => rrcRunIn(hub, room, text);
    const modes = r.modes || '';
    const ask = (title, hint, placeholder, make) => async () => {
        const v = await rrcAsk(title, hint, placeholder);
        if (v) run(make(v));
    };
    const flag = (f, label, tip) => ({ label, check: modes.includes(f), tip, disabled: !on,
        run: () => run(`/mode ${room} ${modes.includes(f) ? '-' : '+'}${f}`) });
    const actions = [
        { label: 'Who is in the room', disabled: !on || !r.joined, run: () => rrcShowWho(hub, room),
          tip: 'Show the people in this room' },
        { label: 'Topic', disabled: !on, run: () => run(`/topic ${room}`), tip: 'Show the topic of this room' },
        { label: 'Ban list', disabled: !on, run: () => run(`/ban ${room} list`), tip: 'Show who is banned from this room' },
        { label: 'Copy the room link', run: () => copyText(`rrc://${hub}/${room}`, 'Room link copied'), tip: 'Copy the link of this room' },
        r.joined ? { label: `Part #${room}`, run: () => rrcCloseWindow(hub, room), tip: 'Leave this room' }
            : { label: `Join #${room}`, disabled: !on, run: () => rrcPost(`/api/rrc/join/${hub}`, { room }).then(pollRrc),
                tip: 'Join this room' },
        '-', { group: 'Operator (the hub refuses if you are not)' },
        { label: 'Set the topic…', disabled: !on, run: ask(`Topic of #${room}`, '', 'New topic', v => `/topic ${room} ${v}`),
          tip: 'Change the topic of this room' },
        flag('m', 'Moderated (+m)', 'Only operators and voiced people can talk'),
        flag('i', 'Invite only (+i)', 'Only invited people can join'),
        flag('t', 'Topic by operators only (+t)', 'Only operators can change the topic'),
        flag('n', 'No messages from outside (+n)', 'Only people in the room can write to it'),
        flag('p', 'Private (+p)', 'Hide this room from the room list'),
        modes.includes('k')
            ? { label: 'Remove the key (-k)', check: true, disabled: !on, run: () => run(`/mode ${room} -k`),
                tip: 'Remove the password of this room' }
            : { label: 'Set a key (+k)…', check: false, disabled: !on, run: ask(`Key of #${room}`, 'A password to join the room.', 'Key', v => `/mode ${room} +k ${v}`),
                tip: 'Set a password to join this room' },
        { label: 'Register the room', disabled: !on, run: () => run(`/register ${room}`), tip: 'Make the hub keep this room and its settings' },
        { label: 'Unregister the room', disabled: !on, danger: true, run: () => run(`/unregister ${room}`),
          tip: 'Stop the hub keeping this room' },
        { label: 'Invite someone…', disabled: !on, run: ask('Invite', `To #${rrcEsc(room)}: a nick or a hash.`, 'nick', v => `/invite ${room} add ${v}`),
          tip: 'Invite a person to this room' },
        { label: 'Invite list', disabled: !on, run: () => run(`/invite ${room} list`), tip: 'Show who is invited to this room' },
        { label: 'Unban…', disabled: !on, run: ask('Unban', `In #${rrcEsc(room)}: a nick or a hash from the ban list.`, 'hash', v => `/ban ${room} del ${v}`),
          tip: 'Remove a ban from this room' },
    ];
    openNodeMenu(anchor, `#${room}${modes ? ' ' + modes : ''}`, h.name || hub, actions);
}

function rrcHubMenu(anchor, hub) {
    const h = rrcHub(hub);
    if (!h) return;
    const on = h.state === 'connected';
    const run = text => rrcRunIn(hub, '', text);
    const actions = [
        { label: 'Rooms', disabled: !on, run: () => rrcShowRooms(hub), tip: 'Show the rooms of this hub' },
        { label: 'Join a room…', disabled: !on, run: async () => {
            const v = await rrcAsk('Join a room', '', 'general');
            if (!v) return;
            const res = await rrcPost(`/api/rrc/join/${hub}`, { room: v });
            if (res.status !== 'success') { showNotification(rrcEsc(res.error), 'error', 4000); return; }
            await pollRrc();
            showRrcRoom(hub, res.room);
        }, tip: 'Join a room by its name' },
        { label: 'Ping', disabled: !on, run: () => run('/ping'), tip: 'Check if this hub answers' },
        { label: 'Nick…', run: () => rrcNickDialog(hub),
          tip: window.rbGuest ? 'Change your nick on all your hubs' : 'Change your nick on this hub' },
        { label: 'Copy the hub address', run: () => copyText(hub, 'Hub address copied'), tip: 'Copy the address of this hub' },
        { label: 'Copy your identity hash', run: () => copyText(h.me, 'Your identity hash copied'), tip: 'Copy your identity on this hub' },
        { label: 'What the colours mean', run: rrcShowLegend, tip: 'Show what the colours in the chat mean' },
        on || h.state === 'connecting' ? { label: 'Disconnect', run: () => rrcPost(`/api/rrc/disconnect/${hub}`).then(pollRrc),
                                           tip: 'Disconnect from this hub' }
            : { label: 'Connect', run: () => rrcConnect(hub), tip: 'Connect to this hub' },
        { label: 'Close the hub', danger: true, run: () => rrcCloseWindow(hub, ''), tip: 'Disconnect and close this hub with its rooms' },
        '-', { group: 'Server operator (the hub refuses if you are not)' },
        { label: 'Hub statistics', disabled: !on, run: () => run('/stats'), tip: 'Show the statistics of this hub' },
        { label: 'K-line list', disabled: !on, run: () => run('/kline list'), tip: 'Show who is banned from the whole hub' },
        { label: 'K-line someone…', disabled: !on, danger: true, run: async () => {
            const v = await rrcAsk('K-line', 'Banned from the whole hub: a nick or a hash.', 'nick or hash');
            if (v) run(`/kline add ${v}`);
        }, tip: 'Ban a person from the whole hub' },
        { label: 'Remove a K-line…', disabled: !on, run: async () => {
            const v = await rrcAsk('Remove a K-line', 'A hash from the K-line list.', 'hash');
            if (v) run(`/kline del ${v}`);
        }, tip: 'Remove a ban from the whole hub' },
        { label: 'Reload the hub configuration', disabled: !on, danger: true, run: async () => {
            if (await confirmDialog('Reload the hub?', 'The hub reads its configuration and rooms again (/reload).', 'Reload')) run('/reload');
        }, tip: 'Make the hub read its configuration again' },
    ];
    openNodeMenu(anchor, h.name || 'RRC hub', on ? 'connected' : 'not connected', actions);
}

// ─── The command list (typing "/" or the / button) ──────────
// [name, arguments, what it does, who can: '' rBrowser itself, 'hub' anyone
// (the hub answers), 'op' a room operator, 'sop' a server operator]. The
// commands of rrcd 0.3.2.
// The hub's ones are rrcd 0.3.2's (commands.py), with its own arguments and
// rights: 'hub' anyone, 'op' a room operator, 'founder' the room's founder,
// 'sop' a server operator (who is in trusted_identities). A server operator
// is also an operator in every room.
const RRC_COMMANDS = [
    ['join', '<room> [key]', 'Join a room (also /j)'],
    ['j', '<room> [key]', 'Join a room (short for /join)'],
    ['part', '[room]', 'Leave a room (this one if none)'],
    ['leave', '[room]', 'Leave a room (same as /part)'],
    ['me', '<text>', 'An action: "* you waves"'],
    ['nick', '[name]', 'Your nick here (empty: the Settings one)'],
    ['ping', '', 'Round trip to the hub'],
    ['notice', '<text>', 'A notice in this room'],
    ['noticeall', '<text>', 'A notice in all your rooms on this hub'],
    ['joinall', '', 'Join every room of this hub, one every 1.5 s'],
    ['rejoin', '[room] [key]', 'Leave the room (this one if none) and join it again'],
    ['clear', '', 'Clear this window'],
    ['help', '', 'All the commands'],
    ['connect', '', 'Connect to the hub again'],
    ['quit', '', 'Close the link to the hub'],
    ['disconnect', '', 'Close the link to the hub (same as /quit)'],
    ['who', '[room]', 'Who is in the room', 'hub'],
    ['names', '[room]', 'Who is in the room (same as /who)', 'hub'],
    ['list', '', 'The public rooms of this hub', 'hub'],
    ['topic', '<room> [text]', 'Read or set the topic', 'hub'],
    ['mode', '<room> <+-m|i|t|n|p|k> [key]', 'Room modes (m i t n p k)', 'op'],
    ['mode', '<room> <+-o|v> <nick|hash>', 'Op or voice, told to the room', 'op'],
    ['op', '<room> <nick|hash>', 'Make an operator (quietly)', 'op'],
    ['deop', '<room> <nick|hash>', 'Take operator away', 'op'],
    ['voice', '<room> <nick|hash>', 'Let talk when moderated', 'op'],
    ['devoice', '<room> <nick|hash>', 'Take voice away', 'op'],
    ['kick', '<room> <nick|hash>', 'Remove from the room', 'op'],
    ['ban', '<room> list', 'The room\'s ban list', 'hub'],
    ['ban', '<room> add|del <nick|hash>', 'Ban or lift (absent: full hash)', 'op'],
    ['unban', '[room] <nick|hash>', 'Lift a ban (= /ban room del)', 'op'],
    ['invite', '<room> add|del|list [nick|hash]', 'Invite list (rooms +i)', 'op'],
    ['register', '<room>', 'The hub keeps the room', 'founder'],
    ['unregister', '<room>', 'Unregister the room', 'founder'],
    ['kline', 'add|del|list [nick|hash]', 'Ban from the whole hub', 'sop'],
    ['unkline', '<nick|hash>', 'Lift a K-line (= /kline del)', 'sop'],
    ['stats', '', 'Hub statistics', 'sop'],
    ['reload', '', 'Reload the hub configuration', 'sop'],
];
const RRC_CMD_WHO = { hub: 'hub', op: 'operator', founder: 'founder', sop: 'server op' };

// all: the whole list (the / button), whatever the line holds.
function renderRrcCommands(all = false) {
    const input = document.getElementById('rrc-input');
    const box = document.getElementById('rrc-cmds');
    if (!input || !box) return;
    const m = all ? [null, ''] : input.value.match(/^\/(\w*)$/);
    if (!m) { renderRrcMentions(input, box); return; }
    const list = RRC_COMMANDS.filter(c => c[0].startsWith(m[1].toLowerCase()));
    box.hidden = !list.length;
    if (!list.length) return;
    Rrc.cmdAt = 0;
    box.innerHTML = list.map((c, i) => `<div class="rrc-cmd${i === 0 ? ' active' : ''}${c[3] ? ` rrc-cmd-${c[3]}` : ''}" data-rrc-cmd="${c[0]}" role="option" title="/${c[0]} ${rrcEsc(c[1])}">
        <span class="rrc-cmd-name">/${c[0]}</span><span class="rrc-cmd-args">${rrcEsc(c[1])}</span>
        <span class="rrc-cmd-what">${rrcEsc(c[2])}${c[3] ? ` <i>${RRC_CMD_WHO[c[3]]}</i>` : ''}</span></div>`).join('');
}

// "@" typed (at the start or after a space): the people of the room whose
// nick starts with what follows, then those that contain it; you not listed.
function renderRrcMentions(input, box) {
    const before = input.value.slice(0, input.selectionStart ?? input.value.length);
    const m = before.match(/(?:^|\s)@([^\s@]*)$/);
    const r = m && Rrc.active && Rrc.active.room ? rrcRoomOf(Rrc.active.hub, Rrc.active.room) : null;
    const me = Rrc.active ? (rrcHub(Rrc.active.hub) || {}).me : '';
    if (!r) { box.hidden = true; box.innerHTML = ''; return; }
    const part = m[1].toLowerCase();
    const name = x => x.nick || x.id.slice(0, 12);
    const people = r.members.filter(x => x.id !== me);
    const starts = people.filter(x => name(x).toLowerCase().startsWith(part));
    const has = people.filter(x => !starts.includes(x) && name(x).toLowerCase().includes(part));
    const by = (a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: 'base' });
    const list = [...starts.sort(by), ...has.sort(by)].slice(0, 30);
    box.hidden = !list.length;
    if (!list.length) { box.innerHTML = ''; return; }
    Rrc.cmdAt = 0;
    box.innerHTML = list.map((x, i) => `<div class="rrc-cmd rrc-at-row${i === 0 ? ' active' : ''}" data-rrc-at="${rrcEsc(name(x))}" role="option" title="${rrcEsc(x.id)}">
        <span class="rrc-user-icon" style="color:${rrcColor(x.id)}">${RRC_USER_ICON}</span>
        <span class="rrc-cmd-name">${RRC_SIGN[x.role] || ''}${rrcEsc(name(x))}</span><code>${rrcEsc(x.id.slice(0, 8))}</code></div>`).join('');
}

// The "@part" being typed becomes "@nick ".
function rrcPickMention(nick) {
    const input = document.getElementById('rrc-input');
    const at = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, at).replace(/@[^\s@]*$/, `@${nick} `);
    input.value = before + input.value.slice(at).replace(/^\S*\s?/, '');
    input.setSelectionRange(before.length, before.length);
    document.getElementById('rrc-cmds').hidden = true;
    input.focus();
}

// Clicked, a command with nothing to add goes at once (no arguments, or
// [room] while in a room); the others wait in the line, the room on screen
// already filled in where a room comes first.
function rrcPickCommand(name, clicked = false) {
    const input = document.getElementById('rrc-input');
    const box = document.getElementById('rrc-cmds');
    const c = RRC_COMMANDS.find(x => x[0] === name);
    const room = Rrc.active && Rrc.active.room;
    box.hidden = true;
    if (clicked && c && (c[1] === '' || (c[1] === '[room]' && room))) {
        input.value = `/${name}`;
        rrcSend();
        input.focus();
        return;
    }
    const fill = c && room && name !== 'join' && /^(<room>|\[room\])/.test(c[1]) ? `${room} ` : '';
    input.value = `/${name} ${fill}`;
    input.setSelectionRange(input.value.length, input.value.length);
    input.focus();
}

// ─── Settings (the RRC part of the Settings dialog, in rbrowser.js) ──────

async function loadRrcSettings() {
    let st;
    try { st = await fetch('/api/rrc').then(r => r.json()); } catch (e) { return; }
    Rrc.state = st;
    // Save sends only what changed since (changedSettings, rbrowser.js).
    Rrc.loadedSettings = JSON.parse(JSON.stringify(st.settings || {}));
    const toggle = document.getElementById('setting-rrc-enabled');
    if (toggle) {
        toggle.classList.toggle('active', !!st.settings.enabled);
        toggle.dataset.loaded = '1';
    }
    const set = (id, on) => { const el = document.getElementById(id); if (el) el.classList.toggle('active', !!on); };
    set('setting-rrc-nick-on', !!st.settings.nick_on);
    set('setting-rrc-joins', st.settings.show_joins);
    set('setting-rrc-reconnect', st.settings.reconnect);
    set('setting-rrc-autoconnect', !!st.settings.autoconnect_all);
    set('setting-rrc-autoconnect-sel', st.settings.autoconnect_selected !== false);
    set('setting-rrc-rejoin', st.settings.rejoin_rooms !== false);
    set('setting-rrc-compact', !!st.settings.compact_joins);
    set('setting-rrc-colors', st.settings.show_colors !== false);
    set('setting-rrc-stickers', !!st.settings.stickers);
    set('setting-rrc-tg-stickers', !!st.settings.tg_stickers);
    rrcStickerSettingsWire();
    set('setting-rrc-markdown', st.settings.render_markdown !== false);
    set('setting-rrc-ts-desktop', st.settings.room_ts_desktop !== false);
    set('setting-rrc-ts-short', !!st.settings.room_ts_short);
    set('setting-rrc-ts-mobile', st.settings.room_ts_mobile !== false);
    set('setting-rrc-autoclose-nodes', st.settings.autoclose_nodes !== false);
    set('setting-rrc-notices-hub', !!st.settings.notices_to_hub);
    set('setting-rrc-show-auto', st.settings.show_auto !== false);
    set('setting-rrc-notify-mentions', st.settings.notify_mentions !== false);
    set('setting-rrc-notify-messages', !!st.settings.notify_messages);
    set('setting-rrc-notify-events', st.settings.notify_events !== false);
    set('setting-rrc-autoreply', !!st.settings.autoreply_on);
    set('setting-rrc-echo', !!st.settings.echo_on);
    set('setting-rrc-away-notice', !!st.settings.away_notice);
    set('setting-rrc-away-nick-on', !!st.settings.away_nick_on);
    set('setting-rrc-back-notice', !!st.settings.back_notice);
    const value = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    value('setting-rrc-rules', st.settings.autoreply_rules);
    value('setting-rrc-away-mode', st.settings.away_mode || 'off');
    value('setting-rrc-away-from', st.settings.away_from);
    value('setting-rrc-away-to', st.settings.away_to);
    value('setting-rrc-away-text', st.settings.away_text);
    value('setting-rrc-echo-text', st.settings.echo_text);
    value('setting-rrc-away-notice-text', st.settings.away_notice_text);
    value('setting-rrc-away-nick', st.settings.away_nick || '');
    value('setting-rrc-away-notice-every', String(st.settings.away_notice_every || 0));
    value('setting-rrc-font-size', String(st.settings.font_size || 13));
    value('setting-rrc-back-notice-text', st.settings.back_notice_text);
    value('setting-rrc-autoreply-scope', st.settings.autoreply_scope || 'all');
    const nick = document.getElementById('setting-rrc-nick');
    if (nick) nick.value = st.settings.nick || '';
    const words = document.getElementById('setting-rrc-highlight');
    if (words) words.value = st.settings.highlight || '';
    fillRrcIdentitySelect(st);
    const add = document.getElementById('setting-rrc-id-new');
    if (add) add.onclick = rrcNewIdentity;
    const del = document.getElementById('setting-rrc-id-delete');
    if (del) del.onclick = rrcDeleteIdentity;
    renderRrcHubSettings(st);
}

function fillRrcIdentitySelect(st) {
    const select = document.getElementById('setting-rrc-identity');
    if (!select) return;
    const keep = select.dataset.picked;     // a choice not saved yet stays
    select.innerHTML = (st.identities || []).map(i => `<option value="${rrcEsc(i.id)}" title="${rrcEsc(i.hash)}">${rrcEsc(i.name)} (${rrcEsc(i.hash.slice(0, 8))})${i.rrc ? ' - made for RRC' : ' - Messenger, can be written to on LXMF'}</option>`).join('');
    select.value = keep && (st.identities || []).some(i => i.id === keep) ? keep : st.settings.identity;
    select.onchange = () => { select.dataset.picked = select.value; };
}

// An identity imported, made, renamed or deleted in Settings > Identity while
// the dialog is open: Chat as and the hubs' boxes get the new list, the rest
// of the RRC settings (maybe edited, not saved) stays as it is.
async function refreshRrcIdentityChoices() {
    if (!document.getElementById('setting-rrc-identity')) return;
    let st;
    try { st = await fetch('/api/rrc').then(r => r.json()); } catch (e) { return; }
    if (!st || !st.settings) return;
    if (Rrc.state) Rrc.state.identities = st.identities;
    fillRrcIdentitySelect(st);
    renderRrcHubSettings(Rrc.state || st);
}

// Settings > RRC Client > Saved hubs: every hub you have been on, who you are there.
// Saved at once (each change is one hub's own), not with Save.
async function renderRrcHubSettings(st) {
    const box = document.getElementById('rrc-hub-settings');
    if (!box) return;
    let rows;
    try { rows = (await fetch('/api/rrc/hub-settings').then(r => r.json())).hubs || []; } catch (e) { return; }
    if (!rows.length) { box.innerHTML = '<div class="settings-hint">No hub yet: the ones you connect to appear here.</div>'; return; }
    const ids = (st && st.identities) || (Rrc.state && Rrc.state.identities) || [];
    // What an empty box means: the Default nick if it is on, else the hash.
    const s = (st && st.settings) || (Rrc.state && Rrc.state.settings) || {};
    const fallback = () => s.nick_on && s.nick ? `${s.nick} (Default nick)` : 'hash only (Default nick off)';
    // The identity of Chat as, as the hubs with no identity of their own use it.
    const chatAs = () => {
        const i = ids.find(x => x.id === s.identity) || ids.find(x => x.rrc);
        return i ? `${i.name} (${i.hash.slice(0, 8)})` : 'Chat as';
    };
    box.innerHTML = rows.map(r => `<div class="rrc-hubset-row" data-hub="${rrcEsc(r.address)}">
            <div class="rrc-hubset-name" title="${rrcEsc(r.address)}">${r.connected ? '<span class="bbs-state bbs-state-connected"></span>' : ''}${rrcEsc(r.name || 'Unnamed hub')}
                <code>${rrcEsc(r.address.slice(0, 12))}…</code></div>
            <select name="rrc-hub-identity" aria-label="Identity on this hub" class="settings-select rrc-hubset-id" title="Identity on this hub: one chosen for it, or the one of Chat as (it follows Chat as when that changes)">
                <option value="">${rrcEsc(chatAs())} · from Chat as</option>
                ${ids.map(i => `<option value="${rrcEsc(i.id)}"${r.identity === i.id ? ' selected' : ''}>${rrcEsc(i.name)} (${rrcEsc(i.hash.slice(0, 8))})</option>`).join('')}
            </select>
            <input name="rrc-hub-nick" aria-label="Nick on this hub" type="text" class="settings-input rrc-hubset-nick" maxlength="64" spellcheck="false" autocomplete="off"
                   value="${rrcEsc(r.nick)}" placeholder="${rrcEsc(fallback(r))}" title="Nick on this hub; empty: ${rrcEsc(fallback(r))}">
            <button type="button" class="msg-tab-close rrc-hubset-forget" title="Forget this hub: nick, identity and rooms (a favourite stays)">&times;</button>
        </div>`).join('');
    box.querySelectorAll('.rrc-hubset-row').forEach(row => {
        const hub = row.dataset.hub;
        const nick = row.querySelector('.rrc-hubset-nick');
        const save = async () => {
            if (nick.value === nick.defaultValue) return;
            const res = await rrcPost(`/api/rrc/hub-nick/${hub}`, { nick: nick.value });
            if (res.status !== 'success') { showNotification(rrcEsc(res.error), 'error', 4000); return; }
            nick.value = nick.defaultValue = res.nick;
            showNotification(`Nick on this hub: ${rrcEsc(res.label)}`, 'success', 3000);
        };
        nick.addEventListener('change', save);
        nick.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); nick.blur(); } });
        row.querySelector('.rrc-hubset-id').addEventListener('change', async e => {
            const res = await rrcPost(`/api/rrc/identity/${hub}`, { identity: e.target.value });
            if (res.status !== 'success') showNotification(rrcEsc(res.error), 'error', 4000);
        });
        row.querySelector('.rrc-hubset-forget').addEventListener('click', async () => {
            await rrcPost(`/api/rrc/hub-forget/${hub}`);
            renderRrcHubSettings(st);
        });
    });
}

// One more identity for RRC alone; it is picked in Chat as (Save keeps it).
async function rrcNewIdentity() {
    const overlay = rrcModal('rrc-id-new', 'New RRC identity', `
        <input name="rrc-hub-name" aria-label="Hub name" type="text" class="rrc-who-search" maxlength="40" placeholder="A name for it, only for you (e.g. Radio club)" spellcheck="false" autocomplete="off">
        <div class="rrc-who-foot">A new key: for the hubs a new person, with no ops or bans.
            <button class="msg-bar-btn primary" data-ok>Create</button></div>`);
    const field = overlay.querySelector('input');
    const ok = async () => {
        const res = await rrcPost('/api/rrc/identities', { name: field.value.trim() });
        if (res.status !== 'success') { showNotification(rrcEsc(res.error), 'error', 5000); return; }
        overlay.close();
        const select = document.getElementById('setting-rrc-identity');
        if (select) select.dataset.picked = res.id;
        await loadRrcSettings();
        showNotification(`New RRC identity ${rrcEsc(res.hash.slice(0, 12))}…: chosen in Chat as, Save to use it`, 'info', 5000);
    };
    overlay.querySelector('[data-ok]').addEventListener('click', ok);
    field.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    field.focus();
}

// The one chosen in Chat as, if it was made here (not the first RRC
// identity, not a Messenger one) and is not the one in use.
async function rrcDeleteIdentity() {
    const select = document.getElementById('setting-rrc-identity');
    const st = Rrc.state || {};
    const i = (st.identities || []).find(x => select && x.id === select.value);
    if (!i || !i.deletable) {
        showNotification('Pick in Chat as an identity made with New…: the first RRC identity and the Messenger ones cannot be deleted here', 'info', 6000);
        return;
    }
    if (i.id === st.settings.identity) {
        showNotification('It is the one in use: pick another in Chat as, Save, then delete it', 'info', 6000);
        return;
    }
    const ok = await confirmDialog('Delete this RRC identity?',
        `<b>${rrcEsc(i.name)}</b> <code>${rrcEsc(i.hash)}</code><br>The key is deleted for good: hubs will never know you by it again, the ops and bans they gave it are lost.`,
        'Delete');
    if (!ok) return;
    const res = await fetch(`/api/rrc/identities/${encodeURIComponent(i.id)}`, { method: 'DELETE' }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
    if (res.status !== 'success') { showNotification(rrcEsc(res.error), 'error', 6000); return; }
    delete select.dataset.picked;
    await loadRrcSettings();
    showNotification('RRC identity deleted', 'info', 3000);
}

function saveRrcSettings() {
    const toggle = document.getElementById('setting-rrc-enabled');
    if (!toggle || !toggle.dataset.loaded) return Promise.resolve();
    const on = id => { const el = document.getElementById(id); return !!(el && el.classList.contains('active')); };
    const select = document.getElementById('setting-rrc-identity');
    const nick = document.getElementById('setting-rrc-nick');
    const words = document.getElementById('setting-rrc-highlight');
    const changed = typeof changedSettings === 'function' ? changedSettings : f => f;
    const body = changed({
        enabled: toggle.classList.contains('active'),
        nick_on: on('setting-rrc-nick-on'),
        show_joins: on('setting-rrc-joins'),
        reconnect: on('setting-rrc-reconnect'),
        autoconnect_all: on('setting-rrc-autoconnect'),
        autoconnect_selected: on('setting-rrc-autoconnect-sel'),
        rejoin_rooms: on('setting-rrc-rejoin'),
        compact_joins: on('setting-rrc-compact'),
        show_colors: on('setting-rrc-colors'),
        stickers: on('setting-rrc-stickers'),
        tg_stickers: on('setting-rrc-tg-stickers'),
        render_markdown: on('setting-rrc-markdown'),
        room_ts_desktop: on('setting-rrc-ts-desktop'),
        room_ts_short: on('setting-rrc-ts-short'),
        room_ts_mobile: on('setting-rrc-ts-mobile'),
        autoclose_nodes: on('setting-rrc-autoclose-nodes'),
        notices_to_hub: on('setting-rrc-notices-hub'),
        show_auto: on('setting-rrc-show-auto'),
        notify_mentions: on('setting-rrc-notify-mentions'),
        notify_messages: on('setting-rrc-notify-messages'),
        notify_events: on('setting-rrc-notify-events'),
        autoreply_on: on('setting-rrc-autoreply'),
        echo_on: on('setting-rrc-echo'),
        away_notice: on('setting-rrc-away-notice'),
        away_nick_on: on('setting-rrc-away-nick-on'),
        back_notice: on('setting-rrc-back-notice'),
        ...Object.fromEntries([['autoreply_rules', 'setting-rrc-rules'], ['away_mode', 'setting-rrc-away-mode'],
                               ['away_from', 'setting-rrc-away-from'], ['away_to', 'setting-rrc-away-to'],
                               ['away_text', 'setting-rrc-away-text'], ['echo_text', 'setting-rrc-echo-text'],
                               ['away_notice_text', 'setting-rrc-away-notice-text'],
                               ['away_nick', 'setting-rrc-away-nick'],
                               ['away_notice_every', 'setting-rrc-away-notice-every'],
                               ['font_size', 'setting-rrc-font-size'],
                               ['back_notice_text', 'setting-rrc-back-notice-text'],
                               ['autoreply_scope', 'setting-rrc-autoreply-scope']]
            .filter(([, id]) => document.getElementById(id))
            .map(([key, id]) => [key, document.getElementById(id).value])),
        ...(words ? { highlight: words.value } : {}),
        ...(nick ? { nick: nick.value } : {}),
        ...(select && select.value ? { identity: select.value } : {}),
    }, Rrc.loadedSettings);
    if (!Object.keys(body).length) return Promise.resolve();
    return rrcPost('/api/rrc/settings', body).then(res => {
        if (res.status === 'error') showNotification(`RRC: ${rrcEsc(res.error)}`, 'error', 5000);
        // The dialog stays open: the next Save compares with what is saved now.
        else if (res.settings) Rrc.loadedSettings = JSON.parse(JSON.stringify(res.settings));
        pollRrc();
    });
}

startRrcPolling();

// ─── Colours and styles of a message, the emoji pages ──────

// rBrowser's own key in the message (K_FMT in rrc.py): [[start, length,
// style], ...] in characters of the text, beside the plain text, so other
// clients show it as it is. The style you pick stays on until Reset.
// The 16 of IRC, then some of mIRC's extended ones (16-98), by number.
const RRC_MIRC = Object.assign({}, ['#ffffff', '#000000', '#00007f', '#009300', '#ff0000', '#7f0000', '#9c009c', '#fc7f00',
    '#ffff00', '#00fc00', '#009393', '#00ffff', '#0000fc', '#ff00ff', '#7f7f7f', '#d2d2d2'],
    { 75: '#ff59bc', 73: '#c459ff', 71: '#59b4ff', 45: '#00b571', 65: '#ffb459', 41: '#b56300' });
const RRC_MIRC_NAMES = Object.assign({}, ['White', 'Black', 'Navy', 'Green', 'Red', 'Maroon', 'Purple', 'Orange',
    'Yellow', 'Lime', 'Teal', 'Cyan', 'Blue', 'Magenta', 'Grey', 'Light grey'],
    { 75: 'Pink', 73: 'Violet', 71: 'Sky', 45: 'Sea green', 65: 'Peach', 41: 'Brown' });
// The order in the palette (an object lists numbers in ascending order).
const RRC_MIRC_ORDER = [...Array(16).keys(), 75, 73, 71, 45, 65, 41];
// The effects: their colours, one after the other or blended.
const RRC_FX = {
    rainbow: ['#ff4d4d', '#ff9f1a', '#ffe14d', '#4dff88', '#4dd2ff', '#6b8cff', '#c46bff'],
    fire: ['#ff3b1f', '#ff6a00', '#ff9500', '#ffc300', '#ffe066'],
    ocean: ['#5fa8ff', '#00b4d8', '#48cae4', '#90e0ef', '#0096c7'],
    neon: ['#ff2bd6', '#00f0ff', '#b8ff00', '#ff8a00'],
    pastel: ['#ffb3ba', '#ffdfba', '#ffffba', '#baffc9', '#bae1ff', '#e0bbff'],
    matrix: ['#00ff41', '#00c832', '#39ff14', '#7dff9b'],
    sunset: ['#ff5e62', '#ff9966', '#ffcc70', '#c06c84', '#8f7bb5'],
    candy: ['#ff6fb5', '#ffd1e8', '#8fd3ff', '#c3a6ff'],
    gold: ['#d4a017', '#ffd700', '#fff3a0', '#ffc94d'],
    ice: ['#e0f7ff', '#a8e6ff', '#6fd3ff', '#3fb8ff'],
    toxic: ['#9dff00', '#39ff14', '#00ff9c', '#c6ff00'],
    aurora: ['#00ffa3', '#00d4ff', '#7b61ff', '#ff61d8'],
    lava: ['#ff2a00', '#ff6a00', '#ff3d3d', '#ffb000'],
    retro: ['#ff71ce', '#01cdfe', '#05ffa1', '#b967ff', '#fffb96'],
    forest: ['#52b788', '#74c69d', '#95d5b2', '#b7e4c7'],
    silver: ['#ffffff', '#d2d2d2', '#a8a8a8', '#d2d2d2'],
};
// Text and back together, one tap (a phone has no right click).
const RRC_PRESETS = [[0, 4], [1, 8], [0, 12], [8, 2], [1, 9], [0, 6], [1, 11], [0, 1], [1, 0],
    [9, 1], [8, 1], [7, 1], [0, 3], [0, 10], [1, 7], [0, 13], [0, 5], [11, 2],
    [4, 1], [11, 1], [13, 1], [8, 4], [0, 14], [1, 15]];
const RRC_STYLE_TABS = { c: 'Colours', s: 'Presets', x: 'Effects', a: 'Fonts', d: 'ASCII' };
const RRC_FX_PATTERNS = { c: 'Letters', w: 'Words', g: 'Gradient' };
// ASCII: fonts change the letters themselves (every client sees them), a
// decoration goes around the message. None of it holds a backtick, ¦ or a
// Markdown sign: NomadNet reads a chat line as Micron and Markdown.
const RRC_FONTS = { b: 'Bold', s: 'Script', f: 'Fraktur', d: 'Double', c: 'Circled', q: 'Bubble', k: 'Small caps',
    u: 'Upside down', x: 'Strike', l: 'Underline', g: 'g33k', y: 'Faux', r: 'Cyrillic', j: 'Asian', n: 'Sans',
    o: 'Boxed', w: 'Blocks', t: 'Tiny', m: 'Currency', e: 'Greek' };
// Fonts made by a mark after every letter.
const RRC_FONT_MARK = { x: '̶', l: '̲' };
const RRC_FONT_MAP = (() => {
    const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', az = AZ.toLowerCase(), N = '0123456789';
    const run = (from, start, holes = {}) => Object.fromEntries(Array.from(from, (ch, i) => [ch, holes[ch] || String.fromCodePoint(start + i)]));
    const table = (from, to) => { const b = Array.from(to); return Object.fromEntries(Array.from(from, (ch, i) => [ch, b[i]])); };
    const caps = m => Object.assign(m, Object.fromEntries(Array.from(az, ch => [ch, m[ch.toUpperCase()]])));
    const lower = m => Object.assign(m, Object.fromEntries(Array.from(AZ, ch => [ch, m[ch.toLowerCase()]])));
    return {
        b: { ...run(AZ, 0x1D400), ...run(az, 0x1D41A), ...run(N, 0x1D7CE) },
        s: { ...run(AZ, 0x1D4D0), ...run(az, 0x1D4EA) },
        f: { ...run(AZ, 0x1D504, { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' }), ...run(az, 0x1D51E) },
        d: { ...run(AZ, 0x1D538, { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' }), ...run(az, 0x1D552), ...run(N, 0x1D7D8) },
        c: { ...run(AZ, 0x24B6), ...run(az, 0x24D0), ...run('123456789', 0x2460), 0: '⓪' },
        q: caps(run(AZ, 0x1F150)),
        k: table(az, 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ'),
        u: table(az + AZ + N + '.,?!()[]{}<>_&\'"', 'ɐqɔpǝɟƃɥᴉɾʞlɯuodbɹsʇnʌʍxʎz∀ᗺƆᗡƎℲ⅁HIſꓘ˥WNOԀΌᴚS⊥∩ΛMX⅄Z0ƖᄅƐㄣϛ9ㄥ86˙\'¿¡)(][}{><‾⅋,„'),
        x: {},
        g: table('aeioAEIO', '43104310'),
        y: lower(table(az, 'αв¢∂єƒgнιʝκℓмησρqяѕтυνωχуz')),
        r: caps(table(AZ, 'ДБÇÐΞŦǤĦЇĴЌŁMИØҎQЯŜŦЦVШЖЧŹ')),
        j: lower(table(az, 'ﾑ乃匚刀乇下ム卄工ﾌズﾚﾶ刀口ｱゐ尺丂ｲひ√W乂ﾘ乙')),
        n: { ...run(AZ, 0x1D5D4), ...run(az, 0x1D5EE), ...run(N, 0x1D7EC) },
        o: caps(run(AZ, 0x1F130)),
        w: caps(run(AZ, 0x1F170)),
        t: { ...lower(table(az, 'ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖᑫʳˢᵗᵘᵛʷˣʸᶻ')), ...table(N, '⁰¹²³⁴⁵⁶⁷⁸⁹') },
        m: caps(table(AZ, '₳฿₵ĐɆ₣₲ⱧłJ₭Ⱡ₥₦Ø₱QⱤ₴₮ɄV₩ӾɎⱫ')),
        e: caps(table(AZ, 'ΛBCDΣFGΉIJKLMПӨPQЯƧƬЦVЩXYZ')),
    };
})();
const RRC_DECOS = [['·.¸¸.·´¯·.¸ ', ' ¸.·¯´·.¸¸.·'], ['★彡 ', ' 彡★'], ['░▒▓ ', ' ▓▒░'], ['»»—— ', ' ——««'],
    ['꧁ ', ' ꧂'], ['•°¯°• ', ' •°¯°•'], ['▁▂▃ ', ' ▃▂▁'], ['♪♫ ', ' ♫♪'], ['✿ ', ' ✿'], ['◄◄ ', ' ►►'],
    ['☆ﾟ.･｡ﾟ ', ' ﾟ｡･.ﾟ☆'], ['≋≋ ', ' ≋≋'], ['×º°”˜”°º× ', ' ×º°”˜”°º×'], ['【 ', ' 】'], ['『 ', ' 』'], ['─═☆ ', ' ☆═─'],
    ['✧･ﾟ: ', ' :ﾟ･✧'], ['▀▄▀▄ ', ' ▄▀▄▀'], ['◥◣ ', ' ◢◤'], ['╰☆☆ ', ' ☆☆╮']];
// Left as typed: links, @nicks, #rooms, hashes.
const RRC_ASCII_KEEP = /\b[a-z][a-z0-9+.-]*:\/\/\S+|lxmf@[0-9a-fA-F]{32}|\b[0-9a-fA-F]{32}\b|(?<![\w@#])[@#][\w-]+/g;
// The chat's background in the theme shown (a colour too close to it gets a chip).
const rrcChatBg = () => (document.documentElement.dataset.theme === 'light' ? '#ffffff' : '#0d1117');

function rrcStyleGet() {
    try {
        const s = JSON.parse(localStorage.getItem('rrc_style') || '{}');
        return s && typeof s === 'object' ? s : {};
    } catch (e) {
        return {};
    }
}

function rrcStyleSet(style) {
    try { localStorage.setItem('rrc_style', JSON.stringify(style)); } catch (e) { /* private window */ }
    rrcStyleShow();
}

function rrcStyleOn(style) {
    return ['f', 'b', 'B', 'I', 'U', 'x', 'a', 'd'].some(k => style[k] !== undefined && style[k] !== null);
}

function rrcIsCommand(text) {
    const t = String(text || '').trimStart();
    return t.startsWith('/') && !t.startsWith('//');
}

// A part of the message can have a style of its own (a word selected, then
// the palette or the small bar over it): one per character of the box, on
// top of the style for the whole message. It follows the box as you type:
// what is typed takes the style of the character before it, what is
// deleted takes its styles away.
function rrcDraftSync(value) {
    const d = Rrc.draft;
    if (d.text === value) return d;
    const a = Array.from(d.text), b = Array.from(value);
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const keep = p > 0 ? d.st[p - 1] : undefined;
    d.st = d.st.slice(0, p).concat(new Array(b.length - p - s).fill(keep), d.st.slice(a.length - s, a.length));
    d.st.length = b.length;
    d.text = value;
    return d;
}

function rrcDraftReset(value) {
    Rrc.draft.text = value;
    Rrc.draft.st = [];
}

// A character's style: the message's, under its own (-1, 0, '' = off).
function rrcStyleMerge(g, c) {
    const has = k => !!c && c[k] !== undefined;
    const pick = k => (has(k) ? c[k] : g[k]);
    const out = {};
    const x = has('x') ? c.x : (has('f') && c.f >= 0 ? '' : g.x);
    const f = pick('f'), b = pick('b');
    if (x && RRC_FX[x]) {
        out.x = x;
        out.p = RRC_FX_PATTERNS[pick('p')] ? pick('p') : 'c';
    } else if (Number.isInteger(f) && RRC_MIRC[f]) out.f = f;
    if (Number.isInteger(b) && RRC_MIRC[b]) out.b = b;
    for (const k of ['B', 'I', 'U']) if (pick(k)) out[k] = 1;
    if (RRC_FONTS[pick('a')]) out.a = pick('a');
    return out;
}

// The style of every character of the box; none for a command.
function rrcDraftStyles(value) {
    const d = rrcDraftSync(value);
    if (rrcIsCommand(value)) return Array.from(value, () => ({}));
    const g = rrcStyleGet();
    return Array.from(value, (ch, i) => rrcStyleMerge(g, d.st[i]));
}

// The colours of a message about to go (raw = the box as typed; it goes
// trimmed): runs of characters with one style, as [start, length, style].
// With the ASCII fonts and decoration applied: { text, fmt }.
function rrcOutgoing(raw) {
    if (rrcIsCommand(raw)) return { text: raw.trim(), fmt: null };
    const chars = Array.from(raw);
    const styles = rrcDraftStyles(raw);
    let a = 0, z = chars.length;
    while (a < z && /\s/.test(chars[a])) a++;
    while (z > a && /\s/.test(chars[z - 1])) z--;
    return rrcAsciiOut(chars.slice(a, z).join(''), styles.slice(a, z), rrcStyleGet().d);
}

// Fonts on the letters (not on links, @nicks, #rooms, hashes or the quoted
// line of a reply), the decoration around the rest; the colours follow.
function rrcAsciiOut(text, styles, deco) {
    const chars = Array.from(text);
    const keep = new Array(chars.length).fill(false);
    const mark = (a, n) => { for (let i = a; i < a + n; i++) keep[i] = true; };
    const quote = /^> [^\n]*\n/.exec(text);
    const body = quote ? Array.from(quote[0]).length : 0;
    mark(0, body);
    for (const m of text.matchAll(RRC_ASCII_KEEP)) mark(Array.from(text.slice(0, m.index)).length, Array.from(m[0]).length);
    let units = chars.map((ch, i) => {
        const st = Object.assign({}, styles[i]);
        const font = keep[i] ? '' : st.a;
        delete st.a;
        let t = ch;
        if (RRC_FONT_MARK[font]) t = /\s/.test(ch) ? ch : ch + RRC_FONT_MARK[font];
        else if (font && RRC_FONT_MAP[font]) t = RRC_FONT_MAP[font][ch] || ch;
        return { t, st, flip: font === 'u' };
    });
    // Upside down: each run of it backwards.
    for (let i = 0; i < units.length;) {
        if (!units[i].flip) { i++; continue; }
        let j = i;
        while (j < units.length && units[j].flip) j++;
        units.splice(i, j - i, ...units.slice(i, j).reverse());
        i = j;
    }
    const d = RRC_DECOS[deco];
    if (d && units.length > body) {
        const add = (s, st) => Array.from(s, t => ({ t, st }));
        units = [...units.slice(0, body), ...add(d[0], units[body].st), ...units.slice(body), ...add(d[1], units[units.length - 1].st)];
    }
    let out = '', at = 0, run = null;
    const fmt = [];
    for (const u of units) {
        const n = Array.from(u.t).length, key = JSON.stringify(u.st);
        if (run && run.key === key) run.span[1] += n;
        else {
            run = { key, span: [at, n, u.st] };
            if (key !== '{}') fmt.push(run.span);
        }
        out += u.t;
        at += n;
    }
    return { text: out, fmt: fmt.length ? fmt.slice(0, 64) : null };
}

function rrcAsciiText(text, font, deco) {
    return rrcAsciiOut(text, Array.from(text, () => (font ? { a: font } : {})), deco).text;
}

// The selection in the box, in characters: none for a command, nothing
// selected or the box not in use.
function rrcSelRange(input) {
    if (!input || document.activeElement !== input || input.selectionStart === input.selectionEnd
        || rrcIsCommand(input.value)) return null;
    const cp = at => Array.from(input.value.slice(0, at)).length;
    return [cp(input.selectionStart), cp(input.selectionEnd)];
}

// A pick of the palette (or of the small bar) on the selected characters.
function rrcDraftApply(input, [a, b], el, back) {
    const d = rrcDraftSync(input.value);
    const g = rrcStyleGet();
    const eff = i => rrcStyleMerge(g, d.st[i]);
    const every = test => { for (let i = a; i < b; i++) if (!test(eff(i))) return false; return true; };
    let change = null;
    if (el.dataset.rrcColor !== undefined) {
        const v = parseInt(el.dataset.rrcColor, 10);
        const k = back ? 'b' : 'f';
        change = c => { c[k] = v < 0 ? -1 : v; if (k === 'f') c.x = ''; };
    } else if (el.dataset.rrcTog) {
        const k = el.dataset.rrcTog, on = every(s => s[k]);
        change = c => { c[k] = on ? 0 : 1; };
    } else if (el.dataset.rrcFx) {
        const name = el.dataset.rrcFx, on = every(s => s.x === name);
        change = (c, s) => { c.x = on ? '' : name; if (!on) c.p = s.p || 'c'; };
    } else if (el.dataset.rrcSwap) {
        change = (c, s) => {
            c.f = Number.isInteger(s.b) ? s.b : -1;
            c.b = Number.isInteger(s.f) ? s.f : -1;
            c.x = '';
        };
    } else if (el.dataset.rrcPreset) {
        const [f, bg] = el.dataset.rrcPreset.split(',').map(Number);
        change = c => { c.f = f; c.b = bg; c.x = ''; };
    } else if (el.dataset.rrcPat) {
        change = c => { c.p = el.dataset.rrcPat; };
    } else if (el.dataset.rrcFont) {
        const name = el.dataset.rrcFont, on = every(s => s.a === name);
        change = c => { c.a = on ? '' : name; };
    } else if (!el.dataset.rrcReset) {
        return;
    }
    for (let i = a; i < b; i++) {
        if (!change) { d.st[i] = undefined; continue; }
        const c = Object.assign({}, d.st[i]);
        change(c, eff(i));
        d.st[i] = c;
    }
    rrcStyleShow();
}

function rrcLum(hex) {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function rrcContrast(a, b) {
    const x = rrcLum(a), y = rrcLum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Its CSS: a colour that would vanish on the chat (black, navy...) gets a
// light background; the same colour as its background is left out.
function rrcStyleCss(st) {
    const css = [];
    const bg = Number.isInteger(st.b) ? RRC_MIRC[st.b] : null;
    const fg = Number.isInteger(st.f) && !st.x ? RRC_MIRC[st.f] : null;
    let chip = !!bg;
    if (bg) css.push(`background:${bg}`);
    if (fg) {
        if (bg && rrcContrast(fg, bg) < 1.6) css.push(`color:${rrcContrast('#ffffff', bg) > rrcContrast('#000000', bg) ? '#ffffff' : '#000000'}`);
        else css.push(`color:${fg}`);
        if (!bg && rrcContrast(fg, rrcChatBg()) < 2.5) {
            css.push(`background:${document.documentElement.dataset.theme === 'light' ? '#30363d' : '#c9d1d9'}`);
            chip = true;
        }
    } else if (bg && !st.x) {
        css.push(`color:${rrcContrast('#ffffff', bg) > rrcContrast('#000000', bg) ? '#ffffff' : '#000000'}`);
    }
    if (st.B) css.push('font-weight:700');
    if (st.I) css.push('font-style:italic');
    if (st.U) css.push('text-decoration:underline');
    return { css: css.join(';'), chip };
}

function rrcGraphemes(text) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), s => s.segment);
    }
    return Array.from(text);
}

function rrcMix(a, b, t) {
    const v = (h, i) => parseInt(h.slice(i, i + 2), 16);
    const out = [1, 3, 5].map(i => Math.round(v(a, i) + (v(b, i) - v(a, i)) * t).toString(16).padStart(2, '0'));
    return '#' + out.join('');
}

// An effect, one colour per letter or word, or a gradient over the text.
// An effect's colour for each grapheme, null for a space.
function rrcFxColours(text, fx, pattern) {
    const pal = RRC_FX[fx] || RRC_FX.rainbow;
    const parts = rrcGraphemes(text);
    const visible = parts.filter(g => g.trim()).length;
    const out = [];
    let n = 0, word = 0, inWord = false;
    for (const g of parts) {
        if (!g.trim()) {
            out.push([g, null]);
            inWord = false;
            continue;
        }
        if (!inWord) { word++; inWord = true; }
        let color;
        if (pattern === 'w') color = pal[(word - 1) % pal.length];
        else if (pattern === 'g') {
            const t = visible > 1 ? n / (visible - 1) * (pal.length - 1) : 0;
            const i = Math.min(Math.floor(t), pal.length - 2);
            color = pal.length > 1 ? rrcMix(pal[i], pal[i + 1], t - i) : pal[0];
        } else color = pal[n % pal.length];
        out.push([g, color]);
        n++;
    }
    return out;
}

function rrcFxHtml(text, fx, pattern) {
    return rrcFxColours(text, fx, pattern)
        .map(([g, c]) => c ? `<span style="color:${c}">${rrcEsc(g)}</span>` : rrcEsc(g)).join('');
}

// Each character's colours (fx: the effect's colours and its letter number,
// for the coarser versions); null where the message has none.
function rrcMicronStyles(text, fmt) {
    const chars = Array.from(String(text || ''));
    const styles = new Array(chars.length).fill(null);
    const reply = /^> [^\n]*\n/.exec(text);
    const skip = reply ? Array.from(reply[0]).length : 0;
    for (const [start, size, st] of fmt) {
        const from = Math.max(start, skip), to = Math.min(start + size, chars.length);
        if (from >= to) continue;
        const base = {
            fg: Number.isInteger(st.f) ? RRC_MIRC[st.f] : null,
            bg: Number.isInteger(st.b) ? RRC_MIRC[st.b] : null,
            B: !!st.B,
        };
        for (let i = from; i < to; i++) styles[i] = { ...base };
        if (st.x) {
            const fx = { cols: [], p: st.p };
            let at = from;
            for (const [g, c] of rrcFxColours(chars.slice(from, to).join(''), st.x, st.p)) {
                if (c) { styles[at].fg = c; styles[at].fx = fx; styles[at].n = fx.cols.length; fx.cols.push(c); }
                at += Array.from(g).length;
            }
        }
    }
    return styles;
}

// The message with its colours as NomadNet's Micron tags (¦), for the other
// clients, from exact (FT) to one colour: the server sends the first that
// fits. Italic and underline left out: NomadNet's Markdown eats ¦* ¦_.
// parts: the texts of a message sent in parts, each gets its own versions.
function rrcMicronFor(text, fmt, parts = null) {
    if (!fmt || !String(text || '').length || /¦/.test(text)) return null;
    const styles = rrcMicronStyles(text, fmt);
    if (!parts) return rrcMicronLevels(Array.from(String(text)), styles);
    const all = Array.from(String(text));
    let at = 0;
    return parts.map(part => {
        const m = /^\(\d+\/\d+\) /.exec(part);
        const body = Array.from(m ? part.slice(m[0].length) : part);
        const pre = m ? Array.from(m[0]).length : 0;
        while (at < all.length && /\s/.test(all[at]) && !/\s/.test(body[0] || '')) at++;
        const ok = body.every((ch, i) => all[at + i] === ch);
        const st = ok ? new Array(pre).fill(null).concat(styles.slice(at, at + body.length)) : null;
        if (ok) at += body.length;
        return st ? rrcMicronLevels(Array.from(part), st) : null;
    });
}

function rrcMicronLevels(chars, styles) {
    const text = chars.join('');
    const build = (compact, list = styles) => {
        const hex = c => compact ? c.slice(1).match(/../g).map(h => Math.round(parseInt(h, 16) / 17).toString(16)).join('') : 'T' + c.slice(1);
        let out = '', cur = { fg: null, bg: null, B: false };
        chars.forEach((ch, i) => {
            const s = list[i] || { fg: null, bg: null, B: false };
            const fg = s.fg ? hex(s.fg) : null, bg = s.bg ? hex(s.bg) : null;
            // A space without a background keeps the colour: fewer tags.
            if (fg !== cur.fg && !(/\s/.test(ch) && !bg)) { out += fg ? `¦F${fg}` : '¦f'; cur.fg = fg; }
            if (bg !== cur.bg) { out += bg ? `¦B${bg}` : '¦b'; cur.bg = bg; }
            if (s.B !== cur.B) { out += '¦!'; cur.B = s.B; }
            out += ch;
        });
        if (cur.fg) out += '¦f';
        if (cur.bg) out += '¦b';
        if (cur.B) out += '¦!';
        return out;
    };
    // Too long for the hub (an effect tags every letter): one effect colour
    // every k letters, then a colour per word, then one colour.
    const blocks = k => styles.map(s => {
        if (!s || !s.fx || s.fx.p === 'w') return s;
        const n = s.fx.p === 'g' ? Math.floor(s.n / k) * k : Math.floor(s.n / k);
        return { ...s, fg: s.fx.cols[n % s.fx.cols.length] };
    });
    let word = null;
    const perWord = styles.map((s, i) => {
        if (!s || /\s/.test(chars[i])) { word = null; return s; }
        if (!word) word = s.fg;
        return { ...s, fg: word };
    });
    const first = (styles.find(s => s && s.fg) || {}).fg || null;
    const single = styles.map(s => s && s.fg ? { ...s, fg: first } : s);
    const exact = build(false);
    if (exact === text) return null;
    const out = [exact, build(true)];
    for (const k of [2, 3, 4, 6, 8, 12, 16]) out.push(build(true, blocks(k)));
    out.push(build(true, perWord), build(true, single));
    return out.filter((v, i) => out.indexOf(v) === i);
}

function rrcStyled(text, st, whole) {
    const { css, chip } = rrcStyleCss(st);
    let inner;
    if (st.x) {
        const m = whole ? /^> ([^\n]*)\n([\s\S]+)$/.exec(text) : null;
        inner = m ? `<span class="rrc-quote">${rrcText(m[1])}</span>${rrcFxHtml(m[2], st.x, st.p)}` : rrcFxHtml(text, st.x, st.p);
    } else {
        inner = whole ? rrcQuoted(text) : rrcText(text);
    }
    return `<span class="rrc-fmt${chip ? ' rrc-fmt-chip' : ''}" style="${css}">${inner}</span>`;
}

// A message with its colours; the parts with none as usual.
function rrcFmtHtml(text, fmt) {
    const chars = Array.from(String(text || ''));
    const spans = (Array.isArray(fmt) ? fmt : [])
        .filter(s => Array.isArray(s) && s.length === 3 && s[2] && typeof s[2] === 'object')
        .sort((a, b) => a[0] - b[0]);
    if (spans.length === 1 && spans[0][0] === 0 && spans[0][1] >= chars.length) {
        return rrcStyled(chars.join(''), spans[0][2], true);
    }
    let html = '', at = 0;
    for (const [start, size, st] of spans) {
        if (start < at) continue;
        if (start > at) html += rrcText(chars.slice(at, start).join(''));
        html += rrcStyled(chars.slice(start, start + size).join(''), st, false);
        at = start + size;
    }
    if (at < chars.length) html += rrcText(chars.slice(at).join(''));
    return html;
}

// Micron as NomadNet draws a chat message (the server makes it: rrc_micron.py,
// Markdown included). Only the inline tags; > and - start a heading or a
// divider on a line after the first, as after NomadNet's nick prefix.
function rrcMcLink(body) {
    const parts = body.split('`');
    const label = parts.length > 1 ? parts[0] : '';
    const url = parts.length > 1 ? parts[1] : parts[0];
    const text = rrcEsc(label || url);
    if (/^https?:\/\/\S+$/i.test(url)) return `<a href="${rrcEsc(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    if (/^[0-9a-f]{32}(:\/\S*)?$/i.test(url)) return `<span class="rrc-link" data-rrc-page="${rrcEsc(url)}" title="Open in a new tab">${text}</span>`;
    return text;
}

function rrcMcHtml(src, colours) {
    let st = {}, lit = false, html = '', buf = '';
    const css = () => {
        const c = [];
        if (colours && st.fg) c.push(`color:${st.fg}`);
        if (colours && st.bg) c.push(`background:${st.bg}`);
        if (st.B) c.push('font-weight:700');
        if (st.I) c.push('font-style:italic');
        if (st.U) c.push('text-decoration:underline');
        return c.join(';');
    };
    const flush = () => {
        if (!buf) return;
        const c = css();
        html += c ? `<span class="rrc-mc" style="${c}">${rrcEsc(buf)}</span>` : rrcEsc(buf);
        buf = '';
    };
    const lines = String(src || '').split('\n');
    let out = 0;
    lines.forEach((line, n) => {
        if (line === '`=') { lit = !lit; return; }
        if (out++) { flush(); html += '\n'; }
        if (n && !lit && line[0] === '>') {
            flush();
            html += `<span class="rrc-mc-h">${rrcMcHtml(line.replace(/^>+/, ''), colours)}</span>`;
            return;
        }
        if (n && !lit && line[0] === '-') {
            flush();
            html += `<span class="rrc-mc-hr" aria-hidden="true">${rrcEsc((line[1] || '─').repeat(40))}</span>`;
            return;
        }
        for (let i = 0; i < line.length;) {
            const ch = line[i];
            if (lit) { buf += ch; i++; continue; }
            if (ch === '\\' && i + 1 < line.length) { buf += line[i + 1]; i += 2; continue; }
            if (ch !== '`') { buf += ch; i++; continue; }
            const t = line[i + 1];
            let m;
            if ((t === 'F' || t === 'B') && (m = /^T([0-9a-fA-F]{6})|^([0-9a-fA-F]{3})/.exec(line.slice(i + 2)))) {
                flush();
                st = { ...st, [t === 'F' ? 'fg' : 'bg']: '#' + (m[1] || m[2]) };
                i += 2 + m[0].length;
                continue;
            }
            if (t === '[') {
                const end = line.indexOf(']', i + 2);
                if (end > 0) {
                    flush();
                    const c = css();
                    const link = rrcMcLink(line.slice(i + 2, end));
                    html += c ? `<span class="rrc-mc" style="${c}">${link}</span>` : link;
                    i = end + 1;
                    continue;
                }
            }
            switch (t) {
                case '!': flush(); st = { ...st, B: !st.B }; break;
                case '*': flush(); st = { ...st, I: !st.I }; break;
                case '_': flush(); st = { ...st, U: !st.U }; break;
                case 'f': flush(); st = { ...st, fg: null }; break;
                case 'b': flush(); st = { ...st, bg: null }; break;
                case '`': flush(); st = {}; break;
                case 'a': case 'c': case 'l': case 'r': break;
                default: buf += ch; i++; continue;
            }
            i += 2;
        }
    });
    flush();
    return html;
}

// Others' colours off: Micron's styles stay, its colours go.
function rrcMcLineHtml(line, own) {
    const colours = own || rrcSetting('show_colors', true) !== false;
    let html = line.mc.map(([k, s]) => k === 'm' ? rrcMcHtml(s, colours) : rrcText(s)).join('');
    html = line.art && colours ? `<span class="rrc-art">${html}</span>` : `<span class="rrc-mcmsg">${html}</span>`;
    const q = line.mc_reply ? /^> ([^\n]*)\n/.exec(String(line.text || '')) : null;
    return q ? `<span class="rrc-quote">${rrcText(q[1])}</span>${html}` : html;
}

function rrcLineHtml(line, own) {
    if (Array.isArray(line.stk) && line.kind === 'msg') return rrcStkHtml(line);
    if (line.fmt && (own || rrcSetting('show_colors', true) !== false)) return rrcFmtHtml(line.text, line.fmt);
    if (Array.isArray(line.mc)) return rrcMcLineHtml(line, own);
    return line.kind === 'msg' ? rrcQuoted(line.text) : rrcText(line.text);
}

// The box shows the message as it will go: the textarea's own text is
// transparent and a copy of it, coloured, is drawn under it (same font,
// size and wrapping: the mono font keeps every character in its place).
// A command, or no colour at all, and the textarea draws its text itself.
function rrcMirrorHtml(chars, styles, mark) {
    let html = '';
    for (let i = 0; i < chars.length;) {
        if (i === mark) html += '<span data-rrc-mark></span>';
        const key = JSON.stringify(styles[i]);
        let j = i + 1;
        while (j < chars.length && j !== mark && JSON.stringify(styles[j]) === key) j++;
        const text = chars.slice(i, j).join('');
        const st = styles[i];
        if (key === '{}') html += rrcEsc(text);
        else html += `<span style="${rrcStyleCss(st).css}">${st.x ? rrcFxHtml(text, st.x, st.p) : rrcEsc(text)}</span>`;
        i = j;
    }
    if (mark >= chars.length) html += '<span data-rrc-mark></span>';
    return html + ' ';                      // a last empty line keeps its height
}

function rrcMirror(input, mark) {
    const mirror = document.getElementById('rrc-mirror');
    if (!input || !mirror) return null;
    const chars = Array.from(input.value);
    const styles = rrcDraftStyles(input.value);
    const styled = styles.some(s => Object.keys(s).length);
    input.classList.toggle('rrc-styled', styled);
    mirror.classList.toggle('on', styled);
    const cs = getComputedStyle(input);
    for (const p of ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRadius', 'tabSize']) {
        mirror.style[p] = cs[p];
    }
    // A scroll bar in the textarea (over six lines): its text is narrower.
    const bar = input.offsetWidth - input.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    mirror.style.paddingRight = `${parseFloat(cs.paddingRight) + Math.max(0, bar)}px`;
    Object.assign(mirror.style, {
        left: `${input.offsetLeft}px`, top: `${input.offsetTop}px`,
        width: `${input.offsetWidth}px`, height: `${input.offsetHeight}px`,
    });
    mirror.innerHTML = rrcMirrorHtml(chars, styles, mark);
    mirror.scrollTop = input.scrollTop;
    return mirror;
}

// The small bar over a selection: bold, italic, underline, the palette
// for it, plain again.
function rrcSelBar(input) {
    const bar = document.getElementById('rrc-sel');
    const box = document.getElementById('rrc-style');
    if (!bar || !input) return;
    const range = rrcSelRange(input);
    if (!range || (box && !box.hidden)) {
        bar.hidden = true;
        return;
    }
    const mirror = rrcMirror(input, range[0]);
    const mark = mirror && mirror.querySelector('[data-rrc-mark]');
    const row = input.offsetParent;
    bar.hidden = false;
    if (mark && row) {
        const x = mark.getBoundingClientRect().left - row.getBoundingClientRect().left;
        bar.style.left = `${Math.max(4, Math.min(x - 10, row.clientWidth - bar.offsetWidth - 4))}px`;
    }
    rrcMirror(input);
}

function rrcStyleShow() {
    const input = document.getElementById('rrc-input');
    const btn = document.getElementById('rrc-style-btn');
    if (!input) return;
    const st = rrcStyleGet();
    rrcMirror(input);
    if (btn) {
        btn.classList.toggle('active', rrcStyleOn(st));
        btn.style.setProperty('--rrc-style-dot', st.x ? `linear-gradient(90deg,${(RRC_FX[st.x] || []).join(',')})`
            : Number.isInteger(st.f) ? RRC_MIRC[st.f] : Number.isInteger(st.b) ? RRC_MIRC[st.b] : '#c9d1d9');
    }
    const box = document.getElementById('rrc-style');
    if (box && !box.hidden) rrcStyleRender(box);
}

// Left click a colour for the text, right click (long press) for the back;
// the sample on top shows the message as it will look. With a word
// selected in the box, everything here is for that word only.
function rrcStyleRender(box) {
    const input = document.getElementById('rrc-input');
    const range = rrcSelRange(input);
    const st = range ? rrcStyleMerge(rrcStyleGet(), rrcDraftSync(input.value).st[range[0]]) : rrcStyleGet();
    const sample = range ? Array.from(input.value).slice(range[0], range[1]).join('').slice(0, 14) : 'Hello';
    const touch = matchMedia('(pointer: coarse)').matches;
    const tab = RRC_STYLE_TABS[box.dataset.tab] ? box.dataset.tab : 'c';
    const g = rrcStyleGet();
    const hint = tab === 'd' ? 'around the whole message' : range ? 'for the selection only' : tab === 's' ? 'text and back in one tap'
        : tab === 'x' ? 'one colour per letter, word or a gradient' : tab === 'a' ? 'every client sees these'
        : touch ? 'tap: text · hold: back' : 'left: text · right: back';
    const sw = RRC_MIRC_ORDER.map(i => `<button class="rrc-swatch${st.f === i && !st.x ? ' on' : ''}${st.b === i ? ' on-b' : ''}"
        data-rrc-color="${i}" style="background:${RRC_MIRC[i]}" title="${RRC_MIRC_NAMES[i]}" aria-label="${RRC_MIRC_NAMES[i]}" tabindex="-1"></button>`).join('');
    const chip = (k, label) => {
        const v = k === 'f' && st.x ? `linear-gradient(90deg,${(RRC_FX[st.x] || []).join(',')})` : Number.isInteger(st[k]) ? RRC_MIRC[st[k]] : null;
        return `<span class="rrc-style-chip ${k}" title="${label}"><i style="${v ? `background:${v}` : ''}">${v ? '' : '⌀'}</i>${label}</span>`;
    };
    const tog = (k, label, css) => `<button class="rrc-style-tog${st[k] ? ' on' : ''}" data-rrc-tog="${k}" style="${css}" tabindex="-1">${label}</button>`;
    const fx = Object.keys(RRC_FX).map(name => `<button class="rrc-fx${st.x === name ? ' on' : ''}" data-rrc-fx="${name}" tabindex="-1"
        title="${name}">${rrcFxHtml(name, name, 'c')}</button>`).join('');
    const pat = Object.entries(RRC_FX_PATTERNS).map(([k, label]) => `<button class="rrc-style-tog${(st.p || 'c') === k ? ' on' : ''}"
        data-rrc-pat="${k}" tabindex="-1"${st.x ? '' : ' disabled'}>${label}</button>`).join('');
    const presets = RRC_PRESETS.map(([f, bg]) => `<button class="rrc-preset${st.f === f && st.b === bg && !st.x ? ' on' : ''}"
        data-rrc-preset="${f},${bg}" style="color:${RRC_MIRC[f]};background:${RRC_MIRC[bg]}" tabindex="-1"
        title="${RRC_MIRC_NAMES[f]} on ${RRC_MIRC_NAMES[bg]}">Ab</button>`).join('');
    const tabs = Object.entries(RRC_STYLE_TABS).map(([k, label]) =>
        `<button class="rrc-style-tab${tab === k ? ' on' : ''}" data-rrc-tab="${k}" tabindex="-1">${label}</button>`).join('');
    const fonts = Object.entries(RRC_FONTS).map(([k, label]) => `<button class="rrc-fx rrc-font${st.a === k ? ' on' : ''}"
        data-rrc-font="${k}" title="${label}" tabindex="-1">${rrcEsc(rrcAsciiText(label, k))}</button>`).join('');
    // The frame goes around the whole message, a selection or not.
    const decos = RRC_DECOS.map(([a, z], i) => `<button class="rrc-fx rrc-font${g.d === i ? ' on' : ''}" data-rrc-deco="${i}"
        title="Around the message" tabindex="-1">${rrcEsc(Array.from(a.trim()).slice(-4).join('') + '…' + Array.from(z.trim()).slice(0, 4).join(''))}</button>`).join('');
    const body = tab === 's' ? `<div class="rrc-presets">${presets}</div>`
        : tab === 'a' ? `<div class="rrc-fonts">${fonts}</div>`
        : tab === 'd' ? `<div class="rrc-decos">${decos}</div>`
        : tab === 'x' ? `<div class="rrc-fxs">${fx}</div><div class="rrc-style-row">${pat}<span class="rrc-style-gap"></span>
            <button class="rrc-style-reset" data-rrc-nobg="1" tabindex="-1" title="Take the background away"${Number.isInteger(st.b) ? '' : ' disabled'}>No BG</button></div>`
        : `<div class="rrc-swatches">${sw}<button class="rrc-swatch rrc-swatch-none" data-rrc-color="-1"
            title="None" aria-label="None" tabindex="-1">⌀</button><button class="rrc-swatch rrc-swatch-none" data-rrc-swap="1"
            title="Swap text and back" aria-label="Swap text and back" tabindex="-1">⇄</button></div>`;
    box.classList.toggle('rrc-style-sel', !!range);
    box.innerHTML = `
        <div class="rrc-style-row">
            <span class="rrc-style-sample">${rrcStyled(rrcAsciiText(sample, st.a, range && tab !== 'd' ? null : g.d), st, false)}</span>
            <span class="rrc-style-gap"></span>
            ${tog('B', 'B', 'font-weight:700')}${tog('I', 'I', 'font-style:italic')}${tog('U', 'U', 'text-decoration:underline')}
            <button class="rrc-style-tog rrc-style-close" data-rrc-close="1" tabindex="-1"
                title="Close: the style stays on until Reset" aria-label="Close">×</button>
        </div>
        <div class="rrc-style-row">${chip('f', 'Text')}${chip('b', 'Back')}<span class="rrc-style-gap"></span>
            <span class="rrc-style-hint">${hint}</span></div>
        <div class="rrc-style-body">${body}</div>
        <div class="rrc-style-row">${tabs}<span class="rrc-style-gap"></span>
            <button class="rrc-style-reset" data-rrc-reset="1" tabindex="-1"
                title="${range ? 'The selection plain again' : 'Back to plain text'}">Reset</button></div>`;
}

function rrcStylePick(el, back) {
    if (el.dataset.rrcNobg) return rrcStylePick({ dataset: { rrcColor: '-1' } }, true);
    const input = document.getElementById('rrc-input');
    const range = rrcSelRange(input);
    if (range && !el.dataset.rrcDeco) return rrcDraftApply(input, range, el, back);
    const st = rrcStyleGet();
    if (el.dataset.rrcColor !== undefined) {
        const k = back ? 'b' : 'f';
        const v = parseInt(el.dataset.rrcColor, 10);
        if (v < 0) delete st[k];
        else {
            st[k] = v;
            if (k === 'f') delete st.x;         // a colour or an effect
        }
    } else if (el.dataset.rrcTog) {
        st[el.dataset.rrcTog] = st[el.dataset.rrcTog] ? undefined : 1;
    } else if (el.dataset.rrcFx) {
        if (st.x === el.dataset.rrcFx) delete st.x;
        else { st.x = el.dataset.rrcFx; delete st.f; st.p = st.p || 'c'; }
    } else if (el.dataset.rrcSwap) {
        const f = st.x ? undefined : st.f, bg = st.b;
        delete st.x;
        if (Number.isInteger(bg)) st.f = bg; else delete st.f;
        if (Number.isInteger(f)) st.b = f; else delete st.b;
    } else if (el.dataset.rrcPreset) {
        [st.f, st.b] = el.dataset.rrcPreset.split(',').map(Number);
        delete st.x;
    } else if (el.dataset.rrcPat) {
        st.p = el.dataset.rrcPat;
    } else if (el.dataset.rrcFont) {
        if (st.a === el.dataset.rrcFont) delete st.a; else st.a = el.dataset.rrcFont;
    } else if (el.dataset.rrcDeco) {
        const v = Number(el.dataset.rrcDeco);
        if (st.d === v) delete st.d; else st.d = v;
    } else if (el.dataset.rrcReset) {
        for (const k of Object.keys(st)) delete st[k];
        if (input) rrcDraftReset(input.value);  // the parts too: all plain
    }
    rrcStyleSet(JSON.parse(JSON.stringify(st)));
}

function bindRrcStyle(view, input) {
    const box = view.querySelector('#rrc-style');
    const btn = view.querySelector('#rrc-style-btn');
    if (!box || !btn) return;
    try { box.dataset.tab = localStorage.getItem('rrc_style_tab') || 'c'; } catch (err) { box.dataset.tab = 'c'; }
    btn.addEventListener('mousedown', e => {
        e.preventDefault();
        box.hidden = !box.hidden;
        if (!box.hidden) {
            rrcStyleRender(box);
            const emojis = view.querySelector('#rrc-emojis');
            if (emojis) emojis.hidden = true;
        }
        input.focus();
    });
    let rightDown = false;
    box.addEventListener('mousedown', e => {
        e.preventDefault();                 // the input keeps the focus
        const el = e.target.closest('button');
        rightDown = e.button === 2;
        if (el && el.dataset.rrcClose) {
            box.hidden = true;
            input.focus();
            rrcSelBar(input);
            return;
        }
        if (el && el.dataset.rrcTab) {
            box.dataset.tab = el.dataset.rrcTab;
            try { localStorage.setItem('rrc_style_tab', el.dataset.rrcTab); } catch (err) { /* private window */ }
            rrcStyleRender(box);
            return;
        }
        if (el && !el.disabled && (e.button === 0 || (rightDown && el.dataset.rrcColor !== undefined))) rrcStylePick(el, rightDown);
    });
    box.addEventListener('contextmenu', e => {
        e.preventDefault();
        // A long press on a phone: no right button came before it.
        const el = e.target.closest('[data-rrc-color]');
        if (el && !rightDown) rrcStylePick(el, true);
        rightDown = false;
    });
    document.addEventListener('mousedown', e => {
        // A click inside it redraws it: the button clicked is gone by now.
        if (!box.hidden && e.target.isConnected && !e.target.closest('#rrc-style, #rrc-style-btn, #rrc-sel')) box.hidden = true;
    });
    const bar = view.querySelector('#rrc-sel');
    if (bar) {
        bar.addEventListener('mousedown', e => {
            e.preventDefault();             // the selection stays
            const el = e.target.closest('button');
            if (!el) return;
            if (el.dataset.rrcSelPalette) {
                box.hidden = false;
                rrcStyleRender(box);
                const emojis = view.querySelector('#rrc-emojis');
                if (emojis) emojis.hidden = true;
            } else rrcStylePick(el, false);
            rrcSelBar(input);
        });
        input.addEventListener('blur', () => { bar.hidden = true; });
    }
    const sel = () => requestAnimationFrame(() => {
        rrcSelBar(input);
        if (!box.hidden) rrcStyleRender(box);
    });
    document.addEventListener('selectionchange', () => { if (document.activeElement === input) sel(); });
    for (const ev of ['select', 'mouseup', 'keyup']) input.addEventListener(ev, sel);
    input.addEventListener('scroll', () => {
        const mirror = view.querySelector('#rrc-mirror');
        if (mirror) mirror.scrollTop = input.scrollTop;
    });
    if (window.ResizeObserver) new ResizeObserver(() => rrcMirror(input)).observe(input);
    rrcStyleShow();
}

// The emoji: ten a page, two rows of five; the first page is the ones you
// use most (counted in this browser), then the groups, faces first.
const RRC_EMOJI_GROUPS = [
    ['😀', 'Faces', '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🫢 🤫 🤔 🫡 🤐 🤨 😐 😑 😶 🫥 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 😵‍💫 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 🫤 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 🫠 😈 👿 💀 ☠️ 💩 🤡 👹 👻 👽 🤖 😺 😸 😹 😻 😼 🙈 🙉 🙊'],
    ['👍', 'Hands', '👍 👎 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👋 🤚 🖐️ ✋ 🖖 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💪 🫵 👀 🧠 🦾 🤷 🤦 🙋 🙆 🙅 💁'],
    ['❤️', 'Hearts', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 🔥 ✨ ⭐ 🌟 🎉 🎊'],
    ['🐶', 'Nature', '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦅 🦉 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐢 🐍 🐙 🐬 🐳 🦈 🌵 🌲 🌴 🌸 🌻 🍀 🍁 🌍 🌙 ☀️ ⛅ 🌧️ ⛈️ ❄️ 🌈'],
    ['🍕', 'Food', '☕ 🍺 🍻 🍷 🥂 🍸 🍕 🍔 🍟 🌭 🥪 🍝 🍣 🍜 🥐 🍞 🧀 🥚 🍳 🥓 🍰 🎂 🍩 🍪 🍫 🍦 🍎 🍌 🍉 🍇 🍓 🍒 🍑 🍋 🌶️ 🥕 🍄 🥑 🍆 🥦'],
    ['⚽', 'Activity', '⚽ 🏀 🏈 🎾 🏐 🎮 🕹️ 🎲 🎯 🎸 🎧 🎤 🎬 📷 🚗 🚲 🏍️ ✈️ 🚀 🛰️ 🚢 🏠 🏔️ 🏖️ 🗺️ 🏆 🥇 🎁 🎈 🎄'],
    ['💡', 'Objects', '📡 📻 📶 🔋 🔌 💻 🖥️ ⌨️ 🖱️ 📱 ☎️ 💾 💿 🔧 🔨 🛠️ ⚙️ 🔩 🧲 🔬 🔭 💡 🔦 📦 ✉️ 📨 📝 📌 📎 🔒 🔓 🔑 🗝️ ⏰ ⌛ 📅 💰 💸 🧾 🤖'],
    ['✅', 'Symbols', '✅ ❌ ⚠️ ❓ ❗ ‼️ ⁉️ 🆗 🆕 🆒 🆘 ⛔ 🚫 ♻️ ⚡ ☢️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ ➡️ ⬅️ ⬆️ ⬇️ 🔁 🔄 ➕ ➖ ✖️ 💤 💬 💭 🗯️ 📢 🔔 🔕 ℹ️ 🎵'],
    ['🏁', 'Flags', '🇮🇹 🇪🇺 🇬🇧 🇺🇸 🇩🇪 🇫🇷 🇪🇸 🇵🇹 🇳🇱 🇧🇪 🇨🇭 🇦🇹 🇵🇱 🇷🇺 🇺🇦 🇧🇷 🇯🇵 🏴‍☠️ 🏳️‍🌈 🏁'],
];
const RRC_EMOJI_FIRST = ['😂', '😀', '😉', '😏', '🙄', '😅', '👍', '❤️', '🤔', '😎'];

// The pages: [group index (-1 = most used), the ten on it].
function rrcEmojiPages() {
    const pages = [[-1, rrcEmojiTop()]];
    RRC_EMOJI_GROUPS.forEach(([, , list], g) => {
        const all = list.split(' ');
        for (let i = 0; i < all.length; i += 10) pages.push([g, all.slice(i, i + 10)]);
    });
    return pages;
}

function rrcEmojiUse() {
    try {
        const u = JSON.parse(localStorage.getItem('rrc_emoji_use') || '{}');
        return u && typeof u === 'object' ? u : {};
    } catch (e) {
        return {};
    }
}

function rrcEmojiTop() {
    const use = rrcEmojiUse();
    const top = Object.keys(use).sort((a, b) => use[b] - use[a]).slice(0, 10);
    for (const e of RRC_EMOJI_FIRST) if (top.length < 10 && !top.includes(e)) top.push(e);
    return top;
}

function rrcEmojiCount(emoji) {
    const use = rrcEmojiUse();
    use[emoji] = (use[emoji] || 0) + 1;
    try { localStorage.setItem('rrc_emoji_use', JSON.stringify(use)); } catch (e) { /* private window */ }
}

function rrcEmojiRender(box, page) {
    const pages = rrcEmojiPages();
    page = (page + pages.length) % pages.length;
    box.dataset.page = String(page);
    const [group, list] = pages[page];
    const firstOf = g => pages.findIndex(p => p[0] === g);
    const inGroup = pages.filter(p => p[0] === group).length;
    const nth = page - firstOf(group) + 1;
    const groups = [['★', 'Most used', -1], ...RRC_EMOJI_GROUPS.map(([icon, name], g) => [icon, name, g])]
        .map(([icon, name, g]) => `<button class="rrc-egroup${g === group ? ' on' : ''}" data-rrc-egroup="${g}"
            title="${name}" tabindex="-1">${icon}</button>`).join('');
    const label = group < 0 ? 'Most used' : RRC_EMOJI_GROUPS[group][1] + (inGroup > 1 ? ` ${nth}/${inGroup}` : '');
    box.innerHTML = `<div class="rrc-emoji-grid">${list.map(x =>
        `<button class="rrc-emoji" data-rrc-emoji="${x}" tabindex="-1">${x}</button>`).join('')}</div>
        <div class="rrc-emoji-label">${label}</div>
        <div class="rrc-emoji-nav">
            <button class="rrc-epage" data-rrc-epage="-1" title="Page before" aria-label="Page before" tabindex="-1">‹</button>
            <div class="rrc-egroups">${groups}</div>
            <button class="rrc-epage" data-rrc-epage="1" title="Next page" aria-label="Next page" tabindex="-1">›</button>
        </div>`;
}

function bindRrcEmojis(view, input) {
    const emojis = view.querySelector('#rrc-emojis');
    view.querySelector('#rrc-emoji-btn').addEventListener('mousedown', e => {
        e.preventDefault();
        emojis.hidden = !emojis.hidden;
        if (!emojis.hidden) {
            rrcEmojiRender(emojis, 0);      // the most used, as they are now
            const style = view.querySelector('#rrc-style');
            if (style) style.hidden = true;
        }
    });
    emojis.addEventListener('mousedown', e => {
        e.preventDefault();                 // the input keeps the focus
        const page = parseInt(emojis.dataset.page || '0', 10);
        const nav = e.target.closest('[data-rrc-epage]');
        if (nav) { rrcEmojiRender(emojis, page + parseInt(nav.dataset.rrcEpage, 10)); return; }
        const grp = e.target.closest('[data-rrc-egroup]');
        if (grp) {
            const g = parseInt(grp.dataset.rrcEgroup, 10);
            rrcEmojiRender(emojis, Math.max(0, rrcEmojiPages().findIndex(p => p[0] === g)));
            return;
        }
        const item = e.target.closest('[data-rrc-emoji]');
        if (!item) return;
        const at = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? at;
        input.value = input.value.slice(0, at) + item.dataset.rrcEmoji + input.value.slice(end);
        const pos = at + item.dataset.rrcEmoji.length;
        input.setSelectionRange(pos, pos);
        input.focus();
        rrcEmojiCount(item.dataset.rrcEmoji);
        rrcStkSuggest();
        // Its stickers came up: no room for both on a phone, the palette goes.
        if (!view.querySelector('#rrc-stk-suggest')?.hidden) emojis.hidden = true;
    });
    document.addEventListener('mousedown', e => {
        if (!emojis.hidden && e.target.isConnected && !e.target.closest('#rrc-emojis, #rrc-emoji-btn, #rrc-stk-suggest')) emojis.hidden = true;
    });
}

// ─── Stickers (rbrowser/stickers.py) ────────────────────────
// A sticker goes as its emoji plus [pack, code points] (K_STICKER): who has
// the pack sees the picture, everyone else the emoji.

const RrcStk = { packs: [], sets: {}, loading: null, polling: false };
function rrcStkIcon() {
    return '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M3 2.5h10v6l-4.5 5H3z"/><path d="M8.5 13.5v-3.5a1.5 1.5 0 0 1 1.5-1.5h3"/></svg>';
}

function rrcStkOn() { return rrcSetting('stickers', false) === true; }
function rrcStkTgOn() { return rrcStkOn() && rrcSetting('tg_stickers', false) === true; }

// Each poll: a switch changed (Settings saved) -> packs again, lines redrawn.
function rrcStkSync() {
    rrcStkSweep();
    const on = `${rrcStkOn()}/${rrcStkTgOn()}`;
    if (RrcStk.on === on) return;
    RrcStk.on = on;
    rrcStkLoad(true);
    if (!rrcStkOn()) rrcStkHide();
}

function rrcStkLoad(force = false) {
    if (RrcStk.loading && !force) return RrcStk.loading;
    RrcStk.loading = fetch('/api/rrc/stickers').then(r => r.json()).then(r => {
        if (!r || r.status !== 'success') return null;
        RrcStk.packs = r.packs;
        RrcStk.rev = (RrcStk.rev || 0) + 1;
        RrcStk.tg = r.telegram || {};
        RrcStk.sets = {};
        RrcStk.byCp = {};
        RrcStk.items = {};
        for (const p of r.packs) {
            if (!p.installed) continue;
            if (p.kind === 'tg') {
                const by = RrcStk.byCp[p.id] = {};
                const items = RrcStk.items[p.id] = {};
                for (const it of p.items) {
                    items[it.id] = it;
                    if (it.cp) (by[it.cp] ||= []).push(it.id);
                }
                RrcStk.sets[p.id] = new Set(Object.keys(items));
            } else {
                RrcStk.sets[p.id] = new Set(p.cps);
            }
        }
        rrcStkButton();
        if (rrcStkTgOn() && RrcStk.tg.lottie) rrcStkLottie();
        rrcStkPaint(document);
        return r;
    }).catch(() => null);
    return RrcStk.loading;
}

function rrcStkPack(id) { return RrcStk.packs.find(p => p.id === id) || null; }
function rrcStkIsTg(id) { return String(id || '').startsWith('tg-'); }
function rrcStkHas(pack, cp) { return !!(RrcStk.sets[pack] && RrcStk.sets[pack].has(cp)); }
function rrcStkUrl(pack, cp, thumb = false) { return `/api/rrc/stickers/${encodeURIComponent(pack)}/${encodeURIComponent(cp)}${thumb ? '?thumb=1' : ''}`; }
function rrcStkInstalled() { return RrcStk.packs.filter(p => p.installed && (p.kind !== 'tg' || rrcStkTgOn())); }

// The stickers of one emoji in a pack (a Telegram set can have several).
function rrcStkKeys(pack, cp) {
    if (rrcStkIsTg(pack)) return (RrcStk.byCp[pack] || {})[cp] || [];
    return rrcStkHas(pack, cp) ? [cp] : [];
}

// A still picture of a sticker for the pickers, or null (then its emoji).
function rrcStkStill(pack, key) {
    if (!rrcStkIsTg(pack)) return rrcStkUrl(pack, key);
    const it = (RrcStk.items[pack] || {})[key];
    if (!it) return null;
    if (it.ext === 'webp') return rrcStkUrl(pack, key);
    return it.thumb ? rrcStkUrl(pack, key, true) : null;
}

function rrcStkItemBtn(pack, key, emoji, title, lazy = false) {
    const still = rrcStkStill(pack, key);
    // alt empty: the browser would show the emoji while the picture loads.
    const face = still ? `<img src="${still}" alt=""${lazy ? ' loading="lazy"' : ''} draggable="false">` : `<span class="rrc-stk-face">${rrcText(emoji)}</span>`;
    return `<button class="rrc-stk-item" data-rrc-stk="${rrcEsc(pack)}" data-cp="${rrcEsc(key)}" data-emoji="${rrcEsc(emoji)}" title="${rrcEsc(title)}" tabindex="-1">${face}</button>`;
}

// lottie-web (Settings), for the animated Telegram stickers: loaded once.
function rrcStkLottie() {
    if (window.lottie || RrcStk.lottieLoading) return;
    RrcStk.lottieLoading = true;
    const s = document.createElement('script');
    s.src = '/api/rrc/stickers-lottie.js';
    s.onload = () => { RrcStk.lottieLoading = false; rrcStkPaint(document); };
    s.onerror = () => { RrcStk.lottieLoading = false; };
    document.head.appendChild(s);
}

// Animations whose line is gone: stopped, or lottie keeps drawing them.
function rrcStkSweep() {
    if (!RrcStk.anims) return;
    RrcStk.anims = RrcStk.anims.filter(a => {
        if (a.el.isConnected) return true;
        try { a.anim.destroy(); } catch { /* gone already */ }
        return false;
    });
}

// The file name of an emoji: its code points, without FE0F (as the server).
function rrcStkCp(text) {
    return Array.from(String(text || '')).map(c => c.codePointAt(0).toString(16))
        .filter(h => h !== 'fe0f').join('-');
}

// One emoji and nothing else (a flag, a family, a keycap count as one).
function rrcStkSingle(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 16) return null;
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        const parts = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t));
        if (parts.length !== 1) return null;
    }
    return /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(t) ? t : null;
}

// In a line: a placeholder, filled here, and again once the packs are known.
function rrcStkHtml(line) {
    const [pack, cp] = line.stk;
    return `<span class="rrc-stk" data-pack="${rrcEsc(pack)}" data-cp="${rrcEsc(cp)}" data-emoji="${rrcEsc(line.text)}">${rrcText(line.text)}</span>`;
}

// How a sticker line is drawn: 'img', 'video', 'anim' (lottie), 'still' or 'emoji'.
function rrcStkMode(pack, key) {
    const tg = rrcStkIsTg(pack);
    if (!(tg ? rrcStkTgOn() : rrcStkOn()) || !rrcStkHas(pack, key)) return 'emoji';
    if (!tg) return 'img';
    const it = RrcStk.items[pack][key];
    if (it.ext === 'webp') return 'img';
    if (it.ext === 'webm') return 'video';
    if (window.lottie) return 'anim';
    return it.thumb ? 'still' : 'emoji';
}

function rrcStkPaint(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('.rrc-stk').forEach(el => {
        const { pack, cp, emoji } = el.dataset;
        const tg = rrcStkIsTg(pack);
        const name = (rrcStkPack(pack) || {}).name || (tg ? pack.slice(3) : pack);
        const want = rrcStkMode(pack, cp);
        if (el.dataset.shown === want) return;
        el.dataset.shown = want;
        const title = `${rrcEsc(name)} sticker`;
        const fail = () => { el.dataset.shown = 'emoji'; el.textContent = emoji; };
        if (want === 'img' || want === 'still') {
            el.innerHTML = `<img class="rrc-sticker" src="${want === 'still' ? rrcStkStill(pack, cp) : rrcStkUrl(pack, cp)}" alt="${rrcEsc(emoji)}" title="${title}" draggable="false">`;
            el.querySelector('img').addEventListener('error', fail, { once: true });
        } else if (want === 'video') {
            el.innerHTML = `<video class="rrc-sticker" src="${rrcStkUrl(pack, cp)}" autoplay loop muted playsinline disablepictureinpicture title="${title}"></video>`;
            el.querySelector('video').addEventListener('error', fail, { once: true });
        } else if (want === 'anim') {
            el.innerHTML = `<span class="rrc-sticker rrc-stk-anim" title="${title}"></span>`;
            const box = el.firstChild;
            try {
                const anim = window.lottie.loadAnimation({ container: box, renderer: 'svg', loop: true, autoplay: true, path: rrcStkUrl(pack, cp) });
                anim.addEventListener('data_failed', fail);
                (RrcStk.anims ||= []).push({ el: box, anim });
            } catch { fail(); }
        } else {
            let tip, act = 'settings';
            if (tg && rrcStkTgOn() && RrcStk.tg?.token) { tip = `A Telegram sticker from ${name}: click to import the set`; act = 'import'; }
            else if (tg) tip = `A Telegram sticker from ${name}: switch Telegram stickers on in Settings to see it`;
            else tip = rrcStkOn() ? `A ${name} sticker: download the pack to see it` : `A ${name} sticker: switch stickers on to see it`;
            el.innerHTML = `${rrcText(emoji)}${window.rbGuest ? '' : `<button class="rrc-stk-get" data-rrc-stk-get="${rrcEsc(pack)}" data-act="${act}" title="${rrcEsc(tip)}">Get sticker pack</button>`}`;
        }
    });
}

function rrcStkSettings(where = 'rrc-stickers-settings') {
    if (typeof showSettings !== 'function' || window.rbGuest) return;
    showSettings('rrc');
    setTimeout(() => document.getElementById(where)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
}

// "Get sticker pack" on a Telegram sticker: the set imported from here.
async function rrcStkGetTg(pack) {
    const name = pack.slice(3);
    const ok = typeof confirmDialog === 'function'
        ? await confirmDialog('Import Telegram stickers', `Import the Telegram set <b>${rrcEsc(name)}</b> with your bot?`, 'Import') : true;
    if (!ok) return;
    const res = await rrcPost('/api/rrc/stickers/telegram/import', { link: name });
    if (res.status !== 'success') { if (typeof showNotification === 'function') showNotification(res.error || 'Failed', 'error', 5000); return; }
    if (typeof showNotification === 'function') showNotification(`Importing ${name}…`, 'info', 3000);
    rrcStkWaitJobs();
}

// Until no import is running: the packs again each second.
function rrcStkWaitJobs() {
    if (RrcStk.waiting) return;
    RrcStk.waiting = true;
    const tick = () => rrcStkLoad(true).then(() => {
        const busy = RrcStk.packs.some(p => p.job && (p.job.state === 'download' || p.job.state === 'unpack'));
        const body = document.getElementById('rrc-tg-body');
        if (body && !body.hidden) rrcStkTgRender(body);
        if (busy) setTimeout(tick, 1000);
        else {
            RrcStk.waiting = false;
            const told = RrcStk.told ||= new Set();
            for (const p of RrcStk.packs) {
                if (p.kind !== 'tg' || !p.job || p.job.state !== 'error' || told.has(p.id + p.job.error)) continue;
                told.add(p.id + p.job.error);
                if (typeof showNotification === 'function') showNotification(p.job.error || 'Import failed', 'error', 6000);
            }
        }
    });
    setTimeout(tick, 1000);
}

document.addEventListener('click', e => {
    const get = e.target.closest('[data-rrc-stk-get]');
    if (!get) return;
    e.preventDefault();
    if (get.dataset.act === 'import') rrcStkGetTg(get.dataset.rrcStkGet);
    else rrcStkSettings(rrcStkIsTg(get.dataset.rrcStkGet) ? 'rrc-tg-block' : 'rrc-stickers-settings');
});

async function rrcSendSticker(pack, cp, emoji) {
    if (!Rrc.active) return;
    rrcStkCount(pack, cp, emoji);
    const { hub, room } = Rrc.active;
    const input = document.getElementById('rrc-input');
    if (input) { input.value = ''; rrcDraftReset(''); rrcGrow(input); }
    Rrc.inputs[rrcKey(hub, room)] = '';
    if (Rrc.stkPending) delete Rrc.stkPending[rrcKey(hub, room)];
    rrcStkPendingShow(null);
    rrcStkHide();
    document.getElementById('rrc-stk-panel')?.setAttribute('hidden', '');
    document.getElementById('rrc-emojis')?.setAttribute('hidden', '');
    rrcDropMarker(rrcKey(hub, room));
    await rrcPost(`/api/rrc/input/${hub}`, { room, text: emoji, sticker: [pack, cp] });
    pollRrc();
    if (Rrc.active) showRrcRoom(Rrc.active.hub, Rrc.active.room);
}

// Above the bar: the stickers of the one emoji typed, from every pack.
function rrcStkSuggest() {
    const box = document.getElementById('rrc-stk-suggest');
    const input = document.getElementById('rrc-input');
    if (!box || !input) return;
    // Closed with the x: stays shut in this room until the text changes.
    const key = Rrc.active ? rrcKey(Rrc.active.hub, Rrc.active.room) : '';
    // A sticker picked and waiting for Enter: shown over the bar until its emoji is changed.
    if (Rrc.stkPending?.[key] && Rrc.stkPending[key].emoji !== input.value) delete Rrc.stkPending[key];
    rrcStkPendingShow(Rrc.stkPending?.[key] || null);
    if (Rrc.stkPending?.[key]) { rrcStkHide(); return; }
    if (Rrc.stkClosed?.[key] !== undefined && Rrc.stkClosed[key] !== input.value) delete Rrc.stkClosed[key];
    const emoji = rrcStkOn() && Rrc.stkClosed?.[key] === undefined ? rrcStkSingle(input.value) : null;
    const cp = emoji ? rrcStkCp(emoji) : '';
    const hits = emoji ? rrcStkInstalled().flatMap(p => rrcStkKeys(p.id, cp).map(k => [p, k])).slice(0, 30) : [];
    if (!hits.length) { rrcStkHide(); return; }
    box.innerHTML = '<div class="rrc-stk-row">' + hits.map(([p, k]) => rrcStkItemBtn(p.id, k, emoji, `${p.name}: click to pick, Enter: the emoji`)).join('') + '</div>'
        + '<button class="rrc-stk-close" data-rrc-stk-close="1" title="Close the stickers" tabindex="-1">✕</button>';
    box.hidden = false;
}

// A click on a sticker puts it in the bar (as its emoji): Enter or Send sends it.
function rrcStkStage(pack, cp, emoji) {
    if (!Rrc.active) return;
    const key = rrcKey(Rrc.active.hub, Rrc.active.room);
    const input = document.getElementById('rrc-input');
    if (!input) return;
    input.value = emoji;
    rrcDraftReset(emoji);
    rrcGrow(input);
    Rrc.inputs[key] = emoji;
    (Rrc.stkPending ||= {})[key] = { pack, cp, emoji };
    document.getElementById('rrc-stk-panel')?.setAttribute('hidden', '');
    document.getElementById('rrc-emojis')?.setAttribute('hidden', '');
    input.focus();
    input.setSelectionRange(emoji.length, emoji.length);
    rrcStkSuggest();
}

function rrcStkPendingShow(pend) {
    const box = document.getElementById('rrc-stk-pending');
    if (!box) return;
    if (!pend) { box.hidden = true; box.innerHTML = ''; box.dataset.key = ''; return; }
    const key = pend.pack + '\t' + pend.cp;
    if (box.dataset.key !== key) {
        box.dataset.key = key;
        const still = rrcStkStill(pend.pack, pend.cp);
        const name = (rrcStkPack(pend.pack) || {}).name || '';
        box.innerHTML = (still ? `<img src="${still}" alt="" draggable="false">` : `<span class="rrc-stk-face">${rrcText(pend.emoji)}</span>`)
            + `<span class="rrc-stk-pend-txt">${rrcEsc(name)} sticker<br><b>Enter</b> to send</span>`
            + '<button class="rrc-stk-close" data-rrc-stk-unpend="1" title="Not the sticker" tabindex="-1">✕</button>';
    }
    box.hidden = false;
}

function rrcStkHide() {
    const box = document.getElementById('rrc-stk-suggest');
    if (box) box.hidden = true;
}

// The sticker button: shown with stickers on and a pack installed.
function rrcStkButton() {
    const btn = document.getElementById('rrc-stk-btn');
    if (btn) btn.hidden = !(rrcStkOn() && rrcStkInstalled().length);
}

// The panel: a tab per pack, the emoji of the picker in its groups.
// Recent tab: the stickers sent most, per browser.
const RRC_STK_RECENT = '__recent';
function rrcStkUse() {
    try {
        const u = JSON.parse(localStorage.getItem('rrc_stk_use') || '{}');
        return u && typeof u === 'object' ? u : {};
    } catch (e) {
        return {};
    }
}

function rrcStkCount(pack, cp, emoji) {
    const use = rrcStkUse();
    const k = pack + '\t' + cp;
    use[k] = { n: ((use[k] || {}).n || 0) + 1, t: Date.now(), e: emoji };
    const keys = Object.keys(use);
    if (keys.length > 200) keys.sort((a, b) => use[a].t - use[b].t).slice(0, keys.length - 200).forEach(x => delete use[x]);
    try { localStorage.setItem('rrc_stk_use', JSON.stringify(use)); } catch (e) { /* private window */ }
}

function rrcStkRecent() {
    const use = rrcStkUse();
    const on = new Set(rrcStkInstalled().map(p => p.id));
    return Object.keys(use).map(k => [...k.split('\t'), use[k]])
        .filter(([p, cp, u]) => on.has(p) && rrcStkHas(p, cp) && u && u.n)
        .sort((a, b) => b[2].n - a[2].n || b[2].t - a[2].t).slice(0, 24);
}

// The tab icon of a pack: its first sticker.
function rrcStkTabFace(pack) {
    const icons = RrcStk.icons && RrcStk.icons.rev === RrcStk.rev ? RrcStk.icons : (RrcStk.icons = { rev: RrcStk.rev });
    if (!(pack.id in icons)) {
        let key = null, emoji = '';
        if (pack.kind === 'tg') {
            const it = (pack.items || []).find(i => rrcStkStill(pack.id, i.id)) || (pack.items || [])[0];
            if (it) { key = it.id; emoji = it.emoji || ''; }
        } else {
            for (const [, , list] of RRC_EMOJI_GROUPS) {
                emoji = list.split(' ').find(e => rrcStkHas(pack.id, rrcStkCp(e))) || '';
                if (emoji) { key = rrcStkCp(emoji); break; }
            }
        }
        icons[pack.id] = [key, emoji];
    }
    const [key, emoji] = icons[pack.id];
    const still = key ? rrcStkStill(pack.id, key) : null;
    return still ? `<img src="${still}" alt="" draggable="false">` : `<span>${rrcText(emoji || pack.name.slice(0, 2))}</span>`;
}

// The active tab in view (the row scrolls sideways).
function rrcStkTabFocus(panel) {
    const row = panel.querySelector('.rrc-stk-tabs');
    const tab = row && row.querySelector('.rrc-stk-tab.on');
    if (tab) row.scrollLeft = tab.offsetLeft - (row.clientWidth - tab.offsetWidth) / 2;
}

function rrcStkPanelRender(panel, packId) {
    const packs = rrcStkInstalled();
    if (!packs.length) { panel.hidden = true; return; }
    if (!packId) { try { packId = localStorage.getItem('rrc_stk_tab'); } catch (e) { /* default */ } }
    const recent = rrcStkRecent();
    const isRecent = packId === RRC_STK_RECENT && recent.length > 0;
    const pack = isRecent ? null : (packs.find(p => p.id === packId) || (recent.length ? null : packs[0]));
    const cur = pack ? pack.id : RRC_STK_RECENT;
    panel.dataset.pack = cur;
    panel.dataset.built = cur + ':' + RrcStk.rev;
    try { localStorage.setItem('rrc_stk_tab', cur); } catch (e) { /* private window */ }
    const tab = (id, title, face) => `<button class="rrc-stk-tab${id === cur ? ' on' : ''}" data-rrc-stk-tab="${rrcEsc(id)}" title="${rrcEsc(title)}" tabindex="-1">${face}</button>`;
    const tabs = (recent.length ? tab(RRC_STK_RECENT, 'Recent', '<span class="rrc-stk-clock">🕘</span>') : '')
        + packs.map(p => tab(p.id, p.name, rrcStkTabFace(p))).join('');
    const body = !pack
        ? `<div class="rrc-stk-group">Recent</div><div class="rrc-stk-grid">${recent.map(([p, cp, u]) => rrcStkItemBtn(p, cp, u.e || '', u.e || '', true)).join('')}</div>`
        : pack.kind === 'tg'
        ? `<div class="rrc-stk-grid">${pack.items.map(it => rrcStkItemBtn(pack.id, it.id, it.emoji || '', it.emoji || '', true)).join('')}</div>`
        : RRC_EMOJI_GROUPS.map(([, name, list]) => {
            const items = list.split(' ').filter(e => rrcStkHas(pack.id, rrcStkCp(e)))
                .map(e => rrcStkItemBtn(pack.id, rrcStkCp(e), e, e, true)).join('');
            return items ? `<div class="rrc-stk-group">${rrcEsc(name)}</div><div class="rrc-stk-grid">${items}</div>` : '';
        }).join('');
    const credit = !pack ? 'Your most sent stickers'
        : pack.kind === 'tg' ? `${rrcEsc(pack.name)} - Telegram set ${rrcEsc(pack.set)}` : `${rrcEsc(pack.name)} - ${rrcEsc(pack.author)}, ${rrcEsc(pack.license)}`;
    panel.innerHTML = `<div class="rrc-stk-head"><div class="rrc-stk-tabs">${tabs}${window.rbGuest ? '' : `<button class="rrc-stk-tab rrc-stk-more" data-rrc-stk-more="1" title="Sticker packs: Settings > RRC Client" tabindex="-1">+</button>`}</div>
        <button class="rrc-stk-close" data-rrc-stk-x="1" title="Close the stickers" tabindex="-1">✕</button></div>
        <div class="rrc-stk-body">${body}</div>
        <div class="rrc-stk-credit">${credit}</div>
        <div class="rrc-stk-preview" hidden></div>`;
    rrcStkTabFocus(panel);
    rrcStkLoading(panel.querySelector('.rrc-stk-body'));
}

// One spinner for the whole tab, until the stickers in view are there.
function rrcStkLoading(el) {
    if (!el) return;
    const run = el.dataset.run = String((Number(el.dataset.run) || 0) + 1);
    const stop = () => { if (el.dataset.run === run) el.classList.remove('loading'); };
    requestAnimationFrame(() => {
        const bottom = el.getBoundingClientRect().bottom;
        const imgs = [...el.querySelectorAll('img')].filter(i => !i.complete && i.getBoundingClientRect().top < bottom);
        if (!imgs.length) return;
        el.classList.add('loading');
        let left = imgs.length;
        const one = () => { if (--left <= 0) stop(); };
        imgs.forEach(i => { i.addEventListener('load', one, { once: true }); i.addEventListener('error', one, { once: true }); });
        setTimeout(stop, 6000);
    });
}

// Big preview: mouse hover, or a long press on a phone.
function rrcStkPreview(panel, item) {
    const box = panel.querySelector('.rrc-stk-preview');
    if (!box) return;
    if (!item) { box.hidden = true; box.innerHTML = ''; box.dataset.key = ''; rrcStkSweep(); return; }
    const { rrcStk: pack, cp, emoji } = item.dataset;
    const key = pack + '\t' + cp;
    const pr = panel.getBoundingClientRect(), ir = item.getBoundingClientRect();
    box.classList.toggle('top', ir.top + ir.height / 2 > pr.top + pr.height / 2);
    if (box.dataset.key === key && !box.hidden) return;
    box.dataset.key = key;
    const name = (rrcStkPack(pack) || {}).name || '';
    box.innerHTML = `<span class="rrc-stk" data-pack="${rrcEsc(pack)}" data-cp="${rrcEsc(cp)}" data-emoji="${rrcEsc(emoji)}">${rrcText(emoji)}</span><small>${rrcText(emoji)} ${rrcEsc(name)}</small>`;
    rrcStkPaint(box);
    box.hidden = false;
}

function bindRrcStickers(view, input) {
    const panel = view.querySelector('#rrc-stk-panel');
    const box = view.querySelector('#rrc-stk-suggest');
    const pick = e => {
        const item = e.target.closest('[data-rrc-stk]');
        if (!item) return false;
        e.preventDefault();
        rrcStkStage(item.dataset.rrcStk, item.dataset.cp, item.dataset.emoji);
        return true;
    };
    // The sticker waiting in the bar: its x leaves the bar empty.
    view.querySelector('#rrc-stk-pending').addEventListener('mousedown', e => {
        e.preventDefault();
        if (!e.target.closest('[data-rrc-stk-unpend]') || !Rrc.active) return;
        const key = rrcKey(Rrc.active.hub, Rrc.active.room);
        if (Rrc.stkPending) delete Rrc.stkPending[key];
        input.value = '';
        rrcDraftReset('');
        rrcGrow(input);
        Rrc.inputs[key] = '';
        rrcStkSuggest();
    });
    // Suggestions: a click sends, a drag or the wheel scrolls the row (on a PC).
    let drag = null;
    box.addEventListener('mousedown', e => {
        if (e.target.closest('[data-rrc-stk-close]')) {
            e.preventDefault();
            if (Rrc.active) (Rrc.stkClosed ||= {})[rrcKey(Rrc.active.hub, Rrc.active.room)] = input.value;
            rrcStkHide();
            return;
        }
        const row = e.target.closest('.rrc-stk-row');
        if (row && e.offsetY >= row.clientHeight && e.target === row) return; // its scrollbar
        e.preventDefault();
        if (!row || e.button !== 0) return;
        drag = { x: e.clientX, left: row.scrollLeft, row, item: e.target.closest('[data-rrc-stk]'), moved: false };
    });
    document.addEventListener('mousemove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > 5) drag.moved = true;
        if (drag.moved) drag.row.scrollLeft = drag.left - dx;
    });
    document.addEventListener('mouseup', () => {
        const d = drag;
        drag = null;
        if (d && !d.moved && d.item) rrcStkStage(d.item.dataset.rrcStk, d.item.dataset.cp, d.item.dataset.emoji);
    });
    box.addEventListener('wheel', e => {
        const row = e.target.closest('.rrc-stk-row');
        if (!row || row.scrollWidth <= row.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        e.preventDefault();
        row.scrollLeft += e.deltaY;
    }, { passive: false });
    view.querySelector('#rrc-stk-btn').addEventListener('mousedown', e => {
        e.preventDefault();
        panel.hidden = !panel.hidden;
        rrcStkPreview(panel, null);
        if (!panel.hidden) {
            // Built once per pack: reopened, the pictures are already there (Recent changes, so always).
            const cur = panel.dataset.pack || '';
            if (!cur || cur === RRC_STK_RECENT || panel.dataset.built !== cur + ':' + RrcStk.rev) rrcStkPanelRender(panel, cur);
            else rrcStkTabFocus(panel);
            for (const id of ['#rrc-emojis', '#rrc-style']) { const o = view.querySelector(id); if (o) o.hidden = true; }
        }
    });
    // A picture that does not load: its emoji.
    const broken = e => {
        const item = e.target.closest && e.target.closest('.rrc-stk-item');
        if (item) item.innerHTML = `<span class="rrc-stk-face">${rrcText(item.dataset.emoji)}</span>`;
    };
    for (const el of [panel, box]) el.addEventListener('error', broken, true);
    let hover = null, press = null, pressed = 0;
    panel.addEventListener('pointerover', e => {
        if (e.pointerType !== 'mouse') return;
        const item = e.target.closest('.rrc-stk-body .rrc-stk-item');
        clearTimeout(hover);
        if (!item) { rrcStkPreview(panel, null); return; }
        const shown = !panel.querySelector('.rrc-stk-preview')?.hidden;
        hover = setTimeout(() => rrcStkPreview(panel, item), shown ? 0 : 350);
    });
    panel.addEventListener('pointerleave', () => { clearTimeout(hover); rrcStkPreview(panel, null); });
    panel.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse') return;
        const item = e.target.closest('.rrc-stk-body .rrc-stk-item');
        clearTimeout(press);
        pressed = 0;
        if (item) press = setTimeout(() => { pressed = Date.now(); rrcStkPreview(panel, item); }, 400);
    });
    const release = () => { clearTimeout(press); if (pressed) setTimeout(() => rrcStkPreview(panel, null), 0); };
    panel.addEventListener('pointerup', release);
    panel.addEventListener('pointercancel', release);
    // No "save image / open in new tab" menu on a long press.
    panel.addEventListener('contextmenu', e => { if (e.target.closest('.rrc-stk-item')) e.preventDefault(); });
    panel.addEventListener('mousedown', e => {
        e.preventDefault();
        const tab = e.target.closest('[data-rrc-stk-tab]');
        if (tab) { rrcStkPreview(panel, null); rrcStkPanelRender(panel, tab.dataset.rrcStkTab); return; }
        if (e.target.closest('[data-rrc-stk-more]')) { panel.hidden = true; rrcStkSettings(); return; }
        if (e.target.closest('[data-rrc-stk-x]')) { panel.hidden = true; rrcStkPreview(panel, null); return; }
        // After a long press the finger lifts: no send.
        if (pressed) { pressed = 0; return; }
        pick(e);
    });
    document.addEventListener('mousedown', e => {
        if (!panel.hidden && e.target.isConnected && !e.target.closest('#rrc-stk-panel, #rrc-stk-btn')) { panel.hidden = true; rrcStkPreview(panel, null); }
    });
    input.addEventListener('input', rrcStkSuggest);
    input.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !box.hidden) rrcStkHide();
        if (e.key === 'Enter') rrcStkHide();
    });
    rrcStkLoad();
}

// ─── Settings > RRC Client > Stickers ───

function rrcStickerSettingsWire() {
    const toggle = document.getElementById('setting-rrc-stickers');
    const list = document.getElementById('rrc-sticker-packs');
    const tgBlock = document.getElementById('rrc-tg-block');
    const tgToggle = document.getElementById('setting-rrc-tg-stickers');
    const tgBody = document.getElementById('rrc-tg-body');
    if (!toggle || !list) return;
    const show = () => {
        list.hidden = !toggle.classList.contains('active');
        if (tgBlock) tgBlock.hidden = list.hidden;
        if (tgBody) tgBody.hidden = list.hidden || !tgToggle.classList.contains('active');
        if (!list.hidden) rrcStkLoad(true).then(() => {
            rrcStkSettingsRender(list);
            if (tgBody && !tgBody.hidden) rrcStkTgRender(tgBody);
        });
    };
    if (!toggle.dataset.stkWired) {
        toggle.dataset.stkWired = '1';
        toggle.addEventListener('click', () => setTimeout(show, 0));
        list.addEventListener('click', e => {
            const b = e.target.closest('[data-stk-act]');
            if (b) rrcStkAct(b.dataset.stkAct, b.dataset.stkPack, list);
        });
        if (tgToggle && tgBody) {
            tgToggle.addEventListener('click', () => setTimeout(() => {
                show();
                if (tgToggle.classList.contains('active')) rrcStkLottieAsk(tgBody);
            }, 0));
            tgBody.addEventListener('click', e => {
                const b = e.target.closest('[data-tg-act]');
                if (b) rrcStkTgAct(b.dataset.tgAct, b.dataset.stkPack, tgBody);
            });
            tgBody.addEventListener('keydown', e => {
                if (e.key !== 'Enter') return;
                if (e.target.id === 'rrc-tg-token') { e.preventDefault(); rrcStkTgAct('token', '', tgBody); }
                if (e.target.id === 'rrc-tg-link') { e.preventDefault(); rrcStkTgAct('import', '', tgBody); }
            });
        }
    }
    show();
}

// Telegram switch on: offer lottie-web for the animated ones, once.
async function rrcStkLottieAsk(body) {
    await rrcStkLoad(true);
    if (!RrcStk.tg || RrcStk.tg.lottie) return;
    const ok = typeof confirmDialog === 'function'
        ? await confirmDialog('Animated stickers', `Download animated sticker support (lottie-web, 168 KB, MIT)?<br>Without it animated stickers show as a still picture.`, 'Download') : false;
    if (ok) await rrcStkTgAct('lottie-install', '', body);
}

function rrcStkTgRender(body) {
    const tg = RrcStk.tg || {};
    const busyNow = p => p.job && (p.job.state === 'download' || p.job.state === 'unpack');
    const token = tg.token
        ? `<div class="settings-row"><span>Bot <b>@${rrcEsc(tg.bot || '?')}</b> <small>token saved on this rBrowser only</small></span>
              <button class="msg-bar-btn" data-tg-act="token-remove">Remove</button></div>`
        : `<div class="settings-row rrc-tg-field"><input type="password" id="rrc-tg-token" class="msg-search" aria-label="Telegram bot token" placeholder="Telegram bot token (123456:ABC...)" autocomplete="off" spellcheck="false">
              <button class="msg-bar-btn" data-tg-act="token">Save</button></div>`;
    const link = `<div class="settings-row rrc-tg-field"><input type="text" id="rrc-tg-link" class="msg-search" aria-label="Telegram sticker link" placeholder="tg://addstickers?set=NAME or t.me/addstickers/NAME" autocomplete="off" spellcheck="false"${tg.token ? '' : ' disabled'}>
              <button class="msg-bar-btn primary" data-tg-act="import"${tg.token ? '' : ' disabled'}>Import</button></div>`;
    const lottie = tg.lottie
        ? `<div class="settings-row"><span>Animated stickers <small>lottie-web installed</small></span><button class="msg-bar-btn" data-tg-act="lottie-remove">Remove</button></div>`
        : `<div class="settings-row"><span>Animated stickers <small>still picture only</small></span><button class="msg-bar-btn" data-tg-act="lottie-install">Download 168 KB</button></div>`;
    const sets = RrcStk.packs.filter(p => p.kind === 'tg').map(p => {
        let state, button = '';
        if (busyNow(p)) {
            state = p.job.total ? `Importing… ${p.job.done}/${p.job.total}` : 'Importing…';
        } else if (p.installed) {
            state = `${p.count} stickers · ${p.size_mb} MB`;
            button = `<button class="msg-bar-btn" data-tg-act="remove" data-stk-pack="${rrcEsc(p.id)}">Remove</button>`;
        } else {
            state = 'Not imported';
            button = `<button class="msg-bar-btn" data-tg-act="dismiss" data-stk-pack="${rrcEsc(p.id)}">OK</button>`;
        }
        const err = p.job && p.job.state === 'error' ? `<div class="rrc-stk-err">${rrcEsc(p.job.error || 'Import failed')}</div>` : '';
        const first = p.installed && p.items[0] ? rrcStkStill(p.id, p.items[0].id) : null;
        const shot = first ? `<img class="rrc-stk-prev" src="${first}" alt="" draggable="false">` : '';
        return `<div class="settings-row rrc-stk-pack">
            <span>${shot}<a href="${rrcEsc(p.home)}" target="_blank" rel="noopener">${rrcEsc(p.name)}</a>
                <small>${state}</small>${err}</span>${button}</div>`;
    }).join('');
    const kept = ['rrc-tg-token', 'rrc-tg-link'].map(id => [id, document.getElementById(id)?.value || '']);
    const focus = document.activeElement?.id;
    body.innerHTML = `<div class="settings-hint">Telegram sets come from Telegram through a bot of your own:
        in Telegram open @BotFather, send /newbot and paste the token it gives you here.</div>${token}${link}${lottie}${sets}`;
    for (const [id, v] of kept) { const el = document.getElementById(id); if (el && v) el.value = v; }
    if (focus) document.getElementById(focus)?.focus();
    if (RrcStk.packs.some(p => p.kind === 'tg' && busyNow(p))) rrcStkWaitJobs();
}

async function rrcStkTgAct(act, pack, body) {
    const note = (text, kind = 'error') => typeof showNotification === 'function' && showNotification(text, kind, 5000);
    let res;
    if (act === 'token') {
        const value = (document.getElementById('rrc-tg-token')?.value || '').trim();
        if (!value) return;
        res = await rrcPost('/api/rrc/stickers/telegram/token', { token: value });
        if (res.status === 'success') note(`Bot @${res.bot} ready`, 'success');
    } else if (act === 'token-remove') {
        res = await rrcPost('/api/rrc/stickers/telegram/token', { token: '' });
    } else if (act === 'import') {
        const input = document.getElementById('rrc-tg-link');
        const value = (input?.value || '').trim();
        if (!value) return;
        res = await rrcPost('/api/rrc/stickers/telegram/import', { link: value });
        if (res.status === 'success' && input) input.value = '';
    } else if (act === 'lottie-install' || act === 'lottie-remove') {
        res = await rrcPost(`/api/rrc/stickers-lottie/${act.slice(7)}`);
        if (res.status === 'success' && act === 'lottie-install') { note('Animated stickers ready', 'success'); rrcStkLottie(); }
    } else if (act === 'remove') {
        const p = rrcStkPack(pack);
        const ok = typeof confirmDialog === 'function'
            ? await confirmDialog('Remove sticker set', `Remove <b>${rrcEsc(p ? p.name : pack)}</b>? You can import it again later.`, 'Remove') : true;
        if (!ok) return;
        res = await rrcPost(`/api/rrc/stickers/${encodeURIComponent(pack)}/remove`);
    } else if (act === 'dismiss') {
        res = await rrcPost(`/api/rrc/stickers/${encodeURIComponent(pack)}/remove`);
    } else return;
    if (res.status !== 'success') note(res.error || 'Failed');
    await rrcStkLoad(true);
    rrcStkTgRender(body);
}

function rrcStkSettingsRender(list) {
    const mb = v => v == null ? '' : `${v} MB`;
    list.innerHTML = `<div class="settings-hint">Downloaded from their official sources, nothing comes with rBrowser.
        Others see your stickers only with the same pack; everyone else gets the emoji.</div>` +
        RrcStk.packs.filter(p => p.kind !== 'tg').map(p => {
            const job = p.job;
            let state, button;
            if (job && (job.state === 'download' || job.state === 'unpack')) {
                const pct = job.total ? Math.round(job.done * 100 / job.total) : 0;
                state = job.state === 'unpack' ? 'Unpacking…' : `Downloading… ${job.total ? pct + '%' : mb(Math.round(job.done / 1e5) / 10)}`;
                button = '';
            } else if (p.installed) {
                state = `${p.count} stickers · ${mb(p.size_mb)}`;
                button = `<button class="msg-bar-btn" data-stk-act="remove" data-stk-pack="${p.id}">Remove</button>`;
            } else {
                state = `Download ${mb(p.download_mb)}${p.disk_mb ? ` · ${mb(p.disk_mb)} on disk` : ''}`;
                button = `<button class="msg-bar-btn" data-stk-act="install" data-stk-pack="${p.id}">Download</button>`;
            }
            const err = job && job.state === 'error' ? `<div class="rrc-stk-err">${rrcEsc(job.error || 'Download failed')}</div>` : '';
            const shot = p.installed ? `<img class="rrc-stk-prev" src="${rrcStkUrl(p.id, '1f600')}" alt="" draggable="false">` : '';
            return `<div class="settings-row rrc-stk-pack">
                <span>${shot}<a href="${rrcEsc(p.home)}" target="_blank" rel="noopener" title="${rrcEsc(p.author)}">${rrcEsc(p.name)}</a>
                    <small>${rrcEsc(p.license)} · ${state}</small>${err}</span>${button}</div>`;
        }).join('');
    const busy = RrcStk.packs.some(p => p.job && (p.job.state === 'download' || p.job.state === 'unpack'));
    if (busy && !RrcStk.polling) {
        RrcStk.polling = true;
        setTimeout(() => {
            RrcStk.polling = false;
            if (list.isConnected && !list.hidden) rrcStkLoad(true).then(() => rrcStkSettingsRender(list));
        }, 1000);
    }
}

async function rrcStkAct(act, pack, list) {
    const p = rrcStkPack(pack);
    if (!p) return;
    if (act === 'remove') {
        const ok = typeof confirmDialog === 'function'
            ? await confirmDialog('Remove sticker pack', `Remove <b>${rrcEsc(p.name)}</b>? You can download it again later.`, 'Remove') : true;
        if (!ok) return;
    }
    const res = await rrcPost(`/api/rrc/stickers/${pack}/${act}`);
    if (res.status !== 'success' && typeof showNotification === 'function') showNotification(res.error || 'Failed', 'error', 5000);
    await rrcStkLoad(true);
    rrcStkSettingsRender(list);
}
