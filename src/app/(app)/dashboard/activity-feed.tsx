import type { ActivityItem } from "@/lib/dashboard-data";
import { Card } from "../ui";

/**
 * What has happened lately, from the audit trail the app has been writing since
 * the first commit. Read-only: this adds nothing to the record, it just shows it.
 */

const PATHS: Record<ActivityItem["kind"], string> = {
  money: '<rect x="2.5" y="5.5" width="19" height="13" rx="3"/><circle cx="12" cy="12" r="2.6"/>',
  message:
    '<path d="M21 15a2.5 2.5 0 0 1-2.5 2.5H8L3 21V5.5A2.5 2.5 0 0 1 5.5 3h13A2.5 2.5 0 0 1 21 5.5z"/>',
  academic: '<path d="M12 3.5 22 8l-10 4.5L2 8z"/><path d="M6 10.4V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.6"/>',
  people:
    '<path d="M17 20v-1.8a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20"/><circle cx="10" cy="7" r="3.6"/>',
  admin:
    '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9z"/>',
};

const TINT: Record<ActivityItem["kind"], string> = {
  money: "bg-brand-50 text-brand-600",
  message: "bg-accent-50 text-accent-600",
  academic: "bg-brand-50 text-brand-600",
  people: "bg-slate-100 text-slate-500",
  admin: "bg-slate-100 text-slate-500",
};

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  return (
    <Card title="Recent activity">
      {items.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-500">
          Nothing recorded yet. Payments, marks and changes to settings appear here as they
          happen.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-3">
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${TINT[item.kind]}`}
              >
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: PATHS[item.kind] }}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-sm font-bold text-slate-900">
                    {item.title}
                  </span>
                  {/* One action across eleven classes is eleven audit rows and one
                      thing that happened. The count says so without spending
                      eleven lines saying it. */}
                  {item.count > 1 ? (
                    <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-extrabold text-slate-500">
                      ×{item.count}
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-slate-500">{item.detail}</span>
              </span>
              <span className="shrink-0 text-xs text-slate-400">{item.when}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
