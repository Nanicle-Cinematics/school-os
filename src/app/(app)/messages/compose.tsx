"use client";

import { useActionState, useState } from "react";
import { previewCampaign, sendCampaign, type PreviewState, type SendState } from "@/lib/message-actions";
import { MERGE_FIELDS } from "@/lib/sms-shared";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

type Template = { id: string; name: string; body: string };
type ClassOption = { id: string; name: string; level: { name: string } };
type LevelOption = { id: string; name: string };

const AUDIENCES = [
  { value: "ALL_PARENTS", label: "All parents" },
  { value: "CLASS", label: "Specific classes" },
  { value: "LEVEL", label: "Specific levels" },
  { value: "DEBTORS", label: "Parents owing fees" },
  { value: "ALL_STAFF", label: "All staff" },
  { value: "CUSTOM", label: "Custom numbers" },
] as const;

export function Compose({
  templates,
  classGroups,
  levels,
  smsEnabled,
}: {
  templates: Template[];
  classGroups: ClassOption[];
  levels: LevelOption[];
  smsEnabled: boolean;
}) {
  const [preview, previewAction] = useActionState<PreviewState, FormData>(previewCampaign, {});
  const [send, sendAction] = useActionState<SendState, FormData>(sendCampaign, {});

  const [audience, setAudience] = useState<string>("ALL_PARENTS");
  const [body, setBody] = useState("");
  const [templateId, setTemplateId] = useState("");

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const template = templates.find((t) => t.id === id);
    if (template) {
      setBody(template.body);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 lg:p-5">
      <h2 className="text-sm font-semibold text-slate-900">Compose message</h2>

      {!smsEnabled ? (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          SMS is switched off in Settings, and no gateway credentials are configured. You can still
          compose and preview — messages will be recorded as a dry run and nothing will be sent.
        </p>
      ) : null}

      {/* One form, two actions: preview reads it, send submits it. */}
      <form className="mt-4 space-y-4">
        <input type="hidden" name="templateId" value={templateId} />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Campaign name">
            <input
              type="text"
              name="name"
              placeholder="e.g. Term 1 fee reminder"
              className={inputClass}
            />
          </Field>

          <Field label="Audience">
            <select
              name="audienceType"
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
              className={inputClass}
            >
              {AUDIENCES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Start from a template">
            <select
              value={templateId}
              onChange={(event) => applyTemplate(event.target.value)}
              className={inputClass}
            >
              <option value="">None</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {audience === "CLASS" ? (
          <Field label="Classes">
            <select name="classGroupIds" multiple className={`${inputClass} h-32`}>
              {classGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.level.name} {group.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        {audience === "LEVEL" ? (
          <Field label="Levels">
            <select name="levelIds" multiple className={`${inputClass} h-32`}>
              {levels.map((level) => (
                <option key={level.id} value={level.id}>
                  {level.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        {audience === "DEBTORS" ? (
          <Field label="Only parents owing at least (GHS)" hint="Leave blank for any balance.">
            <input type="text" inputMode="decimal" name="minBalance" className={inputClass} />
          </Field>
        ) : null}

        {audience === "CUSTOM" ? (
          <Field label="Phone numbers" hint="Separate with commas, spaces or new lines.">
            <textarea name="phones" rows={3} className={inputClass} />
          </Field>
        ) : null}

        <Field label="Message">
          <textarea
            name="body"
            rows={4}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className={inputClass}
            placeholder="Dear {{guardian_name}}, …"
          />
        </Field>

        <div className="flex flex-wrap gap-1.5">
          {MERGE_FIELDS.map((field) => (
            <button
              key={field}
              type="button"
              onClick={() => setBody((current) => `${current}{{${field}}}`)}
              className="rounded border border-slate-200 px-1.5 py-0.5 font-mono text-xs text-slate-600 transition hover:bg-slate-50"
            >
              {`{{${field}}}`}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton formAction={previewAction} variant="secondary" pendingLabel="Checking…">
            Preview recipients
          </SubmitButton>

          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" name="confirm" className="h-4 w-4 rounded border-slate-300" />
            I have checked the message and recipients
          </label>

          <SubmitButton formAction={sendAction} pendingLabel="Sending…">
            Send now
          </SubmitButton>
        </div>
      </form>

      {preview.error ? (
        <div className="mt-4">
          <Alert tone="error">{preview.error}</Alert>
        </div>
      ) : null}
      {send.error ? (
        <div className="mt-4">
          <Alert tone="error">{send.error}</Alert>
        </div>
      ) : null}

      {preview.count ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm font-medium text-slate-900">
            {preview.count} recipient{preview.count === 1 ? "" : "s"} ·{" "}
            {preview.segments} segment{preview.segments === 1 ? "" : "s"} each ({preview.encoding}) ·
            about GHS {preview.cost?.toFixed(2)}
          </p>
          {preview.encoding === "UCS2" ? (
            <p className="mt-1 text-xs text-amber-700">
              Your message contains a non-GSM character, which cuts each segment from 160 to 70
              characters and multiplies the cost. Replacing smart quotes or emoji usually fixes it.
            </p>
          ) : null}
          <ul className="mt-2 space-y-1.5">
            {preview.sample?.map((item) => (
              <li key={item.phone} className="text-xs text-slate-600">
                <span className="font-mono text-slate-400">{item.phone}</span> — {item.body}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
