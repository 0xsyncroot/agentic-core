/**
 * Speech transcoding at the delivery edge. The agent loop stays text in, text out: a delivery
 * adapter turns an utterance into text before a turn and the turn's canonical answer into audio
 * after it. Nothing here reaches the model, the journal or a capability token.
 */
export interface SpeechTranscriptionRequest {
  /** One utterance, already size-bounded by the caller. */
  readonly audio: Uint8Array;
  /** e.g. "audio/wav", "audio/ogg", "audio/webm", "audio/mp4". */
  readonly mediaType: string;
  /** BCP-47 language codes, e.g. ["vi-VN"]. */
  readonly languageCodes: readonly string[];
  /** Proper nouns and domain terms that bias recognition. */
  readonly vocabulary?: readonly string[];
}

/** `text` is "" when the provider heard nothing intelligible: a result, not an error. */
export interface SpeechTranscription {
  readonly text: string;
  readonly modelId: string;
}

export interface SpeechToText {
  readonly providerId: string;
  transcribe(request: SpeechTranscriptionRequest, signal: AbortSignal): Promise<SpeechTranscription>;
}

export interface SpeechSynthesisRequest {
  /** Plain speakable text; the caller normalises markup and abbreviations. */
  readonly text: string;
  /** Provider voice name; the adapter's default when absent. */
  readonly voice?: string;
  /** Delivery direction; its meaning is provider-specific. */
  readonly style?: string;
}

export interface SpeechSynthesis {
  /** A complete RIFF/WAVE file. */
  readonly audio: Uint8Array;
  readonly mediaType: "audio/wav";
  readonly sampleRateHz: number;
  readonly modelId: string;
}

export interface TextToSpeech {
  readonly providerId: string;
  synthesize(request: SpeechSynthesisRequest, signal: AbortSignal): Promise<SpeechSynthesis>;
}
