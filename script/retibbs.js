// The RetiBBS client: bulletin boards over Reticulum. Server side in
// rbrowser/retibbs.py (link, identify, commands, replies); this file shows
// it: the servers heard (favourites and history kept), and the servers open
// as tabs, each a terminal. Loaded after rbrowser.js and messenger.js and
// uses their helpers (escapeHtml, showNotification, copyText, ...).

const RetiBBS = {
    state: null,            // GET /api/retibbs
    servers: null,          // GET /api/retibbs/servers
    open: false,            // the RetiBBS view is on screen
    active: null,           // the server shown
    panes: {},              // {address: {el, seq, seen}}
    inputs: {},             // {address: what was being typed}
    history: [],            // commands sent, for the arrow keys
    historyAt: -1,
    filter: '',
    // Favourites and History closed at every start: opened by hand.
    collapsed: { favorite: true, history: true },
    pollTimer: null,
    serversAt: 0,
};

// A terminal, >_ on a screen: a BBS is a text session. (The screen with
// lines of text it had before is now the NomadNet page icon, NOMAD_ICON.)
const BBS_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path d="M4.5 6.5l2 1.75-2 1.75M8 10.5h3.5"/></svg>';

function retibbsEnabled() {
    return !!(RetiBBS.state && RetiBBS.state.settings && RetiBBS.state.settings.enabled);
}

// ─── Rich markup ────────────────────────────────────────────
// Servers write their screens in Rich markup: [bold red]text[/]. Turned
// into spans with a fixed set of styles; colours are named or #rrggbb, so
// nothing a server sends becomes markup of its own.

const RICH_COLORS = {
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff',
    magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
    bright_black: '#6e7681', bright_red: '#ffa198', bright_green: '#56d364', bright_yellow: '#e3b341',
    bright_blue: '#79c0ff', bright_magenta: '#d2a8ff', bright_cyan: '#56d4dd', bright_white: '#f0f6fc',
    grey: '#8b949e', gray: '#8b949e', orange: '#f0883e', purple: '#a371f7', pink: '#f778ba',
    gold: '#e3b341', default: '',
};

function richColor(word) {
    const w = String(word || '').toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(w)) return w;
    if (/^#[0-9a-f]{3}$/.test(w)) return w;
    const m = w.match(/^(?:grey|gray)(\d{1,3})$/);
    if (m && Number(m[1]) <= 100) { const v = Math.round(Number(m[1]) * 2.55); return `rgb(${v},${v},${v})`; }
    if (w in RICH_COLORS) return RICH_COLORS[w];
    const base = w.replace(/\d+$/, '');
    return base in RICH_COLORS ? RICH_COLORS[base] : null;
}

// A tag's words as CSS, or null when it is not a style (then it is text).
function richStyle(tag) {
    const words = tag.trim().split(/\s+/);
    if (!tag.trim()) return null;
    const css = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i].toLowerCase();
        // Whole words only: Rich's one-letter forms ([b], [i]...) would eat
        // the menus of RetiBBS, written "[b] Boards Area".
        if (w === 'bold') css.push('font-weight:700');
        else if (w === 'dim') css.push('opacity:.65');
        else if (w === 'italic') css.push('font-style:italic');
        else if (w === 'underline') css.push('text-decoration:underline');
        else if (w === 'strike') css.push('text-decoration:line-through');
        else if (w === 'reverse') css.push('filter:invert(1)');
        else if (w === 'blink' || w === 'not' || w === 'none') continue;
        else if (w === 'on' && i + 1 < words.length) {
            const bg = richColor(words[++i]);
            if (bg === null) return null;
            if (bg) css.push(`background:${bg}`);
        } else if (w.startsWith('link=')) {
            css.push('text-decoration:underline');
        } else {
            const fg = richColor(w);
            if (fg === null) return null;
            if (fg) css.push(`color:${fg}`);
        }
    }
    return css.join(';');
}

