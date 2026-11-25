extern crate std;
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Bytes, Env,
};

fn setup<'a>(tax: u32, goal: u32) -> (Env, Address, Address, Address, SplitContractClient<'a>) {
    let env = Env::default();
    let owner = Address::generate(&env);
    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin).address();
    let id = env.register(SplitContract, (&owner, &token, tax, goal));
    let c = SplitContractClient::new(&env, &id);
    (env, owner, token, id, c)
}

/// Spec: "A ref can never be created twice, so a paid or cancelled id cannot be reused."
/// A paid invoice untouched for longer than its TTL must not become re-creatable.
#[test]
fn paid_invoice_cannot_be_recreated_after_ttl_lapses() {
    let (env, _o, token, _id, c) = setup(1000, 1000);
    env.mock_all_auths();
    let rf = Bytes::from_slice(&env, b"A");
    c.create_invoice(&rf, &100);
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&payer, &100);
    c.deposit(&payer, &100, &rf);
    env.ledger().with_mut(|l| l.sequence_number += 3_100_000);
    assert!(c.try_create_invoice(&rf, &100).is_err(), "paid ref was re-created");
}

/// Spec: pots always account for held money; withdraw "sends amount of USDC from a pot to `to`".
/// Withdrawing to the contract itself must not make pots and balance diverge.
#[test]
fn withdraw_to_self_keeps_pots_equal_to_balance() {
    let (env, _o, token, id, c) = setup(1000, 1000);
    env.mock_all_auths();
    let rf = Bytes::from_slice(&env, b"A");
    c.create_invoice(&rf, &100);
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&payer, &100);
    c.deposit(&payer, &100, &rf);
    let _ = c.try_withdraw(&Pot::Tax, &id, &10);
    let (t, g, s) = c.balances();
    assert_eq!(t + g + s, TokenClient::new(&env, &token).balance(&id));
}
