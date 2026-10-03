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
	t.Run("CSEC02", func(t *testing.T) { rootBoundaryLifecycle(t, true) })
	boundaryPython(t, `
with tempfile.TemporaryDirectory() as directory:
 directory=os.path.realpath(directory)
 home=directory+'/home'; os.mkdir(home)
 me=pwd.getpwuid(os.getuid())
 entry=types.SimpleNamespace(pw_dir=home,pw_uid=me.pw_uid,pw_gid=me.pw_gid)
 env=directory+'/env.json'; g.ENV_FILE=env
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
g.pwd.getpwnam=lambda user: types.SimpleNamespace(pw_uid=1500,pw_gid=1500)
g.os.geteuid=lambda: 0
g.os.setgroups=lambda groups: calls.append(('groups',groups))
g.os.setgid=lambda gid: calls.append(('gid',gid))
g.os.setuid=lambda uid: calls.append(('uid',uid))
# Restore the production drop function after the preflight observation.
original=importlib.util.module_from_spec(spec); spec.loader.exec_module(original)
original.drop_to('agent')
assert calls==[('groups',[]),('gid',1500),('uid',1500)], calls
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
		result, err := runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/usr/bin/python3", "-I", "-c", `import os; assert os.getuid()==1500; assert os.getgid()==1500; assert os.getgroups()==[]; print('identity-ok')`}})
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
