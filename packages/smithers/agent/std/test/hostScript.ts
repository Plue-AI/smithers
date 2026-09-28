import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"

/**
 * Writes a test server's source to a fresh host directory outside every test
 * workspace and returns its path. NodeLanguageServer refuses `node -e`, whose
 * inline code resolves bare requires from the workspace, so tests start their
 * servers the way a host should: an interpreter given a host file.
 */
export const hostScript = (source: string): string => {
  const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "smithers-lsp-server-"))
  const file = NodePath.join(directory, "server.cjs")
  NodeFs.writeFileSync(file, source)
  return file
}
