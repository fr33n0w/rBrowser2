// Radio: listens to radio-lxst stations (and LXST phones that answer by
// themselves). Owner: on in Settings > System Setup > Radio. Guest: when the
// owner opens it to guests, with the guest identity and a call of its own.
// Server side rbrowser/radio.py: the call is made there, the Opus packets
// come here as an Ogg stream (/api/radio/stream) for a plain <audio>, so the
// sound plays on this device (phone, tunnel), not on the rBrowser computer.
// Keeps playing on the other tabs.

const RADIO_KEY = 'rbrowser_radio';
const RADIO_VOL_KEY = 'rbrowser_radio_volume';
const RADIO_EVERY = 1500;
const RADIO_EVERY_BG = 5000;
const RADIO_QUALITIES = [['SHQ', 'Super high'], ['HQ', 'High'], ['MQ', 'Medium'],
                         ['LBW', 'Low bandwidth'], ['VLBW', 'Very low'], ['ULBW', 'Ultra low']];
const RADIO_COMMANDS = ['help', 'info', 'status', 'link', 'subscribe', 'unsubscribe'];
const RADIO_BADGES = { playing: 'ON AIR', buffering: 'BUFFER', searching: 'SEARCH', connecting: 'CALL',
                       ringing: 'CALL', retrying: 'RETRY', failed: 'FAILED', ended: 'ENDED', idle: 'STOP' };

const Radio = {
    open: false,
    timer: null,
    busy: false,
    data: null,
    audio: null,
    waiting: false,
    ctx: null,
    analyser: null,
    vuRaf: 0,
    retry: 0,
    pane: 'stations',
    cmdSig: '',
};

const RADIO_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="5.5" width="13" height="8.5" rx="1.2"/><path d="M4 5.5L11 2"/><circle cx="10.5" cy="9.7" r="2"/><path d="M4 8.5h2.5M4 11h2.5"/></svg>';

function radioOn() {
    if (window.rbGuest) return !!window.rbGuest.radio;
    if (typeof APP_WINDOW !== 'undefined' && APP_WINDOW) return false;
    try { return localStorage.getItem(RADIO_KEY) === 'on'; } catch (e) { return false; }
}

function radioVolume() {
    let v = 0.8;
    try { const s = localStorage.getItem(RADIO_VOL_KEY); if (s !== null) v = Number(s); } catch (e) {}
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
}

const radioE = s => escapeHtml(s === undefined || s === null ? '' : String(s));

