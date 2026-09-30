/*
 * Keeps every `smithers://` link the native wrapper hands over (#3061).
 *
 * Electrobun 2.0.1's wrapper calls its URL handler with a string it frees
 * right after the call: a cold-launch link from a vector it destroys, a
 * running-app link from an autoreleased NSString. The SDK's handler is a
 * threadsafe JSCallback, which only queues the pointer, so JS reads freed
 * memory. The copy must happen inside the native call, so the handler here
 * is a few lines of C (Bun's built-in compiler, no system headers needed)
 * that copies the link, then hands the copy to a threadsafe callback that
 * reads and frees it.
 *
 * `retainNativeUrlOpens` runs before `electrobun/main` loads: installing the
 * handler drains the links macOS delivered before launch, so the SDK's own
 * install finds nothing to lose. `install` runs right after the SDK loads and
 * puts this handler back in front of the SDK's.
 */
import { cc, CString, JSCallback, type Pointer } from "bun:ffi"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NativeUrlOpenHost } from "./NativeWrapper"

const SHIM = `typedef unsigned long size_t;
size_t strlen(const char *);
void *malloc(size_t);
void *memcpy(void *, const void *, size_t);
void free(void *);
typedef void (*Forward)(char *);
static Forward forward;
void smithers_set_forward(Forward next) { forward = next; }
static void smithers_url_open(const char *url) {
  if (url == 0) return;
  size_t size = strlen(url) + 1;
  char *copy = malloc(size);
  if (copy == 0) return;
  memcpy(copy, url, size);
  forward(copy);
}
void *smithers_url_open_address(void) { return (void *)smithers_url_open; }
void smithers_free(char *copy) { free(copy); }
`

const compileShim = () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-url-open-"))
  try {
    const source = join(directory, "url-open.c")
    writeFileSync(source, SHIM)
    return cc({
      source,
      symbols: {
        smithers_set_forward: { args: ["ptr"], returns: "void" },
        smithers_url_open_address: { args: [], returns: "ptr" },
        smithers_free: { args: ["ptr"], returns: "void" }
      }
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

// The native side holds these by address only; nothing may collect them for the process's life.
const retained: Array<object> = []

export interface RetainedUrlOpens {
  /** Puts this handler back in front of the one the SDK installed while it loaded. */
  readonly install: () => void
}

/** Installs the copying handler now, draining links buffered before launch; each arrives at `receive` as a task. */
export const retainNativeUrlOpens = (
  host: NativeUrlOpenHost,
  receive: (url: string) => void
): RetainedUrlOpens => {
  const shim = compileShim()
  const forward = new JSCallback(
    (copy: Pointer) => {
      const url = new CString(copy).toString()
      shim.symbols.smithers_free(copy)
      receive(url)
    },
    { args: ["ptr"], returns: "void", threadsafe: true }
  )
  retained.push(shim, forward)
  shim.symbols.smithers_set_forward(forward.ptr)
  const handler = shim.symbols.smithers_url_open_address() as Pointer
  host.setURLOpenHandler(handler)
  return { install: () => host.setURLOpenHandler(handler) }
}
