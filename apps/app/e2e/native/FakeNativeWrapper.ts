/*
 * Electrobun 2.0.1's native URL door, reproduced with its string lifetime
 * (#3061). A link that arrives before a handler exists is buffered; installing
 * a handler calls it once per buffered link and then frees each one. A link
 * that arrives with a handler installed is passed from a temporary that is
 * freed when the call returns. Freed bytes are overwritten first, so a
 * handler that only queues the pointer reads garbage every time, not by luck.
 */
import { cc, type Pointer } from "bun:ffi"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NativeUrlOpenHost } from "../../src/bun/NativeWrapper"

const SOURCE = `typedef unsigned long size_t;
size_t strlen(const char *);
void *malloc(size_t);
void *memcpy(void *, const void *, size_t);
void *memset(void *, int, size_t);
void free(void *);
typedef void (*Handler)(const char *);
static Handler handler;
static char *pending[64];
static int pendingCount;
static char *copy(const char *url) {
  size_t size = strlen(url) + 1;
  char *out = malloc(size);
  memcpy(out, url, size);
  return out;
}
static void release(char *url) {
  memset(url, 'x', strlen(url));
  free(url);
}
void fake_set_url_open_handler(Handler next) {
  handler = next;
  int count = pendingCount;
  pendingCount = 0;
  for (int index = 0; index < count; index++) next(pending[index]);
  for (int index = 0; index < count; index++) release(pending[index]);
}
void fake_open_url(const char *url) {
  if (handler == 0) {
    if (pendingCount < 64) pending[pendingCount++] = copy(url);
    return;
  }
  char *temporary = copy(url);
  handler(temporary);
  release(temporary);
}
`

export interface FakeNativeWrapper extends NativeUrlOpenHost {
  /** macOS delivering a link: buffered before a handler is installed, handed over from a temporary after. */
  readonly openUrl: (url: string) => void
}

export const fakeNativeWrapper = (): FakeNativeWrapper => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-fake-native-wrapper-"))
  try {
    const source = join(directory, "native-wrapper.c")
    writeFileSync(source, SOURCE)
    const wrapper = cc({
      source,
      symbols: {
        fake_set_url_open_handler: { args: ["ptr"], returns: "void" },
        fake_open_url: { args: ["ptr"], returns: "void" }
      }
    })
    return {
      setURLOpenHandler: (handler: Pointer) => wrapper.symbols.fake_set_url_open_handler(handler),
      openUrl: (url) => wrapper.symbols.fake_open_url(Buffer.from(`${url}\0`))
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
