package flowhost

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool          *pgxpool.Pool
	codec         SecretCodec
	newCredential func() (string, error)
}

func NewStore(pool *pgxpool.Pool, codec SecretCodec) (*Store, error) {
	if pool == nil || codec == nil {
		return nil, errors.New("flow host store requires PostgreSQL and a secret codec")
	}
	return &Store{pool: pool, codec: codec, newCredential: generateCredential}, nil
}

func generateCredential() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate flow host credential: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

type lease struct {
	store      *Store
	connection *pgxpool.Conn
	lockKey    string
	binding    Binding
	credential string
	closed     bool
	// supersedes holds the durable owner whose identity no longer matches the
	// operator catalog or authority; target is the identity Rebind installs.
	supersedes *Binding
	target     Binding
}

func bindingLockKey(authority Authority, catalog Catalog) string {
	// Match the database uniqueness and lookup exactly. JSON is collision-free
	// for this tuple and, unlike a NUL delimiter, is valid PostgreSQL text.
	key, _ := json.Marshal([]string{"smithers:flow-host", authority.WorkspaceID, catalog.Key})
	return string(key)
}

func (store *Store) Acquire(ctx context.Context, authority Authority, catalog Catalog) (BindingLease, error) {
	return store.acquire(ctx, authority, catalog, false)
}

// AcquireExisting takes the same owner lock but never inserts a binding or
// generates a credential. A missing binding is an unavailable host, and a
// lock held past existingLockWait (a host start) is ErrHostBusy.
func (store *Store) AcquireExisting(ctx context.Context, authority Authority, catalog Catalog) (BindingLease, error) {
	return store.acquire(ctx, authority, catalog, true)
}

func (store *Store) acquire(ctx context.Context, authority Authority, catalog Catalog, existingOnly bool) (BindingLease, error) {
	if store == nil || store.pool == nil || store.codec == nil {
		return nil, errors.New("flow host store is unavailable")
	}
	if err := validateAuthority(authority.Target, authority); err != nil {
		return nil, err
	}
	validated, err := validateCatalog(catalog)
	if err != nil {
		return nil, err
	}
	if validated.Key != authority.CatalogKey {
		return nil, errors.New("flow host catalog does not match authority")
	}
	connection, err := store.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	lockKey := bindingLockKey(authority, validated)
	if existingOnly {
		// A read never waits out another caller's host start, which holds
		// this lock for as long as the host takes to become ready (#2198).
		if err := tryAdvisoryLock(ctx, connection, lockKey); err != nil {
			closeLockedConnection(connection)
			return nil, err
		}
	} else if _, err := connection.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		closeLockedConnection(connection)
		return nil, err
	}
	result := &lease{store: store, connection: connection, lockKey: lockKey}
	if err := result.loadOrCreate(ctx, authority, validated, existingOnly); err != nil {
		_ = result.Close()
		return nil, err
	}
	return result, nil
}

