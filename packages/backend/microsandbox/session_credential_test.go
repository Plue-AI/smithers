package microsandbox

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// Supplemental filesystem tests of the guest helper's put-token and
// delete-token (T-TRM-02), not reference-host C-SEC-05 receipts: root
// ownership is simulated; opens, links, collisions, writes and replacement are
// real. TestRealMicroVMTerminalSessionToken is the guest receipt.
func TestSessionTokenRootInputsValidatedBeforeUseSupplemental(t *testing.T) {
	require.NotZero(t, os.Geteuid())
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	script := `import importlib.util,os,stat,sys,tempfile,types
spec=importlib.util.spec_from_file_location("g",sys.argv[1]); g=importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
scenario=sys.argv[2]
with tempfile.TemporaryDirectory() as root:
 root=os.path.realpath(root); os.makedirs(root+"/run/smithers/sessions")
 outside=root+"/outside"; open(outside,"wb").write(b"root canary")
 real_open,real_fstat=os.open,os.fstat
 def opened(path,*args,**kwargs): return real_open(root if path=="/" else path,*args,**kwargs)
 def observed(info): return types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=info.st_mode,st_nlink=info.st_nlink,st_dev=info.st_dev,st_ino=info.st_ino)
 os.open=opened; os.fstat=lambda *a,**k:observed(real_fstat(*a,**k))
 os.geteuid=lambda:0
 os.fchown=lambda *a:None
 g.assigned_identity=lambda user:types.SimpleNamespace(pw_uid=19999,pw_gid=19999)
 session="5e55a0b1-0000-4000-8000-000000000001"
 directory=root+"/run/smithers/sessions/"+session
 body=b"smithers_token"
 if scenario=="session-link": os.symlink(root,directory)
 if scenario=="parent-link":
  os.rename(root+"/run/smithers/sessions",root+"/moved"); os.symlink(root+"/moved",root+"/run/smithers/sessions")
 if scenario=="leaf-link": os.mkdir(directory); os.symlink(outside,directory+"/token")
 if scenario=="temporary-link":
  os.mkdir(directory); g.secrets.token_hex=lambda n:"0"*32; os.symlink(outside,directory+"/.token-"+"0"*32)
 if scenario=="writable-session": os.mkdir(directory); os.chmod(directory,0o777)
 if scenario=="space": body=b"two words"
 if scenario=="newline": body=b"smithers_a\nb"
 if scenario=="oversized": body=b"x"*(g.SESSION_TOKEN_LIMIT+1)
 if scenario=="empty": body=b""
 if scenario=="bad-session": session="../escape"
 if scenario=="unprivileged": os.geteuid=lambda:19999
 refused=False
 try: g.put_session_token(session,body)
 except (SystemExit,OSError): refused=True
 assert open(outside,"rb").read()==b"root canary"
 if scenario in ("valid","leaf-link"):
  assert not refused,scenario
  assert not os.path.islink(directory+"/token")
  assert open(directory+"/token","rb").read()==b"smithers_token\n"
  assert stat.S_IMODE(os.stat(directory+"/token").st_mode)==0o600
  g.put_session_token(session,b"smithers_rotated")
  assert open(directory+"/token","rb").read()==b"smithers_rotated\n"
  assert os.listdir(directory)==["token"]
  g.delete_session_token(session)
  assert not os.path.exists(directory)
  g.delete_session_token(session)
 else:
  assert refused,scenario
`
	for _, scenario := range []string{"valid", "session-link", "parent-link", "leaf-link", "temporary-link", "writable-session", "space", "newline", "oversized", "empty", "bad-session", "unprivileged"} {
		t.Run(scenario, func(t *testing.T) {
			output, err := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py"), scenario).CombinedOutput()
			require.NoError(t, err, string(output))
		})
	}
}
