package services

import (
	"context"
	stdErrors "errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/sync/errgroup"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// GitHub App installation verification answers
// GET /api/user/github-app/installations[/{installationId}]: which of the
// caller's own GitHub repositories the App verifiably covers. It walks the
// caller's repository inventory, then diagnoses each repository's access.
// The optional installation id is a filter, never permission to read another
// user's installation.
const (
	// gitHubInstallationAccessBudget caps the per-repository diagnoses one
	// verification may spend.
	gitHubInstallationAccessBudget = 900
	// gitHubInstallationDiagnosisConcurrency bounds parallel diagnoses.
	gitHubInstallationDiagnosisConcurrency = 6

	gitHubInstallationUnverifiedMessage = "Smithers Cloud could not verify the GitHub App installation. Try again."
	gitHubInstallationBudgetMessage     = "Smithers Cloud could not verify this repository inventory within its request budget."
)

var gitHubInstallationRepoName = regexp.MustCompile(`^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`)

// GitHubAppInstallationSource is the in-process inventory and access
// diagnosis a verification reads. *GitHubUserReposService implements it.
type GitHubAppInstallationSource interface {
	ListAuthenticatedUserGitHubRepos(ctx context.Context, userID int64, query url.Values) (GitHubRepoListResult, error)
	DiagnoseGitHubAccess(ctx context.Context, userID int64, owner, repo, surface string) (GitHubAccessDiagnosis, error)
}

// GitHubAppInstallationRepo is one repository the App verifiably covers.
type GitHubAppInstallationRepo struct {
	FullName       string `json:"fullName"`
	PushedAt       string `json:"pushedAt"`
	InstallationID int64  `json:"installationId"`
}

// VerifyGitHubAppInstallations returns the caller's repositories whose access
// diagnosis is ok with a positive installation id, optionally filtered to one
// installation id. With no such repository and at least one blocking verdict
// it refuses with the first blocker's detail as a conflict. Every returned
// error carries a message written for clients.
func VerifyGitHubAppInstallations(
	ctx context.Context,
	source GitHubAppInstallationSource,
	userID int64,
	installationID string,
) ([]GitHubAppInstallationRepo, *pkgerrors.APIError) {
	candidates, err := walkGitHubInstallationInventory(ctx, source, userID)
	if err != nil {
		return nil, err
	}

	diagnoses := make([]*GitHubAccessDiagnosis, len(candidates))
	group, groupCtx := errgroup.WithContext(ctx)
	group.SetLimit(gitHubInstallationDiagnosisConcurrency)
	for i, candidate := range candidates {
		group.Go(func() error {
			owner, repo, _ := strings.Cut(candidate.FullName, "/")
			diagnosis, diagnoseErr := source.DiagnoseGitHubAccess(groupCtx, userID, owner, repo, GitHubRepoMetadataIssues)
			if diagnoseErr != nil {
				switch statusOfAPIError(diagnoseErr) {
				case http.StatusForbidden, http.StatusNotFound:
					// Not visible to this caller: not theirs to verify.
					return nil
				}
				return diagnoseErr
			}
			diagnoses[i] = &diagnosis
			return nil
		})
	}
	if waitErr := group.Wait(); waitErr != nil {
		return nil, gitHubInstallationUnverified(waitErr)
	}

	matches := func(id int64) bool {
		return installationID == "" || (id > 0 && strconv.FormatInt(id, 10) == installationID)
	}
	repos := []GitHubAppInstallationRepo{}
	var blockers []string
	for i, diagnosis := range diagnoses {
		if diagnosis == nil {
			continue
		}
		if diagnosis.Verdict != GitHubAccessVerdictOK && diagnosis.Verdict != GitHubAccessVerdictAppNotInstalled &&
			diagnosis.Detail != "" && matches(diagnosis.InstallationID) {
			blockers = append(blockers, diagnosis.Detail)
		}
		if diagnosis.Verdict == GitHubAccessVerdictOK && diagnosis.InstallationID > 0 && matches(diagnosis.InstallationID) {
			repos = append(repos, GitHubAppInstallationRepo{
				FullName:       candidates[i].FullName,
				PushedAt:       candidates[i].PushedAt,
				InstallationID: diagnosis.InstallationID,
			})
		}
	}
	if len(repos) == 0 && len(blockers) > 0 {
		return nil, pkgerrors.Conflict(blockers[0])
	}
	return repos, nil
}

// walkGitHubInstallationInventory reads the caller's repositories, most
// recently pushed first, 100 per page for at most 10 pages. An incomplete
// walk or more candidates than the access budget refuses before any
// diagnosis is spent.
func walkGitHubInstallationInventory(
	ctx context.Context,
	source GitHubAppInstallationSource,
	userID int64,
) ([]GitHubRepoListItem, *pkgerrors.APIError) {
	seen := map[string]bool{}
	candidates := []GitHubRepoListItem{}
	complete := false
	for page := 1; page <= githubRepoListingMaxPages; page++ {
		query := url.Values{}
		query.Set("sort", "pushed")
		query.Set("direction", "desc")
		query.Set("per_page", strconv.Itoa(githubRepoListingPageSize))
		query.Set("page", strconv.Itoa(page))
		result, err := source.ListAuthenticatedUserGitHubRepos(ctx, userID, query)
		if err != nil {
			return nil, gitHubInstallationUnverified(err)
		}
		for _, row := range result.Repos {
			if !gitHubInstallationRepoName.MatchString(row.FullName) || seen[row.FullName] {
				continue
			}
			seen[row.FullName] = true
			candidates = append(candidates, GitHubRepoListItem{FullName: row.FullName, PushedAt: row.PushedAt})
		}
		if len(result.Repos) < githubRepoListingPageSize {
			complete = true
			break
		}
	}
	if !complete || len(candidates) > gitHubInstallationAccessBudget {
		return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, gitHubInstallationBudgetMessage)
	}
	return candidates, nil
}

// gitHubInstallationUnverified restates an inventory or diagnosis failure:
// its status and typed code survive, its prose never does.
func gitHubInstallationUnverified(err error) *pkgerrors.APIError {
	var apiErr *pkgerrors.APIError
	if stdErrors.As(err, &apiErr) {
		return (&pkgerrors.APIError{
			Status:     apiErr.Status,
			Code:       apiErr.Code,
			Class:      apiErr.Class,
			Fault:      apiErr.Fault,
			RetryAfter: apiErr.RetryAfter,
			Message:    gitHubInstallationUnverifiedMessage,
		}).WithCause(err)
	}
	return pkgerrors.New(pkgerrors.CodeGitHubUnavailable, gitHubInstallationUnverifiedMessage).WithCause(err)
}
