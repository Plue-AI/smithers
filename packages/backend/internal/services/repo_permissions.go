package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	stdErrors "errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Per-repository ownership advisory locks. Ownership mutators (transfer,
// delete, settings update) take the exclusive form; repo-scoped writers that
// only need to fence against a concurrent ownership change take the shared
// form, so they serialize with transfers but not with each other. The string
// prefix keeps the key space disjoint from other advisory-lock users.
//
// The parameter is typed bigint and cast to text inside the statement rather
// than written as $1::text: the latter makes Postgres infer a text parameter,
// which pgx cannot encode the int64 repository id into.
const (
	repoOwnershipLockSQL       = "SELECT pg_advisory_xact_lock(hashtextextended('repository_ownership:' || ($1::bigint)::text, 0))"
	repoOwnershipSharedLockSQL = "SELECT pg_advisory_xact_lock_shared(hashtextextended('repository_ownership:' || ($1::bigint)::text, 0))"
)

// RepoOwnershipGuard fences a repository-scoped write against concurrent
// ownership changes: the write runs while the per-repository ownership lock is
// held in shared mode, after re-validating that the repository still has the
// owner/name the caller authorized against.
type RepoOwnershipGuard interface {
	WithRepoOwnershipShared(ctx context.Context, snapshot db.Repository, write func() error) error
}

// RepoOwnershipFence is the pgxpool-backed RepoOwnershipGuard used in
// production. It shares the advisory-lock key space with RepoService's
// ownership transaction, so guarded writes serialize with transfers, deletes,
// and settings updates.
type RepoOwnershipFence struct {
	pool *pgxpool.Pool
}

type repoOwnershipTransactionKey struct{}
type repoOwnershipTransaction struct {
	pool *pgxpool.Pool
	tx   pgx.Tx
}

// Only an install service holding this pool's transaction can reuse it. The
// guard still checks the same ownership snapshot and takes the same lock.
func withRepoOwnershipTransaction(ctx context.Context, pool *pgxpool.Pool, tx pgx.Tx) context.Context {
	return context.WithValue(ctx, repoOwnershipTransactionKey{}, repoOwnershipTransaction{pool: pool, tx: tx})
}

// NewRepoOwnershipFence returns a fence backed by pool, or nil when pool is nil.
func NewRepoOwnershipFence(pool *pgxpool.Pool) *RepoOwnershipFence {
	if pool == nil {
		return nil
	}
	return &RepoOwnershipFence{pool: pool}
}

func (f *RepoOwnershipFence) WithRepoOwnershipShared(ctx context.Context, snapshot db.Repository, write func() error) error {
	if f == nil || f.pool == nil {
		return write()
	}
	var tx pgx.Tx
	if shared, ok := ctx.Value(repoOwnershipTransactionKey{}).(repoOwnershipTransaction); ok && shared.pool == f.pool && shared.tx != nil {
		tx = shared.tx
	} else {
		var err error
		tx, err = f.pool.Begin(ctx)
		if err != nil {
			slog.Error("failed to begin repository ownership guard transaction", "repo_id", snapshot.ID, "error", err)
			return pkgerrors.Internal("failed to serialize repository write").WithCause(err)
		}
		defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	}

	if _, err := tx.Exec(ctx, repoOwnershipSharedLockSQL, snapshot.ID); err != nil {
		slog.Error("failed to acquire repository ownership shared lock", "repo_id", snapshot.ID, "error", err)
		return pkgerrors.Internal("failed to serialize repository write").WithCause(err)
	}

	fresh, err := db.New(tx).GetRepoByID(ctx, snapshot.ID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("repository not found")
		}
		slog.Error("failed to re-validate repository ownership", "repo_id", snapshot.ID, "error", err)
		return pkgerrors.Internal("failed to serialize repository write").WithCause(err)
	}
	if !repoOwnershipUnchanged(fresh, snapshot) {
		return pkgerrors.Conflict("repository ownership changed concurrently")
	}

	return write()
}

// guardedRepoWrite runs write under g's shared ownership fence when g is
// non-nil, otherwise directly (unit tests without a pool).
func guardedRepoWrite(ctx context.Context, g RepoOwnershipGuard, repository db.Repository, write func() error) error {
	if g == nil {
		return write()
	}
	return g.WithRepoOwnershipShared(ctx, repository, write)
}

