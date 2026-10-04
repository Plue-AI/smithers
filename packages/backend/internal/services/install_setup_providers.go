package services

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// BindRepositoryProviders reuses the existing OAuth/App verification and the
// durable importer. Neither provider loads a flow nor prepares a host recipe.
func (s *InstallSetupService) BindRepositoryProviders(access *GitHubUserReposService, app *GitHubAppCredentialStore, imports *GitHubImportService) {
	s.Providers = map[string]func(context.Context, *jobs.Lease, InstallSetupInput) error{}
	s.Providers["repository"] = func(ctx context.Context, lease *jobs.Lease, input InstallSetupInput) error {
		owner, err := db.New(s.Pool).GetSelfHostOwner(ctx)
		if err != nil {
			return err
		}
		o, n, _ := strings.Cut(input.Repository, "/")
		if err = access.VerifyUserCanPushToGitHubRepo(ctx, owner.ID, o, n); err != nil {
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
		owner, err := db.New(s.Pool).GetSelfHostOwner(ctx)
		if err != nil {
			return err
		}
		var receipt struct {
			ImportID string `json:"import_id"`
		}
		json.Unmarshal(lease.Claim().ExternalReceipt, &receipt)
		if receipt.ImportID == "" {
			row, err := db.New(s.Pool).GetInstallSetting(ctx, "repository")
			if err != nil {
				return err
			}
			var slug string
			if err = json.Unmarshal(row.Value, &slug); err != nil {
				return err
			}
			o, n, _ := strings.Cut(slug, "/")
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
		// Import's selected local slug can differ from the GitHub slug. Pin it for
		// machine preparation rather than guessing a repository-host identity.
		raw, _ := json.Marshal(job.RepoOwner + "/" + job.RepoName)
		return db.New(s.Pool).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.source.repository", Value: raw})
	}
}
