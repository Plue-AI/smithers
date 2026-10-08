package machined

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Payload paths cross the root spawn boundary as OpenExec arguments, rather
// than being executed by a shell that has already dropped privileges. All
// fixture creation and observation still runs as a real installed member.
func TestSessionProductionExecutableEnvironmentMatrix(t *testing.T) {
	h := nativeSessions(t)
	dir := strings.TrimSpace(h.output(nativeBen, `d=$(mktemp -d /workspace/session-payload.XXXXXXXX) || exit 1
cat > "$d/probe" <<'PY'
#!/usr/bin/python3
import os
if os.geteuid() == 0:
    open(os.path.dirname(__file__)+"/root-executed", "w").write("root")
    raise SystemExit(90)
print(os.getuid(), os.geteuid(), os.getgid(), os.getegid())
print(",".join(str(g) for g in os.getgroups()))
print(format(os.umask(2), "04o"))
print(os.getcwd())
print(open("/proc/self/cgroup").read(), end="")
print("payload-version=1")
PY
cat > "$d/canary.py" <<'PY'
import os
if os.geteuid() == 0:
    open(os.path.dirname(__file__)+"/root-executed", "w").write("root-import")
    raise SystemExit(91)
print("import-uid="+str(os.geteuid()))
print("import-version=1")
PY
chmod 700 "$d/probe"
ln -s probe "$d/link"
printf '%s\n' "$d"`))
	require.Regexp(t, `^/workspace/session-payload\.[A-Za-z0-9]{8}$`, dir)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		// The directory is independently constrained above before shell use.
		e, err := h.sessions.OpenExec(ctx, nativeBen, []string{"/bin/rm", "-rf", "--", dir, dir + ".retained"})
		if err == nil {
			_ = e.CloseWrite()
			_ = e.Wait()
			_ = e.Close()
		}
	})
	for _, phase := range []string{"initial connection", "mutated executable and ancestor", "retained files after reconnect"} {
		t.Run(phase, func(t *testing.T) {
			copy := *h
			copy.t = t
			if phase == "mutated executable and ancestor" {
				// A real member replaces the executable inode and its ancestor.
				// The identical RPC argv must resolve the retained replacement only
				// after permanent privilege drop, including following reconnect.
				require.Equal(t, "mutated\n", copy.output(nativeBen,
					"sed 's/payload-version=1/payload-version=2/' '"+dir+"/probe' > '"+dir+"/replacement' && "+
						"chmod 700 '"+dir+"/replacement' && mv '"+dir+"/replacement' '"+dir+"/probe' && "+
						"sed 's/import-version=1/import-version=2/' '"+dir+"/canary.py' > '"+dir+"/canary-replacement' && mv '"+dir+"/canary-replacement' '"+dir+"/canary.py' && "+
						"rm -rf '"+dir+"/__pycache__' && mv '"+dir+"' '"+dir+".retained' && ln -s '"+dir+".retained' '"+dir+"' && echo mutated"))
			}
			if phase == "retained files after reconnect" {
				require.NoError(t, h.link.Close())
				h.connect()
				h.sessions = NewSessions(h.link.Connection, h.config.Branch, h.registry.Sessions(h.config.Branch)).WithActor(h.sessions.actor, "").WithPresenceVia("ssh")
			}
			for _, cell := range []struct {
				name     string
				argv     []string
				imported bool
			}{
				{"branch executable", []string{dir + "/probe"}, false},
				{"branch executable symlink", []string{dir + "/link"}, false},
				{"relative branch executable", []string{"./" + strings.TrimPrefix(dir, "/workspace/") + "/probe"}, false},
				{"hostile executable and import search", []string{"/usr/bin/env", "PATH=" + dir + ":/usr/bin:/bin", "PYTHONPATH=" + dir, "ENV=" + dir + "/probe", "BASH_ENV=" + dir + "/probe", "probe"}, false},
				{"branch import", []string{"/usr/bin/env", "PYTHONPATH=" + dir, "/usr/bin/python3", "-c", "import canary; exec(open('" + dir + "/probe').read())"}, true},
			} {
				t.Run(cell.name, func(t *testing.T) {
					copy := *h
					copy.t = t
					e, out, stderr := copy.exec(nativeBen, cell.argv...)
					require.NoError(t, e.CloseWrite())
					require.NoError(t, e.Wait())
					require.Empty(t, <-stderr)
					lines := strings.Split(strings.TrimSpace(string(<-out)), "\n")
					if cell.imported {
						require.GreaterOrEqual(t, len(lines), 2)
						require.Equal(t, "import-uid=20001", lines[0])
						version := "import-version=2"
						if phase == "initial connection" {
							version = "import-version=1"
						}
						require.Equal(t, version, lines[1])
						lines = lines[2:]
					}
					require.Len(t, lines, 6)
					version := "payload-version=2"
					if phase == "initial connection" {
						version = "payload-version=1"
					}
					require.Equal(t, version, lines[5])
					require.Equal(t, []string{"20001 20001 20001 20001", "20000", "0002", "/workspace"}, lines[:4])
					require.Equal(t, fmt.Sprintf("0::/smithers/sessions/s%d", e.ID()), lines[4])
					require.Equal(t, "clean\n", copy.output(nativeBen, "test ! -e '"+dir+"/root-executed' && echo clean"))
				})
			}
		})
	}
}
