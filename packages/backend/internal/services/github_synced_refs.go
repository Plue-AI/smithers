package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const gitHubRefs = "refs"

// The permit captures the source before network I/O. It admits the complete
// observation only while that binding and the main worker's claim still hold.
type gitHubRefReadCommit func(context.Context, string, string, string, map[string]string) error

type gitHubRefSnapshot struct {
	Branch string            `json:"branch"`
	Refs   map[string]string `json:"refs"`
}

func (s *GitHubSyncedRepoService) prepareRefRead(ctx context.Context, claimed db.GithubMainPull) (gitHubRefReadCommit, error) {
	source, err := s.authorizeRefSource(ctx, claimed.RepositoryID)
	if err != nil {
		return nil, err
	}
	if err := checkRefClaim(ctx, s.install.pool, claimed.RepositoryID, claimed.Claim, false); err != nil {
		return nil, err
	}
	return func(ctx context.Context, owner, repo, branch string, refs map[string]string) error {
		if owner != source.OwnerLogin || repo != source.RepoName {
			return gitHubFetchUnavailable()
		}
		snapshot := gitHubRefSnapshot{Branch: branch, Refs: refs}
		if err := validateRefSnapshot(snapshot); err != nil {
			return err
		}
		// These are pending source observations, not a second current-state
		// cache. Stack consumers project them through the existing jobs worker.
		return pgx.BeginFunc(ctx, s.install.pool, func(tx pgx.Tx) error {
			current, err := lockFetchedRepo(ctx, tx, source.ID)
			if err != nil {
				return err
			}
			if current.GithubRepositoryID != source.GithubRepositoryID || current.InstallationID != source.InstallationID || current.OwnerLogin != source.OwnerLogin || current.RepoName != source.RepoName {
				return gitHubFetchUnavailable()
			}
			if err := s.authorizeFetched(ctx, current); err != nil {
				return err
			}
			if err := lockRefRepository(ctx, tx, claimed.RepositoryID, source, branch); err != nil {
				return err
			}
			if err := checkRefClaim(ctx, tx, claimed.RepositoryID, claimed.Claim, true); err != nil {
				return err
			}
			canonical, err := json.Marshal(snapshot)
			if err != nil {
				return err
			}
			hash := sha256.Sum256(canonical)
			fact := gitHubFetchedObject{
				GitHubRepository: source.GithubRepositoryID.Int64, Installation: source.InstallationID.Int64,
				Repo: source.ID, Resource: gitHubRefs, Version: hex.EncodeToString(hash[:]), Object: canonical,
				RefRepositoryID: claimed.RepositoryID, RefClaim: claimed.Claim,
			}
			// Reuse the latest delivery while the listing is unchanged. Read its
			// identity, not a cached ref body; A -> B -> A must still admit A again.
			var previousClaim, previousSource int64
			var previousVersion string
			err = tx.QueryRow(ctx, `SELECT (payload->>'ref_claim')::bigint,(payload->>'repo')::bigint,payload->>'version' FROM product_job_requests WHERE tenant_id=$1 AND principal_id='refs' AND operation=$2 AND (payload->>'ref_repository_id')::bigint=$3 ORDER BY (payload->>'ref_claim')::bigint DESC LIMIT 1`,
				fmt.Sprintf("github:%d:%d", fact.Installation, fact.GitHubRepository), githubFetchedOperation, claimed.RepositoryID).Scan(&previousClaim, &previousSource, &previousVersion)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if err == nil {
				if previousClaim > claimed.Claim {
					return gitHubFetchUnavailable()
				}
				if previousSource == source.ID && previousVersion == fact.Version {
					return nil
				}
			}
			payload, err := json.Marshal(fact)
			if err != nil {
				return err
			}
			_, err = s.install.jobs.AdmitInTx(ctx, tx, jobs.Admission{
				Scope:     jobs.Scope{TenantID: fmt.Sprintf("github:%d:%d", fact.Installation, fact.GitHubRepository), PrincipalID: gitHubRefs},
				Operation: githubFetchedOperation, RequestID: fmt.Sprintf("%d:%d", claimed.RepositoryID, claimed.Claim),
				Payload: payload, AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectIdempotent,
			})
			return err
		})
	}, nil
}

type refClaimReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func checkRefClaim(ctx context.Context, reader refClaimReader, repositoryID, claim int64, lock bool) error {
	query := `SELECT claim FROM github_main_pulls WHERE repository_id=$1 AND claim=$2 AND state='running' AND lease_expires_at>clock_timestamp()`
	if lock {
		query += " FOR UPDATE"
	}
	var actual int64
	if repositoryID <= 0 || claim <= 0 {
		return gitHubFetchUnavailable()
	}
	if err := reader.QueryRow(ctx, query, repositoryID, claim).Scan(&actual); err != nil {
		return fmt.Errorf("GitHub ref read claim is unavailable: %w", err)
	}
	if lock {
		// The WHERE predicate may have been evaluated before waiting for the
		// row lock. Check the wall clock again after acquiring it.
		var live bool
		if err := reader.QueryRow(ctx, `SELECT lease_expires_at>clock_timestamp() FROM github_main_pulls WHERE repository_id=$1 AND claim=$2`, repositoryID, claim).Scan(&live); err != nil {
			return err
		}
		if !live {
			return gitHubFetchUnavailable()
		}
	}
	return nil
}

func lockRefRepository(ctx context.Context, tx pgx.Tx, repositoryID int64, source db.GithubSyncedRepo, branch string) error {
	var bookmark string
	if err := tx.QueryRow(ctx, `SELECT default_bookmark FROM repositories WHERE id=$1 FOR UPDATE`, repositoryID).Scan(&bookmark); err != nil {
		return err
	}
	bookmark = strings.TrimSpace(bookmark)
	if bookmark == "" {
		bookmark = "main"
	}
	owner, repo, err := resolveGitHubDestination(ctx, db.New(tx), nil, 0, repositoryID, "", "")
	if err != nil {
		return err
	}
	if bookmark != branch || owner != source.OwnerLogin || repo != source.RepoName {
		return gitHubFetchUnavailable()
	}
	return nil
}

func validateRefSnapshot(snapshot gitHubRefSnapshot) error {
	if repohost.ValidateBookmarkName(snapshot.Branch) != nil || snapshot.Refs == nil {
		return errors.New("invalid GitHub ref snapshot")
	}
	for ref, oid := range snapshot.Refs {
		if repohost.ValidateRefName(ref) != nil || (ref != "refs/heads/"+snapshot.Branch && !strings.HasPrefix(ref, "refs/heads/smithers/")) {
			return errors.New("unexpected ref in GitHub snapshot")
		}
		decoded, err := hex.DecodeString(oid)
		if err != nil || (len(decoded) != 20 && len(decoded) != 32) || strings.ToLower(oid) != oid || strings.Trim(oid, "0") == "" {
			return errors.New("invalid object id in GitHub ref snapshot")
		}
	}
	return nil
}

func checkFetchedRefs(ctx context.Context, tx pgx.Tx, source db.GithubSyncedRepo, fact gitHubFetchedObject) error {
	var snapshot gitHubRefSnapshot
	if fact.RefRepositoryID <= 0 || fact.RefClaim <= 0 || json.Unmarshal(fact.Object, &snapshot) != nil {
		return errors.New("invalid GitHub ref delivery")
	}
	if err := validateRefSnapshot(snapshot); err != nil {
		return err
	}
	return lockRefRepository(ctx, tx, fact.RefRepositoryID, source, snapshot.Branch)
}
