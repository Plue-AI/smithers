package services

import (
	"context"
	stdErrors "errors"
	"log/slog"
	"math"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

const (
	defaultPerPage = 30
	maxPerPage     = 100
)

type CreateOrgRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Visibility  string `json:"visibility"`
}

type UpdateOrgRequest struct {
	// Omit to preserve the owner; zero clears the configured principal.
	FactoryOwnerID *int64 `json:"factory_owner_id"`
	Name           string `json:"name"`
	Description    string `json:"description"`
	Visibility     string `json:"visibility"`
	Website        string `json:"website"`
	Location       string `json:"location"`
}

type CreateTeamRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Permission  string `json:"permission"`
}

type UpdateTeamRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Permission  string `json:"permission"`
}

type OrgQuerier interface {
	GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error)
	CreateOrganization(ctx context.Context, arg db.CreateOrganizationParams) (db.Organization, error)
	AddOrgMember(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error)
	UpdateOrganization(ctx context.Context, arg db.UpdateOrganizationParams) (db.Organization, error)

	ListOrgRepos(ctx context.Context, arg db.ListOrgReposParams) ([]db.Repository, error)
	CountOrgRepos(ctx context.Context, orgID pgtype.Int8) (int64, error)
	ListPublicOrgRepos(ctx context.Context, arg db.ListPublicOrgReposParams) ([]db.Repository, error)
	CountPublicOrgRepos(ctx context.Context, orgID pgtype.Int8) (int64, error)

	GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error)
	ListOrgMembers(ctx context.Context, arg db.ListOrgMembersParams) ([]db.ListOrgMembersRow, error)
	CountOrgMembers(ctx context.Context, orgID int64) (int64, error)

	ListOrgTeams(ctx context.Context, arg db.ListOrgTeamsParams) ([]db.Team, error)
	CreateTeam(ctx context.Context, arg db.CreateTeamParams) (db.Team, error)
	GetTeamByOrgAndLowerName(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error)
	UpdateTeam(ctx context.Context, arg db.UpdateTeamParams) (db.Team, error)
	DeleteTeam(ctx context.Context, id int64) error
	CountOrgTeams(ctx context.Context, orgID int64) (int64, error)

	ListTeamMembers(ctx context.Context, arg db.ListTeamMembersParams) ([]db.User, error)
	CountTeamMembers(ctx context.Context, teamID int64) (int64, error)
	AddTeamMember(ctx context.Context, arg db.AddTeamMemberParams) (db.TeamMember, error)
	AddTeamMemberIfOrgMember(ctx context.Context, arg db.AddTeamMemberIfOrgMemberParams) (db.TeamMember, error)
	RemoveTeamMember(ctx context.Context, arg db.RemoveTeamMemberParams) error

	ListTeamRepos(ctx context.Context, arg db.ListTeamReposParams) ([]db.Repository, error)
	CountTeamRepos(ctx context.Context, teamID int64) (int64, error)
	AddTeamRepo(ctx context.Context, arg db.AddTeamRepoParams) (db.TeamRepo, error)
	AddTeamRepoIfOrgRepo(ctx context.Context, arg db.AddTeamRepoIfOrgRepoParams) (db.TeamRepo, error)
	RemoveTeamRepo(ctx context.Context, arg db.RemoveTeamRepoParams) error

	GetUserByLowerUsername(ctx context.Context, lowerUsername string) (db.User, error)
	RemoveOrgMember(ctx context.Context, arg db.RemoveOrgMemberParams) error
	DeleteTeamMembershipsForOrgUser(ctx context.Context, arg db.DeleteTeamMembershipsForOrgUserParams) error
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	CountOrgOwners(ctx context.Context, organizationID int64) (int64, error)
}

