package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestCapturedContinuationHoldsOtherWork(t *testing.T) {
	for _, name := range []string{"ready", "stale", "wake conflict", "wake awaits capture", "paused", "unsettled publication", "foreign push", "unreconciled prefix", "verify still running", "review still running", "held text", "delivered text", "reopened"} {
		t.Run(name, func(t *testing.T) {
			main := strings.Repeat("b", 40)
			item := db.MythicalItem{WorkspaceID: "10000000-0000-4000-8000-000000000001", CandidateBase: main, Source: "todo", State: "proposed", Attempt: 2, FlowDigest: pgtype.Text{String: strings.Repeat("a", 64), Valid: true}}
			checks := mythicalChecks{FlowSource: strings.Repeat("b", 40), Capture: &MachineCapturePending{Head: strings.Repeat("c", 40)}}
			switch name {
			case "stale":
				checks.Capture.Stale = true
			case "wake conflict":
				checks.Capture.Conflict = true
			case "wake awaits capture":
				checks.Capture.ReconciledOnto = main
			case "paused":
				item.PausedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
			case "unsettled publication":
				item.PendingOp = []byte(`{"kind":"push"}`)
			case "foreign push":
				checks.ForeignHead = "foreign"
			case "unreconciled prefix":
				checks.Rebase = &mythicalRebase{Onto: "new-prefix"}
			case "verify still running":
				item.State = "verifying"
			case "review still running":
				checks.Review = &mythicalReview{Head: "reviewing"}
			case "held text", "delivered text":
				checks.Steers = []todoSteer{{Attempt: 2, Text: "do this first", ReleasePending: name == "held text"}}
			case "reopened":
				checks.GitHubReopenedAttempt = 2
			}
			item.Checks = checks.encode()
			// No providers: refusal occurs before object transport or launch.
			step := &mythicalItemStep{s: &MythicalService{}, r: &mythicalRun{mainTip: main}}
			next, saved, err := step.consumeCapturedEdits(t.Context(), item)
			if name == "ready" {
				require.EqualError(t, err, "captured edits need the retained check plan")
			} else {
				require.NoError(t, err)
			}
			require.Nil(t, next)
			require.False(t, saved)
			require.Equal(t, item, (&MythicalService{}).releaseLane(t.Context(), nil, item), "pending work keeps its machine binding")
		})
	}
}

