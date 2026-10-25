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
                <input type="text" id="rrc-address" class="msg-search" placeholder="Hub address (32 hex)" spellcheck="false" autocomplete="off">
                <button class="msg-bar-btn primary" id="rrc-address-go">Connect</button>
            </div>
            <input type="text" id="rrc-filter" class="msg-search bbs-filter" placeholder="Search hubs" spellcheck="false" autocomplete="off">
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
                <span class="rrc-prompt" id="rrc-prompt"></span>
                <button class="rrc-emoji-btn rrc-cmds-btn" id="rrc-cmds-btn" title="Commands (or type /)" aria-label="Commands">/</button>
                <textarea id="rrc-input" class="bbs-input rrc-input-area" rows="1" spellcheck="false" autocomplete="off"
                       placeholder="Message - Shift+Enter new line, /help for the commands, Tab completes a nick, ↑↓ earlier lines"></textarea>
                <button class="rrc-emoji-btn" id="rrc-emoji-btn" title="Emoji" aria-label="Emoji">☺</button>
                <button class="msg-send" id="rrc-send" title="Send (Enter)" aria-label="Send"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 8l11-5.5L9.5 14 7.5 9z" fill="currentColor"/></svg></button>
            </div>
        </div>`;
    document.getElementById('tab-content-wrapper').appendChild(view);
    bindRrcView(view);
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
    const emojis = view.querySelector('#rrc-emojis');
    view.querySelector('#rrc-emoji-btn').addEventListener('mousedown', e => {
        e.preventDefault();
        if (!emojis.childElementCount) emojis.innerHTML = RRC_EMOJIS.map(x => `<button class="rrc-emoji" data-rrc-emoji="${x}" tabindex="-1">${x}</button>`).join('');
        emojis.hidden = !emojis.hidden;
    });
    emojis.addEventListener('mousedown', e => {
        const item = e.target.closest('[data-rrc-emoji]');
        if (!item) return;
        e.preventDefault();                 // the input keeps the focus
        const at = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? at;
        input.value = input.value.slice(0, at) + item.dataset.rrcEmoji + input.value.slice(end);
        const pos = at + item.dataset.rrcEmoji.length;
        input.setSelectionRange(pos, pos);
        input.focus();
    });
    document.addEventListener('mousedown', e => {
        if (!cmds.hidden && !e.target.closest('#rrc-cmds, #rrc-cmds-btn, #rrc-input')) cmds.hidden = true;
        if (!emojis.hidden && !e.target.closest('#rrc-emojis, #rrc-emoji-btn')) emojis.hidden = true;
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
    return wins.find(w => w.r.mentions) || wins.find(w => w.r.unread) || null;
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

function applyRrcVisibility() {
    const on = rrcEnabled();
    if (on) ensureRrcTab();
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
        badge.hidden = !(mentions || unread);
        badge.textContent = mentions ? `@${mentions}` : String(unread);
        badge.classList.toggle('rrc-badge-quiet', !mentions);
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

async function pollRrc() {
    if (Rrc.busy) return;
    Rrc.busy = true;
    try {
        try { Rrc.state = await fetch('/api/rrc').then(r => r.json()); } catch (e) { return; }
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
            pane.el.appendChild(el);
            rrcStartFold(pane, line, el);
        }
        while (pane.el.childElementCount > 1500) pane.el.firstElementChild.remove();
        if (stick || firstLoad) pane.el.scrollTop = pane.el.scrollHeight;
        if (!firstLoad) { rrcAlert(address, line, data.hub.me); rrcEventLine(address, line); }
    }
}

function rrcLooking(address, room) {
    return Rrc.open && !document.hidden && Rrc.active && Rrc.active.hub === address && Rrc.active.room === (room || '');
}

// A line from someone else: what counts as news.
function rrcCounts(line, me) {
    return !!line.src && line.src !== me && ['msg', 'action', 'notice'].includes(line.kind);
}

// News while you look elsewhere: the sound always (Settings > System >
// Sounds decides if it plays), the popup as the RRC settings say.
function rrcAlert(address, line, me) {
    if (typeof appWindowElsewhere === 'function' && appWindowElsewhere('rrc')) return;   // its window tells
    // Someone comes into one of your rooms: a sound only (off by default).
    if (line.kind === 'join' && line.src && line.src !== me && line.room) {
        if (typeof playSound === 'function') playSound('rrc_join');
        return;
    }
    if (!rrcCounts(line, me)) return;
    // The sound also in the window you are looking at; the popup
    // only for the others.
    if (rrcLooking(address, line.room) && document.hasFocus()) {
        if (typeof playSound === 'function') playSound(line.mention ? 'rrc_mention' : 'rrc_message');
        return;
    }
    // Who and where only, never the text: a bot's long lines made huge popups.
    const where = line.room ? `Channel: #${line.room}` : `Hub: ${(rrcHub(address) || {}).name || 'RRC'}`;
    const text = `New message from: <b>${rrcEsc(line.nick)}</b><br>${rrcEsc(where)}`;
    if (line.mention) {
        if (typeof playSound === 'function') playSound('rrc_mention');
        if (rrcSetting('notify_mentions', true)) showNotification(text, 'info', 6000);
    } else {
        if (typeof playSound === 'function') playSound('rrc_message');
        if (rrcSetting('notify_messages', false)) showNotification(text, 'info', 4000);
    }
}

