// Package testdb gives every PostgreSQL test its own freshly created database
// on the one server named by SMITHERS_TEST_DATABASE_URL, so test binaries run
// in parallel without sharing, resetting, or terminating each other's state.
package testdb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	// URLEnv names the server. Its database path is only used to connect as
	// an administrator; tests never touch that database's contents.
	URLEnv = "SMITHERS_TEST_DATABASE_URL"
	// RequireEnv set to "1" turns a missing or unusable server into a failure
	// instead of a skip.
	RequireEnv = "SMITHERS_REQUIRE_DATABASE_TESTS"

	namePrefix     = "smithers_test_"
	connectBudget  = 30 * time.Second
	connectAttempt = 5 * time.Second
	// staleAge is when a database is an orphan: a panic or a killed test
	// process skipped its drop. Names carry their creation time.
	staleAge = 6 * time.Hour
)

// ServerURL returns the configured server URL, or "" when none is set.
func ServerURL() string { return strings.TrimSpace(os.Getenv(URLEnv)) }

// Required reports whether database tests must run.
func Required() bool { return os.Getenv(RequireEnv) == "1" }

// Unavailable skips the test, or fails it when database tests are required.
func Unavailable(t testing.TB, reason error) {
	t.Helper()
	if Required() {
		t.Fatalf("PostgreSQL tests are required: %v", reason)
	}
	t.Skipf("PostgreSQL tests skipped: %v", reason)
}

// ErrNotConfigured reports that no server URL is set.
var ErrNotConfigured = errors.New(URLEnv + " is not set")

// Database is one isolated database. Drop removes it.
type Database struct {
	// URL connects to the database itself.
	URL   string
	Name  string
	admin string
}

// Create makes an empty, uniquely named database on the server at serverURL.
// It needs no *testing.T, so a TestMain can share one database across a test
// binary.
func Create(ctx context.Context, serverURL string) (*Database, error) {
	return CreateFromTemplate(ctx, serverURL, "template0")
}

// CreateFromTemplate clones a disconnected test database. The template must
// have no open connections while PostgreSQL copies it.
func CreateFromTemplate(ctx context.Context, serverURL, template string) (*Database, error) {
	if serverURL == "" {
		return nil, ErrNotConfigured
	}
	if template == "" {
		return nil, errors.New("test database template is empty")
	}
	parsed, err := url.Parse(serverURL)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", URLEnv, err)
	}
	name, err := databaseName(time.Now())
	if err != nil {
		return nil, err
	}
	admin, err := connect(ctx, parsed.String())
	if err != nil {
		return nil, err
	}
	defer admin.Close(context.WithoutCancel(ctx))
	sweepOnce.Do(func() { sweepStale(ctx, admin, time.Now()) })
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" TEMPLATE "+pgx.Identifier{template}.Sanitize()+" ENCODING 'UTF8'"); err != nil {
		return nil, fmt.Errorf("create test database: %w", err)
	}
	target := *parsed
	target.Path = "/" + name
	return &Database{URL: target.String(), Name: name, admin: parsed.String()}, nil
}

// Drop removes the database, ending any sessions still connected to it.
func (d *Database) Drop(ctx context.Context) error {
	admin, err := connect(ctx, d.admin)
	if err != nil {
		return err
	}
	defer admin.Close(context.WithoutCancel(ctx))
	if _, err := admin.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{d.Name}.Sanitize()+" WITH (FORCE)"); err != nil {
		return fmt.Errorf("drop test database %s: %w", d.Name, err)
	}
	return nil
}

// New returns an empty database that exists for the duration of
// the test. Without a server the test is skipped, or fails when required.
func New(t testing.TB) *Database {
	return NewFromTemplate(t, "template0")
}

// NewFromTemplate clones a disconnected database for one test and drops the
// clone during that test's cleanup.
func NewFromTemplate(t testing.TB, template string) *Database {
	t.Helper()
	if testing.Short() {
		t.Skip("PostgreSQL tests skipped in short mode")
	}
	serverURL := ServerURL()
	if serverURL == "" {
		Unavailable(t, ErrNotConfigured)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	database, err := CreateFromTemplate(ctx, serverURL, template)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer dropCancel()
		if err := database.Drop(dropCtx); err != nil {
			t.Errorf("%v", err)
		}
	})
	return database
}

func databaseName(now time.Time) (string, error) {
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s%d_%s", namePrefix, now.Unix(), hex.EncodeToString(suffix[:])), nil
}

func databaseCreated(name string) (time.Time, bool) {
	rest, ok := strings.CutPrefix(name, namePrefix)
	if !ok {
		return time.Time{}, false
	}
	stamp, _, ok := strings.Cut(rest, "_")
	if !ok {
		return time.Time{}, false
	}
	seconds, err := strconv.ParseInt(stamp, 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.Unix(seconds, 0), true
}

var sweepOnce sync.Once

// sweepStale drops orphaned test databases. Only names older than staleAge
// are touched, so concurrent runs keep theirs. Failures are ignored: the
// next run retries.
func sweepStale(ctx context.Context, admin *pgx.Conn, now time.Time) {
	rows, err := admin.Query(ctx, `SELECT datname FROM pg_database WHERE starts_with(datname, $1)`, namePrefix)
	if err != nil {
		return
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return
	}
	for _, name := range names {
		if created, ok := databaseCreated(name); ok && now.Sub(created) > staleAge {
			_, _ = admin.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
		}
	}
}

// connect retries briefly so a server that is still starting, or a port
// forward's first connection, does not fail the setup.
func connect(ctx context.Context, raw string) (*pgx.Conn, error) {
	deadline := time.Now().Add(connectBudget)
	for {
		attemptCtx, cancel := context.WithTimeout(ctx, connectAttempt)
		conn, err := pgx.Connect(attemptCtx, raw)
		cancel()
		if err == nil {
			return conn, nil
		}
		var pgErr interface{ SQLState() string }
		if errors.As(err, &pgErr) || ctx.Err() != nil || time.Now().After(deadline) {
			return nil, fmt.Errorf("connect to PostgreSQL test server: %w", err)
		}
		time.Sleep(250 * time.Millisecond)
	}
}
