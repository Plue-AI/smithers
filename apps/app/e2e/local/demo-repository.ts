/** main's README.md in the stand-in repository `local-owner/demo`: the walk's agent question reads it back from the mirror. */
export const README = "# demo\n\nThe local walk's repository.\n"

/**
 * The C-J1-06 Node canary on main: no `.smithers/`, so setup step 6 detects Node 22
 * and pnpm 9 and builds a real machine image with one locked dependency.
 */
export const NODE_CANARY: Readonly<Record<string, string>> = {
  ".node-version": "22\n",
  "package.json": `${JSON.stringify({
    name: "demo", version: "1.0.0", private: true, packageManager: "pnpm@9",
    scripts: { test: "node --test" }, dependencies: { "is-number": "7.0.0" }
  }, null, 2)}\n`,
  "pnpm-lock.yaml": [
    "lockfileVersion: '9.0'", "", "settings:", "  autoInstallPeers: true", "  excludeLinksFromLockfile: false", "",
    "importers:", "", "  .:", "    dependencies:", "      is-number:", "        specifier: 7.0.0", "        version: 7.0.0", "",
    "packages:", "", "  is-number@7.0.0:",
    "    resolution: {integrity: sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==}",
    "    engines: {node: '>=0.12.0'}", "", "snapshots:", "", "  is-number@7.0.0: {}", ""
  ].join("\n")
}
