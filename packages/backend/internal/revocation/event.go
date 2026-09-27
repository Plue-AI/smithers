// Package revocation propagates authorization revocations to every live
// consumer within seconds.
//
// The gap it closes: a revoked token, a disabled user, a removed collaborator
// or workspace share, a cancelled agent session, or a removed organization
// member used to take effect only on the next fresh request. Established SSE
// streams, terminal WebSockets, SSH sessions, desktop relays, and sandbox
// egress proxies kept working until they ended on their own.
//
// The model copies the property Centaur gets from re-validating a sandbox's
// binding on every request: every revocation is one durable row in
// revocation_events (so a restarted pod catches up from its cursor) plus a
// pg_notify on the "revocations" channel (for latency). A Bus per process
// listens, keeps a bounded in-memory view of recently revoked principals for
// cheap per-request checks, and fans each event out to subscribers that own a
// long-lived connection so they can terminate it with a clear reason.
package revocation

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Channel is the PostgreSQL NOTIFY channel every Bus listens on.
const Channel = "revocations"

// Kind names what was revoked. The CHECK constraint on revocation_events.kind
// also admits "gateway_revoked", which the retired box gateway relay (#2198)
// recorded; nothing produces it and no principal matches it.
type Kind string

const (
	// KindTokenRevoked: an access token was deleted. TokenID and TokenHash
	// identify it; UserID is its owner.
	KindTokenRevoked Kind = "token_revoked"
	// KindTokenScopesNarrowed: an access token lost scopes. Consumers treat it
	// like a revocation because a stream authorized under the old scopes may
	// no longer be permitted.
	KindTokenScopesNarrowed Kind = "token_scopes_narrowed"
	// KindUserDisabled: the user was suspended or deleted. UserID identifies it.
	KindUserDisabled Kind = "user_disabled"
	// KindUserEnabled clears cached suspension state; it does not revoke a stream.
	KindUserEnabled Kind = "user_enabled"
	// KindCollaboratorRemoved: UserID lost access to RepositoryID. SandboxIDs
	// lists that user's live workspace VMs in the repository when known.
	KindCollaboratorRemoved Kind = "collaborator_removed"
	// KindWorkspaceShareRemoved: UserID lost the share on WorkspaceID.
	// SandboxIDs carries the workspace VM when known.
	KindWorkspaceShareRemoved Kind = "workspace_share_removed"
	// KindAgentSessionCancelled: SessionID ended before completion. SandboxIDs
	// carries its VM when known.
	KindAgentSessionCancelled Kind = "agent_session_cancelled"
	// KindOrgMemberRemoved: UserID left OrganizationID.
	KindOrgMemberRemoved Kind = "org_member_removed"
	// KindSSHKeyRevoked: an SSH public-key credential (user key or deploy key)
	// was deleted, so every SSH session it authenticated must end.
	// KeyFingerprint identifies it (SHA256:<base64>); UserID is its owner for
	// user keys, RepositoryID its repository for deploy keys.
	KindSSHKeyRevoked Kind = "ssh_key_revoked"
)

