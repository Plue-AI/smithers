package machined

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// GitCaptureObjects reuses the bundle receiver's host-selected repository and
// bounded, hook-free Git data operations. Resolve must hold the repository's
// maintenance exclusion for the operation, as with GitBurstObjects.
type GitCaptureObjects struct {
	Resolve func(context.Context, string) (string, error)
}

func (s GitCaptureObjects) VerifyCapture(ctx context.Context, branch string, capture wire.Captured) ([]string, error) {
	repo, err := (GitBurstObjects{Resolve: s.Resolve}).repository(ctx, branch)
	if err != nil {
		return nil, err
	}
	if !objectID(capture.Head) || !objectID(capture.Tree) || !objectID(capture.Base) {
		return nil, wire.BadValue
	}
	kind, err := burstGit(ctx, repo, 64, "cat-file", "-t", capture.Head)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return []string{capture.Head}, nil
	}
	if string(kind) != "commit\n" {
		return nil, wire.BadValue
	}
	commit, err := burstGit(ctx, repo, 1<<20, "cat-file", "commit", capture.Head)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(string(commit), "tree "+capture.Tree+"\n") {
		return nil, wire.BadValue
	}
	// A present commit alone is insufficient: all reachable bytes must exist
	// before a capture may acquire a receipt or a durable branch head.
	if _, err := burstGit(ctx, repo, 8<<20, "fsck", "--connectivity-only", "--no-reflogs", capture.Head); err != nil {
		return nil, fmt.Errorf("verify capture graph: %w", err)
	}
	return nil, nil
}

// PublishCapture retains every verified snapshot, including a stale capture,
// before attempting the head CAS. A stale base never moves the host's head.
// The caller records the result and its projection transaction before ACK.
func (s GitCaptureObjects) PublishCapture(ctx context.Context, branch string, capture wire.Captured) (bool, error) {
	missing, err := s.VerifyCapture(ctx, branch, capture)
	if err != nil {
		return false, err
	}
	if len(missing) != 0 {
		return false, fmt.Errorf("missing capture object: %s", missing[0])
	}
	repo, err := (GitBurstObjects{Resolve: s.Resolve}).repository(ctx, branch)
	if err != nil {
		return false, err
	}
	id, _ := uuid.Parse(branch)
	prefix := "refs/smithers/branches/" + id.String()
	// The OID makes this pin immutable and replay-safe even if a receipt
	// transaction fails after Git's durable publication.
	if _, err = burstGit(ctx, repo, 64, "update-ref", prefix+"/captures/"+capture.Head, capture.Head); err != nil {
		return false, err
	}
	ref := prefix + "/head"
	current, readErr := burstGit(ctx, repo, 64, "rev-parse", "--verify", ref)
	if readErr == nil && strings.TrimSpace(string(current)) == capture.Head {
		return true, nil // repair a projection interrupted after publication
	}
	if _, err = burstGit(ctx, repo, 64, "update-ref", ref, capture.Head, capture.Base); err == nil {
		return true, nil
	}
	current, readErr = burstGit(ctx, repo, 64, "rev-parse", "--verify", ref)
	if readErr == nil {
		head := strings.TrimSpace(string(current))
		if head == capture.Head {
			return true, nil
		}
		if head != capture.Base {
			return false, nil
		}
	}
	return false, fmt.Errorf("publish capture head: %w", err)
}
