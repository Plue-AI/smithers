package compose

import (
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestForkAddToStackBrowser(t *testing.T) {
	if os.Getenv("SMITHERS_FORK_DROP_BROWSER") != "1" {
		t.Skip("set SMITHERS_FORK_DROP_BROWSER=1")
	}
	t.Setenv("SMITHERS_J10_BROWSER", "1")
	runForkAddToStackBrowser(t, "SMITHERS_J10_BROWSER")
}

// The terminal in C-J7-02 requires the installed microVM's member-session
// contract. The trusted-process rehearsal cannot qualify or replace it.
// Run with SMITHERS_FORK_DROP_MICROVM=1 and SMITHERS_CHECK_BUNDLE on the mini.
func TestForkAddToStackInstalledMicroVMBrowser(t *testing.T) {
	if os.Getenv("SMITHERS_FORK_DROP_MICROVM") != "1" {
		t.Skip("set SMITHERS_FORK_DROP_MICROVM=1 and SMITHERS_CHECK_BUNDLE")
	}
	t.Setenv("SMITHERS_J10_BROWSER", "1")
	t.Setenv(pinnedMicroVMRehearsal, "1")
	runForkAddToStackBrowser(t, pinnedMicroVMRehearsal)
}

func runForkAddToStackBrowser(t *testing.T, enable string) {
	runPreparedGitHubBrowserRuntime(t, enable, "C-J7-02", "../fork-drop-install.spec.ts", "journey-fork-add-to-stack", func(r *rehearsal) {
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
		// The composition ends at delivery (E-19), while the host retains
		// its engine run for review input. Steer that run, not a new attempt.
		var run string
		var attempt int32
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT request_run_id,attempt FROM mythical_items WHERE number=$1`, second).Scan(&run, &attempt))
		require.NotEmpty(t, run)
		_, err = r.expect("POST", fmt.Sprintf("/api/todos/%d", second), `{"steer":"[HOLD fork-source] [FILE source.md] Improve the retry note."}`, 202)
		require.NoError(t, err)
		t.Cleanup(func() { _ = r.release("fork-source"); _ = r.release("fork-third") })
		require.NoError(t, r.waitHeld("fork-source", 6*time.Minute))
		var heldRun string
		var heldAttempt int32
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT request_run_id,attempt FROM mythical_items WHERE number=$1`, second).Scan(&heldRun, &heldAttempt))
		require.Equal(t, run, heldRun)
		require.Equal(t, attempt, heldAttempt)
		_, err = r.expect("PUT", "/api/install", `{"parallel":1}`, 200)
		require.NoError(t, err)
		third, err := r.file("Later work", "[HOLD fork-third] [FILE later.md] Add the later note.")
		require.NoError(t, err)
		require.EqualValues(t, 3, third)
	})
}
