package compose

import "testing"

// Candidate admission is tested at the installed HTTP boundary with PostgreSQL
// and real Git objects. The existing fixtures substitute guest lifecycle only;
// they do not qualify microVM isolation or model tool execution.
func TestTodoCandidateReviewBoundary(t *testing.T) {
	t.Setenv("SMITHERS_TEST_DATABASE_NAMESPACE", "fr6cand")
	t.Run("current publisher authority and immutable candidate", TestInstallCandidateAuthorizationPostgres)
	t.Run("candidate report binding", TestCandidateHeadReportComposedInstall)
	t.Run("protected publication policy", TestCandidateProtectedPolicyComposedInstall)
}
