import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FiatEvent } from "../lib/types";

/**
 * Mocks ../lib/redis's redisClient so these tests exercise only
 * app/api/events/route.ts's cursor/filter logic, not a real Redis instance
 * -- same approach as apps/merchant/test/premium-data.test.ts's fetch mock
 * for that package's own external dependency.
 */
const lrangeMock = vi.fn();
vi.mock("../lib/redis", () => ({
  redisClient: { lrange: (...args: unknown[]) => lrangeMock(...args) },
}));

const { GET } = await import("../app/api/events/route");

const EPOCH = new Date(0).toISOString();

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

function requestWithSince(since?: string): Request {
  const url = since ? `http://localhost/api/events?since=${encodeURIComponent(since)}` : "http://localhost/api/events";
  return new Request(url);
}

beforeEach(() => {
  lrangeMock.mockReset();
});

describe("GET /api/events", () => {
  it("returns an empty events array and an epoch cursor when nothing has been buffered yet", async () => {
    lrangeMock.mockResolvedValue([]);

    const response = await GET(requestWithSince());
    expect(response.status).toBe(200);

    const body = (await response.json()) as { events: unknown[]; cursor: string };
    expect(body.events).toEqual([]);
    expect(body.cursor).toBe(EPOCH);
  });

  it("returns only events strictly newer than the given since cursor, oldest first", async () => {
    const older = buildEvent({ state: "created", timestamp: "2026-01-01T00:00:00.000Z" });
    const cursorEvent = buildEvent({ state: "pending", timestamp: "2026-01-01T00:00:05.000Z" });
    const newer = buildEvent({ state: "approved", timestamp: "2026-01-01T00:00:10.000Z" });
    // The underlying Redis list is newest-first (LPUSH order) -- see
    // apps/facilitator/src/ws.ts's publishEvent.
    lrangeMock.mockResolvedValue([newer, cursorEvent, older]);

    const response = await GET(requestWithSince(cursorEvent.timestamp));
    const body = (await response.json()) as { events: FiatEvent[]; cursor: string };

    expect(body.events).toEqual([newer]);
    expect(body.cursor).toBe(newer.timestamp);
  });

  it("treats a malformed since param as no cursor and returns the buffered events instead of erroring", async () => {
    const event = buildEvent();
    lrangeMock.mockResolvedValue([event]);

    const response = await GET(requestWithSince("not-a-real-date"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { events: FiatEvent[]; cursor: string };
    expect(body.events).toEqual([event]);
    expect(body.cursor).toBe(event.timestamp);
  });
});
