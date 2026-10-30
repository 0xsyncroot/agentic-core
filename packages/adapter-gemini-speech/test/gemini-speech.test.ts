import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import { AgenticError } from "@0xsyncroot/contracts";
import { GeminiSpeechAdapter, loadGeminiSpeechConfig } from "../src/index.js";

const KEY = "test-gemini-key-not-real-0123456789";
const request = { audio: new Uint8Array([1, 2, 3, 4]), mediaType: "audio/wav", languageCodes: ["vi-VN"] };

interface Captured { url: string; init: RequestInit; body: any }
function fakeFetch(respond: (call: Captured) => Response | Promise<Response>): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const call = { url: String(input), init, body: JSON.parse(String(init.body)) };
    calls.push(call);
    return respond(call);
  };
  return { fetch: impl as typeof fetch, calls };
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const interaction = (...texts: string[]) => ({ id: "interactions/x", status: "completed", steps: [{ id: "s1", type: "model_output", content: texts.map((text) => ({ type: "text", text })) }] });
const adapter = (fetchImpl: typeof fetch, extra: object = {}) => new GeminiSpeechAdapter({ apiKey: KEY, fetch: fetchImpl, ...extra });
const signal = () => new AbortController().signal;
async function rejection(promise: Promise<unknown>): Promise<AgenticError> {
  try { await promise; } catch (error) { assert.ok(error instanceof AgenticError); return error; }
  throw new assert.AssertionError({ message: "expected a rejection" });
}

function riff(rate: number, pcmBytes = 8, junk = false): Uint8Array {
  const chunks: number[][] = [];
  if (junk) chunks.push([...Buffer.from("JUNK"), 4, 0, 0, 0, 9, 9, 9, 9]);
  const fmt = Buffer.alloc(24); fmt.write("fmt ", 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(rate, 12); fmt.writeUInt32LE(rate * 2, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const data = Buffer.alloc(8 + pcmBytes); data.write("data", 0); data.writeUInt32LE(pcmBytes, 4);
  const body = Buffer.concat([Buffer.from("WAVE"), ...chunks.map((c) => Buffer.from(c)), fmt, data]);
  const head = Buffer.alloc(8); head.write("RIFF", 0); head.writeUInt32LE(body.length, 4);
  return new Uint8Array(Buffer.concat([head, body]));
}
const audioResponse = (bytes: Uint8Array, mimeType?: string) => ({
  candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from(bytes).toString("base64"), ...(mimeType ? { mimeType } : {}) } }] } }],
});

test("transcribe sends the documented body with store:false and the key only in a header", async () => {
  const { fetch, calls } = fakeFetch(() => json(interaction("xin chào")));
  const result = await adapter(fetch).transcribe({ ...request, vocabulary: ["UBND", "khai sinh"] }, signal());
  assert.deepEqual(result, { text: "xin chào", modelId: "gemini-3.5-transcribe" });
  const [call] = calls;
  assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.ok(!call.url.includes(KEY));
  assert.equal((call.init.headers as Record<string, string>)["x-goog-api-key"], KEY);
  assert.equal(call.body.store, false);
  assert.deepEqual(call.body, {
    model: "gemini-3.5-transcribe", store: false,
    input: [{ type: "audio", data: "AQIDBA==", mime_type: "audio/wav" }],
    generation_config: { transcription_config: { language_codes: ["vi-VN"], custom_vocabulary: ["UBND", "khai sinh"], mode: "smart" } },
  });
});

test("verbatim mode is an object, empty vocabulary is omitted, vocabulary is capped at 100", async () => {
  const { fetch, calls } = fakeFetch(() => json(interaction("a")));
  await adapter(fetch, { transcriptionMode: "verbatim" }).transcribe(request, signal());
  const config = calls[0].body.generation_config.transcription_config;
  assert.deepEqual(config.mode, { type: "verbatim" });
  assert.equal("custom_vocabulary" in config, false);
  await adapter(fetch).transcribe({ ...request, vocabulary: Array.from({ length: 150 }, (_, i) => `t${i}`) }, signal());
  assert.equal(calls[1].body.generation_config.transcription_config.custom_vocabulary.length, 100);
});

test("prompt mode sends an instruction plus the audio, with store:false", async () => {
  const { fetch, calls } = fakeFetch(() => json(interaction("xin chào")));
  const result = await adapter(fetch, { sttApi: "prompt", sttModel: "gemini-3.8-flash" }).transcribe({ ...request, vocabulary: ["UBND", "CCCD"] }, signal());
  assert.equal(result.modelId, "gemini-3.8-flash");
  const body = calls[0].body;
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(body.store, false);
  assert.equal(body.generation_config, undefined);
  assert.equal(body.input[0].type, "text");
  assert.match(body.input[0].text, /^Transcribe this audio verbatim in vi-VN\. Output only the transcript text\. If there is no intelligible speech, output nothing\. Terms that may occur: UBND, CCCD\.$/u);
  assert.deepEqual(body.input[1], { type: "audio", data: "AQIDBA==", mime_type: "audio/wav" });
});

