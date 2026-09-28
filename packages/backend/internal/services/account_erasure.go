package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AccountErasure wires the stores an account erase needs. Repositories and
// workspaces are deleted through their services so repo-host storage and
// sandbox VMs are torn down, never orphaned by a raw row delete.
type AccountErasure struct {
	Pool interface {
		db.DBTX
		Begin(context.Context) (pgx.Tx, error)
	}
	Repos interface {
		DeleteRepo(ctx context.Context, actor *db.User, owner, repo string) error
	}
	Workspaces interface {
		DeleteWorkspaceSnapshot(ctx context.Context, snapshotID string, repositoryID, userID int64) error
		DeleteWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) error
	}
}

// WithAccountErasure enables EraseUser.
func WithAccountErasure(e AccountErasure) AdminUserServiceOption {
	return func(s *AdminUserService) {
		s.erasure = &e
	}
}

// EraseUserRequest carries the date the account holder asked for deletion,
// which starts the 30-day clock the privacy policy promises.
type EraseUserRequest struct {
	RequestedAt time.Time `json:"requested_at"`
}

// EraseUserResult reports what an erase changed.
type EraseUserResult struct {
	UserID        int64  `json:"user_id"`
	Tombstone     string `json:"tombstone"`
	AlreadyErased bool   `json:"already_erased"`
	RowsChanged   int64  `json:"rows_changed"`
	Repositories  int    `json:"repositories"`
	Workspaces    int    `json:"workspaces"`
}

// accountErasureRetained lists tables an erase keeps although their user
// foreign key cascades: sandbox usage intervals are metering evidence behind
// invoices, and releases, their assets and job approvals belong to the
// repository they were made in. Rows in the user's own repositories already
// went with those repositories.
var accountErasureRetained = map[string]bool{
	"sandbox_usage_intervals":  true,
	"releases":                 true,
	"release_assets":           true,
	"repository_job_approvals": true,
}

const erasedUserPrefix = "erased-"

// erasedUserPrefixFor derives the tombstone prefix from the original
// username, so a repeated erase request finds the tombstone without storing
// the username.
func erasedUserPrefixFor(lowerUsername string) string {
	sum := sha256.Sum256([]byte(lowerUsername))
	return erasedUserPrefix + hex.EncodeToString(sum[:8]) + "-"
}

