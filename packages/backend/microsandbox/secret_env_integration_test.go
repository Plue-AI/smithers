package microsandbox

import (
	"github.com/stretchr/testify/require"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Supplemental filesystem tests, not reference-host C-MCH-07/C-SEC-02 receipts.
// No lane-built artifact executes as root. Root ownership, gid and tmpfs
// observations are simulated; opens, collisions, writes and replacement are real.
func TestSecretEnvRootInputsValidatedBeforeUseSupplemental(t *testing.T) {
	require.NotZero(t, os.Geteuid())
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	script := `import errno,importlib.util,os,stat,sys,tempfile,types
spec=importlib.util.spec_from_file_location("g",sys.argv[1]); g=importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
scenario=sys.argv[2]
messages=[]
real_fail=g.fail
def recorded_fail(code,message):
 messages.append(message);real_fail(code,message)
g.fail=recorded_fail
refusals={'parent-link': ('NotADirectoryError', None),
 'leaf-link': ('SystemExit', 'untrusted secret environment destination'),
 'fifo': ('SystemExit', 'untrusted secret environment destination'),
 'writable-parent': ('SystemExit', 'untrusted directory ancestor'),
 'temporary-link': ('FileExistsError', None),
 'oversized': ('SystemExit', 'secret environment exceeds limit'),
 'nul': ('SystemExit', 'invalid secret environment entry'),
 'duplicate': ('SystemExit', 'duplicate secret environment key'),
 'invalid-name': ('SystemExit', 'invalid secret environment entry'),
 'not-map': ('SystemExit', 'invalid secret environment'),
 'non-string': ('SystemExit', 'invalid secret environment entry'),
 'too-many': ('SystemExit', 'invalid secret environment'),
 'flat-env': ('SystemExit', 'invalid secret delivery'),
 'disk': ('SystemExit', 'not tmpfs'),
 'group': ('SystemExit', 'no team')}
with tempfile.TemporaryDirectory() as root:
 root=os.path.realpath(root); os.mkdir(root+"/run"); parent=root+"/run/smithers"; os.mkdir(parent)
 outside=root+"/outside"; open(outside,"wb").write(b"root canary")
 real_open,real_stat,real_fstat=os.open,os.stat,os.fstat
 def opened(path,*args,**kwargs): return real_open(root if path=="/" else path,*args,**kwargs)
 def observed(info): return types.SimpleNamespace(st_uid=0,st_gid=20000,st_mode=info.st_mode,st_nlink=info.st_nlink,st_dev=info.st_dev,st_ino=info.st_ino)
 os.open=opened; os.stat=lambda *a,**k:observed(real_stat(*a,**k)); os.fstat=lambda *a,**k:observed(real_fstat(*a,**k))
 os.geteuid=lambda:0
 os.fchown=lambda *a:None
 g.secret_team=lambda:20000
 g.require_secret_tmpfs=lambda fd:None
 env={"CANARY_TOKEN":"$(touch /root/canary)\nquote\"literal","PATH":"/hostile","PYTHONPATH":"/hostile","LD_PRELOAD":"/hostile"}
 delivery=lambda env:g.json.dumps({"env":env,"files":{}}).encode()
 body=delivery(env)
 target=parent+"/env"
 if scenario=="parent-link": os.rmdir(parent); os.symlink(root,parent)
 if scenario=="leaf-link": os.symlink(outside,target)
 if scenario=="fifo": os.mkfifo(target)
 if scenario=="writable-parent": os.chmod(parent,0o777)
 if scenario=="temporary-link":
  g.secrets.token_hex=lambda n:"0"*32; os.symlink(outside,parent+"/.env-"+"0"*32)
 if scenario=="oversized": body=b"x"*(g.SECRET_ENV_LIMIT+1)
 if scenario=="nul": body=b'{"env":{"A":"\\u0000"},"files":{}}'
 if scenario=="duplicate": body=b'{"env":{"A":"a","A":"b"},"files":{}}'
 if scenario=="invalid-name": body=b'{"env":{"A=B":"x"},"files":{}}'
 if scenario=="not-map": body=b'{"env":[],"files":{}}'
 if scenario=="non-string": body=b'{"env":{"A":3},"files":{}}'
 if scenario=="too-many": body=delivery({"A"+str(i):"x" for i in range(1001)})
 if scenario=="flat-env": body=b'{"CANARY_TOKEN":"x"}'
 if scenario=="disk": g.require_secret_tmpfs=lambda fd:g.fail(3,"not tmpfs")
 if scenario=="group": g.secret_team=lambda:g.fail(3,"no team")
 refused=None
 try: g.put_secret_environment(body)
 except (SystemExit,OSError,ValueError) as error: refused=error
 assert open(outside,"rb").read()==b"root canary"
 if scenario!="valid":
  kind,message=refusals[scenario]
  assert type(refused).__name__==kind,(scenario,refused,messages)
  if message is not None: assert messages==[message],(scenario,messages)
  else: assert refused.errno==({"NotADirectoryError":errno.ENOTDIR,"FileExistsError":errno.EEXIST,"OSError":errno.ELOOP}[kind]),(scenario,refused)
 else:
  assert refused is None
  written=g.json.dumps(env,sort_keys=True,separators=(",",":")).encode()
  assert open(target,"rb").read()==written
  assert stat.S_IMODE(real_stat(target).st_mode)==0o640
  old=open(target,"rb")
  g.put_secret_environment(delivery({"CANARY_TOKEN":"new"}))
  assert old.read()==written; old.close()
  assert open(target,"rb").read()==b'{"CANARY_TOKEN":"new"}'
  assert not any(n.startswith(".env-") for n in os.listdir(parent))
  os.geteuid=lambda:19999
  os.getgroups=lambda:[20000]
  assert g.load_secret_environment()=={"CANARY_TOKEN":"new"}
`
	for _, scenario := range []string{"valid", "parent-link", "leaf-link", "fifo", "writable-parent", "temporary-link", "oversized", "nul", "duplicate", "invalid-name", "not-map", "non-string", "too-many", "flat-env", "disk", "group"} {
		t.Run(scenario, func(t *testing.T) {
			output, err := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py"), scenario).CombinedOutput()
			require.NoError(t, err, string(output))
		})
	}
}

func TestSecretEnvLoadedOnlyAfterUidDropSupplemental(t *testing.T) {
	require.NotZero(t, os.Geteuid())
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	script := `import importlib.util,os,sys
spec=importlib.util.spec_from_file_location("g",sys.argv[1]);g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
os.geteuid=lambda:0
g.safe_directory=lambda *a,**k:(_ for _ in ()).throw(AssertionError("root opened env"))
try: g.load_secret_environment()
except SystemExit as e: assert e.code==3
else: raise AssertionError("root loaded env")
`
	output, err := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py")).CombinedOutput()
	require.NoError(t, err, string(output))
}

func TestSecretEnvExecLoadsBeforeRequestOverridesSupplemental(t *testing.T) {
	require.NotZero(t, os.Geteuid())
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	script := `import importlib.util,os,sys,tempfile
spec=importlib.util.spec_from_file_location("g",sys.argv[1]);g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
with tempfile.TemporaryDirectory() as directory:
 open(directory+"/cgroup.procs","w").close()
 g.safe_directory=lambda *a,**k:os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
 dropped=[False]
 def drop(user):
  assert user=="agent" and os.geteuid()!=0
  dropped[0]=True
 g.drop_to=drop
 g.base_environment=lambda:{"BASE":"base","OVERRIDE":"base"}
 def load():
  assert dropped[0] and os.geteuid()!=0
  return {"CANARY_TOKEN":"literal-value","OVERRIDE":"secret"}
 g.load_secret_environment=load
 def execute(argv0,argv,env):
  assert dropped[0] and os.geteuid()!=0
  assert env=={"BASE":"base","CANARY_TOKEN":"literal-value","OVERRIDE":"request"}
  assert argv==["fixture-command"]
  os._exit(0)
 g.os.execvpe=execute
 result=g.run_exec({"id":"fixture","user":"agent","argv":["fixture-command"],"env":{"OVERRIDE":"request"},"cwd":directory,"stdin":"inherit"})
 assert result==0
`
	output, err := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py")).CombinedOutput()
	require.NoError(t, err, string(output))
}
