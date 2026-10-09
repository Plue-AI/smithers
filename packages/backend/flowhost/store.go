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
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
)

type Store struct {
	pool                 *pgxpool.Pool
	codec                SecretCodec
	newCredential        func() (string, error)
	protectedBranchHost  func(context.Context, string) error
	workspaceInitialized func(context.Context, Authority) error
}

func NewStore(pool *pgxpool.Pool, codec SecretCodec) (*Store, error) {
	if pool == nil || codec == nil {
		return nil, errors.New("flow host store requires PostgreSQL and a secret codec")
	}
	return &Store{pool: pool, codec: codec, newCredential: generateCredential}, nil
}

// ExistingCodingTarget locates the person who owns an already-running coding
// host. Machine ownership is not host ownership. This is routing metadata only:
// callers must authorize their request first and pass the returned target through
// the ordinary resolver and AcquireExisting, which recheck access and identity.
// It neither reads credentials nor creates or starts a host.
func (store *Store) ExistingCodingTarget(ctx context.Context, repository int64, workspaceID, slug string) (flowruntime.Target, error) {
	if store == nil || store.pool == nil || repository <= 0 {
		return flowruntime.Target{}, ErrHostNotRunning
	}
	if id, err := uuid.Parse(workspaceID); err != nil || id.String() != workspaceID {
		return flowruntime.Target{}, ErrHostNotRunning
	}
	var tenant, principal string
	var user int64
	err := store.pool.QueryRow(ctx, `SELECT tenant_id, principal_id, user_id
		FROM flow_runtime_host_bindings
		WHERE repository_id=$1 AND workspace_id=$2 AND catalog_key=$3 AND state='running'`,
		repository, workspaceID, CatalogCoding).Scan(&tenant, &principal, &user)
	if errors.Is(err, pgx.ErrNoRows) {
		return flowruntime.Target{}, ErrHostNotRunning
	}
	if err != nil {
		return flowruntime.Target{}, err
	}
	if user <= 0 || tenant != "repository:"+strconv.FormatInt(repository, 10) || principal != "user:"+strconv.FormatInt(user, 10) {
		return flowruntime.Target{}, ErrHostIdentityConflict
	}
	return flowruntime.Target{TenantID: tenant, PrincipalID: principal, WorkspaceID: workspaceID, BindingKind: "browser-flow", BindingID: slug}, nil
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
	var terminal bool
	var initializing error
	if store.workspaceInitialized != nil {
		var exists, needsInitialization bool
		if err := store.pool.QueryRow(ctx, `SELECT
            EXISTS(SELECT 1 FROM flow_runtime_host_bindings WHERE workspace_id=$1 AND catalog_key=$2),
            EXISTS(SELECT 1 FROM flow_runtime_host_bindings WHERE workspace_id=$1 AND catalog_key=$2 AND last_error_code IN ('source_revision_mismatch','runtime_source_revision_mismatch',$4)),
            EXISTS(SELECT 1 FROM flow_runtime_host_bindings WHERE workspace_id=$1 AND catalog_key=$2 AND (start_failures >= $3 OR last_error_code IN ('runtime_start_exhausted','runtime_source_revision_mismatch_terminal')))`, authority.WorkspaceID, validated.Key, MaxStartFailures, WorkspaceInitializingCode).Scan(&exists, &needsInitialization, &terminal); err != nil {
			return nil, err
		}
		if !existingOnly && (!exists || needsInitialization) {
			if err := store.workspaceInitialized(ctx, authority); err != nil {
				// A machine whose setup never writes its receipt must not hold
				// its slot forever. An authority that names its source pins
				// nothing from the partial checkout, so the refusal becomes a
				// failed start on its binding and the start bound ends the wait
				// (initializationRefused). Without a named source nothing binds.
				if !workspaceInitializingRefusal(err) || !lowerHex(authority.SourceRevision, 40) {
					return nil, err
				}
				initializing = err
			}
		}
	}

	if store.protectedBranchHost != nil {
		var native, authorized bool
		err := store.pool.QueryRow(ctx, `SELECT w.kind='vm',w.user_id=$3 OR EXISTS(SELECT 1 FROM workspace_shares s JOIN collaborators c ON c.repository_id=w.repository_id AND c.user_id=s.grantee_user_id JOIN users u ON u.id=c.user_id WHERE s.workspace_id=w.id AND s.level='write' AND s.grantee_user_id=$3 AND c.suspended_at IS NULL AND c.permission IN ('write','admin') AND c.unix_uid>=20000 AND u.is_active AND u.deleted_at IS NULL AND NOT u.prohibit_login) FROM workspaces w WHERE w.id=$1 AND w.repository_id=$2 AND w.deleted_at IS NULL`, authority.WorkspaceID, authority.RepositoryID, authority.UserID).Scan(&native, &authorized)
		if err != nil {
			return nil, err
		}
		if !authorized {
			return nil, failure{code: "runtime_target_forbidden"}
		}
		if native && !terminal && initializing == nil {
			if err := store.protectedBranchHost(ctx, authority.WorkspaceID); err != nil {
				return nil, err
			}
		}
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
	if initializing != nil {
		defer result.Close()
		return nil, result.initializationFailed(ctx, initializing)
	}
	return result, nil
}

func workspaceInitializingRefusal(err error) bool {
	var known flowruntime.Failure
	return errors.As(err, &known) && known.FlowRuntimeCode() == WorkspaceInitializingCode
}

// initializationRefused is a start refused because the workspace never wrote
// its initialization receipt, recorded as a failed start on binding. At
// MaxStartFailures the resolver releases the machine and the start is final.
type initializationRefused struct {
	binding Binding
	cause   error
}

func (value initializationRefused) Error() string { return "flow host: " + WorkspaceInitializingCode }
func (value initializationRefused) Unwrap() error { return value.cause }

// initializationFailed counts the refusal like any failed start. A binding
// another caller started meanwhile is left alone: its refusal is stale.
func (value *lease) initializationFailed(ctx context.Context, cause error) error {
	if value.binding.State != "pending" && value.binding.State != "failed" {
		return cause
	}
	code := WorkspaceInitializingCode
	if value.binding.StartFailures+1 >= MaxStartFailures {
		code = "runtime_start_exhausted"
	}
	if err := value.MarkFailed(context.WithoutCancel(ctx), code); err != nil {
		return err
	}
	return initializationRefused{binding: value.binding, cause: cause}
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
	// Retain private-box exclusion. Shared service-owned VMs require both
	// current allocated membership and the install's protected native launcher.
	var workspaceID string
	var shared bool
	if err := tx.QueryRow(ctx, `SELECT w.id::text,
    w.user_id<>$3 AND EXISTS(SELECT 1 FROM workspace_shares s WHERE s.workspace_id=w.id AND s.level='write' AND s.grantee_user_id<>$3)
  FROM workspaces w WHERE w.id=$1 AND w.repository_id=$2 AND w.deleted_at IS NULL
   AND (w.user_id=$3 OR (w.user_id IN (SELECT u.id FROM users u WHERE u.lower_username='smithers-machines' AND u.user_type='service' AND u.prohibit_login AND u.deleted_at IS NULL)
    AND EXISTS(SELECT 1 FROM workspace_shares s WHERE s.workspace_id=w.id AND s.level='write' AND s.grantee_user_id=$3)
    AND (NOT EXISTS(SELECT 1 FROM workspace_shares s WHERE s.workspace_id=w.id AND s.level='write' AND s.grantee_user_id<>$3)
      OR (w.kind='vm' AND EXISTS(SELECT 1 FROM collaborators c JOIN users u ON u.id=c.user_id WHERE c.repository_id=w.repository_id AND c.user_id=$3 AND c.permission IN ('write','admin') AND c.suspended_at IS NULL AND c.unix_uid>=20000 AND c.unix_login<>'' AND u.is_active AND u.deleted_at IS NULL AND NOT u.prohibit_login)))))
   FOR SHARE OF w`, authority.WorkspaceID, authority.RepositoryID, authority.UserID).Scan(&workspaceID, &shared); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return failure{code: "runtime_target_forbidden"}
		}
		return err
	}
	if shared && value.store.protectedBranchHost == nil {
		return failure{code: "runtime_target_forbidden"}
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
		runtime_artifact_digest, source_revision, owner_generation, state, service_identity, start_failures, ever_started, source_refreshed, last_error_code,
		credential_ciphertext, credential_hash
	FROM flow_runtime_host_bindings`

func scanBinding(row pgx.Row) (Binding, string, []byte, error) {
	var binding Binding
	var encrypted string
	var credentialHash []byte
	err := row.Scan(&binding.ID, &binding.TenantID, &binding.PrincipalID, &binding.BindingKind, &binding.BindingID,
		&binding.RepositoryID, &binding.UserID, &binding.WorkspaceID, &binding.CatalogKey, &binding.ServiceName,
		&binding.RuntimeArtifactDigest, &binding.SourceRevision, &binding.OwnerGeneration, &binding.State,
		&binding.ServiceIdentity, &binding.StartFailures, &binding.EverStarted, &binding.SourceRefreshed, &binding.LastErrorCode, &encrypted, &credentialHash)
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
	// Changing draft authority requires replacing the host even at the same
	// source revision: its registry and publication policy are different.
	draftChanged := (binding.BindingKind == "draft-flow") != (authority.Target.BindingKind == "draft-flow")
	if draftChanged {
		target.BindingKind = authority.Target.BindingKind
		target.BindingID = authority.Target.BindingID
	}
	target.ServiceName = catalog.ServiceName
	target.RuntimeArtifactDigest = catalog.ArtifactDigest
	if authority.SourceRevision != "" {
		target.SourceRevision = authority.SourceRevision
	}
	return target, draftChanged || target.ServiceName != binding.ServiceName ||
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
		SET runtime_artifact_digest=$3, service_name=$4, source_revision=$5, binding_kind=$6, binding_id=$7,
			owner_generation=owner_generation+1, state='pending', last_error_code='', service_identity='',
			updated_at=clock_timestamp()
		WHERE id=$1 AND owner_generation=$2 AND state <> 'retired'
		RETURNING owner_generation`, value.binding.ID, value.binding.OwnerGeneration,
		target.RuntimeArtifactDigest, target.ServiceName, target.SourceRevision, target.BindingKind, target.BindingID).Scan(&generation)
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
		SET state='running', ever_started=true, last_error_code='', service_identity=$3, updated_at=clock_timestamp()
		WHERE id=$1 AND owner_generation=$2 AND state <> 'retired'`, value.binding.ID, value.binding.OwnerGeneration, serviceIdentity)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("flow host running checkpoint lost its owner fence")
	}
	value.binding.EverStarted = true
	value.binding.State = "running"
	value.binding.ServiceIdentity = serviceIdentity
	return nil
}

func (value *lease) MarkFailed(ctx context.Context, code string) error {
	if value == nil || value.closed || value.connection == nil {
		return errors.New("flow host binding lease is closed")
	}
	tag, err := value.connection.Exec(ctx, `UPDATE flow_runtime_host_bindings
		SET state='failed', start_failures=start_failures+1, last_error_code=$3, updated_at=clock_timestamp()
		WHERE id=$1 AND owner_generation=$2 AND state <> 'retired'`, value.binding.ID, value.binding.OwnerGeneration, code)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("flow host failure checkpoint lost its owner fence")
	}
	value.binding.StartFailures++
	value.binding.LastErrorCode = code
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

// BindProtectedBranchHost composes the installed native admission provider.
func (s *Store) BindProtectedBranchHost(admit func(context.Context, string) error) {
	s.protectedBranchHost = admit
}

// BindWorkspaceInitialized gates creation and the source capture preceding it.
func (store *Store) BindWorkspaceInitialized(check func(context.Context, Authority) error) {
	store.workspaceInitialized = check
}

func (value *lease) RefreshSource(ctx context.Context, revision string) (Binding, error) {
	if value == nil || value.closed || value.connection == nil {
		return Binding{}, errors.New("flow host binding lease is closed")
	}
	if !lowerHex(revision, 40) {
		return Binding{}, ErrSourceRevisionRequired
	}
	tag, err := value.connection.Exec(ctx, `UPDATE flow_runtime_host_bindings SET source_revision=$3, source_refreshed=true, updated_at=clock_timestamp() WHERE id=$1 AND owner_generation=$2 AND NOT ever_started AND NOT source_refreshed AND state='failed'`, value.binding.ID, value.binding.OwnerGeneration, revision)
	if err != nil {
		return Binding{}, err
	}
	if tag.RowsAffected() != 1 {
		return Binding{}, errors.New("flow host source refresh lost its owner fence")
	}
	value.binding.SourceRevision = revision
	value.binding.SourceRefreshed = true
	return value.binding, nil
}
