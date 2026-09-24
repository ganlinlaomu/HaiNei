import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const OTHER = "c".repeat(64);

const mocks = vi.hoisted(() => ({
  key: { pkHex: "a".repeat(64), supportsNip44: true, signEvent: vi.fn(), nip44Encrypt: vi.fn() },
  tasks: new Map<string, any>(),
  send: vi.fn(),
  publish: vi.fn(),
  upload: vi.fn(),
  queueGet: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => ["wss://relay.test"] }));
vi.mock("@/nostr/messaging/service", () => ({
  sendDirectMessage: mocks.send,
  publishQueuedOutgoing: mocks.publish,
  registerOutgoingPushSigner: vi.fn(),
}));
vi.mock("@/utils/commentImage", () => ({ uploadEncryptedCommentImage: mocks.upload }));
vi.mock("@/repositories/outgoingDmTaskRepository", () => ({
  outgoingDmTaskRepository: {
    get: vi.fn(async (account: string, localId: string) => mocks.tasks.get(`${account}:${localId}`)),
    list: vi.fn(async (account: string) => [...mocks.tasks.values()].filter(task => task.accountPubkey === account)),
    put: vi.fn(async (task: any) => { mocks.tasks.set(`${task.accountPubkey}:${task.localId}`, task); return task; }),
    update: vi.fn(async (account: string, localId: string, patch: any) => {
      const key = `${account}:${localId}`;
      const updated = { ...mocks.tasks.get(key), ...patch };
      mocks.tasks.set(key, updated);
      return updated;
    }),
  },
}));
vi.mock("@/repositories/outgoingQueueRepository", () => ({
  outgoingQueueRepository: { get: mocks.queueGet, list: vi.fn(async () => []) },
}));
vi.mock("@/repositories/syncedMessageRepository", () => ({
  syncedMessageRepository: {
    insertMessageIfAbsent: mocks.insert,
    list: vi.fn(async () => []),
  },
}));
vi.mock("@/repositories/metaRepository", () => ({
  metaRepository: { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined) },
}));

import { useDirectMessagesStore } from "@/stores/directMessages";
import { useFriendshipsStore } from "@/stores/friendships";
import { useMessagesStore } from "@/stores/messages";

function canonical(id = "canonical-1", content = "你好") {
  return {
    message: {
      id, senderPubkey: ACCOUNT, recipientPubkeys: [PEER], conversationId: "conversation-1",
      plaintext: content, createdAt: 100, protocol: "nip17" as const, transportKind: 1059,
      rumorId: id, tags: [["p", PEER], ["t", "hainei-dm"]],
    },
    events: [],
    relayResults: [],
  };
}

function seed(account = ACCOUNT) {
  mocks.key.pkHex = account;
  const messages = useMessagesStore();
  messages.loadedFor = account;
  messages.inbox = [];
  const friendships = useFriendshipsStore();
  friendships.loadedFor = account;
  friendships.records = account === ACCOUNT ? [{
    accountPubkey: ACCOUNT, peerPubkey: PEER, state: "accepted", acceptedAt: 1,
    acceptedEventId: "accepted", acceptedWindows: [{ acceptedAt: 1, acceptedEventId: "accepted" }], updatedAt: 1,
  }] : [];
  const direct = useDirectMessagesStore();
  direct.loadedFor = account;
  return { direct, messages };
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.key.pkHex = ACCOUNT;
  mocks.tasks.clear();
  mocks.send.mockReset();
  mocks.publish.mockReset();
  mocks.upload.mockReset();
  mocks.queueGet.mockReset().mockResolvedValue(undefined);
  mocks.insert.mockReset().mockResolvedValue({ inserted: true });
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() });
  vi.stubGlobal("File", class File extends Blob {
    name: string;
    constructor(parts: BlobPart[], name: string, options?: BlobPropertyBag) {
      super(parts, options);
      this.name = name;
    }
  });
});

