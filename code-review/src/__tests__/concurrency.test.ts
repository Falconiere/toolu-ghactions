import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "@/concurrency.js";

// Real async (real timers), no mocks: staggered delays prove ordering + the cap.
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  it("preserves input order despite out-of-order completion", async () => {
    const input = [40, 10, 30, 5, 20]; // longer delays finish later
    const out = await mapWithConcurrency(input, 3, async (n) => {
      await delay(n);
      return n * 2;
    });
    expect(out).toEqual(input.map((n) => n * 2));
  });

  it("never runs more than `limit` calls at once, yet does parallelize", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapWithConcurrency(items, 4, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight--;
      return i;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("passes the index to the mapper", async () => {
    const out = await mapWithConcurrency(["a", "b", "c"], 2, async (item, i) => `${i}:${item}`);
    expect(out).toEqual(["0:a", "1:b", "2:c"]);
  });

  it("returns [] for empty input", async () => {
    expect(await mapWithConcurrency<number, number>([], 4, async (x) => x)).toEqual([]);
  });
});
