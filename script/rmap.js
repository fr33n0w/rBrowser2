// RMAP integration: the nodes rmap.world hears, on a map and in lists by
// kind. Server side in rbrowser/rmap.py (fetches https://rmap.world/?json
// while on, keeps a trimmed copy). Loaded after rbrowser.js, messenger.js and
// retibbs.js and uses their helpers (escapeHtml, showNotification, copyText,
// openQuickAddress, usePropagationNode, openRetibbs, retibbsConnect...).
//
// The view: map on top, a bar that can be dragged, under it one column per
// kind. What a click does depends on the kind:
//   NomadNet          opens the node's page in a new tab
//   Propagation node  becomes our propagation node (Settings > LXMF Messenger)
//   RRC               the RRC client connects to the hub
//   BBS               RetiBBS: the BBS client connects; NomadNet: its page
//   Backbone          copies a Reticulum interface config for it

const Rmap = {
    status: null,           // GET /api/rmap
    data: null,             // GET /api/rmap/nodes
    dataKey: '',            // fetched_at + age: the list is read again when it changes
    open: false,
    map: null,
    cluster: null,
    markers: {},            // {hash: Leaflet marker}
    filter: '',
    leaflet: null,          // promise of Leaflet loaded
    hidden: (() => {        // kinds switched off with the chips, in this browser
        try { return JSON.parse(localStorage.getItem('rmap-hidden')) || {}; } catch (e) { return {}; }
    })(),
    pollTimer: null,
    // Phones: the one list shown, picked in the selector by the search.
    pick: (() => { try { return localStorage.getItem('rmap-pick') || 'nomadnet'; } catch (e) { return 'nomadnet'; } })(),
};

const RMAP_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 3.5l4-1.5 5 2 4-1.5v10l-4 1.5-5-2-4 1.5z"/><path d="M5.5 2v10M10.5 4v10"/></svg>';

const RMAP_GROUPS = [
    { key: 'nomadnet', label: 'NomadNet', hint: 'Click: open the page in a new tab' },
    { key: 'propnode', label: 'Propagation nodes', hint: 'Click: use as our propagation node' },
    { key: 'rrc', label: 'RRC', hint: 'Click: connect in the RRC client' },
    { key: 'bbs', label: 'BBS', hint: 'RetiBBS: connect with the BBS client - NomadNet: open the page' },
    { key: 'backbone', label: 'Backbone & TCP', hint: 'Click: details and the Reticulum interface config, to copy' },
    { key: 'rnode', label: 'RNode LoRa', hint: 'Click: details and an RNodeInterface config with its radio settings, to edit (port, power) and copy' },
];
const RMAP_LIST_MAX = 400;      // rows drawn per column; the search narrows the rest

// The colours of rmap.world (TYPE_CFG in its index.php), per node type, for
// the dots on the map: a Tor or I2P server looks the same here and there.
const RMAP_TYPE_COLORS = {
    NomadNet: '#ff6b4a', PropNode: '#26de81', RRC: '#00d2d3', RetiBBS: '#fd9644',
    Backbone: '#ff3333', I2P: '#9b59b6', Yggdrasil: '#3498db', Mycelium: '#c68642',
    Tor: '#e84393', TCP_Client: '#888888', RNode_LoRa: '#0099ff',
};

function rmapEnabled() {
    return !!(Rmap.status && Rmap.status.settings && Rmap.status.settings.enabled);
}

// ─── The tab and the view ───────────────────────────────────

