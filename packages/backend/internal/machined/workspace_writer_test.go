package machined

import (
	"context"
	"encoding/hex"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestWorkspaceWriterAuthenticatedRPC(t *testing.T) {
	const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	for _, scenario := range []string{"create", "replace", "stale", "absent-stale", "raced"} {
		t.Run(scenario, func(t *testing.T) {
			r, _, peer := rpcFixture(t)
			ctx := workspaceapi.WithOperation(t.Context(), workspaceapi.Operation{TenantID: "1", PrincipalID: "9", OperationID: "write"})
			base := "absent"
			if scenario != "create" {
				base = digest
			}
			type outcome struct {
				receipt *workspaceapi.FileWriteResult
				err     error
			}
			done := make(chan outcome, 1)
			readyCalls := 0
			go func() {
				receipt, err := (WorkspaceWriter{Client: r, EnsureReady: func(ctx context.Context, id string) error {
					readyCalls++
					require.Equal(t, "a", id)
					op, ok := workspaceapi.OperationFromContext(ctx)
					require.True(t, ok)
					require.Equal(t, "9", op.PrincipalID)
					return nil
				}}).CompareWriteFiles(ctx, "a", []workspaceapi.FileMutation{{Path: "hello", BaseDigest: base, Content: []byte("hello")}})
				done <- outcome{receipt, err}
			}()
			frame, err := wire.Read(peer)
			require.NoError(t, err)
			id, method, args, err := frame.Request()
			require.NoError(t, err)
			require.Equal(t, byte(wire.WriteFiles), method)
			batch, err := wire.Fields("args17", args)
			require.NoError(t, err)
			require.Equal(t, principal([]byte("9")), batch[2])
			changes, err := wire.List("local_mutation", batch[1])
			require.NoError(t, err)
			require.Len(t, changes, 1)
			fields, err := wire.Fields("local_mutation", changes[0])
			require.NoError(t, err)
			require.Equal(t, wire.String("hello"), fields[1])
			d, _ := hex.DecodeString(digest)
			wantBase := wire.Union(2)
			if base != "absent" {
				wantBase = wire.Union(1, wire.Field(1, d))
			}
			require.Equal(t, wantBase, fields[2])
			writeFields := [][]byte{wire.Field(1, wire.Union(1, wire.Field(1, d)))}
			resultFields := [][]byte{}
			if scenario == "stale" || scenario == "absent-stale" {
				fs := [][]byte{wire.Field(1, []byte{byte(wire.Stale)}), wire.Field(2, wire.String("hello"))}
				if scenario == "stale" {
					fs = append(fs, wire.Field(3, d))
				}
				resultFields = append(resultFields, wire.Field(1, wire.U16(0)), wire.Field(2, wire.Struct(wire.Field(1, wire.U16(0)), wire.Field(2, []byte{1}), wire.Field(3, wire.Struct(fs...)))))
			} else if scenario == "raced" {
				writeFields = append(writeFields, wire.Field(2, wire.Struct(wire.Field(1, wire.String("hello")), wire.Field(2, d))))
			}
			if len(resultFields) == 0 {
				resultFields = append(resultFields, wire.Field(1, append(wire.U16(1), wire.Struct(writeFields...)...)))
			}
			response := wire.Union(byte(wire.WriteFiles), resultFields...)
			require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, response))}))
			got := <-done
			require.Equal(t, 1, readyCalls)
			if scenario == "stale" || scenario == "absent-stale" {
				var stale *workspaceapi.StaleFileError
				require.ErrorAs(t, got.err, &stale)
				current := digest
				if scenario == "absent-stale" {
					current = "absent"
				}
				require.Equal(t, &workspaceapi.StaleFileError{Path: "hello", CurrentDigest: current}, stale)
				require.Nil(t, got.receipt)
			} else {
				require.NoError(t, got.err)
				require.Equal(t, []workspaceapi.FileMutationResult{{Path: "hello", Digest: digest}}, got.receipt.Paths)
				require.NotNil(t, got.receipt.Raced)
				if scenario == "raced" {
					require.Equal(t, []workspaceapi.FileRace{{Path: "hello", Version: digest}}, got.receipt.Raced)
				} else {
					require.Empty(t, got.receipt.Raced)
				}
			}
		})
	}
}

type forbiddenWriter struct{ t *testing.T }

func (f forbiddenWriter) WriteFiles(context.Context, string, []byte, []FileChange) (WriteResult, error) {
	f.t.Fatal("unsupported mutation dispatched")
	return WriteResult{}, nil
}

func TestWorkspaceWriterRefusesBeforeDispatch(t *testing.T) {
	for _, scenario := range []string{"identity", "agent", "batch", "delete", "base", "path", "size", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			op := workspaceapi.Operation{TenantID: "1", PrincipalID: "9", OperationID: "write"}
			changes := []workspaceapi.FileMutation{{Path: "a", BaseDigest: "absent", Content: []byte{}}}
			switch scenario {
			case "identity":
				op.PrincipalID = ""
			case "agent":
				op.Automated = true
			case "batch":
				changes = append(changes, changes[0])
			case "delete":
				changes[0].Content = nil
			case "base":
				changes[0].BaseDigest = "bad"
			case "path":
				changes[0].Path = "../outside"
			case "size":
				changes[0].Content = make([]byte, (1<<20)+1)
			}
			ctx, cancel := context.WithCancel(workspaceapi.WithOperation(t.Context(), op))
			defer cancel()
			if scenario == "cancel" {
				cancel()
			}
			_, err := (WorkspaceWriter{Client: forbiddenWriter{t}, EnsureReady: func(context.Context, string) error {
				t.Fatal("refused request started a daemon")
				return nil
			}}).CompareWriteFiles(ctx, "a", changes)
			if scenario == "cancel" {
				require.ErrorIs(t, err, context.Canceled)
			} else {
				require.ErrorIs(t, err, workspaceapi.ErrCompareWriteUnavailable)
			}
		})
	}
}

func TestWorkspaceWriterReadinessFailureNeverDispatches(t *testing.T) {
	for _, canceled := range []bool{false, true} {
		t.Run(map[bool]string{false: "unavailable", true: "canceled"}[canceled], func(t *testing.T) {
			ctx, cancel := context.WithCancel(workspaceapi.WithOperation(t.Context(), workspaceapi.Operation{TenantID: "1", PrincipalID: "9", OperationID: "write"}))
			defer cancel()
			calls := 0
			writer := WorkspaceWriter{Client: forbiddenWriter{t}, EnsureReady: func(context.Context, string) error {
				calls++
				if canceled {
					cancel()
					return ctx.Err()
				}
				return ErrNotReady
			}}
			receipt, err := writer.CompareWriteFiles(ctx, "a", []workspaceapi.FileMutation{{Path: "a", BaseDigest: "absent", Content: []byte("new")}})
			require.Nil(t, receipt)
			require.Equal(t, 1, calls)
			if canceled {
				require.ErrorIs(t, err, context.Canceled)
			} else {
				require.ErrorIs(t, err, workspaceapi.ErrCompareWriteUnavailable)
			}
		})
	}
}
