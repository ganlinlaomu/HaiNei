
import { 
  SimplePool, 
  getPublicKey, 
  generateSecretKey, 
  finalizeEvent, // v2 推荐使用的签名方法
  verifyEvent,
  nip04 
} from 'nostr-tools';
import { LEGACY_MESSAGE_KIND } from '@/nostr/messaging/protocol';

/**
 * NIP-44 style broadcast group implementation (for kind=8964 messages)
 * import { SimplePool, getEventHash, signEvent, getPublicKey, generatePrivateKey, nip04 } from 'nostr-tools';
 * Key points:
 * - group messages are broadcast (kind=8964) with tag ['g', groupId]
 * - group symmetric key is distributed ONCE to new members using NIP-04 (kind=4 DM)
 * - messages do NOT contain recipient pubkeys or 'p' tags (only key-distribution DMs may include ['p', ...])
 *
 * WARNING: This file handles cryptographic operations, but DOES NOT implement secure local persistence.
 * Persist groupKey securely (WebAuthn / non-exportable keys / PBKDF2-protected storage) in your app.
 */

const RELAYS = [
  // 填入你信任的 relay 列表
  'wss://relay.damus.io',
  'wss://nostr-pub.wellorder.net'
];

const GROUP_TAG = 'g'; // tag used on messages to indicate groupId (['g', groupId])

