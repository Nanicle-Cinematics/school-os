"use client";

import { useActionState, useMemo, useState } from "react";
import { saveSkillRatings, type SkillState } from "@/lib/skill-actions";
import {
  SKILL_GRADES,
  SKILL_GRADE_LABEL,
  SKILL_SCORE_OUT_OF,
  checkSkillScore,
  type RatingCell,
  type SkillGradeValue,
} from "@/lib/skills";
import { SubmitButton } from "../../submit-button";
import { Alert, Avatar } from "../../ui";

type Skill = { id: string; name: string };
type Student = { id: string; firstName: string; lastName: string; admissionNo: string };

/**
 * One area's skills for a class: a score and a rating per child per skill.
 *
 * ⚠️ The rating is three BUTTONS and a hidden input, not a <select> or radios. React resets a form's
 * fields once its action returns, and a controlled select, radio or checkbox is not put back (see
 * CLAUDE.md, the mark sheet's "absent" tick): the rating would vanish from the screen after every
 * save while the state behind it still held it. A hidden input and a button are not form controls
 * the reset touches, and the score is a controlled text-like input, whose value React keeps in step
 * with its default so the reset leaves it alone.
 *
 * The same rule judges a score here as in the action (`checkSkillScore`), so this screen cannot
 * accept a number the save will then refuse. A child whose card is published is shown read-only and
 * sends nothing.
 */
export function SkillsGrid({
  termId,
  classGroupId,
  subjectId,
  skills,
  students,
  ratings,
  locked,
}: {
  termId: string;
  classGroupId: string;
  subjectId: string;
  skills: Skill[];
  students: Student[];
  ratings: Record<string, Record<string, RatingCell>>;
  locked: string[];
}) {
  const [state, formAction] = useActionState<SkillState, FormData>(saveSkillRatings, {});
  const settled = useMemo(() => new Set(locked), [locked]);

  const [scores, setScores] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [studentId, byskill] of Object.entries(ratings)) {
      for (const [skillId, cell] of Object.entries(byskill)) {
        initial[`${skillId}:${studentId}`] = cell.score ?? "";
      }
    }
    return initial;
  });
  const [grades, setGrades] = useState<Record<string, SkillGradeValue | "">>(() => {
    const initial: Record<string, SkillGradeValue | ""> = {};
    for (const [studentId, byskill] of Object.entries(ratings)) {
      for (const [skillId, cell] of Object.entries(byskill)) {
        initial[`${skillId}:${studentId}`] = cell.grade ?? "";
      }
    }
    return initial;
  });

  const problems = useMemo(() => {
    const found = new Map<string, string>();
    for (const student of students) {
      if (settled.has(student.id)) continue;
      for (const skill of skills) {
        const key = `${skill.id}:${student.id}`;
        const verdict = checkSkillScore(scores[key] ?? "");
        if (!verdict.ok) {
          found.set(key, `${student.lastName}, ${skill.name}: ${verdict.reason}`);
        }
      }
    }
    return found;
  }, [students, skills, scores, settled]);
  const blocked = problems.size > 0;
  const firstProblem = problems.values().next().value as string | undefined;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="termId" value={termId} />
      <input type="hidden" name="classGroupId" value={classGroupId} />
      <input type="hidden" name="subjectId" value={subjectId} />

      <div className="overflow-x-auto rounded-card border border-hairline bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/60">
              <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2.5 text-left text-[10.5px] font-extrabold text-slate-400">
                Child
              </th>
              {skills.map((skill) => (
                <th key={skill.id} className="px-2 py-2.5 text-center text-[11px] font-extrabold text-slate-500">
                  {skill.name}
                  <span className="block text-[10px] font-normal text-slate-400">
                    score / {SKILL_SCORE_OUT_OF} · rating
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {students.map((student) => {
              const isLocked = settled.has(student.id);
              return (
                <tr key={student.id} className="hover:bg-slate-50/60">
                  <td className="sticky left-0 z-10 bg-surface px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <Avatar firstName={student.firstName} lastName={student.lastName} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate font-bold text-slate-900">
                          {student.lastName}, {student.firstName}
                        </p>
                        <p className="font-mono text-[11px] text-slate-400">
                          {isLocked ? "published" : student.admissionNo}
                        </p>
                      </div>
                    </div>
                  </td>

                  {skills.map((skill) => {
                    const key = `${skill.id}:${student.id}`;
                    const grade = grades[key] ?? "";
                    if (isLocked) {
                      return (
                        <td key={skill.id} className="px-2 py-1.5 text-center text-slate-500">
                          <span className="tabular-nums">{scores[key] || "—"}</span>
                          <span className="mx-1 text-slate-300">·</span>
                          <span className="font-semibold">{grade || "—"}</span>
                        </td>
                      );
                    }
                    const bad = problems.has(key);
                    return (
                      <td key={skill.id} className="px-2 py-1.5">
                        <div className="flex items-center justify-center gap-1.5">
                          <input
                            type="text"
                            inputMode="decimal"
                            name={`score:${skill.id}:${student.id}`}
                            value={scores[key] ?? ""}
                            onChange={(e) => setScores((prev) => ({ ...prev, [key]: e.target.value }))}
                            aria-invalid={bad ? true : undefined}
                            aria-label={`${skill.name} score for ${student.firstName} ${student.lastName}`}
                            className={`w-[3.75rem] rounded-lg border-[1.5px] px-1.5 py-1.5 text-center font-semibold tabular-nums outline-none transition focus:ring-2 ${
                              bad
                                ? "border-danger-ink bg-danger-tint text-danger-ink focus:border-danger-ink focus:ring-danger-ink/25"
                                : "border-slate-200 focus:border-brand-500 focus:ring-brand-500/25"
                            }`}
                          />
                          <input type="hidden" name={`grade:${skill.id}:${student.id}`} value={grade} />
                          <div role="group" aria-label={`${skill.name} rating for ${student.firstName} ${student.lastName}`} className="flex gap-1">
                            {SKILL_GRADES.map((letter) => (
                              <button
                                key={letter}
                                type="button"
                                aria-pressed={grade === letter}
                                title={SKILL_GRADE_LABEL[letter]}
                                onClick={() =>
                                  setGrades((prev) => ({ ...prev, [key]: grade === letter ? "" : letter }))
                                }
                                className={`h-8 w-8 rounded-lg border-[1.5px] text-xs font-bold transition ${
                                  grade === letter
                                    ? "border-brand-600 bg-brand-600 text-white"
                                    : "border-slate-200 text-slate-500 hover:bg-slate-100"
                                }`}
                              >
                                {letter}
                              </button>
                            ))}
                          </div>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {blocked ? (
        <Alert tone="error">
          {problems.size === 1 ? "1 score is" : `${problems.size} scores are`} not valid and{" "}
          {problems.size === 1 ? "is" : "are"} marked in red. Fix {problems.size === 1 ? "it" : "them"} to save.
          First: {firstProblem}
        </Alert>
      ) : null}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…" disabled={blocked}>
          Save ratings
        </SubmitButton>
        <p className="text-xs text-slate-500">
          {SKILL_GRADES.map((g) => `${g} ${SKILL_GRADE_LABEL[g].toLowerCase()}`).join(" · ")}. Tap a
          rating again to clear it. Blank means not assessed yet, never zero.
        </p>
      </div>
    </form>
  );
}
