import "server-only";

import { prisma } from "@/lib/prisma";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What the Online payments settings page shows. The clock is read here, not in the page: reading it
 * during render trips `react-hooks/purity`.
 *
 * Never selects the key itself, only whether one is stored.
 */
export async function getGatewayOverview() {
  const gateway = await prisma.paymentGateway.findFirst({
    select: { enabled: true, mode: true, secretKeyEnc: true },
  });
  const recent = await prisma.onlinePayment.groupBy({
    by: ["status"],
    where: { createdAt: { gte: new Date(Date.now() - THIRTY_DAYS_MS) } },
    _count: true,
  });
  const count = (status: string) => recent.find((r) => r.status === status)?._count ?? 0;
  return {
    enabled: gateway?.enabled ?? false,
    mode: gateway?.mode ?? null,
    hasKey: Boolean(gateway?.secretKeyEnc),
    paid: count("PAID"),
    pending: count("PENDING"),
    failed: count("FAILED"),
  };
}
