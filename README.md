# Proof of Call

**Screenshots are not evidence. Show me your Proof of Call.**

Alpha callers delete their misses, edit their calls after the fact, and screenshot only the
wins. Followers size real money on track records that are, at best, the caller's own marketing.
**Proof of Call is the registry that ends that:** a caller registers a trading call **on-chain on
NEAR, before the move** — the block timestamp cannot be forged, edited, or deleted. An oracle
fetches the real entry price from DexScreener (the caller never types it) and scores the call at
fixed horizons — **15m / 1h / 6h / 24h**. Every call becomes a permanent, unforgeable track
record: hit rate, average return, per-horizon consistency, wins *and* losses alike.

## This is not a mock-data demo

The scoring engine behind Proof of Call has been **live since 2026-11-03**: a Telegram listener +
DexScreener tracker that logs real channel calls and snapshots prices at exactly the
entry / 15m / 1h / 6h / 24h cadence the contract uses. The on-chain registry already holds that
real history — imported on 2026-11-11 and labelled as imported, not dressed up as live calls:

> **The tracked channel's real record, now impossible to cherry-pick: 24 scored calls,
> 23.95% hit rate across 96 horizon outcomes, average return −22.2% — and at the 24h horizon,
> only 3 of the first 24 tracked calls won.** Proof cuts both ways. That is the product.

Alongside the imported history sits **call #24 (BONK, Solana)** — registered *live* through the
same flow any caller uses (wallet signs → contract timestamps → oracle writes the DexScreener
entry → outcomes land on schedule).

## Try it

- **App (GitHub Pages):** https://jusst01.github.io/proof-of-call/
  Leaderboard, caller profiles with per-horizon outcome ladders, the full call feed, and a
  register-a-call form (NEAR testnet wallet — Meteor / MyNearWallet).
- **Contract (NEAR testnet):**
  [`proofofcall.opengraspdev.testnet`](https://testnet.nearblocks.io/address/proofofcall.opengraspdev.testnet)
  · owner `jusst1.testnet` · oracle `opengraspdev.testnet`

## How it works

| Step | What happens | Who can cheat? |
|---|---|---|
| **Register** | Caller signs `register_call(chain, token_ref, direction)`. Contract stores the signer + block timestamp and mints a receipt NFT (`call-<id>`) to the caller. | Nobody — the record is the block. |
| **Entry price** | The oracle fetches the price from DexScreener at registration time and writes it via `set_entry_price`. Stored **verbatim**, as the public source reported it. | Only the oracle writes — and a wrong price is a public, permanent, attributable error anyone can check against the source. |
| **Scoring** | At fixed horizons (15m / 1h / 6h / 24h — no discretion about *when* a call is judged) the oracle records the exit price (verbatim) + `return_bps`, signed basis points **from the caller's perspective** (a short profits when price falls). One outcome per horizon, append-only. | The arithmetic is recomputable by anyone from the two stored prices and the stated direction. |
| **Profiles** | `get_caller_stats` aggregates totals, hit rate, avg/best return, and a per-horizon breakdown — a caller who is great at 15m scalps and terrible at 24h holds is visible as exactly that. | Aggregates are computed by the contract from the records, never self-reported. |

### Oracle trust doctrine (radical transparency)

The oracle is a trusted writer — it alone can set entry prices and record outcomes (the oracle
account is set at init and changeable only by the owner, on-chain, in public). Trust is bounded
by making cheating **detectable**, not by asking for faith: the price source is public, prices
are stored as the source's own strings, horizons are fixed constants, and the method is this
document plus the open oracle code in [`oracle/`](oracle/). The oracle's own record is on trial
with every call it scores.

## Why NEAR

Registering a call must cost cents and confirm in seconds, at the moment the caller sees the
setup. NEAR gives sub-cent fees, fast finality, and human-readable caller accounts —
`caller.near` *is* the caller's brand. On L1 Ethereum, the registration fee alone would exceed
most callers' willingness to prove anything.

## Repository layout

- [`SPEC.md`](SPEC.md) — full product spec (problem, mechanics, moat, demo flow, submission checklist).
- [`contract/`](contract/) — Rust contract (near-sdk 5): register / oracle entry+outcome /
  minimal NEP-171 receipt / stats views, with unit tests. [`contract/README.md`](contract/README.md)
  documents the as-built API and what was deliberately trimmed from the NFT standard, and why.
- [`oracle/`](oracle/) — the Python oracle (DexScreener → contract, idempotent) plus the seed
  pipeline that imported the tracked channel's real history. [`oracle/README.md`](oracle/README.md)
  has run instructions and full data provenance.
- [`index.html`](index.html) + [`app/`](app/) — the static web app (no build step): leaderboard,
  profiles, feed, register-a-call with NEAR Wallet Selector. Reads via
  `https://test.rpc.fastnear.com` view calls; fails soft if wallet CDNs are unreachable.

## Run the oracle

```bash
cd oracle
python3 oracle.py            # add --dry-run to preview writes
```

It scans all calls: sets DexScreener entry prices for `pending_entry` calls and records outcomes
for every matured horizon. Safe to re-run at any time.

## Roadmap

- **Multi-channel leaderboard** — a second tracked channel (a high-frequency trading diary,
  ~18 posts/day) is already wired into the same listener/tracker; its record imports next,
  turning the leaderboard into a cross-channel comparison no caller can opt out of retroactively.
- **Caller self-registration** — push registration into the caller's own flow (register the call
  where you make it), so the registry grows beyond imported channels.
- **Follower views** — per-caller horizon filters, token/chain breakdowns, and exportable
  profile cards ("here is my Proof of Call") for callers to attach to their own posts.
- **Mainnet** — same contract, real stakes: receipts as collectible proof, oracle set expanded
  toward independent price sources with cross-checks.

---

*Built for the NEAR Hackathon (tracks: social + open) by Jallu / jusst. Testnet throughout:
calling is free — the record is real.*
