package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// installImports is the durable importer's contract for the source step.
// GitHubImportService is the install's implementation.
type installImports interface {
	StartImport(context.Context, ImportGitHubRepoInput) (ImportJob, error)
	GetImportJob(context.Context, int64, string) (ImportJob, error)
}

// BindRepositoryProviders reuses the existing OAuth/App verification, the
// durable importer and the stack service. No provider loads a flow or
// prepares a host recipe.
func (s *InstallSetupService) BindRepositoryProviders(access *GitHubUserReposService, app *GitHubAppCredentialStore, imports installImports, members *Members, stacks *MythicalService) {
	if s.Providers == nil {
		s.Providers = map[string]func(context.Context, *jobs.Lease, InstallSetupInput) error{}
	}
	s.Providers["repository"] = func(ctx context.Context, lease *jobs.Lease, input InstallSetupInput) error {
		owner, err := db.New(s.Pool).GetSelfHostOwner(ctx)
		if err != nil {
			return err
		}
		o, n, _ := strings.Cut(input.Repository, "/")
		if members == nil {
			return pkgerrors.Internal("owner verifier unavailable")
		}
		if err = members.BindRepository(ctx, owner, o, n, 0); err != nil {
			return err
		}
		diagnosis, err := access.DiagnoseGitHubAccess(ctx, owner.ID, o, n, GitHubRepoMetadataIssues)
		if err != nil {
			return err
		}
		if diagnosis.Verdict != GitHubAccessVerdictOK || diagnosis.InstallationID <= 0 {
			return pkgerrors.Forbidden("Install the GitHub App on this repository")
		}
		metadata, err := access.GetAuthenticatedUserGitHubRepo(ctx, owner.ID, o, n)
		if err != nil {
			return err
		}
		var repository struct {
			Squash *bool `json:"allow_squash_merge"`
		}
		if json.Unmarshal(metadata.Body, &repository) != nil || repository.Squash == nil {
			return pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "GitHub squash setting unavailable")
		}
		if !*repository.Squash {
			return &InstallReadinessError{Code: "squash_disabled", Class: "github", Message: "Enable squash merging on GitHub ↗", Fix: "https://github.com/" + input.Repository + "/settings"}
		}
		if err = app.SetInstallation(ctx, diagnosis.InstallationID); err != nil {
			return err
		}
		raw, _ := json.Marshal(input.Repository)
		return db.New(s.Pool).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "repository", Value: raw})
	}
	s.Providers["source"] = func(ctx context.Context, lease *jobs.Lease, _ InstallSetupInput) error {
		if imports == nil || members == nil || stacks == nil {
			return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "setup provider unavailable")
		}
		return s.prepareSource(ctx, lease, imports, members, stacks)
	}
}

// prepareSource mirrors main, binds the mirror to the verified owner and asks
// the stack service for the repository's stack. Source ready means the mirror
// holds main (spec §8.6.3): it needs no machine and does not wait for the
// stack, whose state the stack service reports on its own.
func (s *InstallSetupService) prepareSource(ctx context.Context, lease *jobs.Lease, imports installImports, members *Members, stacks *MythicalService) error {
	q := db.New(s.Pool)
	owner, err := q.GetSelfHostOwner(ctx)
	if err != nil {
		return err
	}
	var receipt struct {
		ImportID string `json:"import_id"`
	}
	if raw := lease.Claim().ExternalReceipt; len(raw) > 0 {
		if err = json.Unmarshal(raw, &receipt); err != nil {
			return err
		}
	}
	o, n, err := installRepositorySlug(ctx, q, "repository")
	if err != nil {
		return err
	}
	if receipt.ImportID == "" {
		job, err := imports.StartImport(ctx, ImportGitHubRepoInput{UserID: owner.ID, Owner: o, Repo: n, Branch: "main"})
		if err != nil {
			return err
		}
		receipt.ImportID = job.ImportJobID
		raw, _ := json.Marshal(receipt)
		if _, err = lease.Checkpoint(ctx, raw); err != nil {
			return err
		}
	}
	job, err := imports.GetImportJob(ctx, owner.ID, receipt.ImportID)
	if err != nil {
		return err
	}
	if job.Status == "failed" {
		return &InstallReadinessError{Code: "source_import_failed", Class: "github", Message: "Repository mirror failed"}
	}
	if job.Status != "ready" {
		raw, _ := json.Marshal(receipt)
		return lease.Defer(ctx, raw, time.Second)
	}
	repo, err := q.GetRepoByOwnerAndName(ctx, db.GetRepoByOwnerAndNameParams{Owner: job.RepoOwner, Name: job.RepoName})
	if err != nil {
		return err
	}
	if err = members.BindRepository(ctx, owner, o, n, repo.ID); err != nil {
		return err
	}
	// Import's selected local slug can differ from the GitHub slug. Pin it for
	// machine preparation rather than guessing a repository-host identity.
	raw, _ := json.Marshal(job.RepoOwner + "/" + job.RepoName)
	if err = q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.source.repository", Value: raw}); err != nil {
		return err
	}
	// A TODO needs the repository's stack (mythical_file_todo.go). A repeated
	// request on redelivery only asks the stack worker for one more pass.
	_, err = stacks.RequestBootstrap(ctx, repo.ID, owner.ID, 0, false)
	return err
}

