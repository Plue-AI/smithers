package services

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Literal fixtures: the GitHub account that owns the repository (the fake's
// owner login and the owner's username), the GitHub slug the owner chose, the
// local name the importer published and main's resolved commit.
const (
	setupGitHubOwner = "acme"
	setupGitHubSlug  = "acme/app"
	setupLocalName   = "app-mirror"
	setupMainCommit  = "89abcdef0123456789abcdef0123456789abcdef"
)

type setupFixture struct {
	pool  *pgxpool.Pool
	store *jobs.Store
	svc   *InstallSetupService
	owner db.User
	repo  int64
	// skew moves the service clock past a step's expires_at; the job store's
	// leases keep PostgreSQL time.
	skew atomic.Int64
}

// newSetupFixture seeds an owner, the chosen repository, its published mirror
// and every step before stepID as done, as the earlier steps leave them.
func newSetupFixture(t *testing.T, stepID string) *setupFixture {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: setupGitHubOwner, LowerUsername: setupGitHubOwner})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark) VALUES ($1,$2,$2,'main') RETURNING id`, owner.ID, setupLocalName).Scan(&repo))
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	f := &setupFixture{pool: pool, store: store, owner: owner, repo: repo}
	f.svc = &InstallSetupService{Pool: pool, Jobs: store, Now: func() time.Time { return time.Now().Add(time.Duration(f.skew.Load())) }}
	require.NoError(t, f.svc.Initialize(ctx))
	slug, _ := json.Marshal(setupGitHubSlug)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "repository", Value: slug}))
	for _, id := range InstallStepIDs[:installStepIndex(stepID)] {
		_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{status}','"done"') WHERE key=$1`, "setup.step."+id)
		require.NoError(t, err)
	}
	return f
}

func (f *setupFixture) run(t *testing.T, operation string) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		done <- f.store.RunWorker(ctx, jobs.WorkerConfig{WorkerID: "setup-" + operation, Capacity: 1, Lease: 5 * time.Second, PollInterval: 10 * time.Millisecond,
			Operations: []string{"install.setup." + operation}}, f.svc.Handle)
	}()
	t.Cleanup(func() {
		cancel()
		require.NoError(t, <-done)
	})
}

func (f *setupFixture) step(t *testing.T, id string) InstallStep {
	t.Helper()
	step, err := f.svc.readStep(t.Context(), db.New(f.pool), id)
	require.NoError(t, err)
	return step
}

func (f *setupFixture) awaitStep(t *testing.T, id string, status InstallStepState) InstallStep {
	t.Helper()
	var step InstallStep
	require.Eventually(t, func() bool {
		step = f.step(t, id)
		return step.Status == status
	}, 15*time.Second, 20*time.Millisecond, "step %s never reached %s", id, status)
	return step
}

func (f *setupFixture) stacks(t *testing.T) []db.MythicalStack {
	t.Helper()
	stack, err := db.New(f.pool).GetMythicalStack(t.Context(), f.repo)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	require.NoError(t, err)
	return []db.MythicalStack{stack}
}

func (f *setupFixture) setting(t *testing.T, key string) map[string]any {
	t.Helper()
	row, err := db.New(f.pool).GetInstallSetting(t.Context(), key)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	require.NoError(t, err)
	var value map[string]any
	if json.Unmarshal(row.Value, &value) != nil {
		value = map[string]any{"value": string(row.Value)}
	}
	return value
}

