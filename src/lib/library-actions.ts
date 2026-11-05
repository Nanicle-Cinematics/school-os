"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { LIBRARY, LIBRARY_POLICY } from "@/lib/permissions";
import { setTenantContext } from "@/lib/tenant-context";
import {
  addCatalogue,
  addCopies,
  changeCopy,
  checkCatalogue,
  createBook,
  deleteBook,
  deleteCopy,
  lend,
  renewLoan,
  returnBook,
  savePolicy,
  updateBook,
  type CatalogueReport,
  type CopyChange,
} from "@/lib/library-engine";
import { readBook, readPolicy, type BorrowerKind } from "@/lib/library-rules";

/**
 * The library's doors. Each runs `requireRole`, sets the tenant context in its own frame (a context set inside
 * `requireRole` does not reach here) and hands the real work to the engine.
 *
 * A refusal hands back what was typed (`values`): React resets a form when its action returns, and the desk's one
 * box and the book form's twelve must not be wiped by one bad entry.
 */

export type LibraryState = { error?: string; ok?: string; values?: Record<string, string> };
export type CatalogueState = { error?: string; ok?: string; csv?: string; report?: CatalogueReport };

const KEYS_BOOK = ["title", "author", "isbn", "publisher", "publishedYear", "category", "shelf", "replacementCost", "notes", "copies"] as const;

function pick(formData: FormData, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, String(formData.get(key) ?? "")]));
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "");

function done(result: { ok: string } | { error: string }, values?: Record<string, string>): LibraryState {
  revalidatePath("/library", "layout");
  return "error" in result ? { error: result.error, values } : { ok: result.ok };
}

const kindOf = (value: string): BorrowerKind | null => (value === "STUDENT" || value === "STAFF" ? value : null);

/* ───────────────────────────── the desk ───────────────────────────── */

export async function lendAction(_prev: LibraryState, formData: FormData): Promise<LibraryState> {
  const auth = await requireRole(LIBRARY);
  setTenantContext(auth.tenant);
  const values = pick(formData, ["kind", "borrowerId", "accession"]);
  const kind = kindOf(values.kind!);
  if (!kind || !values.borrowerId) return { error: "Choose who is borrowing first.", values };
  return done(await lend({ schoolId: auth.schoolId, userId: auth.userId }, { kind, borrowerId: values.borrowerId, accession: values.accession! }), values);
}

export async function returnAction(_prev: LibraryState, formData: FormData): Promise<LibraryState> {
  const auth = await requireRole(LIBRARY);
  setTenantContext(auth.tenant);
  const values = pick(formData, ["accession"]);
  return done(await returnBook({ schoolId: auth.schoolId, userId: auth.userId }, { accession: values.accession! }), values);
}

/**
 * Return and Renew beside a person's books share one form, so one message serves the list and survives the row that
 * a return removes. The button's value is `return:<loanId>` or `renew:<loanId>`.
 */
export async function loanAction(_prev: LibraryState, formData: FormData): Promise<LibraryState> {
  const auth = await requireRole(LIBRARY);
  setTenantContext(auth.tenant);
  const actor = { schoolId: auth.schoolId, userId: auth.userId };
  const [what, loanId] = text(formData, "intent").split(":");
  if (!loanId) return { error: "Choose what to do with this loan." };
  if (what === "return") return done(await returnBook(actor, { loanId }));
  if (what === "renew") return done(await renewLoan(actor, loanId));
  return { error: "Choose what to do with this loan." };
}

/* ───────────────────────────── the catalogue ───────────────────────────── */

function readCopies(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return 1;
  return /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : null;
}

export async function createBookAction(_prev: LibraryState, formData: FormData): Promise<LibraryState> {
  const auth = await requireRole(LIBRARY);
  setTenantContext(auth.tenant);
  const values = pick(formData, KEYS_BOOK);

  const book = readBook(values);
  if (!book.ok) return { error: book.error, values };
  const copies = readCopies(values.copies!);
  if (copies === null) return { error: "Copies must be a whole number.", values };

  const made = await createBook({ schoolId: auth.schoolId, userId: auth.userId }, book.value, copies);
  if ("error" in made) return { error: made.error, values };
  revalidatePath("/library", "layout");
  redirect(`/library/books/${made.id}`);
}

