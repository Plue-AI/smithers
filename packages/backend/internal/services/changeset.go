package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// OrgSuperprojectRepoName is the reserved repository name of an organization's
// superproject: one git superproject whose tree holds a gitlink per member
// repository. It is created lazily by the first changeset and lives on
// repo-host like any other repository, so humans can clone it recursively.
const OrgSuperprojectRepoName = "superproject"

// maxChangesetMembers bounds one changeset so a landing transaction stays a
// bounded number of repo-host mutations.
const maxChangesetMembers = 32

// changesetLandAdvisoryLockKey namespaces the per-organization advisory lock
// that serializes changeset landings (key2 is the organization id).
const changesetLandAdvisoryLockKey int32 = 0x5c4a5e75

const (
	changesetStatePending = "pending"
	changesetStateLanding = "landing"
	changesetStateLanded  = "landed"
	changesetStateFailed  = "failed"
)

// ChangesetQuerier is the DB surface the changeset service needs.
type ChangesetQuerier interface {
	SaveChangesetLandingPlan(context.Context, db.SaveChangesetLandingPlanParams) (db.Changeset, error)
	RepoPermQuerier
	ListAllProtectedBookmarksByRepo(context.Context, int64) ([]db.ProtectedBookmark, error)
	GetLatestLandingRequestForChange(context.Context, db.GetLatestLandingRequestForChangeParams) (db.LandingRequest, error)
	GetLandingRequestWithChangeIDsByNumber(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error)
	CreateChangesetWithMembers(context.Context, db.CreateChangesetWithMembersParams) (db.CreateChangesetWithMembersRow, error)

	GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
	GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error)
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetChangesetByID(ctx context.Context, id int64) (db.Changeset, error)
	GetChangesetByOrgAndID(ctx context.Context, arg db.GetChangesetByOrgAndIDParams) (db.Changeset, error)
	ListChangesetMembers(ctx context.Context, changesetID int64) ([]db.ChangesetMember, error)
	ListChangesetsByOrg(ctx context.Context, arg db.ListChangesetsByOrgParams) ([]db.Changeset, error)
	MarkChangesetLanded(ctx context.Context, arg db.MarkChangesetLandedParams) (db.Changeset, error)
	MarkChangesetFailed(ctx context.Context, arg db.MarkChangesetFailedParams) (db.Changeset, error)
	RecordChangesetMemberPreviousCommit(ctx context.Context, arg db.RecordChangesetMemberPreviousCommitParams) error
	RecordChangesetMemberLanded(ctx context.Context, arg db.RecordChangesetMemberLandedParams) error
}

// ChangesetRepoHostClient is the repo-host surface the changeset service needs.
type ChangesetRepoHostClient interface {
	GetChange(ctx context.Context, owner, repo, changeID string) (repohost.Change, error)
	ListBookmarks(ctx context.Context, owner, repo string, cursor string, limit int) ([]repohost.Bookmark, string, error)
	LandChanges(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error)
	CreateBookmark(ctx context.Context, owner, repo string, req repohost.CreateBookmarkRequest) (repohost.Bookmark, error)
	DeleteBookmark(ctx context.Context, owner, repo, name string) error
	ComposeSuperproject(ctx context.Context, owner, repo string, req repohost.ComposeSuperprojectRequest) (repohost.SuperprojectCommit, error)
	GetSuperproject(ctx context.Context, owner, repo, revision string) (repohost.SuperprojectCommit, error)
	BackoutChange(ctx context.Context, owner, repo, changeID string, req repohost.BackoutChangeRequest) (repohost.Change, error)
}

// SuperprojectCreator creates the organization superproject repository on
// first use. *RepoService satisfies it.
type SuperprojectCreator interface {
	CreateOrgRepo(ctx context.Context, actor *db.User, orgName, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error)
}

// ChangesetLocker serializes landings per organization.
type ChangesetLocker interface {
	LockOrganization(ctx context.Context, organizationID int64) (unlock func(), err error)
}

