package services

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// Retention only adds immutable workspace source roots. It never synchronizes
// GitHub branches, imports a mirror, or changes a user's bookmark.
type RepositorySourceRetentionInput struct {
	WorkspaceID string `json:"workspace_id"`
	Kind        string `json:"kind"`
	Number      int64  `json:"number,omitempty"`
	Head        string `json:"head"`
	Base        string `json:"base"`
	Ref         string `json:"ref,omitempty"`
	DeliveryKey string `json:"delivery_key,omitempty"`
}

type RepositorySourceRetentionResult struct {
	Status      string `json:"status"`
	Source      string `json:"source"`
	FullName    string `json:"full_name"`
	WorkspaceID string `json:"workspace_id"`
	Head        string `json:"head"`
	Base        string `json:"base"`
	HeadRef     string `json:"head_ref"`
	BaseRef     string `json:"base_ref,omitempty"`
	CloneURL    string `json:"clone_url"`
}

type repositorySourceRetentionStore interface {
	accessTokenStore
	GetWorkspaceByRepo(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error)
	GetRepoOwnerSlugAndNameByID(context.Context, int64) (db.GetRepoOwnerSlugAndNameByIDRow, error)
	GetRepositorySourcePushEvent(context.Context, db.GetRepositorySourcePushEventParams) (json.RawMessage, error)
}

type repositorySourceAuthority interface {
	authorizedRepo(context.Context, int64, int64, bool) (db.Repository, error)
	Source(context.Context, int64, int64) (RepositorySource, error)
}

type RepositorySourceRetentionService struct {
	q       repositorySourceRetentionStore
	jobs    repositorySourceAuthority
	imports *GitHubImportService
	runGit  func(context.Context, []string, ...string) (string, error)
	slots   chan struct{}
}

func NewRepositorySourceRetentionService(q repositorySourceRetentionStore, jobs repositorySourceAuthority, imports *GitHubImportService) *RepositorySourceRetentionService {
	return &RepositorySourceRetentionService{q: q, jobs: jobs, imports: imports, runGit: runSourceRetentionGit, slots: make(chan struct{}, 2)}
}

