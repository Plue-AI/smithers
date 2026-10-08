package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Every operation delegates to the approved installed runtime. This barrier
// delays delivery of one real broker result; it supplies no PTY or credential.
type pendingInstalledRuntime struct {
	*microsandbox.Runtime
	armed            atomic.Bool
	entered, release chan struct{}
}

func (r *pendingInstalledRuntime) SessionCredentialsForMember(ctx context.Context, branch string, member microsandbox.MemberIdentity) (microsandbox.MemberSessionCredentials, error) {
	writer, err := r.Runtime.SessionCredentialsForMember(ctx, branch, member)
	if err != nil {
		return nil, err
	}
	return pendingInstalledWriter{writer, r}, nil
}

type pendingInstalledWriter struct {
	microsandbox.MemberSessionCredentials
	barrier *pendingInstalledRuntime
}

func (w pendingInstalledWriter) OpenTerminal(ctx context.Context, branch, session, digest string, command workspaceapi.Command) (workspaceapi.Terminal, error) {
	terminal, err := w.MemberSessionCredentials.OpenTerminal(ctx, branch, session, digest, command)
	if err == nil && w.barrier.armed.CompareAndSwap(true, false) {
		close(w.barrier.entered)
		select {
		case <-w.barrier.release:
		case <-ctx.Done():
		}
	}
	return terminal, err
}

func testInstalledTerminalPendingAPI(t *testing.T, h *rootLayerHarness, branch string, ben http.CookieJar) {
	t.Helper()
	original := h.options.Workspace
	defer func() { h.options.Workspace = original; h.recompose() }()
	for _, mode := range []string{"revocation", "rotation"} {
		t.Run("native pending open/"+mode, func(t *testing.T) {
			runtime := &pendingInstalledRuntime{Runtime: h.runtime, entered: make(chan struct{}), release: make(chan struct{})}
			h.options.Workspace = runtime
			h.recompose()
			released := false
			defer func() {
				if !released {
					close(runtime.release)
				}
			}()
			observer := installedMemberTerminal(t, h, branch, ben)
			prefix := "/workspace/trm-pending-" + uuid.NewString()
			installedTerminalInventory(t, observer, prefix, "save")
			defer installedShell(t, observer, fmt.Sprintf("rm -f %q", prefix+".inventory"))
			runtime.armed.Store(true)
			requests := &rehearsal{ctx: t.Context(), origin: h.origin, jar: ben, client: h.client}
			key := uuid.NewString()
			code, raw, err := requests.keyedAs(ben, "POST", "/api/terminals", fmt.Sprintf(`{"branch":%q}`, branch), key)
			require.NoError(t, err)
			require.Equal(t, 202, code, string(raw))
			var receipt services.WorkspaceSessionResponse
			require.NoError(t, json.Unmarshal(raw, &receipt))
			select {
			case <-runtime.entered:
			case <-time.After(30 * time.Second):
				t.Fatal("installed broker result did not reach barrier")
			}
			installedTerminalInventory(t, observer, prefix, "1")
			var tokenID int64
			require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT id FROM access_tokens WHERE name=$1`, "terminal-session-"+receipt.ID).Scan(&tokenID))
			var successorID int64
			if mode == "rotation" {
				code, raw, err = requests.keyedAs(ben, "POST", "/api/user/tokens", `{"name":"native-pending-successor","scopes":["read:user"]}`, uuid.NewString())
				require.NoError(t, err)
				require.Equal(t, 201, code, string(raw))
				require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT id FROM access_tokens WHERE name='native-pending-successor'`).Scan(&successorID))
			}
			code, raw, err = requests.keyedAs(ben, "DELETE", fmt.Sprintf("/api/user/tokens/%d", tokenID), "", uuid.NewString())
			require.NoError(t, err)
			require.Equal(t, 204, code, string(raw))
			close(runtime.release)
			released = true
			require.Eventually(t, func() bool {
				code, raw, err := requests.keyedAs(ben, "POST", "/api/terminals", fmt.Sprintf(`{"branch":%q}`, branch), key)
				var current services.WorkspaceSessionResponse
				return err == nil && code == 202 && json.Unmarshal(raw, &current) == nil && current.Status == "failed"
			}, 5*time.Second, 20*time.Millisecond)
			installedTerminalInventory(t, observer, prefix, "0")
			installedShell(t, observer, fmt.Sprintf(`test ! -e /run/smithers/20001/token/sessions/%s/token`, receipt.ID))
			if successorID != 0 {
				var count int
				require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM access_tokens WHERE id=$1`, successorID).Scan(&count))
				require.Equal(t, 1, count)
				code, raw, err = requests.keyedAs(ben, "DELETE", fmt.Sprintf("/api/user/tokens/%d", successorID), "", uuid.NewString())
				require.NoError(t, err)
				require.Equal(t, 204, code, string(raw))
			}
		})
	}
}
