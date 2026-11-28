// The human details of an invoice (client name, description), kept in the
// freelancer's own Supabase rows (supabase/migrations/..._invoice_details.sql,
// row-level security: a user sees only their own). Never on chain, never in a
// pay link.

/** opens_by_ledger: the last ledger the invoice's opening can land at (its passkey signature expires after it). */
export type Details = { invoice_ref: string; split: string; client_name: string; description: string; created_at: string; opens_by_ledger: number };
/**
 * owner_id is sent, not left to the database default (auth.uid() of whoever's session the request carries): if
 * another tab switched the shared session in the meantime, row-level security then refuses the insert instead
 * of filing these details under the other account (Codex invoices R1 #1).
 */
export type NewDetails = Pick<Details, "invoice_ref" | "split" | "client_name" | "description" | "opens_by_ledger"> & { owner_id: string };

type Result<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;
/** The part of the Supabase client used here. */
export type Db = {
  from(table: "invoices"): {
    select(columns: string): { order(column: string, opts: { ascending: boolean }): Result<Details[]> };
    insert(row: NewDetails): PromiseLike<{ error: { message: string } | null }>;
    delete(): { eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }> };
  };
};

export const NAME_MAX = 120;
export const DESCRIPTION_MAX = 500;

/** The details to save, or the reason they cannot be. */
export function checkDetails(name: string, description: string): { ok: true; name: string; description: string } | { ok: false; why: string } {
  const n = name.trim();
  const d = description.trim();
  if (n === "") return { ok: false, why: "Enter the client's name." };
  if (n.length > NAME_MAX) return { ok: false, why: `The client's name can be up to ${NAME_MAX} characters.` };
  if (d.length > DESCRIPTION_MAX) return { ok: false, why: `The description can be up to ${DESCRIPTION_MAX} characters.` };
  return { ok: true, name: n, description: d };
}

/** The signed-in user's invoice details, newest first. Throws with the database's reason. */
export async function listDetails(db: Db): Promise<Details[]> {
  const { data, error } = await db.from("invoices").select("invoice_ref,split,client_name,description,created_at,opens_by_ledger").order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function saveDetails(db: Db, row: NewDetails): Promise<void> {
  const { error } = await db.from("invoices").insert(row);
  if (error) throw new Error(error.message);
}

/** Removes the details of an invoice that never reached the chain. */
export async function deleteDetails(db: Db, ref: string): Promise<void> {
  const { error } = await db.from("invoices").delete().eq("invoice_ref", ref);
  if (error) throw new Error(error.message);
}
