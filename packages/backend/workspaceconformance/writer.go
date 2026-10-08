package workspaceconformance

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io/fs"

	"github.com/smithersai/smithers/packages/backend/workspace"
)

// writeConformanceFile sets up known fixture bytes without exporting an
// unconditional writer on WorkspaceRuntime. The compared provider is preferred;
// the trusted-process adapter's concrete writer remains a local fixture seam.
// No failed comparison or ambiguous application is retried.
func writeConformanceFile(r workspace.WorkspaceRuntime, ctx context.Context, id, path string, content []byte, mode fs.FileMode, base string) error {
	if w, ok := r.(workspace.WorkspaceCompareWriter); ok {
		_, err := w.CompareWriteFiles(ctx, id, []workspace.FileMutation{{Path: path, BaseDigest: base, Content: content}})
		return err
	}
	if w, ok := r.(interface {
		WriteFile(context.Context, string, string, []byte, fs.FileMode) error
	}); ok {
		return w.WriteFile(ctx, id, path, content, mode)
	}
	return workspace.ErrCompareWriteUnavailable
}

func conformanceDigest(content []byte) string { return fmt.Sprintf("%x", sha256.Sum256(content)) }
