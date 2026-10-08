package services

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

func TestForeignBringReleasedUsesStackWorkerAndSamePR(t *testing.T) { testForeignBring(t, false) }
func TestForeignBringConflictRetainsHeadAndBudget(t *testing.T)     { testForeignBring(t, true) }

func testForeignBring(t *testing.T, conflicting bool) {
	f := newRebaseFixture(t)
	item := f.candidate("Bring", f.main, "OWN.md", "own\n")
	f.wake()
	item = f.item(item.Number.Int64)
	branch := mythicalChecksOf(item).Branch
	files := map[string]string{"alice.md": "alice bytes\n"}
	if conflicting {
		files["OWN.md"] = "Alice replaces this line\n"
	}
	foreign, err := f.fake.PushAs("rehearsal-owner/app", branch, 202, "alice", "Alice's addition", files)
	require.NoError(t, err)
	// Inbound sync's retained objects and wait are tested independently by the
	// real sync suites. This test starts at that durable production boundary.
	f.git(f.work, "fetch", "-q", f.github, foreign)
	f.git(f.work, "push", "-q", f.hostDir, foreign+":"+repohost.KeptCommitRefPrefix+foreign)
	checks := mythicalChecksOf(item)
	checks.ForeignHead = foreign
	checks.Waits = append(checks.Waits, TodoWait{ID: "foreign-wait", Kind: "foreign_push", SHA: foreign, Since: time.Now().UTC(), By: json.RawMessage(`{"kind":"github","login":"alice"}`)})
	retained, err := db.New(f.pool).CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, TargetBookmark: branch, Status: "stopped"})
	require.NoError(t, err)
	_, _, err = db.New(f.pool).BindMythicalLane(t.Context(), db.MythicalLane{WorkspaceID: retained.ID, RepositoryID: f.repoID, ItemID: item.ID, Name: "TODO 1 coding"})
	require.NoError(t, err)
	item.WorkspaceID = ""
	item.Checks = checks.encode()
	item, err = db.New(f.pool).SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	f.service.SetOrchestration(f.service.github, f.launcher, &fakeMythicalLanes{})
	owner, err := db.New(f.pool).GetUserByID(t.Context(), f.userID)
	require.NoError(t, err)
	session := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &owner, SessionHash: "owner-session"})
	input := TodoControlInput{Op: "bring-in", Repository: f.repoID, Actor: f.userID, Request: "bring-press", Wait: "foreign-wait", Revision: foreign}
	_, err = f.pool.Exec(t.Context(), `CREATE FUNCTION refuse_bring_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='todo.foreign_bring-in' THEN RAISE EXCEPTION 'injected bring fact failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_bring_fact BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION refuse_bring_fact()`)
	require.NoError(t, err)
	_, err = f.service.AnswerBranch(session, branch, input)
	require.ErrorContains(t, err, "injected bring fact failure")
	require.Nil(t, mythicalChecksOf(f.item(item.Number.Int64)).ForeignBring)
	_, err = f.pool.Exec(t.Context(), `DROP TRIGGER refuse_bring_fact ON product_job_events; DROP FUNCTION refuse_bring_fact()`)
	require.NoError(t, err)
	receipt, err := f.service.AnswerBranch(session, branch, input)
	require.NoError(t, err)
	replay, err := f.service.AnswerBranch(session, branch, input)
	require.NoError(t, err)
	require.Equal(t, receipt, replay)
	require.Equal(t, item.CandidateHead, f.item(item.Number.Int64).CandidateHead, "HTTP admission does not execute Git work")
	admitted := f.item(item.Number.Int64)
	for _, field := range []string{"head", "generation", "onto", "sha", "occupied"} {
		t.Run(field, func(t *testing.T) {
			changed := admitted
			binding := mythicalChecksOf(changed)
			switch field {
			case "head":
				changed.CandidateHead = "changed"
			case "generation":
				changed.Generation++
			case "onto":
				binding.ForeignBring.Onto = "changed"
			case "sha":
				binding.ForeignBring.SHA = "changed"
			case "occupied":
				changed.WorkspaceID = "occupied"
			}
			changed.Checks = binding.encode()
			step := mythicalItemStep{s: f.service, r: &mythicalRun{mainTip: f.main}, items: []db.MythicalItem{changed}}
			next, saved, err := step.consumeForeignBring(t.Context(), changed)
			require.NoError(t, err)
			require.Nil(t, next)
			require.False(t, saved, "refuse before any Git effect")
		})
	}
	_, err = f.pool.Exec(t.Context(), `UPDATE auth_sessions SET expires_at=NOW()-interval '1 hour' WHERE session_key='owner-session'`)
	require.NoError(t, err)
	f.wake()
	require.Equal(t, item.CandidateHead, f.item(item.Number.Int64).CandidateHead)
	require.Zero(t, f.verifies(item))
	_, err = f.pool.Exec(t.Context(), `UPDATE auth_sessions SET expires_at=NOW()+interval '1 hour' WHERE session_key='owner-session'`)
	require.NoError(t, err)
	f.wake()
	verified := f.item(item.Number.Int64)
	if conflicting {
		require.Equal(t, "rebase_conflict_pending", verified.Reason)
		require.Equal(t, item.CandidateHead, verified.CandidateHead)
		require.Contains(t, string(verified.Integration), "OWN.md")
		require.Contains(t, string(verified.Integration), foreign)
		reservation := mythicalChecksOf(verified).ConflictReservation
		require.NotNil(t, reservation)
		for range 3 {
			f.wake()
		}
		require.Equal(t, item.Attempt, f.item(item.Number.Int64).Attempt)
		require.Equal(t, reservation, mythicalChecksOf(f.item(item.Number.Int64)).ConflictReservation)
		require.Zero(t, f.verifies(item))
		input.Request = "another-press"
		_, err := f.service.AnswerBranch(session, branch, input)
		var refusal *TodoControlError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, "rebase_conflict_pending", refusal.Code)
		return
	}
	require.Equal(t, "verifying", verified.State, verified.Reason)
	require.Equal(t, item.Attempt, verified.Attempt)
	require.Equal(t, item.Generation+1, verified.Generation)
	require.Equal(t, f.main, verified.CandidateBase)
	require.Empty(t, mythicalChecksOf(verified).ForeignHead)
	require.Empty(t, todoOpenWaits(verified))
	require.Equal(t, "alice bytes", f.git(f.hostDir, "show", verified.CandidateHead+":alice.md"))
	require.Equal(t, "own", f.git(f.hostDir, "show", verified.CandidateHead+":OWN.md"))
	require.Equal(t, foreign, verified.PRHead, "publication leases against the accepted foreign push")
	f.verify(verified)
	for range 4 {
		f.wake()
		if f.item(item.Number.Int64).State == "proposed" {
			break
		}
	}
	published := f.item(item.Number.Int64)
	require.Equal(t, "proposed", published.State, published.Reason)
	require.Equal(t, item.PRNumber, published.PRNumber)
	require.Equal(t, published.PRHead, f.githubRef(branch))
	require.Equal(t, "alice bytes", f.git(f.github, "show", published.PRHead+":alice.md"))
	require.Equal(t, 1, f.verifies(published))
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_brought-in'`).Scan(&count))
	require.Equal(t, 1, count)
	replay, err = f.service.AnswerBranch(session, branch, input)
	require.NoError(t, err)
	require.Equal(t, receipt, replay)
}
