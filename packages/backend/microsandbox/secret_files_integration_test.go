package microsandbox

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// Supplemental filesystem tests for declared secret files (spec §8.8.1a,
// C-MCH-12 steps 4 and 5), not reference-host receipts: no lane-built
// artifact runs as root, so ownership, the team gid and tmpfs are simulated
// and the identity drop is recorded instead of performed. Opens, symlink
// refusals, writes, replacement and deletion are real. The real-VM proof runs
// on the Mac mini.
func TestSecretFilesDeliveredWithoutFollowingLinksSupplemental(t *testing.T) {
	require.NotZero(t, os.Geteuid())
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	for _, scenario := range []string{
		"validate-missing", "validate-leaf", "validate-parent", "validate-absolute", "validate-regular", "deliver", "leaf-link", "parent-link", "directory-leaf", "files-link", "removal-retried", "reboot", "homes",
		"invalid:~/../x", "invalid:/etc/x", "invalid:/workspace/x", "invalid:~/a//b", "invalid:/run/smithers/files/",
	} {
		t.Run(scenario, func(t *testing.T) {
			output, err := exec.Command(python, "-B", "-c", secretFilesScript, filepath.Join("guest", "smithers-guest.py"), scenario).CombinedOutput()
			require.NoError(t, err, string(output))
		})
	}
}

