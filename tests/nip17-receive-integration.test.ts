import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, nip59, utils, type EventTemplate, type NostrEvent } from "nostr-tools";
import { HaiNeiDatabase } from "@/db/dexie";
import {
  decryptDirectMessage,
  encryptDirectMessage,
  nip17Adapter,
  type CanonicalMessage
} from "@/nostr/messaging/protocol";
import { createHomeMessageHandler } from "@/nostr/messaging/homeDelivery";
import { MessageSyncManager } from "@/nostr/messaging/sync";
import type { MessageIngestionMetadata } from "@/nostr/messaging/sync/types";
import { SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { logger } from "@/utils/logger";
import { friendshipTags } from "@/nostr/messaging/friendshipControl";

const A_SECRET = utils.hexToBytes("1".padStart(64, "0"));
const B_SECRET = utils.hexToBytes("2".padStart(64, "0"));
const WRONG_SECRET = utils.hexToBytes("3".padStart(64, "0"));
const ACCOUNT_A = getPublicKey(A_SECRET);
const ACCOUNT_B = getPublicKey(B_SECRET);
const RELAYS = ["wss://one.test", "wss://two.test"];
let sequence = 0;
const databases: HaiNeiDatabase[] = [];
const managers: MessageSyncManager[] = [];

type HandlerMap = Record<string, Array<(...args: any[]) => void>>;

class RelayHarness {
  readonly subscriptions: Array<{ relays: string[]; filters: any[]; handlers: HandlerMap }> = [];

  subscribe = (relays: string[], filters: any[]) => {
    const handlers: HandlerMap = {};
    const index = this.subscriptions.push({ relays, filters, handlers }) - 1;
    return {
      on: (name: string, callback: (...args: any[]) => void) => {
        (handlers[name] ||= []).push(callback);
        if (index > 0 && name === "eose") {
          queueMicrotask(() => relays.forEach(relay => callback(relay)));
        }
      },
      unsub() {}
    };
  };

  deliver(event: NostrEvent, relay: string, subscriptionIndex = 0) {
    this.subscriptions[subscriptionIndex].handlers.event?.forEach(handler => handler(event, relay));
  }
}

function database() {
  const value = new HaiNeiDatabase(`nip17-receive-${sequence++}`);
  databases.push(value);
  return value;
}

async function giftWrap(senderSecret: Uint8Array, recipientPubkey: string, plaintext: string, tags?: string[][]) {
  const senderPubkey = getPublicKey(senderSecret);
  const encoded = await nip17Adapter.encode!({
    recipientPubkeys: [recipientPubkey],
    plaintext,
    tags,
    createdAt: 1_700_000_000
  }, {
    senderPubkey,
    nip44Encrypt: (target, value) => encryptDirectMessage({
      senderPrivateKey: senderSecret,
      recipientPubkey: target,
      plaintext: value
    }),
    signEvent: (event: EventTemplate) => Promise.resolve(finalizeEvent(event, senderSecret))
  });
  const recipientWrap = encoded.events.find(event => event.tags[0]?.[1] === recipientPubkey);
  if (!recipientWrap) throw new Error("recipient gift wrap missing");
  return { encoded, recipientWrap };
}

async function startReceiver(options: {
  accountPubkey: string;
  privateKey: Uint8Array;
  repository: SyncedMessageRepository;
  relay: RelayHarness;
  authors?: string[];
  onMessage?: (message: CanonicalMessage, metadata: MessageIngestionMetadata) => void | Promise<void>;
}) {
  const manager = new MessageSyncManager({
    repository: options.repository,
    subscribe: options.relay.subscribe,
    observeRelays: () => () => {},
    now: () => 1_700_000_100_000
  });
  managers.push(manager);
  await manager.start({
    accountPubkey: options.accountPubkey,
    relays: RELAYS,
    authors: options.authors || [],
    decodeContext: {
      accountPubkey: options.accountPubkey,
      nip44Decrypt: (senderPubkey, ciphertext) => decryptDirectMessage({
        recipientPrivateKey: options.privateKey,
        senderPubkey,
        ciphertext
      })
    },
    onMessage: options.onMessage
  });
  return manager;
}

async function waitFor(assertion: () => void | Promise<void>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

afterEach(async () => {
  managers.splice(0).forEach(manager => manager.stop());
  vi.restoreAllMocks();
  const active = databases.splice(0);
  const names = [...new Set(active.map(item => item.name))];
  active.forEach(item => item.close());
  await Promise.all(names.map(name => Dexie.delete(name)));
});

describe("NIP-17 relay to Home receive path", () => {
  it("delivers A -> B through relay, decode, Dexie, Home mirror and notification", async () => {
    const { recipientWrap, encoded } = await giftWrap(A_SECRET, ACCOUNT_B, "hello B");
    const repository = new SyncedMessageRepository(database());
    const relay = new RelayHarness();
    const inbox: CanonicalMessage[] = [];
    const notifications: CanonicalMessage[] = [];
    const handler = createHomeMessageHandler({
      accountPubkey: ACCOUNT_B,
      currentAccount: () => ACCOUNT_B,
      isAcceptedMessage: () => true,
      isInteraction: () => false,
      processInteraction: () => {},
      mirrorMessage: message => inbox.push(message),
      notifyMessage: message => notifications.push(message)
    });
    await startReceiver({ accountPubkey: ACCOUNT_B, privateKey: B_SECRET, repository, relay, onMessage: handler });

    relay.deliver(recipientWrap, RELAYS[0]);
    await waitFor(() => expect(inbox).toHaveLength(1));

    expect(inbox[0]).toMatchObject({
      id: encoded.message.id,
      senderPubkey: ACCOUNT_A,
      plaintext: "hello B",
      protocol: "nip17",
      transportKind: 1059
    });
    expect(inbox[0].recipientPubkeys).toContain(ACCOUNT_B);
    expect(notifications).toHaveLength(1);
    expect(await repository.get(ACCOUNT_B, encoded.message.id)).toBeTruthy();
  });

  it("does not deliver or persist a normal message from an unknown sender", async () => {
    const { recipientWrap } = await giftWrap(A_SECRET, ACCOUNT_B, "blocked unknown message");
    const repository = new SyncedMessageRepository(database());
    const relay = new RelayHarness();
    const inbox: CanonicalMessage[] = [];
    const notifications: CanonicalMessage[] = [];
    const friendsOfB: string[] = [];
    expect(friendsOfB).not.toContain(ACCOUNT_A);
    await startReceiver({
      accountPubkey: ACCOUNT_B,
      privateKey: B_SECRET,
      repository,
      relay,
      authors: friendsOfB,
      onMessage: createHomeMessageHandler({
        accountPubkey: ACCOUNT_B,
        currentAccount: () => ACCOUNT_B,
        isAcceptedMessage: () => false,
        processFriendshipMessage: () => false,
        isInteraction: () => false,
        processInteraction: () => {},
        mirrorMessage: message => inbox.push(message),
        notifyMessage: message => notifications.push(message)
      })
    });

    expect(relay.subscriptions[0].filters).toEqual([
      expect.objectContaining({ kinds: [1059], "#p": [ACCOUNT_B] })
    ]);
    expect(relay.subscriptions[0].filters[0]).not.toHaveProperty("authors");
    relay.deliver(recipientWrap, RELAYS[0]);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(inbox).toEqual([]);
    expect(notifications).toEqual([]);
    expect(await repository.list(ACCOUNT_B)).toEqual([]);
  });

  it("routes a friendship request from an unknown sender without creating a Home message", async () => {
    const payload = JSON.stringify({ type: "friend_request", from: ACCOUNT_A, timestamp: 1_700_000_000 });
    const { recipientWrap } = await giftWrap(A_SECRET, ACCOUNT_B, payload, friendshipTags("request"));
    const repository = new SyncedMessageRepository(database());
    const relay = new RelayHarness();
    const controls: CanonicalMessage[] = [];
    const inbox: CanonicalMessage[] = [];
    await startReceiver({
      accountPubkey: ACCOUNT_B,
      privateKey: B_SECRET,
      repository,
      relay,
      onMessage: createHomeMessageHandler({
        accountPubkey: ACCOUNT_B,
        currentAccount: () => ACCOUNT_B,
        isAcceptedMessage: () => false,
        processFriendshipMessage: message => { controls.push(message); return true; },
        isInteraction: () => false,
        processInteraction: () => {},
        mirrorMessage: message => inbox.push(message),
        notifyMessage: () => {}
      })
    });
    relay.deliver(recipientWrap, RELAYS[0]);
    await waitFor(() => expect(controls).toHaveLength(1));
    expect(inbox).toEqual([]);
    expect(await repository.list(ACCOUNT_B)).toEqual([]);
    await waitFor(async () => expect((await repository.getSyncState(ACCOUNT_B)).highWatermarkCreatedAt).toBe(1_700_000_000));
  });

  it("also delivers the reverse B -> A direction", async () => {
    const { recipientWrap } = await giftWrap(B_SECRET, ACCOUNT_A, "hello A");
    const repository = new SyncedMessageRepository(database());
    const relay = new RelayHarness();
    const received: CanonicalMessage[] = [];
    await startReceiver({
      accountPubkey: ACCOUNT_A,
      privateKey: A_SECRET,
      repository,
      relay,
      authors: [],
      onMessage: createHomeMessageHandler({
        accountPubkey: ACCOUNT_A,
        currentAccount: () => ACCOUNT_A,
        isAcceptedMessage: () => true,
        processFriendshipMessage: () => false,
        isInteraction: () => false,
        processInteraction: () => {},
        mirrorMessage: message => received.push(message),
        notifyMessage: () => {}
      })
    });

    relay.deliver(recipientWrap, RELAYS[1]);
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ senderPubkey: ACCOUNT_B, plaintext: "hello A" });
  });

  it("blocks later inbound messages after friendship removal", async () => {
    const first = await giftWrap(A_SECRET, ACCOUNT_B, "before removal");
    const second = await giftWrap(A_SECRET, ACCOUNT_B, "after removal");
    const repository = new SyncedMessageRepository(database());
    const relay = new RelayHarness();
    const inbox: CanonicalMessage[] = [];
    let accepted = true;
    await startReceiver({
      accountPubkey: ACCOUNT_B,
      privateKey: B_SECRET,
      repository,
      relay,
      onMessage: createHomeMessageHandler({
        accountPubkey: ACCOUNT_B,
        currentAccount: () => ACCOUNT_B,
        isAcceptedMessage: () => accepted,
        processFriendshipMessage: () => false,
        isInteraction: () => false,
        processInteraction: () => {},
        mirrorMessage: message => inbox.push(message),
        notifyMessage: () => {}
      })
    });
    relay.deliver(first.recipientWrap, RELAYS[0]);
    await waitFor(() => expect(inbox).toHaveLength(1));
    accepted = false;
    relay.deliver(second.recipientWrap, RELAYS[0]);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(inbox).toHaveLength(1);
    expect(await repository.list(ACCOUNT_B)).toHaveLength(1);
  });

  it("merges two relay wraps for one rumor and invokes onMessage once", async () => {
    const { recipientWrap, encoded } = await giftWrap(A_SECRET, ACCOUNT_B, "one logical message");
    const sealPlaintext = await decryptDirectMessage({
      recipientPrivateKey: B_SECRET,
      senderPubkey: recipientWrap.pubkey,
      ciphertext: recipientWrap.content
    });
    const secondWrap = nip59.createWrap(JSON.parse(sealPlaintext), ACCOUNT_B);
    expect(secondWrap.id).not.toBe(recipientWrap.id);
    const repository = new SyncedMessageRepository(database());
    const relay = new RelayHarness();
    const received: CanonicalMessage[] = [];
    await startReceiver({
      accountPubkey: ACCOUNT_B,
      privateKey: B_SECRET,
      repository,
      relay,
      onMessage: message => { received.push(message); }
    });

    relay.deliver(recipientWrap, RELAYS[0]);
    await waitFor(() => expect(received).toHaveLength(1));
    relay.deliver(secondWrap, RELAYS[1]);
    await waitFor(async () => {
      expect(received).toHaveLength(1);
      const stored = await repository.get(ACCOUNT_B, encoded.message.id);
      expect(stored?.transportEventIds).toHaveLength(2);
    });
    const stored = await repository.get(ACCOUNT_B, encoded.message.id);
    expect(stored?.transportEventIds.sort()).toEqual([recipientWrap.id, secondWrap.id].sort());
  });

  it("logs the outer-decrypt stage and does not persist when B uses the wrong key", async () => {
    const { recipientWrap } = await giftWrap(A_SECRET, ACCOUNT_B, "wrong key");
    const repository = new SyncedMessageRepository(database());
    const relay = new RelayHarness();
    const received: CanonicalMessage[] = [];
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await startReceiver({
      accountPubkey: ACCOUNT_B,
      privateKey: WRONG_SECRET,
      repository,
      relay,
      onMessage: message => { received.push(message); }
    });

    relay.deliver(recipientWrap, RELAYS[0]);
    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      "[nip17] decode_failed",
      expect.objectContaining({ stage: "outer-decrypt", eventKind: 1059 })
    ));
    expect(await repository.list(ACCOUNT_B)).toEqual([]);
    expect(received).toEqual([]);
  });

  it("restores the Home mirror from Dexie after restart without localStorage", async () => {
    const { recipientWrap } = await giftWrap(A_SECRET, ACCOUNT_B, "survives restart");
    const repository = new SyncedMessageRepository(database());
    const firstRelay = new RelayHarness();
    const firstManager = await startReceiver({
      accountPubkey: ACCOUNT_B,
      privateKey: B_SECRET,
      repository,
      relay: firstRelay
    });
    firstRelay.deliver(recipientWrap, RELAYS[0]);
    await waitFor(async () => expect(await repository.list(ACCOUNT_B)).toHaveLength(1));
    firstManager.stop();

    const restoredInbox: CanonicalMessage[] = [];
    const secondRelay = new RelayHarness();
    await startReceiver({
      accountPubkey: ACCOUNT_B,
      privateKey: B_SECRET,
      repository,
      relay: secondRelay,
      onMessage: createHomeMessageHandler({
        accountPubkey: ACCOUNT_B,
        currentAccount: () => ACCOUNT_B,
        isInteraction: () => false,
        processInteraction: () => {},
        mirrorMessage: message => restoredInbox.push(message),
        notifyMessage: () => {}
      })
    });
    expect(restoredInbox).toHaveLength(1);
    expect(restoredInbox[0].plaintext).toBe("survives restart");
  });
});
