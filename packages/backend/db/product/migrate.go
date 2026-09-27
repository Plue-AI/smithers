// Package product owns the PostgreSQL schema shared by local Smithers and Plue.
package product

import (
	"context"
	"crypto/sha256"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const BaselineVersion = 1

var (
	ErrChecksumMismatch   = errors.New("product migration checksum mismatch")
	ErrUnsupportedVersion = errors.New("product database version is newer than this binary")
)

//go:embed migrations/*.sql
var migrations embed.FS

type migrationSpec struct {
	version int
	path    string
}

// Add each new SQL migration here in version order. Keeping the list explicit
// makes a forgotten file or an accidental deletion fail before any SQL runs.
var migrationRegistry = []migrationSpec{
	{BaselineVersion, "migrations/0001_product_baseline.sql"},
	{2, "migrations/0002_import_publication.sql"},
	{3, "migrations/0003_repository_creation_jobs.sql"},
	{4, "migrations/0004_single_owner_identity.sql"},
	{5, "migrations/0005_durable_product_jobs.sql"},
	{6, "migrations/0006_repository_storage_fences.sql"},
	{7, "migrations/0007_chat_turns.sql"},
	{8, "migrations/0008_flow_runtime_host_bindings.sql"},
	{9, "migrations/0009_owner_models.sql"},
	{10, "migrations/0010_branch_lock_and_workflow_invocations.sql"},
	{11, "migrations/0011_onboarding_and_workspace_setup.sql"},
	{12, "migrations/0012_workflow_run_coding_hosts.sql"},
	{13, "migrations/0013_chat_turn_erasures.sql"},
	{14, "migrations/0014_recommendation_logs.sql"},
	{15, "migrations/0015_github_synced_repo_read_grants.sql"},
	{16, "migrations/0016_repo_push_events.sql"},
	{17, "migrations/0017_secret_caps.sql"},
	{18, "migrations/0018_email_addresses_activated_unique.sql"},
	{19, "migrations/0019_revocation_events_ssh_key_revoked.sql"},
	{20, "migrations/0020_repository_setup_requests.sql"},
	{21, "migrations/0021_oauth2_grant_source.sql"},
	{22, "migrations/0022_provider_refresh_and_mention_sources.sql"},
	{23, "migrations/0023_chat_turn_erasure_proofs.sql"},
	{24, "migrations/0024_github_main_pulls.sql"},
	{25, "migrations/0025_provider_account_pool.sql"},
	{26, "migrations/0026_mythical_stacks.sql"},
	{27, "migrations/0027_exact_credits.sql"},
	{28, "migrations/0028_canonical_import_receipts.sql"},
	{29, "migrations/0029_mythical_lane_accounts.sql"},
	{30, "migrations/0030_model_usage.sql"},
	{31, "migrations/0031_retire_runner_plane.sql"},
	{32, "migrations/0032_workflow_task_guest_tokens.sql"},
	{33, "migrations/0033_credit_plan_grants.sql"},
	{34, "migrations/0034_billing_subscription_payment_reversed.sql"},
	{35, "migrations/0035_landing_github_merges.sql"},
	{36, "migrations/0036_mythical_wikis.sql"},
	{37, "migrations/0037_retire_source_index_wiki_pages.sql"},
	{38, "migrations/0038_provider_usage_guard.sql"},
	{39, "migrations/0039_issue_chat_sync.sql"},
	{40, "migrations/0040_issue_comment_facts.sql"},
	{41, "migrations/0041_billing_subscription_payment_settled.sql"},
	{42, "migrations/0042_wiki_spaces.sql"},
	{43, "migrations/0043_wiki_content_events.sql"},
	{44, "migrations/0044_billing_subscription_snapshot_observed.sql"},
	{45, "migrations/0045_outsider_provenance.sql"},
	{46, "migrations/0046_subscription_token_flags.sql"},
}

type migration struct {
	version  int
	sql      string
	checksum string
}

func registeredMigrations() ([]migration, error) {
	files, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return nil, fmt.Errorf("list product migrations: %w", err)
	}
	if len(files) != len(migrationRegistry) {
		return nil, fmt.Errorf("product migration registry has %d entries for %d SQL files", len(migrationRegistry), len(files))
	}
	result := make([]migration, 0, len(migrationRegistry))
	for i, spec := range migrationRegistry {
		if spec.version != i+1 || spec.path != files[i] {
			return nil, fmt.Errorf("product migration registry is not complete and ordered at version %d", i+1)
		}
		content, err := migrations.ReadFile(spec.path)
		if err != nil {
			return nil, fmt.Errorf("read product migration %d: %w", spec.version, err)
		}
		if len(content) == 0 {
			return nil, fmt.Errorf("product migration %d is empty", spec.version)
		}
		result = append(result, migration{version: spec.version, sql: string(content), checksum: fmt.Sprintf("%x", sha256.Sum256(content))})
	}
	return result, nil
}

type migrationQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func appliedMigrations(ctx context.Context, q migrationQuerier, registered []migration) (map[int]bool, error) {
	rows, err := q.Query(ctx, `SELECT version, checksum FROM public.smithers_product_migrations ORDER BY version`)
	if err != nil {
		return nil, fmt.Errorf("read product migration ledger: %w", err)
	}
	defer rows.Close()
	applied := make(map[int]bool)
	for rows.Next() {
		var version int
		var checksum string
		if err := rows.Scan(&version, &checksum); err != nil {
			return nil, fmt.Errorf("scan product migration ledger: %w", err)
		}
		if version < 1 || version > len(registered) {
			return nil, fmt.Errorf("%w: version %d", ErrUnsupportedVersion, version)
		}
		if checksum != registered[version-1].checksum {
			return nil, fmt.Errorf("%w: version %d", ErrChecksumMismatch, version)
		}
		applied[version] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read product migration ledger: %w", err)
	}
	return applied, nil
}

// Status returns the registered migration versions the database has not
// applied, in version order. An empty result means the schema is current.
func Status(ctx context.Context, pool *pgxpool.Pool) ([]int, error) {
	if pool == nil {
		return nil, errors.New("product migration requires a PostgreSQL pool")
	}
	registered, err := registeredMigrations()
	if err != nil {
		return nil, err
	}
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('public.smithers_product_migrations') IS NOT NULL`).Scan(&exists); err != nil {
		return nil, fmt.Errorf("inspect product migration ledger: %w", err)
	}
	applied := map[int]bool{}
	if exists {
		if applied, err = appliedMigrations(ctx, pool, registered); err != nil {
			return nil, err
		}
	}
	pending := []int{}
	for _, item := range registered {
		if !applied[item.version] {
			pending = append(pending, item.version)
		}
	}
	return pending, nil
}

// Migration DDL waits at most migrationLockTimeout for a table lock, so an
// ALTER queued behind a long transaction cannot stall every later query on
// that table. A lock timeout rolls back and retries after a growing pause.
var (
	migrationLockTimeout      = 5 * time.Second
	migrationStatementTimeout = 15 * time.Minute
	migrationLockAttempts     = 5
	migrationLockBackoff      = time.Second
)

// Apply installs every pending product migration in one transaction. An
// advisory lock serializes concurrent starts; the ledger rejects changed SQL
// and prevents an older binary from opening a newer database. Fresh installs
// need PostgreSQL only, with no Atlas executable or cloud account.
func Apply(ctx context.Context, pool *pgxpool.Pool) error {
	if pool == nil {
		return errors.New("product migration requires a PostgreSQL pool")
	}
	registered, err := registeredMigrations()
	if err != nil {
		return err
	}
	for attempt := 1; ; attempt++ {
		err = applyOnce(ctx, pool, registered)
		var pgErr *pgconn.PgError
		if err == nil || attempt >= migrationLockAttempts || !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
			return err
		}
		wait := migrationLockBackoff * time.Duration(1<<(attempt-1))
		slog.Warn("product migration lock wait timed out; retrying", "attempt", attempt, "retry_in", wait, "error", err)
		select {
		case <-ctx.Done():
			return errors.Join(err, ctx.Err())
		case <-time.After(wait):
		}
	}
}

func applyOnce(ctx context.Context, pool *pgxpool.Pool, registered []migration) error {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin product migration: %w", err)
	}
	defer func() {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(rollbackCtx)
	}()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('smithers:product:migration', 0))`); err != nil {
		return fmt.Errorf("lock product migration: %w", err)
	}
	if _, err := tx.Exec(ctx, fmt.Sprintf(`SET LOCAL lock_timeout = %d; SET LOCAL statement_timeout = %d`,
		migrationLockTimeout.Milliseconds(), migrationStatementTimeout.Milliseconds())); err != nil {
		return fmt.Errorf("bound product migration waits: %w", err)
	}
	if _, err := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS public.smithers_product_migrations (
		version integer PRIMARY KEY,
		checksum text NOT NULL,
		applied_at timestamptz NOT NULL DEFAULT now()
	)`); err != nil {
		return fmt.Errorf("create product migration ledger: %w", err)
	}
	applied, err := appliedMigrations(ctx, tx, registered)
	if err != nil {
		return err
	}
	var durations [][2]int64
	for _, item := range registered {
		if applied[item.version] {
			continue
		}
		if item.version == 12 {
			adopted, err := adoptExistingCodingHostTable(ctx, tx)
			if err != nil {
				return fmt.Errorf("adopt product migration 12: %w", err)
			}
			if adopted {
				if _, err := tx.Exec(ctx, `INSERT INTO public.smithers_product_migrations(version, checksum) VALUES ($1, $2)`, item.version, item.checksum); err != nil {
					return fmt.Errorf("record adopted product migration 12: %w", err)
				}
				continue
			}
		}
		started := time.Now()
		if _, err := tx.Exec(ctx, item.sql, pgx.QueryExecModeSimpleProtocol); err != nil {
			return fmt.Errorf("apply product migration %d: %w", item.version, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO public.smithers_product_migrations(version, checksum) VALUES ($1, $2)`, item.version, item.checksum); err != nil {
			return fmt.Errorf("record product migration %d: %w", item.version, err)
		}
		durations = append(durations, [2]int64{int64(item.version), time.Since(started).Milliseconds()})
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit product migration: %w", err)
	}
	for _, d := range durations {
		slog.Info("product migration applied", "version", d[0], "duration_ms", d[1])
	}
	return nil
}

