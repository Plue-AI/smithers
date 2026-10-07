package microsandbox

import "testing"

// These use actual forks and recipe subprocesses as the ordinary test user.
// Root identity, protected paths and cgroup files are instrumented; no branch
// executable is run as host root and these are not privileged guest receipts.
func TestGuestRootRecipesJoinBeforeExecutionAndPreserveStatus(t *testing.T) {
	boundaryPython(t, `
import hashlib,pathlib,shutil,subprocess
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);groups=root/'groups';groups.mkdir()
 g.PROTECTED_BASE=directory;g.ROOT_UID=os.getuid();g.CGROUP_ROOT=str(groups)
 real_uid=os.getuid();assert real_uid!=0
 g.os.geteuid=lambda:0
 admitted=[];collected=[]
 def group(path,**kwargs):
  assert kwargs.get('trusted') and pathlib.Path(path).parent==groups
  pathlib.Path(path).mkdir();(pathlib.Path(path)/'cgroup.procs').touch()
  admitted.append(pathlib.Path(path));return os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 g.safe_directory=group
 def collect(path):
  collected.append(path);shutil.rmtree(path)
 g.cgroup_kill=collect
 g.drop_to=lambda user:(_ for _ in ()).throw(AssertionError('root recipe unexpectedly used ordinary drop'))
 actual_run=subprocess.run
 def run(argv,**kwargs):
  assert os.getuid()==real_uid,'branch test must stay unprivileged'
  assert (admitted[-1]/'cgroup.procs').read_text()==str(os.getpid())
  store=root.joinpath(*g.WRITER_COORDINATOR)
  protected={(p.stat().st_dev,p.stat().st_ino) for p in (store,store/'lock')}
  for name in os.listdir('/dev/fd'):
   try:info=os.fstat(int(name))
   except OSError:continue
   assert (info.st_dev,info.st_ino) not in protected,'protected descriptor reached recipe'
  mask=os.umask(0o022);assert mask==0o022
  return actual_run(argv,**kwargs)
 subprocess.run=run
 for script,expected in [('exit 0',0),('exit 7',7),('exit 127',127),('kill -TERM $$',143)]:
  digest=hashlib.sha256(script.encode()).hexdigest()
  g.ROOT_RECIPE_DIGESTS={digest:'sync'}
  assert g.run_root_recipe(digest,{'script':script})==expected
  assert str(admitted[-1])==collected[-1] and not admitted[-1].exists()
 # An ordinary caller cannot select privileged execution.
 g.os.geteuid=lambda:real_uid
 try:g.run_managed_child('forbidden',lambda _:None,privileged=True)
 except SystemExit as error:assert error.code==125,error.code
 else:raise AssertionError('unprivileged root metadata accepted')
 assert len(admitted)==4
 # Nor can a branch request add that internal flag to ordinary exec.
 g.os.geteuid=lambda:0
 try:g.run_exec({'id':'forbidden','user':'agent','argv':['id'],'privileged':True})
 except SystemExit as error:assert error.code==125,error.code
 else:raise AssertionError('branch selected root metadata')
 assert len(admitted)==4
`)
}

func TestGuestRootSetupFailureStopsBeforeHomeAndKeepsBothPhasesManaged(t *testing.T) {
	boundaryPython(t, `
import pathlib,shutil
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);groups=root/'groups';groups.mkdir()
 g.PROTECTED_BASE=directory;g.ROOT_UID=os.getuid();g.CGROUP_ROOT=str(groups)
 real_uid=os.getuid();g.os.geteuid=lambda:0
 admitted=[];collected=[]
 def group(path,**kwargs):
  assert kwargs.get('trusted') and pathlib.Path(path).parent==groups
  pathlib.Path(path).mkdir();(pathlib.Path(path)/'cgroup.procs').touch()
  admitted.append(pathlib.Path(path));return os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 g.safe_directory=group
 def collect(path):collected.append(path);shutil.rmtree(path)
 g.cgroup_kill=collect
 def drop(user):
  assert user=='agent';g.os.geteuid=lambda:real_uid
  return 'dropped-entry'
 g.drop_to=drop
 marker=root/'home';setup_marker=root/'setup'
 for code in (3,0):
  def setup(*args):
   assert g.os.geteuid()==0 and admitted[-1].name.startswith('setup-root-')
   assert (admitted[-1]/'cgroup.procs').read_text()==str(os.getpid())
   setup_marker.write_text('bounded metadata')
   if code:raise SystemExit(code)
  g.setup=setup
  def home(entry):
   assert entry=='dropped-entry' and g.os.geteuid()==real_uid
   assert not admitted[-1].name.startswith('setup-root-')
   assert (admitted[-1]/'cgroup.procs').read_text()==str(os.getpid())
   marker.write_text('home initialized')
  g.home_defaults=home
  try:g.main(['setup','agent','19999'])
  except SystemExit as error:assert error.code==code,error.code
  else:raise AssertionError('setup did not return child status')
  assert setup_marker.read_text()=='bounded metadata'
  assert marker.exists()==(code==0)
  assert len(admitted)==len(collected) and not list(groups.iterdir())
 assert len(admitted)==3,'failed setup launched a home writer'
`)
}

func TestTerminalSkillDiscoveryRunsAsSessionUser(t *testing.T) {
	boundaryPython(t, `
import pathlib,pwd
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);home=root/'home';home.mkdir();skill=root/'skill';skill.mkdir()
 (skill/'SKILL.md').write_text('generated skill')
 g.TERMINAL_SKILL_DIR=str(skill);g.TOOL_HOME=str(root/'absent-tools');g.ENV_FILE=str(root/'absent-env')
 entry=pwd.struct_passwd(('session','x',os.getuid(),os.getgid(),'session',str(home),'/bin/sh'))
 g.home_defaults(entry)
 for relative in ('.claude/skills/smithers','.agents/skills/smithers'):
  link=home/relative
  assert link.is_symlink() and link.readlink()==skill
  assert (link/'SKILL.md').read_text()=='generated skill'
 g.home_defaults(entry)
 link=home/'.claude/skills/smithers';link.unlink();link.mkdir();(link/'SKILL.md').write_text('personal')
 g.home_defaults(entry)
 assert (link/'SKILL.md').read_text()=='personal'
 entry=pwd.struct_passwd(('foreign','x',os.getuid()+1,os.getgid(),'foreign',str(home),'/bin/sh'))
 try:g.home_defaults(entry)
 except SystemExit:pass
 else:raise AssertionError('home discovery admitted another uid')
`)
}
