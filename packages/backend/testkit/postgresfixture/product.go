// Package postgresfixture opens product-schema databases for tests. Every
// database is created fresh through testdb and dropped afterwards.
package postgresfixture

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/database"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

const setupTimeout = 2 * time.Minute

// NewProductDatabase creates an isolated database with the product schema
// that exists for the duration of the test. An optional capacity matches the
// composition under test; absent it, pgx uses its default pool size.
func NewProductDatabase(t testing.TB, maxConnections ...int32) (*pgxpool.Pool, string) {
	t.Helper()
	db := testdb.New(t)
	ctx, cancel := context.WithTimeout(context.Background(), setupTimeout)
	defer cancel()
	var capacity int32
	if len(maxConnections) > 0 {
		capacity = maxConnections[0]
	}
	pool, err := Open(ctx, db.URL, capacity)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := product.Apply(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool, db.URL
}

// Open connects a pool that decodes the product's SQL types. maxConns 0 keeps
// the pgxpool default.
func Open(ctx context.Context, raw string, maxConns int32) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(raw)
	if err != nil {
		return nil, err
	}
	if maxConns > 0 {
		config.MaxConns = maxConns
	}
	config.AfterConnect = func(_ context.Context, conn *pgx.Conn) error {
		database.ConfigureSQLCTypes(conn.TypeMap())
		return nil
	}
	return pgxpool.NewWithConfig(ctx, config)
}

// Suite is the database one test binary shares. TestMain calls Run; tests
// call Pool or URL.
type Suite struct {
	// Empty skips the product schema for suites that migrate their own.
	Empty bool
	// MaxConns sizes the shared pool; 0 keeps the pgxpool default.
	MaxConns int32
	// Whole marks a binary whose every test needs the database: without one
	// it runs no tests and reports the skip, or fails when required.
	Whole bool

	db   *testdb.Database
	pool *pgxpool.Pool
	err  error
}

// Run creates the database, applies setup, runs the tests, and drops the
// database. When the server is missing or unusable the tests skip, or the
// binary fails when database tests are required.
func (s *Suite) Run(m *testing.M, setup ...func(context.Context, *pgxpool.Pool) error) int {
	if !flag.Parsed() {
		flag.Parse() // testing.Short reads the parsed -test.short flag.
	}
	if testing.Short() {
		s.err = errors.New("short mode")
		if s.Whole {
			fmt.Println("skipping all tests: PostgreSQL tests skipped in short mode")
			return 0
		}
		return m.Run()
	}
	s.err = s.open(setup)
	if s.err != nil && testdb.Required() {
		fmt.Fprintf(os.Stderr, "PostgreSQL tests are required: %v\n", s.err)
		return 1
	}
	if s.err != nil && s.Whole {
		fmt.Printf("skipping all tests: PostgreSQL unavailable: %v\n", s.err)
		return 0
	}
	code := m.Run()
	if closeErr := s.close(); closeErr != nil {
		fmt.Fprintln(os.Stderr, closeErr)
		if code == 0 {
			code = 1
		}
	}
	return code
}

func (s *Suite) open(setup []func(context.Context, *pgxpool.Pool) error) error {
	ctx, cancel := context.WithTimeout(context.Background(), setupTimeout)
	defer cancel()
	db, err := testdb.Create(ctx, testdb.ServerURL())
	if err != nil {
		return err
	}
	s.db = db
	pool, err := Open(ctx, db.URL, s.MaxConns)
	if err == nil && !s.Empty {
		err = product.Apply(ctx, pool)
	}
	for _, step := range setup {
		if err != nil {
			break
		}
		err = step(ctx, pool)
	}
	if err != nil {
		if pool != nil {
			pool.Close()
		}
		_ = s.close()
		return err
	}
	s.pool = pool
	return nil
}

func (s *Suite) close() error {
	if s.pool != nil {
		s.pool.Close()
		s.pool = nil
	}
	if s.db == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), setupTimeout)
	defer cancel()
	err := s.db.Drop(ctx)
	s.db = nil
	return err
}

// Pool returns the shared pool, skipping the test (or failing it when
// required) if the database is unavailable.
func (s *Suite) Pool(t testing.TB) *pgxpool.Pool {
	t.Helper()
	if s.pool == nil {
		if testing.Short() {
			t.Skip("PostgreSQL tests skipped in short mode")
		}
		reason := s.err
		if reason == nil {
			reason = errors.New("suite database was not opened by TestMain")
		}
		testdb.Unavailable(t, reason)
	}
	return s.pool
}

// URL returns the shared database's URL, with the same availability rules as
// Pool.
func (s *Suite) URL(t testing.TB) string {
	t.Helper()
	s.Pool(t)
	return s.db.URL
}
