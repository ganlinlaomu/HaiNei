import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  decodeEncryptedFileRef, dmFileBadge, encodeEncryptedFileRef, formatDmFileSize, MAX_DM_FILE_BYTES,
  parsePrivateFileMessage, sanitizeDmFileName, serializePrivateFileMessage,
} from "@/nostr/messaging/privateFile";
import { directMessagePreview } from "@/nostr/messaging/directMessages";
import { bytesToBase64 } from "@/nostr/crypto";

const key = bytesToBase64(new Uint8Array(32).fill(7));
const iv = bytesToBase64(new Uint8Array(12).fill(3));
const ref = encodeEncryptedFileRef({ v: 1, url: "https://media.example/abc", mime: "application/pdf", alg: "AES-GCM", iv, key, size: 2048 });
const media = { encryptedRef: ref, name: "报价单.pdf", mime: "application/pdf", size: 2048 };

describe("private file messages", () => {
  it("round-trips and previews with the file name", () => {
    const content = serializePrivateFileMessage(media);
    expect(parsePrivateFileMessage(content)).toEqual({ type: "file", media });
    expect(directMessagePreview(content)).toBe("[文件] 报价单.pdf");
  });

  it("rejects refs a peer should not be able to send", () => {
    const parse = (value: unknown) => parsePrivateFileMessage(JSON.stringify({ type: "file", media: value }));
    expect(parse({ ...media, encryptedRef: "blossom+aesgcm+video:abc" })).toBeNull();
    expect(parse({ ...media, size: MAX_DM_FILE_BYTES + 1 })).toBeNull();
    expect(parse({ ...media, extra: 1 })).toBeNull();
    const insecure = encodeEncryptedFileRef({ v: 1, url: "http://media.example/abc", mime: "application/pdf", alg: "AES-GCM", iv, key, size: 1 });
    expect(decodeEncryptedFileRef(insecure)).toBeNull();
    const badKey = encodeEncryptedFileRef({ v: 1, url: "https://media.example/abc", mime: "application/pdf", alg: "AES-GCM", iv, key: "short", size: 1 });
    expect(decodeEncryptedFileRef(badKey)).toBeNull();
    expect(parsePrivateFileMessage("普通文字")).toBeNull();
  });

  it("strips paths and direction overrides from names and normalizes MIME", () => {
    expect(sanitizeDmFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeDmFileName("invoice‮fdp.exe")).toBe("invoicefdp.exe");
    expect(sanitizeDmFileName("")).toBe("文件");
    const long = sanitizeDmFileName(`${"长".repeat(200)}.docx`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith(".docx")).toBe(true);
    const parsed = parsePrivateFileMessage(JSON.stringify({ type: "file", media: { ...media, name: "a/b.txt", mime: "not a mime" } }));
    expect(parsed?.media).toMatchObject({ name: "b.txt", mime: "application/octet-stream" });
  });

  it("formats sizes and badges", () => {
    expect(formatDmFileSize(512)).toBe("512 B");
    expect(formatDmFileSize(1536)).toBe("1.5 KB");
    expect(formatDmFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(dmFileBadge("a.pdf", "application/pdf")).toBe("PDF");
    expect(dmFileBadge("README", "text/plain")).toBe("TEXT");
    expect(dmFileBadge("blob", "application/zip")).toBe("FILE");
  });

  it("downloads as octet-stream so a file can never render inside the app origin", () => {
    const source = readFileSync("src/utils/encryptedDmFile.ts", "utf8");
    expect(source).toContain('new Blob([file], { type: "application/octet-stream" })');
    expect(source).toContain("anchor.download = file.name");
  });

  it("seals file names and prepared bytes in the local vault", () => {
    const vault = readFileSync("src/services/localVault.ts", "utf8");
    expect(vault).toMatch(/"preparedFile",\s*"fileName"/);
  });
});