// EraseUser deletes the account's owned data and replaces the users row with
// a tombstone identity. Owned repositories, workspaces and their sandboxes,
// sessions, tokens, SSH keys, provider connections, chat turns and every
// other row the schema cascades from the user are removed. Billing, credit
// ledger and tax rows are kept; comments and other contributions in
// repositories the user does not own stay attributed to the tombstone.
// Erasing an already-erased user changes nothing and succeeds. Every call
// writes an admin.user.erase audit event; an erase that destroys anything
// first writes an admin.user.erase_started receipt.
//
// The request date also resolves the username: an account created after the
// deletion request cannot be the requester, so a retry after the freed name
// was re-registered resolves the original tombstone and never touches the new
// account.
func (s *AdminUserService) EraseUser(ctx context.Context, username string, req EraseUserRequest) (EraseUserResult, error) {
	if s.erasure == nil {
		return EraseUserResult{}, pkgerrors.Internal("account erasure not configured")
	}
	lower := strings.ToLower(strings.TrimSpace(username))
	if lower == "" {
		return EraseUserResult{}, pkgerrors.BadRequest("username is required")
	}
	if req.RequestedAt.IsZero() {
		return EraseUserResult{}, pkgerrors.BadRequest("request date is required")
	}
	q := db.New(s.erasure.Pool)

	// Accounts created by the end of the request day could have asked.
	createdBefore := req.RequestedAt.UTC().Truncate(24 * time.Hour).Add(24 * time.Hour)
	user, err := q.AdminGetUserForErasure(ctx, lower)
	live := err == nil
	if err == nil && !user.CreatedAt.Before(createdBefore) || stdErrors.Is(err, pgx.ErrNoRows) {
		user, err = q.AdminFindErasedUser(ctx, db.AdminFindErasedUserParams{TombstonePrefix: erasedUserPrefixFor(lower), CreatedBefore: createdBefore})
		if stdErrors.Is(err, pgx.ErrNoRows) {
			if live {
				return EraseUserResult{}, pkgerrors.Conflict("user " + lower + " was created after the deletion request date")
			}
			return EraseUserResult{}, pkgerrors.NotFound("user not found")
		}
	}
	if err != nil {
		return EraseUserResult{}, pkgerrors.Internal("failed to look up user").WithCause(err)
	}
	if isErasedUser(user) {
		result := EraseUserResult{UserID: user.ID, Tombstone: user.Username, AlreadyErased: true}
		if err := s.insertEraseAudit(ctx, q, "admin.user.erase", result, req); err != nil {
			return EraseUserResult{}, err
		}
		return result, nil
	}

	result := EraseUserResult{UserID: user.ID, Tombstone: erasedUserPrefixFor(lower) + fmt.Sprint(user.ID)}
	// The receipt lands before anything is destroyed, so a partial erase
	// always has an audit record of who asked for it and when.
	if err := s.insertEraseAudit(ctx, q, "admin.user.erase_started", result, req); err != nil {
		return EraseUserResult{}, err
	}
	blocked, err := q.AdminBlockUserLoginForErasure(ctx, user.ID)
	if err != nil {
		return EraseUserResult{}, pkgerrors.Internal("failed to block sign-in").WithCause(err)
	}
	result.RowsChanged += blocked

	// Snapshots go first, through the provider: the repository and
	// workspace deletes below would otherwise drop the rows that hold the
	// provider snapshot ids. A provider failure leaves the rows for the retry.
	snapshots, err := q.AdminListErasureSnapshots(ctx, user.ID)
	if err != nil {
		return EraseUserResult{}, pkgerrors.Internal("failed to list workspace snapshots").WithCause(err)
	}
	for _, snapshot := range snapshots {
		if err := s.erasure.Workspaces.DeleteWorkspaceSnapshot(ctx, snapshot.ID, snapshot.RepositoryID, snapshot.UserID); err != nil && !isNotFound(err) {
			return EraseUserResult{}, err
		}
	}
	result.RowsChanged += int64(len(snapshots))

	workspaces, err := q.AdminListErasureWorkspaces(ctx, user.ID)
	if err != nil {
		return EraseUserResult{}, pkgerrors.Internal("failed to list workspaces").WithCause(err)
	}
	for _, workspace := range workspaces {
		if err := s.erasure.Workspaces.DeleteWorkspace(ctx, workspace.ID, workspace.RepositoryID, workspace.UserID); err != nil && !isNotFound(err) {
			return EraseUserResult{}, err
		}
	}
	result.Workspaces = len(workspaces)

	repos, err := q.AdminListUserRepositories(ctx, user.ID)
	if err != nil {
		return EraseUserResult{}, pkgerrors.Internal("failed to list repositories").WithCause(err)
	}
	repoIDs := make([]int64, 0, len(repos))
	for _, repo := range repos {
		if err := s.erasure.Repos.DeleteRepo(ctx, &user, user.Username, repo.Name); err != nil && !isNotFound(err) {
			return EraseUserResult{}, err
		}
		repoIDs = append(repoIDs, repo.ID)
	}
	result.Repositories = len(repos)
	result.RowsChanged += int64(len(workspaces) + len(repos))

	if err := s.eraseUserRows(ctx, user, &result, req, repoIDs); err != nil {
		return EraseUserResult{}, err
	}
	return result, nil
}

