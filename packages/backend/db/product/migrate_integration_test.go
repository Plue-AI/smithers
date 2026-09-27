package product

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

func TestApplyFreshProductDatabase(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	if pending, err := Status(ctx, pool); err != nil || len(pending) == 0 {
		t.Fatalf("fresh database status: pending=%v err=%v", pending, err)
	}

	if err := Apply(ctx, pool); err != nil {
		t.Fatalf("fresh product migration: %v", err)
	}
	if pending, err := Status(ctx, pool); err != nil || len(pending) != 0 {
		t.Fatalf("migrated database status: pending=%v err=%v", pending, err)
	}
	if err := Apply(ctx, pool); err != nil {
		t.Fatalf("idempotent product migration: %v", err)
	}
	// A hosted database can contain the canonical coding-host table from the
	// earlier Plue lineage while its product ledger ends at version 11.
	if _, err := pool.Exec(ctx, `DELETE FROM smithers_product_migrations WHERE version=12`); err != nil {
		t.Fatal(err)
	}
	if err := Apply(ctx, pool); err != nil {
		t.Fatalf("adopt existing coding-host table: %v", err)
	}
	var adopted bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM smithers_product_migrations WHERE version=12)`).Scan(&adopted); err != nil {
		t.Fatal(err)
	}
	if !adopted {
		t.Fatal("canonical coding-host table was not recorded as applied")
	}
	if _, err := pool.Exec(ctx, `DELETE FROM smithers_product_migrations WHERE version=12`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DROP INDEX idx_workflow_run_coding_hosts_workspace`); err != nil {
		t.Fatal(err)
	}
	if err := Apply(ctx, pool); err == nil || !strings.Contains(err.Error(), "differs from canonical product migration 12") {
		t.Fatalf("changed coding-host table should block adoption, got %v", err)
	}
	if _, err := pool.Exec(ctx, `CREATE INDEX idx_workflow_run_coding_hosts_workspace ON public.workflow_run_coding_hosts (workspace_id, workflow_run_id)`); err != nil {
		t.Fatal(err)
	}
	if err := Apply(ctx, pool); err != nil {
		t.Fatalf("adopt restored coding-host table: %v", err)
	}
	var infraMissing, placementColumnMissing bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('public.repo_storage_sets') IS NULL,
		NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
		AND table_name='repositories' AND column_name='storage_set_id')`).Scan(&infraMissing, &placementColumnMissing); err != nil {
		t.Fatal(err)
	}
	if !infraMissing || !placementColumnMissing {
		t.Fatal("product schema retained cluster storage placement")
	}

	var receiptTable, approvalTable bool
	if err := pool.QueryRow(ctx, `SELECT
		to_regclass('public.repository_ci_check_receipts') IS NOT NULL,
		to_regclass('public.repository_job_approvals') IS NOT NULL`).Scan(&receiptTable, &approvalTable); err != nil {
		t.Fatal(err)
	}
	if !receiptTable || !approvalTable {
		t.Fatal("incremental repository job product tables were not installed")
	}

	var alice, bob, repo int64
	if err := pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('alice', 'alice') RETURNING id`).Scan(&alice); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('bob', 'bob') RETURNING id`).Scan(&bob); err != nil {
		t.Fatal(err)
	}
	var importJobID string
	var defaultBookmark string
	var publishReady bool
	if err := pool.QueryRow(ctx, `INSERT INTO import_jobs(user_id, github_owner, github_repo)
		VALUES ($1, 'alice', 'project') RETURNING id, default_bookmark, publish_ready`, alice).
		Scan(&importJobID, &defaultBookmark, &publishReady); err != nil {
		t.Fatal(err)
	}
	if defaultBookmark != "" || publishReady {
		t.Fatal("new import reservation unexpectedly marked ready")
	}
	if err := pool.QueryRow(ctx, `UPDATE import_jobs SET default_bookmark='trunk', publish_ready=true
		WHERE id=$1 RETURNING default_bookmark, publish_ready`, importJobID).
		Scan(&defaultBookmark, &publishReady); err != nil {
		t.Fatal(err)
	}
	if defaultBookmark != "trunk" || !publishReady {
		t.Fatal("import publication state was not durable")
	}
	queries := db.New(pool)
	repository, err := queries.CreateRepo(ctx, db.CreateRepoParams{
		UserID: pgtype.Int8{Int64: alice, Valid: true}, Name: "secret", LowerName: "secret", DefaultBookmark: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	repo = repository.ID
	if got, err := queries.GetRepoByID(ctx, repo); err != nil || got.ID != repo {
		t.Fatalf("generated repository read: id=%d err=%v", got.ID, err)
	}
	var ownerCanRead, outsiderCanRead bool
	if err := pool.QueryRow(ctx, `SELECT can_view_repository($1, $2), can_view_repository($1, $3)`, repo, alice, bob).Scan(&ownerCanRead, &outsiderCanRead); err != nil {
		t.Fatal(err)
	}
	if !ownerCanRead || outsiderCanRead {
		t.Fatal("private repository authorization crossed owners")
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	inside := queries.WithTx(tx)
	if _, err := inside.CreateIssue(ctx, db.CreateIssueParams{RepositoryID: repo, Title: "issue", AuthorID: alice}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err := inside.CreateWikiPage(ctx, db.CreateWikiPageParams{RepositoryID: repo, Slug: "home", Title: "Home", AuthorID: alice}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err := inside.CreateLandingRequest(ctx, db.CreateLandingRequestParams{RepositoryID: repo, Title: "review", AuthorID: alice, TargetBookmark: "main"}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"issues", "wiki_pages", "landing_requests"} {
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.`+table+` WHERE repository_id=$1`, repo).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Errorf("%s survived transaction rollback", table)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE smithers_product_migrations SET checksum='changed' WHERE version=$1`, BaselineVersion); err != nil {
		t.Fatal(err)
	}
	if err := Apply(ctx, pool); !errors.Is(err, ErrChecksumMismatch) {
		t.Fatalf("changed baseline should be rejected, got %v", err)
	}
	if pending, err := Status(ctx, pool); !errors.Is(err, ErrChecksumMismatch) {
		t.Fatalf("changed baseline status: pending=%v err=%v", pending, err)
	}
	registered, err := registeredMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE smithers_product_migrations SET checksum=$1 WHERE version=$2`, registered[0].checksum, BaselineVersion); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO smithers_product_migrations(version, checksum) VALUES ($1, 'future')`, len(registered)+1); err != nil {
		t.Fatal(err)
	}
	if err := Apply(ctx, pool); !errors.Is(err, ErrUnsupportedVersion) {
		t.Fatalf("newer database should be rejected, got %v", err)
	}
}

func TestDurableProductJobsMigrationRegistered(t *testing.T) {
	content, err := migrations.ReadFile("migrations/0005_durable_product_jobs.sql")
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != jobs.SchemaSQL() {
		t.Fatal("canonical product migration and jobs schema fixture diverged")
	}
	found := false
	for _, spec := range migrationRegistry {
		if spec.version == 5 && spec.path == "migrations/0005_durable_product_jobs.sql" {
			found = true
		}
	}
	if !found {
		t.Fatal("durable jobs migration 0005 is not registered")
	}
}

func TestDurableProductJobsMigration0005(t *testing.T) {
	content, err := migrations.ReadFile("migrations/0005_durable_product_jobs.sql")
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	pool := newProductTestPool(t)
	if _, err := pool.Exec(ctx, string(content), pgx.QueryExecModeSimpleProtocol); err != nil {
		t.Fatalf("apply migration 0005: %v", err)
	}
	if _, err := pool.Exec(ctx, string(content), pgx.QueryExecModeSimpleProtocol); err == nil {
		t.Fatal("direct replay must reject an existing product table; the ledger owns replay")
	}

	store, err := jobs.NewStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	scope := jobs.Scope{TenantID: "user:1", PrincipalID: "user:1"}
	receipt, err := store.Admit(ctx, jobs.Admission{
		Scope: scope, Operation: "migration.acceptance", RequestID: "request-1",
		Payload: json.RawMessage(`{"value":1}`), AuthorizationContext: json.RawMessage(`{"owner":true}`),
		EffectPolicy: jobs.EffectReconcile,
	})
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := store.Admit(ctx, jobs.Admission{
		Scope: scope, Operation: "migration.acceptance", RequestID: "request-1",
		Payload: json.RawMessage("{\n  \"value\": 1\n}"), AuthorizationContext: json.RawMessage(`{"owner":true}`),
		EffectPolicy: jobs.EffectReconcile,
	})
	if err != nil || !duplicate.Joined || duplicate.OperationID != receipt.OperationID {
		t.Fatalf("migrated duplicate admission: receipt=%#v err=%v", duplicate, err)
	}
	claim, err := store.Claim(ctx, "migration-worker", 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	externalAttempt, err := store.BeginExternal(ctx, claim, json.RawMessage(`{"runtime":"canonical"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Checkpoint(ctx, claim, json.RawMessage(`{"runId":"run-1","cursor":"4"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE product_job_dispatches
		SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, receipt.OperationID); err != nil {
		t.Fatal(err)
	}
	if recovered, err := store.RecoverExpired(ctx, 1); err != nil || recovered != 1 {
		t.Fatalf("recover migrated claim: recovered=%d err=%v", recovered, err)
	}
	reconnected, err := store.Claim(ctx, "migration-reconnector", 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if reconnected.Generation <= claim.Generation || reconnected.ExternalAttempt != externalAttempt || reconnected.DeliveryAttempt() != externalAttempt {
		t.Fatalf("migrated recovery fence/attempt: first=%#v second=%#v", claim, reconnected)
	}
	if err := store.Complete(ctx, reconnected, json.RawMessage(`{"kind":"terminal"}`)); err != nil {
		t.Fatal(err)
	}
	operation, err := store.Get(ctx, scope, receipt.OperationID)
	if err != nil || operation.State != jobs.StateCompleted {
		t.Fatalf("migrated store operation: state=%s err=%v", operation.State, err)
	}
	page, err := store.Replay(ctx, scope, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	// A reconcile re-claim is not journaled: the expired lease already
	// recorded operation.reconciliation_required.
	if len(page.Events) < 6 || page.Events[0].Sequence != 1 || page.Events[len(page.Events)-1].State != jobs.StateCompleted {
		t.Fatalf("migrated store replay: %#v", page)
	}
	for index, event := range page.Events {
		if event.Sequence != int64(index+1) {
			t.Fatalf("migrated replay gap at %d: %#v", index, page.Events)
		}
	}
	privatePage, err := store.Replay(ctx, jobs.Scope{TenantID: "user:2", PrincipalID: "user:2"}, 0, 10)
	if err != nil || len(privatePage.Events) != 0 {
		t.Fatalf("migrated private replay isolation: page=%#v err=%v", privatePage, err)
	}
}

func TestBaselineHasNoClusterTableNames(t *testing.T) {
	baseline, err := migrations.ReadFile("migrations/0001_product_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := os.Open("../ownership.csv")
	if err != nil {
		t.Fatal(err)
	}
	defer manifest.Close()
	rows, err := csv.NewReader(manifest).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) < 2 || len(rows[0]) < 2 || rows[0][0] != "table" || rows[0][1] != "target_owner" {
		t.Fatal("invalid schema ownership manifest")
	}
	for _, row := range rows[1:] {
		if len(row) < 2 || row[1] == "product" {
			continue
		}
		if strings.Contains(string(baseline), row[0]) {
			t.Errorf("product baseline still references excluded table %s", row[0])
		}
	}
}

func TestBaselineChecksumPinned(t *testing.T) {
	const expected = "1efe40475c382694f73ff2ab3be2968596e2db08564f50ed8a1f3756d9df42b4"
	registered, err := registeredMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if len(registered) == 0 || registered[0].checksum != expected {
		t.Fatalf("baseline migration changed; add a new numbered migration instead (got %q)", registered[0].checksum)
	}
}

// Every foreign key to repositories states its delete behavior; a default
// NO ACTION key lets one dependent row block repository deletion.
func TestRepositoryForeignKeysStateDeleteBehavior(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	if err := Apply(ctx, pool); err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, `SELECT conname FROM pg_constraint
		WHERE contype='f' AND confrelid='public.repositories'::regclass AND confdeltype='a' ORDER BY conname`)
	if err != nil {
		t.Fatal(err)
	}
	blocking, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if len(blocking) != 0 {
		t.Fatalf("repository foreign keys without ON DELETE: %v", blocking)
	}
}
