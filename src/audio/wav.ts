// 16 kHz mono s16le WAV written while recording; sizes are filled in on close (or repaired after a crash).
import { closeSync, fstatSync, openSync, writeSync } from "node:fs";

const HEADER = 44;

function header(dataBytes: number) {
  const b = Buffer.alloc(HEADER);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

export type WavWriter = { write(pcm: Buffer): void; close(): Promise<void> };

export function createWavWriter(path: string): WavWriter {
  const fd = openSync(path, "w", 0o600);
  writeSync(fd, header(0));
  let bytes = 0;
  let closed = false;
  return {
    write(pcm) {
      if (closed) return;
      writeSync(fd, pcm);
      bytes += pcm.length;
    },
    async close() {
      if (closed) return;
      closed = true;
      writeSync(fd, header(bytes), 0, HEADER, 0);
      closeSync(fd);
    },
  };
}

export function fixWavHeader(path: string): void {
  const fd = openSync(path, "r+");
  try {
    const size = fstatSync(fd).size;
    writeSync(fd, header(Math.max(0, size - HEADER)), 0, HEADER, 0);
  } finally {
    closeSync(fd);
  }
}