// eraseUserRows tombstones the users row, deletes the remaining owned rows
// and writes the completion audit in one transaction, after repository and
// workspace teardown.
func (s *AdminUserService) eraseUserRows(ctx context.Context, user db.User, result *EraseUserResult, req EraseUserRequest, repoIDs []int64) error {
	userID, tombstone := user.ID, result.Tombstone
	tx, err := s.erasure.Pool.Begin(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to begin erase").WithCause(err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	q := db.New(tx)

	live, err := q.AdminCountUserLiveResources(ctx, userID)
	if err != nil {
		return pkgerrors.Internal("failed to count live resources").WithCause(err)
	}
	if live.Repositories > 0 || live.Workspaces > 0 {
		return pkgerrors.Conflict(fmt.Sprintf("user still owns %d repositories and %d workspaces; retry the erase", live.Repositories, live.Workspaces))
	}

	// The waitlist is keyed by email, which the tombstone clears.
	var waitlist int64
	if user.LowerEmail.Valid && user.LowerEmail.String != "" {
		n, err := q.AdminDeleteUserWaitlistEntries(ctx, user.LowerEmail.String)
		if err != nil {
			return pkgerrors.Internal("failed to delete waitlist entries").WithCause(err)
		}
		waitlist = n
	}

	// Rename first: the owner-namespace trigger moves the namespace row to the
	// tombstone, and the cascade sweep below then deletes it.
	changed, err := q.AdminTombstoneUser(ctx, db.AdminTombstoneUserParams{UserID: userID, Tombstone: tombstone})
	if err != nil {
		return pkgerrors.Internal("failed to tombstone user").WithCause(err)
	}
	changed += waitlist

	refs, err := q.AdminListUserCascadeReferences(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to list owned tables").WithCause(err)
	}
	for _, ref := range refs {
		if accountErasureRetained[ref.TableName] {
			continue
		}
		// Table names come from pg_constraint, never from the request.
		tag, err := tx.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE %s = $1`, ref.TableName, pgx.Identifier{ref.ColumnName}.Sanitize()), userID)
		if err != nil {
			return pkgerrors.Internal("failed to delete " + ref.TableName).WithCause(err)
		}
		changed += tag.RowsAffected()
	}

	steps := []func() (int64, error){
		func() (int64, error) {
			return q.AdminDeleteUserChatTurns(ctx, db.AdminDeleteUserChatTurnsParams{UserID: userID, RepositoryIds: repoIDs})
		},
		func() (int64, error) { return q.AdminDeleteUserNotificationFacts(ctx, userID) },
		func() (int64, error) { return q.AdminDeleteUserIssueStateFacts(ctx, userID) },
		func() (int64, error) {
			return q.AdminScrubUserAuditActor(ctx, db.AdminScrubUserAuditActorParams{UserID: userID, Tombstone: tombstone})
		},
		func() (int64, error) {
			return q.AdminScrubUserAuditTarget(ctx, db.AdminScrubUserAuditTargetParams{UserID: userID, Tombstone: tombstone})
		},
		func() (int64, error) { return q.AdminScrubUserAuditDetail(ctx, userID) },
		func() (int64, error) { return q.AdminScrubUserBillingIdentity(ctx, userID) },
		func() (int64, error) {
			return q.AdminScrubUserPushEvents(ctx, db.AdminScrubUserPushEventsParams{UserID: userID, Tombstone: tombstone})
		},
		func() (int64, error) {
			return q.AdminScrubUserWikiRevisions(ctx, db.AdminScrubUserWikiRevisionsParams{UserID: userID, Tombstone: tombstone})
		},
	}
	for _, step := range steps {
		n, err := step()
		if err != nil {
			return pkgerrors.Internal("failed to erase user data").WithCause(err)
		}
		changed += n
	}
	result.RowsChanged += changed
	if err := s.insertEraseAudit(ctx, q, "admin.user.erase", *result, req); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return pkgerrors.Internal("failed to commit erase").WithCause(err)
	}
	return nil
}

// insertEraseAudit writes the audit event synchronously: an erase without
// its audit record is a failed erase.
func (s *AdminUserService) insertEraseAudit(ctx context.Context, q *db.Queries, eventType string, result EraseUserResult, req EraseUserRequest) error {
	actor, _ := AdminAuditActorFromContext(ctx)
	metadata, err := json.Marshal(map[string]any{
		"operator":       actor.Username,
		"request_date":   req.RequestedAt.UTC().Format(time.DateOnly),
		"already_erased": result.AlreadyErased,
		"rows_changed":   result.RowsChanged,
		"repositories":   result.Repositories,
		"workspaces":     result.Workspaces,
	})
	if err != nil {
		return pkgerrors.Internal("failed to encode erase audit").WithCause(err)
	}
	params := db.InsertAuditLogParams{
		EventType:  eventType,
		ActorName:  actor.Username,
		TargetType: "user",
		TargetID:   pgtype.Int8{Int64: result.UserID, Valid: true},
		TargetName: result.Tombstone,
		Action:     "erase",
		Metadata:   metadata,
		IpAddress:  actor.IPAddress,
	}
	if actor.UserID != 0 {
		params.ActorID = pgtype.Int8{Int64: actor.UserID, Valid: true}
	}
	if err := q.InsertAuditLog(ctx, params); err != nil {
		return pkgerrors.Internal("failed to audit erase").WithCause(err)
	}
	return nil
}

// isErasedUser matches only the exact tombstone shape for this row, so a live
// account that merely starts with "erased-" is never mistaken for one.
func isErasedUser(user db.User) bool {
	return erasedUserName.MatchString(user.LowerUsername) &&
		strings.HasSuffix(user.LowerUsername, "-"+strconv.FormatInt(user.ID, 10)) &&
		user.DeletedAt.Valid && !user.IsActive
}

var erasedUserName = regexp.MustCompile(`^erased-[0-9a-f]{16}-[0-9]+$`)

func isNotFound(err error) bool {
	var apiErr *pkgerrors.APIError
	return stdErrors.As(err, &apiErr) && apiErr.Code == pkgerrors.CodeNotFound
}
