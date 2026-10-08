package microsandbox

import "testing"

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