// orgCreateTx is a transaction handle for the coupled CreateOrganization + AddOrgMember operations.
type orgCreateTx interface {
	CreateOrganization(ctx context.Context, arg db.CreateOrganizationParams) (db.Organization, error)
	AddOrgMember(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error)
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

// orgMemberRemovalTx is a transaction handle for the coupled last-owner check +
// team-membership cleanup + org-membership delete in RemoveOrgMember. Running
// these under row locks is what keeps concurrent owner removals from leaving an
// org ownerless and concurrent team adds from surviving a member removal.
type orgMemberRemovalTx interface {
	LockOrganization(ctx context.Context, id int64) (int64, error)
	GetOrgMemberForUpdate(ctx context.Context, arg db.GetOrgMemberForUpdateParams) (db.OrgMember, error)
	CountOrgOwners(ctx context.Context, organizationID int64) (int64, error)
	DeleteTeamMembershipsForOrgUser(ctx context.Context, arg db.DeleteTeamMembershipsForOrgUserParams) error
	RemoveOrgMember(ctx context.Context, arg db.RemoveOrgMemberParams) error
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

// orgTxManager begins transactions for multi-statement org flows.
type orgTxManager interface {
	BeginCreateTx(ctx context.Context) (orgCreateTx, error)
	BeginMemberRemovalTx(ctx context.Context) (orgMemberRemovalTx, error)
}

type pgxOrgTxManager struct {
	pool *pgxpool.Pool
}

func (m *pgxOrgTxManager) BeginCreateTx(ctx context.Context) (orgCreateTx, error) {
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &pgxOrgCreateTx{tx: tx, q: db.New(tx)}, nil
}

func (m *pgxOrgTxManager) BeginMemberRemovalTx(ctx context.Context) (orgMemberRemovalTx, error) {
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &pgxOrgMemberRemovalTx{tx: tx, q: db.New(tx)}, nil
}

type pgxOrgCreateTx struct {
	tx pgx.Tx
	q  *db.Queries
}

func (t *pgxOrgCreateTx) CreateOrganization(ctx context.Context, arg db.CreateOrganizationParams) (db.Organization, error) {
	return t.q.CreateOrganization(ctx, arg)
}

func (t *pgxOrgCreateTx) AddOrgMember(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
	return t.q.AddOrgMember(ctx, arg)
}

func (t *pgxOrgCreateTx) Commit(ctx context.Context) error {
	return t.tx.Commit(ctx)
}

func (t *pgxOrgCreateTx) Rollback(ctx context.Context) error {
	return t.tx.Rollback(ctx)
}

type pgxOrgMemberRemovalTx struct {
	tx pgx.Tx
	q  *db.Queries
}

func (t *pgxOrgMemberRemovalTx) LockOrganization(ctx context.Context, id int64) (int64, error) {
	return t.q.LockOrganization(ctx, id)
}

func (t *pgxOrgMemberRemovalTx) GetOrgMemberForUpdate(ctx context.Context, arg db.GetOrgMemberForUpdateParams) (db.OrgMember, error) {
	return t.q.GetOrgMemberForUpdate(ctx, arg)
}

func (t *pgxOrgMemberRemovalTx) CountOrgOwners(ctx context.Context, organizationID int64) (int64, error) {
	return t.q.CountOrgOwners(ctx, organizationID)
}

func (t *pgxOrgMemberRemovalTx) DeleteTeamMembershipsForOrgUser(ctx context.Context, arg db.DeleteTeamMembershipsForOrgUserParams) error {
	return t.q.DeleteTeamMembershipsForOrgUser(ctx, arg)
}

func (t *pgxOrgMemberRemovalTx) RemoveOrgMember(ctx context.Context, arg db.RemoveOrgMemberParams) error {
	return t.q.RemoveOrgMember(ctx, arg)
}

func (t *pgxOrgMemberRemovalTx) Commit(ctx context.Context) error {
	return t.tx.Commit(ctx)
}

func (t *pgxOrgMemberRemovalTx) Rollback(ctx context.Context) error {
	return t.tx.Rollback(ctx)
}

func rollbackOrgTx(ctx context.Context, tx orgCreateTx) {
	_ = tx.Rollback(ctx)
}

type OrgService struct {
	revocations    revocation.Publisher
	txManager      orgTxManager
	queries        OrgQuerier
	dispatcher     webhooks.Dispatcher
	seatReconciler func(ctx context.Context, orgID int64) error
}

// SetSeatReconciler wires the billing seat reconciler (BillingService.
// ReconcileOrgSeats), invoked after org membership mutations so per-seat
// Stripe subscription quantities track the member count.
func (s *OrgService) SetSeatReconciler(reconciler func(ctx context.Context, orgID int64) error) {
	s.seatReconciler = reconciler
}

// reconcileSeats is best-effort: a billing seat sync failure must not fail or
// roll back a completed membership change (Stripe outages cannot be allowed to
// block org administration). Drift self-heals on the next membership change or
// owner-triggered billing refresh, both of which reconcile against the current
// member count.
func (s *OrgService) reconcileSeats(ctx context.Context, orgID int64) {
	if s.seatReconciler == nil {
		return
	}
	if err := s.seatReconciler(ctx, orgID); err != nil {
		slog.Warn("failed to reconcile org billing seats", "org_id", orgID, "error", err)
	}
}

type OrgServiceOption func(*OrgService)

func WithOrgWebhookDispatcher(dispatcher webhooks.Dispatcher) OrgServiceOption {
	return func(s *OrgService) {
		s.dispatcher = dispatcher
	}
}

func NewOrgService(q OrgQuerier, opts ...OrgServiceOption) *OrgService {
	s := &OrgService{queries: q}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

func NewOrgServiceWithPool(q OrgQuerier, pool *pgxpool.Pool, opts ...OrgServiceOption) *OrgService {
	var txManager orgTxManager
	if pool != nil {
		txManager = &pgxOrgTxManager{pool: pool}
	}
	s := &OrgService{
		queries:   q,
		txManager: txManager,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

func normalizePage(page, perPage int) (pageSize int32, pageOffset int32, resolvedPage int, resolvedPerPage int) {
	resolvedPage = page
	if resolvedPage <= 0 {
		resolvedPage = 1
	}
	resolvedPerPage = perPage
	if resolvedPerPage <= 0 {
		resolvedPerPage = defaultPerPage
	}
	if resolvedPerPage > maxPerPage {
		resolvedPerPage = maxPerPage
	}
	// Cap page so the SQL offset (page-1)*perPage cannot overflow int32 below —
	// an overflow wraps to a negative OFFSET and 500s the query. An absurd page
	// then returns an empty final page instead of an error.
	if maxPage := math.MaxInt32/resolvedPerPage + 1; resolvedPage > maxPage {
		resolvedPage = maxPage
	}
	pageSize = int32(resolvedPerPage)
	pageOffset = int32((resolvedPage - 1) * resolvedPerPage)
	return pageSize, pageOffset, resolvedPage, resolvedPerPage
}

func (s *OrgService) resolveOrg(ctx context.Context, orgName string) (db.Organization, error) {
	lowerName := strings.ToLower(strings.TrimSpace(orgName))
	if lowerName == "" {
		return db.Organization{}, pkgerrors.BadRequest("organization name is required")
	}
	org, err := s.queries.GetOrgByLowerName(ctx, lowerName)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Organization{}, pkgerrors.NotFound("organization not found")
		}
		return db.Organization{}, pkgerrors.Internal("failed to load organization").WithCause(err)
	}
	return org, nil
}

func (s *OrgService) resolveTeam(ctx context.Context, organizationID int64, teamName string) (db.Team, error) {
	lowerName := strings.ToLower(strings.TrimSpace(teamName))
	if lowerName == "" {
		return db.Team{}, pkgerrors.BadRequest("team name is required")
	}
	team, err := s.queries.GetTeamByOrgAndLowerName(ctx, db.GetTeamByOrgAndLowerNameParams{
		OrganizationID: organizationID,
		LowerName:      lowerName,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Team{}, pkgerrors.NotFound("team not found")
		}
		return db.Team{}, pkgerrors.Internal("failed to load team").WithCause(err)
	}
	return team, nil
}

func (s *OrgService) requireOrgRole(ctx context.Context, organizationID, userID int64, roles ...string) error {
	member, err := s.queries.GetOrgMember(ctx, db.GetOrgMemberParams{
		OrganizationID: organizationID,
		UserID:         userID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Forbidden("insufficient organization permissions")
		}
		return pkgerrors.Internal("failed to load organization membership").WithCause(err)
	}
	if len(roles) == 0 {
		return nil
	}
	for _, role := range roles {
		if member.Role == role {
			return nil
		}
	}
	return pkgerrors.Forbidden("insufficient organization permissions")
}

func (s *OrgService) isOrgMember(ctx context.Context, organizationID, userID int64) (bool, error) {
	_, err := s.queries.GetOrgMember(ctx, db.GetOrgMemberParams{
		OrganizationID: organizationID,
		UserID:         userID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, pkgerrors.Internal("failed to load organization membership").WithCause(err)
	}
	return true, nil
}

func (s *OrgService) CreateOrg(ctx context.Context, actor *db.User, req CreateOrgRequest) (db.Organization, error) {
	if actor == nil {
		return db.Organization{}, pkgerrors.Unauthorized("authentication required")
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		return db.Organization{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Organization", Field: "name", Code: "missing_field"})
	}
	if err := validateSafeText("Organization", "name", name); err != nil {
		return db.Organization{}, err
	}
	if err := validateOwnerSegment("Organization", "name", name); err != nil {
		return db.Organization{}, err
	}

	visibility := strings.TrimSpace(req.Visibility)
	if visibility == "" {
		visibility = "public"
	}
	if visibility != "public" && visibility != "limited" && visibility != "private" {
		return db.Organization{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Organization", Field: "visibility", Code: "invalid"})
	}

	if s.txManager != nil {
		tx, err := s.txManager.BeginCreateTx(ctx)
		if err != nil {
			return db.Organization{}, pkgerrors.Internal("failed to begin transaction").WithCause(err)
		}
		defer rollbackOrgTx(ctx, tx)

		org, err := tx.CreateOrganization(ctx, db.CreateOrganizationParams{
			Name:        name,
			LowerName:   strings.ToLower(name),
			Description: req.Description,
			Visibility:  visibility,
		})
		if err != nil {
			if isUniqueViolation(err) {
				return db.Organization{}, pkgerrors.Conflict("organization name already exists")
			}
			return db.Organization{}, pkgerrors.Internal("failed to create organization").WithCause(err)
		}

		_, err = tx.AddOrgMember(ctx, db.AddOrgMemberParams{
			OrganizationID: org.ID,
			UserID:         actor.ID,
			Role:           "owner",
		})
		if err != nil {
			return db.Organization{}, pkgerrors.Internal("failed to add creator as organization owner").WithCause(err)
		}

		if err := tx.Commit(ctx); err != nil {
			return db.Organization{}, pkgerrors.Internal("failed to commit organization creation").WithCause(err)
		}
		s.dispatchOrganizationEvent(ctx, org.ID, actor, "created")
		return org, nil
	}

	org, err := s.queries.CreateOrganization(ctx, db.CreateOrganizationParams{
		Name:        name,
		LowerName:   strings.ToLower(name),
		Description: req.Description,
		Visibility:  visibility,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return db.Organization{}, pkgerrors.Conflict("organization name already exists")
		}
		return db.Organization{}, pkgerrors.Internal("failed to create organization").WithCause(err)
	}

	_, err = s.queries.AddOrgMember(ctx, db.AddOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         actor.ID,
		Role:           "owner",
	})
	if err != nil {
		return db.Organization{}, pkgerrors.Internal("failed to add creator as organization owner").WithCause(err)
	}

	s.dispatchOrganizationEvent(ctx, org.ID, actor, "created")
	return org, nil
}

func (s *OrgService) GetOrg(ctx context.Context, viewer *db.User, orgName string) (db.Organization, error) {
	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return db.Organization{}, err
	}

	if org.Visibility == "public" {
		return org, nil
	}

	if viewer == nil {
		return db.Organization{}, pkgerrors.Forbidden("organization membership required")
	}

	if err := s.requireOrgRole(ctx, org.ID, viewer.ID, "owner", "member"); err != nil {
		return db.Organization{}, err
	}

	return org, nil
}

func (s *OrgService) UpdateOrg(ctx context.Context, actor *db.User, orgName string, req UpdateOrgRequest) (db.Organization, error) {
	if actor == nil {
		return db.Organization{}, pkgerrors.Unauthorized("authentication required")
	}

	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return db.Organization{}, err
	}
	if err := s.requireOrgRole(ctx, org.ID, actor.ID, "owner"); err != nil {
		return db.Organization{}, err
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = org.Name
	}
	if len(name) > 255 {
		return db.Organization{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Organization", Field: "name", Code: "invalid"})
	}
	// Repository storage is addressed by the exact organization name on a
	// case-sensitive filesystem. Changing either its spelling or case without a
	// coordinated repo-host namespace move would make every repository
	// unreachable and would free the old slug for storage-conflicting reuse.
	// Keep the owner namespace immutable until that move has a durable workflow.
	if name != org.Name {
		return db.Organization{}, pkgerrors.Conflict("organization name changes are not supported")
	}

	visibility := strings.TrimSpace(req.Visibility)
	if visibility == "" {
		visibility = org.Visibility
	}
	if visibility != "public" && visibility != "limited" && visibility != "private" {
		return db.Organization{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Organization", Field: "visibility", Code: "invalid"})
	}

	description := org.Description
	if req.Description != "" {
		description = req.Description
	}
	website := org.Website
	if req.Website != "" {
		website = req.Website
	}
	location := org.Location
	if req.Location != "" {
		location = req.Location
	}

	var factoryOwner pgtype.Int8
	if req.FactoryOwnerID != nil {
		if *req.FactoryOwnerID < 0 {
			return db.Organization{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Organization", Field: "factory_owner_id", Code: "invalid"})
		}
		if *req.FactoryOwnerID > 0 {
			member, err := s.queries.GetOrgMember(ctx, db.GetOrgMemberParams{OrganizationID: org.ID, UserID: *req.FactoryOwnerID})
			if err != nil && !stdErrors.Is(err, pgx.ErrNoRows) {
				return db.Organization{}, pkgerrors.Internal("failed to load organization membership").WithCause(err)
			}
			if stdErrors.Is(err, pgx.ErrNoRows) || member.Role != "owner" {
				return db.Organization{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Organization", Field: "factory_owner_id", Code: "invalid"})
			}
			factoryOwner = pgtype.Int8{Int64: *req.FactoryOwnerID, Valid: true}
		}
	}

	updated, err := s.queries.UpdateOrganization(ctx, db.UpdateOrganizationParams{
		FactoryOwnerID:  factoryOwner,
		SetFactoryOwner: req.FactoryOwnerID != nil,
		ID:              org.ID,
		Name:            name,
		LowerName:       strings.ToLower(name),
		Description:     description,
		Visibility:      visibility,
		Website:         website,
		Location:        location,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return db.Organization{}, pkgerrors.Conflict("organization name already exists")
		}
		return db.Organization{}, pkgerrors.Internal("failed to update organization").WithCause(err)
	}
	return updated, nil
}

func (s *OrgService) ListOrgRepos(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.Repository, int64, error) {
	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return nil, 0, err
	}

	isMember := false
	if viewer != nil {
		isMember, err = s.isOrgMember(ctx, org.ID, viewer.ID)
		if err != nil {
			return nil, 0, err
		}
	}

	if org.Visibility != "public" && !isMember {
		return nil, 0, pkgerrors.Forbidden("organization membership required")
	}

	pageSize, pageOffset, _, _ := normalizePage(page, perPage)
	if isMember {
		repos, err := s.queries.ListOrgRepos(ctx, db.ListOrgReposParams{
			OrgID:      pgtype.Int8{Int64: org.ID, Valid: true},
			PageSize:   pageSize,
			PageOffset: pageOffset,
		})
		if err != nil {
			return nil, 0, pkgerrors.Internal("failed to list organization repositories").WithCause(err)
		}
		total, err := s.queries.CountOrgRepos(ctx, pgtype.Int8{Int64: org.ID, Valid: true})
		if err != nil {
			return nil, 0, pkgerrors.Internal("failed to count organization repositories").WithCause(err)
		}
		return repos, total, nil
	}

	repos, err := s.queries.ListPublicOrgRepos(ctx, db.ListPublicOrgReposParams{
		OrgID:      pgtype.Int8{Int64: org.ID, Valid: true},
		PageSize:   pageSize,
		PageOffset: pageOffset,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list organization repositories").WithCause(err)
	}
	total, err := s.queries.CountPublicOrgRepos(ctx, pgtype.Int8{Int64: org.ID, Valid: true})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count organization repositories").WithCause(err)
	}
	return repos, total, nil
}

func (s *OrgService) ListOrgMembers(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.ListOrgMembersRow, int64, error) {
	if viewer == nil {
		return nil, 0, pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return nil, 0, err
	}
	if err := s.requireOrgRole(ctx, org.ID, viewer.ID, "owner", "member"); err != nil {
		return nil, 0, err
	}

	pageSize, pageOffset, _, _ := normalizePage(page, perPage)
	members, err := s.queries.ListOrgMembers(ctx, db.ListOrgMembersParams{
		OrganizationID: org.ID,
		PageSize:       pageSize,
		PageOffset:     pageOffset,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list organization members").WithCause(err)
	}
	total, err := s.queries.CountOrgMembers(ctx, org.ID)
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count organization members").WithCause(err)
	}
	return members, total, nil
}

func (s *OrgService) AddOrgMember(ctx context.Context, actor *db.User, orgName string, targetUserID int64, role string) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}

	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return err
	}
	if err := s.requireOrgRole(ctx, org.ID, actor.ID, "owner"); err != nil {
		return err
	}

	if targetUserID <= 0 {
		return pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "OrgMember", Field: "user_id", Code: "invalid"})
	}

	normalizedRole := strings.ToLower(strings.TrimSpace(role))
	if normalizedRole != "owner" && normalizedRole != "member" {
		return pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "OrgMember", Field: "role", Code: "invalid"})
	}

	_, err = s.queries.AddOrgMember(ctx, db.AddOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         targetUserID,
		Role:           normalizedRole,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return pkgerrors.Conflict("user is already a member of the organization")
		}
		var pgErr *pgconn.PgError
		if stdErrors.As(err, &pgErr) && pgErr.Code == "23503" {
			return pkgerrors.NotFound("user not found")
		}
		return pkgerrors.Internal("failed to add organization member").WithCause(err)
	}

	s.dispatchOrganizationEvent(ctx, org.ID, actor, "member_added")
	s.reconcileSeats(ctx, org.ID)
	return nil
}

