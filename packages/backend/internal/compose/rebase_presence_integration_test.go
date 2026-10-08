package compose

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// The same authenticated host reached by a browser presence frame informs
// rebase scheduling. Its incomplete source census must not look agent-alone.
func TestRebasePresenceComposedBrowserFailsClosed(t *testing.T) {
	f := presenceInstall(t)
	stack := &rebasePresenceBinding{}
	bindRebasePresence(stack, f.p)
	require.NotNil(t, stack.read)
	state, err := stack.read(t.Context(), f.row.RepositoryID, f.row.ID)
	require.NoError(t, err)
	require.Equal(t, services.RebasePresenceUnknown, state)
	conn := f.dial(t)
	sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"presence","id":1,"where":{"branch":%q,"path":"retry.ts","line":12}}`, f.row.ID))
	require.Eventually(t, func() bool { return len(f.roster(t)) == 1 }, time.Second, 10*time.Millisecond)
	state, err = stack.read(t.Context(), f.row.RepositoryID, f.row.ID)
	require.NoError(t, err)
	require.False(t, services.RebaseAtBoundary(true, state))
	state, err = stack.read(t.Context(), f.row.RepositoryID+1, f.row.ID)
	require.NoError(t, err)
	require.Equal(t, services.RebasePresenceUnknown, state)
}

func TestRebasePresenceStoppedHostRequiresCompleteCensus(t *testing.T) {
	f := presenceInstall(t)
	registry, _ := censusRegistry(t)
	f.p.terminalManager = routes.NewTerminalSessionManager(nil)
	stop := f.p.consumeDaemons(t.Context(), registry)
	t.Cleanup(stop)
	_, err := f.pool.Exec(t.Context(), `UPDATE flow_runtime_host_bindings SET state='retired' WHERE workspace_id=$1`, f.row.ID)
	require.NoError(t, err)
	q := db.New(f.pool)
	for _, status := range []string{"running", "starting", "stopped", "suspended", "failed"} {
		_, err = q.UpdateWorkspaceStatus(t.Context(), db.UpdateWorkspaceStatusParams{ID: f.row.ID, Status: status})
		require.NoError(t, err)
		state, readErr := f.p.rebasePresence(t.Context(), f.row.RepositoryID, f.row.ID)
		if status == "stopped" || status == "suspended" {
			require.NoError(t, readErr)
			require.Equal(t, services.RebasePresenceEmpty, state, status)
		} else {
			require.Error(t, readErr)
			require.Equal(t, services.RebasePresenceUnknown, state, status)
		}
	}
	_, err = q.UpdateWorkspaceStatus(t.Context(), db.UpdateWorkspaceStatusParams{ID: f.row.ID, Status: "stopped"})
	require.NoError(t, err)
	f.p.sourcesReady = nil
	state, err := f.p.rebasePresence(t.Context(), f.row.RepositoryID, f.row.ID)
	require.Error(t, err)
	require.Equal(t, services.RebasePresenceUnknown, state)
}

type rebasePresenceBinding struct {
	read func(context.Context, int64, string) (services.RebasePresence, error)
}

func (b *rebasePresenceBinding) SetRebasePresence(read func(context.Context, int64, string) (services.RebasePresence, error)) {
	b.read = read
}
func TestRebasePresenceMissingInstallReaderFailsClosed(t *testing.T) {
	stack := &rebasePresenceBinding{}
	bindRebasePresence(stack, nil)
	state, err := stack.read(t.Context(), 1, "branch")
	require.NoError(t, err)
	require.Equal(t, services.RebasePresenceUnknown, state)
	require.False(t, services.RebaseAtBoundary(true, state))
}
