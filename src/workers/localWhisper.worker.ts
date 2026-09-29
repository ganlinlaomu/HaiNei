const TRANSFORMERS_MODULE_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js";
const MODEL_ID = "onnx-community/whisper-base";
const SAMPLE_RATE = 16_000;

type Backend = "webgpu" | "wasm";

type Pipeline = (
  audio: Float32Array,
  options?: {
    task?: string;
    language?: string;
    chunk_length_s?: number;
    stride_length_s?: number;
  },
) => Promise<{ text?: string } | Array<{ text?: string }>>;

type PipelineOptions = {
  dtype?: string | Record<string, string>;
  device?: string;
  progress_callback?: (progress: { status?: string; progress?: number }) => void;
};

type TransformersModule = {
  pipeline: (
    task: "automatic-speech-recognition",
    model: string,
    options?: PipelineOptions,
  ) => Promise<Pipeline>;
};

let transformersPromise: Promise<TransformersModule> | null = null;
let transcriberPromise: Promise<Pipeline> | null = null;
let activeBackend: Backend | null = null;
let webGpuDisabled = false;
let activeRequestId = 0;
let queue = Promise.resolve();

function postProgress(id: number, stage: "loading-model" | "transcribing", progress?: number) {
  self.postMessage({ id, type: "progress", stage, progress });
}

function isAppleMobileWebKit() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  return /iPhone|iPad|iPod/i.test(ua)
    || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function webGpuAvailable() {
  // Keep iPhone/iPad on the stable WASM path. Safari can expose WebGPU here,
  // but loading/inference with Whisper may terminate the whole page process.
  return !webGpuDisabled
    && !isAppleMobileWebKit()
    && typeof navigator !== "undefined"
    && "gpu" in navigator;
}

function transformersModule() {
  if (!transformersPromise) {
    transformersPromise = import(/* @vite-ignore */ TRANSFORMERS_MODULE_URL) as Promise<TransformersModule>;
  }
  return transformersPromise;
}

async function createTranscriber(id: number, backend: Backend) {
  const transformers = await transformersModule();
  const options: PipelineOptions = backend === "webgpu"
    ? {
        device: "webgpu",
        dtype: {
          encoder_model: "fp32",
          decoder_model_merged: "q4",
        },
      }
    : { dtype: "q8" };

  options.progress_callback = progress => {
    if (activeRequestId !== id) return;
    postProgress(id, "loading-model", typeof progress.progress === "number" ? progress.progress : undefined);
  };

  const pipeline = await transformers.pipeline("automatic-speech-recognition", MODEL_ID, options);
  activeBackend = backend;
  return pipeline;
}

async function getTranscriber(id: number, forceBackend?: Backend) {
  const preferred: Backend = forceBackend || (webGpuAvailable() ? "webgpu" : "wasm");

  if (!transcriberPromise || activeBackend !== preferred) {
    postProgress(id, "loading-model");
    transcriberPromise = createTranscriber(id, preferred).catch(error => {
      transcriberPromise = null;
      activeBackend = null;
      throw error;
    });
  } else {
    postProgress(id, "loading-model", 100);
  }

  return transcriberPromise;
}

function transcriptionOptions(audio: Float32Array) {
  const seconds = audio.length / SAMPLE_RATE;
  const options: {
    task: string;
    language: string;
    chunk_length_s?: number;
    stride_length_s?: number;
  } = {
    task: "transcribe",
    language: "zh",
  };

  // Whisper natively handles up to ~30 s. Avoiding chunk/stride work makes
  // normal short chat voice messages noticeably faster.
  if (seconds > 30) {
    options.chunk_length_s = 30;
    options.stride_length_s = 3;
  }

  return options;
}

async function transcribeWith(
  id: number,
  audio: Float32Array,
  backend?: Backend,
) {
  const transcriber = await getTranscriber(id, backend);
  postProgress(id, "transcribing");
  return transcriber(audio, transcriptionOptions(audio));
}

async function run(message: { id: number; audio: Float32Array }) {
  const { id, audio } = message;
  activeRequestId = id;

  try {
    const started = performance.now();
    let output: Awaited<ReturnType<Pipeline>>;

    try {
      output = await transcribeWith(id, audio);
    } catch (error) {
      // Safari/WebGPU support can vary by device/PWA context. If GPU setup or
      // inference fails, retry the same request once on the proven WASM q8 path.
      if (activeBackend !== "webgpu" && !webGpuAvailable()) throw error;
      webGpuDisabled = true;
      transcriberPromise = null;
      activeBackend = null;
      output = await transcribeWith(id, audio, "wasm");
    }

    const item = Array.isArray(output) ? output[0] : output;
    const text = String(item?.text || "").trim();
    self.postMessage({
      id,
      type: "result",
      text,
      elapsedMs: Math.round(performance.now() - started),
      backend: activeBackend,
    });
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
