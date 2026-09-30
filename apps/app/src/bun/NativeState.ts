import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

/** Shared by native attachment and the explicit session-owner maintenance command. */
export const nativeStateDirectory = (): string => {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Smithers")
  const dataHome = Bun.env.XDG_DATA_HOME
  return join(dataHome !== undefined && isAbsolute(dataHome) ? dataHome : join(homedir(), ".local", "share"), "smithers")
}
