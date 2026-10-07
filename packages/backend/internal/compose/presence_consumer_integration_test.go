package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestPresenceProductionSessionConsumerThroughInstall(t *testing.T) {
	f := presenceInstall(t)
	_, err := f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid)
 VALUES($1,$2,'admin','maya',20001) ON CONFLICT(repository_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET unix_login='maya',unix_uid=20001`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	reader := f.dial(t)
	sendPresenceFrame(t, reader, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	readPresenceFrame(t, reader)
	registry := new(machined.Registry)
	link, guest := presenceTestLink(t, registry, f.row.ID)
	require.NoError(t, link.Reconciled())
	sessions := machined.NewSessions(link.Connection, f.row.ID, registry.Sessions(f.row.ID)).WithPresenceVia("ssh")
	opened := make(chan error, 1)
	go func() {
		id, err := sessions.OpenSession(t.Context(), machined.SessionUser{Login: "maya", UID: 20001}, machined.SessionPTY, nil, nil)
		if err == nil && id != 1 {
			err = fmt.Errorf("session %d", id)
		}
		opened <- err
	}()
	request, err := wire.Read(guest)
	require.NoError(t, err)
	id, method, _, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.OpenSession), method)
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.OpenSession), wire.Field(1, wire.U32(1)))))}))
	require.NoError(t, <-opened)
	// Identity must come from the successful host RPC and committed allocation.
	resolver := f.p.sessionResolver(link)
	binding, err := resolver(t.Context(), f.row.ID, 1)
	require.NoError(t, err)
	require.Equal(t, presenceSessionBinding{Member: f.user.ID, Name: "Alice", Kind: "person", Via: "ssh"}, binding)
	_, err = resolver(t.Context(), f.row.ID, 2)
	require.ErrorIs(t, err, machined.ErrUnauthorized)
	stop := f.p.consumeDaemons(t.Context(), registry)
	defer stop()
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Presence, Payload: wire.Union(1, wire.Field(1, append(wire.U16(1), wire.Struct(wire.Field(1, wire.U32(1)), wire.Field(2, wire.String("retry.ts")))...)))}))
	var card struct {
		Presence []struct {
			Actor map[string]any
			Where map[string]any
		}
	}
	deadline := time.Now().Add(time.Second)
	for {
		frame := readPresenceFrame(t, reader)
		require.NoError(t, json.Unmarshal(frame.Data, &card))
		if len(card.Presence) == 1 {
			break
		}
		require.True(t, time.Now().Before(deadline), "daemon location missing")
	}
	require.Equal(t, "ssh", card.Presence[0].Actor["via"])
	require.Equal(t, "retry.ts", card.Presence[0].Where["path"])

	// An independently admitted external agent has its own broker session. Its
	// lifetime must end while the person's terminal and lease remain open.
	exchange := func(method wire.Method, fields [][]byte, body func() error) {
		result := make(chan error, 1)
		go func() { result <- body() }()
		req, err := wire.Read(guest)
		require.NoError(t, err)
		id, got, _, err := req.Request()
		require.NoError(t, err)
		require.Equal(t, byte(method), got)
		require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(method), fields...)))}))
		require.NoError(t, <-result)
	}
	exchange(wire.OpenSession, [][]byte{wire.Field(1, wire.U32(2))}, func() error {
		id, err := sessions.OpenSession(t.Context(), machined.SessionUser{Login: "agent", UID: 19999}, machined.SessionExec, []string{"codex"}, nil)
		if err == nil && id != 2 {
			return fmt.Errorf("session %d", id)
		}
		return err
	})
	_, err = resolver(t.Context(), f.row.ID, 2)
	require.ErrorIs(t, err, machined.ErrUnauthorized, "unregistered agent must refuse")
	exchange(wire.RegisterRun, nil, func() error { return sessions.RegisterRun(t.Context(), "external-run", 2) })
	binding, err = resolver(t.Context(), f.row.ID, 2)
	require.NoError(t, err)
	require.Equal(t, "run:external-run", binding.Participant)
	require.Equal(t, "external", binding.AgentKind)
	require.Equal(t, "external-run", binding.Run)
	locations := append(wire.U16(2), wire.Struct(wire.Field(1, wire.U32(1)), wire.Field(2, wire.String("retry.ts")))...)
	locations = append(locations, wire.Struct(wire.Field(1, wire.U32(2)))...)
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Presence, Payload: wire.Union(1, wire.Field(1, locations))}))
	frame := readPresenceFrame(t, reader)
	require.NoError(t, json.Unmarshal(frame.Data, &card))
	require.Len(t, card.Presence, 2)
	foundAgent := false
	for _, actor := range card.Presence {
		if actor.Actor["kind"] == "agent" {
			foundAgent = true
			require.Equal(t, "external-run", actor.Actor["run_id"])
			require.Equal(t, "external", actor.Actor["agent"])
		}
	}
	require.True(t, foundAgent)
	exchange(wire.CloseSession, nil, func() error { return sessions.CloseSession(t.Context(), 2) })
	_, err = resolver(t.Context(), f.row.ID, 2)
	require.ErrorIs(t, err, machined.ErrUnauthorized)
	locations = append(wire.U16(1), wire.Struct(wire.Field(1, wire.U32(1)), wire.Field(2, wire.String("retry.ts")))...)
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Presence, Payload: wire.Union(1, wire.Field(1, locations))}))
	frame = readPresenceFrame(t, reader)
	require.NoError(t, json.Unmarshal(frame.Data, &card))
	require.Len(t, card.Presence, 1)
	require.Equal(t, "person", card.Presence[0].Actor["kind"])
	require.NoError(t, guest.Close())
	frame = readPresenceFrame(t, reader)
	require.NoError(t, json.Unmarshal(frame.Data, &card))
	require.Empty(t, card.Presence, "clean close must remove the boot immediately")
	// A changed allocation cannot inherit the old admitted Unix identity.
	_, err = f.pool.Exec(context.Background(), `UPDATE collaborators SET unix_uid=20002 WHERE repository_id=$1 AND user_id=$2`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	_, err = f.p.queries.PresenceSessionMember(t.Context(), f.row.RepositoryID, "maya", 20001)
	require.Error(t, err)
}
