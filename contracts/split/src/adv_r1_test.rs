extern crate std;
use super::*;
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Bytes, Env, IntoVal,
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
fn rb(env: &Env, s: &str) -> Bytes { Bytes::from_slice(env, s.as_bytes()) }

#[test]
fn non_owner_cannot_create_or_cancel() {
    let (env, _o, _t, id, c) = setup(1000, 1000);
    let evil = Address::generate(&env);
    let rf = rb(&env, "A");
    env.mock_auths(&[MockAuth { address: &evil, invoke: &MockAuthInvoke { contract: &id, fn_name: "create_invoice", args: (rf.clone(), 5i128).into_val(&env), sub_invokes: &[] } }]);
    assert!(c.try_create_invoice(&rf, &5).is_err());
    assert!(c.invoice(&rf).is_none());
}

#[test]
fn create_cancel_create_and_pay_cancel_create() {
    let (env, _o, _t, _id, c) = setup(1000, 1000);
    env.mock_all_auths();
    let rf = rb(&env, "A");
    c.create_invoice(&rf, &10);
    c.cancel_invoice(&rf);
    assert!(c.try_create_invoice(&rf, &10).is_err());
    assert!(c.try_create_invoice(&rf, &11).is_err());
    assert!(c.try_cancel_invoice(&rf).is_err());
}

#[test]
fn ref_lengths() {
    let (env, _o, _t, _id, c) = setup(1000, 1000);
    env.mock_all_auths();
    assert!(c.try_create_invoice(&Bytes::new(&env), &10).is_err());
    let ok = Bytes::from_slice(&env, &[b'a'; 64]);
    let bad = Bytes::from_slice(&env, &[b'a'; 65]);
    c.create_invoice(&ok, &10);
    assert!(c.try_create_invoice(&bad, &10).is_err());
    assert!(c.try_cancel_invoice(&bad).is_err());
}

#[test]
fn failed_transfer_leaves_invoice_open_and_pots_zero() {
    let (env, _o, token, _id, c) = setup(1000, 1000);
    env.mock_all_auths();
    let rf = rb(&env, "A");
    c.create_invoice(&rf, &100);
    let payer = Address::generate(&env); // unfunded
    assert!(c.try_deposit(&payer, &100, &rf).is_err());
    assert_eq!(c.invoice(&rf), Some((100, 0)));
    assert_eq!(c.balances(), (0, 0, 0));
    StellarAssetClient::new(&env, &token).mint(&payer, &100);
    c.deposit(&payer, &100, &rf);
    assert_eq!(c.invoice(&rf), Some((100, 1)));
    assert!(c.try_deposit(&payer, &100, &rf).is_err());
    assert_eq!(c.reconcile(), 0);
}

#[test]
fn edge_amounts() {
    let (env, _o, token, id, c) = setup(10_000, 0);
    env.mock_all_auths();
    for (i, a) in [i128::MAX, i128::MAX / 10_000, i128::MAX / 10_000 + 1, 1i128, 3i128].iter().enumerate() {
        let rf = rb(&env, &std::format!("E{i}"));
        c.create_invoice(&rf, a);
        let payer = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&payer, &(a.min(&(i128::MAX / 2))));
        let before = c.balances();
        let r = c.try_deposit(&payer, a, &rf);
        let (t, g, s) = c.balances();
        let bal = TokenClient::new(&env, &token).balance(&id);
        assert!(t + g + s <= bal, "pots exceed balance after {a}: r={:?}", r.is_ok());
        if r.is_err() { assert_eq!(before, (t, g, s)); assert_eq!(c.invoice(&rf), Some((*a, 0))); }
    }
}

#[test]
fn rounding_pots_never_exceed_balance() {
    let (env, _o, token, id, c) = setup(3333, 3333);
    env.mock_all_auths();
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&payer, &1_000_000);
    for i in 0..50i128 {
        let rf = rb(&env, &std::format!("R{i}"));
        c.create_invoice(&rf, &(i + 1));
        c.deposit(&payer, &(i + 1), &rf);
    }
    let (t, g, s) = c.balances();
    assert_eq!(t + g + s, TokenClient::new(&env, &token).balance(&id));
    assert_eq!(c.reconcile(), 0);
}
