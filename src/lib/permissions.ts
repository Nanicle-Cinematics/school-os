import type { Role } from "@prisma/client";

// Coarse role groupings. Membership rows hold the roles; these constants keep
// "who may see this" in one place instead of scattered across pages.
export const LEADERSHIP: Role[] = ["OWNER", "HEAD", "ASSISTANT_HEAD"];
export const FINANCE: Role[] = [...LEADERSHIP, "ACCOUNTANT"];
export const OFFICE: Role[] = [...LEADERSHIP, "ADMIN"];
export const ACADEMIC: Role[] = [...LEADERSHIP, "TEACHER"];

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
    items: [{ href: "/dashboard", label: "Dashboard", roles: [...OFFICE, "ACCOUNTANT", "TEACHER"] }],
  },
  {
    heading: "People",
    items: [
      { href: "/students", label: "Students", roles: [...OFFICE, "TEACHER"] },
      { href: "/guardians", label: "Guardians", roles: OFFICE },
      { href: "/staff", label: "Staff", roles: OFFICE },
      { href: "/houses", label: "Houses", roles: OFFICE },
    ],
  },
  {
    heading: "Academics",
    items: [
      { href: "/classes", label: "Classes", roles: [...OFFICE, "TEACHER"] },
      { href: "/subjects", label: "Subjects", roles: [...OFFICE, "TEACHER"] },
      { href: "/assessments", label: "Assessments", roles: ACADEMIC },
      { href: "/results", label: "Results", roles: ACADEMIC },
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