func (s *OrgService) ListOrgTeams(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]db.Team, int64, error) {
	if viewer == nil {
		return nil, 0, pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return nil, 0, err
	}
	if err := s.requireOrgRole(ctx, org.ID, viewer.ID, "owner", "member"); err != nil {
		return nil, 0, err
	}

	pageSize, pageOffset, _, _ := normalizePage(page, perPage)
	teams, err := s.queries.ListOrgTeams(ctx, db.ListOrgTeamsParams{
		OrganizationID: org.ID,
		PageSize:       pageSize,
		PageOffset:     pageOffset,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list organization teams").WithCause(err)
	}
	total, err := s.queries.CountOrgTeams(ctx, org.ID)
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count organization teams").WithCause(err)
	}
	return teams, total, nil
}

func (s *OrgService) CreateTeam(ctx context.Context, actor *db.User, orgName string, req CreateTeamRequest) (db.Team, error) {
	if actor == nil {
		return db.Team{}, pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return db.Team{}, err
	}
	if err := s.requireOrgRole(ctx, org.ID, actor.ID, "owner"); err != nil {
		return db.Team{}, err
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		return db.Team{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Team", Field: "name", Code: "missing_field"})
	}
	if len(name) > 255 {
		return db.Team{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Team", Field: "name", Code: "invalid"})
	}
	if err := validateSafeText("Team", "name", name); err != nil {
		return db.Team{}, err
	}

	permission := strings.TrimSpace(req.Permission)
	if permission == "" {
		permission = "read"
	}
	if permission != "read" && permission != "write" && permission != "admin" {
		return db.Team{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Team", Field: "permission", Code: "invalid"})
	}

	team, err := s.queries.CreateTeam(ctx, db.CreateTeamParams{
		OrganizationID: org.ID,
		Name:           name,
		LowerName:      strings.ToLower(name),
		Description:    req.Description,
		Permission:     permission,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return db.Team{}, pkgerrors.Conflict("team already exists")
		}
		return db.Team{}, pkgerrors.Internal("failed to create team").WithCause(err)
	}
	s.dispatchTeamLifecycleEvent(ctx, org.ID, actor, "created")
	return team, nil
}

func (s *OrgService) GetTeam(ctx context.Context, viewer *db.User, orgName, teamName string) (db.Team, error) {
	if viewer == nil {
		return db.Team{}, pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return db.Team{}, err
	}
	if err := s.requireOrgRole(ctx, org.ID, viewer.ID, "owner", "member"); err != nil {
		return db.Team{}, err
	}
	return s.resolveTeam(ctx, org.ID, teamName)
}

func (s *OrgService) UpdateTeam(ctx context.Context, actor *db.User, orgName, teamName string, req UpdateTeamRequest) (db.Team, error) {
	if actor == nil {
		return db.Team{}, pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return db.Team{}, err
	}
	if err := s.requireOrgRole(ctx, org.ID, actor.ID, "owner"); err != nil {
		return db.Team{}, err
	}
	team, err := s.resolveTeam(ctx, org.ID, teamName)
	if err != nil {
		return db.Team{}, err
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = team.Name
	}
	if len(name) > 255 {
		return db.Team{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Team", Field: "name", Code: "invalid"})
	}

	permission := strings.TrimSpace(req.Permission)
	if permission == "" {
		permission = team.Permission
	}
	if permission != "read" && permission != "write" && permission != "admin" {
		return db.Team{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Team", Field: "permission", Code: "invalid"})
	}

	description := team.Description
	if req.Description != "" {
		description = req.Description
	}

	var grants teamGrants
	if repoPermissionRank(permission) < repoPermissionRank(team.Permission) {
		grants = s.teamGrantsOf(ctx, team, nil, nil)
	}
	updated, err := s.queries.UpdateTeam(ctx, db.UpdateTeamParams{
		ID:          team.ID,
		Name:        name,
		LowerName:   strings.ToLower(name),
		Description: description,
		Permission:  permission,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return db.Team{}, pkgerrors.Conflict("team already exists")
		}
		return db.Team{}, pkgerrors.Internal("failed to update team").WithCause(err)
	}
	s.dispatchTeamLifecycleEvent(ctx, org.ID, actor, "edited")
	s.publishTeamAccessLost(ctx, grants, actor.ID, "team "+team.Name+" permission lowered")
	return updated, nil
}

func (s *OrgService) DeleteTeam(ctx context.Context, actor *db.User, orgName, teamName string) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return err
	}
	if err := s.requireOrgRole(ctx, org.ID, actor.ID, "owner"); err != nil {
		return err
	}
	team, err := s.resolveTeam(ctx, org.ID, teamName)
	if err != nil {
		return err
	}
	grants := s.teamGrantsOf(ctx, team, nil, nil)
	if err := s.queries.DeleteTeam(ctx, team.ID); err != nil {
		return pkgerrors.Internal("failed to delete team").WithCause(err)
	}
	s.dispatchTeamLifecycleEvent(ctx, org.ID, actor, "deleted")
	s.publishTeamAccessLost(ctx, grants, actor.ID, "team "+team.Name+" deleted")
	return nil
}

func (s *OrgService) ListTeamMembers(ctx context.Context, viewer *db.User, orgName, teamName string, page, perPage int) ([]db.User, int64, error) {
	if viewer == nil {
		return nil, 0, pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return nil, 0, err
	}
	if err := s.requireOrgRole(ctx, org.ID, viewer.ID, "owner", "member"); err != nil {
		return nil, 0, err
	}
	team, err := s.resolveTeam(ctx, org.ID, teamName)
	if err != nil {
		return nil, 0, err
	}

	pageSize, pageOffset, _, _ := normalizePage(page, perPage)
	members, err := s.queries.ListTeamMembers(ctx, db.ListTeamMembersParams{
		TeamID:     team.ID,
		PageSize:   pageSize,
		PageOffset: pageOffset,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list team members").WithCause(err)
	}
	total, err := s.queries.CountTeamMembers(ctx, team.ID)
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count team members").WithCause(err)
	}
	return members, total, nil
}

func (s *OrgService) AddTeamMember(ctx context.Context, actor *db.User, orgName, teamName, username string) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return err
	}
	if err := s.requireOrgRole(ctx, org.ID, actor.ID, "owner"); err != nil {
		return err
	}
	team, err := s.resolveTeam(ctx, org.ID, teamName)
	if err != nil {
		return err
	}

	lowerUsername := strings.ToLower(strings.TrimSpace(username))
	if lowerUsername == "" {
		return pkgerrors.BadRequest("username is required")
	}
	user, err := s.queries.GetUserByLowerUsername(ctx, lowerUsername)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("user not found")
		}
		return pkgerrors.Internal("failed to load user").WithCause(err)
	}

	_, err = s.queries.AddTeamMemberIfOrgMember(ctx, db.AddTeamMemberIfOrgMemberParams{TeamID: team.ID, UserID: user.ID})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "TeamMember", Field: "username", Code: "invalid"})
		}
		if isUniqueViolation(err) {
			return pkgerrors.Conflict("user is already a team member")
		}
		return pkgerrors.Internal("failed to add team member").WithCause(err)
	}
	s.dispatchTeamLifecycleEvent(ctx, org.ID, actor, "member_added")
	return nil
}

