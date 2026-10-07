package microsandbox

import (
	"github.com/stretchr/testify/require"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Root ownership and tmpfs observations are simulated. The fd walk, symlink
// refusal, compare-and-replace and files are real; this is not VM evidence.
func TestMemberTokenPrivateDirectorySupplemental(t *testing.T) {
	require.NotZero(t, os.Geteuid())
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	script := `import hashlib,importlib.util,os,stat,sys,tempfile,types
assert os.geteuid()!=0
spec=importlib.util.spec_from_file_location('g',sys.argv[1]);g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
scenario=sys.argv[2];ownership={};real_open=os.open;real_fstat=os.fstat
os.umask(0o077)
with tempfile.TemporaryDirectory() as root:
 root=os.path.realpath(root);os.makedirs(root+'/run/smithers')
 outside=root+'/canary';open(outside,'wb').write(b'keep')
 def opened(path,*a,**k):return real_open(root if path=='/' else path,*a,**k)
 def chown(fd,uid,gid):
  m=real_fstat(fd);ownership[(m.st_dev,m.st_ino)]=(uid,gid)
 def observed(fd):
  m=real_fstat(fd);uid,gid=ownership.get((m.st_dev,m.st_ino),(0,0));return types.SimpleNamespace(st_uid=uid,st_gid=gid,st_mode=m.st_mode,st_nlink=m.st_nlink,st_dev=m.st_dev,st_ino=m.st_ino,st_size=m.st_size)
 os.open=opened;os.fstat=observed;os.fchown=chown;os.geteuid=lambda:0
 g.require_secret_tmpfs=lambda fd:None
 g.assigned_identity=lambda name:types.SimpleNamespace(pw_uid=20001,pw_gid=20001)
 slot=root+'/run/smithers/20001';session='session-a'
 if scenario=='slot-link':os.symlink(root,slot)
 if scenario in ('slot-mode','slot-owner','parent-link','parent-mode'):
  os.mkdir(slot,0o700);m=os.stat(slot);ownership[(m.st_dev,m.st_ino)]=(20001,20001)
  if scenario=='slot-mode':os.chmod(slot,0o755)
  if scenario=='slot-owner':ownership[(m.st_dev,m.st_ino)]=(20002,20002)
  if scenario=='parent-link':os.symlink(root,slot+'/token')
  if scenario=='parent-mode':os.mkdir(slot+'/token',0o777);os.chmod(slot+'/token',0o777)
 if scenario=='disk':g.require_secret_tmpfs=lambda fd:g.fail(3,'not tmpfs')
 refused=False
 try:g.put_session_token(session,b'smithers_member','absent','ben',20001)
 except (SystemExit,OSError):refused=True
 assert open(outside,'rb').read()==b'keep'
 if scenario!='valid':assert refused,scenario
 else:
  assert not refused
  path=slot+'/token/sessions/'+session+'/token'
  assert open(path,'rb').read()==b'smithers_member\n'
  assert stat.S_IMODE(os.stat(slot).st_mode)==0o700
  m=os.stat(slot);assert ownership[(m.st_dev,m.st_ino)]==(20001,20001)
  m=os.stat(path);assert ownership[(m.st_dev,m.st_ino)]==(20001,20001)
  assert stat.S_IMODE(m.st_mode)==0o600
  assert not os.path.exists(root+'/run/smithers/sessions')
  g.put_session_token(session,b'rotated',hashlib.sha256(b'smithers_member').hexdigest(),'ben',20001)
  refused=False
  try:g.delete_session_token(session,hashlib.sha256(b'smithers_member').hexdigest(),'ben',20001)
  except SystemExit:refused=True
  assert refused and open(path,'rb').read()==b'rotated\n'
  g.delete_session_token(session,hashlib.sha256(b'rotated').hexdigest(),'ben',20001)
  assert not os.path.exists(path)
  g.delete_session_token(session,hashlib.sha256(b'rotated').hexdigest(),'ben',20001)
`
	for _, scenario := range []string{"valid", "slot-link", "slot-mode", "slot-owner", "parent-link", "parent-mode", "disk"} {
		t.Run(scenario, func(t *testing.T) {
			out, err := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py"), scenario).CombinedOutput()
			require.NoError(t, err, string(out))
		})
	}
}
