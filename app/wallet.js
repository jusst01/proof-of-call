/* Proof of Call — NEAR wallet layer (TESTNET), v2.
 *
 * Adapted from OpenGrasp's v2/wallet.js (same selector version, same
 * fail-soft philosophy):
 *   1. "Connect Wallet" button (NEAR Wallet Selector: Meteor + MyNearWallet),
 *   2. registerCall(): signs register_call(...) on the v2 Proof of Call
 *      contract from the USER's account — the signer becomes the caller on
 *      the permanent record. Optionally attaches the 0.1 NEAR bond.
 *   3. claimBond(callId): claims a "claimable" bond back (claim_bond).
 *   4. linkWallet(chain, address) / unlinkWallet(chain, address): manages the
 *      caller's linked trading wallets.
 *
 * Everything fails soft: if the CDN libraries cannot load (offline, blocked
 * CDN, no Web3 support), status becomes 'unavailable', the connect UI hides
 * itself, and the read-only app (leaderboard / profiles / feed) keeps working.
 *
 * Contract: proofofcallv2.opengraspdev.testnet
 *   register_call(chain, token_ref, direction,
 *                 target_price: Option<String>,
 *                 invalidation_price: Option<String>,
 *                 thesis: Option<String>) -> u64
 *     payable: attach exactly 0.1 NEAR (bonded) or 0 (unbonded); any other
 *     amount panics on-chain. bond_amount() view returns the bond in yocto.
 *   claim_bond(call_id) / link_wallet(chain, address) / unlink_wallet(chain, address)
 */