// pgxChangesetLocker holds a session-level advisory lock on a dedicated
// connection for the duration of one landing, without keeping a transaction
// open across repo-host calls.
type pgxChangesetLocker struct {
	pool *pgxpool.Pool
}

func (l *pgxChangesetLocker) LockOrganization(ctx context.Context, organizationID int64) (func(), error) {
	conn, err := l.pool.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire changeset lock connection: %w", err)
	}
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1, $2)", changesetLandAdvisoryLockKey, int32(organizationID)); err != nil {
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		_ = conn.Hijack().Close(closeCtx)
		return nil, fmt.Errorf("acquire changeset advisory lock: %w", err)
	}
	return func() {
		unlockCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if _, err := conn.Exec(unlockCtx, "SELECT pg_advisory_unlock($1, $2)", changesetLandAdvisoryLockKey, int32(organizationID)); err != nil {
			slog.Warn("release changeset advisory lock failed; closing connection", "error", err)
			_ = conn.Hijack().Close(unlockCtx)
			return
		}
		conn.Release()
	}, nil
}

// memoryChangesetLocker is the in-process fallback used without a pool
// (single-replica dev servers and unit tests).
type memoryChangesetLocker struct {
	mu    sync.Mutex
	locks map[int64]*sync.Mutex
}

func (l *memoryChangesetLocker) LockOrganization(_ context.Context, organizationID int64) (func(), error) {
	l.mu.Lock()
	if l.locks == nil {
		l.locks = map[int64]*sync.Mutex{}
	}
	m, ok := l.locks[organizationID]
	if !ok {
		m = &sync.Mutex{}
		l.locks[organizationID] = m
	}
	l.mu.Unlock()
	m.Lock()
	return m.Unlock, nil
}

// ChangesetService creates and lands cross-repository changesets: one
// organization-superproject commit that pins a vector of member-repository
// changes, landed as a transaction across every member.
type ChangesetService struct {
	queries       ChangesetQuerier
	repoHost      ChangesetRepoHostClient
	creator       SuperprojectCreator
	locker        ChangesetLocker
	now           func() time.Time
	landingPolicy *LandingService
}

// ChangesetServiceOption customizes a ChangesetService.
type ChangesetServiceOption func(*ChangesetService)

// WithChangesetLocker overrides the per-organization landing lock.
func WithChangesetLocker(locker ChangesetLocker) ChangesetServiceOption {
	return func(s *ChangesetService) { s.locker = locker }
}

// WithChangesetLandingPolicy uses the ordinary landing request gates for protected targets.
func WithChangesetLandingPolicy(policy *LandingService) ChangesetServiceOption {
	return func(s *ChangesetService) { s.landingPolicy = policy }
}

