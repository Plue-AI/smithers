package services

import (
	"context"
	stdErrors "errors"
	"net"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// maxRepositoryEgressDomains bounds one repository's allowlist.
const maxRepositoryEgressDomains = 200

// repositoryEgressReloadTimeout bounds one running sandbox's live reload.
const repositoryEgressReloadTimeout = 15 * time.Second

// errEgressReloadUnsupported is each running sandbox's outcome when the
// provider cannot change a live proxy: the list applies when it next starts.
const errEgressReloadUnsupported = "live reload unsupported; applies on next start"

// RepositoryEgressPolicyQuerier is the storage a repository's egress
// allowlist needs.
type RepositoryEgressPolicyQuerier interface {
	GetRepositoryEgressPolicy(ctx context.Context, repositoryID int64) (db.RepositoryEgressPolicy, error)
	PatchRepositoryEgressPolicy(ctx context.Context, arg db.PatchRepositoryEgressPolicyParams) (db.RepositoryEgressPolicy, error)
	ListRepositoryLiveSandboxIDs(ctx context.Context, repositoryID int64) ([]string, error)
}

// RepositoryEgressPolicyStore adds the write lock to the storage. The lock
// serializes one repository's writes across every backend process from the
// write through its live reloads, so running proxies receive the lists in
// the order they were written and the last reload carries the newest list.
type RepositoryEgressPolicyStore interface {
	RepositoryEgressPolicyQuerier
	WithRepositoryEgressWriteLock(ctx context.Context, repositoryID int64, work func(RepositoryEgressPolicyQuerier) error) error
}

// PostgresRepositoryEgressPolicyStore is the product store: reads go through
// the pool, a write holds a session advisory lock on one connection and runs
// its statements there, so a waiting writer never needs a second connection.
type PostgresRepositoryEgressPolicyStore struct {
	*db.Queries
	pool *pgxpool.Pool
}

// NewPostgresRepositoryEgressPolicyStore builds the product store over pool.
func NewPostgresRepositoryEgressPolicyStore(pool *pgxpool.Pool) *PostgresRepositoryEgressPolicyStore {
	return &PostgresRepositoryEgressPolicyStore{Queries: db.New(pool), pool: pool}
}

const repositoryEgressWriteLockKey = "hashtextextended('repository-egress-policy:' || $1::bigint::text, 0)"

// WithRepositoryEgressWriteLock runs work while this process holds the
// repository's egress write lock. The lock is released when work returns;
// a connection whose unlock is not confirmed is closed, which releases it.
func (s *PostgresRepositoryEgressPolicyStore) WithRepositoryEgressWriteLock(ctx context.Context, repositoryID int64, work func(RepositoryEgressPolicyQuerier) error) error {
	return withRepositoryEgressConnection(ctx, s.pool, repositoryID, func(conn *pgxpool.Conn) error { return work(db.New(conn)) })
}

func withRepositoryEgressConnection(ctx context.Context, pool *pgxpool.Pool, repositoryID int64, work func(*pgxpool.Conn) error) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock("+repositoryEgressWriteLockKey+")", repositoryID); err != nil {
		return err
	}
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		var unlocked bool
		if err := conn.QueryRow(unlockCtx, "SELECT pg_advisory_unlock("+repositoryEgressWriteLockKey+")", repositoryID).Scan(&unlocked); err != nil || !unlocked {
			_ = conn.Conn().Close(context.WithoutCancel(ctx))
		}
	}()
	return work(conn)
}

// EgressAllowDomainsSource reads the allowlist a new or resumed sandbox of a
// repository is created with. Nil means the provider's deployment default.
type EgressAllowDomainsSource interface {
	AllowDomains(ctx context.Context, repositoryID int64) ([]string, error)
}

// RepositoryEgressPolicy is a repository's egress allowlist. It adds to the
// provider's deployment list and never replaces it: an empty list leaves
// every sandbox of the repository on exactly the deployment list.
type RepositoryEgressPolicy struct {
	AllowDomains []string   `json:"allow_domains"`
	UpdatedAt    *time.Time `json:"updated_at,omitempty"`
}

// RepositoryEgressReload is one running sandbox's live reload outcome.
type RepositoryEgressReload struct {
	SandboxID string `json:"sandbox_id"`
	Reloaded  bool   `json:"reloaded"`
	Error     string `json:"error,omitempty"`
	Outcome   string `json:"outcome,omitempty"`
}

// RepositoryEgressPolicyUpdate is a written policy and the live reload of
// every running sandbox of the repository.
type RepositoryEgressPolicyUpdate struct {
	RepositoryEgressPolicy
	Reloads []RepositoryEgressReload `json:"reloads"`
}

