package compose

import (
	"context"
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