function ensureRmapTab() {
    let tab = document.getElementById('rmap-tab');
    if (!tab) {
        tab = document.createElement('div');
        tab.className = 'tab tab-messages tab-rmap';
        tab.id = 'rmap-tab';
        tab.title = 'RMAP';
        tab.innerHTML = `${RMAP_ICON}<span class="tab-app-label">RMAP</span>`;
        tab.addEventListener('click', () => openAppTab('rmap'));
        addAppTabOff(tab, 'RMAP', async () => {
            const res = await fetch('/api/rmap/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                         body: JSON.stringify({ enabled: false }) }).then(r => r.json());
            if (res && res.status === 'error') throw new Error(res.error);
            pollRmap();
        }, { close: () => closeRmap() });
        placeAppTab(tab);
    }
    let view = document.getElementById('rmap-view');
    if (!view) {
        view = document.createElement('div');
        view.className = 'tab-content rmap-view';
        view.id = 'rmap-view';
        view.innerHTML = `
            <div class="rmap-head">
                <button class="nav-btn sidebar-toggle-btn" onclick="toggleSidebar()" title="Hide the node list">&laquo;</button>${appMainButton()}
                <span class="bbs-title">${RMAP_ICON}<span>RMAP</span></span>
                <span class="rmap-state" id="rmap-state"></span>
                <span class="rmap-chips" id="rmap-chips"></span>
                <button class="msg-bar-btn" id="rmap-theme" title="Light or dark map (also in Settings > RMAP > Map)" aria-label="Light or dark map">☾</button>
                <button class="msg-bar-btn" id="rmap-refresh" title="Fetch the list again from rmap.world">Refresh</button>
                <button class="msg-bar-btn msg-settings-btn" onclick="showSettings('rmap')" title="RMAP settings" aria-label="RMAP settings">${typeof GEAR_ICON !== 'undefined' ? GEAR_ICON : '⚙'}</button>
                <button class="msg-close" onclick="closeRmap()" title="Close RMAP" aria-label="Close">&times;</button>
            </div>
            <div class="rmap-map" id="rmap-map"><div class="msg-search-none">Loading the map…</div></div>
            <div class="rmap-split" id="rmap-split" title="Drag to resize" role="separator" aria-orientation="horizontal"><span></span></div>
            <div class="rmap-lists" id="rmap-lists">
                <div class="rmap-tools">
                    <select id="rmap-pick" class="settings-select rmap-pick" title="Which list to show"></select>
                    <input type="text" id="rmap-filter" class="msg-search" placeholder="Search name, address, host" spellcheck="false" autocomplete="off">
                    <span class="rmap-note">From rmap.world: hops are counted from rmap, not from here.</span>
                </div>
                <div class="rmap-cols" id="rmap-cols"></div>
            </div>`;
        document.getElementById('tab-content-wrapper').appendChild(view);
        bindRmapView(view);
        applySidebarState(document.body.classList.contains('sidebar-collapsed'));
    }
}

function bindRmapView(view) {
    view.querySelector('#rmap-refresh').onclick = () => rmapRefresh();
    // Day / night: the same as Settings > RMAP > Map, saved there.
    view.querySelector('#rmap-theme').onclick = async () => {
        const map = `${rmapMapMode()}-${rmapTheme() === 'light' ? 'dark' : 'light'}`;
        const res = await fetch('/api/rmap/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ map }) }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
        if (res.status === 'error') { showNotification(`RMAP: ${escapeHtml(res.error)}`, 'error', 5000); return; }
        Rmap.status = res;
        applyRmapBase();
        renderRmapState();
    };
    view.querySelector('#rmap-pick').addEventListener('change', e => {
        Rmap.pick = e.target.value;
        try { localStorage.setItem('rmap-pick', Rmap.pick); } catch (err) { /* only now */ }
        renderRmapLists();
    });
    window.addEventListener('resize', () => { if (Rmap.open) renderRmapLists(); });
    view.querySelector('#rmap-filter').addEventListener('input', e => { Rmap.filter = e.target.value; renderRmapLists(); });
    view.querySelector('#rmap-filter').addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.target.value = ''; Rmap.filter = ''; renderRmapLists(); }
    });
    view.querySelector('#rmap-chips').addEventListener('click', e => {
        const chip = e.target.closest('[data-rmap-chip]');
        if (!chip) return;
        const k = chip.dataset.rmapChip;
        Rmap.hidden[k] = !Rmap.hidden[k];
        try { localStorage.setItem('rmap-hidden', JSON.stringify(Rmap.hidden)); } catch (err) { /* only this time */ }
        renderRmapChips();
        renderRmapLists();
        renderRmapMarkers();
    });
    // Rows and popups share one way of acting.
    view.addEventListener('click', e => {
        if (e.target.closest('.leaflet-popup')) return;     // handled on popupopen
        const pin = e.target.closest('[data-rmap-pin]');
        if (pin) { e.stopPropagation(); rmapFlyTo(pin.dataset.rmapPin); return; }
        const act = e.target.closest('[data-rmap-act]');
        if (act) { e.stopPropagation(); rmapAct(act.dataset.rmapAct, act.dataset.hash, act.dataset.group); return; }
        const row = e.target.closest('[data-rmap-row]');
        if (row) rmapAct('primary', row.dataset.rmapRow, row.dataset.group);
    });
    view.addEventListener('contextmenu', e => {
        const row = e.target.closest('[data-rmap-row]');
        if (!row) return;
        e.preventDefault();
        copyText(row.dataset.rmapRow, 'Address copied');
    });
    bindRmapSplit(view);
}

// The bar between map and lists: dragged, remembered in this browser.
function rmapListsPct() {
    let pct = 25;
    try { pct = Number(localStorage.getItem('rmap-lists-pct')) || 25; } catch (e) { /* default */ }
    return Math.min(75, Math.max(15, pct));
}

function applyRmapSplit(view, pct) {
    view.querySelector('#rmap-lists').style.height = `${pct}%`;
    if (Rmap.map) Rmap.map.invalidateSize();
}

function bindRmapSplit(view) {
    const split = view.querySelector('#rmap-split');
    applyRmapSplit(view, rmapListsPct());
    split.addEventListener('pointerdown', e => {
        e.preventDefault();
        split.setPointerCapture(e.pointerId);
        const box = view.getBoundingClientRect();
        const move = ev => {
            const pct = Math.min(75, Math.max(15, (box.bottom - ev.clientY) / box.height * 100));
            view.querySelector('#rmap-lists').style.height = `${pct}%`;
        };
        const up = ev => {
            split.removeEventListener('pointermove', move);
            split.removeEventListener('pointerup', up);
            const pct = Math.min(75, Math.max(15, (box.bottom - ev.clientY) / box.height * 100));
            try { localStorage.setItem('rmap-lists-pct', String(Math.round(pct))); } catch (err) { /* only this time */ }
            applyRmapSplit(view, pct);
        };
        split.addEventListener('pointermove', move);
        split.addEventListener('pointerup', up);
    });
}

