/**
 * HTTP for the load test: a timed client and the form replay `verify:actions` uses.
 *
 * Server actions here are all form-bound (`useActionState`), so the way to run the REAL action
 * without a browser is to read the form the page rendered and post it back, hidden
 * `$ACTION_REF_n` fields and all. The attribute values arrive HTML-escaped and
 * `$ACTION_n:0` is JSON, so they are decoded first: posted raw, Next cannot parse the action id
 * and answers 500, which on a load test is indistinguishable from the thing being measured.
 */
import type { Sample } from "./stats.mjs";

export const COOKIE_NAME = "school_os_session";
const TIMEOUT_MS = 60_000;

export function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export type Field = { name: string; value: string; type: string; checked: boolean; disabled: boolean };
export type Form = { text: string; fields: Field[]; inner: string };

/** Every <form> on the page with the fields that belong to it. */
export function forms(html: string): Form[] {
  return [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((match) => {
    const inner = match[1]!;
    const fields: Field[] = [];
    for (const tag of inner.match(/<input\b[^>]*>/g) ?? []) {
      const name = tag.match(/name="([^"]*)"/)?.[1];
      if (!name) continue;
      fields.push({
        name,
        value: decodeEntities(tag.match(/value="([^"]*)"/)?.[1] ?? ""),
        type: tag.match(/type="([^"]*)"/)?.[1] ?? "text",
        checked: /\bchecked\b/.test(tag),
        disabled: /\sdisabled(=|\s|\/|>)/.test(tag),
      });
    }
    for (const select of inner.match(/<select\b[\s\S]*?<\/select>/g) ?? []) {
      const name = select.match(/name="([^"]*)"/)?.[1];
      if (!name) continue;
      const chosen = decodeEntities(
        select.match(/<option value="([^"]*)"[^>]*\bselected\b/)?.[1] ?? select.match(/<option value="([^"]*)"/)?.[1] ?? "",
      );
      fields.push({ name, value: chosen, type: "select", checked: false, disabled: false });
    }
    return { text: inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), fields, inner };
  });
}

/** The first form that has a field whose name matches. How a person would find "the register". */
export const formHaving = (html: string, test: (name: string) => boolean): Form | undefined =>
  forms(html).find((form) => form.fields.some((field) => test(field.name)));

export type Reply = { status: number; html: string; location: string | null; setCookie: string[] };

/** One signed-in (or anonymous) caller. Records every request it makes. */
export class Client {
  constructor(
    private readonly base: string,
    private readonly record: (sample: Sample) => void,
    /** The session token, or "" for a visitor. */
    readonly token: string = "",
    /** A distinct address per caller: real parents arrive from thousands of phones, and the login limit is per address. */
    private readonly ip: string = "",
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(this.token ? { Cookie: `${COOKIE_NAME}=${this.token}` } : {}),
      ...(this.ip ? { "x-forwarded-for": this.ip } : {}),
      ...extra,
    };
  }

  private async send(path: string, init: RequestInit, label: string, kind: Sample["kind"], accept: (r: Reply) => boolean): Promise<Reply> {
    const started = performance.now();
    let reply: Reply = { status: 0, html: "", location: null, setCookie: [] };
    try {
      const response = await fetch(this.base + path, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      reply = {
        status: response.status,
        html: await response.text(),
        location: response.headers.get("x-action-redirect") ?? response.headers.get("location"),
        setCookie: response.headers.getSetCookie?.() ?? [],
      };
    } catch {
      // A timeout or a refused connection is a result, not an exception: it is the answer.
    }
    this.record({ label, kind, ms: performance.now() - started, status: reply.status, ok: reply.status !== 0 && accept(reply) });
    return reply;
  }

  /** A page read. It worked when it answered 200 and did not bounce to the sign-in page. */
  get(path: string, label: string): Promise<Reply> {
    return this.send(path, { method: "GET", headers: this.headers() }, label, "page", (r) => r.status === 200 && !/\/login\b/.test(r.location ?? ""));
  }

  /**
   * Post a form the way the browser's no-JS fallback does: every field it rendered, `overrides`
   * replacing same-named ones. An unchecked checkbox is not sent, as a browser would not.
   */
  post(path: string, form: Form, overrides: Record<string, string>, label: string, kind: Sample["kind"] = "action", accept?: (r: Reply) => boolean): Promise<Reply> {
    const body = new FormData();
    const used = new Set<string>();
    for (const field of form.fields) {
      if (field.disabled) continue;
      if (field.type === "checkbox" && !field.checked && !(field.name in overrides)) continue;
      if (field.name in overrides) {
        if (used.has(field.name)) continue;
        body.append(field.name, overrides[field.name]!);
        used.add(field.name);
      } else {
        body.append(field.name, field.value);
      }
    }
    for (const [name, value] of Object.entries(overrides)) if (!used.has(name)) body.append(name, value);
    return this.send(path, { method: "POST", headers: this.headers(), body }, label, kind, accept ?? ((r) => (r.status === 200 || r.status === 303) && !/\/login\b/.test(r.location ?? "")));
  }
}

/** The text of every `role="alert"` banner the page rendered: where an action reports what it did. */
export function alerts(html: string): string[] {
  return [...html.matchAll(/<[^>]*role="alert"[^>]*>([\s\S]*?)<\/[a-z0-9]+>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Deterministic, so two runs against the same data make the same choices and a regression is a regression. */
export function rng(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    between: (low: number, high: number) => low + next() * (high - low),
  };
}
