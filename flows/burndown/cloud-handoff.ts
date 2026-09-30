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
  /** Supported retained recovery may verify existing partial commits under the lock. */
  readonly recoverPartial?: boolean
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
// right-side tree; extraction leaves the shared parent and unrelated WIP intact.
const reconstruction = String.raw`#!/usr/bin/env python3
import base64, hashlib, json, os, pathlib, re, stat, subprocess, sys, tempfile
HERE=pathlib.Path(__file__).resolve().parent
ARTIFACT=json.loads((HERE/'artifact.json').read_text())
RECEIPT=HERE/'receipt.json'
REPO=pathlib.Path((HERE/'repository.txt').read_text())
ATTRIBUTION=json.loads((HERE/'attribution.json').read_text())
RECOVER=False
COAUTHOR=None if ATTRIBUTION is None else ('Co-Authored-By: GPT-6.1 Sol <noreply@openai.com>' if ATTRIBUTION['tool']=='codex' else 'Co-Authored-By: Claude Opus <noreply@anthropic.com>')
committed=False
report={'status':'preparing','commits':[]}
if RECEIPT.exists():
    report=json.loads(RECEIPT.read_text())

def save_json(path,value):
    with tempfile.NamedTemporaryFile(mode='w',dir=HERE,delete=False) as stream:
        json.dump(value,stream,indent=2);stream.flush();os.fsync(stream.fileno());name=stream.name
    os.replace(name,path)
    directory=os.open(HERE,os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)

def save(): save_json(RECEIPT,report)

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

def message(commit):
    result=commit['message'].rstrip()
    if COAUTHOR:
        result=re.sub(r'(?im)^Co-Authored-By: [^\r\n]*<noreply@(?:openai\.com|anthropic\.com)>[ \t\r]*$', '', result).rstrip()
        result+='\n\n'+COAUTHOR
    return result

def verify_existing(local,index,parent,state):
    commit=ARTIFACT['commits'][index]
    if not isinstance(local,str) or not re.fullmatch('[0-9a-f]{40}',local) or revision(local)!=local:
        raise RuntimeError('invalid retained local commit identity')
    if jj('--ignore-working-copy','log','--no-graph','-r',local+' & ::visible_heads()','-T','commit_id').decode()!=local:
        raise RuntimeError('retained local commit is hidden')
    if jj('--ignore-working-copy','log','--no-graph','-r',local+' & divergent()','-T','commit_id').strip():
        raise RuntimeError('retained local change is divergent')
    if jj('--ignore-working-copy','log','--no-graph','-r',local,'-T','parents.map(|p| p.commit_id()).join(" ")').decode()!=parent:
        raise RuntimeError('retained commit parent differs')
    if jj('--ignore-working-copy','log','--no-graph','-r',local,'-T','description').decode().rstrip()!=message(commit):
        raise RuntimeError('retained commit attribution or message differs')
    actual=set(jj('--ignore-working-copy','diff','--from',parent,'--to',local,'--name-only').decode().splitlines())
    if actual!={change['path'] for change in commit['changes']}:
        raise RuntimeError('retained commit includes unexpected or missing changes')
    for change in commit['changes']: state[change['path']]=change['after']
    for path,after in state.items():
        if tree(local,path)!=after: raise RuntimeError('retained commit tree differs: '+path)

def restore_seed():
    intent=report.get('seeding')
    if not intent: return
    index=intent['index']
    if not isinstance(index,int) or not 0<=index<len(ARTIFACT['commits']): raise RuntimeError('invalid retained seed intent')
    if revision('@-')!=report['shared_parent'] or jj('--ignore-working-copy','log','--no-graph','-r','@','-T','change_id')!=jj('--ignore-working-copy','log','--no-graph','-r',intent['shared'],'-T','change_id'):
        raise RuntimeError('shared revision changed since seeding; rollback refused')
    if jj('--ignore-working-copy','log','--no-graph','-r','descendants(@) ~ @','-T','commit_id').strip():
        raise RuntimeError('shared working-copy has descendants; rollback refused')
    seed=HERE/('seed-'+str(index)+'.json')
    rollback=HERE/('rollback-'+str(index)+'.py')
    if seed.is_symlink() or rollback.is_symlink(): raise RuntimeError('invalid retained seed files')
    selected=json.loads(seed.read_text())
    for change in selected:
        observed=disk(REPO,change['path'])
        if observed not in (change['before'],change['after']): raise RuntimeError('working-copy changed during rollback')
    restored=subprocess.run([str(rollback),'',str(REPO),'before'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if restored.returncode: raise RuntimeError('own-path rollback failed')
    jj('st')
    report.pop('seeding');report['rolled_back']=True;save()

try:
    os.chdir(REPO)
    if report.get('status')=='prepared':
        if len(report['commits'])!=len(ARTIFACT['commits']): raise RuntimeError('invalid retained commit count')
        state={}
        for commit in ARTIFACT['commits']:
            for change in commit['changes']: state.setdefault(change['path'],change['before'])
        parent=ARTIFACT['base']
        for index,item in enumerate(report['commits']):
            if item['source']!=ARTIFACT['commits'][index]['sha']: raise RuntimeError('retained source mapping differs')
            verify_existing(item['local'],index,parent,state);parent=item['local']
        sys.exit(0)
    if report.get('status')=='failed' or report.get('commits') or report.get('pending') or report.get('seeding'):
        identity=hashlib.sha256(json.dumps(report,sort_keys=True).encode()).hexdigest()
        save_json(HERE/('recovery-from-'+identity+'.json'),report)
    restore_seed()
    main=revision('main')
    upstream=jj('--ignore-working-copy','log','--no-graph','-r','present(main@origin)','-T','commit_id').decode()
    anchor=upstream or main
    shared=revision('@')
    head=revision('@-')
    description=jj('--ignore-working-copy','log','--no-graph','-r','@','-T','description').decode()
    anchored=jj('--ignore-working-copy','log','--no-graph','-r',ARTIFACT['base']+' & ::'+anchor,'-T','commit_id').decode()
    if anchored!=ARTIFACT['base']: raise RuntimeError('Cloud base is not an ancestor of current main')

    if (report.get('commits') or report.get('pending')) and not RECOVER: raise RuntimeError('partial preparation retained; inspect existing receipt before retry')
    initial={}
    for commit in ARTIFACT['commits']:
        for change in commit['changes']: initial.setdefault(change['path'],change['before'])
    for path,before in initial.items():
        if tree(ARTIFACT['base'],path)!=before: raise RuntimeError('exported base bytes mismatch: '+path)
    completed=list(report.get('commits',[]))
    if RECOVER and (completed or report.get('pending')):
        if len(completed)>len(ARTIFACT['commits']): raise RuntimeError('invalid retained commit count')
        state=dict(initial);parent=ARTIFACT['base']
        for index,item in enumerate(completed):
            if item['source']!=ARTIFACT['commits'][index]['sha']: raise RuntimeError('retained source mapping differs')
            verify_existing(item['local'],index,parent,state);parent=item['local']
        pending=report.get('pending')
        if pending:
            index=len(completed)
            if index>=len(ARTIFACT['commits']) or pending['source']!=ARTIFACT['commits'][index]['sha'] or pending['parent']!=parent:
                raise RuntimeError('retained pending identity differs')
            local=pending.get('local')
            if not local:
                candidates=jj('--ignore-working-copy','log','--no-graph','-r','children('+parent+') ~ @','-T','commit_id ++ "\\n"').decode().splitlines()
                candidates=[candidate for candidate in candidates if candidate not in pending['children']]
                if len(candidates)!=1: raise RuntimeError('retained extraction must identify exactly one commit')
                local=candidates[0]
            verify_existing(local,index,parent,state)
            completed.append({'source':pending['source'],'local':local})
        # Qualification changes only this receipt. Later unrelated WIP, parent
        # and descendants are preserved when no further extraction is needed.
    workspace={}
    if len(completed)<len(ARTIFACT['commits']):
        if jj('--ignore-working-copy','log','--no-graph','-r','descendants(@) ~ @','-T','commit_id').strip():
            raise RuntimeError('shared working-copy has descendants; extraction refused')
        jj('st')
        shared=revision('@')
        head=revision('@-')
        description=jj('--ignore-working-copy','log','--no-graph','-r','@','-T','description').decode()
        # Historical commits belong to the exported base. Today's main may
        # differ; preserve its checked bytes while extracting that exact history.
        # Complete retained mappings need no shared-path access or mutation.
        for path,before in initial.items():
            current=tree(head,path)
            if current not in (before,tree(main,path),tree(anchor,path)):
                raise RuntimeError('prepared local commit changed an owned path: '+path)
            if disk(REPO,path)!=current: raise RuntimeError('shared working-copy edits on owned path: '+path)
            workspace[path]=current
    report={'status':'preparing','main':main,'base':ARTIFACT['base'],'shared_parent':head,'upstream':upstream,'commits':completed,'recovered':RECOVER};save()
    cumulative=dict(initial)
    parent=ARTIFACT['base']
    for index,commit in enumerate(ARTIFACT['commits']):
        for change in commit['changes']: cumulative[change['path']]=change['after']
        if index<len(completed):
            parent=completed[index]['local'];continue
        committed=False
        for path,before in workspace.items():
            if disk(REPO,path)!=before: raise RuntimeError('working-copy changed before reconstruction: '+path)
        selected=[{'path':path,'before':workspace[path],'after':after} for path,after in cumulative.items()]
        exact=list(selected)
        if all(change['before']==change['after'] for change in selected):
            selected=[dict(change) for change in selected]
            seed=commit['changes'][0]
            next(change for change in selected if change['path']==seed['path'])['after']=seed['before']
        selection=HERE/('selection-'+str(index)+'.json')
        selection.write_text(json.dumps(selected))
        editor=HERE/('editor-'+str(index)+'.py')
        editor.write_text('''#!/usr/bin/env python3
import base64,json,os,pathlib,shutil,sys,tempfile
changes=json.loads(pathlib.Path('''+repr(str(selection))+''').read_text())
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
        paths=[selector(path) for path in initial]
        # jj's diff editor materializes only already changed paths. Seed the
        # checked own paths so additions enter that selection, then the editor
        # reconstructs exactly that tree without selecting shared WIP.
        # Journal the exact seed before touching shared bytes. The immutable
        # rollback program is independent of the later private-tree selections.
        seed=HERE/('seed-'+str(index)+'.json')
        save_json(seed,selected)
        rollback=HERE/('rollback-'+str(index)+'.py')
        rollback.write_text(editor.read_text().replace(repr(str(selection)),repr(str(seed))))
        rollback.chmod(0o700)
        with rollback.open('rb') as stream: os.fsync(stream.fileno())
        report['seeding']={'index':index,'source':commit['sha'],'shared':shared};save()
        seeded=subprocess.run([str(editor),'',str(REPO)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        if seeded.returncode: raise RuntimeError('could not seed checked Cloud paths')
        additions=[selector(change['path']) for change in selected if change['after'] is not None]
        if additions: jj('file','track','--include-ignored',*additions)
        jj('st')
        for change in selected:
            if disk(REPO,change['path'])!=change['after'] or tree('@',change['path'])!=change['after']:
                raise RuntimeError('shared path changed while seeding: '+change['path'])

        description_message=message(commit)
        if revision('main')!=main or jj('--ignore-working-copy','log','--no-graph','-r','present(main@origin)','-T','commit_id').decode()!=upstream: raise RuntimeError('main changed during preparation')
        # Extract the cumulative own-path delta without moving the shared parent.
        # Later extractions may produce an artificial three-way conflict against
        # the previous artifact commit; the private editor sets the exact tree.
        children=jj('--ignore-working-copy','log','--no-graph','-r','children('+parent+') ~ @','-T','commit_id ++ "\\n"').decode().splitlines()
        report['pending']={'source':commit['sha'],'parent':parent,'children':children};save()
        jj('split','--onto',parent,*paths,'--message='+description_message)
        committed=True
        candidates=jj('--ignore-working-copy','log','--no-graph','-r','children('+parent+') ~ @','-T','commit_id ++ "\\n"').decode().splitlines()
        candidates=[candidate for candidate in candidates if candidate not in children]
        if len(candidates)!=1: raise RuntimeError('extraction must produce exactly one commit')
        local=candidates[0]
        report['pending']['local']=local;save()
        structural=[]
        for change in exact:
            kind=jj('--ignore-working-copy','file','list','-r',local,'-T','file_type',selector(change['path'])).decode()
            if kind and kind not in ('file','symlink'): structural.append(change['path'])
        if structural:
            # Nonmaterializable type conflicts require removal in our private
            # tree before an exact entry can be written. Never remove other paths.
            selection.write_text(json.dumps([dict(change,after=None) for change in exact if change['path'] in structural]))
            jj('--ignore-working-copy','--config-file',str(config),'diffedit','--from','root()','--to',local,'--tool','cloud-handoff',*[selector(path) for path in structural])
            local=revision('latest((children('+parent+') ~ @) ~ ('+(' | '.join(children) if children else 'none()')+'),1)')
            report['pending']['local']=local;save()
        selection.write_text(json.dumps(exact))
        jj('--ignore-working-copy','--config-file',str(config),'diffedit','--from','root()','--to',local,'--tool','cloud-handoff',*paths)
        local=revision('latest((children('+parent+') ~ @) ~ ('+(' | '.join(children) if children else 'none()')+'),1)')
        report['pending']['local']=local;save()
        # A removed conflict is absent on the right. Materialize it against its
        # verified earlier entry so jj tracks the replacement, including symlinks.
        for path in structural:
            prior=parent if tree(parent,path) is not None else ARTIFACT['base']
            selection.write_text(json.dumps([change for change in exact if change['path']==path]))
            jj('--ignore-working-copy','--config-file',str(config),'diffedit','--from',prior,'--to',local,'--tool','cloud-handoff',selector(path))
            local=revision('latest((children('+parent+') ~ @) ~ ('+(' | '.join(children) if children else 'none()')+'),1)')
            report['pending']['local']=local;save()
        local=revision('latest((children('+parent+') ~ @) ~ ('+(' | '.join(children) if children else 'none()')+'),1)')
        report['pending']['local']=local;save()
        verify_existing(local,index,parent,cumulative)
        for path in cumulative:
            if disk(REPO,path)!=workspace[path]: raise RuntimeError('shared working-copy changed after extraction: '+path)
        if revision('@-')!=head or revision('main')!=main or jj('--ignore-working-copy','log','--no-graph','-r','present(main@origin)','-T','commit_id').decode()!=upstream: raise RuntimeError('shared parent or main changed during preparation')
        if jj('--ignore-working-copy','diff','--from',shared,'--to','@','--name-only').strip():
            raise RuntimeError('shared working-copy tree changed during preparation')
        if jj('--ignore-working-copy','log','--no-graph','-r','@','-T','description').decode()!=description:
            raise RuntimeError('shared description changed during preparation')
        report['commits'].append({'source':commit['sha'],'local':local});report.pop('pending');report.pop('seeding');save()
        parent=local
    report['status']='prepared';save()
except Exception as error:
    if report.get('status')=='prepared':
        print(str(error),file=sys.stderr);sys.exit(1)
    if report.get('pending') and not committed:
        try:
            pending=report['pending']
            candidates=jj('--ignore-working-copy','log','--no-graph','-r','children('+pending['parent']+') ~ @','-T','commit_id ++ "\\n"').decode().splitlines()
            candidates=[candidate for candidate in candidates if candidate not in pending['children']]
            if candidates:
                pending['candidates']=candidates;committed=True
            else: report.pop('pending')
        except Exception as discovery_error:
            report['discovery_error']=str(discovery_error);committed=True
    if report.get('seeding'):
        try: restore_seed()
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
  await retainFile(join(directory, "repository.txt"), repoDirectory, 0o600)
  const receiptPath = join(directory, "receipt.json")
  try {
    const existing = JSON.parse(await readFile(receiptPath, "utf8")) as {
      status?: string
      commits?: Array<{ source: string; local: string }>
      pending?: unknown
      seeding?: unknown
    }
    if (
      existing.status !== "prepared" && !options.recoverPartial && !existing.seeding &&
      (existing.commits?.length || existing.pending)
    ) {
      throw new Error("partial preparation retained; inspect existing receipt before retry")
    }
    if (existing.status === "prepared") {
      if (
        existing.commits?.length !== artifact.commits.length ||
        existing.commits.some((commit, index) =>
          commit.source !== artifact.commits[index]!.sha || !sha.test(commit.local)
        )
      ) throw new Error("Cloud handoff preparation lacks a complete receipt")
      // The locked script requalifies visibility, uniqueness and the exact tree;
      // a retained commit ID alone can still resolve after jj rewrites it.
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const script = join(directory, `prepare-${randomUUID()}.py`)
  const source = reconstruction.replace("RECOVER=False", options.recoverPartial ? "RECOVER=True" : "RECOVER=False")
  await replaceHostFile(join(directory, "prepare.py"), source, 0o700)
  await durableWrite(script, source, 0o700)
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
    // Only the locked reconstruction script writes receipt.json. A runner
    // failure may race a new attempt after lock release; retain it separately.
    await durableWrite(
      join(directory, `runner-error-${randomUUID()}.json`),
      JSON.stringify({ status: "failed", runnerError: "Cloud handoff lock runner failed", receiptPath }),
      0o600
    )
    await syncDirectory(directory)
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