function openRmap() {
    if (!rmapEnabled()) {
        showNotification('RMAP is off: Settings > RMAP', 'info', 5000);
        return;
    }
    ensureRmapTab();
    if (typeof Messenger !== 'undefined') Messenger.open = false;
    document.body.classList.remove('messenger-open');
    if (typeof RetiBBS !== 'undefined') RetiBBS.open = false;
    document.body.classList.remove('retibbs-open');
    if (typeof Rrc !== 'undefined') Rrc.open = false;
    document.body.classList.remove('rrc-open');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('rmap-tab').classList.add('active');
    document.getElementById('rmap-view').classList.add('active');
    document.body.classList.add('rmap-open');
    Rmap.open = true;
    renderRmapChips();
    renderRmapState();
    ensureRmapMap().then(() => {
        Rmap.map.invalidateSize();
        loadRmapNodes(true);
    });
}

function closeRmap() {
    if (appWindowClose()) return;
    Rmap.open = false;
    document.body.classList.remove('rmap-open');
    const view = document.getElementById('rmap-view');
    if (view) view.classList.remove('active');
    const tab = document.getElementById('rmap-tab');
    if (tab) tab.classList.remove('active');
    if (typeof activeTabId !== 'undefined' && activeTabId) switchToTab(activeTabId);
}

function applyRmapVisibility() {
    const on = rmapEnabled();
    if (on) ensureRmapTab();
    const tab = document.getElementById('rmap-tab');
    if (tab) tab.hidden = !on;
    layoutAppTabs();
    if (!on && Rmap.open) closeRmap();
    // The list from rmap.world: being fetched (yellow), the last fetch failed
    // (red), fetched (green), not yet (grey).
    const st = Rmap.status;
    if (tab && on && st) {
        const next = st.fetched_at ? Math.max(0, st.fetched_at + st.settings.refresh_minutes * 60 - Date.now() / 1000) : null;
        const inWords = s => s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
        setAppTabState(tab, st.fetching ? 'connecting' : st.error ? 'failed' : st.fetched_at ? 'connected' : '',
            st.fetching ? 'RMAP: fetching the list from rmap.world…'
                : st.error ? `RMAP: last fetch failed (${st.error})`
                : st.fetched_at ? `RMAP: list updated ${rmapAgo(st.fetched_at)}, next in ${inWords(next)}` : 'RMAP: no list yet');
    }
}

// ─── The map ────────────────────────────────────────────────

function rmapLoadFile(url, css) {
    return new Promise((resolve, reject) => {
        const el = document.createElement(css ? 'link' : 'script');
        if (css) { el.rel = 'stylesheet'; el.href = url; } else { el.src = url; }
        el.onload = resolve;
        el.onerror = () => reject(new Error(`${url} not loaded`));
        document.head.appendChild(el);
    });
}

// Leaflet is loaded the first time the view opens, not with every page.
function ensureRmapMap() {
    if (!Rmap.leaflet) {
        Rmap.leaflet = Promise.all([
            rmapLoadFile('/script/leaflet/leaflet.css', true),
            rmapLoadFile('/script/leaflet/MarkerCluster.css', true),
            rmapLoadFile('/script/leaflet/MarkerCluster.Default.css', true),
            rmapLoadFile('/script/leaflet/leaflet.js'),
        ]).then(() => rmapLoadFile('/script/leaflet/leaflet.markercluster.js'))
          .then(() => {
              const box = document.getElementById('rmap-map');
              box.innerHTML = '';
              // Canvas: the offline borders are ~1500 polygons, too many as SVG.
              const map = L.map(box, { worldCopyJump: true, minZoom: 2, maxZoom: 16, zoomControl: true, preferCanvas: true })
                  .setView([35, 10], 2);
              // Leaflet keeps clicks inside a popup from reaching the page:
              // its buttons get their handler here, when it opens.
              map.on('popupopen', e => {
                  const el = e.popup.getElement();
                  if (el) el.onclick = ev => {
                      const act = ev.target.closest('[data-rmap-act]');
                      if (act) rmapAct(act.dataset.rmapAct, act.dataset.hash, act.dataset.group);
                  };
              });
              // The node list folding, the bar dragged, the window resized:
              // Leaflet has to learn the new size or it leaves grey bands.
              if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => map.invalidateSize()).observe(box);
              Rmap.map = map;
              applyRmapBase();
              Rmap.cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 40 });
              map.addLayer(Rmap.cluster);
          })
          .catch(err => {
              Rmap.leaflet = null;
              const box = document.getElementById('rmap-map');
              if (box) box.innerHTML = `<div class="msg-search-none">Map not available: ${escapeHtml(err.message)}</div>`;
              throw err;
          });
    }
    return Rmap.leaflet;
}

