package services

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestCapturedContinuationHoldsOtherWork(t *testing.T) {
	for _, name := range []string{"ready", "stale", "paused", "unsettled publication", "foreign push", "unreconciled prefix", "verify still running", "review still running", "held text", "delivered text", "reopened"} {
		t.Run(name, func(t *testing.T) {
			main := strings.Repeat("b", 40)
			item := db.MythicalItem{WorkspaceID: "10000000-0000-4000-8000-000000000001", CandidateBase: main, Source: "todo", State: "proposed", Attempt: 2, FlowDigest: pgtype.Text{String: strings.Repeat("a", 64), Valid: true}}
			checks := mythicalChecks{FlowSource: strings.Repeat("b", 40), Capture: &MachineCapturePending{Head: strings.Repeat("c", 40)}}
			switch name {
			case "stale":
				checks.Capture.Stale = true
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
			err = step.lockCapturedContinuation(ctx, tx, item, capture)
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
