import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { createStubDom, type StubNode } from "./dom-stub.js";

/**
 * Pasting into the composer, through the built bundle.
 *
 * What a user feels: a screenshot pasted with Ctrl+V lands in the tray and travels with the turn as
 * a file; a paste the browser could not read, or a file the widget refuses, is said in the composer
 * instead of nothing happening. The clipboards below are the shapes browsers really hand over —
 * Windows Chrome gives a screenshot as one `file` item, `image.png`; Chrome on a Linux desktop
 * under WSL is given only an empty `text/plain` for the same screenshot.
 */

interface Widget {
  open(): void;
  send(content: string): Promise<void>;
  getAttachments(): readonly { readonly name: string; readonly type: string; readonly size: number; readonly source: string }[];
  destroy(): void;
}

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));

/** Objects made inside the widget's realm, as plain data of this one. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** A clipboard as a paste event's `clipboardData` exposes it. */
function clipboard(entries: { readonly files?: readonly File[]; readonly filesOnly?: boolean; readonly text?: Readonly<Record<string, string>> }) {
  const files = entries.files ?? [];
  const text = entries.text ?? {};
  const items = [
    ...(entries.filesOnly ? [] : files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file }))),
    ...Object.keys(text).map((type) => ({ kind: "string", type, getAsFile: () => null })),
  ];
  return { items, files, types: [...(files.length ? ["Files"] : []), ...Object.keys(text)], getData: (type: string) => text[type] ?? "" };
}

/**
 * The browser's image codec, as far as the widget uses it: `createImageBitmap` decodes to the given size, and a canvas
 * encodes to the given number of bytes per type. A type left out is one the browser cannot write, and — as browsers do —
 * it writes PNG instead.
 */
interface ImageCodec {
  readonly width: number;
  readonly height: number;
  readonly bytes: Readonly<Partial<Record<"image/webp" | "image/jpeg" | "image/png", number>>>;
  readonly transparent?: boolean;
  readonly decodeDelayMs?: number;
}

function imageCodec(dom: ReturnType<typeof createStubDom>, codec: ImageCodec) {
  const drawn: { width: number; height: number }[] = [];
  const encoded: { type: string; quality?: number }[] = [];
  const orientations: unknown[] = [];
  const create = dom.document.createElement as (tag: string) => unknown;
  dom.document.createElement = (tag: string) => {
    if (String(tag).toLowerCase() !== "canvas") return create(tag);
    const canvas = {
      width: 0, height: 0,
      getContext: () => ({
        drawImage: () => { drawn.push({ width: canvas.width, height: canvas.height }); },
        getImageData: () => ({ data: Uint8ClampedArray.of(255, 255, 255, codec.transparent ? 0 : 255) }),
      }),
      toBlob: (done: (blob: Blob | null) => void, type: string, quality?: number) => {
        encoded.push({ type, ...(quality === undefined ? {} : { quality }) });
        const written = codec.bytes[type as keyof ImageCodec["bytes"]] === undefined ? "image/png" : type;
        done(new Blob([new Uint8Array(codec.bytes[written as keyof ImageCodec["bytes"]] ?? 1)], { type: written }));
      },
    };
    return canvas;
  };
  const createImageBitmap = async (_file: Blob, options?: { imageOrientation?: string }) => {
    orientations.push(options?.imageOrientation);
    if (codec.decodeDelayMs) await new Promise((resolve) => setTimeout(resolve, codec.decodeDelayMs));
    return { width: codec.width, height: codec.height, close: () => undefined };
  };
  return { createImageBitmap, drawn, encoded, orientations };
}