// newSourceFixture binds the source step to the real owner verifier (Members
// against the GitHub fake, which installs the App on repositories) and the
// real stack service. The importer is the fake below: the durable importer
// needs the repository host's native engine, which the composed J1 rehearsal
// exercises end to end.
func newSourceFixture(t *testing.T, imports *sourceImports, repositories ...githubfake.Repository) *setupFixture {
	t.Helper()
	f := newSetupFixture(t, "source")
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	credentials := GitHubAppCredentials{ID: 42, Slug: "smithers-setup", OwnerLogin: setupGitHubOwner, OwnerKind: "user", ClientID: "Iv1.setup", ClientSecret: "client-secret", WebhookSecret: "webhook-secret", PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))}
	fake, err := githubfake.New(githubfake.Config{AppID: credentials.ID, Slug: credentials.Slug, OwnerLogin: credentials.OwnerLogin, OwnerKind: credentials.OwnerKind, PrivateKeyPEM: credentials.PEM, ClientID: credentials.ClientID, ClientSecret: credentials.ClientSecret, ConversionCode: "manifest-code", Installations: []githubfake.Installation{{ID: 91, Repositories: repositories}}})
	require.NoError(t, err)
	t.Cleanup(fake.Close)
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", fake.URL)
	codec, err := webhook.NewSecretCodec("install-key")
	require.NoError(t, err)
	app := NewGitHubAppCredentialStore(f.pool, codec)
	require.NoError(t, app.Save(t.Context(), credentials))
	f.svc.BindRepositoryProviders(nil, app, imports, &Members{Pool: f.pool, Credentials: app}, NewMythicalService(f.pool, nil))
	return f
}

// sourceImports is the durable importer's contract: the first lookup reports
// the mirror still cloning, later lookups the published local mirror or the
// configured status.
type sourceImports struct {
	mu      sync.Mutex
	started []ImportGitHubRepoInput
	lookups int
	status  string
}

func (i *sourceImports) StartImport(_ context.Context, input ImportGitHubRepoInput) (ImportJob, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.started = append(i.started, input)
	return ImportJob{ImportJobID: fmt.Sprintf("import-%d", len(i.started))}, nil
}

func (i *sourceImports) GetImportJob(context.Context, int64, string) (ImportJob, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.lookups++
	if i.lookups == 1 {
		return ImportJob{Status: "cloning"}, nil
	}
	if i.status != "" {
		return ImportJob{Status: i.status}, nil
	}
	return ImportJob{Status: "ready", RepoOwner: setupGitHubOwner, RepoName: setupLocalName}, nil
}

func (i *sourceImports) setStatus(status string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.status = status
}

func (i *sourceImports) starts() []ImportGitHubRepoInput {
	i.mu.Lock()
	defer i.mu.Unlock()
	return append([]ImportGitHubRepoInput(nil), i.started...)
}

var installedApp = githubfake.Repository{ID: 100, FullName: setupGitHubSlug}

// Spec §8.6.3: Source ready means the mirror holds main. The step waits out
// the clone, binds the mirror to the verified owner, asks the stack service
// for the repository's stack once, and completes without a machine and
// without waiting for the stack to become active.
func TestInstallSourceReadyRequestsStackWithoutWaitingPostgres(t *testing.T) {
	imports := &sourceImports{}
	f := newSourceFixture(t, imports, installedApp)
	ctx := t.Context()
	_, err := f.svc.Admit(ctx, "source", "source-1", json.RawMessage(`{}`))
	require.NoError(t, err)
	f.run(t, "source")

	step := f.awaitStep(t, "source", InstallReady)
	require.Nil(t, step.Error)
	require.Equal(t, []ImportGitHubRepoInput{{UserID: f.owner.ID, Owner: setupGitHubOwner, Repo: "app", Branch: "main"}}, imports.starts(), "one import per operation, across the clone's deferral")
	stacks := f.stacks(t)
	require.Len(t, stacks, 1, "the stack was requested")
	require.Equal(t, "bootstrapping", stacks[0].State, "Source ready does not wait for the stack worker")
	require.EqualValues(t, 1, stacks[0].RequestedGeneration, "one stack request")
	require.Equal(t, map[string]any{"owner_login": setupGitHubOwner, "repository_name": "app", "repository_id": float64(f.repo)}, f.setting(t, "github.repository"))
	access := f.setting(t, "owner.access")
	require.Equal(t, float64(f.repo), access["repository_id"])
	require.Equal(t, float64(91), access["installation_id"])
	var permission string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT permission FROM collaborators WHERE repository_id=$1 AND user_id=$2`, f.repo, f.owner.ID).Scan(&permission))
	require.Equal(t, "admin", permission)
	require.Equal(t, map[string]any{"value": `"` + setupGitHubOwner + "/" + setupLocalName + `"`}, f.setting(t, "setup.source.repository"), "the importer's local slug is pinned for Machine ready")
	var machines int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM workspaces`).Scan(&machines))
	require.Zero(t, machines, "Source ready provisions no machine")
	operation, err := f.store.Get(ctx, jobs.Scope{TenantID: "install", PrincipalID: "owner"}, step.OperationID)
	require.NoError(t, err)
	require.Equal(t, jobs.StateCompleted, operation.State)
	require.Equal(t, InstallPending, f.step(t, "machine").Status, "Machine ready is its own step")
}

