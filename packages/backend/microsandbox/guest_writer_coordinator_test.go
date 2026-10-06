package microsandbox

import "testing"

// Real protected-directory operations, flock and child processes under the
// test user's uid. This deliberately substitutes only the root base and uid;
// it is not fresh/retained privileged-machine or atomic-write qualification.
func TestGuestWriterCoordinatorRefusesUnsafeLockAndPendingRecovery(t *testing.T) {
	boundaryPython(t, `
import pathlib
with tempfile.TemporaryDirectory() as directory:
 g.PROTECTED_BASE=directory; g.ROOT_UID=os.getuid()
 parent=g.protected_directory(g.WRITER_COORDINATOR,True); os.close(parent)
 store=pathlib.Path(directory).joinpath(*g.WRITER_COORDINATOR)
 outside=pathlib.Path(directory)/'outside'; outside.write_bytes(b'outside unchanged')
 lock=store/'lock'
 def refused():
  entered=False
  try:
   with g.writer_admission():entered=True
  except (SystemExit,OSError):pass
  else:raise AssertionError('unsafe coordinator admitted')
  assert not entered
  assert outside.read_bytes()==b'outside unchanged'
 for kind in ('symlink','hardlink','fifo','directory','writable'):
  if kind=='symlink':lock.symlink_to(outside)
  elif kind=='hardlink':os.link(outside,lock)
  elif kind=='fifo':os.mkfifo(lock)
  elif kind=='directory':lock.mkdir()
  else:lock.touch(mode=0o666);lock.chmod(0o666)
  refused()
  if kind=='directory':lock.rmdir()
  else:lock.unlink()
 with g.writer_admission():pass
 assert lock.stat().st_mode & 0o777==0o600
 marker=store/'pending'
 for kind in ('file','symlink','directory'):
  if kind=='file':marker.write_bytes(b'not trusted journal JSON')
  elif kind=='symlink':marker.symlink_to(outside)
  else:marker.mkdir()
  real_open=g.os.open
  def no_journal_read(path,*args,**kwargs):
   assert path!='pending','root opened branch recovery bytes'
   return real_open(path,*args,**kwargs)
  g.os.open=no_journal_read
  refused()
  g.os.open=real_open
  if kind=='directory':marker.rmdir()
  else:marker.unlink()
 with g.writer_admission():pass
`)
}

func TestGuestWriterCoordinatorSerializesAndRetainsCrashFence(t *testing.T) {
	boundaryPython(t, `
import pathlib,subprocess,signal,time
with tempfile.TemporaryDirectory() as directory:
 g.PROTECTED_BASE=directory;g.ROOT_UID=os.getuid()
 root=pathlib.Path(directory);ready=root/'ready';entered=root/'entered'
 child_source='''import importlib.util,os,pathlib,signal,sys
spec=importlib.util.spec_from_file_location('guest',sys.argv[1])
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
g.PROTECTED_BASE=sys.argv[2];g.ROOT_UID=os.getuid()
root=pathlib.Path(sys.argv[2]);(root/'ready').touch()
mode=sys.argv[3]
guard=g.writer_admission() if mode=='admit' else g.writer_coordinator(exclusive=True)
with guard as directory:
 (root/'entered').touch()
 if mode=='crash':
  fd=os.open('pending',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=directory)
  os.fsync(fd);os.close(fd);os.fsync(directory)
  os.kill(os.getpid(),signal.SIGKILL)
'''
 helper=os.path.abspath('guest/smithers-guest.py')
 def start(mode):
  ready.unlink(missing_ok=True);entered.unlink(missing_ok=True)
  return subprocess.Popen([sys.executable,'-I','-B','-c',child_source,helper,directory,mode])
 def wait_ready():
  deadline=time.monotonic()+5
  while not ready.exists():
   assert time.monotonic()<deadline,'child startup timeout'
   time.sleep(.01)
 for exclusive,mode in ((True,'admit'),(False,'exclusive')):
  with g.writer_coordinator(exclusive=exclusive):
   child=start(mode)
   try:
    wait_ready();time.sleep(.1)
    assert not entered.exists(),'writer entered while conflicting lock held'
   except BaseException:
    child.kill();child.wait();raise
  assert child.wait(timeout=5)==0
  assert entered.exists(),'positive control did not enter after release'
 child=start('crash')
 assert child.wait(timeout=5)==-signal.SIGKILL
 store=root.joinpath(*g.WRITER_COORDINATOR)
 assert (store/'pending').exists(),'crash lost the recovery fence'
 try:
  with g.writer_admission():raise AssertionError('admission resumed after crash')
 except SystemExit as error:assert error.code==125,error.code
 # This only stands in for explicit recovery, not a production rollback.
 with g.writer_coordinator(exclusive=True) as fd:
  os.unlink('pending',dir_fd=fd);os.fsync(fd)
 with g.writer_admission():pass
`)
}

func TestGuestWriterPendingRecoveryRefusesRootDispatch(t *testing.T) {
	boundaryPython(t, `
import hashlib,pathlib,subprocess
with tempfile.TemporaryDirectory() as directory:
 g.PROTECTED_BASE=directory;g.ROOT_UID=os.getuid()
 with g.writer_coordinator(exclusive=True) as fd:
  pending=os.open('pending',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600,dir_fd=fd)
  os.close(pending)
 g.os.geteuid=lambda:0
 def forbidden(*args,**kwargs):raise AssertionError('dispatch crossed recovery fence')
 g.safe_directory=forbidden;g.setup=forbidden;g.fs_write=forbidden
 subprocess.run=forbidden
 class BranchOperands(list):
  def __getitem__(self,index):
   if isinstance(index,int) and index>=2:raise AssertionError('root consumed file operands')
   return super().__getitem__(index)
 request={'id':'valid-command','user':'agent','argv':['must-not-run']}
 script='exit 0';digest=hashlib.sha256(script.encode()).hexdigest()
 g.ROOT_RECIPE_DIGESTS={digest:'sync'}
 for run in (lambda:g.run_exec(request),
             lambda:g.main(BranchOperands(['fs','agent','write','/workspace','file','644'])),
             lambda:g.main(['setup','agent','19999']),
             lambda:g.run_root_recipe(digest,{'script':script})):
  try:run()
  except SystemExit as error:assert error.code==125,error.code
  else:raise AssertionError('pending recovery admitted dispatch')
`)
}