func installRepositorySlug(ctx context.Context, q *db.Queries, key string) (string, string, error) {
	row, err := q.GetInstallSetting(ctx, key)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", &InstallReadinessError{Code: "source_not_ready", Class: "infra", Message: "Choose the repository and mirror it first"}
	}
	if err != nil {
		return "", "", err
	}
	var slug string
	if err = json.Unmarshal(row.Value, &slug); err != nil {
		return "", "", err
	}
	o, n, ok := strings.Cut(slug, "/")
	if !ok || o == "" || n == "" {
		return "", "", pkgerrors.Internal("invalid repository setting " + key)
	}
	return o, n, nil
}

// BindMachineProvider runs setup step 6 through the retained readiness
// service: main's first machine image (spec §8.6.3). images builds it inside
// the machine runtime's isolation and sources reads main from the mirror; the
// host runs no repository code. The install bundle binds no builder until
// T-INS-06 R4 passes, so its step 6 answers 503.
func (s *InstallSetupService) BindMachineProvider(sources workspaceapi.SourceFiles, images InstallMachineLayerBuilder) {
	if s.Providers == nil {
		s.Providers = map[string]func(context.Context, *jobs.Lease, InstallSetupInput) error{}
	}
	s.Providers["machine"] = func(ctx context.Context, lease *jobs.Lease, _ InstallSetupInput) error {
		o, n, err := installRepositorySlug(ctx, db.New(s.Pool), "setup.source.repository")
		if err != nil {
			return err
		}
		ready := InstallMachineReadyService{Sources: sources, Layers: images, Persistence: installReadinessSteps{setup: s, operation: lease.Claim().OperationID}}
		_, err = ready.Prepare(ctx, o+"/"+n)
		return err
	}
}

// installReadinessSteps persists readiness over setup.step.source and
// setup.step.machine in one transaction. Only the machine operation that
// holds the step writes; another operation's write is refused unchanged.
// The held machine step stays running until it is done or failed, so a
// concurrent POST can never start a second preparation.
type installReadinessSteps struct {
	setup     *InstallSetupService
	operation string
}

func (p installReadinessSteps) Update(ctx context.Context, _ string, mutate func(InstallReadiness) (InstallReadiness, error)) (InstallReadiness, error) {
	tx, err := p.setup.Pool.Begin(ctx)
	if err != nil {
		return InstallReadiness{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(345506)`); err != nil {
		return InstallReadiness{}, err
	}
	q := db.New(tx)
	source, err := p.setup.readStep(ctx, q, "source")
	if err != nil {
		return InstallReadiness{}, err
	}
	machine, err := p.setup.readStep(ctx, q, "machine")
	if err != nil {
		return InstallReadiness{}, err
	}
	if machine.OperationID == "" || machine.OperationID != p.operation {
		return InstallReadiness{}, jobs.ErrClaimLost
	}
	current := InstallReadiness{Source: installReadinessOf(source), Machine: installReadinessOf(machine),
		Revision: machine.Revision, LayerKey: machine.LayerKey, Attempt: machine.ReadinessAttempt}
	next, err := mutate(current)
	if err != nil {
		return current, err
	}
	source = installStepWith(source, next.Source)
	machine = installStepWith(machine, next.Machine)
	machine.Revision, machine.LayerKey, machine.ReadinessAttempt = next.Revision, next.LayerKey, next.Attempt
	if err = saveInstallStep(ctx, tx, source); err != nil {
		return current, err
	}
	if err = saveInstallStep(ctx, tx, machine); err != nil {
		return current, err
	}
	if err = tx.Commit(ctx); err != nil {
		return current, err
	}
	return next, nil
}

func installReadinessOf(step InstallStep) InstallReadinessStep {
	readiness := InstallReadinessStep{State: step.Status, Error: step.Error}
	if step.Pct != nil {
		readiness.Pct = *step.Pct
	}
	return readiness
}

func installStepWith(step InstallStep, readiness InstallReadinessStep) InstallStep {
	state := readiness.State
	if state == InstallPending && step.Status == InstallRunning {
		state = InstallRunning
	}
	step.Status, step.Error, step.Pct = state, readiness.Error, nil
	if state == InstallRunning || state == InstallReady {
		pct := readiness.Pct
		step.Pct = &pct
	}
	return step
}
