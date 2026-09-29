package services

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

type productDatabaseTemplate struct {
	sync.Once
	db          *testdb.Database
	drop        func(context.Context, *testdb.Database) error
	unavailable error
	err         error
}

var productTestTemplate productDatabaseTemplate

func (template *productDatabaseTemplate) prepare(ctx context.Context, migrate func(context.Context, *pgxpool.Pool) error) {
	template.Do(func() {
		database, err := testdb.Create(ctx, testdb.ServerURL())
		if err != nil {
			template.unavailable = err
			return
		}
		pool, err := postgresfixture.Open(ctx, database.URL, 0)
		if err == nil {
			err = migrate(ctx, pool)
		}
		if pool != nil {
			pool.Close()
		}
		if err != nil {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 2*time.Minute)
			drop := template.drop
			if drop == nil {
				drop = func(ctx context.Context, db *testdb.Database) error { return db.Drop(ctx) }
			}
			cleanupErr := drop(cleanupCtx, database)
			cleanupCancel()
			if cleanupErr != nil {
				template.db = database // TestMain retries cleanup.
			}
			template.err = errors.Join(err, cleanupErr)
			return
		}
		template.db = database
	})
}

func productTemplateName(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("PostgreSQL tests skipped in short mode")
	}
	if testdb.ServerURL() == "" {
		testdb.Unavailable(t, testdb.ErrNotConfigured)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	productTestTemplate.prepare(ctx, product.Apply)
	if productTestTemplate.unavailable != nil {
		testdb.Unavailable(t, fmt.Errorf("prepare product test template: %w", productTestTemplate.unavailable))
	}
	if productTestTemplate.err != nil {
		t.Fatalf("prepare product test template: %v", productTestTemplate.err)
	}
	return productTestTemplate.db.Name
}

func (template *productDatabaseTemplate) close() error {
	if template.db == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := template.db.Drop(ctx); err != nil {
		return err
	}
	template.db = nil
	return nil
}

func closeProductTestTemplate() error {
	return productTestTemplate.close()
}

// newProductTestPool clones the migrated product schema into an isolated
// database. Migration runs once per test binary, even across wiki cases.
func newProductTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	database := testdb.NewFromTemplate(t, productTemplateName(t))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool, err := postgresfixture.Open(ctx, database.URL, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestProductTestPoolClonesFreshSchema(t *testing.T) {
	first := newProductTestPool(t)
	_, err := first.Exec(context.Background(), `INSERT INTO users(username, lower_username) VALUES ('fixture-isolation', 'fixture-isolation')`)
	require.NoError(t, err)
	second := newProductTestPool(t)
	var count int
	require.NoError(t, second.QueryRow(context.Background(), `SELECT count(*) FROM users WHERE lower_username = 'fixture-isolation'`).Scan(&count))
	require.Zero(t, count)
}

func TestProductTestTemplateMigrationFailureIsFatalAndCleansUp(t *testing.T) {
	servicesSuite.Pool(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var template productDatabaseTemplate
	template.prepare(ctx, func(context.Context, *pgxpool.Pool) error {
		cancel() // The migration deadline expires before cleanup begins.
		return errors.New("migration failed")
	})
	require.Nil(t, template.unavailable, "migration errors must fail the test, even when a database is optional")
	require.ErrorContains(t, template.err, "migration failed")
	require.Nil(t, template.db, "cleanup must use a fresh context after migration cancellation")
}

func TestProductTestTemplateRetriesFailedCleanup(t *testing.T) {
	servicesSuite.Pool(t)
	var template productDatabaseTemplate
	template.drop = func(context.Context, *testdb.Database) error { return errors.New("drop unavailable") }
	template.prepare(context.Background(), func(context.Context, *pgxpool.Pool) error {
		return errors.New("migration failed")
	})
	require.ErrorContains(t, template.err, "drop unavailable")
	require.NotNil(t, template.db, "failed cleanup must retain the database for TestMain")
	require.NoError(t, template.close())
	require.Nil(t, template.db)
}
