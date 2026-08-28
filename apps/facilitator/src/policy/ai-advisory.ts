/**
 * AI advisory layer.
 *
 * ADVISORY ONLY — can only ADD friction ("hold"), never remove it.
 * This function assumes deterministic policy approval already happened; see
 * ./deterministic.ts: "THIS FUNCTION IS THE FINAL AUTHORITY. No downstream
 * code may override an `allowed: false` result. AI advisory is never called
 * if this returns false." The caller (server.ts) is responsible for calling
 * checkDeterministicPolicy first and only invoking getAdvisoryRecommendation
 * when that returned `allowed: true` — this file does not re-check that
 * itself, but the assumption is documented here too per this module's spec.
 * The caller must also never treat this function's output as able to
 * override a deterministic rejection: "proceed" means no added friction,
 * "hold" means a confirmation gate is required — nothing here can turn a
 * deterministic `false` into a settlement.
 *
 * `semanticMatch` is a separate, independent judgment (does the actual
 * request content match the agent's declared intent?) — it does not itself
 * gate anything; only `recommendation` feeds the confirm-gate in server.ts.
 * `semanticMatch` only judges content/intent fit, never amount or category
 * limits — those remain exclusively the deterministic engine's concern.
 */

import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";

export type AdvisoryRecommendation = "hold" | "proceed";
export type AdvisoryProvider = "gemini" | "groq" | "fail-closed";

/**
 * `recommendation` is advisory only — per CLAUDE.md, this never overrides
 * `isValid` downward and must never be "proceed" on any failure path.
 * `semanticMatch` is an independent judgment of whether the actual request
 * content matches the agent's declared intent; it is NOT the same signal as
 * `recommendation` (a provider could judge the content matches but still
 * recommend "hold" for other reasons, or vice versa).
 */
export interface AdvisoryResult {
  recommendation: AdvisoryRecommendation;
  semanticMatch: boolean;
  reasoning: string;
  humanSummary: string;
  provider: AdvisoryProvider;
}

/**
 * Context for a single getAdvisoryRecommendation call.
 *
 * `fetchImpl` defaults to the global `fetch` and exists so tests can inject a
 * mock instead of hitting real provider APIs. `agentMetadata.taskContext`, if
 * present, is the calling agent's own plain-language statement of what it's
 * trying to do — compared against the declared merchant/description for
 * `semanticMatch`. Comes from `PaymentPayload.extensions.agentMetadata` on
 * the wire; see x402-upi-client/src/upi-scheme-client.ts for how a client
 * populates it.
 */
