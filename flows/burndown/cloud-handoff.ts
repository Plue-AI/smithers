/** Host-only retention and reconstruction of committed Cloud agent work. */
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

export interface CloudFile {
  readonly type: "file" | "symlink"
  readonly mode: "644" | "755" | "120000"
  readonly data: string
}
export interface CloudCommit {
  readonly sha: string
  readonly parent: string
  readonly message: string
  readonly changes: ReadonlyArray<
    { readonly path: string; readonly before: CloudFile | null; readonly after: CloudFile | null }
  >
}
export interface CloudHandoff {
  readonly version: 1
  readonly repository: string
  readonly base: string
  readonly commits: ReadonlyArray<CloudCommit>
}
export const cloudHandoffLimits = {
  commits: 20,
  files: 1000,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  symlinkBytes: 1023
} as const
export interface CloudAttribution {
  readonly tool: "codex" | "claude"
  readonly model: string
}
export interface HandoffOptions {
  readonly repository: string
  readonly repoDirectory: string
  readonly artifactDirectory: string
  /** Trusted coding assignment, kept beside the untrusted exported artifact. */
  readonly attribution?: CloudAttribution
  readonly lockPath?: string
  /** Tests replace the lock runner; production always invokes its executable script once. */
  readonly run?: (command: string, args: ReadonlyArray<string>) => Promise<void>
}
export interface PreparedHandoff {
  readonly artifactPath: string
  readonly receiptPath: string
  readonly commit: string
  readonly commits: ReadonlyArray<{ readonly source: string; readonly local: string }>
}
const sha = /^[0-9a-f]{40}$/
const object = (value: unknown, keys: ReadonlyArray<string>): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid handoff object")
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !(key in record))) {
    throw new Error("invalid handoff schema")
  }
  return record
}
const validPath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096 && !Array.from(value).some((character) =>
    character === "\\" || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
  )
  && value.split("/").every((segment) =>
    segment && ![".", "..", ".git", ".jj"].includes(segment.toLowerCase())
  )

/** Validate untrusted guest bytes before retaining them or invoking any host command. */
export const validateCloudHandoff = (value: unknown, repository: string): CloudHandoff => {
  const root = object(value, ["version", "repository", "base", "commits"])
  if (root.version !== 1) throw new Error("unsupported handoff version")
  if (root.repository !== repository || !["smithersai/smithers", "smithersai/plue"].includes(repository)) {
    throw new Error("handoff repository mismatch")
  }
  if (typeof root.base !== "string" || !sha.test(root.base)) throw new Error("invalid handoff base")
  if (!Array.isArray(root.commits) || root.commits.length < 1 || root.commits.length > cloudHandoffLimits.commits) {
    throw new Error("invalid handoff commit count")
  }
  let total = 0
  let files = 0
  const file = (value: unknown): CloudFile | null => {
    if (value === null) return null
    const row = object(value, ["type", "mode", "data"])
    if (
      !(row.type === "file" && (row.mode === "644" || row.mode === "755")) &&
      !(row.type === "symlink" && row.mode === "120000")
    ) {
      throw new Error("invalid handoff file type or mode")
    }
    if (typeof row.data !== "string" || row.data.length > Math.ceil(cloudHandoffLimits.fileBytes / 3) * 4) {
      throw new Error("handoff file size exceeded")
    }
    const bytes = Buffer.from(row.data, "base64")
    if (bytes.toString("base64") !== row.data) throw new Error("invalid handoff base64")
    if (bytes.length > cloudHandoffLimits.fileBytes) throw new Error("handoff file size exceeded")
    total += bytes.length
    if (total > cloudHandoffLimits.totalBytes) throw new Error("handoff total size exceeded")
    if (
      row.type === "symlink" &&
      (bytes.length === 0 || bytes.length > cloudHandoffLimits.symlinkBytes || bytes.includes(0) ||
        !Buffer.from(bytes.toString("utf8")).equals(bytes))
    ) {
      throw new Error("invalid handoff symlink")
    }
    return { type: row.type, mode: row.mode, data: row.data }
  }
  let parent = root.base
  const seen = new Set<string>([parent])
  const state = new Map<string, CloudFile | null>()
  const aliases = new Map<string, string>()
  const commits = root.commits.map((value): CloudCommit => {
    const row = object(value, ["sha", "parent", "message", "changes"])
    if (typeof row.sha !== "string" || !sha.test(row.sha) || seen.has(row.sha)) {
      throw new Error("invalid handoff commit sha")
    }
    if (row.parent !== parent) throw new Error("invalid handoff parent chain")
    if (
      typeof row.message !== "string" || row.message.trim().length === 0 || row.message.length > 16384 ||
      row.message.includes("\0")
    ) {
      throw new Error("invalid handoff message")
    }
    if (!Array.isArray(row.changes) || row.changes.length === 0) throw new Error("invalid handoff changes")
    files += row.changes.length
    if (files > cloudHandoffLimits.files) throw new Error("handoff path count exceeded")
    const paths = new Set<string>()
    const changes = row.changes.map((value) => {
      const change = object(value, ["path", "before", "after"])
      if (!validPath(change.path)) throw new Error("invalid handoff path")
      if (paths.has(change.path)) throw new Error("duplicate handoff path")
      const canonical = change.path.normalize("NFC").toLowerCase()
      if (aliases.has(canonical) && aliases.get(canonical) !== change.path) throw new Error("ambiguous handoff path")
      if (
        Array.from(aliases.keys()).some((path) => path.startsWith(canonical + "/") || canonical.startsWith(path + "/"))
      ) {
        throw new Error("conflicting handoff path ancestry")
      }
      aliases.set(canonical, change.path)
      paths.add(change.path)
      const before = file(change.before)
      const after = file(change.after)
      if (JSON.stringify(before) === JSON.stringify(after)) throw new Error("unchanged handoff path")
      if (state.has(change.path) && JSON.stringify(state.get(change.path)) !== JSON.stringify(before)) {
        throw new Error("inconsistent handoff path history")
      }
      state.set(change.path, after)
      return { path: change.path, before, after }
    })
    seen.add(row.sha)
    parent = row.sha
    return { sha: row.sha, parent: row.parent, message: row.message, changes }
  })
  return { version: 1, repository, base: root.base, commits }
}

