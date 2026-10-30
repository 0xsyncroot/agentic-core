import { AgenticError } from "@0xsyncroot/contracts";

const WAV_HEADER_BYTES = 44;
const DEFAULT_L16_RATE_HZ = 24_000;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export function isRiffWave(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE";
}

/** Sample rate from the "fmt " chunk of a RIFF/WAVE file; chunks before it (e.g. JUNK) are skipped. */
export function readWavSampleRate(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4, true);
    if (ascii(bytes, offset, 4) === "fmt ") {
      if (size < 16 || offset + 8 + 16 > bytes.length) break;
      const rate = view.getUint32(offset + 12, true);
      if (rate > 0) return rate;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  throw new AgenticError("permanent", "Speech provider returned a WAV file without a usable fmt chunk");
}

/** `audio/L16;codec=pcm;rate=24000` → 24000; 24000 when the parameter is absent. */
export function l16RateFromMimeType(mimeType: string | undefined): number {
  const match = /(?:^|;)\s*rate\s*=\s*(\d{3,6})\s*(?:;|$)/iu.exec(mimeType ?? "");
  return match ? Number(match[1]) : DEFAULT_L16_RATE_HZ;
}

/** Wraps raw little-endian mono 16-bit PCM in a canonical 44-byte WAV header. */
export function wrapL16AsWav(pcm: Uint8Array, sampleRateHz: number): Uint8Array {
  const dataBytes = pcm.length - (pcm.length % 2);
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(out.buffer);
  const tag = (offset: number, text: string): void => { for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i); };
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);
  out.set(pcm.subarray(0, dataBytes), WAV_HEADER_BYTES);
  return out;
}
