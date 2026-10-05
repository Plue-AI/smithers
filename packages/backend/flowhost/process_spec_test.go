package flowhost

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
)

func TestBuildProcessSpecPassesAuthoritativeSystemFlowCatalog(t *testing.T) {
	target := flowruntime.Target{TenantID: "repository:5", PrincipalID: "user:9", BindingKind: "agent-session", BindingID: "session-1"}
	authority := Authority{Target: target, RepositoryID: 5, UserID: 9, WorkspaceID: "workspace-1", CatalogKey: CatalogCoding, SourceRevision: strings.Repeat("b", 40)}
	catalog := Catalog{Key: CatalogCoding, Family: CatalogCoding, Executable: "/opt/smithers/coding-host", ArtifactDigest: strings.Repeat("a", 64), ServiceName: "smithers-flow-coding",
		SystemFlows: []string{"merge", "flow-load", "stack.propose", "repository/setup"},
		Environment: map[string]string{"SMITHERS_SYSTEM_FLOWS": `["attacker"]`}}
	binding := Binding{ID: "11111111-1111-4111-8111-111111111111", TenantID: target.TenantID, PrincipalID: target.PrincipalID, BindingKind: target.BindingKind, BindingID: target.BindingID,
		RepositoryID: 5, UserID: 9, WorkspaceID: "workspace-1", CatalogKey: CatalogCoding, ServiceName: catalog.ServiceName, RuntimeArtifactDigest: catalog.ArtifactDigest, SourceRevision: authority.SourceRevision, OwnerGeneration: 7, State: "starting"}
	launch := HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "bearer"}
	paths := WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}
	spec, err := BuildProcessSpec(launch, paths, 4317)
	require.NoError(t, err)
	var names []string
	require.NoError(t, json.Unmarshal([]byte(spec.Environment["SMITHERS_SYSTEM_FLOWS"]), &names))
	require.Equal(t, catalog.SystemFlows, names)
	launch.Environment = map[string]string{"SMITHERS_SYSTEM_FLOWS": `[]`}
	_, err = BuildProcessSpec(launch, paths, 4317)
	require.Error(t, err, "per-start environment cannot replace the system catalog")
	launch.Environment = nil
	launch.Catalog.SystemFlows = []string{}
	empty, err := BuildProcessSpec(launch, paths, 4317)
	require.NoError(t, err)
	require.Equal(t, "[]", empty.Environment["SMITHERS_SYSTEM_FLOWS"], "an empty catalog does not inherit untrusted environment names")
}

