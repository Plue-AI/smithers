package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const gitHubIssueEvents = "issues/events"

type gitHubFetchedEvent struct {
	ID    int64           `json:"id"`
	Event string          `json:"event"`
	Issue json.RawMessage `json:"issue"`
	Actor gitHubActor     `json:"actor"`
	Label struct {
		Name string `json:"name"`
	} `json:"label"`
	CreatedAt time.Time        `json:"created_at"`
	ViaApp    *json.RawMessage `json:"performed_via_github_app"`
}

func issueEventCursorKey(row db.GithubSyncedRepo) string {
	return fmt.Sprintf("github.issue-events.%d.%d", row.InstallationID.Int64, row.GithubRepositoryID.Int64)
}

type issueEventCursorReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func readIssueEventCursor(ctx context.Context, q issueEventCursorReader, row db.GithubSyncedRepo) (int64, error) {
	var cursor int64
	err := q.QueryRow(ctx, `SELECT (value #>> '{}')::bigint FROM install_settings WHERE key=$1`, issueEventCursorKey(row)).Scan(&cursor)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err == nil && cursor < 0 {
		err = errors.New("invalid GitHub issue-event cursor")
	}
	return cursor, err
}

// backfillIssueEvents walks the repository stream to its saved boundary before
// committing anything. Interrupted reads leave the cursor intact.
func (s *GitHubSyncedRepoService) backfillIssueEvents(ctx context.Context, row db.GithubSyncedRepo, fetch gitHubSyncedRepoPageFetcher) error {
	if err := s.authorizeFetched(ctx, row); err != nil {
		return err
	}
	cursor, err := readIssueEventCursor(ctx, s.install.pool, row)
	if err != nil {
		return err
	}
	objects, _, err := readGitHubIssueEvents(ctx, cursor, fetch)
	if err != nil {
		return err
	}
	return s.commitIssueEvents(ctx, row, objects)
}

// issueEventPages adapts the existing authenticated HTTP client to the one
// repository event reader. It never requests a per-issue event endpoint.
func (g *landingGitHubAPI) issueEventPages(token, owner, repo string) gitHubSyncedRepoPageFetcher {
	return func(ctx context.Context, _ string, query url.Values) (json.RawMessage, error) {
		var body json.RawMessage
		path := landingGitHubRepoPath(owner, repo) + "/issues/events?per_page=100&page=" + query.Get("page")
		status, err := g.request(ctx, token, http.MethodGet, path, nil, &body)
		if err != nil {
			return nil, err
		}
		if status != http.StatusOK {
			return nil, landingGitHubStatusError(status, owner, repo, "read issue events")
		}
		return body, nil
	}
}

// readGitHubIssueEvents returns a complete interval, newest first. The caller
// either commits that interval atomically or uses it for a provenance read.
func readGitHubIssueEvents(ctx context.Context, cursor int64, fetch gitHubSyncedRepoPageFetcher) ([]json.RawMessage, int64, error) {
	var objects []json.RawMessage
	seen := make(map[int64]bool)
	var previous, newest int64
	for page := 1; ; page++ {
		if err := ctx.Err(); err != nil {
			return nil, 0, err
		}
		body, err := fetch(ctx, gitHubIssueEvents, url.Values{"per_page": {"100"}, "page": {strconv.Itoa(page)}})
		if err != nil {
			return nil, 0, err
		}
		var batch []json.RawMessage
		if err := json.Unmarshal(body, &batch); err != nil || batch == nil {
			return nil, 0, errors.New("invalid GitHub issue-event page")
		}
		boundary := false
		for _, object := range batch {
			var event gitHubFetchedEvent
			if json.Unmarshal(object, &event) != nil || event.ID <= 0 || event.Event == "" {
				return nil, 0, errors.New("invalid GitHub issue event")
			}
			if seen[event.ID] {
				continue // New arrivals can shift an already-read event to the next page.
			}
			if previous != 0 && event.ID > previous {
				return nil, 0, errors.New("GitHub issue events are not newest first")
			}
			newest = max(newest, event.ID)
			seen[event.ID] = true
			previous = event.ID
			if event.ID <= cursor {
				boundary = true
				continue
			}
			objects = append(objects, object)
		}
		if boundary || len(batch) < 100 {
			return objects, newest, nil
		}
	}
}

// The cursor marks durable admission, not successful downstream effects. Every
// admitted event remains in the shared jobs store until its consumer settles it.
func (s *GitHubSyncedRepoService) commitIssueEvents(ctx context.Context, row db.GithubSyncedRepo, objects []json.RawMessage) error {
	if err := s.authorizeFetched(ctx, row); err != nil {
		return err
	}
	type entry struct {
		event gitHubFetchedEvent
		raw   json.RawMessage
	}
	entries := make([]entry, len(objects))
	for i, object := range objects {
		if json.Unmarshal(object, &entries[i].event) != nil || entries[i].event.ID <= 0 || entries[i].event.Event == "" {
			return errors.New("invalid GitHub issue event")
		}
		entries[i].raw = object
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].event.ID < entries[j].event.ID })
	return pgx.BeginFunc(ctx, s.install.pool, func(tx pgx.Tx) error {
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
		cursor, err := readIssueEventCursor(ctx, tx, row)
		if err != nil {
			return err
		}
		for _, item := range entries {
			event := item.event
			if event.ID <= cursor {
				continue
			}
			// The embedded issue is cached data, never proof of who authored its
			// current text. Label admission must separately verify text provenance.
			if err := s.commitFetchedIssue(ctx, tx, row, GitHubRepoMetadataIssues, event.Issue); err != nil {
				return err
			}
			var issue gitHubIssueHeader
			if err := json.Unmarshal(event.Issue, &issue); err != nil {
				return err
			}
			version := strconv.FormatInt(event.ID, 10)
			payload, err := json.Marshal(gitHubFetchedObject{GitHubRepository: row.GithubRepositoryID.Int64, Installation: row.InstallationID.Int64, Repo: row.ID, Resource: gitHubIssueEvents, Number: issue.Number, Version: version, EventID: event.ID, Object: item.raw})
			if err != nil {
				return err
			}
			_, err = s.install.jobs.AdmitInTx(ctx, tx, jobs.Admission{
				Scope:     jobs.Scope{TenantID: fmt.Sprintf("github:%d:%d", row.InstallationID.Int64, row.GithubRepositoryID.Int64), PrincipalID: gitHubIssueEvents},
				Operation: githubFetchedOperation, RequestID: version, Payload: payload, AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectIdempotent,
			})
			if err != nil {
				return err
			}
			cursor = event.ID
		}
		_, err = tx.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES($1,to_jsonb($2::bigint)) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, issueEventCursorKey(row), cursor)
		return err
	})
}