// The map under the nodes (Settings > RMAP > Map):
//   online   Esri dark grey tiles with labels (one of rmap.world's layers)
//   offline  country borders drawn from script/leaflet/countries.json
//            (Natural Earth 1:50m, public domain), nothing asked of anyone
// Downloading tiles for offline use is not offered: Esri's and OSM's terms
// forbid bulk downloads.
function rmapMapMode() {
    const st = Rmap.status && Rmap.status.settings;
    return st && String(st.map).startsWith('online') ? 'online' : 'offline';     // offline unless asked
}

// Light (as on rmap.world, easier to read) or dark: Settings > RMAP > Map.
function rmapTheme() {
    const st = Rmap.status && Rmap.status.settings;
    return st && String(st.map).endsWith('dark') ? 'dark' : 'light';
}

let rmapCountries = null;       // promise of the borders, fetched once

function rmapOfflineLayer() {
    if (!rmapCountries) {
        // Read once, turned once into [lat, lon] rings: a theme change
        // only draws them again.
        rmapCountries = fetch('/script/leaflet/countries.json').then(r => r.json()).then(list => list.map(c =>
            // Each ring is a flat list: lon, lat, lon, lat...
            (c.r || []).map(flat => {
                const pts = [];
                for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i + 1], flat[i]]);
                return pts;
            }).filter(pts => pts.length > 2)).filter(rings => rings.length))
            .catch(e => { rmapCountries = null; throw e; });
    }
    const group = L.layerGroup();
    const light = rmapTheme() === 'light';
    rmapCountries.then(countries => {
        const style = light
            ? { color: '#b9c0c7', weight: 0.8, fillColor: '#f7f7f4', fillOpacity: 1, interactive: false }
            : { color: '#3b4450', weight: 0.8, fillColor: '#1f262e', fillOpacity: 1, interactive: false };
        // One layer for the whole world (a multi-polygon, a country each):
        // 1500 separate layers were slow to show, on Firefox above all.
        L.polygon(countries, style).addTo(group);
        group.eachLayer(l => { if (l._map) l.bringToBack(); });
        // Loaded while the map had no size yet (tab just opened): it shows
        // now, not at the first zoom.
        if (Rmap.map) { Rmap.map.invalidateSize(); Rmap.map.fire('moveend'); }
    }).catch(() => showNotification('Offline map not available: countries.json not loaded', 'error', 5000));
    return group;
}

function applyRmapBase() {
    const map = Rmap.map;
    if (!map) return;
    const mode = rmapMapMode();
    const theme = rmapTheme();
    if (Rmap.base && Rmap.base.mode === mode && Rmap.base.theme === theme) return;
    if (Rmap.base) Rmap.base.layers.forEach(l => map.removeLayer(l));
    map.getContainer().classList.toggle('rmap-light', theme === 'light');
    const esri = theme === 'light' ? 'Light_Gray' : 'Dark_Gray';
    let layers;
    if (mode === 'offline') {
        layers = [rmapOfflineLayer()];
        map.getContainer().classList.add('rmap-offline');
        map.attributionControl.addAttribution('Borders: Natural Earth');
    } else {
        layers = [
            L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${esri}_Base/MapServer/tile/{z}/{y}/{x}`,
                { maxZoom: 16, attribution: 'Tiles &copy; Esri' }),
            L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${esri}_Reference/MapServer/tile/{z}/{y}/{x}`,
                { maxZoom: 16 }),
        ];
        map.getContainer().classList.remove('rmap-offline');
        map.attributionControl.removeAttribution('Borders: Natural Earth');
    }
    layers.forEach(l => { l.addTo(map); if (l.bringToBack) l.bringToBack(); });
    Rmap.base = { mode, theme, layers };
}

function rmapMainGroup(n) {
    // A node in two columns (a NomadNet node named BBS) takes the colour of
    // the more specific one on the map.
    return n.groups.includes('bbs') ? 'bbs' : n.groups[0];
}

function rmapVisible(n) {
    return n.groups.some(g => !Rmap.hidden[g]);
}

function renderRmapMarkers() {
    if (!Rmap.cluster || !Rmap.data) return;
    Rmap.cluster.clearLayers();
    Rmap.markers = {};
    const layers = [];
    for (const n of Rmap.data.nodes || []) {
        if (n.lat == null || n.lon == null || !rmapVisible(n)) continue;
        const g = rmapMainGroup(n);
        const color = RMAP_TYPE_COLORS[n.type];
        const marker = L.marker([n.lat, n.lon], {
            icon: L.divIcon({ className: `rmap-dot rmap-dot-${g}`, iconSize: [12, 12],
                              html: color ? `<span class="rmap-dot-fill" style="background:${color}"></span>` : '' }),
            title: n.name || n.hash,
        });
        marker.bindPopup(() => rmapPopupHtml(n), { className: 'rmap-popup' });
        Rmap.markers[n.hash] = marker;
        layers.push(marker);
    }
    Rmap.cluster.addLayers(layers);
}

