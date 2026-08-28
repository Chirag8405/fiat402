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
    text: async () => JSON.stringify(body),
  } as Response;
}

/** A non-JSON response body, e.g. a rate-limiter's plain-text/HTML error page. */
function plainTextResponse(text: string, ok = false, status = 429): Response {
  return {
    ok,
    status,
    json: async () => {
      throw new SyntaxError(`Unexpected token '${text[0]}', "${text}" is not valid JSON`);
    },
    text: async () => text,
  } as unknown as Response;
}

function geminiBody(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

function groqBody(text: string) {
  return { choices: [{ message: { content: text } }] };
}

/** Convenience for building a well-formed provider JSON response body. */
function advisoryJson(overrides: {
  recommendation: "hold" | "proceed";
  semanticMatch: boolean;
  reasoning: string;
  humanSummary: string;
}) {
  return JSON.stringify(overrides);
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
        return jsonResponse(
          geminiBody(
            advisoryJson({
              recommendation: "proceed",
              semanticMatch: true,
              reasoning: "Task context matches declared merchant/description.",
              humanSummary: "Looks routine.",
            }),
          ),
        );
      }
      throw new Error("should not call Groq when Gemini succeeds");
    });
    const context: AdvisoryContext = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      agentMetadata: { taskContext: "Buying one cup of chai from Acme Chai Stall" },
    };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result).toEqual({
      recommendation: "proceed",
      semanticMatch: true,
      reasoning: "Task context matches declared merchant/description.",
      humanSummary: "Looks routine.",
      provider: "gemini",
    });
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
        return jsonResponse(
          groqBody(
            advisoryJson({
              recommendation: "hold",
              semanticMatch: false,
              reasoning: "Unusual pattern.",
              humanSummary: "This looks unusual — please review before approving.",
            }),
          ),
        );
      }
      throw new Error(`unexpected url: ${urlStr}`);
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result).toEqual({
      recommendation: "hold",
      semanticMatch: false,
      reasoning: "Unusual pattern.",
      humanSummary: "This looks unusual — please review before approving.",
      provider: "groq",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns fail-closed hold with semanticMatch: false when both providers fail", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result).toEqual({
      recommendation: "hold",
      semanticMatch: false,
      reasoning: "AI unavailable — fail-closed",
      humanSummary: "AI verification unavailable — review this payment manually before approving.",
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
        // Not JSON, not parseable into the required shape.
        return jsonResponse(geminiBody("I think this transaction seems fine, probably."));
      }
      if (urlStr.includes("api.groq.com")) {
        return jsonResponse(
          groqBody(
            advisoryJson({
              recommendation: "hold",
              semanticMatch: false,
              reasoning: "Needs human review.",
              humanSummary: "Please review this payment before approving.",
            }),
          ),
        );
      }
      throw new Error(`unexpected url: ${urlStr}`);
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result.recommendation).toBe("hold");
    expect(result.provider).toBe("groq");
  });

  it("treats a recommendation value outside the enum as a failure and falls through", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        return jsonResponse(
          geminiBody(
            JSON.stringify({
              recommendation: "approve", // no longer a valid enum value
              semanticMatch: true,
              reasoning: "Not a valid enum value.",
              humanSummary: "Not a valid enum value.",
            }),
          ),
        );
      }
      if (urlStr.includes("api.groq.com")) {
        return jsonResponse(
          groqBody(
            advisoryJson({
              recommendation: "proceed",
              semanticMatch: true,
              reasoning: "All clear.",
              humanSummary: "All clear.",
            }),
          ),
        );
      }
      throw new Error(`unexpected url: ${urlStr}`);
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result.recommendation).toBe("proceed");
    expect(result.provider).toBe("groq");
  });

  it("treats a missing semanticMatch field as a failure and falls through", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        return jsonResponse(
          geminiBody(JSON.stringify({ recommendation: "proceed", reasoning: "Fine.", humanSummary: "Fine." })),
        );
      }
      if (urlStr.includes("api.groq.com")) {
        return jsonResponse(
          groqBody(
            advisoryJson({
              recommendation: "proceed",
              semanticMatch: true,
              reasoning: "Fine.",
              humanSummary: "Fine.",
            }),
          ),
        );
      }
      throw new Error(`unexpected url: ${urlStr}`);
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result.provider).toBe("groq");
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
        return jsonResponse(
          groqBody(
            advisoryJson({
              recommendation: "hold",
              semanticMatch: false,
              reasoning: "Deferring to Groq.",
              humanSummary: "Deferring to Groq.",
            }),
          ),
        );
      }
      throw new Error(`unexpected url: ${urlStr}`);
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result.recommendation).toBe("hold");
    expect(result.provider).toBe("groq");
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
        return Promise.resolve(
          jsonResponse(
            groqBody(
              advisoryJson({
                recommendation: "hold",
                semanticMatch: false,
                reasoning: "Fell back after timeout.",
                humanSummary: "Fell back after timeout.",
              }),
            ),
          ),
        );
      }
      return Promise.reject(new Error(`unexpected url: ${urlStr}`));
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const resultPromise = getAdvisoryRecommendation(requirements, payload, context);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result.recommendation).toBe("hold");
    expect(result.provider).toBe("groq");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("semanticMatch: false when the actual taskContext conflicts with the declared merchant/description", async () => {
    // Declared: a chai stall selling one cup of chai. Actual (agent's own
    // stated intent): booking a flight. These are unrelated, so the prompt
    // sent to the provider must carry both, and a provider recognizing the
    // mismatch should report semanticMatch: false even while still being
    // free to pick either recommendation value.
    const requirements = buildRequirements({
      extra: { merchantName: "Acme Chai Stall", description: "One cup of chai" },
    });
    const payload = buildPayload(requirements);

    let capturedPrompt = "";
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        const body = JSON.parse(String(init?.body));
        capturedPrompt = body.contents[0].parts[0].text;
        return jsonResponse(
          geminiBody(
            advisoryJson({
              recommendation: "hold",
              semanticMatch: false,
              reasoning: "Declared merchant sells chai; actual task context is booking a flight — unrelated.",
              humanSummary: "This payment's stated purpose doesn't match the merchant — please review.",
            }),
          ),
        );
      }
      throw new Error("should not call Groq when Gemini succeeds");
    });
    const context: AdvisoryContext = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      agentMetadata: { taskContext: "Booking a one-way flight to Goa" },
    };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result.semanticMatch).toBe(false);
    expect(result.provider).toBe("gemini");
    // The declared and actual intents must both actually reach the provider.
    expect(capturedPrompt).toContain("Acme Chai Stall");
    expect(capturedPrompt).toContain("One cup of chai");
    expect(capturedPrompt).toContain("Booking a one-way flight to Goa");
  });

  it("falls through cleanly (no unhandled exception) when Gemini 429s with a plain-text body", async () => {
    // Regression test: a real 429 from Gemini/Groq is frequently plain text
    // ("Too Many Requests"), not JSON. Calling .json() on that throws a raw
    // SyntaxError -- this must never escape getAdvisoryRecommendation.
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        return plainTextResponse("Too Many Requests", false, 429);
      }
      if (urlStr.includes("api.groq.com")) {
        return jsonResponse(
          groqBody(
            advisoryJson({
              recommendation: "hold",
              semanticMatch: false,
              reasoning: "Gemini rate-limited, deferring to Groq.",
              humanSummary: "Please review — the primary AI provider was unavailable.",
            }),
          ),
        );
      }
      throw new Error(`unexpected url: ${urlStr}`);
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result.recommendation).toBe("hold");
    expect(result.provider).toBe("groq");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns fail-closed (not a thrown exception) when both providers 429 with plain-text bodies", async () => {
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const fetchImpl = vi.fn(async () => plainTextResponse("Too Many Requests", false, 429));
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result).toEqual({
      recommendation: "hold",
      semanticMatch: false,
      reasoning: "AI unavailable — fail-closed",
      humanSummary: "AI verification unavailable — review this payment manually before approving.",
      provider: "fail-closed",
    });
  });

  it("falls through cleanly when a provider returns 200 OK with a non-JSON body", async () => {
    // Distinct from the 429 case: this covers a misconfigured proxy/gateway
    // that returns a 2xx status with a non-JSON body, which res.ok alone
    // would not catch.
    const requirements = buildRequirements();
    const payload = buildPayload(requirements);
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        return plainTextResponse("<html>upstream error</html>", true, 200);
      }
      if (urlStr.includes("api.groq.com")) {
        return jsonResponse(
          groqBody(
            advisoryJson({
              recommendation: "proceed",
              semanticMatch: true,
              reasoning: "Fine.",
              humanSummary: "Fine.",
            }),
          ),
        );
      }
      throw new Error(`unexpected url: ${urlStr}`);
    });
    const context: AdvisoryContext = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const result = await getAdvisoryRecommendation(requirements, payload, context);

    expect(result.provider).toBe("groq");
  });
});
