package machined

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestBatchWritePartialFailureRetainsVerifiedReceipts(t *testing.T) {
	r, _, peer := rpcFixture(t)
	type response struct {
		result WriteResult
		err    error
	}
	done := make(chan response, 1)
	go func() {
		result, err := r.WriteFiles(t.Context(), "a", []byte("actor"), []FileChange{{Path: "first", Content: []byte("a")}, {Path: "second", Content: []byte("b")}})
		done <- response{result, err}
	}()
	digest := sha256.Sum256([]byte("a"))
	receipt := wire.Struct(wire.Field(1, wire.Union(1, wire.Field(1, digest[:]))), wire.Field(2, wire.Struct(wire.Field(1, wire.String("first")), wire.Field(2, digest[:]), wire.Field(3, wire.String("retained-outside")))))
	failure := wire.Struct(wire.Field(1, wire.U16(1)), wire.Field(2, []byte{0}), wire.Field(3, wire.Struct(wire.Field(1, []byte{byte(wire.Internal)}))))
	answer(t, peer, wire.WriteFiles, wire.Field(1, append(wire.U16(1), receipt...)), wire.Field(2, failure))
	got := <-done
	var refusal *SessionError
	require.ErrorAs(t, got.err, &refusal)
	require.Equal(t, "internal", refusal.Code)
	require.Nil(t, got.result.Stale)
	require.Equal(t, []AppliedFile{{"first", hex.EncodeToString(digest[:])}}, got.result.Applied)
	require.Equal(t, []RacedFile{{"first", hex.EncodeToString(digest[:]), "retained-outside"}}, got.result.Raced)
}
func TestBatchWriteRefusesOldProtocolAndBadLaterInputBeforeSending(t *testing.T) {
	r, link, _ := rpcFixture(t)
	link.protocol = 7
	_, err := r.WriteFiles(t.Context(), "a", []byte("actor"), []FileChange{{Path: "first"}})
	var refusal *SessionError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, "unsupported", refusal.Code)
	link.protocol = wire.Protocol
	badDigest := "not a digest"
	for _, bad := range []FileChange{{Path: "../escape"}, {Path: "first"}, {Path: "first/child"}, {Path: "second", BaseDigest: &badDigest}, {Path: "second", Content: []byte{255}}} {
		result, err := r.WriteFiles(t.Context(), "a", []byte("actor"), []FileChange{{Path: "first", Content: []byte("a")}, bad})
		require.ErrorIs(t, err, wire.BadValue)
		require.Empty(t, result.Applied)
	}
}
func TestBatchWriteRejectsContradictoryOrWrongReceipts(t *testing.T) {
	for _, kind := range []string{"short", "digest", "race_path", "stale_after_write", "failure_index"} {
		t.Run(kind, func(t *testing.T) {
			r, _, peer := rpcFixture(t)
			done := make(chan error, 1)
			go func() {
				_, err := r.WriteFiles(t.Context(), "a", []byte("actor"), []FileChange{{Path: "first", Content: []byte("a")}, {Path: "second", Content: []byte("b")}})
				done <- err
			}()
			digest := sha256.Sum256([]byte("a"))
			if kind == "digest" {
				digest[0] ^= 255
			}
			receiptFields := [][]byte{wire.Field(1, wire.Union(1, wire.Field(1, digest[:])))}
			if kind == "race_path" {
				receiptFields = append(receiptFields, wire.Field(2, wire.Struct(wire.Field(1, wire.String("foreign")), wire.Field(2, digest[:]), wire.Field(3, wire.String("retained-outside")))))
			}
			fields := [][]byte{wire.Field(1, append(wire.U16(1), wire.Struct(receiptFields...)...))}
			if kind == "stale_after_write" || kind == "failure_index" {
				index := uint16(1)
				preflight := byte(1)
				if kind == "failure_index" {
					index = 2
					preflight = 0
				}
				fields = append(fields, wire.Field(2, wire.Struct(wire.Field(1, wire.U16(index)), wire.Field(2, []byte{preflight}), wire.Field(3, wire.Struct(wire.Field(1, []byte{byte(wire.Stale)}))))))
			}
			answer(t, peer, wire.WriteFiles, fields...)
			require.ErrorIs(t, <-done, wire.BadValue)
		})
	}
}

