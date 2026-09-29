import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("local Whisper transcription PoC", () => {
  it("keeps transcription local and lazy-loaded", () => {
    const client = readFileSync(join(process.cwd(), "src/utils/localTranscription.ts"), "utf8");
    const worker = readFileSync(join(process.cwd(), "src/workers/localWhisper.worker.ts"), "utf8");
    const player = readFileSync(join(process.cwd(), "src/components/DmAudioMessage.vue"), "utf8");

    expect(worker).toContain('MODEL_ID = "onnx-community/whisper-tiny"');
    expect(worker).toContain('@huggingface/transformers@3.8.1/+esm');
    expect(worker).toContain('"automatic-speech-recognition"');
    expect(worker).toContain('task: "transcribe"');
    expect(worker).toContain("chunk_length_s: 30");
    expect(client).toContain("decodeAudioData");
    expect(client).toContain("16_000");
    expect(client).toContain('new Worker(new URL("../workers/localWhisper.worker.ts"');
    expect(client).not.toContain("/audio/transcriptions");
    expect(worker).not.toContain("/audio/transcriptions");
    expect(player).toContain("transcribeAudioLocally");
    expect(player).toContain("本机转写");
    expect(player).toContain("语音不上传");\n    expect(player).toContain("首次使用会下载模型");
  });
});
