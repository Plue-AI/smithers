package services

import (
	"context"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func TestRebaseAtBoundary(t *testing.T) {
	for _, pending := range []bool{false, true} {
		for _, presence := range []RebasePresence{RebasePresenceUnknown, RebasePresenceEmpty, RebasePresenceAgent, RebasePresencePeople, 255} {
			want := false
			if pending {
				want = map[RebasePresence]bool{0: false, 1: true, 2: true, 3: false, 255: false}[presence]
			}
			require.Equal(t, want, RebaseAtBoundary(pending, presence))
		}
	}
}

func TestRebaseMissingExecutionRefusesBeforeEffects(t *testing.T) {
	// Nil service, bridge and git executor deliberately detect any use of the
	// legacy host path. Ten passes keep the original candidate and budget.
	st := mythicalItemStep{r: &mythicalRun{}}
	item := db.MythicalItem{CandidateBase: "old", CandidateHead: "candidate", State: "integrating"}
	for i := 0; i < 10; i++ {
		next, launched, err := st.integrate(context.Background(), item)
		var api *pkgerrors.APIError
		require.ErrorAs(t, err, &api)
		require.Equal(t, pkgerrors.CodeServiceUnavailable, api.Code)
		require.Nil(t, next)
		require.False(t, launched)
		require.Equal(t, "candidate", item.CandidateHead)
		require.Equal(t, "integrating", item.State)
	}
}
