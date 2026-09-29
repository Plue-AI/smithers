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

// removal names a row the scan removed a Claude token from: its table, owner
// (user, organization or repository id) and entry name, never its value.
type removal struct {
	table   string
	ownerID int64
	entry   string
}

// StoredSubscriptionTokenScanCounts is the scan's whole report: how many
// stored rows held a subscription token and how many workspaces and snapshots
// it marked rebuild-required. It never carries a name or a value.
type StoredSubscriptionTokenScanCounts struct {
	RepositorySecrets       int64 `json:"repository_secrets"`
	OrganizationSecrets     int64 `json:"organization_secrets"`
	AgentEnvironmentSecrets int64 `json:"agent_environment_secrets"`
	AgentEnvironments       int64 `json:"agent_environments"`
	// Variables are plain text and refused on use; they carry no flag.
	Variables int64 `json:"variables"`
	// ModelCredentials are an account's and refused on use; they carry no
	// flag and mark nothing.
	ModelCredentials int64 `json:"model_credentials"`
	// ProviderConnections holding a Claude token under any label are
	// deleted (#2777).
	ProviderConnections int64 `json:"provider_connections"`
	// ClaudeRemoved counts the rows the scan removed a Claude subscription
	// token from (#2777): included in the counts above, never flagged.
	ClaudeRemoved int64 `json:"claude_removed"`
	Workspaces    int64 `json:"workspaces"`
	Snapshots     int64 `json:"snapshots"`
	// Unreadable counts values that did not decrypt; they are neither
	// flagged nor removed, and the next start checks them again.
	Unreadable int64 `json:"unreadable,omitempty"`
}

