package microsandbox

import "testing"

// Private worker-phase evidence only. These tests own every fixture writer and
// substitute the supplementary-group query; they do not qualify guest-wide
// exclusion, the credential transition, transport or a production provider.
const mutationJournalFixture = `
import contextlib,hashlib,pathlib,shutil
H=lambda body:hashlib.sha256(body).hexdigest()
@contextlib.contextmanager
def fixture():
 with tempfile.TemporaryDirectory() as directory:
  base=pathlib.Path(directory);workspace=base/'workspace';workspace.mkdir()
  journal=base/'journal';journal.mkdir(mode=0o700)
  rootfd=os.open(workspace,os.O_RDONLY|os.O_DIRECTORY)
  journalfd=os.open(journal,os.O_RDONLY|os.O_DIRECTORY)
  groups=g.os.getgroups;g.os.getgroups=lambda:[]
  try:yield workspace,journal,rootfd,journalfd
  finally:g.os.getgroups=groups;os.close(rootfd);os.close(journalfd)
def refused(action,code=None):
 try:action()
 except SystemExit as error:
  if code is not None:assert error.code==code,error.code
 except OSError:
  assert code is None
 else:raise AssertionError('unsafe mutation accepted')
def original(workspace):
 (workspace/'a').write_bytes(b'alpha');(workspace/'a').chmod(0o640)
 (workspace/'b').write_bytes(b'beta');(workspace/'b').chmod(0o600)
def changes():
 return [('a',H(b'alpha'),b'ALPHA',0o664),('b',H(b'beta'),None,0),('new/deep/c','absent',b'beta',0o644)]
def assert_original(workspace):
 assert {p.relative_to(workspace).as_posix() for p in workspace.rglob('*')}=={'a','b'}
 assert (workspace/'a').read_bytes()==b'alpha' and (workspace/'a').stat().st_mode&0o777==0o640
 assert (workspace/'b').read_bytes()==b'beta' and (workspace/'b').stat().st_mode&0o777==0o600
def crash_after_first(rootfd,journalfd):
 child=os.fork()
 if child==0:
  replace=g.os.replace
  def stop(source,target,**kwargs):
   replace(source,target,**kwargs)
   if kwargs.get('dst_dir_fd')!=journalfd:os._exit(86)
  g.os.replace=stop
  g.apply_mutation_batch(rootfd,journalfd,changes(),4096)
  os._exit(87)
 _,status=os.waitpid(child,0);assert os.waitstatus_to_exitcode(status)==86,status
`

func TestGuestMutationBatchValidatesEverythingBeforeWorkspaceChanges(t *testing.T) {
	tests := map[string]string{
		"later-stale":        `batch=[('new/deep/c','absent',b'new',0o644),('b',H(b'old-beta'),None,0)]`,
		"move-source-stale":  `batch=[('new/deep/c','absent',b'alpha',0o644),('a',H(b'old-alpha'),None,0)]`,
		"destination-exists": `batch=[('a',H(b'alpha'),None,0),('b','absent',b'alpha',0o644)]`,
	}
	for name, setup := range tests {
		t.Run(name, func(t *testing.T) {
			boundaryPython(t, mutationJournalFixture+setup+`
with fixture() as (workspace,journal,rootfd,journalfd):
 original(workspace)
 refused(lambda:g.apply_mutation_batch(rootfd,journalfd,batch,4096),6)
 assert_original(workspace);assert not list(journal.iterdir())
`)
		})
	}
}

func TestGuestMutationBatchCommitsAddsDeletesUpdatesAndMoves(t *testing.T) {
	boundaryPython(t, mutationJournalFixture+`
with fixture() as (workspace,journal,rootfd,journalfd):
 original(workspace)
 result=g.apply_mutation_batch(rootfd,journalfd,changes()+[('missing/unused','absent',None,0)],4096)
 assert result=={'a':H(b'ALPHA'),'b':'absent','new/deep/c':H(b'beta'),'missing/unused':'absent'}
 assert (workspace/'a').read_bytes()==b'ALPHA' and (workspace/'a').stat().st_mode&0o777==0o664
 assert not (workspace/'b').exists() and (workspace/'new/deep/c').read_bytes()==b'beta'
 assert not (workspace/'missing').exists()
 assert g.json.loads((journal/'state.json').read_bytes())['phase']=='committed'
 # Lost reply after commit: recovery never reapplies the patch or rolls it back.
 (workspace/'a').write_bytes(b'outside save after thaw')
 assert g.recover_mutation(rootfd,journalfd,4096)=='committed'
 assert g.recover_mutation(rootfd,journalfd,4096)=='committed'
 assert (workspace/'a').read_bytes()==b'outside save after thaw'
 refused(lambda:g.apply_mutation_batch(rootfd,journalfd,changes(),4096),125)
`)
}