// An owner the GitHub App cannot verify on the repository fails Source after
// the mirror, before the stack is requested or the local slug is pinned.
func TestInstallSourceRefusesUnverifiedOwnerBeforeStackPostgres(t *testing.T) {
	f := newSourceFixture(t, &sourceImports{}, githubfake.Repository{ID: 101, FullName: setupGitHubOwner + "/other"})
	_, err := f.svc.Admit(t.Context(), "source", "source-1", json.RawMessage(`{}`))
	require.NoError(t, err)
	f.run(t, "source")
	step := f.awaitStep(t, "source", InstallFailed)
	require.Equal(t, "install_setup_failed", step.Error.Code)
	require.Empty(t, f.stacks(t))
	require.Nil(t, f.setting(t, "setup.source.repository"))
	require.Nil(t, f.setting(t, "owner.access"))
}

// A failed mirror fails Source without asking for a stack; Retry is a new
// operation that starts a new import and requests the stack once.
func TestInstallSourceImportFailureAndRetryPostgres(t *testing.T) {
	imports := &sourceImports{status: "failed"}
	f := newSourceFixture(t, imports, installedApp)
	ctx := t.Context()
	first, err := f.svc.Admit(ctx, "source", "source-1", json.RawMessage(`{}`))
	require.NoError(t, err)
	f.run(t, "source")
	step := f.awaitStep(t, "source", InstallFailed)
	require.Equal(t, &InstallReadinessError{Code: "source_import_failed", Class: "github", Message: "Repository mirror failed"}, step.Error)
	require.Empty(t, f.stacks(t))

	imports.setStatus("")
	retry, err := f.svc.Admit(ctx, "source", "source-retry", json.RawMessage(`{}`))
	require.NoError(t, err)
	require.NotEqual(t, first.OperationID, retry.OperationID)
	step = f.awaitStep(t, "source", InstallReady)
	require.Equal(t, retry.OperationID, step.OperationID)
	require.Len(t, imports.starts(), 2)
	stacks := f.stacks(t)
	require.Len(t, stacks, 1)
	require.EqualValues(t, 1, stacks[0].RequestedGeneration)
}

type machineSources struct{ err error }

func (s machineSources) ResolveSourceRevision(_ context.Context, repository, revision string) (string, error) {
	if repository != setupGitHubOwner+"/"+setupLocalName || revision != "main" {
		return "", fmt.Errorf("unexpected source %s@%s", repository, revision)
	}
	return setupMainCommit, s.err
}
func (machineSources) ReadSourceFile(context.Context, workspaceapi.WorkspaceSource, string) ([]byte, error) {
	return nil, fs.ErrNotExist
}

// machineImages blocks each build until the test releases it with a result.
type machineImages struct {
	started chan workspaceapi.WorkspaceSpec
	results chan machineImageResult
}
type machineImageResult struct {
	layer microsandbox.Layer
	err   error
}

func (m machineImages) ResolveWorkspaceLayer(ctx context.Context, spec workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
	m.started <- spec
	select {
	case result := <-m.results:
		return result.layer, result.err
	case <-ctx.Done():
		return microsandbox.Layer{}, ctx.Err()
	}
}

