# Proof of Call — oracle & seed

Contract: **proofofcall.opengraspdev.testnet** (testnet)
Owner: `jusst1.testnet` · Oracle/caller (MVP): `opengraspdev.testnet`
Explorer: https://testnet.nearblocks.io/address/proofofcall.opengraspdev.testnet

## Run the oracle (live mode)

```bash
cd ~/workspace/proof-of-call/oracle
python3 oracle.py            # add --dry-run to preview writes
```

Scans all calls: sets DexScreener entry prices for `pending_entry` calls and
records outcomes for matured 15m/1h/6h/24h horizons (caller-perspective bps).
Idempotent — safe to re-run any time. Writes go through near-cli-rs
(`npm install -g near-cli-rs` if a VM restart wiped it; v0.31.1).

## Seed (already done — historical import)

- `paper-source.jsonl` — read-only pull of `/root/tg-listener/paper.jsonl`
  from VPS .102 (`tg-tracker.service`, Pumpfun Callouts, since 2026-11-03).
- `extract_seed.py` → `seed-data.json`: 24 complete t0+15m/1h/6h/24h series,
  prices/outcomes verbatim from the tracker file.
- `seed.py` → registered them on-chain as calls 0–23 from the dev account and
  backfilled the recorded prices/outcomes. On-chain `registered_at` is the
  import time; original call times are `first_seen_ts` in `seed-data.json`.
  These are the tracked channel's imported history, NOT live-registered calls.
- Call 24 is a genuine live registration (BONK long, Solana) whose entry price
  the oracle set from live DexScreener data — the end-to-end live proof.

On-chain state after seeding: 25 calls, 24 scored, 96 outcomes;
`get_caller_stats(opengraspdev.testnet)`: hit rate 23.95%, avg −22.20%,
best +84.74% (the channel's real record — the product's point is that this
can no longer be hidden or cherry-picked).
