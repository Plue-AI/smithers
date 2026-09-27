package services

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/subscriptiontoken"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

const storedSubscriptionTokenScanPage = 500

// StoredSubscriptionTokenScanCounts is the scan's whole report: how many
// stored rows held a subscription token and how many workspaces and snapshots
// it marked rebuild-required. It never carries a name or a value.
type StoredSubscriptionTokenScanCounts struct {
	RepositorySecrets       int64 `json:"repository_secrets"`
	OrganizationSecrets     int64 `json:"organization_secrets"`
	AgentEnvironmentSecrets int64 `json:"agent_environment_secrets"`
	AgentEnvironments       int64 `json:"agent_environments"`
	// Variables are plain text and refused on use; they carry no flag.
	Variables  int64 `json:"variables"`
	Workspaces int64 `json:"workspaces"`
	Snapshots  int64 `json:"snapshots"`
	// Unreadable counts secrets that did not decrypt; they are not flagged.
	Unreadable int64 `json:"unreadable,omitempty"`
}

// ScanStoredSubscriptionTokens runs once per database (#2206). Secrets and
// variables saved
// before the hosted refusal are checked with the same detector the write and
// use paths apply: each one holding a subscription token is flagged for
// reconnecting, and every live workspace and snapshot of a repository that
// held one (an organization secret or variable: every repository of the
// organization) is
// marked rebuild-required. The receipt row makes later runs no-ops; replicas
// racing at startup serialize on an advisory lock and the loser returns
// ran=false. Only a deployment that refuses subscription tokens runs it.
func ScanStoredSubscriptionTokens(ctx context.Context, pool interface {
	Begin(context.Context) (pgx.Tx, error)
}, codec webhook.SecretCodec) (counts StoredSubscriptionTokenScanCounts, ran bool, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return counts, false, fmt.Errorf("begin subscription token scan: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	locked, err := q.TryLockStoredSubscriptionTokenScan(ctx)
	if err != nil || !locked {
		return counts, false, err
	}
	if completed, err := q.StoredSubscriptionTokenScanCompleted(ctx); err != nil || completed {
		return counts, false, err
	}

	repositories := map[int64]struct{}{}
	holds := func(name string, cipher []byte) bool {
		value, err := codec.DecryptString(string(cipher))
		if err != nil {
			counts.Unreadable++
			return false
		}
		return value != "" && subscriptiontoken.Holds(name, value)
	}

	for after := int64(0); ; {
		rows, err := q.ListRepositorySecretValuesAfter(ctx, db.ListRepositorySecretValuesAfterParams{AfterID: after, PageSize: storedSubscriptionTokenScanPage})
		if err != nil {
			return counts, false, fmt.Errorf("list repository secrets: %w", err)
		}
		for _, row := range rows {
			after = row.ID
			if !holds(row.Name, row.ValueEncrypted) {
				continue
			}
			flagged, err := q.FlagRepositorySecretSubscriptionToken(ctx, db.FlagRepositorySecretSubscriptionTokenParams{ID: row.ID, ValueEncrypted: row.ValueEncrypted})
			if err != nil {
				return counts, false, fmt.Errorf("flag repository secret: %w", err)
			}
			counts.RepositorySecrets += flagged
			repositories[row.RepositoryID] = struct{}{}
		}
		if len(rows) < storedSubscriptionTokenScanPage {
			break
		}
	}

	for after := int64(0); ; {
		rows, err := q.ListRepositoryVariablesAfter(ctx, db.ListRepositoryVariablesAfterParams{AfterID: after, PageSize: storedSubscriptionTokenScanPage})
		if err != nil {
			return counts, false, fmt.Errorf("list repository variables: %w", err)
		}
		for _, row := range rows {
			after = row.ID
			if row.Value != "" && subscriptiontoken.Holds(row.Name, row.Value) {
				counts.Variables++
				repositories[row.RepositoryID] = struct{}{}
			}
		}
		if len(rows) < storedSubscriptionTokenScanPage {
			break
		}
	}

	organizations := map[int64]struct{}{}
	for after := int64(0); ; {
		rows, err := q.ListOrgVariablesAfter(ctx, db.ListOrgVariablesAfterParams{AfterID: after, PageSize: storedSubscriptionTokenScanPage})
		if err != nil {
			return counts, false, fmt.Errorf("list organization variables: %w", err)
		}
		for _, row := range rows {
			after = row.ID
			if row.Value != "" && subscriptiontoken.Holds(row.Name, row.Value) {
				counts.Variables++
				organizations[row.OrganizationID] = struct{}{}
			}
		}
		if len(rows) < storedSubscriptionTokenScanPage {
			break
		}
	}
	for after := int64(0); ; {
		rows, err := q.ListOrgSecretValuesAfter(ctx, db.ListOrgSecretValuesAfterParams{AfterID: after, PageSize: storedSubscriptionTokenScanPage})
		if err != nil {
			return counts, false, fmt.Errorf("list organization secrets: %w", err)
		}
		for _, row := range rows {
			after = row.ID
			if !holds(row.Name, row.ValueEncrypted) {
				continue
			}
			flagged, err := q.FlagOrgSecretSubscriptionToken(ctx, db.FlagOrgSecretSubscriptionTokenParams{ID: row.ID, ValueEncrypted: row.ValueEncrypted})
			if err != nil {
				return counts, false, fmt.Errorf("flag organization secret: %w", err)
			}
			counts.OrganizationSecrets += flagged
			organizations[row.OrganizationID] = struct{}{}
		}
		if len(rows) < storedSubscriptionTokenScanPage {
			break
		}
	}
	for organizationID := range organizations {
		ids, err := q.ListOrganizationRepositoryIDs(ctx, organizationID)
		if err != nil {
			return counts, false, fmt.Errorf("list organization repositories: %w", err)
		}
		for _, id := range ids {
			repositories[id] = struct{}{}
		}
	}

	for afterRepository, afterName := int64(0), ""; ; {
		rows, err := q.ListAgentEnvironmentSecretValuesAfter(ctx, db.ListAgentEnvironmentSecretValuesAfterParams{
			AfterRepositoryID: afterRepository, AfterName: afterName, PageSize: storedSubscriptionTokenScanPage,
		})
		if err != nil {
			return counts, false, fmt.Errorf("list agent environment secrets: %w", err)
		}
		for _, row := range rows {
			afterRepository, afterName = row.RepositoryID, row.Name
			if !holds(row.Name, row.ValueEncrypted) {
				continue
			}
			flagged, err := q.FlagAgentEnvironmentSecretSubscriptionToken(ctx, db.FlagAgentEnvironmentSecretSubscriptionTokenParams{
				RepositoryID: row.RepositoryID, Name: row.Name, ValueEncrypted: row.ValueEncrypted,
			})
			if err != nil {
				return counts, false, fmt.Errorf("flag agent environment secret: %w", err)
			}
			counts.AgentEnvironmentSecrets += flagged
			repositories[row.RepositoryID] = struct{}{}
		}
		if len(rows) < storedSubscriptionTokenScanPage {
			break
		}
	}

	// A setup script or variable is checked on every read already (#2178);
	// the scan only counts them and marks what their setup built.
	for after := int64(0); ; {
		rows, err := q.ListAgentEnvironmentsAfter(ctx, db.ListAgentEnvironmentsAfterParams{AfterRepositoryID: after, PageSize: storedSubscriptionTokenScanPage})
		if err != nil {
			return counts, false, fmt.Errorf("list agent environments: %w", err)
		}
		for _, row := range rows {
			after = row.RepositoryID
			if agentEnvironmentHoldsSubscriptionToken(db.RepositoryAgentEnvironment{SetupScript: row.SetupScript, EnvironmentVariables: row.EnvironmentVariables}) {
				counts.AgentEnvironments++
				repositories[row.RepositoryID] = struct{}{}
			}
		}
		if len(rows) < storedSubscriptionTokenScanPage {
			break
		}
	}

	for repositoryID := range repositories {
		workspaces, snapshots, err := markRepositoryRebuildRequiredCount(ctx, q, repositoryID)
		if err != nil {
			return counts, false, err
		}
		counts.Workspaces += workspaces
		counts.Snapshots += snapshots
	}

	receipt, err := json.Marshal(counts)
	if err != nil {
		return counts, false, err
	}
	if err := q.RecordStoredSubscriptionTokenScan(ctx, receipt); err != nil {
		return counts, false, fmt.Errorf("record subscription token scan: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return counts, false, fmt.Errorf("commit subscription token scan: %w", err)
	}
	return counts, true, nil
}

// RunStoredSubscriptionTokenScan is the startup worker: it runs the scan and
// logs its counts, or its failure (the next start retries).
func RunStoredSubscriptionTokenScan(ctx context.Context, pool interface {
	Begin(context.Context) (pgx.Tx, error)
}, codec webhook.SecretCodec) {
	counts, ran, err := ScanStoredSubscriptionTokens(ctx, pool, codec)
	if err != nil {
		if ctx.Err() == nil {
			slog.Error("stored subscription token scan failed", "error", err)
		}
		return
	}
	if ran {
		slog.Info("stored subscription token scan completed",
			"repository_secrets", counts.RepositorySecrets,
			"organization_secrets", counts.OrganizationSecrets,
			"agent_environment_secrets", counts.AgentEnvironmentSecrets,
			"agent_environments", counts.AgentEnvironments,
			"variables", counts.Variables,
			"workspaces", counts.Workspaces,
			"snapshots", counts.Snapshots,
			"unreadable", counts.Unreadable,
		)
	}
}
