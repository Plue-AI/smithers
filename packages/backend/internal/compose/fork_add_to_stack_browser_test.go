package compose

import (
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestForkAddToStackBrowser(t *testing.T) {
	if os.Getenv("SMITHERS_FORK_DROP_BROWSER") != "1" {
		t.Skip("set SMITHERS_FORK_DROP_BROWSER=1")
	}
	t.Setenv("SMITHERS_J10_BROWSER", "1")
	runPreparedGitHubBrowser(t, "C-J7-02", "../fork-drop-install.spec.ts", "journey-fork-add-to-stack", func(r *rehearsal) {
		_, err := r.expect("PUT", "/api/install", `{"parallel":2}`, 200)
		require.NoError(t, err)
		first, err := r.file("Prefix", "[PR] [FILE prefix.md] Add the prefix note.")
		require.NoError(t, err)
		require.EqualValues(t, 1, first)
		_, err = r.waitTodoWithin(first, 6*time.Minute, "in_review")
		require.NoError(t, err)
		second, err := r.file("Retry webhooks", "[PR] [FILE source.md] Add the source retry note.")
		require.NoError(t, err)
		require.EqualValues(t, 2, second)
		_, err = r.waitTodoWithin(second, 6*time.Minute, "in_review")
		require.NoError(t, err)
		// Exercise reopening a completed review run. The separate live Drop
		// rehearsal cancels an in-flight composition.
		require.EventuallyWithT(t, func(c *assert.CollectT) {
			var outcome string
			require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT request_outcome FROM mythical_items WHERE number=$1`, second).Scan(&outcome))
			require.Equal(c, "completed", outcome)
		}, time.Minute, 100*time.Millisecond)
		_, err = r.expect("POST", fmt.Sprintf("/api/todos/%d", second), `{"steer":"[HOLD fork-source] [FILE source.md] Improve the retry note."}`, 202)
		require.NoError(t, err)
		t.Cleanup(func() { _ = r.release("fork-source"); _ = r.release("fork-third") })
		require.NoError(t, r.waitHeld("fork-source", 6*time.Minute))
		_, err = r.expect("PUT", "/api/install", `{"parallel":1}`, 200)
		require.NoError(t, err)
		third, err := r.file("Later work", "[HOLD fork-third] [FILE later.md] Add the later note.")
		require.NoError(t, err)
		require.EqualValues(t, 3, third)
	})
}
