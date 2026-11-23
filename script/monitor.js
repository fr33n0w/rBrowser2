// rB2 Monitor: everything rBrowser is doing on one terminal-like page (the
// MON tab, last of the app tabs). On in Settings > System Setup, owner only,
// with its own Terminal CRT EFX switch. Server side: rbrowser/monitor.py,
// GET /api/monitor. Read only.
// Full width panels one under the other. Each read is drawn off screen and
// only what changed is copied in (monMorph): nothing flashes.

const MONITOR_KEY = 'rbrowser_monitor';
const MONITOR_FX_KEY = 'rbrowser_monitor_fx';
const MONITOR_THEME_KEY = 'rbrowser_monitor_theme';
// Only colours, in style.css (.mon-theme-<key>).
const MON_THEMES = [['amber', 'Amber (white, amber, green)'], ['green', 'Green phosphor'], ['orange', 'Orange phosphor'],
                    ['ice', 'Ice blue'], ['white', 'Paper white'], ['synth', 'Synthwave'], ['lcd', 'LCD (light)']];
const MONITOR_EVERY = 2000;
const MONITOR_LOG_MAX = 150;

const Monitor = {
    open: false,
    timer: null,
    busy: false,
    logAfter: 0,
};

const MONITOR_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="10" rx="1"/><path d="M3.5 9l2-2.5 2 2 2-3.5 2.5 3"/></svg>';

const MON_KINDS = [['nomadnet', 'NomadNet'], ['lxmf', 'LXMF'], ['propagation', 'Propagation'],
                   ['rrc', 'RRC'], ['bbs', 'BBS'], ['other', 'Other']];
const MON_IFACE_MODES = { 2: 'point-to-point', 3: 'access point', 4: 'roaming', 5: 'boundary', 6: 'gateway' };

function monitorOn() {
    if (window.rbGuest || (typeof APP_WINDOW !== 'undefined' && APP_WINDOW)) return false;
    try { return localStorage.getItem(MONITOR_KEY) === 'on'; } catch (e) { return false; }
}

function monitorTheme() {
    let t = 'amber';
    try { t = localStorage.getItem(MONITOR_THEME_KEY) || 'amber'; } catch (e) {}
    return MON_THEMES.some(([k]) => k === t) ? t : 'amber';
}

function applyMonitorTheme(view = document.getElementById('monitor-view')) {
    if (!view) return;
    const t = monitorTheme();
    for (const [k] of MON_THEMES) view.classList.toggle(`mon-theme-${k}`, k === t && k !== 'amber');
    const btn = view.querySelector('#mon-theme');
    if (btn) btn.title = `Theme: ${MON_THEMES.find(([k]) => k === t)[1]} (click for the next one)`;
}

function setMonitorTheme(t) {
    try { localStorage.setItem(MONITOR_THEME_KEY, t); } catch (e) {}
    applyMonitorTheme();
    const sel = document.getElementById('setting-monitor-theme');
    if (sel && sel.value !== t) sel.value = t;
}

function nextMonitorTheme() {
    const i = MON_THEMES.findIndex(([k]) => k === monitorTheme());
    setMonitorTheme(MON_THEMES[(i + 1) % MON_THEMES.length][0]);
}

function monitorFxOn() {
    try { return localStorage.getItem(MONITOR_FX_KEY) === 'on'; } catch (e) { return false; }
}

// ─── Formatting ─────────────────────────────────────────────

