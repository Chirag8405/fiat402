import { describe, expect, it } from "vitest";
import { isPendingHold } from "../lib/confirm-gate";

describe("isPendingHold", () => {
  it("is true when state is pending and AI recommended hold", () => {
    expect(isPendingHold("pending", "hold")).toBe(true);
  });

  it("is false when state is pending but AI approved", () => {
    expect(isPendingHold("pending", "approve")).toBe(false);
  });

  it("is false when AI held but the request already moved past pending", () => {
    expect(isPendingHold("approved", "hold")).toBe(false);
    expect(isPendingHold("settled", "hold")).toBe(false);
    expect(isPendingHold("failed", "hold")).toBe(false);
  });

  it("is false when there is no decision data yet", () => {
    expect(isPendingHold("pending", undefined)).toBe(false);
    expect(isPendingHold("pending", null)).toBe(false);
  });

  it("is false when there is no request at all", () => {
    expect(isPendingHold(null, "hold")).toBe(false);
  });
});
