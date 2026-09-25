export const MAX_VOICE_RECORDING_MS = 5 * 60 * 1000;

export type VoiceRecordingResult = {
  blob: Blob;
  mime: string;
  duration: number;
  size: number;
};

export type VoiceRecordingSession = {
  mime: string;
  startedAt: number;
  finished: Promise<VoiceRecordingResult | null>;
  finish: () => Promise<VoiceRecordingResult | null>;
  cancel: () => void;
  dispose: () => void;
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
  finalChunkGraceMs?: number;
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

  const stopTracks = () => stream.getTracks().forEach(track => {
    try { track.stop(); } catch {}
  });
  const mime = selectVoiceRecordingMime(Recorder);
  let recorder: MediaRecorder;
  try {
    recorder = mime ? new Recorder(stream, { mimeType: mime }) : new Recorder(stream);
  } catch {
    stopTracks();
    throw new Error("当前浏览器无法开始录音");
  }

  const chunks: Blob[] = [];
  const now = options.now || Date.now;
  const startedAt = now();
  let completionMode: "finish" | "cancel" | null = null;
  let completionAt = startedAt;
  let settled = false;
  let tracksStopped = false;
  let stopFallback: ReturnType<typeof setTimeout> | null = null;
  let finalChunkGrace: ReturnType<typeof setTimeout> | null = null;
  let resolveFinished!: (result: VoiceRecordingResult | null) => void;
  let rejectFinished!: (error: Error) => void;
  const finished = new Promise<VoiceRecordingResult | null>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  const stopTracksOnce = () => {
    if (tracksStopped) return;
    tracksStopped = true;
    stopTracks();
  };
  const clearCompletionTimers = () => {
    clearTimeout(maxDurationTimer);
    if (stopFallback) clearTimeout(stopFallback);
    if (finalChunkGrace) clearTimeout(finalChunkGrace);
  };
  const settle = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearCompletionTimers();
    stopTracksOnce();
    if (error) return rejectFinished(error);
    if (completionMode === "cancel") return resolveFinished(null);
    if (!chunks.length) return rejectFinished(new Error("未获取到录音数据"));
    const resultMime = recorder.mimeType || chunks.find(chunk => !!chunk.type)?.type || mime;
    const blob = new Blob(chunks, { type: resultMime });
    resolveFinished({
      blob,
      mime: resultMime,
      duration: Math.min(300, Math.max(0, (completionAt - startedAt) / 1000)),
      size: blob.size,
    });
  };
  const scheduleFinalization = () => {
    if (settled || finalChunkGrace) return;
    finalChunkGrace = setTimeout(() => settle(), options.finalChunkGraceMs ?? 50);
  };
  const requestCompletion = (mode: "finish" | "cancel") => {
    if (completionMode) return finished;
    completionMode = mode;
    completionAt = now();
    clearTimeout(maxDurationTimer);
    if (mode === "cancel") {
      if (recorder.state === "recording" || recorder.state === "paused") {
        try { recorder.stop(); } catch {}
      }
      stopTracksOnce();
      settle();
      return finished;
    }
    if (recorder.state === "recording" || recorder.state === "paused") {
      try { recorder.requestData?.(); } catch {}
      try { recorder.stop(); } catch (error) {
        settle(error instanceof Error ? error : new Error("录音停止失败"));
        return finished;
      }
    } else {
      scheduleFinalization();
    }
    stopTracksOnce();
    stopFallback = setTimeout(() => settle(), options.stopFallbackMs ?? 2_000);
    return finished;
  };
  const maxDurationTimer = setTimeout(() => {
    options.onAutoFinish?.();
    void requestCompletion("finish");
  }, options.maxDurationMs || MAX_VOICE_RECORDING_MS);

  recorder.addEventListener("dataavailable", event => {
    if (event.data.size) chunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    if (!completionMode) {
      completionMode = "finish";
      completionAt = now();
      stopTracksOnce();
      options.onAutoFinish?.();
    }
    scheduleFinalization();
  });
  recorder.addEventListener("error", () => {
    settle(new Error("录音失败"));
  });

  try {
    recorder.start();
  } catch {
    clearTimeout(maxDurationTimer);
    stopTracksOnce();
    throw new Error("当前浏览器无法开始录音");
  }
  return {
    mime: recorder.mimeType || mime,
    startedAt,
    finished,
    finish: () => requestCompletion("finish"),
    cancel: () => { void requestCompletion("cancel"); },
    dispose: () => { void requestCompletion("cancel"); },
  };
}
