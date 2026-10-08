package services

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// RebasePresence is an authenticated lease snapshot, not a cached UI roster.
// Unknown presence never grants permission to rewrite a branch.
type RebasePresence uint8

const (
	RebasePresenceUnknown RebasePresence = iota
	RebasePresenceEmpty
	RebasePresenceAgent
	RebasePresencePeople
)

// RebaseAtBoundary is the scheduling decision only. Dispatch must still admit
// authority, a stack fence, a bound target and validated execution providers.
func RebaseAtBoundary(pending bool, presence RebasePresence) bool {
	return pending && (presence == RebasePresenceEmpty || presence == RebasePresenceAgent)
}

// SetRebasePresence binds the install's authenticated branch lease provider.
// A missing workspace, unavailable provider or unknown participant holds the
// rebase. Legacy compositions without multiplayer keep their existing path.
func (s *MythicalService) SetRebasePresence(read func(context.Context, int64, string) (RebasePresence, error)) {
	s.rebasePresence = func(ctx context.Context, repository int64, workspace string) (RebasePresence, error) {
		if read == nil || workspace == "" {
			return RebasePresenceUnknown, nil
		}
		return read(ctx, repository, workspace)
	}
}

func (s *MythicalService) mayRebaseAtBoundary(ctx context.Context, repository int64, workspace string) bool {
	if s.rebasePresence == nil {
		return true
	}
	presence, err := s.rebasePresence(ctx, repository, workspace)
	return err == nil && RebaseAtBoundary(true, presence)
}

// A press authorizes only the candidate and destination it observed. A later
// prefix move must make its own scheduling decision.
type mythicalRebaseRequest struct {
	User       int64                 `json:"user"`
	Credential middleware.Credential `json:"credential"`
	RawScopes  string                `json:"scopes"`
	Via        string                `json:"via"`
	Head       string                `json:"head"`
	Generation int64                 `json:"generation"`
	By         map[string]string     `json:"by"`
}

func requestedRebase(item db.MythicalItem, onto string) bool {
	pending := mythicalChecksOf(item).Rebase
	// An occupied branch must use the daemon freeze/capture/rebase boundary.
	// Until that result carries conflict inspection, a press cannot authorize
	// the host candidate path over an active working copy. A released lane has
	// only its retained candidate; verification allocates a fresh machine.
	return item.WorkspaceID == "" && pending != nil && !pending.Rebased && pending.Onto == onto && pending.Request != nil && pending.Request.Head == item.CandidateHead && pending.Request.Generation == item.Generation
}
func rebaseRequester(item db.MythicalItem) map[string]string {
	if pending := mythicalChecksOf(item).Rebase; pending != nil && pending.Request != nil {
		return pending.Request.By
	}
	return nil
}

func (s *MythicalService) mayExecuteRequestedRebase(ctx context.Context, item db.MythicalItem, onto string) bool {
	if !requestedRebase(item, onto) {
		return false
	}
	return s.rebaseRequestAuthorized(ctx, s.queries(), item, mythicalChecksOf(item).Rebase.Request)
}
func (s *MythicalService) rebaseRequestAuthorized(ctx context.Context, q *db.Queries, item db.MythicalItem, request *mythicalRebaseRequest) bool {
	info, err := middleware.ReloadCredential(ctx, q, request.Credential, s.now())
	if err != nil || info == nil || info.User == nil || info.User.ID != request.User || info.RawScopes != request.RawScopes || !middleware.BindInstallCredential(info) {
		return false
	}
	info.ViaHint = request.Via
	current := middleware.ContextWithAuthInfo(ctx, info)
	repository, err := InstallRepositoryID(current, q)
	if err != nil || repository != item.RepositoryID {
		return false
	}
	_, err = Authorize(current, q, "branch.rebase-now")
	if err != nil {
		return false
	}
	return AuthorizeTodoBranch(current, q, item.RepositoryID, item.Number.Int64) == nil
}

// A reviewed TODO releases its execution lane, but keeps its coding branch.
// Consult that branch's authenticated presence rather than treating the cleared
// execution binding as an unknown branch forever. The retained branch can have
// been reopened by a person, so retirement alone is not permission to rebase.
func (s *MythicalService) mayRebaseItemAtBoundary(ctx context.Context, item db.MythicalItem) bool {
	workspace := item.WorkspaceID
	if s.rebasePresence != nil && workspace == "" {
		if s.store == nil {
			return false
		}
		branch, err := s.queries().GetMythicalTodoBranchWorkspace(ctx, item)
		if err != nil {
			return false
		}
		workspace = branch.ID
	}
	return s.mayRebaseAtBoundary(ctx, item.RepositoryID, workspace)
}
