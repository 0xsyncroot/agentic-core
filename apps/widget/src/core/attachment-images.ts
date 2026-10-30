/**
 * @internal Images the widget sends, made light enough to travel with every model step.
 *
 * The model reads an attached image as base64 on every request of the turn that reads it, and a provider spends time on
 * those bytes before its first token each time, and the format that comes out smallest is not always the same one
 * (measurement: docs/incidents/2026-10-12-shared-widget-image-weight.md). So an image is scaled down to `ATTACHMENT_IMAGE_MAX_EDGE` and, unless it is
 * already small, encoded again in whichever format comes out smallest. The screen capture draws through the same canvas code.
 */

/** @internal Longest edge, in pixels, of an image the widget sends; a larger one is scaled down to it. */
const ATTACHMENT_IMAGE_MAX_EDGE = 2000;
/** @internal At or under the edge and this size, an image goes as it is: encoding it again would save little. */
const ATTACHMENT_IMAGE_SMALL_BYTES = 100 * 1024;
/** @internal Quality of a lossy encoding. */
const ATTACHMENT_IMAGE_QUALITY = 0.85;
/** @internal Raster types the widget decodes and encodes again, with the extension each is named by. A GIF may move: it goes as it is. */
const ATTACHMENT_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** @internal A region of an image source, in its own pixels. */
interface ImageRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** @internal `region` of `source` on a canvas whose longest edge is at most `maxEdge`; undefined when the browser gives no 2D context. */
function scaledImageCanvas(source: CanvasImageSource, region: ImageRegion, maxEdge: number): HTMLCanvasElement | undefined {
  const scale = Math.min(1, maxEdge / Math.max(region.width, region.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(region.width * scale));
  canvas.height = Math.max(1, Math.round(region.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** @internal The canvas encoded, or undefined. A browser that cannot write `type` writes PNG instead, and the blob's type says so. */
function canvasImageBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | undefined> {
  return new Promise((resolve) => {
    try { canvas.toBlob((blob) => resolve(blob ?? undefined), type, quality); } catch { resolve(undefined); }
  });
}

/** @internal True when a pixel is not fully opaque, and when the pixels cannot be read: either way the alpha channel is kept. */
function canvasHasTransparency(canvas: HTMLCanvasElement): boolean {
  try {
    const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!data) return true;
    for (let index = 3; index < data.length; index += 4) if ((data[index] ?? 255) < 255) return true;
    return false;
  } catch { return true; }
}

/** @internal `name` with the extension of `type` in place of its own ("image.png" sent as WebP is "image.webp"). */
function imageFileName(name: string, type: string): string {
  const extension = ATTACHMENT_IMAGE_EXTENSIONS[type];
  if (!extension) return name;
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.${extension}`;
}

/**
 * @internal The image scaled down and encoded again, or the file as it was.
 *
 * Encoded as WebP and as JPEG — or as PNG when it has transparency, which JPEG would lose — keeping the smallest. A
 * screenshot is often smaller as PNG than as JPEG (the one measured: 237 KB against 277 KB), so an image that did not need
 * scaling keeps its own file unless another encoding is at least a tenth smaller. Another type, a browser that cannot
 * decode the file or will not encode the canvas: the file goes as it was, and whatever reads it says what it can.
 * EXIF orientation is applied while decoding, so a photo stays upright once its metadata is gone.
 */
async function compactImageFile(file: File, name: string): Promise<{ readonly file: File; readonly name: string }> {
  const unchanged = { file, name };
  const type = file.type.toLowerCase();
  if (!ATTACHMENT_IMAGE_EXTENSIONS[type] || typeof createImageBitmap !== "function") return unchanged;
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { return unchanged; }
  try {
    const scaled = Math.max(bitmap.width, bitmap.height) > ATTACHMENT_IMAGE_MAX_EDGE;
    if (!scaled && file.size <= ATTACHMENT_IMAGE_SMALL_BYTES) return unchanged;
    const canvas = scaledImageCanvas(bitmap, { x: 0, y: 0, width: bitmap.width, height: bitmap.height }, ATTACHMENT_IMAGE_MAX_EDGE);
    if (!canvas) return unchanged;
    const transparent = type !== "image/jpeg" && canvasHasTransparency(canvas);
    const encoded = [
      await canvasImageBlob(canvas, "image/webp", ATTACHMENT_IMAGE_QUALITY),
      transparent ? await canvasImageBlob(canvas, "image/png") : await canvasImageBlob(canvas, "image/jpeg", ATTACHMENT_IMAGE_QUALITY),
    ];
    let best: Blob | undefined;
    for (const blob of encoded) {
      if (blob && blob.size > 0 && ATTACHMENT_IMAGE_EXTENSIONS[blob.type] && (!best || blob.size < best.size)) best = blob;
    }
    if (!best || (!scaled && best.size > file.size * 0.9)) return unchanged;
    const renamed = imageFileName(name, best.type);
    return { file: new File([best], renamed, { type: best.type, lastModified: file.lastModified }), name: renamed };
  } catch {
    return unchanged;
  } finally {
    bitmap.close();
  }
}

/**
 * @internal One frame of a screen-share stream as a PNG within `ATTACHMENT_IMAGE_MAX_EDGE`, cropped to `crop.rect` (CSS pixels
 * of a page `crop.viewportWidth` × `crop.viewportHeight` wide) when given.
 */
async function captureStreamFrame(
  stream: MediaStream,
  crop?: { readonly rect: DOMRect; readonly viewportWidth: number; readonly viewportHeight: number },
): Promise<Blob> {
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  await new Promise<void>((resolve, reject) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error("Không đọc được hình ảnh màn hình.")), { once: true });
  });
  await video.play();
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) throw new Error("Kích thước ảnh chụp màn hình không hợp lệ.");
  let region: ImageRegion = { x: 0, y: 0, width: videoWidth, height: videoHeight };
  if (crop) {
    const scaleX = videoWidth / Math.max(1, crop.viewportWidth);
    const scaleY = videoHeight / Math.max(1, crop.viewportHeight);
    const x = Math.max(0, Math.round(crop.rect.left * scaleX));
    const y = Math.max(0, Math.round(crop.rect.top * scaleY));
    region = {
      x, y,
      width: Math.min(videoWidth - x, Math.max(1, Math.round(crop.rect.width * scaleX))),
      height: Math.min(videoHeight - y, Math.max(1, Math.round(crop.rect.height * scaleY))),
    };
  }
  const canvas = scaledImageCanvas(video, region, ATTACHMENT_IMAGE_MAX_EDGE);
  if (!canvas) throw new Error("Không thể tạo ảnh chụp màn hình.");
  const blob = await canvasImageBlob(canvas, "image/png");
  if (!blob) throw new Error("Không thể lưu ảnh chụp màn hình.");
  return blob;
}
