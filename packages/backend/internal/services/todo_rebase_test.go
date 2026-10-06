package services

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
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

func TestRebaseWaitsForAnEarlierRebaseBeforeEffects(t *testing.T) {
	// Nil service, bridge and git executor detect any fetch, pin or launch:
	// a later item waits for an earlier item's rebase without effects, so it
	// rebases once, onto that item's next verified head.
	id := func(n byte) pgtype.UUID { return pgtype.UUID{Bytes: [16]byte{n}, Valid: true} }
	first := db.MythicalItem{ID: id(1), Number: pgtype.Int8{Int64: 1, Valid: true}, State: "verifying", CandidateBase: "new-main",
		CandidateHead: "one-rebased", Checks: mythicalChecks{Rebase: &mythicalRebase{Onto: "new-main", Name: "main", Rebased: true}}.encode()}
	second := db.MythicalItem{ID: id(2), Number: pgtype.Int8{Int64: 2, Valid: true}, State: "integrating", CandidateBase: "one",
		CandidateHead: "two", Generation: 4, Reason: "rebase_pending"}
	st := mythicalItemStep{r: &mythicalRun{mainTip: "new-main"}, items: []db.MythicalItem{first, second}, now: time.Unix(100, 0).UTC()}
	next, launched, err := st.integrate(context.Background(), second)
	require.NoError(t, err)
	require.False(t, launched)
	require.NotNil(t, next)
	rebase := mythicalChecksOf(*next).Rebase
	require.NotNil(t, rebase)
	require.Equal(t, mythicalRebase{Onto: "new-main", Name: "T1", Since: time.Unix(100, 0).UTC()}, *rebase)
	require.Equal(t, "rebase_pending", next.Reason)
	require.Equal(t, "two", next.CandidateHead, "the candidate is untouched until it is rebased")
	require.Equal(t, int64(4), next.Generation)
	// An item holding a lane never waits: its machine never idles against
	// the cap the earlier rebase may need.
	held := second
	held.WorkspaceID = "lane"
	require.Nil(t, st.rebaseWaits(held))
	st.items[1] = *next
	st.now = time.Unix(200, 0).UTC()
	again, launched, err := st.integrate(context.Background(), *next)
	require.NoError(t, err)
	require.False(t, launched)
	require.Nil(t, again, "a pass while it still waits saves nothing")
	// A failed or retrying earlier item never holds the items after it.
	for _, state := range []string{"blocked", "retrying", "proposed"} {
		st.items[0].State = state
		require.Nil(t, st.rebaseWaits(second), state)
	}
	st.items[0].State, st.items[0].CandidateVerified = "verifying", true
	require.Nil(t, st.rebaseWaits(second), "a verified earlier item is part of the prefix")
}

func TestInvalidatePrefixVoidsTheApproval(t *testing.T) {
	id := func(n byte) pgtype.UUID { return pgtype.UUID{Bytes: [16]byte{n}, Valid: true} }
	first := db.MythicalItem{ID: id(1), Number: pgtype.Int8{Int64: 1, Valid: true}, State: "proposed", CandidateBase: "main",
		CandidateHead: "one", CandidateVerified: true}
	land := &mythicalLand{By: "owner", Head: "pr-head", Session: "s"}
	second := db.MythicalItem{ID: id(2), Number: pgtype.Int8{Int64: 2, Valid: true}, State: "proposed", CandidateBase: "main",
		CandidateHead: "two", CandidateVerified: true, PRHead: "pr-head", PRNumber: pgtype.Int8{Int64: 9, Valid: true}, PRState: "open",
		Checks: mythicalChecks{Land: land}.encode()}
	st := mythicalItemStep{r: &mythicalRun{mainTip: "main"}, items: []db.MythicalItem{first, second}, now: time.Unix(5, 0).UTC()}
	next := st.invalidatePrefix(second)
	checks := mythicalChecksOf(*next)
	require.Nil(t, checks.Land, "the new generation voids the approval of the old head")
	require.Equal(t, "pr-head", checks.ApprovalCleared)
	require.Equal(t, &mythicalRebase{Onto: "one", Name: "T1", Since: time.Unix(5, 0).UTC()}, checks.Rebase)
	require.Equal(t, "integrating", next.State)
	require.False(t, next.CandidateVerified)
	require.Equal(t, "pr-head", next.PRHead, "the last published head stays until the new one is pushed")
	require.True(t, mythicalRebuilding(*next))
	require.Equal(t, "in_review", todoState(*next), "the pull request stays in review while it rebuilds")
	// Rebuilding keeps it in review only with its pull request open.
	unpublished := *next
	unpublished.PRNumber, unpublished.PRState = pgtype.Int8{}, ""
	require.Equal(t, "working", todoState(unpublished))
	// The merge waits on order first, then on the rebased change's checks.
	var refusal *TodoControlError
	require.ErrorAs(t, mythicalMergeReady(withTodo(*next), 1, "pr-head", false), &refusal)
	require.Equal(t, "order", refusal.Code)
	require.ErrorAs(t, mythicalMergeReady(withTodo(*next), 0, "pr-head", false), &refusal)
	require.Equal(t, "rechecking", refusal.Code)
	// Proposing the rebuilt generation ends the rebase.
	proposed := st.proposedFrom(*next, mythicalPull{Number: 9, State: "open"}, &mythicalPRShape{})
	require.Nil(t, mythicalChecksOf(*proposed).Rebase)
	require.Equal(t, "pr-head", mythicalChecksOf(*proposed).ApprovalCleared, "the card says the approval was cleared until another press")
}

