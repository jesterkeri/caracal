#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Bytes, Env,
};

const BPS_DENOM: i128 = 10_000;
const MAX_REF_LEN: u32 = 64;
const TTL_THRESHOLD: u32 = 100_000;
const TTL_EXTEND_TO: u32 = 500_000;
const PAID_TTL_THRESHOLD: u32 = 500_000;
const PAID_TTL_EXTEND_TO: u32 = 3_000_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    BpsTooHigh = 1,
    InvalidAmount = 2,
    InvalidInvoiceRef = 3,
    InsufficientBalance = 4,
    SamePot = 5,
    InvoiceAlreadyPaid = 6,
    Overflow = 7,
    InvalidPayer = 8,
    InvoiceExists = 9,
    UnknownInvoice = 10,
    WrongAmount = 11,
    InvoiceCancelled = 12,
    InvalidRecipient = 13,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Pot {
    Tax,
    Goal,
    Spend,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Status {
    Open,
    Paid,
    Cancelled,
}

#[contracttype]
#[derive(Clone)]
struct Invoice {
    amount: i128,
    status: Status,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Owner,
    Token,
    TaxBps,
    GoalBps,
    Pot(Pot),
    Invoice(Bytes),
}

#[contractevent(topics = ["split", "v1"])]
pub struct Split {
    pub invoice_ref: Bytes,
    pub from: Address,
    pub token: Address,
    pub owner: Address,
    pub amount: i128,
    pub tax: i128,
    pub goal: i128,
    pub spend: i128,
}

#[contractevent(topics = ["invoice_opened", "v1"])]
pub struct InvoiceOpened {
    pub invoice_ref: Bytes,
    pub amount: i128,
}

#[contractevent(topics = ["invoice_cancelled", "v1"])]
pub struct InvoiceCancelled {
    pub invoice_ref: Bytes,
}

#[contractevent(topics = ["withdraw", "v1"])]
pub struct Withdraw {
    pub pot: Pot,
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["reallocate", "v1"])]
pub struct Reallocate {
    pub from_pot: Pot,
    pub to_pot: Pot,
    pub amount: i128,
}

#[contractevent(topics = ["split_changed", "v1"])]
pub struct SplitChanged {
    pub tax_bps: u32,
    pub goal_bps: u32,
}

#[contractevent(topics = ["reconciled", "v1"])]
pub struct Reconciled {
    pub amount: i128,
}

#[contract]
pub struct SplitContract;

