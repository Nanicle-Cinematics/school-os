"use client";

import { useActionState } from "react";
import {
  removeGatewayKey,
  saveGatewayKey,
  setGatewayEnabled,
  type GatewayState,
} from "@/lib/online-payment-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, Field, inputClass } from "../../ui";

function Feedback({ state }: { state: GatewayState }) {
  if (!state.error && !state.ok) {
    return null;
  }
  return (
    <div className="mt-4">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
    </div>
  );
}

/**
 * The secret key goes in once and is never shown again. The field is cleared by React's own form
 * reset when the action returns, which is the right behaviour here (the opposite of the mark grids):
 * a key left sitting in a box is a key left on a shared screen.
 */
export function GatewayKeyForm({ hasKey }: { hasKey: boolean }) {
  const [state, formAction] = useActionState<GatewayState, FormData>(saveGatewayKey, {});

  return (
    <form action={formAction} className="p-4">
      <Field
        label={hasKey ? "Replace the secret key" : "Paystack secret key"}
        hint="From Paystack: Settings → API Keys & Webhooks. It starts with sk_test_ or sk_live_."
      >
        <input
          type="password"
          name="secretKey"
          autoComplete="off"
          spellCheck={false}
          required
          className={inputClass}
        />
      </Field>
      <Feedback state={state} />
      <div className="mt-4">
        <SubmitButton pendingLabel="Checking with Paystack…">
          {hasKey ? "Replace key" : "Save key"}
        </SubmitButton>
      </div>
    </form>
  );
}

export function GatewaySwitchForm({ enabled, hasKey }: { enabled: boolean; hasKey: boolean }) {
  const [state, formAction] = useActionState<GatewayState, FormData>(setGatewayEnabled, {});

  return (
    <form action={formAction} className="p-4">
      <input type="hidden" name="enable" value={enabled ? "0" : "1"} />
      <p className="text-sm text-slate-600">
        {enabled
          ? "Parents see a Pay now button on their child's fees page."
          : "Parents cannot pay online. Turn this on once the key is saved and the webhook is set up in Paystack."}
      </p>
      <Feedback state={state} />
      <div className="mt-4">
        <SubmitButton pendingLabel="Saving…" disabled={!enabled && !hasKey}>
          {enabled ? "Switch online payments off" : "Switch online payments on"}
        </SubmitButton>
      </div>
    </form>
  );
}

export function GatewayRemoveForm() {
  const [state, formAction] = useActionState<GatewayState, FormData>(removeGatewayKey, {});

  return (
    <form action={formAction} className="p-4">
      <p className="text-sm text-slate-600">
        Removing the key switches online payments off. A payment a parent has already started is still
        recorded if it completes, so remove the key only when you are sure none are in flight.
      </p>
      <Feedback state={state} />
      <div className="mt-4">
        <SubmitButton pendingLabel="Removing…">Remove the key</SubmitButton>
      </div>
    </form>
  );
}
