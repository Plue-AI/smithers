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
	"regexp"
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

// journalNamePattern is the whole journal naming scheme: a name outside it is
// never a workspace's journal, so it is never listed or dropped.
var journalNamePattern = regexp.MustCompile(`^smithers_flows_([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$`)

// JournalWorkspaceID is the workspace a journal database or role name belongs
// to. It refuses every name JournalDatabaseName could not have produced.
func JournalWorkspaceID(name string) (string, error) {
	parts := journalNamePattern.FindStringSubmatch(name)
	if parts == nil {
		return "", errors.New("not a flow journal name")
	}
	workspaceID := strings.Join(parts[1:], "-")
	if derived, err := JournalDatabaseName(workspaceID); err != nil || derived != name {
		return "", errors.New("not a flow journal name")
	}
	return workspaceID, nil
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

// PostgresJournals provisions and drops per-workspace journal databases on
// the backend's PostgreSQL server. The backend's role needs CREATEROLE and
// CREATEDB (or superuser); every workspace role it creates has neither.
type PostgresJournals struct {
	pool    *pgxpool.Pool
	address *url.URL
	key     []byte
	// tag marks each journal role this backend provisions (#3172).
	tag string
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
	return &PostgresJournals{pool: pool, address: parsed, key: append([]byte(nil), key...), tag: journalTag(database)}, nil
}

func journalTag(database string) string { return "smithers flow journal of database " + database }

// JournalKey derives the key that mints journal role passwords from the
// operator key, so rotating the operator key rotates every journal password.
func JournalKey(operatorKey string) []byte {
	key := sha256.Sum256([]byte("smithers flow journal key v1\x00" + operatorKey))
	return key[:]
}

// ResealJournalPasswords sets every journal role this backend's database
// provisioned to the password operatorKey derives, so after an operator key
// rotation the passwords the replaced key derived no longer sign in. Sessions
// already open stay open; a host restarted afterwards gets the new password.
// It needs no journal address: the backend with no journals configured finds
// no roles. Each role is updated under the lock Provision and Drop share.
func ResealJournalPasswords(ctx context.Context, pool *pgxpool.Pool, operatorKey string) (int, error) {
	if pool == nil || operatorKey == "" {
		return 0, errors.New("flow journal passwords need the backend pool and the operator key")
	}
	var database string
	if err := pool.QueryRow(ctx, `SELECT current_database()`).Scan(&database); err != nil {
		return 0, fmt.Errorf("flow journals: %w", err)
	}
	journals := &PostgresJournals{pool: pool, key: JournalKey(operatorKey), tag: journalTag(database)}
	workspaces, err := journals.Workspaces(ctx)
	if err != nil {
		return 0, fmt.Errorf("flow journals: %w", err)
	}
	resealed := 0
	for _, workspaceID := range workspaces {
		changed, err := journals.resealPassword(ctx, workspaceID)
		if err != nil {
			return resealed, err
		}
		if changed {
			resealed++
		}
	}
	return resealed, nil
}

// resealPassword sets one journal role's password; a role dropped since it
// was listed is skipped.
func (journals *PostgresJournals) resealPassword(ctx context.Context, workspaceID string) (bool, error) {
	name, err := JournalDatabaseName(workspaceID)
	if err != nil {
		return false, err
	}
	conn, release, err := journals.lockJournal(ctx, name)
	if err != nil {
		return false, err
	}
	defer release()
	var exists bool
	if err = conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)`, name).Scan(&exists); err != nil || !exists {
		return false, err
	}
	verifier, err := scramVerifier(journals.password(name))
	if err != nil {
		return false, err
	}
	if _, err = conn.Exec(ctx, "ALTER ROLE "+pgx.Identifier{name}.Sanitize()+" WITH PASSWORD '"+verifier+"'"); err != nil {
		return false, fmt.Errorf("flow journal role password: %w", err)
	}
	return true, nil
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
	conn, release, err := journals.lockJournal(ctx, journal.Name)
	if err != nil {
		return JournalDatabase{}, err
	}
	defer release()
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
	// The tag names this backend's database, so a sweep never lists another
	// backend's journals on a shared server.
	if _, err = conn.Exec(ctx, "COMMENT ON ROLE "+role+" IS "+quoteLiteral(journals.tag)); err != nil {
		return JournalDatabase{}, fmt.Errorf("flow journal role tag: %w", err)
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

// lockJournal holds the per-workspace advisory lock Provision and Drop share,
// on a connection of its own, until the returned release runs.
func (journals *PostgresJournals) lockJournal(ctx context.Context, name string) (*pgxpool.Conn, func(), error) {
	conn, err := journals.pool.Acquire(ctx)
	if err != nil {
		return nil, nil, err
	}
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1, 2099))`, name); err != nil {
		conn.Release()
		return nil, nil, err
	}
	return conn, func() {
		if _, unlock := conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock(hashtextextended($1, 2099))`, name); unlock != nil {
			conn.Conn().Close(context.WithoutCancel(ctx)) // closing the session releases the lock
		}
		conn.Release()
	}, nil
}

// Drop removes a deleted workspace's journal database, ending any session
// still open on it, and then its role. It is idempotent, serialized with
// Provision, and touches only the name the workspace id derives.
func (journals *PostgresJournals) Drop(ctx context.Context, workspaceID string) (err error) {
	name, err := JournalDatabaseName(workspaceID)
	if err != nil {
		return err
	}
	conn, release, err := journals.lockJournal(ctx, name)
	if err != nil {
		return err
	}
	defer release()
	role := pgx.Identifier{name}.Sanitize()
	var roleExists, databaseExists bool
	if err = conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1),
			EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, name).Scan(&roleExists, &databaseExists); err != nil {
		return err
	}
	if databaseExists {
		// Only the owner drops a database and ends its sessions; the backend
		// acts as the workspace role through the SET-only membership
		// Provision granted (a provision interrupted before it is repaired).
		if _, err = conn.Exec(ctx, "GRANT "+role+" TO CURRENT_USER WITH INHERIT FALSE, SET TRUE"); err != nil {
			return fmt.Errorf("flow journal role membership: %w", err)
		}
		if _, err = conn.Exec(ctx, "SET ROLE "+role); err != nil {
			return fmt.Errorf("flow journal database drop: %w", err)
		}
		_, err = conn.Exec(ctx, "DROP DATABASE IF EXISTS "+role+" WITH (FORCE)")
		if _, reset := conn.Exec(context.WithoutCancel(ctx), "RESET ROLE"); reset != nil {
			conn.Conn().Close(context.WithoutCancel(ctx)) // never return a pooled session acting as the workspace
			return errors.Join(err, reset)
		}
		if err != nil {
			return fmt.Errorf("flow journal database drop: %w", err)
		}
	}
	if roleExists {
		if _, err = conn.Exec(ctx, "DROP ROLE IF EXISTS "+role); err != nil {
			return fmt.Errorf("flow journal role drop: %w", err)
		}
	}
	return nil
}

// Fence ends every session a workspace's journal role holds, before the
// runtime replaces a box it lost (#1868): a host still running there loses its
// current connections to the journal the replacement's host opens. It reports
// whether the workspace has a journal database at all; without one there is
// nothing to recover, and nothing is fenced. It is serialized with Provision
// and Drop.
func (journals *PostgresJournals) Fence(ctx context.Context, workspaceID string) (bool, error) {
	name, err := JournalDatabaseName(workspaceID)
	if err != nil {
		return false, err
	}
	conn, release, err := journals.lockJournal(ctx, name)
	if err != nil {
		return false, err
	}
	defer release()
	var exists bool
	if err = conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)
			AND EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, name).Scan(&exists); err != nil || !exists {
		return false, err
	}
	role := pgx.Identifier{name}.Sanitize()
	// A role may end its own sessions; the backend acts as it through the
	// SET-only membership Provision grants.
	if _, err = conn.Exec(ctx, "GRANT "+role+" TO CURRENT_USER WITH INHERIT FALSE, SET TRUE"); err != nil {
		return false, fmt.Errorf("flow journal role membership: %w", err)
	}
	err = pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SET LOCAL ROLE "+role); err != nil {
			return err
		}
		// A session that ends by itself meanwhile answers false; what counts
		// is that none is left once every termination has waited.
		if _, err := tx.Exec(ctx, `SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity
			WHERE usename = current_user AND pid <> pg_backend_pid()`); err != nil {
			return fmt.Errorf("flow journal fence: %w", err)
		}
		// pg_stat_activity is a snapshot per transaction until cleared.
		if _, err := tx.Exec(ctx, `SELECT pg_stat_clear_snapshot()`); err != nil {
			return fmt.Errorf("flow journal fence: %w", err)
		}
		var left int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE usename = current_user AND pid <> pg_backend_pid()`).Scan(&left); err != nil {
			return fmt.Errorf("flow journal fence: %w", err)
		}
		if left > 0 {
			return errors.New("flow journal fence: a session of the lost box did not end")
		}
		return nil
	})
	return err == nil, err
}

// Workspaces lists every workspace with a journal role this backend
// provisioned (and so possibly a database), so a sweep can drop those whose
// workspace is gone. Another backend's journals on the same server and names
// outside the journal scheme are never listed.
func (journals *PostgresJournals) Workspaces(ctx context.Context) ([]string, error) {
	rows, err := journals.pool.Query(ctx, `SELECT r.rolname::text FROM pg_roles r
		JOIN pg_shdescription d ON d.objoid = r.oid AND d.classoid = 'pg_authid'::regclass
		WHERE r.rolname LIKE 'smithers\_flows\_%' AND d.description = $1`, journals.tag)
	if err != nil {
		return nil, err
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	var workspaces []string
	for _, name := range names {
		if workspaceID, err := JournalWorkspaceID(name); err == nil {
			workspaces = append(workspaces, workspaceID)
		}
	}
	slices.Sort(workspaces)
	return workspaces, nil
}

func quoteLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
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
