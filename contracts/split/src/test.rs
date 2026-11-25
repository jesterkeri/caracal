extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Bytes, Env, Event, IntoVal,
};

struct Setup<'a> {
    env: Env,
    owner: Address,
    token: Address,
    id: Address,
    client: SplitContractClient<'a>,
}

fn setup<'a>(tax: u32, goal: u32) -> Setup<'a> {
    let env = Env::default();
    let owner = Address::generate(&env);
    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin).address();
    let id = env.register(SplitContract, (&owner, &token, tax, goal));
    let client = SplitContractClient::new(&env, &id);
    Setup { env, owner, token, id, client }
}

fn fund(s: &Setup, who: &Address, amt: i128) {
    s.env.mock_all_auths();
    StellarAssetClient::new(&s.env, &s.token).mint(who, &amt);
    s.env.set_auths(&[]);
}

fn r(env: &Env, s: &str) -> Bytes {
    Bytes::from_slice(env, s.as_bytes())
}

fn dep(s: &Setup, from: &Address, amt: i128) {
    s.env.mock_auths(&[MockAuth {
        address: from,
        invoke: &MockAuthInvoke {
            contract: &s.id,
            fn_name: "deposit",
            args: (from, amt, r(&s.env, "INV-1")).into_val(&s.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &s.token,
                fn_name: "transfer",
                args: (from, &s.id, amt).into_val(&s.env),
                sub_invokes: &[],
            }],
        },
    }]);
    s.client.deposit(from, &amt, &r(&s.env, "INV-1"));
}

macro_rules! owner_auth {
    ($s:expr, $name:expr, $args:expr) => {
        $s.env.mock_auths(&[MockAuth {
            address: &$s.owner,
            invoke: &MockAuthInvoke {
                contract: &$s.id,
                fn_name: $name,
                args: $args.into_val(&$s.env),
                sub_invokes: &[],
            },
        }])
    };
}

#[test]
fn split_math_with_rounding() {
    for (amt, exp) in [
        (9_999_999i128, (999_999i128, 1_499_999i128, 7_500_001i128)),
        (1, (0, 0, 1)),
        (3, (0, 0, 3)),
        (10_000, (1_000, 1_500, 7_500)),
    ] {
        let s = setup(1000, 1500);
        let payer = Address::generate(&s.env);
        fund(&s, &payer, amt);
        dep(&s, &payer, amt);
        let (t, g, sp) = s.client.balances();
        assert_eq!((t, g, sp), exp);
        assert_eq!(t + g + sp, amt);
        assert_eq!(TokenClient::new(&s.env, &s.token).balance(&s.id), amt);
    }
}

#[test]
fn bps_bounds() {
    let s = setup(10_000, 0);
    assert_eq!(s.client.config().2, 10_000);
    let s = setup(4_000, 6_000);
    assert_eq!(s.client.config(), (s.owner.clone(), s.token.clone(), 4_000, 6_000));

    let s = setup(1000, 1500);
    owner_auth!(s, "set_split", (10_000u32, 0u32));
    s.client.set_split(&10_000, &0);
    assert_eq!(s.client.config().2, 10_000);
    owner_auth!(s, "set_split", (10_000u32, 1u32));
    assert_eq!(s.client.try_set_split(&10_000, &1), Err(Ok(Error::BpsTooHigh)));
}

#[test]
fn set_split_affects_future_deposits_only() {
    let s = setup(1000, 1500);
    let payer = Address::generate(&s.env);
    fund(&s, &payer, 2_000);
    dep(&s, &payer, 1_000);
    owner_auth!(s, "set_split", (0u32, 0u32));
    s.client.set_split(&0, &0);
    dep(&s, &payer, 1_000);
    assert_eq!(s.client.balances(), (100, 150, 1_750));
}