function rmapFlyTo(hash) {
    const marker = Rmap.markers[hash];
    if (!marker || !Rmap.map) return;
    Rmap.cluster.zoomToShowLayer(marker, () => marker.openPopup());
}

// ─── Data ───────────────────────────────────────────────────

async function pollRmap() {
    try {
        Rmap.status = await fetch('/api/rmap').then(r => r.json());
    } catch (e) {
        return;
    }
    applyRmapVisibility();
    if (!Rmap.open) return;
    applyRmapBase();            // the map setting may have changed
    renderRmapState();
    loadRmapNodes(false);
}

function startRmapPolling() {
    pollRmap();
    clearInterval(Rmap.pollTimer);
    Rmap.pollTimer = setInterval(pollRmap, 5000);
}

async function loadRmapNodes(force) {
    const st = Rmap.status;
    if (!st) return;
    const key = `${st.fetched_at}|${st.settings.max_age_hours}`;
    if (!force && key === Rmap.dataKey) return;
    try {
        Rmap.data = await fetch('/api/rmap/nodes').then(r => r.json());
    } catch (e) {
        return;
    }
    Rmap.dataKey = key;
    renderRmapState();
    renderRmapLists();
    renderRmapMarkers();
}

async function rmapRefresh() {
    const res = await fetch('/api/rmap/refresh', { method: 'POST' }).then(r => r.json()).catch(e => ({ status: 'error', error: e.message }));
    if (res.status === 'error') { showNotification(escapeHtml(res.error), 'error', 5000); return; }
    Rmap.status = res;
    renderRmapState();
}

function rmapAgo(ts, now) {
    if (!ts) return '';
    const s = Math.max(0, (now || Date.now() / 1000) - ts);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
}

function renderRmapState() {
    const el = document.getElementById('rmap-state');
    const st = Rmap.status;
    if (!el || !st) return;
    const count = Rmap.data && Rmap.data.nodes ? Rmap.data.nodes.length : 0;
    const parts = [];
    if (st.fetching) parts.push('fetching…');
    else if (st.fetched_at) parts.push(`${count} nodes · updated ${rmapAgo(st.fetched_at)}`);
    else parts.push('not fetched yet');
    parts.push(`heard within ${st.settings.max_age_hours} h`);
    el.innerHTML = escapeHtml(parts.join(' · '))
        + (st.error ? ` <span class="rmap-error" title="${escapeHtml(st.error)}">· last fetch failed</span>` : '');
    // Refresh by hand: once every 10 minutes at most (the server says how
    // long is left), never while a fetch runs. rmap.world is everyone's.
    const btn = document.getElementById('rmap-refresh');
    if (btn) {
        const wait = st.manual_wait || 0;
        btn.disabled = !!st.fetching || wait > 0;
        btn.title = st.fetching ? 'Fetching now…'
            : wait > 0 ? `Fetched a moment ago: again in ${Math.max(1, Math.round(wait / 60))} min (rmap.world is shared by everyone)`
            : 'Fetch the list again from rmap.world';
    }
    const theme = document.getElementById('rmap-theme');
    if (theme) theme.textContent = rmapTheme() === 'light' ? '☾' : '☀';
}

function renderRmapChips() {
    const box = document.getElementById('rmap-chips');
    if (!box) return;
    box.innerHTML = RMAP_GROUPS.map(g => `<button class="rmap-chip${Rmap.hidden[g.key] ? ' off' : ''}" data-rmap-chip="${g.key}"
        title="${Rmap.hidden[g.key] ? 'Show' : 'Hide'} ${escapeHtml(g.label)}"><span class="rmap-dot rmap-dot-${g.key}"></span>${escapeHtml(g.label)}</button>`).join('');
}

// ─── Lists ──────────────────────────────────────────────────

function rmapHostPort(n) {
    if (!n.host) return '';
    const host = n.host.includes(':') && !n.host.startsWith('[') ? `[${n.host}]` : n.host;
    return n.port ? `${host}:${n.port}` : host;
}

function rmapMeta(n, group, now) {
    const bits = [];
    if (group === 'backbone') {
        bits.push(n.type === 'TCP_Client' ? 'TCP client' : n.type);
        if (n.host) bits.push(rmapHostPort(n));
        else bits.push('not connectable');
    }
    if (group === 'propnode' && n.stamp_cost != null) bits.push(`stamp ${n.stamp_cost}`);
    if (group === 'bbs') bits.push(n.type === 'RetiBBS' ? 'RetiBBS' : 'NomadNet page');
    if (group === 'rnode') {
        bits.push(n.frequency, n.bandwidth);
        if (n.sf != null) bits.push(`SF${n.sf}`);
        if (n.cr != null) bits.push(`CR4/${n.cr}`);
    }
    bits.push(`heard ${rmapAgo(n.seen, now)}`);
    if (n.hops != null) bits.push(`${n.hops} hop${n.hops === 1 ? '' : 's'} from rmap`);
    return bits.filter(Boolean).map(escapeHtml).join(' · ');
}

