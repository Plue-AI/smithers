package services

import "context"

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