// NewChangesetService constructs the service. pool may be nil (in-process
// locking). creator may be nil, in which case the organization superproject
// must already exist.
func NewChangesetService(q ChangesetQuerier, rh ChangesetRepoHostClient, creator SuperprojectCreator, pool *pgxpool.Pool, opts ...ChangesetServiceOption) *ChangesetService {
	s := &ChangesetService{
		queries:  q,
		repoHost: rh,
		creator:  creator,
		now:      time.Now,
	}
	if pool != nil {
		s.locker = &pgxChangesetLocker{pool: pool}
	} else {
		s.locker = &memoryChangesetLocker{}
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// ChangesetMemberInput names one member change to pin.
type ChangesetMemberInput struct {
	Repo           string `json:"repo"`
	ChangeID       string `json:"change_id"`
	TargetBookmark string `json:"target_bookmark,omitempty"`
}

// CreateChangesetInput is the create request.
type CreateChangesetInput struct {
	Description    string                 `json:"description"`
	TargetBookmark string                 `json:"target_bookmark,omitempty"`
	ParentChangeID string                 `json:"parent_change_id,omitempty"`
	Members        []ChangesetMemberInput `json:"members"`
}

// ChangesetMemberResponse is one pinned member.
type ChangesetMemberResponse struct {
	RepositoryID     int64  `json:"repository_id"`
	Repository       string `json:"repository"`
	Path             string `json:"path"`
	ChangeID         string `json:"change_id"`
	CommitID         string `json:"commit_id"`
	TargetBookmark   string `json:"target_bookmark"`
	PreviousCommitID string `json:"previous_commit_id,omitempty"`
	LandedCommitID   string `json:"landed_commit_id,omitempty"`
}

// ChangesetResponse is the API representation of a changeset.
type ChangesetResponse struct {
	ID              int64                     `json:"id"`
	Organization    string                    `json:"organization"`
	Superproject    string                    `json:"superproject"`
	ChangeID        string                    `json:"change_id"`
	CommitID        string                    `json:"commit_id"`
	LandedCommitID  string                    `json:"landed_commit_id,omitempty"`
	ParentChangeIDs []string                  `json:"parent_change_ids"`
	TargetBookmark  string                    `json:"target_bookmark"`
	Description     string                    `json:"description"`
	State           string                    `json:"state"`
	FailureReason   string                    `json:"failure_reason,omitempty"`
	CreatedAt       time.Time                 `json:"created_at"`
	LandedAt        *time.Time                `json:"landed_at,omitempty"`
	Members         []ChangesetMemberResponse `json:"members"`
}

// CreateChangeset validates every member, composes the superproject commit on
// repo-host, and records the changeset. Nothing lands here.
func (s *ChangesetService) CreateChangeset(ctx context.Context, actor *db.User, orgName string, input CreateChangesetInput) (ChangesetResponse, error) {
	if actor == nil {
		return ChangesetResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.requireOrgMember(ctx, actor, orgName)
	if err != nil {
		return ChangesetResponse{}, err
	}
	targetBookmark := normalizeDefaultBookmark(input.TargetBookmark)
	if err := validateDefaultBookmark(targetBookmark); err != nil {
		return ChangesetResponse{}, err
	}
	if len(input.Members) == 0 {
		return ChangesetResponse{}, pkgerrors.BadRequest("members is required")
	}
	if len(input.Members) > maxChangesetMembers {
		return ChangesetResponse{}, pkgerrors.BadRequest(fmt.Sprintf("a changeset may pin at most %d members", maxChangesetMembers))
	}

	type resolvedMember struct {
		repo     db.Repository
		changeID string
		commitID string
		target   string
	}
	resolved := make([]resolvedMember, 0, len(input.Members))
	seen := map[string]bool{}
	for _, member := range input.Members {
		name := strings.TrimSpace(member.Repo)
		if name == "" {
			return ChangesetResponse{}, pkgerrors.BadRequest("member repo is required")
		}
		if strings.Contains(name, "/") {
			// Members are named relative to the organization.
			parts := strings.SplitN(name, "/", 2)
			if !strings.EqualFold(strings.TrimSpace(parts[0]), org.Name) {
				return ChangesetResponse{}, pkgerrors.BadRequest(fmt.Sprintf("member %q is not in organization %s", name, org.Name))
			}
			name = strings.TrimSpace(parts[1])
		}
		lower := strings.ToLower(name)
		if lower == OrgSuperprojectRepoName {
			return ChangesetResponse{}, pkgerrors.BadRequest("the organization superproject cannot be a member of itself")
		}
		if seen[lower] {
			return ChangesetResponse{}, pkgerrors.BadRequest(fmt.Sprintf("member %q is listed twice", name))
		}
		seen[lower] = true
		changeID := strings.TrimSpace(member.ChangeID)
		if changeID == "" {
			return ChangesetResponse{}, pkgerrors.BadRequest(fmt.Sprintf("member %q needs a change_id", name))
		}
		memberTarget := targetBookmark
		if strings.TrimSpace(member.TargetBookmark) != "" {
			memberTarget = normalizeDefaultBookmark(member.TargetBookmark)
			if err := validateDefaultBookmark(memberTarget); err != nil {
				return ChangesetResponse{}, err
			}
		}
		repo, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: org.Name, LowerName: lower})
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return ChangesetResponse{}, pkgerrors.NotFound(fmt.Sprintf("repository %s/%s not found", org.Name, name))
			}
			return ChangesetResponse{}, pkgerrors.Internal("failed to load member repository").WithCause(err)
		}
		if !repo.OrgID.Valid || repo.OrgID.Int64 != org.ID {
			return ChangesetResponse{}, pkgerrors.BadRequest(fmt.Sprintf("repository %s does not belong to organization %s", name, org.Name))
		}
		if err := s.requireRepoAccess(ctx, repo, actor.ID, true); err != nil {
			return ChangesetResponse{}, err
		}
		change, err := s.repoHost.GetChange(ctx, org.Name, repo.Name, changeID)
		if err != nil {
			return ChangesetResponse{}, mapChangesetRepoHostError(err, fmt.Sprintf("change %s in %s", changeID, repo.Name), "failed to load member change")
		}
		if change.HasConflict {
			return ChangesetResponse{}, pkgerrors.Conflict(fmt.Sprintf("change %s in %s has unresolved conflicts", changeID, repo.Name))
		}
		resolved = append(resolved, resolvedMember{repo: repo, changeID: change.ChangeID, commitID: change.CommitID, target: memberTarget})
	}
	sort.Slice(resolved, func(i, j int) bool { return resolved[i].repo.LowerName < resolved[j].repo.LowerName })

	superproject, err := s.ensureSuperproject(ctx, actor, org, targetBookmark)
	if err != nil {
		return ChangesetResponse{}, err
	}

	composeReq := repohost.ComposeSuperprojectRequest{
		Bookmark:       targetBookmark,
		ParentChangeID: strings.TrimSpace(input.ParentChangeID),
		Description:    strings.TrimSpace(input.Description),
		Members:        make([]repohost.SuperprojectMember, 0, len(resolved)),
	}
	for _, m := range resolved {
		composeReq.Members = append(composeReq.Members, repohost.SuperprojectMember{Path: m.repo.Name, CommitID: m.commitID})
	}
	composed, err := s.repoHost.ComposeSuperproject(ctx, org.Name, superproject.Name, composeReq)
	if err != nil {
		return ChangesetResponse{}, mapChangesetRepoHostError(err, "superproject parent change", "failed to compose superproject commit")
	}

	parentChangeIDs := []string{}
	if composeReq.ParentChangeID != "" {
		parentChangeIDs = append(parentChangeIDs, composeReq.ParentChangeID)
	}
	parentJSON, _ := json.Marshal(parentChangeIDs)
	memberParams := make([]db.AddChangesetMemberParams, 0, len(resolved))
	for _, m := range resolved {
		memberParams = append(memberParams, db.AddChangesetMemberParams{RepositoryID: m.repo.ID, Path: m.repo.Name, ChangeID: m.changeID, CommitID: m.commitID, TargetBookmark: m.target})
	}
	membersJSON, err := json.Marshal(memberParams)
	if err != nil {
		return ChangesetResponse{}, pkgerrors.Internal("failed to encode changeset members").WithCause(err)
	}
	row, err := s.queries.CreateChangesetWithMembers(ctx, db.CreateChangesetWithMembersParams{
		OrganizationID: org.ID, SuperprojectRepositoryID: superproject.ID,
		ChangeID: composed.ChangeID, CommitID: composed.CommitID, ParentChangeIds: parentJSON,
		TargetBookmark: targetBookmark, Description: composed.Description,
		CreatedBy: pgtype.Int8{Int64: actor.ID, Valid: true}, Members: membersJSON,
	})
	if err != nil {
		return ChangesetResponse{}, pkgerrors.Internal("failed to record changeset and members").WithCause(err)
	}
	created := db.Changeset(row)
	members, err := s.queries.ListChangesetMembers(ctx, created.ID)
	if err != nil {
		return ChangesetResponse{}, pkgerrors.Internal("failed to reload changeset members").WithCause(err)
	}
	return s.buildResponse(ctx, org, superproject, created, members)
}