func (s *OrgService) RemoveTeamMember(ctx context.Context, actor *db.User, orgName, teamName, username string) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return err
	}
	if err := s.requireOrgRole(ctx, org.ID, actor.ID, "owner"); err != nil {
		return err
	}
	team, err := s.resolveTeam(ctx, org.ID, teamName)
	if err != nil {
		return err
	}

	lowerUsername := strings.ToLower(strings.TrimSpace(username))
	if lowerUsername == "" {
		return pkgerrors.BadRequest("username is required")
	}
	user, err := s.queries.GetUserByLowerUsername(ctx, lowerUsername)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("user not found")
		}
		return pkgerrors.Internal("failed to load user").WithCause(err)
	}

	grants := s.teamGrantsOf(ctx, team, []int64{user.ID}, nil)
	if err := s.queries.RemoveTeamMember(ctx, db.RemoveTeamMemberParams{TeamID: team.ID, UserID: user.ID}); err != nil {
		return pkgerrors.Internal("failed to remove team member").WithCause(err)
	}
	s.dispatchTeamLifecycleEvent(ctx, org.ID, actor, "member_removed")
	s.publishTeamAccessLost(ctx, grants, actor.ID, "removed from team "+team.Name)
	return nil
}

func (s *OrgService) ListTeamRepos(ctx context.Context, viewer *db.User, orgName, teamName string, page, perPage int) ([]db.Repository, int64, error) {
	if viewer == nil {
		return nil, 0, pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return nil, 0, err
	}
	if err := s.requireOrgRole(ctx, org.ID, viewer.ID, "owner", "member"); err != nil {
		return nil, 0, err
	}
	team, err := s.resolveTeam(ctx, org.ID, teamName)
	if err != nil {
		return nil, 0, err
	}

	pageSize, pageOffset, _, _ := normalizePage(page, perPage)
	repos, err := s.queries.ListTeamRepos(ctx, db.ListTeamReposParams{
		TeamID:     team.ID,
		PageSize:   pageSize,
		PageOffset: pageOffset,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list team repositories").WithCause(err)
	}
	total, err := s.queries.CountTeamRepos(ctx, team.ID)
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count team repositories").WithCause(err)
	}
	return repos, total, nil
}

