// Package testkit constructs canonical product services for deployment adapter
// integration tests. It adds no SQL, policy, or production composition.
package testkit

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/database"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/productstore"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type CreateWorkflowDefinitionParams = db.CreateWorkflowDefinitionParams
type CreateWorkflowRunParams = db.CreateWorkflowRunParams
type CreateWorkflowStepParams = db.CreateWorkflowStepParams
type CreateWorkflowTaskParams = db.CreateWorkflowTaskParams
type CreateWorkspaceParams = db.CreateWorkspaceParams
type CreateWorkspaceSessionParams = db.CreateWorkspaceSessionParams
type GetWorkspaceSessionByRepoParams = db.GetWorkspaceSessionByRepoParams
type GetWorkspaceByRepoParams = db.GetWorkspaceByRepoParams
type UpsertWorkspaceShareParams = db.UpsertWorkspaceShareParams
type CreateAccessTokenParams = db.CreateAccessTokenParams
type AddCollaboratorParams = db.AddCollaboratorParams
type DeleteAccessTokenParams = db.DeleteAccessTokenParams
type WorkspaceSession = db.WorkspaceSession
type ReceivePackMetadata = repohost.ReceivePackMetadata
type APIError = apierrors.APIError

// Product exposes only canonical operations used to seed and verify integration
// fixtures. Its constructor preserves the exact supplied transaction.
type Product interface {
	productstore.Product
	CreateWorkflowDefinition(context.Context, db.CreateWorkflowDefinitionParams) (db.WorkflowDefinition, error)
	UpsertWorkspaceShare(context.Context, db.UpsertWorkspaceShareParams) (db.WorkspaceShare, error)
	AddCollaborator(context.Context, db.AddCollaboratorParams) (db.Collaborator, error)
	GetAccessTokenByID(context.Context, int64) (db.AccessToken, error)
	GetAuthInfoByTokenHash(context.Context, string) (db.GetAuthInfoByTokenHashRow, error)
}

func Queries(t testing.TB, conn productstore.DBTX) Product { t.Helper(); return db.New(conn) }

func Workspace(t testing.TB, q services.WorkspaceQuerier, provider sandbox.Provider, opts ...services.WorkspaceServiceOption) (*services.WorkspaceService, func(context.Context) error) {
	t.Helper()
	base := []services.WorkspaceServiceOption{services.WithWorkspaceGitBaseURL("https://repository.test"), services.WithWorkspaceSandboxClient(provider)}
	service := services.NewWorkspaceService(q, append(base, opts...)...)
	return service, services.ObserveWorkspaceFixtureCleanup(t, service)
}
func GitHTTPProxy(t testing.TB, conn productstore.DBTX, host services.GitHTTPRepoHostClient) *services.GitHTTPProxyService {
	t.Helper()
	product := db.New(conn)
	return services.NewGitHTTPProxyService(product, services.NewSSHAuthorizationService(product), host)
}

// These helpers construct the actual product collaborator used by runner tests.
type NoopSecretCodec = webhook.NoopSecretCodec

func NewSecretInjector(t testing.TB, q services.SecretInjectionQuerier, codec webhook.SecretCodec) *services.SecretInjector {
	t.Helper()
	return services.NewSecretInjector(q, codec)
}
func ConfigureSQLCTypes(t testing.TB, types *pgtype.Map) {
	t.Helper()
	database.ConfigureSQLCTypes(types)
}

func CommitStatuses(t testing.TB, conn productstore.DBTX) *services.CommitStatusService {
	t.Helper()
	return services.NewCommitStatusService(db.New(conn))
}
func WorkflowRuns(t testing.TB, q services.WorkflowRunQuerier, opts ...services.WorkflowRunServiceOption) services.WorkflowRunService {
	t.Helper()
	return services.NewWorkflowRunService(q, opts...)
}

var WithWorkflowRunCommitStatusWriter = services.WithWorkflowRunCommitStatusWriter
var WithWorkflowRunMetrics = services.WithWorkflowRunMetrics

var WithWorkspaceSandboxMetrics = services.WithWorkspaceSandboxMetrics

type ListSecretValuesRow = db.ListSecretValuesRow

type RepositoryVariable = db.RepositoryVariable

type ListOrgSecretValuesRow = db.ListOrgSecretValuesRow

type OrganizationVariable = db.OrganizationVariable

type UpdateWorkflowRunAgentTokenParams = db.UpdateWorkflowRunAgentTokenParams

type GitHubCheckRunResult = services.GitHubCheckRunResult

type GitHubCheckRunInput = services.GitHubCheckRunInput