describe("optimistic outgoing DM tasks", () => {
  it("shows text immediately, keeps one bubble, and reconciles to sent", async () => {
    let release!: (value: any) => void;
    mocks.send.mockImplementation((options: any) => new Promise(resolve => {
      void options.onQueued("canonical-1");
      release = resolve;
    }));
    const { direct, messages } = seed();
    const localId = direct.send(PEER, "你好");

    expect(direct.peerMessages(PEER)).toHaveLength(1);
    expect(direct.peerMessages(PEER)[0]).toMatchObject({ content: "你好", outgoing: { localId, state: "sending" } });

    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    messages.addInbox({
      id: "canonical-1", pubkey: ACCOUNT, recipientPubkeys: [PEER], created_at: 100,
      content: "你好", conversationId: "conversation-1", protocol: "nip17", transportKind: 1059,
      tags: [["t", "hainei-dm"]],
    });
    expect(direct.peerMessages(PEER)).toHaveLength(1);
    release(canonical());
    await vi.waitFor(() => expect(direct.peerMessages(PEER)[0].outgoing?.state).toBe("sent"));
    expect(direct.peerMessages(PEER)).toHaveLength(1);
  });

  it("marks a text failure on the same bubble and retries its durable outgoing item", async () => {
    mocks.send.mockImplementationOnce(async (options: any) => {
      await options.onQueued("canonical-1");
      throw new Error("relay failed");
    });
    mocks.publish.mockResolvedValue(canonical());
    const { direct } = seed();
    const localId = direct.send(PEER, "失败后重试");
    await vi.waitFor(() => expect(direct.peerMessages(PEER)[0].outgoing?.state).toBe("send_failed"));

    await direct.retry(localId);
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledWith(ACCOUNT, "canonical-1", "message");
    expect(direct.peerMessages(PEER)).toHaveLength(1);
    expect(direct.peerMessages(PEER)[0].outgoing?.state).toBe("sent");
  });

  it("shows an image immediately and advances uploading -> sending -> sent as one message", async () => {
    let finishUpload!: (value: any) => void;
    let finishSend!: (value: any) => void;
    mocks.upload.mockImplementation(() => new Promise(resolve => { finishUpload = resolve; }));
    mocks.send.mockImplementation((options: any) => new Promise(resolve => {
      void options.onQueued("canonical-image");
      finishSend = resolve;
    }));
    const { direct } = seed();
    const image = new File(["image"], "photo.jpg", { type: "image/jpeg" });
    direct.send(PEER, "配图", image);

    expect(direct.peerMessages(PEER)[0].outgoing).toMatchObject({ state: "uploading", imagePreviewUrl: "blob:preview", hasImage: true });
    await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    finishUpload({ ref: "blossom+aesgcm:encrypted" });
    await vi.waitFor(() => expect(direct.peerMessages(PEER)[0].outgoing?.state).toBe("sending"));
    expect(mocks.send.mock.calls[0][0].content).toBe("配图\n![](blossom+aesgcm:encrypted)");
    finishSend(canonical("canonical-image", "配图\n![](blossom+aesgcm:encrypted)"));
    await vi.waitFor(() => expect(direct.peerMessages(PEER)[0].outgoing?.state).toBe("sent"));
    expect(direct.peerMessages(PEER)).toHaveLength(1);
  });

  it("distinguishes upload failure and retries the same local image task", async () => {
    const prepared = {
      encryptedBlob: new Blob(["encrypted"]), encryptedName: "photo.encrypted",
      previewBlob: new Blob(["preview"], { type: "image/jpeg" }), mime: "image/jpeg",
      iv: "iv", key: "key", width: 10, height: 10,
    };
    mocks.upload
      .mockImplementationOnce(async (_file: File, options: any) => {
        await options.onPrepared(prepared);
        throw new Error("upload failed");
      })
      .mockImplementationOnce(async (_file: File, options: any) => {
        expect(options.prepared).toMatchObject({ encryptedName: "photo.encrypted", key: "key" });
        return { ref: "blossom+aesgcm:retry" };
      });
    mocks.send.mockImplementation(async (options: any) => {
      await options.onQueued("canonical-image");
      return canonical("canonical-image", options.content);
    });
    const { direct } = seed();
    const localId = direct.send(PEER, "", new File(["image"], "photo.jpg", { type: "image/jpeg" }));
    await vi.waitFor(() => expect(direct.peerMessages(PEER)[0].outgoing?.state).toBe("upload_failed"));

    await direct.retry(localId);
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(direct.peerMessages(PEER)).toHaveLength(1);
    expect(direct.peerMessages(PEER)[0].outgoing?.state).toBe("sent");
  });

  it("does not re-upload after Relay failure and repeated retry stays idempotent", async () => {
    mocks.upload.mockResolvedValue({ ref: "blossom+aesgcm:once" });
    mocks.send.mockImplementationOnce(async (options: any) => {
      await options.onQueued("canonical-image");
      throw new Error("relay failed");
    });
    mocks.publish.mockResolvedValue(canonical("canonical-image", "![](blossom+aesgcm:once)"));
    const { direct } = seed();
    const localId = direct.send(PEER, "", new File(["image"], "photo.jpg", { type: "image/jpeg" }));
    await vi.waitFor(() => expect(direct.peerMessages(PEER)[0].outgoing?.state).toBe("send_failed"));

    await Promise.all([direct.retry(localId), direct.retry(localId)]);
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(direct.peerMessages(PEER)).toHaveLength(1);
  });

  it("merges and durably relinks a failed optimistic image when the task id link is missing", async () => {
    const { direct, messages } = seed();
    const failedTask = {
      accountPubkey: ACCOUNT,
      localId: "lost-link",
      peerPubkey: PEER,
      text: "这张如何",
      imageBlob: new Blob(["image"], { type: "image/jpeg" }),
      uploadedRef: "blossom+aesgcm:encrypted",
      state: "send_failed",
      createdAt: 100,
      updatedAt: 101,
    } as const;
    direct.outgoingTasks = [failedTask];
    mocks.tasks.set(`${ACCOUNT}:lost-link`, failedTask);
    messages.inbox = [{
      id: "relay-self-copy",
      pubkey: ACCOUNT,
      recipientPubkeys: [PEER],
      created_at: 100,
      content: "这张如何\n![](blossom+aesgcm:encrypted)",
      conversationId: "conversation-1",
      protocol: "nip17",
      transportKind: 1059,
      tags: [["t", "hainei-dm"]],
    }];

    expect(direct.peerMessages(PEER)).toHaveLength(1);
    expect(direct.peerMessages(PEER)[0]).toMatchObject({
      id: "relay-self-copy",
      outgoing: { localId: "lost-link", state: "send_failed" },
    });
    await direct.refresh(ACCOUNT);
    expect(mocks.tasks.get(`${ACCOUNT}:lost-link`)).toMatchObject({
      outgoingId: "relay-self-copy",
      canonicalMessageId: "relay-self-copy",
    });
  });

  it("reloads and resumes account-scoped pending work while self-copy stays deduplicated", async () => {
    const persisted = {
      accountPubkey: ACCOUNT, localId: "persisted", peerPubkey: PEER, text: "稍后重试",
      state: "sending", createdAt: 10, updatedAt: 10,
    };
    mocks.tasks.set(`${ACCOUNT}:persisted`, persisted);
    mocks.send.mockResolvedValue(canonical("canonical-resumed", "稍后重试"));
    const { direct, messages } = seed();
    await direct.refresh(ACCOUNT);
    await vi.waitFor(() => expect(direct.peerMessages(PEER)[0].outgoing?.state).toBe("sent"));
    messages.addInbox({ ...direct.peerMessages(PEER)[0], id: "canonical-resumed" });
    expect(direct.peerMessages(PEER)).toHaveLength(1);

    setActivePinia(createPinia());
    const switched = seed(OTHER).direct;
    await switched.refresh(OTHER);
    expect(switched.outgoingTasks).toHaveLength(0);
  });

  it("foreground/network resume retries a failed persisted task", async () => {
    const { direct } = seed();
    const failed = {
      accountPubkey: ACCOUNT, localId: "failed", peerPubkey: PEER, text: "恢复发送",
      state: "send_failed" as const, createdAt: 11, updatedAt: 11,
    };
    mocks.tasks.set(`${ACCOUNT}:failed`, failed);
    direct.outgoingTasks = [failed];
    mocks.send.mockResolvedValue(canonical("canonical-foreground", "恢复发送"));

    await direct.resumePending(true);
    await vi.waitFor(() => expect(direct.peerMessages(PEER)[0].outgoing?.state).toBe("sent"));
  });

  it("does not automatically re-upload a definitively failed image", async () => {
    const { direct } = seed();
    direct.outgoingTasks = [{
      accountPubkey: ACCOUNT, localId: "upload-failed", peerPubkey: PEER, text: "",
      imageBlob: new Blob(["image"], { type: "image/jpeg" }), state: "upload_failed",
      createdAt: 12, updatedAt: 12,
    }];

    await direct.resumePending(true);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(direct.outgoingTasks[0].state).toBe("upload_failed");
  });
});
