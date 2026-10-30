import { describe, expect, it } from "vitest";
import { readPledge } from "./founders";

describe("a pledge remembered in this browser", () => {
  it("reads back what was stored", () => {
    const stored = JSON.stringify({ orderId: "5O190127TN364715T", at: "2026-10-26T10:00:00.000Z" });
    expect(readPledge(stored)).toEqual({ orderId: "5O190127TN364715T", at: "2026-10-26T10:00:00.000Z" });
  });

  it("keeps a valid private receipt without breaking older pledges", () => {
    const receipt = "x".repeat(32);
    const pledge = { orderId: "5O190127TN364715T", at: "2026-10-30", receipt };
    expect(readPledge(JSON.stringify(pledge))).toEqual(pledge);
    for (const invalid of ["../api/me", "", "x".repeat(33), 42]) {
      expect(readPledge(JSON.stringify({ ...pledge, receipt: invalid }))).toEqual({ orderId: pledge.orderId, at: pledge.at });
    }
  });

  it("ignores anything else, so a stranger's storage cannot withdraw some other order", () => {
    for (const stored of [
      null,
      "",
      "not json",
      "null",
      "[]",
      JSON.stringify({ orderId: "5O190127TN364715T" }),
      JSON.stringify({ orderId: 12, at: "2026-10-26" }),
      JSON.stringify({ orderId: "../../api/me", at: "2026-10-26" }),
      JSON.stringify({ orderId: "", at: "2026-10-26" }),
    ]) {
      expect(readPledge(stored)).toBeNull();
    }
  });
});
