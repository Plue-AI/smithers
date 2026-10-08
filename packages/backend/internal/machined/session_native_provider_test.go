package machined

import (
	"bufio"
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Provider removal is exercised with an authenticated installed connection and
// a real held process. Refused doors cannot create cgroups or drain its sibling.
func TestSessionProductionProviderAdmissionMatrix(t *testing.T) {
	h := nativeSessions(t)
	sibling, out, stderr := h.exec(nativeAlice, "/bin/cat")
	observer := nativeCensus(t, h)
	before := observer()
	require.Equal(t, fmt.Sprintf("s%d", sibling.ID()), before)
	for _, name := range []string{"session provider", "authenticated connection", "boot authority", "registry", "wrong branch"} {
		t.Run(name, func(t *testing.T) {
			candidate := *h.sessions
			switch name {
			case "session provider":
				candidate.rpc = nil
			case "authenticated connection":
				candidate.connection = nil
			case "boot authority":
				candidate.connection = &Connection{registry: h.registry}
			case "registry":
				candidate.connection = &Connection{boot: h.link.Connection.boot}
			case "wrong branch":
				candidate.branch = "unbound-branch"
			}
			calls := map[string]func() error{
				"open": func() error {
					_, err := candidate.OpenSession(h.ctx, nativeBen, SessionExec, []string{"/bin/true"}, nil)
					return err
				},
				"tcp":          func() error { _, err := candidate.TCPConnect(h.ctx, 8080); return err },
				"close":        func() error { return candidate.CloseSession(h.ctx, sibling.ID()) },
				"kill":         func() error { _, err := candidate.KillSession(h.ctx, sibling.ID()); return err },
				"kill user":    func() error { _, err := candidate.KillUser(h.ctx, nativeAlice); return err },
				"kill run":     func() error { _, err := candidate.KillRun(h.ctx, "registered-run"); return err },
				"register run": func() error { return candidate.RegisterRun(h.ctx, "registered-run", sibling.ID()) },
				"attach":       func() error { _, err := candidate.AttachSession(h.ctx, sibling.ID(), 0); return err },
				"stream":       func() error { _, err := candidate.Stream(h.ctx, sibling.ID()); return err },
			}
			for door, call := range calls {
				t.Run(door, func(t *testing.T) { require.Error(t, call()) })
			}
		})
	}
	require.Equal(t, before, observer(), "refused doors changed installed process groups")
	_, err := sibling.Write([]byte("installed-provider-controls-survived\n"))
	require.NoError(t, err)
	require.NoError(t, sibling.CloseWrite())
	require.NoError(t, sibling.Wait())
	require.Equal(t, "installed-provider-controls-survived\n", string(<-out))
	require.Empty(t, <-stderr)
}

// Keep one real observer session across both snapshots: admission inodes are
// one-use, so a second observation must not silently require another launch.
func nativeCensus(t *testing.T, h *nativeSessionHarness) func() string {
	t.Helper()
	const script = `import glob,os,sys
own=open('/proc/self/cgroup').read().strip().rsplit('/',1)[-1]
for line in sys.stdin:
 names=[]
 for d in glob.glob('/sys/fs/cgroup/smithers/sessions/s*'):
  if os.path.basename(d)==own: continue
  try:
   if 'populated 1' in open(d+'/cgroup.events').read().splitlines(): names.append(os.path.basename(d))
  except FileNotFoundError: pass
 print(','.join(sorted(names)),flush=True)
`
	e, err := h.sessions.OpenExec(h.ctx, nativeBen, []string{"/usr/bin/python3", "-c", script})
	require.NoError(t, err)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		require.NoError(t, e.Kill(ctx))
	})
	reader := bufio.NewReader(e.Stdout())
	return func() string {
		t.Helper()
		_, err := e.Write([]byte("census\n"))
		require.NoError(t, err)
		line, err := reader.ReadString('\n')
		require.NoError(t, err)
		return strings.TrimSpace(line)
	}
}
