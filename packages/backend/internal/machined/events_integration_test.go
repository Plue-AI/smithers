package machined

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	boot := [16]byte{1}
	secret := []byte("w6-boot")
	require.NoError(t, registry.BindBoot(branch, "vm", boot, secret))
	connection, err := registry.Admit(boot, secret, io.NopCloser(strings.NewReader("")))
	require.NoError(t, err)
	defer connection.Close()
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
	ack, err = s.Apply(ctx, connection, scope, event)
	require.NoError(t, err)
	require.Equal(t, AckApplied, ack.Outcome)
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
