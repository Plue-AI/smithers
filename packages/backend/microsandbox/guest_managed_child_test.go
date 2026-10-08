package microsandbox

import "testing"

// Actual fork, files and helper dispatch; cgroup files and credential drop are
// explicitly substituted. This proves ordering/status, not Linux exclusion or
// fresh/retained privileged-machine qualification.
func TestGuestFilesystemChildrenJoinBeforeOperands(t *testing.T) {
	boundaryPython(t, `
import io, pathlib, shutil, signal
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory); groups=root/'groups'; groups.mkdir()
 g.PROTECTED_BASE=directory; g.ROOT_UID=os.getuid()
 workspace=root/'workspace'; workspace.mkdir()
 target=workspace/'egress-ca.pem'; g.STATE_DIR=str(workspace)
 g.CGROUP_ROOT=str(groups)
 real_uid=os.getuid(); identity=[0]; admitted=[]; cleaned=[]
 g.os.geteuid=lambda:identity[0]
 def group(path,**kwargs):
  assert kwargs=={'trusted':True}
  assert pathlib.Path(path).parent==groups
  os.mkdir(path); pathlib.Path(path,'cgroup.procs').touch()
  admitted.append(path)
  return os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 g.safe_directory=group
 def drop(user):
  assert user=='agent' and identity[0]==0
  store=root.joinpath(*g.WRITER_COORDINATOR)
  protected={(p.stat().st_dev,p.stat().st_ino) for p in (store,store/'lock')}
  for name in os.listdir('/dev/fd'):
   try:info=os.fstat(int(name))
   except OSError:continue
   assert (info.st_dev,info.st_ino) not in protected,'protected descriptor reached child'
  assert pathlib.Path(admitted[-1],'cgroup.procs').read_text()==str(os.getpid())
  identity[0]=real_uid
 g.drop_to=drop
 def cleanup(path):
  assert identity[0]==0, 'parent must retain coordinator identity'
  child=int(pathlib.Path(path,'cgroup.procs').read_text())
  try:os.kill(child,0)
  except ProcessLookupError:pass
  else:raise AssertionError('direct child not reaped')
  cleaned.append(path); shutil.rmtree(path)
 g.cgroup_kill=cleanup
 class Operands(list):
  def __getitem__(self,index):
   if isinstance(index,int) and index>=2:
    assert identity[0]==real_uid, 'root read a branch operand'
    assert pathlib.Path(admitted[-1],'cgroup.procs').read_text()==str(os.getpid())
   return super().__getitem__(index)
 def call(operation, extra=(), expected=0):
  before={s:signal.getsignal(s) for s in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT)}
  try:g.main(Operands(['fs','agent',operation,str(workspace),target.name,*extra]))
  except SystemExit as result:assert result.code==expected,(operation,result.code)
  else:raise AssertionError('parent ignored child status')
  assert before=={s:signal.getsignal(s) for s in before}
  assert len(admitted)==len(cleaned) and list(groups.iterdir())==[]
 target.write_bytes(b'original\n')
 # fs_write_fixed uses safe_directory, which is unrelated to command admission.
 original_safe=g.safe_directory
 def directories(path,**kwargs):
  if kwargs.get('trusted'):return original_safe(path,**kwargs)
  assert identity[0]==real_uid
  return os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 g.safe_directory=directories
 g.sys.stdin=io.TextIOWrapper(io.BytesIO(b'replacement\n'))
 call('state-write')
 assert target.read_bytes()==b'replacement\n'
 call('state-read')
 call('compare-write',['644','absent','1024'],125)
 assert target.read_bytes()==b'replacement\n'
 call('remove')
 assert not target.exists()
 call('unsupported',expected=125)
 assert len(admitted)==5
`)
}

func TestGuestAdmissionFailureConsumesNoFilesystemOperands(t *testing.T) {
	boundaryPython(t, `
import pathlib,shutil
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory); groups=root/'groups'; groups.mkdir()
 g.PROTECTED_BASE=directory; g.ROOT_UID=os.getuid()
 g.CGROUP_ROOT=str(groups)
 g.os.geteuid=lambda:0
 def group(path,**kwargs):
  os.mkdir(path); pathlib.Path(path,'cgroup.procs').touch(mode=0o000)
  return os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 g.safe_directory=group
 g.drop_to=lambda user:(_ for _ in ()).throw(AssertionError('drop before admission'))
 g.cgroup_kill=lambda path:shutil.rmtree(path)
 class Operands(list):
  def __getitem__(self,index):
   if isinstance(index,int) and index>=2:
    raise AssertionError('consumed branch operands after failed admission')
   return super().__getitem__(index)
 try:g.main(Operands(['fs','agent','write','/workspace','file','644']))
 except SystemExit as result:assert result.code==126,result.code
 else:raise AssertionError('admission failure was ignored')
 assert list(groups.iterdir())==[]
`)
}

func TestGuestManagedChildPreservesFailureStatus(t *testing.T) {
	boundaryPython(t, `
import pathlib,shutil,signal
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory)
 g.CGROUP_ROOT=str(root)
 def group(path,**kwargs):
  os.mkdir(path); pathlib.Path(path,'cgroup.procs').touch()
  return os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 g.safe_directory=group
 g.drop_to=lambda user:None
 g.cgroup_kill=lambda path:shutil.rmtree(path)
 def action(entry):g.fail(6,'stale:fixture')
 assert g.run_managed_child('stale',action)==6
 def normal(entry):sys.exit()
 assert g.run_managed_child('normal',normal)==0
 class BrokenReply:
  def flush(self):raise BrokenPipeError('reader went away')
 def broken_reply(entry):g.sys.stdout=BrokenReply()
 assert g.run_managed_child('broken-reply',broken_reply)==126
 def killed(entry):os.kill(os.getpid(),signal.SIGKILL)
 assert g.run_managed_child('killed',killed)==137
 assert list(root.iterdir())==[]
`)
}
