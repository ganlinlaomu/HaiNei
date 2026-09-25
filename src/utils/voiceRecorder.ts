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
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  let activeSince: number | null = startedAt;
  let activeElapsedMs = 0;
  const healthListeners = new Set<(health: VoiceRecordingHealth) => void>();
  let resolveFinished!: (result: VoiceRecordingResult | null) => void;
  let rejectFinished!: (error: Error) => void;
  const finished = new Promise<VoiceRecordingResult | null>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  const hasLiveTrack = () => tracks.some(track => track.readyState === "live");
  const isActive = () => !settled && recorder.state === "recording" && hasLiveTrack();
  const elapsedMs = () => Math.max(0, activeElapsedMs + (isActive() && activeSince !== null ? now() - activeSince : 0));
  const health = (): VoiceRecordingHealth => ({
    state,
    active: isActive(),
    trackMuted: tracks.length > 0 && tracks.every(track => track.muted),
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
    maxDurationTimer = null;
    stopFallback = null;
  };
  const removeListeners = () => {
    recorder.removeEventListener("start", onStart);
    recorder.removeEventListener("dataavailable", onDataAvailable);
    recorder.removeEventListener("stop", onStop);
    recorder.removeEventListener("error", onError);
    recorder.removeEventListener("pause", onPause);
    recorder.removeEventListener("resume", onResume);
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
      rejectFinished(new Error("未获取到录音数据，请重试"));
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
      () => settle(new Error("录音处理超时，请重试")),
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
  const requestUnexpectedCompletion = () => {
    if (completionMode || settled) return;
    completionMode = "unexpected";
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

  function onStart() {
    if (!completionMode && !settled) setState("recording");
  }
  function onDataAvailable(event: BlobEvent) {
    if (event.data.size) chunks.push(event.data);
  }
  function onStop() {
    // MediaRecorder guarantees the final dataavailable caused by stop() before stop.
    if (!completionMode) {
      completionMode = "unexpected";
      captureActiveTime();
    }
    settle();
  }
  function onError() {
    if (!completionMode) completionMode = "unexpected";
    settle(new Error("录音失败，请重试"));
  }
  function onPause() {
    captureActiveTime();
    if (!completionMode && !settled) setState("paused");
  }
  function onResume() {
    if (completionMode || settled) return;
    activeSince = now();
    setState("recording");
  }
  function onTrackEnded() {
    requestUnexpectedCompletion();
  }
  function onTrackMute() {
    emitHealth();
  }
  function onTrackUnmute() {
    emitHealth();
  }

  recorder.addEventListener("start", onStart);
  recorder.addEventListener("dataavailable", onDataAvailable);
  recorder.addEventListener("stop", onStop);
  recorder.addEventListener("error", onError);
  recorder.addEventListener("pause", onPause);
  recorder.addEventListener("resume", onResume);
  tracks.forEach(track => {
    track.addEventListener("ended", onTrackEnded);
    track.addEventListener("mute", onTrackMute);
    track.addEventListener("unmute", onTrackUnmute);
  });

  try {
    recorder.start();
    if (recorder.state !== "recording" || !hasLiveTrack()) throw new Error("inactive");
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