// A single executable script owns all jj reads that snapshot the shared working
// copy and all mutations. Its editor updates only selected paths in jj's private
// right-side tree; jj preserves unrelated working-copy changes on commit.
const reconstruction = String.raw`#!/usr/bin/env python3
import base64, json, os, pathlib, re, stat, subprocess, sys, tempfile
HERE=pathlib.Path(__file__).resolve().parent
ARTIFACT=json.loads((HERE/'artifact.json').read_text())
RECEIPT=HERE/'receipt.json'
REPO=pathlib.Path((HERE/'repository.txt').read_text())
ATTRIBUTION=json.loads((HERE/'attribution.json').read_text())
COAUTHOR=None if ATTRIBUTION is None else ('Co-Authored-By: GPT-6.1 Sol <noreply@openai.com>' if ATTRIBUTION['tool']=='codex' else 'Co-Authored-By: Claude Opus <noreply@anthropic.com>')
inflight=None
committed=False
report={'status':'preparing','commits':[]}
if RECEIPT.exists():
    report=json.loads(RECEIPT.read_text())

def save():
    with tempfile.NamedTemporaryFile(mode='w',dir=HERE,delete=False) as stream:
        json.dump(report,stream,indent=2);stream.flush();os.fsync(stream.fileno());name=stream.name
    os.replace(name,RECEIPT)
    directory=os.open(HERE,os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)

def jj(*args):
    result=subprocess.run(['jj','--no-pager','--color=never',*args],cwd=REPO,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if result.returncode: raise RuntimeError('jj command failed: '+args[0]+' '+result.stderr.decode(errors='replace')[:2000])
    return result.stdout

def revision(value):
    result=jj('--ignore-working-copy','log','--no-graph','-r',value,'-T','commit_id').decode()
    if len(result)!=40: raise RuntimeError('revision must resolve to one commit')
    return result

def selector(path): return 'root-file:'+json.dumps(path,ensure_ascii=False)
def tree(rev,path):
    metadata=jj('--ignore-working-copy','file','list','-r',rev,'-T','file_type ++ " " ++ executable ++ "\n"',selector(path)).decode().strip()
    if not metadata: return None
    kind,executable=metadata.split(' ')
    if kind not in ('file','symlink'): raise RuntimeError('unsupported or conflicting tree entry: '+path)
    if kind=='symlink':
        patch=jj('--ignore-working-copy','diff','--git','--from','root()','--to',rev,selector(path))
        parsed=subprocess.run(['node','--experimental-strip-types',(HERE/'symlink-reader.txt').read_text(),'--decode-diff'],input=patch,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        if parsed.returncode: raise RuntimeError('could not read committed symlink target: '+path)
        data=parsed.stdout
    else: data=jj('--ignore-working-copy','file','show','-r',rev,selector(path))
    return {'type':kind,'mode':'120000' if kind=='symlink' else ('755' if executable=='true' else '644'),
        'data':base64.b64encode(data).decode()}

def disk(root,path):
    parts=path.split('/')
    for i in range(1,len(parts)):
        ancestor=root.joinpath(*parts[:i])
        if ancestor.is_symlink(): raise RuntimeError('symlink ancestor: '+path)
    target=root/path
    try: info=target.lstat()
    except (FileNotFoundError,NotADirectoryError): return None
    if stat.S_ISLNK(info.st_mode):
        return {'type':'symlink','mode':'120000','data':base64.b64encode(os.fsencode(os.readlink(target))).decode()}
    if not stat.S_ISREG(info.st_mode): raise RuntimeError('unsupported working-copy entry: '+path)
    return {'type':'file','mode':'755' if info.st_mode&0o111 else '644','data':base64.b64encode(target.read_bytes()).decode()}

try:
    os.chdir(REPO)
    if report.get('status')=='prepared':
        for item in report['commits']: revision(item['local'])
        sys.exit(0)
    jj('st')
    main=revision('main')
    head=revision('@-')
    description=jj('--ignore-working-copy','log','--no-graph','-r','@','-T','description').decode()
    anchored=jj('--ignore-working-copy','log','--no-graph','-r',ARTIFACT['base']+' & ::'+head,'-T','commit_id').decode()
    if anchored!=ARTIFACT['base']: raise RuntimeError('Cloud base is not an ancestor of local prepared commits')

    if report.get('commits'): raise RuntimeError('partial preparation retained; inspect existing receipt before retry')
    initial={}
    for commit in ARTIFACT['commits']:
        for change in commit['changes']: initial.setdefault(change['path'],change['before'])
    for path,before in initial.items():
        if tree(ARTIFACT['base'],path)!=before: raise RuntimeError('exported base bytes mismatch: '+path)
        if tree(main,path)!=before: raise RuntimeError('main changed an owned path: '+path)
        if tree(head,path)!=before: raise RuntimeError('prepared local commit changed an owned path: '+path)
        if disk(REPO,path)!=before: raise RuntimeError('shared working-copy edits on owned path: '+path)
    report={'status':'preparing','main':main,'base':ARTIFACT['base'],'commits':[]};save()
    for index,commit in enumerate(ARTIFACT['commits']):
        committed=False
        for change in commit['changes']:
            if disk(REPO,change['path'])!=change['before']: raise RuntimeError('working-copy changed before reconstruction: '+change['path'])
        editor=HERE/('editor-'+str(index)+'.py')
        editor.write_text('''#!/usr/bin/env python3
import base64,json,os,pathlib,shutil,sys,tempfile
changes=json.loads(pathlib.Path('''+repr(str(HERE/'artifact.json'))+''').read_text())['commits']['''+str(index)+''']['changes']
right=pathlib.Path(sys.argv[2])
direction='before' if len(sys.argv)>3 and sys.argv[3]=='before' else 'after'
for change in changes:
    target=right/change['path']
    for ancestor in target.parents:
        if ancestor==right: break
        if ancestor.is_symlink(): raise RuntimeError('symlink ancestor in editor')
    if change[direction] is None:
        if target.is_symlink() or target.is_file(): target.unlink()
        elif target.exists(): raise RuntimeError('unexpected directory in editor')
    elif target.exists() and target.is_dir() and not target.is_symlink(): raise RuntimeError('unexpected directory in editor')
for change in changes:
    entry=change[direction];target=right/change['path']
    if entry is None: continue
    for ancestor in target.parents:
        if ancestor==right: break
        if ancestor.is_symlink(): raise RuntimeError('symlink ancestor while writing editor tree')
    target.parent.mkdir(parents=True,exist_ok=True)
    data=base64.b64decode(entry['data'])
    temporary=pathlib.Path(tempfile.mkdtemp(prefix='.cloud-handoff-',dir=target.parent))
    try:
        prepared=temporary/'entry'
        if entry['type']=='symlink': os.symlink(os.fsdecode(data),prepared)
        else: prepared.write_bytes(data);prepared.chmod(0o755 if entry['mode']=='755' else 0o644)
        os.replace(prepared,target)
    finally: shutil.rmtree(temporary)
''')
        editor.chmod(0o700)
        config=HERE/('editor-'+str(index)+'.toml')
        config.write_text('[merge-tools.cloud-handoff]\nprogram = '+json.dumps(str(editor))+'\nedit-args = ["$left", "$right"]\n')
        paths=[selector(change['path']) for change in commit['changes']]
        # jj's diff editor materializes only already changed paths. Seed the
        # checked own paths so additions enter that selection, then the editor
        # reconstructs exactly that tree without selecting shared WIP.
        inflight=(commit,editor)
        seeded=subprocess.run([str(editor),'',str(REPO)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        if seeded.returncode: raise RuntimeError('could not seed checked Cloud paths')
        additions=[selector(change['path']) for change in commit['changes'] if change['after'] is not None]
        if additions: jj('file','track','--include-ignored',*additions)
        jj('--config-file',str(config),'diffedit','-r','@','--tool','cloud-handoff',*paths)
        for change in commit['changes']:
            if disk(REPO,change['path'])!=change['after'] or tree('@',change['path'])!=change['after']: raise RuntimeError('reconstructed working-copy differs: '+change['path'])
        message=commit['message'].rstrip()
        if COAUTHOR:
            message=re.sub(r'(?im)^Co-Authored-By: [^\r\n]*<noreply@(?:openai\.com|anthropic\.com)>[ \t\r]*$', '', message).rstrip()
            message+='\n\n'+COAUTHOR
        if revision('main')!=main: raise RuntimeError('main changed during preparation')
        jj('commit',*paths,'--message='+message)
        committed=True
        local=revision('@-')
        report['commits'].append({'source':commit['sha'],'local':local});save()
        inflight=None
        for change in commit['changes']:
            if tree(local,change['path'])!=change['after']: raise RuntimeError('prepared commit tree differs: '+change['path'])
        if description: jj('describe','@','--message='+description)
        if revision('main')!=main: raise RuntimeError('main changed during preparation')
    report['status']='prepared';save()
except Exception as error:
    if report.get('status')=='prepared': sys.exit(1)
    if inflight and not committed:
        commit,editor=inflight
        try:
            for change in commit['changes']:
                observed=disk(REPO,change['path'])
                if observed not in (change['before'],change['after']): raise RuntimeError('working-copy changed during rollback')
            rollback=subprocess.run([str(editor),'',str(REPO),'before'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            if rollback.returncode: raise RuntimeError('own-path rollback failed')
            jj('st');report['rolled_back']=True
        except Exception as rollback_error: report['rollback_error']=str(rollback_error)
    report['status']='failed';report['error']=str(error);save();sys.exit(1)
`
const execute = promisify(execFile)

