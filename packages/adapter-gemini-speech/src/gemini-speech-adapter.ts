import { AgenticError } from "@0xsyncroot/contracts";
import type {
  SpeechSynthesis, SpeechSynthesisRequest, SpeechToText, SpeechTranscription, SpeechTranscriptionRequest, TextToSpeech,
} from "@0xsyncroot/contracts";
import type { GeminiSpeechConfig } from "./config.js";
import { validateProviderBaseUrl } from "./base-url.js";
import { postJson } from "./gemini-http.js";
import { isRiffWave, l16RateFromMimeType, readWavSampleRate, wrapL16AsWav } from "./wav.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const MAX_VOCABULARY = 100;
/** Callers send what browsers and devices call these formats; Gemini documents only the right-hand names. */
const MEDIA_TYPE_ALIASES: Readonly<Record<string, string>> = { "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/mp4": "audio/m4a", "audio/x-m4a": "audio/m4a" };

function providerMediaType(mediaType: string): string {
  const bare = mediaType.split(";")[0]!.trim().toLowerCase();
  return MEDIA_TYPE_ALIASES[bare] ?? bare;
}

interface ModelOutputStep { readonly type?: unknown; readonly content?: readonly { readonly type?: unknown; readonly text?: unknown }[] }
interface InlineData { readonly data?: unknown; readonly mimeType?: unknown; readonly mime_type?: unknown }
interface GenerateContentResponse {
  readonly candidates?: readonly { readonly content?: { readonly parts?: readonly { readonly inlineData?: InlineData; readonly inline_data?: InlineData }[] } }[];
}

/** Every text part of every `model_output` step, joined and trimmed. Empty when nothing was heard. */
function transcriptOf(response: unknown): string {
  const steps = (response as { steps?: readonly ModelOutputStep[] } | null)?.steps;
  if (!Array.isArray(steps)) return "";
  const parts: string[] = [];
  for (const step of steps) {
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const item of step.content) if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join(" ").trim();
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/**
 * Gemini speech over plain `fetch`: speech-to-text through the Interactions API (stateless,
 * `store:false`) and text-to-speech through `generateContent`. The key is sent only in the
 * `x-goog-api-key` header and never appears in a URL or an error.
 */
export class GeminiSpeechAdapter implements SpeechToText, TextToSpeech {
  readonly providerId = "gemini";
  readonly #apiKey: string;
  private readonly baseUrl: string;
  private readonly sttApi: "transcribe" | "prompt";
  private readonly sttModel: string;
  private readonly transcriptionMode: "smart" | "verbatim";
  private readonly ttsModel: string;
  private readonly defaultVoice: string;
  private readonly defaultStyle: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GeminiSpeechConfig) {
    if (typeof config.apiKey !== "string" || !config.apiKey.trim()) throw new AgenticError("validation", "Gemini speech requires an API key");
    this.#apiKey = config.apiKey.trim();
    this.baseUrl = validateProviderBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.sttApi = config.sttApi ?? "transcribe";
    this.sttModel = config.sttModel ?? "gemini-3.5-transcribe";
    this.transcriptionMode = config.transcriptionMode ?? "smart";
    this.ttsModel = config.ttsModel ?? "gemini-3.8-flash-lite-tts";
    this.defaultVoice = config.defaultVoice ?? "Kore";
    this.defaultStyle = config.defaultStyle;
    this.timeoutMs = config.timeoutMs ?? 12_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new AgenticError("validation", "timeoutMs must be a positive integer");
    this.fetchImpl = config.fetch ?? fetch;
    if (!/^[A-Za-z0-9._-]+$/u.test(this.sttModel) || !/^[A-Za-z0-9._-]+$/u.test(this.ttsModel)) {
      throw new AgenticError("validation", "Model ids may only contain letters, digits, dot, underscore and hyphen");
    }
  }

  async transcribe(request: SpeechTranscriptionRequest, signal: AbortSignal): Promise<SpeechTranscription> {
    const audio = { type: "audio", data: toBase64(request.audio), mime_type: providerMediaType(request.mediaType) };
    const vocabulary = (request.vocabulary ?? []).filter((term) => term.trim()).slice(0, MAX_VOCABULARY);
    const body = this.sttApi === "prompt"
      ? { model: this.sttModel, store: false, input: [{ type: "text", text: promptInstruction(request.languageCodes, vocabulary) }, audio] }
      : {
        model: this.sttModel,
        store: false,
        input: [audio],
        generation_config: {
          transcription_config: {
            language_codes: [...request.languageCodes],
            ...(vocabulary.length ? { custom_vocabulary: vocabulary } : {}),
            mode: this.transcriptionMode === "verbatim" ? { type: "verbatim" } : "smart",
          },
        },
      };
    const response = await postJson({
      url: `${this.baseUrl}/v1beta/interactions`, apiKey: this.#apiKey, body, timeoutMs: this.timeoutMs, signal,
      fetchImpl: this.fetchImpl, operation: "Gemini transcription",
    });
    return { text: transcriptOf(response), modelId: this.sttModel };
  }

  async synthesize(request: SpeechSynthesisRequest, signal: AbortSignal): Promise<SpeechSynthesis> {
    const style = request.style ?? this.defaultStyle;
    const body = {
      contents: [{ role: "user", parts: [{ text: request.text, ...(style ? { speech_metadata: { style } } : {}) }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { voice: request.voice ?? this.defaultVoice } },
      },
    };
    const response = await postJson({
      url: `${this.baseUrl}/v1beta/models/${this.ttsModel}:generateContent`, apiKey: this.#apiKey, body,
      timeoutMs: this.timeoutMs, signal, fetchImpl: this.fetchImpl, operation: "Gemini speech synthesis",
    }) as GenerateContentResponse;
    const inline = firstInlineAudio(response);
    if (!inline) throw new AgenticError("permanent", "Gemini speech synthesis returned no audio part");
    const bytes = new Uint8Array(Buffer.from(inline.data, "base64"));
    if (isRiffWave(bytes)) return { audio: bytes, mediaType: "audio/wav", sampleRateHz: readWavSampleRate(bytes), modelId: this.ttsModel };
    const mimeType = inline.mimeType ?? inline.mime_type;
    const sampleRateHz = l16RateFromMimeType(typeof mimeType === "string" ? mimeType : undefined);
    return { audio: wrapL16AsWav(bytes, sampleRateHz), mediaType: "audio/wav", sampleRateHz, modelId: this.ttsModel };
  }
}

function firstInlineAudio(response: GenerateContentResponse): (InlineData & { data: string }) | undefined {
  for (const part of response?.candidates?.[0]?.content?.parts ?? []) {
    const inline = part?.inlineData ?? part?.inline_data;
    if (inline && typeof inline.data === "string" && inline.data.length > 0) return inline as InlineData & { data: string };
  }
  return undefined;
}

function promptInstruction(languageCodes: readonly string[], vocabulary: readonly string[]): string {
  const language = languageCodes.length ? languageCodes.join(", ") : "the language spoken";
  const terms = vocabulary.length ? ` Terms that may occur: ${vocabulary.join(", ")}.` : "";
  return `Transcribe this audio verbatim in ${language}. Output only the transcript text. If there is no intelligible speech, output nothing.${terms}`;
}
