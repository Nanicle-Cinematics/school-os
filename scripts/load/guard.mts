/**
 * The load test's safety interlock. Pure: no database, no network, no process state.
 *
 * ⚠️ A load test is a deliberate denial-of-service against whatever it is pointed at, and it
 * WRITES (it seeds ten schools, mints sessions, saves registers, runs invoice generation). On
 * 2026-09-11 a dev project went Unhealthy on fourteen requests in an hour, so "it is only dev"
 * is not a safe default here, and production holds a real school. The target therefore has to be
 * proven to be NEITHER, by comparing it against every database and app address this checkout
 * knows about (`.env`, `.env.prod`), and the person running it has to name what they are
 * pointing at rather than inherit it from whichever env file happened to load.
 *
 * Refusals, all of them problems and never warnings, because a warning is scrolled past:
 *   - a connection string that is missing or unreadable;
 *   - ANY of the three database URLs that is, or is the same Supabase project as, one in the
 *     repo's own env files (the pooler and the direct host of one project differ, so the
 *     project REF is compared, not just the hostname);
 *   - a remote database without `LOAD_ALLOW_REMOTE=yes` AND `LOAD_CONFIRM_TARGET` equal to its
 *     project ref (typing the thing is the confirmation);
 *   - a local database whose NAME does not say it is for this (`load`, `scratch`, `throwaway`);
 *   - an app address that is production, or is the repo's own `APP_URL`, or is not local without
 *     the same remote confirmation;
 *   - an SMS gateway that is not forced to a dry run, since a fake school's parents have fake
 *     numbers and a real gateway would still charge for each message.
 */

export type GuardInput = {
  databaseUrl: string | undefined;
  directUrl: string | undefined;
  appDatabaseUrl: string | undefined;
  /** Where the runner will send HTTP requests. */
  baseUrl: string | undefined;
  /** Database and app addresses that must never be targeted: read from `.env`, `.env.prod`. */
  forbiddenUrls: string[];
  allowRemote: string | undefined;
  confirmTarget: string | undefined;
  smsDryRun: string | undefined;
};

export type Verdict = { ok: boolean; problems: string[]; notes: string[] };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Hosts that are production by name, whatever an env file says. */
const NEVER = ["schoolosafrica.com"];

function parse(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * The Supabase project a connection string belongs to, or null if it is not Supabase's.
 * The pooler carries it in the user name (`postgres.<ref>`) and the direct host in the
 * hostname (`db.<ref>.supabase.co`), and ONE project has both, so comparing hosts alone would
 * let the pooler of a forbidden project through under its other name.
 */
export function projectRef(raw: string | undefined): string | null {
  const url = parse(raw);
  if (!url) return null;
  const direct = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.(?:co|com)$/i);
  if (direct) return direct[1]!.toLowerCase();
  if (/supabase\.(?:co|com)$/i.test(url.hostname)) {
    const user = decodeURIComponent(url.username);
    const dot = user.indexOf(".");
    if (dot > 0) return user.slice(dot + 1).toLowerCase();
  }
  return null;
}