func (value *lease) loadOrCreate(ctx context.Context, authority Authority, catalog Catalog, existingOnly bool) error {
	tx, err := value.connection.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanupCtx)
	}()
	// A target resolver authorizes the product request; this lock independently
	// verifies that its workspace still belongs to that repository/user: the
	// user's own, or a branch machine the install's machine service owns whose
	// only write share is the user's. The browser relay finds its box with the
	// same predicate (GetFlowWorkspaceForUserRepo); change both together. Keep
	// deletion and insertion ordered, including repository/user cascades.
	var workspaceID string
	if err := tx.QueryRow(ctx, `SELECT w.id::text FROM workspaces w
		WHERE w.id=$1 AND w.repository_id=$2 AND w.deleted_at IS NULL
		  AND (w.user_id=$3 OR (w.user_id IN (SELECT u.id FROM users u WHERE u.lower_username='smithers-machines'
		        AND u.user_type='service' AND u.prohibit_login AND u.deleted_at IS NULL)
		    AND EXISTS (SELECT 1 FROM workspace_shares s WHERE s.workspace_id=w.id AND s.level='write' AND s.grantee_user_id=$3)
		    AND NOT EXISTS (SELECT 1 FROM workspace_shares s WHERE s.workspace_id=w.id AND s.level='write' AND s.grantee_user_id<>$3)))
		FOR SHARE OF w`, authority.WorkspaceID, authority.RepositoryID, authority.UserID).Scan(&workspaceID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return failure{code: "runtime_target_forbidden"}
		}
		return err
	}
	binding, encrypted, credentialHash, err := scanBinding(tx.QueryRow(ctx, bindingSelect+`
		WHERE workspace_id=$1 AND catalog_key=$2
		FOR UPDATE`, authority.WorkspaceID, catalog.Key))
	if errors.Is(err, pgx.ErrNoRows) {
		if existingOnly {
			return ErrHostNotRunning
		}
		if !lowerHex(authority.SourceRevision, 40) {
			return ErrSourceRevisionRequired
		}
		credential, credentialErr := value.store.newCredential()
		if credentialErr != nil {
			return credentialErr
		}
		encrypted, credentialErr = value.store.codec.EncryptString(credential)
		if credentialErr != nil || strings.TrimSpace(encrypted) == "" {
			return errors.New("protect flow host credential")
		}
		digest := sha256.Sum256([]byte(credential))
		binding = Binding{
			ID: uuid.NewString(), TenantID: authority.Target.TenantID, PrincipalID: authority.Target.PrincipalID,
			BindingKind: authority.Target.BindingKind, BindingID: authority.Target.BindingID,
			RepositoryID: authority.RepositoryID, UserID: authority.UserID, WorkspaceID: authority.WorkspaceID,
			CatalogKey: catalog.Key, ServiceName: catalog.ServiceName,
			RuntimeArtifactDigest: catalog.ArtifactDigest, SourceRevision: authority.SourceRevision,
			OwnerGeneration: 1, State: "pending",
		}
		_, err = tx.Exec(ctx, `INSERT INTO flow_runtime_host_bindings
			(id, tenant_id, principal_id, binding_kind, binding_id, repository_id, user_id, workspace_id,
			 catalog_key, service_name, runtime_artifact_digest, source_revision, owner_generation,
			 credential_ciphertext, credential_hash, state)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending')`,
			binding.ID, binding.TenantID, binding.PrincipalID, binding.BindingKind, binding.BindingID,
			binding.RepositoryID, binding.UserID, binding.WorkspaceID, binding.CatalogKey, binding.ServiceName,
			binding.RuntimeArtifactDigest, binding.SourceRevision, binding.OwnerGeneration, encrypted, digest[:])
		if err != nil {
			return err
		}
		credentialHash = digest[:]
		value.credential = credential
	} else if err != nil {
		return err
	}
	if err := authorityMatches(binding, authority, catalog); err != nil {
		return err
	}
	if target, drifted := identityDrift(binding, authority, catalog); drifted {
		old := binding
		value.supersedes = &old
		value.target = target
	}
	if value.credential == "" {
		credential, err := value.store.codec.DecryptString(encrypted)
		if err != nil || strings.TrimSpace(credential) == "" {
			return errors.New("open flow host credential")
		}
		digest := sha256.Sum256([]byte(credential))
		if len(credentialHash) != len(digest) || subtle.ConstantTimeCompare(credentialHash, digest[:]) != 1 {
			return errors.New("flow host credential integrity check failed")
		}
		value.credential = credential
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	value.binding = binding
	return nil
}

const bindingSelect = `SELECT id::text, tenant_id, principal_id, binding_kind, binding_id,
		repository_id, user_id, workspace_id, catalog_key, service_name,
		runtime_artifact_digest, source_revision, owner_generation, state, service_identity,
		credential_ciphertext, credential_hash
	FROM flow_runtime_host_bindings`

func scanBinding(row pgx.Row) (Binding, string, []byte, error) {
	var binding Binding
	var encrypted string
	var credentialHash []byte
	err := row.Scan(&binding.ID, &binding.TenantID, &binding.PrincipalID, &binding.BindingKind, &binding.BindingID,
		&binding.RepositoryID, &binding.UserID, &binding.WorkspaceID, &binding.CatalogKey, &binding.ServiceName,
		&binding.RuntimeArtifactDigest, &binding.SourceRevision, &binding.OwnerGeneration, &binding.State,
		&binding.ServiceIdentity, &encrypted, &credentialHash)
	return binding, encrypted, credentialHash, err
}