// RepositoryEgressPolicyService owns a repository's egress allowlist: the
// durable record new and resumed sandboxes are created from, and the live
// reload of the sandboxes already running when it changes.
type RepositoryEgressPolicyService struct {
	q        RepositoryEgressPolicyStore
	install  *installRepositoryEgressStore
	reloader sandbox.EgressReloader
}

// NewRepositoryEgressPolicyService builds the service. reloader is nil when
// the deployment's sandbox provider cannot change a running proxy.
func NewRepositoryEgressPolicyService(q RepositoryEgressPolicyStore, reloader sandbox.EgressReloader, options ...RepositoryEgressPolicyServiceOption) *RepositoryEgressPolicyService {
	s := &RepositoryEgressPolicyService{q: q, reloader: reloader}
	for _, option := range options {
		option(s)
	}
	return s
}

// Get reads a repository's allowlist; a repository that never set one has
// an empty list.
func (s *RepositoryEgressPolicyService) Get(ctx context.Context, repositoryID int64) (RepositoryEgressPolicy, error) {
	if s.install != nil {
		return s.getInstallEgressPolicy(ctx, repositoryID)
	}
	return readRepositoryEgressPolicy(ctx, s.q, repositoryID)
}

func readRepositoryEgressPolicy(ctx context.Context, q RepositoryEgressPolicyQuerier, repositoryID int64) (RepositoryEgressPolicy, error) {
	row, err := q.GetRepositoryEgressPolicy(ctx, repositoryID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return RepositoryEgressPolicy{AllowDomains: []string{}}, nil
	}
	if err != nil {
		return RepositoryEgressPolicy{}, pkgerrors.Internal("read the repository egress policy").WithCause(err)
	}
	return repositoryEgressPolicy(row), nil
}

// AllowDomains is the list a sandbox of the repository is created or resumed
// with, as EgressProxyPolicy.ExtraAllowDomains: nil when the repository set
// none, so the sandbox gets exactly the deployment list.
func (s *RepositoryEgressPolicyService) AllowDomains(ctx context.Context, repositoryID int64) ([]string, error) {
	row, err := s.q.GetRepositoryEgressPolicy(ctx, repositoryID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(row.AllowDomains) == 0 {
		return nil, nil
	}
	return append([]string(nil), row.AllowDomains...), nil
}

type RepositoryEgressPatchInput struct {
	Add    []string `json:"add"`
	Remove []string `json:"remove"`
}

func normalizeRepositoryEgressPatch(input RepositoryEgressPatchInput) (RepositoryEgressPatchInput, error) {
	add, err := NormalizeEgressAllowDomains(input.Add)
	if err != nil {
		return RepositoryEgressPatchInput{}, err
	}
	remove, err := NormalizeEgressAllowDomains(input.Remove)
	if err != nil {
		return RepositoryEgressPatchInput{}, err
	}
	if len(add) == 0 && len(remove) == 0 {
		return RepositoryEgressPatchInput{}, pkgerrors.BadRequest("name a host to add or remove")
	}
	for _, domain := range add {
		if slices.Contains(remove, domain) {
			return RepositoryEgressPatchInput{}, pkgerrors.BadRequest("egress domain " + strconv.Quote(domain) + " is both added and removed")
		}
	}
	return RepositoryEgressPatchInput{Add: add, Remove: remove}, nil
}

// Patch adds and removes hosts in one atomic write, then reloads the result
// into every running sandbox of the repository. Overlapping writers each
// apply their own change to the list the other left. The durable record is
// written first and is what a sandbox starts or resumes with, so a reload
// that fails is reported per sandbox rather than failing the write.
func (s *RepositoryEgressPolicyService) Patch(ctx context.Context, actor *db.User, repositoryID int64, add, remove []string) (RepositoryEgressPolicyUpdate, error) {
	input := RepositoryEgressPatchInput{Add: add, Remove: remove}
	if s.install != nil {
		return s.patchInstallEgressPolicy(ctx, actor, repositoryID, input)
	}
	input, err := normalizeRepositoryEgressPatch(input)
	if err != nil {
		return RepositoryEgressPolicyUpdate{}, err
	}
	var update RepositoryEgressPolicyUpdate
	err = s.q.WithRepositoryEgressWriteLock(ctx, repositoryID, func(q RepositoryEgressPolicyQuerier) error {
		row, ids, err := writeRepositoryEgressPolicy(ctx, q, actor, repositoryID, input)
		if err != nil {
			return err
		}
		update = RepositoryEgressPolicyUpdate{RepositoryEgressPolicy: repositoryEgressPolicy(row), Reloads: s.reload(ctx, ids, row.AllowDomains)}
		return nil
	})
	if err != nil {
		var apiErr *pkgerrors.APIError
		if stdErrors.As(err, &apiErr) {
			return RepositoryEgressPolicyUpdate{}, err
		}
		return RepositoryEgressPolicyUpdate{}, pkgerrors.Internal("lock the repository egress policy").WithCause(err)
	}
	return update, nil
}

func writeRepositoryEgressPolicy(ctx context.Context, q RepositoryEgressPolicyQuerier, actor *db.User, repository int64, input RepositoryEgressPatchInput) (db.RepositoryEgressPolicy, []string, error) {
	updatedBy := pgtype.Int8{}
	if actor != nil {
		updatedBy = pgtype.Int8{Int64: actor.ID, Valid: true}
	}
	row, err := q.PatchRepositoryEgressPolicy(ctx, db.PatchRepositoryEgressPolicyParams{RepositoryID: repository, UpdatedBy: updatedBy, AddDomains: input.Add, RemoveDomains: input.Remove, MaxDomains: maxRepositoryEgressDomains})
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return row, nil, pkgerrors.BadRequest("too many egress domains")
	}
	if err != nil {
		return row, nil, pkgerrors.Internal("write the repository egress policy").WithCause(err)
	}
	ids, err := q.ListRepositoryLiveSandboxIDs(ctx, repository)
	if err != nil {
		return row, nil, pkgerrors.Internal("list the repository's running sandboxes").WithCause(err)
	}
	return row, ids, nil
}