var repositorySourceSHA = regexp.MustCompile(`^[0-9a-f]{40}$`)
var repositorySourceName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$`)

const sourceZeroSHA = "0000000000000000000000000000000000000000"

func sourceRetentionError(code string) *pkgerrors.APIError {
	var err *pkgerrors.APIError
	switch code {
	case "source_missing":
		err = pkgerrors.NotFound("The original source is no longer available")
	case "source_changed":
		err = pkgerrors.Conflict("The source changed; inspect the current pull request or push again")
	case "source_refused":
		err = pkgerrors.Forbidden("Source access was refused")
	default:
		err = pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Source retention could not complete; retry")
	}
	// Retain the common HTTP error contract and a bounded, stable domain reason.
	err.Details = map[string]string{"reason": code}
	return err
}

func validateSourceRetention(input RepositorySourceRetentionInput) error {
	id, err := uuid.Parse(input.WorkspaceID)
	if err != nil || id == uuid.Nil || id.String() != input.WorkspaceID || !repositorySourceSHA.MatchString(input.Head) || input.Head == sourceZeroSHA || !repositorySourceSHA.MatchString(input.Base) {
		return pkgerrors.BadRequest("Source retention requires a workspace UUID and exact commit IDs")
	}
	switch input.Kind {
	case "pull_request":
		if input.Number <= 0 || input.Base == sourceZeroSHA || input.Ref != "" || input.DeliveryKey != "" {
			return pkgerrors.BadRequest("Pull request retention requires its number, base, and head")
		}
	case "push":
		_, err := uuid.Parse(strings.TrimPrefix(input.DeliveryKey, "github:"))
		if input.Number != 0 || !strings.HasPrefix(input.DeliveryKey, "github:") || err != nil || !strings.HasPrefix(input.Ref, "refs/heads/") || len(input.Ref) > 512 || strings.ContainsAny(input.Ref, "\x00\r\n") {
			return pkgerrors.BadRequest("Push retention requires the admitted delivery identity and branch ref")
		}
	default:
		return pkgerrors.BadRequest("Unsupported source kind")
	}
	return nil
}

func (s *RepositorySourceRetentionService) authorize(ctx context.Context, repoID, userID int64, workspaceID string) (db.Workspace, error) {
	if _, err := s.jobs.authorizedRepo(ctx, repoID, userID, true); err != nil {
		return db.Workspace{}, err
	}
	w, err := s.q.GetWorkspaceByRepo(ctx, db.GetWorkspaceByRepoParams{ID: workspaceID, RepositoryID: repoID})
	if errors.Is(err, pgx.ErrNoRows) {
		return w, sourceRetentionError("source_missing")
	}
	if err != nil {
		return w, sourceRetentionError("source_retention_unavailable")
	}
	if w.UserID != userID || w.RepositoryID != repoID || w.DeletedAt.Valid || (w.Kind != "vm" && w.Kind != "container") {
		return w, sourceRetentionError("source_refused")
	}
	return w, nil
}

func (s *RepositorySourceRetentionService) Retain(ctx context.Context, repoID, userID int64, input RepositorySourceRetentionInput) (RepositorySourceRetentionResult, error) {
	var result RepositorySourceRetentionResult
	if err := validateSourceRetention(input); err != nil {
		return result, err
	}
	if _, err := s.authorize(ctx, repoID, userID, input.WorkspaceID); err != nil {
		return result, err
	}
	source, err := s.jobs.Source(ctx, repoID, userID)
	if err != nil {
		return result, err
	}
	owner, name, found := strings.Cut(source.FullName, "/")
	if source.Source != "github" || !found || !repositorySourceName.MatchString(owner) || !repositorySourceName.MatchString(name) {
		return result, sourceRetentionError("source_refused")
	}
	if input.Kind == "push" {
		payload, err := s.q.GetRepositorySourcePushEvent(ctx, db.GetRepositorySourcePushEventParams{RepositoryID: repoID, DeliveryKey: input.DeliveryKey})
		if errors.Is(err, pgx.ErrNoRows) {
			return result, sourceRetentionError("source_refused")
		}
		if err != nil {
			return result, sourceRetentionError("source_retention_unavailable")
		}
		if err := verifyRetainedPush(payload, source.FullName, input); err != nil {
			return result, err
		}
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		return result, sourceRetentionError("source_retention_unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, 180*time.Second)
	defer cancel()
	// Reuse the import's exact-source installation/OAuth credentials and its
	// pre-transfer size limit. No GitHub credential ever reaches the workspace.
	token, _, _, err := s.imports.githubCloneInfoForRepo(ctx, userID, owner, name)
	if err != nil {
		var api *pkgerrors.APIError
		if errors.As(err, &api) && (api.Status == 401 || api.Status == 403 || api.Status == 404) {
			return result, sourceRetentionError("source_refused")
		}
		return result, sourceRetentionError("source_retention_unavailable")
	}
	if input.Kind == "pull_request" {
		if err := s.verifyPR(ctx, token, source.FullName, input); err != nil {
			return result, err
		}
	}
	slug, err := s.q.GetRepoOwnerSlugAndNameByID(ctx, repoID)
	if err != nil {
		return result, sourceRetentionError("source_retention_unavailable")
	}
	cloneURL, err := buildRepoCloneURL(s.imports.gitBaseURL, slug.OwnerSlug, slug.RepoName)
	if err != nil {
		return result, sourceRetentionError("source_retention_unavailable")
	}
	result = RepositorySourceRetentionResult{Status: "retained", Source: "github", FullName: source.FullName,
		WorkspaceID: input.WorkspaceID, Head: input.Head, Base: input.Base, CloneURL: cloneURL.String(),
		HeadRef: repohost.WorkspaceSourceRef(input.WorkspaceID, input.Head)}
	if input.Base != sourceZeroSHA {
		result.BaseRef = repohost.WorkspaceSourceRef(input.WorkspaceID, input.Base)
	}
	tmp, err := os.MkdirTemp("", "smithers-source-retention-")
	if err != nil {
		return result, sourceRetentionError("source_retention_unavailable")
	}
	defer os.RemoveAll(tmp)
	// Full ancestry is required for CI. Bound both transfer time and actual
	// scratch bytes instead of returning an incomplete shallow history.
	var tooLarge atomic.Bool
	done := make(chan struct{})
	defer func() { cancel(); <-done }()
	go watchSourceRetentionBytes(ctx, cancel, tmp, 256<<20, &tooLarge, done)
	baseEnv := sourceRetentionGitEnv("", "")
	if _, err := s.runGit(ctx, baseEnv, "init", "--bare", "--template=", tmp); err != nil {
		return result, sourceRetentionError("source_retention_unavailable")
	}
	sourceURL := "https://github.com/" + source.FullName + ".git"
	credential := ""
	if token != "" {
		credential = "Basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token))
	}
	githubEnv := sourceRetentionGitEnv(sourceURL, credential)
	headSelector := input.Head
	if input.Kind == "pull_request" {
		headSelector = fmt.Sprintf("refs/pull/%d/head", input.Number)
	}
	args := []string{"--git-dir", tmp, "fetch", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", sourceURL, headSelector + ":refs/smithers-fetch/head"}
	if input.Base != sourceZeroSHA && input.Base != input.Head {
		args = append(args, input.Base+":refs/smithers-fetch/base")
	}
	if _, err := s.runGit(ctx, githubEnv, args...); err != nil {
		if ctx.Err() != nil || tooLarge.Load() {
			return result, sourceRetentionError("source_retention_unavailable")
		}
		return result, sourceRetentionError("source_missing")
	}
	for ref, sha := range map[string]string{"refs/smithers-fetch/head": input.Head, "refs/smithers-fetch/base": input.Base} {
		if ref == "refs/smithers-fetch/base" && (sha == sourceZeroSHA || sha == input.Head) {
			continue
		}
		actual, err := s.runGit(ctx, baseEnv, "--git-dir", tmp, "rev-parse", "--verify", ref+"^{commit}")
		if err != nil || strings.TrimSpace(actual) != sha {
			return result, sourceRetentionError("source_changed")
		}
	}
	// A moved PR during the transfer is a changed source, never a review of an
	// older revision presented as current. Signed pushes deliberately stay exact.
	if input.Kind == "pull_request" {
		if err := s.verifyPR(ctx, token, source.FullName, input); err != nil {
			return result, err
		}
	}
	if _, err := s.authorize(ctx, repoID, userID, input.WorkspaceID); err != nil {
		return result, err
	}
	latest, err := s.jobs.Source(ctx, repoID, userID)
	if err != nil || latest != source {
		return result, sourceRetentionError("source_changed")
	}
	push, err := issueTemporaryRepoTokenWithTTL(ctx, s.q, userID, "repository-source-retention", workspaceHeadTokenScopes(repoID, input.WorkspaceID), 5*time.Minute)
	if err != nil {
		return result, sourceRetentionError("source_retention_unavailable")
	}
	defer revokeTemporaryRepoCloneToken(ctx, s.q, userID, push.ID)
	pushEnv := sourceRetentionGitEnv(result.CloneURL, "Bearer "+push.Plaintext)
	args = []string{"--git-dir", tmp, "push", "--atomic", "--porcelain", "--no-verify", result.CloneURL, input.Head + ":" + result.HeadRef}
	refs := []string{result.HeadRef}
	if result.BaseRef != "" && result.BaseRef != result.HeadRef {
		args = append(args, input.Base+":"+result.BaseRef)
		refs = append(refs, result.BaseRef)
	}
	if _, err := s.runGit(ctx, pushEnv, args...); err != nil {
		return result, sourceRetentionError("source_retention_unavailable")
	}
	actual, err := s.runGit(ctx, pushEnv, append([]string{"ls-remote", "--refs", result.CloneURL}, refs...)...)
	if err != nil || !verifyRetainedRefs(actual, result) {
		return result, sourceRetentionError("source_retention_unavailable")
	}
	return result, nil
}

func verifyRetainedPush(payload []byte, fullName string, input RepositorySourceRetentionInput) error {
	var event struct {
		Before     string `json:"before"`
		After      string `json:"after"`
		Ref        string `json:"ref"`
		Deleted    bool   `json:"deleted"`
		Repository struct {
			FullName string `json:"full_name"`
		} `json:"repository"`
	}
	if json.Unmarshal(payload, &event) != nil || event.Deleted || !strings.EqualFold(event.Repository.FullName, fullName) || event.Before != input.Base || event.After != input.Head || event.Ref != input.Ref {
		return sourceRetentionError("source_refused")
	}
	return nil
}

func (s *RepositorySourceRetentionService) verifyPR(ctx context.Context, token, fullName string, input RepositorySourceRetentionInput) error {
	u := strings.TrimRight(githubAPIBaseURL(), "/") + "/repos/" + fullName + "/pulls/" + strconv.FormatInt(input.Number, 10)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return sourceRetentionError("source_retention_unavailable")
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	// Never forward a private source credential through a redirect.
	client := *s.imports.httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return sourceRetentionError("source_retention_unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return sourceRetentionError("source_missing")
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return sourceRetentionError("source_refused")
	}
	if resp.StatusCode != 200 {
		return sourceRetentionError("source_retention_unavailable")
	}
	var pr struct {
		Number int64 `json:"number"`
		Base   struct {
			SHA  string `json:"sha"`
			Repo struct {
				FullName string `json:"full_name"`
			} `json:"repo"`
		} `json:"base"`
		Head struct {
			SHA string `json:"sha"`
		} `json:"head"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&pr) != nil {
		return sourceRetentionError("source_retention_unavailable")
	}
	if pr.Number != input.Number || !strings.EqualFold(pr.Base.Repo.FullName, fullName) {
		return sourceRetentionError("source_refused")
	}
	if pr.Base.SHA != input.Base || pr.Head.SHA != input.Head {
		return sourceRetentionError("source_changed")
	}
	return nil
}