// A hub connects, drops or fails: a sound, and a word if you are elsewhere.
function rrcStateChanged(address, before, now) {
    if (!before || before === now || now === 'connecting') return;
    if (typeof appWindowElsewhere === 'function' && appWindowElsewhere('rrc')) return;
    if (typeof playSound === 'function') playSound('rrc_state');
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
    if (typeof playSound === 'function') playSound('rrc_state');
    if (rrcSetting('notify_events', true)) showNotification(`RRC: ${rrcEsc(line.text)}`, 'warning', 6000);
}

// The window on screen is read (the counts go to zero on the server).
function rrcReadInFront() {
    if (!Rrc.active || !Rrc.open || document.hidden) return;
    const r = rrcRoomOf(Rrc.active.hub, Rrc.active.room);
    if (r && (r.unread || r.mentions)) {
        r.unread = r.mentions = 0;
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
        el.className = 'rrc-screen';
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
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}

// Links, as NomadNet's chat makes them: web addresses, lxmf@<hash> or lxmf://<hash> (the
// messenger), a 32 hex address with an optional :/page path (NomadNet), a
// #room (joined on this hub), an RRC hub (rrc://<hash>/room, MeshChatX's
// meshchatx://relay?hub=...). And `code`.
const RRC_LINKS = /(\bhttps?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]])|(?<![\w@])lxmf(?:@|:\/\/)([0-9a-f]{32})(?!\w)\/?|(?<![@\w/])([0-9a-f]{32}(?::\/[^\s<>"']*[^\s<>"'.,;:!?)\]])?)(?![\w])|(?<![\w&#])#([a-z0-9][a-z0-9_\-]{0,62})|`([^`\n]+)`|(\b(?:rrc:\/\/[0-9a-f]{32}(?:\/[^\s<>"']*[^\s<>"'.,;:!?)\]])?|(?:meshchatx|meshchat):\/\/relay\?[^\s<>"']+))/gi;

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
        { label: 'Reply', tip: 'Quotes this line in the box: write the answer under it',
          run: () => rrcReplyTo(said.dataset.replyNick, said.dataset.replyText) },
        { label: 'Copy text', run: () => copyText(said.dataset.replyText, 'Text copied') },
        { label: 'Room menu…', run: () => rrcRoomMenu(at, hub, room) },
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
    const ts = `<span class="rrc-ts">${cont ? '' : `[${rrcTime(line.ts)}]`}</span>`;
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
        div.innerHTML = `${ts}<span class="rrc-who"${cont ? ' aria-hidden="true"' : ''}>&lt;${nickHtml}&gt;</span><span class="rrc-text">${rrcQuoted(line.text)}</span>`;
    } else if (line.kind === 'action') {
        div.innerHTML = `${ts}<span class="rrc-text" style="color:${color}">* ${nickHtml} ${rrcText(line.text)}</span>`;
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
    pane.last = line;
    return div;
}

// Joins and parts in a row, one line: "⇄ → a, b joined · ← c left"
// (Settings > RRC Client > Compact joins and parts). Anything else said, a
// "new" line, or ten minutes, starts a new one.
function rrcStartFold(pane, line, el) {
    const on = rrcSetting('compact_joins', true) !== false;
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
        || line.ts - g.ts > 600 || rrcSetting('compact_joins', true) === false
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
    g.el.innerHTML = `<span class="rrc-ts">[${rrcTime(g.ts)}]</span><span class="rrc-sign">${rrcSign('fold')}</span><span class="rrc-text">${parts.join(' · ')}</span>`;
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
        input.value = Rrc.inputs[key] || '';
        rrcGrow(input);
        if (Rrc.open && !window.matchMedia('(max-width: 700px)').matches) input.focus();
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
    if (!r || !(r.unread || r.mentions)) return '';
    // The hub window: /who, /list and the like grow its count for nothing,
    // a blue dot says enough.
    if (!r.name && !r.mentions) return '<span class="rrc-hub-dot" title="Something new in the hub window"></span>';
    // New messages: orange, a balloon and how many; mentions: red, @N.
    return r.mentions
        ? `<span class="rrc-new-badge rrc-new-at" title="${r.mentions} new ${r.mentions === 1 ? 'mention' : 'mentions'}">@${r.mentions}</span>`
        : `<span class="rrc-new-badge" title="${r.unread} new ${r.unread === 1 ? 'message' : 'messages'}">${RRC_MSG_ICON}${r.unread}</span>`;
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
            <button class="msg-bar-btn auto-reply-btn${typeof autoReplyAnyOn === 'function' && autoReplyAnyOn('rrc') ? ' on' : ''}" data-kind="rrc" onclick="toggleAutoReplyMenu(this, 'rrc')" title="Automatic replies: keywords, away, echo (green dot: one is on)">AutoReply</button>${awayButton('rrc')}
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

function rrcNarrow() { return window.matchMedia('(max-width: 700px)').matches; }

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
    if (!Rrc.dragging) box.style.width = window.matchMedia('(max-width: 700px)').matches ? '' : `${rrcUsersWidth()}px`;
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
    const after = s.slice(m.index + 32).replace(/^[:/]+/, '').trim();
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

async function rrcRun(text, split = false) {
    if (!Rrc.active) return;
    const { hub, room } = Rrc.active;
    const res = await rrcPost(`/api/rrc/input/${hub}`, { room, text, split });
    // Over the hub's limit: in parts "(1/3) ...", if you say so (NomadNet's way).
    if (res.too_long) {
        const ok = await confirmDialog('Message too long',
            `This hub takes ${res.max} bytes per message. Send it in <b>${res.parts} parts</b>, each starting with (1/${res.parts})…?`,
            `Send ${res.parts} parts`);
        if (ok) return rrcRun(text, true);
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
    input.value = '';
    Rrc.inputs[rrcKey(Rrc.active.hub, Rrc.active.room)] = '';
    if (Rrc.history[0] !== text) Rrc.history.unshift(text);
    Rrc.history.length = Math.min(Rrc.history.length, 50);
    Rrc.historyAt = -1;
    rrcDropMarker(rrcKey(Rrc.active.hub, Rrc.active.room));      // you answered: seen
    await rrcRun(text);
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
        <input type="text" class="rrc-who-search" placeholder="Search, or a room name + Enter to join" spellcheck="false" autocomplete="off">
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
        <input type="text" class="rrc-who-search" placeholder="Search nick or hash" spellcheck="false" autocomplete="off">
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
    const mod = (label, cmd, tip, danger) => ({ label, danger, run: () => run(cmd), tip: `${cmd} - ${tip}` });
    const actions = [
        { label: 'Info', run: () => rrcUserInfo(hub, id, name), tip: 'Nick, identity, rooms; their LXMF address, node and hub' },
        { label: 'Mention', disabled: isMe || !room, run: () => {
            const input = document.getElementById('rrc-input');
            input.value = rrcWithMention(input.value, name);
            input.focus();
        }, tip: 'Their nick in the command line' },
        { label: 'Message on LXMF', disabled: id.length !== 32 || isMe, run: () => rrcUserInfo(hub, id, name, 'lxmf'),
          tip: id.length === 32 ? 'Their LXMF address follows from their identity' : 'Only the first 12 characters of the hash are known yet' },
        { label: 'Copy nick', disabled: !nick && !(member && member.nick), run: () => copyText(name, 'Nick copied') },
        { label: 'Copy identity hash', run: () => copyText(id, 'Identity hash copied'), tip: 'Who they are: nicks change, this does not' },
        { label: ignored ? 'Stop ignoring' : 'Ignore', disabled: isMe, danger: !ignored,
          run: () => rrcPost('/api/rrc/ignore', { id, on: !ignored, nick: name }).then(res => {
              if (res.status === 'success') showNotification(ignored ? `${rrcEsc(name)}: shown again` : `${rrcEsc(name)} ignored: their lines are hidden, on every hub`, 'info', 4000);
              else showNotification(rrcEsc(res.error), 'error', 4000);
              pollRrc();
          }), tip: 'Here only: nothing is sent to the hub' },
    ];
    if (room) {
        actions.push('-', { group: 'Room operator (the hub refuses if you are not)' },
            role === 'o' ? mod(isMe ? 'Deop yourself' : 'Deop', `/mode ${room} -o ${target}`, 'take operator away, the room is told')
                : mod('Op', `/mode ${room} +o ${target}`, 'make operator, the room is told'),
            role === 'v' ? mod(isMe ? 'Devoice yourself' : 'Devoice', `/mode ${room} -v ${target}`, 'take voice away, the room is told')
                : mod('Voice', `/mode ${room} +v ${target}`, 'let talk when the room is moderated (+m), the room is told'));
        if (!isMe) {
            actions.push(mod('Kick', `/kick ${room} ${target}`, 'remove from the room', true),
                mod('Ban', `/ban ${room} add ${target}`, 'ban from the room', true),
                mod('Unban', `/ban ${room} del ${target}`, 'lift the ban'),
                mod('Invite', `/invite ${room} add ${target}`, 'on the invite list (rooms +i)'));
        }
    }
    if (!isMe && id.length === 32) {
        actions.push({ group: 'Server operator' }, mod('K-line', `/kline add ${id}`, 'ban from the whole hub', true));
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
    const fallback = h && h.nick_source === 'default' ? `the Default nick` : 'hash only (Default nick off)';
    const overlay = rrcModal('rrc-nick', `Nick on ${rrcEsc((h && h.name) || 'this hub')}`, `
        <input type="text" class="rrc-who-search" maxlength="64" placeholder="Empty: ${rrcEsc(fallback)}" spellcheck="false" autocomplete="off">
        <div class="rrc-who-foot">Only on this hub, saved in Settings > RRC Client > Saved hubs. A label: hubs know you by your identity, and show the new nick from your next message.
            <button class="msg-bar-btn primary" data-ok>Set</button></div>`);
    const field = overlay.querySelector('input');
    field.value = (h && h.nick_source === 'hub' && h.nick) || '';
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

const RRC_EMOJIS = ['😀', '😂', '🤣', '😊', '😉', '😍', '😎', '🤔', '😅', '😭', '😡', '😱',
    '👍', '👎', '👋', '🙏', '👏', '💪', '🤝', '✌️', '🎉', '🔥', '❤️', '💯',
    '✅', '❌', '⚠️', '❓', '💡', '📡', '📻', '🛰️', '🌍', '⚡', '🔒', '🔑',
    '☕', '🍺', '🍕', '🐱', '🐶', '🌙', '☀️', '🌧️', '😴', '🤖', '👀', '🚀'];

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
            <input type="text" class="rrc-who-search" placeholder="${rrcEsc(placeholder || '')}" spellcheck="false" autocomplete="off">
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
        { label: 'Who is in the room', disabled: !on || !r.joined, run: () => rrcShowWho(hub, room) },
        { label: 'Topic', disabled: !on, run: () => run(`/topic ${room}`), tip: 'Ask the hub for the topic' },
        { label: 'Ban list', disabled: !on, run: () => run(`/ban ${room} list`), tip: 'Who is banned here (anyone can look)' },
        { label: 'Copy the room link', run: () => copyText(`rrc://${hub}/${room}`, 'Room link copied'), tip: 'rrc://hub/room: opens this room in rBrowser' },
        r.joined ? { label: `Part #${room}`, run: () => rrcCloseWindow(hub, room) }
            : { label: `Join #${room}`, disabled: !on, run: () => rrcPost(`/api/rrc/join/${hub}`, { room }).then(pollRrc) },
        '-', { group: 'Operator (the hub refuses if you are not)' },
        { label: 'Set the topic…', disabled: !on, run: ask(`Topic of #${room}`, '', 'New topic', v => `/topic ${room} ${v}`) },
        flag('m', 'Moderated (+m)', 'Only operators and voice can talk'),
        flag('i', 'Invite only (+i)', 'Only the invited can join'),
        flag('t', 'Topic by operators only (+t)', ''),
        flag('n', 'No messages from outside (+n)', 'Only people in the room can write to it'),
        flag('p', 'Private (+p)', 'Not in /list'),
        modes.includes('k')
            ? { label: 'Remove the key (-k)', check: true, disabled: !on, run: () => run(`/mode ${room} -k`) }
            : { label: 'Set a key (+k)…', check: false, disabled: !on, run: ask(`Key of #${room}`, 'A password to join the room.', 'Key', v => `/mode ${room} +k ${v}`) },
        { label: 'Register the room', disabled: !on, run: () => run(`/register ${room}`), tip: 'The hub keeps the room, its topic, modes and lists' },
        { label: 'Unregister the room', disabled: !on, danger: true, run: () => run(`/unregister ${room}`) },
        { label: 'Invite someone…', disabled: !on, run: ask('Invite', `To #${rrcEsc(room)}: a nick or a hash.`, 'nick', v => `/invite ${room} add ${v}`) },
        { label: 'Invite list', disabled: !on, run: () => run(`/invite ${room} list`) },
        { label: 'Unban…', disabled: !on, run: ask('Unban', `In #${rrcEsc(room)}: a nick or a hash from the ban list.`, 'hash', v => `/ban ${room} del ${v}`) },
    ];
    openNodeMenu(anchor, `#${room}${modes ? ' ' + modes : ''}`, h.name || hub, actions);
}

function rrcHubMenu(anchor, hub) {
    const h = rrcHub(hub);
    if (!h) return;
    const on = h.state === 'connected';
    const run = text => rrcRunIn(hub, '', text);
    const actions = [
        { label: 'Rooms', disabled: !on, run: () => rrcShowRooms(hub) },
        { label: 'Join a room…', disabled: !on, run: async () => {
            const v = await rrcAsk('Join a room', '', 'general');
            if (!v) return;
            const res = await rrcPost(`/api/rrc/join/${hub}`, { room: v });
            if (res.status !== 'success') { showNotification(rrcEsc(res.error), 'error', 4000); return; }
            await pollRrc();
            showRrcRoom(hub, res.room);
        } },
        { label: 'Ping', disabled: !on, run: () => run('/ping') },
        { label: 'Nick…', run: () => rrcNickDialog(hub) },
        { label: 'Copy the hub address', run: () => copyText(hub, 'Hub address copied') },
        { label: 'Copy your identity hash', run: () => copyText(h.me, 'Your identity hash copied') },
        { label: 'What the colours mean', run: rrcShowLegend },
        on || h.state === 'connecting' ? { label: 'Disconnect', run: () => rrcPost(`/api/rrc/disconnect/${hub}`).then(pollRrc) }
            : { label: 'Connect', run: () => rrcConnect(hub) },
        { label: 'Close the hub', danger: true, run: () => rrcCloseWindow(hub, '') },
        '-', { group: 'Server operator (the hub refuses if you are not)' },
        { label: 'Hub statistics', disabled: !on, run: () => run('/stats') },
        { label: 'K-line list', disabled: !on, run: () => run('/kline list'), tip: 'Banned from the whole hub' },
        { label: 'K-line someone…', disabled: !on, danger: true, run: async () => {
            const v = await rrcAsk('K-line', 'Banned from the whole hub: a nick or a hash.', 'nick or hash');
            if (v) run(`/kline add ${v}`);
        } },
        { label: 'Remove a K-line…', disabled: !on, run: async () => {
            const v = await rrcAsk('Remove a K-line', 'A hash from the K-line list.', 'hash');
            if (v) run(`/kline del ${v}`);
        } },
        { label: 'Reload the hub configuration', disabled: !on, danger: true, run: async () => {
            if (await confirmDialog('Reload the hub?', 'The hub reads its configuration and rooms again (/reload).', 'Reload')) run('/reload');
        } },
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
    ['invite', '<room> add|del|list [nick|hash]', 'Invite list (rooms +i)', 'op'],
    ['register', '<room>', 'The hub keeps the room', 'founder'],
    ['unregister', '<room>', 'Unregister the room', 'founder'],
    ['kline', 'add|del|list [nick|hash]', 'Ban from the whole hub', 'sop'],
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
    set('setting-rrc-compact', st.settings.compact_joins !== false);
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
    value('setting-rrc-back-notice-text', st.settings.back_notice_text);
    value('setting-rrc-autoreply-scope', st.settings.autoreply_scope || 'all');
    const nick = document.getElementById('setting-rrc-nick');
    if (nick) nick.value = st.settings.nick || '';
    const words = document.getElementById('setting-rrc-highlight');
    if (words) words.value = st.settings.highlight || '';
    const select = document.getElementById('setting-rrc-identity');
    if (select) {
        const keep = select.dataset.picked;     // a choice not saved yet stays
        select.innerHTML = (st.identities || []).map(i => `<option value="${rrcEsc(i.id)}" title="${rrcEsc(i.hash)}">${rrcEsc(i.name)} (${rrcEsc(i.hash.slice(0, 8))})${i.rrc ? ' - made for RRC' : ' - Messenger, can be written to on LXMF'}</option>`).join('');
        select.value = keep && (st.identities || []).some(i => i.id === keep) ? keep : st.settings.identity;
        select.onchange = () => { select.dataset.picked = select.value; };
    }
    const add = document.getElementById('setting-rrc-id-new');
    if (add) add.onclick = rrcNewIdentity;
    const del = document.getElementById('setting-rrc-id-delete');
    if (del) del.onclick = rrcDeleteIdentity;
    renderRrcHubSettings(st);
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
            <select class="settings-select rrc-hubset-id" title="Identity on this hub: one chosen for it, or the one of Chat as (it follows Chat as when that changes)">
                <option value="">${rrcEsc(chatAs())} · from Chat as</option>
                ${ids.map(i => `<option value="${rrcEsc(i.id)}"${r.identity === i.id ? ' selected' : ''}>${rrcEsc(i.name)} (${rrcEsc(i.hash.slice(0, 8))})</option>`).join('')}
            </select>
            <input type="text" class="settings-input rrc-hubset-nick" maxlength="64" spellcheck="false" autocomplete="off"
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
        <input type="text" class="rrc-who-search" maxlength="40" placeholder="A name for it, only for you (e.g. Radio club)" spellcheck="false" autocomplete="off">
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