func TestCapturedContinuationRevalidatesItsTransaction(t *testing.T) {
	f := newMythicalServiceFixture(t)
	ctx := t.Context()
	q := db.New(f.pool)
	_, err := q.RequestMythicalBootstrap(ctx, f.repoID, f.userID, 1, false)
	require.NoError(t, err)
	main := strings.Repeat("a", 40)
	branch := "10000000-0000-4000-8000-000000000001"
	capture := MachineCapturePending{Head: strings.Repeat("b", 40), Tree: strings.Repeat("c", 40), Base: strings.Repeat("d", 40), Onto: strings.Repeat("b", 40)}
	raw, _ := json.Marshal(capture)
	_, err = f.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,vm_id,status,head_commit_id,capture_pending) VALUES($1,$2,$3,'capture','capture-vm','running',$4,$5)`, branch, f.repoID, f.userID, capture.Head, raw)
	require.NoError(t, err)
	var id pgtype.UUID
	checks := mythicalChecks{Todo: true, FlowSource: main, Capture: &capture}
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,workspace_id,candidate_base,candidate_head,attempt,generation,checks,flow_digest) VALUES($1,'todo','proposed',$2,$3,$4,2,9,$5,$6) RETURNING id`, f.repoID, branch, main, capture.Base, checks.encode(), strings.Repeat("e", 64)).Scan(&id))
	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET state='active',running=true,claim=7,lease_expires_at=now()+interval '1 minute',landed_main=$2 WHERE repository_id=$1`, f.repoID, main)
	require.NoError(t, err)
	row, err := q.GetMythicalStack(ctx, f.repoID)
	require.NoError(t, err)
	item, err := q.GetMythicalItem(ctx, id)
	require.NoError(t, err)
	step := mythicalItemStep{r: &mythicalRun{row: row, mainTip: main}}
	for _, change := range []string{"none", "prefix", "version", "attempt", "generation", "state", "pause", "merge fence", "candidate", "pin", "claim", "expiry", "frozen", "main", "head", "pending", "cleared", "deleted", "item capture"} {
		t.Run(change, func(t *testing.T) {
			tx, err := f.pool.Begin(ctx)
			require.NoError(t, err)
			defer tx.Rollback(ctx)
			switch change {
			case "prefix":
				_, err = tx.Exec(ctx, `UPDATE mythical_items SET stack_position=2 WHERE id=$1`, id)
				require.NoError(t, err)
				var predecessor pgtype.UUID
				err = tx.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,candidate_base,candidate_head,candidate_verified) VALUES($1,'todo','proposed',$2,$3,true) RETURNING id`, f.repoID, main, strings.Repeat("f", 40)).Scan(&predecessor)
				require.NoError(t, err)
				// Inserts append via the numbering trigger; explicitly move the
				// new candidate ahead of the item without changing its version.
				_, err = tx.Exec(ctx, `UPDATE mythical_items SET stack_position=1 WHERE id=$1`, predecessor)
			case "version", "attempt", "generation":
				_, err = tx.Exec(ctx, `UPDATE mythical_items SET `+change+`=`+change+`+1 WHERE id=$1`, id)
			case "state":
				_, err = tx.Exec(ctx, `UPDATE mythical_items SET state='landed' WHERE id=$1`, id)
			case "pause":
				_, err = tx.Exec(ctx, `UPDATE mythical_items SET paused_at=now() WHERE id=$1`, id)
			case "merge fence":
				_, err = tx.Exec(ctx, `UPDATE mythical_items SET pending_op='{"kind":"merge"}' WHERE id=$1`, id)
			case "candidate":
				_, err = tx.Exec(ctx, `UPDATE mythical_items SET candidate_head=$2 WHERE id=$1`, id, strings.Repeat("f", 40))
			case "pin":
				_, err = tx.Exec(ctx, `UPDATE mythical_items SET flow_digest=$2 WHERE id=$1`, id, strings.Repeat("f", 64))
			case "claim":
				_, err = tx.Exec(ctx, `UPDATE mythical_stacks SET claim=8 WHERE repository_id=$1`, f.repoID)
			case "expiry":
				_, err = tx.Exec(ctx, `UPDATE mythical_stacks SET lease_expires_at=now()-interval '1 second' WHERE repository_id=$1`, f.repoID)
			case "frozen":
				_, err = tx.Exec(ctx, `UPDATE mythical_stacks SET state='frozen' WHERE repository_id=$1`, f.repoID)
			case "main":
				_, err = tx.Exec(ctx, `UPDATE mythical_stacks SET landed_main=$2 WHERE repository_id=$1`, f.repoID, strings.Repeat("f", 40))
			case "head":
				_, err = tx.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, branch, strings.Repeat("f", 40))
			case "pending":
				_, err = tx.Exec(ctx, `UPDATE workspaces SET capture_pending=jsonb_set(capture_pending,'{tree}',to_jsonb($2::text)) WHERE id=$1`, branch, strings.Repeat("f", 40))
			case "cleared":
				_, err = tx.Exec(ctx, `UPDATE workspaces SET capture_pending=NULL WHERE id=$1`, branch)
			case "deleted":
				_, err = tx.Exec(ctx, `UPDATE workspaces SET deleted_at=now() WHERE id=$1`, branch)
			case "item capture":
				_, err = tx.Exec(ctx, `UPDATE mythical_items SET checks=checks-'capture' WHERE id=$1`, id)
			}
			require.NoError(t, err)
			err = step.lockCapturedContinuation(ctx, tx, item, capture, item.CandidateBase)
			if change == "none" {
				require.NoError(t, err)
			} else if change == "prefix" {
				require.EqualError(t, err, "prefix moved before captured edits were consumed")
			} else {
				require.Error(t, err)
			}
		})
	}
}

