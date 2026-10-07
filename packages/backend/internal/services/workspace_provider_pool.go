package services

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const (
	// ProviderPoolPath is where guests reach the account pool: outside /api,
	// because a model call streams for minutes and workspace-bound
	// credentials are confined away from the /api surface.
	ProviderPoolPath = "/provider-pool"
	// ProviderPoolURLEnvName names the pool origin for the guest's model
	// routes (NativeEquipment): ${SMITHERS_ACCOUNT_POOL_URL}/chatgpt and
	// ${SMITHERS_ACCOUNT_POOL_URL}/anthropic.
	ProviderPoolURLEnvName = flowhost.AccountPoolURLEnv
	// ProviderPoolKeyEnvName holds the guest's pool credential as an
	// egress-proxy placeholder, bound for the API host only.
	ProviderPoolKeyEnvName = flowhost.AccountPoolKeyEnv
	// ProviderPoolProvidersEnvName lists the routes ("chatgpt,anthropic") the guest may
	// take to the pool: a provider the repository keys itself
	// keeps that key. Which of them have connected accounts the guest asks
	// the pool (GET /provider-pool/routes) when it resolves a seat, so an
	// account connected after boot serves without a restart.
	ProviderPoolProvidersEnvName = flowhost.AccountPoolProvidersEnv

	providerPoolTokenPrefix = "provider-pool-workspace-"
	providerPoolTokenTTL    = 7 * 24 * time.Hour
)

// ProviderPoolOffer decides whether a guest is offered the account pool
// (services.ProviderConnectionService).
type ProviderPoolOffer interface {
	ServesPool(ctx context.Context, userID, repositoryID int64) (bool, error)
}

// ProviderPoolTokenScopes binds a pool credential to one repository and one
// workspace. It grants read:workspace only; the pool route checks the
// bindings against the workspace row.
func ProviderPoolTokenScopes(repositoryID int64, workspaceID string) string {
	return string(middleware.ScopeReadWorkspace) + "," +
		middleware.RepositoryRestrictionScope(repositoryID) + "," +
		middleware.WorkspaceRestrictionScope(workspaceID)
}

type providerPoolTokenLister interface {
	ListAccessTokensByUserID(ctx context.Context, userID int64) ([]db.AccessToken, error)
}

// bindWorkspaceProviderPool offers the pool whenever the owner's accounts
// may serve the repository, whether or not any is connected yet. The pool
// credential is minted once per boot, replacing the workspace's earlier one,
// and bound as its placeholder value on the API host only, so no provider
// token is ever bound or visible. The platform seats stay bound: a seat the
// pool has no accounts for keeps them.
func (s *WorkspaceService) bindWorkspaceProviderPool(ctx context.Context, workspace db.Workspace, binding *workspaceProviderBinding) error {
	// The pool's names are reserved: a repository value never stands in for
	// the platform's, whether or not this boot offers the pool.
	binding.environment.Env = slices.DeleteFunc(binding.environment.Env, func(v AgentEnvironmentVariable) bool {
		return v.Name == ProviderPoolURLEnvName || v.Name == ProviderPoolProvidersEnvName || v.Name == ProviderPoolKeyEnvName
	})
	if workspace.RepositoryID <= 0 || workspace.UserID <= 0 {
		return nil
	}
	base := normalizePublicBaseURL(s.gitBaseURL)
	host := apiHost(base)
	if !sandbox.ValidEgressHost(host) {
		return nil
	}
	routes := flowhost.AccountPoolGuestRoutes(func(pool flowhost.AccountPoolSeat) bool {
		return workspaceDeclaresProvider(binding.environment, pool.Seat)
	})
	if len(routes) == 0 {
		return nil
	}
	serves, err := s.providerConnections.ServesPool(ctx, workspace.UserID, workspace.RepositoryID)
	if err != nil {
		return pkgerrors.Internal("resolve workspace provider accounts").WithCause(err)
	}
	if !serves {
		return nil
	}
	// The coding host chooses a pool-only default from live routes at startup.
	// Persisting a boot-time choice would turn a removed account into a pin.
	s.revokeProviderPoolTokens(ctx, workspace)
	token, err := issueTemporaryRepoTokenWithTTL(ctx, s.q, workspace.UserID, providerPoolTokenPrefix+workspace.ID,
		ProviderPoolTokenScopes(workspace.RepositoryID, workspace.ID), providerPoolTokenTTL)
	if err != nil {
		return pkgerrors.Internal("mint workspace provider pool credential").WithCause(err)
	}
	// Anthropic Messages clients send the pool key as x-api-key.
	binding.bind(sandbox.EgressProxySecret{Name: ProviderPoolKeyEnvName, Value: token.Plaintext, Hosts: []string{host}, MatchHeaders: []string{"authorization", "x-api-key"}})
	binding.setEnv(ProviderPoolURLEnvName, strings.TrimRight(base, "/")+ProviderPoolPath)
	binding.setEnv(ProviderPoolProvidersEnvName, strings.Join(routes, ","))
	return nil
}

