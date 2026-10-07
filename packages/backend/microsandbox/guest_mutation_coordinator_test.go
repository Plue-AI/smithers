package microsandbox

import "testing"

// Real forks, pipes, journal/filesystem operations and control messages, with
// cgroup state and credentials instrumented. Linux kernel evidence is separate.
const mutationCoordinatorFixture = `
import hashlib,pathlib,shutil,signal
H=lambda body:hashlib.sha256(body).hexdigest()
temporary=tempfile.TemporaryDirectory();base=pathlib.Path(temporary.name)
workspace=base/'workspace';workspace.mkdir();(workspace/'a').write_bytes(b'alpha')
writers=base/'writers';writers.mkdir();(writers/'cgroup.freeze').write_text('0');(writers/'cgroup.events').write_text('frozen 0\n')
mutators=base/'mutators';mutators.mkdir()
g.CGROUP_ROOT=str(writers);g.MUTATION_CGROUP_ROOT=str(mutators)
g.PROTECTED_BASE=str(base);g.ROOT_UID=os.getuid()
real_uid,real_gid=os.getuid(),os.getgid();assert real_uid!=0
g.os.geteuid=lambda:0
entry=types.SimpleNamespace(pw_uid=real_uid)
g.mutation_account=lambda:(entry,real_gid)
# Keep the production deadline: these real child processes share the host
# scheduler, and their ordering assertions must not depend on a two-second slice.
real_directory=g.safe_directory
def directory(path,**kwargs):
 if path=='/workspace':return os.open(workspace,os.O_RDONLY|os.O_DIRECTORY)
 p=pathlib.Path(path)
 if p in (writers,mutators) or p.parent==mutators:
  if kwargs.get('create',True):
   p.mkdir(mode=0o700,exist_ok=True)
   if p.parent==mutators:(p/'cgroup.procs').touch(exist_ok=True)
  return os.open(p,os.O_RDONLY|os.O_DIRECTORY)
 return real_directory(path,**kwargs)
g.safe_directory=directory
g.cgroup_kill=lambda path,**kwargs:shutil.rmtree(path,ignore_errors=True)
listdir=os.listdir
g.os.listdir=lambda path:listdir('/dev/fd' if path=='/proc/self/fd' and not os.path.exists('/proc/self/fd') else path)
def drop(account,gid):
 assert account.pw_uid==real_uid and gid==real_gid
 store=base.joinpath(*g.WRITER_COORDINATOR)
 forbidden={(p.stat().st_dev,p.stat().st_ino) for p in (store,store/'lock',store/'pending')}
 for name in listdir('/dev/fd'):
  try:info=os.fstat(int(name))
  except OSError:continue
  assert (info.st_dev,info.st_ino) not in forbidden,'root coordinator descriptor leaked'
 assert (mutators/'active/cgroup.procs').read_text()==str(os.getpid())
 g.os.geteuid=lambda:real_uid;g.os.getgroups=lambda:[]
g.drop_mutation_identity=drop
write=os.write;events=[]
freeze_inode=(writers/'cgroup.freeze').stat().st_ino
def writing(fd,body):
 count=write(fd,body)
 if os.fstat(fd).st_ino==freeze_inode:
  (writers/'cgroup.events').write_text('frozen '+body.decode()+'\n')
  events.append(body)
 return count
g.os.write=writing
def prepare():
 assert g.os.geteuid()==real_uid and (writers/'cgroup.freeze').read_text()=='0'
 (base/'input-ready').touch()
 return [('a',H(b'alpha'),b'ALPHA',0o644)]
def emit(result):
 assert g.os.geteuid()==real_uid and (writers/'cgroup.freeze').read_text()=='0'
 assert result=={'a':H(b'ALPHA')}
 (base/'reply').write_bytes(b'replied')
def pending():return base.joinpath(*g.WRITER_COORDINATOR,'pending')
def no_pending():
 assert not pending().exists() and not list(mutators.iterdir())
 assert (writers/'cgroup.freeze').read_text()=='0'
`

func TestGuestMutationCoordinatorPreparesThenFreezesAndSettlesBeforeReply(t *testing.T) {
	boundaryPython(t, mutationCoordinatorFixture+`
freeze=g.mutation_freeze
def freezing(fd,value):
 if value:assert (base/'input-ready').exists(),'caller frozen before sending input'
 freeze(fd,value)
g.mutation_freeze=freezing
assert g.coordinate_mutation(prepare,emit,4096)==0
assert events==[b'1',b'0'],events
assert (workspace/'a').read_bytes()==b'ALPHA' and (base/'reply').read_bytes()==b'replied'
no_pending()
`)
}

func TestGuestMutationCoordinatorStaleRefusalSettlesWithoutReply(t *testing.T) {
	boundaryPython(t, mutationCoordinatorFixture+`
(workspace/'a').write_bytes(b'outside save')
assert g.coordinate_mutation(prepare,emit,4096)==6
assert (workspace/'a').read_bytes()==b'outside save' and not (base/'reply').exists()
assert events==[b'1',b'0'],events
no_pending()
`)
}