func (s *OrgService) AddTeamRepo(ctx context.Context, actor *db.User, orgName, teamName, owner, repo string) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return err
	}
	if err := s.requireOrgRole(ctx, org.ID, actor.ID, "owner"); err != nil {
		return err
	}
	team, err := s.resolveTeam(ctx, org.ID, teamName)
	if err != nil {
		return err
	}

	repository, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner:     strings.ToLower(strings.TrimSpace(owner)),
		LowerName: strings.ToLower(strings.TrimSpace(repo)),
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("repository not found")
		}
		return pkgerrors.Internal("failed to load repository").WithCause(err)
	}
	_, err = s.queries.AddTeamRepoIfOrgRepo(ctx, db.AddTeamRepoIfOrgRepoParams{TeamID: team.ID, RepositoryID: repository.ID})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "TeamRepo", Field: "repository", Code: "invalid"})
		}
		if isUniqueViolation(err) {
			return pkgerrors.Conflict("repository is already assigned to team")
		}
		return pkgerrors.Internal("failed to add team repository").WithCause(err)
	}
	s.dispatchTeamRepositoryEvent(ctx, repository, owner, actor, "repo_added")
	return nil
}

func (s *OrgService) RemoveTeamRepo(ctx context.Context, actor *db.User, orgName, teamName, owner, repo string) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return err
	}
	if err := s.requireOrgRole(ctx, org.ID, actor.ID, "owner"); err != nil {
		return err
	}
	team, err := s.resolveTeam(ctx, org.ID, teamName)
	if err != nil {
		return err
	}

	repository, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner:     strings.ToLower(strings.TrimSpace(owner)),
		LowerName: strings.ToLower(strings.TrimSpace(repo)),
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("repository not found")
		}
		return pkgerrors.Internal("failed to load repository").WithCause(err)
	}
	if !repository.OrgID.Valid || repository.OrgID.Int64 != org.ID {
		return pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "TeamRepo", Field: "repository", Code: "invalid"})
	}

	grants := s.teamGrantsOf(ctx, team, nil, []db.Repository{repository})
	if err := s.queries.RemoveTeamRepo(ctx, db.RemoveTeamRepoParams{TeamID: team.ID, RepositoryID: repository.ID}); err != nil {
		return pkgerrors.Internal("failed to remove team repository").WithCause(err)
	}
	s.publishTeamAccessLost(ctx, grants, actor.ID, "repository removed from team "+team.Name)
	s.dispatchTeamRepositoryEvent(ctx, repository, owner, actor, "repo_removed")
	return nil
}