const durableWrite = async (path: string, bytes: string, mode: number): Promise<void> => {
  const file = await open(path, "wx", mode)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
}

const retainFile = async (path: string, bytes: string, mode: number): Promise<void> => {
  try {
    await durableWrite(path, bytes, mode)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if ((await lstat(path)).isSymbolicLink() || await readFile(path, "utf8") !== bytes) {
      throw new Error("retained handoff identity mismatch")
    }
  }
}
const replaceHostFile = async (path: string, bytes: string, mode: number): Promise<void> => {
  const temporary = path + ".host-" + randomUUID()
  await durableWrite(temporary, bytes, mode)
  await rename(temporary, path)
}
const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
const retainValidated = async (artifact: CloudHandoff, artifactDirectory: string): Promise<string> => {
  if (!isAbsolute(artifactDirectory)) throw new Error("artifact directory must be absolute")
  const requestedRoot = resolve(artifactDirectory)
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 })
  if ((await lstat(requestedRoot)).isSymbolicLink()) throw new Error("artifact directory cannot use symlinks")
  const root = await realpath(requestedRoot)
  const encoded = JSON.stringify(artifact)
  const directory = join(root, createHash("sha256").update(encoded).digest("hex"))
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  if (await realpath(directory) !== directory) throw new Error("artifact receipt directory cannot use symlinks")
  const artifactPath = join(directory, "artifact.json")
  await retainFile(artifactPath, encoded, 0o600)
  await syncDirectory(directory)
  await syncDirectory(root)
  return artifactPath
}