func TestGuestMutationRecoveryAfterProcessDeath(t *testing.T) {
	for _, stage := range []string{"backup", "prepared", "directory", "replacement", "deletion", "committed"} {
		t.Run(stage, func(t *testing.T) {
			boundaryPython(t, mutationJournalFixture+"stage="+`'`+stage+`'
with fixture() as (workspace,journal,rootfd,journalfd):
 original(workspace)
 child=os.fork()
 if child==0:
  save=g.mutation_save_state;write=g.mutation_write_new
  replace=g.os.replace;mkdir=g.os.mkdir;unlink=g.os.unlink
  def saving(fd,state):
   save(fd,state)
   if stage==state['phase']:os._exit(86)
  def writing(fd,leaf,body,mode):
   write(fd,leaf,body,mode)
   if stage=='backup' and leaf=='base-0':os._exit(86)
  def replacing(source,target,**kwargs):
   replace(source,target,**kwargs)
   if stage=='replacement' and kwargs.get('dst_dir_fd')!=journalfd:os._exit(86)
  def making(path,*args,**kwargs):
   mkdir(path,*args,**kwargs)
   if stage=='directory':os._exit(86)
  def unlinking(path,**kwargs):
   unlink(path,**kwargs)
   if stage=='deletion' and path=='b':os._exit(86)
  g.mutation_save_state=saving;g.mutation_write_new=writing
  g.os.replace=replacing;g.os.mkdir=making;g.os.unlink=unlinking
  g.apply_mutation_batch(rootfd,journalfd,changes(),4096)
  os._exit(87)
 _,status=os.waitpid(child,0);assert os.waitstatus_to_exitcode(status)==86,status
 expected='committed' if stage=='committed' else 'aborted'
 assert g.recover_mutation(rootfd,journalfd,4096)==expected
 assert g.recover_mutation(rootfd,journalfd,4096)==expected
 if stage!='committed':assert_original(workspace)
 else:
  assert (workspace/'a').read_bytes()==b'ALPHA'
  assert not (workspace/'b').exists() and (workspace/'new/deep/c').read_bytes()==b'beta'
`)
		})
	}
}

func TestGuestMutationWriteFailureRollsBackAndRecoveryCanItselfRestart(t *testing.T) {
	for _, crash := range []bool{false, true} {
		name := "io-failure"
		crashFlag := "False"
		if crash {
			name, crashFlag = "death-during-rollback", "True"
		}
		t.Run(name, func(t *testing.T) {
			boundaryPython(t, mutationJournalFixture+"crash="+crashFlag+`
with fixture() as (workspace,journal,rootfd,journalfd):
 original(workspace)
 child=os.fork()
 if child==0:
  replace=g.os.replace;unlink=g.os.unlink;failed=[False]
  def unlinking(path,**kwargs):
   if path=='b' and not failed[0]:
    failed[0]=True;raise OSError('injected workspace I/O failure')
   return unlink(path,**kwargs)
  def replacing(source,target,**kwargs):
   replace(source,target,**kwargs)
   if crash and failed[0] and kwargs.get('dst_dir_fd')!=journalfd:os._exit(86)
  g.os.unlink=unlinking;g.os.replace=replacing
  try:g.apply_mutation_batch(rootfd,journalfd,changes(),4096)
  except OSError:os._exit(85)
  os._exit(87)
 _,status=os.waitpid(child,0);assert os.waitstatus_to_exitcode(status)==(86 if crash else 85),status
 assert g.recover_mutation(rootfd,journalfd,4096)=='aborted'
 assert_original(workspace)
 # A settled rollback is also immutable after writers may have resumed.
 (workspace/'a').write_bytes(b'outside after rollback')
 assert g.recover_mutation(rootfd,journalfd,4096)=='aborted'
 assert (workspace/'a').read_bytes()==b'outside after rollback'
`)
		})
	}
}