function radioHms(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const p = n => String(n).padStart(2, '0');
    return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec % 3600 / 60))}:${p(sec % 60)}`;
}

function radioAgo(ts) {
    if (!ts) return 'never heard';
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 172800) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
}

// ─── The tab and the view ───────────────────────────────────

function ensureRadioTab() {
    let tab = document.getElementById('radio-tab');
    if (!tab) {
        tab = document.createElement('div');
        tab.className = 'tab tab-messages tab-radio';
        tab.id = 'radio-tab';
        tab.title = 'Radio (radio-lxst)';
        tab.innerHTML = `${RADIO_ICON}<span class="tab-app-label">RADIO</span>`;
        tab.addEventListener('click', () => openRadio());
        addAppTabOff(tab, 'Radio', async () => {
            radioStop();
            if (window.rbGuest) { closeRadio(); return; }   // a guest has no Settings to switch it back on
            try { localStorage.setItem(RADIO_KEY, 'off'); } catch (e) {}
            applyRadioVisibility();
        }, { close: () => closeRadio() });
        placeAppTab(tab);
    }
    let view = document.getElementById('radio-view');
    if (!view) {
        view = document.createElement('div');
        view.className = 'tab-content radio-view';
        view.id = 'radio-view';
        view.innerHTML = `
            <div class="radio-screen">
                <div class="radio-top">
                    <span class="radio-title">📻 Radio</span>
                    <span class="radio-sub">radio-lxst stations over Reticulum</span>
                    <span class="msg-identity-label">Identity in use:</span>
                    <div class="msg-identity-wrap radio-id-wrap" id="radio-id-wrap">
                        <button class="msg-identity" id="radio-id" title="The identity the stations see - click to change"></button>
                        <div class="msg-identity-menu" id="radio-id-menu" hidden></div>
                    </div>
                    <button class="radio-x" onclick="closeRadio()" title="Close the Radio (it keeps playing)" aria-label="Close">&times;</button>
                </div>
                <div class="radio-lcd" id="radio-lcd">
                    <div class="radio-lcd-row">
                        <span class="radio-name" id="radio-name">NO STATION</span>
                        <span class="radio-badge" id="radio-badge">STOP</span>
                    </div>
                    <div class="radio-track" id="radio-track"></div>
                    <div class="radio-prog" id="radio-prog">
                        <span id="radio-prog-l">-:--</span><span class="radio-prog-bar"><i id="radio-prog-fill"></i></span><span id="radio-prog-r">-:--</span>
                    </div>
                    <div class="radio-live" id="radio-live" hidden><span id="radio-live-text"></span></div>
                    <div class="radio-lcd-grid">
                        <span>TIME <b id="radio-time">00:00:00</b></span>
                        <span>RATE <b id="radio-rate">-</b></span>
                        <span>HOPS <b id="radio-hops">-</b></span>
                        <span>LISTEN <b id="radio-listen">-</b></span>
                    </div>
                    <div class="radio-cid" id="radio-cid" title="Click to copy the Call ID"></div>
                    <div class="radio-vu"><span>L</span><div class="radio-vu-bar"><i id="radio-vu-l"></i></div></div>
                    <div class="radio-vu"><span>R</span><div class="radio-vu-bar"><i id="radio-vu-r"></i></div></div>
                    <div class="radio-msg" id="radio-msg"></div>
                </div>
                <div class="radio-controls">
                    <button class="radio-btn radio-play" id="radio-play" onclick="radioPlayToggle()">▶ Play</button>
                    <button class="radio-btn" onclick="radioNext(false)" title="Next station on air in the list">⏭ Next</button>
                    <button class="radio-btn" onclick="radioNext(true)" title="A station on air at random">🔀 Random</button>
                    <label class="radio-vol" for="radio-volume">Vol <input type="range" id="radio-volume" min="0" max="100" step="1" oninput="radioSetVolume(this.value)"></label>
                    <span class="radio-q-wrap"><span class="radio-q-label">Quality</span>
                        <select id="radio-quality" class="settings-select" onchange="radioSetQuality(this.value)" title="Asked to the station, also while listening">
                            ${RADIO_QUALITIES.map(([k, l]) => `<option value="${k}">${k} - ${escapeHtml(l)}</option>`).join('')}
                        </select></span>
                </div>
                <div class="radio-add">
                    <input type="text" id="radio-callid" class="radio-input" maxlength="32" spellcheck="false" autocomplete="off"
                           placeholder="Call ID of a station (32 hex)" onkeydown="if (event.key === 'Enter') radioTuneTyped()">
                    <button class="radio-btn" onclick="radioTuneTyped()">Listen</button>
                </div>
                <div class="radio-subtabs" role="tablist">
                    <button class="radio-subtab active" data-pane="stations" onclick="radioPane('stations')">Stations</button>
                    <button class="radio-subtab" data-pane="commands" onclick="radioPane('commands')">Commands</button>
                </div>
                <div class="radio-pane" id="radio-pane-stations">
                    <div class="radio-list-head"><span>Stations</span><span class="radio-hint">★ first, state asked to each station <button class="radio-mini" title="Ask the stations for their state now" onclick="radioRefresh()">⟳</button></span></div>
                    <div class="radio-list" id="radio-list"><div class="radio-empty">Listening for stations…</div></div>
                </div>
                <div class="radio-pane" id="radio-pane-commands" hidden>
                    <div class="radio-cmd-head">
                        <span class="radio-q-label">Station</span>
                        <select id="radio-cmd-station" class="settings-select" onchange="radioCmdLoad(true)"></select>
                        <span class="radio-cmd-sub" id="radio-cmd-sub"></span>
                    </div>
                    <div class="radio-cmd-btns">
                        ${RADIO_COMMANDS.map(c => `<button class="radio-btn" onclick="radioCommand('${c}')">${c[0].toUpperCase() + c.slice(1)}</button>`).join('')}
                    </div>
                    <div class="radio-cmd-log" id="radio-cmd-log"></div>
                    <div class="radio-foot" id="radio-cmd-foot"></div>
                </div>
                <audio id="radio-audio" preload="none"></audio>
            </div>`;
        document.getElementById('tab-content-wrapper').appendChild(view);
        new MutationObserver(() => {
            if (Radio.open && !view.classList.contains('active')) radioHidden();
        }).observe(view, { attributes: true, attributeFilter: ['class'] });
        const vol = view.querySelector('#radio-volume');
        vol.value = Math.round(radioVolume() * 100);
        view.querySelector('#radio-cid').addEventListener('click', () => {
            const cid = Radio.data && Radio.data.call_id;
            if (cid) copyText(cid, 'Call ID copied');
        });
        radioAudioSetup(view.querySelector('#radio-audio'));
    }
}

function openRadio() {
    if (!radioOn()) return;
    ensureRadioTab();
    if (typeof Messenger !== 'undefined') Messenger.open = false;
    if (typeof RetiBBS !== 'undefined') RetiBBS.open = false;
    if (typeof Rrc !== 'undefined') Rrc.open = false;
    if (typeof Rmap !== 'undefined') Rmap.open = false;
    document.body.classList.remove('messenger-open', 'retibbs-open', 'rrc-open', 'rmap-open', 'monitor-open');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('radio-tab').classList.add('active');
    document.getElementById('radio-view').classList.add('active');
    document.body.classList.add('radio-open');
    Radio.open = true;
    pollRadio();
}

function radioHidden() {
    Radio.open = false;
    document.body.classList.remove('radio-open');
    const tab = document.getElementById('radio-tab');
    if (tab) tab.classList.remove('active');
}

function closeRadio() {
    const view = document.getElementById('radio-view');
    if (view) view.classList.remove('active');
    radioHidden();
    if (typeof activeTabId !== 'undefined' && activeTabId) switchToTab(activeTabId);
}

function applyRadioVisibility() {
    const on = radioOn();
    if (on) ensureRadioTab();
    const tab = document.getElementById('radio-tab');
    if (tab) tab.hidden = !on;
    layoutAppTabs();
    if (!on) {
        if (Radio.audio && !Radio.audio.paused) radioStop();
        if (Radio.open) closeRadio();
    } else {
        pollRadio();
    }
}

// ─── Audio ──────────────────────────────────────────────────

function radioAudioSetup(audio) {
    Radio.audio = audio;
    audio.volume = radioVolume();
    audio.addEventListener('waiting', () => { Radio.waiting = true; drawRadio(); });
    audio.addEventListener('playing', () => { Radio.waiting = false; Radio.retry = 0; drawRadio(); });
    // The stream ends with the call, or breaks on the way: open it again while the call is on.
    const again = () => {
        if (!audio.dataset.want) return;
        setTimeout(() => {
            if (!audio.dataset.want) return;
            const d = Radio.data;
            if (d && d.state === 'retrying') return again();  // server redials: wait, don't spend attaches
            if (d && ['playing', 'searching', 'connecting', 'ringing'].includes(d.state) && Radio.retry++ < 5) radioAttach();
        }, 1500);
    };
    audio.addEventListener('ended', again);
    audio.addEventListener('error', again);
}

function radioAttach() {
    const a = Radio.audio;
    if (!a) return;
    a.dataset.token = String(Date.now());
    a.src = `/api/radio/stream?t=${a.dataset.token}`;
    a.dataset.want = '1';
    Radio.waiting = true;
    a.play().catch(() => {});
    radioVuStart();
}

function radioDetach() {
    const a = Radio.audio;
    if (!a) return;
    delete a.dataset.want;
    a.pause();
    a.removeAttribute('src');
    a.load();
    Radio.waiting = false;
    radioVuStop();
}

// VU meter: Web Audio on the same element (needs the Play click to start).
function radioVuStart() {
    try {
        if (!Radio.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            Radio.ctx = new AC();
            const src = Radio.ctx.createMediaElementSource(Radio.audio);
            const split = Radio.ctx.createChannelSplitter(2);
            Radio.analyser = [Radio.ctx.createAnalyser(), Radio.ctx.createAnalyser()];
            src.connect(Radio.ctx.destination);
            src.connect(split);
            Radio.analyser.forEach((an, i) => { an.fftSize = 512; split.connect(an, i); });
        }
        if (Radio.ctx.state === 'suspended') Radio.ctx.resume();
    } catch (e) { return; }
    cancelAnimationFrame(Radio.vuRaf);
    const buf = new Float32Array(512);
    const peaks = [0, 0];
    const step = () => {
        Radio.vuRaf = requestAnimationFrame(step);
        if (!Radio.open || document.hidden) return;
        Radio.analyser.forEach((an, i) => {
            an.getFloatTimeDomainData(buf);
            let p = 0;
            for (let k = 0; k < buf.length; k++) p = Math.max(p, Math.abs(buf[k]));
            peaks[i] = Math.max(p, peaks[i] * 0.9);
            const el = document.getElementById(i ? 'radio-vu-r' : 'radio-vu-l');
            if (el) el.style.width = `${Math.min(100, peaks[i] * 100).toFixed(1)}%`;
        });
    };
    step();
}

function radioVuStop() {
    cancelAnimationFrame(Radio.vuRaf);
    for (const id of ['radio-vu-l', 'radio-vu-r']) { const el = document.getElementById(id); if (el) el.style.width = '0'; }
}

// ─── Actions ────────────────────────────────────────────────

async function radioPost(url, body, method = 'POST') {
    try {
        const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        const d = await r.json();
        if (d.status !== 'success') showNotification(radioE(d.error || 'Radio: no answer'), 'error', 4000);
        return d;
    } catch (e) {
        showNotification(`Radio: ${radioE(e.message)}`, 'error', 4000);
        return null;
    }
}

async function radioTune(callId) {
    callId = String(callId || '').trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(callId)) { showNotification('A Call ID is 32 hex characters', 'warning', 3000); return; }
    // Web Audio must start inside the click: browsers block it later.
    radioVuStart();
    Radio.retry = 0;
    const q = document.getElementById('radio-quality');
    const d = await radioPost('/api/radio/tune', { call_id: callId, quality: q ? q.value : undefined });
    if (d && d.status === 'success') {
        radioAttach();
        pollRadio();
    }
}

// Next / Random: only stations on air, in the list order (favourites first), never the one playing.
function radioNext(random) {
    const d = Radio.data || {};
    const cur = d.call_id || d.last || '';
    const on = (d.stations || []).filter(s => s.on_air);
    const others = on.filter(s => s.call_id !== cur);
    if (!others.length) { showNotification('No other station on air', 'warning', 3000); return; }
    let pick;
    if (random) pick = others[Math.floor(Math.random() * others.length)];
    else {
        const i = on.findIndex(s => s.call_id === cur);
        pick = i < 0 ? on[0] : on[(i + 1) % on.length];
    }
    radioTune(pick.call_id);
}

function radioTuneTyped() {
    const el = document.getElementById('radio-callid');
    if (!el) return;
    radioTune(el.value);
    el.value = '';
}

async function radioStop() {
    radioDetach();
    await radioPost('/api/radio/stop');
    pollRadio();
}

function radioPlayToggle() {
    const d = Radio.data || {};
    if (['playing', 'searching', 'connecting', 'ringing', 'retrying'].includes(d.state)) radioStop();
    else if (d.call_id || d.last) radioTune(d.call_id || d.last);
    else showNotification('Pick a station from the list or type its Call ID', 'info', 3000);
}

function radioSetVolume(v) {
    const vol = Math.min(1, Math.max(0, Number(v) / 100));
    if (Radio.audio) Radio.audio.volume = vol;
    try { localStorage.setItem(RADIO_VOL_KEY, String(vol)); } catch (e) {}
}

// While listening the server asks the station for the new codec on the same call.
function radioSetQuality(q) {
    radioPost('/api/radio/quality', { quality: q });
}

async function radioRefresh() {
    await radioPost('/api/radio/refresh');
    showNotification('Asking the stations…', 'info', 2000);
    setTimeout(pollRadio, 4000);
}

async function radioFavorite(callId, on) {
    await radioPost(`/api/radio/station/${callId}`, { favorite: on });
    pollRadio();
}

async function radioForget(callId) {
    await radioPost(`/api/radio/station/${callId}`, {}, 'DELETE');
    pollRadio();
}

// ─── Reading and drawing ────────────────────────────────────

async function pollRadio() {
    clearTimeout(Radio.timer);
    if (!radioOn()) return;
    if (!Radio.busy && !document.hidden) {
        Radio.busy = true;
        try {
            const tok = Radio.audio && Radio.audio.dataset.want ? Radio.audio.dataset.token || '' : '';
            const d = await fetch(`/api/radio?t=${encodeURIComponent(tok)}`).then(r => r.json());
            if (d && d.status === 'success') {
                Radio.data = d;
                Radio.dataAt = performance.now();
                Radio.dataTok = tok;
                // The call ended on the server: stop the element too.
                if (Radio.audio && Radio.audio.dataset.want && ['idle', 'failed', 'ended'].includes(d.state)) radioDetach();
                drawRadio();
            }
        } catch (e) {}
        finally { Radio.busy = false; }
    }
    const live = Radio.data && !['idle', 'failed', 'ended'].includes(Radio.data.state);
    if (Radio.open || live) Radio.timer = setTimeout(pollRadio, Radio.open ? RADIO_EVERY : RADIO_EVERY_BG);
}

function radioState(d) {
    if (d.state === 'playing' && (Radio.waiting || !Radio.audio || !Radio.audio.dataset.want)) return 'buffering';
    return d.state;
}

function radioText(id, text) {
    const el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
}

function drawRadio() {
    const d = Radio.data;
    if (!d) return;
    const st = radioState(d);
    const live = ['playing', 'buffering', 'searching', 'connecting', 'ringing', 'retrying'].includes(st);
    const tab = document.getElementById('radio-tab');
    if (tab && typeof setAppTabState === 'function') {
        setAppTabState(tab, st === 'playing' ? 'connected' : live ? 'connecting' : st === 'failed' ? 'failed' : '',
            st === 'playing' ? `Playing ${d.name || d.call_id}` : live ? 'Tuning in' : st === 'failed' ? d.message : 'Stopped');
    }
    if (!document.getElementById('radio-view')) return;
    const lcd = document.getElementById('radio-lcd');
    lcd.classList.toggle('on', live);
    const known = (d.stations || []).find(s => s.call_id === (d.call_id || d.last));
    radioText('radio-name', (d.name || (known && known.name) || (d.call_id || d.last ? 'UNNAMED STATION' : 'NO STATION')).toUpperCase());
    const badge = document.getElementById('radio-badge');
    radioText('radio-badge', RADIO_BADGES[st] || st.toUpperCase());
    badge.className = `radio-badge st-${st}`;
    drawRadioTrack();
    if (!Radio.trackTimer) Radio.trackTimer = setInterval(() => { if (Radio.open && !document.hidden) drawRadioTrack(); }, 500);
    radioText('radio-time', radioHms(d.time));
    radioText('radio-rate', d.kbps ? `${d.kbps} kbit/s` : '-');
    radioText('radio-hops', d.hops === null || d.hops === undefined ? '-' : String(d.hops));
    radioText('radio-listen', d.listeners === null || d.listeners === undefined ? '-' : String(d.listeners));
    radioText('radio-cid', d.call_id || d.last ? `CALL ID ${d.call_id || d.last}` : '');
    const msg = !d.ready ? 'Reticulum is not connected yet'
        : st === 'buffering' ? 'Buffering...' : d.message || '';
    radioText('radio-msg', msg);
    radioText('radio-play', live ? '■ Stop' : '▶ Play');
    const q = document.getElementById('radio-quality');
    if (q && document.activeElement !== q && q.value !== d.quality) q.value = d.quality;
    drawRadioList(d);
    drawRadioIdentity(d);
    if (Radio.pane === 'commands' && Radio.open) { radioCmdStations(d, false); radioCmdLoad(false); }
}

function radioMss(sec) {
    sec = Math.max(0, Math.floor(sec));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// Seconds of audio the browser holds ahead: what the station sends now is heard this much later.
function radioAhead() {
    const a = Radio.audio;
    try {
        if (a && a.buffered.length) return Math.max(0, a.buffered.end(a.buffered.length - 1) - a.currentTime);
    } catch (e) {}
    return 0;
}

// Track line as the radio-lxst client: the title and bar of what is heard now (a new title waits
// for the buffer to play out), a moving text for a live stream.
function drawRadioTrack() {
    const d = Radio.data;
    if (!d || !document.getElementById('radio-track')) return;
    const playing = d.state === 'playing' && Radio.audio && Radio.audio.dataset.want;
    const since = Radio.dataAt ? (performance.now() - Radio.dataAt) / 1000 : 0;
    // heard = seconds of call audio played so far: where this stream starts + the element's clock.
    // Without it (older answer), the guess from the element's buffer, which Chrome reports in jumps.
    const base = playing && Radio.dataTok === Radio.audio.dataset.token ? d.stream_base : null;
    const heard = base !== null && base !== undefined ? base + Radio.audio.currentTime : null;
    const ahead = playing && heard === null ? radioAhead() : 0;
    let m = d.now || { np: d.track || '' };
    if (playing && d.prev) {
        const late = Math.max(0, -(Number(m.tp) || 0));  // the new track starts later at the station
        if (heard !== null ? heard < d.np_at + late
            : d.np_age !== null && d.np_age !== undefined && d.np_age + since < ahead + late) m = d.prev;
    }
    const np = m.np || '';
    const liveStream = np === 'Live streaming' || np.startsWith('Live streaming - ');
    radioText('radio-track', np ? `♪ ${np}` : '');
    const prog = document.getElementById('radio-prog');
    const live = document.getElementById('radio-live');
    if (playing && liveStream && !(m.td > 0)) {
        const title = np.slice('Live streaming - '.length).trim();
        const text = (m.sn ? `LIVE STREAMING: ${m.sn}` : 'LIVE STREAMING') + (np.startsWith('Live streaming - ') && title ? ` - ${title}` : '');
        const box = document.getElementById('radio-live-text');
        if (box.dataset.text !== text) {
            box.dataset.text = text;
            // 8 copies fill any width; the animation moves exactly one copy (12.5%) and starts over
            box.innerHTML = `<span>${radioE(text)}&nbsp;&nbsp;·&nbsp;&nbsp;</span>`.repeat(8);
            box.style.animationDuration = `${Math.max(6, (text.length + 6) * 0.25)}s`;
        }
        prog.hidden = true;
        live.hidden = false;
        return;
    }
    live.hidden = true;
    prog.hidden = false;
    const has = playing && m.td > 0 && m.tp !== undefined;
    const td = has ? m.td : 0;
    const at = heard !== null ? m.tp + heard - m.at : m.tp + (m.age || 0) + since - ahead;
    const pos = has ? Math.min(td, Math.max(0, at)) : 0;
    prog.classList.toggle('on', !!has);
    radioText('radio-prog-l', has ? radioMss(pos) : '-:--');
    radioText('radio-prog-r', has ? `-${radioMss(td - pos)} / ${radioMss(td)}` : '-:--');
    document.getElementById('radio-prog-fill').style.width = has ? `${(pos / td * 100).toFixed(2)}%` : '0';
}

// The identity in use, in the top bar like the other clients. A guest's is fixed.
function drawRadioIdentity(d) {
    const box = document.getElementById('radio-id');
    if (!box) return;
    const sig = JSON.stringify([d.identity, d.identity_name, d.client_id, d.guest, d.ready]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    const caret = d.guest ? '' : '<span class="msg-caret">▾</span>';
    if (!d.client_id) {
        box.className = 'msg-identity off';
        box.innerHTML = `<span class="msg-identity-name">${radioE(d.ready ? 'No identity: pick one' : 'Not connected')}</span>${caret}`;
    } else {
        box.className = 'msg-identity';
        box.innerHTML = '<span class="msg-dot"></span>'
            + (typeof IDENTITY_ICON !== 'undefined' ? `<span class="msg-identity-icon" aria-hidden="true">${IDENTITY_ICON}</span>` : '')
            + `<span class="msg-identity-name">${radioE(d.identity_name)}</span><code>${radioE(d.client_id)}</code>${caret}`;
    }
    box.title = d.guest ? `Listening as ${d.identity_name} (${d.client_id}): your guest identity - click to copy`
        : `Listening as ${d.identity_name} (${d.client_id}) - click to change`;
    box.onclick = e => {
        e.stopPropagation();
        if (d.guest) { if (d.client_id) copyText(d.client_id, 'Your identity hash copied'); return; }
        toggleRadioIdentityMenu();
    };
}

function toggleRadioIdentityMenu(force) {
    const menu = document.getElementById('radio-id-menu');
    const d = Radio.data || {};
    if (!menu) return;
    const open = (force !== undefined ? force : menu.hidden) && !d.guest;
    menu.hidden = !open;
    if (!open) return;
    menu.innerHTML = '<div class="msg-menu-head">Listen as</div>'
        + (d.identities || []).map(i => `
            <button class="msg-menu-item${i.id === d.identity ? ' current' : ''}" data-id="${radioE(i.id)}">
                <span class="msg-menu-text"><b>${radioE(i.name)}</b><code>${radioE(i.hash)}</code></span>
                ${i.id === d.identity ? '<span class="msg-menu-check">✓</span>' : ''}
            </button>`).join('')
        + (d.client_id ? `<div class="msg-menu-sep"></div>
            <button class="msg-menu-item plain" data-copy="1">Copy my identity hash</button>` : '');
    menu.querySelectorAll('.msg-menu-item').forEach(btn => btn.onclick = async e => {
        e.stopPropagation();
        toggleRadioIdentityMenu(false);
        if (btn.dataset.copy) return copyText(d.client_id, 'Your identity hash copied');
        if (btn.dataset.id === d.identity) return;
        const res = await radioPost('/api/radio/identity', { identity: btn.dataset.id });
        if (res && res.status === 'success') {
            showNotification(`Radio: now listening as ${radioE(btn.querySelector('b').textContent)}`, 'success', 3000);
            pollRadio();
        }
    });
}

document.addEventListener('click', e => {
    if (!e.target.closest('#radio-id-wrap')) toggleRadioIdentityMenu(false);
});

function drawRadioList(d) {
    const list = document.getElementById('radio-list');
    const rows = d.stations || [];
    const sig = JSON.stringify([rows, d.call_id, d.state]);
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    if (!rows.length) {
        list.innerHTML = '<div class="radio-empty">No station heard yet. They announce themselves every few minutes, or type a Call ID above.</div>';
        return;
    }
    list.innerHTML = rows.map(s => {
        const cur = s.call_id === d.call_id && !['idle', 'failed', 'ended'].includes(d.state);
        const nl = s.listeners;
        const info = `<span class="radio-air ${s.on_air ? 'on' : 'off'}">● ${s.on_air ? 'ON AIR' : 'OFF AIR'}</span>`
            + (s.subscribed ? '<span class="radio-sub-pill" title="You get a message when it goes on air">✓ SUBSCRIBED</span>' : '')
            + [nl !== null && nl !== undefined ? `<b>${radioE(nl)}</b> ${nl === 1 ? 'listener' : 'listeners'}` : '',
               s.kbps ? `<b>${radioE(s.kbps)}</b> kbit/s` : '',
               `heard ${radioE(radioAgo(s.heard))}`].filter(Boolean).map(t => `<span>${t}</span>`).join('');
        return `<div class="radio-st${cur ? ' cur' : ''}${s.on_air ? '' : ' off'}" data-cid="${radioE(s.call_id)}">
            <button class="radio-star${s.favorite ? ' on' : ''}" title="${s.favorite ? 'Remove from favourites' : 'Favourite'}"
                    onclick="radioFavorite('${radioE(s.call_id)}', ${!s.favorite})">${s.favorite ? '★' : '☆'}</button>
            <div class="radio-st-main" onclick="radioTune('${radioE(s.call_id)}')" title="Listen">
                <div class="radio-st-name">${radioE(s.name || 'Unnamed station')}${cur ? ' <span class="radio-st-now">▶</span>' : ''}</div>
                ${s.now_playing ? `<div class="radio-st-track">♪ ${radioE(s.now_playing)}</div>` : ''}
                <div class="radio-st-info">${info}</div>
                <div class="radio-st-cid">${radioE(s.call_id)}</div>
            </div>
            <div class="radio-st-acts">
                <button class="radio-mini" title="Copy the Call ID" onclick="copyText('${radioE(s.call_id)}', 'Call ID copied')">⧉</button>
                <button class="radio-mini radio-forget" title="Forget this station" onclick="radioForget('${radioE(s.call_id)}')">×</button>
            </div>
        </div>`;
    }).join('');
}

// ─── Commands: the station's LXMF autoresponder, buttons only ─

function radioPane(name) {
    Radio.pane = name;
    document.querySelectorAll('.radio-subtab').forEach(b => b.classList.toggle('active', b.dataset.pane === name));
    document.getElementById('radio-pane-stations').hidden = name !== 'stations';
    document.getElementById('radio-pane-commands').hidden = name !== 'commands';
    if (name === 'commands') { radioCmdStations(Radio.data || {}, true); radioCmdLoad(true); }
}

// The station list of the selector; opening the pane picks the one playing (or the last one).
function radioCmdStations(d, pickCurrent) {
    const sel = document.getElementById('radio-cmd-station');
    if (!sel) return;
    // shown by LXMF address (it gets the messages), picked by Call ID
    const rows = (d.stations || []).map(s => [s.call_id, s.name || 'Unnamed station', s.lxmf || '']);
    const cur = d.call_id || d.last;
    if (cur && !rows.some(r => r[0] === cur)) rows.unshift([cur, d.name || 'Unnamed station', d.lxmf || '']);
    const sig = JSON.stringify(rows);
    const keep = pickCurrent && cur ? cur : sel.value;
    if (sel.dataset.sig !== sig) {
        sel.dataset.sig = sig;
        sel.innerHTML = rows.length ? rows.map(([cid, name, lx]) => `<option value="${radioE(cid)}">${radioE(name)} - LXMF ${radioE(lx)}</option>`).join('')
            : '<option value="">No station yet</option>';
    }
    if (keep && rows.some(r => r[0] === keep)) sel.value = keep;
}

async function radioCommand(cmd) {
    const sel = document.getElementById('radio-cmd-station');
    const cid = sel ? sel.value : '';
    if (!/^[0-9a-f]{32}$/.test(cid)) { showNotification('Pick a station first', 'warning', 3000); return; }
    const d = await radioPost('/api/radio/command', { call_id: cid, cmd });
    if (d && d.status === 'success') radioCmdLoad(true);
}

async function radioCmdLoad(force) {
    const sel = document.getElementById('radio-cmd-station');
    const box = document.getElementById('radio-cmd-log');
    if (!sel || !box || Radio.pane !== 'commands') return;
    const cid = sel.value;
    if (!cid) { box.innerHTML = '<div class="radio-empty">No station to talk to yet.</div>'; return; }
    let d;
    try { d = await fetch(`/api/radio/commands/${cid}`).then(r => r.json()); } catch (e) { return; }
    if (!d || d.status !== 'success' || sel.value !== cid) return;
    const sig = JSON.stringify([cid, d]);
    if (!force && sig === Radio.cmdSig) return;
    Radio.cmdSig = sig;
    const foot = document.getElementById('radio-cmd-foot');
    if (!d.available) {
        box.innerHTML = `<div class="radio-empty">${radioE(d.why)}</div>`;
        foot.textContent = '';
        return;
    }
    const sub = document.getElementById('radio-cmd-sub');
    sub.textContent = d.subscribed === true ? '✓ Subscribed' : d.subscribed === false ? 'Not subscribed' : '';
    sub.classList.toggle('on', d.subscribed === true);
    foot.textContent = `Sent from your LXMF address ${d.from}. Replies and on-air messages land in the Messenger too.`;
    if (!d.messages.length) {
        box.innerHTML = '<div class="radio-empty">Send a command: the reply shows here. Subscribe = a message when the station goes on air.</div>';
        return;
    }
    const when = ts => ts ? new Date(ts * 1000).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    box.innerHTML = d.messages.map(m => m.dir === 'out'
        ? `<div class="radio-cmd-out"><span class="radio-cmd-t">${radioE(when(m.ts))}</span> &gt; ${radioE(m.text)}
             <span class="radio-cmd-st${m.state === 'failed' ? ' bad' : ''}">${radioE(m.state)}${m.error ? ': ' + radioE(m.error) : ''}</span></div>`
        : `<div class="radio-cmd-in"><span class="radio-cmd-t">${radioE(when(m.ts))}</span><div>${radioE(m.text)}</div></div>`).join('');
    box.scrollTop = box.scrollHeight;
}

// Settings > System Setup > Radio: applied at once, kept in ui_prefs.json.
function toggleRadioSetting(el) {
    const on = !el.classList.contains('active');
    el.classList.toggle('active', on);
    try { localStorage.setItem(RADIO_KEY, on ? 'on' : 'off'); } catch (e) {}
    applyRadioVisibility();
}

document.addEventListener('DOMContentLoaded', () => applyRadioVisibility());
window.addEventListener('storage', e => { if (e.key === RADIO_KEY) applyRadioVisibility(); });
