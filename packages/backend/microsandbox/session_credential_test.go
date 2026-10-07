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
	script := `import hashlib,importlib.util,json,os,stat,sys,tempfile,types
spec=importlib.util.spec_from_file_location("g",sys.argv[1]); g=importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
scenario=sys.argv[2]
os.umask(0o022)
with tempfile.TemporaryDirectory() as root:
 root=os.path.realpath(root); os.makedirs(root+"/run/smithers/sessions")
 outside=root+"/outside"; open(outside,"wb").write(b"root canary")
 real_open,real_fstat=os.open,os.fstat
 def opened(path,*args,**kwargs): return real_open(root if path=="/" else path,*args,**kwargs)
 def observed(info): return types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=info.st_mode,st_nlink=info.st_nlink,st_dev=info.st_dev,st_ino=info.st_ino,st_size=info.st_size)
 os.open=opened; os.fstat=lambda *a,**k:observed(real_fstat(*a,**k))
 os.geteuid=lambda:0
 os.fchown=lambda *a:None
 g.assigned_identity=lambda user:types.SimpleNamespace(pw_uid=0,pw_gid=0)
 session="5e55a0b1-0000-4000-8000-000000000001"
 directory=root+"/run/smithers/sessions/"+session
 body=b"smithers_token"
 expected="absent"
 if scenario in ("foreign-token","writable-token","hardlink-token","delete-extra","stale-rotation","stale-close"):
  os.mkdir(directory); open(directory+"/token","wb").write(b"smithers_foreign\n"); os.chmod(directory+"/token",0o600)
  expected=hashlib.sha256(b"smithers_foreign").hexdigest()
  if scenario=="foreign-token": expected=hashlib.sha256(b"smithers_other").hexdigest()
  if scenario=="writable-token": os.chmod(directory+"/token",0o644)
  if scenario=="hardlink-token": os.link(directory+"/token",root+"/retained-link")
  if scenario=="delete-extra": open(directory+"/unrelated","wb").write(b"keep")
  if scenario in ("stale-rotation","stale-close"): expected=hashlib.sha256(b"smithers_previous").hexdigest()
 if scenario=="lock-link": os.symlink(outside,root+"/run/smithers/sessions/.credential-lock")
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
 issuer="http://127.0.0.1:4000"
 if scenario=="bad-issuer": issuer="http://127.0.0.1:70000"
 if scenario.startswith("issuer-"):
  g.put_session_token(session,body,expected,issuer)
  expected=hashlib.sha256(body).hexdigest()
  if scenario=="issuer-link":
   os.unlink(directory+"/issuer.json");os.symlink(outside,directory+"/issuer.json")
  if scenario=="issuer-writable": os.chmod(directory+"/issuer.json",0o666)
  if scenario=="issuer-session":
   value=json.load(open(directory+"/issuer.json"));value['session_id']='foreign';json.dump(value,open(directory+"/issuer.json","w"))
 refused=False
 try:
  if scenario in ("delete-extra","stale-close"): g.delete_session_token(session,expected)
  else: g.put_session_token(session,body,expected,issuer)
 except (SystemExit,OSError): refused=True
 assert open(outside,"rb").read()==b"root canary"
 if scenario=="valid":
  assert not refused,scenario
  assert not os.path.islink(directory+"/token")
  assert open(directory+"/token","rb").read()==b"smithers_token\n"
  assert stat.S_IMODE(os.stat(directory+"/token").st_mode)==0o600
  g.put_session_token(session,b"smithers_rotated",hashlib.sha256(body).hexdigest(),"http://127.0.0.1:4000")
  assert open(directory+"/token","rb").read()==b"smithers_rotated\n"
  assert sorted(os.listdir(directory))==["issuer.json","token"]
  g.delete_session_token(session,hashlib.sha256(b"smithers_rotated").hexdigest())
  assert not os.path.exists(directory)
  g.delete_session_token(session,hashlib.sha256(b"smithers_rotated").hexdigest())
 else:
  assert refused,scenario
  if scenario in ("foreign-token","writable-token","hardlink-token","delete-extra","stale-rotation","stale-close"):
   assert open(directory+"/token","rb").read()==b"smithers_foreign\n"
  if scenario=="delete-extra": assert open(directory+"/unrelated","rb").read()==b"keep"
`
	for _, scenario := range []string{"valid", "foreign-token", "writable-token", "hardlink-token", "delete-extra", "stale-rotation", "stale-close", "lock-link", "session-link", "parent-link", "leaf-link", "temporary-link", "writable-session", "space", "newline", "oversized", "empty", "bad-session", "unprivileged", "bad-issuer", "issuer-link", "issuer-writable", "issuer-session"} {
		t.Run(scenario, func(t *testing.T) {
			output, err := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py"), scenario).CombinedOutput()
			require.NoError(t, err, string(output))
		})
	}
}
