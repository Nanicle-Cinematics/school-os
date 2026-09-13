import type { Role } from "@prisma/client";

// Coarse role groupings. Membership rows hold the roles; these constants keep
// "who may see this" in one place instead of scattered across pages.
export const LEADERSHIP: Role[] = ["OWNER", "HEAD", "ASSISTANT_HEAD"];
export const FINANCE: Role[] = [...LEADERSHIP, "ACCOUNTANT"];
export const OFFICE: Role[] = [...LEADERSHIP, "ADMIN"];

/**
 * The end-of-term report card entry screens, and the only place a teacher goes.
 *
 * A class teacher signs in to do one job: enter the term's marks for the
 * subjects they teach, and write the conduct and remark for their class. Every
 * other screen — the roll, the fees, other classes' results — is either not
 * their business or actively dangerous to hand them. So TEACHER appears on
 * these two routes and nowhere else, which is what makes `requireRole` refuse
 * everything else without a separate list of prohibitions to keep in step.
 *
 * LEADERSHIP is included because a head who marks a class needs the same
 * screens, and a head with the TEACHER role also keeps the rest of the app —
 * see `isTeacherOnly`.
 */
export const MARKING: Role[] = [...LEADERSHIP, "TEACHER"];

export type NavItem = {
  href: string;
  label: string;
  roles: Role[];
  /** Key into the icon set in `nav.tsx`. The rail is icon-first. */
  icon: NavIcon;
  /** Rendered but not yet implemented — links to a stub page. */
  stub?: boolean;
};

export type NavIcon =
  | "dashboard"
  | "export"
  | "students"
  | "guardians"
  | "staff"
  | "houses"
  | "classes"
  | "subjects"
  | "sheet"
  | "assessments"
  | "results"
  | "remarks"
  | "promotions"
  | "fees"
  | "invoices"
  | "payments"
  | "expenses"
  | "messages"
  | "users"
  | "settings";

/**
 * One hue per area of the app.
 *
 * It rides on the icon chip beside every rail item and nowhere else. Required
 * rather than optional, so a new section has to CHOOSE — a default would make
 * the newest part of the app the one grey thing in a coloured rail, which reads
 * as unfinished rather than as restraint.
 *
 * Colour here is information, not decoration: it says which part of the school
 * you are in before you have read a word. The gold accent keeps its own
 * separate job — the single figure on a screen that decides what happens next.
 */
export type NavHue = "overview" | "people" | "academics" | "finance" | "school";

export type NavSection = {
  heading: string;
  items: NavItem[];
  hue: NavHue;
};

export const NAV: NavSection[] = [
  {
    heading: "Overview",
    hue: "overview",
    items: [{ href: "/dashboard", label: "Dashboard", icon: "dashboard", roles: [...OFFICE, "ACCOUNTANT"] }],
  },
  {
    heading: "People",
    hue: "people",
    items: [
      { href: "/students", label: "Students", icon: "students", roles: OFFICE },
      { href: "/guardians", label: "Guardians", icon: "guardians", roles: OFFICE },
      { href: "/staff", label: "Staff", icon: "staff", roles: OFFICE },
      { href: "/houses", label: "Houses", icon: "houses", roles: OFFICE },
    ],
  },
  {
    heading: "Academics",
    hue: "academics",
    items: [
      { href: "/classes", label: "Classes", icon: "classes", roles: OFFICE },
      { href: "/subjects", label: "Subjects", icon: "subjects", roles: OFFICE },
      { href: "/assessments/sheet", label: "Mark sheet", icon: "sheet", roles: MARKING },
      { href: "/assessments", label: "Assessments", icon: "assessments", roles: LEADERSHIP },
      { href: "/results", label: "Results", icon: "results", roles: LEADERSHIP },
      { href: "/results/remarks", label: "Conduct & remarks", icon: "remarks", roles: MARKING },
      { href: "/promotions", label: "Promotions", icon: "promotions", roles: OFFICE },
    ],
  },
  {
    heading: "Finance",
    hue: "finance",
    items: [
      { href: "/fees", label: "Fee structure", icon: "fees", roles: FINANCE },
      { href: "/invoices", label: "Invoices", icon: "invoices", roles: FINANCE },
      { href: "/payments", label: "Payments", icon: "payments", roles: FINANCE },
      { href: "/expenses", label: "Expenses", icon: "expenses", roles: FINANCE },
    ],
  },
  {
    heading: "School",
    hue: "school",
    items: [
      { href: "/messages", label: "Messages", icon: "messages", roles: OFFICE },
      { href: "/users", label: "Users", icon: "users", roles: OFFICE },
      { href: "/export", label: "Export", icon: "export", roles: OFFICE },
      { href: "/settings", label: "Settings", icon: "settings", roles: [...LEADERSHIP, "ADMIN"] },
    ],
  },
];