function monBytes(n) {
    n = Number(n) || 0;
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${i ? n.toFixed(1) : n} ${u[i]}`;
}

function monBits(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)} Mbps`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kbps`;
    return `${Math.round(n)} bps`;
}

function monSpan(s) {
    s = Math.max(0, Math.round(Number(s) || 0));
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

function monAgo(ts, now) {
    if (!ts) return 'never';
    return `${monSpan((now || Date.now() / 1000) - ts)} ago`;
}

function monTime(ts) {
    return new Date(ts * 1000).toTimeString().slice(0, 8);
}

function monHash(h, n = 12) {
    return h ? `<${String(h).slice(0, n)}>` : '-';
}

function monMs(sec) {
    return sec ? `${Math.round(sec * 1000)} ms` : '-';
}

const monE = s => escapeHtml(s === undefined || s === null || s === '' ? '-' : String(s));
const monT = s => escapeHtml(s === undefined || s === null ? '' : String(s));     // empty stays empty

// ─── Building blocks ────────────────────────────────────────
// A panel: title (digital font), a note on the right, then its parts.
// cls everywhere: '' green, 'warn' yellow, 'bad' red, 'dim' dark green.

function monPanel(id, title, note, body, noteCls = '') {
    return `<section class="mon-panel" data-panel="${id}">
        <div class="mon-head"><h3 class="mon-h">${monE(title)}</h3><span class="mon-note ${noteCls}">${monT(note)}</span></div>
        ${body}</section>`;
}

// Big numbers in a row (as nomad-server's strip): [value, label, cls, small line].
// The digital font has no '/': one value per cell.
function monStrip(cells) {
    return `<div class="mon-strip">${cells.map(([v, l, c, sub]) =>
        `<div class="mon-cell"><div class="mon-cv ${c || ''}">${monE(v)}</div><div class="mon-cl">${monE(l)}</div>`
        + `${sub ? `<div class="mon-cs">${monT(sub)}</div>` : ''}</div>`).join('')}</div>`;
}

// Label / value pairs, as many per line as fit: [label, value, cls].
function monKv(rows) {
    return `<div class="mon-kv">${rows.map(([l, v, c]) =>
        `<div class="mon-row"><span class="mon-l">${monE(l)}</span><span class="mon-v ${c || ''}">${monE(v)}</span></div>`).join('')}</div>`;
}

// One line per thing (interface, hub, identity...): dot, tag, name, details, right side.
function monItems(items, empty) {
    if (!items.length) return `<div class="mon-empty">${monE(empty)}</div>`;
    return `<div class="mon-items">${items.map(i =>
        `<div class="mon-item"><span class="mon-dot ${i.dot || ''}"></span><span class="mon-ty">${monE(i.ty)}</span>`
        + `<span class="mon-nm" title="${escapeHtml(i.tip || '')}">${monE(i.nm)}</span>`
        + `<span class="mon-mid ${i.midCls || ''}">${monT(i.mid)}</span><span class="mon-io ${i.ioCls || ''}">${monT(i.io)}</span></div>`).join('')}</div>`;
}

function monOff(id, title, where) {
    return monPanel(id, title, 'off', `<div class="mon-empty">Switched off (Settings > ${monE(where)})</div>`, 'dim');
}

function monBroken(id, title, sec) {
    const err = sec && sec.error && Object.keys(sec).length === 1 ? sec.error : (!sec ? 'not available' : '');
    return err ? monPanel(id, title, 'error', `<div class="mon-empty bad">${monE(err)}</div>`, 'bad') : '';
}

// ─── The panels ─────────────────────────────────────────────

function monSystem(s, usage) {
    const cells = [[monSpan(s.uptime), 'uptime']];
    if (usage && usage.status === 'success') {
        cells.push([`${usage.cpu}%`, 'CPU', usage.cpu > 80 ? 'warn' : '']);
        cells.push([`${usage.rss_mb} MB`, 'RAM']);
    }
    cells.push([s.threads, 'threads']);
    cells.push([s.guests === null || s.guests === undefined ? 'off' : s.guests, 'guests online',
                s.guests === null || s.guests === undefined ? 'dim' : '']);
    if (usage && usage.battery) cells.push([`${usage.battery.percent}%`, usage.battery.plugged ? 'battery, plugged' : 'battery']);
    return monPanel('system', 'SYSTEM', `rBrowser2 ${s.version} · ${s.machine} · ${s.os} · Python ${s.python} · pid ${s.pid}`,
                    monStrip(cells));
}

function monNetwork(n, now) {
    const a = n.addresses || {}, run = a.running || {}, t = n.tunnel || {}, d = n.ddns || {}, i = n.internet || {};
    const inet = !i.state || i.state === 'off' ? ['off', 'dim'] : i.state === 'up' ? ['UP', ''] : i.state === 'down' ? ['DOWN', 'bad'] : ['CHECKING', 'warn'];
    const tunUp = t.state && t.state !== 'off';
    const cells = [
        [run.host !== undefined ? `${run.host}:${run.port}` : '-', 'listening on'],
        [inet[0], i.last_ms !== null && i.last_ms !== undefined && i.state !== 'off' ? `internet · ${i.last_ms} ms` : 'internet', inet[1]],
        [tunUp ? (t.url ? 'UP' : String(t.state).toUpperCase()) : 'off', 'tunnel', tunUp ? (t.url ? '' : t.error ? 'bad' : 'warn') : 'dim'],
        [d.on ? (d.state === 'ok' ? 'OK' : String(d.state || 'waiting').toUpperCase()) : 'off', 'DDNS', d.on ? (d.state === 'ok' ? '' : 'warn') : 'dim'],
    ];
    const rows = [];
    if (a.local) rows.push(['This device', a.local]);
    (a.lan || []).forEach(u => rows.push(['Home network', u]));
    if (a.local_only) rows.push(['Home network', 'closed (127.0.0.1)', 'dim']);
    if (t.url) rows.push(['Tunnel address', t.url]);
    if (t.error) rows.push(['Tunnel error', t.error, 'bad']);
    if (d.on) {
        rows.push(['DDNS name', `${d.domain || '?'} (${d.provider || '?'})`]);
        if (d.ip) rows.push(['Public IP', d.ip]);
        if (d.at) rows.push(['DDNS updated', monAgo(d.at, now)]);
        if (d.error) rows.push(['DDNS error', d.error, 'bad']);
    }
    if (i.state && i.state !== 'off') {
        rows.push(['Internet check', `${i.method === 'ntp' ? 'time server' : 'hosts'} every ${monSpan(i.every)}`]);
        if (i.last_check) rows.push(['Last answer', `${i.last_ok ? 'ok' : 'none'} ${monAgo(i.last_check, now)}`, i.last_ok ? '' : 'bad']);
        if (i.state === 'down' && i.down_for) rows.push(['Down for', monSpan(i.down_for), 'bad']);
    } else {
        rows.push(['Internet check', 'off (System Setup > Internet check)', 'dim']);
    }
    return monPanel('network', 'NETWORK', i.state === 'down' ? 'no internet' : '', monStrip(cells) + monKv(rows), 'bad');
}

function monReticulum(r, now) {
    const ifs = r.interfaces || [];
    const up = ifs.filter(f => f.status).length;
    const note = [r.ready ? 'CONNECTED' : 'NOT READY', r.shared === null ? '' : r.shared ? 'Shared instance (rnsd)' : 'Own Reticulum instance',
                  ifs.length ? `${up} of ${ifs.length} interfaces up` : '', `RNS v${r.version}`].filter(Boolean).join(' · ');
    const t = r.totals || {};
    const cells = [];
    if (t.rxb !== undefined) {
        cells.push([`↓ ${monBytes(t.rxb)}`, 'received'], [`↑ ${monBytes(t.txb)}`, 'sent'],
                   [`↓ ${monBits(t.rxs)}`, 'speed in'], [`↑ ${monBits(t.txs)}`, 'speed out']);
        if (t.rxpps !== undefined) cells.push([`↓ ${(+t.rxpps).toFixed(1)}`, 'packets/s in'], [`↑ ${(+t.txpps).toFixed(1)}`, 'packets/s out']);
    }
    const items = ifs.map(f => {
        const mid = [];
        if (f.mode && MON_IFACE_MODES[f.mode]) mid.push(MON_IFACE_MODES[f.mode]);
        if (f.bitrate) mid.push(monBits(f.bitrate));
        mid.push(`${monBits(f.rxs)} ↓ ${monBits(f.txs)} ↑`);
        if (f.incoming_announce_frequency !== undefined) mid.push(`ann ${(+f.incoming_announce_frequency).toFixed(2)}/s`);
        if (f.clients !== undefined && f.clients !== null) mid.push(`${f.clients} clients`);
        if (f.peers !== undefined && f.peers !== null) mid.push(`${f.peers} peers`);
        if (f.frequency) mid.push(`${(f.frequency / 1e6).toFixed(3)} MHz SF${f.sf || '?'} ${f.txpower !== undefined ? f.txpower + ' dBm' : ''}`.trim());
        if (f.rssi !== undefined) mid.push(`RSSI ${f.rssi} SNR ${f.snr}`);
        if (f.channel_load_short !== undefined) mid.push(`load ${f.channel_load_short}%`);
        if (f.held_announces) mid.push(`${f.held_announces} held`);
        if (f.txdrp) mid.push(`${f.txdrp} drops`);
        if (f.ifac_netname) mid.push(`net ${f.ifac_netname}`);
        return { dot: f.status ? '' : 'bad', ty: String(f.type || '').replace(/Interface$/, ''), nm: f.name,
                 mid: mid.join(' · '), io: `↓${monBytes(f.rxb)} ↑${monBytes(f.txb)}`, midCls: f.txdrp ? 'warn' : '' };
    });
    const kv = monKv([['Transport', t.transport_id ? `on ${monHash(t.transport_id)}` : r.transport ? 'on' : 'off'],
                      ['rnsd uptime', t.transport_uptime ? monSpan(t.transport_uptime) : '-'],
                      ['Identity', monHash(r.identity, 32)],
                      ['Links (ours)', `${r.links} active · ${r.pending_links} pending`]]);
    return monPanel('reticulum', 'RETICULUM', note, (cells.length ? monStrip(cells) : '') + monItems(items, r.read_at ? 'No interfaces: this instance reaches nobody else.' : 'Interfaces not read yet') + kv, r.ready ? '' : 'bad');
}

function monIdentities(d) {
    const items = (d.profiles || []).map(p => ({
        dot: p.loadable === false ? 'bad' : p.used_in.length ? '' : 'dim',
        ty: p.active ? 'IN USE' : 'ID', nm: p.name,
        mid: `${monHash(p.identity, 32)}  LXMF ${monHash(p.lxmf, 32)}`,
        io: p.used_in.length ? `Used in ${p.used_in.join(', ')}` : 'not used now', ioCls: p.used_in.length ? '' : 'dim',
        tip: `Identity ${p.identity}\nLXMF ${p.lxmf}`,
    }));
    const note = `${items.length} saved · ${d.identified} nodes identified to now · ${d.bindings} node bindings`;
    return monPanel('identities', 'IDENTITIES', note, monItems(items, 'No identities'));
}

function monAnnounces(a, now) {
    const m = a.minute || {}, h = a.hour || {}, k = a.by_kind || {};
    const sum = o => Object.values(o).reduce((x, y) => x + y, 0);
    const cells = MON_KINDS.map(([key, label]) => [k[key] || 0, label, k[key] ? '' : 'dim', `${m[key] || 0}/min · ${h[key] || 0}/hour`]);
    const names = Object.fromEntries(MON_KINDS);
    const items = (a.recent || []).map(e => ({ dot: e.kind === 'other' ? 'dim' : '', ty: names[e.kind] || e.kind,
                                               nm: e.name || monHash(e.hash), mid: e.name ? monHash(e.hash, 32) : '',
                                               io: monTime(e.at), tip: e.hash }));
    return monPanel('announces', 'ANNOUNCES', `${a.total} since start · ${sum(m)}/min · ${sum(h)}/hour`,
                    monStrip(cells) + `<div class="mon-sub">LAST HEARD</div>` + monItems(items, 'Nothing heard yet'));
}

function monLxmf(m, now) {
    if (!m.enabled) return monOff('lxmf', 'LXMF', 'LXMF Messenger');
    const state = m.offline ? 'OFFLINE' : m.running ? 'LISTENING' : 'STARTING';
    const c = m.messages || {};
    const cells = [[c.in ?? '-', 'received'], [c.out ?? '-', 'sent'], [c.in_24h ?? 0, 'received, 24 h'], [c.out_24h ?? 0, 'sent, 24 h'],
                   [c.unread ?? 0, 'unread', c.unread ? 'warn' : ''], [c.sending ?? 0, 'sending now', c.sending ? 'warn' : ''],
                   [c.failed ?? 0, 'failed', c.failed ? 'bad' : '']];
    const p = m.propagation || {};
    const rows = [['Address', monHash(m.address, 32)], ['Last announce', monAgo(m.last_announce, now)],
                  ['Peers heard', m.peers ? `${m.peers.live} live · ${m.peers.known} known` : '-'],
                  ['Listening', `${c.identities ?? 0} identities · ${c.chats ?? 0} chats`],
                  ['Propagation node', p.node ? `${p.node_name || ''} ${monHash(p.node)}`.trim() : 'none', p.node ? '' : 'dim'],
                  ['Propagation', `${p.mode || '-'} · ${p.heard ?? 0} heard${p.set_aside ? ` · ${p.set_aside} set aside` : ''}`],
                  ['Last sync', `${monAgo(p.last_sync, now)}${p.sync ? ' · ' + p.sync : ''}`]];
    if (m.transfers) rows.push(['Files arriving', m.transfers, 'warn']);
    if (m.error) rows.push(['Error', m.error, 'bad']);
    return monPanel('lxmf', 'LXMF', `${state} · ${m.identity || ''} · ${m.name || ''}`, monStrip(cells) + monKv(rows),
                    m.offline ? 'warn' : m.error ? 'bad' : '');
}

function monRrc(r, now) {
    if (!r.enabled) return monOff('rrc', 'RRC', 'RRC Client');
    const items = (r.hubs || []).map(h => {
        const ok = h.state === 'connected';
        return { dot: ok ? '' : h.state === 'connecting' ? 'warn' : 'bad', ty: h.state.toUpperCase(), nm: h.name,
                 mid: `${h.rooms} rooms${h.users ? ` · ${h.users} people` : ''} · ${h.unread} unread · ${h.reconnects} reconnects`
                      + `${h.waiting ? ` · ${h.waiting} waiting` : ''}${h.last_rx ? ` · last packet ${monAgo(h.last_rx, now)}` : ''}`
                      + (h.error && !ok ? ` · ${h.error}` : ''),
                 io: `RTT ${monMs(h.rtt)}`, tip: h.address };
    });
    const note = `nick ${r.nick} · ${r.heard ? `${r.heard.live} hubs heard live, ${r.heard.known} known` : ''}${r.guest_hubs ? ` · ${r.guest_hubs} guest hubs` : ''}`;
    return monPanel('rrc', 'RRC', note, monItems(items, 'No hub connected'));
}

function monBbs(b, now) {
    if (!b.enabled) return monOff('bbs', 'BBS', 'BBS Client');
    const items = (b.sessions || []).map(s => {
        const ok = s.state === 'connected';
        return { dot: ok ? '' : s.state === 'connecting' ? 'warn' : 'bad', ty: String(s.state).toUpperCase(), nm: s.name,
                 mid: [s.area, s.error && !ok ? s.error : ''].filter(Boolean).join(' · '), io: `RTT ${monMs(s.rtt)}`, tip: s.address };
    });
    const note = `${b.running ? 'listening' : 'starting'}${b.heard ? ` · ${b.heard.live} BBS heard live, ${b.heard.known} known` : ''}`;
    return monPanel('bbs', 'BBS', note, monItems(items, 'No BBS open'));
}

function monNomad(n, now) {
    const cells = [[n.nodes, 'nodes known'], [n.links, 'links open'], [n.favorites, 'favorites'],
                   [n.last_announce ? monAgo(n.last_announce, now) : 'never', 'last node announce'],
                   [n.cache_on ? 'on' : 'off', 'page cache', n.cache_on ? '' : 'dim']];
    const m = n.rmap;
    if (m) cells.push(m.enabled ? [m.nodes ?? '-', m.error ? 'RMAP · last fetch failed' : `RMAP nodes · ${monAgo(m.fetched_at, now)}`, m.error ? 'bad' : '']
                                : ['off', 'RMAP', 'dim']);
    const note = n.guest_watches ? `${n.guest_watches} guest sessions browsing` : '';
    return monPanel('nomadnet', 'NOMADNET', note, monStrip(cells));
}

function monSafe(build, sec, id, title, ...extra) {
    const broken = monBroken(id, title, sec);
    if (broken) return broken;
    try { return build(sec, ...extra); }
    catch (e) { return monPanel(id, title, 'error', `<div class="mon-empty bad">${monE(e.message)}</div>`, 'bad'); }
}

function renderMonitor(d, usage) {
    const now = d.now;
    const html = [
        monSafe(monSystem, d.system, 'system', 'SYSTEM', usage),
        monSafe(monNetwork, d.network, 'network', 'NETWORK', now),
        monSafe(monReticulum, d.reticulum, 'reticulum', 'RETICULUM', now),
        monSafe(monIdentities, d.identities, 'identities', 'IDENTITIES'),
        monSafe(monAnnounces, d.announces, 'announces', 'ANNOUNCES', now),
        monSafe(monLxmf, d.lxmf, 'lxmf', 'LXMF', now),
        monSafe(monRrc, d.rrc, 'rrc', 'RRC', now),
        monSafe(monBbs, d.bbs, 'bbs', 'BBS', now),
        monSafe(monNomad, d.nomadnet, 'nomadnet', 'NOMADNET', now),
    ].join('');
    const grid = document.getElementById('mon-grid');
    if (!grid) return;
    const next = document.createElement('div');
    next.innerHTML = html;
    if (grid.querySelector('.mon-boot')) grid.innerHTML = '';
    monMorph(grid, next);
}

// Makes old look like new, touching only what differs.
function monMorph(old, neu) {
    const a = [...old.childNodes], b = [...neu.childNodes];
    for (let i = 0; i < b.length; i++) {
        const o = a[i], n = b[i];
        if (!o) { old.appendChild(n); continue; }
        if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) { old.replaceChild(n, o); continue; }
        if (o.nodeType === 3) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; continue; }
        if (o.nodeType !== 1) continue;
        for (const at of [...o.attributes]) if (!n.hasAttribute(at.name)) o.removeAttribute(at.name);
        for (const at of [...n.attributes]) if (o.getAttribute(at.name) !== at.value) o.setAttribute(at.name, at.value);
        monMorph(o, n);
    }
    for (let i = a.length - 1; i >= b.length; i--) a[i].remove();
}

// ─── The tab and the view ───────────────────────────────────

function ensureMonitorTab() {
    let tab = document.getElementById('monitor-tab');
    if (!tab) {
        tab = document.createElement('div');
        tab.className = 'tab tab-messages tab-monitor';
        tab.id = 'monitor-tab';
        tab.title = 'rB2 Monitor';
        tab.innerHTML = `${MONITOR_ICON}<span class="tab-app-label">MON</span>`;
        tab.addEventListener('click', () => openMonitor());
        addAppTabOff(tab, 'rB2 Monitor', async () => {
            try { localStorage.setItem(MONITOR_KEY, 'off'); } catch (e) {}
            applyMonitorVisibility();
        }, { close: () => closeMonitor() });
        placeAppTab(tab);
    }
    let view = document.getElementById('monitor-view');
    if (!view) {
        view = document.createElement('div');
        view.className = 'tab-content monitor-view';
        view.id = 'monitor-view';
        view.innerHTML = `
            <div class="mon-screen">
                <div class="mon-top">
                    <span class="mon-title">rB2 MONITOR</span>
                    <span class="mon-live" id="mon-live">○ WAIT</span>
                    <span class="mon-clock" id="mon-clock"></span>
                    <button class="mon-close" id="mon-theme" onclick="nextMonitorTheme()" aria-label="Next theme">◐</button>
                    <button class="mon-close" onclick="closeMonitor()" title="Close rB2 Monitor" aria-label="Close">&times;</button>
                </div>
                <div class="mon-grid" id="mon-grid"><div class="mon-boot">BOOTING MONITOR<span class="mon-cursor">█</span></div></div>
                <section class="mon-panel">
                    <div class="mon-head"><h3 class="mon-h">LOG</h3><span class="mon-note">last lines of the terminal</span></div>
                    <pre class="mon-log" id="mon-log"></pre>
                </section>
            </div>`;
        document.getElementById('tab-content-wrapper').appendChild(view);
        // Any other tab or client taking the screen takes the active class away.
        new MutationObserver(() => {
            if (Monitor.open && !view.classList.contains('active')) monitorStopped();
        }).observe(view, { attributes: true, attributeFilter: ['class'] });
    }
    view.classList.toggle('mon-fx', monitorFxOn());
    applyMonitorTheme(view);
}

function openMonitor() {
    if (!monitorOn()) return;
    ensureMonitorTab();
    if (typeof Messenger !== 'undefined') Messenger.open = false;
    if (typeof RetiBBS !== 'undefined') RetiBBS.open = false;
    if (typeof Rrc !== 'undefined') Rrc.open = false;
    if (typeof Rmap !== 'undefined') Rmap.open = false;
    document.body.classList.remove('messenger-open', 'retibbs-open', 'rrc-open', 'rmap-open');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('monitor-tab').classList.add('active');
    document.getElementById('monitor-view').classList.add('active');
    document.body.classList.add('monitor-open');
    Monitor.open = true;
    pollMonitor();
}

function monitorStopped() {
    Monitor.open = false;
    document.body.classList.remove('monitor-open');
    clearTimeout(Monitor.timer);
    Monitor.timer = null;
    const tab = document.getElementById('monitor-tab');
    if (tab) tab.classList.remove('active');
}

function closeMonitor() {
    const view = document.getElementById('monitor-view');
    if (view) view.classList.remove('active');
    monitorStopped();
    if (typeof activeTabId !== 'undefined' && activeTabId) switchToTab(activeTabId);
}

function applyMonitorVisibility() {
    const on = monitorOn();
    if (on) ensureMonitorTab();
    const tab = document.getElementById('monitor-tab');
    if (tab) tab.hidden = !on;
    const view = document.getElementById('monitor-view');
    if (view) view.classList.toggle('mon-fx', monitorFxOn());
    applyMonitorTheme(view);
    layoutAppTabs();
    if (!on && Monitor.open) closeMonitor();
}

// ─── Reading ────────────────────────────────────────────────

async function pollMonitor() {
    clearTimeout(Monitor.timer);
    if (!Monitor.open) return;
    if (!document.hidden && !Monitor.busy) {
        Monitor.busy = true;
        try {
            const [data, usage, log] = await Promise.all([
                fetch('/api/monitor').then(r => r.json()),
                fetch('/api/usage').then(r => r.json()).catch(() => null),
                fetch(`/api/log?after=${Monitor.logAfter}`).then(r => r.json()).catch(() => null),
            ]);
            if (data && data.status === 'success') {
                renderMonitor(data, usage);
                setMonLive(true);
            } else {
                setMonLive(false, (data && data.error) || 'no answer');
            }
            if (log && log.status === 'success') appendMonLog(log);
        } catch (e) {
            setMonLive(false, e.message);
        } finally {
            Monitor.busy = false;
        }
    }
    Monitor.timer = setTimeout(pollMonitor, MONITOR_EVERY);
}

function setMonLive(ok, why) {
    const el = document.getElementById('mon-live');
    if (!el) return;
    const text = ok ? '● LIVE' : '○ NO SIGNAL';
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('bad', !ok);
    el.title = ok ? `Read every ${MONITOR_EVERY / 1000} s` : `rBrowser did not answer: ${why || ''}`;
    const clock = document.getElementById('mon-clock');
    if (clock) clock.textContent = new Date().toTimeString().slice(0, 8);
}

function appendMonLog(log) {
    const pre = document.getElementById('mon-log');
    if (!pre) return;
    const first = Monitor.logAfter === 0;
    Monitor.logAfter = log.last || Monitor.logAfter;
    let lines = log.lines || [];
    if (first) lines = lines.slice(-MONITOR_LOG_MAX);
    if (!lines.length) return;
    const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
    for (const line of lines) {
        const div = document.createElement('div');
        div.textContent = line;
        if (/⚠️|❌|🔴|error|failed/i.test(line)) div.className = 'bad';
        pre.appendChild(div);
    }
    while (pre.childElementCount > MONITOR_LOG_MAX) pre.firstElementChild.remove();
    if (atEnd || first) pre.scrollTop = pre.scrollHeight;
}

// Settings > System Setup > rB2 Monitor: applied at once, kept in ui_prefs.json.
function toggleMonitorSetting(el, key = MONITOR_KEY) {
    const on = !el.classList.contains('active');
    el.classList.toggle('active', on);
    try { localStorage.setItem(key, on ? 'on' : 'off'); } catch (e) {}
    applyMonitorVisibility();
}

// The switches live in Settings > System Setup; the tab follows them.
document.addEventListener('DOMContentLoaded', () => applyMonitorVisibility());
window.addEventListener('storage', e => { if ([MONITOR_KEY, MONITOR_FX_KEY, MONITOR_THEME_KEY].includes(e.key)) applyMonitorVisibility(); });