func (s *OrgService) RemoveOrgMember(ctx context.Context, actor *db.User, orgName, username string) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}

	org, err := s.resolveOrg(ctx, orgName)
	if err != nil {
		return err
	}
	if err := s.requireOrgRole(ctx, org.ID, actor.ID, "owner"); err != nil {
		return err
	}

	lowerUsername := strings.ToLower(strings.TrimSpace(username))
	if lowerUsername == "" {
		return pkgerrors.BadRequest("username is required")
	}
	user, err := s.queries.GetUserByLowerUsername(ctx, lowerUsername)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("user not found")
		}
		return pkgerrors.Internal("failed to load user").WithCause(err)
	}

	if s.txManager != nil {
		return s.removeOrgMemberTx(ctx, org, actor, user)
	}

	targetMember, err := s.queries.GetOrgMember(ctx, db.GetOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         user.ID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("organization member not found")
		}
		return pkgerrors.Internal("failed to load target organization membership").WithCause(err)
	}

	if targetMember.Role == "owner" {
		ownerCount, err := s.queries.CountOrgOwners(ctx, org.ID)
		if err != nil {
			return pkgerrors.Internal("failed to count organization owners").WithCause(err)
		}
		if ownerCount <= 1 {
			return pkgerrors.Conflict("cannot remove the last organization owner")
		}
	}
	sandboxIDs := organizationWorkspaceVMIDs(ctx, s.queries, org.ID, user.ID)

	// Strip the user's team memberships for this org BEFORE removing org
	// membership. Team membership grants repo access independently of org
	// membership (team_members has no cascade from org_members), so doing this
	// first means a partial failure can only leave the user still in the org
	// (safe) — never removed-from-org-but-still-on-its-teams.
	if err := s.queries.DeleteTeamMembershipsForOrgUser(ctx, db.DeleteTeamMembershipsForOrgUserParams{
		OrganizationID: org.ID,
		UserID:         user.ID,
	}); err != nil {
		return pkgerrors.Internal("failed to remove organization team memberships").WithCause(err)
	}

	if err := s.queries.RemoveOrgMember(ctx, db.RemoveOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         user.ID,
	}); err != nil {
		return pkgerrors.Internal("failed to remove organization member").WithCause(err)
	}
	s.dispatchOrganizationEvent(ctx, org.ID, actor, "member_removed")
	revocation.PublishBestEffort(ctx, s.revocations, revocation.Event{
		Kind:           revocation.KindOrgMemberRemoved,
		UserID:         user.ID,
		OrganizationID: org.ID,
		SandboxIDs:     sandboxIDs,
		Reason:         "removed from organization " + org.Name,
		ActorID:        actor.ID,
	})
	s.reconcileSeats(ctx, org.ID)
	return nil
}

