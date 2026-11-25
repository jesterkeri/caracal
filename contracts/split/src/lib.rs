#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Bytes, Env,
};

const BPS_DENOM: i128 = 10_000;
const MAX_REF_LEN: u32 = 64;
const TTL_THRESHOLD: u32 = 100_000;
const TTL_EXTEND_TO: u32 = 500_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    BpsTooHigh = 1,
    InvalidAmount = 2,
    InvalidInvoiceRef = 3,
    InsufficientBalance = 4,
    SamePot = 5,
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
}

#[contractevent]
pub struct Split {
    pub invoice_ref: Bytes,
    pub from: Address,
    pub amount: i128,
    pub tax: i128,
    pub goal: i128,
    pub spend: i128,
}

#[contractevent]
pub struct Withdraw {
    pub pot: Pot,
    pub to: Address,
    pub amount: i128,
}

#[contractevent]
pub struct Reallocate {
    pub from_pot: Pot,
    pub to_pot: Pot,
    pub amount: i128,
}

#[contractevent]
pub struct SplitChanged {
    pub tax_bps: u32,
    pub goal_bps: u32,
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
        let tax = amount * (tax_bps as i128) / BPS_DENOM;
        let goal = amount * (goal_bps as i128) / BPS_DENOM;
        let spend = amount - tax - goal;

        token::Client::new(&env, &token_addr(&env)).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
        set_pot(&env, Pot::Tax, get_pot(&env, Pot::Tax) + tax);
        set_pot(&env, Pot::Goal, get_pot(&env, Pot::Goal) + goal);
        set_pot(&env, Pot::Spend, get_pot(&env, Pot::Spend) + spend);
        Split { invoice_ref, from, amount, tax, goal, spend }.publish(&env);
        Ok(())
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
        set_pot(&env, to_pot, get_pot(&env, to_pot) + amount);
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
