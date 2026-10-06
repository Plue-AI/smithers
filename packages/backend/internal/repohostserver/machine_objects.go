package repohostserver

import (
	"context"
	"errors"
	"path/filepath"
)

// WithGitObjectStore keeps transfer/ref operations inside the engine's writer
// exclusion, including native mutations, maintenance and GC. This is an
// in-process host capability, never an HTTP route or a machine-selected path.
func (s *Server) WithGitObjectStore(ctx context.Context, owner, repository string, use func(string) error) error {
	if err := validateOwnerRepo(owner, repository); err != nil {
		return err
	}
	if use == nil {
		return errors.New("object operation unavailable")
	}
	unlock, err := s.locks.Lock(ctx, s.config.RepoPath(owner, repository))
	if err != nil {
		return err
	}
	defer unlock()
	path, err := filepath.Abs(s.config.GitBackendPath(owner, repository))
	if err != nil {
		return err
	}
	return use(path)
}
