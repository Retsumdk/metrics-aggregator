import { describe, test, expect } from "bun:test";
describe("metrics-aggregator", () => {
  test("module loads", async () => { const m = await import("../src/index"); expect(m).toBeDefined(); });
});
