package compose

import (
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

// The aggregate oracle is literal and independent of the producer suites and
// production guards. Producers report only after their composed HTTP/event
// assertions pass. A removed source, trigger or reporter leaves a missing pair
// and fails here; merely invoking a named test cannot supply coverage.
var todoGuardPairRuns sync.Map

type todoGuardPairRun struct {
	mu    sync.Mutex
	pairs map[string]string
}

func recordTodoGuardPair(t *testing.T, source, trigger, destination string) {
	t.Helper()
	todoGuardPairRuns.Range(func(key, value any) bool {
		if !strings.HasPrefix(t.Name(), key.(string)+"/") {
			return true
		}
		run := value.(*todoGuardPairRun)
		run.mu.Lock()
		defer run.mu.Unlock()
		pair := source + "/" + trigger
		if prior, found := run.pairs[pair]; found {
			require.Equal(t, prior, destination, "inconsistent repeated pair %s", pair)
		} else {
			run.pairs[pair] = destination
		}
		return true
	})
}

func TestTodoTransitionLiteralCases(t *testing.T) {
	if testing.Short() {
		t.Skip("real PostgreSQL, GitHub transport and composed producer doors")
	}
	sources := []string{"draft", "queued", "starting", "working", "needs_you", "paused", "failed", "in_review", "merged", "dropped"}
	// Nonempty means an accepted lifecycle/evidence fact and its observed card
	// state; empty means no lifecycle fact. A recorded held review and late bound
	// terminal evidence retain their state. Command Stop records the request;
	// only the real park changes paused_at. Canonical sources are the pre-input card states. Independent wait/phase
	// cross-products also run but cannot fill an inventory cell.
	rows := []struct {
		trigger string
		to      [10]string
	}{
		{"place", [10]string{"queued", "", "", "", "", "", "", "", "", ""}},
		{"drop", [10]string{"", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "", ""}},
		{"stop", [10]string{"", "", "", "working", "needs_you", "", "", "in_review", "", ""}},
		{"resume", [10]string{"", "", "", "", "", "queued", "", "", "", ""}},
		{"retry", [10]string{"", "", "", "", "", "", "queued", "", "", ""}},
		{"retry-current-flow", [10]string{"", "", "", "", "", "", "queued", "", "", ""}},
		{"steer", [10]string{"", "queued", "starting", "working", "needs_you", "paused", "queued", "working", "", ""}},
		{"run_attached", [10]string{"", "", "working", "working", "needs_you", "paused", "", "in_review", "", ""}},
		{"question", [10]string{"", "", "", "needs_you", "needs_you", "", "", "", "", ""}},
		{"approval", [10]string{"", "", "", "needs_you", "needs_you", "", "", "", "", ""}},
		{"start_failed", [10]string{"", "", "failed", "", "", "", "", "", "", ""}},
		{"run_uncertain", [10]string{"", "", "failed", "failed", "needs_you", "paused", "failed", "in_review", "merged", "dropped"}},
		{"missing_tool", [10]string{"", "", "failed", "failed", "needs_you", "paused", "failed", "failed", "merged", "dropped"}},
		{"resolve", [10]string{"", "", "", "", "working", "", "", "", "", ""}},
		{"park", [10]string{"", "", "working", "paused", "needs_you", "paused", "", "paused", "", ""}},
		{"run_failed", [10]string{"", "", "failed", "failed", "needs_you", "paused", "failed", "in_review", "merged", "dropped"}},
		{"rebased", [10]string{"", "", "starting", "working", "needs_you", "paused", "", "in_review", "", ""}},
		{"edited", [10]string{"", "", "", "", "", "", "", "in_review", "", ""}},
		{"admit", [10]string{"", "starting", "", "", "", "", "", "", "", ""}},
		{"conflict", [10]string{"", "needs_you", "needs_you", "needs_you", "needs_you", "needs_you", "needs_you", "needs_you", "", ""}},
		{"moved_off", [10]string{"", "needs_you", "needs_you", "needs_you", "needs_you", "needs_you", "needs_you", "needs_you", "", ""}},
		{"foreign_push", [10]string{"", "needs_you", "needs_you", "needs_you", "needs_you", "needs_you", "needs_you", "needs_you", "", ""}},
		{"discard", [10]string{"", "", "", "", "working", "", "", "", "", ""}},
		{"propose", [10]string{"", "", "", "in_review", "", "", "", "", "", ""}},
		{"changes_requested", [10]string{"", "queued", "starting", "working", "needs_you", "paused", "failed", "working", "merged", "dropped"}},
		{"review_comment", [10]string{"", "queued", "starting", "working", "needs_you", "paused", "failed", "working", "merged", "dropped"}},
		{"checks_updated", [10]string{"", "", "", "", "", "", "", "in_review", "", ""}},
		{"github_merged", [10]string{"", "merged", "merged", "merged", "merged", "merged", "merged", "merged", "", "merged"}},
		{"github_closed", [10]string{"", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "", ""}},
		{"github_reopened", [10]string{"", "", "", "", "", "", "", "", "", "in_review"}},
		{"rebase-requested", [10]string{"", "", "starting", "working", "needs_you", "", "", "in_review", "", ""}},
		{"bring-in", [10]string{"", "", "", "", "needs_you", "", "", "", "", ""}},
		{"answer-question", [10]string{"", "", "", "", "working", "", "", "", "", ""}},
		{"answer-approval", [10]string{"", "", "", "", "working", "", "", "", "", ""}},
		{"learning_done", [10]string{"", "", "", "", "", "", "", "", "merged", ""}},
	}
	expected := map[string]string{}
	allowed, refused := 0, 0
	for _, row := range rows {
		for i, source := range sources {
			pair := source + "/" + row.trigger
			_, duplicate := expected[pair]
			require.False(t, duplicate)
			expected[pair] = row.to[i]
			if row.to[i] == "" {
				refused++
			} else {
				allowed++
			}
		}
	}
	run := &todoGuardPairRun{pairs: map[string]string{}}
	todoGuardPairRuns.Store(t.Name(), run)
	defer todoGuardPairRuns.Delete(t.Name())
	suites := []struct {
		name string
		run  func(*testing.T)
	}{
		{"draft-producers", TestTodoDraftProducerGuardPairsComposedInstall},
		{"place-draft", TestTodoDraftPlacementLiteralComposedInstall},
		{"place-stored", TestTodoStoredPlacementGuardPairsComposedInstall},
		{"drop-engine-overlays", TestTodoDropEngineTransitionLiteralCases},
		{"commands", TestTodoCommandGuardPairAccountingComposedInstall},
		{"runtime", TestTodoRuntimeGuardPairAccountingComposedInstall},
		{"resolve", TestTodoConflictDoneGuardPairAccountingComposedInstall},
		{"rebased", TestTodoRebasedGuardPairAccountingComposedInstall},
		{"edited", TestCandidateHeadReportComposedInstall},
		{"admission", TestTodoAdmissionSourceTransitionLiteralCases},
		{"conflict", TestTodoRuntimeConflictTransitionLiteralCases},
		{"moved-off", TestTodoMovedOffSourceTransitionLiteralCases},
		{"foreign-push", TestTodoForeignPushSourceTransitionLiteralCases},
		{"discard", TestTodoDiscardSourceTransitionLiteralCases},
		{"discard-canonical", TestTodoDiscardGuardPairAccountingComposedInstall},
		{"answers", TestTodoAnswerGuardPairAccountingComposedInstall},
		{"proposal", TestTodoProposeSourceTransitionLiteralCases},
		{"reviews", TestTodoReviewSourceTransitionLiteralCases},
		{"checks", TestTodoChecksSourceTransitionLiteralCases},
		{"github-terminal", TestTodoGitHubSourceTransitionLiteralCases},
		{"github-reopen", TestTodoReopenSourceTransitionLiteralCases},
		{"rebase-requested", TestTodoRebaseSourceTransitionLiteralCases},
		{"bring-in", TestTodoBringSourceTransitionLiteralCases},
		{"learning", TestTodoLearningSourceGuardPairAccountingComposedInstall},
	}
	for _, suite := range suites {
		t.Run(suite.name, suite.run)
	}
	run.mu.Lock()
	defer run.mu.Unlock()
	for pair, to := range expected {
		actual, found := run.pairs[pair]
		require.True(t, found, "unexecuted pair %s", pair)
		require.Equal(t, to, actual, pair)
	}
	require.Equal(t, expected, run.pairs, "every reported pair has exactly one inventory entry")
	t.Logf("literal complete inventory: %d accepted facts, %d refused/no-fact pairs; 10 sources × %d triggers = %d", allowed, refused, len(rows), len(expected))
}
