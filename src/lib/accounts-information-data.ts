import "server-only";

import { prisma } from "@/lib/prisma";

export async function getAccountsInformation(schoolId: string) {
  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: {
      tin: true,
      accreditationNo: true,
      settings: { select: { paymentInstructions: true, invoiceNote: true } },
    },
  });
  return {
    tin: school?.tin ?? "",
    accreditationNo: school?.accreditationNo ?? "",
    paymentInstructions: school?.settings?.paymentInstructions ?? "",
    invoiceNote: school?.settings?.invoiceNote ?? "",
  };
}
