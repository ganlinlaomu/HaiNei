import { sha256 } from "@noble/hashes/sha256";
import type { NearbyOffer } from "./nearbyTransfer";

/** Bound temporary buffers; completed files still live in memory until removed. */
export const NEARBY_CHUNK_BYTES = 256 * 1024;
export const chunkDigest = (data: Uint8Array) => Array.from(sha256(data), b => b.toString(16).padStart(2, "0")).join("");
export const hashHex = (hash: ReturnType<typeof sha256.create>) => Array.from(hash.digest(), b => b.toString(16).padStart(2, "0")).join("");
export type ChunkMeta = { id: string; index: number; offset: number; hash: string };
export type TransferControl = { id: string; op: "status" | "finish" | "complete" | "cancel"; index?: number; hash?: string };
type Part = { offset: number; chunks: Blob[]; hash: ReturnType<typeof sha256.create>; digest?: string };
type Batch = { offer: NearbyOffer; parts: Part[]; canceled: boolean };

/** Receiver-owned offsets are authoritative. Replaying an acknowledged chunk is harmless. */
export class NearbyChunkReceiver {
  private batches = new Map<string, Batch>();
  constructor(private onFile: (id: string, index: number, file: File) => void) {}
  private key(peer: string, id: string) { return `${peer}:${id}`; }
  private get(peer: string, id: string) { return this.batches.get(this.key(peer, id)); }
  has(offer: NearbyOffer) {
    const batch = this.get(offer.from, offer.id);
    return !!batch && !batch.canceled && JSON.stringify(batch.offer) === JSON.stringify(offer);
  }
  known(peer: string, id: string) { return this.batches.has(this.key(peer, id)); }
  fileSize(peer: string, id: string, index: number) { return this.get(peer, id)?.offer.files[index]?.size || 1; }
  begin(offer: NearbyOffer) {
    this.batches.set(this.key(offer.from, offer.id), { offer, canceled: false,
      parts: offer.files.map(() => ({ offset: 0, chunks: [], hash: sha256.create() })) });
  }
  allows(peer: string, meta: ChunkMeta, bytes: number) {
    const batch = this.get(peer, meta?.id);
    const part = batch?.parts[meta?.index];
    const file = batch?.offer.files[meta?.index];
    return !!batch && !batch.canceled && !!part && !part.digest && !!file
      && Number.isInteger(meta.index) && Number.isSafeInteger(meta.offset) && meta.offset >= 0
      && meta.offset <= part.offset && /^[0-9a-f]{64}$/.test(meta.hash)
      && bytes > 0 && bytes <= NEARBY_CHUNK_BYTES && meta.offset + bytes <= file.size;
  }
  async receive(peer: string, meta: ChunkMeta, data: ArrayBuffer | Blob) {
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
    if (!this.allows(peer, meta, bytes.byteLength) || chunkDigest(bytes) !== meta.hash) throw new Error("nearby_invalid_chunk");
    const part = this.get(peer, meta.id)!.parts[meta.index];
    if (meta.offset === part.offset) {
      part.hash.update(bytes);
      part.chunks.push(new Blob([bytes]));
      part.offset += bytes.byteLength;
    }
    return part.offset;
  }
  control(peer: string, value: TransferControl): number | boolean {
    const batch = this.get(peer, value?.id);
    if (!batch || (batch.canceled && value.op !== "cancel")) throw new Error("nearby_unknown_transfer");
    if (value.op === "cancel") {
      batch.canceled = true;
      batch.parts.forEach(part => { part.chunks = []; part.hash.destroy(); });
      return true;
    }
    if (value.op === "complete") return batch.parts.every(part => !!part.digest);
    const part = Number.isInteger(value.index) ? batch.parts[value.index!] : undefined;
    const file = batch.offer.files[value.index!];
    if (!part || !file) throw new Error("nearby_invalid_index");
    if (value.op === "status") return part.offset;
    if (value.op !== "finish" || !/^[0-9a-f]{64}$/.test(value.hash || "") || part.offset !== file.size) return false;
    if (part.digest) return part.digest === value.hash;
    const digest = hashHex(part.hash);
    if (digest !== value.hash) {
      part.offset = 0; part.chunks = []; part.hash = sha256.create();
      return false;
    }
    const received = new File(part.chunks, file.name, { type: file.type });
    part.digest = digest;
    part.chunks = [];
    this.onFile(value.id, value.index!, received);
    return true;
  }
  forget(peer: string, id: string) {
    const batch = this.get(peer, id);
    batch?.parts.forEach(part => part.hash.destroy());
    this.batches.delete(this.key(peer, id));
  }
  clear() {
    for (const batch of this.batches.values()) batch.parts.forEach(part => part.hash.destroy());
    this.batches.clear();
  }
}

/** Read one bounded slice at a time, including the prefix when rebuilding a resumed hash. */
export async function sendChunkedFiles(files: File[], io: {
  status: (index: number) => Promise<number>;
  chunk: (data: Blob, meta: Omit<ChunkMeta, "id">) => Promise<number>;
  finish: (index: number, hash: string) => Promise<boolean>;
  complete: () => Promise<boolean>;
  progress: (index: number, fraction: number) => void;
  signal: AbortSignal;
}) {
  for (let index = 0; index < files.length; index++) {
    io.signal.throwIfAborted();
    const file = files[index];
    let offset = await io.status(index);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size || (offset !== file.size && offset % NEARBY_CHUNK_BYTES)) throw new Error("nearby_invalid_offset");
    const hash = sha256.create();
    try {
      io.progress(index, file.size ? offset / file.size : 0);
      for (let start = 0; start < file.size; start += NEARBY_CHUNK_BYTES) {
        io.signal.throwIfAborted();
        const slice = file.slice(start, start + NEARBY_CHUNK_BYTES);
        const bytes = new Uint8Array(await slice.arrayBuffer());
        io.signal.throwIfAborted();
        hash.update(bytes);
        if (start < offset) continue;
        const ack = await io.chunk(slice, { index, offset: start, hash: chunkDigest(bytes) });
        if (ack !== start + bytes.byteLength) throw new Error("nearby_invalid_ack");
        offset = ack;
        io.progress(index, file.size ? offset / file.size : 1);
      }
      io.signal.throwIfAborted();
      if (!await io.finish(index, hashHex(hash))) throw new Error("nearby_checksum_failed");
      io.progress(index, 1);
    } finally { hash.destroy(); }
  }
  io.signal.throwIfAborted();
  if (!await io.complete()) throw new Error("nearby_missing_receipt");
}
