import type { MomoNetwork, PaymentMethod } from "@prisma/client";

/**
 * How a payment is described to a human — a parent most of all.
 *
 * ⚠️ The portal had its own map keyed `MOMO` and `BANK`, values that do not
 * exist: the enum is MOBILE_MONEY, BANK_TRANSFER and BANK_DEPOSIT. Typed as
 * `Record<string, string>` with a `?? method` fallback, every miss was invisible
 * — so a parent's receipt read **MOBILE_MONEY · TELECEL**. The same shouted enum
 * that once reached the portal as "FIRST Term", on a bill.
 *
 * These are `Record<PaymentMethod, …>` and `Record<MomoNetwork, …>` on purpose:
 * a value added to either enum without a label here is a BUILD failure, not a
 * string a parent finds later. Prefer these to writing the map again — the staff
 * screens each had their own `.replace(/_/g, " ").toLowerCase()`, which is how
 * the two drifted in the first place.
 */

const METHOD: Record<PaymentMethod, string> = {
  CASH: "Cash",
  BANK_TRANSFER: "Bank transfer",
  BANK_DEPOSIT: "Bank deposit",
  MOBILE_MONEY: "Mobile money",
  CARD: "Card",
  CHEQUE: "Cheque",
};

/** Ghana's three networks, spelled the way each company spells itself. */
const NETWORK: Record<MomoNetwork, string> = {
  MTN: "MTN",
  TELECEL: "Telecel",
  AIRTELTIGO: "AirtelTigo",
};

export function paymentMethodLabel(method: PaymentMethod) {
  return METHOD[method];
}

export function momoNetworkLabel(network: MomoNetwork) {
  return NETWORK[network];
}

/**
 * "Mobile money · Telecel", or just the method where there is no network.
 * One string, so a receipt line and a payments table cannot disagree.
 */
export function paymentSource(method: PaymentMethod, network?: MomoNetwork | null) {
  return network ? `${METHOD[method]} · ${NETWORK[network]}` : METHOD[method];
}
