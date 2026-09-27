package services

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
)

const (
	// modelProxyTokenPrefix names every platform-minted model credential; the
	// full name is prefix + holder ("workspace-<id>").
	modelProxyTokenPrefix = "model-proxy-"
	modelProxyTokenTTL    = 7 * 24 * time.Hour
)

// modelProxyURL is the metered proxy under a public base URL, or "" when the
// base URL names no host a guest can reach.
func modelProxyURL(baseURL string) string {
	base := normalizePublicBaseURL(baseURL)
	if apiHost(base) == "" {
		return ""
	}
	return base + modelproxy.Path
}

// modelProxyTokenScopes confines a model credential off the /api surface:
// the workspace restriction admits no /api route but a workspace's own head
// report.
func modelProxyTokenScopes(repositoryID int64, holder string) string {
	return string(middleware.ScopeReadWorkspace) + "," +
		middleware.RepositoryRestrictionScope(repositoryID) + "," +
		middleware.WorkspaceRestrictionScope(holder)
}

// issueModelProxyToken mints holder's model credential for userID. The
// holder's earlier credentials stay valid until the caller has installed the
// new one and calls revokeModelProxyTokens with its id.
func issueModelProxyToken(ctx context.Context, store accessTokenStore, userID, repositoryID int64, holder, restriction string) (temporaryRepoCloneToken, error) {
	return issueTemporaryRepoTokenWithTTL(ctx, store, userID, modelProxyTokenPrefix+holder,
		modelProxyTokenScopes(repositoryID, restriction), modelProxyTokenTTL)
}

// revokeModelProxyTokens deletes holder's live model credentials except keep.
func revokeModelProxyTokens(ctx context.Context, store accessTokenStore, userID int64, holder string, keep ...int64) {
	lister, ok := store.(providerPoolTokenLister)
	if !ok || userID <= 0 {
		return
	}
	tokens, err := lister.ListAccessTokensByUserID(ctx, userID)
	if err != nil {
		slog.Warn("list model proxy credentials failed", "holder", holder, "error", err)
		return
	}
	for _, token := range tokens {
		if token.Name == modelProxyTokenPrefix+holder && !slices.Contains(keep, token.ID) {
			revokeTemporaryRepoCloneToken(ctx, store, userID, token.ID)
		}
	}
}

type modelProxyCallerQuerier interface {
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetAccessTokenByID(ctx context.Context, id int64) (db.AccessToken, error)
	GetWorkspace(ctx context.Context, id string) (db.Workspace, error)
}

// ModelProxyCallers resolves who pays for a proxy call. Agent runs and
// managed Flow hosts are repository automation and charge the repository's
// owner; a workspace and a signed-in app call charge the user.
type ModelProxyCallers struct {
	q     modelProxyCallerQuerier
	pool  *pgxpool.Pool
	codec flowhost.SecretCodec
	// PaidPlan reports whether an owner has a paid plan. When set, automation
	// on an organization's repository charges the organization only when it
	// has one, and otherwise the user the run or host acts for.
	PaidPlan func(ctx context.Context, ownerType string, ownerID int64) (bool, error)
}

// NewModelProxyCallers resolves payers over product SQL. codec opens managed
// Flow hosts' stored credentials (the Flow host store's codec).
func NewModelProxyCallers(q modelProxyCallerQuerier, pool *pgxpool.Pool, codec flowhost.SecretCodec) *ModelProxyCallers {
	return &ModelProxyCallers{q: q, pool: pool, codec: codec}
}