(function () {
  'use strict';

  var CONTRACT_ID = 'proofofcallv2.opengraspdev.testnet';
  var BOND_YOCTO = '100000000000000000000000'; // 0.1 NEAR == bond_amount()
  var NETWORK = 'testnet';
  var SELECTOR_VERSION = '8.9.13';
  var CDN = 'https://cdn.jsdelivr.net/npm/@near-wallet-selector';
  var PENDING_KEY = 'poc_pending_call'; // in-flight tx marker (redirect wallets)

  var state = { status: 'idle', account: null };
  var selector = null;
  var modal = null;
  var loadPromise = null;
  var listeners = [];

  // A wallet redirect (MyNearWallet) returns to the page with the outcome in
  // the URL. Capture it once, then scrub the URL so a refresh cannot replay it.
  var redirectInfo = null;
  try {
    var q = new URLSearchParams(window.location.search);
    var txHashes = q.get('transactionHashes');
    var errCode = q.get('errorCode');
    if (txHashes || errCode) {
      redirectInfo = {
        txHash: txHashes ? txHashes.split(',')[0] : null,
        error: errCode ? (q.get('errorMessage') || errCode) : null,
      };
      q.delete('transactionHashes'); q.delete('errorCode'); q.delete('errorMessage');
      var clean = window.location.pathname + (q.toString() ? '?' + q.toString() : '') + window.location.hash;
      window.history.replaceState(null, '', clean);
    }
  } catch (e) { /* URL parsing is best-effort */ }

  function snapshot() { return { status: state.status, account: state.account }; }
  function emit() {
    renderBox();
    var s = snapshot();
    listeners.slice().forEach(function (cb) { try { cb(s); } catch (e) { /* listener errors are theirs */ } });
  }
  function setState(patch) {
    var changed = false;
    for (var k in patch) { if (state[k] !== patch[k]) { state[k] = patch[k]; changed = true; } }
    if (changed) emit();
  }

  // ------------------------------------------------------------- hub widget
  function box() { return document.getElementById('walletBox'); }

  function renderBox() {
    var el = box();
    if (!el) return;
    if (state.status === 'unavailable') { el.innerHTML = ''; return; }
    if (state.status === 'connected' && state.account) {
      el.innerHTML =
        '<span class="wchip on">⛓ NEAR <b>' + escapeHtml(state.account) + '</b></span>' +
        '<button type="button" class="wbtn ghost" id="pocDisconnectBtn">Disconnect</button>';
    } else if (state.status === 'loading') {
      el.innerHTML = '<button type="button" class="wbtn" disabled>Loading wallet…</button>';
    } else {
      el.innerHTML = '<button type="button" class="wbtn" id="pocConnectBtn">⛓ Connect Wallet</button>' +
        '<span class="wchip dim">NEAR TESTNET</span>';
    }
    var c = document.getElementById('pocConnectBtn');
    if (c) c.addEventListener('click', function () { connect(); });
    var d = document.getElementById('pocDisconnectBtn');
    if (d) d.addEventListener('click', function () { disconnect(); });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // ------------------------------------------------------------ wallet core
  function loadLibs() {
    if (loadPromise) return loadPromise;
    setState({ status: 'loading' });
    loadPromise = Promise.all([
      import(CDN + '/core@' + SELECTOR_VERSION + '/+esm'),
      import(CDN + '/modal-ui-js@' + SELECTOR_VERSION + '/+esm'),
      import(CDN + '/meteor-wallet@' + SELECTOR_VERSION + '/+esm'),
      import(CDN + '/my-near-wallet@' + SELECTOR_VERSION + '/+esm'),
    ]).then(function (mods) {
      var core = mods[0], modalJs = mods[1], meteor = mods[2], mnw = mods[3];
      if (!document.querySelector('link[data-poc-wallet-css]')) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = CDN + '/modal-ui-js@' + SELECTOR_VERSION + '/styles.css';
        link.setAttribute('data-poc-wallet-css', '1');
        document.head.appendChild(link);
      }
      return core.setupWalletSelector({
        network: NETWORK,
        modules: [meteor.setupMeteorWallet(), mnw.setupMyNearWallet()],
      }).then(function (sel) {
        selector = sel;
        modal = modalJs.setupModal(selector, {
          contractId: CONTRACT_ID,
          theme: 'auto',
          description: 'Register trading calls on-chain: the contract records YOU as the caller with the block timestamp. Add a target, an invalidation and a thesis, and optionally bond 0.1 NEAR on the call. The oracle — never you — writes the entry price from DexScreener and scores the call at 15m / 1h / 6h / 24h.',
        });
        var syncFromStore = function () {
          try {
            var s = selector.store.getState();
            var accounts = s.accounts || [];
            var active = null;
            for (var i = 0; i < accounts.length; i++) if (accounts[i].active) { active = accounts[i]; break; }
            var acct = (active || accounts[0] || {}).accountId || null;
            if (acct !== state.account) {
              setState({ account: acct, status: acct ? 'connected' : 'ready' });
            }
          } catch (e) { /* store not ready yet */ }
        };
        try {
          if (selector.store.observable && typeof selector.store.observable.subscribe === 'function') {
            selector.store.observable.subscribe(syncFromStore);
          }
        } catch (e) { /* subscription is best-effort; connect() re-syncs */ }
        syncFromStore();
        if (!state.account) setState({ status: 'ready' });
        return selector;
      });
    }).catch(function () {
      selector = null; modal = null;
      setState({ status: 'unavailable' });
      return null;
    });
    return loadPromise;
  }

  function init() {
    renderBox();
    // Warm the libraries only when there is a plausible session to restore or
    // a redirect to finalize; otherwise load on first click.
    var hasSession = false;
    try { hasSession = !!window.localStorage.getItem('near-wallet-selector:selectedWalletId'); } catch (e) { /* ignore */ }
    if (hasSession || redirectInfo) loadLibs();
    return loadPromise || Promise.resolve(null);
  }

  function connect() {
    return loadLibs().then(function (sel) {
      if (!sel || !modal) { setState({ status: 'unavailable' }); return; }
      try { modal.show(); } catch (e) { setState({ status: 'unavailable' }); }
    });
  }

  function disconnect() {
    if (!selector) { setState({ account: null, status: 'ready' }); return Promise.resolve(); }
    return selector.wallet().then(function (w) { return w.signOut(); }).catch(function () { /* ignore */ })
      .then(function () { setState({ account: null, status: 'ready' }); });
  }

  // ------------------------------------------------------- transaction core
  /* Sign and send one FunctionCall against the v2 contract from the
   * connected account. Resolves { txHash } for injected wallets; redirect
   * wallets return via redirectInfo instead (txHash null here). */
  function sendCall(methodName, args, deposit) {
    return loadLibs().then(function (sel) {
      if (!sel) throw new Error('Wallet unavailable');
      if (!state.account) throw new Error('Connect a wallet first');
      return selector.wallet();
    }).then(function (wallet) {
      return wallet.signAndSendTransaction({
        receiverId: CONTRACT_ID,
        actions: [{
          type: 'FunctionCall',
          params: {
            methodName: methodName,
            args: args,
            gas: '30000000000000',
            deposit: deposit || '0',
          },
        }],
      });
    }).then(function (outcome) {
      var txHash = null;
      try {
        if (outcome && outcome.transaction && outcome.transaction.hash) txHash = outcome.transaction.hash;
      } catch (e) { /* ignore */ }
      return { txHash: txHash };
    });
  }

  function optString(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    return s ? s : null;
  }

  // --------------------------------------------------------- register a call
  /* args: { chain, token_ref, direction,
   *         target_price?, invalidation_price?, thesis?, bond? }.
   * Optional fields are sent as null when empty (contract Option<String>).
   * Deposit is exactly BOND_YOCTO when args.bond is truthy (the form's
   * default) and '0' otherwise — any other amount panics on-chain. */
  function registerCall(args) {
    var payload = {
      chain: args.chain,
      token_ref: args.token_ref,
      direction: args.direction,
      target_price: optString(args.target_price),
      invalidation_price: optString(args.invalidation_price),
      thesis: optString(args.thesis),
    };
    var deposit = args.bond ? BOND_YOCTO : '0';
    try {
      window.localStorage.setItem(PENDING_KEY, JSON.stringify({
        chain: payload.chain, token_ref: payload.token_ref, direction: payload.direction,
        target_price: payload.target_price, invalidation_price: payload.invalidation_price,
        thesis: payload.thesis, bond: !!args.bond, ts: Date.now(),
      }));
    } catch (e) { /* best-effort */ }
    return sendCall('register_call', payload, deposit).then(function (res) {
      try { window.localStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
      return res;
    });
  }

  // ------------------------------------------------------------- claim bond
  /* claim_bond(call_id) — caller claims a "claimable" bond back. No deposit. */
  function claimBond(callId) {
    return sendCall('claim_bond', { call_id: Number(callId) }, '0');
  }

  // ----------------------------------------------------------- linked wallets
  function linkWallet(chain, address) {
    return sendCall('link_wallet', { chain: chain, address: String(address).trim() }, '0');
  }
  function unlinkWallet(chain, address) {
    return sendCall('unlink_wallet', { chain: chain, address: String(address).trim() }, '0');
  }

  window.PoCWallet = {
    init: init,
    connect: connect,
    disconnect: disconnect,
    registerCall: registerCall,
    claimBond: claimBond,
    linkWallet: linkWallet,
    unlinkWallet: unlinkWallet,
    getState: snapshot,
    redirectInfo: redirectInfo,
    onChange: function (cb) { listeners.push(cb); },
    CONTRACT_ID: CONTRACT_ID,
    BOND_YOCTO: BOND_YOCTO,
  };
})();
