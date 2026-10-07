package services

import (
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestLearningEvidenceFailuresRetainDistinctPatterns(t *testing.T) {
	checks := mythicalChecks{Attempts: []todoAttemptEvidence{{Attempt: 1, Items: []map[string]any{
		{"kind": "check", "name": " LINT ", "state": "failed", "tier": "slow", "evidence": "Run lint before review."},
		{"kind": "check", "name": "lint", "state": "failed", "tier": "slow", "evidence": "Repeated failure."},
		{"kind": "check", "name": "build", "state": "failed", "fault": "infra"},
		{"kind": "check", "name": "unit", "state": "passed"},
	}, Previous: &todoRevisionEvidence{Items: []map[string]any{{"kind": "check", "name": "typecheck", "state": "failed", "tier": "fast"}}}}}}
	require.Equal(t, []LearningFailure{{"check:lint@review", "Run lint before review."}, {"check:typecheck@check", "Check typecheck failed."}}, learningFailures(checks))
	require.Equal(t, "lint test", learningNormalize("  ＬＩＮＴ\n\t Test  "))
	require.Equal(t, "li\u0307nt σος", learningNormalize("\uFEFF ＬİＮＴ  ΣΟΣ "))
	require.Equal(t, "\u0085 lint \u0085", learningNormalize(" \u0085 LINT \u0085 "))
	require.Empty(t, learningFailures(mythicalChecks{GitHubInputs: []todoGitHubInput{{Text: "Hidden review", ReviewState: "CHANGES_REQUESTED", Hidden: true}, {Text: "Approved", ReviewState: "APPROVED"}}}))
}

func TestLearningEvidenceRetainsCorrectedFailureWithinAttempt(t *testing.T) {
	checks := mythicalChecks{Receipts: &mythicalReceipts{Run: "attempt-1", Checks: []mythicalReceipt{{Check: "lint", Tier: "slow", Status: "failed", Commit: "candidate", Evidence: "Run lint before review."}}}}
	item := db.MythicalItem{Source: "todo", State: "running", Number: pgtype.Int8{Int64: 7, Valid: true}, Attempt: 1, RequestRunID: "attempt-1", CandidateHead: "candidate", Checks: checks.encode()}
	item = retainTodoAttemptEvidence(item)
	checks = mythicalChecksOf(item)
	checks.Receipts.Checks[0].Status = "passed"
	checks.Receipts.Checks[0].Evidence = "Corrected"
	item.Checks = checks.encode()
	item = retainTodoAttemptEvidence(item)
	require.Equal(t, []LearningFailure{{Signature: "check:lint@review", Text: "Run lint before review."}}, learningFailures(mythicalChecksOf(item)))
	require.Equal(t, []map[string]any{{"kind": "check", "name": "lint", "state": "passed"}}, currentTodoEvidence(item).Items)
}
