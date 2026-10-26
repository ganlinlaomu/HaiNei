import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const forbiddenConfirm = vi.fn(() => { throw new Error("swipe delete must not show a confirmation dialog"); });

function runActions(path: string, slices: Array<[string, string]>, context: Record<string, unknown>, names: string[]) {
  const source = readFileSync(path, "utf8");
  const code = slices.map(([start, end]) => {
    const begin = source.indexOf(start);
    const finish = source.indexOf(end, begin + start.length);
    if (begin < 0 || finish < 0) throw new Error(`Missing action boundary in ${path}: ${start}`);
    return source.slice(begin, finish);
  }).join("\n");
  const transpiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return runInNewContext(`${transpiled}\n({ ${names.join(", ")} })`, context);
}

describe("iPhone-style immediate swipe deletion", () => {
  it("deletes a call record immediately and resets the busy state", async () => {
    const deleteRecord = vi.fn(async () => undefined);
    const closeSwipe = vi.fn();
    const deletingId = { value: "" };
    const error = { value: "" };
    const { deleteCallRecord } = runActions("src/views/Calls.vue",
      [["async function deleteCallRecord(", "onBeforeUnmount("]],
      { keys: { pkHex: ACCOUNT, isUnlocked: true }, deletingId, error, closeSwipe,
        callHistory: { deleteRecord }, window: { confirm: forbiddenConfirm },
        name: () => "Contact" },
      ["deleteCallRecord"]);
    await deleteCallRecord({ id: "call-1", peer: PEER });
    expect(deleteRecord).toHaveBeenCalledExactlyOnceWith(ACCOUNT, "call-1");
    expect(closeSwipe).toHaveBeenCalledExactlyOnceWith("call-1");
    expect(deletingId.value).toBe("");
    expect(forbiddenConfirm).not.toHaveBeenCalled();
    expect(error.value).toBe("");
  });

  it("does not delete another account's call after the session becomes locked", async () => {
    const deleteRecord = vi.fn();
    const { deleteCallRecord } = runActions("src/views/Calls.vue",
      [["async function deleteCallRecord(", "onBeforeUnmount("]],
      { keys: { pkHex: ACCOUNT, isUnlocked: false }, deletingId: { value: "" },
        error: { value: "" }, closeSwipe: vi.fn(), callHistory: { deleteRecord },
        window: { confirm: forbiddenConfirm }, name: () => "Contact" },
      ["deleteCallRecord"]);
    await deleteCallRecord({ id: "call-2", peer: PEER });
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it("deletes a contact on swipe without asking confirmation", async () => {
    const removeFriend = vi.fn(async () => undefined);
    const remove = vi.fn(async () => true);
    const closeSwipe = vi.fn();
    const ui = { addToast: vi.fn() };
    const relationshipBusy = new Set<string>();
    const { deleteFromSwipe } = runActions("src/views/Friends.vue", [
      ["const deleteFromSwipe = ", "\n    const startPendingEdit"],
      ["const confirmDelete = ", "\n    const acceptRequest"],
    ], { closeSwipe, relationshipBusy, friendships: { removeFriend },
      friends: { remove }, ui, confirm: forbiddenConfirm }, ["deleteFromSwipe"]);
    deleteFromSwipe({ pubkey: PEER, name: "Friend" });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith(PEER));
    expect(removeFriend).toHaveBeenCalledExactlyOnceWith(PEER);
    expect(closeSwipe).toHaveBeenCalledExactlyOnceWith(PEER);
    expect(ui.addToast).toHaveBeenCalledWith("已删除", 1500, "info");
    expect(relationshipBusy.size).toBe(0);
    expect(forbiddenConfirm).not.toHaveBeenCalled();
  });

  it("withdraws a swiped outgoing friend request without confirmation", async () => {
    const cancelRequest = vi.fn(async () => undefined);
    const closeSwipe = vi.fn();
    const ui = { addToast: vi.fn() };
    const { withdrawFromSwipe } = runActions("src/views/Friends.vue", [
      ["const withdrawFromSwipe = ", "\n\n    const withdrawRequest"],
      ["const withdrawRequest = ", "\n\n    // Group autocomplete handlers"],
    ], { closeSwipe, relationshipBusy: new Set(), friendships: { cancelRequest },
      ui, confirm: forbiddenConfirm }, ["withdrawFromSwipe"]);
    withdrawFromSwipe(PEER);
    await vi.waitFor(() => expect(cancelRequest).toHaveBeenCalledExactlyOnceWith(PEER));
    expect(closeSwipe).toHaveBeenCalledExactlyOnceWith(PEER);
    expect(ui.addToast).toHaveBeenCalledWith("好友请求已撤回", 1500, "info");
    expect(forbiddenConfirm).not.toHaveBeenCalled();
  });

  it("deletes a DM conversation in one swipe action with the original error handling", async () => {
    const deleteConversationData = vi.fn(async () => undefined);
    const closeSwipe = vi.fn();
    const ui = { addToast: vi.fn() };
    const { deleteConversation } = runActions("src/views/Conversations.vue", [
      ["async function deleteConversation(", "\nonMounted("],
    ], { closeSwipe, directMessages: { deleteConversation: deleteConversationData },
      ui, window: { confirm: forbiddenConfirm } }, ["deleteConversation"]);
    await deleteConversation(PEER);
    expect(deleteConversationData).toHaveBeenCalledExactlyOnceWith(PEER);
    expect(closeSwipe).toHaveBeenCalledExactlyOnceWith(PEER);
    expect(ui.addToast).toHaveBeenCalledWith("已删除本机聊天记录", 1600, "info");
    expect(forbiddenConfirm).not.toHaveBeenCalled();
  });

  it("dismisses a swiped notification without confirmation", () => {
    const dismissNotification = vi.fn();
    const closeSwipe = vi.fn();
    const { dismiss } = runActions("src/views/Notifications.vue", [
      ["function dismiss(", "\nfunction displayName("],
    ], { notifications: { dismiss: dismissNotification }, closeSwipe,
      confirm: forbiddenConfirm, window: { confirm: forbiddenConfirm } }, ["dismiss"]);
    dismiss({ id: "notice-1" });
    expect(dismissNotification).toHaveBeenCalledExactlyOnceWith("notice-1");
    expect(closeSwipe).toHaveBeenCalledExactlyOnceWith("notice-1");
    expect(forbiddenConfirm).not.toHaveBeenCalled();
  });
});
