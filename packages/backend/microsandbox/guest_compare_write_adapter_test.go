package microsandbox

import (
	"fmt"
	"testing"
)

// Exercise the existing single-file envelope through real child processes and
// the journal, with the fixture's explicit credential/cgroup substitutions.
const compareWriteAdapterFixture = mutationCoordinatorFixture + `
import io,json
def compare(path,base_digest,body,mode='644',limit='4096',root='/workspace'):
 class Args(list):
  def __getitem__(self,key):
   if key!=7:assert g.os.geteuid()==real_uid,'root consumed branch operands'
   return super().__getitem__(key)
 class Input(io.BytesIO):
  def read(self,size=-1):
   assert g.os.geteuid()==real_uid,'root consumed branch bytes'
   assert size==int(limit)+1,'unbounded input read'
   return super().read(size)
 args=Args(['fs','agent','compare-write',root,path,mode,base_digest,limit])
 prior_in=g.sys.stdin
 g.sys.stdout.flush();g.sys.stderr.flush()
 saved_out,saved_err=os.dup(1),os.dup(2)
 output=base/'output';error=base/'error'
 try:
  g.sys.stdin=types.SimpleNamespace(buffer=Input(body))
  with output.open('w') as out,error.open('w') as err:
   os.dup2(out.fileno(),1);os.dup2(err.fileno(),2)
   code=g.coordinated_compare_write(args)
 finally:
  g.sys.stdout.flush();g.sys.stderr.flush()
  os.dup2(saved_out,1);os.dup2(saved_err,2)
  os.close(saved_out);os.close(saved_err);g.sys.stdin=prior_in
 return code,output.read_text(),error.read_text()
`

func TestGuestCompareWriteAdapterWritesExactBytesAfterDrop(t *testing.T) {
	boundaryPython(t, compareWriteAdapterFixture+`
body=bytes(range(256))*8+b'\x00\xff\n'
code,out,err=compare('a',H(b'alpha'),body,'640')
assert code==0 and err=='',(code,err)
assert json.loads(out)=={'digest':H(body)},out
assert (workspace/'a').read_bytes()==body
assert (workspace/'a').stat().st_mode & 0o777==0o640
no_pending()
code,out,err=compare('nested/new','absent',b'')
assert code==0 and err=='',(code,err)
assert json.loads(out)=={'digest':H(b'')}
assert (workspace/'nested/new').read_bytes()==b''
no_pending()
`)
}

func TestGuestCompareWriteAdapterStalePreservesBytesAndSettles(t *testing.T) {
	boundaryPython(t, compareWriteAdapterFixture+`
for path,base_digest,current in [('a',H(b'old'),H(b'alpha')),('a','absent',H(b'alpha')),('missing',H(b'old'),'absent')]:
 code,out,err=compare(path,base_digest,b'new')
 assert code==6 and out=='' and err=='smithers-guest: stale:'+current+'\n',(code,out,err)
 assert (workspace/'a').read_bytes()==b'alpha'
 assert not (workspace/'missing').exists()
 no_pending()
`)
}

func TestGuestCompareWriteAdapterInvalidInputDoesNotFenceLaterRequests(t *testing.T) {
	for _, scenario := range []string{"digest", "upper-digest", "path", "absolute", "empty", "root", "mode", "special-mode", "oversize"} {
		t.Run(scenario, func(t *testing.T) {
			boundaryPython(t, compareWriteAdapterFixture+fmt.Sprintf("scenario=%q\n", scenario)+`
path,base_digest,body,mode,limit,root='a',H(b'alpha'),b'new','644','4096','/workspace'
if scenario=='digest':base_digest='bad'
elif scenario=='upper-digest':base_digest=base_digest.upper()
elif scenario=='path':path='../escape'
elif scenario=='absolute':path='/a'
elif scenario=='empty':path=''
elif scenario=='root':root='/elsewhere'
elif scenario=='mode':mode='999'
elif scenario=='special-mode':mode='4644'
elif scenario=='oversize':body=b'X'*4097
code,out,err=compare(path,base_digest,body,mode,limit,root)
assert code==(4 if scenario=='oversize' else 3) and out=='' and err.startswith('smithers-guest: '),(code,out,err)
assert (workspace/'a').read_bytes()==b'alpha' and list(workspace.iterdir())==[workspace/'a']
no_pending()
code,out,err=compare('a',H(b'alpha'),b'retry')
assert code==0 and json.loads(out)=={'digest':H(b'retry')} and err=='',(code,out,err)
assert (workspace/'a').read_bytes()==b'retry'
no_pending()
`)
		})
	}
}

func TestGuestCompareWriteAdapterRejectsInvalidSizeBeforeAdmission(t *testing.T) {
	boundaryPython(t, compareWriteAdapterFixture+`
g.coordinate_mutation=lambda *args:(_ for _ in ()).throw(AssertionError('invalid envelope admitted'))
for limit in ('0','-1','67108865','999999999','1.5','1024\n',' 1024',None):
 try:compare('a',H(b'alpha'),b'new',limit=limit)
 except SystemExit as error:assert error.code==3,error.code
 else:raise AssertionError('invalid limit accepted')
assert not pending().exists() and events==[]
assert (workspace/'a').read_bytes()==b'alpha'
`)
}
