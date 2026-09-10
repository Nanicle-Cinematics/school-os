import "server-only";

import type { SmsProvider } from "@prisma/client";

// Re-exported so server code has one import site for all SMS concerns.
export * from "@/lib/sms-shared";

export type SendResult = {
  ok: boolean;
  providerRef?: string;
  error?: string;
};

/**
 * Send one message.
 *
 * With no provider credentials configured this runs in DRY-RUN: nothing leaves
 * the building, and the message is recorded so the whole flow — audience
 * resolution, merge fields, segment counting, cost — can be exercised safely.
 * That is the deliberate default; a half-configured gateway silently texting
 * real parents is much worse than one that clearly did nothing.
 */
export async function sendSms(
  to: string,
  body: string,
  opts: { provider?: SmsProvider | null; senderId?: string | null },
): Promise<SendResult & { dryRun: boolean }> {
  const apiKey = process.env.SMS_API_KEY;
  const provider = opts.provider ?? (process.env.SMS_PROVIDER as SmsProvider | undefined) ?? null;

  /**
   * `SMS_DRY_RUN=1` forces dry-run even WITH credentials.
   *
   * For verify scripts and staging: the password-reset flow refuses to start
   * unless a gateway is configured (telling a parent to wait for a text that
   * cannot arrive is worse than telling them to ring the office), so exercising
   * it otherwise means either real texts or real requests to Arkesel from CI.
   * Neither belongs in a test suite.
   */
  if (process.env.SMS_DRY_RUN === "1" || !apiKey || !provider) {
    return { ok: true, dryRun: true, providerRef: `dryrun-${Date.now()}` };
  }

  try {
    const response = await dispatch(provider, {
      to,
      body,
      apiKey,
      senderId: opts.senderId ?? process.env.SMS_SENDER_ID ?? "SchoolOS",
    });
    return { ...response, dryRun: false };
  } catch (error) {
    return {
      ok: false,
      dryRun: false,
      error: error instanceof Error ? error.message : "Unknown gateway error",
    };
  }
}

type DispatchArgs = { to: string; body: string; apiKey: string; senderId: string };

/**
 * Every gateway call is bounded and every failure is legible.
 *
 * ⚠️ A gateway error page is HTML, so `res.json()` THROWS and the school reads
 * "Unexpected token <" where the reason should be. And an unbounded fetch stalls
 * whatever is looping over it — publishing a class holds the form open per
 * parent. So: one timeout, read the body as text, try to parse it, and keep a
 * snippet either way.
 */
async function call(
  url: string,
  init: RequestInit,
): Promise<{ status: number; ok: boolean; json: Record<string, unknown> | null; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

/** What went wrong, in the gateway's own words where it has any. */
function reason(
  result: { status: number; json: Record<string, unknown> | null; text: string },
  fallbackField = "message",
) {
  const said = result.json?.[fallbackField] ?? result.json?.error ?? result.json?.message;
  if (typeof said === "string" && said.trim()) {
    return said;
  }
  const snippet = result.text.replace(/\s+/g, " ").trim().slice(0, 140);
  return snippet ? `HTTP ${result.status}: ${snippet}` : `HTTP ${result.status}`;
}

async function dispatch(provider: SmsProvider, args: DispatchArgs): Promise<SendResult> {
  switch (provider) {
    /**
     * ⚠️ v2, not the v1 this shipped with.
     *
     * v1 was `GET /sms/api?action=send-sms&api_key=…&from=&to=&sms=` answering
     * `{"code":"ok"}`. Arkesel documents v2 — a POST, the key in an `api-key`
     * HEADER rather than the query string (so it stays out of logs and proxies),
     * and `recipients` as an array. Nothing here had ever run against a real
     * gateway, so the mismatch cost nothing until the moment it would have cost
     * a school every text it thought it was sending.
     */
    case "ARKESEL": {
      const res = await call("https://sms.arkesel.com/api/v2/sms/send", {
        method: "POST",
        headers: { "api-key": args.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: args.senderId,
          message: args.body,
          recipients: [args.to],
        }),
      });
      const data = res.json?.data as { id?: string } | undefined;
      return res.ok && res.json?.status === "success"
        ? { ok: true, providerRef: data?.id }
        : { ok: false, error: reason(res) };
    }

    /**
     * Basic auth over `clientid:clientsecret`. ⚠️ The credential is a PAIR, and
     * this used to interpolate SMS_API_KEY into the header raw — which silently
     * required a pre-base64-encoded value and gave a 401 with no explanation to
     * anyone who pasted the two halves as Hubtel shows them. Encode it here when
     * it still has the colon in it, and accept an already-encoded key too.
     */
    case "HUBTEL": {
      const credential = args.apiKey.includes(":")
        ? Buffer.from(args.apiKey).toString("base64")
        : args.apiKey;
      const res = await call("https://sms.hubtel.com/v1/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Basic ${credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ From: args.senderId, To: args.to, Content: args.body }),
      });
      const id = res.json?.messageId ?? (res.json?.data as { messageId?: string } | undefined)?.messageId;
      return res.ok
        ? { ok: true, providerRef: typeof id === "string" ? id : undefined }
        : { ok: false, error: reason(res, "statusDescription") };
    }

    case "MNOTIFY": {
      const res = await call(
        `https://api.mnotify.com/api/sms/quick?key=${encodeURIComponent(args.apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient: [args.to],
            sender: args.senderId,
            message: args.body,
          }),
        },
      );
      const summary = res.json?.summary as { _id?: string } | undefined;
      return res.ok && res.json?.status === "success"
        ? { ok: true, providerRef: summary?._id }
        : { ok: false, error: reason(res) };
    }

    default:
      return { ok: false, error: `Unsupported provider ${provider}` };
  }
}