// Configuration writers take this lock before credential rows. A competing
// insert cannot wait on a uniqueness conflict after the live-credential check.
// It grants no policy authority and does not change the ownership lock domain.
func lockInstallRepositoryAdminMutation(ctx context.Context, tx pgx.Tx, repository int64) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('install_repository_admin:' || ($1::bigint)::text, 0))`, repository)
	return err
}

// RepoPermQuerier is the minimal DB interface required for repository permission
// resolution. All per-service querier interfaces must embed or satisfy this set.
type RepoPermQuerier interface {
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
}

// repoPermissionForUser resolves the effective permission string and whether the
// user is the repository owner.  It is the single canonical implementation used
// by every service — replacing the ~16 per-service copies that previously existed.
//
// Return contract:
//   - isOwner=true  → the caller should treat the user as having full access.
//   - permission    → highest of team + collaborator permissions ("read"/"write"/"admin").
//   - err           → non-nil only on DB failures (wrapped as pkgerrors.Internal).
func repoPermissionForUser(ctx context.Context, q RepoPermQuerier, repository db.Repository, userID int64) (permission string, isOwner bool, err error) {
	if repository.UserID.Valid && repository.UserID.Int64 == userID {
		return "", true, nil
	}

	teamPermission := ""
	if repository.OrgID.Valid {
		orgOwner, err := q.IsOrgOwnerForRepoUser(ctx, db.IsOrgOwnerForRepoUserParams{
			RepositoryID: repository.ID,
			UserID:       userID,
		})
		if err != nil {
			return "", false, pkgerrors.Internal("failed to resolve repository permissions").WithCause(err)
		}
		if orgOwner {
			return "", true, nil
		}

		teamPermission, err = q.GetHighestTeamPermissionForRepoUser(ctx, db.GetHighestTeamPermissionForRepoUserParams{
			RepositoryID: repository.ID,
			UserID:       userID,
		})
		if err != nil {
			return "", false, pkgerrors.Internal("failed to resolve repository permissions").WithCause(err)
		}
	}

	collabPermission, err := q.GetCollaboratorPermissionForRepoUser(ctx, db.GetCollaboratorPermissionForRepoUserParams{
		RepositoryID: repository.ID,
		UserID:       pgtype.Int8{Int64: userID, Valid: true},
	})
	if err != nil {
		return "", false, pkgerrors.Internal("failed to resolve repository permissions").WithCause(err)
	}

	return highestRepoPermission(teamPermission, collabPermission), false, nil
}

// canReadRepo returns true when userID may read repository (public repos are
// always readable, owners and any collaborator/team with at least read access).
func canReadRepo(ctx context.Context, q RepoPermQuerier, repository db.Repository, userID int64) (bool, error) {
	if repository.IsPublic {
		return true, nil
	}
	permission, isOwner, err := repoPermissionForUser(ctx, q, repository, userID)
	if err != nil {
		return false, err
	}
	if isOwner {
		return true, nil
	}
	return permission == "read" || permission == "write" || permission == "admin", nil
}

// canWriteRepo returns true when userID may push/modify repository contents.
func canWriteRepo(ctx context.Context, q RepoPermQuerier, repository db.Repository, userID int64) (bool, error) {
	permission, isOwner, err := repoPermissionForUser(ctx, q, repository, userID)
	if err != nil {
		return false, err
	}
	if isOwner {
		return true, nil
	}
	return permission == "write" || permission == "admin", nil
}

// canAdminRepo returns true when userID has admin or owner access to the
// repository. A request that authenticated as userID with a system-issued
// credential never has it (middleware.capCredentialPermission).
func canAdminRepo(ctx context.Context, q RepoPermQuerier, repository db.Repository, userID int64) (bool, error) {
	if actsThroughRunCredential(ctx, userID) {
		return false, nil
	}
	return canLandRepo(ctx, q, repository, userID)
}

// canLandRepo returns true when userID may land into the repository's
// bookmarks: admin or owner access, whatever credential the request used.
// Landing is how an agent's work reaches a bookmark (the coding flow lands
// with its run credential); protected-bookmark policy applies inside the
// landing, and a landing records no push, so its runs never save caches.
func canLandRepo(ctx context.Context, q RepoPermQuerier, repository db.Repository, userID int64) (bool, error) {
	permission, isOwner, err := repoPermissionForUser(ctx, q, repository, userID)
	if err != nil {
		return false, err
	}
	if isOwner {
		return true, nil
	}
	return permission == "admin", nil
}

// canOwnRepo returns true only when userID is the direct owner of the repository.
func canOwnRepo(ctx context.Context, q RepoPermQuerier, repository db.Repository, userID int64) (bool, error) {
	if actsThroughRunCredential(ctx, userID) {
		return false, nil
	}
	_, isOwner, err := repoPermissionForUser(ctx, q, repository, userID)
	if err != nil {
		return false, err
	}
	return isOwner, nil
}

// actsThroughRunCredential reports whether an agent makes the request as
// userID: a system-issued credential, or an agent account's own
// (middleware.AuthInfo.IsAgent).
func actsThroughRunCredential(ctx context.Context, userID int64) bool {
	info := middleware.AuthInfoFromContext(ctx)
	return info.IsAgent() && info.User != nil && info.User.ID == userID
}

// CanAdminRepo reports whether userID has admin or owner access to repository.
// It is the exported entry point to the canonical permission logic for callers
// outside the services package (e.g. the push hook gating config-sync on the
// pusher's permission before applying admin-only repo settings).
func CanAdminRepo(ctx context.Context, q RepoPermQuerier, repository db.Repository, userID int64) (bool, error) {
	return canAdminRepo(ctx, q, repository, userID)
}

// normalizeRepoPermission lower-cases and trims a permission string.
func normalizeRepoPermission(permission string) string {
	return strings.ToLower(strings.TrimSpace(permission))
}

func repoPermissionRank(permission string) int {
	switch normalizeRepoPermission(permission) {
	case "admin":
		return 3
	case "write":
		return 2
	case "read":
		return 1
	default:
		return 0
	}
}

func highestRepoPermission(permissions ...string) string {
	best := ""
	for _, permission := range permissions {
		if repoPermissionRank(permission) > repoPermissionRank(best) {
			best = normalizeRepoPermission(permission)
		}
	}
	return best
}

// InstallRole is a person's role on a self-hosted install's roster
// (mvp.md §6.15): the owner who installed it, then the collaborators rows of
// the install's repository, admin as Maintainer and write as Member.
type InstallRole string

const (
	InstallOwner      InstallRole = "owner"
	InstallMaintainer InstallRole = "maintainer"
	InstallMember     InstallRole = "member"
)

func (r InstallRole) rank() int {
	switch r {
	case InstallOwner:
		return 3
	case InstallMaintainer:
		return 2
	case InstallMember:
		return 1
	}
	return 0
}

// installCommandPolicy binds legacy HTTP names to literal catalog operations.
// No role, actor or delegation policy is declared in the backend.
func installCommandPolicy(command string) (CatalogPolicy, bool) {
	switch command {
	case "members.write":
		command = "members.add"
	case "secrets.write":
		command = "secrets.set"
	case "branch.join":
		command = "branch"
	}
	return OperationPolicy(command)
}

// terminalCommands are the commands a stage-1 terminal credential runs for
// its member (spec §8.11.1, §5.3.2a): the eligible reads and wiki reads;
// answer and steer, on its own branch's TODO only (AuthorizeTodoBranch);
// todo.control, the steer door, whose handler authorizes the op again; and
// todo.new, which a delegated credential confirms in the app.
var terminalCommands = map[string]bool{"self.read": true, "repo.read": true, "todo.read": true, "wiki.read": true,
	"todo.answer": true, "todo.steer": true, "todo.control": true, "todo.new": true, "branch.read": true}

// AccessError is Authorize's refusal (spec §6.2.3 error envelope).
type AccessError struct {
	Status  int    `json:"-"`
	Class   string `json:"class"`
	Code    string `json:"code"`
	Message string `json:"message"`
	// Fix is where the person fixes the refusal, such as the repository's
	// access settings on GitHub for needs_github_access.
	Fix string `json:"fix,omitempty"`
}

func (e *AccessError) Error() string { return e.Message }

// InstallAuthorization is one Authorize decision: the person and the role
// they hold now.
type InstallAuthorization struct {
	UserID int64
	Role   InstallRole
}

type installAuthorizationKey struct{}

// InstallSubject is resolved from the route and checked against stored authority.
// A system grant cannot be reused for a different workspace or repository.
type InstallSubject struct {
	RepositoryID     int64
	WorkspaceID      string
	ChildWorkspaceID string
	TodoNumber       int64
	Attempt          int32
	RunID            string
	Generation       int64
	Base             string
	Source           string
	PayloadDigest    string
	Resource         string
}

type boundInstallAuthorization struct {
	subject    InstallSubject
	command    string
	credential *middleware.AuthInfo
	decision   InstallAuthorization
}

// WithInstallAuthorization carries the decision made before dispatch. Binding
// both command and principal prevents reuse after a dispatcher changes either.
func WithInstallAuthorization(ctx context.Context, command string, decision InstallAuthorization, subjects ...InstallSubject) context.Context {
	var subject InstallSubject
	if len(subjects) == 1 {
		subject = subjects[0]
	}
	return context.WithValue(ctx, installAuthorizationKey{}, boundInstallAuthorization{subject: subject, command: command, credential: middleware.AuthInfoFromContext(ctx), decision: decision})
}

// WithInstallCredentialFence serializes an admitted effect with credential
// death and member removal. It preserves the original role decision; the
// consumer rechecks its stored subject under its existing authority fence.
func WithInstallCredentialFence(ctx context.Context, transactions interface {
	Begin(context.Context) (pgx.Tx, error)
}, effect func(context.Context) error) error {
	bound, ok := ctx.Value(installAuthorizationKey{}).(boundInstallAuthorization)
	if !ok || transactions == nil || bound.subject.RepositoryID <= 0 {
		return confirmationPermission()
	}
	if _, err := Authorize(ctx, nil, bound.command, bound.subject); err != nil {
		return err
	}
	tx, err := transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := guardInstallMemberCredential(ctx, tx, bound.subject.RepositoryID, bound.decision.UserID, false); err != nil {
		return err
	}
	return effect(ctx)
}

type authorizationObserverKey struct{}

// WithAuthorizationObserver observes evaluated command decisions. Reusing a
// bound decision does not evaluate policy again. The observer grants no authority.
func WithAuthorizationObserver(ctx context.Context, observe func(string)) context.Context {
	return context.WithValue(ctx, authorizationObserverKey{}, observe)
}

// Authorize is the install's one command authorizer (T-ACC-03): the
// request's credential, the command and the person's role, read from
// committed roster state on every call, so a removal or suspension refuses
// the very next request. A person's own browser session carries person
// authority; a stage-1 terminal's delegated credential acts for its member
// within terminalCommands, and its todo.new is refused with confirm_in_app
// until the app's private Confirm card serves it (spec §5.3.2a). Every other
// credential is refused. A person-only command checks the role first, so an
// eligible delegated caller is told never and an ineligible one permission
// (§5.2.1).
func Authorize(ctx context.Context, q *db.Queries, command string, subjects ...InstallSubject) (InstallAuthorization, error) {
	var subject InstallSubject
	if len(subjects) > 1 {
		return InstallAuthorization{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Invalid subject"}
	}
	if len(subjects) == 1 {
		subject = subjects[0]
	}
	// The S1 profile constrains every dispatch, including specialized command
	// doors and cached decisions. The HTTP auth loader only resolves identity.
	if info := middleware.AuthInfoFromContext(ctx); info != nil {
		if _, terminal := info.TerminalDelegation(); terminal && (!terminalCommands[command] || command == "self.read" && subject.Resource != "identity") {
			return InstallAuthorization{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "A terminal's credential cannot do this"}
		}
	}
	if bound, ok := ctx.Value(installAuthorizationKey{}).(boundInstallAuthorization); ok {
		info := middleware.AuthInfoFromContext(ctx)
		if info != nil && info.User != nil && info == bound.credential && info.User.ID == bound.decision.UserID && command == bound.command {
			if subject != bound.subject {
				// A stored binding changed after admission. Never substitute a
				// second decision for the request's original command subject.
				return InstallAuthorization{}, confirmationPermission()
			}
			return bound.decision, nil
		}
		// A dispatcher cannot replace its admitted command or credential.
		return InstallAuthorization{}, confirmationPermission()
	}
	if observe, ok := ctx.Value(authorizationObserverKey{}).(func(string)); ok && observe != nil {
		observe(command)
	}
	if info := middleware.AuthInfoFromContext(ctx); info != nil && info.User != nil && info.IsTokenAuth {
		// New or historical kind/profile names grant no install authority.
		for _, entry := range strings.Split(info.RawScopes, ",") {
			entry = strings.ToLower(strings.TrimSpace(entry))
			if strings.HasPrefix(entry, "credential:") && entry != middleware.SyncCredentialScope() && entry != middleware.WorkspaceChildrenCredentialScope() ||
				strings.HasPrefix(entry, "profile:") && entry != "profile:"+middleware.TerminalProfileS1 && entry != "profile:"+middleware.CodingFileProfileS1 {
				return InstallAuthorization{}, confirmationPermission()
			}
		}
	}
	policy, known := installCommandPolicy(command)
	if !known {
		return InstallAuthorization{}, confirmationPermission()
	}
	if command == "workspace.head" || command == "workspace.children.list" || command == "workspace.children.spawn" || command == "workspace.children.stop" || command == "workspace.provider-pool" || command == "stack.candidate" || command == "stack.propose" {
		if policy.Visibility != "hidden" || policy.Agent != "never" || len(policy.Actors) != 0 {
			return InstallAuthorization{}, confirmationPermission()
		}
	}
	if command == "workspace.children.list" || command == "workspace.children.spawn" || command == "workspace.children.stop" {
		return authorizeWorkspaceChildren(ctx, q, command, subject)
	}
	if command == "workspace.provider-pool" {
		return authorizeWorkspaceProviderPool(ctx, q, subject)
	}
	if command == "workspace.head" {
		return authorizeWorkspaceHead(ctx, q, subject)
	}
	if command == "stack.candidate" || command == "stack.propose" {
		return authorizeStackCandidate(ctx, q, subject)
	}
	if command == "flow.source-coedit" && middleware.IsCodingFileCredential(middleware.AuthInfoFromContext(ctx)) {
		return authorizeCodingFileCoedit(ctx, q, subject)
	}
	if command == "flow.source-coedit" && InstallExecutionCredential(ctx) {
		decision, err := authorizeExecutionTodoRead(ctx, q, subject)
		if err != nil {
			return InstallAuthorization{}, err
		}
		info := middleware.AuthInfoFromContext(ctx)
		if info.CredentialKind() != middleware.CredentialAgentRun || !info.Scopes.Has(middleware.ScopeWriteRepository) || subject.WorkspaceID == "" || subject.PayloadDigest == "" {
			return InstallAuthorization{}, confirmationPermission()
		}
		workspace, err := q.GetWorkspace(ctx, subject.WorkspaceID)
		if err != nil {
			return InstallAuthorization{}, err
		}
		if workspace.Status != "running" {
			return InstallAuthorization{}, confirmationPermission()
		}
		return decision, nil
	}
	if command == "flow.run" && InstallExecutionCredential(ctx) {
		return authorizeOwnRunFlow(ctx, q, subject)
	}
	if command == "branch.fork" && InstallExecutionCredential(ctx) {
		info := middleware.AuthInfoFromContext(ctx)
		if info.CredentialKind() != middleware.CredentialAgentRun || !info.Scopes.Has(middleware.ScopeWriteRepository) {
			return InstallAuthorization{}, confirmationPermission()
		}
		return authorizeExecutionTodoRead(ctx, q, subject)
	}
	if command == "branch.read" && InstallExecutionCredential(ctx) {
		if (subject.Resource != "files" && subject.Resource != "diff") || subject.WorkspaceID == "" {
			return InstallAuthorization{}, confirmationPermission()
		}
		return authorizeExecutionTodoRead(ctx, q, subject)
	}
	if command == "monitor" && InstallExecutionCredential(ctx) {
		return authorizeExecutionMonitor(ctx, q, subject)
	}
	if command == "todo.read" && InstallExecutionCredential(ctx) {
		return authorizeExecutionTodoRead(ctx, q, subject)
	}
	// A plan step reads and selects its repository's wiki pages only while
	// bound to its own live TODO attempt (T-FLW-10); no write scope follows.
	if command == "wiki.read" && InstallExecutionCredential(ctx) {
		return authorizeExecutionWikiRead(ctx, q, subject)
	}
	if len(policy.Actors) == 0 {
		return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Not available"}
	}
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil {
		return InstallAuthorization{}, &AccessError{Status: http.StatusUnauthorized, Class: "permission", Code: "unauthenticated", Message: middleware.UnauthenticatedMessage(ctx)}
	}
	// Delivery reads only the state of its own stored lane. Other repo.read
	// doors have no subject binding and cannot expose the stack or other items.
	if command == "repo.read" && InstallExecutionCredential(ctx) {
		return authorizeExecutionTodoRead(ctx, q, subject)
	}

	_, terminalProfile := info.TerminalDelegation()
	if info.IsTokenAuth && !terminalProfile && (info.CredentialKind() == middleware.CredentialDelegated || info.CredentialKind() == middleware.CredentialPerson) {
		scope := middleware.TokenScope(policy.CredentialScope)
		if scope != middleware.ScopeWriteRepository && scope != middleware.ScopeReadRepository && scope != middleware.ScopeReadUser && scope != middleware.ScopeWriteUser {
			return InstallAuthorization{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Unknown credential scope"}
		}
		if !info.Scopes.Has(scope) {
			return InstallAuthorization{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Insufficient credential scope"}
		}
		if len(middleware.ParseTokenPathRestrictions(info.RawScopes)) != 0 {
			return InstallAuthorization{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Insufficient credential scope"}
		}
		if restricted := info.RepositoryRestriction(); restricted != 0 {
			repository, err := InstallRepositoryID(ctx, q)
			if err != nil {
				return InstallAuthorization{}, err
			}
			if restricted != repository {
				return InstallAuthorization{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Insufficient credential scope"}
			}
		}
	}
	if command == "branch.read" && info.IsTokenAuth {
		refused := func() (InstallAuthorization, error) {
			return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Credential cannot read this branch"}
		}
		if !info.Scopes.Has(middleware.ScopeReadRepository) || len(middleware.ParseTokenPathRestrictions(info.RawScopes)) != 0 {
			return refused()
		}
		if restricted := info.RepositoryRestriction(); restricted != 0 {
			repository, err := InstallRepositoryID(ctx, q)
			if err != nil {
				return InstallAuthorization{}, err
			}
			if restricted != repository {
				return refused()
			}
		}
		if restricted := info.WorkspaceRestriction(); restricted != "" {
			delegation, delegated := info.Delegation()
			if !delegated || delegation.Branch != restricted {
				return refused()
			}
		}
	}

	if command == "confirmations.read" && info.IsTokenAuth && (info.CredentialKind() == middleware.CredentialDelegated || info.CredentialKind() == middleware.CredentialPerson) && info.Scopes.Has(middleware.ScopeReadRepository) && info.RepositoryRestriction() == 0 && info.WorkspaceRestriction() == "" && len(middleware.ParseTokenPathRestrictions(info.RawScopes)) == 0 {
		role, err := InstallRoleOf(ctx, q, info.User.ID)
		if err != nil {
			return InstallAuthorization{}, err
		}
		if role == "" {
			return InstallAuthorization{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not a member"}
		}
		return InstallAuthorization{UserID: info.User.ID, Role: role}, nil
	}
	delegation, delegated := info.Delegation()
	actor := ""
	if delegated {
		switch delegation.Via {
		case "smithers":
			actor = "app_agent"
		case "cli", "terminal", "claude-code", "codex":
			actor = "external_agent"
		default:
			if !ValidExternalAgent(delegation.Via) {
				return InstallAuthorization{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Unknown delegated actor"}
			}
			actor = "external_agent"
		}
	}
	if policy.Agent == "never" {
		return authorizePersonOnly(ctx, q, info, InstallRole(policy.MinimumRole))
	}
	fullDelegated := delegated && info.CredentialKind() == middleware.CredentialDelegated && !middleware.IsAgentAccount(info.User.UserType) && delegation.Profile == "" && delegation.Branch == "" && actor != ""
	_, terminal := info.TerminalDelegation()
	if terminal {
		// S1 was checked before specialized and bound command dispatch above.
	} else if !fullDelegated && (info.IsTokenAuth || info.IsAgent() || info.SessionHash == "") &&
		!(command == "branch.read" && info.CredentialKind() == middleware.CredentialDelegated && delegation.Profile == "") {
		message := "Sign in with a browser session"
		if command == "merge" {
			message = mythicalMergeForbidden().Message
		}
		return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: message}
	}
	role, err := InstallRoleOf(ctx, q, info.User.ID)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if role == "" {
		return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Not a member"}
	}
	if role.rank() < InstallRole(policy.MinimumRole).rank() {
		return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Only a maintainer can do this"}
	}
	if fullDelegated {
		if !slices.Contains(policy.Actors, actor) {
			return InstallAuthorization{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not available to this agent"}
		}
	}
	// The generated descriptor owns confirmation policy; the existing role,
	// scope and actor checks above still decide whether it may be requested.
	if policy, ok := OperationPolicy(command); fullDelegated && ok && policy.Agent == "confirm" {
		fallback := &AccessError{Status: 503, Class: "infra", Code: "confirmation_unavailable", Message: "Confirmation unavailable"}
		if command == "todo.new" || command == "branch.bring-in" || command == "branch.discard-foreign" {
			fallback = &AccessError{Status: 403, Class: "permission", Code: "confirm_in_app", Message: "Confirm in the app"}
		}
		return InstallAuthorization{}, requireConfirmation(info, command, InstallAuthorization{UserID: info.User.ID, Role: role}, fallback)
	}
	if terminal && command == "todo.amend" {
		return InstallAuthorization{}, &AccessError{Status: http.StatusServiceUnavailable, Class: "infra", Code: "confirmation_unavailable", Message: "Amendment confirmation is unavailable"}
	}
	if (terminal || fullDelegated) && command == "todo.new" {
		// A delegated TODO waits for its person's Confirm in the app, which
		// stage 1 does not serve yet: nothing is filed (T-APP-04).
		return InstallAuthorization{}, requireConfirmation(info, command, InstallAuthorization{UserID: info.User.ID, Role: role}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "confirm_in_app", Message: "Confirm in the app"})
	}
	return InstallAuthorization{UserID: info.User.ID, Role: role}, nil
}

// authorizePersonOnly decides a person-only command: the person's role
// first, then the credential. Only the person's own browser session acts; a
// delegated credential (a system-issued token with a stored via, or a
// personal access token, which install mode classifies as delegated,
// spec §5.3.0) is refused with never, and a run's, a machine's or an agent
// account's with permission.
func authorizePersonOnly(ctx context.Context, q *db.Queries, info *middleware.AuthInfo, need InstallRole) (InstallAuthorization, error) {
	role, err := InstallRoleOf(ctx, q, info.User.ID)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if role == "" {
		return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Not a member"}
	}
	if role.rank() < need.rank() {
		return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Only a maintainer can do this"}
	}
	switch kind := info.CredentialKind(); {
	case !info.IsTokenAuth && info.SessionHash != "" && kind == middleware.CredentialPerson:
		return InstallAuthorization{UserID: info.User.ID, Role: role}, nil
	case info.IsTokenAuth && (kind == middleware.CredentialDelegated || kind == middleware.CredentialPerson):
		return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "never", Code: "never", Message: "Only a person can do this"}
	}
	return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Sign in with a browser session"}
}

// AuthorizeTodoBranch admits a stage-1 terminal credential's answer or steer
// only on the TODO whose branch the terminal is on (spec §8.11.1): any other
// TODO, or a TODO with no branch, is 403 permission. Every other credential
// passes; Authorize has already decided it.
func AuthorizeTodoBranch(ctx context.Context, q *db.Queries, repositoryID, number int64) error {
	if _, terminal := middleware.AuthInfoFromContext(ctx).TerminalDelegation(); !terminal {
		return nil
	}
	item, err := q.GetMythicalItemByNumber(ctx, repositoryID, number)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return todoBranchRefusal()
	}
	if err != nil {
		return err
	}
	return todoBranchForbids(ctx, item)
}

// todoBranchForbids is AuthorizeTodoBranch for an item the caller holds.
func todoBranchForbids(ctx context.Context, item db.MythicalItem) error {
	delegation, terminal := middleware.AuthInfoFromContext(ctx).TerminalDelegation()
	if terminal && (item.WorkspaceID == "" || !strings.EqualFold(item.WorkspaceID, delegation.Branch)) {
		return todoBranchRefusal()
	}
	return nil
}

func todoBranchRefusal() error {
	return &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "A terminal acts only on its own branch's TODO"}
}

// InstallRepositoryID is the install's repository: the GitHub repository the
// repository step stores (github.repository); a caller never names it.
func InstallRepositoryID(ctx context.Context, q *db.Queries) (int64, error) {
	id, err := q.InstallRepositoryID(ctx)
	if stdErrors.Is(err, db.ErrInstallRepositoryUnavailable) {
		return 0, &AccessError{Status: http.StatusServiceUnavailable, Class: "infra", Code: "unavailable", Message: "Repository unavailable"}
	}
	return id, err
}

// InstallRoleOf is userID's current role, or "" for a person who is not an
// active member: off the roster, suspended, or barred from signing in.
func InstallRoleOf(ctx context.Context, q *db.Queries, userID int64) (InstallRole, error) {
	if q == nil {
		return "", &AccessError{Status: http.StatusServiceUnavailable, Class: "infra", Code: "unavailable", Message: "Members unavailable"}
	}
	owner, err := q.GetSelfHostOwner(ctx)
	if err != nil && !stdErrors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if err == nil && owner.ID == userID {
		if owner.ProhibitLogin {
			return "", nil
		}
		return InstallOwner, nil
	}
	permission, err := q.InstallationMemberPermission(ctx, userID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	switch permission {
	case "admin":
		return InstallMaintainer, nil
	case "write":
		return InstallMember, nil
	}
	return "", nil
}

// authorizeWorkspaceHead reuses the machine credential's stored workspace
// restriction. Person roles never grant this system action (spec 6.1.2d).
func authorizeWorkspaceHead(ctx context.Context, q *db.Queries, subject InstallSubject) (InstallAuthorization, error) {
	deny := func() (InstallAuthorization, error) {
		return InstallAuthorization{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Workspace credential required"}
	}
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil {
		return InstallAuthorization{}, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in"}
	}
	_, decision, authErr := authenticateInstallExecutionCredential(ctx, q)
	if authErr != nil {
		return InstallAuthorization{}, authErr
	}

	if q == nil || !info.IsTokenAuth || !info.TokenSystemIssued || info.CredentialKind() != middleware.CredentialMachine ||
		!info.Scopes.Has(middleware.ScopeWriteRepository) || middleware.ParseTokenWorkspaceChildrenCredential(info.RawScopes) ||
		subject.RepositoryID <= 0 || subject.WorkspaceID == "" || info.RepositoryRestriction() != subject.RepositoryID || !strings.EqualFold(info.WorkspaceRestriction(), subject.WorkspaceID) {
		return deny()
	}
	workspace, err := q.GetWorkspace(ctx, subject.WorkspaceID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return deny()
	}
	if err != nil {
		return InstallAuthorization{}, err
	}
	if workspace.RepositoryID != subject.RepositoryID || !workspace.HeadPushTokenID.Valid || workspace.HeadPushTokenID.Int64 != info.TokenID || workspace.DeletedAt.Valid {
		return deny()
	}
	repository, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if repository != subject.RepositoryID {
		return deny()
	}
	return decision, nil
}

// Children retain the existing issuer-only children scope and stored ancestry.
// A person role, generic machine token or caller-supplied parent grants nothing.
func authorizeWorkspaceChildren(ctx context.Context, q *db.Queries, command string, subject InstallSubject) (InstallAuthorization, error) {
	deny := func() (InstallAuthorization, error) {
		return InstallAuthorization{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Workspace children credential required"}
	}
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil {
		return InstallAuthorization{}, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in"}
	}
	token, decision, authErr := authenticateInstallExecutionCredential(ctx, q)
	if authErr != nil {
		return InstallAuthorization{}, authErr
	}

	if q == nil || !info.IsTokenAuth || !info.TokenSystemIssued || info.CredentialKind() != middleware.CredentialMachine || !middleware.ParseTokenWorkspaceChildrenCredential(info.RawScopes) || subject.RepositoryID <= 0 || subject.WorkspaceID == "" || info.RepositoryRestriction() != subject.RepositoryID || !strings.EqualFold(info.WorkspaceRestriction(), subject.WorkspaceID) {
		return deny()
	}
	scope := middleware.ScopeWriteWorkspace
	if command == "workspace.children.list" {
		scope = middleware.ScopeReadWorkspace
	}
	if !info.Scopes.Has(scope) {
		return deny()
	}
	parent, err := q.GetWorkspace(ctx, subject.WorkspaceID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return deny()
	}
	if err != nil {
		return InstallAuthorization{}, err
	}
	if parent.RepositoryID != subject.RepositoryID || parent.UserID != info.User.ID || parent.DeletedAt.Valid {
		return deny()
	}
	if token.Name != workspaceChildrenTokenName(parent.ID) || !token.SystemIssued || token.UserID != info.User.ID {
		return deny()
	}
	if command == "workspace.children.spawn" && subject.PayloadDigest == "" {
		return deny()
	}
	if command == "workspace.children.stop" {
		if subject.ChildWorkspaceID == "" {
			return deny()
		}
		child, err := q.GetWorkspace(ctx, subject.ChildWorkspaceID)
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return deny()
		}
		if err != nil {
			return InstallAuthorization{}, err
		}
		if !child.ParentWorkspaceID.Valid || child.ParentWorkspaceID != stringToUUID(parent.ID) || child.RepositoryID != parent.RepositoryID || child.UserID != parent.UserID {
			return deny()
		}
	} else if subject.ChildWorkspaceID != "" {
		return deny()
	}
	repository, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if repository != subject.RepositoryID {
		return deny()
	}
	return decision, nil
}

// The pool keeps its existing named publisher credential and workspace owner
// guard. An install additionally binds it to the active repository member.
func authorizeWorkspaceProviderPool(ctx context.Context, q *db.Queries, subject InstallSubject) (InstallAuthorization, error) {
	deny := func() (InstallAuthorization, error) {
		return InstallAuthorization{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Workspace pool credential required"}
	}
	if binding, ok := ctx.Value(verifiedInstallPoolHostKey{}).(flowhost.CredentialBinding); ok {
		if q == nil || binding.RepositoryID != subject.RepositoryID || binding.WorkspaceID != subject.WorkspaceID || subject.ChildWorkspaceID != "" {
			return deny()
		}
		workspace, err := q.GetWorkspace(ctx, subject.WorkspaceID)
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return deny()
		}
		if err != nil {
			return InstallAuthorization{}, err
		}
		if workspace.RepositoryID != binding.RepositoryID || workspace.DeletedAt.Valid {
			return deny()
		}
		repository, err := InstallRepositoryID(ctx, q)
		if err != nil {
			return InstallAuthorization{}, err
		}
		if repository != binding.RepositoryID {
			return deny()
		}
		role, err := InstallRoleOf(ctx, q, binding.UserID)
		if err != nil {
			return InstallAuthorization{}, err
		}
		if role == "" {
			return InstallAuthorization{}, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
		}
		if err := identity.NewMemberBoundary(q).AuthorizeMember(identity.WithMemberRoute(ctx), binding.UserID); err != nil {
			return InstallAuthorization{}, err
		}
		return InstallAuthorization{UserID: binding.UserID, Role: role}, nil
	}
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil {
		return InstallAuthorization{}, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in"}
	}
	token, decision, authErr := authenticateInstallExecutionCredential(ctx, q)
	if authErr != nil {
		return InstallAuthorization{}, authErr
	}

	if q == nil || !info.IsTokenAuth || !info.TokenSystemIssued || info.CredentialKind() != middleware.CredentialMachine || !info.Scopes.Has(middleware.ScopeReadWorkspace) || subject.RepositoryID <= 0 || subject.WorkspaceID == "" || subject.ChildWorkspaceID != "" || info.RepositoryRestriction() != subject.RepositoryID || !strings.EqualFold(info.WorkspaceRestriction(), subject.WorkspaceID) {
		return deny()
	}
	if !token.SystemIssued || token.UserID != info.User.ID || token.Name != providerPoolTokenPrefix+subject.WorkspaceID {
		return deny()
	}
	workspace, err := q.GetWorkspace(ctx, subject.WorkspaceID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return deny()
	}
	if err != nil {
		return InstallAuthorization{}, err
	}
	if workspace.UserID != info.User.ID || workspace.RepositoryID != subject.RepositoryID || workspace.DeletedAt.Valid {
		return deny()
	}
	repository, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if repository != subject.RepositoryID {
		return deny()
	}
	return decision, nil
}

// InstallExecutionCredential distinguishes hidden execution reads from member
// commands. It grants nothing without the stored subject check below.
func InstallExecutionCredential(ctx context.Context) bool {
	info := middleware.AuthInfoFromContext(ctx)
	return info != nil && info.IsTokenAuth && (info.CredentialKind() == middleware.CredentialAgentRun || info.CredentialKind() == middleware.CredentialMachine)
}

func authenticateInstallExecutionCredential(ctx context.Context, q *db.Queries) (db.AccessToken, InstallAuthorization, error) {
	if !InstallExecutionCredential(ctx) {
		return db.AccessToken{}, InstallAuthorization{}, confirmationPermission()
	}
	return authenticateInstallStoredToken(ctx, q)
}

func authenticateInstallStoredToken(ctx context.Context, q *db.Queries) (db.AccessToken, InstallAuthorization, error) {
	deny := func() (db.AccessToken, InstallAuthorization, error) {
		return db.AccessToken{}, InstallAuthorization{}, confirmationPermission()
	}
	dead := func() (db.AccessToken, InstallAuthorization, error) {
		return db.AccessToken{}, InstallAuthorization{}, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
	}
	info := middleware.AuthInfoFromContext(ctx)
	if q == nil || info == nil || info.User == nil || !info.TokenSystemIssued || !info.IsTokenAuth {
		return deny()
	}
	token, err := q.GetAccessTokenByID(ctx, info.TokenID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return dead()
	}
	if err != nil {
		return db.AccessToken{}, InstallAuthorization{}, err
	}
	if !token.SystemIssued || token.UserID != info.User.ID || token.Scopes != info.RawScopes || token.TokenHash != info.TokenHash || token.ExpiresAt.Valid && !token.ExpiresAt.Time.After(time.Now()) {
		return dead()
	}
	role, err := InstallRoleOf(ctx, q, info.User.ID)
	if err != nil {
		return db.AccessToken{}, InstallAuthorization{}, err
	}
	if role == "" {
		return dead()
	}
	return token, InstallAuthorization{UserID: info.User.ID, Role: role}, nil
}

func authorizeExecutionTodoRead(ctx context.Context, q *db.Queries, subject InstallSubject) (InstallAuthorization, error) {
	deny := func() (InstallAuthorization, error) {
		return InstallAuthorization{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Credential cannot read this TODO"}
	}
	info := middleware.AuthInfoFromContext(ctx)
	_, decision, err := authenticateInstallExecutionCredential(ctx, q)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if middleware.ParseTokenWorkspaceChildrenCredential(info.RawScopes) || !info.Scopes.Has(middleware.ScopeReadRepository) || subject.RepositoryID <= 0 || subject.TodoNumber <= 0 || info.RepositoryRestriction() != subject.RepositoryID {
		return deny()
	}
	// Ordinary execution read grants exclude specialized credential profiles.
	for _, entry := range strings.Split(info.RawScopes, ",") {
		entry = strings.ToLower(strings.TrimSpace(entry))
		if strings.HasPrefix(entry, "credential:") || strings.HasPrefix(entry, "profile:") {
			return deny()
		}
	}
	workspaceID := info.WorkspaceRestriction()
	if info.CredentialKind() == middleware.CredentialAgentRun {
		workspaceID = middleware.ParseTokenLandingWorkspace(info.RawScopes)
	}
	if workspaceID == "" || subject.WorkspaceID != "" && subject.WorkspaceID != workspaceID {
		return deny()
	}
	paths := middleware.ParseTokenPathRestrictions(info.RawScopes)
	if len(paths) != 0 && (len(paths) != 1 || paths[0] != "**") {
		return deny()
	}
	workspace, err := q.GetWorkspace(ctx, workspaceID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return deny()
	}
	if err != nil {
		return InstallAuthorization{}, err
	}
	if workspace.RepositoryID != subject.RepositoryID || workspace.DeletedAt.Valid {
		return deny()
	}
	item, err := q.GetMythicalItemByNumber(ctx, subject.RepositoryID, subject.TodoNumber)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return deny()
	}
	if err != nil {
		return InstallAuthorization{}, err
	}
	if item.WorkspaceID != workspace.ID || !executionTodoSponsorMatches(info, item) || subject.Attempt != 0 && item.Attempt != subject.Attempt {
		return deny()
	}
	repository, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if repository != subject.RepositoryID {
		return deny()
	}
	return decision, nil
}

func authorizeStackCandidate(ctx context.Context, q *db.Queries, subject InstallSubject) (InstallAuthorization, error) {
	deny := func() (InstallAuthorization, error) { return InstallAuthorization{}, confirmationPermission() }
	info := middleware.AuthInfoFromContext(ctx)
	// A machine identity names a workspace, not the attempt running in it.
	// Require the issuer's run restriction too: a retained machine bearer
	// must not select a replacement attempt by copying its run into the body.
	if !InstallExecutionCredential(ctx) || info == nil || !info.Scopes.Has(middleware.ScopeWriteRepository) || subject.RunID == "" || subject.WorkspaceID == "" || middleware.ParseTokenAgentSessionRestriction(info.RawScopes) != subject.RunID {
		return deny()
	}
	decision, err := authorizeExecutionTodoRead(ctx, q, subject)
	if err != nil {
		return InstallAuthorization{}, err
	}
	item, err := q.GetMythicalItemByNumber(ctx, subject.RepositoryID, subject.TodoNumber)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if item.WorkspaceID != subject.WorkspaceID || item.RequestRunID != subject.RunID || item.Generation != subject.Generation || item.BaseCommit != subject.Base {
		return deny()
	}
	lane, err := q.GetMythicalLane(ctx, subject.WorkspaceID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return deny()
	}
	if err != nil {
		return InstallAuthorization{}, err
	}
	if lane.RetiredAt.Valid || lane.RepositoryID != subject.RepositoryID || lane.ItemID != item.ID {
		return deny()
	}
	stack, err := q.GetMythicalStack(ctx, subject.RepositoryID)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if !stack.ActorUserID.Valid || stack.State != "active" {
		return deny()
	}
	return decision, nil
}

// ResolveInstallCandidateSubject binds validated submission inputs to the
// current stored lane. A service reuses its router decision's generation;
// the serialized write guard refuses if that generation has since changed.
func ResolveInstallCandidateSubject(ctx context.Context, q *db.Queries, repositoryID int64, input MythicalLaneSubmission) (InstallSubject, error) {
	if err := validateMythicalLaneSubmission(input); err != nil {
		return InstallSubject{}, err
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return InstallSubject{}, err
	}
	digest := sha256.Sum256(encoded)
	payloadDigest := hex.EncodeToString(digest[:])
	if bound, ok := ctx.Value(installAuthorizationKey{}).(boundInstallAuthorization); ok && bound.command == "stack.candidate" {
		subject := bound.subject
		if subject.RepositoryID != repositoryID || subject.WorkspaceID != input.WorkspaceID || subject.RunID != input.RequestRunID || subject.Base != input.Base || subject.Source != input.Source || subject.PayloadDigest != payloadDigest {
			return InstallSubject{}, confirmationPermission()
		}
		return subject, nil
	}
	lane, err := q.GetMythicalLane(ctx, input.WorkspaceID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return InstallSubject{}, confirmationPermission()
	}
	if err != nil {
		return InstallSubject{}, err
	}
	item, err := q.GetMythicalItem(ctx, lane.ItemID)
	if err != nil {
		return InstallSubject{}, err
	}
	return InstallSubject{RepositoryID: repositoryID, WorkspaceID: input.WorkspaceID, TodoNumber: item.Number.Int64, Generation: item.Generation, RunID: input.RequestRunID, Base: input.Base, Source: input.Source, PayloadDigest: payloadDigest}, nil
}

func ResolveInstallExecutionSubject(ctx context.Context, q *db.Queries, repository int64) (InstallSubject, error) {
	info := middleware.AuthInfoFromContext(ctx)
	if !InstallExecutionCredential(ctx) {
		return InstallSubject{}, confirmationPermission()
	}
	workspace := info.WorkspaceRestriction()
	if info.CredentialKind() == middleware.CredentialAgentRun {
		workspace = middleware.ParseTokenLandingWorkspace(info.RawScopes)
	}
	if workspace == "" {
		return InstallSubject{}, confirmationPermission()
	}
	lane, err := q.GetMythicalLane(ctx, workspace)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return InstallSubject{}, confirmationPermission()
	}
	if err != nil {
		return InstallSubject{}, err
	}
	if lane.RepositoryID != repository || lane.RetiredAt.Valid {
		return InstallSubject{}, confirmationPermission()
	}
	item, err := q.GetMythicalItem(ctx, lane.ItemID)
	if err != nil {
		return InstallSubject{}, err
	}
	return InstallSubject{RepositoryID: repository, WorkspaceID: workspace, TodoNumber: item.Number.Int64}, nil
}

// ResolveReservedStackSubject uses issuer-owned authority, never operation payload fields.
func ResolveReservedStackSubject(ctx context.Context, q *db.Queries, repository int64, workspace string) (InstallSubject, error) {
	info := middleware.AuthInfoFromContext(ctx)
	if !InstallExecutionCredential(ctx) || info == nil || middleware.ParseTokenAgentSessionRestriction(info.RawScopes) == "" {
		return InstallSubject{}, confirmationPermission()
	}
	subject, err := ResolveInstallExecutionSubject(ctx, q, repository)
	if err != nil {
		return InstallSubject{}, err
	}
	if subject.WorkspaceID != workspace {
		return InstallSubject{}, confirmationPermission()
	}
	item, err := q.GetMythicalItemByNumber(ctx, repository, subject.TodoNumber)
	if err != nil {
		return InstallSubject{}, err
	}
	subject.RunID = middleware.ParseTokenAgentSessionRestriction(info.RawScopes)
	subject.Base, subject.Generation, subject.Attempt = item.BaseCommit, item.Generation, item.Attempt
	return subject, nil
}

// BoundInstallExecutionRead tells the retained snapshot door to encode only
// execution state after the router has authorized its stored lane subject.
func BoundInstallExecutionRead(ctx context.Context) bool {
	bound, ok := ctx.Value(installAuthorizationKey{}).(boundInstallAuthorization)
	return ok && bound.command == "repo.read" && bound.subject.TodoNumber > 0 && InstallExecutionCredential(ctx)
}

// A machine creator retains no read authority after the TODO sponsor changes.
func executionTodoSponsorMatches(info *middleware.AuthInfo, item db.MythicalItem) bool {
	if info == nil || info.User == nil || !item.OwnerID.Valid || item.OwnerID.Int64 != info.User.ID || item.Attempt <= 0 || item.RequestRunID == "" {
		return false
	}
	return info.CredentialKind() != middleware.CredentialAgentRun || middleware.ParseTokenAgentSessionRestriction(info.RawScopes) == item.RequestRunID
}

// A run may execute a child flow only through a consumer that carries its
// exact current attempt and validated launch payload. The ordinary person
// invocation/relay has no such contract and continues to fail closed.
func authorizeOwnRunFlow(ctx context.Context, q *db.Queries, subject InstallSubject) (InstallAuthorization, error) {
	decision, err := authorizeExecutionTodoRead(ctx, q, subject)
	if err != nil {
		return InstallAuthorization{}, err
	}
	info := middleware.AuthInfoFromContext(ctx)
	if info.CredentialKind() != middleware.CredentialAgentRun || !info.Scopes.Has(middleware.ScopeWriteRepository) || subject.WorkspaceID == "" || subject.RunID == "" || subject.Attempt <= 0 || subject.PayloadDigest == "" || subject.Resource == "" {
		return InstallAuthorization{}, confirmationPermission()
	}
	flowName, valid := invokeFlowID(subject.Resource)
	payload, digestErr := hex.DecodeString(subject.PayloadDigest)
	if !valid || !Overridable(flowName) || digestErr != nil || len(payload) != sha256.Size {
		return InstallAuthorization{}, confirmationPermission()
	}
	item, err := q.GetMythicalItemByNumber(ctx, subject.RepositoryID, subject.TodoNumber)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if item.RequestRunID != subject.RunID || item.Attempt != subject.Attempt || item.Generation != subject.Generation || item.State != "running" || item.PausedAt.Valid {
		return InstallAuthorization{}, confirmationPermission()
	}
	workspace, err := q.GetWorkspace(ctx, subject.WorkspaceID)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if workspace.Status != "running" {
		return InstallAuthorization{}, confirmationPermission()
	}
	return decision, nil
}

// lockInstallSessionWrite checks credential and membership liveness under the
// caller's roster lock. It preserves an admitted command's role decision.
func lockInstallSessionWrite(ctx context.Context, tx pgx.Tx, actorID int64) error {
	info := middleware.AuthInfoFromContext(ctx)
	dead := func() error {
		return &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
	}
	if info == nil || info.User == nil || info.User.ID != actorID || info.IsTokenAuth || info.SessionHash == "" {
		return dead()
	}
	// Account disable/delete is another credential-death transition. Keep its
	// row stable through the effect, in the same roster → user → session order.
	var liveUser int64
	if err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND is_active AND NOT prohibit_login AND deleted_at IS NULL FOR SHARE`, actorID).Scan(&liveUser); stdErrors.Is(err, pgx.ErrNoRows) {
		return dead()
	} else if err != nil {
		return err
	}
	// Find the stored key without locking unrelated sessions. Earlier rows
	// stored the raw cookie; the live principal still carries its digest.
	rows, err := tx.Query(ctx, `SELECT session_key FROM auth_sessions WHERE user_id=$1 AND expires_at>now()`, actorID)
	if err != nil {
		return err
	}
	key := ""
	for rows.Next() {
		var stored string
		if err = rows.Scan(&stored); err != nil {
			rows.Close()
			return err
		}
		if stored == info.SessionHash || (middleware.LegacyRawSessionKey(stored) && sessionStorageKey(stored) == info.SessionHash) {
			key = stored
			break
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if key == "" {
		return dead()
	}
	// Logout deletes this row, so exactly this credential is serialized too.
	err = tx.QueryRow(ctx, `SELECT session_key FROM auth_sessions WHERE session_key=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE`, key, actorID).Scan(&key)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return dead()
	}
	if err != nil {
		return err
	}
	queries := db.New(tx)
	role, err := InstallRoleOf(ctx, queries, actorID)
	if err != nil {
		return err
	}
	if role == "" {
		return dead()
	}
	if err := identity.NewMemberBoundary(queries).AuthorizeMember(identity.WithMemberRoute(ctx), actorID); err != nil {
		return err
	}
	return nil

}