func TestBuildProcessSpecUsesSameImmutableIdentityForWorkspaceAdapters(t *testing.T) {
	target := flowruntime.Target{TenantID: "repository:5", PrincipalID: "user:9", BindingKind: "agent-session", BindingID: "session-1"}
	authority := Authority{Target: target, RepositoryID: 5, UserID: 9, WorkspaceID: "workspace-1", CatalogKey: CatalogCoding, SourceRevision: strings.Repeat("b", 40)}
	catalog := Catalog{Key: CatalogCoding, Family: CatalogCoding, SystemFlows: []string{"merge"}, Executable: "/opt/smithers/coding-host",
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
	assert.NotContains(t, spec.Environment, "SMITHERS_CODING_REVIEW_MODEL", "unpinned, the host chooses the review seat")
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

	// The operator's review seat reaches the host as the coding host reads
	// it, and a pinned host is a different host.
	pinned := catalog
	pinned.ReviewModel = " cerebras:gpt-oss-120b "
	pinned, err = validateCatalog(pinned)
	require.NoError(t, err)
	reviewed, err := BuildProcessSpec(HostLaunch{Binding: binding, Authority: authority, Catalog: pinned, Credential: "bearer"}, WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4317)
	require.NoError(t, err)
	assert.Equal(t, "cerebras:gpt-oss-120b", reviewed.Environment["SMITHERS_CODING_REVIEW_MODEL"])
	assert.NotEqual(t, spec.Identity, reviewed.Identity)
	pinned.ReviewModel = "sol"
	_, err = validateCatalog(pinned)
	require.ErrorContains(t, err, "review model must be provider:model")
	_, err = validateCatalog(Catalog{Key: CatalogCoding, Family: CatalogCoding, Executable: "/host", SystemFlows: []string{"merge"},
		ArtifactDigest: strings.Repeat("a", 64), ServiceName: "host", Environment: map[string]string{"SMITHERS_CODING_REVIEW_MODEL": "openai:gpt-5"}})
	require.ErrorContains(t, err, "reserved identity SMITHERS_CODING_REVIEW_MODEL", "only the operator's pin names the review seat")

	// A start's landing credential reaches the host but not its identity, so
	// an inspection without it still matches the live host (#2198).
	landing := HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "bearer",
		Environment: map[string]string{"SMITHERS_JJHUB_TOKEN": "landing", "SMITHERS_JJHUB_API_URL": "https://api.example/api",
			"SMITHERS_CACHE_TOKEN": "cache-read", "SMITHERS_CACHE_URL": "https://api.example/api/repos/o/r/build-cache"}}
	withLanding, err := BuildProcessSpec(landing, WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4317)
	require.NoError(t, err)
	assert.Equal(t, "landing", withLanding.Environment["SMITHERS_JJHUB_TOKEN"])
	assert.Equal(t, "https://api.example/api", withLanding.Environment["SMITHERS_JJHUB_API_URL"])
	assert.Equal(t, "cache-read", withLanding.Environment["SMITHERS_CACHE_TOKEN"])
	assert.Equal(t, "https://api.example/api/repos/o/r/build-cache", withLanding.Environment["SMITHERS_CACHE_URL"])
	assert.Equal(t, spec.Identity, withLanding.Identity)
	for _, name := range []string{"SMITHERS_API_KEY", "PATH", "HOME", "LD_PRELOAD", "NODE_OPTIONS", "BASH_ENV", "JJ_CONFIG", "SMITHERS_ANYTHING", "BAD-NAME"} {
		landing.Environment = map[string]string{name: "stolen"}
		_, err = BuildProcessSpec(landing, WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4317)
		require.Error(t, err, name)
	}
	landing.Environment = map[string]string{"NPM_TOKEN": "placeholder"}
	withVariable, err := BuildProcessSpec(landing, WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4317)
	require.NoError(t, err)
	assert.Equal(t, "placeholder", withVariable.Environment["NPM_TOKEN"])
	catalog.Environment = map[string]string{"NPM_TOKEN": "catalog"}
	landing.Catalog = catalog
	_, err = BuildProcessSpec(landing, WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4317)
	require.Error(t, err, "a start never overrides the catalog")
	for _, name := range []string{"SMITHERS_JJHUB_TOKEN", "SMITHERS_JJHUB_API_URL", "SMITHERS_CACHE_TOKEN", "SMITHERS_CACHE_URL"} {
		catalog.Environment = map[string]string{name: "static"}
		_, err = validateCatalog(catalog)
		require.Error(t, err, "a catalog never carries a start credential: %s", name)
		assert.False(t, RepositoryVariable(name), name)
	}
}

func TestBuildProcessSpecGivesModelSeatsADerivedCredential(t *testing.T) {
	target := flowruntime.Target{TenantID: "repository:5", PrincipalID: "user:9", BindingKind: "agent-session", BindingID: "session-1"}
	authority := Authority{Target: target, RepositoryID: 5, UserID: 9, WorkspaceID: "workspace-1", CatalogKey: CatalogCoding, SourceRevision: strings.Repeat("b", 40)}
	seat, _ := modelproxy.SeatFor(modelproxy.ProviderVercel)
	catalog := Catalog{Key: CatalogCoding, Family: CatalogCoding, SystemFlows: []string{"merge"}, Executable: "/opt/smithers/coding-host",
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
	assert.Equal(t, "chatgpt,anthropic", spec.Environment[AccountPoolProvidersEnv], "Codex sign-ins and Anthropic API keys; a Claude subscription is never pooled (#2777)")
	assert.Equal(t, credential, spec.Environment[AccountPoolKeyEnv])
	assert.NotContains(t, spec.Identity, credential)
	// Pool-only managed hosts discover a model at startup, including accounts
	// connected after the workspace booted (#1985).
	catalog.ModelProxyURL, catalog.ModelSeats = "", nil
	spec, err = BuildProcessSpec(HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "control-credential"},
		WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4317)
	require.NoError(t, err)
	assert.NotContains(t, spec.Environment, "SMITHERS_CODING_IMPLEMENT_MODEL")
	assert.NotContains(t, spec.Environment, "AI_GATEWAY_API_KEY")
	assert.Equal(t, catalog.AccountPoolURL, spec.Environment[AccountPoolURLEnv])
	assert.Equal(t, "chatgpt,anthropic", spec.Environment[AccountPoolProvidersEnv])
	assert.Equal(t, credential, spec.Environment[AccountPoolKeyEnv])
	// A seat the repository keys itself keeps that key, as in a workspace:
	// the pool is offered only the other routes, and none when both are keyed.
	for _, keyed := range []struct {
		environment map[string]string
		routes      string
	}{
		{map[string]string{"ANTHROPIC_API_KEY": "repository-key"}, "chatgpt"},
		{map[string]string{"OPENAI_API_KEY": "repository-key"}, "anthropic"},
		{map[string]string{"ANTHROPIC_API_KEY": "", "OPENAI_API_KEY": ""}, "chatgpt,anthropic"},
		{map[string]string{"ANTHROPIC_API_KEY": "repository-key", "OPENAI_API_KEY": "repository-key"}, ""},
	} {
		spec, err = BuildProcessSpec(HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "control-credential", Environment: keyed.environment},
			WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4317)
		require.NoError(t, err)
		if keyed.routes == "" {
			for _, name := range []string{AccountPoolURLEnv, AccountPoolProvidersEnv, AccountPoolKeyEnv} {
				assert.NotContains(t, spec.Environment, name, "a host with no pooled seat is not offered the pool")
			}
			continue
		}
		assert.Equal(t, keyed.routes, spec.Environment[AccountPoolProvidersEnv], keyed.environment)
		assert.Equal(t, credential, spec.Environment[AccountPoolKeyEnv])
	}
	// A platform seat's key replaces the repository's, so the pool, which
	// replaces platform credentials, is still offered that route.
	anthropic, ok := modelproxy.SeatFor(modelproxy.ProviderAnthropic)
	require.True(t, ok)
	platform := catalog
	platform.ModelProxyURL, platform.ModelSeats = "https://backend.internal/model-proxy", []modelproxy.Seat{anthropic}
	spec, err = BuildProcessSpec(HostLaunch{Binding: binding, Authority: authority, Catalog: platform, Credential: "control-credential",
		Environment: map[string]string{"ANTHROPIC_API_KEY": "repository-key"}},
		WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4317)
	require.NoError(t, err)
	assert.Equal(t, "chatgpt,anthropic", spec.Environment[AccountPoolProvidersEnv])
	assert.Equal(t, credential, spec.Environment["ANTHROPIC_API_KEY"])
	catalog.ImplementationModel = "openai:gpt-6-sol"
	spec, err = BuildProcessSpec(HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "control-credential"},
		WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4317)
	require.NoError(t, err)
	assert.Equal(t, catalog.ImplementationModel, spec.Environment["SMITHERS_CODING_IMPLEMENT_MODEL"])
	catalog.AccountPoolURL = "file:///etc/passwd"
	_, err = validateCatalog(catalog)
	require.Error(t, err)
}

