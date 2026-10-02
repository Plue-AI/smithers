package repository_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// This test uses a fresh product-only PostgreSQL database and the real jj FFI.
// A reservation is committed, the service is lost, and another service finishes
// the exact same operation without making a second row or repository.
func TestProductRepositoryCreationSurvivesCrashes(t *testing.T) {
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if ffi == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	pool, _ := postgresfixture.NewProductDatabase(t)
	owner := createProductProvisionUser(t, ctx, pool, "owner")
	forker := createProductProvisionUser(t, ctx, pool, "forker")
	storage := t.TempDir()
	local := openProductProvisionLocal(t, storage, ffi)
	defer func() { _ = local.Shutdown(context.Background()) }()
	service := services.NewProductRepoServiceWithPool(db.New(pool), local.Client(), pool)

	source, err := service.CreateRepo(ctx, &owner, "source", "base", true, "main", true)
	if err != nil {
		t.Fatalf("create source: %v", err)
	}
	if source.ID == 0 {
		t.Fatal("source has no persisted id")
	}
	assertNoProductCreationJobs(t, ctx, pool)
	// A destination occupied outside this reservation is never deleted during
	// conflict cleanup, and the failed reservation no longer blocks retries.
	occupied := filepath.Join(storage, owner.Username, "occupied")
	if err := os.MkdirAll(occupied, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(occupied, "unrelated")
	if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateRepo(ctx, &owner, "occupied", "", true, "main", false); err == nil {
		t.Fatal("occupied path was accepted")
	}
	if contents, err := os.ReadFile(marker); err != nil || string(contents) != "keep" {
		t.Fatalf("unrelated path changed: %q, %v", contents, err)
	}
	assertNoProductCreationJobs(t, ctx, pool)
	var orgID int64
	orgName := fmt.Sprintf("org%d", time.Now().UnixNano())
	if err := pool.QueryRow(ctx, `INSERT INTO organizations(name,lower_name) VALUES($1,$1) RETURNING id`, orgName).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO org_members(organization_id,user_id,role) VALUES($1,$2,'owner')`, orgID, owner.ID); err != nil {
		t.Fatal(err)
	}
	orgRepo, err := service.CreateOrgRepo(ctx, &owner, orgName, "team", "", true, "main", false)
	if err != nil || !orgRepo.OrgID.Valid || orgRepo.OrgID.Int64 != orgID {
		t.Fatalf("create org repository: %+v, %v", orgRepo, err)
	}
	assertNoProductCreationJobs(t, ctx, pool)
	// An exact HTTP retry adopts the pre-crash reservation and its token.
	retryID := insertProductCreationJob(t, ctx, pool, local, owner, "exact-retry", false, "")
	if _, err := pool.Exec(ctx, `UPDATE repository_creation_jobs SET is_public=false WHERE repository_id=$1`, retryID); err != nil {
		t.Fatal(err)
	}
	deniedBilling := &denyingPrivateRepoPolicy{}
	service = services.NewProductRepoServiceWithPool(db.New(pool), local.Client(), pool,
		services.WithRepoBillingPolicy(deniedBilling))
	retried, err := service.CreateRepo(ctx, &owner, "exact-retry", "", false, "main", false)
	if err != nil || retried.ID != retryID {
		t.Fatalf("exact retry: id=%d want=%d err=%v", retried.ID, retryID, err)
	}
	if deniedBilling.calls != 0 {
		t.Fatalf("exact reservation retry was billed %d times", deniedBilling.calls)
	}
	service = services.NewProductRepoServiceWithPool(db.New(pool), local.Client(), pool)
	assertNoProductCreationJobs(t, ctx, pool)

	// Crash 1: only the database reservation has committed. The pending name
	// is fenced from unrelated repository inserts until a new process resumes.
	reserved := insertProductCreationJob(t, ctx, pool, local, owner, "after-reserve", false, "")
	if _, err := pool.Exec(ctx, `INSERT INTO repositories(user_id,name,lower_name)
		VALUES($1,'after-reserve','after-reserve')`, owner.ID); err == nil {
		t.Fatal("unrelated insert bypassed pending namespace reservation")
	}
	if err := local.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	local = openProductProvisionLocal(t, storage, ffi)
	service = services.NewProductRepoServiceWithPool(db.New(pool), local.Client(), pool)
	if err := service.ReconcileProductRepositoryCreates(ctx); err != nil {
		t.Fatal(err)
	}
	assertProductRepoID(t, ctx, pool, owner.ID, "after-reserve", reserved)
	assertNoProductCreationJobs(t, ctx, pool)
	// Crash 3: the database row was committed, but the staging receipt was
	// still present. Recovery must finalize it without building another repo.
	afterRow := insertProductCreationJob(t, ctx, pool, local, owner, "after-row", false, "")
	var afterRowToken string
	if err := pool.QueryRow(ctx, `SELECT token FROM repository_creation_jobs WHERE repository_id=$1`, afterRow).Scan(&afterRowToken); err != nil {
		t.Fatal(err)
	}
	stagedRow := repository.StagedProvision{StorageSetID: "local", Token: afterRowToken, OperationType: "init", Owner: owner.Username, Repo: "after-row", DefaultBookmark: "main"}
	if err := local.Client().ExecuteStagedProvision(ctx, stagedRow); err != nil {
		t.Fatal(err)
	}
	if err := local.Client().PublishStagedProvision(ctx, stagedRow); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('smithers.product_repository_creation_token',$1,true)`, afterRowToken); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO repositories(id,user_id,name,lower_name,description,is_public,default_bookmark)
		VALUES($1,$2,'after-row','after-row','',true,'main')`, afterRow, owner.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM repositories WHERE id=$1`, afterRow); err == nil {
		t.Fatal("pending creation allowed repository deletion")
	}
	if _, err := pool.Exec(ctx, `UPDATE repositories SET user_id=$2 WHERE id=$1`, afterRow, forker.ID); err == nil {
		t.Fatal("pending creation allowed ownership transfer")
	}
	if err := service.ReconcileProductRepositoryCreates(ctx); err != nil {
		t.Fatal(err)
	}
	assertProductRepoID(t, ctx, pool, owner.ID, "after-row", afterRow)
	assertNoProductCreationJobs(t, ctx, pool)

	// Crash 2: jj storage was published, but the SQL repository row was not.
	// The new service adopts the same reserved ID and finalizes the stage.
	stagedFork := insertProductCreationJob(t, ctx, pool, local, forker, "after-publish", true, fmt.Sprintf("%d:%s:%s", source.ID, owner.Username, source.Name))
	stage, err := local.Client().PrepareStagedFork(ctx, "local", owner.Username, source.Name, forker.Username, "after-publish")
	if err != nil {
		t.Fatal(err)
	}
	// The reservation token must be the token the staged storage recognizes.
	if _, err := pool.Exec(ctx, `UPDATE repository_creation_jobs SET token=$2 WHERE repository_id=$1`, stagedFork, stage.Token); err != nil {
		t.Fatal(err)
	}
	if err := local.Client().ExecuteStagedProvision(ctx, stage); err != nil {
		t.Fatal(err)
	}
	if err := local.Client().PublishStagedProvision(ctx, stage); err != nil {
		t.Fatal(err)
	}
	if err := local.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	local = openProductProvisionLocal(t, storage, ffi)
	service = services.NewProductRepoServiceWithPool(db.New(pool), local.Client(), pool)
	if err := service.ReconcileProductRepositoryCreates(ctx); err != nil {
		t.Fatal(err)
	}
	assertProductRepoID(t, ctx, pool, forker.ID, "after-publish", stagedFork)
	var forkID int64
	if err := pool.QueryRow(ctx, `SELECT fork_id FROM repositories WHERE id=$1`, stagedFork).Scan(&forkID); err != nil || forkID != source.ID {
		t.Fatalf("recovered fork source = %d, err=%v", forkID, err)
	}
	assertNoProductCreationJobs(t, ctx, pool)
}

