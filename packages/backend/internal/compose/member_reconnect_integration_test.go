package compose

import (
	"bytes"
	"context"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// The broker peer is test-only; this proves the composed HTTP mutation reaches
// the authenticated production link before ready, not guest cgroup termination.
func exerciseRevocationReconnect(t *testing.T, pool *pgxpool.Pool, writer db.User,
	request func(string, string, string, string) (int, string), signIn func()) {
	t.Helper()
	ctx := t.Context()
	signIn()
	var branch string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name)
 SELECT c.repository_id,o.user_id,'reconnect-proof' FROM collaborators c CROSS JOIN self_host_owners o
 WHERE c.user_id=$1 RETURNING id::text`, writer.ID).Scan(&branch))
	var ownerLogin string
	var ownerUID uint32
	require.NoError(t, pool.QueryRow(ctx, `SELECT c.unix_login,c.unix_uid FROM collaborators c JOIN self_host_owners o ON o.user_id=c.user_id`).Scan(&ownerLogin, &ownerUID))
	ownerEntry := wire.Struct(wire.Field(1, wire.String(ownerLogin)), wire.Field(2, wire.U32(ownerUID)))
	registry := new(machined.Registry)
	registry.BindObjectExporter(func(context.Context, string, string, uint32) (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader("roster fixture bundle")), nil
	})
	roster := &machineRoster{pool: pool, client: registry}
	registry.BindRosterSync(roster.syncBranch)
	authority, err := registry.MintBoot(branch, "reconnect-proof")
	require.NoError(t, err)
	defer registry.Close()
	connect := func() (*machined.Link, net.Conn) {
		t.Helper()
		host, peer := net.Pipe()
		t.Cleanup(func() { host.Close(); peer.Close() })
		require.NoError(t, peer.SetDeadline(time.Now().Add(5*time.Second)))
		done := make(chan error, 1)
		go func() {
			nonce := make([]byte, 32)
			nonce[0] = 7
			if err := wire.Write(peer, wire.Frame{Kind: wire.Hello, Payload: wire.Union(1,
				wire.Field(1, wire.U32(0x534d4d44)), wire.Field(2, wire.U16(wire.Protocol)),
				wire.Field(3, authority.ID[:]), wire.Field(4, nonce))}); err != nil {
				done <- err
				return
			}
			proof, err := wire.Read(peer)
			if err != nil {
				done <- err
				return
			}
			fields, err := wire.Fields("proof", proof.Payload[1:])
			if err != nil {
				done <- err
				return
			}
			if !wire.VerifyHostMAC(authority.Secret[:], authority.ID[:], nonce, fields[2]) {
				done <- wire.AuthFailed
				return
			}
			if err = wire.Write(peer, wire.Frame{Kind: wire.Hello, Payload: wire.Union(3,
				wire.Field(1, wire.Bytes([]byte(authority.Credential))), wire.Field(2, make([]byte, 16)),
				wire.Field(3, wire.U64(1)), wire.Field(4, wire.U16(0)))}); err != nil {
				done <- err
				return
			}
			welcome, err := wire.Read(peer)
			if err == nil && (welcome.Kind != wire.Hello || welcome.Payload[0] != 4) {
				err = wire.HandshakeOrder
			}
			done <- err
		}()
		link, err := registry.Connect(ctx, branch, host)
		require.NoError(t, err)
		require.NoError(t, <-done)
		return link, peer
	}
	reply := func(peer net.Conn, expected wire.Method, fields ...[]byte) []byte {
		t.Helper()
		frame, err := wire.Read(peer)
		require.NoError(t, err)
		id, method, args, err := frame.Request()
		require.NoError(t, err)
		require.Equal(t, byte(expected), method)
		require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2,
			wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(method, fields...)))}))
		return args
	}
	maximum := time.Duration(0)
	for run := 1; run <= 20; run++ {
		var uid uint32
		require.NoError(t, pool.QueryRow(ctx, `SELECT unix_uid FROM collaborators WHERE user_id=$1`, writer.ID).Scan(&uid))
		// Establish the live link, then partition it before the HTTP removal.
		link, peer := connect()
		synced := make(chan error, 1)
		go func() { synced <- roster.syncBranch(ctx, branch) }()
		args := reply(peer, wire.SetRoster)
		require.True(t, bytes.Contains(args, wire.Struct(wire.Field(1, wire.String("writer")), wire.Field(2, wire.U32(uid)))))
		require.NoError(t, <-synced)
		require.NoError(t, link.Close())
		peer.Close()
		status, body := request("DELETE", "/api/members/writer", "", "owner-cookie")
		require.Equal(t, 204, status, body)
		require.Error(t, roster.syncBranch(ctx, branch), "partitioned link cannot certify cleanup")
		link, peer = connect()
		started := time.Now()
		admitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		admitted := make(chan error, 1)
		go func() {
			admitted <- registry.AdmitReady(admitCtx, branch, strings.Repeat("a", 40), []machined.SessionUser{{Login: "writer", UID: uid}})
		}()
		frame, err := wire.Read(peer)
		require.NoError(t, err)
		id, method, args, err := frame.Request()
		require.NoError(t, err)
		require.Equal(t, byte(wire.SetRoster), method, "cleanup precedes wake reconciliation")
		require.False(t, bytes.Contains(args, wire.String("writer")), "stale caller roster cannot resurrect removed member")
		require.True(t, bytes.Contains(args, ownerEntry), "revocation retains the owner on the same branch")
		require.ErrorIs(t, link.RequireReady(branch), machined.ErrNotReady, "handshake alone is not cleanup")
		select {
		case err := <-admitted:
			t.Fatalf("admitted before broker cleanup reply: %v", err)
		default:
		}
		require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2,
			wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.SetRoster))))}))
		for {
			frame, err := wire.Read(peer)
			require.NoError(t, err)
			require.Equal(t, wire.Objects, frame.Kind)
			require.GreaterOrEqual(t, frame.Stream, uint32(0x80000000))
			if frame.Payload[0] == 2 {
				require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: frame.Stream, Payload: []byte{7}}))
				break
			}
			require.Equal(t, byte(1), frame.Payload[0])
			require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: frame.Stream, Payload: append([]byte{6}, wire.U32(uint32(len(frame.Payload)-2))...)}))
		}
		reply(peer, wire.WakeReconcile, wire.Field(1, wire.Union(1)))
		reply(peer, wire.Status, wire.Field(1, []byte{3}), wire.Field(2, wire.U16(1)),
			wire.Field(3, wire.String("guest")), wire.Field(4, wire.U32(0)), wire.Field(6, wire.U16(0)))
		require.NoError(t, <-admitted)
		require.NoError(t, link.RequireReady(branch))
		elapsed := time.Since(started)
		require.LessOrEqual(t, elapsed, 5*time.Second)
		maximum = max(maximum, elapsed)
		t.Logf("run=%d boundary=authenticated-link handshake_to_ready_seconds=%.6f", run, elapsed.Seconds())
		cancel()
		require.NoError(t, link.Close())
		peer.Close()
		status, body = request("POST", "/api/members", `{"login":"writer"}`, "owner-cookie")
		require.Equal(t, 204, status, body)
		signIn()
	}
	t.Logf("authenticated link max over 20 runs: %.6f seconds; guest process death not measured", maximum.Seconds())
}