func TestGuestMutationCoordinatorFailedInputRecoversWithoutCallingInputAgain(t *testing.T) {
	boundaryPython(t, mutationCoordinatorFixture+`
def invalid():os.kill(os.getpid(),signal.SIGKILL)
try:g.coordinate_mutation(invalid,emit,4096)
except SystemExit as error:assert error.code==125,error.code
else:raise AssertionError('invalid input succeeded')
assert pending().exists() and events==[],events
assert (workspace/'a').read_bytes()==b'alpha'
def forbidden(*args):raise AssertionError('recovery consumed a new request or emitted a prior reply')
assert g.coordinate_mutation(forbidden,forbidden,4096,recover_only=True)==0
no_pending()
`)
}

func TestGuestMutationCoordinatorKeepsWritersFrozenAfterWorkerDeath(t *testing.T) {
	boundaryPython(t, mutationCoordinatorFixture+`
replace=g.os.replace
def replacing(source,target,**kwargs):
 replace(source,target,**kwargs)
 if target=='a':os.kill(os.getpid(),signal.SIGKILL)
g.os.replace=replacing
try:g.coordinate_mutation(prepare,emit,4096)
except SystemExit as error:assert error.code==125,error.code
else:raise AssertionError('dead mutation worker succeeded')
g.os.replace=replace
assert pending().exists() and (writers/'cgroup.freeze').read_text()=='1'
assert (workspace/'a').read_bytes()==b'ALPHA' and not (base/'reply').exists()
assert events==[b'1'],events
assert g.coordinate_mutation(None,None,4096,recover_only=True)==0
assert (workspace/'a').read_bytes()==b'alpha'
no_pending()
`)
}

func TestGuestMutationCoordinatorRecoversBeforeConsumingTheNextRequest(t *testing.T) {
	boundaryPython(t, mutationCoordinatorFixture+`
def invalid():os.kill(os.getpid(),signal.SIGKILL)
try:g.coordinate_mutation(invalid,emit,4096)
except SystemExit:pass
assert pending().exists()
assert g.coordinate_mutation(prepare,emit,4096)==0
assert (workspace/'a').read_bytes()==b'ALPHA'
assert events==[b'1',b'1',b'0',b'1',b'0'],events
no_pending()
`)
}

func TestGuestMutationCoordinatorNeverThawsUnknownRecovery(t *testing.T) {
	boundaryPython(t, mutationCoordinatorFixture+`
parent=g.protected_directory(g.WRITER_COORDINATOR,True)
p,j=g.mutation_pending(parent,entry,real_gid)
g.mutation_write_new(j,'state.json',b'not a journal',0o600)
os.close(j);os.close(p);os.close(parent)
try:g.coordinate_mutation(None,None,4096,recover_only=True)
except SystemExit as error:assert error.code==125,error.code
else:raise AssertionError('unknown recovery was accepted')
assert pending().exists() and (writers/'cgroup.freeze').read_text()=='1'
assert b'0' not in events,events
assert (workspace/'a').read_bytes()==b'alpha'
`)
}

func TestGuestMutationCredentialDropChecksSavedIDsAndDumpability(t *testing.T) {
	for _, scenario := range []string{"valid", "dumpable-policy", "saved-uid", "saved-gid", "groups", "prctl-set", "prctl-get"} {
		t.Run(scenario, func(t *testing.T) {
			boundaryPython(t, "scenario="+`'`+scenario+`'
import contextlib,pathlib
with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as mocks:
 policy=pathlib.Path(directory)/'policy';policy.write_bytes(b'2\n' if scenario=='dumpable-policy' else b'0\n')
 actual_open=g.os.open;calls=[]
 def opening(path,flags,*args,**kwargs):
  assert path=='/proc/sys/fs/suid_dumpable' and flags & os.O_NOFOLLOW
  calls.append('policy');return actual_open(policy,flags,*args,**kwargs)
 g.os.open=opening
 mocks.callback(setattr,g.os,'open',actual_open)
 ids={'uid':(0,0,0),'gid':(0,0,0),'groups':[20000]}
 def groups(value):
  assert value==[];calls.append('groups')
  if scenario!='groups':ids['groups']=value
 def gids(*value):
  assert ids['groups']==[] or scenario=='groups'
  assert value==(20000,20000,20000);calls.append('gid')
  ids['gid']=(20000,20000,0) if scenario=='saved-gid' else value
 def uids(*value):
  assert value==(19999,19999,19999);calls.append('uid')
  ids['uid']=(19999,19999,0) if scenario=='saved-uid' else value
 g.os.setgroups=groups;g.os.setresgid=gids;g.os.setresuid=uids
 g.os.getresuid=lambda:ids['uid'];g.os.getresgid=lambda:ids['gid']
 g.os.geteuid=lambda:ids['uid'][1];g.os.getegid=lambda:ids['gid'][1];g.os.getgroups=lambda:ids['groups']
 def prctl(option,*values):
  assert values==(0,0,0,0);calls.append(('prctl',option))
  assert ids['uid']==(19999,)*3 and ids['gid']==(20000,)*3 and ids['groups']==[]
  return -1 if scenario=='prctl-set' and option==4 else 1 if scenario=='prctl-get' and option==3 else 0
 g.ctypes.CDLL=lambda *args,**kwargs:types.SimpleNamespace(prctl=prctl)
 try:g.drop_mutation_identity(types.SimpleNamespace(pw_uid=19999),20000)
 except SystemExit as error:assert scenario!='valid' and error.code==125,(scenario,error.code)
 else:assert scenario=='valid',scenario
 if scenario=='dumpable-policy':assert calls==['policy'],calls
 elif scenario=='valid':assert calls==['policy','groups','gid','uid',('prctl',4),('prctl',3)],calls
 elif scenario in ('saved-uid','saved-gid','groups'):assert not any(isinstance(call,tuple) for call in calls)
`)
		})
	}
}

