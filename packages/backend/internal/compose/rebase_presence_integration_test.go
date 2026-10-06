package compose

import (
	"fmt"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// The same authenticated host reached by a browser presence frame informs
// rebase scheduling. Its incomplete source census must not look agent-alone.
func TestRebasePresenceComposedBrowserFailsClosed(t *testing.T) {
	f := presenceInstall(t)
	state, err := f.p.rebasePresence(t.Context(), f.row.RepositoryID, f.row.ID)
	require.NoError(t, err)
	require.Equal(t, services.RebasePresenceUnknown, state)
	conn := f.dial(t)
	sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"presence","id":1,"where":{"branch":%q,"path":"retry.ts","line":12}}`, f.row.ID))
	require.Eventually(t, func() bool { return len(f.roster(t)) == 1 }, time.Second, 10*time.Millisecond)
	state, err = f.p.rebasePresence(t.Context(), f.row.RepositoryID, f.row.ID)
	require.NoError(t, err)
	require.False(t, services.RebaseAtBoundary(true, state))
	state, err = f.p.rebasePresence(t.Context(), f.row.RepositoryID+1, f.row.ID)
	require.NoError(t, err)
	require.Equal(t, services.RebasePresenceUnknown, state)
}
