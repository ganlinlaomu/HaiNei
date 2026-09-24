import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";

export interface HaiNeiRemoteSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
  nip44: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
  disconnect?: () => void;
}

function signerWithRequiredCapabilities(value: unknown): value is HaiNeiRemoteSigner {
  if (!value || typeof value !== "object") return false;
  const signer = value as Partial<HaiNeiRemoteSigner>;
  return typeof signer.getPublicKey === "function"
    && typeof signer.signEvent === "function"
    && typeof signer.nip44?.encrypt === "function"
    && typeof signer.nip44?.decrypt === "function";
}

export async function validatePomegranateSigner(pubkey: string, signer: unknown, expectedPubkey?: string) {
  const normalized = pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error("Google 登录返回了无效公钥");
  if (!signerWithRequiredCapabilities(signer)) {
    throw new Error("Google 签名器缺少签名或 NIP-44 加解密能力");
  }
  const signerPubkey = (await signer.getPublicKey()).toLowerCase();
  if (signerPubkey !== normalized) throw new Error("Google 签名器公钥不匹配");
  if (expectedPubkey && normalized !== expectedPubkey.toLowerCase()) {
    throw new Error("Google 返回的账号与所选账号不匹配");
  }
  return { pubkey: normalized, signer };
}

export async function connectWithPomegranate(expectedPubkey?: string): Promise<{ pubkey: string; signer: HaiNeiRemoteSigner }> {
  const { default: MILL } = await import("nostr-mill");
  return new Promise((resolve, reject) => {
    let completed = false;
    MILL.open({
      methods: ["pomegranate"],
      pomegranate: true,
      appName: "HaiNei",
      onConnected: result => {
        void validatePomegranateSigner(result.pubkey, result.signer, expectedPubkey).then(connection => {
          completed = true;
          resolve(connection);
          MILL.close();
        }, error => {
          completed = true;
          MILL.close();
          reject(error);
        });
      },
      onClose: () => {
        if (!completed) reject(new Error("Google 登录已取消"));
      },
    });
  });
}
