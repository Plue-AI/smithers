package microsandbox

import (
	"runtime"
	"testing"
)

// Linux disk and renameat2 candidate evidence only. This does not qualify the
// real-machine privilege/ancestor boundary or enable WorkspaceCompareWriter.
func TestGuestCompareWriteCandidate(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("candidate requires Linux renameat2; qualification runs on Linux")
	}
	boundaryPython(t, `
import io,json,pathlib,contextlib
old='25718360e05d3c2d0963d1381e9dd4dae5fca789244ee4b9f861adcc0cc96218'
new='1d054714357ce5ee01723ed91fcaa69206e221faaf9c1fad64f73be2e5d051da'
outside='92a214fa61579091222f97eaf8e9bf11c1a728af5a077a3b5568231b6dc5be43'
with tempfile.TemporaryDirectory() as root:
 p=pathlib.Path(root)/'file'
 def write(base, path='file', data=b'replacement\n', limit=1024):
  g.sys.stdin=io.TextIOWrapper(io.BytesIO(data))
  out=io.StringIO()
  with contextlib.redirect_stdout(out):
   g.fs_compare_write(root,path,0o644,base,limit)
  return json.loads(out.getvalue())
 def refuse(base, code, path='file', data=b'replacement\n', limit=1024, current=None):
  err=io.StringIO()
  try:
   with contextlib.redirect_stderr(err): write(base,path,data,limit)
  except SystemExit as e: assert e.code==code,(e.code,code)
  else: raise AssertionError('accepted refused write')
  if current is not None: assert err.getvalue()=='smithers-guest: stale:'+current+'\n',err.getvalue()
 p.write_bytes(b'original\n')
 assert write(old)=={'digest':new}
 assert p.read_bytes()==b'replacement\n'
 refuse(old,6,current=new)
 assert p.read_bytes()==b'replacement\n'
 refuse('absent',6)
 refuse('bad',3)
 refuse('A'*64,3)
 refuse('absent',3,'../escape')
 refuse('absent',3,'/absolute')
 refuse('absent',3,'')
 refuse(new,4,data=b'x'*1025)
 assert p.read_bytes()==b'replacement\n'
 p.unlink()
 refuse(old,6)
 assert not p.exists()
 assert write('absent')=={'digest':new}
 assert p.read_bytes()==b'replacement\n'
 # An outside replacement immediately before the actual exchange must be
 # restored from displaced bytes, not from the earlier comparison read.
 p.write_bytes(b'original\n')
 exchange=g.exchange_file
 raced=[False]
 def race(parent,source,target,flags):
  if not raced[0]:
   raced[0]=True
   q=pathlib.Path(root)/'outside'
   q.write_bytes(b'outside\n');os.replace(q,p)
  exchange(parent,source,target,flags)
 g.exchange_file=race
 refuse(old,6,current=outside)
 assert p.read_bytes()==b'outside\n'
 assert sorted(os.listdir(root))==['file']
 # NOREPLACE refuses a destination created after the absent comparison.
 p.unlink();raced[0]=False
 refuse('absent',6,current=outside)
 assert p.read_bytes()==b'outside\n'
 assert sorted(os.listdir(root))==['file']
 g.exchange_file=exchange
 # Never follow a final symlink, including one exchanged into place.
 p.unlink();os.symlink('/etc/passwd',p)
 try: write('absent')
 except OSError: pass
 else: raise AssertionError('followed symlink')
 p.unlink();p.write_bytes(b'original\n')
 raced[0]=False
 def symlink_race(parent,source,target,flags):
  if not raced[0]:
   raced[0]=True;p.unlink();os.symlink('/etc/passwd',p)
  exchange(parent,source,target,flags)
 g.exchange_file=symlink_race
 try: write(old)
 except OSError: pass
 else: raise AssertionError('accepted displaced symlink')
 assert p.is_symlink() and os.readlink(p)=='/etc/passwd'
 assert sorted(os.listdir(root))==['file']
 g.exchange_file=exchange
 # A missing or symlink parent creates no path.
 try: write('absent','missing/file')
 except FileNotFoundError: pass
 else: raise AssertionError('created parent')
 assert not (pathlib.Path(root)/'missing').exists()
 os.symlink('/tmp',pathlib.Path(root)/'link')
 try: write('absent','link/file')
 except OSError: pass
 else: raise AssertionError('followed parent symlink')
`)
}

func TestGuestCompareWriteUnqualifiedCLI(t *testing.T) {
	boundaryPython(t, `
import io,pathlib
with tempfile.TemporaryDirectory() as root:
 p=pathlib.Path(root)/'file';p.write_bytes(b'original\n')
 g.sys.stdin=io.TextIOWrapper(io.BytesIO(b'replacement\n'))
 # The production command gate cannot be opened by a valid digest.
 try: g.main(['fs','agent','compare-write',root,'file','644',
              '25718360e05d3c2d0963d1381e9dd4dae5fca789244ee4b9f861adcc0cc96218','1024'])
 except SystemExit as e: assert e.code==125,e.code
 else: raise AssertionError('enabled unqualified provider')
 assert p.read_bytes()==b'original\n'
 assert os.listdir(root)==['file']
`)
}
