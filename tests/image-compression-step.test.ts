import { describe, expect, it } from "vitest";
import { nextCompressionStep } from "@/utils/imageCompression";

describe("nextCompressionStep", () => {
  const target = 250 * 1024;

  it("lowers quality first when the result is only a little too large", () => {
    expect(nextCompressionStep({ quality: 0.82, scale: 1 }, 300 * 1024, target, 0.1))
      .toEqual({ quality: expect.closeTo(0.72, 5), scale: 1 });
  });

  it("scales the area toward the target in one step when far too large", () => {
    const next = nextCompressionStep({ quality: 0.82, scale: 1 }, 1000 * 1024, target, 0.1);
    // sqrt(250/1000) * 1.05 ≈ 0.525
    expect(next.scale).toBeGreaterThan(0.5);
    expect(next.scale).toBeLessThan(0.55);
    expect(next.quality).toBeCloseTo(0.77, 5);
  });

  it("always shrinks and never goes below the minimum scale or quality", () => {
    let step = { quality: 0.82, scale: 1 };
    for (let i = 0; i < 20; i++) {
      const next = nextCompressionStep(step, 5_000 * 1024, target, 0.2);
      expect(next.scale <= step.scale && next.quality <= step.quality).toBe(true);
      step = next;
    }
    expect(step.scale).toBe(0.2);
    expect(step.quality).toBe(0.6);
  });
});
