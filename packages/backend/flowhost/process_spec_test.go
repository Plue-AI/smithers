package flowhost

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
)

func TestBuildProcessSpecUsesSameImmutableIdentityForWorkspaceAdapters(t *testing.T) {
	target := flowruntime.Target{TenantID: "repository:5", PrincipalID: "user:9", BindingKind: "agent-session", BindingID: "session-1"}
	authority := Authority{Target: target, RepositoryID: 5, UserID: 9, WorkspaceID: "workspace-1", CatalogKey: CatalogCoding, SourceRevision: strings.Repeat("b", 40)}
	catalog := Catalog{Key: CatalogCoding, Family: CatalogCoding, Executable: "/opt/smithers/coding-host",
		ArtifactDigest: strings.Repeat("a", 64),
		ServiceName:    "smithers-flow-coding", ImplementationModel: "openai:gpt-5"}
	binding := Binding{ID: "11111111-1111-4111-8111-111111111111", TenantID: target.TenantID,
		PrincipalID: target.PrincipalID, BindingKind: target.BindingKind, BindingID: target.BindingID,
		RepositoryID: 5, UserID: 9, WorkspaceID: "workspace-1", CatalogKey: CatalogCoding,
		ServiceName: catalog.ServiceName, RuntimeArtifactDigest: catalog.ArtifactDigest,
		SourceRevision: authority.SourceRevision, OwnerGeneration: 7, State: "starting"}
	spec, err := BuildProcessSpec(HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "bearer"},
		WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4317)
	require.NoError(t, err)
	assert.Equal(t, "127.0.0.1:4317", spec.ReadyAddress)
	assert.Equal(t, []string{"/opt/smithers/coding-host", "serve", "--root", "/workspace/repo", "--state-dir",
		"/workspace/state", "--host", "127.0.0.1", "--port", "4317", "--listen"}, spec.Args)
	assert.Equal(t, "bearer", spec.Environment["SMITHERS_API_KEY"])
	assert.Equal(t, "7", spec.Environment["SMITHERS_OWNER_GENERATION"])
	assert.Equal(t, "openai:gpt-5", spec.Environment["SMITHERS_CODING_IMPLEMENT_MODEL"])
	assert.NotContains(t, spec.Identity, "bearer")
	assert.NotContains(t, spec.Environment, "SMITHERS_POSTGRES_URL")
	assert.NotContains(t, spec.Environment, "SMITHERS_POSTGRES_SCHEMA")
	otherPort, err := BuildProcessSpec(HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "bearer"}, WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4318)
	require.NoError(t, err)
	assert.Equal(t, spec.Identity, otherPort.Identity)
	assert.NotEqual(t, spec.ReadyAddress, otherPort.ReadyAddress)
	catalog.ImplementationModel = ""
	_, err = validateCatalog(catalog)
	require.NoError(t, err)
	spec, err = BuildProcessSpec(HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "bearer"}, WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4317)
	require.NoError(t, err)
	assert.NotContains(t, spec.Environment, "SMITHERS_CODING_IMPLEMENT_MODEL")
}

func TestBuildProcessSpecGivesModelSeatsADerivedCredential(t *testing.T) {
	target := flowruntime.Target{TenantID: "repository:5", PrincipalID: "user:9", BindingKind: "agent-session", BindingID: "session-1"}
	authority := Authority{Target: target, RepositoryID: 5, UserID: 9, WorkspaceID: "workspace-1", CatalogKey: CatalogCoding, SourceRevision: strings.Repeat("b", 40)}
	seat, _ := modelproxy.SeatFor(modelproxy.ProviderVercel)
	catalog := Catalog{Key: CatalogCoding, Family: CatalogCoding, Executable: "/opt/smithers/coding-host",
		ArtifactDigest: strings.Repeat("a", 64), ServiceName: "smithers-flow-coding",
		ModelProxyURL: "https://backend.internal/model-proxy", ModelSeats: []modelproxy.Seat{seat}}
	binding := Binding{ID: "11111111-1111-4111-8111-111111111111", TenantID: target.TenantID,
		PrincipalID: target.PrincipalID, BindingKind: target.BindingKind, BindingID: target.BindingID,
		RepositoryID: 5, UserID: 9, WorkspaceID: "workspace-1", CatalogKey: CatalogCoding,
		ServiceName: catalog.ServiceName, RuntimeArtifactDigest: catalog.ArtifactDigest,
		SourceRevision: authority.SourceRevision, OwnerGeneration: 7, State: "starting"}
	spec, err := BuildProcessSpec(HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "control-credential"},
		WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4317)
	require.NoError(t, err)
	credential := spec.Environment["AI_GATEWAY_API_KEY"]
	assert.Equal(t, ModelCredential(binding.ID, "control-credential"), credential)
	assert.True(t, strings.HasPrefix(credential, ModelCredentialPrefix+binding.ID+"."))
	assert.NotContains(t, credential, "control-credential", "the model credential does not reveal the control credential")
	assert.Equal(t, "https://backend.internal/model-proxy/vercel/v4/ai/evaluation-model", spec.Environment["SMITHERS_EVALUATOR_BASE_URL"])
	assert.Equal(t, "vercel", spec.Environment[modelproxy.ProvidersEnv])
	assert.NotContains(t, spec.Identity, credential)
	assert.NotEqual(t, ModelCredential(binding.ID, "rotated"), credential)
	_, pooled := spec.Environment[AccountPoolURLEnv]
	assert.False(t, pooled, "no pool unless the deployment offers one")

	// With the account pool offered, the host reaches it with the same
	// derived credential; the pool serves the binding user's accounts.
	catalog.AccountPoolURL = "https://backend.internal/provider-pool"
	_, err = validateCatalog(catalog)
	require.NoError(t, err)
	spec, err = BuildProcessSpec(HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "control-credential"},
		WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4317)
	require.NoError(t, err)
	assert.Equal(t, "https://backend.internal/provider-pool", spec.Environment[AccountPoolURLEnv])
	assert.Equal(t, "anthropic,chatgpt", spec.Environment[AccountPoolProvidersEnv])
	assert.Equal(t, credential, spec.Environment[AccountPoolKeyEnv])
	assert.NotContains(t, spec.Identity, credential)
	catalog.AccountPoolURL = "file:///etc/passwd"
	_, err = validateCatalog(catalog)
	require.Error(t, err)
}

// A repository command can read its host's environment; a database URL there
// hands the backend credential to the repository (#2175).
func TestCatalogRefusesDatabaseCredentials(t *testing.T) {
	for _, name := range []string{"SMITHERS_POSTGRES_URL", "SMITHERS_POSTGRES_SCHEMA", "DATABASE_URL", "SMITHERS_DATABASE_URL", "SMITHERS_BACKEND"} {
		catalog := Catalog{Key: CatalogCoding, Family: CatalogCoding, Executable: "/opt/smithers/coding-host",
			ArtifactDigest: strings.Repeat("a", 64), ServiceName: "smithers-flow-coding",
			Environment: map[string]string{name: "postgres://user:secret@db/smithers"}}
		_, err := validateCatalog(catalog)
		require.ErrorContains(t, err, "database configuration "+name)
		assert.NotContains(t, err.Error(), "secret")
	}
}
