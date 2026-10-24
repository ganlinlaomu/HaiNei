import { describe, expect, it } from "vitest";
import {
  canBeginVerticalDismissDrag,
  canStartPostEditorDrag,
  shouldDismissPostEditor,
  shouldDismissVerticalSheet,
} from "@/utils/postEditorGesture";

describe("shared vertical sheet dismiss physics", () => {
  it("allows downward movement only when sheet scrolling is at the top", () => {
    expect(canBeginVerticalDismissDrag(0, 24, 0)).toBe(true);
    expect(canBeginVerticalDismissDrag(0, 24, 1)).toBe(false);
    expect(canBeginVerticalDismissDrag(0, -24, 0)).toBe(false);
    expect(canBeginVerticalDismissDrag(20, 8, 0)).toBe(false);
    expect(canBeginVerticalDismissDrag(8, 24, 0)).toBe(true);
    expect(canBeginVerticalDismissDrag(0, 4, 0)).toBe(false);
    expect(canStartPostEditorDrag(0, 12)).toBe(true);
    expect(canStartPostEditorDrag(1, 12)).toBe(false);
  });

  it("rebounds small/slow drags and closes long or fast drags", () => {
    expect(shouldDismissVerticalSheet(40, 0.1, 420)).toBe(false);
    expect(shouldDismissVerticalSheet(110, 0.2, 420)).toBe(true);
    expect(shouldDismissVerticalSheet(38, 0.68, 500)).toBe(true);
    expect(shouldDismissVerticalSheet(38, 0.4, 500)).toBe(false);
    expect(shouldDismissPostEditor(110, 0.2, 420)).toBe(shouldDismissVerticalSheet(110, 0.2, 420));
  });

  it("clamps the dismissal threshold for very short or tall menus", () => {
    expect(shouldDismissVerticalSheet(95, 0, 150)).toBe(false);
    expect(shouldDismissVerticalSheet(96, 0, 150)).toBe(true);
    expect(shouldDismissVerticalSheet(179, 0, 2000)).toBe(false);
    expect(shouldDismissVerticalSheet(180, 0, 2000)).toBe(true);
  });
});