// Plue's former mixed lineage already installed migration 12's table before
// Smithers owned the product ledger. Adopt only the exact canonical shape;
// a partial or different table must stop the rollout.
func adoptExistingCodingHostTable(ctx context.Context, tx pgx.Tx) (bool, error) {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT to_regclass('public.workflow_run_coding_hosts') IS NOT NULL`).Scan(&exists); err != nil {
		return false, err
	}
	if !exists {
		return false, nil
	}
	var matches bool
	err := tx.QueryRow(ctx, `SELECT
		ARRAY(SELECT a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
			FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
			WHERE a.attrelid='public.workflow_run_coding_hosts'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum)
		= ARRAY['workflow_run_id:bigint:true:', 'workspace_id:uuid:true:', 'host_run_id:text:true:', 'flow_id:text:true:',
			'created_at:timestamp with time zone:true:now()', 'updated_at:timestamp with time zone:true:now()']
		AND ARRAY(SELECT conname || ':' || pg_get_constraintdef(oid)
			FROM pg_constraint
			WHERE conrelid='public.workflow_run_coding_hosts'::regclass AND contype <> 'n'
			ORDER BY conname)
		= ARRAY['workflow_run_coding_hosts_flow_id_present:CHECK ((flow_id <> ''''::text))',
			'workflow_run_coding_hosts_host_run_id_present:CHECK ((host_run_id <> ''''::text))',
			'workflow_run_coding_hosts_pkey:PRIMARY KEY (workflow_run_id)',
			'workflow_run_coding_hosts_workflow_run_id_fkey:FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE',
			'workflow_run_coding_hosts_workspace_id_fkey:FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE']
		AND ARRAY(SELECT indexname || ':' || indexdef FROM pg_indexes
			WHERE schemaname='public' AND tablename='workflow_run_coding_hosts' ORDER BY indexname)
		= ARRAY['idx_workflow_run_coding_hosts_workspace:CREATE INDEX idx_workflow_run_coding_hosts_workspace ON public.workflow_run_coding_hosts USING btree (workspace_id, workflow_run_id)',
			'workflow_run_coding_hosts_pkey:CREATE UNIQUE INDEX workflow_run_coding_hosts_pkey ON public.workflow_run_coding_hosts USING btree (workflow_run_id)']`).Scan(&matches)
	if err != nil {
		return false, err
	}
	if !matches {
		return false, errors.New("preexisting workflow_run_coding_hosts differs from canonical product migration 12")
	}
	return true, nil
}
