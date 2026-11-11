//! # Sentinel Vault: give an AI agent money without giving it the keys
//!
//! An **owner** funds an allowance for an **agent account** and sets a policy:
//! a per-payment limit, a rolling 24-hour limit, and an optional list of allowed receivers.
//! The agent spends with `spend(owner_id, intent_id, receiver_id, amount)`, which takes **no deposit**,
//! so the agent can hold nothing but a NEAR *function-call access key* restricted to `spend` on this
//! contract. That key cannot transfer the agent's own funds, call other contracts, or exceed the policy.
//!
//! * Each `(owner, agent, intent_id)` pays **at most once** (`DUPLICATE_INTENT`), so a blind retry after an
//!   RPC timeout cannot double-pay.
//! * A failed transfer (for example, the receiver doesn't exist) restores the balance and the daily
//!   allowance and frees the intent.
//! * Only the owner can top up, change the policy, freeze/unfreeze, or withdraw.
//! * The contract itself has no admin and no upgrade method.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

/// Kept from the vault balance per spend, to pay for that spend's storage. Worst case (64-byte owner, agent,
/// receiver and intent id): spend record 338 bytes + window entry 253 bytes = 591 bytes = 0.00591 NEAR at
/// 1e19 yoctoNEAR/byte, so 0.006 NEAR always covers it (a unit test measures the real worst case).
pub const RECORD_FEE: NearToken = NearToken::from_millinear(6);
pub const MAX_INTENT_ID_LEN: usize = 64;
pub const MAX_ALLOWED_RECEIVERS: usize = 20;
pub const WINDOW_MS: u64 = 24 * 60 * 60 * 1000;
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const EVENT_STANDARD: &str = "sentinel_vault";
const EVENT_VERSION: &str = "1.0.0";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Policies,
    Spends,
    /// Which 24-hour window each in-flight spend was counted in (owner, agent, intent) -> window_start_ms.
    /// Kept outside the contract struct so the deployed state layout is unchanged.
    SpendWindows,
}

fn spend_windows() -> LookupMap<SpendKey, u64> {
    LookupMap::new(StorageKey::SpendWindows)
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Policy {
    pub balance: NearToken,
    pub per_payment_max: NearToken,
    pub daily_max: NearToken,
    pub spent_in_window: NearToken,
    pub window_start_ms: u64,
    /// Empty = any receiver.
    pub allowed_receivers: Vec<AccountId>,
    pub frozen: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PolicyView {
    pub owner_id: AccountId,
    pub agent_id: AccountId,
    pub balance: U128,
    pub per_payment_max: U128,
    pub daily_max: U128,
    /// Spent in the current 24-hour window (0 if the window has already rolled over).
    pub spent_in_window: U128,
    /// What the agent can still spend right now: min(per-payment limit, daily headroom, balance - record fee).
    pub available_now: U128,
    pub window_resets_at_ms: u64,
    pub allowed_receivers: Vec<AccountId>,
    pub frozen: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum SpendStatus {
    Pending,
    Paid,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct SpendRecord {
    pub receiver_id: AccountId,
    pub amount: NearToken,
    pub block_height: u64,
    pub status: SpendStatus,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SpendView {
    pub owner_id: AccountId,
    pub agent_id: AccountId,
    pub intent_id: String,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub block_height: u64,
    pub status: SpendStatus,
}

type PolicyKey = (AccountId, AccountId); // (owner, agent)
type SpendKey = (AccountId, AccountId, String); // (owner, agent, intent_id)

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    policies: LookupMap<PolicyKey, Policy>,
    spends: LookupMap<SpendKey, SpendRecord>,
}

fn validate_intent_id(intent_id: &str) {
    require!(!intent_id.is_empty(), "INVALID_INTENT_ID: must not be empty");
    require!(intent_id.len() <= MAX_INTENT_ID_LEN, "INVALID_INTENT_ID: longer than 64 bytes");
    require!(
        intent_id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':')),
        "INVALID_INTENT_ID: allowed characters are A-Z a-z 0-9 - _ . :"
    );
}

fn emit(event: &str, owner: &AccountId, agent: &AccountId, extra: &str) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"{EVENT_STANDARD}\",\"version\":\"{EVENT_VERSION}\",\"event\":\"{event}\",\"data\":[{{\"owner_id\":\"{owner}\",\"agent_id\":\"{agent}\"{extra}}}]}}"
    ));
}

