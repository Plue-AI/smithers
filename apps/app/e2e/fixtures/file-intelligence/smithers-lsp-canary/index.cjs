// Provision only as a repository dependency inside the canary branch machine.
// Loading the plugin records the OS identity before delegating unchanged LSP.
const fs = require("node:fs")
module.exports = () => ({
  create(info) {
    fs.writeFileSync("/tmp/smithers-lsp-plugin-canary.json", JSON.stringify({
      uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(),
      pid: process.pid, cwd: process.cwd(), marker: "branch-plugin-only"
    }) + "\n", { mode: 0o600 })
    return info.languageService
  }
})
