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

// WorkspaceWriter adapts the authenticated daemon's single-file RPC to the
// workspace mutation boundary. ADR 0004 currently has no atomic batch or
// deletion request. Refuse those before sending anything, rather than expose
// WriteFiles' ordered, partially applied semantics as a transaction.
type WorkspaceWriter struct {
	Client interface {
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
	if !ok || op.Automated || op.PrincipalID == "" || len(op.PrincipalID) > 1024 || op.TenantID == "" || op.OperationID == "" || workspaceID == "" || w.Client == nil || len(changes) != 1 || changes[0].Content == nil {
		return nil, workspaceapi.ErrCompareWriteUnavailable
	}
	c := changes[0]
	if !utf8.ValidString(c.Path) || c.Path == "" || len(c.Path) > 4096 || c.Path == "." || path.IsAbs(c.Path) || path.Clean(c.Path) != c.Path || c.Path == ".." || strings.HasPrefix(c.Path, "../") || strings.ContainsRune(c.Path, 0) || len(c.Content) > 1<<20 {
		return nil, workspaceapi.ErrCompareWriteUnavailable
	}
	var base *string
	if c.BaseDigest != "absent" {
		if !fileDigest(c.BaseDigest) {
			return nil, workspaceapi.ErrCompareWriteUnavailable
		}
		base = &c.BaseDigest
	}
	result, err := w.Client.WriteFiles(ctx, workspaceID, []byte(op.PrincipalID), []FileChange{{Path: c.Path, BaseDigest: base, Content: append([]byte{}, c.Content...)}})
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
		if result.Stale.Path != c.Path || len(result.Applied) != 0 || len(result.Raced) != 0 {
			return nil, workspaceapi.ErrCompareWriteUnavailable
		}
		return nil, &workspaceapi.StaleFileError{Path: c.Path, CurrentDigest: current}
	}
	digest := sha256.Sum256(c.Content)
	if len(result.Applied) != 1 || result.Applied[0].Path != c.Path || result.Applied[0].PostDigest != hex.EncodeToString(digest[:]) || len(result.Raced) > 1 {
		return nil, workspaceapi.ErrCompareWriteUnavailable
	}
	receipt := &workspaceapi.FileWriteResult{Paths: []workspaceapi.FileMutationResult{{Path: c.Path, Digest: result.Applied[0].PostDigest}}, Raced: []workspaceapi.FileRace{}}
	for _, raced := range result.Raced {
		if raced.Path != c.Path || !fileDigest(raced.DisplacedDigest) {
			return nil, workspaceapi.ErrCompareWriteUnavailable
		}
		receipt.Raced = append(receipt.Raced, workspaceapi.FileRace{Path: c.Path, Version: raced.DisplacedDigest})
	}
	return receipt, nil
}

func fileDigest(digest string) bool {
	b, err := hex.DecodeString(digest)
	return err == nil && len(b) == sha256.Size && hex.EncodeToString(b) == digest
}
