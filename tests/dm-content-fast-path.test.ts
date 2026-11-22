import { describe, expect, it } from "vitest";
import { parsePrivateAudioMessage, parsePrivateVideoMessage } from "@/nostr/messaging/privateMedia";
import { decodeDmReceiptPayload, isDmReceiptPayload } from "@/nostr/messaging/dmReceipts";
import { decodeBurnControlPayload } from "@/nostr/messaging/dmBurnControl";
import { isCallPayload } from "@/nostr/messaging/callControl";

const plain = ["你好", "", "   ", "[1,2]", "\"just a string\"", "42", "null", "{broken json"];

describe("content parsers skip plain text without JSON.parse", () => {
  it("returns no match for plain text and non-object JSON", () => {
    for (const content of plain) {
      expect(parsePrivateAudioMessage(content)).toBeNull();
      expect(parsePrivateVideoMessage(content)).toBeNull();
      expect(decodeDmReceiptPayload(content)).toBeNull();
      expect(decodeBurnControlPayload(content)).toBeNull();
      expect(isCallPayload(content)).toBe(false);
    }
  });

  it("still accepts a JSON object with leading whitespace, as JSON.parse does", () => {
    const receipt = JSON.stringify({ type: "hainei-dm-receipt", status: "read", upTo: { createdAt: 1_800_000_000, messageId: "b".repeat(64) } });
    expect(isDmReceiptPayload(receipt)).toBe(true);
    expect(isDmReceiptPayload(`  \n${receipt}`)).toBe(true);
    const burn = JSON.stringify({ type: "hainei-dm-burn", messageId: "a".repeat(64) });
    expect(decodeBurnControlPayload(burn)).toBe("a".repeat(64));
    expect(decodeBurnControlPayload(`\t${burn}`)).toBe("a".repeat(64));
  });
});
