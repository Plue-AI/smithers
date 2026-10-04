package services

import pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"

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
// No existing presence-aware decision exists in the legacy integration loop.
func RebaseAtBoundary(pending bool, presence RebasePresence) bool {
	return pending && (presence == RebasePresenceEmpty || presence == RebasePresenceAgent)
}

// The host-only integration path is removed rather than used as a fallback.
// No rebase or Done door is mounted until guest, wait and authority contracts
// are composed and their production acceptance receipts pass.
func branchRebaseUnavailable() error {
	return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Rebase pending: validated branch rebase execution is unavailable")
}
