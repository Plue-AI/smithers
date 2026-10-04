package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

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

func TestCandidateAvailablePrefix(t *testing.T) {
	id := func(n byte) pgtype.UUID { return pgtype.UUID{Bytes: [16]byte{n}, Valid: true} }
	first := db.MythicalItem{ID: id(1), State: "proposed", CandidateBase: "main", CandidateHead: "one", CandidateVerified: true}
	second := db.MythicalItem{ID: id(2), State: "running", CandidateBase: "one", CandidateHead: "two"}
	third := db.MythicalItem{ID: id(3), State: "queued"}
	st := mythicalItemStep{r: &mythicalRun{mainTip: "main"}, items: []db.MythicalItem{first, second, third}}
	require.Equal(t, "main", st.prefix(first))
	require.Equal(t, "one", st.prefix(third))
	st.items[1].CandidateVerified = true
	require.Equal(t, "two", st.prefix(third))
	st.items[0].State = "landed"
	require.Equal(t, "main", st.prefix(third), "a stale earlier candidate cannot contribute after its base disappears")
	st.items[0] = first
	st.r.mainTip = "new-main"
	require.Equal(t, "new-main", st.prefix(third))
	st.items = []db.MythicalItem{third, first}
	require.Equal(t, "new-main", st.prefix(third), "later verified items are outside this prefix")
}

func TestCandidateChangedPrefixRefusesBeforePublication(t *testing.T) {
	// Nil service/GitHub prove the stale base is rejected before any provider
	// is read. The same candidate bytes still need fresh checks on a new base.
	st := mythicalItemStep{r: &mythicalRun{mainTip: "new-main"}}
	item := db.MythicalItem{CandidateBase: "old-main", CandidateHead: "same-tree", CandidateVerified: true,
		State: "proposing", Generation: 7, PRHead: "last-published"}
	next, err := st.propose(context.Background(), item)
	require.NoError(t, err)
	require.True(t, next.CandidateVerified, "unavailable publication authority refuses before candidate mutation")
	require.Equal(t, "proposing", next.State)
	next = st.invalidatePrefix(item)
	require.False(t, next.CandidateVerified)
	require.Equal(t, "rebase_pending", next.Reason)
	require.Equal(t, "integrating", next.State)
	require.Equal(t, "same-tree", next.CandidateHead)
	require.Equal(t, "last-published", next.PRHead)
	require.Equal(t, int64(7), next.Generation, "only a new capture allocates a generation")
	item.State, item.VerifyOutcome = "verifying", "passed"
	next, launched, err := st.advance(context.Background(), item)
	require.NoError(t, err)
	require.False(t, launched)
	require.False(t, next.CandidateVerified)
	require.Equal(t, "rebase_pending", next.Reason)
	item.CandidateBase = "new-main"
	next, launched, err = st.advance(context.Background(), item)
	require.NoError(t, err)
	require.False(t, launched)
	require.True(t, next.CandidateVerified)
	require.Equal(t, "proposing", next.State)
}
