package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// PostgreSQL serialization proof for the existing claimed proposal path.
// Packaged guest dispatch and real-microVM acceptance remain separate checks.
func TestCandidatePushRevalidatesUnderOwningClaim(t *testing.T) {
	for _, change := range []string{"none", "version", "verification", "prefix", "main", "claim", "expired", "merge fence", "closed", "attempt", "pending push"} {
		t.Run(change, func(t *testing.T) {
			f := newMythicalServiceFixture(t)
			ctx := t.Context()
			q := db.New(f.pool)
			_, err := q.RequestMythicalBootstrap(ctx, f.repoID, f.userID, 1, false)
			require.NoError(t, err)
			main := strings.Repeat("a", 40)
			_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET state='active',running=true,claim=7,landed_main=$2,lease_expires_at=now()+interval '1 minute' WHERE repository_id=$1`, f.repoID, main)
			require.NoError(t, err)
			var earlierID, id pgtype.UUID
			require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,candidate_base,candidate_head,candidate_verified) VALUES($1,'todo','running','Earlier',$2,$3,false) RETURNING id`, f.repoID, main, strings.Repeat("b", 40)).Scan(&earlierID))
			require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,candidate_base,candidate_head,candidate_verified) VALUES($1,'todo','proposing','Candidate',$2,$3,true) RETURNING id`, f.repoID, main, strings.Repeat("c", 40)).Scan(&id))
			row, err := q.GetMythicalStack(ctx, f.repoID)
			require.NoError(t, err)
			item, err := q.GetMythicalItem(ctx, id)
			require.NoError(t, err)
			step := &mythicalItemStep{s: f.service, r: &mythicalRun{row: row, mainTip: main}}
			switch change {
			case "merge fence":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET pending_op=jsonb_build_object('kind','merge','target','1','desired',$2::text,'state','intended') WHERE id=$1`, id, item.CandidateHead)
			case "closed":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET state='landed' WHERE id=$1`, id)
			case "attempt":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET attempt=attempt+1 WHERE id=$1`, id)
			case "pending push":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET pending_op=jsonb_build_object('kind','push','target','smithers/other','desired',$2::text,'state','intended') WHERE id=$1`, id, item.CandidateHead)
			case "version":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET version=version+1 WHERE id=$1`, id)
			case "verification":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET candidate_verified=false WHERE id=$1`, id)
			case "prefix":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET candidate_verified=true WHERE id=$1`, earlierID)
			case "main":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET landed_main=$2 WHERE repository_id=$1`, f.repoID, strings.Repeat("d", 40))
			case "claim":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET claim=claim+1 WHERE repository_id=$1`, f.repoID)
			case "expired":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET lease_expires_at=now()-interval '1 second' WHERE repository_id=$1`, f.repoID)
			}
			require.NoError(t, err)
			pushes := 0
			err = step.pushCurrentProposal(ctx, item, func() error { pushes++; return nil })
			if change == "none" {
				require.NoError(t, err)
				require.Equal(t, 1, pushes)
			} else {
				require.Error(t, err)
				require.Zero(t, pushes)
			}
		})
	}
}

func TestCandidatePushHoldsStackMutationUntilEffectReturns(t *testing.T) {
	f := newMythicalServiceFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	q := db.New(f.pool)
	_, err := q.RequestMythicalBootstrap(ctx, f.repoID, f.userID, 1, false)
	require.NoError(t, err)
	main := strings.Repeat("a", 40)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET running=true,claim=1,landed_main=$2,lease_expires_at=now()+interval '1 minute' WHERE repository_id=$1`, f.repoID, main)
	require.NoError(t, err)
	var id pgtype.UUID
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,candidate_base,candidate_head,candidate_verified) VALUES($1,'todo','proposing','Candidate',$2,$3,true) RETURNING id`, f.repoID, main, strings.Repeat("c", 40)).Scan(&id))
	row, err := q.GetMythicalStack(ctx, f.repoID)
	require.NoError(t, err)
	item, err := q.GetMythicalItem(ctx, id)
	require.NoError(t, err)
	step := &mythicalItemStep{s: f.service, r: &mythicalRun{row: row, mainTip: main}}
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- step.pushCurrentProposal(ctx, item, func() error {
			close(entered)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	select {
	case <-entered:
	case err := <-done:
		t.Fatalf("push did not start: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// NOWAIT independently proves the row is locked through the external effect.
	tx, err := f.pool.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE NOWAIT`, f.repoID)
	require.Error(t, err)
	require.NoError(t, tx.Rollback(ctx))
	close(release)
	require.NoError(t, <-done)
	require.NoError(t, pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE NOWAIT`, f.repoID)
		return err
	}))
}
