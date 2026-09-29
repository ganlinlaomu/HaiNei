export type TranscriptionProgress = {
  stage: "decoding" | "loading-model" | "transcribing";
  progress?: number;
};

type WorkerResponse =
  | { id: number; type: "progress"; stage: "loading-model" | "transcribing"; progress?: number }
  | { id: number; type: "result"; text: string; elapsedMs: number }
  | { id: number; type: "error"; message: string };

type PendingRequest = {
  resolve: (value: { text: string; elapsedMs: number }) => void;
  reject: (reason: Error) => void;
  onProgress?: (progress: TranscriptionProgress) => void;
};

let worker: Worker | null = null;
let requestId = 0;
const pending = new Map<number, PendingRequest>();

function transcriptionWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/localWhisper.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const request = pending.get(message.id);
    if (!request) return;
    if (message.type === "progress") {
      request.onProgress?.({ stage: message.stage, progress: message.progress });
      return;
    }
    pending.delete(message.id);
    if (message.type === "result") request.resolve({ text: message.text, elapsedMs: message.elapsedMs });
    else request.reject(new Error(message.message || "本机转写失败"));
  };
  worker.onerror = () => {
    for (const request of pending.values()) request.reject(new Error("本机转写引擎加载失败"));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function resampleToMono16k(buffer: AudioBuffer) {
  const sourceLength = buffer.length;
  const channels = Math.max(1, buffer.numberOfChannels);
  const mono = new Float32Array(sourceLength);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < sourceLength; i += 1) mono[i] += data[i] / channels;
  }
  if (buffer.sampleRate === 16_000) return mono;
  const targetLength = Math.max(1, Math.round(sourceLength * 16_000 / buffer.sampleRate));
  const output = new Float32Array(targetLength);
  const ratio = buffer.sampleRate / 16_000;
  for (let i = 0; i < targetLength; i += 1) {
    const position = i * ratio;
    const left = Math.min(sourceLength - 1, Math.floor(position));
    const right = Math.min(sourceLength - 1, left + 1);
    const fraction = position - left;
    output[i] = mono[left] * (1 - fraction) + mono[right] * fraction;
  }
  return output;
}

async function decodeAudio(blob: Blob) {
  const AudioContextCtor = window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error("此设备不支持本机音频解码");
  const context = new AudioContextCtor();
  try {
    const bytes = await blob.arrayBuffer();
    const decoded = await context.decodeAudioData(bytes.slice(0));
    return resampleToMono16k(decoded);
  } catch {
    throw new Error("无法解码这条语音，暂时不能本机转写");
  } finally {
    void context.close();
  }
}

export async function transcribeAudioLocally(
  blob: Blob,
  onProgress?: (progress: TranscriptionProgress) => void,
) {
  onProgress?.({ stage: "decoding" });
  const audio = await decodeAudio(blob);
  const id = ++requestId;
  const result = new Promise<{ text: string; elapsedMs: number }>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
  });
  transcriptionWorker().postMessage({ id, audio }, [audio.buffer]);
  return result;
}
