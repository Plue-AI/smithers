package compose

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// The installed consumer, immutable admission references, transaction and HTTP
// controls are production code. Only the authenticated guest transport is a fixture.
func TestMovedOffMachineConsumerThroughInstallHTTP(t *testing.T) {
	f := presenceInstall(t)
	ctx := t.Context()
	_, err := f.pool.Exec(ctx, `UPDATE workspaces SET vm_id='machine' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET workspace_id=$1 WHERE repository_id=$2 AND number=1`, f.row.ID, f.row.RepositoryID)
	require.NoError(t, err)
	config := f.pool.Config()
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	service := services.NewMythicalService(pool, nil)
	registry := new(machined.Registry)
	stop, err := bindMachineEvents(ctx, registry, pool, repohost.NewLocalClient(http.NotFoundHandler(), "fixture"), nil, nil, service)
	require.NoError(t, err)
	t.Cleanup(stop)
	link, guest := presenceTestLink(t, registry, f.row.ID)
	require.NoError(t, link.Reconciled())
	actor, err := machined.CommitActor(ctx, pool, f.row.ID, "machine", func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
		return machined.ActorIdentity{Kind: "person", MemberID: f.user.ID, Via: "ssh"}, nil
	})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	server := httptest.NewUnstartedServer(nil)
	cfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	server.Config.Handler = githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: service}})
	server.Start()
	t.Cleanup(server.Close)
	head, err := hex.DecodeString("1234567890abcdef1234567890abcdef12345678")
	require.NoError(t, err)
	payload := func(returned bool) []byte {
		fields := [][]byte{wire.Field(1, wire.Union(1, wire.Field(1, wire.Bytes(actor)))), wire.Field(2, wire.U64(1)), wire.Field(3, head)}
		if returned {
			fields = append(fields, wire.Field(4, []byte{1}))
		}
		return wire.Union(4, fields...)
	}
	send := func(e machined.Event, outcome machined.AckOutcome) {
		t.Helper()
		require.NoError(t, guest.SetDeadline(time.Now().Add(10*time.Second)))
		require.NoError(t, wire.Write(guest, transcriptEventFrame(e)))
		frame, err := wire.Read(guest)
		require.NoError(t, err)
		require.Equal(t, wire.Events, frame.Kind)
		fields, err := wire.Fields("ack", frame.Payload[1:])
		require.NoError(t, err)
		require.Equal(t, e.Seq, binary.BigEndian.Uint64(fields[1]))
		require.Equal(t, []byte{byte(outcome)}, fields[2])
	}
	event := machined.Event{Seq: 1, EventID: [16]byte{41}, Payload: payload(false)}
	send(event, machined.AckApplied)
	send(event, machined.AckDuplicate)
	read := func() map[string]any {
		t.Helper()
		request, err := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/todos/1", nil)
		require.NoError(t, err)
		request.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		require.Equal(t, 200, response.StatusCode)
		var card map[string]any
		require.NoError(t, json.NewDecoder(response.Body).Decode(&card))
		return card
	}
	card := read()
	require.Equal(t, "needs_you", card["state"])
	waits := card["waits"].([]any)
	require.Len(t, waits, 1)
	wait := waits[0].(map[string]any)
	require.Equal(t, "Alice moved this branch off T1", wait["prompt"])
	require.Equal(t, "presence-owner", wait["by"].(map[string]any)["login"])
	post := func(op, key string) int {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"op": op, "id": wait["id"]})
		request, err := http.NewRequestWithContext(ctx, "POST", server.URL+"/api/todos/1", strings.NewReader(string(body)))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", server.URL)
		request.Header.Set("X-CSRF-Token", "machine-csrf")
		request.AddCookie(&http.Cookie{Name: "__csrf", Value: "machine-csrf"})
		request.Header.Set("Idempotency-Key", key)
		request.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		return response.StatusCode
	}
	require.Equal(t, 202, post("keep-moved", "keep-machine"))
	require.Equal(t, "needs_you", read()["state"])
	require.Equal(t, 409, post("keep-moved", "second-choice"))
	send(machined.Event{Seq: 2, EventID: [16]byte{42}, Payload: payload(true)}, machined.AckApplied)
	require.NotEqual(t, "needs_you", read()["state"])
	var fact []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT moved_off FROM workspaces WHERE id=$1`, f.row.ID).Scan(&fact))
	require.Empty(t, fact)
	// A new move has a new first-answer owner and a production Return adapter.
	send(machined.Event{Seq: 3, EventID: [16]byte{43}, Payload: payload(false)}, machined.AckApplied)
	adapter := machineReturn{registry: registry, pool: pool}
	wait = read()["waits"].([]any)[0].(map[string]any)
	// Remove real host providers through the served command boundary. A ready
	// transport alone cannot authorize a rewrite whose event cannot settle the wait.
	unconsumed := new(machined.Registry)
	unconsumedLink, _ := presenceTestLink(t, unconsumed, f.row.ID)
	require.NoError(t, unconsumedLink.Reconciled())
	// Keep the durable consumer mounted while independently removing each
	// branch transport prerequisite. These registries never replace the live
	// source connection, so the same wait must remain answerable afterward.
	transportRegistry := func() *machined.Registry {
		t.Helper()
		r := new(machined.Registry)
		stop, err := bindMachineEvents(ctx, r, pool, repohost.NewLocalClient(http.NotFoundHandler(), "fixture"), nil, nil, service)
		require.NoError(t, err)
		t.Cleanup(stop)
		t.Cleanup(func() { require.NoError(t, r.Close()) })
		return r
	}
	unbound := transportRegistry()
	unreconciled := transportRegistry()
	presenceTestLink(t, unreconciled, f.row.ID)
	disconnected := transportRegistry()
	disconnectedLink, _ := presenceTestLink(t, disconnected, f.row.ID)
	require.NoError(t, disconnectedLink.Reconciled())
	require.NoError(t, disconnectedLink.Close())
	var referencesBefore int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_actor_references WHERE workspace_id=$1`, f.row.ID).Scan(&referencesBefore))
	for _, missing := range []struct {
		name     string
		provider machineReturn
	}{
		{"database", machineReturn{registry: registry}},
		{"registry", machineReturn{pool: pool}},
		{"event-consumer", machineReturn{registry: unconsumed, pool: pool}},
		{"branch-binding", machineReturn{registry: unbound, pool: pool}},
		{"wake-reconciliation", machineReturn{registry: unreconciled, pool: pool}},
		{"authenticated-connection", machineReturn{registry: disconnected, pool: pool}},
	} {
		t.Run("unavailable-"+missing.name, func(t *testing.T) {
			service.SetMovedOffReturn(missing.provider)
			require.Equal(t, 503, post("return-to-item", "missing-"+missing.name))
			card := read()
			require.Equal(t, "needs_you", card["state"])
			require.NotContains(t, card["waits"].([]any)[0].(map[string]any), "answered_by")
			result, err := missing.provider.ReturnToItem(ctx, f.row.ID, []byte(f.user.Username))
			require.ErrorIs(t, err, machined.ErrNotReady)
			require.Empty(t, result.Head)
			var referencesAfter int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_actor_references WHERE workspace_id=$1`, f.row.ID).Scan(&referencesAfter))
			require.Equal(t, referencesBefore, referencesAfter)
			require.NoError(t, pool.QueryRow(ctx, `SELECT moved_off FROM workspaces WHERE id=$1`, f.row.ID).Scan(&fact))
			require.NotEmpty(t, fact)
		})
	}
	service.SetMovedOffReturn(adapter)
	require.Equal(t, 202, post("return-to-item", "return-machine"))
	require.Equal(t, 409, post("keep-moved", "late-keep-machine"))
	returned := make(chan error, 1)
	go func() {
		result, err := adapter.ReturnToItem(ctx, f.row.ID, []byte(f.user.Username))
		if err == nil && result.Head != "1234567890abcdef1234567890abcdef12345678" {
			err = machined.ErrUnauthorized
		}
		returned <- err
	}()
	request, err := wire.Read(guest)
	require.NoError(t, err)
	id, method, args, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.ReturnToItem), method)
	fields, err := wire.Fields("args12", args)
	require.NoError(t, err)
	principal, err := wire.Fields("principal", fields[1][1:])
	require.NoError(t, err)
	reference := principal[1][4:]
	require.Len(t, reference, 16)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	identity, err := machined.ResolveActorInTx(ctx, tx, f.row.ID, "machine", reference)
	require.NoError(t, err)
	require.Equal(t, f.user.ID, identity.MemberID)
	require.Equal(t, "person", identity.Kind)
	require.NoError(t, tx.Rollback(ctx))
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.ReturnToItem), wire.Field(1, head))))}))
	require.NoError(t, <-returned)
	actor = reference
	send(machined.Event{Seq: 4, EventID: [16]byte{44}, Payload: payload(true)}, machined.AckApplied)
	require.NotEqual(t, "needs_you", read()["state"])
	// Unknown references cannot publish a fact or adopt a current member.
	actor = make([]byte, 16)
	actor[0] = 255
	require.NoError(t, wire.Write(guest, transcriptEventFrame(machined.Event{Seq: 5, EventID: [16]byte{45}, Payload: payload(false)})))
	_, err = wire.Read(guest)
	require.Error(t, err)
	require.NoError(t, pool.QueryRow(ctx, `SELECT moved_off FROM workspaces WHERE id=$1`, f.row.ID).Scan(&fact))
	require.Empty(t, fact)
}
