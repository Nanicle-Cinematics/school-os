import type { ActivityItem } from "@/lib/dashboard-data";
import type { LucideIcon } from "lucide-react";
import { Banknote, GraduationCap, Send, Settings, Users } from "lucide-react";
import { Card } from "../ui";

/**
 * What has happened lately, from the audit trail the app has been writing since
 * the first commit. Read-only: this adds nothing to the record, it just shows it.
 */

/**
 * One glyph per kind of event, from the same set as everything else.
 *
 * ⚠️ The chip is NEUTRAL for every kind, which is a change. It used to tint by
 * topic — brand green for money, gold for a message — and that is decoration
 * wearing the clothes of information: a feed is a record of what has ALREADY
 * happened, so nothing in it blocks work and nothing in it is urgent. Severity
 * colour belongs to things somebody still has to act on. The glyph says what
 * kind of event it was; the colour says nothing, correctly.
 */
const GLYPH: Record<ActivityItem["kind"], LucideIcon> = {
  money: Banknote,
  message: Send,
  academic: GraduationCap,
  people: Users,
  admin: Settings,
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
          {items.map((item) => {
            const Glyph = GLYPH[item.kind];
            return (
            <li key={item.id} className="flex items-center gap-3 px-4 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                <Glyph className="h-[17px] w-[17px]" aria-hidden="true" />
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
            );
          })}
        </ul>
      )}
    </Card>
  );
}