// authorityMatches checks the immutable part of a durable binding: who owns
// it and which workspace/catalog it serves. A mismatch is a hard conflict.
func authorityMatches(binding Binding, authority Authority, catalog Catalog) error {
	if binding.TenantID != authority.Target.TenantID || binding.PrincipalID != authority.Target.PrincipalID ||
		binding.RepositoryID != authority.RepositoryID || binding.UserID != authority.UserID ||
		binding.WorkspaceID != authority.WorkspaceID || binding.CatalogKey != catalog.Key ||
		!lowerHex(binding.SourceRevision, 40) || binding.OwnerGeneration <= 0 || binding.State == "retired" {
		return errors.New("flow host durable binding conflicts with resolved authority")
	}
	return nil
}

// identityDrift returns the host identity the operator catalog and authority
// now require. Artifact digest and service name follow the catalog; the source
// revision follows the authority only when it names one (reconnects keep the
// pinned revision). Drift is a planned owner replacement, never a conflict.
func identityDrift(binding Binding, authority Authority, catalog Catalog) (Binding, bool) {
	target := binding
	target.ServiceName = catalog.ServiceName
	target.RuntimeArtifactDigest = catalog.ArtifactDigest
	if authority.SourceRevision != "" {
		target.SourceRevision = authority.SourceRevision
	}
	return target, target.ServiceName != binding.ServiceName ||
		target.RuntimeArtifactDigest != binding.RuntimeArtifactDigest || target.SourceRevision != binding.SourceRevision
}

// bindingMatches is the launch-time check: the binding must match both the
// authority and the current identity exactly.
func bindingMatches(binding Binding, authority Authority, catalog Catalog) error {
	if err := authorityMatches(binding, authority, catalog); err != nil {
		return err
	}
	if _, drifted := identityDrift(binding, authority, catalog); drifted {
		return errors.New("flow host durable binding identity differs from its catalog")
	}
	return nil
}

func (value *lease) Binding() Binding { return value.binding }

func (value *lease) Credential() string { return value.credential }

// Supersedes reports the durable owner a Rebind would replace.
func (value *lease) Supersedes() (Binding, bool) {
	if value == nil || value.supersedes == nil {
		return Binding{}, false
	}
	return *value.supersedes, true
}

// Rebind installs the drifted identity on the same durable row and fences the
// superseded owner by advancing its generation. The caller must stop the
// superseded host first; the bearer and state directory are retained.
func (value *lease) Rebind(ctx context.Context) (Binding, error) {
	if value == nil || value.closed || value.connection == nil {
		return Binding{}, errors.New("flow host binding lease is closed")
	}
	if value.supersedes == nil {
		return value.binding, nil
	}
	if value.binding.OwnerGeneration == int64(^uint64(0)>>1) {
		return Binding{}, errors.New("flow host owner generation exhausted")
	}
	target := value.target
	var generation int64
	err := value.connection.QueryRow(ctx, `UPDATE flow_runtime_host_bindings
		SET runtime_artifact_digest=$3, service_name=$4, source_revision=$5,
			owner_generation=owner_generation+1, state='pending', last_error_code='', service_identity='',
			updated_at=clock_timestamp()
		WHERE id=$1 AND owner_generation=$2 AND state <> 'retired'
		RETURNING owner_generation`, value.binding.ID, value.binding.OwnerGeneration,
		target.RuntimeArtifactDigest, target.ServiceName, target.SourceRevision).Scan(&generation)
	if errors.Is(err, pgx.ErrNoRows) {
		return Binding{}, errors.New("flow host rebind lost its owner fence")
	}
	if err != nil {
		return Binding{}, err
	}
	if generation != value.binding.OwnerGeneration+1 {
		return Binding{}, errors.New("flow host owner fence was not committed")
	}
	target.OwnerGeneration = generation
	target.State = "pending"
	target.ServiceIdentity = ""
	value.binding = target
	value.supersedes = nil
	return value.binding, nil
}

