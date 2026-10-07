package machined

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestBurstAttributionUsesAdmittedSession(t *testing.T) {
	pool, branch, _ := machineReceiptDatabase(t)
	var repository int64
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT repository_id FROM workspaces WHERE id=$1`, branch).Scan(&repository))
	registry := new(Registry)
	authority, err := registry.MintBoot(branch, "vm")
	require.NoError(t, err)
	link, guest := connectTest(t, registry, branch, authority)
	require.NoError(t, link.Reconciled())
	sessions := NewSessions(link.Connection, branch, registry.Sessions(branch)).WithPresenceVia("ssh")
	opened := make(chan error, 1)
	go func() {
		_, err := sessions.OpenSession(t.Context(), SessionUser{"alice", 20001}, SessionPTY, nil, nil)
		opened <- err
	}()
	answer(t, guest, wire.OpenSession, wire.Field(1, wire.U32(1)))
	require.NoError(t, <-opened)
	objects := &burstObjectFixture{}
	writer := &BurstIngest{Pool: pool, Objects: objects, ResolveActor: func(_ context.Context, branch string, actor wire.Actor) (json.RawMessage, error) {
		user, run, via, err := link.SessionPresence(branch, actor.Session)
		if err != nil {
			return nil, err
		}
		require.Equal(t, SessionUser{"alice", 20001}, user)
		require.Empty(t, run)
		require.Equal(t, "ssh", via)
		return json.RawMessage(`{"id":"member:alice","kind":"person","via":"ssh"}`), nil
	}}
	event := Event{Seq: 1, EventID: [16]byte{1}, Payload: burstPayload([16]byte{2}, "source.ts")}
	ack, err := writer.Apply(t.Context(), link.Connection, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: "branch:" + branch}, event)
	require.NoError(t, err)
	require.Equal(t, AckApplied, ack.Outcome)
	var actor string
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT data->'actor'->>'id' FROM product_job_events WHERE event_type='branch.burst'`).Scan(&actor))
	require.Equal(t, "member:alice", actor)
	require.Equal(t, 1, objects.publications)
}

func TestBurstAttributionRechecksConnectionBeforeWriting(t *testing.T) {
	for _, replacement := range []string{"boot", "connection", "close"} {
		t.Run(replacement, func(t *testing.T) {
			pool, branch, _ := machineReceiptDatabase(t)
			var repository int64
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT repository_id FROM workspaces WHERE id=$1`, branch).Scan(&repository))
			registry := new(Registry)
			authority, err := registry.MintBoot(branch, "vm")
			require.NoError(t, err)
			link, _ := connectTest(t, registry, branch, authority)
			objects := &burstObjectFixture{}
			entered, release := make(chan struct{}), make(chan struct{})
			writer := &BurstIngest{Pool: pool, Objects: objects, ResolveActor: func(ctx context.Context, _ string, _ wire.Actor) (json.RawMessage, error) {
				close(entered)
				select {
				case <-release:
				case <-ctx.Done():
					return nil, ctx.Err()
				}
				return json.RawMessage(`{"id":"outside","kind":"outside"}`), nil
			}}
			event := Event{Seq: 1, EventID: [16]byte{1}, Payload: burstPayload([16]byte{2}, "source.ts")}
			done := make(chan error, 1)
			go func() {
				ack, err := writer.Apply(t.Context(), link.Connection, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: "branch:" + branch}, event)
				if ack.Outcome != 0 {
					err = fmt.Errorf("obsolete connection acknowledged: %+v", ack)
				}
				done <- err
			}()
			<-entered
			switch replacement {
			case "boot":
				_, err = registry.MintBoot(branch, "next-vm")
			case "connection":
				connectTest(t, registry, branch, authority)
			case "close":
				err = link.Close()
			}
			require.NoError(t, err)
			close(release)
			require.ErrorIs(t, <-done, ErrUnauthorized)
			require.Zero(t, objects.publications)
			for _, table := range []string{"machine_event_receipts", "product_job_events", "burst_files"} {
				var count int
				require.NoError(t, pool.QueryRow(t.Context(), "SELECT count(*) FROM "+table).Scan(&count))
				require.Zero(t, count, table)
			}
			writer.ResolveActor = func(context.Context, string, wire.Actor) (json.RawMessage, error) {
				t.Error("obsolete connection reached attribution")
				return nil, ErrUnauthorized
			}
			_, err = writer.Apply(t.Context(), link.Connection, jobs.Scope{}, event)
			require.ErrorIs(t, err, ErrUnauthorized)
			_, err = writer.Apply(t.Context(), new(Connection), jobs.Scope{}, event)
			require.ErrorIs(t, err, ErrUnauthorized)
		})
	}
}
