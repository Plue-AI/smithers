package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type configSnapshotSource struct {
	config string
	reads  int
}

func (s *configSnapshotSource) ResolveSourceRevision(context.Context, string, string) (string, error) {
	return strings.Repeat("a", 40), nil
}
func (s *configSnapshotSource) ReadSourceFile(_ context.Context, source workspaceapi.WorkspaceSource, name string) ([]byte, error) {
	s.reads++
	if source.Revision != strings.Repeat("a", 40) || name != ".smithers/coding-project.json" {
		panic("snapshot must read only pinned main config")
	}
	if s.config == "" {
		return nil, fs.ErrNotExist
	}
	return []byte(s.config), nil
}
func TestInstallCodingProjectPinsRestartAndNextBindingPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	owner, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "config-owner", LowerUsername: "config-owner"})
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO repositories(user_id,name,lower_name,default_bookmark) VALUES($1,'app','app','main') RETURNING id`, owner.ID).Scan(&repo))
	require.NoError(t, q.UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: services.InstallCodingProjectKey, Value: []byte(`{"checks":[{"id":"test"}],"seats":{"coding/implement":"auto","coding/review":"auto"},"wiki":true}`)}))
	sources := &configSnapshotSource{}
	load := installCodingProject(pool, sources)
	launch := flowhost.HostLaunch{Binding: flowhost.Binding{ID: "first", RepositoryID: repo, OwnerGeneration: 1}}
	first, err := load(t.Context(), launch)
	require.NoError(t, err)
	require.JSONEq(t, `{"checks":[{"id":"test"}],"seats":{"coding/implement":"auto","coding/review":"auto"},"wiki":true}`, string(first))
	launch.Binding.OwnerGeneration = 2
	sources.config = `{"checks":[{"id":"lint"}],"seats":{"coding/review":"openai:gpt-6"}}`
	restarted, err := load(t.Context(), launch)
	require.NoError(t, err)
	require.Equal(t, first, restarted)
	require.Equal(t, 1, sources.reads)
	launch.Binding.ID = "second"
	second, err := load(t.Context(), launch)
	require.NoError(t, err)
	require.JSONEq(t, `{"checks":[{"id":"lint"}],"seats":{"coding/implement":"auto","coding/review":"openai:gpt-6"},"wiki":true}`, string(second))
	sources.config = "{invalid"
	launch.Binding.ID = "third"
	_, err = load(t.Context(), launch)
	require.ErrorContains(t, err, ".smithers/coding-project.json")
	var count int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM install_settings WHERE key='coding.snapshot:third'`).Scan(&count))
	require.Zero(t, count)

	_, err = q.RequestMythicalBootstrap(t.Context(), repo, owner.ID, 100, false)
	require.NoError(t, err)
	var todoID string
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO mythical_items(repository_id,issue_number,issue_title,state,attempt) VALUES($1,1,'Config attempt','queued',1) RETURNING id::text`, repo).Scan(&todoID))
	launch.Authority.Target = flowruntime.Target{BindingKind: flowdispatch.StackBindingKind, BindingID: todoID}
	sources.config = `{"wiki":false}`
	attemptOne, err := load(t.Context(), launch)
	require.NoError(t, err)
	sources.config = `{"wiki":true}`
	launch.Binding.OwnerGeneration++
	sameAttempt, err := load(t.Context(), launch)
	require.NoError(t, err)
	require.Equal(t, attemptOne, sameAttempt)
	_, err = pool.Exec(t.Context(), `UPDATE mythical_items SET attempt=2 WHERE id=$1`, todoID)
	require.NoError(t, err)
	attemptTwo, err := load(t.Context(), launch)
	require.NoError(t, err)
	require.NotEqual(t, attemptOne, attemptTwo)
	require.Contains(t, string(attemptTwo), `"wiki": true`)
}

// §11.5a beside §11.2: a running attempt keeps its admitted checks and pages,
// while the owner's agent:<role> choice applies to that attempt's next model
// call through the production owner command and factory-seat door.
func TestInstallCodingSnapshotFixedWhileOwnerRoleModelChangesPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "snapshot-owner", LowerUsername: "snapshot-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark) VALUES($1,'app','app','main') RETURNING id`, owner.ID).Scan(&repo))
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo, owner.ID)
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"snapshot-owner","repository_name":"app","repository_id":%d}`, repo)
	stored := `{"checks":[{"id":"test","target":".","flow":"checks/test","tier":"slow","required":true}],"detected":[{"flow":"checks/test","argv":["go","test","./..."],"timeoutMs":1800000}],"pages":[{"id":"overview"},{"id":"architecture"}],"seats":{"coding/review":"auto"},"wiki":true}`
	for key, value := range map[string]string{
		"github.repository":              binding,
		"owner.access":                   binding[:len(binding)-1] + `,"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339) + `"}`,
		"agent:reviewer":                 `{"protocol":"anthropic-messages","modelId":"model-a","credential":"ANTHROPIC_API_KEY"}`,
		services.InstallCodingProjectKey: stored,
	} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	session := "snapshot-session"
	hash := sha256.Sum256([]byte(session))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner.ID, 100, false)
	require.NoError(t, err)
	var item, workspace string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,issue_number,issue_title,state,attempt) VALUES($1,1,'Running attempt','running',1) RETURNING id::text`, repo).Scan(&item))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id) VALUES($1,$2) RETURNING id::text`, repo, owner.ID).Scan(&workspace))
	host, control := uuid.NewString(), "snapshot-control"
	controlHash := sha256.Sum256([]byte(control))
	_, err = pool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings(id,tenant_id,principal_id,binding_kind,binding_id,repository_id,user_id,workspace_id,catalog_key,service_name,runtime_artifact_digest,source_revision,owner_generation,credential_ciphertext,credential_hash,state)
 VALUES($1,'repository:1','user:1','mythical-item',$2,$3,$4,$5,'coding','coding',$6,$7,1,$8,$9,'running')`, host, item, repo, owner.ID, workspace, strings.Repeat("a", 64), strings.Repeat("b", 40), control, controlHash[:])
	require.NoError(t, err)

	sources := &configSnapshotSource{}
	load := installCodingProject(pool, sources)
	launch := flowhost.HostLaunch{Binding: flowhost.Binding{ID: host, RepositoryID: repo, WorkspaceID: workspace, OwnerGeneration: 1},
		Authority: flowhost.Authority{Target: flowruntime.Target{BindingKind: flowdispatch.StackBindingKind, BindingID: item}}}
	admitted, err := load(ctx, launch)
	require.NoError(t, err)
	require.JSONEq(t, stored, string(admitted))

	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{Setup: &services.InstallSetupService{Pool: pool}, Owners: q, Roster: q, Origins: middleware.FixedOrigins("http://example.com")})
	mountModelPublic(router.(chi.Router), modelhost.OwnerModels{Pool: pool}, q, cfg)
	mountModelProxy(router.(chi.Router), q, cfg, &modelproxy.Handler{OwnerPaid: true, Keys: modelproxy.StaticKeys{modelproxy.ProviderAnthropic: "fixture"},
		Callers: services.NewModelProxyCallers(q, pool, webhook.NoopSecretCodec{}), ResolveFactorySeat: resolveFactorySeat(q, nil)})
	reviewer := flowhost.RoleModelCredential(host, control, "reviewer")
	seat := func() string {
		req := httptest.NewRequest("GET", modelproxy.Path+"/factory-seat", nil)
		req.Header.Set("Authorization", "Bearer "+reviewer)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		require.Equal(t, 200, res.Code, res.Body.String())
		var selected modelproxy.FactorySeat
		require.NoError(t, json.Unmarshal(res.Body.Bytes(), &selected))
		return selected.Seat
	}
	require.Equal(t, "anthropic:model-a", seat())

	// The owner picks another reviewer model and main gains a repository
	// declaration while attempt 1 runs.
	req := httptest.NewRequest("PUT", "http://example.com/api/agents/reviewer/model", strings.NewReader(`{"model":{"protocol":"anthropic-messages","modelId":"model-b","credential":"ANTHROPIC_API_KEY"}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://example.com")
	req.AddCookie(&http.Cookie{Name: "session", Value: session})
	req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "snapshot-csrf"})
	req.Header.Set("X-CSRF-Token", "snapshot-csrf")
	assigned := httptest.NewRecorder()
	router.ServeHTTP(assigned, req)
	require.Equal(t, 200, assigned.Code, assigned.Body.String())
	sources.config = `{"checks":[{"id":"lint","target":".","flow":"checks/lint","tier":"fast","required":true}]}`

	require.Equal(t, "anthropic:model-b", seat(), "the running attempt's next call uses the owner's new model")
	restarted, err := load(ctx, launch)
	require.NoError(t, err)
	require.Equal(t, admitted, restarted, "the running attempt keeps its admitted checks and pages")
	require.Equal(t, 1, sources.reads)
	var digest string
	require.NoError(t, pool.QueryRow(ctx, `SELECT runtime_artifact_digest FROM flow_runtime_host_bindings WHERE id=$1`, host).Scan(&digest))
	require.Equal(t, strings.Repeat("a", 64), digest, "a model change replaces no host")

	_, err = pool.Exec(ctx, `UPDATE mythical_items SET attempt=2 WHERE id=$1`, item)
	require.NoError(t, err)
	next, err := load(ctx, launch)
	require.NoError(t, err)
	require.JSONEq(t, `{"checks":[{"id":"lint","target":".","flow":"checks/lint","tier":"fast","required":true}],"pages":[{"id":"overview"},{"id":"architecture"}],"seats":{"coding/review":"auto"},"wiki":true}`, string(next),
		"the next attempt reads main's checks; stored command bodies no longer apply")
	require.Equal(t, "anthropic:model-b", seat())
}

func TestBrowserFlowReadsPinnedTodoConfigurationPostgres(t *testing.T) {
	b := newRelayBoxes(t)
	ctx := t.Context()
	box := b.box(b.repo, b.machines, "running", b.owner)
	_, err := b.RequestMythicalBootstrap(ctx, b.repo.ID, b.owner, 100, false)
	require.NoError(t, err)
	var itemID string
	source, digest := strings.Repeat("a", 40), strings.Repeat("b", 64)
	require.NoError(t, b.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,issue_number,issue_title,state,attempt,workspace_id,flow_digest,checks) VALUES($1,1,'Pinned read','queued',1,$2,$3,jsonb_build_object('flowSource',$4::text)) RETURNING id::text`, b.repo.ID, box, digest, source).Scan(&itemID))
	b.exec(`INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'attempt-one')`, box, b.repo.ID, itemID)
	target := b.target(b.repo, b.owner, box)
	authority, err := (browserFlowTarget{queries: b}).ResolveFlowHostTarget(ctx, target)
	require.NoError(t, err)
	require.Equal(t, &flowruntime.Pin{Flow: "todo", SourceCommit: source, ExecutionDigest: digest}, authority.ExecutionPin)
	require.Equal(t, source, authority.SourceRevision)
	require.Equal(t, target, authority.Target, "browser identity must not become a stack launch")
	require.NoError(t, b.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: services.InstallCodingProjectKey, Value: []byte(`{"checks":[],"seats":{"coding/implement":"auto","coding/review":"auto"},"wiki":true}`)}))
	sources := &configSnapshotSource{config: `{"wiki":false}`}
	load := installCodingProject(b.pool, sources)
	launch := flowhost.HostLaunch{Binding: flowhost.Binding{ID: "pinned-read", RepositoryID: b.repo.ID, WorkspaceID: box}, Authority: authority}
	_, err = load(ctx, launch)
	require.ErrorContains(t, err, "configuration snapshot is unavailable", "a browser read cannot pin current settings for an existing run")
	require.Zero(t, sources.reads)
	stackLaunch := launch
	stackLaunch.Authority.Target = flowruntime.Target{BindingKind: flowdispatch.StackBindingKind, BindingID: itemID}
	first, err := load(ctx, stackLaunch)
	require.NoError(t, err)
	sources.config = `{"wiki":true}`
	current, err := load(ctx, launch)
	require.NoError(t, err)
	require.Equal(t, first, current, "read must reuse the launch snapshot after configuration changes")
	require.Equal(t, 1, sources.reads)
	var count int
	require.NoError(t, b.pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='coding.snapshot:pinned-read'`).Scan(&count))
	require.Zero(t, count, "no parallel browser snapshot")
	for _, change := range []func(*flowhost.Authority){
		func(a *flowhost.Authority) { a.ExecutionPin = nil },
		func(a *flowhost.Authority) {
			pin := *a.ExecutionPin
			pin.ExecutionDigest = strings.Repeat("c", 64)
			a.ExecutionPin = &pin
		},
		func(a *flowhost.Authority) { a.SourceRevision = strings.Repeat("c", 40) },
	} {
		launch.Authority = authority
		change(&launch.Authority)
		_, err = load(ctx, launch)
		require.ErrorContains(t, err, "execution changed")
	}
	launch.Authority = authority
	b.exec(`UPDATE mythical_items SET workspace_id='replacement' WHERE id=$1`, itemID)
	_, err = (browserFlowTarget{queries: b}).ResolveFlowHostTarget(ctx, target)
	require.Error(t, err, "an old lane cannot inherit the next attempt pin")
	_, err = load(ctx, launch)
	require.Error(t, err)
	require.Equal(t, 1, sources.reads)
}

func TestCodingHostModelIdentitySurvivesOwnerSwitchPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	pin := pinCodingHostModel(db.New(pool))
	launch := flowhost.HostLaunch{Binding: flowhost.Binding{ID: "host-one"}}
	first, err := pin(t.Context(), launch, "openai:model-a")
	require.NoError(t, err)
	next, err := pin(t.Context(), launch, "anthropic:model-b")
	require.NoError(t, err)
	require.Equal(t, "openai:model-a", first)
	require.Equal(t, first, next)
	launch.Binding.ID = "host-two"
	fresh, err := pin(t.Context(), launch, "anthropic:model-b")
	require.NoError(t, err)
	require.Equal(t, "anthropic:model-b", fresh)
}