func newMachineFixture(t *testing.T, sources machineSources) (*setupFixture, machineImages) {
	t.Helper()
	f := newSetupFixture(t, "machine")
	pinned, _ := json.Marshal(setupGitHubOwner + "/" + setupLocalName)
	require.NoError(t, db.New(f.pool).UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "setup.source.repository", Value: pinned}))
	images := machineImages{started: make(chan workspaceapi.WorkspaceSpec, 4), results: make(chan machineImageResult, 4)}
	f.svc.BindMachineProvider(sources, images)
	return f, images
}

func projectedSteps(t *testing.T, f *setupFixture) map[string]map[string]any {
	t.Helper()
	status, err := f.svc.Status(t.Context())
	require.NoError(t, err)
	raw, err := json.Marshal(status["steps"])
	require.NoError(t, err)
	var steps []map[string]any
	require.NoError(t, json.Unmarshal(raw, &steps))
	byID := map[string]map[string]any{}
	for _, step := range steps {
		byID[step["id"].(string)] = step
	}
	return byID
}

// Spec §8.6.3 and T-INS-06: Machine ready means main's first image is built.
// While it builds, GET shows source done and machine running with its pct; a
// concurrent POST starts nothing; done commits only after the verified layer.
func TestInstallMachineReadyBuildsMainImagePostgres(t *testing.T) {
	f, images := newMachineFixture(t, machineSources{})
	ctx := t.Context()
	receipt, err := f.svc.Admit(ctx, "machine", "machine-1", json.RawMessage(`{}`))
	require.NoError(t, err)
	f.run(t, "machine")
	var spec workspaceapi.WorkspaceSpec
	select {
	case spec = <-images.started:
	case <-time.After(15 * time.Second):
		t.Fatal("the machine image build never started")
	}
	require.Equal(t, &workspaceapi.WorkspaceSource{Repository: setupGitHubOwner + "/" + setupLocalName, Revision: setupMainCommit}, spec.Source)
	steps := projectedSteps(t, f)
	require.Equal(t, map[string]any{"id": "source", "state": "done", "pct": float64(100)}, steps["source"])
	require.Equal(t, map[string]any{"id": "machine", "state": "running", "pct": float64(0)}, steps["machine"])
	_, err = f.svc.Admit(ctx, "machine", "machine-2", json.RawMessage(`{}`))
	var conflict *pkgerrors.APIError
	require.ErrorAs(t, err, &conflict, "a second POST during the build starts nothing")
	require.Equal(t, pkgerrors.CodeConflict, conflict.Code)
	require.Equal(t, receipt.OperationID, f.step(t, "machine").OperationID)

	images.results <- machineImageResult{layer: microsandbox.Layer{Snapshot: "layer-snapshot", Key: "verified-layer-key"}}
	step := f.awaitStep(t, "machine", InstallReady)
	require.Equal(t, setupMainCommit, step.Revision)
	require.Equal(t, "verified-layer-key", step.LayerKey)
	require.Nil(t, step.Error)
	require.Equal(t, map[string]any{"id": "machine", "state": "done", "pct": float64(100)}, projectedSteps(t, f)["machine"])
	operation, err := f.store.Get(ctx, jobs.Scope{TenantID: "install", PrincipalID: "owner"}, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, jobs.StateCompleted, operation.State)
	raw, err := json.Marshal(projectedSteps(t, f))
	require.NoError(t, err)
	require.NotContains(t, string(raw), "verified-layer-key", "receipts stay out of the projection")
}