// GetChangeset returns one changeset with its members.
func (s *ChangesetService) GetChangeset(ctx context.Context, viewer *db.User, orgName string, id int64) (ChangesetResponse, error) {
	if viewer == nil {
		return ChangesetResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.requireOrgMember(ctx, viewer, orgName)
	if err != nil {
		return ChangesetResponse{}, err
	}
	cs, members, superproject, err := s.loadChangeset(ctx, org, id)
	if err != nil {
		return ChangesetResponse{}, err
	}
	if err := s.requireMembersAccess(ctx, viewer.ID, members, false); err != nil {
		return ChangesetResponse{}, err
	}
	return s.buildResponse(ctx, org, superproject, cs, members)
}

// ListChangesets returns a page of an organization's changesets.
func (s *ChangesetService) ListChangesets(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]ChangesetResponse, error) {
	if viewer == nil {
		return nil, pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.requireOrgMember(ctx, viewer, orgName)
	if err != nil {
		return nil, err
	}
	if page < 1 {
		page = 1
	}
	if perPage < 1 || perPage > 100 {
		perPage = 30
	}
	rows, err := s.queries.ListChangesetsByOrg(ctx, db.ListChangesetsByOrgParams{
		OrganizationID: org.ID,
		PageSize:       int32(perPage),
		PageOffset:     int32((page - 1) * perPage),
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to list changesets").WithCause(err)
	}
	out := make([]ChangesetResponse, 0, len(rows))
	for _, cs := range rows {
		members, err := s.queries.ListChangesetMembers(ctx, cs.ID)
		if err != nil {
			return nil, pkgerrors.Internal("failed to list changeset members").WithCause(err)
		}
		if err := s.requireMembersAccess(ctx, viewer.ID, members, false); err != nil {
			var apiErr *pkgerrors.APIError
			if stdErrors.As(err, &apiErr) && apiErr.Status == 403 {
				continue
			}
			return nil, err
		}
		superproject, err := s.queries.GetRepoByID(ctx, cs.SuperprojectRepositoryID)
		if err != nil {
			return nil, pkgerrors.Internal("failed to load superproject repository").WithCause(err)
		}
		resp, err := s.buildResponse(ctx, org, superproject, cs, members)
		if err != nil {
			return nil, err
		}
		out = append(out, resp)
	}
	return out, nil
}

// MaterializeChangeset returns the member repositories of a changeset at their
// pinned commits for an agent VM. The user must be a member of the owning
// organization. Landed changesets materialize at the landed commits.
func (s *ChangesetService) MaterializeChangeset(ctx context.Context, userID, changesetID int64) ([]ChangesetMaterializedMember, error) {
	cs, err := s.queries.GetChangesetByID(ctx, changesetID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, pkgerrors.NotFound("changeset not found")
		}
		return nil, pkgerrors.Internal("failed to load changeset").WithCause(err)
	}
	if _, err := s.queries.GetOrgMember(ctx, db.GetOrgMemberParams{OrganizationID: cs.OrganizationID, UserID: userID}); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, pkgerrors.Forbidden("insufficient organization permissions")
		}
		return nil, pkgerrors.Internal("failed to load organization membership").WithCause(err)
	}
	org, err := s.queries.GetOrgByID(ctx, cs.OrganizationID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to load organization").WithCause(err)
	}
	members, err := s.queries.ListChangesetMembers(ctx, cs.ID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to load changeset members").WithCause(err)
	}
	out := make([]ChangesetMaterializedMember, 0, len(members))
	for _, m := range members {
		repo, err := s.queries.GetRepoByID(ctx, m.RepositoryID)
		if err != nil {
			return nil, pkgerrors.Internal("failed to load changeset member repository").WithCause(err)
		}
		if err := s.requireRepoAccess(ctx, repo, userID, false); err != nil {
			return nil, err
		}
		commit := m.CommitID
		if m.LandedCommitID != "" && cs.State == changesetStateLanded {
			commit = m.LandedCommitID
		}
		out = append(out, ChangesetMaterializedMember{Owner: org.Name, Repo: repo.Name, CommitID: commit})
	}
	return out, nil
}