// Event is one revocation. Zero fields mean "not applicable"; a consumer
// matches on the populated ones through Affects.
type Event struct {
	ID             int64     `json:"id"`
	Kind           Kind      `json:"kind"`
	UserID         int64     `json:"user_id,omitempty"`
	TokenID        int64     `json:"token_id,omitempty"`
	TokenHash      string    `json:"token_hash,omitempty"`
	RepositoryID   int64     `json:"repository_id,omitempty"`
	OrganizationID int64     `json:"organization_id,omitempty"`
	WorkspaceID    string    `json:"workspace_id,omitempty"`
	SessionID      string    `json:"session_id,omitempty"`
	KeyFingerprint string    `json:"key_fingerprint,omitempty"`
	SandboxIDs     []string  `json:"sandbox_ids,omitempty"`
	Reason         string    `json:"reason,omitempty"`
	ActorID        int64     `json:"actor_id,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
}

// Principal describes what a live consumer is authorized as. A consumer fills
// in what it knows; unknown fields stay zero and never match.
type Principal struct {
	UserID         int64
	TokenHash      string
	RepositoryID   int64
	OrganizationID int64
	WorkspaceID    string
	SandboxID      string
	SessionID      string
	// KeyFingerprint is the SHA256:<base64> fingerprint of the SSH public key
	// that authenticated the session.
	KeyFingerprint string
}

// Affects reports whether the event revokes the principal's authorization.
func (e Event) Affects(p Principal) bool {
	switch e.Kind {
	case KindTokenRevoked, KindTokenScopesNarrowed:
		return e.TokenHash != "" && p.TokenHash == e.TokenHash
	case KindUserDisabled:
		return e.UserID != 0 && p.UserID == e.UserID
	case KindCollaboratorRemoved:
		if e.UserID != 0 && p.UserID == e.UserID && e.RepositoryID != 0 && p.RepositoryID == e.RepositoryID {
			return true
		}
		return e.namesSandbox(p.SandboxID)
	case KindWorkspaceShareRemoved:
		if e.WorkspaceID != "" && p.WorkspaceID == e.WorkspaceID && (e.UserID == 0 || p.UserID == e.UserID) {
			return true
		}
		return e.namesSandbox(p.SandboxID)
	case KindAgentSessionCancelled:
		if e.SessionID != "" && p.SessionID == e.SessionID {
			return true
		}
		return e.namesSandbox(p.SandboxID)
	case KindOrgMemberRemoved:
		if e.UserID != 0 && p.UserID == e.UserID && e.OrganizationID != 0 && p.OrganizationID == e.OrganizationID {
			return true
		}
		return e.namesSandbox(p.SandboxID)
	case KindSSHKeyRevoked:
		return e.KeyFingerprint != "" && p.KeyFingerprint == e.KeyFingerprint
	}
	return false
}

func (e Event) namesSandbox(sandboxID string) bool {
	if sandboxID == "" {
		return false
	}
	for _, id := range e.SandboxIDs {
		if id == sandboxID {
			return true
		}
	}
	return false
}

// FromRow converts a stored row into an Event.
func FromRow(row db.RevocationEvent) Event {
	return Event{
		ID:             row.ID,
		Kind:           Kind(row.Kind),
		UserID:         int8Value(row.UserID),
		TokenID:        int8Value(row.TokenID),
		TokenHash:      row.TokenHash,
		RepositoryID:   int8Value(row.RepositoryID),
		OrganizationID: int8Value(row.OrganizationID),
		WorkspaceID:    row.WorkspaceID,
		SessionID:      row.SessionID,
		KeyFingerprint: row.KeyFingerprint,
		SandboxIDs:     append([]string(nil), row.SandboxIds...),
		Reason:         row.Reason,
		ActorID:        int8Value(row.ActorID),
		CreatedAt:      row.CreatedAt,
	}
}

// ToParams converts an Event into the insert parameters for its row.
func (e Event) ToParams() db.InsertRevocationEventParams {
	sandboxIDs := e.SandboxIDs
	if sandboxIDs == nil {
		sandboxIDs = []string{}
	}
	return db.InsertRevocationEventParams{
		Kind:           string(e.Kind),
		UserID:         int8Param(e.UserID),
		TokenID:        int8Param(e.TokenID),
		TokenHash:      e.TokenHash,
		RepositoryID:   int8Param(e.RepositoryID),
		OrganizationID: int8Param(e.OrganizationID),
		WorkspaceID:    e.WorkspaceID,
		SessionID:      e.SessionID,
		KeyFingerprint: e.KeyFingerprint,
		SandboxIds:     sandboxIDs,
		Reason:         e.Reason,
		ActorID:        int8Param(e.ActorID),
	}
}

func int8Value(v pgtype.Int8) int64 {
	if !v.Valid {
		return 0
	}
	return v.Int64
}

func int8Param(v int64) pgtype.Int8 {
	return pgtype.Int8{Int64: v, Valid: v != 0}
}