// A repository command can read its host's environment; a database URL there
// hands the backend credential to the repository (#2175).
func TestCatalogRefusesDatabaseCredentials(t *testing.T) {
	for _, name := range []string{"SMITHERS_POSTGRES_URL", "SMITHERS_POSTGRES_SCHEMA", "DATABASE_URL", "SMITHERS_DATABASE_URL", "SMITHERS_BACKEND"} {
		catalog := Catalog{Key: CatalogCoding, Family: CatalogCoding, SystemFlows: []string{"merge"}, Executable: "/opt/smithers/coding-host",
			ArtifactDigest: strings.Repeat("a", 64), ServiceName: "smithers-flow-coding",
			Environment: map[string]string{name: "postgres://user:secret@db/smithers"}}
		_, err := validateCatalog(catalog)
		require.ErrorContains(t, err, "database configuration "+name)
		assert.NotContains(t, err.Error(), "secret")
	}
}

// A host keeps its journals in its workspace's own database only through
// HostLaunch.Journal (#2099): never from a catalog or a start's environment,
// never another workspace's database, and never the backend's own database.
func TestBuildProcessSpecGivesTheHostOnlyItsWorkspaceJournal(t *testing.T) {
	workspace := "0f1e2d3c-4b5a-4968-8776-655443322110"
	target := flowruntime.Target{TenantID: "repository:5", PrincipalID: "user:9", BindingKind: "agent-session", BindingID: "session-1"}
	authority := Authority{Target: target, RepositoryID: 5, UserID: 9, WorkspaceID: workspace, CatalogKey: CatalogCoding, SourceRevision: strings.Repeat("b", 40)}
	catalog := Catalog{Key: CatalogCoding, Family: CatalogCoding, SystemFlows: []string{"merge"}, Executable: "/opt/smithers/coding-host",
		ArtifactDigest: strings.Repeat("a", 64), ServiceName: "smithers-flow-coding"}
	binding := Binding{ID: "11111111-1111-4111-8111-111111111111", TenantID: target.TenantID,
		PrincipalID: target.PrincipalID, BindingKind: target.BindingKind, BindingID: target.BindingID,
		RepositoryID: 5, UserID: 9, WorkspaceID: workspace, CatalogKey: CatalogCoding,
		ServiceName: catalog.ServiceName, RuntimeArtifactDigest: catalog.ArtifactDigest,
		SourceRevision: authority.SourceRevision, OwnerGeneration: 7, State: "starting"}
	paths := WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}
	sqlite, err := BuildProcessSpec(HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "bearer"}, paths, 4317)
	require.NoError(t, err)
	assert.NotContains(t, sqlite.Environment, "SMITHERS_POSTGRES_URL")
	// A SQLite host's identity is unchanged by the journal field, so enabling
	// the code path alone never restarts a live host.
	before, _ := json.Marshal(struct {
		BindingID, WorkspaceID, Artifact, Revision string
		Generation                                 int64
		Catalog                                    Catalog
		Repository                                 string
	}{binding.ID, workspace, binding.RuntimeArtifactDigest, binding.SourceRevision, 7, catalog, authority.Repository})
	digest := sha256.Sum256(before)
	assert.Equal(t, "flow-host:"+hex.EncodeToString(digest[:]), sqlite.Identity)

	journals := &PostgresJournals{address: mustURL(t, "postgres://journal.internal:5432/?sslmode=disable"), key: journalTestKey}
	journal, err := journals.Describe(workspace)
	require.NoError(t, err)
	launch := HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "bearer", Journal: journal}
	spec, err := BuildProcessSpec(launch, paths, 4317)
	require.NoError(t, err)
	assert.Equal(t, journal.URL, spec.Environment["SMITHERS_POSTGRES_URL"])
	assert.Equal(t, "flows", spec.Environment["SMITHERS_POSTGRES_SCHEMA"])
	assert.NotContains(t, spec.Environment, "SMITHERS_BACKEND")
	assert.Contains(t, spec.Args, "--state-dir", "artifacts and native state stay in the state directory")
	assert.NotEqual(t, sqlite.Identity, spec.Identity, "moving the journal restarts the host")
	password, _ := mustURL(t, journal.URL).User.Password()
	assert.NotContains(t, spec.Identity, password)
	rotated, err := (&PostgresJournals{address: journals.address, key: []byte(strings.Repeat("r", 32))}).Describe(workspace)
	require.NoError(t, err)
	launch.Journal = rotated
	withRotated, err := BuildProcessSpec(launch, paths, 4317)
	require.NoError(t, err)
	assert.Equal(t, spec.Identity, withRotated.Identity, "the credential is not identity")

	other, err := journals.Describe("1f1e2d3c-4b5a-4968-8776-655443322110")
	require.NoError(t, err)
	backendDatabase := journal
	backendDatabase.URL = strings.Replace(journal.URL, "/"+journal.Name, "/smithers", 1)
	otherRole := journal
	otherRole.URL = strings.Replace(journal.URL, journal.Name+":", other.Name+":", 1)
	noPassword := journal
	noPassword.URL = "postgres://" + journal.Name + "@journal.internal:5432/" + journal.Name
	schemaSelected := journal
	schemaSelected.URL = journal.URL + "&schema=public"
	userSelected := journal
	userSelected.URL = journal.URL + "&user=postgres"
	wrongSchema := journal
	wrongSchema.Schema = "public"
	wrongScheme := journal
	wrongScheme.URL = strings.Replace(journal.URL, "postgres://", "http://", 1)
	for name, invalid := range map[string]JournalDatabase{
		"another workspace": other, "the backend database": backendDatabase, "another role": otherRole,
		"no credential": noPassword, "a selected schema": schemaSelected, "a selected user": userSelected, "another schema": wrongSchema,
		"not postgres": wrongScheme, "unparseable": {Name: journal.Name, Schema: JournalSchema, URL: "postgres://%zz"},
	} {
		launch.Journal = invalid
		_, err = BuildProcessSpec(launch, paths, 4317)
		require.Error(t, err, name)
		assert.NotContains(t, err.Error(), password, name)
	}

	launch.Journal = JournalDatabase{}
	for _, name := range []string{"SMITHERS_POSTGRES_URL", "SMITHERS_POSTGRES_SCHEMA", "DATABASE_URL", "SMITHERS_BACKEND"} {
		launch.Environment = map[string]string{name: journal.URL}
		_, err = BuildProcessSpec(launch, paths, 4317)
		require.Error(t, err, "a start's environment never selects the journal: %s", name)
	}
}

// A repository command can read its host's environment; a raw provider key
// there hands the operator's key to the repository (#2187). Seats reach the
// host only as the per-binding credential BuildProcessSpec derives.
func TestCatalogRefusesProviderCredentials(t *testing.T) {
	for _, name := range []string{"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AI_GATEWAY_API_KEY", "CEREBRAS_API_KEY",
		"OPENROUTER_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_CODEX_ACCESS_TOKEN", "HF_API_TOKEN"} {
		catalog := Catalog{Key: CatalogCoding, Family: CatalogCoding, SystemFlows: []string{"merge"}, Executable: "/opt/smithers/coding-host",
			ArtifactDigest: strings.Repeat("a", 64), ServiceName: "smithers-flow-coding",
			Environment: map[string]string{name: "sk-operator-secret"}}
		_, err := validateCatalog(catalog)
		require.ErrorContains(t, err, "provider credential "+name)
		assert.NotContains(t, err.Error(), "sk-operator-secret")
	}
}