function richToHtml(text) {
    const src = String(text || '');
    let out = '';
    let open = 0;
    let last = 0;
    const re = /\\\[|\[(\/?)([^\[\]\n]{0,60})\]/g;
    let m;
    while ((m = re.exec(src))) {
        out += escapeHtml(src.slice(last, m.index));
        last = re.lastIndex;
        if (m[0] === '\\[') { out += '['; continue; }
        if (m[1] === '/') {
            if (open > 0 && /^[a-z0-9 #_=.:/-]*$/i.test(m[2])) { out += '</span>'; open--; }
            else out += escapeHtml(m[0]);
            continue;
        }
        const css = richStyle(m[2]);
        if (css === null) { out += escapeHtml(m[0]); continue; }
        out += `<span style="${escapeHtml(css)}">`;
        open++;
    }
    out += escapeHtml(src.slice(last));
    return out + '</span>'.repeat(open);
}

// ─── The tab and the view ───────────────────────────────────

function ensureRetibbsTab() {
    let tab = document.getElementById('retibbs-tab');
    if (!tab) {
        tab = document.createElement('div');
        tab.className = 'tab tab-messages tab-retibbs';
        tab.id = 'retibbs-tab';
        tab.title = 'BBS Client';
        tab.innerHTML = `${BBS_ICON}<span class="tab-app-label">BBS</span><span class="tab-messages-badge" hidden></span>`;
        tab.addEventListener('click', () => openAppTab('bbs'));
        addAppTabOff(tab, 'BBS', async () => {
            const res = await retibbsPost('/api/retibbs/settings', { enabled: false });
            if (res && res.status === 'error') throw new Error(res.error);
            pollRetibbs();
        }, {
            close: () => closeRetibbs(),
            disconnect: async () => {
                const live = ((RetiBBS.state && RetiBBS.state.sessions) || []).filter(s => s.state === 'connected' || s.state === 'connecting');
                await Promise.all(live.map(s => retibbsPost(`/api/retibbs/disconnect/${s.address}`)));
                pollRetibbs();
            },
            disconnectTip: 'every BBS is disconnected, the client stays open',
        });
        placeAppTab(tab);
    }
    let view = document.getElementById('retibbs-view');
    if (!view) {
        view = document.createElement('div');
        view.className = 'tab-content retibbs-view';
        view.id = 'retibbs-view';
        view.innerHTML = `
            <div class="bbs-side">
                <div class="bbs-side-head">
                    <button class="nav-btn sidebar-toggle-btn" onclick="toggleSidebar()" title="Hide the node list">&laquo;</button>${appMainButton()}
                    <span class="bbs-title">${BBS_ICON}<span>BBS Client</span></span>
                    ${clientListButton('bbs')}
                    <button class="msg-bar-btn msg-settings-btn" onclick="showSettings('retibbs')" title="BBS client settings" aria-label="BBS client settings">${typeof GEAR_ICON !== 'undefined' ? GEAR_ICON : '⚙'}</button>
                    <button class="msg-close" onclick="closeRetibbs()" title="Close the BBS client" aria-label="Close">&times;</button>
                </div>
                <div class="bbs-connect">
                    <input aria-label="Server address" type="text" id="bbs-address" class="msg-search" placeholder="Server address (32 hex)" spellcheck="false" autocomplete="off">
                    <button class="msg-bar-btn primary" id="bbs-address-go">Connect</button>
                </div>
                <input aria-label="Search servers" type="text" id="bbs-filter" class="msg-search bbs-filter" placeholder="Search servers" spellcheck="false" autocomplete="off">
                <div class="bbs-identity" id="bbs-identity"></div>
                <div class="bbs-servers" id="bbs-servers"><div class="msg-search-none">Listening for servers…</div></div>
            </div>
            <div class="bbs-main">
                <div class="msg-tabs" id="bbs-tabs" hidden></div>
                <div class="bbs-head" id="bbs-head"></div>
                <div class="bbs-screens" id="bbs-screens">
                    <div class="msg-empty bbs-empty">${typeof clientWelcome === 'function' ? clientWelcome(BBS_ICON, 'BBS Client') : ''}Pick a server on the left, or paste its address.<br>
                        Servers are found from their announces; favourites and the ones you visited stay in the list.</div>
                </div>
                <div class="bbs-input-row" id="bbs-input-row" hidden>
                    <div class="rrc-cmds bbs-cmds" id="bbs-cmds" hidden role="listbox"></div>
                    <span class="bbs-prompt">&gt;</span>
                    <input aria-label="Command" type="text" id="bbs-input" class="bbs-input" spellcheck="false" autocomplete="off"
                           placeholder="Command - ? for help, / or Tab lists the commands, ↑↓ earlier ones">
                    <button class="msg-send" id="bbs-send" title="Send (Enter)" aria-label="Send"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 8l11-5.5L9.5 14 7.5 9z" fill="currentColor"/></svg></button>
                </div>
            </div>`;
        document.getElementById('tab-content-wrapper').appendChild(view);
        bindRetibbsView(view);
        // The node list button here follows the others (as in Messages).
        applySidebarState(document.body.classList.contains('sidebar-collapsed'));
        applyClientList('bbs');
    }
}

function bindRetibbsView(view) {
    const go = () => {
        const box = view.querySelector('#bbs-address');
        const addr = box.value.trim().toLowerCase().replace(/[<>]/g, '');
        if (!/^[0-9a-f]{32}$/.test(addr)) { showNotification('A BBS address is 32 hex characters', 'error', 4000); return; }
        box.value = '';
        retibbsConnect(addr);
    };
    view.querySelector('#bbs-address-go').onclick = go;
    view.querySelector('#bbs-address').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    view.querySelector('#bbs-filter').addEventListener('input', e => { RetiBBS.filter = e.target.value; renderRetibbsServers(); });
    if (typeof watchListUse === 'function') watchListUse(view.querySelector('#bbs-servers'), () => renderRetibbsServers());
    view.querySelector('#bbs-servers').addEventListener('click', e => {
        const head = e.target.closest('[data-bbs-section]');
        if (head) {
            const k = head.dataset.bbsSection;
            RetiBBS.collapsed[k] = !RetiBBS.collapsed[k];
            renderRetibbsServers();
            return;
        }
        const star = e.target.closest('[data-bbs-star]');
        if (star) { e.stopPropagation(); retibbsFavorite(star.dataset.bbsStar, star.dataset.on !== '1'); return; }
        const forget = e.target.closest('[data-bbs-forget]');
        if (forget) { e.stopPropagation(); retibbsForget(forget.dataset.bbsForget); return; }
        const nomad = e.target.closest('[data-bbs-nomad]');
        if (nomad) { openNomadBbs(nomad.dataset.bbsNomad, nomad.dataset.name); return; }
        const row = e.target.closest('[data-bbs]');
        if (row) retibbsConnect(row.dataset.bbs);
    });
    view.querySelector('#bbs-servers').addEventListener('contextmenu', e => {
        const nomad = e.target.closest('[data-bbs-nomad]');
        if (nomad) { e.preventDefault(); copyText(nomad.dataset.bbsNomad, 'NomadNet address copied'); return; }
        const row = e.target.closest('[data-bbs]');
        if (!row) return;
        e.preventDefault();
        copyText(row.dataset.bbs, 'RetiBBS address copied');
    });
    // On the press: a redraw of the strip ("new" coming) between press and
    // release would lose the click (same as the RRC tabs).
    view.querySelector('#bbs-tabs').addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const close = e.target.closest('[data-bbs-close]');
        if (close) { e.preventDefault(); e.stopPropagation(); retibbsCloseSession(close.dataset.bbsClose); return; }
        const tab = e.target.closest('[data-bbs-tab]');
        if (tab) showRetibbsSession(tab.dataset.bbsTab);
    });
    view.querySelector('#bbs-tabs').addEventListener('auxclick', e => {
        const tab = e.button === 1 && e.target.closest('[data-bbs-tab]');
        if (tab) { e.preventDefault(); retibbsCloseSession(tab.dataset.bbsTab); }
    });
    const input = view.querySelector('#bbs-input');
    const cmds = view.querySelector('#bbs-cmds');
    input.addEventListener('input', () => renderBbsCommands());
    input.addEventListener('blur', () => setTimeout(() => { cmds.hidden = true; }, 150));
    cmds.addEventListener('mousedown', e => {
        const item = e.target.closest('[data-bbs-cmd]');
        if (!item) return;
        e.preventDefault();                 // the input keeps the focus
        bbsPickCommand(Number(item.dataset.bbsCmd), true);
    });
    input.addEventListener('keydown', e => {
        // Tab on an empty line (or a / being typed) opens the commands.
        if (cmds.hidden && e.key === 'Tab' && !e.shiftKey && (!input.value || /^\/\S*$/.test(input.value))) {
            e.preventDefault();
            renderBbsCommands(true);
            return;
        }
        // The list, while open, takes the arrows, Tab, Enter, Esc.
        if (!cmds.hidden) {
            const items = [...cmds.querySelectorAll('[data-bbs-cmd]')];
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                RetiBBS.cmdAt = (RetiBBS.cmdAt + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                items.forEach((el, i) => el.classList.toggle('active', i === RetiBBS.cmdAt));
                items[RetiBBS.cmdAt].scrollIntoView({ block: 'nearest' });
                return;
            }
            if ((e.key === 'Tab' || e.key === 'Enter') && items[RetiBBS.cmdAt]) {
                e.preventDefault();
                bbsPickCommand(Number(items[RetiBBS.cmdAt].dataset.bbsCmd), e.key === 'Enter');
                return;
            }
            if (e.key === 'Escape') { e.preventDefault(); cmds.hidden = true; return; }
        }
        if (e.key === 'Enter') { e.preventDefault(); retibbsSend(); return; }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            if (!RetiBBS.history.length) return;
            e.preventDefault();
            const n = RetiBBS.history.length;
            if (e.key === 'ArrowUp') RetiBBS.historyAt = RetiBBS.historyAt < 0 ? n - 1 : Math.max(0, RetiBBS.historyAt - 1);
            else RetiBBS.historyAt = RetiBBS.historyAt < 0 ? -1 : RetiBBS.historyAt + 1;
            if (RetiBBS.historyAt >= n) RetiBBS.historyAt = -1;
            input.value = RetiBBS.historyAt < 0 ? '' : RetiBBS.history[RetiBBS.historyAt];
        }
    });
    view.querySelector('#bbs-send').onclick = () => retibbsSend();
    view.querySelector('#bbs-head').addEventListener('click', e => {
        const b = e.target.closest('[data-bbs-act]');
        if (!b) return;
        const addr = RetiBBS.active;
        // The x of the open screen closes that server only (like its tab's x);
        // the client stays open on the others or on the list.
        if (b.dataset.bbsAct === 'close-view') { retibbsCloseSession(addr); return; }
        if (b.dataset.bbsAct === 'connect') retibbsConnect(addr);
        else if (b.dataset.bbsAct === 'disconnect') retibbsPost(`/api/retibbs/disconnect/${addr}`).then(pollRetibbs);
        else if (b.dataset.bbsAct === 'copy') copyText(addr, 'Server address copied');
        // Our identity hash: some BBS functions ask for it.
        else if (b.dataset.bbsAct === 'copy-me') copyText(b.dataset.hash, 'Your identity hash copied');
        else if (b.dataset.bbsAct === 'cmd') { retibbsSendText(b.dataset.cmd); }
        // Phones: back to the list; the server stays open (its tab and dot).
        else if (b.dataset.bbsAct === 'back') showRetibbsSession(null);
    });
}