func TestCapturedContinuationDoesNotHideMovedMain(t *testing.T) {
	for _, phase := range []string{"integrating", "verifying", "proposing", "waiting", "proposed"} {
		for _, receipt := range []string{"none", "completed", "older pending"} {
			t.Run(phase+"/"+receipt, func(t *testing.T) {
				old, main := strings.Repeat("a", 40), strings.Repeat("b", 40)
				capture := &MachineCapturePending{Head: strings.Repeat("c", 40), Onto: strings.Repeat("c", 40), Tree: strings.Repeat("d", 40), Base: old}
				checks := mythicalChecks{Todo: true, FlowSource: old, Capture: capture, Steers: []todoSteer{{Attempt: 2, Text: "retained input"}}}
				if receipt != "none" {
					checks.Rebase = &mythicalRebase{Onto: old, Name: "main", Rebased: receipt == "completed", Since: time.Now().Add(-time.Minute)}
				}
				item := db.MythicalItem{Source: "todo", State: phase, Attempt: 2, CandidateBase: old, CandidateHead: strings.Repeat("e", 40), WorkspaceID: "10000000-0000-4000-8000-000000000001", Checks: checks.encode(), FlowDigest: pgtype.Text{String: strings.Repeat("f", 64), Valid: true}}
				step := mythicalItemStep{s: &MythicalService{rebasePresence: func(context.Context, int64, string) (RebasePresence, error) { return RebasePresenceUnknown, nil }}, r: &mythicalRun{mainTip: main}, items: []db.MythicalItem{item}, now: time.Now()}
				next, saved, err := step.advance(t.Context(), item)
				require.NoError(t, err)
				require.False(t, saved)
				require.NotNil(t, next)
				require.Equal(t, "integrating", next.State)
				require.Equal(t, "rebase_pending", next.Reason)
				require.Equal(t, main, mythicalChecksOf(*next).Rebase.Onto)
				require.Equal(t, capture, mythicalChecksOf(*next).Capture)
				require.Equal(t, mythicalChecksOf(item).Steers, mythicalChecksOf(*next).Steers)
				require.Equal(t, item.CandidateHead, next.CandidateHead)
				require.Equal(t, item.Generation, next.Generation)
				require.False(t, mythicalChecksOf(*next).Rebase.Rebased)
				// No authenticated presence provider: the next poll keeps the hold.
				held, saved, err := step.advance(t.Context(), *next)
				require.NoError(t, err)
				require.False(t, saved)
				require.Nil(t, held)
			})
		}
	}
}

func TestCapturedSubmittedCandidateDoesNotWaitForItsSteer(t *testing.T) {
	f := newMythicalServiceFixture(t)
	ctx := t.Context()
	q := db.New(f.pool)
	_, err := q.RequestMythicalBootstrap(ctx, f.repoID, f.userID, 1, false)
	require.NoError(t, err)
	main, head := strings.Repeat("a", 40), strings.Repeat("b", 40)
	branch := "10000000-0000-4000-8000-000000000001"
	capture := MachineCapturePending{Head: head, Tree: strings.Repeat("c", 40), Base: main, Onto: head}
	raw, _ := json.Marshal(capture)
	_, err = f.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,vm_id,status,head_commit_id,capture_pending) VALUES($1,$2,$3,'capture','capture-vm','running',$4,$5)`, branch, f.repoID, f.userID, head, raw)
	require.NoError(t, err)
	checks := mythicalChecks{Todo: true, FlowSource: main, Capture: &capture, Steers: []todoSteer{{Attempt: 2, Text: "amend the prompt"}}}
	var id pgtype.UUID
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,workspace_id,candidate_base,candidate_head,candidate_verified,vibe_outcome,attempt,generation,checks,flow_digest,request_run_id) VALUES($1,'todo','integrating',$2,$3,$4,true,'submitted',2,9,$5,$6,'same-todo-run') RETURNING id`, f.repoID, branch, main, head, checks.encode(), strings.Repeat("e", 64)).Scan(&id))
	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET state='active',running=true,claim=7,lease_expires_at=now()+interval '1 minute',landed_main=$2 WHERE repository_id=$1`, f.repoID, main)
	require.NoError(t, err)
	row, err := q.GetMythicalStack(ctx, f.repoID)
	require.NoError(t, err)
	item, err := q.GetMythicalItem(ctx, id)
	require.NoError(t, err)
	step := mythicalItemStep{s: f.service, r: &mythicalRun{row: row, mainTip: main}}
	for _, name := range []string{"different head", "unverified", "stale", "reconciliation", "paused", "ready"} {
		t.Run(name, func(t *testing.T) {
			current := item
			held := mythicalChecksOf(current)
			switch name {
			case "different head":
				current.CandidateHead = strings.Repeat("f", 40)
			case "unverified":
				current.CandidateVerified = false
			case "stale":
				held.Capture.Stale = true
			case "reconciliation":
				held.Capture.ReconcileWaitID = "wake-wait"
			case "paused":
				current.PausedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
			}
			current.Checks = held.encode()
			next, saved, err := step.consumeCapturedEdits(ctx, current)
			require.NoError(t, err)
			if name != "ready" {
				require.Nil(t, next)
				require.False(t, saved)
				return
			}
			require.True(t, saved)
			require.NotNil(t, next)
			require.Nil(t, mythicalChecksOf(*next).Capture)
			require.Equal(t, mythicalChecksOf(item).Steers, mythicalChecksOf(*next).Steers)
			require.Equal(t, item.RequestRunID, next.RequestRunID)
			require.Equal(t, item.Attempt, next.Attempt)
			require.Equal(t, item.Generation, next.Generation)
			var pending []byte
			require.NoError(t, f.pool.QueryRow(ctx, `SELECT capture_pending FROM workspaces WHERE id=$1`, branch).Scan(&pending))
			require.Empty(t, pending)
		})
	}
}
