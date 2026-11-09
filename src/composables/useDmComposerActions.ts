import { computed, nextTick, type Ref } from "vue";
import type { BurnDuration } from "@/nostr/messaging/disappearingMessages";
import { serializeLocationShare, type LocationShare } from "@/nostr/messaging/locationShare";
import type { useDirectMessagesStore } from "@/stores/directMessages";
import type { SelectedDmImage } from "@/composables/useDmImageSelection";
import type { VoiceRecordingResult } from "@/utils/voiceRecorder";

export const MIN_VOICE_DURATION_SECONDS = 1;

type ToastKind = "info" | "success" | "error";

/**
 * What the DM composer sends and when: text (optionally burn-after-reading),
 * images as one message each with the text and reply on the first, recorded
 * voice, locations and friend cards, plus the attachment menu's guards
 * (burn-after-reading is text only).
 */
export function useDmComposerActions(options: {
  account: () => string;
  peer: () => string;
  accepted: () => boolean;
  supportsNip44: () => boolean;
  isDisposed: () => boolean;
  draft: Ref<string>;
  replyingToId: Readonly<Ref<string>>;
  /** Id of the message being replied to, when it is still available. */
  replyTarget: () => string | undefined;
  cancelReply: () => void;
  selectedImages: Readonly<Ref<SelectedDmImage[]>>;
  imageInput: Readonly<Ref<HTMLInputElement | null>>;
  clearSelectedImages: () => void;
  recording: Readonly<Ref<unknown>>;
  recordedAudio: Readonly<Ref<VoiceRecordingResult | null>>;
  clearRecordedAudio: () => void;
  voiceError: Ref<string>;
  voiceCaptureOwnsAudioSession: Readonly<Ref<boolean>>;
  textInput: Readonly<Ref<HTMLTextAreaElement | null>>;
  disappearingSeconds: Ref<BurnDuration | null>;
  attachmentMenuOpen: Ref<boolean>;
  locationSheetOpen: Ref<boolean>;
  showRecommendationPicker: () => void;
  clearAfterSend: (clear: () => void) => void;
  directMessages: Pick<ReturnType<typeof useDirectMessagesStore>, "send" | "sendAudio">;
  startLiveSharing: (peer: string, durationSeconds: number, location: LocationShare) => Promise<unknown>;
  notify: (message: string, durationMs: number, kind: ToastKind) => void;
}) {
  const {
    account, peer, accepted, supportsNip44, isDisposed, draft, replyingToId, replyTarget, cancelReply,
    selectedImages, imageInput, clearSelectedImages, recording, recordedAudio, clearRecordedAudio, voiceError,
    voiceCaptureOwnsAudioSession, textInput, disappearingSeconds, attachmentMenuOpen, locationSheetOpen,
    showRecommendationPicker, clearAfterSend, directMessages, startLiveSharing, notify,
  } = options;

  const canSend = computed(() => !!account() && accepted() && !recording.value && (!!draft.value.trim() || selectedImages.value.length > 0 || !!recordedAudio.value));

  function openRecommendationPicker() {
    attachmentMenuOpen.value = false;
    if (!accepted() || !supportsNip44() || disappearingSeconds.value !== null) {
      notify("当前账号无法发送加密好友名片", 2000, "info");
      return;
    }
    textInput.value?.blur();
    showRecommendationPicker();
  }
  function openLocationSheet() {
    attachmentMenuOpen.value = false;
    if (!accepted()) return;
    if (disappearingSeconds.value !== null) {
      notify("阅后即焚仅支持纯文字消息", 2200, "info");
      return;
    }
    textInput.value?.blur();
    locationSheetOpen.value = true;
  }
  async function sendLocation(location: LocationShare, durationSeconds = 0) {
    locationSheetOpen.value = false;
    if (!accepted()) return;
    if (durationSeconds > 0) {
      try {
        await startLiveSharing(peer(), durationSeconds, location);
      } catch (error) {
        notify(error instanceof Error ? error.message : "位置共享失败", 2200, "error");
      }
      return;
    }
    try {
      // Like a friend card: a separate message that leaves the typed draft alone.
      directMessages.send(peer(), serializeLocationShare(location), undefined, undefined, undefined, { preserveDraft: true });
    } catch (error) {
      notify(error instanceof Error ? error.message : "位置发送失败", 2200, "error");
    }
  }
  function chooseImageFromMenu() {
    attachmentMenuOpen.value = false;
    if (accepted() && disappearingSeconds.value === null) imageInput.value?.click();
  }
  function enableDisappearing() {
    attachmentMenuOpen.value = false;
    if (!accepted() || !supportsNip44()) {
      notify("当前账号无法发送加密临时消息", 2000, "info");
      return;
    }
    if (selectedImages.value.length || recordedAudio.value || voiceCaptureOwnsAudioSession.value) {
      notify("请先移除图片或语音，阅后即焚仅支持文字", 2200, "info");
      return;
    }
    cancelReply();
    disappearingSeconds.value = 10;
    void nextTick(() => textInput.value?.focus());
  }
  function disableDisappearing() {
    disappearingSeconds.value = null;
  }
  function sendVoiceRecordingResult(result: VoiceRecordingResult, accountAtStart: string, peerAtStart: string) {
    if (isDisposed() || account() !== accountAtStart || peer() !== peerAtStart) return;
    if (result.duration < MIN_VOICE_DURATION_SECONDS) {
      notify("说话时间太短", 1_600, "info");
      return;
    }
    try {
      directMessages.sendAudio(peerAtStart, result, replyTarget());
      cancelReply();
    } catch (error) {
      voiceError.value = error instanceof Error ? error.message : "语音发送失败";
      notify(voiceError.value, 2_200, "error");
    }
  }
  function submitMessage() {
    if (!canSend.value) return;
    if (disappearingSeconds.value !== null && (recordedAudio.value || selectedImages.value.length || replyingToId.value)) {
      notify("阅后即焚仅支持纯文字消息", 2200, "info");
      return;
    }
    if (recordedAudio.value) {
      const audio = recordedAudio.value;
      const replyTo = replyTarget();
      try {
        directMessages.sendAudio(peer(), audio, replyTo);
        clearAfterSend(() => {
          draft.value = "";
          clearRecordedAudio();
          cancelReply();
        });
      } catch (error) {
        voiceError.value = error instanceof Error ? error.message : "语音发送失败";
        notify(voiceError.value, 2200, "error");
      }
      return;
    }
    const text = draft.value;
    const images = selectedImages.value.map(image => image.file);
    const replyTo = replyTarget();
    try {
      if (images.length) {
        images.forEach((image, index) => directMessages.send(
          peer(),
          index === 0 ? text : "",
          image,
          index === 0 ? replyTo : undefined,
        ));
      } else {
        directMessages.send(peer(), text, undefined, replyTo, disappearingSeconds.value ?? undefined);
      }
      disappearingSeconds.value = null;
      attachmentMenuOpen.value = false;
      clearAfterSend(() => {
        draft.value = "";
        clearSelectedImages();
        cancelReply();
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : "发送失败，请稍后重试", 2200, "error");
    }
  }

  return {
    canSend, submitMessage, sendVoiceRecordingResult, sendLocation,
    openRecommendationPicker, openLocationSheet, chooseImageFromMenu, enableDisappearing, disableDisappearing,
  };
}