function openRetibbs() {
    if (!retibbsEnabled()) {
        showNotification('The BBS client is off: Settings > BBS Client', 'info', 5000);
        return;
    }
    ensureRetibbsTab();
    if (typeof Messenger !== 'undefined') Messenger.open = false;
    document.body.classList.remove('messenger-open');
    if (typeof Rmap !== 'undefined') Rmap.open = false;
    document.body.classList.remove('rmap-open');
    if (typeof Rrc !== 'undefined') Rrc.open = false;
    document.body.classList.remove('rrc-open');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('retibbs-tab').classList.add('active');
    document.getElementById('retibbs-view').classList.add('active');
    document.body.classList.add('retibbs-open');
    RetiBBS.open = true;
    RetiBBS.serversAt = 0;
    pollRetibbs();
    if (RetiBBS.active) showRetibbsSession(RetiBBS.active);
}

function closeRetibbs() {
    if (appWindowClose()) return;
    RetiBBS.open = false;
    document.body.classList.remove('retibbs-open');
    const view = document.getElementById('retibbs-view');
    if (view) view.classList.remove('active');
    const tab = document.getElementById('retibbs-tab');
    if (tab) tab.classList.remove('active');
    if (typeof activeTabId !== 'undefined' && activeTabId) switchToTab(activeTabId);
}

function applyRetibbsVisibility() {
    const on = retibbsEnabled();
    if (on) ensureRetibbsTab();
    const tab = document.getElementById('retibbs-tab');
    if (tab) tab.hidden = !on;
    layoutAppTabs();
    if (!on && RetiBBS.open) closeRetibbs();
    // New lines on servers not on screen: the tab shows how many have some.
    const badge = tab && tab.querySelector('.tab-messages-badge');
    if (badge) {
        const waiting = (RetiBBS.state && RetiBBS.state.sessions || []).filter(s => {
            const p = RetiBBS.panes[s.address];
            return s.seq > (p ? p.seen : 0) && !(RetiBBS.open && RetiBBS.active === s.address);
        }).length;
        badge.hidden = !waiting;
        badge.textContent = String(waiting);
    }
    if (tab && on) {
        const sessions = (RetiBBS.state && RetiBBS.state.sessions) || [];
        const count = s => sessions.filter(x => x.state === s).length;
        const [ok, trying, failed] = [count('connected'), count('connecting'), count('failed')];
        setAppTabState(tab, ok ? 'connected' : trying ? 'connecting' : failed ? 'failed' : '',
            ok ? `BBS: connected to ${ok} server${ok === 1 ? '' : 's'}${trying ? `, ${trying} connecting` : ''}`
                : trying ? 'BBS: connecting…' : failed ? 'BBS: connection failed' : 'BBS: not connected');
    }
}

// ─── Polling ────────────────────────────────────────────────

async function pollRetibbs() {
    try {
        RetiBBS.state = await fetch('/api/retibbs').then(r => r.json());
    } catch (e) {
        return;
    }
    applyRetibbsVisibility();
    if (!RetiBBS.open) return;
    const view = document.getElementById('retibbs-view');
    if (view) view.classList.toggle('bbs-fx', retibbsFx());
    renderRetibbsIdentity();
    if (Date.now() - RetiBBS.serversAt > 5000) {
        RetiBBS.serversAt = Date.now();
        try {
            RetiBBS.servers = await fetch('/api/retibbs/servers').then(r => r.json());
        } catch (e) { /* next time */ }
    }
    // Every poll: the dots follow the sessions (unchanged html is not redrawn,
    // a list in use is held: watchListUse in rrc.js).
    renderRetibbsServers(true);
    // Every open server: their screens keep filling while another is shown.
    for (const s of RetiBBS.state.sessions || []) {
        const pane = RetiBBS.panes[s.address];
        if (!pane || s.seq > pane.seq) await loadRetibbsOutput(s.address);
    }
    renderRetibbsTabs();
    renderRetibbsHead();
}

function startRetibbsPolling() {
    pollRetibbs();
    clearInterval(RetiBBS.pollTimer);
    RetiBBS.pollTimer = setInterval(pollRetibbs, 2000);
}