func (s *ChangesetService) requireOrgMember(ctx context.Context, user *db.User, orgName string) (db.Organization, error) {
	lower := strings.ToLower(strings.TrimSpace(orgName))
	if lower == "" {
		return db.Organization{}, pkgerrors.BadRequest("organization name is required")
	}
	org, err := s.queries.GetOrgByLowerName(ctx, lower)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Organization{}, pkgerrors.NotFound("organization not found")
		}
		return db.Organization{}, pkgerrors.Internal("failed to load organization").WithCause(err)
	}
	if _, err := s.queries.GetOrgMember(ctx, db.GetOrgMemberParams{OrganizationID: org.ID, UserID: user.ID}); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Organization{}, pkgerrors.Forbidden("insufficient organization permissions")
		}
		return db.Organization{}, pkgerrors.Internal("failed to load organization membership").WithCause(err)
	}
	return org, nil
}

func (s *ChangesetService) ensureSuperproject(ctx context.Context, actor *db.User, org db.Organization, defaultBookmark string) (db.Repository, error) {
	repo, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: org.Name, LowerName: OrgSuperprojectRepoName})
	if err == nil {
		if !repo.OrgID.Valid || repo.OrgID.Int64 != org.ID {
			return db.Repository{}, pkgerrors.Internal("organization superproject is owned by another namespace")
		}
		return repo, nil
	}
	if !stdErrors.Is(err, pgx.ErrNoRows) {
		return db.Repository{}, pkgerrors.Internal("failed to load organization superproject")
	}
	if s.creator == nil {
		return db.Repository{}, pkgerrors.Conflict("organization superproject does not exist yet")
	}
	created, err := s.creator.CreateOrgRepo(ctx, actor, org.Name, OrgSuperprojectRepoName,
		"Organization superproject: one gitlink per member repository; each commit is a cross-repository changeset.",
		false, defaultBookmark, false)
	if err != nil {
		var apiErr *pkgerrors.APIError
		if stdErrors.As(err, &apiErr) && apiErr.Status == 403 {
			return db.Repository{}, pkgerrors.Forbidden("the organization superproject does not exist yet; an organization owner must create the first changeset")
		}
		return db.Repository{}, err
	}
	return created, nil
}

