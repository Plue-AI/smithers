package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const githubFetchedOperation = "github.fetched.consume"

// gitHubFetchedObject is a version fetched from GitHub, never a webhook body.
// Consumers may write only through the supplied transaction: their receipt,
// product changes and further delivery intents commit with its acknowledgement.
type gitHubFetchedObject struct {
	GitHubRepository int64           `json:"github_repository"`
	Installation     int64           `json:"installation"`
	Repo             int64           `json:"repo"`
	Resource         string          `json:"resource"`
	Number           int64           `json:"number"`
	Version          string          `json:"version"`
	EventID          int64           `json:"event_id,omitempty"`
	RefRepositoryID  int64           `json:"ref_repository_id,omitempty"`
	RefClaim         int64           `json:"ref_claim,omitempty"`
	Object           json.RawMessage `json:"object"`
}

type gitHubFetchedConsumer func(context.Context, pgx.Tx, gitHubFetchedObject) (json.RawMessage, error)

type gitHubInstallSync struct {
	pool *pgxpool.Pool
	jobs *jobs.Store
	// Qualification includes the install credential, storage, permission and
	// runtime providers. Nil leaves fetching and consumption disabled.
	authorize     func(context.Context, db.GithubSyncedRepo) error
	consumers     map[string]gitHubFetchedConsumer
	mu            sync.Mutex
	requested     map[gitHubStreamKey]bool
	streams       map[gitHubStreamKey]gitHubPollState
	etags         map[gitHubPageKey]gitHubPageValidator
	wake          chan struct{}
	requestPulls  func(context.Context, db.GithubSyncedRepo) error
	requiredPulls func(context.Context, db.GithubSyncedRepo) ([]GitHubSyncStream, error)
}

// ConfigureInstallSync replaces webhook cache writes with fetch hints on an
// install and binds cache changes to the existing product jobs transaction.
// Provider qualification and downstream consumers remain unregistered until
// their production boundaries pass; hosted instances keep their current path.
func (s *GitHubSyncedRepoService) ConfigureInstallSync(pool *pgxpool.Pool) error {
	store, err := jobs.NewStore(pool)
	if err != nil {
		return err
	}
	s.install = &gitHubInstallSync{pool: pool, jobs: store, consumers: map[string]gitHubFetchedConsumer{}, requested: map[gitHubStreamKey]bool{}, streams: map[gitHubStreamKey]gitHubPollState{}, wake: make(chan struct{}, 1)}
	return nil
}

func gitHubFetchUnavailable() error {
	return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "GitHub fetched-state sync is unavailable")
}

func (s *GitHubSyncedRepoService) authorizeFetched(ctx context.Context, row db.GithubSyncedRepo) error {
	if s.install == nil || s.install.authorize == nil || row.ID <= 0 || !row.InstallationID.Valid || row.InstallationID.Int64 <= 0 || !row.GithubRepositoryID.Valid || row.GithubRepositoryID.Int64 <= 0 || !row.SyncMetadata || row.SyncState == "disabled" || row.SyncState == "failed" {
		return gitHubFetchUnavailable()
	}
	return s.install.authorize(ctx, row)
}

