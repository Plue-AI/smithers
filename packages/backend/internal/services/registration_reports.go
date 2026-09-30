package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
)

// registrationReportHost is the source host of every shared report: the
// registration app analyses GitHub repositories only.
const registrationReportHost = "github.com"

const registrationReportMaxBytes = 1 << 20

var (
	registrationCommitPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
	registrationRepoPattern   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,38})/[a-z0-9._-]{1,100}$`)
)

// ErrRegistrationReportUnshareable is returned for a repository GitHub does
// not serve anonymously, a commit it does not have, or a report that does not
// describe the repository and commit it is recorded for. Nothing is stored.
var ErrRegistrationReportUnshareable = errors.New("registration report is not shareable")

// SharedRegistrationReport is one account's finished registration report,
// served to any account registering the same public repository at the same
// commit.
type SharedRegistrationReport struct {
	Repo       string          `json:"repo"`
	Commit     string          `json:"commit"`
	Report     json.RawMessage `json:"report"`
	RecordedAt time.Time       `json:"recordedAt"`
}

// RegistrationReports shares registration reports across accounts (#2158).
// Only public GitHub repositories are shared: every write and every read asks
// GitHub anonymously, so a repository that is private, renamed private or gone
// has no shared report, and a report is never taken from a client.
type RegistrationReports struct {
	queries *db.Queries
	client  *http.Client
}

func NewRegistrationReports(dbtx db.DBTX) *RegistrationReports {
	return &RegistrationReports{queries: db.New(dbtx), client: observability.NewHTTPClient(15 * time.Second)}
}

// github answers one anonymous GitHub API read: the status and up to 1 MiB of body.
func (s *RegistrationReports) github(ctx context.Context, path, accept string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubAPIBaseURL()+path, nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", "smithers-server")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, body, err
}

func repoPath(repo string) (string, error) {
	if !registrationRepoPattern.MatchString(repo) {
		return "", fmt.Errorf("%w: invalid repository", ErrRegistrationReportUnshareable)
	}
	owner, name, _ := strings.Cut(repo, "/")
	return "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name), nil
}

// publicHead is the commit a public repository's default branch points at. A
// repository GitHub hides from an anonymous caller answers ok=false; an
// unreadable answer is an error, never "private".
func (s *RegistrationReports) publicHead(ctx context.Context, repo string) (string, bool, error) {
	path, err := repoPath(repo)
	if err != nil {
		return "", false, nil
	}
	status, body, err := s.github(ctx, path, "application/vnd.github+json")
	if err != nil {
		return "", false, err
	}
	switch {
	case status == http.StatusNotFound:
		return "", false, nil
	case status != http.StatusOK:
		return "", false, fmt.Errorf("github repository read answered %d", status)
	}
	var metadata struct {
		Private bool `json:"private"`
	}
	if err := json.Unmarshal(body, &metadata); err != nil {
		return "", false, err
	}
	if metadata.Private {
		return "", false, nil
	}
	status, body, err = s.github(ctx, path+"/commits/HEAD", "application/vnd.github.sha")
	if err != nil {
		return "", false, err
	}
	head := strings.TrimSpace(string(body))
	if status != http.StatusOK || !registrationCommitPattern.MatchString(head) {
		return "", false, fmt.Errorf("github head read answered %d", status)
	}
	return head, true, nil
}

func (s *RegistrationReports) publicCommit(ctx context.Context, repo, commit string) (bool, error) {
	if _, ok, err := s.publicHead(ctx, repo); err != nil || !ok {
		return false, err
	}
	path, _ := repoPath(repo)
	status, _, err := s.github(ctx, path+"/commits/"+commit, "application/vnd.github.sha")
	if err != nil {
		return false, err
	}
	switch status {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound, http.StatusUnprocessableEntity:
		return false, nil
	}
	return false, fmt.Errorf("github commit read answered %d", status)
}

// Record stores the finished report of a public repository for its analysed
// commit. The first report of a commit stays. It reports whether a row was written.
func (s *RegistrationReports) Record(ctx context.Context, repo, commit string, report json.RawMessage) (bool, error) {
	if !registrationRepoPattern.MatchString(repo) || !registrationCommitPattern.MatchString(commit) || len(report) > registrationReportMaxBytes {
		return false, ErrRegistrationReportUnshareable
	}
	var described struct {
		Repo  string `json:"repo"`
		Clone struct {
			Repo   string `json:"repo"`
			Commit string `json:"commit"`
		} `json:"clone"`
	}
	if json.Unmarshal(report, &described) != nil || described.Repo != repo || described.Clone.Repo != repo || described.Clone.Commit != commit {
		return false, ErrRegistrationReportUnshareable
	}
	owner, name, _ := strings.Cut(repo, "/")
	if _, err := s.queries.GetRepositoryRegistrationReport(ctx, db.GetRepositoryRegistrationReportParams{Host: registrationReportHost, Owner: owner, Name: name, CommitSha: commit}); err == nil {
		return false, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	public, err := s.publicCommit(ctx, repo, commit)
	if err != nil {
		return false, err
	}
	if !public {
		return false, ErrRegistrationReportUnshareable
	}
	rows, err := s.queries.InsertRepositoryRegistrationReport(ctx, db.InsertRepositoryRegistrationReportParams{
		Host: registrationReportHost, Owner: owner, Name: name, CommitSha: commit, Report: report,
	})
	return rows == 1, err
}

// Lookup serves the report recorded for the public repository's current
// commit. A private, unreadable or unanalysed repository answers ok=false.
func (s *RegistrationReports) Lookup(ctx context.Context, repo string) (SharedRegistrationReport, bool, error) {
	head, public, err := s.publicHead(ctx, repo)
	if err != nil || !public {
		return SharedRegistrationReport{}, false, err
	}
	owner, name, _ := strings.Cut(repo, "/")
	row, err := s.queries.GetRepositoryRegistrationReport(ctx, db.GetRepositoryRegistrationReportParams{Host: registrationReportHost, Owner: owner, Name: name, CommitSha: head})
	if errors.Is(err, pgx.ErrNoRows) {
		return SharedRegistrationReport{}, false, nil
	}
	if err != nil {
		return SharedRegistrationReport{}, false, err
	}
	return SharedRegistrationReport{Repo: repo, Commit: row.CommitSha, Report: row.Report, RecordedAt: row.RecordedAt}, true, nil
}
