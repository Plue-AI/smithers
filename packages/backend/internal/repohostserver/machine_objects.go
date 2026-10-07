package repohostserver

import (
	"context"
	"os"
)

// WithMachineRepository composes the existing Git object adapters with this
// engine's write/maintenance exclusion. It is never exposed as an HTTP route.
func (s *Server) WithMachineRepository(ctx context.Context, owner, repo string, visit func(string) error) error {
	if err := validateOwnerRepo(owner, repo); err != nil {
		return err
	}
	path := s.config.RepoPath(owner, repo)
	unlock, err := s.lockRepo(ctx, path)
	if err != nil {
		return err
	}
	defer unlock()
	git := repoGitDir(path)
	if _, err = os.Stat(git); err != nil {
		return err
	}
	return visit(git)
}
