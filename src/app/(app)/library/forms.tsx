"use client";

import { useActionState } from "react";
import {
  addCopiesAction,
  changeCopyAction,
  createBookAction,
  deleteBookAction,
  deleteCopyAction,
  lendAction,
  loanAction,
  returnAction,
  savePolicyAction,
  updateBookAction,
  type LibraryState,
} from "@/lib/library-actions";
import type { LibraryPolicy, LoanState } from "@/lib/library-rules";
import { Button } from "../primitives";
import { SubmitButton } from "../submit-button";
import { Alert, inputClass } from "../ui";
import { LoanBadge } from "./loan-badge";

const Message = ({ state }: { state: LibraryState }) =>
  state.error ? <Alert tone="error">{state.error}</Alert> : state.ok ? <Alert tone="success">{state.ok}</Alert> : null;

const Label = ({ text, children, hint }: { text: string; children: React.ReactNode; hint?: string }) => (
  <label className="block">
    <span className="mb-1.5 block text-sm font-medium text-slate-700">{text}</span>
    {children}
    {hint ? <span className="mt-1 block text-xs text-slate-400">{hint}</span> : null}
  </label>
);

/* ───────────────────────────── the desk ───────────────────────────── */

/**
 * One box, and the scanner's Enter submits it. The box clears when a book goes out (React resets the form, which is
 * exactly right for the next book) and keeps what was typed when the desk refuses, so a mistyped digit is one
 * keystroke to fix.
 */
export function LendForm({ kind, borrowerId }: { kind: "STUDENT" | "STAFF"; borrowerId: string }) {
  const [state, action] = useActionState<LibraryState, FormData>(lendAction, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="borrowerId" value={borrowerId} />
      <Label text="Accession number" hint="Scan the label inside the book, or type its number.">
        <input name="accession" required autoFocus autoComplete="off" defaultValue={state.values?.accession ?? ""} className={inputClass} />
      </Label>
      <Message state={state} />
      <SubmitButton pendingLabel="Lending…">Lend this book</SubmitButton>
    </form>
  );
}

export function ReturnForm() {
  const [state, action] = useActionState<LibraryState, FormData>(returnAction, {});
  return (
    <form action={action} className="space-y-3">
      <Label text="Accession number" hint="Scan or type the number of the book being brought back. You do not need to know who had it.">
        <input name="accession" required autoComplete="off" defaultValue={state.values?.accession ?? ""} className={inputClass} />
      </Label>
      <Message state={state} />
      <SubmitButton variant="secondary" pendingLabel="Taking back…">Take this book back</SubmitButton>
    </form>
  );
}

export type LoanItem = {
  id: string;
  title: string;
  author: string | null;
  accessionNo: string;
  dueOn: string;
  state: LoanState;
  daysOverdue: number;
  renewals: number;
  canRenew: boolean;
};

/**
 * A person's books, each with Return and Renew. One form serves the whole list so that one message does too, and it
 * survives the row a return removes ("Returned, 3 days late" would otherwise vanish with the book it describes).
 */
