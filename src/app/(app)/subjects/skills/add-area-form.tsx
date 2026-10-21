"use client";

import { useActionState } from "react";
import { addSkillArea, type SkillState } from "@/lib/skill-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, Card, inputClass } from "../../ui";

export function AddAreaForm({ levelId, levelName }: { levelId: string; levelName: string }) {
  const [state, formAction] = useActionState<SkillState, FormData>(addSkillArea, {});

  return (
    <Card title="Add an area">
      <form action={formAction} className="space-y-3 p-4">
        <input type="hidden" name="levelId" value={levelId} />
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-56 flex-1 text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              An area of {levelName}, such as Language, Reading or Free play
            </span>
            <input type="text" name="name" maxLength={60} required className={inputClass} />
          </label>
          <SubmitButton variant="secondary" pendingLabel="Adding…">
            Add area
          </SubmitButton>
        </div>
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
      </form>
    </Card>
  );
}
