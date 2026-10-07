package machined

import (
	"context"
	"os"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// HostObjects keeps the repository engine's write/maintenance exclusion held
// until each data operation finishes. A returned pathname is never a lease.
// Visit resolves an authenticated branch to its install-owned repository.
type HostObjects struct {
	Visit func(context.Context, string, func(string) error) error
}

func (s HostObjects) visit(ctx context.Context, branch string, call func(func(context.Context, string) (string, error)) error) error {
	if s.Visit == nil {
		return ErrNotReady
	}
	return s.Visit(ctx, branch, func(path string) error {
		return call(func(_ context.Context, id string) (string, error) {
			if id != branch {
				return "", ErrUnauthorized
			}
			return path, nil
		})
	})
}

func (s HostObjects) Import(ctx context.Context, branch string, file *os.File) error {
	return s.visit(ctx, branch, func(resolve func(context.Context, string) (string, error)) error {
		return GitBundleImporter(resolve)(ctx, branch, file)
	})
}
func (s HostObjects) VerifyCapture(ctx context.Context, branch string, capture wire.Captured) (missing []string, err error) {
	err = s.visit(ctx, branch, func(resolve func(context.Context, string) (string, error)) error {
		var e error
		missing, e = (GitCaptureObjects{Resolve: resolve}).VerifyCapture(ctx, branch, capture)
		return e
	})
	return
}
func (s HostObjects) PublishCapture(ctx context.Context, branch string, capture wire.Captured) (applied bool, err error) {
	err = s.visit(ctx, branch, func(resolve func(context.Context, string) (string, error)) error {
		var e error
		applied, e = (GitCaptureObjects{Resolve: resolve}).PublishCapture(ctx, branch, capture)
		return e
	})
	return
}
func (s HostObjects) VerifyBurst(ctx context.Context, branch string, burst wire.Burst) (missing []string, err error) {
	err = s.visit(ctx, branch, func(resolve func(context.Context, string) (string, error)) error {
		var e error
		missing, e = (GitBurstObjects{Resolve: resolve}).VerifyBurst(ctx, branch, burst)
		return e
	})
	return
}
func (s HostObjects) PublishBurst(ctx context.Context, branch, id, versions string) error {
	return s.visit(ctx, branch, func(resolve func(context.Context, string) (string, error)) error {
		return (GitBurstObjects{Resolve: resolve}).PublishBurst(ctx, branch, id, versions)
	})
}
