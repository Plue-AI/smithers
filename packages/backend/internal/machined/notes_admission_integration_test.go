package machined

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Contract proof only: a test-only pinned-delivery port shares the real burst
// transaction. This does not substitute for the reference machine/run proof.
func TestOutsideChangeAdmissionSharesBurstCommit(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	var member, repository int64
	var branch string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('notes','notes') RETURNING id`).Scan(&member))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'notes','notes') RETURNING id`, member).Scan(&repository))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name) VALUES($1,$2,'notes') RETURNING id`, repository, member).Scan(&branch))
	registry := &Registry{}
	boot, err := registry.MintBoot(branch, "vm")
	require.NoError(t, err)
	link, peer := connectTest(t, registry, branch, boot)
	actor := json.RawMessage(`{"id":"member:1","kind":"person","via":"ssh"}`)
	objects := &burstObjectFixture{}
	ingest := &BurstIngest{Pool: pool, Objects: objects, ResolveActor: func(context.Context, string, wire.Actor) (json.RawMessage, error) { return actor, nil }}
	event := Event{Seq: 1, EventID: [16]byte{2}, Payload: burstPayload([16]byte{3}, "a.ts", "b.ts")}
	scope := jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: "branch:" + branch}
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Error("runtime must never resolve inside burst transaction")
		return nil, errors.New("unexpected runtime resolution")
	})})
	require.NoError(t, err)
	fail := true
	calls := 0
	ingest.OutsideChanges = func(ctx context.Context, tx pgx.Tx, gotBranch, burst string, gotActor json.RawMessage, paths []string) error {
		calls++
		require.Equal(t, branch, gotBranch)
		require.Equal(t, "03000000-0000-0000-0000-000000000000", burst)
		require.JSONEq(t, string(actor), string(gotActor))
		require.Equal(t, []string{"a.ts", "b.ts"}, paths)
		var facts int
		require.NoError(t, tx.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.burst'`).Scan(&facts))
		require.Equal(t, 1, facts)
		payload, err := json.Marshal(map[string]any{"kind": "outside_change", "id": burst, "actor": json.RawMessage(gotActor), "files": paths})
		require.NoError(t, err)
		_, err = dispatcher.SignalInTx(ctx, tx, flowdispatch.SignalRequest{
			Scope: scope, RequestID: "outside-change:" + burst, Target: flowruntime.Target{BindingKind: "repository-job-dispatch", BindingID: "pinned-dispatch"},
			FlowID: "coding/dispatch", RunID: "pinned-run", Name: "outside_change", Payload: payload, AuthorizationContext: json.RawMessage(`{"source":"committed-watcher"}`),
		})
		require.NoError(t, err)
		if fail {
			return errors.New("pinned delivery unavailable")
		}
		return nil
	}
	// Authentication and complete object verification precede the admission
	// port. Neither refusal may leave a signal intent or call the pinned host.
	_, err = ingest.Apply(ctx, link.Connection, jobs.Scope{TenantID: "different-repository", PrincipalID: scope.PrincipalID}, event)
	require.ErrorIs(t, err, ErrUnauthorized)
	require.Zero(t, calls)
	objects.missing = []string{"unavailable-object"}
	missingAck, err := ingest.Apply(ctx, link.Connection, scope, event)
	require.NoError(t, err)
	require.Equal(t, AckMissingObjects, missingAck.Outcome)
	require.Zero(t, calls)
	objects.missing = nil
	_, err = ingest.Apply(ctx, link.Connection, scope, event)
	require.EqualError(t, err, "pinned delivery unavailable")
	for _, table := range []string{"machine_event_receipts", "product_job_events", "burst_files", "product_job_requests"} {
		var count int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
		require.Zero(t, count, "failed note admission rolls back "+table)
	}
	fail = false
	// Snapshot retention now precedes SQL commit. Its failure must roll back
	// the note intent, rather than pretending to be a lost transport ACK.
	objects.publishError = errors.New("snapshot retention unavailable")
	_, err = ingest.Apply(ctx, link.Connection, scope, event)
	require.EqualError(t, err, "snapshot retention unavailable")
	for _, table := range []string{"machine_event_receipts", "product_job_events", "burst_files", "product_job_requests"} {
		var count int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
		require.Zero(t, count, "failed snapshot retention rolls back "+table)
	}
	objects.publishError = nil
	ack, err := ingest.Apply(ctx, link.Connection, scope, event)
	require.NoError(t, err)
	require.Equal(t, AckApplied, ack.Outcome)
	require.Equal(t, 3, calls)
	// Lose the actual acknowledgement transport after the durable commit.
	// Reconnect with the same authenticated boot and replay its unacked event.
	require.NoError(t, peer.Close())
	require.Error(t, link.Ack(ctx, branch, ack))
	link, _ = connectTest(t, registry, branch, boot)
	ack, err = ingest.Apply(ctx, link.Connection, scope, event)
	require.NoError(t, err)
	require.Equal(t, AckDuplicate, ack.Outcome)
	require.Equal(t, 3, calls, "a committed duplicate never admits another note")
	// Reconnection can assign a new transport event identity to the same
	// logical burst. Deduplication must remain bound to the committed burst.
	event.EventID = [16]byte{4}
	event.Seq = 2
	ack, err = ingest.Apply(ctx, link.Connection, scope, event)
	require.NoError(t, err)
	require.Equal(t, AckDuplicate, ack.Outcome)
	require.Equal(t, 3, calls)
	var signals int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation=$1`, flowdispatch.OperationSignal).Scan(&signals))
	require.Equal(t, 1, signals, "lost burst acknowledgement leaves exactly one durable signal intent")
}
