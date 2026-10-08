package machined

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"path"
	"strings"
	"unicode/utf8"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// WorkspaceWriter submits one compared daemon batch. Only a complete receipt
// is success; only a zero-write preflight receipt is stale. Application failures
// may retain a durable prefix and must never be reported as stale or success.
type WorkspaceWriter struct {
	// EnsureReady starts/adopts the installed daemon only after admission and
	// complete request validation. Runtime composition supplies its lifecycle.
	EnsureReady func(context.Context, string) error
	Client      interface {
		WriteFiles(context.Context, string, []byte, []FileChange) (WriteResult, error)
	}
}

func (w WorkspaceWriter) CompareWriteFiles(ctx context.Context, workspaceID string, changes []workspaceapi.FileMutation) (*workspaceapi.FileWriteResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	op, ok := workspaceapi.OperationFromContext(ctx)
	// Agent writes must use the local registered-run socket. The host RPC's
	// principal actor cannot stand in for a run, even with a valid S1 grant.
	if !ok || op.Automated || op.PrincipalID == "" || len(op.PrincipalID) > 1024 || op.TenantID == "" || op.OperationID == "" || workspaceID == "" || w.Client == nil || len(changes) == 0 || len(changes) > 256 {
		return nil, workspaceapi.ErrCompareWriteUnavailable
	}
	batch := make([]FileChange, len(changes))
	paths := make(map[string]bool, len(changes))
	total := 0
	for i, c := range changes {
		total += len(c.Content)
		if !utf8.ValidString(c.Path) || !utf8.Valid(c.Content) || c.Path == "" || len(c.Path) > 4096 || c.Path == "." || path.IsAbs(c.Path) || path.Clean(c.Path) != c.Path || c.Path == ".." || strings.HasPrefix(c.Path, "../") || strings.ContainsRune(c.Path, 0) || paths[c.Path] || total > 1<<20 {
			return nil, workspaceapi.ErrCompareWriteUnavailable
		}
		paths[c.Path] = true
		var base *string
		if c.BaseDigest != "absent" {
			if !fileDigest(c.BaseDigest) {
				return nil, workspaceapi.ErrCompareWriteUnavailable
			}
			value := c.BaseDigest
			base = &value
		}
		var content []byte
		if c.Content != nil {
			content = append([]byte{}, c.Content...)
		}
		batch[i] = FileChange{Path: c.Path, BaseDigest: base, Content: content}
	}
	for name := range paths {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if paths[parent] {
				return nil, workspaceapi.ErrCompareWriteUnavailable
			}
		}
	}
	if w.EnsureReady != nil {
		if err := w.EnsureReady(ctx, workspaceID); err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, workspaceapi.ErrCompareWriteUnavailable
		}
	}
	result, err := w.Client.WriteFiles(ctx, workspaceID, []byte(op.PrincipalID), batch)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, workspaceapi.ErrCompareWriteUnavailable
	}
	if result.Stale != nil {
		current := "absent"
		if result.Stale.CurrentDigest != nil {
			current = *result.Stale.CurrentDigest
			if !fileDigest(current) {
				return nil, workspaceapi.ErrCompareWriteUnavailable
			}
		}
		if !paths[result.Stale.Path] || len(result.Applied) != 0 || len(result.Raced) != 0 {
			return nil, workspaceapi.ErrCompareWriteUnavailable
		}
		return nil, &workspaceapi.StaleFileError{Path: result.Stale.Path, CurrentDigest: current}
	}
	if len(result.Applied) != len(batch) || len(result.Raced) > len(batch) {
		return nil, workspaceapi.ErrCompareWriteUnavailable
	}
	receipt := &workspaceapi.FileWriteResult{Paths: make([]workspaceapi.FileMutationResult, 0, len(batch)), Raced: []workspaceapi.FileRace{}}
	for i, c := range batch {
		expected := "absent"
		if c.Content != nil {
			digest := sha256.Sum256(c.Content)
			expected = hex.EncodeToString(digest[:])
		}
		if result.Applied[i].Path != c.Path || result.Applied[i].PostDigest != expected {
			return nil, workspaceapi.ErrCompareWriteUnavailable
		}
		receipt.Paths = append(receipt.Paths, workspaceapi.FileMutationResult{Path: c.Path, Digest: expected})
	}
	seenRaces := make(map[string]bool)
	for _, raced := range result.Raced {
		if !paths[raced.Path] || seenRaces[raced.Path] || !fileDigest(raced.DisplacedDigest) {
			return nil, workspaceapi.ErrCompareWriteUnavailable
		}
		seenRaces[raced.Path] = true
		receipt.Raced = append(receipt.Raced, workspaceapi.FileRace{Path: raced.Path, Version: raced.DisplacedDigest})
	}
	return receipt, nil
}

func fileDigest(digest string) bool {
	b, err := hex.DecodeString(digest)
	return err == nil && len(b) == sha256.Size && hex.EncodeToString(b) == digest
}