export function BorrowerLoans({ loans }: { loans: LoanItem[] }) {
  const [state, action] = useActionState<LibraryState, FormData>(loanAction, {});
  return (
    <form action={action}>
      {loans.length === 0 ? (
        <p className="px-4.5 py-4 text-sm text-slate-500">Nothing out at the moment.</p>
      ) : (
        <ul className="divide-y divide-hairline">
          {loans.map((loan) => (
            <li key={loan.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4.5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-900">{loan.title}</p>
                <p className="text-xs text-slate-500">
                  {loan.accessionNo}
                  {loan.author ? ` · ${loan.author}` : ""} · due {loan.dueOn}
                  {loan.renewals > 0 ? ` · renewed ${loan.renewals}×` : ""}
                </p>
              </div>
              <LoanBadge state={loan.state} days={loan.daysOverdue} />
              <div className="flex gap-2">
                <Button type="submit" name="intent" value={`return:${loan.id}`} size="sm">
                  Return
                </Button>
                {loan.canRenew ? (
                  <Button type="submit" name="intent" value={`renew:${loan.id}`} variant="ghost" size="sm">
                    Renew
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {state.error || state.ok ? (
        <div className="px-4.5 pb-4">
          <Message state={state} />
        </div>
      ) : null}
    </form>
  );
}

/* ───────────────────────────── a book ───────────────────────────── */

export type BookValues = {
  title: string;
  author: string;
  isbn: string;
  publisher: string;
  publishedYear: string;
  category: string;
  shelf: string;
  replacementCost: string;
  notes: string;
};

const EMPTY_BOOK: BookValues = { title: "", author: "", isbn: "", publisher: "", publishedYear: "", category: "", shelf: "", replacementCost: "", notes: "" };

/**
 * Add a title (with its first copies) or edit one. The edit form is keyed on what was saved, so after a save it
 * remounts with the new values rather than relying on React to reset it to them.
 */
export function BookForm({ book, bookId, categories }: { book?: BookValues; bookId?: string; categories: string[] }) {
  const editing = Boolean(bookId);
  const [state, action] = useActionState<LibraryState, FormData>(editing ? updateBookAction : createBookAction, {});
  const start = book ?? EMPTY_BOOK;
  const v = (key: keyof BookValues) => state.values?.[key] ?? start[key];
  return (
    <form key={editing ? JSON.stringify(start) : "new"} action={action} className="space-y-4 px-4.5 py-4">
      {editing ? <input type="hidden" name="bookId" value={bookId} /> : null}
      <Label text="Title">
        <input name="title" required maxLength={200} defaultValue={v("title")} className={inputClass} />
      </Label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="Author">
          <input name="author" maxLength={150} defaultValue={v("author")} className={inputClass} />
        </Label>
        <Label text="Publisher">
          <input name="publisher" maxLength={150} defaultValue={v("publisher")} className={inputClass} />
        </Label>
        <Label text="ISBN" hint="Optional. 10 or 13 digits; hyphens are fine.">
          <input name="isbn" maxLength={20} defaultValue={v("isbn")} className={inputClass} />
        </Label>
        <Label text="Year published">
          <input name="publishedYear" inputMode="numeric" maxLength={4} defaultValue={v("publishedYear")} className={inputClass} />
        </Label>
        <Label text="Category" hint="Storybooks, Science, Reference… type your own.">
          <input name="category" list="library-categories" maxLength={60} defaultValue={v("category")} className={inputClass} />
          <datalist id="library-categories">
            {categories.map((category) => (
              <option key={category} value={category} />
            ))}
          </datalist>
        </Label>
        <Label text="Shelf" hint="Where it lives, e.g. A3.">
          <input name="shelf" maxLength={40} defaultValue={v("shelf")} className={inputClass} />
        </Label>
        <Label text="Replacement cost (GH₵)" hint="Shown if a copy is lost. Nothing is billed.">
          <input name="replacementCost" inputMode="decimal" maxLength={12} defaultValue={v("replacementCost")} className={inputClass} />
        </Label>
        {editing ? null : (
          <Label text="Copies to add now" hint="Each gets its own accession number. You can add more later.">
            <input name="copies" inputMode="numeric" maxLength={3} defaultValue={state.values?.copies ?? "1"} className={inputClass} />
          </Label>
        )}
      </div>
      <Label text="Notes">
        <textarea name="notes" rows={2} maxLength={500} defaultValue={v("notes")} className={inputClass} />
      </Label>
      <Message state={state} />
      <SubmitButton pendingLabel="Saving…">{editing ? "Save changes" : "Add this book"}</SubmitButton>
    </form>
  );
}

export function AddCopiesForm({ bookId }: { bookId: string }) {
  const [state, action] = useActionState<LibraryState, FormData>(addCopiesAction, {});
  return (
    <form action={action} className="space-y-3 px-4.5 py-4">
      <input type="hidden" name="bookId" value={bookId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="How many copies" hint="Numbered for you, one after another.">
          <input name="count" inputMode="numeric" maxLength={3} defaultValue={state.values?.count ?? "1"} className={inputClass} />
        </Label>
        <Label text="…or one copy with its own number" hint="If the book already carries a number from your register.">
          <input name="accessionNo" maxLength={40} defaultValue={state.values?.accessionNo ?? ""} className={inputClass} />
        </Label>
      </div>
      <Message state={state} />
      <SubmitButton variant="secondary" pendingLabel="Adding…">Add copies</SubmitButton>
    </form>
  );
}

export function DeleteBookButton({ bookId, title }: { bookId: string; title: string }) {
  const [state, action] = useActionState<LibraryState, FormData>(deleteBookAction, {});
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`Delete "${title}" and all its copies? This cannot be undone.`)) e.preventDefault();
      }}
      className="space-y-2"
    >
      <input type="hidden" name="bookId" value={bookId} />
      <SubmitButton variant="danger" pendingLabel="Deleting…">Delete this book</SubmitButton>
      <Message state={state} />
    </form>
  );
}

/** What can be done to one copy, behind a "Manage" disclosure so a long list of copies stays readable. */
export function CopyActions({ copyId, status, onLoan, everLent }: { copyId: string; status: "ACTIVE" | "LOST" | "WITHDRAWN"; onLoan: boolean; everLent: boolean }) {
  const [state, action] = useActionState<LibraryState, FormData>(changeCopyAction, {});
  const [deleted, deleteAction] = useActionState<LibraryState, FormData>(deleteCopyAction, {});
  const confirm = (message: string) => (e: React.MouseEvent) => {
    if (!window.confirm(message)) e.preventDefault();
  };
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-brand-ink hover:underline">Manage</summary>
      <div className="mt-2 space-y-3">
        <form action={action} className="space-y-2">
          <input type="hidden" name="copyId" value={copyId} />
          {status === "ACTIVE" ? (
            <>
              <input name="note" maxLength={300} placeholder="Reason (optional)" aria-label="Reason" className={inputClass} />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" name="change" value="lost" size="sm" onClick={confirm("Record this copy as lost?")}>
                  Record as lost
                </Button>
                {onLoan ? null : (
                  <Button type="submit" name="change" value="withdraw" variant="ghost" size="sm" onClick={confirm("Withdraw this copy from the library?")}>
                    Withdraw
                  </Button>
                )}
              </div>
            </>
          ) : (
            <Button type="submit" name="change" value="reinstate" size="sm">
              Put back in stock
            </Button>
          )}
          <Message state={state} />
        </form>
        {everLent ? null : (
          <form action={deleteAction} className="space-y-2">
            <input type="hidden" name="copyId" value={copyId} />
            <Button type="submit" variant="danger" size="sm" onClick={confirm("Delete this copy? It has never been lent.")}>
              Delete (entered by mistake)
            </Button>
            <Message state={deleted} />
          </form>
        )}
      </div>
    </details>
  );
}

/* ───────────────────────────── the rules ───────────────────────────── */

export function PolicyForm({ policy }: { policy: LibraryPolicy }) {
  const [state, action] = useActionState<LibraryState, FormData>(savePolicyAction, {});
  const v = (key: string, fallback: number) => state.values?.[key] ?? String(fallback);
  const block = state.values ? state.values.blockOverdue : policy.blockOverdue ? "yes" : "no";
  return (
    <form key={JSON.stringify(policy)} action={action} className="space-y-4 px-4.5 py-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="Days a pupil may keep a book">
          <input name="pupilDays" inputMode="numeric" required maxLength={3} defaultValue={v("pupilDays", policy.pupilDays)} className={inputClass} />
        </Label>
        <Label text="Days a member of staff may keep a book">
          <input name="staffDays" inputMode="numeric" required maxLength={3} defaultValue={v("staffDays", policy.staffDays)} className={inputClass} />
        </Label>
        <Label text="Books a pupil may hold at once">
          <input name="pupilMax" inputMode="numeric" required maxLength={2} defaultValue={v("pupilMax", policy.pupilMax)} className={inputClass} />
        </Label>
        <Label text="Books a member of staff may hold at once">
          <input name="staffMax" inputMode="numeric" required maxLength={2} defaultValue={v("staffMax", policy.staffMax)} className={inputClass} />
        </Label>
      </div>
      <Label text="When someone has an overdue book" hint="Books already out keep the date they were given; a change applies to new loans and renewals.">
        <select name="blockOverdue" defaultValue={block} className={inputClass}>
          <option value="yes">They cannot borrow another until it is back</option>
          <option value="no">They can still borrow</option>
        </select>
      </Label>
      <Message state={state} />
      <SubmitButton pendingLabel="Saving…">Save the rules</SubmitButton>
    </form>
  );
}
