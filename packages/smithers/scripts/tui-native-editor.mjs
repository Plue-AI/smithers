import { join } from "node:path"

/** Core's fallback imports must embed the same file as the selected editor. */
export const nativeEditorPlugin = (packageRoot) => ({
  name: "smithers-native-editor",
  setup(build) {
    build.onResolve({ filter: /^@opentui\/core-(darwin|linux|win32)-(arm64|x64)(-musl)?$/ }, ({ path }) => ({
      path: join(packageRoot, "vendor/opentui-native", path.slice("@opentui/core-".length), "index.bun.mjs")
    }))
  }
})
