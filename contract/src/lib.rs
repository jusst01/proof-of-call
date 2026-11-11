// Proof of Call — NEAR testnet contract, v0 (hackathon MVP).
//
// Callers register trading calls on-chain (token + chain + direction); the
// block timestamp + signing account are the unforgeable proof of WHEN and WHO.
// Entry prices are NEVER caller-supplied: an oracle account fetches the price
// from DexScreener at registration time and writes it here verbatim (string,
// exactly as the public source reported it — memecoin prices need more
// precision than fixed-point types give, and verbatim storage lets anyone
// audit the oracle against the source). The oracle then scores each call at
// fixed horizons (15m / 1h / 6h / 24h) with exit price + return_bps, where
// return_bps is from the CALLER's perspective (a short profits on a fall).
// Every registration mints one minimal NEP-171 receipt NFT to the caller.
//
// Toolchain notes carried over from OpenGrasp (near-sdk 5.x): borsh is a
// DIRECT dependency (derive macros panic otherwise) and store reads use the
// Option<&V> API with .cloned() when an owned value is mutated/re-inserted.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::store::{LookupMap, UnorderedMap};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

/// The only horizons the oracle may score, in order. Fixed by design:
/// no discretion about when a call is judged (see SPEC.md §3).
pub const HORIZONS: [&str; 4] = ["15m", "1h", "6h", "24h"];

fn horizon_index(h: &str) -> Option<usize> {
    HORIZONS.iter().position(|x| *x == h)
}

// ---------------------------------------------------------------- call record

