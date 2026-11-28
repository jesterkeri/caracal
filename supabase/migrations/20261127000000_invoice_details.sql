-- Invoice details: the human part of an invoice (client name, description).
--
-- On chain an invoice is only (opaque ref, exact amount, status). Names and
-- descriptions stay here, in the freelancer's own rows. The client's pay page
-- never reads this table: it shows the amount and status from the chain.
--
-- Not applied by the app. Joshua applies migrations.

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The opaque id used on chain: 1 to 64 bytes as lowercase hex.
  invoice_ref text not null check (invoice_ref ~ '^([0-9a-f]{2}){1,64}$'),
  -- The owner's split contract the invoice was opened on (a C address).
  split text not null check (split ~ '^C[A-Z2-7]{55}$'),
  client_name text not null check (char_length(client_name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 500),
  -- The last ledger at which this invoice's opening can land: the passkey signature on it expires after
  -- this ledger (its signatureExpirationLedger), so any device can tell when an entry that never reached the
  -- chain is safe to remove (Codex invoices R1 #2).
  opens_by_ledger bigint not null check (opens_by_ledger > 0),
  created_at timestamptz not null default now(),
  unique (owner_id, invoice_ref)
);

create index if not exists invoices_owner_created_idx on public.invoices (owner_id, created_at desc);

alter table public.invoices enable row level security;

-- A user sees and changes only their own rows. There is no update policy:
-- an invoice's details are fixed once saved, as its amount is on chain.
create policy "invoices: read own" on public.invoices
  for select to authenticated using (owner_id = auth.uid());

create policy "invoices: insert own" on public.invoices
  for insert to authenticated with check (owner_id = auth.uid());

create policy "invoices: delete own" on public.invoices
  for delete to authenticated using (owner_id = auth.uid());

-- Anonymous visitors (a client opening a pay link) get nothing from this table.
revoke all on public.invoices from anon;
