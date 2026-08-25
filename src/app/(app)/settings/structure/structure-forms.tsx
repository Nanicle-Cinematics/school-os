"use client";

import { useActionState } from "react";
import {
  deleteHouse,
  deleteLevel,
  deleteProgramme,
  saveHouse,
  saveLevel,
  saveProgramme,
  type StructureState,
} from "@/lib/structure-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, inputClass } from "../../ui";

type Stage = { value: string; label: string };

function Feedback({ state }: { state: StructureState }) {
  if (!state.error && !state.ok) {
    return null;
  }
  return (
    <div className="mt-2">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
    </div>
  );
}

/** Why a row cannot be deleted, or null when it can. */
function blockedBy(counts: { label: string; count: number }[]) {
  const held = counts.filter((entry) => entry.count > 0);
  if (held.length === 0) {
    return null;
  }
  return held.map((entry) => `${entry.count} ${entry.label}`).join(", ");
}

function DeleteButton({
  action,
  id,
  blocked,
  noun,
}: {
  action: (formData: FormData) => Promise<void>;
  id: string;
  blocked: string | null;
  noun: string;
}) {
  if (blocked) {
    return (
      <p className="self-center text-xs text-slate-400" title={`In use by ${blocked}.`}>
        in use · {blocked}
      </p>
    );
  }
  return (
    <form action={action} className="self-center">
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="danger" pendingLabel="…">
        Delete {noun}
      </SubmitButton>
    </form>
  );
}

// ── Levels ──────────────────────────────────────────────────────────────────

export type LevelRow = {
  id: string;
  name: string;
  code: string;
  stage: string;
  order: number;
  _count: { classGroups: number; levelSubjects: number; feeStructures: number };
};

function LevelFields({
  stages,
  values,
  defaultOrder,
}: {
  stages: Stage[];
  values?: LevelRow;
  defaultOrder?: number;
}) {
  return (
    <div className="grid flex-1 gap-2 sm:grid-cols-4">
      <input
        type="text"
        name="name"
        required
        placeholder="Basic 5"
        defaultValue={values?.name ?? ""}
        aria-label="Level name"
        className={inputClass}
      />
      <input
        type="text"
        name="code"
        required
        placeholder="B5"
        defaultValue={values?.code ?? ""}
        aria-label="Level code"
        className={inputClass}
      />
      <select
        name="stage"
        required
        defaultValue={values?.stage ?? ""}
        aria-label="Stage"
        className={inputClass}
      >
        <option value="" disabled>
          Stage
        </option>
        {stages.map((stage) => (
          <option key={stage.value} value={stage.value}>
            {stage.label}
          </option>
        ))}
      </select>
      <input
        type="number"
        name="order"
        required
        placeholder="Order"
        defaultValue={values?.order ?? defaultOrder ?? ""}
        aria-label="Order"
        className={inputClass}
      />
    </div>
  );
}

function LevelItem({ level, stages }: { level: LevelRow; stages: Stage[] }) {
  const [state, formAction] = useActionState<StructureState, FormData>(saveLevel, {});

  return (
    <li className="border-t border-slate-100 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <form action={formAction} className="flex flex-1 flex-wrap items-start gap-2">
          <input type="hidden" name="id" value={level.id} />
          <LevelFields stages={stages} values={level} />
          <SubmitButton variant="secondary" pendingLabel="…">
            Save
          </SubmitButton>
        </form>

        <DeleteButton
          action={deleteLevel}
          id={level.id}
          noun="level"
          blocked={blockedBy([
            { label: "classes", count: level._count.classGroups },
            { label: "fee tables", count: level._count.feeStructures },
          ])}
        />
      </div>
      <Feedback state={state} />
    </li>
  );
}

export function LevelSection({ levels, stages }: { levels: LevelRow[]; stages: Stage[] }) {
  const [state, formAction] = useActionState<StructureState, FormData>(saveLevel, {});
  const nextOrder = levels.reduce((max, level) => Math.max(max, level.order), 0) + 1;

  return (
    <>
      <ul>
        {levels.map((level) => (
          <LevelItem key={level.id} level={level} stages={stages} />
        ))}
      </ul>

      <div className="border-t border-slate-100 bg-slate-50/60 p-4">
        <form action={formAction} className="flex flex-wrap items-start gap-2">
          <LevelFields stages={stages} defaultOrder={nextOrder} />
          <SubmitButton pendingLabel="Adding…">Add level</SubmitButton>
        </form>
        <Feedback state={state} />
      </div>
    </>
  );
}

