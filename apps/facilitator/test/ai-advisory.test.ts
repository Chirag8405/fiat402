import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import { getAdvisoryRecommendation, type AdvisoryContext } from "../src/policy/ai-advisory";

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

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function geminiBody(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

function groqBody(text: string) {
  return { choices: [{ message: { content: text } }] };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.GROQ_API_KEY = "groq-test-key";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("getAdvisoryRecommendation", () => {
  it("returns Gemini's recommendation on success, without calling Groq", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        return jsonResponse(geminiBody(JSON.stringify({ recommendation: "approve", justification: "Looks routine." })));
      }
      throw new Error("should not call Groq when Gemini succeeds");
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result).toEqual({ recommendation: "approve", justification: "Looks routine.", provider: "gemini" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls through to Groq when Gemini fails (network error)", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        throw new Error("network error");
      }
      if (urlStr.includes("api.groq.com")) {
        return jsonResponse(groqBody(JSON.stringify({ recommendation: "flag", justification: "Unusual pattern." })));
      }
      throw new Error(`unexpected url: ${urlStr}`);
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result).toEqual({ recommendation: "flag", justification: "Unusual pattern.", provider: "groq" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns fail-closed hold when both providers fail", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result).toEqual({
      recommendation: "hold",
      justification: "AI advisory unavailable — defaulting to hold per fail-closed policy",
      provider: "fail-closed",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats malformed Gemini output as a failure and falls through to Groq", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        // Not JSON, not one of approve/hold/flag anywhere parseable.
        return jsonResponse(geminiBody("I think this transaction seems fine, probably."));
      }
      if (urlStr.includes("api.groq.com")) {
        return jsonResponse(groqBody(JSON.stringify({ recommendation: "hold", justification: "Needs human review." })));
      }
      throw new Error(`unexpected url: ${urlStr}`);
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result).toEqual({ recommendation: "hold", justification: "Needs human review.", provider: "groq" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a recommendation value outside the enum as a failure and falls through", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        return jsonResponse(geminiBody(JSON.stringify({ recommendation: "reject", justification: "Not a valid enum value." })));
      }
      if (urlStr.includes("api.groq.com")) {
        return jsonResponse(groqBody(JSON.stringify({ recommendation: "approve", justification: "All clear." })));
      }
      throw new Error(`unexpected url: ${urlStr}`);
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result).toEqual({ recommendation: "approve", justification: "All clear.", provider: "groq" });
  });

  it("treats an empty response body as a failure and falls through", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        return jsonResponse(geminiBody(""));
      }
      if (urlStr.includes("api.groq.com")) {
        return jsonResponse(groqBody(JSON.stringify({ recommendation: "approve", justification: "Fine." })));
      }
      throw new Error(`unexpected url: ${urlStr}`);
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result).toEqual({ recommendation: "approve", justification: "Fine.", provider: "groq" });
  });

  it("treats a non-OK HTTP response as a failure and falls through", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        return jsonResponse({ error: "rate limited" }, false, 429);
      }
      if (urlStr.includes("api.groq.com")) {
        return jsonResponse(groqBody(JSON.stringify({ recommendation: "hold", justification: "Deferring to Groq." })));
      }
      throw new Error(`unexpected url: ${urlStr}`);
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result).toEqual({ recommendation: "hold", justification: "Deferring to Groq.", provider: "groq" });
  });

  it("times out a slow Gemini response rather than hanging, and does not double-count a late reply", async () => {
    vi.useFakeTimers();
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);

    const fetchImpl = vi.fn((url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        // Never resolves on its own; only rejects when the AbortController fires.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      if (urlStr.includes("api.groq.com")) {
        return Promise.resolve(jsonResponse(groqBody(JSON.stringify({ recommendation: "flag", justification: "Fell back after timeout." }))));
      }
      return Promise.reject(new Error(`unexpected url: ${urlStr}`));
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const resultPromise = getAdvisoryRecommendation(requirements, payload, context);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result).toEqual({ recommendation: "flag", justification: "Fell back after timeout.", provider: "groq" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
