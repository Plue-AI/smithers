package machined

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// W3's object receiver is not landed. This test-only port exercises the real
// codec, authenticated boot lease and PostgreSQL writer without claiming VM or
// host-store verification evidence.
type burstObjectFixture struct {
	missing      []string
	publishError error
	publications int
}

func (f *burstObjectFixture) VerifyBurst(context.Context, string, wire.Burst) ([]string, error) {
	return f.missing, nil
}
func (f *burstObjectFixture) PublishBurst(context.Context, string, string, string) error {
	f.publications++
	return f.publishError
}

func burstPayload(id [16]byte, paths ...string) []byte {
	list := wire.U16(uint16(len(paths)))
	for _, p := range paths {
		list = append(list, wire.Struct(wire.Field(1, wire.String(p)), wire.Field(2, []byte{2}), wire.Field(4, []byte(strings.Repeat("a", 20))), wire.Field(5, []byte(strings.Repeat("b", 20))), wire.Field(6, []byte(strings.Repeat("c", 32))))...)
	}
	return wire.Union(1, wire.Field(1, id[:]), wire.Field(2, wire.Union(2, wire.Field(1, wire.U32(1)))), wire.Field(3, list), wire.Field(4, []byte(strings.Repeat("v", 20))))
}

func TestBurstIngestProductionBoundary(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	var user, repo int64
	var branch string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('w6','w6') RETURNING id`).Scan(&user))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, user).Scan(&repo))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name) VALUES($1,$2,'watch') RETURNING id`, repo, user).Scan(&branch))
	registry := &Registry{}
	authority, err := registry.MintBoot(branch, "vm")
	require.NoError(t, err)
	link, daemon := connectTest(t, registry, branch, authority)
	connection := link.Connection
	objects := &burstObjectFixture{}
	s := &BurstIngest{Pool: pool, Objects: objects, ResolveActor: func(_ context.Context, b string, a wire.Actor) (json.RawMessage, error) {
		require.Equal(t, branch, b)
		require.Equal(t, uint32(1), a.Session)
		return json.RawMessage(`{"id":"member:1","kind":"person","member_id":"1","via":"ssh"}`), nil
	}}
	scope := jobs.Scope{TenantID: fmt.Sprint(repo), PrincipalID: "branch:" + branch}
	event := Event{Seq: 1, EventID: [16]byte{2}, Payload: burstPayload([16]byte{3}, "a.ts", "b.ts")}
	counts := func(events, files, receipts int) {
		t.Helper()
		for table, want := range map[string]int{"product_job_events": events, "burst_files": files, "machine_event_receipts": receipts} {
			var got int
			require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&got))
			require.Equal(t, want, got, table)
		}
	}
	objects.missing = []string{strings.Repeat("61", 20)}
	ack, err := s.Apply(ctx, connection, scope, event)
	require.NoError(t, err)
	require.Equal(t, AckMissingObjects, ack.Outcome)
	counts(0, 0, 0)
	objects.missing = nil
	// Force the per-file insert to fail after the canonical writer has appended.
	_, err = pool.Exec(ctx, `ALTER TABLE burst_files ADD CONSTRAINT fixture_fail CHECK(path<>'b.ts')`)
	require.NoError(t, err)
	_, err = s.Apply(ctx, connection, scope, event)
	require.Error(t, err)
	counts(0, 0, 0)
	_, err = pool.Exec(ctx, `ALTER TABLE burst_files DROP CONSTRAINT fixture_fail`)
	require.NoError(t, err)
	// The real W3 handshake and event demultiplexer deliver the Event union
	// to the production dispatcher; the peer sees success only after commit.
	peerDone := make(chan error, 1)
	go func() {
		frame := wire.Frame{Kind: wire.Events, Payload: wire.Union(1, wire.Field(1, wire.U64(event.Seq)), wire.Field(2, event.EventID[:]), wire.Field(3, event.Payload))}
		if err := wire.Write(daemon, frame); err != nil {
			peerDone <- err
			return
		}
		frame, err := wire.Read(daemon)
		if err != nil {
			peerDone <- err
			return
		}
		values, err := wire.Fields("ack", frame.Payload[1:])
		if err != nil {
			peerDone <- err
			return
		}
		if frame.Kind != wire.Events || frame.Payload[0] != 3 || values[2][0] != byte(AckApplied) {
			peerDone <- fmt.Errorf("unexpected acknowledgement")
			return
		}
		peerDone <- nil
	}()
	received, err := link.Receive(ctx)
	require.NoError(t, err)
	require.Equal(t, event, received)
	require.NoError(t, s.DispatchBurst(ctx, link, scope, received))
	require.NoError(t, <-peerDone)
	counts(1, 2, 1)
	ack, err = s.Apply(ctx, connection, scope, event)
	require.NoError(t, err)
	require.Equal(t, AckDuplicate, ack.Outcome)
	counts(1, 2, 1)
	changed := event
	changed.Payload = burstPayload([16]byte{3}, "different.ts")
	_, err = s.Apply(ctx, connection, scope, changed)
	require.ErrorIs(t, err, wire.BadValue)
	counts(1, 2, 1)
	var actor, before, after, digest string
	require.NoError(t, pool.QueryRow(ctx, `SELECT e.data->'actor'->>'id',f.before_blob,f.after_blob,f.post_digest FROM burst_files f JOIN product_job_events e ON e.event_id=f.event_id WHERE f.path='a.ts'`).Scan(&actor, &before, &after, &digest))
	require.Equal(t, "member:1", actor)
	require.Equal(t, strings.Repeat("61", 20), before)
	require.Equal(t, strings.Repeat("62", 20), after)
	require.Equal(t, strings.Repeat("63", 32), digest)
	// Retention must succeed even on replay before any success acknowledgement.
	objects.publishError = errors.New("ref unavailable")
	_, err = s.Apply(ctx, connection, scope, event)
	require.ErrorContains(t, err, "ref unavailable")
	counts(1, 2, 1)
	objects.publishError = nil
	for _, p := range []string{"../escape", ".git/config", ".jj/repo/op_store", "/root/x"} {
		bad := event
		bad.Payload = burstPayload([16]byte{4}, p)
		_, err = s.Apply(ctx, connection, scope, bad)
		require.Error(t, err)
		counts(1, 2, 1)
	}
	_, err = s.Apply(ctx, connection, jobs.Scope{TenantID: "999", PrincipalID: "branch:" + branch}, event)
	require.ErrorIs(t, err, ErrUnauthorized)
	counts(1, 2, 1)
	for name, alter := range map[string]func(*BurstIngest){
		"database": func(s *BurstIngest) { s.Pool = nil },
		"objects":  func(s *BurstIngest) { s.Objects = nil },
		"actor":    func(s *BurstIngest) { s.ResolveActor = nil },
	} {
		t.Run("unavailable_"+name, func(t *testing.T) {
			copy := *s
			alter(&copy)
			ack, err := copy.Apply(ctx, connection, scope, event)
			require.ErrorIs(t, err, ErrNotReady)
			require.Zero(t, ack.Outcome)
			counts(1, 2, 1)
		})
	}
	newBoot := uuid.New()
	require.NoError(t, registry.BindBoot(branch, "vm2", newBoot, []byte("new-secret")))
	_, err = s.Apply(ctx, connection, scope, event)
	require.ErrorIs(t, err, ErrUnauthorized)
	counts(1, 2, 1)
}