// reload sends the list to every sandbox at once, each under its own bound,
// as the sandbox's extra hosts: its base list is never touched.
func (s *RepositoryEgressPolicyService) reload(ctx context.Context, sandboxIDs []string, domains []string) []RepositoryEgressReload {
	reloads := make([]RepositoryEgressReload, len(sandboxIDs))
	var wg sync.WaitGroup
	for index, sandboxID := range sandboxIDs {
		reloads[index].SandboxID = sandboxID
		if s.reloader == nil {
			reloads[index].Error = errEgressReloadUnsupported
			continue
		}
		wg.Add(1)
		go func(outcome *RepositoryEgressReload) {
			defer wg.Done()
			reloadCtx, cancel := context.WithTimeout(ctx, repositoryEgressReloadTimeout)
			defer cancel()
			request := sandbox.EgressReloadRequest{ExtraAllowDomains: append([]string{}, domains...)}
			if _, err := s.reloader.ReloadEgress(reloadCtx, outcome.SandboxID, request); err != nil {
				outcome.Error = err.Error()
				outcome.Outcome = "outcomeUnknown"
				return
			}
			outcome.Reloaded = true
		}(&reloads[index])
	}
	wg.Wait()
	return reloads
}

// NormalizeEgressAllowDomains lower-cases, deduplicates and sorts an
// allowlist of host names and "*.domain" wildcards. It refuses "*", IP
// addresses and ranges, and anything that is not a host name.
func NormalizeEgressAllowDomains(domains []string) ([]string, error) {
	seen := make(map[string]struct{}, len(domains))
	normalized := make([]string, 0, len(domains))
	for _, raw := range domains {
		domain := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(raw)), ".")
		if domain == "*" {
			return nil, pkgerrors.BadRequest("egress domain \"*\" would allow every host")
		}
		if net.ParseIP(domain) != nil {
			return nil, pkgerrors.BadRequest("egress domain " + strconv.Quote(raw) + " is an IP address, not a host name")
		}
		if _, _, err := net.ParseCIDR(domain); err == nil || !sandbox.ValidEgressHost(domain) {
			return nil, pkgerrors.BadRequest("egress domain " + strconv.Quote(raw) + " is not a host name")
		}
		if _, duplicate := seen[domain]; duplicate {
			continue
		}
		seen[domain] = struct{}{}
		normalized = append(normalized, domain)
	}
	if len(normalized) > maxRepositoryEgressDomains {
		return nil, pkgerrors.BadRequest("too many egress domains")
	}
	sort.Strings(normalized)
	return normalized, nil
}

func repositoryEgressPolicy(row db.RepositoryEgressPolicy) RepositoryEgressPolicy {
	updatedAt := row.UpdatedAt
	domains := append([]string{}, row.AllowDomains...)
	return RepositoryEgressPolicy{AllowDomains: domains, UpdatedAt: &updatedAt}
}