#[derive(BorshSerialize, BorshDeserialize, Clone)]
#[near(serializers = [json])]
pub struct Outcome {
    /// One of HORIZONS.
    pub horizon: String,
    /// Exit price, verbatim string from the public price source.
    pub exit_price: String,
    /// Signed return in basis points, from the caller's perspective.
    pub return_bps: i64,
    /// Block timestamp (ns) when the oracle recorded this outcome.
    pub recorded_at_ns: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
#[near(serializers = [json])]
pub struct Call {
    pub id: u64,
    pub caller: AccountId,
    /// Chain the token trades on, e.g. "solana", "bsc", "base", "ethereum".
    pub chain: String,
    /// Contract address / mint of the called token.
    pub token_ref: String,
    /// "long" or "short".
    pub direction: String,
    /// Block timestamp (ns) of registration — the proof of when.
    pub registered_at_ns: u64,
    /// Oracle-written entry price (verbatim source string); None until set.
    pub entry_price: Option<String>,
    /// Block timestamp (ns) when the entry price was written.
    pub entry_set_at_ns: Option<u64>,
    /// "pending_entry" -> "open" (entry set) -> "scored" (>= 1 outcome).
    pub status: String,
    /// Append-only outcome ladder, at most one entry per horizon.
    pub outcomes: Vec<Outcome>,
    /// Receipt NFT token id minted to the caller at registration.
    pub receipt_token_id: String,
}

// ------------------------------------------------------------- NFT (minimal)

#[derive(BorshSerialize, BorshDeserialize, Clone, Default)]
#[near(serializers = [json])]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub reference: Option<String>,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
#[near(serializers = [json])]
pub struct Token {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
}

// ------------------------------------------------------------------- stats

#[derive(Clone, Default)]
#[near(serializers = [json])]
pub struct HorizonStats {
    pub horizon: String,
    pub outcomes: u64,
    pub wins: u64,
    pub hit_rate_bps: u64,
    pub avg_return_bps: i64,
}

#[derive(Clone, Default)]
#[near(serializers = [json])]
pub struct CallerStats {
    pub total_calls: u64,
    /// Calls with at least one recorded outcome.
    pub scored_calls: u64,
    pub total_outcomes: u64,
    pub wins: u64,
    pub hit_rate_bps: u64,
    pub avg_return_bps: i64,
    /// Best single-outcome return; 0 when nothing scored yet.
    pub best_return_bps: i64,
    pub per_horizon: Vec<HorizonStats>,
}

// ---------------------------------------------------------------- contract

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner: AccountId,
    pub oracle: AccountId,
    pub next_call_id: u64,
    pub calls: UnorderedMap<u64, Call>,
    pub calls_by_caller: LookupMap<AccountId, Vec<u64>>,
    // Minimal NEP-171 receipt storage.
    pub tokens: UnorderedMap<String, Token>,
    pub tokens_by_owner: LookupMap<AccountId, Vec<String>>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, oracle: AccountId) -> Self {
        Self {
            owner,
            oracle,
            next_call_id: 0,
            calls: UnorderedMap::new(b"c"),
            calls_by_caller: LookupMap::new(b"u"),
            tokens: UnorderedMap::new(b"t"),
            tokens_by_owner: LookupMap::new(b"o"),
        }
    }

    // ------------------------------------------------------------ mutators

    /// Register a call. The caller is the signer; the block timestamp is the
    /// proof. Mints the receipt NFT. Returns the new call id.
    pub fn register_call(&mut self, chain: String, token_ref: String, direction: String) -> u64 {
        require!(
            direction == "long" || direction == "short",
            "direction must be \"long\" or \"short\""
        );
        require!(!chain.is_empty() && chain.len() <= 32, "chain must be 1..=32 chars");
        require!(
            !token_ref.is_empty() && token_ref.len() <= 128,
            "token_ref must be 1..=128 chars"
        );
        let caller = env::predecessor_account_id();
        let id = self.next_call_id;
        self.next_call_id += 1;
        let receipt_token_id = format!("call-{id}");
        let call = Call {
            id,
            caller: caller.clone(),
            chain: chain.clone(),
            token_ref: token_ref.clone(),
            direction: direction.clone(),
            registered_at_ns: env::block_timestamp(),
            entry_price: None,
            entry_set_at_ns: None,
            status: "pending_entry".to_string(),
            outcomes: Vec::new(),
            receipt_token_id: receipt_token_id.clone(),
        };
        self.calls.insert(id, call);

        let mut ids = self.calls_by_caller.get(&caller).cloned().unwrap_or_default();
        ids.push(id);
        self.calls_by_caller.insert(caller.clone(), ids);

        // Receipt NFT: minted at call time — proof of WHEN, portable.
        let metadata = TokenMetadata {
            title: Some(format!("Proof of Call #{id}")),
            description: Some(format!(
                "{direction} call on {token_ref} ({chain}), registered on-chain at block \
                 timestamp; outcomes are scored by the oracle at 15m/1h/6h/24h. Full record: \
                 get_call({id}) on this contract."
            )),
            media: None,
            reference: Some(format!("call:{id}")),
        };
        self.mint_receipt(receipt_token_id, caller, metadata);
        id
    }

    /// Oracle-only: write the entry price fetched from the public source.
    pub fn set_entry_price(&mut self, call_id: u64, price: String) {
        self.assert_oracle();
        require!(!price.is_empty() && price.len() <= 64, "price must be 1..=64 chars");
        let mut call = self.get_call_or_panic(call_id);
        require!(call.entry_price.is_none(), "entry price already set");
        call.entry_price = Some(price);
        call.entry_set_at_ns = Some(env::block_timestamp());
        call.status = "open".to_string();
        self.calls.insert(call_id, call);
    }

    /// Oracle-only: append the outcome for one horizon. One per horizon, ever.
    pub fn record_outcome(
        &mut self,
        call_id: u64,
        horizon: String,
        exit_price: String,
        return_bps: i64,
    ) {
        self.assert_oracle();
        require!(horizon_index(&horizon).is_some(), "horizon must be one of 15m, 1h, 6h, 24h");
        require!(
            !exit_price.is_empty() && exit_price.len() <= 64,
            "exit_price must be 1..=64 chars"
        );
        let mut call = self.get_call_or_panic(call_id);
        require!(call.entry_price.is_some(), "entry price not set yet");
        require!(
            call.outcomes.iter().all(|o| o.horizon != horizon),
            "outcome already recorded for this horizon"
        );
        call.outcomes.push(Outcome {
            horizon,
            exit_price,
            return_bps,
            recorded_at_ns: env::block_timestamp(),
        });
        call.status = "scored".to_string();
        self.calls.insert(call_id, call);
    }

    /// Owner-only: re-point the oracle (public, on-chain — see SPEC.md §3).
    pub fn set_oracle(&mut self, new_oracle: AccountId) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner can change the oracle"
        );
        self.oracle = new_oracle;
    }

    // ------------------------------------------------------- NFT core (min.)
    // Minimal NEP-171: mint (internal, at registration), nft_token,
    // nft_tokens_for_owner, nft_total_supply, nft_transfer. Trimmed vs the
    // full standard: no approvals (nft_approve / nft_is_approved), no
    // nft_transfer_call + resolution callbacks, no payout/royalty handling,
    // no metadata contract standard. See contract README.

    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, memo: Option<String>) {
        require!(
            env::attached_deposit().as_yoctonear() == 1,
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        let sender = env::predecessor_account_id();
        let mut token = self
            .tokens
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("token not found"));
        require!(token.owner_id == sender, "only the token owner can transfer");
        require!(receiver_id != sender, "cannot transfer to self");
        token.owner_id = receiver_id.clone();
        self.tokens.insert(token_id.clone(), token);

        let mut from = self.tokens_by_owner.get(&sender).cloned().unwrap_or_default();
        from.retain(|t| t != &token_id);
        self.tokens_by_owner.insert(sender, from);
        let mut to = self.tokens_by_owner.get(&receiver_id).cloned().unwrap_or_default();
        to.push(token_id);
        self.tokens_by_owner.insert(receiver_id, to);
        let _ = memo;
    }

    // --------------------------------------------------------------- views

    pub fn get_call(&self, id: u64) -> Option<Call> {
        self.calls.get(&id).cloned()
    }

    pub fn get_calls_by_caller(&self, account: AccountId) -> Vec<Call> {
        let ids = self.calls_by_caller.get(&account).cloned().unwrap_or_default();
        ids.iter()
            .filter_map(|id| self.calls.get(id).cloned())
            .collect()
    }

    /// Most recent calls first, newest registration last-id first.
    pub fn get_recent_calls(&self, limit: u64) -> Vec<Call> {
        let limit = limit.min(100) as u64;
        let mut out = Vec::new();
        let mut id = self.next_call_id;
        while id > 0 && (out.len() as u64) < limit {
            id -= 1;
            if let Some(call) = self.calls.get(&id).cloned() {
                out.push(call);
            }
        }
        out
    }

    /// Aggregates over every outcome ever recorded for this caller.
    /// Returns are the stored return_bps values (caller-perspective).
    pub fn get_caller_stats(&self, account: AccountId) -> CallerStats {
        let ids = self.calls_by_caller.get(&account).cloned().unwrap_or_default();
        let mut stats = CallerStats {
            total_calls: ids.len() as u64,
            ..Default::default()
        };
        let mut sum: i64 = 0;
        let mut per: Vec<(u64, u64, i64)> = vec![(0, 0, 0); HORIZONS.len()]; // (n, wins, sum)
        for id in &ids {
            let Some(call) = self.calls.get(id).cloned() else { continue };
            if !call.outcomes.is_empty() {
                stats.scored_calls += 1;
            }
            for o in &call.outcomes {
                stats.total_outcomes += 1;
                sum += o.return_bps;
                if o.return_bps > 0 {
                    stats.wins += 1;
                }
                if stats.total_outcomes == 1 || o.return_bps > stats.best_return_bps {
                    stats.best_return_bps = o.return_bps;
                }
                if let Some(i) = horizon_index(&o.horizon) {
                    per[i].0 += 1;
                    if o.return_bps > 0 {
                        per[i].1 += 1;
                    }
                    per[i].2 += o.return_bps;
                }
            }
        }
        if stats.total_outcomes > 0 {
            stats.hit_rate_bps = stats.wins * 10_000 / stats.total_outcomes;
            stats.avg_return_bps = sum / stats.total_outcomes as i64;
        }
        stats.per_horizon = HORIZONS
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let (n, w, s) = per[i];
                HorizonStats {
                    horizon: h.to_string(),
                    outcomes: n,
                    wins: w,
                    hit_rate_bps: if n > 0 { w * 10_000 / n } else { 0 },
                    avg_return_bps: if n > 0 { s / n as i64 } else { 0 },
                }
            })
            .collect();
        stats
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_oracle(&self) -> AccountId {
        self.oracle.clone()
    }

    pub fn get_call_count(&self) -> u64 {
        self.next_call_id
    }

    // ------------------------------------------------------------ NFT views

    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        self.tokens.get(&token_id).cloned()
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId) -> Vec<Token> {
        let ids = self.tokens_by_owner.get(&account_id).cloned().unwrap_or_default();
        ids.iter()
            .filter_map(|t| self.tokens.get(t).cloned())
            .collect()
    }

    pub fn nft_total_supply(&self) -> u64 {
        self.tokens.len() as u64
    }

    // ------------------------------------------------------------- helpers

    fn assert_oracle(&self) {
        require!(
            env::predecessor_account_id() == self.oracle,
            "only the oracle can write prices and outcomes"
        );
    }

    fn get_call_or_panic(&self, call_id: u64) -> Call {
        self.calls
            .get(&call_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("call not found"))
    }

    fn mint_receipt(&mut self, token_id: String, owner: AccountId, metadata: TokenMetadata) {
        let token = Token {
            token_id: token_id.clone(),
            owner_id: owner.clone(),
            metadata,
        };
        self.tokens.insert(token_id.clone(), token);
        let mut owned = self.tokens_by_owner.get(&owner).cloned().unwrap_or_default();
        owned.push(token_id.clone());
        self.tokens_by_owner.insert(owner.clone(), owned);
        // NEP-171 mint event, so indexers/explorers see the receipt.
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"nep171\",\"version\":\"1.0.0\",\"event\":\"nft_mint\",\
             \"data\":[{{\"owner_id\":\"{owner}\",\"token_ids\":[\"{token_id}\"]}}]}}"
        ));
    }
}