func TestBatchWriteAllSuccessIncludesEmptyFile(t *testing.T) {
	r, _, peer := rpcFixture(t)
	type response struct {
		result WriteResult
		err    error
	}
	done := make(chan response, 1)
	go func() {
		v, e := r.WriteFiles(t.Context(), "a", []byte("actor"), []FileChange{{Path: "empty", Content: []byte{}}, {Path: "text", Content: []byte("text")}})
		done <- response{v, e}
	}()
	receipts := wire.U16(2)
	for _, content := range [][]byte{nil, []byte("text")} {
		d := sha256.Sum256(content)
		receipts = append(receipts, wire.Struct(wire.Field(1, wire.Union(1, wire.Field(1, d[:]))))...)
	}
	answer(t, peer, wire.WriteFiles, wire.Field(1, receipts))
	got := <-done
	require.NoError(t, got.err)
	require.Nil(t, got.result.Stale)
	require.Empty(t, got.result.Raced)
	require.Len(t, got.result.Applied, 2)
	require.Equal(t, "empty", got.result.Applied[0].Path)
	require.Equal(t, "text", got.result.Applied[1].Path)
}

func TestBatchReceiptUsesEncodedSnapshotWhenCallerReusesBuffers(t *testing.T) {
	r, _, peer := rpcFixture(t)
	data := []byte("before")
	changes := []FileChange{{Path: "first", Content: data}}
	type response struct {
		result WriteResult
		err    error
	}
	done := make(chan response, 1)
	go func() { v, e := r.WriteFiles(t.Context(), "a", []byte("actor"), changes); done <- response{v, e} }()
	request, err := wire.Read(peer)
	require.NoError(t, err)
	id, method, _, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.WriteFiles), method)
	copy(data, []byte("reused"))
	changes[0].Path = "different"
	digest := sha256.Sum256([]byte("before"))
	receipts := append(wire.U16(1), wire.Struct(wire.Field(1, wire.Union(1, wire.Field(1, digest[:]))))...)
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.WriteFiles), wire.Field(1, receipts))))}))
	got := <-done
	require.NoError(t, got.err)
	require.Equal(t, []AppliedFile{{"first", hex.EncodeToString(digest[:])}}, got.result.Applied)
}

func TestDeleteAndEmptyWriteEncodeDistinctMutationsAndReceipts(t *testing.T) {
	for _, mismatch := range []bool{false, true} {
		t.Run(map[bool]string{false: "valid", true: "contradictory"}[mismatch], func(t *testing.T) {
			r, _, peer := rpcFixture(t)
			type response struct {
				result WriteResult
				err    error
			}
			done := make(chan response, 1)
			changes := []FileChange{{Path: "deleted", Content: nil}, {Path: "empty", Content: []byte{}}}
			go func() { v, e := r.WriteFiles(t.Context(), "a", []byte("actor"), changes); done <- response{v, e} }()
			request, err := wire.Read(peer)
			require.NoError(t, err)
			id, method, args, err := request.Request()
			require.NoError(t, err)
			require.Equal(t, byte(wire.WriteFiles), method)
			fields, err := wire.Fields("args17", args)
			require.NoError(t, err)
			items, err := wire.List("local_mutation", fields[1])
			require.NoError(t, err)
			require.Len(t, items, 2)
			deleted, err := wire.Fields("local_mutation", items[0])
			require.NoError(t, err)
			require.NotContains(t, deleted, byte(3))
			empty, err := wire.Fields("local_mutation", items[1])
			require.NoError(t, err)
			require.Equal(t, wire.Bytes([]byte{}), empty[3])
			// Reusing the caller's slice cannot change nil-vs-empty receipt validation.
			changes[0].Content = []byte{}
			changes[1].Content = nil
			d := sha256.Sum256(nil)
			gone, exists := wire.Union(2), wire.Union(1, wire.Field(1, d[:]))
			if mismatch {
				gone, exists = exists, gone
			}
			receipts := append(wire.U16(2), wire.Struct(wire.Field(1, gone))...)
			receipts = append(receipts, wire.Struct(wire.Field(1, exists))...)
			require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.WriteFiles), wire.Field(1, receipts))))}))
			got := <-done
			if mismatch {
				require.ErrorIs(t, got.err, wire.BadValue)
			} else {
				require.NoError(t, got.err)
				require.Equal(t, []AppliedFile{{"deleted", "absent"}, {"empty", hex.EncodeToString(d[:])}}, got.result.Applied)
			}
		})
	}
}