func withTodo(item db.MythicalItem) db.MythicalItem {
	checks := mythicalChecksOf(item)
	checks.Todo = true
	item.Checks = checks.encode()
	return item
}

func TestRebuiltTodoStaysInReviewThroughMetadataSettlement(t *testing.T) {
	// Unit-test publication's projection: guards are accepted here, while nil
	// transports prove scheduling metadata never sends a GitHub write itself.
	for _, rebasing := range []bool{false, true} {
		t.Run(fmt.Sprint(rebasing), func(t *testing.T) {
			guardCalls := 0
			guard := func(context.Context, db.MythicalItem, string) error { guardCalls++; return nil }
			s := &MythicalService{outbound: MythicalOutboundProviders{CanonicalApp: guard, StackLease: guard, Budget: guard,
				Membership: guard, Authorization: guard, AcceptedGeneration: guard}}
			shape := &mythicalPRShape{Branch: "smithers/example", Title: "Example", Prompt: "Example", Acceptance: "Works",
				Evidence: "Checks passed", DiffStat: "1 file changed", Review: "Reviewed", URL: "http://localhost/todos/1", Owner: "ben", First: true, DraftsAvailable: true}
			_, body, err := shape.render()
			require.NoError(t, err)
			first := false
			checks := mythicalChecks{Todo: true, PRFirst: &first, PRBody: "old-body", ApprovalCleared: "old-head"}
			if rebasing {
				checks.Rebase = &mythicalRebase{Onto: "new-main", Name: "main", Rebased: true}
			}
			item := db.MythicalItem{State: "proposing", CandidateVerified: true, PRNumber: pgtype.Int8{Int64: 9, Valid: true},
				PRHead: "new-head", PRState: "open", Checks: checks.encode()}
			pull := mythicalPull{Number: 9, State: "open", HeadSHA: "new-head", Draft: true}
			step := &mythicalItemStep{s: s, prShape: shape}
			for _, kind := range []string{"body", "draft"} {
				next, err := step.bindPull(t.Context(), item, mythicalGitHubRepo{}, shape.Branch, pull)
				require.NoError(t, err)
				op, err := decodeMythicalOutbound(next.PendingOp)
				require.NoError(t, err)
				require.Equal(t, kind, op.Kind)
				require.Equal(t, "proposing", next.State)
				require.Equal(t, checks.Rebase, mythicalChecksOf(*next).Rebase)
				want := "working"
				if rebasing {
					want = "in_review"
				}
				require.Equal(t, want, todoState(*next))
				require.Error(t, mythicalMergeReady(*next, 0, "new-head", false), "metadata publication must settle before merge")
				// Feed the next confirmed provider observation to the binding;
				// outbound delivery/recovery has its own real-provider tests.
				item = *next
				item.PendingOp = nil
				if kind == "body" {
					settled := mythicalChecksOf(item)
					settled.PRBody = mythicalBodyDigest(body)
					item.Checks = settled.encode()
				} else {
					pull.Draft = false
				}
			}
			next, err := step.bindPull(t.Context(), item, mythicalGitHubRepo{}, shape.Branch, pull)
			require.NoError(t, err)
			require.Equal(t, "proposed", next.State)
			require.Empty(t, next.PendingOp)
			require.Nil(t, mythicalChecksOf(*next).Rebase)
			require.Equal(t, "old-head", mythicalChecksOf(*next).ApprovalCleared)
			require.Equal(t, "in_review", todoState(*next))
			require.Equal(t, 12, guardCalls)
		})
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

func TestRetainedConflictPollDoesNotDispatch(t *testing.T) {
	// No service or repository providers: any dispatch would panic.
	st := mythicalItemStep{}
	item := db.MythicalItem{State: "integrating", CandidateHead: "retained", Reason: "rebase_conflict_pending"}
	for range 10 {
		next, launched, err := st.integrate(context.Background(), item)
		require.NoError(t, err)
		require.Nil(t, next)
		require.False(t, launched)
	}
}

func TestRebasePresenceRefusesBeforeRepositoryEffects(t *testing.T) {
	for _, name := range []string{"missing provider", "missing workspace", "unknown", "people", "invalid", "error"} {
		t.Run(name, func(t *testing.T) {
			service := &MythicalService{}
			read := func(context.Context, int64, string) (RebasePresence, error) {
				switch name {
				case "missing workspace":
					t.Fatal("must not query an unbound workspace")
				case "people":
					return RebasePresencePeople, nil
				case "invalid":
					return 255, nil
				case "error":
					return RebasePresenceEmpty, errors.New("host unavailable")
				}
				return RebasePresenceUnknown, nil
			}
			if name == "missing provider" {
				read = nil
			}
			service.SetRebasePresence(read)
			item := db.MythicalItem{State: "integrating", CandidateBase: "old-main", CandidateHead: "retained", WorkspaceID: "branch", Generation: 4}
			if name == "missing workspace" {
				item.WorkspaceID = ""
			}
			st := mythicalItemStep{s: service, r: &mythicalRun{mainTip: "new-main"}, items: []db.MythicalItem{item}, now: time.Unix(10, 0).UTC()}
			next, launched, err := st.integrate(context.Background(), item)
			require.NoError(t, err)
			require.False(t, launched)
			require.NotNil(t, next)
			require.Equal(t, "rebase_pending", next.Reason)
			require.Equal(t, "retained", next.CandidateHead)
			require.Equal(t, int64(4), next.Generation)
		})
	}
}