func (value *lease) PrepareStart(ctx context.Context, replaceOwner bool) (Binding, error) {
	if value == nil || value.closed || value.connection == nil {
		return Binding{}, errors.New("flow host binding lease is closed")
	}
	if replaceOwner {
		if value.binding.OwnerGeneration == int64(^uint64(0)>>1) {
			return Binding{}, errors.New("flow host owner generation exhausted")
		}
		value.binding.OwnerGeneration++
	}
	// Every start gets its own control credential, so a process from an
	// earlier start can no longer call the host's callbacks or spend its model
	// credential (#2198).
	credential, err := value.store.newCredential()
	if err != nil {
		return Binding{}, err
	}
	encrypted, err := value.store.codec.EncryptString(credential)
	if err != nil || strings.TrimSpace(encrypted) == "" {
		return Binding{}, errors.New("protect flow host credential")
	}
	digest := sha256.Sum256([]byte(credential))
	var generation int64
	err = value.connection.QueryRow(ctx, `UPDATE flow_runtime_host_bindings
		SET owner_generation=$2, state='starting', last_error_code='', credential_ciphertext=$3, credential_hash=$4,
			service_identity='', updated_at=clock_timestamp()
		WHERE id=$1 AND owner_generation <= $2 AND state <> 'retired'
		RETURNING owner_generation`, value.binding.ID, value.binding.OwnerGeneration, encrypted, digest[:]).Scan(&generation)
	if err != nil {
		return Binding{}, err
	}
	if generation != value.binding.OwnerGeneration {
		return Binding{}, errors.New("flow host owner fence was not committed")
	}
	value.binding.State = "starting"
	value.binding.ServiceIdentity = ""
	value.credential = credential
	return value.binding, nil
}

func (value *lease) MarkRunning(ctx context.Context, serviceIdentity string) error {
	if value == nil || value.closed || value.connection == nil {
		return errors.New("flow host binding lease is closed")
	}
	tag, err := value.connection.Exec(ctx, `UPDATE flow_runtime_host_bindings
		SET state='running', last_error_code='', service_identity=$3, updated_at=clock_timestamp()
		WHERE id=$1 AND owner_generation=$2 AND state <> 'retired'`, value.binding.ID, value.binding.OwnerGeneration, serviceIdentity)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("flow host running checkpoint lost its owner fence")
	}
	value.binding.State = "running"
	value.binding.ServiceIdentity = serviceIdentity
	return nil
}

func (value *lease) MarkFailed(ctx context.Context, code string) error {
	if value == nil || value.closed || value.connection == nil {
		return errors.New("flow host binding lease is closed")
	}
	tag, err := value.connection.Exec(ctx, `UPDATE flow_runtime_host_bindings
		SET state='failed', last_error_code=$3, updated_at=clock_timestamp()
		WHERE id=$1 AND owner_generation=$2 AND state <> 'retired'`, value.binding.ID, value.binding.OwnerGeneration, code)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("flow host failure checkpoint lost its owner fence")
	}
	value.binding.State = "failed"
	return nil
}

func (value *lease) Close() error {
	if value == nil || value.closed {
		return nil
	}
	value.closed = true
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := value.connection.Exec(ctx, `SELECT pg_advisory_unlock(hashtextextended($1, 0))`, value.lockKey)
	if err != nil {
		// Returning a session with an unknown advisory-lock state poisons the
		// pool. Closing the physical connection releases every session lock.
		closeLockedConnection(value.connection)
	} else {
		value.connection.Release()
	}
	value.connection = nil
	return err
}

var _ BindingStore = (*Store)(nil)
var _ BindingLease = (*lease)(nil)

// A cancelled lock query may have acquired the lock before its reply was lost.
// Never return an ambiguous session lock to the connection pool.
func closeLockedConnection(connection *pgxpool.Conn) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = connection.Hijack().Close(ctx)
}

// existingLockWait bounds how long a read waits for the owner lock. Ordinary
// holders (an identity probe, a checkpoint) release it well within it.
const existingLockWait = 2 * time.Second

func tryAdvisoryLock(ctx context.Context, connection *pgxpool.Conn, lockKey string) error {
	deadline := time.Now().Add(existingLockWait)
	for {
		var locked bool
		if err := connection.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1, 0))`, lockKey).Scan(&locked); err != nil {
			return err
		}
		if locked {
			return nil
		}
		if time.Now().After(deadline) {
			return ErrHostBusy
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}
