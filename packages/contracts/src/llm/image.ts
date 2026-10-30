import { AgenticError } from "../errors/agentic-error.js";

/** Image bytes, base64 encoded for JSON transport. They are never model text. */
export interface ModelImage {
  readonly mediaType: string;
  readonly data: string;
}

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGES_PER_RESULT = 8;

/** Validate at the tool boundary and on journal replay; refuse an incomplete image. */
export function parseModelImages(value: unknown): readonly ModelImage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_IMAGES_PER_RESULT) throw new AgenticError("validation", "Invalid image list");
  let total = 0;
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new AgenticError("validation", "Invalid image content");
    const { mediaType, data } = entry as ModelImage;
    if (typeof mediaType !== "string" || !/^image\/[a-zA-Z0-9.+-]{1,80}$/.test(mediaType) ||
        typeof data !== "string" || !data.length || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
        data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new AgenticError("validation", "Invalid or oversized image content");
    }
    const bytes = data.length * 3 / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) throw new AgenticError("validation", "Image content exceeds 4 MiB");
    total += bytes;
    if (total > 16 * 1024 * 1024) throw new AgenticError("validation", "Image content exceeds 16 MiB");
    return { mediaType, data };
  });
}
