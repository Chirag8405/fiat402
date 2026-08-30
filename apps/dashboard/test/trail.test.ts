import { describe, it, expect } from "vitest";
import { reconstructTrail, trailsEqual, type RequestTrail } from "../lib/trail";
import type { FiatEvent } from "../lib/types";

function buildEvent(overrides: Partial<FiatEvent> = {}): FiatEvent {
  return {
    requestId: "req_1",
    state: "pending",
    previousState: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    meta: { paymentLinkId: null, razorpayPaymentId: null, reason: null },
    ...overrides,
  };
}

describe("reconstructTrail", () => {
  it("returns null for an empty events list", () => {
    expect(reconstructTrail([])).toBeNull();
  });

  it("picks the most recently active requestId -- the last entry in the sorted-ascending list", () => {
    const events = [
      buildEvent({ requestId: "req_old", state: "settled", timestamp: "2026-01-01T00:00:00.000Z" }),
      buildEvent({ requestId: "req_new", state: "pending", timestamp: "2026-01-01T00:00:05.000Z" }),
    ];
    const trail = reconstructTrail(events);
    expect(trail?.requestId).toBe("req_new");
  });

  it("filters out other requests' events entirely, not just deprioritizes them", () => {
    const events = [
      buildEvent({ requestId: "req_old", state: "pending", timestamp: "2026-01-01T00:00:00.000Z" }),
      buildEvent({ requestId: "req_old", state: "settled", timestamp: "2026-01-01T00:00:01.000Z" }),
      buildEvent({ requestId: "req_new", state: "pending", timestamp: "2026-01-01T00:00:05.000Z" }),
    ];
    const trail = reconstructTrail(events);
    expect(trail?.events).toEqual([events[2]]);
  });

  it("dedupes by (requestId, state), keeping the first occurrence", () => {
    // The UPI retry case: approved -> declined -> approved again for the
    // same requestId. Dedup collapses this to one "approved" entry (the
    // first) -- an accepted, documented tradeoff, not a bug.
    const first = buildEvent({ state: "pending", timestamp: "2026-01-01T00:00:00.000Z" });
    const approved1 = buildEvent({ state: "approved", timestamp: "2026-01-01T00:00:01.000Z" });
    const declined = buildEvent({ state: "declined", timestamp: "2026-01-01T00:00:02.000Z" });
    const approved2 = buildEvent({ state: "approved", timestamp: "2026-01-01T00:00:03.000Z" });
    const trail = reconstructTrail([first, approved1, declined, approved2]);
    expect(trail?.events).toEqual([first, approved1, declined]);
  });

  it("does not collapse consecutive-in-source but distinct real states", () => {
    const events = [
      buildEvent({ state: "pending", timestamp: "2026-01-01T00:00:00.000Z" }),
      buildEvent({ state: "approved", timestamp: "2026-01-01T00:00:01.000Z" }),
      buildEvent({ state: "settled", timestamp: "2026-01-01T00:00:02.000Z" }),
    ];
    expect(reconstructTrail(events)?.events).toEqual(events);
  });
});

describe("trailsEqual", () => {
  const base: RequestTrail = {
    requestId: "req_1",
    events: [buildEvent({ state: "pending" }), buildEvent({ state: "approved", timestamp: "2026-01-01T00:00:01.000Z" })],
  };

  it("is true for the same reference", () => {
    expect(trailsEqual(base, base)).toBe(true);
  });

  it("is true for null vs null", () => {
    expect(trailsEqual(null, null)).toBe(true);
  });

  it("is false when one side is null and the other isn't", () => {
    expect(trailsEqual(null, base)).toBe(false);
    expect(trailsEqual(base, null)).toBe(false);
  });

  it("is true for a freshly-reconstructed but data-identical trail -- the reference-stability guarantee page.tsx relies on", () => {
    const rebuilt: RequestTrail = {
      requestId: "req_1",
      events: [buildEvent({ state: "pending" }), buildEvent({ state: "approved", timestamp: "2026-01-01T00:00:01.000Z" })],
    };
    expect(trailsEqual(base, rebuilt)).toBe(true);
  });

  it("is false when a new state has actually arrived", () => {
    const withNewState: RequestTrail = {
      requestId: "req_1",
      events: [...base.events, buildEvent({ state: "settled", timestamp: "2026-01-01T00:00:02.000Z" })],
    };
    expect(trailsEqual(base, withNewState)).toBe(false);
  });

  it("is false when the requestId differs", () => {
    expect(trailsEqual(base, { requestId: "req_2", events: base.events })).toBe(false);
  });
});
