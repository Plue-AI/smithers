package microsandbox

import "testing"

func TestGuestStartupRecoveryWithoutPendingConsumesNoBranchInput(t *testing.T) {
	boundaryPython(t, mutationCoordinatorFixture+`
def forbidden(*args,**kwargs):raise AssertionError('empty recovery consumed input or started a worker')
g.mutation_account=forbidden;g.os.fork=forbidden
g.sys.stdin=types.SimpleNamespace(buffer=types.SimpleNamespace(read=forbidden))
g.recover_mutation=forbidden
try:g.main(['recover-files'])
except SystemExit as error:assert error.code==0,error.code
else:raise AssertionError('recovery did not propagate its status')
assert events==[] and (workspace/'a').read_bytes()==b'alpha'
no_pending()
`)
}

func TestGuestStartupRecoverySettlesPartialMutationBeforeAdmission(t *testing.T) {
	boundaryPython(t, mutationCoordinatorFixture+`
replace=g.os.replace
def replacing(source,target,**kwargs):
 replace(source,target,**kwargs)
 if target=='a':os.kill(os.getpid(),signal.SIGKILL)
g.os.replace=replacing
try:g.coordinate_mutation(prepare,emit,4096)
except SystemExit as error:assert error.code==125,error.code
else:raise AssertionError('dead mutation worker succeeded')
g.os.replace=replace
assert pending().exists() and (workspace/'a').read_bytes()==b'ALPHA'
try:
 with g.writer_admission():raise AssertionError('pending mutation admitted a writer')
except SystemExit as error:assert error.code==125,error.code
def forbidden(*args,**kwargs):raise AssertionError('startup read stdin')
g.sys.stdin=types.SimpleNamespace(buffer=types.SimpleNamespace(read=forbidden))
try:g.main(['recover-files'])
except SystemExit as error:assert error.code==0,error.code
assert (workspace/'a').read_bytes()==b'alpha'
no_pending()
with g.writer_admission():pass
`)
}

func TestGuestStartupRecoveryRefusesCorruptJournalWithoutThaw(t *testing.T) {
	boundaryPython(t, mutationCoordinatorFixture+`
parent=g.protected_directory(g.WRITER_COORDINATOR,True)
p,j=g.mutation_pending(parent,entry,real_gid)
g.mutation_write_new(j,'state.json',b'not a journal',0o600)
os.close(j);os.close(p);os.close(parent)
try:g.main(['recover-files'])
except SystemExit as error:assert error.code==125,error.code
else:raise AssertionError('corrupt startup recovery succeeded')
assert pending().exists() and (writers/'cgroup.freeze').read_text()=='1'
assert b'0' not in events and (workspace/'a').read_bytes()==b'alpha'
`)
}

func TestGuestStartupRecoveryRejectsUnprivilegedAndOperandEnvelopes(t *testing.T) {
	boundaryPython(t, mutationCoordinatorFixture+`
for args in (['recover-files','/workspace'],['recover-files','67108864']):
 try:g.main(args)
 except SystemExit as error:assert error.code==125,error.code
 else:raise AssertionError('recovery accepted operands')
g.os.geteuid=lambda:real_uid
try:g.main(['recover-files'])
except SystemExit as error:assert error.code==125,error.code
else:raise AssertionError('unprivileged recovery accepted')
assert events==[] and not pending().exists()
assert (workspace/'a').read_bytes()==b'alpha'
`)
}