function rmapRow(n, group, now) {
    const pin = n.lat != null && n.lon != null
        ? `<button class="rmap-pin" data-rmap-pin="${escapeHtml(n.hash)}" title="Show on the map" aria-label="Show on the map">⌖</button>` : '';
    return `<div class="rmap-row" data-rmap-row="${escapeHtml(n.hash)}" data-group="${group}"
                 title="${escapeHtml(RMAP_GROUPS.find(g => g.key === group).hint)} - right-click: copy the address">
            <div class="rmap-row-text">
                <div class="rmap-row-name">${escapeHtml(n.name || (group === 'propnode' ? 'Propagation node' : 'Unnamed'))}</div>
                <code>${escapeHtml(n.hash)}</code>
                <div class="rmap-row-meta">${rmapMeta(n, group, now)}</div>
            </div>${pin}
        </div>`;
}

function renderRmapLists() {
    const box = document.getElementById('rmap-cols');
    if (!box || !Rmap.data) return;
    const words = Rmap.filter.toLowerCase().split(/\s+/).filter(Boolean);
    const match = n => !words.length || words.every(w =>
        `${n.name} ${n.hash} ${n.host || ''} ${n.type}`.toLowerCase().includes(w));
    const now = Rmap.data.now;
    let shown = RMAP_GROUPS.filter(g => !Rmap.hidden[g.key]);
    const count = g => (Rmap.data.nodes || []).filter(n => n.groups.includes(g.key) && match(n)).length;
    // Phones: one list, the one picked (with how many each has).
    const pick = document.getElementById('rmap-pick');
    if (pick) {
        if (shown.length && !shown.some(g => g.key === Rmap.pick)) Rmap.pick = shown[0].key;
        const opts = shown.map(g => `<option value="${g.key}"${g.key === Rmap.pick ? ' selected' : ''}>${escapeHtml(g.label)} (${count(g)})</option>`).join('');
        if (pick.dataset.html !== opts) { pick.dataset.html = opts; pick.innerHTML = opts; }
    }
    if (window.matchMedia('(max-width: 700px)').matches) shown = shown.filter(g => g.key === Rmap.pick);
    const html = shown.map(g => {
        const list = (Rmap.data.nodes || []).filter(n => n.groups.includes(g.key) && match(n));
        const rows = list.slice(0, RMAP_LIST_MAX).map(n => rmapRow(n, g.key, now)).join('');
        const more = list.length > RMAP_LIST_MAX
            ? `<div class="msg-search-none">${list.length - RMAP_LIST_MAX} more: search to narrow</div>` : '';
        return `<div class="rmap-col">
            <div class="rmap-col-head" title="${escapeHtml(g.hint)}"><span><span class="rmap-dot rmap-dot-${g.key}"></span>${escapeHtml(g.label)}</span><span>${list.length}</span></div>
            <div class="rmap-col-body">${rows || '<div class="msg-search-none">None</div>'}${more}</div>
        </div>`;
    }).join('');
    box.style.setProperty('--rmap-cols', String(Math.max(1, shown.length)));
    if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

function rmapPopupHtml(n) {
    const g = rmapMainGroup(n);
    const label = { nomadnet: 'Open page', propnode: 'Use as propagation node', rrc: 'Connect (RRC chat)', bbs: n.type === 'RetiBBS' ? 'Connect (BBS client)' : 'Open page',
                    backbone: 'Details and config', rnode: 'Details and config' }[g];
    return `<div class="rmap-pop">
        <div class="rmap-pop-name">${escapeHtml(n.name || n.hash)}</div>
        <div class="rmap-row-meta">${rmapMeta(n, g, Rmap.data && Rmap.data.now)}</div>
        <code>${escapeHtml(n.hash)}</code>
        <div class="rmap-pop-acts">
            <button class="msg-bar-btn primary" data-rmap-act="primary" data-hash="${escapeHtml(n.hash)}" data-group="${g}">${escapeHtml(label)}</button>
            ${g === 'backbone' && n.host ? `<button class="msg-bar-btn" data-rmap-act="hostport" data-hash="${escapeHtml(n.hash)}" data-group="${g}">Copy host</button>` : ''}
            <button class="msg-bar-btn" data-rmap-act="copy" data-hash="${escapeHtml(n.hash)}" data-group="${g}">Copy address</button>
        </div>
    </div>`;
}

// ─── Actions ────────────────────────────────────────────────

function rmapNode(hash) {
    return (Rmap.data && Rmap.data.nodes || []).find(n => n.hash === hash);
}

// A Reticulum interface section for a backbone or TCP server, ready to paste
// into the config. TCPClientInterface also talks to BackboneInterface
// servers; I2P gets an I2PInterface; Tor needs a proxy, so only the address.
function rmapInterfaceConfig(n) {
    const name = `RMAP ${(n.name || n.hash.slice(0, 8)).replace(/[^\w .-]/g, '').trim() || n.hash.slice(0, 8)}`;
    const ifac = [];
    if (n.ifac_netname) ifac.push(`    network_name = ${n.ifac_netname}`);
    if (n.ifac_netkey) ifac.push(`    passphrase = ${n.ifac_netkey}`);
    if (n.type === 'I2P') {
        const peer = n.host.includes('.') ? n.host : `${n.host}.b32.i2p`;
        return [`[[${name}]]`, '    type = I2PInterface', '    enabled = yes', `    peers = ${peer}`, ...ifac].join('\n');
    }
    if (!n.port) return null;
    return [`[[${name}]]`, '    type = TCPClientInterface', '    enabled = yes',
            `    target_host = ${n.host}`, `    target_port = ${n.port}`, ...ifac].join('\n');
}

// An RNodeInterface with the radio settings this node announces, for a
// local LoRa link: the port and the power are yours to set.
function rmapRnodeConfig(n) {
    const hz = (text, unit) => {
        const m = String(text || '').match(/([\d.]+)\s*(MHz|kHz|Hz)?/i);
        if (!m) return null;
        const value = parseFloat(m[1]);
        // No unit and already a big number: it is in Hz (an older record).
        const scale = !m[2] && value >= 1e4 ? 1 : { mhz: 1e6, khz: 1e3, hz: 1 }[(m[2] || unit).toLowerCase()];
        return Math.round(value * scale);
    };
    const freq = hz(n.frequency, 'MHz'), bw = hz(n.bandwidth, 'kHz');
    if (!freq || !bw) return null;
    // Your own interface on the same radio settings, as rmap.world gives it:
    // nothing of that node (name, identity), only what the link needs.
    return ['[[RNode LoRa Interface]]', '    type = RNodeInterface', '    enabled = yes',
            '    # Your serial port (Windows: COMx, Linux: /dev/ttyUSBx)',
            '    port = ',
            `    frequency = ${freq}`, `    bandwidth = ${bw}`,
            ...(n.sf != null ? [`    spreadingfactor = ${n.sf}`] : []),
            ...(n.cr != null ? [`    codingrate = ${n.cr}`] : []),
            '    # TX power is not announced: set your own (dBm, what your radio and country allow)',
            '    txpower = ',
            ...(n.ifac_netname ? [`    network_name = ${n.ifac_netname}`] : []),
            ...(n.ifac_netkey ? [`    passphrase = ${n.ifac_netkey}`] : []),
            '    # Radio parameters as published on RMAP: they have to match the node you want to reach.'].join('\n');
}

function rmapAct(act, hash, group) {
    const n = rmapNode(hash);
    if (!n) return;
    if (act === 'copy') { copyText(n.hash, 'Address copied'); return; }
    if (act === 'hostport') { copyText(rmapHostPort(n), 'Host copied'); return; }
    if (group === 'nomadnet' || (group === 'bbs' && n.type !== 'RetiBBS')) {
        closeRmap();
        openQuickAddress(`${n.hash}:/page/index.mu`, n.name, true);
    } else if (group === 'propnode') {
        // Asked first: it changes Settings > LXMF Messenger > Propagation node.
        const ask = typeof confirmDialog === 'function'
            ? confirmDialog('Propagation node',
                `Use <b>${escapeHtml(n.name || 'this node')}</b> <code>${escapeHtml(n.hash)}</code> as your default propagation node? (Settings > LXMF Messenger)`,
                'Use it')
            : Promise.resolve(true);
        ask.then(ok => { if (ok) usePropagationNode(n.hash); });
    } else if (group === 'rrc') {
        if (typeof rrcEnabled !== 'function' || !rrcEnabled()) {
            showNotification('The RRC client is off: Settings > RRC Client', 'info', 5000);
            return;
        }
        closeRmap();
        openRrcAddress(n.hash);
    } else if (group === 'bbs') {
        if (typeof retibbsEnabled !== 'function' || !retibbsEnabled()) {
            showNotification('The BBS client is off: Settings > BBS Client', 'info', 5000);
            return;
        }
        openRetibbs();
        retibbsConnect(n.hash);
    } else if (group === 'backbone' || group === 'rnode') {
        rmapConfigDialog(n, group);
    }
}

// Backbone / RNode: what is known of it and the config to paste into the
// Reticulum config, editable (port, power) before Copy config. Nothing is
// copied until a button says so.
function rmapConfigDialog(n, group) {
    const rnode = group === 'rnode';
    const config = rnode ? rmapRnodeConfig(n) : (n.host && n.type !== 'Tor' ? rmapInterfaceConfig(n) : null);
    const why = rnode ? 'No radio settings announced: no config to make.'
        : !n.host ? 'No host announced: not connectable from here.'
        : n.type === 'Tor' ? 'Tor: it needs a Tor proxy, only the address is given.'
        : 'No port announced: only the host.';
    const host = !rnode && n.host ? rmapHostPort(n) : '';
    const row = (k, v) => v ? `<div class="rmap-cfg-row"><span>${k}</span><span>${v}</span></div>` : '';
    const radio = rnode ? [n.frequency && `freq ${escapeHtml(String(n.frequency))}`, n.bandwidth && `bw ${escapeHtml(String(n.bandwidth))}`,
        n.sf != null && `SF ${escapeHtml(String(n.sf))}`, n.cr != null && `CR ${escapeHtml(String(n.cr))}`].filter(Boolean).join(' · ') : '';
    const overlay = document.createElement('div');
    overlay.className = 'auto-reload-modal';
    overlay.innerHTML = `<div class="auto-reload-dialog rmap-cfg-dialog">
        <div class="dialog-header"><h3>${rnode ? 'RNode' : 'Backbone'}: ${escapeHtml(n.name || n.hash.slice(0, 12))}</h3>
            <button class="modal-close" data-x title="Close" aria-label="Close">&times;</button></div>
        <div class="rmap-cfg-info">
            ${row('Type', escapeHtml(n.type || (rnode ? 'RNode LoRa' : '')))}
            ${row('Host', host ? `<code>${escapeHtml(host)}</code>` : '')}
            ${row('Radio', radio)}
            ${row('Seen', rmapMeta(n, group, Rmap.data && Rmap.data.now))}
            ${row('Address', `<code>${escapeHtml(n.hash)}</code>`)}
        </div>
        ${config ? `<div class="settings-hint">${rnode ? 'Fill in your port and power, then' : ''} paste it into the Reticulum config (interfaces section), then restart Reticulum.</div>
            <textarea class="settings-input settings-textarea rmap-cfg-text" spellcheck="false" rows="${config.split('\n').length + 1}">${escapeHtml(config)}</textarea>`
                 : `<div class="settings-hint">${why}</div>`}
        <div class="auto-reload-actions">
            <button class="btn-cancel" data-a="addr">Copy address</button>
            ${host ? '<button class="btn-cancel" data-a="host">Copy host</button>' : ''}
            ${config ? '<button class="btn-save" data-a="cfg">Copy config</button>' : ''}
        </div></div>`;
    const close = () => { overlay.remove(); document.removeEventListener('keydown', esc); };
    const esc = e => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', e => {
        if (e.target === overlay || e.target.closest('[data-x]')) { close(); return; }
        const a = e.target.closest('[data-a]');
        if (!a) return;
        if (a.dataset.a === 'addr') copyText(n.hash, 'Address copied');
        else if (a.dataset.a === 'host') copyText(host, 'Host copied');
        else copyText(overlay.querySelector('.rmap-cfg-text').value, 'Config copied: paste it into the Reticulum config');
    });
    document.addEventListener('keydown', esc);
    document.body.appendChild(overlay);
}

