// Short tooltips for the controls that have no label of their own: icons
// (×, ←, →) and buttons whose one word may not say enough (Sync, Use,
// Connect...). A control with a title already keeps it; controls next to
// a label (Settings rows, menu entries) need none. Applied to whatever is
// drawn later too: the clients redraw their bars all the time.

const TOOLTIPS = [
    // Page tabs and navigation
    ['.tab-close', 'Close tab'],
    ['.nav-btn.back-btn', 'Back'],
    ['.nav-btn.forward-btn', 'Forward'],
    // RRC
    ['#rrc-address-go', 'Connect to this hub'],
    ['[data-rrc-act="connect"]', 'Connect to the hub'],
    ['[data-rrc-act="disconnect"]', 'Disconnect from the hub'],
    ['[data-rrc-refresh]', 'Ask the hub again'],
    ['[data-rrc-goto]', 'Open this room'],
    ['[data-rrc-join]', 'Join this room'],
    ['.rrc-emoji', 'Insert this emoji'],
    // BBS
    ['#bbs-address-go', 'Connect to this BBS'],
    ['[data-bbs-act="connect"]', 'Connect to the BBS'],
    ['[data-bbs-act="disconnect"]', 'Disconnect from the BBS'],
    // Lists that fold (RRC, BBS)
    ['.bbs-section-title', 'Show or hide this list'],
    // RMAP
    ['[data-rmap-act="copy"]', 'Copy the address'],
    ['[data-rmap-act="hostport"]', 'Copy host and port'],
    // Messenger
    ['[data-act="write"]', 'Open a chat with this address'],
    ['[data-act="ping"]', 'Time an answer, no message sent'],
    ['[data-act="check"]', 'Ask the network for a path'],
    ['[data-act="copy"]', 'Copy the address'],
    ['[data-unblock]', 'Accept messages again'],
    ['.msg-picker button[data-emoji]', 'React with this emoji'],
    // Settings buttons
    ['.identity-binding select', 'Identity used on this node'],
    ['[onclick^="useIdentity("]', 'Make it the identity in use'],
    ['[onclick^="renameIdentity("]', 'Change its name'],
    ['[onclick^="deleteIdentity("]', 'Delete this identity and its keys'],
    ['[onclick="forgetIdentifiedNodes()"]', 'Forget the nodes you identified to'],
    ['[onclick="clearHistoryFromSettings()"]', 'Empty the History list'],
    ['[onclick="clearPageCache()"]', 'Delete every stored page'],
    ['[onclick="showCacheSearch()"]', 'Search the pages you read'],
    ['#messenger-announce-now', 'Announce your LXMF address now'],
    ['#messenger-sync-now', 'Collect your messages from the node'],
    ['#messenger-sync-cancel', 'Stop the sync'],
    ['[onclick="confirmRestart()"]', 'Restart the rBrowser server'],
    ['#setting-update-now', 'Look for a new version'],
    ['#setting-auth-change', 'Set or change the access password'],
    ['#setting-ddns-apply', 'Apply the DDNS settings'],
    ['#setting-guest-apply', 'Apply the guest settings'],
    ['#setting-remote-copy', 'Copy the remote link'],
    ['#setting-remote-open', 'Open the remote link'],
    ['#setting-rrc-id-new', 'New RRC identity'],
    ['#setting-rrc-id-delete', 'Delete this RRC identity'],
    ['a[href^="http://rbrowser.local"]', 'rBrowser by name on your network'],
];

function applyTooltips(root = document) {
    for (const [selector, text] of TOOLTIPS) {
        root.querySelectorAll(selector).forEach(el => {
            if (!el.hasAttribute('title') && !el.hasAttribute('aria-label')) el.title = text;
        });
    }
}

{
    let pending = null;
    const run = () => { pending = null; applyTooltips(); };
    new MutationObserver(() => { if (!pending) pending = setTimeout(run, 300); })
        .observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
}

// Our own tooltip everywhere, quicker and nicer than the browser's.
// The title moves to data-tip on hover (and again if the code sets it later).
{
    const SCOPE = '[title], [data-tip], .node-cache';
    // Text made at hover time (rbrowser.js rbTipText, node list), else data-tip.
    const tipText = el => (typeof window.rbTipText === 'function' && window.rbTipText(el)) || el.dataset.tip;
    const moveTitle = el => {
        el.dataset.tip = el.getAttribute('title');
        if (!el.hasAttribute('aria-label') || el.dataset.tipLabel) {
            el.setAttribute('aria-label', el.dataset.tip);
            el.dataset.tipLabel = '1';
        }
        el.removeAttribute('title');
    };
    const DELAY = 250, QUICK = 600;
    let tip = null, timer = null, current = null, hiddenAt = 0;
    const hide = () => {
        clearTimeout(timer);
        if (tip && !tip.hidden) { tip.hidden = true; hiddenAt = Date.now(); }
        current = null;
    };
    const show = el => {
        const text = tipText(el);
        if (!text || !el.isConnected || el.hidden) return;
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'rb-tip';
            tip.setAttribute('role', 'tooltip');
            document.body.appendChild(tip);
        }
        tip.textContent = text;
        tip.hidden = false;
        const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
        const left = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 6));
        const below = r.bottom + 6 + h < innerHeight || r.top - h - 6 < 0;
        tip.style.left = `${left}px`;
        tip.style.top = `${below ? r.bottom + 6 : r.top - h - 6}px`;
    };
    document.addEventListener('pointerover', e => {
        if (e.pointerType === 'touch') return;
        if (!e.target.closest) return;
        const el = e.target.closest(SCOPE);
        if (!el || el === current || el.tagName === 'IFRAME') return;
        hide();
        if (el.hasAttribute('title')) moveTitle(el);
        if (!tipText(el)) return;
        current = el;
        timer = setTimeout(() => show(el), Date.now() - hiddenAt < QUICK ? 0 : DELAY);
    });
    document.addEventListener('pointerout', e => {
        if (current && !current.contains(e.relatedTarget)) hide();
    });
    ['pointerdown', 'scroll', 'blur'].forEach(t => window.addEventListener(t, hide, true));
    window.rbHideTip = hide;
    new MutationObserver(list => {
        for (const m of list) {
            const el = m.target;
            if (el.hasAttribute('title') && 'tip' in el.dataset) moveTitle(el);
            if (el === current && !tip?.hidden) show(el);
        }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['title'], subtree: true });
}
