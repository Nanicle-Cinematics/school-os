"use client";

import { useEffect, useMemo, useState } from "react";
import { rollIsFresh, type OfflineRoll } from "@/lib/offline-register";
import { listRolls, pruneStale } from "@/lib/offline-store";
import { useOnline } from "@/lib/use-online";
import { OfflineSync } from "../offline-sync";
import { RegisterForm } from "../(app)/attendance/register-form";
import { Card, filterClass } from "../(app)/ui";

/** The device's own calendar day, which is the school's: it is in the school. */
function localToday() {
  return new Date().toLocaleDateString("en-CA");
}

/**
 * Takes the register from what the phone already holds. Reached when /attendance
 * cannot load (the service worker answers with this page instead), or directly.
 */
export function OfflineRegisterApp() {
  const [rolls, setRolls] = useState<OfflineRoll[] | null>(null);
  const [classGroupId, setClassGroupId] = useState("");
  const [date, setDate] = useState(localToday);
  const online = useOnline();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await pruneStale(new Date());
      const found = (await listRolls()).filter((roll) => rollIsFresh(roll, new Date()));
      if (cancelled) return;
      setRolls(found);
      const params = new URLSearchParams(window.location.search);
      const wanted = params.get("class");
      const day = params.get("date");
      if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) setDate(day);
      setClassGroupId(found.find((roll) => roll.classGroupId === wanted)?.classGroupId ?? found[0]?.classGroupId ?? "");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const roll = rolls?.find((candidate) => candidate.classGroupId === classGroupId) ?? null;
  const boys = useMemo(() => view(roll, "MALE"), [roll]);
  const girls = useMemo(() => view(roll, "FEMALE"), [roll]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-4 lg:py-8">
      <header className="flex items-center justify-between gap-3">
        <h1 className="font-heading text-2xl font-extrabold tracking-tight text-slate-900">Attendance</h1>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            online ? "bg-success-tint text-success-ink" : "bg-warning-tint text-warning-ink"
          }`}
        >
          {online ? "Online" : "No signal"}
        </span>
      </header>

      <p className="rounded-control bg-info-tint px-3.5 py-2.5 text-sm text-info-ink">
        {online ? (
          <>
            You are back online.{" "}
            <a
              // ?online=1 tells the service worker this person will wait for the network.
              href={classGroupId ? `/attendance?class=${encodeURIComponent(classGroupId)}&date=${date}&online=1` : "/attendance?online=1"}
              className="font-semibold underline underline-offset-2"
            >
              Open the full Attendance page
            </a>
            .
          </>
        ) : (
          "Registers you take here are kept on this phone and sent when you are back online."
        )}
      </p>

      {rolls === null ? (
        <p className="text-sm text-slate-500">Looking for your class on this phone…</p>
      ) : rolls.length === 0 ? (
        <p className="rounded-control bg-warning-tint px-3.5 py-2.5 text-sm text-warning-ink">
          There is no class saved on this phone yet. Open Attendance once while you have a signal, and your class is
          kept here for the next {7} days.
        </p>
      ) : (
        <>
          <Card title="Which register?">
            <div className="flex flex-wrap items-end gap-3 p-4">
              {rolls.length > 1 ? (
                <label className="text-sm">
                  <span className="mb-1 block font-semibold text-slate-700">Class</span>
                  <select
                    value={classGroupId}
                    onChange={(event) => setClassGroupId(event.target.value)}
                    className={`${filterClass} w-52`}
                  >
                    {rolls.map((candidate) => (
                      <option key={candidate.classGroupId} value={candidate.classGroupId}>
                        {candidate.className}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="text-sm">
                <span className="mb-1 block font-semibold text-slate-700">Day</span>
                <input
                  type="date"
                  value={date}
                  onChange={(event) => event.target.value && setDate(event.target.value)}
                  className={`${filterClass} w-44`}
                />
              </label>
            </div>
          </Card>

          {roll ? (
            <Card title={`${roll.className} · ${new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}`}>
              <p className="border-b border-hairline bg-slate-50 px-4 py-2 text-xs text-slate-500">
                Class list saved {new Date(roll.savedAt).toLocaleString("en-GB")}. A child who joined since is not on it.
              </p>
              <RegisterForm
                key={`${roll.classGroupId}|${date}`}
                classGroupId={roll.classGroupId}
                classLabel={roll.className}
                date={date}
                taken={false}
                boys={boys}
                girls={girls}
                offlineOnly
              />
            </Card>
          ) : null}
        </>
      )}

      <OfflineSync />
    </div>
  );
}

function view(roll: OfflineRoll | null, gender: "MALE" | "FEMALE") {
  return (roll?.rows ?? [])
    .filter((row) => row.gender === gender)
    .map((row) => ({ studentId: row.studentId, admissionNo: row.admissionNo, name: row.name, mark: null, note: null }));
}
