package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// SandboxVMClient is the minimal sandbox provider VM API surface used by services.
// The type name is retained while older product and database names migrate.
type SandboxVMClient interface {
	CreateSandbox(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error)
	ForkSandbox(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error)
	CreateService(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error)
	InspectSandbox(ctx context.Context, vmID string) (sandbox.Sandbox, error)
	DeleteSandbox(ctx context.Context, vmID string) error
	StartSandbox(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error)
	SuspendSandbox(ctx context.Context, vmID string) (sandbox.SuspendResult, error)
	SnapshotSandbox(ctx context.Context, vmID string, req sandbox.SnapshotRequest) (sandbox.SnapshotResult, error)
	DeleteSnapshot(ctx context.Context, snapshotID string) error
	CreateIdentity(ctx context.Context) (sandbox.Identity, error)
	GrantAccess(ctx context.Context, identityID, vmID string, req sandbox.GrantAccessRequest) (sandbox.AccessGrant, error)
	CreateIdentityToken(ctx context.Context, identityID string) (sandbox.CreatedToken, error)
}

// SandboxMetricsRecorder captures service-level sandbox provider VM lifecycle metrics.
// Method names are retained for compatibility with older service wiring.
type SandboxMetricsRecorder interface {
	ObserveSandboxVMCreate(vmType, status string, seconds float64)
	AddSandboxActiveVMs(vmType string, delta float64)
	ObserveSandboxVMSuspend(seconds float64)
}

type WorkspaceSessionMetricsRecorder interface {
	ObserveWorkspaceSessionProvision(status string, seconds float64)
}

// sandboxProvisionContext gives every product-owned create/fork a stable
// logical-operation key and durable attribution headers. The attempt name is
// part of the key so an intentional fallback with a different request body
// (for example golden snapshot -> bare image) does not conflict with the first
// operation, while retries of either attempt converge on one provider ID.
// The key names the create or fork request alone: the controller refuses any
// other mutation sent under it (409 idempotency_conflict), so follow-up calls
// on the new sandbox, such as createWorkspaceSandbox's artifact writes and
// execs, must not reuse the returned context's key.
func sandboxProvisionContext(ctx context.Context, action, resourceKind, resourceID, attempt string) context.Context {
	payload := strings.Join([]string{action, resourceKind, resourceID, attempt}, "\x00")
	digest := sha256.Sum256([]byte(payload))
	key := "plue-" + action + "-" + hex.EncodeToString(digest[:16])
	ctx = sandbox.WithIdempotencyKey(ctx, key)
	return sandbox.WithResourceLink(ctx, resourceKind, resourceID)
}

type accessTokenStore interface {
	CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error)
	DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error
}

type temporaryRepoCloneToken struct {
	ID        int64
	Plaintext string
	ExpiresAt time.Time
}

const (
	temporaryRepoTokenTTL           = time.Hour
	temporaryRepoTokenRevokeTimeout = 10 * time.Second
	// perRunAPITokenTTL bounds a per-run scoped jjhub API token. It mirrors the
	// agent callback token's 24h expiry (see agent_dispatch.storeTokenHash) so a
	// long-running agent can keep calling the REST API for the whole run. The
	// token is revoked at run end regardless; the TTL is only a leak backstop.
	perRunAPITokenTTL = 24 * time.Hour
)

// issueTemporaryRepoCloneToken mints a short-lived read-only token used to CLONE
// a user's jjhub repo into a sandbox/workspace.
func issueTemporaryRepoCloneToken(ctx context.Context, store accessTokenStore, userID int64, name string) (temporaryRepoCloneToken, error) {
	return issueTemporaryRepoToken(ctx, store, userID, name, string(middleware.ScopeReadRepository))
}

// CI clone credentials are limited to one repository, including when an org
// owner lends their identity to an org-owned repository's guest.
func issueTemporaryBoundRepoCloneToken(ctx context.Context, store accessTokenStore, userID, repositoryID int64, name string) (temporaryRepoCloneToken, error) {
	if repositoryID <= 0 {
		return temporaryRepoCloneToken{}, fmt.Errorf("bound clone token requires a repository binding")
	}
	scopes := string(middleware.ScopeReadRepository) + "," + middleware.RepositoryRestrictionScope(repositoryID)
	return issueTemporaryRepoToken(ctx, store, userID, name, scopes)
}

// issueTemporarySyncPushToken mints the platform's short-lived sync
// credential (middleware.CredentialSync): it can PUSH (write) to one
// repository, the default bookmark included. Only the GitHub import and its
// refresh hold it, on the server, to push the refs they cloned from GitHub; it
// is never handed to an agent, workspace or workflow. The pushes it makes
// start no cache-saving run (SystemPushTriggerEvent).
func issueTemporarySyncPushToken(ctx context.Context, store accessTokenStore, userID, repositoryID int64, name string) (temporaryRepoCloneToken, error) {
	if repositoryID <= 0 {
		return temporaryRepoCloneToken{}, fmt.Errorf("sync push token requires a repository binding")
	}
	return issueTemporaryRepoToken(ctx, store, userID, name, string(middleware.ScopeWriteRepository)+","+
		middleware.RepositoryRestrictionScope(repositoryID)+","+middleware.SyncCredentialScope())
}

