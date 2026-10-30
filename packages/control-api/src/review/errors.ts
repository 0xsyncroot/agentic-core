/** Error codes of the review HTTP surface, with the status each one answers with. */
export const REVIEW_ERROR_STATUS = Object.freeze({ unauthorized: 401, forbidden: 403, validation: 400, not_found: 404, internal: 500 });
export type ReviewErrorCode = keyof typeof REVIEW_ERROR_STATUS;

/** A refusal the console shows its reader. `message` is technical English for logs; the product supplies the words shown. */
export class ReviewRequestError extends Error {
  constructor(readonly code: Exclude<ReviewErrorCode, "internal">, message: string) {
    super(message);
    this.name = "ReviewRequestError";
  }
}
