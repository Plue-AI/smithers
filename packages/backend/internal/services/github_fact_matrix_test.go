package services

import (
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

// C-GH-13's pull-state matrix is literal contract data, independent of the
// production decision. Review authority/lifecycle matrices live beside their
// normalizer tests; consumers exercise these decisions against PostgreSQL.
func TestGitHubFactCrossConsumerMatrix(t *testing.T) {
	now := time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)
	for _, state := range []struct{ name, close, reopen, push string }{
		{"queued", "dropped", "not_dropped", "foreign_push"},
		{"starting", "dropped", "not_dropped", "foreign_push"},
		{"working", "dropped", "not_dropped", "foreign_push"},
		{"needs_you", "dropped", "not_dropped", "foreign_push"},
		{"in_review", "dropped", "not_dropped", "foreign_push"},
		{"failed", "dropped", "not_dropped", "foreign_push"},
		{"paused", "dropped", "not_dropped", "foreign_push"},
		{"dropped", "already_closed", "in_review", "terminal"},
		{"rejected", "already_closed", "in_review", "terminal"},
		{"cancelled", "already_closed", "in_review", "terminal"},
		{"declined", "dropped", "not_dropped", "terminal"},
		{"merged", "terminal", "terminal", "terminal"},
		{"landed", "terminal", "terminal", "terminal"},
	} {
		t.Run(state.name, func(t *testing.T) {
			item := mythicalGitHubFactItem{State: state.name, Head: "old", PendingHead: "own", ClosedAt: now.Add(-time.Hour)}
			closeWant := mythicalGitHubFactDecision{Noop: state.close}
			if state.close == "dropped" {
				closeWant = mythicalGitHubFactDecision{Event: "dropped"}
			}
			require.Equal(t, closeWant, decideGitHubFact(mythicalGitHubFact{Kind: "closed"}, item, now))
			reopenWant := mythicalGitHubFactDecision{Noop: state.reopen}
			if state.reopen == "in_review" {
				reopenWant = mythicalGitHubFactDecision{Event: "in_review"}
			}
			require.Equal(t, reopenWant, decideGitHubFact(mythicalGitHubFact{Kind: "reopened"}, item, now))
			for _, head := range []struct{ name, value, noop string }{{"absent", "", "unchanged"}, {"duplicate", "old", "unchanged"}, {"own", "own", "own_push"}, {"foreign", "foreign", ""}} {
				t.Run(head.name, func(t *testing.T) {
					want := mythicalGitHubFactDecision{Noop: head.noop}
					if state.push == "terminal" {
						want = mythicalGitHubFactDecision{Noop: "terminal"}
					} else if head.name == "foreign" {
						want = mythicalGitHubFactDecision{Attention: "foreign_push"}
					}
					fact := mythicalGitHubFact{Kind: "push", Head: head.value}
					require.Equal(t, want, decideGitHubFact(fact, item, now))
				})
			}
			for _, onMain := range []bool{false, true} {
				for _, commit := range []string{"", "merged-sha"} {
					want := mythicalGitHubFactDecision{Noop: "merge_not_on_main"}
					if state.name == "merged" || state.name == "landed" {
						want = mythicalGitHubFactDecision{Noop: "already_merged"}
					} else if onMain && commit != "" {
						want = mythicalGitHubFactDecision{Event: "merged"}
					}
					require.Equal(t, want, decideGitHubFact(mythicalGitHubFact{Kind: "merged", OnMain: onMain, MergeCommit: commit}, item, now))
				}
			}
		})
	}
}