func TestBurstMultipartProductionBoundary(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	var user, repo int64
	var branch string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('multipart','multipart') RETURNING id`).Scan(&user))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, user).Scan(&repo))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name) VALUES($1,$2,'watch') RETURNING id`, repo, user).Scan(&branch))
	registry := &Registry{}
	authority, err := registry.MintBoot(branch, "vm")
	require.NoError(t, err)
	link, daemon := connectTest(t, registry, branch, authority)
	objects := &burstObjectFixture{}
	service := func() *BurstIngest {
		return &BurstIngest{Pool: pool, Objects: objects, ResolveActor: func(context.Context, string, wire.Actor) (json.RawMessage, error) {
			return json.RawMessage(`{"id":"member:1","kind":"person","member_id":"1","via":"terminal"}`), nil
		}}
	}
	scope := jobs.Scope{TenantID: fmt.Sprint(repo), PrincipalID: "branch:" + branch}
	payload := func(part uint16, paths ...string) []byte {
		base := burstPayload([16]byte{88}, paths...)
		fields, err := wire.Fields("burst", base[1:])
		require.NoError(t, err)
		return wire.Union(1, wire.Field(1, fields[1]), wire.Field(2, fields[2]), wire.Field(3, fields[3]), wire.Field(4, fields[4]), wire.Field(5, wire.U16(part)), wire.Field(6, wire.U16(2)))
	}
	first := Event{Seq: 1, EventID: [16]byte{89}, Payload: payload(1, "a.ts")}
	second := Event{Seq: 2, EventID: [16]byte{90}, Payload: payload(2, "b.ts")}
	counts := func(entries, files, receipts int) {
		t.Helper()
		for table, want := range map[string]int{"product_job_events": entries, "burst_files": files, "machine_event_receipts": receipts} {
			var n int
			require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n))
			require.Equal(t, want, n, table)
		}
	}
	// Exercise the authenticated wire dispatcher, including acknowledgement of
	// durable staging so the serial daemon outbox can send its next frame.
	done := make(chan error, 1)
	go func() {
		if err := wire.Write(daemon, wire.Frame{Kind: wire.Events, Payload: wire.Union(1, wire.Field(1, wire.U64(1)), wire.Field(2, first.EventID[:]), wire.Field(3, first.Payload))}); err != nil {
			done <- err
			return
		}
		frame, err := wire.Read(daemon)
		if err == nil {
			fields, e := wire.Fields("ack", frame.Payload[1:])
			err = e
			if err == nil && fields[2][0] != byte(AckApplied) {
				err = fmt.Errorf("staging not acknowledged")
			}
		}
		done <- err
	}()
	received, err := link.Receive(ctx)
	require.NoError(t, err)
	require.NoError(t, service().DispatchBurst(ctx, link, scope, received))
	require.NoError(t, <-done)
	counts(0, 0, 1)
	require.Zero(t, objects.publications)
	_, err = service().Apply(ctx, link.Connection, jobs.Scope{TenantID: "wrong", PrincipalID: scope.PrincipalID}, second)
	require.ErrorIs(t, err, ErrUnauthorized)
	counts(0, 0, 1)
	remapped := service()
	remapped.ResolveActor = func(context.Context, string, wire.Actor) (json.RawMessage, error) {
		return json.RawMessage(`{"id":"member:2","kind":"person","member_id":"2","via":"terminal"}`), nil
	}
	_, err = remapped.Apply(ctx, link.Connection, scope, second)
	require.ErrorIs(t, err, ErrUnauthorized)
	counts(0, 0, 1)
	changed := first
	changed.Payload = payload(1, "substituted.ts")
	_, err = service().Apply(ctx, link.Connection, scope, changed)
	require.ErrorIs(t, err, wire.BadValue)
	counts(0, 0, 1)
	duplicatePath := second
	duplicatePath.Payload = payload(2, "a.ts")
	_, err = service().Apply(ctx, link.Connection, scope, duplicatePath)
	require.ErrorIs(t, err, wire.BadValue)
	counts(0, 0, 1)
	objects.missing = []string{strings.Repeat("61", 20)}
	ack, err := service().Apply(ctx, link.Connection, scope, second)
	require.NoError(t, err)
	require.Equal(t, AckMissingObjects, ack.Outcome)
	counts(0, 0, 1)
	objects.missing = nil
	_, err = pool.Exec(ctx, `ALTER TABLE burst_files ADD CONSTRAINT multipart_fail CHECK(path<>'b.ts')`)
	require.NoError(t, err)
	_, err = service().Apply(ctx, link.Connection, scope, second)
	require.Error(t, err)
	counts(0, 0, 1)
	_, err = pool.Exec(ctx, `ALTER TABLE burst_files DROP CONSTRAINT multipart_fail`)
	require.NoError(t, err)
	// A new service and a new admitted boot recover from database staging.
	authority, err = registry.MintBoot(branch, "restarted")
	require.NoError(t, err)
	recovered, _ := connectTest(t, registry, branch, authority)
	ack, err = service().Apply(ctx, recovered.Connection, scope, second)
	require.NoError(t, err)
	require.Equal(t, AckApplied, ack.Outcome)
	counts(1, 2, 2)
	ack, err = service().Apply(ctx, recovered.Connection, scope, second)
	require.NoError(t, err)
	require.Equal(t, AckDuplicate, ack.Outcome)
	counts(1, 2, 2)
	_, err = service().Apply(ctx, recovered.Connection, scope, first)
	require.NoError(t, err)
	counts(1, 2, 2)
}