// A recipe refusal fails Machine with its class and fix, keeps Source done, and
// Retry rebuilds under a new attempt that fences the earlier one.
func TestInstallMachineRecipeFailureAndRetryPostgres(t *testing.T) {
	f, images := newMachineFixture(t, machineSources{})
	ctx := t.Context()
	_, err := f.svc.Admit(ctx, "machine", "machine-1", json.RawMessage(`{}`))
	require.NoError(t, err)
	f.run(t, "machine")
	<-images.started
	images.results <- machineImageResult{err: &microsandbox.RecipeError{Code: "missing_machine_tool", Class: "user", Message: "cargo is not installed", Fix: "rust-toolchain.toml"}}
	step := f.awaitStep(t, "machine", InstallFailed)
	require.Equal(t, &InstallReadinessError{Code: "missing_machine_tool", Class: "user", Message: "cargo is not installed", Fix: "rust-toolchain.toml"}, step.Error)
	require.Equal(t, InstallReady, f.step(t, "source").Status)
	require.Equal(t, map[string]any{"code": "missing_machine_tool", "class": "user", "message": "cargo is not installed", "fix": "rust-toolchain.toml"}, projectedSteps(t, f)["machine"]["error"])
	first := step.ReadinessAttempt

	retry, err := f.svc.Admit(ctx, "machine", "machine-retry", json.RawMessage(`{}`))
	require.NoError(t, err)
	<-images.started
	images.results <- machineImageResult{layer: microsandbox.Layer{Key: "retried-layer"}}
	step = f.awaitStep(t, "machine", InstallReady)
	require.Equal(t, retry.OperationID, step.OperationID)
	require.Equal(t, first+1, step.ReadinessAttempt)
	require.Equal(t, "retried-layer", step.LayerKey)
	require.Nil(t, step.Error)
}

// When main cannot be resolved, Source is no longer ready: both steps fail and
// no image build starts.
func TestInstallMachineWithoutMainFailsSourcePostgres(t *testing.T) {
	f, images := newMachineFixture(t, machineSources{err: errors.New("bookmark \"main\" is not found")})
	ctx := t.Context()
	_, err := f.svc.Admit(ctx, "machine", "machine-1", json.RawMessage(`{}`))
	require.NoError(t, err)
	f.run(t, "machine")
	step := f.awaitStep(t, "machine", InstallFailed)
	require.Equal(t, "source_main_unavailable", step.Error.Code)
	source := f.step(t, "source")
	require.Equal(t, InstallFailed, source.Status)
	require.Equal(t, "source_main_unavailable", source.Error.Code)
	require.Empty(t, images.started)
}

// Only the operation holding the machine step writes readiness; a superseded
// operation's write changes neither step.
func TestInstallReadinessStepsRefuseAnotherOperationPostgres(t *testing.T) {
	f, _ := newMachineFixture(t, machineSources{})
	ctx := t.Context()
	receipt, err := f.svc.Admit(ctx, "machine", "machine-1", json.RawMessage(`{}`))
	require.NoError(t, err)
	before := []InstallStep{f.step(t, "source"), f.step(t, "machine")}
	called := false
	_, err = installReadinessSteps{setup: f.svc, operation: "superseded-operation"}.Update(ctx, "ignored", func(current InstallReadiness) (InstallReadiness, error) {
		called = true
		current.Machine = InstallReadinessStep{State: InstallReady, Pct: 100}
		return current, nil
	})
	require.ErrorIs(t, err, jobs.ErrClaimLost)
	require.False(t, called)
	require.Equal(t, before, []InstallStep{f.step(t, "source"), f.step(t, "machine")})

	next, err := installReadinessSteps{setup: f.svc, operation: receipt.OperationID}.Update(ctx, "ignored", func(current InstallReadiness) (InstallReadiness, error) {
		require.Equal(t, InstallReady, current.Source.State)
		require.Equal(t, InstallRunning, current.Machine.State)
		current.Attempt++
		current.Machine = InstallReadinessStep{State: InstallPending}
		return current, nil
	})
	require.NoError(t, err)
	require.Equal(t, InstallPending, next.Machine.State)
	machine := f.step(t, "machine")
	require.Equal(t, InstallRunning, machine.Status, "the held step never reads as pending")
	require.EqualValues(t, 1, machine.ReadinessAttempt)
}