type denyingPrivateRepoPolicy struct {
	services.BillingPolicy
	calls int
}

func (p *denyingPrivateRepoPolicy) AuthorizePrivateRepo(context.Context, string, int64) error {
	p.calls++
	return fmt.Errorf("private repository quota exceeded")
}

func createProductProvisionUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, prefix string) db.User {
	t.Helper()
	name := fmt.Sprintf("%s%d", prefix, time.Now().UnixNano())
	var id int64
	if err := pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email)
		VALUES($1,$1,$2,$2) RETURNING id`, name, name+"@example.invalid").Scan(&id); err != nil {
		t.Fatal(err)
	}
	user, err := db.New(pool).GetUserByID(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func openProductProvisionLocal(t *testing.T, storage, ffi string) *repository.Local {
	t.Helper()
	local, err := repository.OpenLocal(repository.Config{StoragePath: storage, AuthToken: "product-provision-test", FFILibraryPath: ffi})
	if err != nil {
		t.Fatal(err)
	}
	return local
}

func insertProductCreationJob(t *testing.T, ctx context.Context, pool *pgxpool.Pool, local *repository.Local, owner db.User, name string, fork bool, source string) int64 {
	t.Helper()
	var stage repository.StagedProvision
	var err error
	operation := "init"
	var sourceID any
	var sourceOwner, sourceRepo any
	if fork {
		parts := strings.SplitN(source, ":", 3)
		if len(parts) != 3 {
			t.Fatal("invalid fork source fixture")
		}
		var id int64
		if _, err := fmt.Sscan(parts[0], &id); err != nil {
			t.Fatal(err)
		}
		sourceID, sourceOwner, sourceRepo = id, parts[1], parts[2]
		operation = "fork"
		stage, err = local.Client().PrepareStagedFork(ctx, "local", parts[1], parts[2], owner.Username, name)
	} else {
		stage, err = local.Client().PrepareStagedInit(ctx, "local", owner.Username, name, "main", false)
	}
	if err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := pool.QueryRow(ctx, `SELECT nextval(pg_get_serial_sequence('public.repositories','id'))`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO repository_creation_jobs
		(repository_id,token,operation_type,actor_id,user_id,owner_name,name,lower_name,description,is_public,default_bookmark,auto_init,source_repository_id,source_owner,source_repo)
		VALUES($1,$2,$3,$4,$4,$5,$6,$6,'',true,'main',false,$7,$8,$9)`,
		id, stage.Token, operation, owner.ID, owner.Username, name, sourceID, sourceOwner, sourceRepo)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func assertNoProductCreationJobs(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM repository_creation_jobs`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("unfinished repository creations = %d", count)
	}
}

func assertProductRepoID(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64, name string, want int64) {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx, `SELECT id FROM repositories WHERE user_id=$1 AND lower_name=$2`, userID, name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if id != want {
		t.Fatalf("recovered repository id = %d, want reserved %d", id, want)
	}
}
