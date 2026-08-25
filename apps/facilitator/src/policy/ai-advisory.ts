/**
 * AI advisory layer.
 *
 * ADVISORY ONLY — can only ADD friction ("hold"/"flag"), never remove it.
 * This function assumes deterministic policy approval already happened; see
 * ./deterministic.ts: "THIS FUNCTION IS THE FINAL AUTHORITY. No downstream
 * code may override an `allowed: false` result. AI advisory is never called
 * if this returns false." The caller (server.ts) is responsible for calling
 * checkDeterministicPolicy first and only invoking getAdvisoryRecommendation
 * when that returned `allowed: true` — this file does not re-check that
 * itself, but the assumption is documented here too per this module's spec.
 * The caller must also never treat this function's output as able to
 * override a deterministic rejection: "approve" means no added friction,
 * "hold"/"flag" mean a confirmation gate is required — nothing here can turn
 * a deterministic `false` into a settlement.
 */

import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";

export type AdvisoryRecommendation = "approve" | "hold" | "flag";
export type AdvisoryProvider = "gemini" | "groq" | "fail-closed";

export interface AdvisoryResult {
  recommendation: AdvisoryRecommendation;
  justification: string;
  provider: AdvisoryProvider;
}

/**
 * Context for a single getAdvisoryRecommendation call.
 *
 * `fetchImpl` defaults to the global `fetch` and exists so tests can inject a
 * mock instead of hitting real provider APIs.
 */
export interface AdvisoryContext {
  agentMetadata?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

const TIMEOUT_MS = 5000;
const VALID_RECOMMENDATIONS: readonly AdvisoryRecommendation[] = ["approve", "hold", "flag"];

interface ParsedAdvisory {
  recommendation: AdvisoryRecommendation;
  justification: string;
}

function isValidRecommendation(value: unknown): value is AdvisoryRecommendation {
  return typeof value === "string" && (VALID_RECOMMENDATIONS as readonly string[]).includes(value);
}

/**
 * Defensively parses a provider's raw text response into a recommendation.
 * Providers are asked to respond with a bare JSON object, but LLMs sometimes
 * wrap it in prose or markdown fences — so after a strict JSON.parse we also
 * try extracting the first `{...}` block before giving up. Any shape that
 * isn't cleanly one of approve/hold/flag with a string justification is
 * treated as a parse failure (returns null), which the caller treats as a
 * provider failure and falls through to the next provider.
 */
function parseRecommendation(text: string): ParsedAdvisory | null {
  const tryParse = (candidate: string): ParsedAdvisory | null => {
    let obj: unknown;
    try {
      obj = JSON.parse(candidate);
    } catch {
      return null;
    }
    if (
      obj &&
      typeof obj === "object" &&
      isValidRecommendation((obj as Record<string, unknown>).recommendation) &&
      typeof (obj as Record<string, unknown>).justification === "string"
    ) {
      const record = obj as Record<string, unknown>;
      return {
        recommendation: record.recommendation as AdvisoryRecommendation,
        justification: record.justification as string,
      };
    }
    return null;
  };

  const direct = tryParse(text.trim());
  if (direct) return direct;

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    const extracted = tryParse(match[0]);
    if (extracted) return extracted;
  }

  return null;
}

function buildPrompt(
  requirements: PaymentRequirements,
  payload: PaymentPayload,
  context: AdvisoryContext,
): string {
  const payerVpa =
  payload && typeof payload === "object"
    ? ((payload as Record<string, unknown>).payerVpa as string | undefined) ??
      (payload.payload && typeof payload.payload === "object"
        ? (payload.payload as { payerVpa?: unknown }).payerVpa
        : undefined)
    : undefined;
  const agentMetadata = context.agentMetadata ? JSON.stringify(context.agentMetadata) : "none";

  return [
    "You are an advisory fraud-review layer for a payment facilitator agent.",
    "This transaction has already passed hard deterministic policy checks",
    "(amount ceiling, merchant allowlist, velocity limit) — those are final and",
    "cannot be changed. Your job is advisory only: recommend whether the",
    "transaction should proceed without friction, be held for confirmation, or",
    "be flagged for review.",
    "For small test transactions (under 500 paise) from known VPAs in a",
    "development environment, the default recommendation should be 'approve'",
    "unless there is a specific fraud signal.",
    "",
    `Amount (paise): ${requirements?.amount}`,
    `Merchant VPA (payTo): ${requirements?.payTo}`,
    `Payer VPA: ${typeof payerVpa === "string" ? payerVpa : "unknown"}`,
    `Agent metadata: ${agentMetadata}`,
    "",
    "Respond with ONLY a JSON object of exactly this shape, no markdown, no",
    "extra text:",
    '{"recommendation": "approve" | "hold" | "flag", "justification": "<one sentence>"}',
  ].join("\n");
}

/**
 * Runs `fetchImpl` with a hard timeout using AbortController, so a slow
 * provider is actually cancelled rather than left to resolve later — this is
 * what prevents a late response from a "timed out" provider being awaited
 * twice or the overall call hanging past TIMEOUT_MS.
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(prompt: string, fetchImpl: typeof fetch): Promise<ParsedAdvisory> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2-flash-lite:generateContent?key=${apiKey}`;
  const res = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    },
    TIMEOUT_MS,
  );

  if (!res.ok) {
    throw new Error(`Gemini request failed with status ${res.status}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("Gemini response missing text content");
  }

  console.log("[ai-advisory] Gemini raw response:", text);
  const parsed = parseRecommendation(text);
  if (!parsed) {
    throw new Error("Gemini response was not parseable into approve/hold/flag");
  }
  return parsed;
}

async function callGroq(prompt: string, fetchImpl: typeof fetch): Promise<ParsedAdvisory> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY not set");
  }

  const url = "https://api.groq.com/openai/v1/chat/completions";
  const res = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
      }),
    },
    TIMEOUT_MS,
  );

  if (!res.ok) {
    throw new Error(`Groq request failed with status ${res.status}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("Groq response missing message content");
  }

  console.log("[ai-advisory] Groq raw response:", text);
  const parsed = parseRecommendation(text);
  if (!parsed) {
    throw new Error("Groq response was not parseable into approve/hold/flag");
  }
  return parsed;
}

/**
 * getAdvisoryRecommendation — advisory-only reasoning layer.
 *
 * Tries Gemini first, then Groq on any Gemini failure (network error,
 * timeout, non-OK response, missing/malformed/unparseable output). If both
 * fail, returns a fixed fail-closed "hold" — this path MUST NEVER return
 * "approve", since an unavailable advisory layer should add friction, not
 * silently grant a frictionless approval.
 *
 * Never throws.
 */
export async function getAdvisoryRecommendation(
  requirements: PaymentRequirements,
  payload: PaymentPayload,
  context: AdvisoryContext = {},
): Promise<AdvisoryResult> {
  const fetchImpl = context.fetchImpl ?? fetch;
  const prompt = buildPrompt(requirements, payload, context);

  try {
    const { recommendation, justification } = await callGemini(prompt, fetchImpl);
    return { recommendation, justification, provider: "gemini" };
  } catch (err) {
    console.log("[ai-advisory] Gemini failed:", err);
    // Fall through to Groq on any Gemini failure.
  }

  try {
    const { recommendation, justification } = await callGroq(prompt, fetchImpl);
    return { recommendation, justification, provider: "groq" };
  } catch {
    // Fall through to fail-closed on any Groq failure.
  }

  return {
    recommendation: "hold",
    justification: "AI advisory unavailable — defaulting to hold per fail-closed policy",
    provider: "fail-closed",
  };
}
