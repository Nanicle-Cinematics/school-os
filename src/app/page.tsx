import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { Marketing } from "./marketing";

export const metadata: Metadata = {
  title: "School OS — school management for African schools",
  description:
    "Pupils, marks, terminal report cards and fees in one place, built around three terms and GES conventions. Seven days free, then GH₵800 a month.",
};

/**
 * The front door, for two different people.
 *
 * ⚠️ It used to redirect EVERYONE — signed in to /dashboard, signed out to
 * /login — which meant the only thing a head teacher sent this link ever saw
 * was a password box for an account they did not have. A product with a price
 * needs somewhere to send people before they are customers.
 *
 * Signed-in members still go straight through; nobody who works at a school
 * wants a sales page every morning.
 */
export default async function RootPage() {
  const result = await getSessionUser();
  if (result && result.user.memberships.length > 0) {
    redirect("/dashboard");
  }
  // A signed-in platform admin belongs to no school, so without this they land
  // on a sales page with a "Sign in" link, already signed in.
  if (result?.user.isPlatformAdmin) {
    redirect("/admin");
  }
  return <Marketing />;
}