// removeOrgMemberTx performs the last-owner check, team-membership cleanup, and
// org-membership delete in one transaction under row locks:
//
//   - The organizations row lock serializes concurrent member removals in the
//     same org, so two owner removals cannot both pass the last-owner check and
//     leave the org ownerless.
//   - The org_members row lock (also taken by AddTeamMemberIfOrgMember) makes
//     removal and team-member admission mutually exclusive: a concurrent team
//     add either commits first (and its row is deleted by the cleanup below,
//     which runs on a fresh statement snapshot) or waits for this transaction
//     and then sees the membership gone.
func (s *OrgService) removeOrgMemberTx(ctx context.Context, org db.Organization, actor *db.User, user db.User) error {
	tx, err := s.txManager.BeginMemberRemovalTx(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to begin transaction").WithCause(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.LockOrganization(ctx, org.ID); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("organization not found")
		}
		return pkgerrors.Internal("failed to lock organization").WithCause(err)
	}

	targetMember, err := tx.GetOrgMemberForUpdate(ctx, db.GetOrgMemberForUpdateParams{
		OrganizationID: org.ID,
		UserID:         user.ID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("organization member not found")
		}
		return pkgerrors.Internal("failed to load target organization membership").WithCause(err)
	}

	if targetMember.Role == "owner" {
		ownerCount, err := tx.CountOrgOwners(ctx, org.ID)
		if err != nil {
			return pkgerrors.Internal("failed to count organization owners").WithCause(err)
		}
		if ownerCount <= 1 {
			return pkgerrors.Conflict("cannot remove the last organization owner")
		}
	}
	sandboxIDs := organizationWorkspaceVMIDs(ctx, s.queries, org.ID, user.ID)

	if err := tx.DeleteTeamMembershipsForOrgUser(ctx, db.DeleteTeamMembershipsForOrgUserParams{
		OrganizationID: org.ID,
		UserID:         user.ID,
	}); err != nil {
		return pkgerrors.Internal("failed to remove organization team memberships").WithCause(err)
	}

	if err := tx.RemoveOrgMember(ctx, db.RemoveOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         user.ID,
	}); err != nil {
		return pkgerrors.Internal("failed to remove organization member").WithCause(err)
	}

	if err := tx.Commit(ctx); err != nil {
		return pkgerrors.Internal("failed to remove organization member").WithCause(err)
	}
	s.dispatchOrganizationEvent(ctx, org.ID, actor, "member_removed")
	revocation.PublishBestEffort(ctx, s.revocations, revocation.Event{
		Kind:           revocation.KindOrgMemberRemoved,
		UserID:         user.ID,
		OrganizationID: org.ID,
		SandboxIDs:     sandboxIDs,
		Reason:         "removed from organization " + org.Name,
		ActorID:        actor.ID,
	})
	s.reconcileSeats(ctx, org.ID)
	return nil
}

