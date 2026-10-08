// Package guestfixture uploads benchmark fixtures through ordinary unprivileged
// sessions. It is not a product save API and never runs branch artifacts as root.
package guestfixture

import (
	"context"
	"encoding/base64"
	"fmt"
	"io/fs"
	"path"
	"strings"

	workspace "github.com/smithersai/smithers/packages/backend/workspace"
)

type Executor interface {
	ExecuteCommand(context.Context, string, workspace.Command) (workspace.CommandResult, error)
}

// WriteFile bounds argv size for large archives. Partial uploads fail the run;
// only the final command applies the requested mode.
func WriteFile(ctx context.Context, runtime Executor, id, name string, content []byte, mode fs.FileMode) error {
	if name == "." || path.IsAbs(name) || path.Clean(name) != name || strings.HasPrefix(name, "../") || mode != mode.Perm() {
		return fmt.Errorf("invalid benchmark fixture path or mode: %q", name)
	}
	const chunkSize = 32768
	for offset := 0; ; {
		if err := ctx.Err(); err != nil {
			return err
		}
		end := min(offset+chunkSize, len(content))
		final := end == len(content)
		result, err := runtime.ExecuteCommand(ctx, id, workspace.Command{Args: []string{
			"/usr/bin/python3", "-I", "-S", "-c", upload,
			name, base64.StdEncoding.EncodeToString(content[offset:end]), fmt.Sprint(offset), fmt.Sprintf("%o", mode.Perm()), fmt.Sprint(final),
		}})
		if err != nil {
			return err
		}
		if result.ExitCode != 0 {
			return fmt.Errorf("benchmark fixture upload: exit %d: %s", result.ExitCode, result.Stderr)
		}
		if final {
			return nil
		}
		offset = end
	}
}

const upload = `import os,sys,base64
p=os.path.realpath(sys.argv[1])
r=os.path.realpath('.')
if os.path.commonpath([r,p]) != r: raise ValueError('fixture leaves workspace')
os.makedirs(os.path.dirname(p),exist_ok=True)
n=int(sys.argv[3])
f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW|(os.O_TRUNC if n==0 else 0),0o600)
with os.fdopen(f,'wb') as out:
 out.seek(n);out.write(base64.b64decode(sys.argv[2]));out.flush();os.fsync(out.fileno())
if sys.argv[5]=='true': os.chmod(p,int(sys.argv[4],8))`