test("multi-part text is joined and trimmed; non-model steps are ignored", async () => {
  const { fetch } = fakeFetch(() => json({ steps: [{ type: "thought", content: [{ type: "text", text: "ignore" }] }, ...interaction(" một ", "hai ").steps] }));
  assert.equal((await adapter(fetch).transcribe(request, signal())).text, "một  hai");
});

test("an empty transcript is a result, not an error", async () => {
  for (const body of [interaction(""), interaction("   "), { steps: [] }, {}]) {
    const { fetch } = fakeFetch(() => json(body));
    assert.deepEqual(await adapter(fetch).transcribe(request, signal()), { text: "", modelId: "gemini-3.5-transcribe" });
  }
});

test("status codes map to transient or permanent per the contract", async () => {
  const cases: [number, unknown, string][] = [
    [408, { error: { code: "timeout", message: "slow" } }, "transient"],
    [429, { error: { code: "rate_limit_exceeded", message: "slow down" } }, "transient"],
    [429, { error: { code: 429, message: "x", status: "RESOURCE_EXHAUSTED" } }, "transient"],
    [500, {}, "transient"], [503, {}, "transient"], [529, {}, "transient"],
    [429, { error: { code: "quota_exceeded", message: "daily" } }, "permanent"],
    [400, { error: { code: "invalid_request", message: "bad" } }, "permanent"],
    [401, {}, "permanent"], [402, {}, "permanent"], [403, {}, "permanent"], [404, {}, "permanent"], [409, {}, "permanent"], [422, {}, "permanent"],
  ];
  for (const [status, body, code] of cases) {
    const { fetch } = fakeFetch(() => json(body, status));
    const error = await rejection(adapter(fetch).transcribe(request, signal()));
    assert.equal(error.code, code, `HTTP ${status} ${JSON.stringify(body)}`);
    assert.equal(error.retryable, code === "transient");
    assert.match(error.message, new RegExp(`HTTP ${status}`, "u"));
  }
  const { fetch } = fakeFetch(() => json({ error: { code: "invalid_request", message: "The value 'x' is not supported" } }, 400));
  assert.match((await rejection(adapter(fetch).synthesize({ text: "a" }, signal()))).message, /not supported/u);
});

test("a network failure is transient and the key never appears in any error", async () => {
  const failing = (async () => { throw new TypeError(`connect ECONNREFUSED using ${KEY}`); }) as typeof fetch;
  const network = await rejection(adapter(failing).transcribe(request, signal()));
  assert.equal(network.code, "transient");
  const echoing = fakeFetch(() => json({ error: { code: "invalid_request", message: `bad key ${KEY}` } }, 400));
  const echoed = await rejection(adapter(echoing.fetch).synthesize({ text: "a" }, signal()));
  for (const error of [network, echoed]) assert.ok(!error.message.includes(KEY), error.message);
  const notJson = fakeFetch(() => new Response("<html>", { status: 200 }));
  assert.equal((await rejection(adapter(notJson.fetch).transcribe(request, signal()))).code, "permanent");
});