const secretFilesScript = `
import importlib.util,io,json,os,stat,sys,tempfile,types,contextlib
spec=importlib.util.spec_from_file_location("g",sys.argv[1]); g=importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
scenario=sys.argv[2]
with tempfile.TemporaryDirectory() as root:
 root=os.path.realpath(root)
 for d in ("/run","/run/smithers","/home","/home/agent","/home/ben","/outside"): os.mkdir(root+d)
 canary=root+"/outside/canary"; open(canary,"wb").write(b"root canary")
 real_open,real_stat,real_fstat=os.open,os.stat,os.fstat
 def opened(path,*args,**kwargs):
  if isinstance(path,str) and path.startswith("/") and not path.startswith(root+"/") and kwargs.get("dir_fd") is None: path=root+path
  return real_open(path,*args,**kwargs)
 def observed(info): return types.SimpleNamespace(st_uid=0,st_gid=20000,st_mode=info.st_mode,st_nlink=info.st_nlink,st_dev=info.st_dev,st_ino=info.st_ino)
 os.open=opened; os.stat=lambda *a,**k:observed(real_stat(*a,**k)); os.fstat=lambda *a,**k:observed(real_fstat(*a,**k))
 os.geteuid=lambda:0
 os.fchown=lambda *a:None
 os.chown=lambda *a,**k:None
 g.secret_team=lambda:20000
 g.require_secret_tmpfs=lambda fd:None
 homes=[types.SimpleNamespace(pw_name=n,pw_uid=0,pw_gid=0,pw_dir="/home/"+n) for n in ("agent","ben")]
 real_homes=g.secret_homes
 g.secret_homes=lambda:homes
 os.mkdir(root+"/drops")
 # The writer runs in a forked child; its identity drop is recorded on disk.
 g.drop_to=lambda user,uid=None:real_open(root+"/drops/"+user,os.O_CREAT|os.O_WRONLY,0o600)
 key="~/.config/anthropic/key"
 home_file=lambda n:root+"/home/"+n+"/.config/anthropic/key"
 team_file=root+"/run/smithers/files/npm/token"
 def put(files,env=None):
  out=io.StringIO()
  with contextlib.redirect_stdout(out): g.put_secret_environment(json.dumps({"env":env or {"A":"x"},"files":files}).encode())
  return json.loads(out.getvalue())["refused"] if out.getvalue() else []
 manifest=lambda:json.load(open(root+"/var/lib/smithers/secret-files.json"))
 mode=lambda p:stat.S_IMODE(real_stat(p,follow_symlinks=False).st_mode)
 if scenario.startswith("validate-"):
  before=set(os.listdir(root+"/home/agent"))
  if scenario=="validate-leaf": os.symlink(canary,root+"/home/ben/key")
  if scenario=="validate-parent": os.symlink(root+"/outside",root+"/home/ben/folder")
  if scenario=="validate-absolute": os.symlink(root+"/outside",root+"/run/smithers/files")
  if scenario=="validate-regular": open(root+"/home/ben/key","w").write("keep")
  path={"validate-parent":"~/folder/key","validate-absolute":"/run/smithers/files/key"}.get(scenario,"~/key")
  assert g.validate_secret_file_path(path)==(scenario in ("validate-missing","validate-regular"))
  assert set(os.listdir(root+"/home/agent"))==before
  assert open(canary,"rb").read()==b"root canary"
  assert not os.path.exists(root+"/var")
 elif scenario=="deliver":
  assert put({key:"ANTHROPIC_API_KEY","/run/smithers/files/npm/token":"npm-value"})==[]
  for n in ("agent","ben"):
   assert open(home_file(n),"rb").read()==b"ANTHROPIC_API_KEY"
   assert mode(home_file(n))==0o600
   assert mode(root+"/home/"+n+"/.config/anthropic")==0o700
  assert sorted(os.listdir(root+"/drops"))==["agent","ben"]
  assert open(team_file,"rb").read()==b"npm-value"
  assert mode(team_file)==0o640 and mode(root+"/run/smithers/files/npm")==0o750 and mode(root+"/run/smithers/files")==0o750
  assert manifest()==sorted([key,"/run/smithers/files/npm/token"])
  assert mode(root+"/var/lib/smithers/secret-files.json")==0o600
  assert json.load(open(root+"/run/smithers/env"))=={"A":"x"}
  # Replace: the value changes in place.
  assert put({key:"rotated","/run/smithers/files/npm/token":"npm-2"})==[]
  assert open(home_file("ben"),"rb").read()==b"rotated" and open(team_file,"rb").read()==b"npm-2"
  # Move: the old path is deleted, the new one written.
  assert put({"~/.npmrc":"rotated"})==[]
  assert not os.path.exists(home_file("agent")) and not os.path.exists(team_file)
  assert open(root+"/home/ben/.npmrc","rb").read()==b"rotated"
  # Remove: every file is gone and the manifest is empty.
  assert put({})==[]
  assert not os.path.exists(root+"/home/ben/.npmrc") and manifest()==[]
  assert not any(n.startswith(".smithers-secret-") for d,_,fs in os.walk(root) for n in fs)
 elif scenario=="leaf-link":
  os.makedirs(root+"/home/ben/.config/anthropic"); os.symlink(canary,home_file("ben"))
  assert put({key:"ANTHROPIC_API_KEY"})==[key+" in ben"]
  assert open(canary,"rb").read()==b"root canary" and os.path.islink(home_file("ben"))
  assert open(home_file("agent"),"rb").read()==b"ANTHROPIC_API_KEY"
  # Removing never deletes or follows the planted link.
  assert put({})==[]
  assert os.path.islink(home_file("ben")) and open(canary,"rb").read()==b"root canary"
 elif scenario=="parent-link":
  os.symlink(root+"/outside",root+"/home/ben/.config")
  assert put({key:"ANTHROPIC_API_KEY"})==[key+" in ben"]
  assert sorted(os.listdir(root+"/outside"))==["canary"]
  assert open(home_file("agent"),"rb").read()==b"ANTHROPIC_API_KEY"
 elif scenario=="directory-leaf":
  os.makedirs(home_file("ben"))
  assert put({key:"v"})==[key+" in ben"]
  assert os.path.isdir(home_file("ben"))
 elif scenario=="files-link":
  os.symlink(root+"/outside",root+"/run/smithers/files")
  try: put({"/run/smithers/files/x":"v"})
  except (SystemExit,OSError): pass
  else: raise AssertionError("followed a linked files root")
  assert sorted(os.listdir(root+"/outside"))==["canary"]
 elif scenario=="removal-retried":
  assert put({key:"v"})==[]
  os.remove(home_file("ben")); os.rmdir(root+"/home/ben/.config/anthropic"); os.rmdir(root+"/home/ben/.config")
  os.symlink(root+"/outside",root+"/home/ben/.config"); os.makedirs(root+"/outside/anthropic"); open(root+"/outside/anthropic/key","wb").write(b"keep")
  assert put({})==[key+" in ben"]
  assert manifest()==[key] and not os.path.exists(home_file("agent"))
  assert open(root+"/outside/anthropic/key","rb").read()==b"keep"
  os.remove(root+"/home/ben/.config")
  assert put({})==[] and manifest()==[]
 elif scenario=="reboot":
  assert put({key:"v","/run/smithers/files/t":"v"})==[]
  # A reboot empties the tmpfs; homes and the manifest stay on disk.
  import shutil; shutil.rmtree(root+"/run/smithers"); os.mkdir(root+"/run/smithers")
  assert put({})==[]
  assert not os.path.exists(home_file("agent")) and not os.path.exists(home_file("ben")) and manifest()==[]
 elif scenario=="homes":
  for n in ("root","stranger","mallory","Bad.Name"): os.mkdir(root+"/home/"+n)
  os.symlink(root+"/outside",root+"/home/linked")
  users={"agent":19999,"ben":20001,"root":0,"mallory":20002,"linked":20003,"stranger-not-here":20004}
  owners={"agent":19999,"ben":20001,"mallory":5,"root":0,"linked":20003}
  def account(n):
   if n not in users: raise KeyError(n)
   return types.SimpleNamespace(pw_name=n,pw_uid=users[n],pw_gid=users[n],pw_dir="/home/"+n)
  g.pwd.getpwnam=account
  os.stat=lambda name,dir_fd=None,follow_symlinks=True:(lambda info:types.SimpleNamespace(st_mode=info.st_mode,st_uid=owners.get(name,0)))(real_stat(name,dir_fd=dir_fd,follow_symlinks=follow_symlinks))
  assert [e.pw_name for e in real_homes()]==["agent","ben"]
 elif scenario.startswith("invalid:"):
  path=scenario[len("invalid:"):]
  try: put({path:"v"})
  except SystemExit as e: assert e.code==3
  else: raise AssertionError("accepted "+path)
  assert not os.path.exists(root+"/run/smithers/env") and not os.path.exists(root+"/var/lib/smithers/secret-files.json")
 else: raise AssertionError(scenario)
`
