package services

import (
	"context"
	stdErrors "errors"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

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
	UpsertRepositoryEgressPolicy(ctx context.Context, arg db.UpsertRepositoryEgressPolicyParams) (db.RepositoryEgressPolicy, error)
	ListRepositoryLiveSandboxIDs(ctx context.Context, repositoryID int64) ([]string, error)
}

// EgressAllowDomainsSource reads the allowlist a new or resumed sandbox of a
// repository is created with. Nil means the provider's deployment default.
type EgressAllowDomainsSource interface {
	AllowDomains(ctx context.Context, repositoryID int64) ([]string, error)
}

// RepositoryEgressPolicy is a repository's egress allowlist. An empty list
// leaves every sandbox of the repository on the provider's deployment list;
// a non-empty one replaces that list.
type RepositoryEgressPolicy struct {
	AllowDomains []string   `json:"allow_domains"`
	UpdatedAt    *time.Time `json:"updated_at,omitempty"`
}

// RepositoryEgressReload is one running sandbox's live reload outcome.
type RepositoryEgressReload struct {
	SandboxID string `json:"sandbox_id"`
	Reloaded  bool   `json:"reloaded"`
	Error     string `json:"error,omitempty"`
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
	q        RepositoryEgressPolicyQuerier
	reloader sandbox.EgressReloader
}

// NewRepositoryEgressPolicyService builds the service. reloader is nil when
// the deployment's sandbox provider cannot change a running proxy.
func NewRepositoryEgressPolicyService(q RepositoryEgressPolicyQuerier, reloader sandbox.EgressReloader) *RepositoryEgressPolicyService {
	return &RepositoryEgressPolicyService{q: q, reloader: reloader}
}

// Get reads a repository's allowlist; a repository that never set one has
// an empty list.
func (s *RepositoryEgressPolicyService) Get(ctx context.Context, repositoryID int64) (RepositoryEgressPolicy, error) {
	row, err := s.q.GetRepositoryEgressPolicy(ctx, repositoryID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return RepositoryEgressPolicy{AllowDomains: []string{}}, nil
	}
	if err != nil {
		return RepositoryEgressPolicy{}, pkgerrors.Internal("read the repository egress policy").WithCause(err)
	}
	return repositoryEgressPolicy(row), nil
}

// AllowDomains is the list a sandbox of the repository is created or resumed
// with: nil when the repository set none, so the provider's default applies.
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

// Put replaces a repository's allowlist, then reloads it into every running
// sandbox of the repository. The durable record is written first and is what
// a sandbox starts or resumes with, so a reload that fails is reported per
// sandbox rather than failing the write.
func (s *RepositoryEgressPolicyService) Put(ctx context.Context, actor *db.User, repositoryID int64, domains []string) (RepositoryEgressPolicyUpdate, error) {
	normalized, err := NormalizeEgressAllowDomains(domains)
	if err != nil {
		return RepositoryEgressPolicyUpdate{}, err
	}
	updatedBy := pgtype.Int8{}
	if actor != nil {
		updatedBy = pgtype.Int8{Int64: actor.ID, Valid: true}
	}
	row, err := s.q.UpsertRepositoryEgressPolicy(ctx, db.UpsertRepositoryEgressPolicyParams{
		RepositoryID: repositoryID,
		AllowDomains: normalized,
		UpdatedBy:    updatedBy,
	})
	if err != nil {
		return RepositoryEgressPolicyUpdate{}, pkgerrors.Internal("write the repository egress policy").WithCause(err)
	}
	sandboxIDs, err := s.q.ListRepositoryLiveSandboxIDs(ctx, repositoryID)
	if err != nil {
		return RepositoryEgressPolicyUpdate{}, pkgerrors.Internal("list the repository's running sandboxes").WithCause(err)
	}
	return RepositoryEgressPolicyUpdate{
		RepositoryEgressPolicy: repositoryEgressPolicy(row),
		Reloads:                s.reload(ctx, sandboxIDs, normalized),
	}, nil
}

// reload sends the list to every sandbox at once, each under its own bound.
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
			request := sandbox.EgressReloadRequest{AllowDomains: append([]string{}, domains...)}
			if _, err := s.reloader.ReloadEgress(reloadCtx, outcome.SandboxID, request); err != nil {
				outcome.Error = err.Error()
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