test("the adapter's own deadline is timeout, the caller's abort is cancelled", async () => {
  const hanging = ((_url: string, init: RequestInit) => new Promise((_, reject) => {
    init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as unknown as typeof fetch;
  const timeout = await rejection(adapter(hanging, { timeoutMs: 20 }).transcribe(request, signal()));
  assert.equal(timeout.code, "timeout");
  assert.equal(timeout.retryable, false);
  const controller = new AbortController();
  const pending = rejection(adapter(hanging, { timeoutMs: 5000 }).synthesize({ text: "a" }, controller.signal));
  controller.abort();
  assert.equal((await pending).code, "cancelled");
  const already = AbortSignal.abort();
  assert.equal((await rejection(adapter(hanging).transcribe(request, already))).code, "cancelled");
});

test("synthesize sends the documented body and passes RIFF through with the rate from fmt", async () => {
  const wav = riff(16000, 8, true);
  const { fetch, calls } = fakeFetch(() => json(audioResponse(wav, "audio/wav")));
  const result = await adapter(fetch, { defaultStyle: "warm" }).synthesize({ text: "xin chào" }, signal());
  assert.deepEqual(Buffer.from(result.audio), Buffer.from(wav));
  assert.equal(result.sampleRateHz, 16000);
  assert.equal(result.mediaType, "audio/wav");
  assert.equal(result.modelId, "gemini-3.8-flash-lite-tts");
  const [call] = calls;
  assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent");
  assert.equal((call.init.headers as Record<string, string>)["x-goog-api-key"], KEY);
  assert.deepEqual(call.body, {
    contents: [{ role: "user", parts: [{ text: "xin chào", speech_metadata: { style: "warm" } }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { voice: "Kore" } } },
  });
});

test("style and voice: request overrides defaults; speech_metadata is omitted with no style", async () => {
  const { fetch, calls } = fakeFetch(() => json(audioResponse(riff(24000))));
  await adapter(fetch).synthesize({ text: "a" }, signal());
  assert.equal("speech_metadata" in calls[0].body.contents[0].parts[0], false);
  await adapter(fetch, { defaultVoice: "Puck", defaultStyle: "calm" }).synthesize({ text: "a", voice: "Zephyr", style: "brisk" }, signal());
  assert.equal(calls[1].body.generationConfig.speechConfig.voiceConfig.voice, "Zephyr");
  assert.equal(calls[1].body.contents[0].parts[0].speech_metadata.style, "brisk");
});

test("L16 audio is wrapped as a 44-byte mono WAV with the rate from the mimeType", async () => {
  const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
  const { fetch } = fakeFetch(() => json(audioResponse(pcm, "audio/L16;codec=pcm;rate=22050")));
  const result = await adapter(fetch).synthesize({ text: "a" }, signal());
  const bytes = Buffer.from(result.audio);
  assert.equal(result.sampleRateHz, 22050);
  assert.equal(bytes.length, 44 + 8);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.readUInt32LE(4), 36 + 8);
  assert.equal(bytes.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(bytes.readUInt16LE(20), 1);
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 22050);
  assert.equal(bytes.readUInt32LE(28), 44100);
  assert.equal(bytes.readUInt16LE(32), 2);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.toString("ascii", 36, 40), "data");
  assert.equal(bytes.readUInt32LE(40), 8);
  assert.deepEqual(bytes.subarray(44), Buffer.from(pcm));
});

test("L16 without a rate parameter defaults to 24000; a bare AUDIO_L16 mimeType too", async () => {
  for (const mime of [undefined, "AUDIO_L16", "audio/L16;codec=pcm"]) {
    const { fetch } = fakeFetch(() => json(audioResponse(new Uint8Array([0, 0, 1, 0]), mime)));
    assert.equal((await adapter(fetch).synthesize({ text: "a" }, signal())).sampleRateHz, 24000);
  }
});

test("a TTS response with no audio part is permanent", async () => {
  for (const body of [{ candidates: [] }, { candidates: [{ content: { parts: [{ text: "no" }] } }] }, {}]) {
    const { fetch } = fakeFetch(() => json(body));
    const error = await rejection(adapter(fetch).synthesize({ text: "a" }, signal()));
    assert.equal(error.code, "permanent");
  }
});

test("baseUrl must be https, or loopback http, without credentials", () => {
  const ok = (baseUrl: string) => new GeminiSpeechAdapter({ apiKey: KEY, baseUrl });
  ok("https://example.test"); ok("http://127.0.0.1:4711"); ok("http://localhost:4711/");
  for (const bad of ["http://example.test", "ftp://x", "https://user:pw@example.test", "https://example.test/?key=abc", "not a url", "http://127.0.0.1.evil.test"]) {
    assert.throws(() => ok(bad), (error: unknown) => error instanceof AgenticError && error.code === "validation" && !error.message.includes("pw"), bad);
  }
  assert.throws(() => new GeminiSpeechAdapter({ apiKey: "  " }), AgenticError);
});

test("a custom baseUrl is used verbatim, trailing slash trimmed", async () => {
  const { fetch, calls } = fakeFetch(() => json(interaction("a")));
  await adapter(fetch, { baseUrl: "http://127.0.0.1:4711/" }).transcribe(request, signal());
  assert.equal(calls[0].url, "http://127.0.0.1:4711/v1beta/interactions");
});

async function loader(yaml: string, env: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), "speech-yaml-"));
  const path = join(dir, "speech.yaml");
  await writeFile(path, yaml);
  return loadGeminiSpeechConfig(path, env);
}

