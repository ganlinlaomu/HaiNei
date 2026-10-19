/** A stored (uncompressed) ZIP: source Blobs are reused, not copied in memory. */
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

async function crc32(file: Blob, signal?: AbortSignal) {
  let crc = 0xffffffff;
  let scanned = 0;
  const reader = file.stream().getReader();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      for (const byte of value) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
      scanned += value.length;
      if (scanned >= 4 * 1024 * 1024) {
        scanned = 0;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  } finally { reader.releaseLock(); }
  return (crc ^ 0xffffffff) >>> 0;
}

function header(length: number) {
  const bytes = new Uint8Array(length);
  return { bytes, view: new DataView(bytes.buffer) };
}

export async function createTransferZip(files: File[], signal?: AbortSignal) {
  if (!files.length || files.length > 200) throw new Error("invalid_transfer_batch");
  const parts: BlobPart[] = [];
  const directory: BlobPart[] = [];
  const names = new Set<string>();
  let offset = 0;
  let directorySize = 0;
  for (const file of files) {
    const base = file.name.replace(/[\\/\u0000-\u001f]/g, "_") || "文件";
    let name = base;
    for (let suffix = 2; names.has(name); suffix++) name = `${suffix}-${base}`;
    names.add(name);
    const encoded = new TextEncoder().encode(name);
    const crc = await crc32(file, signal);
    const local = header(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true); // UTF-8 filenames
    local.view.setUint16(12, 33, true); // 1980-01-01
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, file.size, true);
    local.view.setUint32(22, file.size, true);
    local.view.setUint16(26, encoded.length, true);
    const central = header(46);
    central.view.setUint32(0, 0x02014b50, true);
    central.view.setUint16(4, 20, true);
    central.bytes.set(local.bytes.subarray(4, 30), 6);
    central.view.setUint32(42, offset, true);
    parts.push(local.bytes, encoded, file);
    directory.push(central.bytes, encoded);
    offset += 30 + encoded.length + file.size;
    directorySize += 46 + encoded.length;
    if (offset + directorySize > 0xffffffff) throw new Error("transfer_zip_too_large");
  }
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, directorySize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end.bytes], { type: "application/zip" });
}

export function canShareTransfer(files: File[]) {
  try {
    return files.length > 0 && typeof navigator.share === "function"
      && typeof navigator.canShare === "function" && navigator.canShare({ files });
  } catch { return false; }
}
