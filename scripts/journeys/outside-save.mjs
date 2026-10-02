import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { cli, command, createStepLog, isMain, required, safeRelativePath } from "./lib.mjs"

export function sshTarget(value) {
  if (typeof value !== "string" || !/^(?:[a-zA-Z0-9_-]+@)?[a-zA-Z0-9.-]+$/.test(value) || value.startsWith("-")) throw new Error("Unsafe SSH target")
  return value
}

// Input travels on stdin. The remote shell sees only this constant command.
// realpath containment also refuses a symlink from the working copy to a home.
export const OUTSIDE_SAVE_SCRIPT = `import sys,json,pathlib,os,tempfile,hashlib
p=json.load(sys.stdin)
root=pathlib.Path(p['root']).resolve(strict=True)
file=(root/p['path']).resolve(strict=True)
if root not in file.parents or not file.is_file(): raise ValueError('outside working copy')
data=file.read_bytes()
if len(data)>1048576: raise ValueError('not live editable')
data.decode('utf-8')
if p['action']=='write':
 data=p['content'].encode('utf-8')
 if len(data)>1048576: raise ValueError('not live editable')
 st=file.stat()
 if st.st_uid!=os.geteuid(): raise ValueError('outside save must preserve the owner')
 fd,name=tempfile.mkstemp(prefix='.journey-save-',dir=str(file.parent))
 try:
  os.fchown(fd,st.st_uid,st.st_gid)
  os.fchmod(fd,st.st_mode & 0o777)
  with os.fdopen(fd,'wb') as out: out.write(data);out.flush();os.fsync(out.fileno())
  os.replace(name,file)
  directory=os.open(str(file.parent),os.O_RDONLY);os.fsync(directory);os.close(directory)
 finally:
  if os.path.exists(name): os.unlink(name)
print(json.dumps({'content':data.decode('utf-8'),'digest':hashlib.sha256(data).hexdigest()}))`
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`

export function outsideVersions(content, { untouchedLine, typedLine, untouchedText, typedText }) {
  const lines = content.split(/(?<=\n)/)
  for (const line of [untouchedLine, typedLine]) if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) throw new Error("Outside-save line out of bounds")
  if (untouchedLine === typedLine) throw new Error("Outside saves need distinct untouched and typed lines")
  for (const text of [untouchedText, typedText]) if (typeof text !== "string" || /[\r\n]/.test(text)) throw new Error("Outside-save replacement must be one line")
  const replaced = (base, line, text) => {
    const next = [...base]
    next[line - 1] = `${text}${base[line - 1].endsWith("\n") ? "\n" : ""}`
    return next
  }
  const untouched = replaced(lines, untouchedLine, untouchedText)
  return { untouched: untouched.join(""), overlap: replaced(untouched, typedLine, typedText).join("") }
}

export async function outsideSave({ target, root, path, evidenceDirectory, beforeSave, log = async () => {}, execImpl = command, ...edits }) {
  sshTarget(target)
  required(root, "absolute SSH working-copy root")
  if (!root.startsWith("/")) throw new Error("SSH working-copy root must be absolute")
  safeRelativePath(path)
  if (typeof beforeSave !== "function") throw new Error("Outside saves require a live typing synchronization callback")
  const remote = async (payload) => {
    const result = await execImpl("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", target, `python3 -c ${shellQuote(OUTSIDE_SAVE_SCRIPT)}`], { input: JSON.stringify({ root, path, ...payload }) })
    return JSON.parse(result.stdout)
  }
  const base = await remote({ action: "read" })
  const versions = outsideVersions(base.content, edits)
  const receipts = []
  for (const kind of ["untouched", "overlap"]) {
    // The operator coordinates two typists with this gate; no sleep guesses
    // when their edits are active or when their saves are acknowledged.
    await beforeSave(kind)
    const content = versions[kind]
    const digest = createHash("sha256").update(content).digest("hex")
    if (evidenceDirectory) await writeFile(join(evidenceDirectory, `outside-${kind}.txt`), content, { mode: 0o600 })
    await log({ event: "outside-save.start", kind, actor: "owner", via: "ssh", target, path, baseDigest: base.digest, digest })
    const saved = await remote({ action: "write", content })
    if (saved.digest !== digest) throw new Error("SSH outside save digest mismatch")
    const receipt = { event: "outside-save.completed", kind, path, digest }
    await log(receipt)
    receipts.push(receipt)
  }
  return receipts
}

if (isMain(import.meta.url)) await cli(async () => {
  const { readFile } = await import("node:fs/promises")
  const { createInterface } = await import("node:readline/promises")
  const options = JSON.parse(await readFile(required(process.argv[2], "outside-save JSON file"), "utf8"))
  const directory = new URL(`../../.artifacts/checks/C-J3-04/${new Date().toISOString()}/`, import.meta.url).pathname
  const log = await createStepLog(directory)
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    await outsideSave({ ...options, evidenceDirectory: directory, log, beforeSave: async (kind) => {
      const answer = await terminal.question(`${kind}: owner is the only outside session, no agent active, Ben and Alice typing. Type SAVE: `)
      if (answer !== "SAVE") throw new Error("Outside save cancelled")
    } })
  } finally { terminal.close() }
})
