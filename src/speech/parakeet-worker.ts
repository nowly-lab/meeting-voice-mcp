// Worker thread: one Parakeet recognizer shared by both sides, one Silero VAD per side. Audio never leaves the Mac.
import { createRequire } from "node:module";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { createSideProcessor, VAD_SETTINGS, type VadLike } from "./side-processor.ts";
import { SAMPLE_RATE, pcmToFloat } from "./types.ts";

type SherpaStream = { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void };
type Sherpa = {
  OfflineRecognizer: new (c: object) => { createStream(): SherpaStream; decode(s: SherpaStream): void; getResult(s: SherpaStream): { text: string } };
  Vad: new (c: object, bufferSeconds: number) => VadLike;
};

export function createRecognizer(modelDir: string, vadOnly = false) {
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as Sherpa;
  const newVad = () => new sherpa.Vad({ sileroVad: { model: join(modelDir, "silero_vad.onnx"), ...VAD_SETTINGS }, sampleRate: SAMPLE_RATE, numThreads: 1, debug: false }, 60);
  // Gemini mode: only voice start/end is needed, so no recognizer (and no 650 MB model) is loaded.
  if (vadOnly) return { recognize: () => "", newVad };
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: { nemoCtc: { model: join(modelDir, "model.int8.onnx") }, tokens: join(modelDir, "tokens.txt"), numThreads: 2, provider: "cpu", debug: 0 },
  });
  const recognize = (samples: Float32Array) => {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    recognizer.decode(stream);
    return recognizer.getResult(stream).text;
  };
  return { recognize, newVad };
}

if (parentPort && workerData?.modelDir) {
  const port = parentPort;
  try {
    const { recognize, newVad } = createRecognizer(workerData.modelDir as string, workerData.vadOnly === true);
    const sides = { mic: createSideProcessor({ vad: newVad(), recognize }), system: createSideProcessor({ vad: newVad(), recognize }) };
    const send = (side: "mic" | "system", r: ReturnType<typeof sides.mic.accept>) => {
      for (const v of r.voice) port.postMessage({ type: "voice", side, ...v });
      for (const s of r.segments) port.postMessage({ type: "segment", side, ...s });
    };
    port.postMessage({ type: "ready" });
    port.on("message", (m: { type: string; side?: "mic" | "system"; atMs?: number; pcm?: ArrayBuffer }) => {
      try {
        if (m.type === "pcm" && m.side && m.pcm && typeof m.atMs === "number") send(m.side, sides[m.side].accept(pcmToFloat(Buffer.from(m.pcm)), m.atMs));
        else if (m.type === "stop") {
          send("mic", sides.mic.flush());
          send("system", sides.system.flush());
          port.postMessage({ type: "finished" });
        }
      } catch (error) {
        port.postMessage({ type: "error", message: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
      }
    });
  } catch (error) {
    port.postMessage({ type: "error", message: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
  }
}
