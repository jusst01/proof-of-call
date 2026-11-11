# Proof of Call — SPEC

**One-liner:** Callers register trading calls on-chain on NEAR *before* the move; an oracle
fetches the real entry price and scores the outcome at fixed horizons. Every call becomes a
permanent, unforgeable track record — "show me your Proof of Call" before you ape.

**Context:** NEAR Hackathon slot-2 project (slot 1 = OpenGrasp, submitted, frozen).
Dev deadline **2026-11-15 06:59 WIB**. Tracks: **social + open** *(flagged — Jallu to confirm)*.

---

## 1. Problem

Alpha-call culture (Telegram channels, X callers) runs on unverifiable claims:

- Calls get **deleted** when wrong, **edited** after the fact, and screenshotted selectively.
- Bad callers rebrand and restart at zero; good callers have **no way to prove** a record.
- Followers size real money on track records that are, at best, a caller's own marketing.

Screenshots are not evidence. What is missing is a timestamp nobody can forge and a score
nobody can cherry-pick.

## 2. Product

### 2.1 Register a call (on-chain, immutable)
A caller calls `register_call(chain, token_ref, direction)` on the NEAR contract:
- `chain` — where the token trades (`solana`, `bsc`, `base`, `ethereum`, …)
- `token_ref` — contract address / mint of the called token
- `direction` — `long` or `short`
- The contract stores **caller = the signing account** and **block timestamp**. That pair is
  the proof: the call existed at that moment, made by that account. It cannot be backdated,
  edited, or deleted.

### 2.2 Entry price is never caller-supplied
The caller does **not** state an entry price (that is the oldest cheat in the genre).
The **oracle** fetches the price from **DexScreener** at registration time and writes it via
`set_entry_price`. The price is stored **verbatim as the public source reported it** (string),
so anyone can compare it against the source tick-for-tick.

### 2.3 Fixed-horizon scoring
The oracle scores every call at **15m / 1h / 6h / 24h** after entry — the exact snapshot
cadence of Jallu's existing tg-tracker — and writes each result via `record_outcome`:
exit price (verbatim) + `return_bps` (signed basis points, **from the caller's perspective**:
a `short` profits when price falls; the oracle does that one piece of arithmetic, in the open,
from the two published prices). One outcome per horizon; outcomes are append-only and a
horizon cannot be re-recorded — the record is the record.

### 2.4 NFT receipt per call
At registration the contract mints **one receipt NFT** (minimal NEP-171) to the caller,
token id `call-<id>`, metadata referencing the call (chain, token, direction, timestamp).
The receipt is minted *at call time* — it is the portable proof of **when** the call was made;
the outcome history lives on the call record it points to.

### 2.5 Public profiles + leaderboard
Views anyone (or any UI) can read:
- `get_call(id)` — the full record: caller, timestamp, entry, all horizon outcomes.
- `get_calls_by_caller(account)` / `get_recent_calls(limit)` — the raw material of a profile page.
- `get_caller_stats(account)` — aggregates: total calls, scored outcomes, wins,
  **hit rate**, **average return**, **best call**, and **per-horizon consistency**
  (hit rate + average return broken out for 15m / 1h / 6h / 24h — a caller who is great at
  15m scalps and terrible at 24h holds is *visible as exactly that*).
Leaderboards are computed from these on-chain records; nothing is self-reported.

## 3. Oracle trust doctrine (radical transparency — same as OpenGrasp)

The oracle is a trusted writer (it alone can set entry prices / record outcomes; the oracle
account is set at init and changeable by the owner, on-chain, in public). Trust is bounded
by making cheating **detectable**, not by asking for faith:

- **Price source is public** (DexScreener) and the stored prices are the source's own strings.
- **Horizons are fixed constants** — no discretion about *when* a call is judged.
- **The method is this document + open oracle code**; `return_bps` is recomputable by anyone
  from the two stored prices and the stated direction.
- Any wrong price or score is a public, permanent, attributable error — the oracle's own
  record is on trial with every call it scores.

## 4. The moat (why us, why now)

The scoring engine already exists and is **live**: a Telegram listener + DexScreener tracker
(VPS .102, running since 2026-11-03) already logs real channel calls and snapshots prices at
entry / 15m / 1h / 6h / 24h. Proof of Call points that cadence at an on-chain registry.
Competitors demo with mock data; our demo scores **real calls from a real dataset**.
(Integration of the live tracker as the oracle is step 2 — not part of the contract MVP.)

## 5. Why NEAR

Registering a call must cost cents and confirm in seconds, at the moment the caller sees the
setup — NEAR gives sub-cent fees and fast finality, plus human-readable caller accounts
(`caller.near` *is* the caller's brand). On L1 Ethereum the registration fee alone would
exceed most callers' willingness to prove anything.

## 6. MVP scope

**In:** this spec; the Rust contract (register / oracle entry+outcome / NFT receipt / views /
unit tests, wasm built); a static web app (register a call, caller profile, leaderboard)
reading the contract; oracle integration with the existing tracker cadence; seed/demo data
from the existing 8-day dataset of real scored calls.

**Out (post-hackathon):** multi-channel automatic ingestion, follower/copy-trade execution,
caller subscriptions, mainnet migration, full NEP-171 approvals/enumeration polish
(see contract README for the exact NFT trims), storage-deposit charging (MVP: contract
account covers storage).

## 7. Demo flow (for the X demo post)

1. Connect wallet → register a **live call** on a real token → receipt NFT lands in-wallet;
   contract shows the block timestamp. Entry price appears moments later, written by the
   oracle from DexScreener — *not typed by the caller*.
2. Cut to **matured calls from the real 8-day dataset**: full outcome ladders at
   15m/1h/6h/24h, wins and losses alike — the losses are the pitch.
3. Caller profile + **leaderboard**: hit rate, average return, per-horizon consistency,
   all read from on-chain records. Close: "Don't trust callers. Verify them."

## 8. Submission checklist (mirrors OpenGrasp's)

- [ ] Public GitHub repo (this project), README with the method (§3) front and centre
- [ ] Contract deployed to NEAR **testnet**; explorer link in README
- [ ] Hosted web app (GitHub Pages) connected to the testnet contract
- [ ] X demo post **by Jallu himself** tagging @NEARProtocol + #NEARHackathon (demoUrl)
- [ ] Application via POST `https://nearhackathon.com/api/applications`, JSON only:
      projectName, leadName `Jallu`, email, size `1`, tracks `["social","open"]` *(confirm)*,
      nearAddress **`jusst1.near`** (mainnet, lowercase), projectUrl = repo, demoUrl = X post,
      idea (20–2000 chars), consent = true, requestId generated once and reused on retries
- [ ] ⚠️ **`website` field MUST stay empty** — any non-empty value is a spam trap and rejects
- [ ] Print the full payload and get Jallu's explicit yes before sending; on error use
      /request-changes — **never resubmit** (409 = already submitted / 2-project limit)
- [ ] Deadline: **2026-11-15 06:59 WIB**; this is project #2 of max 2 for Jallu
