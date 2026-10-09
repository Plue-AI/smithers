package services

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// RebaseBlockerReader resolves only a host-admitted session on its exact boot.
// Missing, replaced or revoked sessions never acquire an invented actor label.
type RebaseBlockerReader func(context.Context, string, string, uint32) (map[string]any, error)

func (s *MythicalService) SetRebaseBlockerReader(read RebaseBlockerReader)  { s.rebaseBlocker = read }
func (s *WorkspaceService) SetRebaseBlockerReader(read RebaseBlockerReader) { s.rebaseBlocker = read }

func rebaseWaitingFor(ctx context.Context, read RebaseBlockerReader, workspace, boot string, session uint32) map[string]any {
	if read == nil || len(boot) != 32 || session == 0 {
		return nil
	}
	writer, err := read(ctx, workspace, boot, session)
	if err != nil {
		return nil
	}
	return writer
}

// Writer details belong to the person who requested this rebase. Background
// facts carry no viewer identity and must never broadcast the private blocker.
func rebaseRequestedByViewer(ctx context.Context, request *mythicalRebaseRequest) bool {
	viewer := middleware.UserFromContext(ctx)
	return viewer != nil && request != nil && request.User > 0 && viewer.ID == request.User && !InstallExecutionCredential(ctx)
}
