import { describe, test, expect } from "bun:test";
describe("metrics-aggregator", () => {
  test("module loads", async () => { const m = await import("./index"); expect(m).toBeDefined(); });
});
