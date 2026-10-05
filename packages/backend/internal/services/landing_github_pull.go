package services

import (
	"bytes"
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// A repository whose GitHub policy is `changes: "send-upstream"` delivers a
// landing as a GitHub pull request that a maintainer merges on GitHub. GitHub
// then owns main and Smithers follows it; Smithers never appends to its own
// main for such a landing, so there is one writer of main.
//
// The pull request is keyed by the landing: its head branch is
// smithers/landing-<number> on the GitHub repository. A retry finds the same
// branch and pull request, so no request pushes twice or opens a duplicate.
const landingGitHubPullTimeout = 5 * time.Minute

const landingGitHubPullBranchPrefix = "smithers/landing-"

// LandingGitHubPullBranch is the GitHub head branch of one landing's pull request.
func LandingGitHubPullBranch(number int64) string {
	return landingGitHubPullBranchPrefix + strconv.FormatInt(number, 10)
}

// LandingGitHubPullInput names the exact landing tip the caller verified.
type LandingGitHubPullInput struct {
	CommitID string
	RunID    string
}

// LandingGitHubPull is GitHub's pull request for one landing.
type LandingGitHubPull struct {
	LandingNumber int64  `json:"landing_number"`
	Repository    string `json:"repository"`
	Number        int64  `json:"number"`
	URL           string `json:"url"`
	State         string `json:"state"`
	Merged        bool   `json:"merged"`
	HeadRef       string `json:"head_ref"`
	HeadSHA       string `json:"head_sha"`
	BaseRef       string `json:"base_ref"`
	Created       bool   `json:"created"`
}

// landingGitHubRemotes are resolved per request and never persisted. The
// source URL carries a short-lived Smithers read token; the target URL and
// token carry a GitHub App installation token.
type landingGitHubRemotes struct {
	githubOwner string
	githubRepo  string
	sourceURL   string
	targetURL   string
	token       string
	cleanup     func()
}

func (r landingGitHubRemotes) close() {
	if r.cleanup != nil {
		r.cleanup()
	}
}

type landingGitHubPullRequest struct {
	Number   int64   `json:"number"`
	NodeID   string  `json:"node_id"`
	Draft    bool    `json:"draft"`
	HTMLURL  string  `json:"html_url"`
	State    string  `json:"state"`
	MergedAt *string `json:"merged_at"`
	// MergeCommitSHA is GitHub's merge commit once MergedAt is set.
	MergeCommitSHA *string `json:"merge_commit_sha"`
	Head           struct {
		Ref  string `json:"ref"`
		SHA  string `json:"sha"`
		Repo *struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"head"`
	Base struct {
		Ref string `json:"ref"`
	} `json:"base"`
}

var errLandingGitHubPullExists = stdErrors.New("github pull request already exists")

type landingGitHubPulls interface {
	Find(ctx context.Context, token, owner, repo, branch string) (*landingGitHubPullRequest, error)
	Create(ctx context.Context, token, owner, repo string, input landingGitHubPullCreate) (*landingGitHubPullRequest, error)
	AheadBy(ctx context.Context, token, owner, repo, base, head string) (int, error)
}

type landingGitHubPullCreate struct {
	Title               string `json:"title"`
	Head                string `json:"head"`
	Base                string `json:"base"`
	Body                string `json:"body"`
	MaintainerCanModify bool   `json:"maintainer_can_modify"`
	Draft               bool   `json:"draft"`
}

// LandingGitHubPullService opens and reports the GitHub pull request of a landing.
type LandingGitHubPullService struct {
	landings *LandingService
	remotes  func(ctx context.Context, actor *db.User, repository db.Repository, owner, repo string) (landingGitHubRemotes, error)
	listRefs func(ctx context.Context, remote string) (map[string]string, error)
	push     func(ctx context.Context, sourceURL, sourceRef, commitID, targetURL, targetRef string) error
	github   landingGitHubPulls
}

// LandingGitHubPullTokens mints the repository owner's GitHub App
// installation tokens at dispatch, scoped to one repository and the named
// permissions. *RepoConnectionService implements it.
type LandingGitHubPullTokens interface {
	CreateGitHubInstallationTokenForRepositoryOwner(ctx context.Context, ownerUserID, ownerOrgID int64, owner, repo string, permissions map[string]string) (GitHubInstallationToken, error)
}

// Landing tokens never include workflows. GitHub refuses a push that adds or
// edits .github/workflows without it, so an agent-written workflow cannot run
// in the customer's repository with its secrets before a human merges.
var (
	landingGitHubPushPermissions = map[string]string{"contents": "write"}
	landingGitHubPullPermissions = map[string]string{"contents": "read", "pull_requests": "write"}
)

// NewLandingGitHubPullService resolves credentials at dispatch: the GitHub
// destination from the repository's recorded GitHub source, the acting user's
// proven GitHub push access, the repository owner's App installation token,
// and a disposable Smithers read token for the retained source.
func NewLandingGitHubPullService(landings *LandingService, q GitMirrorCredentialStore, tokens LandingGitHubPullTokens, prover GitHubRepoPushProver, sourceBaseURL string, connections RepoSyncConnectionChecker) *LandingGitHubPullService {
	s := &LandingGitHubPullService{
		landings: landings,
		listRefs: defaultListRemoteRefs,
		push:     defaultPushLandingCommit,
		github:   &landingGitHubAPI{client: gitHubProviderClient(tokens, 30*time.Second), baseURL: githubAPIBaseURL},
	}
	s.remotes = func(ctx context.Context, actor *db.User, repository db.Repository, owner, repo string) (landingGitHubRemotes, error) {
		if q == nil || tokens == nil {
			return landingGitHubRemotes{}, pkgerrors.Internal("GitHub pull requests are not configured")
		}
		githubOwner, githubRepo, err := resolveGitHubDestination(ctx, q, connections, actor.ID, repository.ID, owner, repo)
		if err != nil {
			return landingGitHubRemotes{}, err
		}
		// The App can write to far more repositories than this user. Every
		// platform write on a user's behalf first proves their own push access.
		if prover == nil {
			return landingGitHubRemotes{}, pkgerrors.Forbidden("GitHub push access cannot be proven")
		}
		if err := prover.GitHubRepoPushAuthorized(ctx, actor.ID, githubOwner, githubRepo); err != nil {
			return landingGitHubRemotes{}, pkgerrors.Forbidden("Your GitHub account must have push access to " + githubOwner + "/" + githubRepo).WithCause(err)
		}
		installation, err := tokens.CreateGitHubInstallationTokenForRepositoryOwner(ctx, repository.UserID.Int64, repository.OrgID.Int64, githubOwner, githubRepo, landingGitHubPushPermissions)
		if err != nil {
			return landingGitHubRemotes{}, err
		}
		if strings.TrimSpace(installation.Token) == "" {
			return landingGitHubRemotes{}, pkgerrors.BadRequest("github app is not installed for this repository")
		}
		pulls, err := tokens.CreateGitHubInstallationTokenForRepositoryOwner(ctx, repository.UserID.Int64, repository.OrgID.Int64, githubOwner, githubRepo, landingGitHubPullPermissions)
		if err != nil {
			return landingGitHubRemotes{}, err
		}
		if strings.TrimSpace(pulls.Token) == "" {
			return landingGitHubRemotes{}, pkgerrors.BadRequest("github app is not installed for this repository")
		}
		if _, err := gitMirrorURL(sourceBaseURL, "", owner, repo); err != nil {
			return landingGitHubRemotes{}, pkgerrors.Internal("landing source URL is not configured").WithCause(err)
		}
		scopes := string(middleware.ScopeReadRepository) + "," + middleware.RepositoryRestrictionScope(repository.ID)
		readToken, err := issueTemporaryRepoTokenWithTTL(ctx, q, actor.ID, "github-pull-read", scopes, landingGitHubPullTimeout+5*time.Minute)
		if err != nil {
			return landingGitHubRemotes{}, pkgerrors.Internal("create landing source credential").WithCause(err)
		}
		cleanup := func() { revokeTemporaryRepoCloneToken(context.Background(), q, actor.ID, readToken.ID) }
		source, err := gitMirrorURL(sourceBaseURL, readToken.Plaintext, owner, repo)
		if err != nil {
			cleanup()
			return landingGitHubRemotes{}, pkgerrors.Internal("build landing source URL").WithCause(err)
		}
		targetBase := githubGitBaseURL()
		target, err := gitMirrorURL(targetBase, installation.Token, githubOwner, githubRepo)
		if err != nil {
			cleanup()
			return landingGitHubRemotes{}, pkgerrors.Internal("build GitHub destination URL").WithCause(err)
		}
		return landingGitHubRemotes{githubOwner: githubOwner, githubRepo: githubRepo, sourceURL: source, targetURL: target,
			token: pulls.Token, cleanup: cleanup}, nil
	}
	return s
}

// OpenLandingGitHubPull pushes the landing's exact retained tip to its GitHub
// head branch and opens its pull request, or returns the one already open,
// closed or merged. It never pushes over a branch that moved.
func (s *LandingGitHubPullService) OpenLandingGitHubPull(ctx context.Context, actor *db.User, owner, repo string, number int64, input LandingGitHubPullInput) (LandingGitHubPull, error) {
	if actor == nil {
		return LandingGitHubPull{}, pkgerrors.Unauthorized("authentication required")
	}
	if s == nil || s.landings == nil || s.remotes == nil || s.github == nil || s.listRefs == nil || s.push == nil {
		return LandingGitHubPull{}, pkgerrors.Internal("GitHub pull requests are not configured")
	}
	commitID := strings.TrimSpace(input.CommitID)
	if !immutableLandingCommit(commitID) {
		return LandingGitHubPull{}, pkgerrors.BadRequest("commit_id must be a full commit ID")
	}
	if len(input.RunID) > 1024 || strings.ContainsAny(input.RunID, "\r\n`") {
		return LandingGitHubPull{}, pkgerrors.BadRequest("run_id is invalid")
	}
	repository, err := s.landings.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return LandingGitHubPull{}, err
	}
	if err := s.landings.requireWriteAccess(ctx, repository, actor); err != nil {
		return LandingGitHubPull{}, err
	}
	landing, err := s.landings.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return LandingGitHubPull{}, err
	}
	if landing.State != landingStateOpen {
		return LandingGitHubPull{}, pkgerrors.Conflict("landing request is not open")
	}
	if len(landing.ChangeIds) == 0 || len(landing.ChangeIds) > maxLandingStackChanges {
		return LandingGitHubPull{}, pkgerrors.BadRequest("landing requires a bounded non-empty stack")
	}
	tip, err := s.landings.repoHost.GetChange(ctx, owner, repo, landing.ChangeIds[len(landing.ChangeIds)-1])
	if err != nil {
		return LandingGitHubPull{}, mapLandingRepoHostError(err, "failed to resolve the landing tip")
	}
	if tip.CommitID != commitID {
		return LandingGitHubPull{}, pkgerrors.Conflict("commit_id is not this landing's current tip")
	}
	if err := s.landings.refuseOutsiderLandingPaths(ctx, owner, repo, landing.ID, landing.ChangeIds, landing.TargetBookmark); err != nil {
		return LandingGitHubPull{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, landingGitHubPullTimeout)
	defer cancel()
	remotes, err := s.remotes(ctx, actor, repository, owner, repo)
	if err != nil {
		return LandingGitHubPull{}, err
	}
	defer remotes.close()

	branch := LandingGitHubPullBranch(number)
	result := func(pull *landingGitHubPullRequest, created bool) (LandingGitHubPull, error) {
		if pull.Head.Ref != branch || pull.Head.SHA != commitID {
			return LandingGitHubPull{}, pkgerrors.Conflict("GitHub pull request #" + strconv.FormatInt(pull.Number, 10) + " no longer carries this landing's tip")
		}
		return LandingGitHubPull{LandingNumber: number, Repository: remotes.githubOwner + "/" + remotes.githubRepo,
			Number: pull.Number, URL: pull.HTMLURL, State: pull.State, Merged: pull.MergedAt != nil,
			HeadRef: pull.Head.Ref, HeadSHA: pull.Head.SHA, BaseRef: pull.Base.Ref, Created: created}, nil
	}
	if existing, err := s.github.Find(ctx, remotes.token, remotes.githubOwner, remotes.githubRepo, branch); err != nil {
		return LandingGitHubPull{}, err
	} else if existing != nil {
		return result(existing, false)
	}

	targetRef := "refs/heads/" + branch
	targetRefs, err := s.listRefs(ctx, remotes.targetURL)
	if err != nil {
		return LandingGitHubPull{}, landingGitHubGitError("read GitHub branches", err, remotes)
	}
	switch current := targetRefs[targetRef]; current {
	case commitID:
	case "":
		sourceRefs, err := s.listRefs(ctx, remotes.sourceURL)
		if err != nil {
			return LandingGitHubPull{}, landingGitHubGitError("read the retained Smithers source", err, remotes)
		}
		sourceRef := retainedSourceRef(sourceRefs, commitID)
		if sourceRef == "" {
			return LandingGitHubPull{}, pkgerrors.Conflict("the landing tip is not retained in Smithers; publish the cleaned source first")
		}
		if err := s.push(ctx, remotes.sourceURL, sourceRef, commitID, remotes.targetURL, targetRef); err != nil {
			return LandingGitHubPull{}, landingGitHubGitError("push the landing branch to GitHub", err, remotes)
		}
		after, err := s.listRefs(ctx, remotes.targetURL)
		if err != nil {
			return LandingGitHubPull{}, landingGitHubGitError("verify the GitHub branch", err, remotes)
		}
		if after[targetRef] != commitID {
			return LandingGitHubPull{}, pkgerrors.New(pkgerrors.CodeBadGateway, "GitHub branch "+branch+" did not reach the landing tip")
		}
	default:
		return LandingGitHubPull{}, pkgerrors.Conflict("GitHub branch " + branch + " moved to another commit; inspect it before retrying")
	}

	base := landing.TargetBookmark
	// The pull request must carry exactly this landing. A GitHub base that
	// lacks Smithers' base means the two mains diverged: refuse instead of
	// proposing unrelated commits.
	ahead, err := s.github.AheadBy(ctx, remotes.token, remotes.githubOwner, remotes.githubRepo, base, commitID)
	if err != nil {
		return LandingGitHubPull{}, err
	}
	if ahead != len(landing.ChangeIds) {
		return LandingGitHubPull{}, pkgerrors.Conflict(fmt.Sprintf("GitHub %s does not match this landing's base (%d commits ahead, want %d); refresh the Smithers mirror from GitHub before retrying", base, ahead, len(landing.ChangeIds)))
	}
	body := strings.TrimSpace(landing.Body)
	footer := "Smithers landing #" + strconv.FormatInt(number, 10)
	if input.RunID != "" {
		footer += " · run `" + input.RunID + "`"
	}
	if body != "" {
		body += "\n\n"
	}
	created, err := s.github.Create(ctx, remotes.token, remotes.githubOwner, remotes.githubRepo, landingGitHubPullCreate{
		Title: landing.Title, Head: branch, Base: base, Body: body + "---\n" + footer, MaintainerCanModify: true,
	})
	if stdErrors.Is(err, errLandingGitHubPullExists) {
		// A concurrent attempt opened it first.
		existing, findErr := s.github.Find(ctx, remotes.token, remotes.githubOwner, remotes.githubRepo, branch)
		if findErr != nil {
			return LandingGitHubPull{}, findErr
		}
		if existing == nil {
			return LandingGitHubPull{}, pkgerrors.New(pkgerrors.CodeBadGateway, "GitHub refused the pull request for "+branch)
		}
		return result(existing, false)
	}
	if err != nil {
		return LandingGitHubPull{}, err
	}
	return result(created, true)
}

