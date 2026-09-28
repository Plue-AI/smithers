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

// accountErasureRetained lists user-owned tables an erase keeps: sandbox
// usage intervals are metering evidence behind invoices.
var accountErasureRetained = map[string]bool{"sandbox_usage_intervals": true}

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
// writes an admin.user.erase audit event.
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

	user, err := q.AdminGetUserForErasure(ctx, lower)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		user, err = q.AdminFindErasedUser(ctx, erasedUserPrefixFor(lower))
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return EraseUserResult{}, pkgerrors.NotFound("user not found")
		}
	}
	if err != nil {
		return EraseUserResult{}, pkgerrors.Internal("failed to look up user").WithCause(err)
	}
	if isErasedUser(user) {
		result := EraseUserResult{UserID: user.ID, Tombstone: user.Username, AlreadyErased: true}
		if err := s.insertEraseAudit(ctx, q, result, req); err != nil {
			return EraseUserResult{}, err
		}
		return result, nil
	}

	result := EraseUserResult{UserID: user.ID, Tombstone: erasedUserPrefixFor(lower) + fmt.Sprint(user.ID)}
	blocked, err := q.AdminBlockUserLoginForErasure(ctx, user.ID)
	if err != nil {
		return EraseUserResult{}, pkgerrors.Internal("failed to block sign-in").WithCause(err)
	}
	result.RowsChanged += blocked

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

	changed, err := s.eraseUserRows(ctx, user.ID, result.Tombstone, repoIDs)
	if err != nil {
		return EraseUserResult{}, err
	}
	result.RowsChanged += changed
	if err := s.insertEraseAudit(ctx, q, result, req); err != nil {
		return EraseUserResult{}, err
	}
	return result, nil
}

// eraseUserRows tombstones the users row and deletes the remaining owned rows
// in one transaction, after repository and workspace teardown.
func (s *AdminUserService) eraseUserRows(ctx context.Context, userID int64, tombstone string, repoIDs []int64) (int64, error) {
	tx, err := s.erasure.Pool.Begin(ctx)
	if err != nil {
		return 0, pkgerrors.Internal("failed to begin erase").WithCause(err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	q := db.New(tx)

	live, err := q.AdminCountUserLiveResources(ctx, userID)
	if err != nil {
		return 0, pkgerrors.Internal("failed to count live resources").WithCause(err)
	}
	if live.Repositories > 0 || live.Workspaces > 0 {
		return 0, pkgerrors.Conflict(fmt.Sprintf("user still owns %d repositories and %d workspaces; retry the erase", live.Repositories, live.Workspaces))
	}

	// Rename first: the owner-namespace trigger moves the namespace row to the
	// tombstone, and the cascade sweep below then deletes it.
	changed, err := q.AdminTombstoneUser(ctx, db.AdminTombstoneUserParams{UserID: userID, Tombstone: tombstone})
	if err != nil {
		return 0, pkgerrors.Internal("failed to tombstone user").WithCause(err)
	}

	refs, err := q.AdminListUserCascadeReferences(ctx)
	if err != nil {
		return 0, pkgerrors.Internal("failed to list owned tables").WithCause(err)
	}
	for _, ref := range refs {
		if accountErasureRetained[ref.TableName] {
			continue
		}
		// Table names come from pg_constraint, never from the request.
		tag, err := tx.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE %s = $1`, ref.TableName, pgx.Identifier{ref.ColumnName}.Sanitize()), userID)
		if err != nil {
			return 0, pkgerrors.Internal("failed to delete " + ref.TableName).WithCause(err)
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
		func() (int64, error) {
			return q.AdminScrubUserWikiRevisions(ctx, db.AdminScrubUserWikiRevisionsParams{UserID: userID, Tombstone: tombstone})
		},
	}
	for _, step := range steps {
		n, err := step()
		if err != nil {
			return 0, pkgerrors.Internal("failed to erase user data").WithCause(err)
		}
		changed += n
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, pkgerrors.Internal("failed to commit erase").WithCause(err)
	}
	return changed, nil
}

// insertEraseAudit writes the audit event synchronously: an erase without
// its audit record is a failed erase.
func (s *AdminUserService) insertEraseAudit(ctx context.Context, q *db.Queries, result EraseUserResult, req EraseUserRequest) error {
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
		EventType:  "admin.user.erase",
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
