/**
 * Loads the three captured runs in fixtures/*.json and turns each into a
 * ReplaySource (components/AgentConsole.tsx) plus the derived props the
 * other live panels (StateMachineViz/DecisionPanel/RawTrafficViewer) need --
 * consumed only by app/page.tsx's "Live proof" section. Real, captured data
 * throughout; nothing here is fabricated except the small connective console
 * strings, which are copied VERBATIM from app/api/simulate/route.ts's own
 * `emit(...)` call sites (see REPLAY_LINE_TEMPLATES below) with only the
 * already-real persona label / taskContext substituted in -- taskContext is
 * decoded from the fixture's own captured paymentSignatureHeader, not
 * invented (see extractTaskContext).
 *
 * Fixture JSON shape (produced by app/api/console/export/[requestId]/route.ts):
 *   { requestId, persona, events: FiatEvent[], reconciliation: ReconciliationRecordDto | null,
 *     headers: { paymentRequiredHeader, paymentSignatureHeader, paymentResponseHeader } }
 */

import type { ConsoleLine, ReplaySource, ReplayStep } from "../components/AgentConsole";
import type { DeterministicDecision, AiAdvisory } from "../components/DecisionPanel";
import type { FiatEvent, ReconciliationRecordDto } from "./types";

import researchbotCleanApprove from "../fixtures/researchbot-clean-approve.json";
import travelbotMismatchDecline from "../fixtures/travelbot-mismatch-decline.json";
import travelbotTimeout from "../fixtures/travelbot-timeout.json";

export interface FixtureHeaders {
  paymentRequiredHeader: string | null;
  paymentSignatureHeader: string | null;
  paymentResponseHeader: string | null;
}

export interface Fixture {
  requestId: string;
  persona: string | null;
  events: FiatEvent[];
  reconciliation: ReconciliationRecordDto | null;
  headers: FixtureHeaders;
}

/** JSON-imported fixtures type-check structurally against Fixture (resolveJsonModule widens string literals, so this is a safe structural cast, not a runtime one). */
const FIXTURES = {
  researchbot: researchbotCleanApprove as unknown as Fixture,
  "travelbot-decline": travelbotMismatchDecline as unknown as Fixture,
  "travelbot-timeout": travelbotTimeout as unknown as Fixture,
} as const;

export type FixtureKey = keyof typeof FIXTURES;

export function getFixture(key: FixtureKey): Fixture {
  return FIXTURES[key];
}

/** Same {label, key} shape components/AgentConsole.tsx's own PERSONAS constant uses -- copied verbatim from app/api/simulate/route.ts's PERSONAS labels. */
const REPLAY_PERSONAS: { key: FixtureKey; label: string }[] = [
  { key: "researchbot", label: "Run ResearchBot" },
  { key: "travelbot-decline", label: "Run TravelBot — Decline" },
  { key: "travelbot-timeout", label: "Run TravelBot — Timeout" },
];

const PERSONA_DISPLAY_LABEL: Record<FixtureKey, string> = {
  researchbot: "ResearchBot",
  "travelbot-decline": "TravelBot",
  "travelbot-timeout": "TravelBot",
};

function decodeBase64Json(header: string): unknown | null {
  try {
    const binary = atob(header);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch {
    return null;
  }
}

/** Pulls the real captured taskContext back out of the fixture's own paymentSignatureHeader -- see app/api/simulate/route.ts's registerUpiScheme call, which is what put it there in the first place (extensions.agentMetadata.taskContext). */
function extractTaskContext(fixture: Fixture): string | null {
  const header = fixture.headers.paymentSignatureHeader;
  if (!header) return null;
  const decoded = decodeBase64Json(header) as { extensions?: { agentMetadata?: { taskContext?: unknown } } } | null;
  const taskContext = decoded?.extensions?.agentMetadata?.taskContext;
  return typeof taskContext === "string" ? taskContext : null;
}

/**
 * Console line templates copied verbatim from app/api/simulate/route.ts's
 * own emit(...)/emitHeaders(...) call sites (see that file's POST handler),
 * so a replayed run reads identically to a real one -- only the interpolated
 * values differ, and those come from real captured data (persona label,
 * decoded taskContext), never invented text.
 */
function buildReplaySteps(fixture: Fixture, personaKey: FixtureKey): ReplayStep[] {
  const label = PERSONA_DISPLAY_LABEL[personaKey];
  const taskContext = extractTaskContext(fixture);
  const hasHeaders = Boolean(fixture.headers.paymentRequiredHeader && fixture.headers.paymentSignatureHeader);

  const line = (text: string, kind: ConsoleLine["kind"] = "info"): ConsoleLine => ({ line: text, kind });

  const steps: ReplayStep[] = [
    { delayMs: 0, line: line(`${label}: requesting protected resource...`) },
    { delayMs: 320, line: line("402 Payment Required received from merchant", "success") },
    {
      delayMs: 260,
      line: line(`constructing UPI payment payload (task: "${taskContext ?? fixture.persona ?? "unknown"}")...`),
    },
  ];

  if (hasHeaders) {
    steps.push({ delayMs: 240, line: line("PAYMENT-REQUIRED / PAYMENT-SIGNATURE headers captured", "success") });
  } else {
    steps.push({
      delayMs: 240,
      line: line("PAYMENT-REQUIRED header missing from merchant's 402 response -- raw traffic capture skipped", "error"),
    });
  }

  steps.push({ delayMs: 220, line: line("sending payment payload to facilitator via merchant -- watch the rail below") });

  return steps;
}

export function buildReplaySource(): ReplaySource {
  return {
    personas: REPLAY_PERSONAS,
    run(personaKey: string) {
      if (!(personaKey in FIXTURES)) return null;
      const key = personaKey as FixtureKey;
      const fixture = FIXTURES[key];
      const steps = buildReplaySteps(fixture, key);
      const headers = fixture.headers.paymentRequiredHeader && fixture.headers.paymentSignatureHeader
        ? { paymentRequiredHeader: fixture.headers.paymentRequiredHeader, paymentSignatureHeader: fixture.headers.paymentSignatureHeader }
        : null;
      return { steps, headers };
    },
  };
}

interface Decision {
  deterministic: DeterministicDecision | null;
  ai: AiAdvisory | null;
}

/**
 * Mirrors app/console/page.tsx's own deriveDecision exactly (kept in sync by
 * hand, same convention as lib/events.ts/lib/types.ts's own "duplicated, not
 * imported across a page boundary" notes) -- pulls the decision-layer fields
 * off the most recent "pending" event that carries them. All three fixtures
 * captured here have that data live (no Postgres-fallback merge needed), so
 * this is the only derivation replay needs.
 */
export function deriveDecisionFromFixture(events: FiatEvent[]): Decision {
  const decisionEvent = [...events].reverse().find(event => event.state === "pending" && event.aiRecommendation !== undefined);
  if (!decisionEvent) return { deterministic: null, ai: null };

  const deterministic: DeterministicDecision | null =
    decisionEvent.deterministicDecision !== undefined
      ? { allowed: decisionEvent.deterministicDecision === "allowed", reason: decisionEvent.deterministicReason }
      : null;

  const ai: AiAdvisory | null =
    decisionEvent.aiRecommendation !== undefined
      ? {
          recommendation: decisionEvent.aiRecommendation,
          justification: decisionEvent.aiJustification ?? "",
          provider: decisionEvent.aiProvider ?? "",
          semanticMatch: decisionEvent.aiSemanticMatch,
          reasoning: decisionEvent.aiReasoning,
        }
      : null;

  return { deterministic, ai };
}