fn bump(env: &Env) {
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn check_bps(tax_bps: u32, goal_bps: u32) -> Result<(), Error> {
    if (tax_bps as u64) + (goal_bps as u64) > 10_000 {
        return Err(Error::BpsTooHigh);
    }
    Ok(())
}

fn get_pot(env: &Env, pot: Pot) -> i128 {
    env.storage().instance().get(&Key::Pot(pot)).unwrap_or(0)
}

fn set_pot(env: &Env, pot: Pot, v: i128) {
    env.storage().instance().set(&Key::Pot(pot), &v);
}

fn owner(env: &Env) -> Address {
    env.storage().instance().get(&Key::Owner).unwrap()
}

fn token_addr(env: &Env) -> Address {
    env.storage().instance().get(&Key::Token).unwrap()
}

fn check_ref(r: &Bytes) -> Result<(), Error> {
    if r.is_empty() || r.len() > MAX_REF_LEN {
        return Err(Error::InvalidInvoiceRef);
    }
    Ok(())
}

fn save_invoice(env: &Env, r: &Bytes, inv: &Invoice) {
    let k = Key::Invoice(r.clone());
    let p = env.storage().persistent();
    p.set(&k, inv);
    p.extend_ttl(&k, PAID_TTL_THRESHOLD, PAID_TTL_EXTEND_TO);
}

fn load_invoice(env: &Env, r: &Bytes) -> Option<Invoice> {
    let k = Key::Invoice(r.clone());
    let p = env.storage().persistent();
    let inv: Option<Invoice> = p.get(&k);
    if inv.is_some() {
        p.extend_ttl(&k, PAID_TTL_THRESHOLD, PAID_TTL_EXTEND_TO);
    }
    inv
}

#[contractimpl]
impl SplitContract {
    pub fn __constructor(
        env: Env,
        owner: Address,
        token: Address,
        tax_bps: u32,
        goal_bps: u32,
    ) -> Result<(), Error> {
        check_bps(tax_bps, goal_bps)?;
        let s = env.storage().instance();
        s.set(&Key::Owner, &owner);
        s.set(&Key::Token, &token);
        s.set(&Key::TaxBps, &tax_bps);
        s.set(&Key::GoalBps, &goal_bps);
        bump(&env);
        Ok(())
    }

    pub fn deposit(env: Env, from: Address, amount: i128, invoice_ref: Bytes) -> Result<(), Error> {
        if from == env.current_contract_address() {
            return Err(Error::InvalidPayer);
        }
        from.require_auth();
        bump(&env);
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        check_ref(&invoice_ref)?;
        let mut inv = load_invoice(&env, &invoice_ref).ok_or(Error::UnknownInvoice)?;
        match inv.status {
            Status::Paid => return Err(Error::InvoiceAlreadyPaid),
            Status::Cancelled => return Err(Error::InvoiceCancelled),
            Status::Open => {}
        }
        if amount != inv.amount {
            return Err(Error::WrongAmount);
        }
        let s = env.storage().instance();
        let tax_bps: u32 = s.get(&Key::TaxBps).unwrap();
        let goal_bps: u32 = s.get(&Key::GoalBps).unwrap();
        let tax = amount.checked_mul(tax_bps as i128).ok_or(Error::Overflow)? / BPS_DENOM;
        let goal = amount.checked_mul(goal_bps as i128).ok_or(Error::Overflow)? / BPS_DENOM;
        let spend = amount - tax - goal;
        if tax + goal + spend != amount || spend < 0 {
            return Err(Error::Overflow);
        }
        let new_tax = get_pot(&env, Pot::Tax).checked_add(tax).ok_or(Error::Overflow)?;
        let new_goal = get_pot(&env, Pot::Goal).checked_add(goal).ok_or(Error::Overflow)?;
        let new_spend = get_pot(&env, Pot::Spend).checked_add(spend).ok_or(Error::Overflow)?;

        inv.status = Status::Paid;
        save_invoice(&env, &invoice_ref, &inv);
        set_pot(&env, Pot::Tax, new_tax);
        set_pot(&env, Pot::Goal, new_goal);
        set_pot(&env, Pot::Spend, new_spend);
        let token = token_addr(&env);
        token::Client::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);
        Split { invoice_ref, from, token, owner: owner(&env), amount, tax, goal, spend }.publish(&env);
        Ok(())
    }

    pub fn create_invoice(env: Env, invoice_ref: Bytes, amount: i128) -> Result<(), Error> {
        owner(&env).require_auth();
        bump(&env);
        check_ref(&invoice_ref)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if env.storage().persistent().has(&Key::Invoice(invoice_ref.clone())) {
            return Err(Error::InvoiceExists);
        }
        save_invoice(&env, &invoice_ref, &Invoice { amount, status: Status::Open });
        InvoiceOpened { invoice_ref, amount }.publish(&env);
        Ok(())
    }

    pub fn cancel_invoice(env: Env, invoice_ref: Bytes) -> Result<(), Error> {
        owner(&env).require_auth();
        bump(&env);
        check_ref(&invoice_ref)?;
        let mut inv = load_invoice(&env, &invoice_ref).ok_or(Error::UnknownInvoice)?;
        match inv.status {
            Status::Paid => return Err(Error::InvoiceAlreadyPaid),
            Status::Cancelled => return Err(Error::InvoiceCancelled),
            Status::Open => {}
        }
        inv.status = Status::Cancelled;
        save_invoice(&env, &invoice_ref, &inv);
        InvoiceCancelled { invoice_ref }.publish(&env);
        Ok(())
    }

    /// (amount, status) where status is 0 open, 1 paid, 2 cancelled.
    pub fn invoice(env: Env, invoice_ref: Bytes) -> Option<(i128, u32)> {
        bump(&env);
        load_invoice(&env, &invoice_ref).map(|i| (i.amount, i.status as u32))
    }

    pub fn is_paid(env: Env, invoice_ref: Bytes) -> bool {
        bump(&env);
        matches!(load_invoice(&env, &invoice_ref), Some(Invoice { status: Status::Paid, .. }))
    }

    pub fn reconcile(env: Env) -> Result<i128, Error> {
        owner(&env).require_auth();
        bump(&env);
        let held = token::Client::new(&env, &token_addr(&env)).balance(&env.current_contract_address());
        let (t, g, s) = (get_pot(&env, Pot::Tax), get_pot(&env, Pot::Goal), get_pot(&env, Pot::Spend));
        let accounted = t.checked_add(g).and_then(|x| x.checked_add(s)).ok_or(Error::Overflow)?;
        let surplus = held - accounted;
        if surplus > 0 {
            set_pot(&env, Pot::Spend, s.checked_add(surplus).ok_or(Error::Overflow)?);
            Reconciled { amount: surplus }.publish(&env);
            Ok(surplus)
        } else {
            Ok(0)
        }
    }

    pub fn balance(env: Env, pot: Pot) -> i128 {
        bump(&env);
        get_pot(&env, pot)
    }

    pub fn balances(env: Env) -> (i128, i128, i128) {
        bump(&env);
        (get_pot(&env, Pot::Tax), get_pot(&env, Pot::Goal), get_pot(&env, Pot::Spend))
    }

    pub fn withdraw(env: Env, pot: Pot, to: Address, amount: i128) -> Result<(), Error> {
        owner(&env).require_auth();
        bump(&env);
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if to == env.current_contract_address() {
            return Err(Error::InvalidRecipient);
        }
        let bal = get_pot(&env, pot);
        if amount > bal {
            return Err(Error::InsufficientBalance);
        }
        set_pot(&env, pot, bal - amount);
        token::Client::new(&env, &token_addr(&env)).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        Withdraw { pot, to, amount }.publish(&env);
        Ok(())
    }

    pub fn move_between(env: Env, from_pot: Pot, to_pot: Pot, amount: i128) -> Result<(), Error> {
        owner(&env).require_auth();
        bump(&env);
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if from_pot == to_pot {
            return Err(Error::SamePot);
        }
        let bal = get_pot(&env, from_pot);
        if amount > bal {
            return Err(Error::InsufficientBalance);
        }
        set_pot(&env, from_pot, bal - amount);
        set_pot(&env, to_pot, get_pot(&env, to_pot).checked_add(amount).ok_or(Error::Overflow)?);
        Reallocate { from_pot, to_pot, amount }.publish(&env);
        Ok(())
    }

    pub fn set_split(env: Env, tax_bps: u32, goal_bps: u32) -> Result<(), Error> {
        owner(&env).require_auth();
        bump(&env);
        check_bps(tax_bps, goal_bps)?;
        let s = env.storage().instance();
        s.set(&Key::TaxBps, &tax_bps);
        s.set(&Key::GoalBps, &goal_bps);
        SplitChanged { tax_bps, goal_bps }.publish(&env);
        Ok(())
    }

    pub fn config(env: Env) -> (Address, Address, u32, u32) {
        bump(&env);
        let s = env.storage().instance();
        (owner(&env), token_addr(&env), s.get(&Key::TaxBps).unwrap(), s.get(&Key::GoalBps).unwrap())
    }
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod adv_test;
#[cfg(test)]
mod adv_r1_test;
#[cfg(test)]
mod adv_r2b_test;
