package compose

import (
	"encoding/json"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/stretchr/testify/require"
)

func TestMachineItemBindingPinsLogicalChange(t *testing.T) {
	pool := docDatabase(t)
	ctx := t.Context()
	var user, repository, number int64
	var item string
	const branch = "5a1b0000-0000-4000-8000-000000000005"
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('item-owner','item-owner') RETURNING id`).Scan(&user))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'item','item') RETURNING id`, user).Scan(&repository))
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,head_change_id) VALUES($1,$2,$3,'item','yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy')`, branch, repository, user)
	require.NoError(t, err)
	got, err := machineItemBinding(ctx, pool, branch)
	require.NoError(t, err)
	require.Equal(t, machined.ItemBinding{}, got, "a workspace without an item is explicitly scratch")
	_, err = pool.Exec(ctx, `UPDATE workspaces SET target_bookmark='mythical' WHERE id=$1`, branch)
	require.NoError(t, err)
	_, err = machineItemBinding(ctx, pool, branch)
	require.ErrorIs(t, err, machined.ErrNotReady, "an item lane cannot boot as scratch before its binding lands")
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,workspace_id) VALUES($1,'todo','running','Item',$2) RETURNING id::text,number`, repository, branch).Scan(&item, &number))
	_, err = pool.Exec(ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'item')`, branch, repository, item)
	require.NoError(t, err)
	_, err = machineItemBinding(ctx, pool, branch)
	require.ErrorIs(t, err, machined.ErrNotReady, "an uncaptured item cannot use its current working copy as authority")
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_build_object('machineItemChanges',jsonb_build_object($1::text,'vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv')) WHERE id=$2`, branch, item)
	require.NoError(t, err)
	initial, err := machineItemBinding(ctx, pool, branch)
	require.NoError(t, err)
	require.Equal(t, machined.ItemBinding{Number: uint64(number), Change: "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv"}, initial, "first coding admission has retained authority before any delivery")
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks='{}' WHERE id=$1`, item)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_changes(repository_id,position,change_id,commit_id,kind,item_id) VALUES($1,1,'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','item',$2)`, repository, item)
	require.NoError(t, err)
	got, err = machineItemBinding(ctx, pool, branch)
	require.NoError(t, err)
	require.Equal(t, machined.ItemBinding{Number: uint64(number), Change: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"}, got)
	// Current-head reporting after an external move cannot rebind the item.
	_, err = pool.Exec(ctx, `UPDATE workspaces SET head_change_id='xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' WHERE id=$1`, branch)
	require.NoError(t, err)
	again, err := machineItemBinding(ctx, pool, branch)
	require.NoError(t, err)
	require.Equal(t, got, again)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET moved_off='{"pre_move_commit":"1234567890abcdef1234567890abcdef12345678"}' WHERE id=$1`, branch)
	require.NoError(t, err)
	restored, err := machineItemBinding(ctx, pool, branch)
	require.NoError(t, err)
	require.Equal(t, "1234567890abcdef1234567890abcdef12345678", restored.PreMoveCommit, "a new boot retains the pending return target")
	_, err = pool.Exec(ctx, `UPDATE mythical_lanes SET retired_at=NOW() WHERE workspace_id=$1`, branch)
	require.NoError(t, err)
	_, err = machineItemBinding(ctx, pool, branch)
	require.ErrorIs(t, err, machined.ErrUnauthorized)
}

func TestMachineRetainedConflictRequiresCommittedAttemptBinding(t *testing.T) {
	pool := docDatabase(t)
	ctx := t.Context()
	var user, repository int64
	var item string
	const branch = "5a1b0000-0000-4000-8000-000000000006"
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('conflict-owner','conflict-owner') RETURNING id`).Scan(&user))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'conflict','conflict') RETURNING id`, user).Scan(&repository))
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name) VALUES($1,$2,$3,'conflict')`, branch, repository, user)
	require.NoError(t, err)
	empty, err := machineRetainedConflict(ctx, pool, branch)
	require.NoError(t, err)
	require.Nil(t, empty)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,workspace_id,reason,request_run_id,flow_digest) VALUES($1,'todo','waiting','Conflict',$2,'rebase_conflict_pending','run','pin') RETURNING id::text`, repository, branch).Scan(&item))
	_, err = pool.Exec(ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'conflict')`, branch, repository, item)
	require.NoError(t, err)
	const change = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const onto = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	reservation := map[string]any{"Change": change, "Onto": onto, "Run": "run"}
	native := map[string]any{"Head": change, "Paths": []string{"conflict"}, "Inspected": true, "receipt_id": "committed"}
	checks := map[string]any{"run_launched": true, "run_attached": true, "rebase": map[string]any{"onto": onto, "native": native}, "conflictReservation": reservation}
	save := func() {
		b, e := json.Marshal(checks)
		require.NoError(t, e)
		_, e = pool.Exec(ctx, `UPDATE mythical_items SET checks=$1,integration=jsonb_build_object('conflict',jsonb_build_object('head',$2::text,'onto',$3::text)) WHERE id=$4`, b, change, onto, item)
		require.NoError(t, e)
	}
	save()
	got, err := machineRetainedConflict(ctx, pool, branch)
	require.NoError(t, err)
	require.Equal(t, &machined.RetainedConflict{Change: change, Onto: onto}, got)
	for _, invalidate := range []func(){
		func() { checks["run_attached"] = false },
		func() { reservation["Run"] = "other-run" },
		func() { native["Head"] = onto },
		func() { native["receipt_id"] = "" },
		func() { native["Paths"] = []string{} },
	} {
		invalidate()
		save()
		_, err = machineRetainedConflict(ctx, pool, branch)
		require.ErrorIs(t, err, machined.ErrNotReady)
		checks["run_attached"] = true
		reservation["Run"] = "run"
		native["Head"] = change
		native["receipt_id"] = "committed"
		native["Paths"] = []string{"conflict"}
	}
	checks["rebase"] = map[string]any{"onto": onto}
	save()
	got, err = machineRetainedConflict(ctx, pool, branch)
	require.NoError(t, err)
	require.Nil(t, got, "a host marker grants no native conflict wake admission")
	reservation["Run"] = "other-run"
	save()
	_, err = machineRetainedConflict(ctx, pool, branch)
	require.ErrorIs(t, err, machined.ErrNotReady, "host materialization must retain the existing attempt")
	reservation["Run"] = "run"
	checks["rebase"] = map[string]any{"onto": onto, "native": native}
	save()
	_, err = pool.Exec(ctx, `UPDATE mythical_lanes SET retired_at=NOW() WHERE workspace_id=$1`, branch)
	require.NoError(t, err)
	got, err = machineRetainedConflict(ctx, pool, branch)
	require.NoError(t, err)
	require.Nil(t, got, "retired lanes cannot admit a daemon")
}
