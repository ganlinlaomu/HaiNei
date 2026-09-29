import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("local Whisper transcription PoC", () => {
  it("keeps transcription local and lazy-loaded", () => {
    const client = readFileSync(join(process.cwd(), "src/utils/localTranscription.ts"), "utf8");
    const worker = readFileSync(join(process.cwd(), "src/workers/localWhisper.worker.ts"), "utf8");
    const player = readFileSync(join(process.cwd(), "src/components/DmAudioMessage.vue"), "utf8");

    expect(worker).toContain('MODEL_ID = "onnx-community/whisper-base"');
    expect(worker).toContain('@huggingface/transformers@4.3.0/dist/transformers.min.js');
    expect(worker).toContain('"automatic-speech-recognition"');
    expect(worker).toContain('device: "webgpu"');
    expect(worker).toContain('encoder_model: "fp32"');
    expect(worker).toContain('decoder_model_merged: "q4"');
    expect(worker).toContain('dtype: "q8"');
    expect(worker).toContain("isAppleMobileWebKit");
    expect(worker).toContain("!isAppleMobileWebKit()");
    expect(worker).toContain("webGpuDisabled = true");
    expect(worker).toContain('task: "transcribe"');
    expect(worker).toContain('language: "zh"');
    expect(client).not.toContain("TranscriptionLanguage");
    expect(player).not.toContain("transcription-language");
    expect(player).not.toContain("本机转写 · 语音不上传 · 首次使用会下载模型");
    expect(player).toContain(">转文字</button>");
    expect(worker).toContain("if (seconds > 30)");
    expect(worker).toContain("options.chunk_length_s = 30");
    expect(worker).toContain("options.stride_length_s = 3");
    expect(client).toContain("decodeAudioData");
    expect(client).toContain("16_000");
    expect(client).toContain('new Worker(new URL("../workers/localWhisper.worker.ts"');
    expect(client).not.toContain("/audio/transcriptions");
    expect(worker).not.toContain("/audio/transcriptions");
    expect(player).toContain("transcribeAudioLocally");
  });
});
