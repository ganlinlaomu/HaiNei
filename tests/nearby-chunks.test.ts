import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { NearbyChunkReceiver, NEARBY_CHUNK_BYTES, chunkDigest, hashHex, sendChunkedFiles } from '@/services/nearbyChunks';
import type { NearbyOffer } from '@/services/nearbyTransfer';

function fixture(size = NEARBY_CHUNK_BYTES * 2 + 7) {
  const bytes = new Uint8Array(size).map((_, i) => i % 251);
  const file = new File([bytes], 'test.bin', { type: 'application/octet-stream' });
  const onFile = vi.fn();
  const receiver = new NearbyChunkReceiver(onFile);
  const offer: NearbyOffer = { id: '0123456789abcdef', from: 'peer', protocol: 2, files: [{ name: file.name, size, type: file.type }] };
  receiver.begin(offer);
  const controller = new AbortController();
  const io = {
    signal: controller.signal, progress: vi.fn(),
    status: vi.fn(async (index: number) => receiver.control('peer', { id: offer.id, op: 'status', index }) as number),
    chunk: vi.fn(async (data: Blob, meta: any) => receiver.receive('peer', { id: offer.id, ...meta }, data)),
    finish: vi.fn(async (index: number, hash: string) => receiver.control('peer', { id: offer.id, op: 'finish', index, hash }) === true),
    complete: vi.fn(async () => receiver.control('peer', { id: offer.id, op: 'complete' }) === true),
  };
  return { bytes, file, receiver, offer, onFile, io, controller };
}

describe('nearby verified chunk transfer', () => {
  it('checks bounded chunks and a whole-file checksum before confirming delivery', async () => {
    const f = fixture();
    await sendChunkedFiles([f.file], f.io);
    expect(f.io.chunk).toHaveBeenCalledTimes(3);
    expect(f.io.chunk.mock.calls.every(([blob]) => blob.size <= NEARBY_CHUNK_BYTES)).toBe(true);
    expect(f.onFile).toHaveBeenCalledOnce();
    expect(new Uint8Array(await f.onFile.mock.calls[0][2].arrayBuffer())).toEqual(f.bytes);
    expect(f.io.complete).toHaveBeenCalledOnce();
    expect(f.io.progress).toHaveBeenLastCalledWith(0, 1);
  });
  it('resumes after a lost chunk acknowledgement without duplicate bytes or duplicate files', async () => {
    const f = fixture();
    const send = f.io.chunk.getMockImplementation()!;
    f.io.chunk.mockImplementationOnce(async (...args) => { await send(...args); throw new Error('disconnected after receiving'); });
    await expect(sendChunkedFiles([f.file], f.io)).rejects.toThrow('disconnected');
    expect(f.onFile).not.toHaveBeenCalled();
    await sendChunkedFiles([f.file], f.io);
    expect(f.io.chunk).toHaveBeenCalledTimes(3);
    expect(f.io.chunk.mock.calls[1][1].offset).toBe(NEARBY_CHUNK_BYTES);
    await sendChunkedFiles([f.file], f.io); // receipt was lost; verify idempotent completion
    expect(f.io.chunk).toHaveBeenCalledTimes(3);
    expect(f.onFile).toHaveBeenCalledOnce();
  });
  it('rejects corrupted, unauthorized and out-of-order chunks and mismatched manifests', async () => {
    const f = fixture(7);
    const meta = { id: f.offer.id, index: 0, offset: 0, hash: chunkDigest(f.bytes) };
    expect(f.receiver.allows('other', meta, 7)).toBe(false);
    expect(f.receiver.allows('peer', { ...meta, offset: 1 }, 7)).toBe(false);
    await expect(f.receiver.receive('peer', { ...meta, hash: '0'.repeat(64) }, f.file)).rejects.toThrow('invalid_chunk');
    expect(f.receiver.has({ ...f.offer, text: 'changed' })).toBe(false);
    expect(f.receiver.control('peer', { id: f.offer.id, op: 'complete' })).toBe(false);
    expect(f.onFile).not.toHaveBeenCalled();
  });
  it('resets a file after whole-file checksum failure and allows a clean retransmission', async () => {
    const f = fixture(7);
    await f.receiver.receive('peer', { id: f.offer.id, index: 0, offset: 0, hash: chunkDigest(f.bytes) }, f.file);
    expect(f.receiver.control('peer', { id: f.offer.id, op: 'finish', index: 0, hash: '0'.repeat(64) })).toBe(false);
    expect(f.receiver.control('peer', { id: f.offer.id, op: 'status', index: 0 })).toBe(0);
    expect(f.onFile).not.toHaveBeenCalled();
    await sendChunkedFiles([f.file], f.io);
    expect(f.onFile).toHaveBeenCalledOnce();
  });
  it('handles empty files and refuses a missing final receipt', async () => {
    const f = fixture(0);
    f.io.complete.mockResolvedValueOnce(false);
    await expect(sendChunkedFiles([f.file], f.io)).rejects.toThrow('missing_receipt');
    expect(f.io.chunk).not.toHaveBeenCalled();
    expect(f.onFile.mock.calls[0][2].size).toBe(0);
    expect(f.io.finish).toHaveBeenCalledWith(0, hashHex(sha256.create()));
  });
  it('stops on cancel, releases partial buffers and refuses late bytes', async () => {
    const f = fixture();
    const send = f.io.chunk.getMockImplementation()!;
    f.io.chunk.mockImplementationOnce(async (...args) => { const result = await send(...args); f.controller.abort(); return result; });
    await expect(sendChunkedFiles([f.file], f.io)).rejects.toMatchObject({ name: 'AbortError' });
    f.receiver.control('peer', { id: f.offer.id, op: 'cancel' });
    expect(f.receiver.has(f.offer)).toBe(false);
    await expect(f.receiver.receive('peer', { id: f.offer.id, index: 0, offset: 0, hash: chunkDigest(f.bytes) }, f.file)).rejects.toThrow('invalid_chunk');
    expect(f.onFile).not.toHaveBeenCalled();
    f.receiver.clear();
    expect(f.receiver.known('peer', f.offer.id)).toBe(false);
  });
  it.each([-1, 1, NaN, NEARBY_CHUNK_BYTES * 4])('rejects invalid resume offset %s', async offset => {
    const f = fixture();
    f.io.status.mockResolvedValueOnce(offset);
    await expect(sendChunkedFiles([f.file], f.io)).rejects.toThrow('invalid_offset');
    expect(f.io.chunk).not.toHaveBeenCalled();
  });
});
