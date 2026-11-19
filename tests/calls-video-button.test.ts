import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Calls page video calls", () => {
  const page = readFileSync("src/views/Calls.vue", "utf8");

  it("offers video next to voice on every call record and in the contact picker", () => {
    expect(page).toContain('@click="startCall(item.peer)"');
    expect(page).toContain('@click="startCall(item.peer, true)"');
    expect(page).toContain('@click="startCall(friend.pubkey)"');
    expect(page).toContain('@click="startCall(friend.pubkey, true)"');
    expect(page).toContain("await engine.startCall(peer, video ? { video: true } : undefined);");
  });

  it("labels video call records without the redundant icon text", () => {
    expect(page).toContain("const outcome = item.text.replace(/^📞\\s*(?:语音|视频)通话\\s*(?:·\\s*)?/, \"\").trim();");
    expect(page).toContain("const kind = video ? `${direction} · 视频` : direction;");
  });
});
