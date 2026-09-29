const TRANSFORMERS_MODULE_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";
const MODEL_ID = "onnx-community/whisper-tiny";

type Pipeline = (
  audio: Float32Array,
  options?: { task?: string; chunk_length_s?: number; stride_length_s?: number },
) => Promise<{ text?: string } | Array<{ text?: string }>>;

type TransformersModule = {
  pipeline: (
    task: "automatic-speech-recognition",
    model: string,
    options?: { progress_callback?: (progress: { status?: string; progress?: number }) => void },
  ) => Promise<Pipeline>;
};

let transcriberPromise: Promise<Pipeline> | null = null;
let activeRequestId = 0;
let queue = Promise.resolve();

function postProgress(id: number, stage: "loading-model" | "transcribing", progress?: number) {
  self.postMessage({ id, type: "progress", stage, progress });
}

async function getTranscriber(id: number) {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      postProgress(id, "loading-model");
      const transformers = await import(/* @vite-ignore */ TRANSFORMERS_MODULE_URL) as TransformersModule;
      return transformers.pipeline("automatic-speech-recognition", MODEL_ID, {
        progress_callback: progress => {
          if (activeRequestId !== id) return;
          postProgress(id, "loading-model", typeof progress.progress === "number" ? progress.progress : undefined);
        },
      });
    })().catch(error => {
      transcriberPromise = null;
      throw error;
    });
  } else {
    postProgress(id, "loading-model", 100);
  }
  return transcriberPromise;
}

async function run(message: { id: number; audio: Float32Array }) {
  const { id, audio } = message;
  activeRequestId = id;
  try {
    const transcriber = await getTranscriber(id);
    postProgress(id, "transcribing");
    const started = performance.now();
    const output = await transcriber(audio, {
      task: "transcribe",
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const item = Array.isArray(output) ? output[0] : output;
    const text = String(item?.text || "").trim();
    self.postMessage({ id, type: "result", text, elapsedMs: Math.round(performance.now() - started) });
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      message: error instanceof Error ? error.message : "本机 Whisper 转写失败",
    });
  } finally {
    if (activeRequestId === id) activeRequestId = 0;
  }
}

self.onmessage = (event: MessageEvent<{ id: number; audio: Float32Array }>) => {
  queue = queue.then(() => run(event.data)).catch(() => undefined);
};
