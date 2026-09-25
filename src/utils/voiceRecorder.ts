export const MAX_VOICE_RECORDING_MS = 5 * 60 * 1000;

export type VoiceRecordingResult = {
  blob: Blob;
  mime: string;
  duration: number;
  size: number;
};

export type VoiceRecordingState = "recording" | "paused" | "finishing" | "stopped" | "cancelled" | "error";

export type VoiceRecordingHealth = {
  state: VoiceRecordingState;
  active: boolean;
  streamActive: boolean;
  trackMuted: boolean;
};

export type VoiceRecordingSession = {
  mime: string;
  startedAt: number;
  finished: Promise<VoiceRecordingResult | null>;
  finish: () => Promise<VoiceRecordingResult | null>;
  cancel: () => void;
  dispose: () => void;
  isActive: () => boolean;
  elapsedMs: () => number;
  onStateChange: (listener: (health: VoiceRecordingHealth) => void) => () => void;
};

const AUDIO_MIME_CANDIDATES = [
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

export function selectVoiceRecordingMime(recorderType: { isTypeSupported?: (type: string) => boolean }) {
  if (typeof recorderType.isTypeSupported !== "function") return "";
  return AUDIO_MIME_CANDIDATES.find(type => recorderType.isTypeSupported?.(type)) || "";
}

export async function createVoiceRecordingSession(options: {
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  Recorder?: typeof MediaRecorder;
  maxDurationMs?: number;
  stopFallbackMs?: number;
  muteGraceMs?: number;
  now?: () => number;
  onAutoFinish?: () => void;
} = {}): Promise<VoiceRecordingSession> {
  const mediaDevices = options.mediaDevices || navigator.mediaDevices;
  const Recorder = options.Recorder || globalThis.MediaRecorder;
  if (!mediaDevices?.getUserMedia || !Recorder) throw new Error("当前浏览器不支持录音");

  let stream: MediaStream;
  try {
    stream = await mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new Error("无法使用麦克风，请检查权限设置");
  }

  const tracks = typeof stream.getAudioTracks === "function"
    ? stream.getAudioTracks()
    : stream.getTracks().filter(track => !track.kind || track.kind === "audio");
  const stopTracks = () => stream.getTracks().forEach(track => {
    try { track.stop(); } catch {}
  });
  if (!tracks.length || tracks.every(track => track.readyState === "ended")) {
    stopTracks();
    throw new Error("未检测到可用的麦克风");
  }

  // Safari is most reliable when it chooses its own native container/codec.
  // Only try an explicit supported type if the default constructor itself fails.
  let recorder: MediaRecorder;
  try {
    recorder = new Recorder(stream);
  } catch {
    const fallbackMime = selectVoiceRecordingMime(Recorder);
    try {
      if (!fallbackMime) throw new Error("unsupported");
      recorder = new Recorder(stream, { mimeType: fallbackMime });
    } catch {
      stopTracks();
      throw new Error("当前浏览器无法开始录音");
    }
  }

  const chunks: Blob[] = [];
  const now = options.now || Date.now;
  const startedAt = now();
  let state: VoiceRecordingState = "recording";
  let completionMode: "finish" | "cancel" | "unexpected" | null = null;
  let settled = false;
  let tracksStopped = false;
  let stopFallback: ReturnType<typeof setTimeout> | null = null;
  let muteGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  let activeSince: number | null = startedAt;
  let activeElapsedMs = 0;
  let emptyDataError: Error | null = null;
  const healthListeners = new Set<(health: VoiceRecordingHealth) => void>();
  let resolveFinished!: (result: VoiceRecordingResult | null) => void;
  let rejectFinished!: (error: Error) => void;
  const finished = new Promise<VoiceRecordingResult | null>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  const diagnosticsEnabled = import.meta.env.DEV && !options.Recorder;
  const diagnose = (event: string) => {
    if (!diagnosticsEnabled) return;
    console.debug("[voice-recorder]", {
      timestamp: new Date().toISOString(),
      event,
      recorderState: recorder.state,
      streamActive: stream.active,
      tracks: tracks.map(track => ({ readyState: track.readyState, muted: track.muted })),
    });
  };
  const streamIsActive = () => stream.active !== false;
  const hasLiveTrack = () => tracks.some(track => track.readyState === "live");
  const allTracksMuted = () => tracks.length > 0 && tracks.every(track => track.muted);
  const rawIsActive = () => !settled
    && recorder.state === "recording"
    && streamIsActive()
    && hasLiveTrack()
    && !allTracksMuted();
  const isActive = () => {
    const active = rawIsActive();
    if (!active && !completionMode && !settled) syncHealth("poll");
    return active;
  };
  const elapsedMs = () => Math.max(0, activeElapsedMs + (rawIsActive() && activeSince !== null ? now() - activeSince : 0));
  const health = (): VoiceRecordingHealth => ({
    state,
    active: rawIsActive(),
    streamActive: streamIsActive(),
    trackMuted: allTracksMuted(),
  });
  const emitHealth = () => healthListeners.forEach(listener => listener(health()));
  const setState = (next: VoiceRecordingState) => {
    state = next;
    emitHealth();
  };
  const captureActiveTime = () => {
    if (activeSince === null) return;
    activeElapsedMs += Math.max(0, now() - activeSince);
    activeSince = null;
  };
  const stopTracksOnce = () => {
    if (tracksStopped) return;
    tracksStopped = true;
    stopTracks();
  };
  const clearTimers = () => {
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    if (stopFallback) clearTimeout(stopFallback);
    if (muteGraceTimer) clearTimeout(muteGraceTimer);
    maxDurationTimer = null;
    stopFallback = null;
    muteGraceTimer = null;
  };
  const removeListeners = () => {
    recorder.removeEventListener("start", onStart);
    recorder.removeEventListener("dataavailable", onDataAvailable);
    recorder.removeEventListener("stop", onStop);
    recorder.removeEventListener("error", onError);
    recorder.removeEventListener("pause", onPause);
    recorder.removeEventListener("resume", onResume);
    stream.removeEventListener("active", onStreamActive);
    stream.removeEventListener("inactive", onStreamInactive);
    tracks.forEach(track => {
      track.removeEventListener("ended", onTrackEnded);
      track.removeEventListener("mute", onTrackMute);
      track.removeEventListener("unmute", onTrackUnmute);
    });
  };
  const settle = (error?: Error) => {
    if (settled) return;
    settled = true;
    captureActiveTime();
    clearTimers();
    removeListeners();
    if (completionMode === "cancel") {
      stopTracksOnce();
      setState("cancelled");
      resolveFinished(null);
      return;
    }
    if (error) {
      stopTracksOnce();
      setState("error");
      rejectFinished(error);
      return;
    }
    const resultMime = recorder.mimeType || chunks.find(chunk => !!chunk.type)?.type || "application/octet-stream";
    const blob = new Blob(chunks, { type: resultMime });
    stopTracksOnce();
    if (!blob.size) {
      setState("error");
      rejectFinished(emptyDataError || new Error("未获取到录音数据，请重试"));
      return;
    }
    setState("stopped");
    resolveFinished({
      blob,
      mime: resultMime,
      duration: Math.min(300, activeElapsedMs / 1000),
      size: blob.size,
    });
  };
  const startStopWatchdog = () => {
    if (stopFallback || settled) return;
    stopFallback = setTimeout(
      () => settle(completionMode === "unexpected"
        ? emptyDataError || new Error("麦克风录音已被系统中断，请重试")
        : new Error("录音处理超时，请重试")),
      options.stopFallbackMs ?? 3_000,
    );
  };
  const requestCompletion = (mode: "finish" | "cancel") => {
    if (completionMode) return finished;
    completionMode = mode;
    captureActiveTime();
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    maxDurationTimer = null;
    if (mode === "cancel") {
      if (recorder.state === "recording" || recorder.state === "paused") {
        try { recorder.stop(); } catch {}
      }
      settle();
      return finished;
    }
    setState("finishing");
    if (recorder.state === "recording" || recorder.state === "paused") {
      try { recorder.stop(); } catch (error) {
        settle(error instanceof Error ? error : new Error("录音停止失败"));
        return finished;
      }
    }
    startStopWatchdog();
    return finished;
  };
  const requestUnexpectedCompletion = (reason = new Error("麦克风录音已被系统中断，请重试")) => {
    if (completionMode || settled) return;
    completionMode = "unexpected";
    emptyDataError = reason;
    captureActiveTime();
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    maxDurationTimer = null;
    setState("finishing");
    if (recorder.state === "recording" || recorder.state === "paused") {
      try { recorder.stop(); } catch (error) {
        settle(error instanceof Error ? error : new Error("录音意外中断"));
        return;
      }
    }
    startStopWatchdog();
  };

  function syncHealth(source: string) {
    if (completionMode || settled) return;
    if (recorder.state === "inactive") {
      diagnose(`${source}:inactive`);
      requestUnexpectedCompletion();
      return;
    }
    if (!streamIsActive() || !hasLiveTrack()) {
      captureActiveTime();
      emitHealth();
      diagnose(`${source}:interrupted`);
      requestUnexpectedCompletion();
      return;
    }
    if (recorder.state === "paused") {
      captureActiveTime();
      setState("paused");
      return;
    }
    if (allTracksMuted()) {
      captureActiveTime();
      emitHealth();
      if (!muteGraceTimer) {
        muteGraceTimer = setTimeout(() => {
          muteGraceTimer = null;
          if (!completionMode && !settled && allTracksMuted()) {
            diagnose("mute-timeout");
            requestUnexpectedCompletion();
          }
        }, options.muteGraceMs ?? 1_000);
      }
      return;
    }
    if (muteGraceTimer) {
      clearTimeout(muteGraceTimer);
      muteGraceTimer = null;
    }
    if (activeSince === null) activeSince = now();
    state = "recording";
    emitHealth();
  }

  function onStart() {
    diagnose("start");
    if (!completionMode && !settled) syncHealth("start");
  }
  function onDataAvailable(event: BlobEvent) {
    if (event.data.size) chunks.push(event.data);
  }
  function onStop() {
    diagnose("stop");
    // MediaRecorder guarantees the final dataavailable caused by stop() before stop.
    if (!completionMode) {
      completionMode = "unexpected";
      emptyDataError = new Error("麦克风录音已被系统中断，请重试");
      captureActiveTime();
    }
    settle();
  }
  function onError() {
    diagnose("error");
    requestUnexpectedCompletion(new Error("录音失败，请重试"));
  }
  function onPause() {
    diagnose("pause");
    captureActiveTime();
    if (!completionMode && !settled) setState("paused");
  }
  function onResume() {
    diagnose("resume");
    if (completionMode || settled) return;
    syncHealth("resume");
  }
  function onTrackEnded() {
    diagnose("ended");
    requestUnexpectedCompletion();
  }
  function onTrackMute() {
    diagnose("mute");
    syncHealth("mute");
  }
  function onTrackUnmute() {
    diagnose("unmute");
    syncHealth("unmute");
  }
  function onStreamActive() {
    diagnose("stream-active");
    syncHealth("stream-active");
  }
  function onStreamInactive() {
    diagnose("stream-inactive");
    requestUnexpectedCompletion();
  }

  recorder.addEventListener("start", onStart);
  recorder.addEventListener("dataavailable", onDataAvailable);
  recorder.addEventListener("stop", onStop);
  recorder.addEventListener("error", onError);
  recorder.addEventListener("pause", onPause);
  recorder.addEventListener("resume", onResume);
  stream.addEventListener("active", onStreamActive);
  stream.addEventListener("inactive", onStreamInactive);
  tracks.forEach(track => {
    track.addEventListener("ended", onTrackEnded);
    track.addEventListener("mute", onTrackMute);
    track.addEventListener("unmute", onTrackUnmute);
  });

  try {
    recorder.start();
    if (recorder.state !== "recording" || !streamIsActive() || !hasLiveTrack()) throw new Error("inactive");
  } catch {
    clearTimers();
    removeListeners();
    stopTracksOnce();
    throw new Error("当前浏览器无法开始录音");
  }

  maxDurationTimer = setTimeout(() => {
    options.onAutoFinish?.();
    void requestCompletion("finish");
  }, options.maxDurationMs || MAX_VOICE_RECORDING_MS);
  syncHealth("initial");

  return {
    mime: recorder.mimeType,
    startedAt,
    finished,
    finish: () => requestCompletion("finish"),
    cancel: () => { void requestCompletion("cancel"); },
    dispose: () => { void requestCompletion("cancel"); },
    isActive,
    elapsedMs,
    onStateChange(listener) {
      healthListeners.add(listener);
      listener(health());
      return () => healthListeners.delete(listener);
    },
  };
}
