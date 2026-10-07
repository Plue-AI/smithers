package microsandbox

import (
	"github.com/stretchr/testify/require"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Account/root/tmpfs observations and the broker launch are simulated. Actual
// descriptor walks, file modes, locks, digest checks and replacements execute
// as this non-root test user; this is not a real-VM acceptance receipt.
func TestMachinedInstalledBootSupplemental(t *testing.T) {
	require.NotZero(t, os.Geteuid())
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	script := `import importlib.util,os,stat,sys,tempfile,types,subprocess,hashlib
spec=importlib.util.spec_from_file_location("g",sys.argv[1]);g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
messages=[]
real_fail=g.fail
def recorded_fail(code,message):
 messages.append(message);real_fail(code,message)
g.fail=recorded_fail
# The fixture models root-protected ancestors independently of the host umask.
os.umask(0o022)
with tempfile.TemporaryDirectory() as root:
 root=os.path.realpath(root);g.PROTECTED_BASE=root
 os.makedirs(root+"/var/lib");os.chmod(root,0o700)
 # Positive controls must retain protected modes under a group-writable umask.
 for directory in (root+"/var",root+"/var/lib"):os.chmod(directory,0o755)
 real_open,real_stat,real_fstat=os.open,os.stat,os.fstat
 owners={}
 def observed(info):
  uid,gid=owners.get((info.st_dev,info.st_ino),(0,0))
  return types.SimpleNamespace(st_uid=uid,st_gid=gid,st_mode=info.st_mode,st_nlink=info.st_nlink,st_size=info.st_size,st_dev=info.st_dev,st_ino=info.st_ino)
 def chown(fd,uid,gid):
  info=real_fstat(fd);owners[(info.st_dev,info.st_ino)]=(uid,gid)
 os.open=lambda p,*a,**kw:real_open(root if p=="/" else p,*a,**kw)
 os.stat=lambda *a,**kw:observed(real_stat(*a,**kw));os.fstat=lambda fd:observed(real_fstat(fd));os.fchown=chown
 os.geteuid=lambda:0;g.require_secret_tmpfs=lambda fd:None;g.secret_team=lambda:20000;g.prepare_system_identity=lambda:None;g.time.sleep=lambda n:None
 calls=[]
 def launch(argv,**kw):
  calls.append((argv,kw));return types.SimpleNamespace(poll=lambda:None)
 subprocess.Popen=launch
 program=bytearray(64);program[:6]=b'\x7fELF\x02\x01';program[18:20]=(183).to_bytes(2,'little');program=bytes(program)
 digest=hashlib.sha256(program).hexdigest()
 body=b'boot_id='+b'01'*16+b'\nrelay_secret='+b'02'*32+b'\ncredential='+b'03'*32+b'\ntopology=relay\n'
 for bad in [b'',b'x'*4097,body+b'credential=other\n',body.replace(b'relay',b'bridge'),body+b'executable=/workspace/a\n',body+b'\x00',body.replace(b'01',b'GG')]:
  try:g.machined_boot_body(bad)
  except SystemExit as error:assert error.code==3 and messages[-1]=='invalid machined boot authority',messages
  else:raise AssertionError('invalid authority accepted')
 assert not calls and not os.path.exists(root+'/run')
 assert not g.machined_program(digest)
 for mode in (0o775,0o757):
  os.chmod(root,mode)
  try:g.machined_program(digest,program)
  except SystemExit as error:assert error.code==3 and messages[-1]=='protected directory is not root-owned and protected',messages
  else:raise AssertionError('writable protected ancestor accepted')
  assert not calls
 os.chmod(root,0o700)
 g.machined_program(digest,program);assert g.machined_program(digest)
 assert g.start_machined(digest,body)=='started'
 assert len(calls)==1 and calls[0][0]==['/opt/smithers/bin/smithers-machined','broker']
 assert calls[0][1]['cwd']=='/' and calls[0][1]['env']=={'PATH':'/usr/bin:/bin','HOME':'/'}
 assert open(root+'/run/smithers/machined/boot','rb').read()==body
 assert stat.S_IMODE(real_stat(root+'/run/smithers/machined/boot').st_mode)==0o400
 assert open(root+'/run/smithers/env','rb').read()==b'{}'
 def locked(fd,op):raise BlockingIOError()
 g.fcntl.flock=locked
 assert g.start_machined(digest,body)=='current' and len(calls)==1
 try:g.machined_program(digest,program)
 except SystemExit as error:assert error.code==3 and messages[-1]=='machined update requires a stopped broker',messages
 else:raise AssertionError('serving executable replaced')
 try:g.start_machined(digest,body.replace(b'01',b'04'))
 except SystemExit as error:assert error.code==3 and messages[-1]=='serving machined boot differs from host authority',messages
 else:raise AssertionError('serving authority replaced')
 assert open(root+'/run/smithers/machined/boot','rb').read()==body and len(calls)==1
 os.geteuid=lambda:20001
 try:g.start_machined(digest,body)
 except SystemExit as error:assert error.code==3 and messages[-1]=='machined startup requires root',messages
 else:raise AssertionError('member started root broker')
`
	out, err := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py")).CombinedOutput()
	require.NoError(t, err, string(out))
}