fn tok(v: U128) -> NearToken {
    NearToken::from_yoctonear(v.0)
}

impl Policy {
    /// Roll the 24-hour window if it has expired.
    fn roll(&mut self, now_ms: u64) {
        if now_ms.saturating_sub(self.window_start_ms) >= WINDOW_MS {
            self.window_start_ms = now_ms;
            self.spent_in_window = NearToken::from_yoctonear(0);
        }
    }
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self { policies: LookupMap::new(StorageKey::Policies), spends: LookupMap::new(StorageKey::Spends) }
    }

    /// Create or update the policy for `agent_id` (caller = owner). Any attached deposit is added to the
    /// balance after paying for the storage the policy uses.
    #[payable]
    pub fn set_policy(&mut self, agent_id: AccountId, per_payment_max: U128, daily_max: U128, allowed_receivers: Vec<AccountId>) {
        let owner = env::predecessor_account_id();
        require!(per_payment_max.0 > 0, "INVALID_POLICY: per_payment_max must be > 0");
        require!(per_payment_max.0 <= daily_max.0, "INVALID_POLICY: per_payment_max must be <= daily_max");
        require!(allowed_receivers.len() <= MAX_ALLOWED_RECEIVERS, "INVALID_POLICY: at most 20 allowed receivers");
        require!(!allowed_receivers.contains(&env::current_account_id()), "INVALID_POLICY: the vault cannot be a receiver");

        let before = env::storage_usage();
        let key = (owner.clone(), agent_id.clone());
        let now = env::block_timestamp_ms();
        let mut p = self.policies.get(&key).cloned().unwrap_or(Policy {
            balance: NearToken::from_yoctonear(0),
            per_payment_max: tok(per_payment_max),
            daily_max: tok(daily_max),
            spent_in_window: NearToken::from_yoctonear(0),
            window_start_ms: now,
            allowed_receivers: vec![],
            frozen: false,
        });
        p.per_payment_max = tok(per_payment_max);
        p.daily_max = tok(daily_max);
        p.allowed_receivers = allowed_receivers;
        self.policies.insert(key.clone(), p);
        self.policies.flush();
        let grown = env::storage_usage().saturating_sub(before);
        let storage_cost = env::storage_byte_cost().saturating_mul(grown as u128);
        let deposit = env::attached_deposit();
        require!(deposit >= storage_cost, format!("INSUFFICIENT_DEPOSIT: attach at least {} yoctoNEAR for storage", storage_cost.as_yoctonear()));
        let p = self.policies.get_mut(&key).unwrap();
        p.balance = p.balance.saturating_add(deposit.saturating_sub(storage_cost));
        emit("policy_set", &owner, &agent_id, &format!(",\"per_payment_max\":\"{}\",\"daily_max\":\"{}\"", per_payment_max.0, daily_max.0));
    }

    /// Owner tops up the agent's balance.
    #[payable]
    pub fn deposit(&mut self, agent_id: AccountId) {
        let owner = env::predecessor_account_id();
        let p = self.policies.get_mut(&(owner.clone(), agent_id.clone())).unwrap_or_else(|| env::panic_str("NO_POLICY: create it with set_policy first"));
        p.balance = p.balance.saturating_add(env::attached_deposit());
        emit("deposit", &owner, &agent_id, &format!(",\"amount\":\"{}\"", env::attached_deposit().as_yoctonear()));
    }

    /// Owner stops (or resumes) all spending by this agent.
    pub fn set_frozen(&mut self, agent_id: AccountId, frozen: bool) {
        let owner = env::predecessor_account_id();
        let p = self.policies.get_mut(&(owner.clone(), agent_id.clone())).unwrap_or_else(|| env::panic_str("NO_POLICY"));
        p.frozen = frozen;
        emit(if frozen { "frozen" } else { "unfrozen" }, &owner, &agent_id, "");
    }

    /// Owner takes back up to the whole balance.
    pub fn withdraw(&mut self, agent_id: AccountId, amount: U128) -> Promise {
        let owner = env::predecessor_account_id();
        let key = (owner.clone(), agent_id.clone());
        let p = self.policies.get_mut(&key).unwrap_or_else(|| env::panic_str("NO_POLICY"));
        let amount = tok(amount);
        require!(amount.as_yoctonear() > 0 && amount <= p.balance, "INSUFFICIENT_VAULT_BALANCE");
        p.balance = p.balance.saturating_sub(amount);
        emit("withdraw", &owner, &agent_id, &format!(",\"amount\":\"{}\"", amount.as_yoctonear()));
        Promise::new(owner.clone())
            .transfer(amount)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_withdraw(owner, agent_id, U128(amount.as_yoctonear())))
    }

    /// Agent pays `amount` to `receiver_id` from the owner's allowance, at most once per intent.
    /// Takes no deposit, so a function-call access key limited to this method can call it.
    pub fn spend(&mut self, owner_id: AccountId, intent_id: String, receiver_id: AccountId, amount: U128) -> Promise {
        validate_intent_id(&intent_id);
        let agent = env::predecessor_account_id();
        let amount = tok(amount);
        require!(amount.as_yoctonear() > 0, "INVALID_AMOUNT: must be > 0");
        require!(receiver_id != env::current_account_id(), "INVALID_RECEIVER: cannot pay the vault itself");

        let spend_key = (owner_id.clone(), agent.clone(), intent_id.clone());
        if self.spends.contains_key(&spend_key) {
            env::panic_str(&format!("DUPLICATE_INTENT: {agent} already used intent_id {intent_id}"));
        }
        let now = env::block_timestamp_ms();
        let p = self.policies.get_mut(&(owner_id.clone(), agent.clone())).unwrap_or_else(|| env::panic_str("NO_POLICY: this owner has no policy for this agent"));
        require!(!p.frozen, "FROZEN: the owner has frozen this agent's spending");
        require!(p.allowed_receivers.is_empty() || p.allowed_receivers.contains(&receiver_id), "NOT_ALLOWED_RECEIVER: receiver is not on the owner's allowlist");
        require!(amount <= p.per_payment_max, "OVER_PER_PAYMENT_LIMIT");
        p.roll(now);
        require!(p.spent_in_window.saturating_add(amount) <= p.daily_max, "OVER_DAILY_LIMIT");
        let cost = amount.saturating_add(RECORD_FEE);
        require!(cost <= p.balance, "INSUFFICIENT_VAULT_BALANCE");
        p.balance = p.balance.saturating_sub(cost);
        p.spent_in_window = p.spent_in_window.saturating_add(amount);

        let window = p.window_start_ms;
        self.spends.insert(
            spend_key.clone(),
            SpendRecord { receiver_id: receiver_id.clone(), amount, block_height: env::block_height(), status: SpendStatus::Pending },
        );
        let mut windows = spend_windows();
        windows.insert(spend_key, window);
        windows.flush();
        emit("spend_recorded", &owner_id, &agent, &format!(",\"intent_id\":\"{intent_id}\",\"receiver_id\":\"{receiver_id}\",\"amount\":\"{}\"", amount.as_yoctonear()));
        Promise::new(receiver_id)
            .transfer(amount)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_spend(owner_id, agent, intent_id))
    }

    /// Callback: mark the spend paid, or release it and restore the balance and daily allowance.
    #[private]
    pub fn on_spend(&mut self, owner_id: AccountId, agent_id: AccountId, intent_id: String, #[callback_result] result: Result<(), PromiseError>) -> bool {
        let key = (owner_id.clone(), agent_id.clone(), intent_id.clone());
        let Some(rec) = self.spends.get(&key).cloned() else {
            return false;
        };
        let mut windows = spend_windows();
        let counted_in = windows.remove(&key);
        windows.flush();
        if result.is_ok() {
            self.spends.insert(key, SpendRecord { status: SpendStatus::Paid, ..rec });
            emit("spend_paid", &owner_id, &agent_id, &format!(",\"intent_id\":\"{intent_id}\""));
            true
        } else {
            // The failed transfer's amount came back to this contract: credit it (and the record fee) back.
            self.spends.remove(&key);
            if let Some(p) = self.policies.get_mut(&(owner_id.clone(), agent_id.clone())) {
                p.balance = p.balance.saturating_add(rec.amount.saturating_add(RECORD_FEE));
                // Give the allowance back only to the window the spend was counted in. If the 24-hour window
                // has rolled since, the old window's spending no longer matters and the new one must not be credited.
                if counted_in == Some(p.window_start_ms) {
                    p.spent_in_window = p.spent_in_window.saturating_sub(rec.amount);
                }
            }
            emit("spend_released", &owner_id, &agent_id, &format!(",\"intent_id\":\"{intent_id}\""));
            false
        }
    }

    /// Callback: if the withdrawal transfer failed, the amount came back; credit it to the balance again.
    #[private]
    pub fn on_withdraw(&mut self, owner_id: AccountId, agent_id: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) -> bool {
        if result.is_ok() {
            return true;
        }
        if let Some(p) = self.policies.get_mut(&(owner_id, agent_id)) {
            p.balance = p.balance.saturating_add(tok(amount));
        }
        false
    }

    pub fn get_policy(&self, owner_id: AccountId, agent_id: AccountId) -> Option<PolicyView> {
        let p = self.policies.get(&(owner_id.clone(), agent_id.clone()))?;
        let now = env::block_timestamp_ms();
        let rolled = now.saturating_sub(p.window_start_ms) >= WINDOW_MS;
        let spent = if rolled { NearToken::from_yoctonear(0) } else { p.spent_in_window };
        let headroom = p.daily_max.saturating_sub(spent);
        let spendable = p.balance.saturating_sub(RECORD_FEE);
        let available = if p.frozen { NearToken::from_yoctonear(0) } else { p.per_payment_max.min(headroom).min(spendable) };
        Some(PolicyView {
            owner_id,
            agent_id,
            balance: U128(p.balance.as_yoctonear()),
            per_payment_max: U128(p.per_payment_max.as_yoctonear()),
            daily_max: U128(p.daily_max.as_yoctonear()),
            spent_in_window: U128(spent.as_yoctonear()),
            available_now: U128(available.as_yoctonear()),
            window_resets_at_ms: if rolled { now } else { p.window_start_ms + WINDOW_MS },
            allowed_receivers: p.allowed_receivers.clone(),
            frozen: p.frozen,
        })
    }

    pub fn get_spend(&self, owner_id: AccountId, agent_id: AccountId, intent_id: String) -> Option<SpendView> {
        self.spends.get(&(owner_id.clone(), agent_id.clone(), intent_id.clone())).map(|r| SpendView {
            owner_id,
            agent_id,
            intent_id,
            receiver_id: r.receiver_id.clone(),
            amount: U128(r.amount.as_yoctonear()),
            block_height: r.block_height,
            status: r.status.clone(),
        })
    }

    pub fn record_fee(&self) -> U128 {
        U128(RECORD_FEE.as_yoctonear())
    }

    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
    use std::collections::HashMap;

    const DAY: u64 = WINDOW_MS;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn near(n: u128) -> NearToken {
        NearToken::from_near(n)
    }
    fn milli(n: u128) -> NearToken {
        NearToken::from_millinear(n)
    }
    fn u(t: NearToken) -> U128 {
        U128(t.as_yoctonear())
    }

    fn set(predecessor: &str, deposit: NearToken, ts_ms: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("vault.testnet"))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .attached_deposit(deposit)
            .block_height(1000)
            .block_timestamp(ts_ms * 1_000_000);
        testing_env!(b.build());
    }

    fn callback(result: PromiseResult, ts_ms: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("vault.testnet")).predecessor_account_id(acc("vault.testnet")).block_timestamp(ts_ms * 1_000_000);
        testing_env!(b.build(), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), HashMap::default(), vec![result]);
    }

    /// owner funds 10 NEAR for agent: 1 NEAR per payment, 2 NEAR per day, any receiver.
    fn setup(receivers: Vec<&str>) -> Contract {
        set("owner.testnet", near(10), 1_000);
        let mut c = Contract::new();
        c.set_policy(acc("agent.testnet"), u(near(1)), u(near(2)), receivers.into_iter().map(acc).collect());
        c
    }

    fn policy(c: &Contract) -> PolicyView {
        c.get_policy(acc("owner.testnet"), acc("agent.testnet")).unwrap()
    }

    #[test]
    fn set_policy_charges_storage_and_credits_the_rest() {
        let c = setup(vec![]);
        let p = policy(&c);
        assert!(p.balance.0 < near(10).as_yoctonear() && p.balance.0 > near(9).as_yoctonear(), "balance = deposit - storage");
        assert_eq!(p.per_payment_max, u(near(1)));
        assert_eq!(p.available_now, u(near(1)));
    }

    #[test]
    fn spend_within_limits_records_pending_and_debits() {
        let mut c = setup(vec![]);
        let before = policy(&c).balance.0;
        set("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        c.spend(acc("owner.testnet"), "order-1".into(), acc("shop.testnet"), u(milli(500)));
        let p = policy(&c);
        assert_eq!(p.balance.0, before - milli(500).as_yoctonear() - RECORD_FEE.as_yoctonear());
        assert_eq!(p.spent_in_window, u(milli(500)));
        let s = c.get_spend(acc("owner.testnet"), acc("agent.testnet"), "order-1".into()).unwrap();
        assert_eq!(s.status, SpendStatus::Pending);
    }

    #[test]
    #[should_panic(expected = "DUPLICATE_INTENT")]
    fn same_intent_twice_is_rejected() {
        let mut c = setup(vec![]);
        set("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        c.spend(acc("owner.testnet"), "order-1".into(), acc("shop.testnet"), u(milli(100)));
        c.spend(acc("owner.testnet"), "order-1".into(), acc("shop.testnet"), u(milli(100)));
    }

    #[test]
    #[should_panic(expected = "OVER_PER_PAYMENT_LIMIT")]
    fn over_per_payment_limit_is_rejected() {
        let mut c = setup(vec![]);
        set("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        c.spend(acc("owner.testnet"), "big".into(), acc("shop.testnet"), u(milli(1001)));
    }

    #[test]
    #[should_panic(expected = "OVER_DAILY_LIMIT")]
    fn over_daily_limit_is_rejected() {
        let mut c = setup(vec![]);
        set("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        c.spend(acc("owner.testnet"), "a".into(), acc("shop.testnet"), u(near(1)));
        c.spend(acc("owner.testnet"), "b".into(), acc("shop.testnet"), u(milli(900)));
        c.spend(acc("owner.testnet"), "c".into(), acc("shop.testnet"), u(milli(200)));
    }

    #[test]
    fn daily_window_rolls_over_after_24h() {
        let mut c = setup(vec![]);
        set("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        c.spend(acc("owner.testnet"), "a".into(), acc("shop.testnet"), u(near(1)));
        c.spend(acc("owner.testnet"), "b".into(), acc("shop.testnet"), u(near(1)));
        set("agent.testnet", NearToken::from_yoctonear(0), 1_000 + DAY);
        c.spend(acc("owner.testnet"), "c".into(), acc("shop.testnet"), u(near(1)));
        assert_eq!(policy(&c).spent_in_window, u(near(1)));
    }

    #[test]
    #[should_panic(expected = "NOT_ALLOWED_RECEIVER")]
    fn receiver_outside_allowlist_is_rejected() {
        let mut c = setup(vec!["shop.testnet"]);
        set("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        c.spend(acc("owner.testnet"), "x".into(), acc("attacker.testnet"), u(milli(10)));
    }

    #[test]
    #[should_panic(expected = "FROZEN")]
    fn frozen_agent_cannot_spend() {
        let mut c = setup(vec![]);
        set("owner.testnet", NearToken::from_yoctonear(0), 2_000);
        c.set_frozen(acc("agent.testnet"), true);
        assert_eq!(policy(&c).available_now, U128(0));
        set("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        c.spend(acc("owner.testnet"), "x".into(), acc("shop.testnet"), u(milli(10)));
    }

    #[test]
    #[should_panic(expected = "NO_POLICY")]
    fn another_account_cannot_spend_someone_elses_allowance() {
        let mut c = setup(vec![]);
        set("intruder.testnet", NearToken::from_yoctonear(0), 2_000);
        c.spend(acc("owner.testnet"), "x".into(), acc("shop.testnet"), u(milli(10)));
    }

    #[test]
    #[should_panic(expected = "NO_POLICY")]
    fn only_the_owner_can_withdraw() {
        let mut c = setup(vec![]);
        set("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        c.withdraw(acc("agent.testnet"), u(near(1)));
    }

    #[test]
    #[should_panic(expected = "INSUFFICIENT_VAULT_BALANCE")]
    fn cannot_spend_more_than_the_balance() {
        set("owner.testnet", NearToken::from_millinear(500), 1_000);
        let mut c = Contract::new();
        c.set_policy(acc("agent.testnet"), u(near(1)), u(near(2)), vec![]);
        set("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        c.spend(acc("owner.testnet"), "x".into(), acc("shop.testnet"), u(milli(499)));
    }

    #[test]
    fn failed_transfer_restores_balance_allowance_and_frees_the_intent() {
        let mut c = setup(vec![]);
        let before = policy(&c);
        set("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        c.spend(acc("owner.testnet"), "x".into(), acc("missing.testnet"), u(milli(400)));
        callback(PromiseResult::Failed, 2_000);
        assert!(!c.on_spend(acc("owner.testnet"), acc("agent.testnet"), "x".into(), Err(PromiseError::Failed)));
        let after = policy(&c);
        assert_eq!(after.balance, before.balance);
        assert_eq!(after.spent_in_window, U128(0));
        assert!(c.get_spend(acc("owner.testnet"), acc("agent.testnet"), "x".into()).is_none());
    }

    #[test]
    fn failed_transfer_after_the_window_rolled_does_not_credit_the_new_window() {
        // Daily limit 2, per payment 1. A spend counted at the end of window 1 fails AFTER window 2 started.
        let mut c = setup(vec![]);
        set("agent.testnet", NearToken::from_yoctonear(0), 1_000 + DAY - 1);
        c.spend(acc("owner.testnet"), "a".into(), acc("missing.testnet"), u(near(1)));
        set("agent.testnet", NearToken::from_yoctonear(0), 1_000 + DAY + 1);
        c.spend(acc("owner.testnet"), "b".into(), acc("shop.testnet"), u(near(1)));
        c.spend(acc("owner.testnet"), "c".into(), acc("shop.testnet"), u(near(1)));
        callback(PromiseResult::Failed, 1_000 + DAY + 2);
        c.on_spend(acc("owner.testnet"), acc("agent.testnet"), "a".into(), Err(PromiseError::Failed));
        let p = policy(&c);
        assert_eq!(p.spent_in_window, u(near(2)), "window 2 still has 2 NEAR spent");
        assert_eq!(p.available_now, U128(0));
    }

    #[test]
    #[should_panic(expected = "OVER_DAILY_LIMIT")]
    fn rollover_race_cannot_exceed_the_daily_limit() {
        let mut c = setup(vec![]);
        set("agent.testnet", NearToken::from_yoctonear(0), 1_000 + DAY - 1);
        c.spend(acc("owner.testnet"), "a".into(), acc("missing.testnet"), u(near(1)));
        set("agent.testnet", NearToken::from_yoctonear(0), 1_000 + DAY + 1);
        c.spend(acc("owner.testnet"), "b".into(), acc("shop.testnet"), u(near(1)));
        c.spend(acc("owner.testnet"), "c".into(), acc("shop.testnet"), u(near(1)));
        callback(PromiseResult::Failed, 1_000 + DAY + 2);
        c.on_spend(acc("owner.testnet"), acc("agent.testnet"), "a".into(), Err(PromiseError::Failed));
        set("agent.testnet", NearToken::from_yoctonear(0), 1_000 + DAY + 3);
        c.spend(acc("owner.testnet"), "d".into(), acc("shop.testnet"), u(near(1))); // would be a 3rd NEAR in window 2
    }

    #[test]
    fn record_fee_covers_the_largest_possible_spend() {
        let id64 = "a".repeat(64);
        let long = |p: &str| -> AccountId { format!("{p}{}", "x".repeat(64 - p.len())).parse().unwrap() };
        let (owner, agent, shop) = (long("o"), long("g"), long("s"));
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("vault.testnet")).predecessor_account_id(owner.clone()).attached_deposit(near(10)).block_timestamp(1_000_000_000);
        testing_env!(b.build());
        let mut c = Contract::new();
        c.set_policy(agent.clone(), u(near(1)), u(near(2)), vec![]);
        b.predecessor_account_id(agent.clone()).attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(b.build());
        let before = env::storage_usage();
        c.spend(owner.clone(), id64, shop, u(milli(1)));
        c.spends.flush();
        let used = env::storage_usage() - before;
        let cost = env::storage_byte_cost().saturating_mul(used as u128);
        assert!(cost <= RECORD_FEE, "worst-case spend uses {used} bytes = {} yocto > fee {}", cost.as_yoctonear(), RECORD_FEE.as_yoctonear());
    }

    #[test]
    fn successful_transfer_marks_paid() {
        let mut c = setup(vec![]);
        set("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        c.spend(acc("owner.testnet"), "x".into(), acc("shop.testnet"), u(milli(400)));
        callback(PromiseResult::Successful(vec![]), 2_000);
        assert!(c.on_spend(acc("owner.testnet"), acc("agent.testnet"), "x".into(), Ok(())));
        assert_eq!(c.get_spend(acc("owner.testnet"), acc("agent.testnet"), "x".into()).unwrap().status, SpendStatus::Paid);
    }

    #[test]
    #[should_panic(expected = "INVALID_POLICY")]
    fn per_payment_limit_cannot_exceed_daily_limit() {
        set("owner.testnet", near(1), 1_000);
        let mut c = Contract::new();
        c.set_policy(acc("agent.testnet"), u(near(3)), u(near(2)), vec![]);
    }

    #[test]
    #[should_panic(expected = "INVALID_INTENT_ID")]
    fn intent_ids_with_quotes_are_rejected() {
        let mut c = setup(vec![]);
        set("agent.testnet", NearToken::from_yoctonear(0), 2_000);
        c.spend(acc("owner.testnet"), "bad\"id".into(), acc("shop.testnet"), u(milli(10)));
    }

    #[test]
    fn owner_withdraw_debits_and_failed_withdraw_is_restored() {
        let mut c = setup(vec![]);
        let before = policy(&c).balance.0;
        set("owner.testnet", NearToken::from_yoctonear(0), 2_000);
        c.withdraw(acc("agent.testnet"), u(near(2)));
        assert_eq!(policy(&c).balance.0, before - near(2).as_yoctonear());
        callback(PromiseResult::Failed, 2_000);
        c.on_withdraw(acc("owner.testnet"), acc("agent.testnet"), u(near(2)), Err(PromiseError::Failed));
        assert_eq!(policy(&c).balance.0, before);
    }
}
