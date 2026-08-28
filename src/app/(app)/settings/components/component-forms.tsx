"use client";

import { useActionState } from "react";
import {
  applyDefaultComponents,
  deleteComponent,
  saveComponent,
  type StructureState,
} from "@/lib/structure-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, inputClass } from "../../ui";

export type ComponentRow = {
  id: string;
  title: string;
  type: string;
  maxScore: number;
  isExam: boolean;
  order: number;
};

const TYPES = [
  { value: "CLASS_TEST", label: "Class test" },
  { value: "GROUP_WORK", label: "Group work" },
  { value: "PROJECT", label: "Project" },
  { value: "CLASS_EXERCISE", label: "Class exercise" },
  { value: "HOMEWORK", label: "Homework" },
  { value: "MIDTERM_EXAM", label: "Mid-term exam" },
  { value: "END_OF_TERM_EXAM", label: "End of term exam" },
];

function Feedback({ state }: { state: StructureState }) {
  if (!state.error && !state.ok) return null;
  return (
    <div className="mt-2">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
    </div>
  );
}

function Fields({ values }: { values?: ComponentRow }) {
  return (
    <div className="grid flex-1 gap-2 sm:grid-cols-4">
      <input
        type="text"
        name="title"
        required
        placeholder="Class Test 1"
        defaultValue={values?.title ?? ""}
        aria-label="Component name"
        className={inputClass}
      />
      <select
        name="type"
        defaultValue={values?.type ?? "CLASS_TEST"}
        aria-label="Kind"
        className={inputClass}
      >
        {TYPES.map((type) => (
          <option key={type.value} value={type.value}>
            {type.label}
          </option>
        ))}
      </select>
      <input
        type="number"
        name="maxScore"
        required
        min={1}
        max={1000}
        placeholder="Total marks"
        defaultValue={values?.maxScore ?? ""}
        aria-label="Total marks"
        className={inputClass}
      />
      <input
        type="number"
        name="order"
        placeholder="Order"
        defaultValue={values?.order ?? ""}
        aria-label="Order"
        className={inputClass}
      />
    </div>
  );
}

function ComponentItem({ component }: { component: ComponentRow }) {
  const [state, formAction] = useActionState<StructureState, FormData>(saveComponent, {});

  return (
    <li className="border-t border-slate-100 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <form action={formAction} className="flex flex-1 flex-wrap items-start gap-2">
          <input type="hidden" name="id" value={component.id} />
          <Fields values={component} />
          <SubmitButton variant="secondary" pendingLabel="…">
            Save
          </SubmitButton>
        </form>

        <form action={deleteComponent} className="self-center">
          <input type="hidden" name="id" value={component.id} />
          <SubmitButton variant="danger" pendingLabel="…">
            Delete
          </SubmitButton>
        </form>
      </div>
      {component.isExam ? (
        <p className="mt-1 text-xs text-slate-400">
          Counts toward the exam score rather than the class score.
        </p>
      ) : null}
      <Feedback state={state} />
    </li>
  );
}

export function ComponentSection({
  components,
  classWeight,
  examWeight,
}: {
  components: ComponentRow[];
  classWeight: number;
  examWeight: number;
}) {
  const [addState, addAction] = useActionState<StructureState, FormData>(saveComponent, {});
  const [defaultsState, defaultsAction] = useActionState<StructureState, FormData>(
    applyDefaultComponents,
    {},
  );

  const classMarks = components
    .filter((c) => !c.isExam)
    .reduce((sum, c) => sum + c.maxScore, 0);
  const examMarks = components.filter((c) => c.isExam).reduce((sum, c) => sum + c.maxScore, 0);

  return (
    <>
      {components.length === 0 ? (
        <div className="border-b border-slate-100 bg-amber-50/60 px-4 py-3 text-sm text-amber-900">
          No components are set up, so a teacher opening a mark sheet finds nothing to mark. Start
          from the standard six below.
        </div>
      ) : (
        <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-3 text-sm text-slate-600">
          Class components are worth <span className="font-medium">{classMarks} marks</span> in
          total, scaled to {classWeight} on the report card. The exam is worth{" "}
          <span className="font-medium">{examMarks}</span>, scaled to {examWeight}. A component
          worth more marks counts for proportionally more — there is no separate weighting to set.
        </div>
      )}

      <ul>
        {components.map((component) => (
          <ComponentItem key={component.id} component={component} />
        ))}
      </ul>

      <div className="border-t border-slate-100 bg-slate-50/60 p-4">
        <form action={addAction} className="flex flex-wrap items-start gap-2">
          <Fields />
          <SubmitButton pendingLabel="Adding…">Add component</SubmitButton>
        </form>
        <Feedback state={addState} />

        <div className="mt-4 border-t border-slate-200 pt-3">
          <form action={defaultsAction}>
            <SubmitButton variant="secondary" pendingLabel="Adding…">
              {components.length === 0
                ? "Add the standard components"
                : "Add any standard components that are missing"}
            </SubmitButton>
          </form>
          <Feedback state={defaultsState} />
          <p className="mt-2 text-xs text-slate-400">
            Class Test 1 and 2, Group Work 1 and 2, Project Work and the Examination. Nothing you
            have renamed or re-marked is touched.
          </p>
        </div>
      </div>
    </>
  );
}
