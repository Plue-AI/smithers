package microsandbox

import (
	"fmt"
	"testing"
)

// Real child processes, journal and file operations. Credential/cgroup queries
// are explicitly substituted by mutationCoordinatorFixture, not qualified here.
const compareWriteAdapterFixture = mutationCoordinatorFixture + `
import base64,io,json
def change(path,base,body):
 return {'path':path,'base_digest':base,'content':None if body is None else base64.b64encode(body).decode(),**({} if body is None else {'encoding':'base64'})}
def compare(changes,limit='4096',root='/workspace',raw=None):
 class Args(list):
  def __getitem__(self,key):
   if key!=4:assert g.os.geteuid()==real_uid,'root consumed branch operands'
   return super().__getitem__(key)
 class Input(io.BytesIO):
  def read(self,size=-1):
   assert g.os.geteuid()==real_uid,'root consumed branch bytes'
   assert (writers/'cgroup.freeze').read_text()=='0','input read while caller frozen'
   assert size==min(64<<20,6*int(limit)+(2<<20))+1,'unbounded input read'
   return super().read(size)
 args=Args(['fs','agent','compare-write',root,limit])
 body=json.dumps({'changes':changes}).encode() if raw is None else raw
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

func TestGuestCompareWriteAdapterBatchExactBytesAndModesAfterDrop(t *testing.T) {
	boundaryPython(t, compareWriteAdapterFixture+`
body=bytes(range(256))*8+b'\x00\xff\n'
(workspace/'a').chmod(0o751)
(workspace/'move').write_bytes(b'moved')
(workspace/'remove').write_bytes(b'removed')
read=g.mutation_read
def frozen_read(*args):
 assert g.os.geteuid()==real_uid
 assert (writers/'cgroup.freeze').read_text()=='1','file/mode read before exclusion'
 return read(*args)
g.mutation_read=frozen_read
batch=[change('a',H(b'alpha'),body),change('move',H(b'moved'),None),change('nested/new','absent',b'moved'),change('remove',H(b'removed'),None),change('empty','absent',b''),{'path':'text','base_digest':'absent','content':'é\n'}]
code,out,err=compare(batch)
assert code==0 and err=='',(code,out,err)
assert json.loads(out)=={'changes':[{'path':c['path'],'digest':d} for c,d in zip(batch,[H(body),'absent',H(b'moved'),'absent',H(b''),H('é\n'.encode())])]},out
assert (workspace/'a').read_bytes()==body and (workspace/'a').stat().st_mode&0o777==0o751
assert not (workspace/'move').exists() and not (workspace/'remove').exists()
assert (workspace/'nested/new').read_bytes()==b'moved' and (workspace/'nested/new').stat().st_mode&0o777==0o644
assert (workspace/'empty').read_bytes()==b'' and (workspace/'text').read_bytes()=='é\n'.encode()
assert events==[b'1',b'0'],events
no_pending()
`)
}

func TestGuestCompareWriteAdapterLaterStaleLeavesWholeBatchUnchanged(t *testing.T) {
	for _, scenario := range []string{"later-update", "move-source", "move-destination", "delete", "absent-create"} {
		t.Run(scenario, func(t *testing.T) {
			boundaryPython(t, compareWriteAdapterFixture+fmt.Sprintf("scenario=%q\n", scenario)+`
(workspace/'b').write_bytes(b'outside')
batch=[change('a',H(b'alpha'),b'NEW'),change('nested/new','absent',b'new')]
path,current='b',H(b'outside')
if scenario=='later-update':batch.append(change('b',H(b'old'),b'NEW'))
elif scenario=='move-source':batch += [change('destination','absent',b'old'),change('b',H(b'old'),None)]
elif scenario=='move-destination':batch += [change('b','absent',b'old'),change('source','absent',None)]
elif scenario=='delete':batch.append(change('b',H(b'old'),None))
elif scenario=='absent-create':batch.append(change('b','absent',b'NEW'))
code,out,err=compare(batch)
assert code==6 and out=='',(code,out,err)
assert json.loads(err.removeprefix('smithers-guest: stale:'))=={'path':path,'current_digest':current},err
assert {p.name:p.read_bytes() for p in workspace.iterdir()}=={'a':b'alpha','b':b'outside'}
no_pending()
`)
		})
	}
}

func TestGuestCompareWriteAdapterRejectsMalformedBatchAndAllowsRetry(t *testing.T) {
	for _, scenario := range []string{"digest", "upper-digest", "path", "absolute", "empty-path", "root", "mode", "uid", "actor", "branch", "machine", "unknown", "missing-content", "missing-base", "null-encoding", "delete-encoding", "bad-encoding", "bad-base64", "base64-bits", "base64-newline", "surrogate", "number", "duplicate-path", "overlap", "reverse-overlap", "empty", "too-many", "oversize", "total-oversize", "invalid-json", "duplicate-field", "duplicate-top", "top-unknown", "trailing-json", "non-utf8", "nan", "wire-limit"} {
		t.Run(scenario, func(t *testing.T) {
			boundaryPython(t, compareWriteAdapterFixture+fmt.Sprintf("scenario=%q\n", scenario)+`
