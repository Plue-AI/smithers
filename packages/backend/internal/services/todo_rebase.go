package services

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
