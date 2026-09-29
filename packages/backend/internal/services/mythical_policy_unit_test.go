package services

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestMythicalPolicy_AdmissionPrecedence(t *testing.T) {
	t.Parallel()
	// A maintainer approval admits only an open issue without a skip label;
	// it never overrides a pull request, closure, or explicit skip category.
	for _, approved := range []bool{false, true} {
		for _, labels := range [][]string{nil, {"todo"}, {"bug", "question"}} {
			for _, tc := range []struct {
				name, state, wantState, reason string
				pull                           bool
			}{
				{"open pull", "open", "skipped", "pull requests are reviewed, not implemented", true},
				{"closed pull", "closed", "skipped", "pull requests are reviewed, not implemented", true},
				{"closed issue", "closed", "cancelled", "the issue is closed", false},
				{"unknown issue state", "", "cancelled", "the issue is closed", false},
			} {
				t.Run(fmt.Sprintf("%s/approved=%t/labels=%v", tc.name, approved, labels), func(t *testing.T) {
					state, reason := mythicalAdmission(mythicalIssue{State: tc.state, Labels: labels, PullRequest: tc.pull}, approved)
					require.Equal(t, tc.wantState, state)
					require.Equal(t, tc.reason, reason)
				})
			}
		}
	}
}

func TestMythicalPolicy_OpenIssueAdmission(t *testing.T) {
	t.Parallel()
	for _, label := range []string{"question", "duplicate", "invalid", "wontfix", "epic", "umbrella", "tracking"} {
		for _, approved := range []bool{false, true} {
			labels := []string{"bug", " \t" + strings.ToUpper(label) + "\n", "todo"}
			original := slices.Clone(labels)
			state, reason := mythicalAdmission(mythicalIssue{State: "OPEN", Labels: labels}, approved)
			require.Equal(t, "skipped", state, "label=%s approved=%t", label, approved)
			require.Equal(t, "labeled "+label, reason)
			require.Equal(t, original, labels)
		}
	}
	for _, tc := range []struct {
		name, state, reason string
		labels              []string
		approved            bool
	}{
		{"unapproved", "skipped", "waiting for a maintainer to add the todo label", nil, false},
		{"approval belongs to older text", "skipped", "a maintainer re-applies the todo label to approve this text", []string{" ToDo "}, false},
		{"unrelated label", "skipped", "waiting for a maintainer to add the todo label", []string{"todo-extra"}, false},
		{"approved maintainer text", "queued", "", nil, true},
		{"approved labeled text", "queued", "", []string{"todo", "bug"}, true},
		{"similarly named labels do not skip", "queued", "", []string{"questions", "tracking-extra"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state, reason := mythicalAdmission(mythicalIssue{State: "oPeN", Labels: tc.labels}, tc.approved)
			require.Equal(t, tc.state, state)
			require.Equal(t, tc.reason, reason)
		})
	}
}

func TestMythicalPolicy_RetryAndTransientDelayPreserveItem(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 12, 31, 23, 59, 50, 123456789, time.FixedZone("test", -7*3600))
	for _, attempt := range []int32{0, 1, 2, 3, 4, math.MaxInt32} {
		item := db.MythicalItem{
			RepositoryID: 71, IssueNumber: pgtype.Int8{Int64: 19, Valid: true},
			IssueTitle: "Preserve the requested work", IssueBody: "exact body", IssueDigest: "digest",
			ApprovedDigest: "approved", State: "verifying", Reason: "previous failure", Attempt: attempt,
			Outsider: true, Source: "chat", Version: 12, Generation: 3, ProposalRound: 2,
			WorkspaceID: "owned-workspace", Lane: pgtype.Int4{Int32: 2, Valid: true},
			BaseCommit: "base", CandidateBase: "candidate-base", CandidateHead: "candidate-head", CandidateVerified: true,
			RequestRunID: "request-run", VibeRunID: "delivery-run", VerifyRunID: "verification-run",
			Summary: "Recorded work", PRNumber: pgtype.Int8{Int64: 44, Valid: true}, PRURL: "https://example.test/pull/44",
			NextAttemptAt: pgtype.Timestamptz{Time: now.Add(-time.Minute), Valid: true},
		}
		before := item
		want := item
		want.Reason = "new failure"
		if attempt < 3 {
			want.State = "retrying"
			want.NextAttemptAt = pgtype.Timestamptz{Time: now.Add(30 * time.Second), Valid: true}
		} else {
			want.State, want.Reason = "blocked", "very hard: new failure"
		}
		got := mythicalRetry(item, "new failure", now)
		require.Equal(t, &want, got, "attempt %d", attempt)
		require.Equal(t, before, item)
		got.Reason = "caller changes returned value"
		require.Equal(t, before, item)

		want = item
		want.Reason = "GitHub is temporarily unavailable"
		want.NextAttemptAt = pgtype.Timestamptz{Time: now.Add(time.Minute), Valid: true}
		require.Equal(t, &want, mythicalLater(item, want.Reason, now), "attempt %d", attempt)
		require.Equal(t, before, item)
	}
}