// Webhook dispatch runs after the mutation committed, so it is best effort: a
// failed enqueue is logged and never fails the request, which would make the
// client retry a change that already succeeded.
func (s *OrgService) dispatchOrganizationEvent(
	ctx context.Context,
	orgID int64,
	actor *db.User,
	action string,
) {
	if s.dispatcher == nil {
		return
	}

	sender := webhooks.UserPayload{}
	if actor != nil {
		sender = webhooks.UserPayload{
			ID:    actor.ID,
			Login: actor.Username,
		}
	}

	payload := webhooks.OrganizationEventPayload{
		Action: action,
		Sender: sender,
	}
	if err := s.dispatcher.DispatchOrgEvent(ctx, orgID, webhooks.EventTypeOrganization, payload); err != nil {
		slog.Error("organization webhook enqueue failed", "org_id", orgID, "event", action, "error", err)
	}
}

func (s *OrgService) dispatchTeamLifecycleEvent(
	ctx context.Context,
	orgID int64,
	actor *db.User,
	action string,
) {
	if s.dispatcher == nil {
		return
	}

	sender := webhooks.UserPayload{}
	if actor != nil {
		sender = webhooks.UserPayload{
			ID:    actor.ID,
			Login: actor.Username,
		}
	}

	payload := webhooks.TeamEventPayload{
		Action: action,
		Sender: sender,
	}
	if err := s.dispatcher.DispatchOrgEvent(ctx, orgID, webhooks.EventTypeTeam, payload); err != nil {
		slog.Error("team webhook enqueue failed", "org_id", orgID, "event", action, "error", err)
	}
}

func (s *OrgService) dispatchTeamRepositoryEvent(
	ctx context.Context,
	repository db.Repository,
	owner string,
	actor *db.User,
	action string,
) {
	if s.dispatcher == nil {
		return
	}

	sender := webhooks.UserPayload{}
	if actor != nil {
		sender = webhooks.UserPayload{
			ID:    actor.ID,
			Login: actor.Username,
		}
	}

	payload := webhooks.RepositoryEventPayload{
		Action: action,
		Repository: webhooks.RepositoryPayload{
			ID:       repository.ID,
			Name:     repository.Name,
			FullName: strings.ToLower(strings.TrimSpace(owner)) + "/" + repository.Name,
		},
		Sender: sender,
	}
	if err := s.dispatcher.DispatchEvent(ctx, repository.ID, webhooks.EventTypeTeam, payload); err != nil {
		slog.Error("team repository webhook enqueue failed", "repo_id", repository.ID, "event", action, "error", err)
	}
}

func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if stdErrors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	return strings.Contains(strings.ToLower(err.Error()), "duplicate key")
}
