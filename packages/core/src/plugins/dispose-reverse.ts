import type { Disposable } from "@0xsyncroot/plugin-sdk";

/** Dispose every item in LIFO order and report all failures after cleanup finishes. */
export async function disposeReverse(items: readonly Disposable[]): Promise<void> {
  const errors: unknown[] = [];
  for (const item of [...items].reverse()) {
    try {
      await item.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "One or more plugin resources failed to dispose");
  }
}
