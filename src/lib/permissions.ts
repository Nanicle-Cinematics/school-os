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
  /** Rendered but not yet implemented — links to a stub page. */
  stub?: boolean;
};

export type NavSection = {
  heading: string;
  items: NavItem[];
};

export const NAV: NavSection[] = [
  {
    heading: "Overview",
    items: [{ href: "/dashboard", label: "Dashboard", roles: [...OFFICE, "ACCOUNTANT"] }],
  },
  {
    heading: "People",
    items: [
      { href: "/students", label: "Students", roles: OFFICE },
      { href: "/guardians", label: "Guardians", roles: OFFICE },
      { href: "/staff", label: "Staff", roles: OFFICE },
      { href: "/houses", label: "Houses", roles: OFFICE },
    ],
  },
  {
    heading: "Academics",
    items: [
      { href: "/classes", label: "Classes", roles: OFFICE },
      { href: "/subjects", label: "Subjects", roles: OFFICE },
      { href: "/assessments/sheet", label: "Mark sheet", roles: MARKING },
      { href: "/assessments", label: "Assessments", roles: LEADERSHIP },
      { href: "/results", label: "Results", roles: LEADERSHIP },
      { href: "/results/remarks", label: "Conduct & remarks", roles: MARKING },
      { href: "/promotions", label: "Promotions", roles: OFFICE },
    ],
  },
  {
    heading: "Finance",
    items: [
      { href: "/fees", label: "Fee structure", roles: FINANCE },
      { href: "/invoices", label: "Invoices", roles: FINANCE },
      { href: "/payments", label: "Payments", roles: FINANCE },
      { href: "/expenses", label: "Expenses", roles: FINANCE },
    ],
  },
  {
    heading: "School",
    items: [
      { href: "/messages", label: "Messages", roles: OFFICE },
      { href: "/users", label: "Users", roles: OFFICE },
      { href: "/settings", label: "Settings", roles: [...LEADERSHIP, "ADMIN"] },
    ],
  },
];

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
 * Where a sign-in lands, and where a refused page sends someone.
 *
 * This must never point at a screen the same person would then be refused from:
 * a teacher bounced off /students to /dashboard would be bounced again, and the
 * two redirects would chase each other. Hence one function, used by the login
 * action, `requireRole`, `redirectIfAuthenticated` and the platform gate alike.
 */
export function landingFor(roles: Role[]) {
  return isTeacherOnly(roles) ? "/assessments/sheet" : "/dashboard";
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
