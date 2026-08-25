import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";

export default async function RootPage() {
  const result = await getSessionUser();
  redirect(result && result.user.memberships.length > 0 ? "/dashboard" : "/login");
}
