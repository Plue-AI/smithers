package services

import "testing"

// Reuse the existing real-Git/PostgreSQL engine harness rather than another
// candidate implementation. The compose package covers HTTP publisher authority.
// These host contracts do not replace read-only guest/microVM qualification.
func TestTodoCandidateReviewBoundary(t *testing.T) {
	t.Setenv("SMITHERS_TEST_DATABASE_NAMESPACE", "fr6review")
	t.Run("rebased paths and measured receipts", TestMythicalVerifyChecksTheRebasedPathsAndRecordsItsReceipts)
	t.Run("equal tree new base requires fresh verification", TestTodoRebaseEqualTreeNewBaseRequiresFreshVerification)
	t.Run("unverified or different tree cannot publish", TestCandidatePublicationReplayRefusesUnverifiedOrDifferentTrees)
	t.Run("retained plan cannot validate another candidate", TestTodoRetainedPlanCannotValidateNewCandidate)
	t.Run("literal first line verdict", TestMythicalReviewVerdict)
}
