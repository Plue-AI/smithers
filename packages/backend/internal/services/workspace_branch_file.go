package services

import "context"

// ReadCurrentBranchFile composes the existing bounded, authorized runtime file
// reader. An install never substitutes a hosted sandbox or mirrored head for
// an unavailable working copy.
func (s *WorkspaceService) ReadCurrentBranchFile(ctx context.Context, workspaceID string, repositoryID, userID int64, path string) (WorkspaceFileContent, error) {
	if s == nil || s.runtime == nil {
		return WorkspaceFileContent{}, ErrSourceNotReady
	}
	return s.ReadWorkspaceFile(ctx, workspaceID, repositoryID, userID, path)
}
