//! # Sentinel Guard: on-chain idempotency for agent payments
//!
//! NEAR Sentinel tells an agent, off-chain, whether a retry is safe. This contract enforces the
//! same thing on-chain: a payment is forwarded **at most once** per `(payer, intent_id)`.
//!
//! * `pay(intent_id, receiver_id)` with an attached deposit records the intent and transfers
//!   `deposit - STORAGE_FEE` to `receiver_id`.
//! * A second `pay` with the same `intent_id` from the same payer panics with
//!   `DUPLICATE_INTENT`, so NEAR refunds that deposit automatically. A blind retry can't
//!   double-pay.
//! * If the transfer itself fails (for example, the receiver doesn't exist), the callback deletes the
//!   record and refunds the full deposit, so the same intent can be retried.
//!
//! No owner, no admin methods, no upgrade path: nobody holds privileges after deployment.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

/// Kept by the contract to pay for the intent record's storage (a record is < 300 bytes = 0.003 NEAR).
pub const STORAGE_FEE: NearToken = NearToken::from_millinear(5);
pub const MAX_INTENT_ID_LEN: usize = 64;
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const EVENT_STANDARD: &str = "sentinel_guard";
const EVENT_VERSION: &str = "1.0.0";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Intents,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum IntentStatus {
    /// Recorded; the transfer is in flight.
    Pending,
    /// The transfer to the receiver succeeded.
    Paid,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct IntentRecord {
    pub receiver_id: AccountId,
    /// Amount forwarded to the receiver (deposit minus storage fee), in yoctoNEAR.
    pub amount: NearToken,
    pub block_height: u64,
    pub status: IntentStatus,
}

/// JSON view of an intent record.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct IntentView {
    pub payer_id: AccountId,
    pub intent_id: String,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub block_height: u64,
    pub status: IntentStatus,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    intents: LookupMap<(AccountId, String), IntentRecord>,
}

fn validate_intent_id(intent_id: &str) {
    require!(!intent_id.is_empty(), "INVALID_INTENT_ID: must not be empty");
    require!(intent_id.len() <= MAX_INTENT_ID_LEN, "INVALID_INTENT_ID: longer than 64 bytes");
    require!(
        intent_id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':')),
        "INVALID_INTENT_ID: allowed characters are A-Z a-z 0-9 - _ . :"
    );
}

