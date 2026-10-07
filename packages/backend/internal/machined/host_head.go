package machined

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// Head reads the authoritative host ref, seeding only from the host's recorded
// immutable commit. A guest's advertised head is never the authority on wake.
func (s HostObjects) Head(ctx context.Context, branch, seed string) (head string, err error) {
	err = s.visit(ctx, branch, func(resolve func(context.Context, string) (string, error)) error {
		repo, e := (GitBurstObjects{Resolve: resolve}).repository(ctx, branch)
		if e != nil {
			return e
		}
		id, _ := uuid.Parse(branch)
		ref := "refs/smithers/branches/" + id.String() + "/head"
		value, e := burstGit(ctx, repo, 64, "rev-parse", "--verify", ref)
		if e == nil {
			head = strings.TrimSpace(string(value))
			if !objectID(head) {
				return wire.BadValue
			}
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !objectID(seed) {
			return ErrNotReady
		}
		value, e = burstGit(ctx, repo, 64, "cat-file", "-t", seed)
		if e != nil {
			return e
		}
		if string(value) != "commit\n" {
			return wire.BadValue
		}
		if _, e = burstGit(ctx, repo, 64, "update-ref", ref, seed, strings.Repeat("0", 40)); e != nil {
			return e
		}
		head = seed
		return nil
	})
	return
}

func (s HostObjects) Tree(ctx context.Context, branch, head string) (tree string, err error) {
	if !objectID(head) {
		return "", wire.BadValue
	}
	err = s.visit(ctx, branch, func(resolve func(context.Context, string) (string, error)) error {
		repo, e := (GitBurstObjects{Resolve: resolve}).repository(ctx, branch)
		if e != nil {
			return e
		}
		value, e := burstGit(ctx, repo, 64, "rev-parse", "--verify", head+"^{tree}")
		if e != nil {
			return e
		}
		tree = strings.TrimSpace(string(value))
		if !objectID(tree) {
			return wire.BadValue
		}
		return nil
	})
	return
}