// Step 6 holds one heartbeated job lease for the whole image build, which
// outlasts the step's one-minute expires_at. While the worker holds it, GET
// shows the step running and a POST starts nothing.
func TestInstallMachineBuildPastExpiryStaysRunningPostgres(t *testing.T) {
	f, images := newMachineFixture(t, machineSources{})
	ctx := t.Context()
	receipt, err := f.svc.Admit(ctx, "machine", "machine-1", json.RawMessage(`{}`))
	require.NoError(t, err)
	f.run(t, "machine")
	<-images.started
	f.skew.Store(int64(2 * time.Minute))
	require.Equal(t, map[string]any{"id": "machine", "state": "running", "pct": float64(0)}, projectedSteps(t, f)["machine"])
	_, err = f.svc.Admit(ctx, "machine", "machine-2", json.RawMessage(`{}`))
	var conflict *pkgerrors.APIError
	require.ErrorAs(t, err, &conflict)
	require.Equal(t, "setup worker lease is active", conflict.Message)
	images.results <- machineImageResult{layer: microsandbox.Layer{Key: "slow-layer"}}
	step := f.awaitStep(t, "machine", InstallReady)
	require.Equal(t, receipt.OperationID, step.OperationID)
	require.Equal(t, "slow-layer", step.LayerKey)
}

// A step whose handler deferred its next pass (the source step while the
// mirror clones) is still worked after expires_at lapses: GET shows it running
// and POST starts nothing. A step no worker ever claimed is recoverable: GET
// shows it pending and POST resumes the same operation under a new attempt.
func TestInstallLapsedStepIsPendingOnlyWithoutWorkPostgres(t *testing.T) {
	f := newSourceFixture(t, &sourceImports{}, installedApp)
	ctx := t.Context()
	receipt, err := f.svc.Admit(ctx, "source", "source-1", json.RawMessage(`{}`))
	require.NoError(t, err)
	f.skew.Store(int64(2 * time.Minute))
	require.Equal(t, map[string]any{"id": "source", "state": "pending"}, projectedSteps(t, f)["source"], "nothing worked the lapsed step")
	recovered, err := f.svc.Admit(ctx, "source", "source-2", json.RawMessage(`{}`))
	require.NoError(t, err)
	require.Equal(t, receipt.OperationID, recovered.OperationID)
	require.Equal(t, 2, f.step(t, "source").Attempt)
	require.Equal(t, "running", projectedSteps(t, f)["source"]["state"])

	claim, err := f.store.ClaimForOperations(ctx, "setup-test", 5*time.Second, []string{"install.setup.source"})
	require.NoError(t, err)
	require.Equal(t, receipt.OperationID, claim.OperationID)
	_, err = f.store.BeginExternal(ctx, claim, json.RawMessage(`{"phase":"setup"}`))
	require.NoError(t, err)
	require.NoError(t, f.store.Park(ctx, claim, json.RawMessage(`{"import_id":"import-1"}`), time.Hour))
	f.skew.Store(int64(4 * time.Minute))
	require.Equal(t, "running", projectedSteps(t, f)["source"]["state"], "a deferred pass is scheduled")
	_, err = f.svc.Admit(ctx, "source", "source-3", json.RawMessage(`{}`))
	var conflict *pkgerrors.APIError
	require.ErrorAs(t, err, &conflict)
	require.Equal(t, "setup worker lease is active", conflict.Message)
	require.Equal(t, 2, f.step(t, "source").Attempt)
}

// Without a bound image builder (the install bundle, T-INS-06 R4) step 6
// answers 503 and admits no job.
func TestInstallMachineUnboundAnswersUnavailablePostgres(t *testing.T) {
	f := newSetupFixture(t, "machine")
	_, err := f.svc.Admit(t.Context(), "machine", "machine-1", json.RawMessage(`{}`))
	var unavailable *pkgerrors.APIError
	require.ErrorAs(t, err, &unavailable)
	require.Equal(t, pkgerrors.CodeServiceUnavailable, unavailable.Code)
	var jobsAdmitted int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests`).Scan(&jobsAdmitted))
	require.Zero(t, jobsAdmitted)
	require.Equal(t, InstallPending, f.step(t, "machine").Status)
}