func (s *ChangesetService) loadChangeset(ctx context.Context, org db.Organization, id int64) (db.Changeset, []db.ChangesetMember, db.Repository, error) {
	cs, err := s.queries.GetChangesetByOrgAndID(ctx, db.GetChangesetByOrgAndIDParams{OrganizationID: org.ID, ID: id})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Changeset{}, nil, db.Repository{}, pkgerrors.NotFound("changeset not found")
		}
		return db.Changeset{}, nil, db.Repository{}, pkgerrors.Internal("failed to load changeset").WithCause(err)
	}
	members, err := s.queries.ListChangesetMembers(ctx, cs.ID)
	if err != nil {
		return db.Changeset{}, nil, db.Repository{}, pkgerrors.Internal("failed to load changeset members").WithCause(err)
	}
	superproject, err := s.queries.GetRepoByID(ctx, cs.SuperprojectRepositoryID)
	if err != nil {
		return db.Changeset{}, nil, db.Repository{}, pkgerrors.Internal("failed to load organization superproject").WithCause(err)
	}
	return cs, members, superproject, nil
}

func (s *ChangesetService) findBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, bool, error) {
	cursor := ""
	for i := 0; i < 50; i++ {
		items, next, err := s.repoHost.ListBookmarks(ctx, owner, repo, cursor, 100)
		if err != nil {
			return repohost.Bookmark{}, false, err
		}
		for _, b := range items {
			if b.Name == name {
				return b, true, nil
			}
		}
		if next == "" {
			return repohost.Bookmark{}, false, nil
		}
		cursor = next
	}
	return repohost.Bookmark{}, false, nil
}