export interface AdvisoryContext {
  agentMetadata?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

const TIMEOUT_MS = 15000;
const VALID_RECOMMENDATIONS: readonly AdvisoryRecommendation[] = ["hold", "proceed"];

interface ParsedAdvisory {
  recommendation: AdvisoryRecommendation;
  semanticMatch: boolean;
  reasoning: string;
  humanSummary: string;
}

function isValidRecommendation(value: unknown): value is AdvisoryRecommendation {
  return typeof value === "string" && (VALID_RECOMMENDATIONS as readonly string[]).includes(value);
}

/**
 * Defensively parses a provider's raw text response into a recommendation.
 * Providers are asked to respond with a bare JSON object, but LLMs sometimes
 * wrap it in prose or markdown fences — so after a strict JSON.parse we also
 * try extracting the first `{...}` block before giving up. Any shape that
 * isn't cleanly hold/proceed with a boolean semanticMatch and string
 * reasoning/humanSummary is treated as a parse failure (returns null), which
 * the caller treats as a provider failure and falls through to the next
 * provider — per CLAUDE.md, ambiguity fails closed, it does not guess.
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
      typeof (obj as Record<string, unknown>).semanticMatch === "boolean" &&
      typeof (obj as Record<string, unknown>).reasoning === "string" &&
      typeof (obj as Record<string, unknown>).humanSummary === "string"
    ) {
      const record = obj as Record<string, unknown>;
      return {
        recommendation: record.recommendation as AdvisoryRecommendation,
        semanticMatch: record.semanticMatch as boolean,
        reasoning: record.reasoning as string,
        humanSummary: record.humanSummary as string,
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

  const extra = requirements?.extra as Record<string, unknown> | undefined;
  const merchantName = typeof extra?.merchantName === "string" ? extra.merchantName : "unknown";
  const description = typeof extra?.description === "string" ? extra.description : "unknown";
  const taskContext =
    typeof context.agentMetadata?.taskContext === "string" ? context.agentMetadata.taskContext : undefined;

  return [
    "You are an advisory semantic-review layer for a payment facilitator agent.",
    "This transaction has already passed hard deterministic policy checks",
    "(amount ceiling, merchant allowlist, velocity limit) — those are final,",
    "already enforced elsewhere, and cannot be changed by you. Do NOT base",
    "your recommendation on the amount or on category/velocity limits — judge",
    "ONLY whether the actual request's content semantically matches what the",
    "calling agent declared it was trying to do.",
    "",
    "Declared merchant intent (from the payment requirements the resource",
    "server published):",
    `  Merchant name: ${merchantName}`,
    `  Description: ${description}`,
    "",
    "Actual agent intent (what the calling agent itself stated it is trying",
    "to do, taken from its own request metadata):",
    `  Task context: ${taskContext ?? "not provided"}`,
    "",
    `Payer VPA: ${typeof payerVpa === "string" ? payerVpa : "unknown"}`,
    "",
    "Set semanticMatch to false if the task context is missing, is too vague",
    "to compare, or plainly does not match the declared merchant/description.",
    "Only set it true when the two are genuinely consistent.",
    "",
    "recommendation is separate from semanticMatch: it reflects your overall",
    "advisory judgment (a mismatch should normally push toward 'hold', but",
    "this is your call, not a mechanical rule) — 'proceed' means no added",
    "friction, 'hold' means a human confirmation gate is required before this",
    "payment can settle. Never let ambiguity resolve to 'proceed'.",
    "",
    "Respond with ONLY a JSON object of exactly this shape, no markdown, no",
    "extra text:",
    '{"recommendation": "hold" | "proceed", "semanticMatch": true | false, ' +
      '"reasoning": "<short technical sentence, for logs>", ' +
      '"humanSummary": "<one plain-language sentence for a human approver>"}',
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
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
    // Read as text, not json() -- a 429/5xx body is frequently plain text
    // ("Too Many Requests") or an HTML error page, not JSON, and calling
    // .json() on it throws a raw SyntaxError instead of the clean,
    // catchable Error this function is supposed to produce on failure.
    const bodyText = await res.text().catch(() => "<unreadable body>");
    throw new Error(`Gemini request failed with status ${res.status}: ${bodyText}`);
  }

  // Even on a 2xx response, the body isn't guaranteed to be valid JSON (a
  // misconfigured proxy/gateway can return 200 with a non-JSON body) -- so
  // .json() is wrapped rather than called directly, keeping this a normal
  // thrown Error that getAdvisoryRecommendation's try/catch already falls
  // through on, instead of an unhandled SyntaxError.
  let data: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`Gemini response body was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("Gemini response missing text content");
  }

  console.log("[ai-advisory] Gemini raw response:", text);
  const parsed = parseRecommendation(text);
  if (!parsed) {
    throw new Error("Gemini response was not parseable into hold/proceed");
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
        model: "openai/gpt-oss-120b",
        messages: [{ role: "user", content: prompt }],
      }),
    },
    TIMEOUT_MS,
  );

  if (!res.ok) {
    // Same reasoning as callGemini above: read as text, not json() -- a
    // 429/5xx body is frequently plain text ("Too Many Requests") or an
    // HTML error page, not JSON.
    const bodyText = await res.text().catch(() => "<unreadable body>");
    throw new Error(`Groq request failed with status ${res.status}: ${bodyText}`);
  }

  // Same reasoning as callGemini above: don't assume a 2xx body is valid JSON.
  let data: { choices?: Array<{ message?: { content?: string } }> };
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`Groq response body was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("Groq response missing message content");
  }

  console.log("[ai-advisory] Groq raw response:", text);
  const parsed = parseRecommendation(text);
  if (!parsed) {
    throw new Error("Groq response was not parseable into hold/proceed");
  }
  return parsed;
}

/**
 * getAdvisoryRecommendation — advisory-only reasoning layer.
 *
 * Tries Gemini first, then Groq on any Gemini failure (network error,
 * timeout, non-OK response, missing/malformed/unparseable output). If both
 * fail, returns a fixed fail-closed result — this path MUST NEVER return
 * "proceed" or semanticMatch: true, since an unavailable advisory layer
 * should add friction, not silently grant a frictionless approval.
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
    const { recommendation, semanticMatch, reasoning, humanSummary } = await callGemini(prompt, fetchImpl);
    return { recommendation, semanticMatch, reasoning, humanSummary, provider: "gemini" };
  } catch (err) {
    console.log("[ai-advisory] Gemini failed:", err);
    // Fall through to Groq on any Gemini failure.
  }

  try {
    const { recommendation, semanticMatch, reasoning, humanSummary } = await callGroq(prompt, fetchImpl);
    return { recommendation, semanticMatch, reasoning, humanSummary, provider: "groq" };
  } catch (err) {
      console.log("[ai-advisory] Groq failed:", err);
    // Fall through to fail-closed on any Groq failure.
  }

  return {
    recommendation: "hold",
    semanticMatch: false,
    reasoning: "AI unavailable — fail-closed",
    humanSummary: "AI verification unavailable — review this payment manually before approving.",
    provider: "fail-closed",
  };
}
