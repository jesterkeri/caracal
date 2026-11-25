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
    dep_ref(s, from, amt, "INV-1");
}

fn open_inv(s: &Setup, amt: i128, rf: &str) {
    s.env.mock_auths(&[MockAuth {
        address: &s.owner,
        invoke: &MockAuthInvoke {
            contract: &s.id,
            fn_name: "create_invoice",
            args: (r(&s.env, rf), amt).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.client.create_invoice(&r(&s.env, rf), &amt);
}

fn dep_ref(s: &Setup, from: &Address, amt: i128, rf: &str) {
    open_inv(s, amt, rf);
    s.env.mock_auths(&[MockAuth {
        address: from,
        invoke: &MockAuthInvoke {
            contract: &s.id,
            fn_name: "deposit",
            args: (from, amt, r(&s.env, rf)).into_val(&s.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &s.token,
                fn_name: "transfer",
                args: (from, &s.id, amt).into_val(&s.env),
                sub_invokes: &[],
            }],
        },
    }]);
    s.client.deposit(from, &amt, &r(&s.env, rf));
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
    dep_ref(&s, &payer, 1_000, "INV-2");
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
        token: s.token.clone(),
        owner: s.owner.clone(),
        amount: 9_999_999,
        tax: 999_999,
        goal: 1_499_999,
        spend: 7_500_001,
    };
    let _ = &expected;
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
    s.client.create_invoice(&max, &100);
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

#[test]
fn duplicate_invoice_rejected_and_is_paid() {
    let s = setup(1000, 1500);
    let payer = Address::generate(&s.env);
    fund(&s, &payer, 1_000);
    assert!(!s.client.is_paid(&r(&s.env, "INV-1")));
    dep(&s, &payer, 100);
    assert!(s.client.is_paid(&r(&s.env, "INV-1")));
    assert!(!s.client.is_paid(&r(&s.env, "INV-2")));
    s.env.mock_all_auths();
    assert_eq!(
        s.client.try_deposit(&payer, &100, &r(&s.env, "INV-1")),
        Err(Ok(Error::InvoiceAlreadyPaid))
    );
    s.client.create_invoice(&r(&s.env, "INV-2"), &100);
    s.client.deposit(&payer, &100, &r(&s.env, "INV-2"));
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&s.id), 200);
}

#[test]
fn huge_amounts_checked() {
    let s = setup(1000, 1500);
    let payer = Address::generate(&s.env);
    let big: i128 = i128::MAX / 10_000;
    fund(&s, &payer, big);
    s.env.mock_all_auths();
    s.client.create_invoice(&r(&s.env, "BIG"), &big);
    s.client.deposit(&payer, &big, &r(&s.env, "BIG"));
    let (t, g, sp) = s.client.balances();
    assert_eq!(t + g + sp, big);

    // amount * bps overflows i128: clean error, no panic, no state change
    let over: i128 = i128::MAX / 1_000 + 1;
    s.client.create_invoice(&r(&s.env, "OVER"), &over);
    assert_eq!(
        s.client.try_deposit(&payer, &over, &r(&s.env, "OVER")),
        Err(Ok(Error::Overflow))
    );
    assert!(!s.client.is_paid(&r(&s.env, "OVER")));
    assert_eq!(s.client.balances(), (t, g, sp));
}

#[test]
fn reconcile_credits_unsolicited_transfer_to_spend() {
    let s = setup(1000, 1500);
    let payer = Address::generate(&s.env);
    fund(&s, &payer, 1_000);
    dep(&s, &payer, 1_000);
    owner_auth!(s, "reconcile", ());
    assert_eq!(s.client.reconcile(), 0);

    let stranger = Address::generate(&s.env);
    fund(&s, &stranger, 77);
    s.env.mock_all_auths();
    TokenClient::new(&s.env, &s.token).transfer(&stranger, &s.id, &77);
    assert_eq!(s.client.balances(), (100, 150, 750));

    // non-owner cannot reconcile
    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke { contract: &s.id, fn_name: "reconcile", args: ().into_val(&s.env), sub_invokes: &[] },
    }]);
    assert!(s.client.try_reconcile().is_err());

    owner_auth!(s, "reconcile", ());
    assert_eq!(s.client.reconcile(), 77);
    let evs = s.env.events().all().filter_by_contract(&s.id);
    assert_eq!(s.client.balances(), (100, 150, 827));
    assert_eq!(evs, std::vec![Reconciled { amount: 77 }.to_xdr(&s.env, &s.id)]);
    owner_auth!(s, "reconcile", ());
    assert_eq!(s.client.reconcile(), 0);
}

