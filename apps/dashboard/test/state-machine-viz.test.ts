import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  distinctStateSequence,
  enqueueNewStates,
  advanceQueue,
  type QueueState,
} from "../components/StateMachineViz";
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

describe("distinctStateSequence", () => {
  it("collapses consecutive duplicate states into one", () => {
    const events = [
      buildEvent({ state: "pending" }),
      buildEvent({ state: "pending" }),
      buildEvent({ state: "approved" }),
    ];
    expect(distinctStateSequence(events, "req_1")).toEqual(["pending", "approved"]);
  });

  it("skips and warns on an unrecognized state without breaking the sequence", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = [
      buildEvent({ state: "pending" }),
      buildEvent({ state: "made-up-state" as FiatEvent["state"] }),
      buildEvent({ state: "approved" }),
    ];
    expect(distinctStateSequence(events, "req_1")).toEqual(["pending", "approved"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

describe("enqueueNewStates", () => {
  it("starts a fresh queue for a brand new request: first state shown immediately, rest queued", () => {
    const events = [buildEvent({ state: "pending" }), buildEvent({ state: "approved" }), buildEvent({ state: "settled" })];
    const result = enqueueNewStates(null, events);
    expect(result).toEqual({ requestId: "req_1", displayed: ["pending"], pending: ["approved", "settled"] });
  });

  it("appends only the new tail when more events arrive for the same request", () => {
    const prev: QueueState = { requestId: "req_1", displayed: ["pending"], pending: [] };
    const events = [buildEvent({ state: "pending" }), buildEvent({ state: "approved" }), buildEvent({ state: "settled" })];
    const result = enqueueNewStates(prev, events);
    expect(result).toEqual({ requestId: "req_1", displayed: ["pending"], pending: ["approved", "settled"] });
  });

  it("is a no-op when the events array carries nothing beyond what's already displayed/queued", () => {
    const prev: QueueState = { requestId: "req_1", displayed: ["pending", "approved"], pending: [] };
    const events = [buildEvent({ state: "pending" }), buildEvent({ state: "approved" })];
    expect(enqueueNewStates(prev, events)).toBe(prev);
  });

  it("discards the previous request's queue when a different requestId arrives, rather than mixing trails", () => {
    const prev: QueueState = { requestId: "req_old", displayed: ["pending", "approved", "settled"], pending: [] };
    const events = [buildEvent({ requestId: "req_new", state: "pending" })];
    expect(enqueueNewStates(prev, events)).toEqual({ requestId: "req_new", displayed: ["pending"], pending: [] });
  });

  it("returns prev unchanged when events is empty", () => {
    const prev: QueueState = { requestId: "req_1", displayed: ["pending"], pending: [] };
    expect(enqueueNewStates(prev, [])).toBe(prev);
  });
});

describe("advanceQueue", () => {
  it("pops exactly one state off pending onto the end of displayed", () => {
    const prev: QueueState = { requestId: "req_1", displayed: ["pending"], pending: ["approved", "settled"] };
    expect(advanceQueue(prev)).toEqual({ requestId: "req_1", displayed: ["pending", "approved"], pending: ["settled"] });
  });

  it("is a no-op when pending is already empty", () => {
    const prev: QueueState = { requestId: "req_1", displayed: ["pending", "approved", "settled"], pending: [] };
    expect(advanceQueue(prev)).toBe(prev);
  });
});

describe("rapid-fire integration: pending, approved, settled all arriving in the same batch", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("plays through all three states in order across successive advances, never skipping straight to the terminal state", () => {
    // Simulates the exact bug scenario: a single poll batch (or page.tsx's
    // `events` prop update) carries the full pending->approved->settled
    // trail at once, the way a fast payment resolves. Each `advanceQueue`
    // call stands in for one MIN_VISIBLE_MS tick of the component's pacing
    // effect (see StateMachineViz.tsx) -- this is the queueing algorithm
    // that guarantees each intermediate state gets its own visible moment,
    // decoupled from real timer/DOM machinery this package has no harness for.
    const events = [buildEvent({ state: "pending" }), buildEvent({ state: "approved" }), buildEvent({ state: "settled" })];

    let queue = enqueueNewStates(null, events);
    expect(queue?.displayed).toEqual(["pending"]);
    expect(queue?.pending).toEqual(["approved", "settled"]);

    queue = advanceQueue(queue!);
    expect(queue.displayed).toEqual(["pending", "approved"]);
    expect(queue.pending).toEqual(["settled"]);

    queue = advanceQueue(queue);
    expect(queue.displayed).toEqual(["pending", "approved", "settled"]);
    expect(queue.pending).toEqual([]);

    // Further advances are no-ops -- the journey played out fully, in order.
    expect(advanceQueue(queue)).toBe(queue);
  });

  it("still plays approved before settled even when the terminal event was pushed to the queue first in a differently-ordered batch", () => {
    // enqueueNewStates always walks `events` in trail order (oldest-first,
    // as page.tsx's poll loop appends them) -- this guards against a queue
    // implementation that might otherwise prioritize/deduplicate by state
    // name and accidentally let a terminal state jump the line.
    const events = [buildEvent({ state: "pending" }), buildEvent({ state: "approved" }), buildEvent({ state: "settled" })];
    const queue = enqueueNewStates(null, events);
    expect(queue?.pending[0]).toBe("approved");
    expect(queue?.pending[1]).toBe("settled");
  });
});