func (s *GitHubSyncedRepoService) requestInstallFetch(ctx context.Context, githubRepoID int64, resources ...string) error {
	if githubRepoID <= 0 {
		return nil
	}
	row, err := s.store.GetGitHubSyncedRepoByGitHubID(ctx, pgtype.Int8{Int64: githubRepoID, Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	s.install.mu.Lock()
	if len(resources) == 0 {
		resources = installMetadataResources
	}
	for _, resource := range resources {
		s.install.requested[syncedStreamKey(row, resource)] = true
	}
	s.install.mu.Unlock()
	var pullErr error
	for _, resource := range resources {
		if resource == GitHubRepoMetadataPulls && s.install.requestPulls != nil {
			pullErr = s.install.requestPulls(ctx, row)
			break
		}
	}
	select {
	case s.install.wake <- struct{}{}:
	default:
	}
	return pullErr
}

// commitFetched atomically records a fetched batch and its durable deliveries.
// A missing consumer does not discard the delivery. Repeated polls share the
// same canonical object version, including JSON object ordering and numbers.
func (s *GitHubSyncedRepoService) commitFetched(ctx context.Context, row db.GithubSyncedRepo, resource string, objects []json.RawMessage) error {
	if err := s.authorizeFetched(ctx, row); err != nil {
		return err
	}
	if resource != GitHubRepoMetadataIssues && resource != GitHubRepoMetadataPulls && resource != gitHubConversationComments {
		return fmt.Errorf("unsupported fetched resource %q", resource)
	}
	return pgx.BeginFunc(ctx, s.install.pool, func(tx pgx.Tx) error {
		// The registry row serializes batches for this repository. Recheck current
		// provider authority after waiting before disclosing or changing cached data.
		current, err := lockFetchedRepo(ctx, tx, row.ID)
		if err != nil {
			return err
		}
		if current.GithubRepositoryID != row.GithubRepositoryID || current.InstallationID != row.InstallationID || current.OwnerLogin != row.OwnerLogin || current.RepoName != row.RepoName {
			return gitHubFetchUnavailable()
		}
		if err := s.authorizeFetched(ctx, current); err != nil {
			return err
		}

		if resource == gitHubConversationComments {
			return s.commitFetchedComments(ctx, tx, row, objects)
		}
		for _, object := range objects {
			if err := s.commitFetchedIssue(ctx, tx, row, resource, object); err != nil {
				return err
			}
		}
		// Deletion requires its own fetched tombstone and consumer delivery. Do not
		// prune silently until that stream supplies authoritative deletion evidence.
		return nil
	})
}

func (s *GitHubSyncedRepoService) commitFetchedIssue(ctx context.Context, tx pgx.Tx, row db.GithubSyncedRepo, resource string, object json.RawMessage) error {
	writer := NewGitHubSyncedRepoService(db.New(tx))
	var header gitHubIssueHeader
	if err := json.Unmarshal(object, &header); err != nil || header.ID <= 0 || header.Number <= 0 || !parseGitHubTimestamp(header.UpdatedAt).Valid {
		return errors.New("invalid fetched GitHub object")
	}
	if resource == GitHubRepoMetadataIssues && header.PullRequest != nil {
		return nil
	}
	var canonical []byte
	if err := tx.QueryRow(ctx, `SELECT $1::jsonb::text`, object).Scan(&canonical); err != nil {
		return err
	}
	var stale bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM github_synced_issues WHERE synced_repo_id=$1 AND resource=$2 AND number=$3 AND github_updated_at>$4::timestamptz)`, row.ID, resource, header.Number, header.UpdatedAt).Scan(&stale); err != nil {
		return err
	}
	if stale {
		return nil
	}
	if _, err := writer.storeSyncedIssue(ctx, row.ID, resource, canonical); err != nil {
		return err
	}
	return s.admitFetchedObject(ctx, tx, row, resource, header.ID, header.Number, canonical)
}

func (s *GitHubSyncedRepoService) admitFetchedObject(ctx context.Context, tx pgx.Tx, row db.GithubSyncedRepo, resource string, id, number int64, canonical json.RawMessage) error {
	hash := sha256.Sum256(canonical)
	version := hex.EncodeToString(hash[:])
	fact := gitHubFetchedObject{GitHubRepository: row.GithubRepositoryID.Int64, Installation: row.InstallationID.Int64, Repo: row.ID, Resource: resource, Number: number, Version: version, Object: canonical}
	payload, err := json.Marshal(fact)
	if err != nil {
		return err
	}
	_, err = s.install.jobs.AdmitInTx(ctx, tx, jobs.Admission{
		Scope:     jobs.Scope{TenantID: "github:" + strconv.FormatInt(row.InstallationID.Int64, 10) + ":" + strconv.FormatInt(row.GithubRepositoryID.Int64, 10), PrincipalID: resource},
		Operation: githubFetchedOperation, RequestID: strconv.FormatInt(id, 10) + ":" + version,
		Payload: payload, AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectIdempotent,
	})
	if err != nil {
		return err
	}
	return nil
}

func (s *GitHubSyncedRepoService) consumeFetched(ctx context.Context, lease *jobs.Lease) error {
	claim := lease.Claim()
	var fact gitHubFetchedObject
	if claim.Operation != githubFetchedOperation || json.Unmarshal(claim.Payload, &fact) != nil {
		return errors.New("invalid fetched delivery")
	}
	consumer := s.install.consumers[fact.Resource]
	if consumer == nil {
		return gitHubFetchUnavailable()
	}
	return pgx.BeginFunc(ctx, s.install.pool, func(tx pgx.Tx) error {
		row, err := lockFetchedRepo(ctx, tx, fact.Repo)
		if err != nil {
			return err
		}
		if row.GithubRepositoryID.Int64 != fact.GitHubRepository || row.InstallationID.Int64 != fact.Installation {
			return gitHubFetchUnavailable()
		}
		if err = s.authorizeFetched(ctx, row); err != nil {
			return err
		}
		if fact.Resource == gitHubRefs {
			if err := checkFetchedRefs(ctx, tx, row, fact); err != nil {
				return err
			}
		}
		// A failed earlier version must finish before a later one from this stream.
		var earlier bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_requests p JOIN product_job_requests current ON current.id=$1 WHERE p.tenant_id=current.tenant_id AND p.principal_id=current.principal_id AND p.operation=current.operation AND (p.created_at,p.id)<(current.created_at,current.id) AND p.state NOT IN ('completed','failed','cancelled'))`, claim.OperationID).Scan(&earlier); err != nil {
			return err
		}
		if fact.EventID > 0 {
			if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_requests p JOIN product_job_requests current ON current.id=$1 WHERE p.tenant_id=current.tenant_id AND p.principal_id=current.principal_id AND p.operation=current.operation AND (p.payload->>'event_id')::bigint<$2 AND p.state<>'completed')`, claim.OperationID, fact.EventID).Scan(&earlier); err != nil {
				return err
			}
		}
		if fact.Resource == gitHubRefs {
			// Poll claims, not transaction start timestamps, order snapshots.
			// Reverting a branch to a previously seen SHA is a new observation.
			if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_requests p JOIN product_job_requests current ON current.id=$1 WHERE p.tenant_id=current.tenant_id AND p.principal_id=current.principal_id AND p.operation=current.operation AND (p.payload->>'ref_repository_id')::bigint=$2 AND (p.payload->>'ref_claim')::bigint<$3 AND p.state<>'completed')`, claim.OperationID, fact.RefRepositoryID, fact.RefClaim).Scan(&earlier); err != nil {
				return err
			}
		}
		if earlier {
			return errors.New("earlier fetched delivery is pending")
		}
		receipt, err := consumer(ctx, tx, fact)
		if err != nil {
			return err
		}
		return s.install.jobs.SettleInTx(ctx, tx, claim, receipt, false)
	})
}

func (s *GitHubSyncedRepoService) runFetchedDeliveries(ctx context.Context) error {
	return s.install.jobs.RunWorker(ctx, jobs.WorkerConfig{WorkerID: "github-fetched", Capacity: 1, Lease: 30 * time.Second, PollInterval: time.Second, RetryDelay: time.Second, Operations: []string{githubFetchedOperation}}, s.consumeFetched)
}

// lockFetchedRepo resolves current registry authority under the same lock used
// by fetched cache commits and delivery transactions.
func lockFetchedRepo(ctx context.Context, tx pgx.Tx, id int64) (db.GithubSyncedRepo, error) {
	var githubID int64
	if err := tx.QueryRow(ctx, `SELECT github_repository_id FROM github_synced_repos WHERE id=$1 FOR UPDATE`, id).Scan(&githubID); err != nil {
		return db.GithubSyncedRepo{}, err
	}
	return db.New(tx).GetGitHubSyncedRepoByGitHubID(ctx, pgtype.Int8{Int64: githubID, Valid: true})
}
