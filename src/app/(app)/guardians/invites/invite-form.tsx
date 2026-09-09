"use client";

import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { previewInvites, sendInvites, type InviteState } from "@/lib/portal-invite-actions";
import { Alert, Card, Field, filterClass } from "../../ui";
import { SubmitButton } from "../../submit-button";

/**
 * Preview first, always.
 *
 * This spends real money and creates real accounts, so the office sees the
 * count, the cost and every guardian who will be SKIPPED before anything
 * happens. One form drives both actions — the same shape as the SMS campaign
 * screen — so the audience previewed is exactly the audience sent to.
 */
export function InviteForm({
  classes,
  smsLive,
}: {
  classes: { id: string; label: string }[];
  smsLive: boolean;
}) {
  const [state, formAction] = useActionState<InviteState, FormData>(previewInvites, {});
  const [sendState, sendAction] = useActionState<InviteState, FormData>(sendInvites, {});

  const [classGroupId, setClassGroupId] = useState("");
  const selectRef = useRef<HTMLSelectElement>(null);

  // ⚠️ React RESETS a form's DOM fields once its action completes, and being
  // CONTROLLED does not save this select from it: the re-render carries the same
  // `value` prop it had before, React sees no change and leaves the reset node
  // alone. So after a preview the field silently showed "Every class" again while
  // the card above still read "3 logins will be created" — and pressing Create
  // invited all 43 guardians in the school. Put the choice back after every run.
  useEffect(() => {
    if (selectRef.current) selectRef.current.value = classGroupId;
  }, [classGroupId, state, sendState]);

  const previewed = state.preview;

  // Say the class out loud wherever a number appears. "3 logins" and "43 logins"
  // look equally reasonable on their own; "3 logins for Kindergarten 1 A" does not.
  const classLabel = (id: string | null | undefined) =>
    id ? (classes.find((c) => c.id === id)?.label ?? "that class") : "every class";

  /**
   * Which card the screen is currently about.
   *
   * `useActionState` keeps a result forever, so after one class was invited the
   * Done card sat on top of every later preview and the next class could not be
   * checked at all without reloading the page — on a screen whose whole design is
   * "a class at a time". Previewing again therefore puts the run's result away.
   */
  const [ranFor, setRanFor] = useState<string | null>(null);
  const done = ranFor !== null ? sendState.result : undefined;
  // A run that REFUSES has no result, so the screen must still be showing the
  // run's state — otherwise it falls back to the preview's and the refusal is
  // rendered nowhere at all, which is how a guard comes to fire in silence.
  const ran = ranFor !== null;

  const previewAgain = useCallback(
    (formData: FormData) => {
      setRanFor(null);
      return formAction(formData);
    },
    [formAction],
  );

  // The run's audience is the one the SERVER previewed, carried in React state —
  // never re-read from the form, for the reason above. `expectedCount` goes with
  // it so the action can refuse outright if the school no longer matches what
  // was on screen; a login is not something to create on a stale count.
  const runInvites = useCallback(
    (formData: FormData) => {
      formData.set("classGroupId", previewed?.classGroupId ?? "");
      formData.set("expectedCount", String(previewed?.count ?? ""));
      setRanFor(classLabel(previewed?.classGroupId));
      return sendAction(formData);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewed?.classGroupId, previewed?.count, sendAction],
  );

  const shown = ran ? sendState : state;

  return (
    <form action={previewAgain} className="space-y-4">
      <Card title="Who to invite">
        <div className="space-y-3 p-4">
          {!smsLive ? (
            <Alert tone="error">
              SMS is switched off for this school, so nothing will be texted. Logins
              are still created, and every temporary password is shown here once so
              you can pass them on. Turn SMS on in Settings to send them instead.
            </Alert>
          ) : null}

          <Field label="Class">
            <select
              ref={selectRef}
              name="classGroupId"
              className={filterClass}
              value={classGroupId}
              onChange={(e) => setClassGroupId(e.target.value)}
            >
              <option value="">Every class</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>

          <p className="text-sm text-slate-600">
            Guardians who already have a login, or who have no usable Ghana mobile
            number, are skipped and listed below.
          </p>

          <SubmitButton formAction={previewAgain} pendingLabel="Checking…">
            Preview
          </SubmitButton>
        </div>
      </Card>

      {shown.error ? <Alert tone="error">{shown.error}</Alert> : null}

      {state.preview && !done ? (
        <Card title="What will happen">
          <div className="space-y-3 p-4">
            <p className="text-sm text-slate-900">
              <span className="font-bold">{state.preview.count}</span> login
              {state.preview.count === 1 ? "" : "s"} will be created for{" "}
              <span className="font-bold">{classLabel(state.preview.classGroupId)}</span>
              {smsLive ? (
                <>
                  {" "}and texted — {state.preview.segments} SMS segment
                  {state.preview.segments === 1 ? "" : "s"}, about GH₵
                  {state.preview.cost.toFixed(2)}
                </>
              ) : null}
              .
            </p>

            {state.preview.overLimit > 0 ? (
              <Alert tone="error">
                {state.preview.overLimit} more will be left over — this runs 60 at a
                time so it does not time out. Run it again afterwards, or go class by
                class.
              </Alert>
            ) : null}

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                The message
              </p>
              <p className="mt-1 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                {state.preview.sample}
              </p>
            </div>

            {state.preview.skipped.length > 0 ? (
              <details>
                <summary className="cursor-pointer text-sm font-semibold text-slate-700">
                  {state.preview.skipped.length} skipped — why
                </summary>
                <ul className="mt-2 space-y-1 text-sm text-slate-600">
                  {state.preview.skipped.map((s) => (
                    <li key={s.guardianId}>
                      {s.name} — {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            {state.preview.count > 0 ? (
              <SubmitButton formAction={runInvites} pendingLabel="Creating…">
                Create {state.preview.count} login
                {state.preview.count === 1 ? "" : "s"} for{" "}
                {classLabel(state.preview.classGroupId)}
                {smsLive ? " and text them" : ""}
              </SubmitButton>
            ) : null}
          </div>
        </Card>
      ) : null}

      {done ? (
        <Card title="Done">
          <div className="space-y-3 p-4">
            <p className="text-sm text-slate-900">
              <span className="font-bold">{done.created}</span> login
              {done.created === 1 ? "" : "s"} created for{" "}
              <span className="font-bold">{ranFor}</span>,{" "}
              <span className="font-bold">{done.texted}</span> texted.
              {done.remaining > 0
                ? ` ${done.remaining} still to do — run it again.`
                : ""}
            </p>

            {done.undelivered.length > 0 ? (
              <>
                <Alert tone="error">
                  {done.undelivered.length} password
                  {done.undelivered.length === 1 ? " was" : "s were"} not
                  delivered. This is the only time they are shown — write them down
                  and give them to the parent.
                </Alert>
                <ul className="space-y-1 text-sm">
                  {done.undelivered.map((u) => (
                    <li key={u.phone} className="rounded-lg bg-slate-50 p-2">
                      <span className="font-semibold text-slate-900">{u.name}</span>{" "}
                      <span className="text-slate-500">{u.phone}</span>
                      {" — "}
                      <span className="font-mono font-bold text-slate-900">{u.password}</span>
                      <span className="text-slate-500"> ({u.why})</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </Card>
      ) : null}
    </form>
  );
}
