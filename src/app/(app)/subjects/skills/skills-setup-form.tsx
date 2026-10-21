"use client";

import { useActionState, useState } from "react";
import { saveLevelSkills, type SkillState } from "@/lib/skill-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, Card, inputClass } from "../../ui";

type Area = {
  subjectId: string;
  name: string;
  skills: { id: string; name: string; rated: number }[];
};

/**
 * Every area's skills as one form: a row per skill, and a box per area for new ones, one a line.
 *
 * ⚠️ The rows are CONTROLLED and live in a child that is re-keyed from what the server holds. React
 * resets a form's fields once its action returns, so an uncontrolled row would fall back to its old
 * text after a refusal, taking the typing with it; a controlled one keeps it. The key changes only
 * when a save SUCCEEDS (the lists the server sends back are different), which clears the "add" boxes
 * and shows the new rows. The message sits outside the key so it survives the re-mount.
 */
export function SkillsSetupForm({ levelId, areas }: { levelId: string; areas: Area[] }) {
  const [state, formAction] = useActionState<SkillState, FormData>(saveLevelSkills, {});
  const version = areas.map((a) => a.skills.map((s) => `${s.id}:${s.name}`).join("|")).join("/");

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="levelId" value={levelId} />
      <Rows key={version} areas={areas} />

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…">Save skills</SubmitButton>
        <p className="text-xs text-slate-500">
          Clear a skill&rsquo;s box to remove it. A skill that children have already been rated on can
          be renamed but not removed.
        </p>
      </div>
    </form>
  );
}

function Rows({ areas }: { areas: Area[] }) {
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(areas.flatMap((area) => area.skills.map((skill) => [skill.id, skill.name]))),
  );
  const [adds, setAdds] = useState<Record<string, string>>({});

  return (
    <>
      {areas.map((area) => (
        <Card key={area.subjectId} title={area.name}>
          <div className="space-y-2 p-4">
            {area.skills.length === 0 ? (
              <p className="text-sm text-slate-500">No skills listed yet.</p>
            ) : null}
            {area.skills.map((skill) => (
              <label key={skill.id} className="flex items-center gap-3">
                <span className="sr-only">Skill under {area.name}</span>
                <input
                  type="text"
                  name={`skill:${skill.id}`}
                  maxLength={60}
                  value={names[skill.id] ?? ""}
                  onChange={(e) => setNames((prev) => ({ ...prev, [skill.id]: e.target.value }))}
                  className={inputClass}
                />
                {skill.rated > 0 ? (
                  <span className="shrink-0 text-xs text-slate-500">
                    rated for {skill.rated}
                  </span>
                ) : null}
              </label>
            ))}
            <label className="block pt-1">
              <span className="mb-1 block text-xs font-medium text-slate-500">
                Add skills to {area.name}, one on each line
              </span>
              <textarea
                name={`add:${area.subjectId}`}
                rows={2}
                value={adds[area.subjectId] ?? ""}
                onChange={(e) => setAdds((prev) => ({ ...prev, [area.subjectId]: e.target.value }))}
                className={inputClass}
              />
            </label>
          </div>
        </Card>
      ))}
    </>
  );
}