/* --- WebCrypto helpers (AES-GCM) --- */
const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function importAesKey(rawKey: Uint8Array) {
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function aesGcmEncrypt(plain: string, rawKey: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(rawKey);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  const ivCt = new Uint8Array(iv.byteLength + ct.byteLength);
  ivCt.set(iv, 0);
  ivCt.set(new Uint8Array(ct), iv.byteLength);
  return bytesToBase64(ivCt);
}

async function aesGcmDecrypt(ivCtB64: string, rawKey: Uint8Array) {
  const ivCt = base64ToBytes(ivCtB64);
  const iv = ivCt.slice(0, 12);
  const ct = ivCt.slice(12);
  const key = await importAesKey(rawKey);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return dec.decode(plainBuf);
}

/* --- utility to make unpredictable groupId --- */
function randomHex(len = 16) {
  const a = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}
function makeGroupId(ownerPub: string) {
  // simple unpredictable id: ownerPub + random hex, then base64-encode partially
  return `${ownerPub}-${randomHex(12)}`;
}

/* --- NostrService --- */
export class NostrService {
  pool: SimplePool;
  subs: Record<string, any> = {};

  constructor() {
    this.pool = new SimplePool();
  }

  connect() {
    console.info('NostrService ready. Relays:', RELAYS);
  }

  /**
   * createGroup
   * - ownerPrivKey: hex string
   * - groupName: optional name (stored in group-meta event content)
   * - memberPubkeys: pubkeys to invite (string[])
   *
   * Returns: { groupId, groupKeyB64, metaEvent }
   *
   * Side-effects:
   * - publishes optional group meta event (kind=8964, tags: ['g', groupId], content includes public meta)
   * - sends one-time kind=4 DMs to memberPubkeys containing the encrypted groupKey (nip04.encrypt)
   *
   * NOTE: DM may include ['p', memberPub] tag to allow relays to deliver quickly. This tag exists ONLY
   * for one-time distribution. If you strictly forbid any recipient tags, perform out-of-band distribution instead.
   */
  async createGroup(opts: { ownerPrivKey: string; groupName?: string; memberPubkeys?: string[] }) {
    const { ownerPrivKey, groupName = '', memberPubkeys = [] } = opts;
    const ownerPub = getPublicKey(ownerPrivKey);
    const groupId = makeGroupId(ownerPub);

    // generate 32-byte group key
    const keyRaw = crypto.getRandomValues(new Uint8Array(32));
    const groupKeyB64 = bytesToBase64(keyRaw);

    // publish optional group-meta event (public metadata without members)
    const metaEvt: any = {
      kind: LEGACY_MESSAGE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [[GROUP_TAG, groupId], ['name', groupName]],
      content: JSON.stringify({ type: 'group-meta', groupId, name: groupName, owner: ownerPub }),
      pubkey: ownerPub
    };
    metaEvt.id = getEventHash(metaEvt);
    metaEvt.sig = await signEvent(metaEvt, ownerPrivKey);
    // publish meta event
    const mProms = this.pool.publish(RELAYS, metaEvt);
    await Promise.all(mProms.map((p: Promise<any>) => p.catch((e: any) => e)));

    // distribute group key once per member via NIP-04 DM (kind=4)
    for (const member of memberPubkeys) {
      try {
        const payload = JSON.stringify({ type: 'group-key', groupId, groupKey: groupKeyB64, from: ownerPub });
        const encPayload = await nip04.encrypt(ownerPrivKey, member, payload);
        const dmEvt: any = {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          // This ['p', member] tag helps relays deliver DM quickly; optional if you can't accept recipient tags
          tags: [['p', member], [GROUP_TAG, groupId]],
          content: encPayload,
          pubkey: ownerPub
        };
        dmEvt.id = getEventHash(dmEvt);
        dmEvt.sig = await signEvent(dmEvt, ownerPrivKey);
        const r = this.pool.publish(RELAYS, dmEvt);
        await Promise.all(r.map((p: Promise<any>) => p.catch((e: any) => e)));
      } catch (e) {
        console.warn('distribute group key to', member, 'failed', e);
      }
    }

    return { groupId, groupKeyB64, metaEvt };
  }

  /**
   * inviteMember
   * - ownerPrivKey: hex
   * - groupId: string
   * - memberPub: string
   *
   * Sends one-time encrypted DM with groupKey (caller must retrieve groupKey locally).
   * This function does not fetch stored groupKey; caller must pass it in.
   */
  async inviteMember(opts: { ownerPrivKey: string; groupId: string; memberPub: string; groupKeyB64: string }) {
    const { ownerPrivKey, groupId, memberPub, groupKeyB64 } = opts;
    const ownerPub = getPublicKey(ownerPrivKey);

    const payload = JSON.stringify({ type: 'group-key', groupId, groupKey: groupKeyB64, from: ownerPub });
    const encPayload = await nip04.encrypt(ownerPrivKey, memberPub, payload);
    const dmEvt: any = {
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', memberPub], [GROUP_TAG, groupId]],
      content: encPayload,
      pubkey: ownerPub
    };
    dmEvt.id = getEventHash(dmEvt);
    dmEvt.sig = await signEvent(dmEvt, ownerPrivKey);
    const r = this.pool.publish(RELAYS, dmEvt);
    await Promise.all(r.map((p: Promise<any>) => p.catch((e: any) => e)));
    return dmEvt;
  }

  /**
   * publishGroupMessage
   * - groupId: string
   * - groupKeyB64: base64 of 32-byte key (caller must have it locally)
   * - content: plaintext string
   * - privateKey: sender's private key
   * - kind: default 8964
   *
   * Publishes a broadcast event (no recipient pubkeys, only ['g', groupId] tag)
   */
  async publishGroupMessage(opts: { groupId: string; groupKeyB64: string; content: string; privateKey?: string; kind?: number }) {
    const { groupId, groupKeyB64, content, privateKey, kind = LEGACY_MESSAGE_KIND } = opts;
    const sk = privateKey || generatePrivateKey();
    const pub = getPublicKey(sk);
    const keyRaw = base64ToBytes(groupKeyB64);

    const encryptedContent = await aesGcmEncrypt(content, keyRaw);

    const evt: any = {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags: [[GROUP_TAG, groupId]],
      content: encryptedContent,
      pubkey: pub
    };
    evt.id = getEventHash(evt);
    evt.sig = await signEvent(evt, sk);
    const res = this.pool.publish(RELAYS, evt);
    await Promise.all(res.map((p: Promise<any>) => p.catch((e: any) => e)));
    return evt;
  }

  /**
   * subscribeGroup
   * - groupId: string
   * - authors?: string[] (strongly recommended to reduce relay load; e.g., owner or member pubkeys)
   * - onEvent: callback(evt)
   */
  subscribeGroup(options: { groupId: string; authors?: string[]; onEvent: (evt: any) => void }) {
    const subId = Math.random().toString(36).slice(2, 9);
    const filters: any = { kinds: [LEGACY_MESSAGE_KIND], '#g': [options.groupId] };
    if (options.authors && options.authors.length) filters.authors = options.authors;
    const s = this.pool.sub(RELAYS, [filters]);
    s.on('event', (evt: any) => {
      options.onEvent(evt);
    });
    this.subs[subId] = s;
    return subId;
  }

  unsub(subId: string) {
    const s = this.subs[subId];
    if (s) {
      s.unsub();
      delete this.subs[subId];
    }
  }

  /**
   * tryDecryptGroupEvent
   * - evt: event (kind=8964 with ['g', groupId])
   * - groupKeyB64: base64 group key stored locally
   * Returns decrypted plaintext or null on failure
   */
  async tryDecryptGroupEvent(evt: any, groupKeyB64: string) {
    if (!evt || !evt.content) return null;
    try {
      const keyRaw = base64ToBytes(groupKeyB64);
      const plain = await aesGcmDecrypt(evt.content, keyRaw);
      return plain;
    } catch (e) {
      // decryption failed
      return null;
    }
  }

  /**
   * handleIncomingDirectForGroupKey
   * - evt: incoming kind=4 event
   * - myPrivKey: hex
   *
   * If DM contains { type: 'group-key', groupId, groupKey }, returns object; else null.
   * Caller should persist returned groupKey securely.
   */
  async handleIncomingDirectForGroupKey(evt: any, myPrivKey: string) {
    if (!evt || evt.kind !== 4 || !evt.content) return null;
    try {
      const plain = await nip04.decrypt(myPrivKey, evt.pubkey, evt.content);
      const obj = JSON.parse(plain);
      if (obj && obj.type === 'group-key' && obj.groupId && obj.groupKey) {
        return { groupId: obj.groupId, groupKeyB64: obj.groupKey, from: obj.from || evt.pubkey };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * rotateGroupKey
   * - ownerPrivKey: hex
   * - groupId: string
   * - newMemberList: string[] (pubkeys of remaining members)
   * - oldGroupKeyB64: string (optional, for re-encrypting history if desired)
   *
   * Generates a new group key, publishes a group-rotate meta event, and distributes new key to members via NIP-04 DMs.
   * Caller should persist the new key locally when owner invokes it.
   */
  async rotateGroupKey(opts: { ownerPrivKey: string; groupId: string; newMemberList: string[]; rotateReason?: string }) {
    const { ownerPrivKey, groupId, newMemberList, rotateReason = '' } = opts;
    const ownerPub = getPublicKey(ownerPrivKey);
    const newKeyRaw = crypto.getRandomValues(new Uint8Array(32));
    const newKeyB64 = bytesToBase64(newKeyRaw);

    // publish a group-rotate meta event so clients can know a rotation occurred (meta does not include key)
    const meta: any = {
      kind: LEGACY_MESSAGE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [[GROUP_TAG, groupId], ['rotated', String(Date.now())]],
      content: JSON.stringify({ type: 'group-rotate', groupId, reason: rotateReason, owner: ownerPub }),
      pubkey: ownerPub
    };
    meta.id = getEventHash(meta);
    meta.sig = await signEvent(meta, ownerPrivKey);
    const metaProms = this.pool.publish(RELAYS, meta);
    await Promise.all(metaProms.map((p: Promise<any>) => p.catch((e: any) => e)));

    // distribute new key to newMemberList
    for (const member of newMemberList) {
      try {
        const payload = JSON.stringify({ type: 'group-key', groupId, groupKey: newKeyB64, from: ownerPub });
        const encPayload = await nip04.encrypt(ownerPrivKey, member, payload);
        const dmEvt: any = {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', member], [GROUP_TAG, groupId], ['rotate', '1']],
          content: encPayload,
          pubkey: ownerPub
        };
        dmEvt.id = getEventHash(dmEvt);
        dmEvt.sig = await signEvent(dmEvt, ownerPrivKey);
        const r = this.pool.publish(RELAYS, dmEvt);
        await Promise.all(r.map((p: Promise<any>) => p.catch((e: any) => e)));
      } catch (e) {
        console.warn('rotate: distribute to', member, 'failed', e);
      }
    }

    return { groupId, newKeyB64 };
  }
}
