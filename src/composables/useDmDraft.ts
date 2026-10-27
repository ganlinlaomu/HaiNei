import { nextTick, type Ref } from "vue";
import type { useDirectMessagesStore } from "@/stores/directMessages";
import type { InboxItem } from "@/stores/messages";

type DirectMessagesStore = ReturnType<typeof useDirectMessagesStore>;
const DRAFT_SAVE_DELAY_MS = 300;

/**
 * Per-conversation durable draft (text and the message being replied to).
 * The composer's refs stay the view's; this saves them 300ms after edits,
 * flushes on leave/lock, restores on open, and pauses while a send clears
 * the composer so an empty composer never overwrites the saved draft.
 */
export function useDmDraft(options: {
  account: () => string;
  peer: () => string;
  isDisposed: () => boolean;
  messages: () => InboxItem[];
  draft: Ref<string>;
  replyingToId: Ref<string>;
  /** A restored reply target that is outside the loaded history window. */
  draftReplyMessage: Ref<InboxItem | undefined>;
  directMessages: DirectMessagesStore;
}) {
  const { draft, replyingToId, draftReplyMessage, directMessages } = options;
  let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let draftReady = false;
  let suppressDraftPersistence = false;

  function clearDraftSaveTimer() {
    if (draftSaveTimer !== null) clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
  function scheduleDraftSave() {
    if (!draftReady || suppressDraftPersistence) return;
    clearDraftSaveTimer();
    const account = options.account();
    const peer = options.peer();
    const text = draft.value;
    const replyTo = replyingToId.value || undefined;
    if (!account || !peer) return;
    draftSaveTimer = setTimeout(() => {
      draftSaveTimer = null;
      void directMessages.saveDraft(peer, { text, replyTo }, account);
    }, DRAFT_SAVE_DELAY_MS);
  }
  function flushDraft(account: string = options.account(), peer: string = options.peer()) {
    clearDraftSaveTimer();
    if (!draftReady || suppressDraftPersistence || !account || !peer) return;
    return directMessages.saveDraft(peer, { text: draft.value, replyTo: replyingToId.value || undefined }, account);
  }
  /** Stop saving until the next restore (conversation switch, lock, unmount). */
  function pauseDraftPersistence() {
    draftReady = false;
    clearDraftSaveTimer();
  }
  async function restoreDraft(account: string, peer: string) {
    draftReady = false;
    clearDraftSaveTimer();
    const saved = await directMessages.loadDraft(peer, account);
    if (options.isDisposed() || options.account() !== account || options.peer() !== peer) return;
    draft.value = saved?.text || "";
    replyingToId.value = saved?.replyTo || "";
    draftReplyMessage.value = undefined;
    if (saved?.replyTo && !options.messages().some(message => message.id === saved.replyTo)) {
      const context = await directMessages.loadPeerMessageContext(peer, saved.replyTo, 0);
      if (options.isDisposed() || options.account() !== account || options.peer() !== peer) return;
      draftReplyMessage.value = context.find(message => message.id === saved.replyTo);
    }
    await nextTick();
    draftReady = true;
  }
  /**
   * Run `clear` (empty the composer after a send) without persisting the
   * cleared state; anything typed meanwhile is saved on the next tick.
   */
  function clearAfterSend(clear: () => void) {
    clearDraftSaveTimer();
    suppressDraftPersistence = true;
    clear();
    void nextTick(() => {
      suppressDraftPersistence = false;
      if (draft.value || replyingToId.value) scheduleDraftSave();
    });
  }

  return { scheduleDraftSave, flushDraft, pauseDraftPersistence, restoreDraft, clearAfterSend };
}
