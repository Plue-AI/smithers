package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Related observations belong to the cached pull's exact head. Pages live in
// PostgreSQL; poller memory holds only their validators and health.
type gitHubRelatedSnapshot struct {
	Head  string                     `json:"head"`
	Pages map[string]json.RawMessage `json:"pages"`
}

func (s *GitHubSyncedRepoService) pollInstallRelated(ctx context.Context, row db.GithubSyncedRepo, number int64, head, kind string, resources []string) (err error) {
	if s.install == nil {
		return gitHubFetchUnavailable()
	}
	snapshotAt := s.now().UTC()
	streamKey := syncedStreamKey(row, kind+"/"+strconv.FormatInt(number, 10))
	pause := s.installPollRetryAt(row, kind+"/"+strconv.FormatInt(number, 10), kind)
	defer func() {
		s.install.mu.Lock()
		defer s.install.mu.Unlock()
		state := s.install.streams[streamKey]
		state.lastError = err
		state.retryAt = pause
		if observed := s.budget.StreamRetryAt(row.InstallationID.Int64, kind); observed.After(state.retryAt) {
			state.retryAt = observed
		}
		if err == nil {
			state.lastSuccess = s.now()
			if !state.retryAt.After(s.now()) {
				state.retryAt = time.Time{}
			}
		}
		if saveErr := s.persistPollHealth(ctx, row, kind+"/"+strconv.FormatInt(number, 10), state); saveErr != nil {
			state.lastSuccess = s.install.streams[streamKey].lastSuccess
			err = errors.Join(err, saveErr)
			state.lastError = err
		}
		s.install.streams[streamKey] = state
	}()
	if err = s.authorizeFetched(ctx, row); err != nil {
		return err
	}
	if pause.After(s.now()) {
		return GitHubRateLimitError(http.StatusTooManyRequests, http.Header{"Retry-After": {pause.UTC().Format(http.TimeFormat)}}, s.now())
	}
	var previous []byte
	if err = s.install.pool.QueryRow(ctx, `SELECT COALESCE(related_facts->$3,'{}'::jsonb)::text FROM github_synced_issues WHERE synced_repo_id=$1 AND resource='pulls' AND number=$2`, row.ID, number, kind).Scan(&previous); err != nil {
		return err
	}
	old := gitHubRelatedSnapshot{}
	if json.Unmarshal(previous, &old) != nil {
		return gitHubFetchUnavailable()
	}
	snapshot := gitHubRelatedSnapshot{Head: head, Pages: map[string]json.RawMessage{}}
	pending := map[gitHubPageKey]gitHubPageValidator{}
	if s.conditionalFetcherFactory == nil {
		return gitHubFetchUnavailable()
	}
	fetch := s.conditionalFetcherFactory(row)
	if fetch == nil {
		return gitHubFetchUnavailable()
	}
	for _, resource := range resources {
		if !gitHubPullFactResource(resource) {
			return gitHubFetchUnavailable()
		}
		for page := 1; ; page++ {
			if page > githubRepoMetadataMaxPage {
				return fmt.Errorf("GitHub pull facts exceed pagination limit")
			}
			if err = ctx.Err(); err != nil {
				return err
			}
			query := url.Values{"per_page": {"100"}, "page": {strconv.Itoa(page)}}
			if strings.HasSuffix(resource, "/check-runs") {
				query.Set("filter", "latest")
			}
			path := resource + "?" + query.Encode()
			key := gitHubPageKey{syncedStreamKey(row, resource), query.Encode()}
			s.install.mu.Lock()
			validator := s.install.etags[key]
			s.install.mu.Unlock()
			if old.Head != head || old.Pages[path] == nil || validator.objectVersion != gitHubPullVersion(string(previous)) {
				validator = gitHubPageValidator{}
			}
			response, fetchErr := fetch(ctx, resource, query, validator.etag)
			if fetchErr != nil {
				return fetchErr
			}
			body := response.Body
			if response.NotModified {
				if validator.etag == "" {
					return GitHubRequestFailure(ctx, "GitHub returned 304 without a committed related validator")
				}
				body = old.Pages[path]
			}
			count, decodeErr := gitHubRelatedPageCount(resource, body)
			if decodeErr != nil {
				return decodeErr
			}
			snapshot.Pages[path] = body
			etag := response.ETag
			if response.NotModified && etag == "" {
				etag = validator.etag
			}
			pending[key] = gitHubPageValidator{etag: etag}
			if count < 100 {
				break
			}
		}
	}
	facts := map[string]any{"head": head, "pages": snapshot.Pages}
	for _, resource := range resources {
		objects := []json.RawMessage{}
		for page := 1; ; page++ {
			query := url.Values{"per_page": {"100"}, "page": {strconv.Itoa(page)}}
			if strings.HasSuffix(resource, "/check-runs") {
				query.Set("filter", "latest")
			}
			body, ok := snapshot.Pages[resource+"?"+query.Encode()]
			if !ok {
				break
			}
			var entries []json.RawMessage
			if strings.HasSuffix(resource, "/check-runs") {
				var envelope struct {
					Runs []json.RawMessage `json:"check_runs"`
				}
				json.Unmarshal(body, &envelope)
				entries = envelope.Runs
			} else {
				json.Unmarshal(body, &entries)
			}
			objects = append(objects, entries...)
		}
		facts[resource] = objects
	}
	raw, err := json.Marshal(facts)
	if err != nil {
		return err
	}
	var canonical string
	err = pgx.BeginFunc(ctx, s.install.pool, func(tx pgx.Tx) error {
		current, e := lockFetchedRepo(ctx, tx, row.ID)
		if e != nil {
			return e
		}
		if current.InstallationID != row.InstallationID || current.GithubRepositoryID != row.GithubRepositoryID || current.OwnerLogin != row.OwnerLogin || current.RepoName != row.RepoName {
			return gitHubFetchUnavailable()
		}
		if e = s.authorizeFetched(ctx, current); e != nil {
			return e
		}
		var currentHead, currentFacts string
		e = tx.QueryRow(ctx, `SELECT payload#>>'{head,sha}',COALESCE(related_facts->$3,'{}'::jsonb)::text FROM github_synced_issues WHERE synced_repo_id=$1 AND resource='pulls' AND number=$2 FOR UPDATE`, row.ID, number, kind).Scan(&currentHead, &currentFacts)
		if e != nil {
			return e
		}
		if currentHead != head || currentFacts != string(previous) {
			return gitHubFetchUnavailable()
		}
		if e = tx.QueryRow(ctx, `SELECT $1::jsonb::text`, raw).Scan(&canonical); e != nil {
			return e
		}
		if kind == "reviews" {
			comments, _ := facts["issues/"+strconv.FormatInt(number, 10)+"/comments"].([]json.RawMessage)
			if e = s.commitFetchedConversationSnapshot(ctx, tx, row, number, snapshotAt, comments); e != nil {
				return e
			}
			if e = s.admitFetchedReviewSnapshot(ctx, tx, row, number, facts); e != nil {
				return e
			}
		}

		if _, e = tx.Exec(ctx, `UPDATE github_synced_issues SET related_facts=jsonb_set(related_facts,ARRAY[$3],$4::jsonb),updated_at=NOW() WHERE synced_repo_id=$1 AND resource='pulls' AND number=$2`, row.ID, number, kind, canonical); e != nil {
			return e
		}
		if e = s.admitFetchedObject(ctx, tx, row, kind, number, number, json.RawMessage(canonical)); e != nil {
			return e
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.install.mu.Lock()
	defer s.install.mu.Unlock()
	if s.install.etags == nil {
		s.install.etags = map[gitHubPageKey]gitHubPageValidator{}
	}
	for key, validator := range pending {
		validator.objectVersion = gitHubPullVersion(canonical)
		if validator.etag == "" {
			delete(s.install.etags, key)
		} else {
			s.install.etags[key] = validator
		}
	}
	return nil
}

func gitHubRelatedPageCount(resource string, body json.RawMessage) (int, error) {
	var objects []json.RawMessage
	if strings.HasSuffix(resource, "/check-runs") {
		var runs struct {
			Runs []json.RawMessage `json:"check_runs"`
		}
		if json.Unmarshal(body, &runs) != nil || runs.Runs == nil {
			return 0, GitHubRequestFailure(context.Background(), "GitHub returned invalid check runs")
		}
		objects = runs.Runs
	} else if json.Unmarshal(body, &objects) != nil || objects == nil {
		return 0, GitHubRequestFailure(context.Background(), "GitHub returned invalid related facts")
	}
	return len(objects), nil
}

func (s *GitHubSyncedRepoService) sharedRetryOwner() *GitHubSyncedRepoService { return s }
func (g gitHubPullFactStreams) sharedRetryOwner() *GitHubSyncedRepoService    { return g.service }
