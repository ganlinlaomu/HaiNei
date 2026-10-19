import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransferZip, canShareTransfer } from "@/services/transferBatchSave";

afterEach(() => vi.unstubAllGlobals());

describe("batch save", () => {
  it("stops preparing a batch after its account or page is closed", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(createTransferZip([new File(["a"], "a")], abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("creates a valid UTF-8 ZIP with distinct safe names, CRCs, sizes and directory offsets", async () => {
    const files = [new File(["123456789"], "照片.txt"), new File([""], "照片.txt"), new File(["a"], "../a")];
    const zip = await createTransferZip(files);
    const bytes = new Uint8Array(await zip.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const end = bytes.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(3);
    let central = view.getUint32(end + 16, true);
    const directoryStart = central;
    for (const [index, name] of ["照片.txt", "2-照片.txt", ".._a"].entries()) {
      expect(view.getUint32(central, true)).toBe(0x02014b50);
      const offset = view.getUint32(central + 42, true);
      expect(view.getUint32(offset, true)).toBe(0x04034b50);
      expect(view.getUint16(offset + 6, true)).toBe(0x0800);
      const length = view.getUint16(offset + 26, true);
      expect(new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + length))).toBe(name);
      expect(view.getUint32(offset + 22, true)).toBe(files[index].size);
      if (index === 0) expect(view.getUint32(offset + 14, true)).toBe(0xcbf43926);
      expect(new TextDecoder().decode(bytes.subarray(offset + 30 + length, offset + 30 + length + files[index].size))).toBe(await files[index].text());
      central += 46 + length;
    }
    expect(view.getUint32(end + 12, true)).toBe(central - directoryStart);
  });

  it("checks batch sharing capability and handles unavailable or rejecting browsers", () => {
    const files = [new File(["a"], "a")];
    vi.stubGlobal("navigator", {});
    expect(canShareTransfer(files)).toBe(false);
    const canShare = vi.fn(() => true);
    vi.stubGlobal("navigator", { share: vi.fn(), canShare });
    expect(canShareTransfer(files)).toBe(true);
    expect(canShare).toHaveBeenCalledWith({ files });
    canShare.mockImplementation(() => { throw new Error("unsupported"); });
    expect(canShareTransfer(files)).toBe(false);
  });
});
