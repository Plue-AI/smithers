package microsandbox

import (
	"context"
	"encoding/base64"
	"fmt"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"io/fs"
)

// writeGuestFixture plants test data as a normal unprivileged session. It is
// deliberately not a file-save API: binary, executable and hostile fixtures
// are outside writes, while save assertions enter the authenticated HTTP door.
func writeGuestFixture(r workspaceapi.WorkspaceRuntime, ctx context.Context, id, path string, content []byte, mode fs.FileMode) error {
	if mode == 0 {
		mode = 0600
	}
	result, err := r.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{
		"/usr/bin/python3", "-I", "-S", "-c",
		`import os,sys,base64
p=sys.argv[1]
os.makedirs(os.path.dirname(p) or '.',exist_ok=True)
f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,int(sys.argv[3],8))
b=base64.b64decode(sys.argv[2])
with os.fdopen(f,'wb') as out:
 out.write(b);out.flush();os.fsync(out.fileno())
os.chmod(p,int(sys.argv[3],8))`, path, base64.StdEncoding.EncodeToString(content), fmt.Sprintf("%o", mode.Perm()),
	}})
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("guest fixture: exit %d: %s", result.ExitCode, result.Stderr)
	}
	return nil
}