// ResolveModelCaller reads the credential the route's auth middleware
// (routes.ModelProxyAuth) authenticated.
func (c *ModelProxyCallers) ResolveModelCaller(r *http.Request) (modelproxy.Caller, error) {
	ctx := r.Context()
	if run := middleware.WorkflowRunFromContext(ctx); run != nil {
		caller, err := c.repositoryOwner(ctx, run.RepositoryID)
		if err == nil {
			caller, err = c.automationPayer(ctx, caller, func() (int64, error) { return c.runActor(ctx, run.ID) })
		}
		caller.Source, caller.RepositoryID, caller.WorkflowRunID = modelproxy.SourceAgentRun, run.RepositoryID, run.ID
		return caller, err
	}
	if token := bearerCredential(r); strings.HasPrefix(token, flowhost.ModelCredentialPrefix) {
		binding, err := flowhost.VerifyModelCredential(ctx, c.pool, c.codec, token)
		if err != nil {
			if errors.Is(err, flowhost.ErrModelCredentialInvalid) {
				return modelproxy.Caller{}, modelproxy.ErrUnauthenticated
			}
			return modelproxy.Caller{}, err
		}
		caller, err := c.repositoryOwner(ctx, binding.RepositoryID)
		if err == nil {
			caller, err = c.automationPayer(ctx, caller, func() (int64, error) { return binding.UserID, nil })
		}
		caller.Source, caller.UserID, caller.RepositoryID = modelproxy.SourceFlowHost, binding.UserID, binding.RepositoryID
		caller.WorkspaceID, caller.Reference = binding.WorkspaceID, binding.ID
		return caller, err
	}
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil || !info.IsTokenAuth {
		return modelproxy.Caller{}, modelproxy.ErrUnauthenticated
	}
	user := modelproxy.Caller{OwnerType: "user", OwnerID: info.User.ID, UserID: info.User.ID}
	if !info.IsResourceBound() {
		// The user's own token (the app's signed-in calls): the user pays.
		// read:user spends model credit, as it did on the legacy proxy.
		// A third-party OAuth app never spends the user's credit.
		if info.TokenSource == middleware.TokenSourceOAuth2AccessToken || !info.Scopes.Has(middleware.ScopeReadUser) {
			return modelproxy.Caller{}, modelproxy.ErrForbidden
		}
		user.Source = modelproxy.SourceApp
		return user, nil
	}
	token, err := c.q.GetAccessTokenByID(ctx, info.TokenID)
	if err != nil || !token.SystemIssued || token.UserID != info.User.ID || !strings.HasPrefix(token.Name, modelProxyTokenPrefix) {
		return modelproxy.Caller{}, modelproxy.ErrForbidden
	}
	repositoryID := info.RepositoryRestriction()
	holder := strings.TrimPrefix(token.Name, modelProxyTokenPrefix)
	restriction := info.WorkspaceRestriction()
	user.RepositoryID = repositoryID
	switch {
	case strings.HasPrefix(holder, "workspace-") && restriction == strings.TrimPrefix(holder, "workspace-"):
		workspace, err := c.q.GetWorkspace(ctx, restriction)
		if err != nil || workspace.UserID != info.User.ID || workspace.RepositoryID != repositoryID || repositoryID <= 0 {
			return modelproxy.Caller{}, modelproxy.ErrForbidden
		}
		user.Source, user.WorkspaceID = modelproxy.SourceWorkspace, workspace.ID
		return user, nil
	}
	return modelproxy.Caller{}, modelproxy.ErrForbidden
}

// automationPayer is the account automation on a repository charges. An
// organization without a paid plan does not pay for it: the acting user does,
// so a paying user can work on a Free organization's repositories. Without a
// known actor the organization pays.
func (c *ModelProxyCallers) automationPayer(ctx context.Context, owner modelproxy.Caller, actor func() (int64, error)) (modelproxy.Caller, error) {
	if owner.OwnerType != "org" || c.PaidPlan == nil {
		return owner, nil
	}
	paid, err := c.PaidPlan(ctx, owner.OwnerType, owner.OwnerID)
	if err != nil || paid {
		return owner, err
	}
	userID, err := actor()
	if err != nil || userID <= 0 {
		return owner, err
	}
	return modelproxy.Caller{OwnerType: "user", OwnerID: userID, UserID: userID}, nil
}

// runActor is the user whose agent session a run works for, or 0.
func (c *ModelProxyCallers) runActor(ctx context.Context, runID int64) (int64, error) {
	var userID int64
	err := c.pool.QueryRow(ctx, `SELECT user_id FROM agent_sessions WHERE workflow_run_id = $1 AND deleted_at IS NULL
		ORDER BY created_at DESC LIMIT 1`, runID).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return userID, err
}

func (c *ModelProxyCallers) repositoryOwner(ctx context.Context, repositoryID int64) (modelproxy.Caller, error) {
	repo, err := c.q.GetRepoByID(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return modelproxy.Caller{}, modelproxy.ErrForbidden
	}
	if err != nil {
		return modelproxy.Caller{}, err
	}
	if repo.OrgID.Valid && repo.OrgID.Int64 > 0 {
		return modelproxy.Caller{OwnerType: "org", OwnerID: repo.OrgID.Int64}, nil
	}
	if repo.UserID.Valid && repo.UserID.Int64 > 0 {
		return modelproxy.Caller{OwnerType: "user", OwnerID: repo.UserID.Int64}, nil
	}
	return modelproxy.Caller{}, modelproxy.ErrForbidden
}

func bearerCredential(r *http.Request) string {
	scheme, token, _ := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
	if !strings.EqualFold(scheme, "bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}
