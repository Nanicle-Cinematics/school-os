import type { BillSchool } from "@/lib/invoice-data";

/**
 * The top of every document the school hands out.
 *
 * Extracted because `addressLine` and `contactLine` existed TWICE — once in
 * invoice-bill.tsx and once, character for character, in payment-receipt.tsx.
 * That is the shape every drift bug in this codebase has had: the portal's own
 * copy of the payment-method labels, the export's own copy of the CSV headers.
 * A school that adds a GPS address and sees it on the invoice but not the
 * receipt would have no idea which file to blame.
 */

export function addressLine(school: BillSchool) {
  return [school.address, school.town, school.district, school.region]
    .filter(Boolean)
    .join(", ");
}

export function contactLine(school: BillSchool) {
  return [school.phone, school.altPhone, school.email, school.website]
    .filter(Boolean)
    .join(" · ");
}

export function BillLetterhead({ school }: { school: BillSchool }) {
  const address = addressLine(school);
  const contact = contactLine(school);

  return (
    <header className="flex items-center gap-4 border-b-2 border-brand-800 pb-3 text-center">
      {school.crestUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={school.crestUrl} alt="" className="h-14 w-14 shrink-0 object-contain" />
      ) : null}
      <div className="min-w-0 flex-1">
        <h1 className="font-display text-2xl">{school.name}</h1>
        {school.motto ? (
          <p className="font-display text-xs italic text-accent-600">{school.motto}</p>
        ) : null}
        {address ? <p className="mt-1 text-xs text-slate-600">{address}</p> : null}
        {contact ? <p className="text-xs text-slate-600">{contact}</p> : null}
        {school.gpsAddress ? (
          <p className="text-xs text-slate-500">GPS: {school.gpsAddress}</p>
        ) : null}
      </div>
      {/* Balances the crest so the name stays optically centred. */}
      {school.crestUrl ? <div className="h-14 w-14 shrink-0" /> : null}
    </header>
  );
}