/** `host:port/database`, lowercased: what two URLs must differ in to be different databases. */
export function dbIdentity(raw: string | undefined): string | null {
  const url = parse(raw);
  if (!url) return null;
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`.toLowerCase();
}

export const isLocalHost = (host: string) => LOCAL_HOSTS.has(host.toLowerCase());

export function assessTarget(input: GuardInput): Verdict {
  const problems: string[] = [];
  const notes: string[] = [];

  const named: [string, string | undefined][] = [
    ["DATABASE_URL", input.databaseUrl],
    ["DIRECT_URL", input.directUrl],
    ["APP_DATABASE_URL", input.appDatabaseUrl],
  ];
  const forbidden = input.forbiddenUrls.filter(Boolean);
  const forbiddenRefs = new Set(forbidden.map(projectRef).filter((r): r is string => Boolean(r)));
  const forbiddenIds = new Set(forbidden.map(dbIdentity).filter((r): r is string => Boolean(r)));

  const remote = input.allowRemote === "yes";

  for (const [label, raw] of named) {
    const url = parse(raw);
    if (!url) {
      problems.push(`${label} is missing or is not a URL. The load test needs all three, set in .env.load.`);
      continue;
    }
    const ref = projectRef(raw);
    if (ref && forbiddenRefs.has(ref)) {
      problems.push(`${label} is Supabase project "${ref}", which this checkout's own env files use. That is dev or production.`);
    }
    const id = dbIdentity(raw);
    if (id && forbiddenIds.has(id)) {
      problems.push(`${label} is the same database (${id}) as one in .env / .env.prod.`);
    }

    const local = isLocalHost(url.hostname);
    if (local) {
      const dbName = url.pathname.replace(/^\//, "");
      if (!/load|scratch|throwaway/i.test(dbName)) {
        problems.push(`${label} points at the local database "${dbName}". Name the throwaway one so it says what it is (for example school_os_load).`);
      }
    } else if (!remote) {
      problems.push(`${label} is not on this machine (${url.hostname}). Set LOAD_ALLOW_REMOTE=yes and LOAD_CONFIRM_TARGET to its project ref to point the test at a remote database.`);
    } else {
      if (!ref) {
        problems.push(`${label} is remote and not a Supabase project, so there is no project ref to confirm. Refusing.`);
      } else if (input.confirmTarget?.trim().toLowerCase() !== ref) {
        problems.push(`${label} is Supabase project "${ref}" but LOAD_CONFIRM_TARGET does not say so. Type the ref to confirm.`);
      } else {
        notes.push(`${label}: remote project ${ref}, confirmed.`);
      }
    }
  }

  // The three must be ONE database, or the seed would land in one place and the app read another.
  const ids = new Set(named.map(([, raw]) => projectRef(raw) ?? dbIdentity(raw)).filter(Boolean));
  const names = new Set(named.map(([, raw]) => parse(raw)?.pathname).filter(Boolean));
  if (ids.size > 1 && !named.every(([, raw]) => projectRef(raw))) {
    problems.push("DATABASE_URL, DIRECT_URL and APP_DATABASE_URL do not all name the same database.");
  }
  if (names.size > 1) {
    problems.push("The three database URLs name different databases.");
  }

  // Where the HTTP goes.
  const base = parse(input.baseUrl);
  if (!base) {
    problems.push("LOAD_BASE_URL is missing or is not a URL (for example http://localhost:3100).");
  } else {
    const host = base.hostname.toLowerCase();
    if (NEVER.some((never) => host === never || host.endsWith(`.${never}`))) {
      problems.push(`LOAD_BASE_URL is ${host}: that is production. Refusing.`);
    }
    const forbiddenHosts = new Set(forbidden.map((u) => parse(u)?.hostname.toLowerCase()).filter(Boolean));
    if (forbiddenHosts.has(host) && !isLocalHost(host)) {
      problems.push(`LOAD_BASE_URL is ${host}, the app address in this checkout's own env files.`);
    }
    if (!isLocalHost(host) && !remote) {
      problems.push(`LOAD_BASE_URL is not on this machine (${host}). Set LOAD_ALLOW_REMOTE=yes to drive a deployed copy, and make sure it uses the throwaway database.`);
    }
  }

  if (input.smsDryRun !== "1") {
    problems.push("SMS_DRY_RUN must be 1. A fake school's parents have fake numbers, and a real gateway would charge for every message.");
  }

  return { ok: problems.length === 0, problems, notes };
}

/** KEY="value" lines of an env file, for the keys that name a place. Anything else is ignored. */
export function forbiddenFromEnvText(text: string): string[] {
  const keys = new Set(["DATABASE_URL", "DIRECT_URL", "APP_DATABASE_URL", "PROD_DIRECT_URL", "PROD_APP_DIRECT_URL", "APP_URL", "VERIFY_BASE_URL"]);
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || !keys.has(match[1]!)) continue;
    const value = match[2]!.replace(/^["']|["']$/g, "").trim();
    if (value && !value.includes("<")) found.push(value);
  }
  return found;
}
