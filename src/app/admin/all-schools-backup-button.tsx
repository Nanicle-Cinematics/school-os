"use client";

import { useActionState } from "react";
import { triggerAllSchoolsBackup, type BackupState } from "@/lib/platform-backup-actions";
import { SCHOOL_BACKUP_RUNS_URL } from "@/lib/platform-backup-constants";

export function AllSchoolsBackupButton() {
  const [state, action] = useActionState<BackupState, FormData>(triggerAllSchoolsBackup, {});

  return (
    <form action={action} className="flex items-center gap-2">
      <button
        type="submit"
        className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
      >
        Back up every school now
      </button>
      {state.error ? <span className="text-xs text-danger-ink">{state.error}</span> : null}
      {state.ok ? (
        <a
          href={SCHOOL_BACKUP_RUNS_URL}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-success-ink hover:underline"
        >
          {state.ok}
        </a>
      ) : null}
    </form>
  );
}
