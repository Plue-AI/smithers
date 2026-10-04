package microsandbox

import (
	"crypto/sha256"
	"fmt"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// Supplemental unit evidence only. C-SEC-02 requires an installed approved
// bundle and fresh/retained real machines; these tests never execute as root.
func boundaryPython(t *testing.T, body string) {
	t.Helper()
	require.NotZero(t, os.Geteuid(), "branch tests must never execute as host root")
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	script := `import importlib.util, os, pwd, sys, tempfile, types
spec=importlib.util.spec_from_file_location('guest','guest/smithers-guest.py')
g=importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
` + body
	output, err := exec.Command(python, "-I", "-B", "-c", script).CombinedOutput()
	require.NoError(t, err, string(output))
}

func TestGuestHelperInstallPinsInterpreterAndEnv(t *testing.T) {
	t.Run("filesystem", TestGuestBootstrapFilesystemSupplemental)
	t.Run("approved-startup", TestRootBoundaryApprovedBundleStartup)

	t.Run("CSEC02", func(t *testing.T) { rootBoundaryLifecycle(t, false) })
	args := guestArgs("fixture", map[string]string{"PATH": "/hostile", "PYTHONPATH": "/hostile", "LD_PRELOAD": "/hostile"}, false, "kill-all")
	joined := strings.Join(args, " ")
	require.Contains(t, joined, "-e PATH=/usr/bin:/bin -e PYTHONPATH= -e LD_PRELOAD= -e LD_LIBRARY_PATH=")
	require.Contains(t, joined, "-- /usr/bin/env -i PATH=/usr/bin:/bin PYTHONPATH= /usr/bin/python3 -I -S -c")
	require.Contains(t, joined, "hashlib.sha256(body).hexdigest()!=sys.argv[1]")
	require.Contains(t, joined, "os.O_DIRECTORY|os.O_NOFOLLOW")
	require.Contains(t, joined, "exec(compile(body")
	require.Equal(t, "kill-all", args[len(args)-1])
	body, err := os.ReadFile("guest/smithers-guest.py")
	require.NoError(t, err)
	require.Contains(t, args, fmt.Sprintf("%x", sha256.Sum256(body)))
}

func TestRootSetupNeverFollowsMemberSymlinks(t *testing.T) {
	t.Run("replacement", TestRootHomeReplacementSupplemental)
	t.Run("approved-retained", TestRootBoundaryApprovedBundleRetainedHome)

	t.Run("CSEC02", func(t *testing.T) { rootBoundaryLifecycle(t, true) })
	boundaryPython(t, `
with tempfile.TemporaryDirectory() as directory:
 directory=os.path.realpath(directory)
 home=directory+'/home'; os.mkdir(home)
 me=pwd.getpwuid(os.getuid())
 entry=types.SimpleNamespace(pw_dir=home,pw_uid=me.pw_uid,pw_gid=me.pw_gid)
 env=directory+'/env.json'; g.ENV_FILE=env; g.TOOL_HOME=directory+'/absent-tool-home'
 with open(env,'w') as f: f.write('{"GOTOOLCHAIN":"local"}')
 for target in ('/etc','/root'):
  os.symlink(target,home+'/.config')
  try: g.home_defaults(entry)
  except (OSError,SystemExit): pass
  else: raise AssertionError('followed member ancestor '+target)
  os.unlink(home+'/.config')
 g.home_defaults(entry)
 assert open(home+'/.config/go/env').read()=='GOTOOLCHAIN=local\n'
 sentinel=directory+'/sentinel'
 with open(sentinel,'w') as f: f.write('outside bytes')
 before=os.stat(sentinel)
 os.unlink(home+'/.config/go/env'); os.symlink(sentinel,home+'/.config/go/env')
 try: g.home_defaults(entry)
 except (OSError,SystemExit): pass
 else: raise AssertionError('followed leaf')
 after=os.stat(sentinel)
 assert open(sentinel).read()=='outside bytes'
 assert (before.st_uid,before.st_gid,before.st_mode)==(after.st_uid,after.st_gid,after.st_mode)
 # Swap an ancestor immediately before open; no target is followed.
 os.unlink(home+'/.config/go/env')
 real_open=os.open
 def racing_open(path,flags,*args,**kwargs):
  if path=='go':
   os.rename(home+'/.config/go',home+'/.config/old-go')
   os.symlink('/etc',home+'/.config/go')
  return real_open(path,flags,*args,**kwargs)
 g.os.open=racing_open
 try: g.home_defaults(entry)
 except OSError: pass
 else: raise AssertionError('followed raced ancestor')
 finally: g.os.open=real_open
 os.symlink('/etc',home+'/ancestor')
 try: g.safe_directory(home+'/ancestor/new')
 except OSError: pass
 else: raise AssertionError('followed setup ancestor')
`)
}

func TestRootPreflightParsesOnlyEnvelope(t *testing.T) {
	t.Run("identity", TestRootIdentityDropOrderingSupplemental)
	t.Run("approved-dispatch", TestRootBoundaryApprovedBundleDispatch)

	t.Run("CSEC02", func(t *testing.T) {
		rootBoundaryLifecycle(t, false)
		t.Run("files", TestRealMicroVMWorkspaceConformance)
		t.Run("terminal-relay", TestRealMicroVMTerminalAndManagedHost)
		t.Run("cancellation", TestRealMicroVMCancellationKillsGuestWork)
		t.Run("restart", TestRealMicroVMServicePreviewAndRestart)
	})
	boundaryPython(t, `
class Dropped(Exception): pass
accesses=[]
class Envelope(dict):
 def get(self,key,*args):
  accesses.append(key)
  assert key in ('id','user'), 'pre-drop payload access: '+key
  return super().get(key,*args)
request=Envelope(id='literal-id',user='agent',argv=['/usr/bin/true'],env={'PATH':'/hostile','PYTHONPATH':'/hostile','LD_PRELOAD':'/hostile'},cwd='/hostile',root='/workspace')
g.safe_directory=lambda path,**kwargs: os.open('/',os.O_RDONLY)
g.os.fork=lambda: 0
class Handle:
 def __enter__(self): return self
 def __exit__(self,*args): pass
 def write(self,data): pass
real_open=g.os.open
g.os.open=lambda *args,**kwargs: real_open('/',os.O_RDONLY)
g.os.fdopen=lambda *args,**kwargs: Handle()
def drop(user):
 assert user=='agent'
 raise Dropped()
g.drop_to=drop
g.os._exit=lambda code: (_ for _ in ()).throw(Dropped())
try: g.run_exec(request)
except Dropped: pass
else: raise AssertionError('drop not reached')
assert accesses==['id','user'], accesses
for user in ('root','','other'):
 try: g.run_exec({'id':'literal-id','user':user})
 except SystemExit: pass
 else: raise AssertionError('invalid identity accepted')
for name in ('../root','.','..','/root','x/y','é'):
 assert not g.valid_id(name), name
# Independently observe the credential syscall order without executing root code.
import io
for body in (b'{', b'x'*1048577):
 try: g.read_request(io.BytesIO(body))
 except (SystemExit,ValueError): pass
 else: raise AssertionError('malformed/oversized request accepted')
calls=[]
g.pwd.getpwnam=lambda user: types.SimpleNamespace(pw_uid=19999,pw_gid=19999,pw_dir='/home/agent',pw_shell='/bin/bash')
g.grp=types.SimpleNamespace(getgrnam=lambda name: types.SimpleNamespace(gr_gid=20000,gr_mem=['agent']),getgrall=lambda:[])
g.os.geteuid=lambda: 0
g.os.setgroups=lambda groups: calls.append(('groups',groups))
g.os.setgid=lambda gid: calls.append(('gid',gid))
g.os.setuid=lambda uid: calls.append(('uid',uid))
# Restore the production drop function after the preflight observation.
original=importlib.util.module_from_spec(spec); spec.loader.exec_module(original)
original.grp=g.grp
original.drop_to('agent')
assert calls==[('groups',[20000]),('gid',19999),('uid',19999)], calls
`)
}

// Lifecycle receipts require the reviewed installed bundle on a reference host.
// Never enable this for branch-built privileged code.
func rootBoundaryLifecycle(t *testing.T, hostileHome bool) {
	t.Helper()
	if os.Getenv("SMITHERS_GUEST_ROOT_BOUNDARY_CHECK") != "1" {
		t.Skip("PENDING C-SEC-02: requires approved installed bundle and real msb; set SMITHERS_GUEST_ROOT_BOUNDARY_CHECK=1")
	}
	runtime := realRuntime(t, t.TempDir())
	ctx := operation("root-boundary")
	id := "root-boundary"
	_, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	require.NoError(t, err)
	check := func() {
		result, err := runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/usr/bin/python3", "-I", "-c", `import os; assert os.getuid()==19999; assert os.getgid()==19999; assert os.getgroups()==[20000]; print('identity-ok')`}})
		require.NoError(t, err)
		require.Equal(t, 0, result.ExitCode)
		require.Equal(t, "identity-ok\n", result.Stdout)
	}
	check()
	if hostileHome {
		result, err := runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/usr/bin/python3", "-I", "-c", `import os; os.symlink('/etc','/home/agent/.config'); os.symlink('/root','/home/agent/.cache')`}})
		require.NoError(t, err)
		require.Equal(t, 0, result.ExitCode)
	}
	require.NoError(t, runtime.StopWorkspace(ctx, id))
	_, err = runtime.StartWorkspace(ctx, id)
	if hostileHome {
		require.Error(t, err)
	} else {
		require.NoError(t, err)
		check()
	}
}

// The setup fixture supplies OS identity/syscalls because this unit evidence
// must never run privileged code on the host. All branch disk reads are trapped.
func TestWarmSetupDoesNotReadBranchOutputAsRoot(t *testing.T) {
	boundaryPython(t, `
entry=types.SimpleNamespace(pw_dir='/home/agent',pw_uid=19999,pw_gid=19999,pw_shell='/bin/bash')
g.pwd.getpwnam=lambda user: entry
g.grp=types.SimpleNamespace(getgrnam=lambda name: types.SimpleNamespace(gr_gid=20000,gr_mem=['agent']),getgrall=lambda:[])
g.safe_directory=lambda *args,**kwargs: 10
g.os.mkdir=lambda *args,**kwargs: (_ for _ in ()).throw(FileExistsError())
g.os.open=lambda *args,**kwargs: 10
g.os.close=lambda *args: None
g.os.fstat=lambda fd: types.SimpleNamespace(st_uid=19999,st_gid=19999)
g.os.fchown=lambda *args: None
g.os.fchmod=lambda *args: None
g.os.listdir=lambda *args: (_ for _ in ()).throw(AssertionError('root enumerated branch output'))
g.home_defaults=lambda *args: (_ for _ in ()).throw(AssertionError('root consumed home output'))
g.sanitize_system_image=lambda: None
g.configure_shared_git=lambda: None
g.prepare_system_identity=lambda: None
g.setup('agent',19999,['/var/cache/smithers'])
`)
}

func TestWarmHomeInitializationDropsIdentityBeforeReadingOutput(t *testing.T) {
	boundaryPython(t, `
with tempfile.TemporaryDirectory() as directory:
 home=os.path.realpath(directory)+'/home'; tools=os.path.realpath(directory)+'/tools'
 os.mkdir(home); os.mkdir(tools); open(tools+'/branch-created','w').close()
 g.TOOL_HOME=tools; g.ENV_FILE=directory+'/absent-env'
 entry=types.SimpleNamespace(pw_dir=home,pw_uid=19999,pw_gid=19999,pw_shell='/bin/bash')
 state=[0]; calls=[]
 g.os.geteuid=lambda: state[0]
 def setup(*args):
  assert state[0]==0; calls.append('root-fixed-setup')
 g.setup=setup
 def drop(user):
  assert user=='agent'; state[0]=19999; calls.append('drop'); return entry
 g.drop_to=drop
 listdir=os.listdir
 def read(fd):
  assert state[0]==19999, 'branch output read as root'
  calls.append('branch-read'); return listdir(fd)
 g.os.listdir=read
 g.main(['setup','agent','19999'])
 assert calls==['root-fixed-setup','drop','branch-read'],calls
 assert os.readlink(home+'/branch-created')==tools+'/branch-created'
`)
}

func TestRootExecNeverParsesBranchPayload(t *testing.T) {
	boundaryPython(t, `
import io
body=b'{"id":"host-id","user":"agent","argv":["branch-script"]}'
g.sys.stdin=io.TextIOWrapper(io.BytesIO(body))
# A root transport test must not interpret even valid JSON branch payloads.
g.json.loads=lambda *args: (_ for _ in ()).throw(AssertionError('root parsed branch payload'))
class Untouched(io.BytesIO):
 def read(self,*args): raise AssertionError('root read branch bytes')
g.sys.stdin=types.SimpleNamespace(buffer=Untouched(body))
seen=[]
def supervise(request):
 assert request=={'id':'host-id','user':'agent','payload':g.sys.stdin.buffer}
 seen.append(request['id']); return 0
g.run_exec=supervise
try: g.main(['exec','host-id'])
except SystemExit as exit: assert exit.code==0
assert seen==['host-id']
`)
}

func TestRootRequestTransferReadsBranchBytesOnlyAfterDrop(t *testing.T) {
	boundaryPython(t, `
import io
with tempfile.TemporaryDirectory() as directory:
 g.protected_requests=lambda: os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
 identity=[0]
 def drop(user):
  assert user=='agent'; identity[0]=19999
 g.drop_to=drop
 class Branch(io.BytesIO):
  def read(self,*args):
   assert identity[0]==19999, 'root read branch IPC bytes'
   return super().read(*args)
 g.sys.stdin=types.SimpleNamespace(buffer=Branch(b'branch payload'))
 g.main(['put-request','host-id'])
 assert identity==[0],identity
 assert open(directory+'/host-id.json','rb').read()==b'branch payload'
 assert os.stat(directory+'/host-id.json').st_mode & 0o777 == 0o600
 g.sys.stdin=types.SimpleNamespace(buffer=Branch(b'x'*1048577))
 try: g.main(['put-request','oversized'])
 except SystemExit as error: assert error.code==125
 else: raise AssertionError('oversized input accepted')
 assert not os.path.exists(directory+'/oversized.json')
`)
}

func TestMemberImageRootInputs(t *testing.T) {
	// Real descriptor operations in an unprivileged temporary image; only owner
	// observations are substituted. No branch-built script executes as root.
	boundaryPython(t, `
with tempfile.TemporaryDirectory() as directory:
 root=os.path.realpath(directory)
 usr=root+'/usr'; os.mkdir(usr); os.mkdir(usr+'/bin'); os.mkdir(usr+'/shared',0o2775)
 os.chmod(usr+'/shared',0o2775)
 for name in ('sudo','su','sshd','tool'):
  with open(usr+'/bin/'+name,'wb') as f: f.write(b'image fixture')
  os.chmod(usr+'/bin/'+name,0o6755)
 outside=root+'/outside'; os.mkdir(outside)
 sentinel=outside+'/sentinel'; open(sentinel,'w').write('outside bytes'); os.chmod(sentinel,0o6755)
 os.symlink(outside,usr+'/symlink')
 original=g.safe_directory; real_fstat=os.fstat
 g.safe_directory=lambda path,**kwargs: os.open(usr,os.O_RDONLY|os.O_DIRECTORY)
 # An image-owned setgid directory is preserved, but writable ancestors fail
 # closed. Use a non-writable setgid directory for successful sanitation.
 os.chmod(usr+'/shared',0o2755)
 def owned(fd):
  info=real_fstat(fd)
  return types.SimpleNamespace(st_uid=0,st_mode=info.st_mode)
 g.os.fstat=owned
 g.os.listxattr=lambda fd:['security.capability']
 removed=[];g.os.removexattr=lambda fd,name: removed.append(name)
 g.sanitize_system_image()
 assert not any(os.path.exists(usr+'/bin/'+name) for name in ('sudo','su','sshd'))
 assert os.stat(usr+'/bin/tool').st_mode & 0o7777 == 0o755
 assert os.stat(usr+'/shared').st_mode & 0o7777 == 0o2755
 assert removed==['security.capability']
 assert open(sentinel).read()=='outside bytes'
 assert os.stat(sentinel).st_mode & 0o7777 == 0o6755
 os.chmod(usr+'/bin',0o777)
 try:g.sanitize_system_image()
 except SystemExit:pass
 else:raise AssertionError('writable image ancestor accepted')
 g.os.fstat=real_fstat;g.safe_directory=original
`)
}

func TestMemberSetupAndIdentityRefusals(t *testing.T) {
	boundaryPython(t, `
team=types.SimpleNamespace(gr_gid=20000,gr_mem=['ben','alice','agent'])
g.grp=types.SimpleNamespace(getgrnam=lambda name:team,getgrall=lambda:[])
accounts={name:types.SimpleNamespace(pw_uid=uid,pw_gid=uid,pw_dir='/home/'+name,pw_shell='/bin/bash') for name,uid in (('ben',20001),('alice',20002),('agent',19999))}
g.pwd.getpwnam=lambda name:accounts[name]
for name,uid in (('ben',20001),('alice',20002),('agent',19999)):
 calls=[]
 g.os.geteuid=lambda:0
 g.os.setgroups=lambda groups:calls.append(('groups',groups))
 g.os.setgid=lambda gid:calls.append(('gid',gid))
 g.os.setuid=lambda uid:calls.append(('uid',uid))
 g.drop_to(name,uid)
 assert calls==[('groups',[20000]),('gid',uid),('uid',uid)],calls
for name,uid in (('root',20001),('machined',20001),('agent',20001),('ben',19999),('Ben',20001),('../ben',20001)):
 try:g.setup(name,uid,[])
 except SystemExit:pass
 else:raise AssertionError('invalid setup identity accepted')
for name,uid in (('ben',20002),('ben',0),('alice',None)):
 try:g.drop_to(name,uid)
 except SystemExit:pass
 else:raise AssertionError('account mismatch accepted')
# No member command is exposed through the root transport before activation.
for name in ('ben','root','machined'):
 try:g.main(['setup',name,'20001'])
 except SystemExit:pass
 else:raise AssertionError('dark provisioning command accepted')
team.gr_mem=[]
try:g.drop_to('ben',20001)
except SystemExit:pass
else:raise AssertionError('missing team binding accepted')
team.gr_mem=['ben']
g.grp.getgrall=lambda:[types.SimpleNamespace(gr_gid=27,gr_mem=['ben'])]
try:g.drop_to('ben',20001)
except SystemExit:pass
else:raise AssertionError('privileged supplementary group accepted')
`)
}

func TestMemberHomesRemainPrivateAndRetained(t *testing.T) {
	boundaryPython(t, `
with tempfile.TemporaryDirectory() as directory:
 root=os.path.realpath(directory)
 home=root+'/homes';outside=root+'/outside';os.mkdir(home);os.mkdir(outside)
 sentinel=outside+'/sentinel';open(sentinel,'wb').write(b'outside sentinel')
 entry=types.SimpleNamespace(pw_uid=20001,pw_gid=20001,pw_dir='/home/ben',pw_shell='/bin/bash')
 g.pwd.getpwnam=lambda name:entry
 g.grp=types.SimpleNamespace(getgrnam=lambda name:types.SimpleNamespace(gr_gid=20000,gr_mem=['ben']),getgrall=lambda:[])
 g.safe_directory=lambda path,**kwargs:os.open(home,os.O_RDONLY|os.O_DIRECTORY) if path=='/home' else (_ for _ in ()).throw(AssertionError('unexpected setup path '+path))
 real_fstat=os.fstat
 def owned(fd):
  info=real_fstat(fd)
  return types.SimpleNamespace(st_uid=20001,st_gid=20001,st_mode=info.st_mode)
 g.os.fstat=owned
 ownership=[];g.os.fchown=lambda fd,uid,gid:ownership.append((uid,gid))
 g.setup('ben',20001,[])
 assert ownership==[(20001,20001)]
 assert os.stat(home+'/ben').st_mode & 0o7777 == 0o700
 marker=home+'/ben/.marker';open(marker,'wb').write(b'machine A only');os.chmod(marker,0o664)
 ownership.clear()
 g.setup('ben',20001,[])
 assert ownership==[], 'retained home was rechowned'
 assert open(marker,'rb').read()==b'machine A only'
 assert os.stat(marker).st_mode & 0o777 == 0o664
 # Another machine has an independent empty home, without copying a marker.
 other=root+'/machine-b';os.mkdir(other)
 g.safe_directory=lambda path,**kwargs:os.open(other,os.O_RDONLY|os.O_DIRECTORY)
 g.setup('ben',20001,[])
 assert not os.path.exists(other+'/ben/.marker')
 g.safe_directory=lambda path,**kwargs:os.open(home,os.O_RDONLY|os.O_DIRECTORY)
 # A retained home owned by a different allocation is refused before chown.
 g.os.fstat=lambda fd:types.SimpleNamespace(st_uid=20002,st_gid=20002)
 ownership.clear()
 try:g.setup('ben',20001,[])
 except SystemExit:pass
 else:raise AssertionError('retained home ownership mismatch accepted')
 assert ownership==[]
 g.os.fstat=owned
 os.rename(home+'/ben',home+'/old-ben');os.symlink(outside,home+'/ben')
 try:g.setup('ben',20001,[])
 except OSError:pass
 else:raise AssertionError('retained home symlink accepted')
 assert ownership==[]
 assert open(sentinel,'rb').read()==b'outside sentinel'
 g.os.fstat=real_fstat
`)
}

func TestMemberSharedGitConfigRejectsSymlink(t *testing.T) {
	boundaryPython(t, `
with tempfile.TemporaryDirectory() as directory:
 directory=os.path.realpath(directory)
 g.safe_directory=lambda path,**kwargs:os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
 real_fstat=os.fstat
 def owned(fd):
  info=real_fstat(fd)
  return types.SimpleNamespace(st_uid=0,st_mode=info.st_mode,st_nlink=info.st_nlink)
 g.os.fstat=owned
 g.configure_shared_git()
 assert open(directory+'/gitconfig','rb').read()==b'[safe]\n\tdirectory = /workspace\n'
 g.configure_shared_git()
 assert os.stat(directory+'/gitconfig').st_mode & 0o777 == 0o644
 sentinel=directory+'/sentinel';open(sentinel,'wb').write(b'outside bytes')
 os.unlink(directory+'/gitconfig');os.symlink(sentinel,directory+'/gitconfig')
 try:g.configure_shared_git()
 except OSError:pass
 else:raise AssertionError('gitconfig symlink followed')
 assert open(sentinel,'rb').read()==b'outside bytes'
 os.unlink(directory+'/gitconfig');os.link(sentinel,directory+'/gitconfig')
 try:g.configure_shared_git()
 except SystemExit:pass
 else:raise AssertionError('gitconfig hardlink followed')
 assert open(sentinel,'rb').read()==b'outside bytes'
 g.os.fstat=real_fstat
`)
}

func TestMemberDaemonImageAccount(t *testing.T) {
	boundaryPython(t, `
import subprocess
accounts={}
def lookup(name):
 if name not in accounts:raise KeyError(name)
 return accounts[name]
g.pwd.getpwnam=lookup
g.pwd.getpwuid=lambda uid:(_ for _ in ()).throw(KeyError(uid))
g.grp=types.SimpleNamespace(getgrall=lambda:[])
calls=[]
def run(argv,**kwargs):
 assert argv==['/usr/sbin/useradd','--uid','19998','--gid','team','--no-user-group','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin','--','machined'],argv
 assert kwargs=={'check':True,'env':{'PATH':'/usr/bin:/bin'}}
 calls.append(argv)
 accounts['machined']=types.SimpleNamespace(pw_uid=19998,pw_gid=20000,pw_dir='/nonexistent',pw_shell='/usr/sbin/nologin')
subprocess.run=run
g.prepare_system_identity();g.prepare_system_identity()
assert len(calls)==1
accounts['machined'].pw_uid=0
try:g.prepare_system_identity()
except SystemExit:pass
else:raise AssertionError('root daemon accepted')
accounts.clear()
g.pwd.getpwuid=lambda uid:types.SimpleNamespace(pw_uid=19998)
try:g.prepare_system_identity()
except SystemExit:pass
else:raise AssertionError('reserved uid collision accepted')
assert len(calls)==1
`)
}

func TestMemberUmaskPrecedesRepositoryPayload(t *testing.T) {
	boundaryPython(t, `
class Observed(BaseException):pass
calls=[]
g.safe_directory=lambda *args,**kwargs:10
g.os.fork=lambda:0
g.os.open=lambda *args,**kwargs:11
g.os.close=lambda *args:None
class Handle:
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def write(self,data):pass
g.os.fdopen=lambda *args,**kwargs:Handle()
g.drop_to=lambda user:calls.append(('drop',user))
g.os.umask=lambda mask:calls.append(('umask',mask))
def payload(handle):
 assert calls==[('drop','agent'),('umask',0o002)],calls
 calls.append(('payload',))
 raise Observed()
g.read_request=payload
g.os._exit=lambda code:(_ for _ in ()).throw(Observed())
try:g.run_exec({'id':'fixture-session','user':'agent','payload':object()})
except Observed:pass
else:raise AssertionError('payload observation missing')
assert calls==[('drop','agent'),('umask',0o002),('payload',)],calls
`)
}
