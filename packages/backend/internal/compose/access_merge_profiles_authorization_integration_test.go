package compose

import (
	"testing"
)

// Reuse the production merge/reconciliation campaign: the source CLI requests
// private confirmation, a fresh requester session admits the merge, a lost
// GitHub response is reconciled, and exactly one squash send is observed.
func TestAccessMergeProfilesComposedPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("composed merge matrix requires PostgreSQL and native helpers")
	}
	for _, role := range []string{"owner", "maintainer"} {
		for _, via := range []string{"cli", "codex", "claude-code", "smithers"} {
			for _, subject := range []string{"own", "other-member"} {
				t.Run(role+"/"+via+"/"+subject, func(t *testing.T) {
					testTodoMergeProfileComposedRouteBoundaryPostgres(t, true, false, false, accessMergeProfile{via: via, role: role, subject: subject})
				})
			}
		}
	}
}