func (s *ChangesetService) buildResponse(ctx context.Context, org db.Organization, superproject db.Repository, cs db.Changeset, members []db.ChangesetMember) (ChangesetResponse, error) {
	parents := []string{}
	if len(cs.ParentChangeIds) > 0 {
		_ = json.Unmarshal(cs.ParentChangeIds, &parents)
		if parents == nil {
			parents = []string{}
		}
	}
	resp := ChangesetResponse{
		ID:              cs.ID,
		Organization:    org.Name,
		Superproject:    org.Name + "/" + superproject.Name,
		ChangeID:        cs.ChangeID,
		CommitID:        cs.CommitID,
		LandedCommitID:  cs.LandedCommitID,
		ParentChangeIDs: parents,
		TargetBookmark:  cs.TargetBookmark,
		Description:     cs.Description,
		State:           cs.State,
		FailureReason:   cs.FailureReason,
		CreatedAt:       cs.CreatedAt,
		Members:         make([]ChangesetMemberResponse, 0, len(members)),
	}
	if cs.LandedAt.Valid {
		t := cs.LandedAt.Time
		resp.LandedAt = &t
	}
	for _, m := range members {
		name := m.Path
		if repo, err := s.queries.GetRepoByID(ctx, m.RepositoryID); err == nil {
			name = repo.Name
		}
		resp.Members = append(resp.Members, ChangesetMemberResponse{
			RepositoryID:     m.RepositoryID,
			Repository:       org.Name + "/" + name,
			Path:             m.Path,
			ChangeID:         m.ChangeID,
			CommitID:         m.CommitID,
			TargetBookmark:   m.TargetBookmark,
			PreviousCommitID: m.PreviousCommitID,
			LandedCommitID:   m.LandedCommitID,
		})
	}
	return resp, nil
}

// summarizeRepoHostError keeps the repo-host status and message for the
// changeset failure reason without leaking URLs.
func summarizeRepoHostError(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	if idx := strings.LastIndex(msg, "repo-host returned status "); idx >= 0 {
		return strings.TrimSpace(msg[idx:])
	}
	if len(msg) > 300 {
		return msg[:300]
	}
	return msg
}

// changesetRepoHostStatus returns the repo-host HTTP status carried by err,
// from the typed client error first and the message marker as a fallback.
func changesetRepoHostStatus(err error) (int, bool) {
	var statusErr *repohost.StatusError
	if stdErrors.As(err, &statusErr) {
		return statusErr.StatusCode, true
	}
	if status, ok := extractRepoHostStatusCode(err); ok {
		return status, true
	}
	msg := err.Error()
	const marker = "repo-host returned status "
	if idx := strings.LastIndex(msg, marker); idx >= 0 {
		tail := strings.TrimSpace(msg[idx+len(marker):])
		digits := strings.TrimRight(strings.SplitN(tail, " ", 2)[0], ":")
		if status, convErr := strconv.Atoi(digits); convErr == nil {
			return status, true
		}
	}
	return 0, false
}

func mapChangesetRepoHostError(err error, subject, fallbackMessage string) error {
	status, ok := changesetRepoHostStatus(err)
	if !ok {
		return pkgerrors.Internal(fallbackMessage)
	}
	switch status {
	case 404:
		return pkgerrors.NotFound(subject + " not found")
	case 400:
		return pkgerrors.BadRequest(subject + " was rejected by repo-host")
	case 409:
		return pkgerrors.Conflict(subject + " conflicts with its target bookmark")
	default:
		return pkgerrors.Internal(fallbackMessage)
	}
}