func retainedSourceRef(refs map[string]string, commitID string) string {
	for name, target := range refs {
		if target != commitID {
			continue
		}
		if _, commit, ok := repohost.WorkspaceSourceFromRef(name); ok && commit == commitID {
			return name
		}
	}
	return ""
}

func landingGitHubGitError(action string, err error, remotes landingGitHubRemotes) error {
	return pkgerrors.New(pkgerrors.CodeBadGateway, "Could not "+action+": "+sanitizeMirrorError(err, remotes.sourceURL, remotes.targetURL))
}

// resolveGitHubDestination is the repository's one GitHub destination: an
// explicit mirror destination, its single recorded GitHub source, or an
// explicit repository connection. It is never inferred from names alone.
// gitHubDestinationStore is what resolveGitHubDestination reads.
type gitHubDestinationStore interface {
	GetRepoByID(context.Context, int64) (db.Repository, error)
	ListRepositoryGitHubSources(context.Context, int64) ([]db.ListRepositoryGitHubSourcesRow, error)
}

func resolveGitHubDestination(ctx context.Context, q gitHubDestinationStore, connection RepoSyncConnectionChecker, userID, repositoryID int64, owner, repo string) (string, string, error) {
	repository, err := q.GetRepoByID(ctx, repositoryID)
	if err != nil {
		return "", "", pkgerrors.Internal("load mirror repository").WithCause(err)
	}
	destination := strings.TrimSpace(repository.MirrorDestination)
	if destination == "" {
		sources, err := q.ListRepositoryGitHubSources(ctx, repositoryID)
		if err != nil {
			return "", "", pkgerrors.Internal("load GitHub mirror destination").WithCause(err)
		}
		if len(sources) == 1 {
			destination = sources[0].GithubOwner + "/" + sources[0].GithubRepo
		} else if len(sources) == 0 && connection != nil {
			status, err := connection.GetRepoConnectionStatus(ctx, userID, owner, repo)
			if err != nil {
				return "", "", err
			}
			if status.Connected {
				destination = owner + "/" + repo
			}
		}
		if destination == "" {
			return "", "", pkgerrors.Conflict("Connect one GitHub destination before reconciling this repository")
		}
	}
	return mirrorDestination(destination)
}

