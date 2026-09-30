package flowhost

import (
	"context"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// JournalDatabase is the PostgreSQL database a flow host keeps its control
// and engine journals in (#2099). Each workspace gets its own database, owned
// by its own login role, on the backend's server: the host shares its
// workspace with repository commands, so the credential it holds reaches only
// that workspace's journals, never the backend's database (#2175).
type JournalDatabase struct {
	// Name is the workspace's database and role name. It is not secret.
	Name string
	// URL is the host-reachable connection string with the workspace role's
	// credential. It is minted for every inspect and start and is never part
	// of the service identity.
	URL string
	// Schema prefixes the schema of each store the host opens
	// (SMITHERS_POSTGRES_SCHEMA).
	Schema string
}

// JournalSchema prefixes every store schema inside a workspace's journal
// database: the host's control.db and engine.db become flows_control_db and
// flows_engine_db.
const JournalSchema = "flows"

// journalConnectionLimit bounds how many connections one workspace's host may
// hold, so one repository cannot exhaust the server's connections.
const journalConnectionLimit = 32

// journalTransportParameters are the only query parameters a journal URL
// carries. Any other (user, password, dbname, host, options, schema) could
// replace the workspace's own role or database in the host's driver.
var journalTransportParameters = []string{"application_name", "connect_timeout", "sslmode", "sslrootcert"}

func journalTransportOnly(query url.Values) bool {
	for name := range query {
		if !slices.Contains(journalTransportParameters, name) {
			return false
		}
	}
	return true
}

// JournalDatabaseName is a workspace's journal database and role name.
func JournalDatabaseName(workspaceID string) (string, error) {
	parsed, err := uuid.Parse(workspaceID)
	if err != nil || parsed.String() != workspaceID {
		return "", errors.New("journal database needs a canonical workspace id")
	}
	return "smithers_flows_" + strings.ReplaceAll(workspaceID, "-", ""), nil
}

// identity is the journal's part of the host's service identity: where the
// host connects and to which database, never the credential. A SQLite host
// has none.
func (journal JournalDatabase) identity() string {
	if journal == (JournalDatabase{}) {
		return ""
	}
	endpoint, err := url.Parse(journal.URL)
	if err != nil {
		return journal.Name
	}
	endpoint.User = nil
	return endpoint.String() + "#" + journal.Schema
}

// environment is what BuildProcessSpec gives the host for its journal: the
// shared Node/Bun database adapter selects PostgreSQL from exactly these.
func (journal JournalDatabase) environment(workspaceID string) (map[string]string, error) {
	if journal == (JournalDatabase{}) {
		return nil, nil
	}
	if name, err := JournalDatabaseName(workspaceID); err != nil || journal.Name != name || journal.Schema != JournalSchema {
		return nil, errors.New("flow host journal database belongs to another workspace")
	}
	parsed, err := url.Parse(journal.URL)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Host == "" ||
		parsed.User == nil || parsed.User.Username() != journal.Name || parsed.Path != "/"+journal.Name {
		return nil, errors.New("flow host journal database URL must name the workspace's own role and database")
	}
	if password, ok := parsed.User.Password(); !ok || password == "" {
		return nil, errors.New("flow host journal database URL has no credential")
	}
	if !journalTransportOnly(parsed.Query()) {
		return nil, errors.New("flow host journal database URL may carry only transport parameters")
	}
	return map[string]string{"SMITHERS_POSTGRES_URL": journal.URL, "SMITHERS_POSTGRES_SCHEMA": journal.Schema}, nil
}

// PostgresJournals provisions per-workspace journal databases on the
// backend's PostgreSQL server. The backend's role needs CREATEROLE and
// CREATEDB (or superuser); every workspace role it creates has neither.
type PostgresJournals struct {
	pool    *pgxpool.Pool
	address *url.URL
	key     []byte
}

// NewPostgresJournals keeps journals on pool's server. address is how a flow
// host reaches that server (a microVM guest may need a different host than the
// backend); its user, password and database are always replaced. key derives
// each workspace role's password, so every backend replica mints the same
// credential and a live host keeps reconnecting across a restart.
//
// A workspace role must not open the backend's own database, so the backend
// database's PUBLIC CONNECT grant is revoked here; when the backend cannot do
// that (it does not own the database) every provision is refused instead.
func NewPostgresJournals(ctx context.Context, pool *pgxpool.Pool, address string, key []byte) (*PostgresJournals, error) {
	if pool == nil || len(key) < 32 {
		return nil, errors.New("flow journals need the backend pool and a 32-byte key")
	}
	parsed, err := url.Parse(strings.TrimSpace(address))
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Host == "" {
		return nil, errors.New("flow journal address must be a postgres:// URL with a host")
	}
	if !journalTransportOnly(parsed.Query()) {
		return nil, errors.New("flow journal address may carry only transport parameters: " + strings.Join(journalTransportParameters, ", "))
	}
	parsed.RawQuery, parsed.User, parsed.Path, parsed.RawPath, parsed.Fragment = parsed.Query().Encode(), nil, "", "", ""
	var database string
	if err = pool.QueryRow(ctx, `SELECT current_database()`).Scan(&database); err != nil {
		return nil, fmt.Errorf("flow journals: %w", err)
	}
	// Best effort: a backend that does not own its database is refused per
	// provision by the connect check, with the remedy in the error.
	_, _ = pool.Exec(ctx, "REVOKE CONNECT, TEMPORARY ON DATABASE "+pgx.Identifier{database}.Sanitize()+" FROM PUBLIC")
	return &PostgresJournals{pool: pool, address: parsed, key: append([]byte(nil), key...)}, nil
}

// Describe answers a workspace's journal without touching the server, for
// inspecting a live host whose database already exists.
func (journals *PostgresJournals) Describe(workspaceID string) (JournalDatabase, error) {
	name, err := JournalDatabaseName(workspaceID)
	if err != nil {
		return JournalDatabase{}, err
	}
	address := *journals.address
	address.User = url.UserPassword(name, journals.password(name))
	address.Path = "/" + name
	return JournalDatabase{Name: name, URL: address.String(), Schema: JournalSchema}, nil
}

func (journals *PostgresJournals) password(name string) string {
	mac := hmac.New(sha256.New, journals.key)
	mac.Write([]byte("smithers flow journal role v1\x00" + name))
	return hex.EncodeToString(mac.Sum(nil))
}

// Provision creates or repairs a workspace's journal role and database before
// its host starts. It is idempotent and serialized per workspace across
// backend replicas.
func (journals *PostgresJournals) Provision(ctx context.Context, workspaceID string) (_ JournalDatabase, err error) {
	journal, err := journals.Describe(workspaceID)
	if err != nil {
		return JournalDatabase{}, err
	}
	conn, err := journals.pool.Acquire(ctx)
	if err != nil {
		return JournalDatabase{}, err
	}
	defer conn.Release()
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1, 2099))`, journal.Name); err != nil {
		return JournalDatabase{}, err
	}
	defer func() {
		if _, unlock := conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock(hashtextextended($1, 2099))`, journal.Name); unlock != nil {
			conn.Conn().Close(context.WithoutCancel(ctx)) // closing the session releases the lock
		}
	}()
	verifier, err := scramVerifier(journals.password(journal.Name))
	if err != nil {
		return JournalDatabase{}, err
	}
	role := pgx.Identifier{journal.Name}.Sanitize()
	// The verifier, not the password, reaches the server, so statement logs
	// never hold the credential.
	// Only a superuser may set SUPERUSER, REPLICATION or BYPASSRLS, so a
	// CREATEROLE backend names just the rest; the check below refuses a role
	// that holds any of them.
	attributes := fmt.Sprintf("LOGIN NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT %d PASSWORD '%s'",
		journalConnectionLimit, verifier)
	var exists bool
	if err = conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)`, journal.Name).Scan(&exists); err != nil {
		return JournalDatabase{}, err
	}
	if exists {
		_, err = conn.Exec(ctx, "ALTER ROLE "+role+" WITH "+attributes)
	} else {
		_, err = conn.Exec(ctx, "CREATE ROLE "+role+" WITH "+attributes)
	}
	if err != nil {
		return JournalDatabase{}, fmt.Errorf("flow journal role: %w", err)
	}
	if err = conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, journal.Name).Scan(&exists); err != nil {
		return JournalDatabase{}, err
	}
	// CREATE DATABASE ... OWNER and acting as the owner need SET on the
	// role; a CREATEROLE backend holds only ADMIN on the roles it creates.
	// INHERIT FALSE keeps the backend from holding the workspace's privileges.
	if _, err = conn.Exec(ctx, "GRANT "+role+" TO CURRENT_USER WITH INHERIT FALSE, SET TRUE"); err != nil {
		return JournalDatabase{}, fmt.Errorf("flow journal role membership: %w", err)
	}
	// A new database refuses connections until PUBLIC's default CONNECT is
	// revoked, so no other workspace's role can open a session in between.
	if !exists {
		if _, err = conn.Exec(ctx, "CREATE DATABASE "+role+" OWNER "+role+" ENCODING 'UTF8' TEMPLATE template0 ALLOW_CONNECTIONS false"); err != nil {
			return JournalDatabase{}, fmt.Errorf("flow journal database: %w", err)
		}
	}
	// Only the owner's revoke removes PUBLIC's grant.
	if err = pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SET LOCAL ROLE "+role); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "REVOKE ALL ON DATABASE "+role+" FROM PUBLIC"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, "ALTER DATABASE "+role+" WITH ALLOW_CONNECTIONS true")
		return err
	}); err != nil {
		return JournalDatabase{}, fmt.Errorf("flow journal database grants: %w", err)
	}
	var elevated, reachesBackend bool
	if err = conn.QueryRow(ctx, `SELECT r.rolsuper OR r.rolreplication OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole,
			has_database_privilege(r.rolname, current_database(), 'CONNECT')
		FROM pg_roles r WHERE r.rolname = $1`, journal.Name).Scan(&elevated, &reachesBackend); err != nil {
		return JournalDatabase{}, err
	}
	switch {
	case elevated:
		return JournalDatabase{}, errors.New("flow journal role holds a server privilege; remove it before the host starts")
	case reachesBackend:
		return JournalDatabase{}, errors.New("flow journal role could connect to the backend database; revoke CONNECT on it from PUBLIC")
	}
	return journal, nil
}

// scramVerifier is PostgreSQL's SCRAM-SHA-256 stored form of a password
// (RFC 5802/7677), as pg_authid keeps it.
func scramVerifier(password string) (string, error) {
	const iterations = 4096
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	salted, err := pbkdf2.Key(sha256.New, password, salt, iterations, sha256.Size)
	if err != nil {
		return "", err
	}
	keyed := func(message string) []byte {
		mac := hmac.New(sha256.New, salted)
		mac.Write([]byte(message))
		return mac.Sum(nil)
	}
	stored := sha256.Sum256(keyed("Client Key"))
	encode := base64.StdEncoding.EncodeToString
	return fmt.Sprintf("SCRAM-SHA-256$%d:%s$%s:%s", iterations, encode(salt), encode(stored[:]), encode(keyed("Server Key"))), nil
}
