import { nip44, utils } from "nostr-tools";
import { normalizePubkey } from "./common";

function secretKeyBytes(secretKey: string | Uint8Array): Uint8Array {
  if (secretKey instanceof Uint8Array) return secretKey;
  if (!/^[0-9a-f]{64}$/i.test(secretKey)) throw new Error("invalid nostr private key");
  return utils.hexToBytes(secretKey);
}

export async function encryptDirectMessage(options: {
  senderPrivateKey: string | Uint8Array;
  recipientPubkey: string;
  plaintext: string;
}): Promise<string> {
  const conversationKey = nip44.v2.utils.getConversationKey(
    secretKeyBytes(options.senderPrivateKey),
    normalizePubkey(options.recipientPubkey)
  );
  return nip44.v2.encrypt(options.plaintext, conversationKey);
}

export async function decryptDirectMessage(options: {
  recipientPrivateKey: string | Uint8Array;
  senderPubkey: string;
  ciphertext: string;
}): Promise<string> {
  const conversationKey = nip44.v2.utils.getConversationKey(
    secretKeyBytes(options.recipientPrivateKey),
    normalizePubkey(options.senderPubkey)
  );
  return nip44.v2.decrypt(options.ciphertext, conversationKey);
}
