// Call signals used to wait for the recipient's relay list and every relay
// (a slow one held the invite's push for seconds). The fast path does not.
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, utils } from "nostr-tools";
import { encryptDirectMessage } from "@/nostr/messaging/protocol";

const mocks = vi.hoisted(() => ({ publish: vi.fn(), push: vi.fn(async () => undefined) }));
vi.mock("@/services/nostrClient", () => ({ nostrClient: { publish: mocks.publish } }));
vi.mock("@/services/pushNotifications", () => ({ triggerGenericPush: mocks.push }));

const sk = utils.hexToBytes("1".padStart(64, "0"));
const ME = getPublicKey(sk);
const PEER = getPublicKey(utils.hexToBytes("2".padStart(64, "0")));
const context = {
  senderPubkey: ME,
  nip44Encrypt: (peer: string, plaintext: string) => encryptDirectMessage({ senderPrivateKey: sk, recipientPubkey: peer, plaintext }),
  signEvent: (event: any) => Promise.resolve(finalizeEvent(event, sk)),
};
const target = (event: any) => event.tags.find((tag: string[]) => tag[0] === "p")?.[1];

afterEach(() => { mocks.publish.mockReset(); mocks.push.mockClear(); });

describe("fast control send", () => {
  it("resolves on the first relay to accept and pushes the invite at once", async () => {
    let releaseSlow!: () => void;
    mocks.publish.mockImplementation((event: any, [relay]: string[]) => relay === "wss://slow.test"
      ? new Promise(resolve => { releaseSlow = () => resolve([{ relay, ok: true }]); })
      : Promise.resolve([{ relay, ok: true }]));
    const { sendFastControl } = await import("@/nostr/messaging/service");
    await sendFastControl({
      recipientPubkeys: [PEER], content: "{}", tags: [["t", "hainei-call"], ["t", "hainei-call-invite"]],
      relays: ["wss://fast.test", "wss://slow.test"], context: context as any, push: "call",
    });
    expect(mocks.push).toHaveBeenCalledOnce();
    const [recipients, , , type, , hints] = mocks.push.mock.calls[0] as any[];
    expect(recipients).toEqual([PEER]);
    expect(type).toBe("call");
    // The encrypted wrap rides in the push, so a closed app needs no fetch.
    expect(hints[0]).toMatchObject({ recipient: PEER, event: expect.objectContaining({ kind: 1059 }) });
    releaseSlow();
  });

  it("fails only when every relay refuses, and keeps self-only records off the peer", async () => {
    mocks.publish.mockImplementation((_event: any, [relay]: string[]) => Promise.resolve([{ relay, ok: false }]));
    const { sendFastControl } = await import("@/nostr/messaging/service");
    await expect(sendFastControl({ recipientPubkeys: [PEER], content: "x", tags: [], relays: ["wss://a.test", "wss://b.test"], context: context as any }))
      .rejects.toThrow("没有 relay 接收通话信令");

    mocks.publish.mockReset().mockImplementation((_event: any, [relay]: string[]) => Promise.resolve([{ relay, ok: true }]));
    await sendFastControl({ recipientPubkeys: [PEER], content: "📞", tags: [["t", "hainei-dm"]], relays: ["wss://a.test"], context: context as any, selfOnly: true });
    expect(mocks.publish.mock.calls.map(call => target(call[0]))).toEqual([ME]);
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
