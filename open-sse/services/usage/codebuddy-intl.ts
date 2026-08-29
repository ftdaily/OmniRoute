/**
 * CodeBuddy INTL usage handler — scoped to the "codebuddy-intl" provider.
 *
 * Mirrors the CN handler; the intl gateway exposes the same wrapped billing
 * payload shape (data.Response.Data.Accounts[]) and the same refill/bonus
 * credit semantics. Only the host differs.
 */

const USAGE_URL = "https://www.codebuddy.ai/v2/billing/meter/get-user-resource";

interface TencentAccount {
  PackageName?: string;
  SubProductName?: string;
  CycleStartTime?: string | number;
  CycleEndTime?: string | number;
  DeductionEndTime?: string | number;
  CycleCapacitySize?: number | string;
  CycleCapacitySizePrecise?: string | number;
  CycleCapacityUsed?: number | string;
  CycleCapacityUsedPrecise?: string | number;
  CapacitySize?: number | string;
  CapacitySizePrecise?: string | number;
  CapacityUsed?: number | string;
  CapacityUsedPrecise?: string | number;
}

function parseResetTime(value: unknown): string | null {
  if (!value) return null;
  try {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number") {
      const ts = value < 1e12 ? value * 1000 : value;
      const d = new Date(ts);
      return d.getTime() > 0 ? d.toISOString() : null;
    }
    if (typeof value === "string") {
      if (/^\d+$/.test(value)) {
        const n = Number(value);
        const d = new Date(n < 1e12 ? n * 1000 : n);
        return d.getTime() > 0 ? d.toISOString() : null;
      }
      const d = new Date(value);
      return d.getTime() > 0 ? d.toISOString() : null;
    }
  } catch {
    return null;
  }
  return null;
}

interface CodeBuddyUsageResult {
  plan?: string;
  message?: string;
  quotas?: Record<
    string,
    { used: number; total: number; resetAt: string | null; unlimited: boolean }
  >;
}

const PROVIDER_NAME = "CodeBuddy INTL";
const FALLBACK_PLAN = "CodeBuddy International";

function num(precise: unknown, plain: unknown): number {
  const n = Number(precise ?? plain);
  return Number.isFinite(n) ? n : 0;
}

function refillCadence(acc: TencentAccount): string {
  const start = parseResetTime(acc.CycleStartTime);
  const end = parseResetTime(acc.CycleEndTime);
  if (start && end) {
    const days = (new Date(end).getTime() - new Date(start).getTime()) / 86400000;
    if (days <= 1.5) return "Daily";
    if (days <= 10) return "Weekly";
  }
  return "Monthly";
}

function cycleEndMs(acc: TencentAccount): number {
  const t = parseResetTime(acc.CycleEndTime);
  return t ? new Date(t).getTime() : Number.MAX_SAFE_INTEGER;
}

function isRefill(acc: TencentAccount): boolean {
  return num(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize) > 0;
}

export async function getCodeBuddyIntlUsage(
  accessToken?: string,
  apiKey?: string,
  _providerSpecificData?: unknown
): Promise<CodeBuddyUsageResult> {
  const token = accessToken || apiKey;
  if (!token) {
    return { message: "CodeBuddy INTL credential not available." };
  }
  try {
    const response = await fetch(USAGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "IDE/2.63.2 CodeBuddy/2.63.2",
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "codebuddy.ai",
        Authorization: `Bearer ${accessToken}`,
        "X-Product": "SaaS",
      },
      body: "{}",
    });
    if (!response.ok) {
      return { message: `${PROVIDER_NAME} error: HTTP ${response.status}` };
    }
    const json = (await response.json().catch(() => ({}))) as {
      code?: number;
      data?: { Response?: { Data?: TencentAccount[] } } | TencentAccount[];
    };
    if (json?.code !== 0) {
      return { message: `${PROVIDER_NAME} error: upstream code ${json?.code ?? "?"}` };
    }
    const inner = Array.isArray(json.data)
      ? json.data
      : ((json.data as { Response?: { Data?: TencentAccount[] } } | undefined)?.Response?.Data ??
        []);
    const accountsRaw = inner.filter((a): a is TencentAccount => !!a && typeof a === "object");
    if (accountsRaw.length === 0) {
      return { plan: FALLBACK_PLAN, quotas: {} };
    }

    const byExpiry = (a: TencentAccount, b: TencentAccount) => cycleEndMs(a) - cycleEndMs(b);
    const refills = accountsRaw.filter(isRefill).sort(byExpiry);
    const bonuses = accountsRaw.filter((a) => !isRefill(a)).sort(byExpiry);

    const quotas: NonNullable<CodeBuddyUsageResult["quotas"]> = {};
    const seenRefill: Record<string, number> = {};
    refills.forEach((acc) => {
      const base = refillCadence(acc);
      seenRefill[base] = (seenRefill[base] || 0) + 1;
      const name = seenRefill[base] > 1 ? `${base} ${seenRefill[base]}` : base;
      quotas[name] = {
        used: num(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed),
        total: num(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize),
        resetAt: parseResetTime(acc.CycleEndTime),
        unlimited: false,
      };
    });
    bonuses.forEach((acc, i) => {
      quotas[`Bonus Pack ${i + 1}`] = {
        used: num(acc.CapacityUsedPrecise, acc.CapacityUsed),
        total: num(acc.CapacitySizePrecise, acc.CapacitySize),
        resetAt: parseResetTime(acc.CycleEndTime),
        unlimited: false,
      };
    });

    const basePkg = refills[0] || accountsRaw[0] || {};
    const plan = basePkg.PackageName || basePkg.SubProductName || FALLBACK_PLAN;

    return { plan, quotas };
  } catch {
    return { message: `${PROVIDER_NAME} error: failed to fetch quota.` };
  }
}

export default getCodeBuddyIntlUsage;