#[test]
fn non_owner_cannot_act() {
    let s = setup(1000, 1500);
    let payer = Address::generate(&s.env);
    fund(&s, &payer, 1_000);
    dep(&s, &payer, 1_000);
    let evil = Address::generate(&s.env);

    let args: soroban_sdk::Vec<soroban_sdk::Val> = (Pot::Spend, &evil, 100i128).into_val(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &evil,
        invoke: &MockAuthInvoke { contract: &s.id, fn_name: "withdraw", args, sub_invokes: &[] },
    }]);
    assert!(s.client.try_withdraw(&Pot::Spend, &evil, &100).is_err());

    let args: soroban_sdk::Vec<soroban_sdk::Val> = (Pot::Spend, Pot::Goal, 100i128).into_val(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &evil,
        invoke: &MockAuthInvoke { contract: &s.id, fn_name: "move_between", args, sub_invokes: &[] },
    }]);
    assert!(s.client.try_move_between(&Pot::Spend, &Pot::Goal, &100).is_err());

    let args: soroban_sdk::Vec<soroban_sdk::Val> = (0u32, 0u32).into_val(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &evil,
        invoke: &MockAuthInvoke { contract: &s.id, fn_name: "set_split", args, sub_invokes: &[] },
    }]);
    assert!(s.client.try_set_split(&0, &0).is_err());

    // no auth at all also fails
    s.env.set_auths(&[]);
    assert!(s.client.try_withdraw(&Pot::Spend, &evil, &100).is_err());

    assert_eq!(s.client.balances(), (100, 150, 750));
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&evil), 0);
}

#[test]
fn withdraw_limits_and_real_transfer() {
    let s = setup(1000, 1500);
    let payer = Address::generate(&s.env);
    fund(&s, &payer, 1_000);
    dep(&s, &payer, 1_000);
    let dest = Address::generate(&s.env);
    let tok = TokenClient::new(&s.env, &s.token);

    owner_auth!(s, "withdraw", (Pot::Tax, &dest, 101i128));
    assert_eq!(s.client.try_withdraw(&Pot::Tax, &dest, &101), Err(Ok(Error::InsufficientBalance)));
    owner_auth!(s, "withdraw", (Pot::Tax, &dest, 0i128));
    assert_eq!(s.client.try_withdraw(&Pot::Tax, &dest, &0), Err(Ok(Error::InvalidAmount)));

    owner_auth!(s, "withdraw", (Pot::Tax, &dest, 60i128));
    s.client.withdraw(&Pot::Tax, &dest, &60);
    assert_eq!(tok.balance(&dest), 60);
    assert_eq!(tok.balance(&s.id), 940);
    assert_eq!(s.client.balance(&Pot::Tax), 40);
}

#[test]
fn move_between_pots() {
    let s = setup(1000, 1500);
    let payer = Address::generate(&s.env);
    fund(&s, &payer, 1_000);
    dep(&s, &payer, 1_000);
    owner_auth!(s, "move_between", (Pot::Spend, Pot::Goal, 50i128));
    s.client.move_between(&Pot::Spend, &Pot::Goal, &50);
    assert_eq!(s.client.balances(), (100, 200, 700));
    owner_auth!(s, "move_between", (Pot::Tax, Pot::Goal, 101i128));
    assert_eq!(
        s.client.try_move_between(&Pot::Tax, &Pot::Goal, &101),
        Err(Ok(Error::InsufficientBalance))
    );
}

#[test]
fn deposit_emits_one_split_event() {
    let s = setup(1000, 1500);
    let payer = Address::generate(&s.env);
    fund(&s, &payer, 9_999_999);
    dep(&s, &payer, 9_999_999);
    let expected = Split {
        invoice_ref: r(&s.env, "INV-1"),
        from: payer.clone(),
        amount: 9_999_999,
        tax: 999_999,
        goal: 1_499_999,
        spend: 7_500_001,
    };
    let evs = s.env.events().all().filter_by_contract(&s.id);
    assert_eq!(evs.events().len(), 1);
    assert_eq!(evs, std::vec![expected.to_xdr(&s.env, &s.id)]);
}

#[test]
fn invalid_inputs_rejected() {
    let s = setup(1000, 1500);
    let payer = Address::generate(&s.env);
    fund(&s, &payer, 1_000);
    s.env.mock_all_auths();
    let ok = r(&s.env, "INV-1");
    assert_eq!(s.client.try_deposit(&payer, &100, &Bytes::new(&s.env)), Err(Ok(Error::InvalidInvoiceRef)));
    let long = Bytes::from_slice(&s.env, &[b'a'; 65]);
    assert_eq!(s.client.try_deposit(&payer, &100, &long), Err(Ok(Error::InvalidInvoiceRef)));
    let max = Bytes::from_slice(&s.env, &[b'a'; 64]);
    s.client.deposit(&payer, &100, &max);
    assert_eq!(s.client.try_deposit(&payer, &0, &ok), Err(Ok(Error::InvalidAmount)));
    assert_eq!(s.client.try_deposit(&payer, &-5, &ok), Err(Ok(Error::InvalidAmount)));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn constructor_rejects_10001() {
    setup(5_000, 5_001);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn constructor_rejects_overflowing_bps() {
    setup(u32::MAX, u32::MAX);
}
