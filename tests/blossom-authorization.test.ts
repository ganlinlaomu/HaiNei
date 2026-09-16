import { describe, expect, it } from "vitest";
import { buildBud11AuthorizationHeader } from "@/utils/blossom";

describe("Blossom BUD-11 authorization", () => {
  it("encodes signed events as unpadded Base64URL and preserves UTF-8", () => {
    const event = {
      kind: 24242,
      content: "上传图片 🌸",
      tags: [["t", "upload"], ["expiration", "2000000000"]],
      pubkey: "a".repeat(64),
      id: "b".repeat(64),
      sig: "c".repeat(128)
    };

    const header = buildBud11AuthorizationHeader(event);
    expect(header).toMatch(/^Nostr [A-Za-z0-9_-]+$/);
    expect(header).not.toContain("=");

    const encoded = header.slice("Nostr ".length);
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    expect(JSON.parse(decoded)).toEqual(event);
  });
});
