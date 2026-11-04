import { formatCedis } from "@/lib/money";
import { fromPesewas } from "@/lib/payroll-rules";

/** Whole pesewas as GH₵ for a screen. Money stays an integer until the last moment it is read by a person. */
export const gh = (pesewas: number) => formatCedis(fromPesewas(pesewas));

export const day = (value: Date | null | undefined) =>
  value ? new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
