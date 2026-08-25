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

  if (!apiKey || !provider) {
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

async function dispatch(provider: SmsProvider, args: DispatchArgs): Promise<SendResult> {
  switch (provider) {
    case "ARKESEL": {
      const url = new URL("https://sms.arkesel.com/sms/api");
      url.searchParams.set("action", "send-sms");
      url.searchParams.set("api_key", args.apiKey);
      url.searchParams.set("to", args.to);
      url.searchParams.set("from", args.senderId);
      url.searchParams.set("sms", args.body);
      const res = await fetch(url, { method: "GET" });
      const json = (await res.json()) as { code?: string; message?: string; data?: { id?: string } };
      return json.code === "ok"
        ? { ok: true, providerRef: json.data?.id }
        : { ok: false, error: json.message ?? `HTTP ${res.status}` };
    }

    case "HUBTEL": {
      const res = await fetch("https://smsc.hubtel.com/v1/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Basic ${args.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ From: args.senderId, To: args.to, Content: args.body }),
      });
      const json = (await res.json()) as { messageId?: string; status?: number; message?: string };
      return res.ok
        ? { ok: true, providerRef: json.messageId }
        : { ok: false, error: json.message ?? `HTTP ${res.status}` };
    }

    case "MNOTIFY": {
      const res = await fetch(`https://api.mnotify.com/api/sms/quick?key=${args.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: [args.to],
          sender: args.senderId,
          message: args.body,
        }),
      });
      const json = (await res.json()) as { status?: string; message?: string; summary?: { _id?: string } };
      return json.status === "success"
        ? { ok: true, providerRef: json.summary?._id }
        : { ok: false, error: json.message ?? `HTTP ${res.status}` };
    }

    default:
      return { ok: false, error: `Unsupported provider ${provider}` };
  }
}
