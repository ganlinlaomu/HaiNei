// 统一的对称加密 / 解密工具
const enc = new TextEncoder();
const dec = new TextDecoder();

export function hexToBytes(hex: string) {
  if (hex.length % 2) hex = "0" + hex;
  const len = hex.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
export function base64ToBytes(b64: string) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function genSymHex() {
  const arr = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(arr); // 64 chars hex
}

async function importAesKeyFromHex(symHex: string) {
  const raw = hexToBytes(symHex);
  return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function symEncryptPackage(symHex: string, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKeyFromHex(symHex);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  const ivb = new Uint8Array(iv);
  const ctb = new Uint8Array(ct);
  return {
    iv: bytesToBase64(ivb),
    ct: bytesToBase64(ctb)
  };
}

export async function symDecryptPackage(symHex: string, pkg: { iv: string; ct: string }) {
  const iv = base64ToBytes(pkg.iv);
  const ct = base64ToBytes(pkg.ct);
  const key = await importAesKeyFromHex(symHex);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return dec.decode(plain);
}
