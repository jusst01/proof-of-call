/* Proof of Call — read layer + UI.
 * All data comes from view calls against the testnet contract via
 * https://test.rpc.fastnear.com. No backend, no build step.
 *
 * HONESTY RULES baked into this UI:
 *  - Calls 0–23 (caller opengraspdev.testnet) are IMPORTED historical records
 *    of the tracked Telegram channel "Pumpfun Callouts", imported 2026-11-11
 *    from a live tracker running since 2026-11-03. They are labelled as such
 *    everywhere they appear — never as live-registered calls. Their on-chain
 *    timestamp is the import time; the original calls happened 2026-11-03 → 11.
 *  - Call 24 (BONK, Solana) is a genuine LIVE registration, labelled live.
 *  - Any other call registered through this page is live by construction.
 */
(function () {
  'use strict';

  var CONTRACT_ID = 'proofofcall.opengraspdev.testnet';
  var RPC_URL = 'https://test.rpc.fastnear.com';
  var EXPLORER = 'https://testnet.nearblocks.io/address/' + CONTRACT_ID;
  var IMPORTED_CALLER = 'opengraspdev.testnet';
  var IMPORTED_MAX_ID = 23; // ids 0..23 = imported Pumpfun Callouts history
  var HORIZONS = ['15m', '1h', '6h', '24h'];

  var $ = function (id) { return document.getElementById(id); };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // ------------------------------------------------------------------- RPC
  function view(method, args) {
    var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(args || {}))));
    return fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'poc-' + method, method: 'query',
        params: {
          request_type: 'call_function', account_id: CONTRACT_ID,
          method_name: method, args_base64: b64, finality: 'optimistic',
        },
      }),
    }).then(function (res) { return res.json(); }).then(function (j) {
      if (!j || !j.result || !j.result.result) throw new Error('Bad RPC response for ' + method);
      var bytes = j.result.result;
      var text = '';
      for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
      return JSON.parse(decodeURIComponent(escape(text)));
    });
  }

  // -------------------------------------------------------------- formatting
  function fmtBps(bps) {
    if (bps === null || bps === undefined) return '—';
    var pct = bps / 100;
    var sign = pct > 0 ? '+' : '';
    return sign + pct.toFixed(2) + '%';
  }
  function clsBps(bps) {
    if (bps > 0) return 'pos';
    if (bps < 0) return 'neg';
    return 'flat';
  }
  function fmtHit(bps) { return (bps / 100).toFixed(1) + '%'; }
  function fmtMoney(v) {
    var neg = v < 0;
    var txt = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-$' : '$') + txt;
  }

  // ------------------------------------------------- follower simulation
  // $100 on every scored call, exited at the 24h outcome where recorded,
  // else at the call's latest recorded horizon. A call can lose at most
  // its $100. Computed purely from the on-chain outcomes already loaded.
  var EXIT_ORDER = ['24h', '6h', '1h', '15m'];
  function simulateFollower(callList) {
    var sim = { n: 0, fallback: 0, staked: 0, final: 0 };
    callList.forEach(function (c) {
      var byHorizon = {};
      (c.outcomes || []).forEach(function (o) { byHorizon[o.horizon] = o; });
      var pick = null;
      for (var i = 0; i < EXIT_ORDER.length; i++) {
        if (byHorizon[EXIT_ORDER[i]]) { pick = byHorizon[EXIT_ORDER[i]]; break; }
      }
      if (!pick) return; // unscored call — nothing to simulate yet
      if (pick.horizon !== '24h') sim.fallback++;
      sim.n++;
      sim.staked += 100;
      sim.final += Math.max(0, 100 * (1 + pick.return_bps / 10000));
    });
    sim.net = sim.final - sim.staked;
    return sim;
  }

  // Pool every caller's contract stats into one all-callers baseline.
  function fieldStats() {
    var wins = 0, outcomes = 0, weighted = 0, any = false;
    state.callers.forEach(function (acct) {
      var s = state.statsByCaller[acct];
      if (!s || !s.total_outcomes) return;
      any = true;
      wins += s.wins || 0;
      outcomes += s.total_outcomes;
      weighted += (s.avg_return_bps || 0) * s.total_outcomes;
    });
    if (!any) return null;
    return {
      // Truncate, mirroring the contract's integer math, so the strip
      // always agrees with the per-caller rows to the last digit.
      hitRateBps: Math.floor(wins * 10000 / outcomes),
      avgBps: Math.trunc(weighted / outcomes),
      outcomes: outcomes,
    };
  }
  function fmtDateFromNs(ns) {
    // ns timestamps exceed Number.MAX_SAFE_INTEGER; seconds precision is
    // all the UI needs and survives the float conversion.
    var sec = Math.floor(Number(ns) / 1e9);
    var d = new Date(sec * 1000);
    return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
  function shortRef(ref) {
    if (!ref) return '';
    if (ref.length <= 20) return ref;
    return ref.slice(0, 10) + '…' + ref.slice(-6);
  }
  function dexLink(call) {
    return 'https://dexscreener.com/search?q=' + encodeURIComponent(call.token_ref);
  }
  function isImported(call) {
    return call.caller === IMPORTED_CALLER && call.id <= IMPORTED_MAX_ID;
  }

  // ------------------------------------------------------------- call cards
  function outcomeChips(call) {
    var byHorizon = {};
    (call.outcomes || []).forEach(function (o) { byHorizon[o.horizon] = o; });
    return HORIZONS.map(function (h) {
      var o = byHorizon[h];
      if (!o) return '<span class="chip none">' + h + ' · pending</span>';
      return '<span class="chip ' + clsBps(o.return_bps) + '">' + h + ' ' + fmtBps(o.return_bps) + '</span>';
    }).join('');
  }

  function callCard(call) {
    var imported = isImported(call);
    var live = !imported;
    var badges =
      '<span class="badge dir-' + escapeHtml(call.direction) + '">' + escapeHtml(call.direction.toUpperCase()) + '</span>' +
      '<span class="badge chain">' + escapeHtml(call.chain) + '</span>' +
      (imported ? '<span class="badge imported">IMPORTED RECORD</span>' : '<span class="badge live">● LIVE</span>') +
      '<span class="badge status">' + escapeHtml(call.status.replace('_', ' ')) + '</span>';
    var when = imported
      ? 'Historical call · imported on-chain 2026-11-11'
      : 'Registered ' + fmtDateFromNs(call.registered_at_ns);
    return '<article class="call">' +
      '<div class="call-head"><span class="call-id">Call #' + call.id + '</span>' + badges + '</div>' +
      '<div class="call-token"><a href="' + dexLink(call) + '" target="_blank" rel="noopener" title="' + escapeHtml(call.token_ref) + '">' +
        escapeHtml(shortRef(call.token_ref)) + '</a>' +
        '<span class="call-caller">by ' + escapeHtml(call.caller) + '</span></div>' +
      '<div class="call-meta">' + when +
        (call.entry_price ? ' · entry <b>' + escapeHtml(call.entry_price) + '</b> (set by oracle)' : ' · entry price pending (oracle)') +
        ' · receipt NFT <code>' + escapeHtml(call.receipt_token_id) + '</code></div>' +
      '<div class="chips">' + outcomeChips(call) + '</div>' +
      '</article>';
  }

  // ------------------------------------------------------------------ data
  var state = { calls: [], callers: [], statsByCaller: {}, focus: IMPORTED_CALLER };

  function loadAll() {
    return Promise.all([
      view('get_recent_calls', { limit: 100 }),
      view('get_call_count', {}),
    ]).then(function (r) {
      var calls = r[0] || [];
      state.calls = calls;
      var seen = {};
      calls.forEach(function (c) { seen[c.caller] = true; });
      // The seeded caller leads even if a newer call pushed them out of view.
      seen[IMPORTED_CALLER] = true;
      state.callers = Object.keys(seen);
      return Promise.all(state.callers.map(function (acct) {
        return view('get_caller_stats', { account: acct }).then(function (s) {
          state.statsByCaller[acct] = s;
        }).catch(function () { state.statsByCaller[acct] = null; });
      }));
    }).then(function () { renderAll(); });
  }

  // --------------------------------------------------------------- renders
  function callerLabel(acct) {
    if (acct === IMPORTED_CALLER) {
      return escapeHtml(acct) + ' <span class="badge imported">IMPORTED TRACK RECORD — “Pumpfun Callouts”</span>';
    }
    return escapeHtml(acct);
  }

  function renderHero() {
    var totalOutcomes = 0, scored = 0;
    state.calls.forEach(function (c) {
      totalOutcomes += (c.outcomes || []).length;
      if ((c.outcomes || []).length) scored++;
    });
    $('heroStats').innerHTML =
      '<div class="stat"><b>' + state.calls.length + '</b><span>calls on-chain</span></div>' +
      '<div class="stat"><b>' + scored + '</b><span>calls scored</span></div>' +
      '<div class="stat"><b>' + totalOutcomes + '</b><span>horizon outcomes</span></div>' +
      '<div class="stat"><b>' + state.callers.length + '</b><span>callers tracked</span></div>';
  }

  function renderLeaderboard() {
    var rows = state.callers.map(function (acct) {
      var s = state.statsByCaller[acct] || {};
      return { acct: acct, s: s };
    }).sort(function (a, b) {
      return (b.s.total_outcomes || 0) - (a.s.total_outcomes || 0) ||
             (b.s.hit_rate_bps || 0) - (a.s.hit_rate_bps || 0);
    });
    var field = fieldStats();
    var fieldSim = simulateFollower(state.calls);
    var html = '';
    if (field && fieldSim.n) {
      html += '<div class="bench">📊 <b>The field — every caller combined:</b> hit rate ' +
        fmtHit(field.hitRateBps) + ' · avg return <span class="' + clsBps(field.avgBps) + '">' +
        fmtBps(field.avgBps) + '</span> · $100 on every scored call → <b>' + fmtMoney(fieldSim.final) +
        '</b> back from ' + fmtMoney(fieldSim.staked) + ' staked' +
        '<span class="bench-note">This is the base rate every caller below is read against — the average call on this record loses money; beating the field means losing less, or actually winning.</span></div>';
    }
    html += '<table class="board"><thead><tr>' +
      '<th>Caller</th><th>Calls</th><th>Scored</th><th>Hit rate</th><th>Avg return</th><th>Best call</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (r) {
      var s = r.s;
      var marker = '';
      if (field && s.total_outcomes) {
        if (s.avg_return_bps > field.avgBps) marker = ' <span class="vsfield pos" title="Above the all-caller average return">▲</span>';
        else if (s.avg_return_bps < field.avgBps) marker = ' <span class="vsfield neg" title="Below the all-caller average return">▼</span>';
        else marker = ' <span class="vsfield flat" title="Exactly the all-caller average return">●</span>';
      }
      html += '<tr data-caller="' + escapeHtml(r.acct) + '" class="lb-row' + (r.acct === state.focus ? ' focused' : '') + '">' +
        '<td>' + callerLabel(r.acct) + '</td>' +
        '<td>' + (s.total_calls != null ? s.total_calls : '—') + '</td>' +
        '<td>' + (s.scored_calls != null ? s.scored_calls : '—') + '</td>' +
        '<td>' + (s.total_outcomes ? fmtHit(s.hit_rate_bps) : '—') + '</td>' +
        '<td class="' + clsBps(s.avg_return_bps) + '">' + (s.total_outcomes ? fmtBps(s.avg_return_bps) + marker : '—') + '</td>' +
        '<td class="' + clsBps(s.best_return_bps) + '">' + (s.total_outcomes ? fmtBps(s.best_return_bps) : '—') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table><p class="hint">Click a caller to open their profile. Hit rate &amp; returns are computed by the contract from recorded outcomes — nothing here is self-reported.</p>';
    $('leaderboard').innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('.lb-row'), function (tr) {
      tr.addEventListener('click', function () {
        state.focus = tr.getAttribute('data-caller');
        renderLeaderboard(); renderProfile();
        $('profile').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function renderProfile() {
    var acct = state.focus;
    var s = state.statsByCaller[acct];
    var myCalls = state.calls.filter(function (c) { return c.caller === acct; })
      .sort(function (a, b) { return b.id - a.id; });
    var html = '<h3 class="profile-name">' + callerLabel(acct) + '</h3>';
    if (acct === IMPORTED_CALLER) {
      html += '<div class="notice">This profile is the <b>imported track record of the Telegram channel “Pumpfun Callouts”</b>, ' +
        'imported on-chain on 2026-11-11 from a live listener + DexScreener tracker that has run since 2026-11-03. ' +
        'The calls below (ids 0–23) are historical records — they were <b>not</b> registered live through this page. ' +
        'Call #24 (BONK) was registered live end-to-end. Original calls: 2026-11-03 → 2026-11-11.</div>';
    }
    if (s) {
      html += '<div class="statgrid">' +
        '<div class="stat"><b>' + s.total_calls + '</b><span>calls</span></div>' +
        '<div class="stat"><b>' + s.scored_calls + '</b><span>scored</span></div>' +
        '<div class="stat"><b>' + (s.total_outcomes ? fmtHit(s.hit_rate_bps) : '—') + '</b><span>hit rate</span></div>' +
        '<div class="stat"><b class="' + clsBps(s.avg_return_bps) + '">' + (s.total_outcomes ? fmtBps(s.avg_return_bps) : '—') + '</b><span>avg return</span></div>' +
        '<div class="stat"><b class="' + clsBps(s.best_return_bps) + '">' + (s.total_outcomes ? fmtBps(s.best_return_bps) : '—') + '</b><span>best outcome</span></div>' +
        '</div>';
      if (s.per_horizon && s.per_horizon.length) {
        html += '<table class="board small"><thead><tr><th>Horizon</th><th>Outcomes</th><th>Wins</th><th>Hit rate</th><th>Avg return</th></tr></thead><tbody>';
        s.per_horizon.forEach(function (h) {
          html += '<tr><td>' + escapeHtml(h.horizon) + '</td><td>' + h.outcomes + '</td><td>' + h.wins + '</td>' +
            '<td>' + (h.outcomes ? fmtHit(h.hit_rate_bps) : '—') + '</td>' +
            '<td class="' + clsBps(h.avg_return_bps) + '">' + (h.outcomes ? fmtBps(h.avg_return_bps) : '—') + '</td></tr>';
        });
        html += '</tbody></table>';
      }
      var sim = simulateFollower(myCalls);
      if (sim.n) {
        var netPct = sim.staked ? (sim.net / sim.staked * 100) : 0;
        var basisNote = sim.fallback
          ? sim.fallback + ' of ' + sim.n + ' calls exited at their latest recorded horizon (24h not yet recorded); the rest at 24h.'
          : 'Exit at the 24h outcome for all ' + sim.n + ' calls.';
        html += '<div class="followersim">' +
          '<div class="fs-label">💸 If you had followed every call</div>' +
          '<div class="fs-big">$100 on each of ' + sim.n + ' scored calls → <b class="' + clsBps(sim.net) + '">' +
            fmtMoney(sim.final) + '</b></div>' +
          '<div class="fs-sub">from ' + fmtMoney(sim.staked) + ' staked · net <span class="' + clsBps(sim.net) + '">' +
            fmtMoney(sim.net) + ' (' + (netPct > 0 ? '+' : '') + netPct.toFixed(2) + '%)</span></div>' +
          '<p class="fs-note">Simulation computed from the on-chain outcomes below — $100 per scored call, a call can lose at most its $100. ' +
            basisNote + ' Unscored calls are excluded.</p>' +
          '</div>';
      } else {
        html += '<p class="hint">No scored calls yet — the $100-per-call follower simulation starts once the oracle records this caller’s first outcomes.</p>';
      }
    }
    html += '<div class="calls">' + (myCalls.length ? myCalls.map(callCard).join('') : '<p class="hint">No calls loaded for this caller.</p>') + '</div>';
    $('profileBody').innerHTML = html;
  }

  function renderFeed() {
    var sorted = state.calls.slice().sort(function (a, b) { return b.id - a.id; });
    $('feed').innerHTML = sorted.map(callCard).join('') || '<p class="hint">No calls yet.</p>';
  }

  function renderAll() {
    renderHero(); renderLeaderboard(); renderProfile(); renderFeed();
    $('loadState').textContent = 'Live from NEAR testnet · contract ' + CONTRACT_ID;
  }

  // -------------------------------------------------------------- register
  function setFormState() {
    var w = window.PoCWallet ? window.PoCWallet.getState() : { status: 'unavailable', account: null };
    var btn = $('regSubmit');
    var note = $('regNote');
    if (w.status === 'unavailable') {
      btn.disabled = true;
      note.textContent = 'Wallet libraries could not load — registration is unavailable in this browser, but all records above stay readable.';
    } else if (!w.account) {
      btn.disabled = true;
      note.textContent = 'Connect your NEAR testnet wallet to register a call. The wallet that signs becomes the caller on the permanent record.';
    } else {
      btn.disabled = false;
      note.textContent = 'Signing as ' + w.account + '. Your call is timestamped by the block — it cannot be backdated, edited, or deleted.';
    }
  }

  function initForm() {
    var form = $('regForm');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var chain = $('fChain').value;
      var tokenRef = $('fToken').value.trim();
      var direction = $('fDirection').value;
      var msg = $('regMsg');
      if (!tokenRef) { msg.textContent = 'Enter the token contract / mint address.'; return; }
      msg.textContent = 'Waiting for wallet signature…';
      window.PoCWallet.registerCall({ chain: chain, token_ref: tokenRef, direction: direction })
        .then(function (res) {
          msg.innerHTML = '✅ Call registered on-chain' + (res && res.txHash ? ' (tx ' + escapeHtml(res.txHash) + ')' : '') +
            '. The oracle will fetch the entry price from DexScreener and score this call at 15m / 1h / 6h / 24h. Refreshing…';
          setTimeout(function () { loadAll().then(setFormState); }, 2500);
        })
        .catch(function (err) {
          msg.textContent = 'Registration failed or was rejected: ' + (err && err.message ? err.message : err);
        });
    });
  }

  // ----------------------------------------------------------------- boot
  document.addEventListener('DOMContentLoaded', function () {
    if (window.PoCWallet) {
      window.PoCWallet.init();
      window.PoCWallet.onChange(setFormState);
      var ri = window.PoCWallet.redirectInfo;
      if (ri && (ri.txHash || ri.error)) {
        var msg = $('regMsg');
        if (msg) {
          msg.innerHTML = ri.error
            ? 'Wallet returned an error: ' + escapeHtml(ri.error)
            : '✅ Call registered on-chain (tx ' + escapeHtml(ri.txHash || '') + '). The oracle will set the entry price from DexScreener and score it at 15m / 1h / 6h / 24h.';
        }
      }
    }
    initForm();
    setFormState();
    loadAll().catch(function (err) {
      $('loadState').textContent = 'Could not reach the NEAR RPC (' + (err && err.message ? err.message : err) + '). Records are on-chain at ' + CONTRACT_ID + ' — try refreshing.';
    });
  });
})();
