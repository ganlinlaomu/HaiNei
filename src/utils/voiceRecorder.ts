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
  now?: () => number;
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

  const stopTracks = () => stream.getTracks().forEach(track => track.stop());
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
  let discarded = false;
  let settled = false;
  let resolveFinished!: (result: VoiceRecordingResult | null) => void;
  let rejectFinished!: (error: Error) => void;
  const finished = new Promise<VoiceRecordingResult | null>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  const timeout = setTimeout(() => {
    if (recorder.state !== "inactive") recorder.stop();
  }, options.maxDurationMs || MAX_VOICE_RECORDING_MS);

  const cleanup = () => {
    clearTimeout(timeout);
    stopTracks();
  };
  recorder.addEventListener("dataavailable", event => {
    if (event.data.size) chunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    if (settled) return;
    settled = true;
    cleanup();
    if (discarded) return resolveFinished(null);
    const resultMime = recorder.mimeType || chunks.find(chunk => !!chunk.type)?.type || mime;
    const blob = new Blob(chunks, { type: resultMime });
    resolveFinished({ blob, mime: resultMime, duration: Math.min(300, Math.max(0, (now() - startedAt) / 1000)), size: blob.size });
  });
  recorder.addEventListener("error", () => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectFinished(new Error("录音失败"));
  });

  try {
    recorder.start();
  } catch {
    cleanup();
    throw new Error("当前浏览器无法开始录音");
  }

  const stop = () => {
    if (recorder.state !== "inactive") recorder.stop();
    else cleanup();
  };
  return {
    mime: recorder.mimeType || mime,
    startedAt,
    finished,
    finish: () => { stop(); return finished; },
    cancel: () => { discarded = true; stop(); },
    dispose: () => { discarded = true; stop(); },
  };
}