/** Atomic, bounded host recovery evidence. Guest logs and credentials never belong here. */
export const retainCloudRecovery = async (
  directory: string,
  value: Readonly<Record<string, unknown>>
): Promise<void> => {
  if (!isAbsolute(directory)) throw new Error("recovery directory must be absolute")
  const bytes = JSON.stringify(value)
  if (Buffer.byteLength(bytes) > 16 * 1024) throw new Error("Cloud recovery receipt exceeds limit")
  const created = await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("recovery directory cannot use symlinks")
  await replaceHostFile(join(directory, "recovery.json"), bytes, 0o600)
  await syncDirectory(directory)
  if (created !== undefined) {
    // Fsync newly created ancestors as well as the receipt's own directory.
    for (let parent = dirname(directory);; parent = dirname(parent)) {
      await syncDirectory(parent)
      if (parent === dirname(created)) break
    }
  }
}

/** Durably retain validated committed bytes before review or sandbox release. */
export const retainCloudHandoff = async (
  value: unknown,
  options: Pick<HandoffOptions, "repository" | "artifactDirectory">
): Promise<string> => retainValidated(validateCloudHandoff(value, options.repository), options.artifactDirectory)

/** Retains host bytes before running the locked, own-path-only jj preparation. */
export const prepareCloudHandoff = async (value: unknown, options: HandoffOptions): Promise<PreparedHandoff> => {
  const attribution = options.attribution ?? null
  if (
    attribution !== null && !(
      (attribution.tool === "codex" && attribution.model === "gpt-6.1-sol") ||
      (attribution.tool === "claude" && attribution.model === "claude-opus-5-5")
    )
  ) throw new Error("invalid Cloud assignment attribution tool/model")
  const artifact = validateCloudHandoff(value, options.repository)
  const artifactPath = await retainValidated(artifact, options.artifactDirectory)
  const directory = dirname(artifactPath)
  await retainFile(join(directory, "attribution.json"), JSON.stringify(attribution), 0o600)
  await syncDirectory(directory)
  const repository = options.repository === "smithersai/smithers" ? "smithers" : "plue"
  const repoDirectory = await realpath(options.repoDirectory)
  const receiptPath = join(directory, "receipt.json")
  try {
    const existing = JSON.parse(await readFile(receiptPath, "utf8")) as {
      status?: string
      commits?: Array<{ source: string; local: string }>
    }
    if (existing.status !== "prepared" && existing.commits?.length) {
      throw new Error("partial preparation retained; inspect existing receipt before retry")
    }
    if (existing.status === "prepared") {
      if (
        existing.commits?.length !== artifact.commits.length ||
        existing.commits.some((commit, index) =>
          commit.source !== artifact.commits[index]!.sha || !sha.test(commit.local)
        )
      ) throw new Error("Cloud handoff preparation lacks a complete receipt")
      return { artifactPath, receiptPath, commits: existing.commits, commit: existing.commits.at(-1)!.local }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const script = join(directory, "prepare.py")
  await replaceHostFile(join(directory, "repository.txt"), repoDirectory, 0o600)
  await replaceHostFile(script, reconstruction, 0o700)
  await replaceHostFile(
    join(directory, "symlink-reader.txt"),
    fileURLToPath(new URL("./cloud-symlink.ts", import.meta.url)),
    0o600
  )
  await syncDirectory(directory)
  try {
    await (options.run ?? (async (command, args) => {
      await execute(command, [...args], { maxBuffer: 1024 * 1024 })
    }))(
      "python3",
      [options.lockPath ?? join(homedir(), "Smithers-Ops/dispatch/vcs_lock.py"), repository, script]
    )
  } catch (error) {
    let receipt: Record<string, unknown> = {}
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError
    }
    if (receipt.status !== "prepared") {
      const failed = JSON.stringify({ ...receipt, status: "failed", runnerError: String(error) })
      const temporary = receiptPath + ".failed-" + randomUUID()
      await durableWrite(temporary, failed, 0o600)
      await rename(temporary, receiptPath)
      await syncDirectory(directory)
    }
    throw new Error(typeof receipt.error === "string" ? receipt.error : String(error), { cause: error })
  }
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    status?: string
    commits?: Array<{ source: string; local: string }>
  }
  if (
    receipt.status !== "prepared" || receipt.commits?.length !== artifact.commits.length
    || receipt.commits.some((commit, index) =>
      commit.source !== artifact.commits[index]!.sha || !sha.test(commit.local)
    )
  ) {
    throw new Error("Cloud handoff preparation lacks a complete receipt")
  }
  return { artifactPath, receiptPath, commits: receipt.commits, commit: receipt.commits.at(-1)!.local }
}
