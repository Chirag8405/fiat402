import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FiatEvent } from "../lib/types";

/**
 * Mocks ../lib/redis's redisClient so these tests exercise only
 * app/api/events/route.ts's parse/sort logic, not a real Redis instance --
 * same approach as apps/merchant/test/premium-data.test.ts's fetch mock for
 * that package's own external dependency.
 */
const lrangeMock = vi.fn();
vi.mock("../lib/redis", () => ({
  redisClient: { lrange: (...args: unknown[]) => lrangeMock(...args) },
}));

const { GET } = await import("../app/api/events/route");

function buildEvent(overrides: Partial<FiatEvent> = {}): FiatEvent {
  return {
    requestId: "req_1",
    state: "pending",
    previousState: "created",
    timestamp: "2026-01-01T00:00:00.000Z",
    meta: { paymentLinkId: null, razorpayPaymentId: null, reason: null },
    ...overrides,
  };
}

beforeEach(() => {
  lrangeMock.mockReset();
});

describe("GET /api/events", () => {
  it("returns an empty events array when nothing has been buffered yet", async () => {
    lrangeMock.mockResolvedValue([]);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = (await response.json()) as { events: unknown[] };
    expect(body.events).toEqual([]);
  });

  it("returns the full bounded list every call -- no cursor/since param, by design", async () => {
    // No incremental filtering: this route deliberately always returns
    // everything currently in the bounded list (see this route's top-of-file
    // comment on why a cursor-based version could permanently drop events).
    const first = buildEvent({ state: "pending", timestamp: "2026-01-01T00:00:00.000Z" });
    const second = buildEvent({ state: "approved", timestamp: "2026-01-01T00:00:05.000Z" });
    lrangeMock.mockResolvedValue([second, first]);

    const response = await GET();
    const body = (await response.json()) as { events: FiatEvent[] };

    expect(body.events).toEqual([first, second]);
  });

  it("orders events by their own timestamp, not by raw list order -- two concurrent publishers can LPUSH out of chronological order", async () => {
    // Simulates the exact race this fixes: webhook-handler.ts's "approved"
    // transition and server.ts's subsequent "settled" transition are two
    // independent, unsynchronized publish+lpush chains against the same
    // list -- "settled"'s LPUSH can land before "approved"'s own LPUSH
    // completes, even though "approved" has an earlier `timestamp`. The list
    // here is deliberately NOT newest-first (LPUSH order); if this route
    // trusted raw list order instead of sorting by `timestamp`, it would
    // return "settled" before "approved".
    const approved = buildEvent({ state: "approved", timestamp: "2026-01-01T00:00:05.000Z" });
    const settled = buildEvent({ state: "settled", timestamp: "2026-01-01T00:00:06.000Z" });
    lrangeMock.mockResolvedValue([settled, approved]);

    const response = await GET();
    const body = (await response.json()) as { events: FiatEvent[] };

    expect(body.events).toEqual([approved, settled]);
  });

  it("drops malformed list entries rather than erroring", async () => {
    const valid = buildEvent();
    lrangeMock.mockResolvedValue([valid, { not: "a fiat event" }, "not even json {"]);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = (await response.json()) as { events: FiatEvent[] };
    expect(body.events).toEqual([valid]);
  });
});