test("loader: absent file is undefined; a full file resolves with the key from env", async () => {
  assert.equal(await loadGeminiSpeechConfig(join(tmpdir(), "no-such-dir-speech", "speech.yaml"), {}), undefined);
  const settings = await loader(`
enabled: true
apiKeyEnv: GEMINI_API_KEY
baseUrl: http://127.0.0.1:4711
stt:
  api: prompt
  model: gemini-3.8-flash
  mode: verbatim
  languageCodes: [vi-VN]
  vocabulary: [UBND, CCCD]
tts:
  model: gemini-3.8-flash-lite-tts
  voice: Kore
  style: "warm and calm"
timeoutMs: 9000
`, { GEMINI_API_KEY: ` ${KEY} ` });
  assert.deepEqual(settings, {
    enabled: true, apiKeyEnv: "GEMINI_API_KEY", apiKey: KEY,
    adapter: {
      baseUrl: "http://127.0.0.1:4711", sttApi: "prompt", sttModel: "gemini-3.8-flash", transcriptionMode: "verbatim",
      ttsModel: "gemini-3.8-flash-lite-tts", defaultVoice: "Kore", defaultStyle: "warm and calm", timeoutMs: 9000,
    },
    languageCodes: ["vi-VN"], vocabulary: ["UBND", "CCCD"],
  });
});

test("loader: defaults, and no apiKey when the env var is unset or blank", async () => {
  for (const env of [{}, { GEMINI_API_KEY: "  " }]) {
    const settings = await loader("stt:\n  languageCodes: [vi-VN]\n", env);
    assert.equal(settings?.enabled, true);
    assert.equal(settings?.apiKeyEnv, "GEMINI_API_KEY");
    assert.equal("apiKey" in settings!, false);
    assert.deepEqual(settings?.adapter, {});
    assert.deepEqual(settings?.vocabulary, []);
  }
  assert.equal((await loader("enabled: false\n"))?.enabled, false);
});

test("loader rejects unknown keys, substitution, a literal key and bad values", async () => {
  const rejects: [string, RegExp][] = [
    ["surprise: 1\n", /surprise is not a known key/u],
    ["stt:\n  extra: 1\n", /stt\.extra/u],
    ["tts:\n  extra: 1\n", /tts\.extra/u],
    ["apiKey: AIzaSyLITERAL\n", /literal apiKey/u],
    ["tts:\n  api_key: x\n", /literal api_key/u],
    ["apiKeyEnv: AIzaSyLITERAL0123\n", /apiKeyEnv is invalid/u],
    ["apiKeyEnv: ${GEMINI_API_KEY}\n", /substitution/u],
    ["tts:\n  style: \"say ${x}\"\n", /substitution/u],
    ["stt:\n  vocabulary: [\"a\", \"${b}\"]\n", /substitution/u],
    ["baseUrl: http://example.test\n", /https/u],
    ["baseUrl: https://user:pw@example.test\n", /credentials/u],
    ["stt:\n  api: live\n", /stt\.api must be one of/u],
    ["stt:\n  mode: fast\n", /stt\.mode must be one of/u],
    ["stt:\n  languageCodes: vi-VN\n", /must be a list/u],
    ["stt:\n  languageCodes: [\"not a code\"]\n", /invalid/u],
    [`stt:\n  vocabulary: [${Array.from({ length: 101 }, (_, i) => `t${i}`).join(", ")}]\n`, /at most 100/u],
    ["timeoutMs: 5\n", /timeoutMs/u],
    ["enabled: yes please\n", /enabled must be true or false/u],
    ["- a\n- b\n", /must be a mapping/u],
    ["a: [unclosed\n", /not valid YAML/u],
  ];
  for (const [yaml, message] of rejects) await assert.rejects(loader(yaml), message, yaml);
});

test("the key does not appear when the adapter is serialised or inspected", () => {
  const instance = new GeminiSpeechAdapter({ apiKey: KEY });
  assert.ok(!JSON.stringify(instance).includes(KEY));
  assert.ok(!inspect(instance, { depth: 5, showHidden: true }).includes(KEY));
});

test("media types are sent under the names Gemini documents", async () => {
  const cases: [string, string][] = [
    ["audio/x-wav", "audio/wav"], ["audio/wav; codecs=1", "audio/wav"], ["audio/mp4", "audio/m4a"], ["Audio/MP4", "audio/m4a"],
    ["audio/ogg", "audio/ogg"], ["audio/webm", "audio/webm"], ["audio/aac", "audio/aac"],
  ];
  for (const [given, sent] of cases) {
    for (const sttApi of ["transcribe", "prompt"]) {
      const { fetch, calls } = fakeFetch(() => json(interaction("a")));
      await adapter(fetch, { sttApi }).transcribe({ ...request, mediaType: given }, signal());
      const audio = calls[0].body.input.find((item: { type: string }) => item.type === "audio");
      assert.equal(audio.mime_type, sent, `${sttApi} ${given}`);
    }
  }
});
