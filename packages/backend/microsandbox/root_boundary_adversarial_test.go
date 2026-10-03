package microsandbox

import (
	"encoding/base64"
	"github.com/stretchr/testify/require"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestGuestBootstrapFilesystemSupplemental(t *testing.T) {
	require.NotZero(t, os.Geteuid(), "branch-built tests must never execute as host root")
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	// Root UID observations are simulated because no branch script may run as
	// host root. Directory opens, writes, symlinks, digest checks and replacement
	// use the real filesystem. This is supplemental, never a C-SEC-02 receipt.
	script := `import base64,hashlib,io,os,secrets,stat,sys,tempfile,types
bootstrap = base64.b64decode(sys.argv[1]).decode()
scenario = sys.argv[2]
body = b'print("approved fixture executed")\n'
with tempfile.TemporaryDirectory() as root:
    root = os.path.realpath(root)
    parent = os.path.join(root,"opt","smithers","guest"); os.makedirs(parent)
    for directory in (os.path.join(root,"opt"),os.path.join(root,"opt","smithers"),parent): os.chmod(directory,0o755)
    outside = os.path.join(root,"outside"); os.mkdir(outside)
    sentinel = os.path.join(outside,"sentinel")
    with open(sentinel,"wb") as f: f.write(b"outside sentinel")
    os.chmod(sentinel,0o640)
    before = os.stat(sentinel)
    target = os.path.join(parent,"smithers-guest.py")
    with open(target,"wb") as f: f.write(body if scenario != "digest" else b"unapproved")
    os.chmod(target,0o644)
    if scenario == "parent-link":
        os.unlink(target); os.rmdir(parent); os.symlink(outside,parent)
    if scenario == "leaf-link":
        os.unlink(target); os.symlink(sentinel,target)
    if scenario == "writable-parent": os.chmod(parent,0o777)
    if scenario == "temporary-link":
        secrets.token_hex = lambda n: "0"*32
        os.symlink(sentinel,os.path.join(parent,".install-"+"0"*32))
    real_open, real_fstat, real_stat = os.open, os.fstat, os.stat
    def opened(path,*args,**kwargs):
        fd = real_open(root if path == "/" else path,*args,**kwargs)
        if scenario == "parent-replacement" and path == "guest":
            os.rename(parent,os.path.join(root,"old-guest")); os.symlink(outside,parent)
        return fd
    def approved(info):
        return types.SimpleNamespace(st_uid=1 if scenario == "owner" else 0, st_mode=info.st_mode)
    os.open = opened
    os.fstat = lambda fd: approved(real_fstat(fd))
    os.stat = lambda *a,**k: approved(real_stat(*a,**k))
    operation = "install" if scenario in ("trusted-install","temporary-link","parent-replacement") else "run"
    sys.stdin = types.SimpleNamespace(buffer=io.BytesIO(body))
    sys.argv = ["bootstrap",hashlib.sha256(body).hexdigest(),operation]
    try: exec(compile(bootstrap,"approved-bootstrap-fixture","exec"),{})
    except (RuntimeError,OSError):
        if scenario in ("trusted","trusted-install","parent-replacement"): raise
    else:
        if scenario not in ("trusted","trusted-install","parent-replacement"): raise AssertionError("hostile startup accepted: " + scenario)
    if scenario in ("trusted-install","parent-replacement"):
        installed = os.path.join(root,"old-guest","smithers-guest.py") if scenario == "parent-replacement" else target
        with open(installed,"rb") as f: assert f.read() == body
    os.open, os.fstat, os.stat = real_open, real_fstat, real_stat
    with open(sentinel,"rb") as f: assert f.read() == b"outside sentinel"
    after = os.stat(sentinel)
    assert (before.st_uid,before.st_gid,before.st_mode) == (after.st_uid,after.st_gid,after.st_mode)
print("startup fixture passed")
`
	for _, scenario := range []string{"trusted", "trusted-install", "temporary-link", "parent-replacement", "parent-link", "leaf-link", "writable-parent", "owner", "digest"} {
		t.Run(scenario, func(t *testing.T) {
			output, err := exec.Command(python, "-I", "-S", "-B", "-c", script, base64.StdEncoding.EncodeToString([]byte(pinnedGuestBootstrap())), scenario).CombinedOutput()
			require.NoError(t, err, string(output))
			require.Contains(t, string(output), "startup fixture passed")
			if scenario == "trusted" {
				require.Contains(t, string(output), "approved fixture executed")
			}
		})
	}
}

func TestRootHomeReplacementSupplemental(t *testing.T) {
	require.NotZero(t, os.Geteuid(), "branch-built tests must never execute as host root")
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	script := `import importlib.util,os,pwd,sys,tempfile
spec=importlib.util.spec_from_file_location("guest",sys.argv[1]); g=importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
scenario=sys.argv[2]
with tempfile.TemporaryDirectory() as root:
    root = os.path.realpath(root)
    home=os.path.join(root,"home"); outside=os.path.join(root,"outside")
    os.makedirs(os.path.join(home,".config","go")); os.mkdir(outside)
    sentinel=os.path.join(outside,"env")
    with open(sentinel,"wb") as f: f.write(b"outside sentinel")
    os.chmod(sentinel,0o640)
    before=os.stat(sentinel)
    target=os.path.join(home,".config","go","env")
    with open(target,"w") as f: f.write("old settings")
    me=pwd.getpwuid(os.getuid()); entry=pwd.struct_passwd((me.pw_name,"x",me.pw_uid,me.pw_gid,"",home,"/bin/sh"))
    real_open,real_stat=os.open,os.stat
    swapped=[False]
    config_opens=[0]
    def opened(path,*args,**kw):
        fd=real_open(path,*args,**kw)
        if scenario=="leaf" and path=="env" and not swapped[0]:
            swapped[0]=True; os.rename(target,target+"-old"); os.symlink(sentinel,target)
        if path==".config": config_opens[0]+=1
        if scenario=="ancestor" and path==".config" and config_opens[0]==3 and not swapped[0]:
            swapped[0]=True
            os.rename(os.path.join(home,".config"),os.path.join(home,"old-config"))
            os.symlink(outside,os.path.join(home,".config"))
        return fd
    def stated(path,*args,**kw):
        info=real_stat(path,*args,**kw)
        if scenario=="leaf" and path=="env" and not swapped[0]:
            swapped[0]=True; os.unlink(target); os.symlink(sentinel,target)
        return info
    # Deterministically schedule a real replacement exactly between syscalls.
    os.open,os.stat=opened,stated
    g.ENV_FILE=sentinel
    g.base_environment=lambda: {"GOTOOLCHAIN":"local"}
    g.home_defaults(entry)
    os.open,os.stat=real_open,real_stat
    assert swapped[0],"race seam was never reached"
    with open(sentinel,"rb") as f: assert f.read()==b"outside sentinel"
    after=os.stat(sentinel)
    assert (before.st_uid,before.st_gid,before.st_mode)==(after.st_uid,after.st_gid,after.st_mode)
    installed=os.path.join(home,"old-config","go","env") if scenario=="ancestor" else target+"-old"
    with open(installed) as f: assert f.read()=="GOTOOLCHAIN=local\n"
print("replacement confined")
`
	for _, scenario := range []string{"leaf", "ancestor"} {
		t.Run(scenario, func(t *testing.T) {
			output, err := exec.Command(python, "-I", "-S", "-B", "-c", script, filepath.Join("guest", "smithers-guest.py"), scenario).CombinedOutput()
			require.NoError(t, err, string(output))
			require.Contains(t, string(output), "replacement confined")
		})
	}
}

func TestRootIdentityDropOrderingSupplemental(t *testing.T) {
	require.NotZero(t, os.Geteuid(), "branch-built tests must never execute as host root")
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	// Syscalls are observed rather than executed: branch code never gains host
	// root. The real-VM check must observe kernel identities independently.
	script := `import importlib.util,pwd,sys,types
spec=importlib.util.spec_from_file_location("guest",sys.argv[1]); g=importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
calls=[]
g.pwd=types.SimpleNamespace(getpwnam=lambda user: pwd.struct_passwd(("agent","x",1500,1500,"","/home/agent","/bin/bash")))
g.os=types.SimpleNamespace(geteuid=lambda:0,setgroups=lambda v:calls.append(("groups",v)),setgid=lambda v:calls.append(("gid",v)),setuid=lambda v:calls.append(("uid",v)),getuid=lambda:1500,getgid=lambda:1500,getgroups=lambda:[])
g.drop_to("agent")
assert calls==[("groups",[]),("gid",1500),("uid",1500)]
for user in ("","root","other"):
    calls.clear()
    try:g.drop_to(user)
    except SystemExit:pass
    else:raise AssertionError("non-fixed identity accepted")
    assert calls==[]
print("fixed identity drop order passed")
`
	output, err := exec.Command(python, "-I", "-S", "-B", "-c", script, filepath.Join("guest", "smithers-guest.py")).CombinedOutput()
	require.NoError(t, err, string(output))
	require.Contains(t, string(output), "fixed identity drop order passed")
}