func TestChangeIntegrationLandsDark(t *testing.T) {
	pool, branch, foreign := machineReceiptDatabase(t)
	registry := new(Registry)
	authority, err := registry.MintBoot(branch, "vm")
	require.NoError(t, err)
	link, _ := connectTest(t, registry, branch, authority)
	service := func() *BurstIngest {
		return &BurstIngest{Pool: pool, Objects: &burstObjectFixture{}, ResolveActor: func(context.Context, string, wire.Actor) (json.RawMessage, error) {
			return json.RawMessage(`{"id":"outside","kind":"outside","via":"tool"}`), nil
		}}
	}
	event := Event{Seq: 1, EventID: [16]byte{23}, Payload: burstPayload([16]byte{24}, "a.ts")}
	for name, remove := range map[string]func(*Ingestor){
		"database":       func(i *Ingestor) { i.Pool = nil },
		"burst_provider": func(i *Ingestor) { i.Bursts = nil },
		"objects":        func(i *Ingestor) { i.Bursts.Objects = nil },
		"attribution":    func(i *Ingestor) { i.Bursts.ResolveActor = nil },
	} {
		t.Run(name, func(t *testing.T) {
			pump := &Ingestor{Pool: pool, Bursts: service()}
			remove(pump)
			ack, err := pump.Commit(t.Context(), link.Connection, branch, event)
			require.ErrorIs(t, err, ErrNotReady)
			require.Zero(t, ack.Outcome)
		})
	}
	pump := &Ingestor{Pool: pool, Bursts: service()}
	for _, connection := range []*Connection{nil, {}, {registry: registry}} {
		_, err := pump.Commit(t.Context(), connection, branch, event)
		require.ErrorIs(t, err, ErrUnauthorized)
	}
	_, err = pump.Commit(t.Context(), link.Connection, foreign, event)
	require.ErrorIs(t, err, ErrUnauthorized)
	// Moved-off belongs to T-COL-05's transactional provider. Never silently
	// acknowledge its event while that provider is unavailable.
	moved := event
	moved.Payload = wire.Union(4, wire.Field(1, wire.Union(4)), wire.Field(2, wire.U64(42)), wire.Field(3, []byte(strings.Repeat("a", 20))))
	_, err = pump.Commit(t.Context(), link.Connection, branch, moved)
	require.ErrorIs(t, err, ErrNotReady)
	hint := Event{Payload: wire.Union(1, wire.Field(1, wire.String("a.ts")), wire.Field(2, wire.Union(4)))}
	require.ErrorIs(t, pump.Bursts.Hint(t.Context(), link.Connection, branch, hint), ErrNotReady)
	require.NoError(t, link.Reconciled())
	require.ErrorIs(t, pump.Bursts.Hint(t.Context(), link.Connection, foreign, hint), ErrUnauthorized)
	bad := hint
	bad.Seq = 1
	require.ErrorIs(t, pump.Bursts.Hint(t.Context(), link.Connection, branch, bad), wire.BadValue)
	bad = hint
	bad.Payload = wire.Union(1, wire.Field(1, wire.String("../escape")), wire.Field(2, wire.Union(4)))
	require.ErrorIs(t, pump.Bursts.Hint(t.Context(), link.Connection, branch, bad), wire.BadValue)
	pump.Bursts.ResolveActor = func(context.Context, string, wire.Actor) (json.RawMessage, error) { return nil, ErrUnauthorized }
	require.ErrorIs(t, pump.Bursts.Hint(t.Context(), link.Connection, branch, hint), ErrUnauthorized)
	_, err = pump.Commit(t.Context(), link.Connection, branch, event)
	require.ErrorIs(t, err, ErrUnauthorized)
	// A resolver can rotate admission while it runs; no old-lease hint may
	// publish after it returns, and resolving must not hold the registry lock.
	pump.Bursts.ResolveActor = func(context.Context, string, wire.Actor) (json.RawMessage, error) {
		_, err := registry.MintBoot(branch, "replacement")
		return json.RawMessage(`{"kind":"outside"}`), err
	}
	require.ErrorIs(t, pump.Bursts.Hint(t.Context(), link.Connection, branch, hint), ErrUnauthorized)
	for _, table := range []string{"product_job_events", "burst_files", "machine_event_receipts"} {
		var count int
		require.NoError(t, pool.QueryRow(t.Context(), "SELECT count(*) FROM "+table).Scan(&count))
		require.Zero(t, count, table)
	}
}
