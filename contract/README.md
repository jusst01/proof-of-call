# Proof of Call — contract (NEAR, Rust / near-sdk 5)

Design lives in [`../SPEC.md`](../SPEC.md). This file is the as-built API reference.

## State

- `owner: AccountId` — set at init; only the owner can re-point the oracle.
- `oracle: AccountId` — set at init; the only account allowed to write entry
  prices and outcomes. Changing it is an owner call, recorded on-chain.
- `calls: Map<u64, Call>` — `Call { id, caller, chain, token_ref, direction,
  registered_at_ns, entry_price: Option<String>, entry_set_at_ns, status,
  outcomes: Vec<Outcome>, receipt_token_id }`;
  `Outcome { horizon, exit_price, return_bps, recorded_at_ns }`.
  Prices are stored as **verbatim strings from the public price source**
  (DexScreener): memecoin prices routinely need >18 significant decimals, and
  verbatim storage makes every oracle write auditable against the source.
  All arithmetic lives in `return_bps` (signed bps, caller-perspective).
- `calls_by_caller: Map<AccountId, Vec<u64>>` — profile index.
- Receipt NFTs: `tokens: Map<TokenId, Token>`, `tokens_by_owner: Map<AccountId, Vec<TokenId>>`.

## Methods

| Method | Who | Notes |
|---|---|---|
| `new(owner, oracle)` | deployer | `#[init]` |
| `register_call(chain, token_ref, direction) -> u64` | anyone | direction ∈ {long, short}; stores signer + block timestamp; mints receipt `call-<id>`; status `pending_entry` |
| `set_entry_price(call_id, price)` | **oracle only** | once only; status → `open` |
| `record_outcome(call_id, horizon, exit_price, return_bps)` | **oracle only** | horizon ∈ {15m, 1h, 6h, 24h}; requires entry set; one outcome per horizon, append-only; status → `scored` |
| `set_oracle(new_oracle)` | **owner only** | |
| `get_call(id) -> Option<Call>` | view | full record incl. outcome ladder |
| `get_calls_by_caller(account) -> Vec<Call>` | view | |
| `get_recent_calls(limit) -> Vec<Call>` | view | newest first, limit clamped to 100 |
| `get_caller_stats(account) -> CallerStats` | view | totals, hit_rate_bps, avg_return_bps, best_return_bps, per-horizon breakdown |
| `get_owner() / get_oracle() / get_call_count()` | view | |
| `nft_token(token_id)`, `nft_tokens_for_owner(account)`, `nft_total_supply()` | view | NEP-171 core views |
| `nft_transfer(receiver_id, token_id, memo)` | token owner | payable, exactly 1 yoctoNEAR |

## NFT receipt — what was trimmed, and why

The brief asked for a *minimal* NEP-171: one receipt per call, minted at
registration, so the caller holds portable proof of when the call was made.
The full standard's approval + callback machinery exists for marketplaces;
a receipt needs none of it to be real, transferable, and visible in wallets.

**Implemented:** `nft_token`, `nft_tokens_for_owner`, `nft_total_supply`,
`nft_transfer` (owner-only, 1-yocto convention), NEP-171 `nft_mint` event log
at issuance, per-token metadata (title / description / reference → `call:<id>`).

**Trimmed:** approvals (`nft_approve`, `nft_is_approved`, `nft_revoke*`),
`nft_transfer_call` + `nft_resolve_transfer`, payouts/royalties, the separate
NEP-177 metadata contract standard, storage-deposit registration (MVP: the
contract account funds storage; charging users is a mainnet concern).
Adding approvals later is additive — no state migration needed.

## Build & test

```bash
cargo test                                        # unit tests (host)
cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/proof_of_call.wasm .
```

Toolchain notes (hard-won on OpenGrasp, applied here): `borsh = "1"` is a
**direct** dependency (near-sdk derive macros fail without it), and store
reads use `.get()` → `Option<&V>` with `.cloned()` before mutation.
