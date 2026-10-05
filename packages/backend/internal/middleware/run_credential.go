package middleware

import (
	"context"
	"net/http"
	"strings"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// CredentialKind says who holds an access token.
type CredentialKind string

const (
	// CredentialPerson is a token a person created (a personal access token
	// or the one behind an OAuth2 grant).
	CredentialPerson CredentialKind = "person"
	// CredentialAgentRun is a system-issued token handed to a computer that
	// runs code or instructions nobody has reviewed: an agent computer, a
	// workspace, a workflow job, a gateway. It is the kind every
	// system-issued token has unless it is issued as CredentialSync.
	CredentialAgentRun CredentialKind = "run"
	// CredentialSync is a system-issued token only the platform's own
	// sync workers hold on the server (repository mirroring and document
	// synchronization). No agent or workflow ever receives one.
	CredentialSync CredentialKind = "sync"
	// CredentialPlatform is not a token: it marks the API's own verified
	// write of the default bookmark, the GitHub main pull's fast-forward to
	// GitHub's reviewed tip.
	CredentialPlatform CredentialKind = "platform"
	// CredentialDelegated is a system-issued token that acts for its person
	// through an agent or a tool (spec §5.3): its issuer stored a via:<name>
	// entry. It has every restriction of CredentialAgentRun (Agent) and only
	// the routes its stored profile names.
	CredentialDelegated CredentialKind = "delegated"
)

// Delegation entries are issuer-bound: only the host's own minting writes
// them (a person cannot request them; they are not TokenScopes), and like the
// other binding entries they grant nothing (ParseTokenScopes drops them).
const (
	delegationViaScopePrefix     = "via:"
	delegationBranchScopePrefix  = "branch:"
	delegationProfileScopePrefix = "profile:"
	delegationSessionScopePrefix = "terminal-session:"
)

// TerminalProfileS1 is the stage-1 terminal credential's scope profile
// (spec §8.11.1): reads, wiki reads, and the TODO actions T-TRM-02 lists.
const TerminalProfileS1 = "terminal_s1"

// Delegation is what the issuer stored on a delegated credential: the tool
// it was minted for (via), and for a terminal's, its branch, profile and
// terminal session.
type Delegation struct {
	Via     string
	Branch  string
	Profile string
	Session string
}

// DelegationScopes are the scopes-list entries that bind a delegated
// credential to its via, branch, profile and terminal session. Empty fields
// are left out; via is required.
func DelegationScopes(d Delegation) []string {
	entries := []string{delegationViaScopePrefix + strings.ToLower(strings.TrimSpace(d.Via))}
	for _, entry := range [][2]string{{delegationBranchScopePrefix, d.Branch}, {delegationProfileScopePrefix, d.Profile}, {delegationSessionScopePrefix, d.Session}} {
		if value := strings.TrimSpace(entry[1]); value != "" {
			entries = append(entries, entry[0]+strings.ToLower(value))
		}
	}
	return entries
}

// ParseTokenDelegation reads the delegation entries of a system-issued
// token's scopes. A token with no via entry is not delegated.
func ParseTokenDelegation(systemIssued bool, raw string) (Delegation, bool) {
	if !systemIssued {
		return Delegation{}, false
	}
	var d Delegation
	for _, part := range tokenScopeEntries(raw) {
		part = strings.ToLower(strings.TrimSpace(part))
		for prefix, field := range map[string]*string{delegationViaScopePrefix: &d.Via, delegationBranchScopePrefix: &d.Branch, delegationProfileScopePrefix: &d.Profile, delegationSessionScopePrefix: &d.Session} {
			if strings.HasPrefix(part, prefix) && *field == "" {
				*field = strings.TrimPrefix(part, prefix)
			}
		}
	}
	return d, d.Via != ""
}

// Delegation is the request credential's stored delegation, if it is a
// delegated token.
func (a *AuthInfo) Delegation() (Delegation, bool) {
	if a == nil || !a.IsTokenAuth {
		return Delegation{}, false
	}
	return ParseTokenDelegation(a.TokenSystemIssued, a.RawScopes)
}

// EffectiveVia is the via a delegated request is attributed to (spec §6.4):
// a terminal's or the CLI's credential takes the Smithers-Via hint of the
// agent working in it (claude-code or codex); every other stored via stands,
// so a forged hint never changes a claude-code credential's attribution. The
// hint is attribution only: it selects no person, branch, role or scope.
func EffectiveVia(stored, hint string) string {
	hint = strings.ToLower(strings.TrimSpace(hint))
	if (stored == "terminal" || stored == "cli") && (hint == "claude-code" || hint == "codex") {
		return hint
	}
	return stored
}

// Agent reports whether a credential of this kind is an agent's: an agent
// run's or a delegated one. Neither writes the default bookmark directly.
func (k CredentialKind) Agent() bool {
	return k == CredentialAgentRun || k == CredentialDelegated
}

// syncCredentialScope marks a system-issued token as CredentialSync. Like the
// other binding entries it grants no permission (ParseTokenScopes drops it),
// and a person cannot request it (it is not a TokenScope). It counts only on a
// system-issued token.
const syncCredentialScope = "credential:sync"

// SyncCredentialScope returns the scopes-list entry that issues a
// system token as CredentialSync.
func SyncCredentialScope() string { return syncCredentialScope }

// workspaceChildrenCredentialScope marks a workspace-bound token as the one a
// running workspace spawns its children with (#2802). It grants nothing on
// its own: it moves the token's one reachable route family from the head
// report to the workspace's children routes.
const workspaceChildrenCredentialScope = "credential:workspace-children"

// WorkspaceChildrenCredentialScope returns the scopes-list entry of a
// workspace's children credential.
func WorkspaceChildrenCredentialScope() string { return workspaceChildrenCredentialScope }

// ParseTokenWorkspaceChildrenCredential reports whether raw carries the
// children credential mark.
func ParseTokenWorkspaceChildrenCredential(raw string) bool {
	for _, part := range tokenScopeEntries(raw) {
		if strings.EqualFold(strings.TrimSpace(part), workspaceChildrenCredentialScope) {
			return true
		}
	}
	return false
}

// TokenCredentialKind classifies an access token from its stored fields
// and its user's account type. An agent account (a bot or service user) is
// an agent whatever token it holds: its token is an agent run's.
func TokenCredentialKind(systemIssued bool, rawScopes, userType string) CredentialKind {
	if !systemIssued {
		if IsAgentAccount(userType) {
			return CredentialAgentRun
		}
		return CredentialPerson
	}
	for _, part := range tokenScopeEntries(rawScopes) {
		if strings.EqualFold(strings.TrimSpace(part), syncCredentialScope) {
			return CredentialSync
		}
	}
	if _, ok := ParseTokenDelegation(systemIssued, rawScopes); ok {
		return CredentialDelegated
	}
	return CredentialAgentRun
}

// ParseCredentialKind reads a kind another service recorded. Empty stays
// empty (unattributed); an unknown value is read as an agent run's, the most
// restricted kind.
func ParseCredentialKind(raw string) CredentialKind {
	switch kind := CredentialKind(strings.TrimSpace(raw)); kind {
	case "", CredentialPerson, CredentialAgentRun, CredentialSync, CredentialPlatform, CredentialDelegated:
		return kind
	default:
		return CredentialAgentRun
	}
}

// Reviewed reports whether a write with this kind is a person's or the
// API's own verified one. Every other kind, unattributed included, runs no
// cache-saving workflow and applies no administrator setting.
func (k CredentialKind) Reviewed() bool {
	return k == CredentialPerson || k == CredentialPlatform
}

// IsAgentAccount reports whether a user account is an agent's (a bot or a
// service), not a person's.
func IsAgentAccount(userType string) bool {
	return userType == "bot" || userType == "service"
}

// CredentialKind reports who holds the request's credential. A session, and
// any request without a token, is a person's unless its account is an
// agent's.
func (a *AuthInfo) CredentialKind() CredentialKind {
	userType := ""
	if a != nil && a.User != nil {
		userType = a.User.UserType
	}
	if a == nil || !a.IsTokenAuth {
		if IsAgentAccount(userType) {
			return CredentialAgentRun
		}
		return CredentialPerson
	}
	return TokenCredentialKind(a.TokenSystemIssued, a.RawScopes, userType)
}

// IsRunCredential reports whether the request authenticated with a
// system-issued credential of either kind: an agent run's token, or the
// platform's sync token. It acts as the user who owns the run or the import,
// but no person is making the request.
func (a *AuthInfo) IsRunCredential() bool {
	return a != nil && a.IsTokenAuth && a.TokenSystemIssued
}

// IsAgent reports whether an agent, not a person, makes the request: a run
// credential, or any credential of an agent account (a bot or service
// user). It takes no person's decision and holds no administrator's power.
func (a *AuthInfo) IsAgent() bool {
	return a.IsRunCredential() || a != nil && a.User != nil && IsAgentAccount(a.User.UserType)
}

// RequirePerson refuses a run credential on a decision only a person may
// take: one that clears a landing blocker or satisfies a human requirement
// (acknowledging a review comment, dismissing a person's review, landing or
// queueing someone else's landing, reporting a commit status, deciding an
// approval), and the person-owned routes behind RefuseRunCredentials. It is
// the one check for that rule. action completes "a run credential cannot ...".
func RequirePerson(ctx context.Context, action string) error {
	if err := requirePerson(ctx, action); err != nil {
		return err
	}
	return nil
}

func requirePerson(ctx context.Context, action string) *apierrors.APIError {
	if info := AuthInfoFromContext(ctx); info.IsAgent() {
		if info.IsRunCredential() {
			return apierrors.Forbidden("a run credential cannot " + action)
		}
		return apierrors.Forbidden("an agent account cannot " + action)
	}
	return nil
}

// RefuseRunCredentials applies RequirePerson to a whole route: managing build
// cache read tokens (a run could revoke the committed read token or mint one
// for itself), clearing workflow caches, starting, rerunning, resuming or cancelling
// workflow runs (a run could start the default bookmark's workflows with
// inputs it chooses, and their caches are what every later run restores),
// pausing repository jobs, deciding human approvals, and reporting commit statuses.
func RefuseRunCredentials(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := requirePerson(r.Context(), "use this endpoint"); err != nil {
			apierrors.WriteError(w, err)
			return
		}
		next.ServeHTTP(w, r)
	})
}