// ── Houses ──────────────────────────────────────────────────────────────────

export type HouseRow = {
  id: string;
  name: string;
  color: string | null;
  _count: { students: number };
};

function HouseItem({ house }: { house: HouseRow }) {
  const [state, formAction] = useActionState<StructureState, FormData>(saveHouse, {});

  return (
    <li className="border-t border-slate-100 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <form action={formAction} className="flex flex-1 flex-wrap items-start gap-2">
          <input type="hidden" name="id" value={house.id} />
          <input
            type="text"
            name="name"
            required
            defaultValue={house.name}
            aria-label="House name"
            className={`${inputClass} max-w-56`}
          />
          <input
            type="text"
            name="color"
            placeholder="Colour"
            defaultValue={house.color ?? ""}
            aria-label="House colour"
            className={`${inputClass} max-w-40`}
          />
          <span className="self-center text-xs text-slate-400">
            {house._count.students} student{house._count.students === 1 ? "" : "s"}
          </span>
          <SubmitButton variant="secondary" pendingLabel="…">
            Save
          </SubmitButton>
        </form>

        <DeleteButton
          action={deleteHouse}
          id={house.id}
          noun="house"
          blocked={blockedBy([{ label: "students", count: house._count.students }])}
        />
      </div>
      <Feedback state={state} />
    </li>
  );
}

export function HouseSection({ houses }: { houses: HouseRow[] }) {
  const [state, formAction] = useActionState<StructureState, FormData>(saveHouse, {});

  return (
    <>
      <ul>
        {houses.map((house) => (
          <HouseItem key={house.id} house={house} />
        ))}
      </ul>

      <div className="border-t border-slate-100 bg-slate-50/60 p-4">
        <form action={formAction} className="flex flex-wrap items-start gap-2">
          <input
            type="text"
            name="name"
            required
            placeholder="Gold House"
            aria-label="House name"
            className={`${inputClass} max-w-56`}
          />
          <input
            type="text"
            name="color"
            placeholder="Colour"
            aria-label="House colour"
            className={`${inputClass} max-w-40`}
          />
          <SubmitButton pendingLabel="Adding…">Add house</SubmitButton>
        </form>
        <Feedback state={state} />
      </div>
    </>
  );
}

// ── Programmes ──────────────────────────────────────────────────────────────

export type ProgrammeRow = {
  id: string;
  name: string;
  code: string;
  _count: { students: number };
};

function ProgrammeItem({ programme }: { programme: ProgrammeRow }) {
  const [state, formAction] = useActionState<StructureState, FormData>(saveProgramme, {});

  return (
    <li className="border-t border-slate-100 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <form action={formAction} className="flex flex-1 flex-wrap items-start gap-2">
          <input type="hidden" name="id" value={programme.id} />
          <input
            type="text"
            name="name"
            required
            defaultValue={programme.name}
            aria-label="Programme name"
            className={`${inputClass} max-w-64`}
          />
          <input
            type="text"
            name="code"
            required
            defaultValue={programme.code}
            aria-label="Programme code"
            className={`${inputClass} max-w-32`}
          />
          <span className="self-center text-xs text-slate-400">
            {programme._count.students} student{programme._count.students === 1 ? "" : "s"}
          </span>
          <SubmitButton variant="secondary" pendingLabel="…">
            Save
          </SubmitButton>
        </form>

        <DeleteButton
          action={deleteProgramme}
          id={programme.id}
          noun="programme"
          blocked={blockedBy([{ label: "students", count: programme._count.students }])}
        />
      </div>
      <Feedback state={state} />
    </li>
  );
}

export function ProgrammeSection({ programmes }: { programmes: ProgrammeRow[] }) {
  const [state, formAction] = useActionState<StructureState, FormData>(saveProgramme, {});

  return (
    <>
      <ul>
        {programmes.map((programme) => (
          <ProgrammeItem key={programme.id} programme={programme} />
        ))}
      </ul>

      <div className="border-t border-slate-100 bg-slate-50/60 p-4">
        <form action={formAction} className="flex flex-wrap items-start gap-2">
          <input
            type="text"
            name="name"
            required
            placeholder="General Science"
            aria-label="Programme name"
            className={`${inputClass} max-w-64`}
          />
          <input
            type="text"
            name="code"
            required
            placeholder="GSCI"
            aria-label="Programme code"
            className={`${inputClass} max-w-32`}
          />
          <SubmitButton pendingLabel="Adding…">Add programme</SubmitButton>
        </form>
        <Feedback state={state} />
      </div>
    </>
  );
}
