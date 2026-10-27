import { computed, nextTick, ref, shallowRef } from "vue";
import { classifyVoiceGesture } from "@/utils/voiceGesture";
import { createVoiceRecordingSession, type VoiceRecordingResult, type VoiceRecordingSession } from "@/utils/voiceRecorder";

const VOICE_CANCEL_DISTANCE = 68;
const VOICE_LOCK_DISTANCE = 68;

/**
 * Hold-to-record voice messages for one chat: the capture session, its
 * timer and health watch, the slide-to-cancel / slide-up-to-lock gesture,
 * and the recorded preview. Sending is the view's (`send`).
 */
export function useVoiceRecorder(options: {
  account: () => string;
  peer: () => string;
  accepted: () => boolean;
  isDisposed: () => boolean;
  /** A selected image blocks recording, as the composer holds one attachment. */
  hasPendingImage: () => boolean;
  send: (result: VoiceRecordingResult, account: string, peer: string) => void;
}) {
  const recording = shallowRef<VoiceRecordingSession | null>(null);
  const startingRecording = ref(false);
  const finishingRecording = ref(false);
  const recordingElapsed = ref(0);
  const voiceLocked = ref(false);
  const voiceGestureHint = ref<"send" | "cancel" | "lock">("send");
  const recordedAudio = ref<(VoiceRecordingResult & { preview: string }) | null>(null);
  const voiceError = ref("");
  /** Starting, recording or finishing: the microphone owns the audio session. */
  const voiceCaptureOwnsAudioSession = computed(() => startingRecording.value || !!recording.value || finishingRecording.value);
  let recordingTimer: ReturnType<typeof setInterval> | null = null;
  let recordingHealthUnsubscribe: (() => void) | null = null;
  let voiceGesture: { kind: "touch" | "mouse"; startX: number; startY: number; touchId?: number } | null = null;
  let pendingVoiceGestureAction: "send" | "cancel" | null = null;
  let autoSendVoiceOnFinish = false;
  let ignoreVoiceMouseUntil = 0;

  function formatVoiceDuration(value: number) {
    const seconds = Math.max(0, Math.floor(value));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function stopRecordingTimer() {
    if (recordingTimer !== null) clearInterval(recordingTimer);
    recordingTimer = null;
  }
  function stopRecordingHealthWatch() {
    recordingHealthUnsubscribe?.();
    recordingHealthUnsubscribe = null;
  }
  function startRecordingTimer(session: VoiceRecordingSession) {
    if (recordingTimer !== null || !session.isActive()) return;
    recordingElapsed.value = Math.min(300, session.elapsedMs() / 1000);
    recordingTimer = setInterval(() => {
      if (recording.value !== session || !session.isActive()) {
        stopRecordingTimer();
        return;
      }
      recordingElapsed.value = Math.min(300, session.elapsedMs() / 1000);
    }, 250);
  }
  function clearRecordedAudio() {
    if (recordedAudio.value?.preview) URL.revokeObjectURL(recordedAudio.value.preview);
    recordedAudio.value = null;
  }
  function stopVoiceGestureTracking() {
    window.removeEventListener("touchmove", handleVoiceTouchMove);
    window.removeEventListener("touchend", handleVoiceTouchEnd);
    window.removeEventListener("touchcancel", handleVoiceTouchCancel);
    window.removeEventListener("mousemove", handleVoiceMouseMove);
    window.removeEventListener("mouseup", handleVoiceMouseUp);
    voiceGesture = null;
    voiceGestureHint.value = "send";
  }
  function cancelVoiceRecording() {
    const active = recording.value;
    if (!active && startingRecording.value) pendingVoiceGestureAction = "cancel";
    recording.value = null;
    finishingRecording.value = false;
    stopRecordingTimer();
    stopRecordingHealthWatch();
    recordingElapsed.value = 0;
    voiceLocked.value = false;
    stopVoiceGestureTracking();
    active?.cancel();
  }
  function acceptRecordingResult(
    session: VoiceRecordingSession,
    result: VoiceRecordingResult | null,
    account: string,
    peer: string,
  ) {
    if (!result
      || recording.value !== session
      || options.isDisposed()
      || options.account() !== account
      || options.peer() !== peer) return;
    clearRecordedAudio();
    recordedAudio.value = { ...result, preview: URL.createObjectURL(result.blob) };
  }
  function waitForAudioElementsToUnmount() {
    return new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }

  function updateVoiceGesture(clientX: number, clientY: number, event?: Event) {
    if (!voiceGesture || voiceLocked.value) return;
    const dx = clientX - voiceGesture.startX;
    const dy = clientY - voiceGesture.startY;
    voiceGestureHint.value = classifyVoiceGesture(dx, dy, VOICE_CANCEL_DISTANCE, VOICE_LOCK_DISTANCE);
    if (event?.cancelable) event.preventDefault();
  }
  function completeVoiceGesture() {
    if (!voiceGesture) return;
    const action = voiceGestureHint.value;
    stopVoiceGestureTracking();
    if (action === "lock") {
      voiceLocked.value = true;
      pendingVoiceGestureAction = null;
      return;
    }
    pendingVoiceGestureAction = action === "cancel" ? "cancel" : "send";
    if (pendingVoiceGestureAction === "cancel") cancelVoiceRecording();
    else if (recording.value) void finishVoiceRecording(recording.value, true);
  }
  function handleVoiceTouchStart(event: TouchEvent) {
    if (voiceGesture || recording.value || startingRecording.value || recordedAudio.value || options.hasPendingImage() || !options.accepted() || !options.account()) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    ignoreVoiceMouseUntil = Date.now() + 800;
    voiceGesture = { kind: "touch", startX: touch.clientX, startY: touch.clientY, touchId: touch.identifier };
    voiceGestureHint.value = "send";
    voiceLocked.value = false;
    pendingVoiceGestureAction = null;
    window.addEventListener("touchmove", handleVoiceTouchMove, { passive: false });
    window.addEventListener("touchend", handleVoiceTouchEnd, { passive: false });
    window.addEventListener("touchcancel", handleVoiceTouchCancel, { passive: false });
    void startVoiceRecording();
  }
  function handleVoiceTouchMove(event: TouchEvent) {
    if (voiceGesture?.kind !== "touch") return;
    const touch = Array.from(event.touches).find(item => item.identifier === voiceGesture?.touchId);
    if (touch) updateVoiceGesture(touch.clientX, touch.clientY, event);
  }
  function handleVoiceTouchEnd(event: TouchEvent) {
    if (voiceGesture?.kind !== "touch") return;
    const ended = Array.from(event.changedTouches).some(item => item.identifier === voiceGesture?.touchId);
    if (!ended) return;
    if (event.cancelable) event.preventDefault();
    completeVoiceGesture();
  }
  function handleVoiceTouchCancel(event: TouchEvent) {
    if (voiceGesture?.kind !== "touch") return;
    if (event.cancelable) event.preventDefault();
    pendingVoiceGestureAction = "cancel";
    cancelVoiceRecording();
  }
  function handleVoiceMouseDown(event: MouseEvent) {
    if (Date.now() < ignoreVoiceMouseUntil || voiceGesture || recording.value || startingRecording.value || recordedAudio.value || options.hasPendingImage() || !options.accepted() || !options.account()) return;
    voiceGesture = { kind: "mouse", startX: event.clientX, startY: event.clientY };
    voiceGestureHint.value = "send";
    voiceLocked.value = false;
    pendingVoiceGestureAction = null;
    window.addEventListener("mousemove", handleVoiceMouseMove);
    window.addEventListener("mouseup", handleVoiceMouseUp);
    void startVoiceRecording();
  }
  function handleVoiceMouseMove(event: MouseEvent) {
    if (voiceGesture?.kind === "mouse") updateVoiceGesture(event.clientX, event.clientY, event);
  }
  function handleVoiceMouseUp(event: MouseEvent) {
    if (voiceGesture?.kind !== "mouse") return;
    if (event.cancelable) event.preventDefault();
    completeVoiceGesture();
  }

  async function startVoiceRecording() {
    if (startingRecording.value || recording.value || recordedAudio.value || options.hasPendingImage() || !options.accepted() || !options.account()) return;
    startingRecording.value = true;
    voiceError.value = "";
    const accountAtStart = options.account();
    const peerAtStart = options.peer();
    try {
      // iOS 27 can interrupt a fresh microphone capture when an HTMLAudioElement
      // from the conversation still owns the media session. Setting the reactive
      // flag is not enough: Vue has not removed those elements until nextTick.
      await nextTick();
      await waitForAudioElementsToUnmount();
      if (options.isDisposed() || !options.accepted() || options.account() !== accountAtStart || options.peer() !== peerAtStart) return;
      const remainingAudioElements = document.querySelectorAll(".message-list audio, .composer-region audio").length;
      console.info("[voice-recorder]", { event: "pre-capture-audio-elements", count: remainingAudioElements });
      const session = await createVoiceRecordingSession({
        onAutoFinish: () => { autoSendVoiceOnFinish = true; },
      });
      if (options.isDisposed() || !options.accepted() || options.account() !== accountAtStart || options.peer() !== peerAtStart) return session.dispose();
      if (pendingVoiceGestureAction === "cancel") {
        pendingVoiceGestureAction = null;
        session.cancel();
        return;
      }
      recording.value = session;
      finishingRecording.value = false;
      recordingElapsed.value = 0;
      recordingHealthUnsubscribe = session.onStateChange(health => {
        if (recording.value !== session) return;
        if (health.active && !finishingRecording.value) startRecordingTimer(session);
        else stopRecordingTimer();
        if (["finishing", "stopped", "error"].includes(health.state) && !finishingRecording.value) {
          void finishVoiceRecording(session, autoSendVoiceOnFinish);
        }
      });
      startRecordingTimer(session);
      if (pendingVoiceGestureAction === "send") {
        pendingVoiceGestureAction = null;
        void finishVoiceRecording(session, true);
      }
    } catch (error) {
      voiceError.value = error instanceof Error ? error.message : "无法使用麦克风";
    } finally {
      startingRecording.value = false;
    }
  }
  async function finishVoiceRecording(target?: VoiceRecordingSession, sendImmediately = false) {
    const session = target || recording.value;
    if (!session || recording.value !== session || finishingRecording.value) return;
    const accountAtFinish = options.account();
    const peerAtFinish = options.peer();
    recordingElapsed.value = Math.min(300, session.elapsedMs() / 1000);
    finishingRecording.value = true;
    stopRecordingTimer();
    stopVoiceGestureTracking();
    voiceError.value = "";
    try {
      const result = await session.finish();
      if (result && sendImmediately) options.send(result, accountAtFinish, peerAtFinish);
      else acceptRecordingResult(session, result, accountAtFinish, peerAtFinish);
    } catch (error) {
      if (recording.value === session) voiceError.value = error instanceof Error ? error.message : "录音处理失败";
    } finally {
      if (recording.value === session) {
        recording.value = null;
        recordingElapsed.value = 0;
        stopRecordingHealthWatch();
      }
      finishingRecording.value = false;
      pendingVoiceGestureAction = null;
      autoSendVoiceOnFinish = false;
      voiceLocked.value = false;
    }
  }

  return {
    recording,
    finishingRecording,
    recordingElapsed,
    voiceLocked,
    voiceGestureHint,
    recordedAudio,
    voiceError,
    voiceCaptureOwnsAudioSession,
    formatVoiceDuration,
    clearRecordedAudio,
    cancelVoiceRecording,
    finishVoiceRecording,
    handleVoiceTouchStart,
    handleVoiceMouseDown,
  };
}
