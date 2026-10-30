/**
 * @internal Puts text on the clipboard, and says whether it got there.
 *
 * The async API first, bounded: on some embedded pages it neither resolves nor rejects. Then the
 * selection fallback, for pages that are not a secure context. Shared by the answer's copy action
 * and the table view's "Chép bảng".
 */
async function writeClipboardText(content: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await Promise.race([
        navigator.clipboard.writeText(content),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("Clipboard timeout")), 800)),
      ]);
      return true;
    }
  } catch { /* Fall back for non-secure embedded pages. */ }
  try {
    const fallback = document.createElement("textarea");
    fallback.value = content;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    fallback.style.pointerEvents = "none";
    (document.body ?? document.documentElement).append(fallback);
    fallback.select();
    const copied = document.execCommand("copy");
    fallback.remove();
    return copied;
  } catch { return false; }
}
