/*
 * The one symbol of Electrobun's native wrapper the app calls itself:
 * `setURLOpenHandler` (NativeUrlOpen.ts). It opens the same
 * libNativeWrapper.dylib the SDK opens, from the same places (next to the
 * working directory, then next to the launcher), so both reach one set of
 * native globals. macOS only: the wrapper registers URL schemes nowhere else.
 */
import { dlopen, FFIType, suffix, type Pointer } from "bun:ffi"
import { dirname, join } from "node:path"

export interface NativeUrlOpenHost {
  /** Installs the native URL handler; the wrapper calls it at once with every link it buffered. */
  readonly setURLOpenHandler: (handler: Pointer) => void
}

const fileName = `libNativeWrapper.${suffix}`

/** The native wrapper's URL door, or null off macOS or when no wrapper loads (a headless run). */
export const nativeUrlOpenHost = (
  platform: NodeJS.Platform = process.platform,
  candidates: ReadonlyArray<string> = [join(process.cwd(), fileName), join(dirname(process.argv0), fileName)]
): NativeUrlOpenHost | null => {
  if (platform !== "darwin") return null
  for (const path of candidates) {
    try {
      const wrapper = dlopen(path, { setURLOpenHandler: { args: [FFIType.ptr], returns: FFIType.void } })
      return { setURLOpenHandler: (handler) => wrapper.symbols.setURLOpenHandler(handler) }
    } catch {
      // Not at this candidate; the SDK tries the next one the same way.
    }
  }
  return null
}