async function mount(images?: ImageCodec) {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const codec = images ? imageCodec(dom, images) : undefined;
  const context = createContext({
    ...dom.window, ...(codec ? { createImageBitmap: codec.createImageBitmap } : {}),
    document: dom.document, URL, Headers, Response, TextDecoder, DOMException, File, Blob,
    AbortController, AbortSignal, setTimeout, clearTimeout, crypto,
    location: { origin: "https://example.test", href: "https://example.test/app/", assign: () => undefined },
    CustomEvent: class { readonly type: string; readonly detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    Event: class { readonly type: string; constructor(type: string) { this.type = type; } },
  });
  const scope = context as unknown as Record<string, unknown>;
  scope.window = context;
  scope.globalThis = context;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);
  const sent: { request: Record<string, unknown>; files?: ReadonlyMap<string, File> }[] = [];
  const errors: { name: string; message: string }[] = [];
  const transport = {
    checkConnection: async () => ({ status: "ok" }),
    loadHistory: async () => [],
    send: async (request: Record<string, unknown>, operation: { attachmentFiles?: ReadonlyMap<string, File> }) => {
      sent.push({ request, ...(operation.attachmentFiles ? { files: operation.attachmentFiles } : {}) });
      return { content: "xong", sessionId: String(request.sessionId), turnId: "t1", outcome: "completed" };
    },
  };
  const api = (context as unknown as { AgentChat: { create(options: Record<string, unknown>): Widget } }).AgentChat;
  const widget = api.create({ transport, sessionId: "session-a", onError: (error: Error) => errors.push({ name: error.name, message: error.message }) });
  widget.open();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const input = dom.document.querySelector("textarea") as unknown as StubNode;
  const notice = dom.document.querySelector(".acw-attachment-notice") as unknown as StubNode;
  return {
    widget, sent, errors, dom, codec,
    /** Raises a paste at the composer; says whether the widget took the paste over from the browser. */
    paste: async (clipboardData: ReturnType<typeof clipboard>): Promise<boolean> => {
      let prevented = false;
      input.dispatchEvent({ type: "paste", clipboardData, preventDefault: () => { prevented = true; } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return prevented;
    },
    chips: () => dom.document.querySelectorAll(".acw-attachment-chip") as unknown as StubNode[],
    notice: () => (notice.hidden ? "" : notice.textContent ?? ""),
  };
}

test("a screenshot pasted from the clipboard joins the tray and goes up with the turn as a file", async () => {
  const harness = await mount();
  try {
    const screenshot = new File([PNG], "image.png", { type: "image/png" });
    assert.equal(await harness.paste(clipboard({ files: [screenshot] })), true, "the widget takes the paste over: the image is not pasted as text");
    assert.deepEqual(plain(harness.widget.getAttachments().map(({ name, type, source }) => ({ name, type, source }))),
      [{ name: "image.png", type: "image/png", source: "paste" }]);
    assert.equal(harness.chips().length, 1);
    assert.equal(harness.chips()[0]!.dataset.kind, "image", "an image shows as a thumbnail");
    assert.equal(harness.notice(), "");
    await harness.widget.send("Ảnh này có gì?");
    const [turn] = harness.sent;
    assert.equal((turn!.request.attachments as unknown[]).length, 1);
    assert.equal([...turn!.files!.values()][0], screenshot, "the bytes travel with the turn, not only a name");
  } finally { harness.widget.destroy(); }
});

test("a pasted image with no name is still attached, named the way browsers name one", async () => {
  const harness = await mount();
  try {
    assert.equal(await harness.paste(clipboard({ files: [new File([PNG], "", { type: "image/png" })] })), true);
    assert.deepEqual(plain(harness.widget.getAttachments().map(({ name, type }) => ({ name, type }))), [{ name: "image.png", type: "image/png" }]);
  } finally { harness.widget.destroy(); }
});

test("a file a browser lists only under clipboardData.files is attached as well", async () => {
  const harness = await mount();
  try {
    assert.equal(await harness.paste(clipboard({ files: [new File([PNG], "chup.png", { type: "image/png" })], filesOnly: true })), true);
    assert.equal(harness.widget.getAttachments().length, 1);
  } finally { harness.widget.destroy(); }
});

test("a paste that brings nothing readable is said in the composer, not met with silence", async () => {
  const harness = await mount();
  try {
    // Chrome under WSLg for a Windows screenshot: one text/plain entry, empty.
    assert.equal(await harness.paste(clipboard({ text: { "text/plain": "" } })), false);
    assert.equal(harness.widget.getAttachments().length, 0);
    assert.match(harness.notice(), /bộ nhớ tạm/u);
    assert.deepEqual(harness.errors.map((error) => error.name), ["AgentChatAttachmentError"],
      "a host can tell it from a lost connection");
  } finally { harness.widget.destroy(); }
});

test("pasting text stays a text paste", async () => {
  const harness = await mount();
  try {
    assert.equal(await harness.paste(clipboard({ text: { "text/plain": "Bảng lương tháng 9" } })), false);
    assert.equal(harness.widget.getAttachments().length, 0);
    assert.equal(harness.notice(), "");
    assert.equal(harness.errors.length, 0);
  } finally { harness.widget.destroy(); }
});

test("a refused file says why in the composer, and the next good file clears it", async () => {
  const harness = await mount();
  try {
    await harness.paste(clipboard({ files: [new File([PNG], "nen.zip", { type: "application/zip" })] }));
    assert.equal(harness.widget.getAttachments().length, 0);
    assert.match(harness.notice(), /không được hỗ trợ: nen\.zip/u);
    await harness.paste(clipboard({ files: [new File([PNG], "image.png", { type: "image/png" })] }));
    assert.equal(harness.widget.getAttachments().length, 1);
    assert.equal(harness.notice(), "");
  } finally { harness.widget.destroy(); }
});

/**
 * A pasted image is made light before it goes: the model reads it on every request of the turn, and a provider spends time
 * on its bytes each time (docs/incidents/2026-10-12-shared-widget-image-weight.md). Byte counts below are what real
 * encoders produced for real screenshots, or round figures; the codec itself is the stub above.
 */
const bytes = (size: number) => new Uint8Array(size);
const sentFile = (harness: Awaited<ReturnType<typeof mount>>) => [...harness.sent[0]!.files!.values()][0]!;

test("a pasted image larger than 2000 px is scaled down and goes as the smallest encoding, named for it", async () => {
  const harness = await mount({ width: 4000, height: 3000, bytes: { "image/webp": 300_000, "image/jpeg": 400_000, "image/png": 900_000 } });
  try {
    await harness.paste(clipboard({ files: [new File([bytes(3_000_000)], "image.png", { type: "image/png" })] }));
    assert.deepEqual(harness.codec!.drawn, [{ width: 2000, height: 1500 }]);
    assert.deepEqual(harness.codec!.orientations, ["from-image"], "a photo stays upright once its metadata is gone");
    assert.deepEqual(plain(harness.widget.getAttachments().map(({ name, type, size }) => ({ name, type, size }))),
      [{ name: "image.webp", type: "image/webp", size: 300_000 }]);
    await harness.widget.send("Ảnh này có gì?");
    assert.equal(sentFile(harness).type, "image/webp");
    assert.equal(sentFile(harness).size, 300_000);
    assert.equal(sentFile(harness).name, "image.webp");
  } finally { harness.widget.destroy(); }
});

test("a transparent image is never made JPEG, which would lose its alpha", async () => {
  const harness = await mount({ width: 2500, height: 1000, transparent: true, bytes: { "image/png": 500_000, "image/jpeg": 1_000 } });
  try {
    await harness.paste(clipboard({ files: [new File([bytes(2_000_000)], "logo.png", { type: "image/png" })] }));
    assert.ok(!harness.codec!.encoded.some((entry) => entry.type === "image/jpeg"));
    assert.deepEqual(plain(harness.widget.getAttachments().map(({ name, type, size }) => ({ name, type, size }))),
      [{ name: "logo.png", type: "image/png", size: 500_000 }], "a browser without WebP writes PNG, at 2000 px");
  } finally { harness.widget.destroy(); }
});

test("a screenshot within the edge keeps its own file unless another encoding is a tenth smaller", async () => {
  // 1440 x 857, as captured live: PNG 237,598 bytes, JPEG q85 277,173, WebP q85 137,496.
  const original = new File([bytes(237_598)], "image.png", { type: "image/png" });
  const without = await mount({ width: 1440, height: 857, bytes: { "image/jpeg": 277_173, "image/png": 257_650 } });
  try {
    await without.paste(clipboard({ files: [original] }));
    await without.widget.send("Ảnh này có gì?");
    assert.equal(sentFile(without), original, "no WebP in this browser, and JPEG is larger than the PNG: the file goes as it was");
  } finally { without.widget.destroy(); }
  const withWebp = await mount({ width: 1440, height: 857, bytes: { "image/webp": 137_496, "image/jpeg": 277_173, "image/png": 257_650 } });
  try {
    await withWebp.paste(clipboard({ files: [original] }));
    assert.deepEqual(withWebp.codec!.drawn, [{ width: 1440, height: 857 }], "not scaled: only encoded again");
    await withWebp.widget.send("Ảnh này có gì?");
    assert.deepEqual([sentFile(withWebp).type, sentFile(withWebp).size], ["image/webp", 137_496]);
  } finally { withWebp.widget.destroy(); }
});

test("a small image goes as it is, without being decoded", async () => {
  const harness = await mount({ width: 480, height: 200, bytes: { "image/webp": 10, "image/jpeg": 10 } });
  try {
    const small = new File([bytes(6_521)], "image.png", { type: "image/png" });
    await harness.paste(clipboard({ files: [small] }));
    assert.equal(harness.codec!.drawn.length, 0);
    await harness.widget.send("Ảnh này có gì?");
    assert.equal(sentFile(harness), small);
  } finally { harness.widget.destroy(); }
});

test("a photo over the attachment limit is taken once scaled under it", async () => {
  const harness = await mount({ width: 6000, height: 4000, bytes: { "image/webp": 450_000, "image/jpeg": 600_000 } });
  try {
    await harness.paste(clipboard({ files: [new File([bytes(12 * 1024 * 1024)], "anh.jpg", { type: "image/jpeg" })] }));
    assert.equal(harness.notice(), "");
    assert.deepEqual(plain(harness.widget.getAttachments().map(({ name, size }) => ({ name, size }))), [{ name: "anh.webp", size: 450_000 }]);
  } finally { harness.widget.destroy(); }
});

test("a send pressed while an image is still being made lighter waits for it", async () => {
  const harness = await mount({ width: 4000, height: 3000, decodeDelayMs: 30, bytes: { "image/webp": 300_000, "image/jpeg": 400_000 } });
  try {
    await harness.paste(clipboard({ files: [new File([bytes(3_000_000)], "image.png", { type: "image/png" })] }));
    assert.equal(harness.widget.getAttachments().length, 0, "still decoding");
    await harness.widget.send("Ảnh này có gì?");
    assert.equal((harness.sent[0]!.request.attachments as unknown[]).length, 1);
    assert.equal(sentFile(harness).size, 300_000);
  } finally { harness.widget.destroy(); }
});