#[test]
fn failed_transfer_reverts_withdraw() {
    use soroban_sdk::testutils::IssuerFlags;
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    sac.issuer().set_flag(IssuerFlags::RequiredFlag);
    let token = sac.address();
    let id = env.register(SplitContract, (&owner, &token, 1000u32, 1500u32));
    let client = SplitContractClient::new(&env, &id);
    let admin = StellarAssetClient::new(&env, &token);
    let payer = Address::generate(&env);
    admin.set_authorized(&payer, &true);
    admin.set_authorized(&id, &true);
    admin.mint(&payer, &1_000);
    client.create_invoice(&Bytes::from_slice(&env, b"INV-1"), &1_000);
    client.deposit(&payer, &1_000, &Bytes::from_slice(&env, b"INV-1"));
    let dest = Address::generate(&env);
    admin.set_authorized(&dest, &true);
    admin.set_authorized(&id, &false); // contract frozen: token transfer will fail
    assert!(client.try_withdraw(&Pot::Spend, &dest, &100).is_err());
    assert_eq!(client.balances(), (100, 150, 750));
    assert_eq!(TokenClient::new(&env, &token).balance(&dest), 0);
}

fn pots_within_held(s: &Setup) {
    let (t, g, sp) = s.client.balances();
    assert!(t + g + sp <= TokenClient::new(&s.env, &s.token).balance(&s.id));
}

#[test]
fn third_party_underpayment_cannot_burn_invoice() {
    let s = setup(1000, 1500);
    let attacker = Address::generate(&s.env);
    let client = Address::generate(&s.env);
    fund(&s, &attacker, 10);
    fund(&s, &client, 1_000);
    open_inv(&s, 1_000, "INV-1");
    s.env.mock_all_auths();
    assert_eq!(
        s.client.try_deposit(&attacker, &1, &r(&s.env, "INV-1")),
        Err(Ok(Error::WrongAmount))
    );
    assert_eq!(s.client.invoice(&r(&s.env, "INV-1")), Some((1_000, 0)));
    assert!(!s.client.is_paid(&r(&s.env, "INV-1")));
    assert_eq!(s.client.balances(), (0, 0, 0));
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&attacker), 10);

    s.env.mock_all_auths();
    s.client.deposit(&client, &1_000, &r(&s.env, "INV-1"));
    assert_eq!(s.client.invoice(&r(&s.env, "INV-1")), Some((1_000, 1)));
    assert!(s.client.is_paid(&r(&s.env, "INV-1")));
    assert_eq!(s.client.balances(), (100, 150, 750));
    pots_within_held(&s);
}

#[test]
fn overpayment_and_partial_rejected() {
    let s = setup(1000, 1500);
    let payer = Address::generate(&s.env);
    fund(&s, &payer, 5_000);
    open_inv(&s, 1_000, "INV-1");
    s.env.mock_all_auths();
    assert_eq!(s.client.try_deposit(&payer, &1_001, &r(&s.env, "INV-1")), Err(Ok(Error::WrongAmount)));
    assert_eq!(s.client.try_deposit(&payer, &999, &r(&s.env, "INV-1")), Err(Ok(Error::WrongAmount)));
    assert_eq!(s.client.balances(), (0, 0, 0));
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&s.id), 0);
}

#[test]
fn unknown_ref_rejected() {
    let s = setup(1000, 1500);
    let payer = Address::generate(&s.env);
    fund(&s, &payer, 100);
    s.env.mock_all_auths();
    assert_eq!(s.client.try_deposit(&payer, &100, &r(&s.env, "NOPE")), Err(Ok(Error::UnknownInvoice)));
    assert_eq!(s.client.invoice(&r(&s.env, "NOPE")), None);
    assert!(!s.client.is_paid(&r(&s.env, "NOPE")));
}

#[test]
fn non_owner_cannot_create_or_cancel_invoice() {
    let s = setup(1000, 1500);
    let evil = Address::generate(&s.env);
    let args: soroban_sdk::Vec<soroban_sdk::Val> = (r(&s.env, "INV-1"), 100i128).into_val(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &evil,
        invoke: &MockAuthInvoke { contract: &s.id, fn_name: "create_invoice", args, sub_invokes: &[] },
    }]);
    assert!(s.client.try_create_invoice(&r(&s.env, "INV-1"), &100).is_err());
    assert_eq!(s.client.invoice(&r(&s.env, "INV-1")), None);

    open_inv(&s, 100, "INV-1");
    let args: soroban_sdk::Vec<soroban_sdk::Val> = (r(&s.env, "INV-1"),).into_val(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &evil,
        invoke: &MockAuthInvoke { contract: &s.id, fn_name: "cancel_invoice", args, sub_invokes: &[] },
    }]);
    assert!(s.client.try_cancel_invoice(&r(&s.env, "INV-1")).is_err());
    s.env.set_auths(&[]);
    assert!(s.client.try_cancel_invoice(&r(&s.env, "INV-1")).is_err());
    assert_eq!(s.client.invoice(&r(&s.env, "INV-1")), Some((100, 0)));
}

