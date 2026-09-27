import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"

/**
 * A descriptor-relative host whose only directory is a Windows drive `root`.
 * `realPath` answers that exact spelling and nothing else, so a root resolved
 * by POSIX rules (`<cwd>/D:\...`) is not found. Every atomic request is
 * recorded; `remove` succeeds and every other operation is refused.
 */
export const win32Host = (root: string) => {
  const realPaths: Array<string> = []
  const requests: Array<KernelFileSystem.AtomicRequest> = []
  const inner = FileSystem.makeNoop({
    makeDirectory: () => Effect.void,
    realPath: (path) =>
      Effect.suspend(() => {
        realPaths.push(path)
        return path === root
          ? Effect.succeed(path)
          : Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "test", method: "realPath" }))
      }),
    stat: () => Effect.succeed({ type: "Directory", dev: 7, ino: Option.some(42) } as unknown as FileSystem.File.Info)
  })
  const fs = KernelFileSystem.withAtomicFileSystem(inner, {
    execute: (request) => {
      requests.push(request)
      return (request.operation === "remove"
        ? Effect.void
        : Effect.fail(
          PlatformError.systemError({ _tag: "PermissionDenied", module: "test", method: request.operation })
        )) as never
    }
  })
  return { fs, realPaths, requests }
}
