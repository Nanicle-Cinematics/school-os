"use client";

import { useActionState, useState } from "react";
import { saveItemsToBring, type ActionState } from "@/lib/fee-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, Card, inputClass } from "../../ui";

type Level = { id: string; name: string; items: string };

/**
 * One box per level. The boxes are CONTROLLED, so a refusal (a list over the cap) does not wipe what was
 * typed: React resets a form's fields when its action returns, and a controlled field is the one that
 * keeps its text (CLAUDE.md, the mark sheet).
 */
export function ItemsForm({ levels }: { levels: Level[] }) {
  const [state, formAction] = useActionState<ActionState, FormData>(saveItemsToBring, {});
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(levels.map((l) => [l.id, l.items])));

  return (
    <form action={formAction} className="space-y-4">
      {levels.map((level) => (
        <Card key={level.id} title={level.name}>
          <label className="block p-4">
            <span className="sr-only">Items to bring for {level.name}</span>
            <textarea
              name={`items:${level.id}`}
              rows={4}
              value={text[level.id] ?? ""}
              onChange={(e) => setText((prev) => ({ ...prev, [level.id]: e.target.value }))}
              className={inputClass}
            />
          </label>
        </Card>
      ))}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
      <SubmitButton pendingLabel="Saving…">Save lists</SubmitButton>
    </form>
  );
}