fn emit(event: &str, payer: &AccountId, intent_id: &str, receiver: &AccountId, amount: NearToken) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"{EVENT_STANDARD}\",\"version\":\"{EVENT_VERSION}\",\"event\":\"{event}\",\"data\":[{{\"payer_id\":\"{payer}\",\"intent_id\":\"{intent_id}\",\"receiver_id\":\"{receiver}\",\"amount\":\"{}\"}}]}}",
        amount.as_yoctonear()
    ));
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self { intents: LookupMap::new(StorageKey::Intents) }
    }

    /// Forward `deposit - STORAGE_FEE` to `receiver_id`, at most once per `(caller, intent_id)`.
    #[payable]
    pub fn pay(&mut self, intent_id: String, receiver_id: AccountId) -> Promise {
        validate_intent_id(&intent_id);
        let payer = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        require!(deposit > STORAGE_FEE, "INSUFFICIENT_DEPOSIT: attach more than the storage fee (0.005 NEAR)");
        require!(receiver_id != env::current_account_id(), "INVALID_RECEIVER: cannot pay the guard contract itself");

        let key = (payer.clone(), intent_id.clone());
        if self.intents.contains_key(&key) {
            env::panic_str(&format!("DUPLICATE_INTENT: {payer} already used intent_id {intent_id}; this deposit is refunded"));
        }

        let amount = deposit.saturating_sub(STORAGE_FEE);
        self.intents.insert(
            key,
            IntentRecord { receiver_id: receiver_id.clone(), amount, block_height: env::block_height(), status: IntentStatus::Pending },
        );
        emit("intent_recorded", &payer, &intent_id, &receiver_id, amount);

        Promise::new(receiver_id)
            .transfer(amount)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_transfer(payer, intent_id))
    }

    /// Callback: mark the intent paid, or release it and refund the full deposit if the transfer failed.
    #[private]
    pub fn on_transfer(&mut self, payer_id: AccountId, intent_id: String, #[callback_result] result: Result<(), PromiseError>) -> bool {
        let key = (payer_id.clone(), intent_id.clone());
        let Some(record) = self.intents.get(&key).cloned() else {
            return false;
        };
        if result.is_ok() {
            self.intents.insert(key, IntentRecord { status: IntentStatus::Paid, ..record.clone() });
            emit("intent_paid", &payer_id, &intent_id, &record.receiver_id, record.amount);
            true
        } else {
            self.intents.remove(&key);
            emit("intent_released", &payer_id, &intent_id, &record.receiver_id, record.amount);
            // The failed transfer's amount came back to this contract; return it plus the storage fee.
            let _ = Promise::new(payer_id).transfer(record.amount.saturating_add(STORAGE_FEE));
            false
        }
    }

    /// The recorded intent, if any. `null` means this payer has never successfully used `intent_id`.
    pub fn get_intent(&self, payer_id: AccountId, intent_id: String) -> Option<IntentView> {
        self.intents.get(&(payer_id.clone(), intent_id.clone())).map(|r| IntentView {
            payer_id,
            intent_id,
            receiver_id: r.receiver_id.clone(),
            amount: U128(r.amount.as_yoctonear()),
            block_height: r.block_height,
            status: r.status.clone(),
        })
    }

    pub fn storage_fee(&self) -> U128 {
        U128(STORAGE_FEE.as_yoctonear())
    }

    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
    use std::collections::HashMap;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: &str, deposit: NearToken) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("guard.testnet"))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .attached_deposit(deposit)
            .block_height(1000);
        b
    }

    fn set(predecessor: &str, deposit: NearToken) {
        testing_env!(ctx(predecessor, deposit).build());
    }

    fn set_callback(result: PromiseResult) {
        testing_env!(
            ctx("guard.testnet", NearToken::from_yoctonear(0)).build(),
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            HashMap::default(),
            vec![result]
        );
    }

    fn one_near() -> NearToken {
        NearToken::from_near(1)
    }

    #[test]
    fn first_pay_records_pending_and_emits_event() {
        set("agent.testnet", one_near());
        let mut c = Contract::new();
        c.pay("order-1".into(), acc("merchant.testnet"));
        let v = c.get_intent(acc("agent.testnet"), "order-1".into()).unwrap();
        assert_eq!(v.status, IntentStatus::Pending);
        assert_eq!(v.receiver_id, acc("merchant.testnet"));
        assert_eq!(v.amount.0, one_near().as_yoctonear() - STORAGE_FEE.as_yoctonear());
        assert_eq!(v.block_height, 1000);
        assert!(get_logs()[0].starts_with("EVENT_JSON:{\"standard\":\"sentinel_guard\""));
        assert!(get_logs()[0].contains("\"event\":\"intent_recorded\""));
    }

    #[test]
    #[should_panic(expected = "DUPLICATE_INTENT")]
    fn duplicate_intent_from_same_payer_is_rejected_while_pending() {
        set("agent.testnet", one_near());
        let mut c = Contract::new();
        c.pay("order-1".into(), acc("merchant.testnet"));
        c.pay("order-1".into(), acc("merchant.testnet"));
    }

    #[test]
    #[should_panic(expected = "DUPLICATE_INTENT")]
    fn duplicate_intent_is_rejected_after_paid_even_to_another_receiver() {
        set("agent.testnet", one_near());
        let mut c = Contract::new();
        c.pay("order-1".into(), acc("merchant.testnet"));
        set_callback(PromiseResult::Successful(vec![]));
        assert!(c.on_transfer(acc("agent.testnet"), "order-1".into(), Ok(())));
        set("agent.testnet", one_near());
        c.pay("order-1".into(), acc("other.testnet"));
    }

    #[test]
    fn same_intent_id_from_different_payers_is_independent() {
        set("agent-a.testnet", one_near());
        let mut c = Contract::new();
        c.pay("order-1".into(), acc("merchant.testnet"));
        set("agent-b.testnet", one_near());
        c.pay("order-1".into(), acc("merchant.testnet"));
        assert!(c.get_intent(acc("agent-a.testnet"), "order-1".into()).is_some());
        assert!(c.get_intent(acc("agent-b.testnet"), "order-1".into()).is_some());
    }

    #[test]
    fn successful_transfer_marks_paid() {
        set("agent.testnet", one_near());
        let mut c = Contract::new();
        c.pay("order-1".into(), acc("merchant.testnet"));
        set_callback(PromiseResult::Successful(vec![]));
        assert!(c.on_transfer(acc("agent.testnet"), "order-1".into(), Ok(())));
        assert_eq!(c.get_intent(acc("agent.testnet"), "order-1".into()).unwrap().status, IntentStatus::Paid);
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"intent_paid\"")));
    }

    #[test]
    fn failed_transfer_releases_intent_so_it_can_be_retried() {
        set("agent.testnet", one_near());
        let mut c = Contract::new();
        c.pay("order-1".into(), acc("no-such-account.testnet"));
        set_callback(PromiseResult::Failed);
        assert!(!c.on_transfer(acc("agent.testnet"), "order-1".into(), Err(PromiseError::Failed)));
        assert!(c.get_intent(acc("agent.testnet"), "order-1".into()).is_none());
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"intent_released\"")));
        // The same intent can now be paid again.
        set("agent.testnet", one_near());
        c.pay("order-1".into(), acc("merchant.testnet"));
        assert_eq!(c.get_intent(acc("agent.testnet"), "order-1".into()).unwrap().status, IntentStatus::Pending);
    }

    #[test]
    fn callback_for_unknown_intent_is_a_no_op() {
        set_callback(PromiseResult::Successful(vec![]));
        let mut c = Contract::new();
        assert!(!c.on_transfer(acc("agent.testnet"), "never".into(), Ok(())));
    }

    // `#[private]` is enforced by the generated wasm entry point, not by the Rust method, so it is
    // verified on-chain by the live integration test (`pnpm test:contract`), not here.

    #[test]
    #[should_panic(expected = "INSUFFICIENT_DEPOSIT")]
    fn deposit_must_exceed_storage_fee() {
        set("agent.testnet", STORAGE_FEE);
        Contract::new().pay("order-1".into(), acc("merchant.testnet"));
    }

    #[test]
    #[should_panic(expected = "INVALID_INTENT_ID")]
    fn empty_intent_id_rejected() {
        set("agent.testnet", one_near());
        Contract::new().pay("".into(), acc("merchant.testnet"));
    }

    #[test]
    #[should_panic(expected = "INVALID_INTENT_ID")]
    fn long_intent_id_rejected() {
        set("agent.testnet", one_near());
        Contract::new().pay("x".repeat(65), acc("merchant.testnet"));
    }

    #[test]
    #[should_panic(expected = "INVALID_INTENT_ID")]
    fn intent_id_with_quote_rejected_so_event_json_cannot_be_forged() {
        set("agent.testnet", one_near());
        Contract::new().pay("a\",\"x".into(), acc("merchant.testnet"));
    }

    #[test]
    fn max_length_intent_id_accepted() {
        set("agent.testnet", one_near());
        let mut c = Contract::new();
        c.pay("a".repeat(64), acc("merchant.testnet"));
        assert!(c.get_intent(acc("agent.testnet"), "a".repeat(64)).is_some());
    }

    #[test]
    #[should_panic(expected = "INVALID_RECEIVER")]
    fn cannot_pay_the_contract_itself() {
        set("agent.testnet", one_near());
        Contract::new().pay("order-1".into(), acc("guard.testnet"));
    }

    #[test]
    fn views() {
        set("agent.testnet", NearToken::from_yoctonear(0));
        let c = Contract::new();
        assert_eq!(c.storage_fee().0, STORAGE_FEE.as_yoctonear());
        assert_eq!(c.version(), "0.1.0");
        assert!(c.get_intent(acc("agent.testnet"), "x".into()).is_none());
    }
}
