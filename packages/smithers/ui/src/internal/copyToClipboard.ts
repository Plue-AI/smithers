export type CopyFailureCode = "clipboard-unavailable" | "clipboard-write-failed";

export type CopyResult =
  | { ok: true; }
  | { ok: false; code: CopyFailureCode; cause: unknown; };

/** Await the host copy path and normalize every failure without exposing host text. */
export async function copyToClipboard(
  text: string,
  onCopy?: (text: string) => void | Promise<void>,
): Promise<CopyResult> {
  try {
    if (onCopy) {
      await onCopy(text);
      return { ok: true };
    }
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
      return legacyCopy(text);
    }
    await navigator.clipboard.writeText(text);
    return { ok: true };
  } catch (cause) {
    const fallback = legacyCopy(text);
    return fallback.ok ? fallback : { ok: false, code: "clipboard-unavailable", cause: fallback.cause ?? cause };
  }
}

/** Plain HTTP has no Clipboard API; keep selection and keyboard focus intact. */
function legacyCopy(text: string): CopyResult {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return { ok: false, code: "clipboard-unavailable", cause: undefined };
  }
  const focused = document.activeElement;
  const selection = document.getSelection();
  const ranges = Array.from({ length: selection?.rangeCount ?? 0 }, (_, index) => selection!.getRangeAt(index).cloneRange());
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("aria-hidden", "true");
  field.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  try {
    document.body.append(field);
    field.focus({ preventScroll: true });
    field.select();
    return document.execCommand("copy")
      ? { ok: true }
      : { ok: false, code: "clipboard-unavailable", cause: undefined };
  } catch (cause) {
    return { ok: false, code: "clipboard-unavailable", cause };
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
  }
}

/** Copy through the host Clipboard API or the plain-HTTP fallback. */
export const copyText = copyToClipboard;

/** Whether either shared copy path is available in this browser. */
export const canCopyText = (): boolean =>
 typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function" ||
 typeof document !== "undefined" && typeof document.execCommand === "function";

/** Reserve native activation now, then copy only the admitted command's text. */
export function reserveCopyText(): { copyText(text: string): Promise<void>; release(): void } | undefined {
 if (typeof navigator === "undefined" || typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return undefined;
 let resolve!: (blob: Blob) => void;
 let reject!: (cause: Error) => void;
 let consumed = false;
 const data = new Promise<Blob>((done, failed) => { resolve = done; reject = failed; });
 void data.catch(() => {});
 let writing: Promise<void>;
 try { writing = navigator.clipboard.write([new ClipboardItem({ "text/plain": data })]); }
 catch (cause) { writing = Promise.reject(cause); }
 void writing.catch(() => {});
 return {
  copyText: async text => {
   consumed = true; resolve(new Blob([text], { type: "text/plain" }));
   await writing;
  },
  release: () => { if (!consumed) reject(new Error("The command was not accepted")); }
 };
}
