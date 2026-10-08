package microsandbox

import (
	"encoding/hex"
	"io/fs"
	"net"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// Only the remote daemon is scripted. Runtime admission, authenticated host
// transport, RPC decoding and digest validation are production implementations.
func TestDaemonReadFileAdmittedBoot(t *testing.T) {
	r := &Runtime{config: Config{FileReadLimit: 4}, workspaces: map[string]*workspace{"a": newWorkspace(metadata{ID: "a", Machine: "vm", State: "running"}, "")}}
	authority, err := r.machined.MintBoot("a", "vm")
	require.NoError(t, err)
	host, peer := net.Pipe()
	require.NoError(t, peer.SetDeadline(time.Now().Add(5*time.Second)))
	t.Cleanup(func() { host.Close(); peer.Close() })
	done := make(chan error, 1)
	go func() {
		nonce := make([]byte, 32)
		nonce[0] = 41
		err := wire.Write(peer, wire.Frame{Kind: wire.Hello, Payload: wire.Union(1, wire.Field(1, wire.U32(0x534d4d44)), wire.Field(2, wire.U16(wire.Protocol)), wire.Field(3, authority.ID[:]), wire.Field(4, nonce))})
		if err != nil {
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
		if !wire.VerifyHostMAC(authority.Secret[:], wire.Protocol, authority.ID[:], nonce, fields[2]) {
			done <- wire.AuthFailed
			return
		}
		err = wire.Write(peer, wire.Frame{Kind: wire.Hello, Payload: wire.Union(3, wire.Field(1, wire.Bytes([]byte(authority.Credential))), wire.Field(2, make([]byte, 16)), wire.Field(3, wire.U64(1)), wire.Field(4, wire.U16(0)))})
		if err != nil {
			done <- err
			return
		}
		_, err = wire.Read(peer)
		done <- err
	}()
	link, err := r.machined.Connect(t.Context(), "a", host)
	require.NoError(t, err)
	require.NoError(t, <-done)
	t.Cleanup(func() { link.Close() })
	// Authentication alone must not admit ordinary reads.
	_, err = r.machined.ReadFile(t.Context(), "a", "README.md", "")
	require.Error(t, err)
	require.NoError(t, link.Reconciled())
	digest, err := hex.DecodeString("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
	require.NoError(t, err)
	for _, tc := range []struct {
		name    string
		missing bool
		limit   int64
	}{
		{"bounded", false, 5}, {"oversize", false, 4}, {"missing", true, 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r.config.FileReadLimit = tc.limit
			type response struct {
				data []byte
				err  error
			}
			result := make(chan response, 1)
			go func() {
				data, err := r.ReadWorkingCopyFile(t.Context(), "a", "README.md")
				result <- response{data, err}
			}()
			request, err := wire.Read(peer)
			require.NoError(t, err)
			id, method, args, err := request.Request()
			require.NoError(t, err)
			require.Equal(t, byte(wire.ReadFile), method)
			fields, err := wire.Fields("args2", args)
			require.NoError(t, err)
			require.Equal(t, wire.String("README.md"), fields[1])
			require.Len(t, fields, 1)
			reply := wire.Union(byte(wire.ReadFile), wire.Field(1, wire.Bytes([]byte("hello"))), wire.Field(2, digest), wire.Field(3, wire.U32(420)))
			if tc.missing {
				reply = wire.Union(255, wire.Field(1, []byte{5}))
			}
			require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, reply))}))
			got := <-result
			if tc.missing {
				require.ErrorIs(t, got.err, fs.ErrNotExist)
				require.Nil(t, got.data)
			} else if tc.limit < 5 {
				require.Error(t, got.err)
				require.Nil(t, got.data)
			} else {
				require.NoError(t, got.err)
				require.Equal(t, []byte("hello"), got.data)
			}
		})
	}
}