/**
 * The parent portal. A guardian signs in to see their OWN children and nothing
 * else — so, like MARKING, this is a short list of routes rather than a list of
 * prohibitions.
 *
 * Note what this constant does NOT do: it decides which *routes* a parent may
 * open, not which *rows* they may read. Row security here is per family, and
 * Postgres RLS scopes by school, so every parent-facing query must additionally
 * filter to the guardian's own children in the application. See requireGuardian
 * and requireMyChild in portal-auth.ts — a route guard alone would let a parent
 * read another family's child by changing the id in the URL.
 */
export const PARENT_PORTAL: Role[] = ["PARENT"];

export function canAccess(roles: Role[], allowed: Role[]) {
  return roles.some((role) => allowed.includes(role));
}

/**
 * Someone whose only role is TEACHER — as opposed to a head or bursar who also
 * teaches, who keeps the whole app.
 */
export function isTeacherOnly(roles: Role[]) {
  return roles.length > 0 && roles.every((role) => role === "TEACHER");
}

/**
 * Someone whose only role is PARENT. Unlike a teacher, a parent is never also
 * staff in practice — but a proprietor whose own child attends the school would
 * hold both, and must keep the whole app, so this is `every` rather than `some`.
 */
export function isParentOnly(roles: Role[]) {
  return roles.length > 0 && roles.every((role) => role === "PARENT");
}

/**
 * Where a sign-in lands, and where a refused page sends someone.
 *
 * This must never point at a screen the same person would then be refused from:
 * a teacher bounced off /students to /dashboard would be bounced again, and the
 * two redirects would chase each other. Hence one function, used by the login
 * action, `requireRole`, `redirectIfAuthenticated` and the platform gate alike.
 */
export function landingFor(roles: Role[]) {
  if (isParentOnly(roles)) return "/portal";
  if (isTeacherOnly(roles)) return "/assessments/sheet";
  return "/dashboard";
}

/**
 * Which area of the school a path belongs to.
 *
 * ⚠️ The SAME longest-prefix rule the rail highlights with, deliberately shared
 * rather than reimplemented: if the page said Finance while the rail lit
 * Academics, the colour would be worse than no colour — it would be a confident
 * wrong answer about where you are.
 *
 * Longest match wins, so `/assessments/sheet` resolves to Mark sheet rather than
 * to Assessments, and a detail page like `/students/abc123` inherits its list's
 * area instead of falling through to nothing.
 */
export function bestHrefMatch(pathname: string, hrefs: string[]): string | undefined {
  return hrefs
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];
}

export function sectionFor(pathname: string): { hue: NavHue; icon: NavIcon } | null {
  const href = bestHrefMatch(
    pathname,
    NAV.flatMap((section) => section.items.map((item) => item.href)),
  );
  if (!href) {
    return null;
  }
  for (const section of NAV) {
    const item = section.items.find((candidate) => candidate.href === href);
    if (item) {
      return { hue: section.hue, icon: item.icon };
    }
  }
  return null;
}

export function navFor(roles: Role[]): NavSection[] {
  return NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => canAccess(roles, item.roles)),
  })).filter((section) => section.items.length > 0);
}

const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Proprietor",
  HEAD: "Headteacher",
  ASSISTANT_HEAD: "Assistant Head",
  ADMIN: "Administrator",
  ACCOUNTANT: "Bursar",
  TEACHER: "Teacher",
  LIBRARIAN: "Librarian",
  HOUSE_MASTER: "House Master",
  NURSE: "Nurse",
  PARENT: "Parent",
  STUDENT: "Student",
};

export function roleLabel(role: Role) {
  return ROLE_LABELS[role] ?? role;
}