// defaultPushLandingCommit fetches the retained source ref and pushes its
// exact commit to a new GitHub branch. The push is not forced.
func defaultPushLandingCommit(ctx context.Context, sourceURL, sourceRef, commitID, targetURL, targetRef string) error {
	dir, err := os.MkdirTemp("", "smithers-landing-pull-")
	if err != nil {
		return fmt.Errorf("create landing push directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	if err := runMirrorGitCommand(ctx, "", "init", "--bare", dir); err != nil {
		return err
	}
	if err := runMirrorGitCommand(ctx, dir, "fetch", "--no-tags", sourceURL, "+"+sourceRef+":refs/landing/source"); err != nil {
		return err
	}
	return runMirrorGitCommand(ctx, dir, "push", targetURL, commitID+":"+targetRef)
}

type landingGitHubAPI struct {
	client  *http.Client
	baseURL func() string
}

func (a *landingGitHubAPI) request(ctx context.Context, token, method, path string, body any, out any, refusal ...*GitHubRefusal) (int, error) {
	status, _, err := a.requestHeaders(ctx, token, method, path, "", body, out, refusal...)
	return status, err
}

// requestHeaders exposes conditional-read status and headers to the existing
// pollers. A 304 has no body to decode and must not replace their cached fact.
func (a *landingGitHubAPI) requestHeaders(ctx context.Context, token, method, path, etag string, body any, out any, refusal ...*GitHubRefusal) (int, http.Header, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, pkgerrors.Internal("encode GitHub request").WithCause(err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(a.baseURL(), "/")+path, reader)
	if err != nil {
		return 0, nil, pkgerrors.Internal("build GitHub request").WithCause(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if method == http.MethodGet && etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "smithers-server")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return 0, nil, gitHubRequestFailure(ctx, "GitHub did not answer")
	}
	defer func() { _ = resp.Body.Close() }()
	if limited := GitHubRateLimitError(resp.StatusCode, resp.Header, time.Now()); limited != nil {
		return resp.StatusCode, resp.Header.Clone(), limited
	}

	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, githubRepoMetadataMaxResponseBytes+1))
	if readErr != nil || int64(len(raw)) > githubRepoMetadataMaxResponseBytes {
		return resp.StatusCode, resp.Header.Clone(), gitHubRequestFailure(ctx, "GitHub returned an incomplete response")
	}
	if resp.StatusCode >= 400 && len(refusal) > 0 && refusal[0] != nil {
		_ = json.Unmarshal(raw, refusal[0])
		refusal[0].Status = resp.StatusCode
		refusal[0].Code, refusal[0].Class = "github_refused", "github"
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return resp.StatusCode, resp.Header.Clone(), gitHubRequestFailure(ctx, "GitHub returned an unreadable response")
		}
	}
	return resp.StatusCode, resp.Header.Clone(), nil
}