// ─── Settings > RMAP ────────────────────────────────────────

async function loadRmapSettings() {
    let st;
    try { st = await fetch('/api/rmap').then(r => r.json()); } catch (e) { return; }
    Rmap.status = st;
    const toggle = document.getElementById('setting-rmap-enabled');
    if (toggle) {
        toggle.classList.toggle('active', !!st.settings.enabled);
        toggle.dataset.loaded = '1';
    }
    const refresh = document.getElementById('setting-rmap-refresh');
    if (refresh) {
        refresh.innerHTML = st.refresh_choices.map(m => `<option value="${m}">${m < 60 ? `${m} min` : `${m / 60} h`}</option>`).join('');
        refresh.value = String(st.settings.refresh_minutes);
    }
    const age = document.getElementById('setting-rmap-age');
    if (age) {
        age.innerHTML = st.age_choices.map(h => `<option value="${h}">${h < 24 ? `${h} h` : `${h / 24} day${h === 24 ? '' : 's'}`}</option>`).join('');
        age.value = String(st.settings.max_age_hours);
    }
    const mapMode = document.getElementById('setting-rmap-map');
    if (mapMode) mapMode.value = st.settings.map || 'offline-light';
}

function saveRmapSettings() {
    const toggle = document.getElementById('setting-rmap-enabled');
    // Not read from the server: nothing sent (as for the messenger).
    if (!toggle || !toggle.dataset.loaded) return Promise.resolve();
    const refresh = document.getElementById('setting-rmap-refresh');
    const age = document.getElementById('setting-rmap-age');
    return fetch('/api/rmap/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            enabled: toggle.classList.contains('active'),
            ...(refresh && refresh.value ? { refresh_minutes: Number(refresh.value) } : {}),
            ...(age && age.value ? { max_age_hours: Number(age.value) } : {}),
            ...(document.getElementById('setting-rmap-map') ? { map: document.getElementById('setting-rmap-map').value } : {}),
        }),
    }).then(r => r.json()).then(res => {
        if (res.status === 'error') showNotification(`RMAP: ${escapeHtml(res.error)}`, 'error', 5000);
        pollRmap();
    }).catch(e => showNotification(`RMAP setting not saved: ${escapeHtml(e.message)}`, 'error', 5000));
}

startRmapPolling();
