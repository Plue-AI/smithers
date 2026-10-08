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
seed_pending()
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

func TestGuestStartupRecoveryRetainsSettledJournalsAndOutsideBytes(t *testing.T) {
	for _, phase := range []string{"committed", "aborted"} {
		t.Run(phase, func(t *testing.T) {
			boundaryPython(t, mutationCoordinatorFixture+"phase='"+phase+`'
seed_pending()
journal=pending()/'journal';state=json.loads((journal/'state.json').read_text())
state['phase']=phase;(journal/'state.json').write_text(json.dumps(state))
(workspace/'a').write_bytes(b'outside after settlement')
assert g.recover_files(4096)==0
assert (workspace/'a').read_bytes()==b'outside after settlement'
no_pending()
`)
		})
	}
}

func TestGuestStartupRecoveryRefusesCorruptBackupAndOutsideReplacement(t *testing.T) {
	for _, scenario := range []string{"backup", "outside", "ancestor"} {
		t.Run(scenario, func(t *testing.T) {
			boundaryPython(t, mutationCoordinatorFixture+"scenario='"+scenario+`'
seed_pending()
if scenario=='backup':(pending()/'journal/base-0').write_bytes(b'corrupt')
elif scenario=='outside':(workspace/'a').write_bytes(b'outside replacement')
else:
 (workspace/'a').unlink();(workspace/'a').symlink_to(base/'outside')
 (base/'outside').write_bytes(b'outside replacement')
try:g.recover_files(4096)
except (SystemExit,OSError):pass
else:raise AssertionError('unsafe recovery succeeded')
assert pending().exists() and (writers/'cgroup.freeze').read_text()=='1'
assert b'0' not in events
if scenario=='outside':assert (workspace/'a').read_bytes()==b'outside replacement'
if scenario=='ancestor':assert (base/'outside').read_bytes()==b'outside replacement'
`)
		})
	}
}

func TestGuestStartupRecoveryCanRestartAfterWorkerDeath(t *testing.T) {
	boundaryPython(t, mutationCoordinatorFixture+`
seed_pending()
replace=g.os.replace
def replacing(source,target,**kwargs):
 replace(source,target,**kwargs)
 if target=='a':os.kill(os.getpid(),signal.SIGKILL)
g.os.replace=replacing
try:g.recover_files(4096)
except SystemExit as error:assert error.code==125,error.code
else:raise AssertionError('dead recovery worker succeeded')
assert pending().exists() and (writers/'cgroup.freeze').read_text()=='1'
assert (workspace/'a').read_bytes()==b'alpha'
g.os.replace=replace
assert g.recover_files(4096)==0
assert (workspace/'a').read_bytes()==b'alpha'
no_pending()
`)
}
