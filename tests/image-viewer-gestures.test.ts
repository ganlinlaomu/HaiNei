import { describe, expect, it } from "vitest";
import {
  resetViewerTransform,
  shouldCloseViewer,
  swipeImageDirection
} from "@/utils/imageViewerGestures";

describe("ImageViewer gestures", () => {
  it("resets zoom and pan when the image changes", () => {
    expect(resetViewerTransform()).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("disables image swiping while zoomed", () => {
    expect(swipeImageDirection(2, -120, 4)).toBe(0);
    expect(swipeImageDirection(1, -120, 4)).toBe(1);
  });

  it("only closes on a downward gesture while not zoomed", () => {
    expect(shouldCloseViewer(1, 5, 100)).toBe(true);
    expect(shouldCloseViewer(2, 5, 100)).toBe(false);
    expect(shouldCloseViewer(1, 5, -100)).toBe(false);
  });
});