// ------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    const TS: u64 = 1_700_000_000_000_000_000; // ns

    fn ctx(predecessor: AccountId) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(predecessor)
            .block_timestamp(TS)
            .attached_deposit(NearToken::from_yoctonear(0));
        b
    }

    fn contract() -> Contract {
        // owner = alice (accounts(0)), oracle = bob (accounts(1))
        Contract::new(accounts(0), accounts(1))
    }

    /// alice registers; bob (oracle) sets entry; helper returning call id.
    fn registered_with_entry(c: &mut Contract) -> u64 {
        testing_env!(ctx(accounts(2)).build()); // charlie calls
        let id = c.register_call(
            "solana".into(),
            "So11111111111111111111111111111111111111112".into(),
            "long".into(),
        );
        testing_env!(ctx(accounts(1)).build());
        c.set_entry_price(id, "0.00001234".into());
        id
    }

    #[test]
    fn register_stores_caller_and_timestamp_and_mints_receipt() {
        let mut c = contract();
        testing_env!(ctx(accounts(2)).build());
        let id = c.register_call("bsc".into(), "0xabc".into(), "short".into());
        assert_eq!(id, 0);
        let call = c.get_call(id).expect("call stored");
        assert_eq!(call.caller, accounts(2));
        assert_eq!(call.registered_at_ns, TS);
        assert_eq!(call.status, "pending_entry");
        assert!(call.entry_price.is_none());
        assert!(call.outcomes.is_empty());
        // Receipt NFT minted to the caller.
        let token = c.nft_token("call-0".into()).expect("receipt exists");
        assert_eq!(token.owner_id, accounts(2));
        assert_eq!(c.nft_tokens_for_owner(accounts(2)).len(), 1);
        assert_eq!(c.nft_total_supply(), 1);
        // Indexed under the caller.
        assert_eq!(c.get_calls_by_caller(accounts(2)).len(), 1);
        assert_eq!(c.get_calls_by_caller(accounts(3)).len(), 0);
    }

    #[test]
    #[should_panic(expected = "direction must be")]
    fn register_rejects_bad_direction() {
        let mut c = contract();
        testing_env!(ctx(accounts(2)).build());
        c.register_call("solana".into(), "mint".into(), "sideways".into());
    }

    #[test]
    #[should_panic(expected = "only the oracle")]
    fn non_oracle_cannot_set_entry_price() {
        let mut c = contract();
        testing_env!(ctx(accounts(2)).build());
        let id = c.register_call("solana".into(), "mint".into(), "long".into());
        testing_env!(ctx(accounts(2)).build()); // caller is not the oracle
        c.set_entry_price(id, "1.0".into());
    }

    #[test]
    #[should_panic(expected = "only the oracle")]
    fn non_oracle_cannot_record_outcome() {
        let mut c = contract();
        let id = registered_with_entry(&mut c);
        testing_env!(ctx(accounts(0)).build()); // even the owner is not the oracle
        c.record_outcome(id, "15m".into(), "0.5".into(), 100);
    }

    #[test]
    fn outcomes_append_per_horizon() {
        let mut c = contract();
        let id = registered_with_entry(&mut c);
        testing_env!(ctx(accounts(1)).build());
        c.record_outcome(id, "15m".into(), "0.00001300".into(), 535);
        c.record_outcome(id, "1h".into(), "0.00001100".into(), -1085);
        let call = c.get_call(id).unwrap();
        assert_eq!(call.status, "scored");
        assert_eq!(call.entry_price.as_deref(), Some("0.00001234"));
        assert_eq!(call.outcomes.len(), 2);
        assert_eq!(call.outcomes[0].horizon, "15m");
        assert_eq!(call.outcomes[0].return_bps, 535);
        assert_eq!(call.outcomes[1].horizon, "1h");
        assert_eq!(call.outcomes[1].return_bps, -1085);
    }

    #[test]
    #[should_panic(expected = "already recorded for this horizon")]
    fn duplicate_horizon_rejected() {
        let mut c = contract();
        let id = registered_with_entry(&mut c);
        testing_env!(ctx(accounts(1)).build());
        c.record_outcome(id, "15m".into(), "1".into(), 1);
        c.record_outcome(id, "15m".into(), "2".into(), 2);
    }

    #[test]
    #[should_panic(expected = "entry price not set yet")]
    fn outcome_before_entry_rejected() {
        let mut c = contract();
        testing_env!(ctx(accounts(2)).build());
        let id = c.register_call("solana".into(), "mint".into(), "long".into());
        testing_env!(ctx(accounts(1)).build());
        c.record_outcome(id, "15m".into(), "1".into(), 1);
    }

    #[test]
    fn stats_aggregate_correctly() {
        let mut c = contract();
        let id = registered_with_entry(&mut c); // caller = charlie
        // Second call, also charlie's.
        testing_env!(ctx(accounts(2)).build());
        let id2 = c.register_call("base".into(), "0xtoken".into(), "short".into());
        testing_env!(ctx(accounts(1)).build());
        c.set_entry_price(id2, "2.50".into());
        c.record_outcome(id, "15m".into(), "x".into(), 1000); // win
        c.record_outcome(id, "1h".into(), "x".into(), -500); // loss
        c.record_outcome(id2, "15m".into(), "x".into(), 300); // win
        c.record_outcome(id2, "24h".into(), "x".into(), 200); // win

        let s = c.get_caller_stats(accounts(2));
        assert_eq!(s.total_calls, 2);
        assert_eq!(s.scored_calls, 2);
        assert_eq!(s.total_outcomes, 4);
        assert_eq!(s.wins, 3);
        assert_eq!(s.hit_rate_bps, 7500); // 75%
        assert_eq!(s.avg_return_bps, 250); // (1000-500+300+200)/4
        assert_eq!(s.best_return_bps, 1000);
        let h15 = &s.per_horizon[0];
        assert_eq!(h15.horizon, "15m");
        assert_eq!(h15.outcomes, 2);
        assert_eq!(h15.wins, 2);
        assert_eq!(h15.hit_rate_bps, 10_000);
        assert_eq!(h15.avg_return_bps, 650);
        let h24 = &s.per_horizon[3];
        assert_eq!(h24.outcomes, 1);
        assert_eq!(h24.avg_return_bps, 200);
        // A caller with nothing has clean zeros.
        let z = c.get_caller_stats(accounts(4));
        assert_eq!(z.total_calls, 0);
        assert_eq!(z.hit_rate_bps, 0);
        assert_eq!(z.avg_return_bps, 0);
    }

    #[test]
    fn recent_calls_and_owner_only_oracle_change() {
        let mut c = contract();
        testing_env!(ctx(accounts(2)).build());
        c.register_call("solana".into(), "a".into(), "long".into());
        c.register_call("solana".into(), "b".into(), "long".into());
        let recent = c.get_recent_calls(10);
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].id, 1); // newest first
        // Oracle change: non-owner panics, owner succeeds.
        testing_env!(ctx(accounts(0)).build());
        c.set_oracle(accounts(3));
        assert_eq!(c.get_oracle(), accounts(3));
    }

    #[test]
    #[should_panic(expected = "only the owner can change the oracle")]
    fn non_owner_cannot_change_oracle() {
        let mut c = contract();
        testing_env!(ctx(accounts(1)).build());
        c.set_oracle(accounts(3));
    }
}
