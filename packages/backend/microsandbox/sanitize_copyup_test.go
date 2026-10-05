package microsandbox

import "testing"

// On the guest's overlay root any chmod of an image (lower) file copies the
// whole file into the writable layer and fsyncs it, even when the mode does
// not change. Setup must change only files that carry set-id bits: a fresh
// node:26.5.0-trixie /usr has 26,677 regular files and 13 set-id files, and
// chmod-ing all of them took 407 s and copied 1,256 MiB (#3439).
func TestSanitizeChangesOnlySetIDFiles(t *testing.T) {
	boundaryPython(t, `
with tempfile.TemporaryDirectory() as directory:
 usr=os.path.realpath(directory)+'/usr'; os.mkdir(usr); os.mkdir(usr+'/bin')
 for name,mode in (('plain',0o755),('data',0o644),('setuid',0o4755),('setgid',0o2755)):
  with open(usr+'/bin/'+name,'wb') as f: f.write(b'image fixture')
  os.chmod(usr+'/bin/'+name,mode)
 real_fstat=os.fstat; real_fchmod=os.fchmod; original=g.safe_directory
 g.safe_directory=lambda path,**kwargs: os.open(usr,os.O_RDONLY|os.O_DIRECTORY)
 g.os.fstat=lambda fd: types.SimpleNamespace(st_uid=0,st_mode=real_fstat(fd).st_mode,st_ino=real_fstat(fd).st_ino)
 g.os.listxattr=lambda fd: []
 changed=[]
 def fchmod(fd,mode):
  changed.append(real_fstat(fd).st_ino); real_fchmod(fd,mode)
 g.os.fchmod=fchmod
 try: g.sanitize_system_image()
 finally: g.os.fstat=real_fstat; g.os.fchmod=real_fchmod; g.safe_directory=original
 inode=lambda name: os.stat(usr+'/bin/'+name).st_ino
 assert sorted(changed)==sorted([inode('setuid'),inode('setgid')]), ('chmod of files without set-id bits', changed)
 modes={name: os.stat(usr+'/bin/'+name).st_mode & 0o7777 for name in ('plain','data','setuid','setgid')}
 assert modes=={'plain':0o755,'data':0o644,'setuid':0o755,'setgid':0o755}, modes
`)
}
