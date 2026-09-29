import { describe, expect, it } from "vitest";
import { classifyVoiceGesture } from "../src/utils/voiceGesture";

describe("voice hold gesture", () => {
  it("sends on release when the finger stays near the microphone", () => {
    expect(classifyVoiceGesture(4, -8)).toBe("send");
  });

  it("cancels after a deliberate left swipe", () => {
    expect(classifyVoiceGesture(-80, -12)).toBe("cancel");
  });

  it("locks after a deliberate upward swipe", () => {
    expect(classifyVoiceGesture(-10, -80)).toBe("lock");
  });

  it("does not lock or cancel on diagonal movement without a dominant direction", () => {
    expect(classifyVoiceGesture(-80, -80)).toBe("send");
  });
});