// issueTemporaryRepoAPIToken mints a short-lived write-scoped token that a
// sandbox/agent run uses to call the jjhub REST API (create landings, set/delete
// bookmarks, read/create issues) AS the owning user. Unlike the clone/push
// tokens it lives for the whole run (perRunAPITokenTTL), and is revoked at run
// end. write:repository implies read:repository, so it satisfies every list
// route too.
//
// The token is BOUND to the run's repository via a repo:<id> restriction entry
// in its scopes: LoadRepoContext and the git smart-HTTP proxy treat it as
// anonymous on every other repository, so a prompt-injected agent that
// exfiltrates it cannot touch the owner's other repos.
func issueTemporaryRepoAPIToken(ctx context.Context, store accessTokenStore, userID, repositoryID int64, name string, allowedPaths ...string) (temporaryRepoCloneToken, error) {
	return issueTemporaryBoundRepoAPIToken(ctx, store, userID, repositoryID, name, "", allowedPaths...)
}

func issueTemporaryAgentRepoAPIToken(ctx context.Context, store accessTokenStore, userID, repositoryID int64, name, sessionID string, allowedPaths ...string) (temporaryRepoCloneToken, error) {
	return issueTemporaryBoundRepoAPIToken(ctx, store, userID, repositoryID, name, sessionID, allowedPaths...)
}

func issueTemporaryBoundRepoAPIToken(ctx context.Context, store accessTokenStore, userID, repositoryID int64, name, sessionID string, allowedPaths ...string) (temporaryRepoCloneToken, error) {
	if repositoryID <= 0 {
		return temporaryRepoCloneToken{}, fmt.Errorf("per-run api token requires a repository binding")
	}
	scopes := string(middleware.ScopeWriteRepository) + "," + middleware.RepositoryRestrictionScope(repositoryID)
	if sessionID = strings.TrimSpace(sessionID); sessionID != "" {
		scopes += "," + middleware.AgentSessionRestrictionScope(sessionID)
	}
	for _, pathScope := range middleware.PathRestrictionScopes(allowedPaths) {
		scopes += "," + pathScope
	}
	return issueTemporaryRepoTokenWithTTL(ctx, store, userID, name, scopes, perRunAPITokenTTL)
}

func issueTemporaryRepoToken(ctx context.Context, store accessTokenStore, userID int64, name, scopes string) (temporaryRepoCloneToken, error) {
	return issueTemporaryRepoTokenWithTTL(ctx, store, userID, name, scopes, temporaryRepoTokenTTL)
}

func issueTemporaryRepoTokenWithTTL(ctx context.Context, store accessTokenStore, userID int64, name, scopes string, ttl time.Duration) (temporaryRepoCloneToken, error) {
	if store == nil {
		return temporaryRepoCloneToken{}, fmt.Errorf("access token store unavailable")
	}

	plaintext := "smithers_" + randomHex(20)
	sum := sha256.Sum256([]byte(plaintext))
	tokenHash := hex.EncodeToString(sum[:])
	tokenLastEight := tokenHash[len(tokenHash)-8:]

	expiresAt := time.Now().UTC().Add(ttl)
	created, err := store.CreateAccessToken(ctx, db.CreateAccessTokenParams{
		UserID:         userID,
		Name:           name,
		TokenHash:      tokenHash,
		TokenLastEight: tokenLastEight,
		SystemIssued:   true,
		Scopes:         scopes,
		ExpiresAt:      pgtype.Timestamptz{Time: expiresAt, Valid: true},
	})
	if err != nil {
		return temporaryRepoCloneToken{}, err
	}

	return temporaryRepoCloneToken{
		ID:        created.ID,
		Plaintext: plaintext,
		ExpiresAt: expiresAt,
	}, nil
}

func revokeTemporaryRepoCloneToken(ctx context.Context, store accessTokenStore, userID, tokenID int64) {
	if store == nil || tokenID <= 0 {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	revokeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), temporaryRepoTokenRevokeTimeout)
	defer cancel()
	_ = store.DeleteAccessToken(revokeCtx, db.DeleteAccessTokenParams{
		ID:     tokenID,
		UserID: userID,
	})
}

// gitBearerAuthEnvExports returns shell `export` lines that hand a bearer
// credential to git via GIT_CONFIG_* environment variables instead of an
// `-c http.extraHeader=…` argv flag: argv is world-readable in
// /proc/<pid>/cmdline inside the VM for the whole clone/fetch, while the
// environment is not. runuser/su without --login preserve the exported values
// for the target user's git process. Mirrors gitBearerAuthEnv
// (github_import.go), which does the same for host-side exec.Cmd invocations.
func gitBearerAuthEnvExports(token string) []string {
	return []string{
		"export GIT_CONFIG_COUNT=1",
		"export GIT_CONFIG_KEY_0=http.extraHeader",
		"export GIT_CONFIG_VALUE_0=" + shellQuote("Authorization: Bearer "+strings.TrimSpace(token)),
	}
}

func buildAuthenticatedRepoCloneURL(baseURL, owner, repo, token string) (string, error) {
	parsed, err := buildRepoCloneURL(baseURL, owner, repo)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(token) == "" {
		return "", fmt.Errorf("git clone token is required")
	}

	parsed.User = url.UserPassword("x-access-token", token)
	return parsed.String(), nil
}

func buildRepoCloneURL(baseURL, owner, repo string) (*url.URL, error) {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return nil, fmt.Errorf("git base url is required")
	}
	if strings.TrimSpace(owner) == "" || strings.TrimSpace(repo) == "" {
		return nil, fmt.Errorf("repository owner and name are required")
	}

	parsed, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("parse git base url: %w", err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("git base url must include scheme and host")
	}

	parsed.Path = path.Join(parsed.Path, owner, repo+".git")
	parsed.User = nil
	return parsed, nil
}

func normalizePublicBaseURL(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimRight(raw, "/")
	if strings.HasSuffix(raw, "/api") {
		return strings.TrimSuffix(raw, "/api")
	}
	return raw
}

func optionalVMID(vmID string) pgtype.Text {
	vmID = strings.TrimSpace(vmID)
	return pgtype.Text{String: vmID, Valid: vmID != ""}
}
