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
    ['[onclick="lockAdvanced()"]', 'Hide the Advanced settings'],
    ['#setting-update-now', 'Look for a new version'],
    ['#setting-auth-apply', 'Apply the password settings'],
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
