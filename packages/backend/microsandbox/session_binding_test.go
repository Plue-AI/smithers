package microsandbox

import (
	"github.com/stretchr/testify/require"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Supplemental root-input evidence: filesystem effects are real; root, account
// and tmpfs observations are simulated. No checkout code executes as root.
func TestSessionBindingRootInputsBeforePayloadSupplemental(t *testing.T) {
	require.NotZero(t, os.Geteuid())
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	script := `import importlib.util,os,stat,sys,tempfile,types
spec=importlib.util.spec_from_file_location("g",sys.argv[1]);g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
scenario=sys.argv[2]
with tempfile.TemporaryDirectory() as root:
 root=os.path.realpath(root);os.makedirs(root+"/run/smithers/admission")
 outside=root+"/canary";open(outside,"wb").write(b"untouched")
 real_open,real_stat,real_fstat=os.open,os.stat,os.fstat
 def opened(path,*a,**kw):return real_open(root if path=="/" else path,*a,**kw)
 def observed(m):return types.SimpleNamespace(st_uid=0,st_gid=20001,st_mode=m.st_mode,st_nlink=m.st_nlink,st_size=m.st_size,st_dev=m.st_dev,st_ino=m.st_ino)
 os.open=opened;os.fstat=lambda *a,**kw:observed(real_fstat(*a,**kw));os.stat=lambda *a,**kw:observed(real_stat(*a,**kw));os.fchown=lambda *a:None
 os.geteuid=lambda:0;g.require_secret_tmpfs=lambda fd:None
 g.assigned_identity=lambda user:types.SimpleNamespace(pw_uid=20001,pw_gid=20001)
 login,uid,body="ben","20001",b'{"branch":"$(touch /root/canary)","opaque":"literal"}'
 target=root+"/run/smithers/admission/u20001"
 if scenario=="root":login,uid="root","0"
 if scenario=="mismatch":uid="20002"
 if scenario=="traversal":login="../ben"
 if scenario=="uid-text":uid="20001;exec"
 if scenario=="oversized":body=b"x"*(256*1024+1)
 if scenario=="empty":body=b""
 if scenario=="unprivileged":os.geteuid=lambda:20001
 if scenario=="disk":g.require_secret_tmpfs=lambda fd:g.fail(3,"not tmpfs")
 if scenario=="leaf-link":os.symlink(outside,target)
 if scenario=="parent-link":os.rename(root+"/run/smithers/admission",root+"/moved");os.symlink(root+"/moved",root+"/run/smithers/admission")
 if scenario=="existing":open(target,"wb").write(b"previous")
 refused=False
 try:g.put_session_binding(login,uid,body)
 except (OSError,SystemExit):refused=True
 assert open(outside,"rb").read()==b"untouched"
 if scenario=="valid":
  assert not refused
  assert open(target,"rb").read()==body
  assert stat.S_IMODE(real_stat(target).st_mode)==0o640
  try:g.put_session_binding(login,uid,b"replacement")
  except FileExistsError:pass
  else:raise AssertionError("unconsumed binding replaced")
  assert open(target,"rb").read()==body
  g.delete_session_binding(login,uid);assert not os.path.exists(target)
  g.delete_session_binding(login,uid)
 else:
  assert refused,scenario
  if scenario=="existing":assert open(target,"rb").read()==b"previous"
`
	for _, scenario := range []string{"valid", "root", "mismatch", "traversal", "uid-text", "oversized", "empty", "unprivileged", "disk", "leaf-link", "parent-link", "existing"} {
		t.Run(scenario, func(t *testing.T) {
			out, err := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py"), scenario).CombinedOutput()
			require.NoError(t, err, string(out))
		})
	}
}
