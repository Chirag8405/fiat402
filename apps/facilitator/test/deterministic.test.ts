import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import {
  checkDeterministicPolicy,
  type VelocityRedisClient,
  type DeterministicPolicyContext,
} from "../src/policy/deterministic";

/**
 * In-memory fake implementing the same sorted-set + expire surface as a real
 * Redis client, so the velocity-limit tests exercise the same code paths
 * (zremrangebyscore trimming, zcard counting) that production Redis would.
 */
class FakeRedisClient implements VelocityRedisClient {
  private sortedSets = new Map<string, Map<string, number>>();

  async zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    const isNew = !set.has(member);
    set.set(member, score);
    this.sortedSets.set(key, set);
    return isNew ? 1 : 0;
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    const set = this.sortedSets.get(key);
    if (!set) return 0;
    const lo = Number(min);
    const hi = Number(max);
    let removed = 0;
    for (const [member, score] of set) {
      if (score >= lo && score <= hi) {
        set.delete(member);
        removed++;
      }
    }
    return removed;
  }

  async zcard(key: string): Promise<number> {
    return this.sortedSets.get(key)?.size ?? 0;
  }

  async expire(): Promise<number> {
    return 1;
  }
}

/** Always-throwing stand-in for a Redis client that is down/unreachable. */
class DownRedisClient implements VelocityRedisClient {
  async zadd(): Promise<number> {
    throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
  }
  async zremrangebyscore(): Promise<number> {
    throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
  }
  async zcard(): Promise<number> {
    throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
  }
  async expire(): Promise<number> {
    throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
  }
}

const MERCHANT = "merchant@ybl";

function buildRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "upi",
    network: "upi:in",
    amount: "10000",
    asset: "INR",
    payTo: MERCHANT,
    maxTimeoutSeconds: 90,
    extra: { merchantName: "Acme Chai Stall", description: "One cup of chai" },
    ...overrides,
  };
}

function buildPayload(requirements: PaymentRequirements): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: { payerVpa: "payer@okhdfcbank" },
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.MAX_AMOUNT_PAISE = "50000";
  process.env.ALLOWED_MERCHANTS = `${MERCHANT},other-merchant@icici`;
  process.env.MAX_REQUESTS_PER_MINUTE = "3";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("checkDeterministicPolicy", () => {
  it("rejects an amount over the MAX_AMOUNT_PAISE ceiling", async () => {
    const requirements = buildRequirements({ amount: "999999" });
    const payload = buildPayload(requirements);
    const context: DeterministicPolicyContext = { redis: new FakeRedisClient(), requestIp: "1.2.3.4" };

    const result = await checkDeterministicPolicy(requirements, payload, context);

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/exceeds MAX_AMOUNT_PAISE/);
  });

  it("passes for a valid amount and an allowlisted merchant", async () => {
    const requirements = buildRequirements({ amount: "10000" });
    const payload = buildPayload(requirements);
    const context: DeterministicPolicyContext = { redis: new FakeRedisClient(), requestIp: "1.2.3.4" };

    const result = await checkDeterministicPolicy(requirements, payload, context);

    expect(result).toEqual({ allowed: true });
  });

  it("rejects a merchant not in ALLOWED_MERCHANTS", async () => {
    const requirements = buildRequirements({ payTo: "unlisted@ybl" });
    const payload = buildPayload(requirements);
    const context: DeterministicPolicyContext = { redis: new FakeRedisClient(), requestIp: "1.2.3.4" };

    const result = await checkDeterministicPolicy(requirements, payload, context);

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not in ALLOWED_MERCHANTS/);
  });

  it("rejects the N+1th request once MAX_REQUESTS_PER_MINUTE is reached for an agent", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const redis = new FakeRedisClient();
    // MAX_REQUESTS_PER_MINUTE=3 (set in beforeEach). Use a fixed clock so all
    // requests land in the same 1-minute window regardless of test speed.
    let clock = 1_000_000;
    const context: DeterministicPolicyContext = {
      redis,
      requestIp: "9.9.9.9",
      now: () => clock,
    };

    for (let i = 0; i < 3; i++) {
      const result = await checkDeterministicPolicy(requirements, payload, context);
      expect(result).toEqual({ allowed: true });
      clock += 1000;
    }

    const fourth = await checkDeterministicPolicy(requirements, payload, context);
    expect(fourth.allowed).toBe(false);
    expect(fourth.reason).toMatch(/velocity limit exceeded/);
  });

  it("fails closed (rejects) when Redis is unavailable for the velocity check", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const context: DeterministicPolicyContext = { redis: new DownRedisClient(), requestIp: "1.2.3.4" };

    const result = await checkDeterministicPolicy(requirements, payload, context);

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Redis unavailable/);
  });

  it("rejects malformed requirements without throwing", async () => {
    const malformed = { scheme: "upi" } as unknown as PaymentRequirements;
    const payload = buildPayload(buildRequirements());
    const context: DeterministicPolicyContext = { redis: new FakeRedisClient(), requestIp: "1.2.3.4" };

    await expect(checkDeterministicPolicy(malformed, payload, context)).resolves.toMatchObject({
      allowed: false,
    });
  });
});
