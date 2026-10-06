"use client";

import { buttonClass } from "./button-style";
import { Card } from "./ui";

/**
 * What a screen shows when something it ran threw — most often now a SAVE
 * refused because the school is read-only (an expired trial, or a subscription
 * in arrears), which prisma.ts enforces by throwing rather than by each action
 * checking. Before this file there was no boundary at all, and the refusal
 * reached the office as Next's bare "Application error" page.
 *
 * Production hides the error's message from the browser, so this cannot tell a
 * read-only refusal from any other failure. It names the likely cause and points
 * at the banner above, which the layout still renders: this boundary replaces
 * only the page beneath it.
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <div className="space-y-3 px-4 py-8 text-center">
          <h2 className="text-base font-semibold text-slate-900">That could not be completed</h2>
          <p className="text-sm text-slate-600">
            If the notice at the top of the page says the school is read-only, that is the
            reason: records can still be read and printed, but nothing can be changed until the
            subscription is settled. Otherwise, try again; if it keeps happening, tell Nanicle
            {error.digest ? (
              <>
                {" "}and quote <span className="font-mono">{error.digest}</span>
              </>
            ) : null}
            .
          </p>
          <button type="button" onClick={() => retry()} className={buttonClass("secondary")}>
            Try again
          </button>
        </div>
      </Card>
    </div>
  );
}
