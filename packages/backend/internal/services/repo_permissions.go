package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
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
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		slog.Error("failed to begin repository ownership guard transaction", "repo_id", snapshot.ID, "error", err)
		return pkgerrors.Internal("failed to serialize repository write").WithCause(err)
	}
	// The transaction only holds the shared lock; rolling it back releases the
	// lock after the write completes and never discards data.
	defer func() { _ = tx.Rollback(ctx) }()

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

// installCommand is one person command's policy: the least role it needs,
// and whether it is person-only (§5.2's delegated `never`).
type installCommand struct {
	role InstallRole
	// personOnly refuses every credential but the person's own browser
	// session once the role check passes: a delegated credential is
	// refused with never (no confirmation path), any other with
	// permission (spec §5.2.1).
	personOnly bool
}

// installCommands is the policy of each person command the install serves
// (mvp.md §6.15, M-05): members read the install and its repository, ask
// the app agent and work TODOs; maintainers merge, manage people and write
// the repository's secrets. A command absent here is refused.
var installCommands = map[string]installCommand{
	"install.read":     {role: InstallMember},
	"self.read":        {role: InstallMember},
	"telemetry.report": {role: InstallMember},
	"repo.read":        {role: InstallMember},
	"wiki.read":        {role: InstallMember},
	"sync.read":        {role: InstallMember},
	"sync.retry":       {role: InstallMember},
	"live":             {role: InstallMember},
	"agent.turn":       {role: InstallMember},
	"issue.read":       {role: InstallMember},
	"todo.read":        {role: InstallMember},
	"todo.new":         {role: InstallMember},
	"todo.answer":      {role: InstallMember},
	// todo.control is POST /api/todos/{n}; its handler authorizes the
	// control itself: steer, stop, resume, retry, drop or move.
	"todo.control": {role: InstallMember},
	"todo.steer":   {role: InstallMember},
	"todo.amend":   {role: InstallMember},
	"todo.stop":    {role: InstallMember},
	"todo.resume":  {role: InstallMember},
	"todo.retry":   {role: InstallMember},
	"todo.drop":    {role: InstallMember},
	"stack.move":   {role: InstallMember},
	"merge":        {role: InstallMaintainer},
	"flows.read":   {role: InstallMember},
	// Branches (spec §6.3): any member reads them and forks a scratch
	// branch (§15.1.5: fork is run).
	"branches.read": {role: InstallMember},
	"branch.fork":   {role: InstallMember},
	"members.list":  {role: InstallMember},
	"members.write": {role: InstallMaintainer},
	// secrets.write is POST /secrets and PATCH and DELETE /secrets/{name}
	// on a repository: add, replace and delete (§5.2 "Members, roles,
	// secrets write"). Secret values never pass through an agent.
	"secrets.write": {role: InstallMaintainer, personOnly: true},
}

// terminalCommands are the commands a stage-1 terminal credential runs for
// its member (spec §8.11.1, §5.3.2a): the eligible reads and wiki reads;
// answer and steer, on its own branch's TODO only (AuthorizeTodoBranch);
// todo.control, the steer door, whose handler authorizes the op again; and
// todo.new, which a delegated credential confirms in the app.
var terminalCommands = map[string]bool{"self.read": true, "repo.read": true, "todo.read": true, "wiki.read": true,
	"todo.answer": true, "todo.steer": true, "todo.control": true, "todo.new": true}

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
func Authorize(ctx context.Context, q *db.Queries, command string) (InstallAuthorization, error) {
	need, ok := installCommands[command]
	if !ok {
		return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Not available"}
	}
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil {
		return InstallAuthorization{}, &AccessError{Status: http.StatusUnauthorized, Class: "permission", Code: "unauthenticated", Message: "Sign in"}
	}
	if need.personOnly {
		return authorizePersonOnly(ctx, q, info, need.role)
	}
	_, terminal := info.TerminalDelegation()
	if terminal {
		// A member's terminal credential acts as that member (spec §8.11.1);
		// the auth loader already confined it to its profile's routes.
		if !terminalCommands[command] {
			return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "A terminal's credential cannot do this"}
		}
	} else if info.IsTokenAuth || info.IsAgent() || info.SessionHash == "" {
		return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Sign in with a browser session"}
	}
	role, err := InstallRoleOf(ctx, q, info.User.ID)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if role == "" {
		return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Not a member"}
	}
	if role.rank() < need.role.rank() {
		return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Only a maintainer can do this"}
	}
	if terminal && command == "todo.new" {
		// A delegated TODO waits for its person's Confirm in the app, which
		// stage 1 does not serve yet: nothing is filed (T-APP-04).
		return InstallAuthorization{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "confirm_in_app", Message: "Confirm in the app"}
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

// PersonOnlyCommand reports whether command refuses every credential but a
// person's own browser session, the install owner's included.
func PersonOnlyCommand(command string) bool {
	return installCommands[command].personOnly
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
	setting, err := q.GetInstallSetting(ctx, "github.repository")
	if err != nil {
		return 0, err
	}
	var binding struct {
		Owner string `json:"owner_login"`
		Name  string `json:"repository_name"`
	}
	if err = json.Unmarshal(setting.Value, &binding); err != nil || binding.Owner == "" || binding.Name == "" {
		return 0, &AccessError{Status: http.StatusServiceUnavailable, Class: "infra", Code: "unavailable", Message: "Repository unavailable"}
	}
	row, err := q.GetRepoByOwnerAndName(ctx, db.GetRepoByOwnerAndNameParams{Owner: binding.Owner, Name: binding.Name})
	return row.ID, err
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