c=change('a',H(b'alpha'),b'new');batch=[c];root='/workspace';raw=None
if scenario=='digest':c['base_digest']='bad'
elif scenario=='upper-digest':c['base_digest']=c['base_digest'].upper()
elif scenario=='path':c['path']='../escape'
elif scenario=='absolute':c['path']='/a'
elif scenario=='empty-path':c['path']=''
elif scenario=='root':root='/elsewhere'
elif scenario in ('mode','uid','actor','branch','machine','unknown'):c[scenario]=0
elif scenario=='missing-content':del c['content']
elif scenario=='missing-base':del c['base_digest']
elif scenario=='null-encoding':c['encoding']=None
elif scenario=='delete-encoding':c['content']=None
elif scenario=='bad-encoding':c['encoding']='hex'
elif scenario=='bad-base64':c['content']='%%%'
elif scenario=='base64-bits':c['content']='Zh=='
elif scenario=='base64-newline':c['content']='Zg==\n'
elif scenario=='surrogate':c.update(content='\ud800',encoding='utf-8')
elif scenario=='number':c['content']=1
elif scenario=='duplicate-path':batch.append(c)
elif scenario=='overlap':batch.append(change('a/b','absent',b'x'))
elif scenario=='reverse-overlap':batch=[change('a/b','absent',b'x'),c]
elif scenario=='empty':batch=[]
elif scenario=='too-many':batch=[change(str(i),'absent',b'') for i in range(257)]
elif scenario=='oversize':batch=[change('a',H(b'alpha'),b'X'*4097)]
elif scenario=='total-oversize':batch=[change('a',H(b'alpha'),b'X'*4096),change('b','absent',b'x')]
elif scenario=='invalid-json':raw=b'{'
elif scenario=='duplicate-field':raw=b'{"changes":[{"path":"a","path":"b","base_digest":"absent","content":""}]}'
elif scenario=='duplicate-top':raw=b'{"changes":[],"changes":[]}'
elif scenario=='top-unknown':raw=b'{"changes":[],"actor":0}'
elif scenario=='trailing-json':raw=b'{"changes":[]} {}'
elif scenario=='non-utf8':raw=b'\xff'
elif scenario=='nan':raw=b'{"changes":NaN}'
elif scenario=='wire-limit':raw=b' '*(6*4096+(2<<20)+1)
code,out,err=compare(batch,root=root,raw=raw)
expected=4 if scenario in ('oversize','total-oversize','wire-limit') else 3
assert code==expected and out=='' and err.startswith('smithers-guest: '),(code,out,err)
assert (workspace/'a').read_bytes()==b'alpha' and list(workspace.iterdir())==[workspace/'a']
no_pending()
code,out,err=compare([change('a',H(b'alpha'),b'retry')])
assert code==0 and json.loads(out)=={'changes':[{'path':'a','digest':H(b'retry')}]} and err=='',(code,out,err)
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
 try:compare([change('a',H(b'alpha'),b'new')],limit=limit)
 except SystemExit as error:assert error.code==3,error.code
 else:raise AssertionError('invalid limit accepted')
assert not pending().exists() and events==[]
assert (workspace/'a').read_bytes()==b'alpha'
`)
}

func TestGuestCompareWriteAdapterInclusiveBounds(t *testing.T) {
	boundaryPython(t, compareWriteAdapterFixture+`
batch=[change('a',H(b'alpha'),b'X'*4096)]+[change('empty-'+str(i),'absent',b'') for i in range(255)]
code,out,err=compare(batch)
assert code==0 and err=='',(code,err)
assert len(json.loads(out)['changes'])==256
assert (workspace/'a').read_bytes()==b'X'*4096
no_pending()
`)
}

func TestGuestCompareWriteAdapterStaleDiagnosticFollowsThaw(t *testing.T) {
	boundaryPython(t, compareWriteAdapterFixture+`
original_error=g.sys.stderr
class ThawedError:
 def write(self,body):
  assert (writers/'cgroup.freeze').read_text()=='0','diagnostic can block before caller thaws'
  return original_error.write(body)
 def flush(self):return original_error.flush()
g.sys.stderr=ThawedError()
code,out,err=compare([change('a','absent',b'new')])
assert code==6 and out=='',(code,out,err)
assert json.loads(err.removeprefix('smithers-guest: stale:'))=={'path':'a','current_digest':H(b'alpha')},err
assert (workspace/'a').read_bytes()==b'alpha'
no_pending()
`)
}
