// Adversary day 1 tests, kept after review.
extern crate std;
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Bytes, Env,
};

fn mk<'a>() -> (Env, Address, Address, SplitContractClient<'a>) {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin).address();
    let id = env.register(SplitContract, (&owner, &token, 2000u32, 1000u32));
    let c = SplitContractClient::new(&env, &id);
    (env, token, id, c)
}

#[test]
fn contract_as_from_is_rejected_even_when_it_holds_funds() {
    let (env, token, id, c) = mk();
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&payer, &1_000_000);
    c.create_invoice(&Bytes::from_slice(&env, b"REAL"), &1_000_000);
    c.deposit(&payer, &1_000_000, &Bytes::from_slice(&env, b"REAL"));
    let r = c.try_deposit(&id, &1_000_000i128, &Bytes::from_slice(&env, b"SELF"));
    assert_eq!(r, Err(Ok(Error::InvalidPayer)));
    let (t, g, s) = c.balances();
    let held = TokenClient::new(&env, &token).balance(&id);
    assert_eq!(t + g + s, held);
}

#[test]
fn paid_marker_survives_ttl_expiry() {
    let (env, token, _id, c) = mk();
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&payer, &10_000);
    let r = Bytes::from_slice(&env, b"INV");
    c.create_invoice(&r, &100);
    c.deposit(&payer, &100, &r);
    env.ledger().with_mut(|l| l.sequence_number += 3_100_000);
    assert_eq!(c.try_deposit(&payer, &100, &r), Err(Ok(Error::InvoiceAlreadyPaid)));
}