#[test]
fn create_invoice_twice_fails_even_after_paid_or_cancelled() {
    let s = setup(1000, 1500);
    let payer = Address::generate(&s.env);
    fund(&s, &payer, 1_000);
    open_inv(&s, 100, "INV-1");
    s.env.mock_all_auths();
    assert_eq!(s.client.try_create_invoice(&r(&s.env, "INV-1"), &100), Err(Ok(Error::InvoiceExists)));
    s.client.deposit(&payer, &100, &r(&s.env, "INV-1"));
    assert_eq!(s.client.try_create_invoice(&r(&s.env, "INV-1"), &100), Err(Ok(Error::InvoiceExists)));
    assert_eq!(s.client.try_create_invoice(&r(&s.env, "INV-1"), &555), Err(Ok(Error::InvoiceExists)));
    s.client.create_invoice(&r(&s.env, "INV-2"), &100);
    s.client.cancel_invoice(&r(&s.env, "INV-2"));
    assert_eq!(s.client.try_create_invoice(&r(&s.env, "INV-2"), &100), Err(Ok(Error::InvoiceExists)));
}

#[test]
fn create_invoice_validates_inputs() {
    let s = setup(1000, 1500);
    s.env.mock_all_auths();
    assert_eq!(s.client.try_create_invoice(&Bytes::new(&s.env), &100), Err(Ok(Error::InvalidInvoiceRef)));
    let long = Bytes::from_slice(&s.env, &[b'a'; 65]);
    assert_eq!(s.client.try_create_invoice(&long, &100), Err(Ok(Error::InvalidInvoiceRef)));
    assert_eq!(s.client.try_create_invoice(&r(&s.env, "A"), &0), Err(Ok(Error::InvalidAmount)));
    assert_eq!(s.client.try_create_invoice(&r(&s.env, "A"), &-1), Err(Ok(Error::InvalidAmount)));
}

#[test]
fn cancelled_cannot_be_paid_and_paid_cannot_be_cancelled() {
    let s = setup(1000, 1500);
    let payer = Address::generate(&s.env);
    fund(&s, &payer, 1_000);
    open_inv(&s, 100, "INV-1");
    s.env.mock_all_auths();
    s.client.create_invoice(&r(&s.env, "INV-2"), &100);
    s.client.cancel_invoice(&r(&s.env, "INV-1"));
    let evs = s.env.events().all().filter_by_contract(&s.id);
    assert_eq!(evs, std::vec![InvoiceCancelled { invoice_ref: r(&s.env, "INV-1") }.to_xdr(&s.env, &s.id)]);
    assert_eq!(s.client.invoice(&r(&s.env, "INV-1")), Some((100, 2)));
    assert_eq!(s.client.try_deposit(&payer, &100, &r(&s.env, "INV-1")), Err(Ok(Error::InvoiceCancelled)));
    assert_eq!(s.client.try_cancel_invoice(&r(&s.env, "INV-1")), Err(Ok(Error::InvoiceCancelled)));
    assert!(!s.client.is_paid(&r(&s.env, "INV-1")));

    s.client.deposit(&payer, &100, &r(&s.env, "INV-2"));
    assert_eq!(s.client.try_cancel_invoice(&r(&s.env, "INV-2")), Err(Ok(Error::InvoiceAlreadyPaid)));
    assert_eq!(s.client.try_cancel_invoice(&r(&s.env, "NOPE")), Err(Ok(Error::UnknownInvoice)));
    assert_eq!(s.client.invoice(&r(&s.env, "INV-2")), Some((100, 1)));
    assert_eq!(s.client.balances(), (10, 15, 75));
    pots_within_held(&s);
}

#[test]
fn create_invoice_emits_opened_event() {
    let s = setup(1000, 1500);
    open_inv(&s, 777, "INV-9");
    let evs = s.env.events().all().filter_by_contract(&s.id);
    assert_eq!(
        evs,
        std::vec![InvoiceOpened { invoice_ref: r(&s.env, "INV-9"), amount: 777 }.to_xdr(&s.env, &s.id)]
    );
}

#[test]
fn withdraw_to_self_is_refused_and_changes_nothing() {
    let s = setup(1000, 1500);
    let payer = Address::generate(&s.env);
    fund(&s, &payer, 1_000);
    dep(&s, &payer, 1_000);
    let before = s.client.balances();
    let tok = TokenClient::new(&s.env, &s.token);
    let held = tok.balance(&s.id);
    owner_auth!(s, "withdraw", (Pot::Spend, &s.id, 10i128));
    assert_eq!(s.client.try_withdraw(&Pot::Spend, &s.id, &10), Err(Ok(Error::InvalidRecipient)));
    assert_eq!(s.client.balances(), before);
    assert_eq!(tok.balance(&s.id), held);
}