func verifyRetainedRefs(output string, result RepositorySourceRetentionResult) bool {
	want := map[string]string{result.HeadRef: result.Head}
	if result.BaseRef != "" {
		want[result.BaseRef] = result.Base
	}
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || want[fields[1]] != fields[0] {
			return false
		}
		delete(want, fields[1])
	}
	return len(want) == 0
}

func sourceRetentionGitEnv(authURL, credential string) []string {
	env := []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=false", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}
	var config [][2]string
	if authURL != "" && credential != "" {
		parsed, _ := url.Parse(authURL)
		config = append(config, [2]string{"http." + parsed.String() + ".extraHeader", "Authorization: " + credential})
	}
	env = append(env, "GIT_CONFIG_COUNT="+strconv.Itoa(len(config)))
	for i, item := range config {
		env = append(env, fmt.Sprintf("GIT_CONFIG_KEY_%d=%s", i, item[0]), fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", i, item[1]))
	}
	return env
}

type retentionOutput struct{ bytes.Buffer }

func (b *retentionOutput) Write(p []byte) (int, error) {
	n := len(p)
	if remaining := (64 << 10) - b.Len(); remaining > 0 {
		_, _ = b.Buffer.Write(p[:min(remaining, n)])
	}
	return n, nil
}

// sourceRetentionGitCommand is shared by host object transfers and their
// measurements. None of these operations checks out files or runs repository
// tools; only OS Git and its HTTP transport can execute. Command-line policy
// overrides repository configuration even when credentials replace env config.
func sourceRetentionGitCommand(ctx context.Context, env []string, args ...string) *exec.Cmd {
	policy := []string{
		"-c", "core.hooksPath=/dev/null", "-c", "credential.helper=",
		"-c", "core.fsmonitor=false", "-c", "core.alternateRefsCommand=",
		"-c", "diff.external=", "-c", "http.followRedirects=false",
		"-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=30",
		"-c", "pack.threads=1", "-c", "fetch.fsckObjects=true",
		"-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
		"-c", "protocol.http.allow=always", "-c", "protocol.file.allow=never",
		"-c", "protocol.ext.allow=never", "-c", "protocol.ssh.allow=never",
		"-c", "protocol.git.allow=never",
	}
	cmd := exec.CommandContext(ctx, "/usr/bin/git", append(policy, args...)...)
	cmd.Env = env
	return cmd
}

func runSourceRetentionGit(ctx context.Context, env []string, args ...string) (string, error) {
	cmd := sourceRetentionGitCommand(ctx, env, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	var out retentionOutput
	cmd.Stdout, cmd.Stderr = &out, io.Discard
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	return out.String(), err
}

func watchSourceRetentionBytes(ctx context.Context, cancel context.CancelFunc, path string, limit int64, exceeded *atomic.Bool, done chan struct{}) {
	defer close(done)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			var size int64
			_ = filepath.WalkDir(path, func(_ string, entry os.DirEntry, err error) error {
				if err == nil && !entry.IsDir() {
					if info, err := entry.Info(); err == nil {
						size += info.Size()
					}
				}
				if size > limit {
					exceeded.Store(true)
					cancel()
					return io.EOF
				}
				return nil
			})
		}
	}
}
