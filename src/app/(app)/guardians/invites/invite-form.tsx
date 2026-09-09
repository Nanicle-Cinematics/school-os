"use client";

import { useActionState, useState } from "react";
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

  // CONTROLLED on purpose. Left uncontrolled, the select reset to "Every class"
  // when useActionState re-rendered the form after a preview — so the card read
  // "Create 3 logins" for one class while the field underneath said every class,
  // and pressing it would have created 43 and sent 43 texts. The preview and the
  // run must be the same audience, and that means the value has to survive the
  // re-render.
  const [classGroupId, setClassGroupId] = useState("");

  const shown = sendState.result ? sendState : state;

  return (
    <form action={formAction} className="space-y-4">
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

          <SubmitButton pendingLabel="Checking…">Preview</SubmitButton>
        </div>
      </Card>

      {shown.error ? <Alert tone="error">{shown.error}</Alert> : null}

      {state.preview && !sendState.result ? (
        <Card title="What will happen">
          <div className="space-y-3 p-4">
            <p className="text-sm text-slate-900">
              <span className="font-bold">{state.preview.count}</span> login
              {state.preview.count === 1 ? "" : "s"} will be created
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
              <SubmitButton formAction={sendAction} pendingLabel="Creating…">
                Create {state.preview.count} login
                {state.preview.count === 1 ? "" : "s"}
                {smsLive ? " and text them" : ""}
              </SubmitButton>
            ) : null}
          </div>
        </Card>
      ) : null}

      {sendState.result ? (
        <Card title="Done">
          <div className="space-y-3 p-4">
            <p className="text-sm text-slate-900">
              <span className="font-bold">{sendState.result.created}</span> login
              {sendState.result.created === 1 ? "" : "s"} created,{" "}
              <span className="font-bold">{sendState.result.texted}</span> texted.
              {sendState.result.remaining > 0
                ? ` ${sendState.result.remaining} still to do — run it again.`
                : ""}
            </p>

            {sendState.result.undelivered.length > 0 ? (
              <>
                <Alert tone="error">
                  {sendState.result.undelivered.length} password
                  {sendState.result.undelivered.length === 1 ? " was" : "s were"} not
                  delivered. This is the only time they are shown — write them down
                  and give them to the parent.
                </Alert>
                <ul className="space-y-1 text-sm">
                  {sendState.result.undelivered.map((u) => (
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
