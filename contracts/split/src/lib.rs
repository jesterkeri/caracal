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
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Pot {
    Tax,
    Goal,
    Spend,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Owner,
    Token,
    TaxBps,
    GoalBps,
    Pot(Pot),
    Paid(Bytes),
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
        from.require_auth();
        bump(&env);
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if invoice_ref.is_empty() || invoice_ref.len() > MAX_REF_LEN {
            return Err(Error::InvalidInvoiceRef);
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
        let paid_key = Key::Paid(invoice_ref.clone());
        let p = env.storage().persistent();
        if p.has(&paid_key) {
            return Err(Error::InvoiceAlreadyPaid);
        }
        let new_tax = get_pot(&env, Pot::Tax).checked_add(tax).ok_or(Error::Overflow)?;
        let new_goal = get_pot(&env, Pot::Goal).checked_add(goal).ok_or(Error::Overflow)?;
        let new_spend = get_pot(&env, Pot::Spend).checked_add(spend).ok_or(Error::Overflow)?;

        p.set(&paid_key, &true);
        p.extend_ttl(&paid_key, PAID_TTL_THRESHOLD, PAID_TTL_EXTEND_TO);
        set_pot(&env, Pot::Tax, new_tax);
        set_pot(&env, Pot::Goal, new_goal);
        set_pot(&env, Pot::Spend, new_spend);
        let token = token_addr(&env);
        token::Client::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);
        Split { invoice_ref, from, token, owner: owner(&env), amount, tax, goal, spend }.publish(&env);
        Ok(())
    }

    pub fn is_paid(env: Env, invoice_ref: Bytes) -> bool {
        bump(&env);
        let k = Key::Paid(invoice_ref);
        let p = env.storage().persistent();
        let paid = p.has(&k);
        if paid {
            p.extend_ttl(&k, PAID_TTL_THRESHOLD, PAID_TTL_EXTEND_TO);
        }
        paid
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