func TestGuestMutationRecoveryRefusesCorruptionAndUnexpectedOutsideWrites(t *testing.T) {
	for _, scenario := range []string{"backup", "backup-link", "journal", "path", "outside"} {
		t.Run(scenario, func(t *testing.T) {
			boundaryPython(t, mutationJournalFixture+"scenario="+`'`+scenario+`'
with fixture() as (workspace,journal,rootfd,journalfd):
 original(workspace);crash_after_first(rootfd,journalfd)
 outside=workspace.parent/'outside';outside.write_bytes(b'outside sentinel')
 if scenario=='backup':(journal/'base-1').write_bytes(b'corrupt beta')
 elif scenario=='backup-link':(journal/'base-1').unlink();(journal/'base-1').symlink_to(outside)
 elif scenario=='journal':(journal/'state.json').write_bytes(b'not JSON')
 elif scenario=='path':
  state=g.json.loads((journal/'state.json').read_bytes());state['entries'][1]['path']='../outside'
  (journal/'state.json').write_text(g.json.dumps(state))
 else:(workspace/'b').write_bytes(b'outside saved beta')
 before={p.relative_to(workspace).as_posix():p.read_bytes() for p in workspace.rglob('*') if p.is_file()}
 refused(lambda:g.recover_mutation(rootfd,journalfd,4096))
 after={p.relative_to(workspace).as_posix():p.read_bytes() for p in workspace.rglob('*') if p.is_file()}
 assert after==before,'recovery modified earlier paths before validating later evidence'
 assert outside.read_bytes()==b'outside sentinel'
`)
		})
	}
}

func TestGuestMutationWorkerRejectsUnsafeInputsBeforeChanges(t *testing.T) {
	boundaryPython(t, mutationJournalFixture+`
with fixture() as (workspace,journal,rootfd,journalfd):
 original(workspace)
 outside=workspace.parent/'outside';outside.mkdir();(outside/'file').write_bytes(b'outside')
 (workspace/'link').symlink_to(outside,target_is_directory=True)
 (workspace/'leaf').symlink_to(outside/'file')
 os.mkfifo(workspace/'fifo')
 for batch in ([('../outside/file','absent',b'x',0o644)], [('/outside','absent',b'x',0o644)],
               [('link/file',H(b'outside'),b'x',0o644)], [('leaf',H(b'outside'),b'x',0o644)],
               [('fifo','absent',b'x',0o644)], [('a','unread',b'x',0o644)],
               [('a',H(b'alpha'),b'x',0o644),('a',H(b'alpha'),b'y',0o644)],
               [('dir','absent',b'x',0o644),('dir/file','absent',b'x',0o644)],
               [('a',H(b'alpha'),b'x',0o4000)], [('a',H(b'alpha'),b'x'*4097,0o644)],
               [('a',H(b'alpha'),b'x'*3000,0o644),('b',H(b'beta'),b'y'*3000,0o644)]):
  refused(lambda:g.apply_mutation_batch(rootfd,journalfd,batch,4096))
  assert not list(journal.iterdir())
  assert (workspace/'a').read_bytes()==b'alpha' and (workspace/'b').read_bytes()==b'beta'
  assert not (workspace/'dir').exists() and (outside/'file').read_bytes()==b'outside'
 groups=g.os.getgroups;g.os.getgroups=lambda:[20000]
 refused(lambda:g.apply_mutation_batch(rootfd,journalfd,changes(),4096),125)
 g.os.getgroups=groups
 euid=g.os.geteuid;g.os.geteuid=lambda:0
 refused(lambda:g.apply_mutation_batch(rootfd,journalfd,changes(),4096),125)
 g.os.geteuid=euid
 egid=g.os.getegid;g.os.getegid=lambda:0
 refused(lambda:g.apply_mutation_batch(rootfd,journalfd,changes(),4096),125)
 g.os.getegid=egid
 journal.chmod(0o755)
 refused(lambda:g.apply_mutation_batch(rootfd,journalfd,changes(),4096),125)
 assert not list(journal.iterdir())
`)
}

func TestGuestMutationStateFsyncFailureDoesNotUndoASettledCommit(t *testing.T) {
	for _, phase := range []string{"prepared", "committed"} {
		t.Run(phase, func(t *testing.T) {
			boundaryPython(t, mutationJournalFixture+"phase="+`'`+phase+`'
with fixture() as (workspace,journal,rootfd,journalfd):
 original(workspace)
 fsync=g.os.fsync;failed=[False]
 def sync(fd):
  state=journal/'state.json'
  if fd==journalfd and state.exists() and g.json.loads(state.read_bytes())['phase']==phase and not failed[0]:
   failed[0]=True;raise OSError('injected journal directory fsync failure')
  fsync(fd)
 g.os.fsync=sync
 try:
  try:g.apply_mutation_batch(rootfd,journalfd,changes(),4096)
  except OSError:pass
  else:raise AssertionError('failed durability reported success')
 finally:g.os.fsync=fsync
 assert failed[0]
 expected='aborted' if phase=='prepared' else 'committed'
 assert g.recover_mutation(rootfd,journalfd,4096)==expected
 if phase=='prepared':assert_original(workspace)
 else:
  assert (workspace/'a').read_bytes()==b'ALPHA'
  (workspace/'a').write_bytes(b'outside save after committed recovery')
  assert g.recover_mutation(rootfd,journalfd,4096)=='committed'
  assert (workspace/'a').read_bytes()==b'outside save after committed recovery'
`)
		})
	}
}