func (s *WorkspaceService) revokeProviderPoolTokens(ctx context.Context, workspace db.Workspace) {
	lister, ok := s.q.(providerPoolTokenLister)
	if !ok {
		return
	}
	tokens, err := lister.ListAccessTokensByUserID(ctx, workspace.UserID)
	if err != nil {
		slog.Warn("list provider pool credentials failed", "workspace_id", workspace.ID, "error", err)
		return
	}
	for _, token := range tokens {
		if token.Name == providerPoolTokenPrefix+workspace.ID {
			revokeTemporaryRepoCloneToken(ctx, s.q, workspace.UserID, token.ID)
		}
	}
}

// providerPoolScopeQuerier resolves the credential and the workspace it names.
type providerPoolScopeQuerier interface {
	GetAccessTokenByID(ctx context.Context, id int64) (db.AccessToken, error)
	GetWorkspace(ctx context.Context, id string) (db.Workspace, error)
}

// ProviderPoolScopes binds a pool call to a (user, repository) scope.
type ProviderPoolScopes struct {
	install bool
	q       providerPoolScopeQuerier
	pool    *pgxpool.Pool
	codec   flowhost.SecretCodec
}

// NewProviderPoolScopes resolves pool scopes over product SQL. codec opens
// managed Flow hosts' stored credentials (the Flow host store's codec).
func NewProviderPoolScopes(q providerPoolScopeQuerier, pool *pgxpool.Pool, codec flowhost.SecretCodec, install ...bool) *ProviderPoolScopes {
	return &ProviderPoolScopes{q: q, pool: pool, codec: codec, install: len(install) > 0 && install[0]}
}

type verifiedInstallPoolHostKey struct{}

// Scope answers the pool (user, repository) of an authenticated call.
//
// A managed Flow host (a box's coding host) presents its
// binding's model credential: it draws on the accounts of the binding's
// user, the user who initiated the run, on the binding's repository; the
// repository preference and that user's grants decide the rest.
//
// Otherwise the token must be the workspace's platform-minted pool
// credential (not another workspace-bound token, such as the head
// reporter's), bound to that workspace and its repository, and the workspace
// must belong to its user.
// It preserves the legacy provider interface; ScopeDecision carries the
// install's typed authorization refusal to the HTTP boundary.
func (p *ProviderPoolScopes) Scope(ctx context.Context, bearer string) (int64, int64, bool) {
	user, repository, err := p.ScopeDecision(ctx, bearer)
	return user, repository, err == nil
}

func (p *ProviderPoolScopes) ScopeDecision(ctx context.Context, bearer string) (int64, int64, error) {
	return p.scopeDecision(ctx, bearer, nil)
}

func (p *ProviderPoolScopes) scopeDecision(ctx context.Context, bearer string, bind func(InstallSubject, *flowhost.CredentialBinding)) (userID, repositoryID int64, failure error) {
	if p == nil {
		return 0, 0, errors.New("pool credential required")
	}
	if strings.HasPrefix(bearer, flowhost.ModelCredentialPrefix) {
		binding, err := flowhost.VerifyModelCredential(ctx, p.pool, p.codec, bearer)
		if err != nil || binding.UserID <= 0 || binding.RepositoryID <= 0 {
			if p.install {
				return 0, 0, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Invalid model credential"}
			}
			return 0, 0, errors.New("pool credential required")
		}
		if p.install {
			verified := context.WithValue(ctx, verifiedInstallPoolHostKey{}, binding)
			subject := InstallSubject{RepositoryID: binding.RepositoryID, WorkspaceID: binding.WorkspaceID}
			if _, err := Authorize(verified, db.New(p.pool), "workspace.provider-pool", subject); err != nil {
				return 0, 0, err
			}
			if bind != nil {
				bind(subject, &binding)
			}
		}
		return binding.UserID, binding.RepositoryID, nil
	}
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || !info.IsTokenAuth || info.User == nil {
		return 0, 0, errors.New("pool credential required")
	}
	workspaceID := info.WorkspaceRestriction()
	repositoryID = info.RepositoryRestriction()
	if p.install {
		q, ok := p.q.(*db.Queries)
		if !ok {
			return 0, 0, errors.New("pool credential required")
		}
		decision, err := Authorize(ctx, q, "workspace.provider-pool", InstallSubject{RepositoryID: repositoryID, WorkspaceID: workspaceID})
		if err != nil {
			return 0, 0, err
		}
		if bind != nil {
			bind(InstallSubject{RepositoryID: repositoryID, WorkspaceID: workspaceID}, nil)
		}
		return decision.UserID, repositoryID, nil
	}
	if workspaceID == "" || repositoryID <= 0 {
		return 0, 0, errors.New("pool credential required")
	}
	token, err := p.q.GetAccessTokenByID(ctx, info.TokenID)
	if err != nil || !token.SystemIssued || token.UserID != info.User.ID || token.Name != providerPoolTokenPrefix+workspaceID {
		return 0, 0, errors.New("pool credential required")
	}
	workspace, err := p.q.GetWorkspace(ctx, workspaceID)
	if err != nil || workspace.UserID != info.User.ID || workspace.RepositoryID != repositoryID {
		return 0, 0, errors.New("pool credential required")
	}
	return workspace.UserID, repositoryID, nil
}