func TestGuestMutationCoordinatorRefusesUnsafeRecoveryDirectories(t *testing.T) {
	for _, scenario := range []string{"pending-link", "pending-mode", "journal-link", "journal-file"} {
		t.Run(scenario, func(t *testing.T) {
			boundaryPython(t, mutationCoordinatorFixture+"scenario="+`'`+scenario+`'
store=g.protected_directory(g.WRITER_COORDINATOR,True);os.close(store)
outside=base/'outside';outside.mkdir();(outside/'sentinel').write_bytes(b'outside')
if scenario=='pending-link':pending().symlink_to(outside,target_is_directory=True)
else:
 pending().mkdir(mode=0o700)
 if scenario=='pending-mode':pending().chmod(0o755)
 elif scenario=='journal-link':(pending()/'journal').symlink_to(outside,target_is_directory=True)
 else:(pending()/'journal').write_bytes(b'not a directory')
g.recover_mutation=lambda *args:(_ for _ in ()).throw(AssertionError('unsafe journal reached worker'))
try:g.coordinate_mutation(None,None,4096,recover_only=True)
except (SystemExit,OSError):pass
else:raise AssertionError('unsafe recovery directory accepted')
assert pending().exists() and (outside/'sentinel').read_bytes()==b'outside'
assert events==[],events
`)
		})
	}
}

func TestGuestMutationCoordinatorPipeSetupFailureClosesDescriptors(t *testing.T) {
	boundaryPython(t, mutationCoordinatorFixture+`
pipe=g.os.pipe;opened=[]
def pipes():
 if opened:raise OSError('injected second pipe failure')
 pair=pipe();opened.extend(pair);return pair
g.os.pipe=pipes
try:g.coordinate_mutation(prepare,emit,4096)
except OSError:pass
else:raise AssertionError('pipe failure accepted')
g.os.pipe=pipe
for fd in opened:
 try:os.fstat(fd)
 except OSError:pass
 else:raise AssertionError('failed setup leaked control descriptor')
assert pending().exists() and events==[]
assert g.coordinate_mutation(None,None,4096,recover_only=True)==0
no_pending()
`)
}

func TestGuestKillAllCollectsMutationWorkerWithoutClearingRecovery(t *testing.T) {
	boundaryPython(t, mutationCoordinatorFixture+`
store=g.protected_directory(g.WRITER_COORDINATOR,True)
p,j=g.mutation_pending(store,entry,real_gid)
os.close(p);os.close(j);os.close(store)
(writers/'cgroup.freeze').write_text('1')
collected=[]
g.cgroup_kill=lambda path,**kwargs:collected.append((path,kwargs))
g.main(['kill-all'])
assert collected==[(str(mutators/'active'),{'mutation':True,'collect':False})],collected
assert pending().exists() and (writers/'cgroup.freeze').read_text()=='1'
`)
}

func TestGuestCgroupCollectionAcceptsRemovedInodeWithoutRemovingReplacement(t *testing.T) {
	for _, scenario := range []string{"removed", "replaced", "missing-events", "leave-directory"} {
		t.Run(scenario, func(t *testing.T) {
			boundaryPython(t, "scenario="+`'`+scenario+`'
import pathlib,shutil
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);group=root/'active';group.mkdir(mode=0o700)
 (group/'cgroup.kill').touch()
 if scenario=='leave-directory':(group/'cgroup.events').write_text('populated 0\n')
 g.CGROUP_ROOT=directory;g.ROOT_UID=os.getuid()
 opening=os.open
 g.safe_directory=lambda path,**kwargs:opening(path,os.O_RDONLY|os.O_DIRECTORY)
 def opened(path,*args,**kwargs):
  if path=='cgroup.events' and scenario in ('removed','replaced'):
   shutil.rmtree(group)
   if scenario=='replaced':group.mkdir(mode=0o700);(group/'sentinel').write_bytes(b'replacement')
  return opening(path,*args,**kwargs)
 g.os.open=opened
 try:
  try:g.cgroup_kill(str(group),collect=scenario!='leave-directory')
  except RuntimeError:assert scenario=='missing-events',scenario
  else:assert scenario!='missing-events'
 finally:g.os.open=opening
 if scenario=='replaced':assert (group/'sentinel').read_bytes()==b'replacement'
 elif scenario=='removed':assert not group.exists()
 elif scenario=='leave-directory':assert group.exists()
`)
		})
	}
}