func landingGitHubStatusError(status int, owner, repo, action string) error {
	if err := gitHubResponseFailure(status, nil, time.Now()); err != nil {
		return err.WithCause(fmt.Errorf("GitHub %s on %s/%s returned HTTP %d", action, owner, repo, status))
	}
	return pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "GitHub returned an unexpected response")
}

func landingGitHubRepoPath(owner, repo string) string {
	return "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo)
}

func (a *landingGitHubAPI) Find(ctx context.Context, token, owner, repo, branch string) (*landingGitHubPullRequest, error) {
	query := url.Values{"head": {owner + ":" + branch}, "state": {"all"}, "per_page": {"10"}}
	var pulls []landingGitHubPullRequest
	status, err := a.request(ctx, token, http.MethodGet, landingGitHubRepoPath(owner, repo)+"/pulls?"+query.Encode(), nil, &pulls)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, landingGitHubStatusError(status, owner, repo, "read pull requests")
	}
	for i := range pulls {
		pull := pulls[i]
		if pull.Head.Ref == branch && pull.Head.Repo != nil && strings.EqualFold(pull.Head.Repo.FullName, owner+"/"+repo) {
			return &pull, nil
		}
	}
	return nil, nil
}

func (a *landingGitHubAPI) Create(ctx context.Context, token, owner, repo string, input landingGitHubPullCreate) (*landingGitHubPullRequest, error) {
	var pull landingGitHubPullRequest
	status, err := a.request(ctx, token, http.MethodPost, landingGitHubRepoPath(owner, repo)+"/pulls", input, &pull)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnprocessableEntity {
		return nil, errLandingGitHubPullExists
	}
	if status != http.StatusCreated {
		return nil, landingGitHubStatusError(status, owner, repo, "open pull requests")
	}
	return &pull, nil
}

func (a *landingGitHubAPI) AheadBy(ctx context.Context, token, owner, repo, base, head string) (int, error) {
	var compare struct {
		AheadBy int `json:"ahead_by"`
	}
	status, err := a.request(ctx, token, http.MethodGet, landingGitHubRepoPath(owner, repo)+"/compare/"+url.PathEscape(base)+"..."+url.PathEscape(head), nil, &compare)
	if err != nil {
		return 0, err
	}
	if status != http.StatusOK {
		return 0, landingGitHubStatusError(status, owner, repo, "compare "+base)
	}
	return compare.AheadBy, nil
}
