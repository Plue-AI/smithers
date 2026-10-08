package machined

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A member selector must drain all of that uid's session cgroups, including
// detached descendants, while preserving another member's original stream.
// This measures the broker RPC, not the composed member-removal deadline.
func TestSessionProductionMemberDrainMatrix(t *testing.T) {
	h := nativeSessions(t)
	sibling, siblingOut, siblingErr := h.exec(nativeAlice, "/bin/cat")
	type process struct {
		exec        *Exec
		out, stderr <-chan []byte
	}
	var owned []process
	for i := 0; i < 2; i++ {
		e, out, stderr := h.exec(nativeBen, "/bin/sh", "-c", "nohup sleep 120 >/dev/null 2>&1 </dev/null & exec cat")
		owned = append(owned, process{e, out, stderr})
		// The kernel must actually contain the detached child before kill.
		require.Equal(t, "ready\n", h.output(nativeAlice, fmt.Sprintf(`for i in $(seq 1 100); do test "$(wc -l < /sys/fs/cgroup/smithers/sessions/s%d/cgroup.procs)" -ge 2 && { echo ready; exit; }; sleep .01; done; exit 1`, e.ID())))
	}
	ctx, cancel := context.WithTimeout(h.ctx, 5*time.Second)
	defer cancel()
	started := time.Now()
	killed, err := h.sessions.KillUser(ctx, nativeBen)
	require.NoError(t, err)
	require.GreaterOrEqual(t, killed, uint16(2))
	for _, p := range owned {
		require.Error(t, p.exec.Wait())
		require.Empty(t, <-p.out)
		require.Empty(t, <-p.stderr)
		// Independent kernel observation follows the RPC reply, using Alice.
		require.Equal(t, "empty\n", h.output(nativeAlice, fmt.Sprintf(`p=/sys/fs/cgroup/smithers/sessions/s%d; { test ! -d "$p" || grep -qx 'populated 0' "$p/cgroup.events"; } && echo empty`, p.exec.ID())))
	}
	require.Equal(t, "no-member-process\n", h.output(nativeAlice, "pgrep -u 20001 >/dev/null; test $? = 1 && echo no-member-process"))
	require.Less(t, time.Since(started), 5*time.Second, "includes independent process and cgroup observations")
	killed, err = h.sessions.KillUser(h.ctx, nativeBen)
	require.NoError(t, err)
	require.Zero(t, killed)
	_, err = sibling.Write([]byte("alice-original-session-survived\n"))
	require.NoError(t, err)
	require.NoError(t, sibling.CloseWrite())
	require.NoError(t, sibling.Wait())
	require.Equal(t, "alice-original-session-survived\n", string(<-siblingOut))
	require.Empty(t, <-siblingErr)
}