function retibbsPost(url, body) {
    return fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
}

// ─── Servers ────────────────────────────────────────────────

function bbsAgo(ts) {
    if (!ts) return '';
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
}

// NomadNet nodes from the node list whose name has the word BBS ("N2 BBS",
// "BBS_Italia"; not "RetiBBS", a RetiBBS server's own name). Off with
// Settings > BBS Client > Listen for > NomadNet.
const NOMAD_BBS_NAME = /(^|[^a-z0-9])bbs([^a-z0-9]|$)/i;

function nomadBbsNodes() {
    const st = RetiBBS.state && RetiBBS.state.settings;
    if (st && st.protocols && st.protocols.nomadnet === false) return [];
    const nodes = typeof cachedNodes !== 'undefined' && Array.isArray(cachedNodes) ? cachedNodes : [];
    return nodes.filter(n => n && n.hash && NOMAD_BBS_NAME.test(n.name || ''))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base', numeric: true }));
}

function openNomadBbs(hash, name) {
    closeRetibbs();
    openQuickAddress(`${hash}:/page/index.mu`, name, true);
}

function renderRetibbsServers(fromPoll = false) {
    const box = document.getElementById('bbs-servers');
    if (!box || !RetiBBS.servers) return;
    if (fromPoll && typeof listHeld === 'function' && listHeld(box)) return;
    const words = RetiBBS.filter.toLowerCase().split(/\s+/).filter(Boolean);
    const match = s => !words.length || words.every(w => `${s.name} ${s.address} ${s.type_label || ''}`.toLowerCase().includes(w));
    // The dot follows the live session (polled every 2 s), not the server
    // list (every 5 s): green connected, amber connecting, none when the
    // link is down. A tab still open but disconnected only marks the card.
    const live = s => {
        const ses = sessionOf(s.address);
        return ses && (ses.state === 'connected' || ses.state === 'connecting') ? ses.state : '';
    };
    const row = (s, kind) => `
        <div class="bbs-server${sessionOf(s.address) ? ' open' : ''}${s.address === RetiBBS.active ? ' active' : ''}" data-bbs="${escapeHtml(s.address)}"
             title="Click: connect - right-click: copy the address">
            <button class="bbs-star${s.favorite ? ' on' : ''}" data-bbs-star="${escapeHtml(s.address)}" data-on="${s.favorite ? '1' : '0'}"
                    title="${s.favorite ? 'Remove from favourites' : 'Add to favourites'}">${s.favorite ? '★' : '☆'}</button>
            <div class="bbs-server-text">
                <div class="bbs-server-name">${live(s) ? `<span class="bbs-state bbs-state-${live(s)}" title="${live(s) === 'connected' ? 'Connected' : 'Connecting…'}"></span>` : ''}<span class="bbs-server-title">${escapeHtml(s.name || 'Unnamed server')}</span>${s.type_label
                    ? `<span class="bbs-type" title="${escapeHtml(`${s.type_label} server - announces on the ${s.aspect} aspect`)}">${escapeHtml(s.type_label)}</span>` : ''}</div>
                <code>${escapeHtml(s.address)}</code>
                <div class="bbs-server-meta">${[
                    s.hops != null ? `${s.hops} hop${s.hops === 1 ? '' : 's'}` : '',
                    s.heard ? `heard ${bbsAgo(s.heard)}` : (kind === 'heard' ? '' : 'not heard lately'),
                    kind === 'history' && s.last ? `visited ${bbsAgo(s.last)}` : '',
                ].filter(Boolean).map(escapeHtml).join(' · ')}</div>
            </div>
            ${kind === 'history' ? `<button class="msg-tab-close" data-bbs-forget="${escapeHtml(s.address)}" title="Remove from the history">&times;</button>` : ''}
        </div>`;
    // Inside a section the servers go by kind of BBS, in the server's order
    // (RetiBBS last); a separator with the kind's name
    // only when the section holds more than one kind.
    const order = RetiBBS.servers.types || [];
    const rank = s => { const i = order.indexOf(s.type); return i < 0 ? order.length : i; };
    const rows = (list, kind) => {
        // Starred servers always first, then by kind of BBS.
        const fav = s => (s.favorite ? 0 : 1);
        const sorted = list.map((s, i) => [s, i]).sort((a, b) => fav(a[0]) - fav(b[0]) || rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(p => p[0]);
        const mixed = new Set(sorted.map(s => s.type)).size > 1;
        let last = null;
        return sorted.map(s => {
            // The starred ones on top of Heard have no kind separator (it
            // would repeat below them); in Favourites all are starred.
            const top = s.favorite && kind !== 'favorite';
            const sep = mixed && !top && s.type !== last ? `<div class="bbs-type-sep">${escapeHtml(s.type_label || s.type || '')}</div>` : '';
            if (!top) last = s.type;
            return sep + row(s, kind);
        }).join('');
    };
    // NomadNet nodes with BBS in their name: their boards are Micron pages,
    // not a text protocol, so they open as a page in a new tab, where forms,
    // Enter and identify already work. Listed last, under their own separator.
    const nomad = nomadBbsNodes().filter(n => match({ name: n.name, address: n.hash, type_label: 'NomadNet' }));
    const nomadRow = n => `
        <div class="bbs-server bbs-nomad" data-bbs-nomad="${escapeHtml(n.hash)}" data-name="${escapeHtml(n.name || '')}"
             title="Opens as a NomadNet page in a new tab - right-click: copy the address">
            <span class="bbs-star bbs-star-none"></span>
            <div class="bbs-server-text">
                <div class="bbs-server-name"><span class="bbs-server-title">${escapeHtml(n.name || 'Unnamed node')}</span><span class="bbs-type" title="A NomadNet node with BBS in its name: opens as a page">NomadNet</span></div>
                <code>${escapeHtml(n.hash)}</code>
                <div class="bbs-server-meta">${[
                    n.hops != null ? `${n.hops} hop${n.hops === 1 ? '' : 's'}` : '',
                    n.last_seen_relative ? `heard ${String(n.last_seen_relative).toLowerCase()}` : '',
                ].filter(Boolean).map(escapeHtml).join(' · ')}</div>
            </div>
        </div>`;
    const nomadHtml = nomad.length
        ? `<div class="bbs-type-sep">Found on NomadNet</div>` + nomad.map(nomadRow).join('') : '';
    const section = (title, list, kind, empty, tail = '', extra = 0) => {
        const shown = list.filter(match);
        // A search opens every section: what it finds must be in view.
        const closed = !!RetiBBS.collapsed[kind] && !words.length;
        return `<div class="bbs-section"><button class="bbs-section-title" data-bbs-section="${kind}" aria-expanded="${!closed}">
                <span><span class="bbs-caret">${closed ? '▸' : '▾'}</span>${title}</span><span>${shown.length + extra}</span></button>
            ${closed ? '' : (shown.length ? rows(shown, kind) : (tail ? '' : `<div class="msg-search-none">${empty}</div>`)) + tail}</div>`;
    };
    const fav = new Set(RetiBBS.servers.favorites.map(s => s.address));
    const html = section('Favourites', RetiBBS.servers.favorites, 'favorite', 'Star a server to keep it here')
        + section('History', RetiBBS.servers.history.filter(s => !fav.has(s.address)), 'history', 'Servers you connect to stay here')
        + section('Heard', RetiBBS.servers.heard, 'heard', 'No BBS announced yet', nomadHtml, nomad.length);
    if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

function renderRetibbsIdentity() {
    const box = document.getElementById('bbs-identity');
    const st = RetiBBS.state;
    if (!box || !st) return;
    const html = `Logging in as <b>${escapeHtml(st.identity_name || '')}</b>
        <button class="msg-rename-btn" onclick="showSettings('retibbs')" title="Change it in Settings > RetiBBS">${typeof PENCIL_ICON !== 'undefined' ? PENCIL_ICON : '✎'}</button>`;
    if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

async function retibbsFavorite(address, on) {
    await retibbsPost(`/api/retibbs/favorite/${address}`, { favorite: on });
    RetiBBS.serversAt = 0;
    pollRetibbs();
}

async function retibbsForget(address) {
    await retibbsPost(`/api/retibbs/forget/${address}`);
    RetiBBS.serversAt = 0;
    pollRetibbs();
}

// ─── Sessions ───────────────────────────────────────────────

async function retibbsConnect(address) {
    const res = await retibbsPost(`/api/retibbs/connect/${address}`);
    if (res.status !== 'success') {
        showNotification(escapeHtml(res.error || 'Could not connect'), 'error', 5000);
        return;
    }
    RetiBBS.serversAt = 0;
    await pollRetibbs();
    showRetibbsSession(address);
}

// ─── Commands: / or Tab opens the list ──────────────────────
// Per kind of server and per area (the server says the area: CTRL AREA).
// RetiBBS (github.com/kc1awv/RetiBBS): the main menu and the boards take
// bare words, the chat takes /words. Other kinds of BBS get their own list.
const BBS_COMMANDS = {
    retibbs: {
        main: [
            ['?', '', 'Help for this area'],
            ['h', '', 'Am I authorized? (hello)'],
            ['n', '<name>', 'Your display name'],
            ['d', '<LXMF address>', 'Where board alerts go'],
            ['td', '', 'Send a test LXMF alert'],
            ['b', '', 'Message boards'],
            ['c', '', 'Chat rooms'],
            ['lo', '', 'Log out'],
            ['lu', '', 'List users', 'admin'],
            ['a', '<user hash>', 'Make admin', 'admin'],
        ],
        boards: [
            ['?', '', 'Help for this area'],
            ['b', '', 'Back to the main menu'],
            ['lb', '', 'List the boards'],
            ['cb', '<board>', 'Go to a board'],
            ['lm', '[board]', 'List messages'],
            ['lu', '', 'Unread in this board'],
            ['r', '<id>', 'Read a message'],
            ['p', '<topic> | <text>', 'Post in this board'],
            ['re', '<id> | <text>', 'Reply to a message'],
            ['>', '', 'Next page'],
            ['<', '', 'Previous page'],
            ['w', '<board>', 'Watch a board (needs d)'],
            ['uw', '<board>', 'Stop watching'],
            ['wl', '', 'Boards you watch'],
            ['nb', '<name>', 'New board', 'admin'],
            ['db', '<board>', 'Delete a board', 'admin'],
        ],
        chat: [
            ['/?', '', 'Help for the chat'],
            ['/list', '', 'Rooms and how many are in'],
            ['/join', '<room>', 'Join (or make) a room'],
            ['/leave', '', 'Leave the room'],
            ['/back', '', 'Back to the main menu'],
        ],
    },
};

function bbsCommandList() {
    const s = sessionOf(RetiBBS.active);
    if (!s) return [];
    const kind = BBS_COMMANDS[String(s.kind || 'retibbs').toLowerCase()] || BBS_COMMANDS.retibbs;
    const area = String(s.area || '').toLowerCase();
    return kind[/chat/.test(area) || s.room ? 'chat' : /board/.test(area) ? 'boards' : 'main'] || [];
}

function renderBbsCommands(all = false) {
    const input = document.getElementById('bbs-input');
    const box = document.getElementById('bbs-cmds');
    if (!input || !box) return;
    const m = all ? [null, ''] : input.value.match(/^\/(\S*)$/);
    if (!m) { box.hidden = true; return; }
    const typed = m[1].toLowerCase();
    const list = bbsCommandList().map((c, i) => [c, i])
        .filter(([c]) => c[0].replace(/^\//, '').toLowerCase().startsWith(typed.replace(/^\//, '')));
    box.hidden = !list.length;
    if (!list.length) return;
    RetiBBS.cmdAt = 0;
    box.innerHTML = list.map(([c, i], n) => `<div class="rrc-cmd${n === 0 ? ' active' : ''}${c[3] ? ' rrc-cmd-op' : ''}" data-bbs-cmd="${i}" role="option" title="${escapeHtml(c[0] + ' ' + c[1])}">
        <span class="rrc-cmd-name">${escapeHtml(c[0])}</span><span class="rrc-cmd-args">${escapeHtml(c[1])}</span>
        <span class="rrc-cmd-what">${escapeHtml(c[2])}${c[3] ? ' <i>admin</i>' : ''}</span></div>`).join('');
}

// Clicked or Enter: a command with nothing to add goes at once; the others
// wait in the line for what follows.
function bbsPickCommand(index, go = false) {
    const input = document.getElementById('bbs-input');
    const c = bbsCommandList()[index];
    document.getElementById('bbs-cmds').hidden = true;
    if (!c || !input) return;
    if (go && !c[1]) { input.value = c[0]; retibbsSend(); input.focus(); return; }
    input.value = c[1] ? `${c[0]} ` : c[0];
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
}

function sessionOf(address) {
    return ((RetiBBS.state && RetiBBS.state.sessions) || []).find(s => s.address === address) || null;
}

function retibbsPane(address) {
    let pane = RetiBBS.panes[address];
    if (!pane) {
        const el = document.createElement('div');
        el.className = 'bbs-screen';
        el.hidden = true;
        document.getElementById('bbs-screens').appendChild(el);
        pane = RetiBBS.panes[address] = { el, seq: 0, seen: 0 };
    }
    return pane;
}

async function loadRetibbsOutput(address) {
    const pane = retibbsPane(address);
    let data;
    try {
        data = await fetch(`/api/retibbs/output/${address}?since=${pane.seq}`).then(r => r.json());
    } catch (e) {
        return;
    }
    if (data.status !== 'success') return;
    const el = pane.el;
    // Opened (a page reload) on a server no longer connected: an empty
    // screen, not its old welcome as if it were still on.
    const session = sessionOf(address);
    if (!pane.seq && session && !['connected', 'connecting'].includes(session.state)) {
        pane.seq = data.seq || (data.lines.length ? data.lines[data.lines.length - 1].seq : 0);
        el.innerHTML = '<div class="bbs-line bbs-system">Not connected. Connect to start again.</div>';
        return;
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    // Older lines than the ones the server keeps: start the screen over.
    if (pane.seq && data.first > pane.seq + 1) el.innerHTML = '';
    const fx = retibbsFx();
    const stick = atBottom || data.lines.some(l => l.kind === 'me');
    for (const line of data.lines) {
        // Send and poll can ask at the same moment from the same seq: the
        // later answer must not draw the lines again (a line twice).
        if (line.seq <= pane.seq) continue;
        pane.seq = line.seq;
        if (line.kind === 'cls') { el.innerHTML = ''; continue; }
        // Effects only for what just arrived: a tab opened later shows its
        // past at once.
        const animate = fx && Date.now() / 1000 - line.ts < 10;
        if (animate && line.kind === 'system') {
            for (const modem of fxModemLines(line.text, address)) {
                const m = document.createElement('div');
                m.className = 'bbs-line bbs-modem';
                el.appendChild(m);
                fxType(pane, m, modem, stick);
            }
        }
        const div = document.createElement('div');
        div.className = `bbs-line bbs-${line.kind}`;
        if (line.kind === 'text') div.innerHTML = richToHtml(line.text);
        else if (line.kind === 'me') div.textContent = `> ${line.text}`;
        else div.textContent = line.text;
        el.appendChild(div);
        if (animate) {
            if (line.kind === 'text') fxReveal(pane, div, stick);
            else fxAppear(pane, div, stick);
        }
    }
    while (el.childElementCount > 3000) el.firstElementChild.remove();
    // Something new from a server you are not looking at.
    const looking = RetiBBS.open && RetiBBS.active === address && document.visibilityState === 'visible' && document.hasFocus();
    if (!looking && typeof playSound === 'function'
            && data.lines.some(l => l.kind === 'text' && Date.now() / 1000 - l.ts < 30)) playSound('bbs');
    fitRetibbsScreen(pane);
    if (RetiBBS.open && RetiBBS.active === address) {
        pane.seen = pane.seq;
        if (atBottom || data.lines.some(l => l.kind === 'me')) el.scrollTop = el.scrollHeight;
    }
}

function showRetibbsSession(address) {
    const input = document.getElementById('bbs-input');
    if (RetiBBS.active && input) RetiBBS.inputs[RetiBBS.active] = input.value;
    RetiBBS.active = address;
    const empty = document.querySelector('#bbs-screens .bbs-empty');
    if (empty) empty.hidden = !!address;
    for (const [a, p] of Object.entries(RetiBBS.panes)) p.el.hidden = a !== address;
    const pane = address ? retibbsPane(address) : null;
    if (pane) {
        pane.el.hidden = false;
        pane.seen = pane.seq;
        if (!pane.seq) loadRetibbsOutput(address).then(() => { pane.el.scrollTop = pane.el.scrollHeight; });
        else fitRetibbsScreen(pane);
    }
    const row = document.getElementById('bbs-input-row');
    if (row) row.hidden = !address;
    // On a phone the list or the terminal fills the screen, not both.
    const view = document.getElementById('retibbs-view');
    if (view) view.classList.toggle('bbs-has-session', !!address);
    if (input) {
        input.value = (address && RetiBBS.inputs[address]) || '';
        if (address && !isMobileDevice()) input.focus();
    }
    RetiBBS.historyAt = -1;
    renderRetibbsTabs();
    renderRetibbsHead();
    renderRetibbsServers();
    applyRetibbsVisibility();
}

function renderRetibbsTabs() {
    const strip = document.getElementById('bbs-tabs');
    if (!strip) return;
    const sessions = (RetiBBS.state && RetiBBS.state.sessions) || [];
    strip.hidden = !sessions.length;
    const html = sessions.map(s => {
        const pane = RetiBBS.panes[s.address];
        const fresh = s.address !== RetiBBS.active && s.seq > (pane ? pane.seen : 0);
        return `<div class="msg-tab bbs-tab${s.address === RetiBBS.active ? ' active' : ''}" data-bbs-tab="${escapeHtml(s.address)}"
                     title="${escapeHtml(s.name || s.address)} - ${escapeHtml(s.state)}">
            <span class="bbs-state bbs-state-${escapeHtml(s.state)}"></span>
            <span class="msg-tab-name">${escapeHtml(s.name || s.address.slice(0, 8) + '…')}</span>
            ${fresh ? '<span class="msg-conv-unread">new</span>' : ''}
            <button class="msg-tab-close" data-bbs-close="${escapeHtml(s.address)}" title="Close (disconnects)" aria-label="Close">&times;</button>
        </div>`;
    }).join('');
    if (strip.dataset.html !== html) { strip.dataset.html = html; strip.innerHTML = html; }
}

function renderRetibbsHead() {
    const head = document.getElementById('bbs-head');
    if (!head) return;
    // A server on screen always has its bar (before the first poll had its
    // session, it was hidden).
    let s = RetiBBS.active ? sessionOf(RetiBBS.active) : null;
    if (!s && RetiBBS.active) {
        const known = [].concat(...Object.values((RetiBBS.servers && RetiBBS.servers.groups) || {}))
            .find(x => x && x.address === RetiBBS.active);
        s = { address: RetiBBS.active, name: (known && known.name) || '', state: 'closed', identity: '' };
    }
    if (!s) { head.innerHTML = ''; head.hidden = true; return; }
    head.hidden = false;
    const where = [s.area, s.board && `board ${s.board}`, s.room && `room ${s.room}`].filter(Boolean).join(' › ');
    // Who we are on this server: the identity the session logged in with.
    const me = ((RetiBBS.state && RetiBBS.state.identities) || []).find(i => i.id === s.identity);
    const stateText = { connecting: 'Connecting…', connected: 'Connected', closed: 'Disconnected', failed: 'Failed' }[s.state] || s.state;
    const html = `
        <button class="msg-back" data-bbs-act="back" title="Back to the servers (it stays connected)">&larr;</button>
        <div class="bbs-head-who">
            <div class="bbs-head-name">${escapeHtml(s.name || 'RetiBBS server')}</div>
            <code data-bbs-act="copy" title="Click to copy">${escapeHtml(s.address)}</code>
        </div>
        <div class="bbs-head-where">
            <span class="bbs-state bbs-state-${escapeHtml(s.state)}"></span>${escapeHtml(stateText)}
            ${where ? ` · <b>${escapeHtml(where)}</b>` : ''}
            ${s.rtt != null && s.state === 'connected' ? ` · RTT ${Math.round(s.rtt * 1000)} ms` : ''}
            ${s.receiving ? ' · receiving…' : ''}
        </div>
        <div class="bbs-head-me" title="The identity you are logged in with: your account on this server">
            as <b>${escapeHtml(me ? me.name : s.identity)}</b>${me && me.hash ? ` <code data-bbs-act="copy-me" data-hash="${escapeHtml(me.hash)}" title="Your identity hash - click to copy">${escapeHtml(me.hash)}</code>` : ''}
        </div>
        <div class="bbs-head-actions">
            ${s.state === 'connected' ? `<button class="msg-bar-btn" data-bbs-act="cmd" data-cmd="?" title="The server's help for where you are">Help</button>` : ''}
            ${s.state === 'connected' || s.state === 'connecting'
                ? '<button class="msg-bar-btn danger" data-bbs-act="disconnect">Disconnect</button>'
                : '<button class="msg-bar-btn primary" data-bbs-act="connect">Connect</button>'}
            <button class="msg-bar-btn msg-settings-btn" onclick="showSettings('retibbs')" title="BBS client settings" aria-label="BBS client settings">${typeof GEAR_ICON !== 'undefined' ? GEAR_ICON : '⚙'}</button>
            <button class="msg-close" data-bbs-act="close-view" title="Close this server (disconnects)" aria-label="Close this server">&times;</button>
        </div>`;
    if (head.dataset.html !== html) { head.dataset.html = html; head.innerHTML = html; }
    const input = document.getElementById('bbs-input');
    if (input) input.disabled = s.state !== 'connected';
}

async function retibbsSend() {
    const input = document.getElementById('bbs-input');
    const text = input.value;
    if (!text.trim() || !RetiBBS.active) return;
    if (await retibbsSendText(text)) {
        input.value = '';
        if (RetiBBS.history[RetiBBS.history.length - 1] !== text) RetiBBS.history.push(text);
        if (RetiBBS.history.length > 100) RetiBBS.history.shift();
        RetiBBS.historyAt = -1;
    }
}

async function retibbsSendText(text) {
    const address = RetiBBS.active;
    const res = await retibbsPost(`/api/retibbs/send/${address}`, { text });
    if (res.status !== 'success') {
        showNotification(escapeHtml(res.error || 'Not sent'), 'error', 4000);
        return false;
    }
    await loadRetibbsOutput(address);
    return true;
}

async function retibbsCloseSession(address) {
    await retibbsPost(`/api/retibbs/close/${address}`);
    const pane = RetiBBS.panes[address];
    if (pane) { pane.el.remove(); delete RetiBBS.panes[address]; }
    delete RetiBBS.inputs[address];
    await pollRetibbs();
    if (RetiBBS.active === address) {
        const next = ((RetiBBS.state && RetiBBS.state.sessions) || [])[0];
        showRetibbsSession(next ? next.address : null);
    }
}

// Phones: a BBS screen is drawn for 80 columns. Lines do not wrap (the
// art and the boxes would break) and the font shrinks until the widest
// fits, down to FIT_MIN_PX; past that the screen scrolls sideways.
const FIT_MIN_PX = 7;
const FIT_MAX_PX = 12;

function fitRetibbsScreen(pane) {
    const el = pane.el;
    if (window.innerWidth > 700) { el.style.fontSize = ''; return; }
    if (el.hidden || !el.clientWidth) return;
    el.style.fontSize = `${FIT_MAX_PX}px`;
    const room = el.clientWidth - 16;
    let widest = 0;
    for (const line of el.children) widest = Math.max(widest, line.scrollWidth);
    if (widest > room) {
        el.style.fontSize = `${Math.max(FIT_MIN_PX, Math.floor(FIT_MAX_PX * room / widest * 10) / 10)}px`;
    }
}

window.addEventListener('resize', () => {
    for (const pane of Object.values(RetiBBS.panes)) fitRetibbsScreen(pane);
});

// ─── Keys go to the command line ────────────────────────────
// As in the messenger: a key typed while no field has the focus lands in
// the command line; a click on the screen (not a selection) puts it there.

document.addEventListener('keydown', e => {
    if (!RetiBBS.open) return;
    finishRetibbsFx();
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    const active = document.activeElement;
    if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
    if (document.querySelector('.auto-reload-modal, .choice-modal')) return;
    const input = document.getElementById('bbs-input');
    if (input && !input.disabled && !input.closest('[hidden]')) input.focus();
}, true);

document.addEventListener('click', e => {
    if (!RetiBBS.open || !e.target.closest('#bbs-screens')) return;
    finishRetibbsFx();
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).length) return;
    const input = document.getElementById('bbs-input');
    if (input && !input.disabled && !isMobileDevice()) input.focus();
});

// ─── Terminal FX ────────────────────────────────────────────
// Settings > BBS Client > Terminal Effect: the 80s/90s look. While connecting
// the line "dials" like a modem; text scrolls in line by line, as at a slow
// baud rate; a CRT glow and scanlines. Only looks: any key or click shows
// everything at once.

function retibbsFx() {
    return !!(RetiBBS.state && RetiBBS.state.settings && RetiBBS.state.settings.terminal_fx);
}

const FX_LINE_MS = 28;          // per line scrolling in
const FX_MAX_MS = 2600;         // a long screen never takes longer

// When the next effect may start, so blocks arriving together scroll in
// one after the other.
function fxSlot(pane, ms) {
    const now = performance.now();
    const start = Math.max(now, pane.fxUntil || 0);
    pane.fxUntil = start + ms;
    return start - now;
}

function fxFollow(pane) {
    if (pane.fxFollowing) return;
    pane.fxFollowing = true;
    const step = () => {
        if (performance.now() > (pane.fxUntil || 0) + 50) { pane.fxFollowing = false; return; }
        if (pane.fxStick) pane.el.scrollTop = pane.el.scrollHeight;
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// A block of text scrolls in, line by line.
function fxReveal(pane, div, stick) {
    // Not on screen (a phone showing the server list, another tab): no
    // height to measure. Animated to a height of 0 the text stayed hidden
    // for good - the BBS screen "lost" its lines.
    if (!pane.el.offsetParent || !div.scrollHeight) return;
    const lineHeight = parseFloat(getComputedStyle(pane.el).lineHeight) || 16;
    const height = div.scrollHeight;
    const lines = Math.max(1, Math.round(height / lineHeight));
    const ms = Math.min(FX_MAX_MS, lines * FX_LINE_MS);
    const delay = fxSlot(pane, ms);
    div.classList.add('bbs-reveal');
    div.style.setProperty('--h', `${height}px`);
    div.style.animation = `bbs-reveal ${ms}ms steps(${lines}, end) ${delay}ms both`;
    fxDone(div);
    pane.fxStick = pane.fxStick || stick;
    fxFollow(pane);
}

// A short line appears in its turn (after what is still scrolling in).
function fxAppear(pane, div, stick) {
    const delay = fxSlot(pane, 120);
    if (!pane.el.offsetParent) return;
    div.classList.add('bbs-appear');
    div.style.animation = `bbs-appear 120ms linear ${delay}ms both`;
    fxDone(div);
    pane.fxStick = pane.fxStick || stick;
    fxFollow(pane);
}

// Once played, the effect lets go of the line: its height was fixed to the
// one measured, and a font change after (phone fit) cut the text.
function fxDone(div) {
    div.addEventListener('animationend', () => {
        div.style.animation = 'none';
        div.classList.remove('bbs-reveal', 'bbs-appear');
    }, { once: true });
}

// Typed one letter at a time: the modem's own lines.
function fxType(pane, div, text, stick) {
    const ms = Math.min(900, text.length * 22);
    const delay = fxSlot(pane, ms + 160);
    div.textContent = '';
    pane.fxStick = pane.fxStick || stick;
    fxFollow(pane);
    let i = 0;
    const tick = () => {
        if (div.dataset.done) return;
        div.textContent = text.slice(0, ++i);
        if (i < text.length) div.fxTimer = setTimeout(tick, 22);
    };
    div.dataset.full = text;
    div.fxTimer = setTimeout(tick, delay);
}

// What the client says while connecting, in a modem's words.
function fxModemLines(text, address) {
    if (/^Connecting to /.test(text)) return ['ATZ', 'OK', `ATDT ${address}`];
    if (text === 'Connected.') return ['CONNECT 9600/RNS'];
    if (/^(Disconnected|Stopped)/.test(text)) return ['NO CARRIER'];
    if (/^(No answer|No path|The server did not|Could not|This address is not|The server stopped)/.test(text)) {
        return ['NO CARRIER'];
    }
    return [];
}

function finishRetibbsFx() {
    for (const pane of Object.values(RetiBBS.panes)) {
        if (!pane.fxUntil) continue;
        pane.el.querySelectorAll('.bbs-reveal, .bbs-appear').forEach(d => {
            d.style.animation = 'none';
            d.classList.remove('bbs-reveal', 'bbs-appear');
        });
        pane.el.querySelectorAll('[data-full]').forEach(d => {
            clearTimeout(d.fxTimer);
            d.dataset.done = '1';
            d.textContent = d.dataset.full;
            d.removeAttribute('data-full');
        });
        pane.fxUntil = 0;
        if (pane.fxStick) pane.el.scrollTop = pane.el.scrollHeight;
        pane.fxStick = false;
    }
}

// ─── Settings > BBS Client ──────────────────────────────────

async function loadRetibbsSettings() {
    let st;
    try {
        st = await fetch('/api/retibbs').then(r => r.json());
    } catch (e) {
        return;
    }
    RetiBBS.state = st;
    const toggle = document.getElementById('setting-bbs-enabled');
    if (toggle) {
        toggle.classList.toggle('active', !!st.settings.enabled);
        toggle.dataset.loaded = '1';
    }
    const proto = document.getElementById('setting-bbs-proto-retibbs');
    if (proto) proto.classList.toggle('active', !st.settings.protocols || st.settings.protocols.retibbs !== false);
    const nomadProto = document.getElementById('setting-bbs-proto-nomadnet');
    if (nomadProto) nomadProto.classList.toggle('active', !st.settings.protocols || st.settings.protocols.nomadnet !== false);
    const fx = document.getElementById('setting-bbs-fx');
    if (fx) fx.classList.toggle('active', !!st.settings.terminal_fx);
    fillRetibbsIdentitySelect(st.identities, st.settings.identity);
}

function fillRetibbsIdentitySelect(identities, value) {
    const select = document.getElementById('setting-bbs-identity');
    if (!select) return;
    select.innerHTML = (identities || []).map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}</option>`).join('');
    select.value = value;
}

// The identity list changed with the dialog open: the choice shown stays.
async function refreshRetibbsIdentityChoices() {
    const select = document.getElementById('setting-bbs-identity');
    if (!select) return;
    let st;
    try { st = await fetch('/api/retibbs').then(r => r.json()); } catch (e) { return; }
    if (!st || !st.settings) return;
    if (RetiBBS.state) RetiBBS.state.identities = st.identities;
    const shown = select.value;
    fillRetibbsIdentitySelect(st.identities, (st.identities || []).some(i => i.id === shown) ? shown : st.settings.identity);
}

function saveRetibbsSettings() {
    const toggle = document.getElementById('setting-bbs-enabled');
    // Not read from the server: nothing sent (as for the messenger).
    if (!toggle || !toggle.dataset.loaded) return Promise.resolve();
    const select = document.getElementById('setting-bbs-identity');
    const on = id => { const el = document.getElementById(id); return !!(el && el.classList.contains('active')); };
    return retibbsPost('/api/retibbs/settings', {
        enabled: toggle.classList.contains('active'),
        protocols: { retibbs: on('setting-bbs-proto-retibbs'), nomadnet: on('setting-bbs-proto-nomadnet') },
        terminal_fx: on('setting-bbs-fx'),
        ...(select && select.value ? { identity: select.value } : {}),
    }).then(res => {
        if (res.status === 'error') showNotification(`BBS client: ${escapeHtml(res.error)}`, 'error', 5000);
        pollRetibbs();
    });
}

startRetibbsPolling();