export async function updateBookAction(_prev: LibraryState, formData: FormData): Promise<LibraryState> {
  const auth = await requireRole(LIBRARY);
  setTenantContext(auth.tenant);
  const values = pick(formData, [...KEYS_BOOK, "bookId"]);
  const book = readBook(values);
  if (!book.ok) return { error: book.error, values };
  return done(await updateBook({ schoolId: auth.schoolId, userId: auth.userId }, values.bookId!, book.value), values);
}

export async function deleteBookAction(_prev: LibraryState, formData: FormData): Promise<LibraryState> {
  const auth = await requireRole(LIBRARY);
  setTenantContext(auth.tenant);
  const result = await deleteBook({ schoolId: auth.schoolId, userId: auth.userId }, text(formData, "bookId"));
  if ("error" in result) return { error: result.error };
  revalidatePath("/library", "layout");
  redirect("/library/books");
}

export async function addCopiesAction(_prev: LibraryState, formData: FormData): Promise<LibraryState> {
  const auth = await requireRole(LIBRARY);
  setTenantContext(auth.tenant);
  const values = pick(formData, ["bookId", "count", "accessionNo"]);
  const count = readCopies(values.count!);
  if (count === null) return { error: "Copies must be a whole number.", values };
  return done(await addCopies({ schoolId: auth.schoolId, userId: auth.userId }, { bookId: values.bookId!, count, accessionNo: values.accessionNo }), values);
}

export async function changeCopyAction(_prev: LibraryState, formData: FormData): Promise<LibraryState> {
  const auth = await requireRole(LIBRARY);
  setTenantContext(auth.tenant);
  const change = text(formData, "change");
  if (change !== "lost" && change !== "withdraw" && change !== "reinstate") return { error: "Choose what to do with this copy." };
  return done(await changeCopy({ schoolId: auth.schoolId, userId: auth.userId }, text(formData, "copyId"), change as CopyChange, text(formData, "note")));
}

export async function deleteCopyAction(_prev: LibraryState, formData: FormData): Promise<LibraryState> {
  const auth = await requireRole(LIBRARY);
  setTenantContext(auth.tenant);
  return done(await deleteCopy({ schoolId: auth.schoolId, userId: auth.userId }, text(formData, "copyId")));
}

/* ───────────────────────────── set-up ───────────────────────────── */

export async function savePolicyAction(_prev: LibraryState, formData: FormData): Promise<LibraryState> {
  const auth = await requireRole(LIBRARY_POLICY);
  setTenantContext(auth.tenant);
  const values = pick(formData, ["pupilDays", "staffDays", "pupilMax", "staffMax", "blockOverdue"]);
  const policy = readPolicy(values);
  if (!policy.ok) return { error: policy.error, values };
  return done(await savePolicy({ schoolId: auth.schoolId, userId: auth.userId }, policy.value), values);
}

/* ───────────────────────────── import ───────────────────────────── */

/** The pasted text or the uploaded file, whichever was used. A register is a few hundred kilobytes at most. */
async function readCsv(formData: FormData): Promise<string> {
  const file = formData.get("file");
  if (file && typeof file !== "string" && file.size > 0) {
    if (file.size > 2_000_000) return "";
    return file.text();
  }
  return String(formData.get("csv") ?? "");
}

export async function checkCatalogueAction(_prev: CatalogueState, formData: FormData): Promise<CatalogueState> {
  const auth = await requireRole(LIBRARY);
  setTenantContext(auth.tenant);
  const csv = await readCsv(formData);
  if (!csv.trim()) return { error: "Paste the spreadsheet or choose a CSV file (under 2 MB)." };
  const report = await checkCatalogue(auth.schoolId, csv);
  return { csv, report };
}

export async function addCatalogueAction(_prev: CatalogueState, formData: FormData): Promise<CatalogueState> {
  const auth = await requireRole(LIBRARY);
  setTenantContext(auth.tenant);
  const csv = await readCsv(formData);
  if (!csv.trim()) return { error: "Paste the spreadsheet or choose a CSV file (under 2 MB)." };
  const result = await addCatalogue({ schoolId: auth.schoolId, userId: auth.userId }, csv);
  revalidatePath("/library", "layout");
  // Nothing added keeps the text, so the problems can be fixed in place; added clears it, so it cannot be added twice.
  return "error" in result ? { error: result.error, csv } : { ok: result.ok };
}