// ScanStoredSubscriptionTokens runs on every start. Secrets, variables,
// model credentials, agent environments and provider connections are checked
// with the same detector the write and use paths apply, in two parts:
//
//   - Every start, on every deployment, removes each Claude subscription
//     token (#2777), so one written by an old replica during a rolling deploy
//     or unreadable under an earlier key goes on the next start: a secret,
//     variable or provider connection holding one is deleted, a model
//     credential loses its value, and an agent environment's setup script has
//     the token replaced by a marker and its token variables dropped. Each
//     removal is logged by table, owner and entry name.
//   - A deployment that refuses ChatGPT tokens (allowed false) flags each
//     other secret holding a subscription token for reconnecting once per
//     database (#2206; its receipt makes later starts skip this part);
//     variables, model credentials and agent environments are only counted,
//     since every read refuses them.
//
// Every live workspace and snapshot of a repository that held a refused token
// (an organization secret or variable: every repository of the organization)
// is marked rebuild-required. Replicas racing at startup serialize on an
// advisory lock and the loser returns ran=false.
func ScanStoredSubscriptionTokens(ctx context.Context, pool interface {
	Begin(context.Context) (pgx.Tx, error)
}, codec webhook.SecretCodec, allowed bool) (counts StoredSubscriptionTokenScanCounts, ran bool, err error) {
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
	flag := !allowed
	if flag {
		completed, err := q.StoredSubscriptionTokenScanCompleted(ctx)
		if err != nil {
			return counts, false, err
		}
		flag = !completed
	}

	// check decides a stored value: remove reports a Claude token to remove,
	// found any token this run acts on.
	check := func(name, value string) (remove, found bool) {
		if value == "" {
			return false, false
		}
		if subscriptiontoken.HoldsClaude(name, value) {
			return true, true
		}
		return false, flag && subscriptiontoken.Holds(name, value)
	}
	decrypt := func(cipher []byte) string {
		value, err := codec.DecryptString(string(cipher))
		if err != nil {
			counts.Unreadable++
			return ""
		}
		return value
	}
	// act removes or flags one row and returns how many rows changed. Each
	// removal is logged by table, owner and entry name, never its value.
	// removed is logged once the transaction commits, so a rolled-back scan
	// never reports a removal.
	var removed []removal
	act := func(remove bool, what removal, removeRow, flagRow func() (int64, error)) (int64, error) {
		if remove {
			n, err := removeRow()
			if err == nil && n > 0 {
				counts.ClaudeRemoved += n
				removed = append(removed, what)
			}
			return n, err
		}
		if flagRow == nil {
			return 1, nil
		}
		return flagRow()
	}
	repositories := map[int64]struct{}{}

	for after := int64(0); ; {
		rows, err := q.ListRepositorySecretValuesAfter(ctx, db.ListRepositorySecretValuesAfterParams{AfterID: after, PageSize: storedSubscriptionTokenScanPage})
		if err != nil {
			return counts, false, fmt.Errorf("list repository secrets: %w", err)
		}
		for _, row := range rows {
			after = row.ID
			remove, found := check(row.Name, decrypt(row.ValueEncrypted))
			if !found {
				continue
			}
			n, err := act(remove, removal{"repository_secrets", row.RepositoryID, row.Name}, func() (int64, error) {
				return q.DeleteRepositorySecretSubscriptionToken(ctx, db.DeleteRepositorySecretSubscriptionTokenParams{ID: row.ID, ValueEncrypted: row.ValueEncrypted})
			}, func() (int64, error) {
				return q.FlagRepositorySecretSubscriptionToken(ctx, db.FlagRepositorySecretSubscriptionTokenParams{ID: row.ID, ValueEncrypted: row.ValueEncrypted})
			})
			if err != nil {
				return counts, false, fmt.Errorf("repository secret: %w", err)
			}
			counts.RepositorySecrets += n
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
			remove, found := check(row.Name, row.Value)
			if !found {
				continue
			}
			n, err := act(remove, removal{"repository_variables", row.RepositoryID, row.Name}, func() (int64, error) {
				return q.DeleteRepositoryVariableSubscriptionToken(ctx, db.DeleteRepositoryVariableSubscriptionTokenParams{ID: row.ID, Value: row.Value})
			}, nil)
			if err != nil {
				return counts, false, fmt.Errorf("repository variable: %w", err)
			}
			counts.Variables += n
			repositories[row.RepositoryID] = struct{}{}
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
			remove, found := check(row.Name, row.Value)
			if !found {
				continue
			}
			n, err := act(remove, removal{"organization_variables", row.OrganizationID, row.Name}, func() (int64, error) {
				return q.DeleteOrgVariableSubscriptionToken(ctx, db.DeleteOrgVariableSubscriptionTokenParams{ID: row.ID, Value: row.Value})
			}, nil)
			if err != nil {
				return counts, false, fmt.Errorf("organization variable: %w", err)
			}
			counts.Variables += n
			organizations[row.OrganizationID] = struct{}{}
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
			remove, found := check(row.Name, decrypt(row.ValueEncrypted))
			if !found {
				continue
			}
			n, err := act(remove, removal{"organization_secrets", row.OrganizationID, row.Name}, func() (int64, error) {
				return q.DeleteOrgSecretSubscriptionToken(ctx, db.DeleteOrgSecretSubscriptionTokenParams{ID: row.ID, ValueEncrypted: row.ValueEncrypted})
			}, func() (int64, error) {
				return q.FlagOrgSecretSubscriptionToken(ctx, db.FlagOrgSecretSubscriptionTokenParams{ID: row.ID, ValueEncrypted: row.ValueEncrypted})
			})
			if err != nil {
				return counts, false, fmt.Errorf("organization secret: %w", err)
			}
			counts.OrganizationSecrets += n
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
			remove, found := check(row.Name, decrypt(row.ValueEncrypted))
			if !found {
				continue
			}
			n, err := act(remove, removal{"repository_agent_environment_secrets", row.RepositoryID, row.Name}, func() (int64, error) {
				return q.DeleteAgentEnvironmentSecretSubscriptionToken(ctx, db.DeleteAgentEnvironmentSecretSubscriptionTokenParams{
					RepositoryID: row.RepositoryID, Name: row.Name, ValueEncrypted: row.ValueEncrypted,
				})
			}, func() (int64, error) {
				return q.FlagAgentEnvironmentSecretSubscriptionToken(ctx, db.FlagAgentEnvironmentSecretSubscriptionTokenParams{
					RepositoryID: row.RepositoryID, Name: row.Name, ValueEncrypted: row.ValueEncrypted,
				})
			})
			if err != nil {
				return counts, false, fmt.Errorf("agent environment secret: %w", err)
			}
			counts.AgentEnvironmentSecrets += n
			repositories[row.RepositoryID] = struct{}{}
		}
		if len(rows) < storedSubscriptionTokenScanPage {
			break
		}
	}

	for after := int64(0); ; {
		rows, err := q.ListAgentEnvironmentsAfter(ctx, db.ListAgentEnvironmentsAfterParams{AfterRepositoryID: after, PageSize: storedSubscriptionTokenScanPage})
		if err != nil {
			return counts, false, fmt.Errorf("list agent environments: %w", err)
		}
		for _, row := range rows {
			after = row.RepositoryID
			stored := db.RepositoryAgentEnvironment{SetupScript: row.SetupScript, EnvironmentVariables: row.EnvironmentVariables}
			remove := agentEnvironmentHoldsSubscriptionToken(true, stored)
			if !remove && !(flag && agentEnvironmentHoldsSubscriptionToken(false, stored)) {
				continue
			}
			n, err := act(remove, removal{"repository_agent_environments", row.RepositoryID, "setup script and variables"}, func() (int64, error) {
				script, variables, err := removeClaudeFromAgentEnvironment(stored)
				if err != nil {
					return 0, err
				}
				return q.ReplaceAgentEnvironmentSubscriptionToken(ctx, db.ReplaceAgentEnvironmentSubscriptionTokenParams{
					RepositoryID: row.RepositoryID, SetupScript: script, EnvironmentVariables: variables,
					StoredSetupScript: row.SetupScript, StoredEnvironmentVariables: row.EnvironmentVariables,
				})
			}, nil)
			if err != nil {
				return counts, false, fmt.Errorf("agent environment: %w", err)
			}
			counts.AgentEnvironments += n
			repositories[row.RepositoryID] = struct{}{}
		}
		if len(rows) < storedSubscriptionTokenScanPage {
			break
		}
	}

	// Model credentials belong to an account, not a repository: they mark
	// nothing.
	for afterUser, afterName := int64(0), ""; ; {
		rows, err := q.ListOwnerModelCredentialValuesAfter(ctx, db.ListOwnerModelCredentialValuesAfterParams{
			AfterUserID: afterUser, AfterName: afterName, PageSize: storedSubscriptionTokenScanPage,
		})
		if err != nil {
			return counts, false, fmt.Errorf("list model credentials: %w", err)
		}
		for _, row := range rows {
			afterUser, afterName = row.UserID, row.Name
			remove, found := check(row.Name, decrypt([]byte(row.ValueEncrypted)))
			if !found {
				continue
			}
			n, err := act(remove, removal{"owner_model_credentials", row.UserID, row.Name}, func() (int64, error) {
				return q.ClearOwnerModelCredentialSubscriptionToken(ctx, db.ClearOwnerModelCredentialSubscriptionTokenParams{
					UserID: row.UserID, Name: row.Name, ValueEncrypted: row.ValueEncrypted,
				})
			}, nil)
			if err != nil {
				return counts, false, fmt.Errorf("model credential: %w", err)
			}
			counts.ModelCredentials += n
		}
		if len(rows) < storedSubscriptionTokenScanPage {
			break
		}
	}

	// A provider connection holding a Claude token under any label (#2777)
	// is deleted; its grants and usage records cascade. Pool tokens never
	// enter a workspace, so it marks nothing.
	for after := "00000000-0000-0000-0000-000000000000"; ; {
		rows, err := q.ListProviderConnectionTokensAfter(ctx, db.ListProviderConnectionTokensAfterParams{AfterID: after, PageSize: storedSubscriptionTokenScanPage})
		if err != nil {
			return counts, false, fmt.Errorf("list provider connections: %w", err)
		}
		for _, row := range rows {
			after = row.ID
			access := decrypt(row.AccessTokenEncrypted)
			refresh := ""
			if len(row.RefreshTokenEncrypted) > 0 {
				refresh = decrypt(row.RefreshTokenEncrypted)
			}
			if !subscriptiontoken.HoldsClaude("", access) && !subscriptiontoken.HoldsClaude("", refresh) {
				continue
			}
			n, err := act(true, removal{"provider_connections", row.OwnerID, row.OwnerType + " " + row.Provider + " connection " + row.ID}, func() (int64, error) {
				return q.DeleteProviderConnectionSubscriptionToken(ctx, db.DeleteProviderConnectionSubscriptionTokenParams{ID: row.ID, AccessTokenEncrypted: row.AccessTokenEncrypted})
			}, nil)
			if err != nil {
				return counts, false, fmt.Errorf("provider connection: %w", err)
			}
			counts.ProviderConnections += n
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

	if flag {
		receipt, err := json.Marshal(counts)
		if err != nil {
			return counts, false, err
		}
		if err := q.RecordStoredSubscriptionTokenScan(ctx, receipt); err != nil {
			return counts, false, fmt.Errorf("record subscription token scan: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return counts, false, fmt.Errorf("commit subscription token scan: %w", err)
	}
	for _, what := range removed {
		slog.Warn("removed a stored Claude subscription token (#2777)", "table", what.table, "owner_id", what.ownerID, "entry", what.entry)
	}
	return counts, true, nil
}

// removeClaudeFromAgentEnvironment is a stored agent environment with every
// Claude subscription token removed: replaced by a marker in the setup
// script, and each variable holding one dropped, as the read path's answer
// drops it. Variables that do not decode are dropped whole.
func removeClaudeFromAgentEnvironment(stored db.RepositoryAgentEnvironment) (string, json.RawMessage, error) {
	kept := []AgentEnvironmentVariable{}
	var variables []AgentEnvironmentVariable
	if json.Unmarshal(stored.EnvironmentVariables, &variables) == nil {
		for _, variable := range variables {
			if !subscriptiontoken.HoldsClaude(variable.Name, variable.Value) {
				kept = append(kept, variable)
			}
		}
	}
	encoded, err := json.Marshal(kept)
	return subscriptiontoken.RemoveClaude(stored.SetupScript), encoded, err
}

// RunStoredSubscriptionTokenScan is the startup worker: it runs the scan and
// logs its counts, or its failure (the next start retries).
func RunStoredSubscriptionTokenScan(ctx context.Context, pool interface {
	Begin(context.Context) (pgx.Tx, error)
}, codec webhook.SecretCodec, allowed bool) {
	counts, ran, err := ScanStoredSubscriptionTokens(ctx, pool, codec, allowed)
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
			"model_credentials", counts.ModelCredentials,
			"provider_connections", counts.ProviderConnections,
			"claude_removed", counts.ClaudeRemoved,
			"workspaces", counts.Workspaces,
			"snapshots", counts.Snapshots,
			"unreadable", counts.Unreadable,
		)
	}
}
