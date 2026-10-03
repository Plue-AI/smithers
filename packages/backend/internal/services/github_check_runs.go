package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const maxCheckRunAnnotationsPerRequest = 50

// gitHubCheckRunPermissions posts and updates check runs.
var gitHubCheckRunPermissions = map[string]string{"checks": "write"}

// GitHubCheckRunService posts and updates GitHub Check Runs.
type GitHubCheckRunService interface {
	PostCheckRun(ctx context.Context, installationID int64, repositoryID int64, owner string, repo string, input GitHubCheckRunInput) (GitHubCheckRunResult, error)
	UpdateCheckRun(ctx context.Context, installationID int64, repositoryID int64, owner string, repo string, checkRunID int64, update GitHubCheckRunUpdate) (GitHubCheckRunResult, error)
}

type githubCheckRunService struct {
	tokenIssuer GitHubInstallationTokenMinter
	httpClient  *http.Client
}

// GitHubCheckRunAnnotation represents one line-level annotation.
type GitHubCheckRunAnnotation struct {
	Path            string `json:"path"`
	StartLine       int    `json:"start_line"`
	EndLine         int    `json:"end_line,omitempty"`
	AnnotationLevel string `json:"annotation_level"`
	Message         string `json:"message"`
	Title           string `json:"title,omitempty"`
	RawDetails      string `json:"raw_details,omitempty"`
}

// GitHubCheckRunOutput is the check-run output payload.
type GitHubCheckRunOutput struct {
	Title       string                     `json:"title"`
	Summary     string                     `json:"summary"`
	Text        string                     `json:"text,omitempty"`
	Annotations []GitHubCheckRunAnnotation `json:"annotations,omitempty"`
}

// GitHubCheckRunInput is the create payload for POST /check-runs.
type GitHubCheckRunInput struct {
	Name        string                `json:"name"`
	HeadSHA     string                `json:"head_sha"`
	DetailsURL  string                `json:"details_url,omitempty"`
	ExternalID  string                `json:"external_id,omitempty"`
	Status      string                `json:"status,omitempty"`
	Conclusion  string                `json:"conclusion,omitempty"`
	StartedAt   *time.Time            `json:"started_at,omitempty"`
	CompletedAt *time.Time            `json:"completed_at,omitempty"`
	Output      *GitHubCheckRunOutput `json:"output,omitempty"`
}

// GitHubCheckRunUpdate is the patch payload for PATCH /check-runs/{id}.
type GitHubCheckRunUpdate struct {
	Name        *string               `json:"name,omitempty"`
	DetailsURL  *string               `json:"details_url,omitempty"`
	ExternalID  *string               `json:"external_id,omitempty"`
	Status      string                `json:"status,omitempty"`
	Conclusion  string                `json:"conclusion,omitempty"`
	StartedAt   *time.Time            `json:"started_at,omitempty"`
	CompletedAt *time.Time            `json:"completed_at,omitempty"`
	Output      *GitHubCheckRunOutput `json:"output,omitempty"`
}

// GitHubCheckRunResult is a subset of the GitHub check run response.
type GitHubCheckRunResult struct {
	ID      int64  `json:"id"`
	URL     string `json:"url"`
	HTMLURL string `json:"html_url"`
}

// NewGitHubCheckRunService builds a GitHubCheckRunService.
func NewGitHubCheckRunService(tokenIssuer GitHubInstallationTokenMinter) GitHubCheckRunService {
	return &githubCheckRunService{
		tokenIssuer: tokenIssuer,
		httpClient:  gitHubProviderClient(tokenIssuer, 10*time.Second),
	}
}

func (s *githubCheckRunService) PostCheckRun(
	ctx context.Context,
	installationID int64,
	repositoryID int64,
	owner string,
	repo string,
	input GitHubCheckRunInput,
) (GitHubCheckRunResult, error) {
	if s == nil || s.tokenIssuer == nil {
		return GitHubCheckRunResult{}, pkgerrors.Internal("github check run service unavailable")
	}
	if installationID <= 0 {
		return GitHubCheckRunResult{}, pkgerrors.BadRequest("installation id must be positive")
	}
	trimmedOwner := strings.TrimSpace(owner)
	trimmedRepo := strings.TrimSpace(repo)
	if trimmedOwner == "" || trimmedRepo == "" {
		return GitHubCheckRunResult{}, pkgerrors.BadRequest("owner and repo are required")
	}
	if strings.TrimSpace(input.Name) == "" || strings.TrimSpace(input.HeadSHA) == "" {
		return GitHubCheckRunResult{}, pkgerrors.BadRequest("check run name and head sha are required")
	}

	token, err := s.issueInstallationToken(ctx, installationID, repositoryID)
	if err != nil {
		return GitHubCheckRunResult{}, err
	}

	annotationBatches := splitCheckRunOutputBatches(input.Output, maxCheckRunAnnotationsPerRequest)

	requestPayload := githubCreateCheckRunRequest{
		Name:        input.Name,
		HeadSHA:     input.HeadSHA,
		DetailsURL:  input.DetailsURL,
		ExternalID:  input.ExternalID,
		Status:      input.Status,
		Conclusion:  input.Conclusion,
		StartedAt:   input.StartedAt,
		CompletedAt: input.CompletedAt,
		Output:      annotationBatches[0],
	}

	endpoint := githubCheckRunsEndpoint(trimmedOwner, trimmedRepo)
	result, err := s.createCheckRunWithToken(ctx, installationID, endpoint, token, requestPayload)
	if err != nil {
		return GitHubCheckRunResult{}, err
	}

	for i := 1; i < len(annotationBatches); i++ {
		_, err := s.updateCheckRunWithToken(
			ctx,
			installationID,
			githubCheckRunByIDEndpoint(trimmedOwner, trimmedRepo, result.ID),
			token,
			githubUpdateCheckRunRequest{
				Output: annotationBatches[i],
			},
		)
		if err != nil {
			return GitHubCheckRunResult{}, err
		}
	}

	return result, nil
}

func (s *githubCheckRunService) UpdateCheckRun(
	ctx context.Context,
	installationID int64,
	repositoryID int64,
	owner string,
	repo string,
	checkRunID int64,
	update GitHubCheckRunUpdate,
) (GitHubCheckRunResult, error) {
	if s == nil || s.tokenIssuer == nil {
		return GitHubCheckRunResult{}, pkgerrors.Internal("github check run service unavailable")
	}
	if installationID <= 0 {
		return GitHubCheckRunResult{}, pkgerrors.BadRequest("installation id must be positive")
	}
	if checkRunID <= 0 {
		return GitHubCheckRunResult{}, pkgerrors.BadRequest("check run id must be positive")
	}

	trimmedOwner := strings.TrimSpace(owner)
	trimmedRepo := strings.TrimSpace(repo)
	if trimmedOwner == "" || trimmedRepo == "" {
		return GitHubCheckRunResult{}, pkgerrors.BadRequest("owner and repo are required")
	}

	token, err := s.issueInstallationToken(ctx, installationID, repositoryID)
	if err != nil {
		return GitHubCheckRunResult{}, err
	}

	annotationBatches := splitCheckRunOutputBatches(update.Output, maxCheckRunAnnotationsPerRequest)
	endpoint := githubCheckRunByIDEndpoint(trimmedOwner, trimmedRepo, checkRunID)

	var result GitHubCheckRunResult
	for index, batch := range annotationBatches {
		requestPayload := githubUpdateCheckRunRequest{
			Name:        update.Name,
			DetailsURL:  update.DetailsURL,
			ExternalID:  update.ExternalID,
			Status:      update.Status,
			Conclusion:  update.Conclusion,
			StartedAt:   update.StartedAt,
			CompletedAt: update.CompletedAt,
			Output:      batch,
		}
		if index > 0 {
			requestPayload.Name = nil
			requestPayload.DetailsURL = nil
			requestPayload.ExternalID = nil
			requestPayload.Status = ""
			requestPayload.Conclusion = ""
			requestPayload.StartedAt = nil
			requestPayload.CompletedAt = nil
		}

		result, err = s.updateCheckRunWithToken(ctx, installationID, endpoint, token, requestPayload)
		if err != nil {
			return GitHubCheckRunResult{}, err
		}
	}

	return result, nil
}

func (s *githubCheckRunService) issueInstallationToken(ctx context.Context, installationID, repositoryID int64) (string, error) {
	token, err := s.tokenIssuer.CreateGitHubInstallationToken(ctx, installationID, GitHubTokenScope{RepositoryIDs: []int64{repositoryID}, Permissions: gitHubCheckRunPermissions})
	if err != nil {
		return "", err
	}
	if token.InstallationID > 0 && token.InstallationID != installationID {
		return "", pkgerrors.Forbidden("github installation token did not match installation")
	}
	if strings.TrimSpace(token.Token) == "" {
		return "", pkgerrors.Internal("github installation token was empty")
	}
	return token.Token, nil
}

func (s *githubCheckRunService) createCheckRunWithToken(
	ctx context.Context,
	installationID int64,
	endpoint string,
	token string,
	payload githubCreateCheckRunRequest,
) (GitHubCheckRunResult, error) {
	var result GitHubCheckRunResult
	if err := s.doGitHubJSON(ctx, installationID, http.MethodPost, endpoint, token, payload, &result); err != nil {
		return GitHubCheckRunResult{}, err
	}
	return normalizeCheckRunResult(result), nil
}

func (s *githubCheckRunService) updateCheckRunWithToken(
	ctx context.Context,
	installationID int64,
	endpoint string,
	token string,
	payload githubUpdateCheckRunRequest,
) (GitHubCheckRunResult, error) {
	var result GitHubCheckRunResult
	if err := s.doGitHubJSON(ctx, installationID, http.MethodPatch, endpoint, token, payload, &result); err != nil {
		return GitHubCheckRunResult{}, err
	}
	return normalizeCheckRunResult(result), nil
}

func (s *githubCheckRunService) doGitHubJSON(
	ctx context.Context,
	installationID int64,
	method string,
	endpoint string,
	token string,
	payload any,
	out any,
) error {
	var bodyReader io.Reader
	if payload != nil {
		bodyBytes, err := json.Marshal(payload)
		if err != nil {
			return pkgerrors.Internal("failed to encode github check run request").WithCause(err)
		}
		bodyReader = bytes.NewReader(bodyBytes)
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint, bodyReader)
	if err != nil {
		return pkgerrors.Internal("failed to build github check run request").WithCause(err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "smithers-server")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return pkgerrors.Internal("github check run request failed").WithCause(err)
	}
	defer func() { _ = resp.Body.Close() }()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		var errorPayload struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(bodyBytes, &errorPayload)
		message := strings.TrimSpace(errorPayload.Message)
		if message == "" {
			message = fmt.Sprintf("github check run request failed with status %d", resp.StatusCode)
		}
		switch resp.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			// A revoked/suspended installation returns 401/403 here; the
			// check-run endpoint set is fixed so evicting is safe (no thrash).
			invalidateCachedInstallationToken(installationID)
			return pkgerrors.Forbidden(message)
		case http.StatusNotFound:
			return pkgerrors.NotFound(message)
		case http.StatusBadRequest, http.StatusUnprocessableEntity:
			return pkgerrors.BadRequest(message)
		default:
			return pkgerrors.Internal(message)
		}
	}

	if out == nil || len(bodyBytes) == 0 {
		return nil
	}
	if err := json.Unmarshal(bodyBytes, out); err != nil {
		return pkgerrors.Internal("failed to decode github check run response").WithCause(err)
	}
	return nil
}

func splitCheckRunOutputBatches(output *GitHubCheckRunOutput, maxBatchSize int) []*GitHubCheckRunOutput {
	if output == nil {
		return []*GitHubCheckRunOutput{nil}
	}
	if maxBatchSize <= 0 || len(output.Annotations) <= maxBatchSize {
		return []*GitHubCheckRunOutput{output}
	}

	annotations := output.Annotations
	batches := make([]*GitHubCheckRunOutput, 0, (len(annotations)+maxBatchSize-1)/maxBatchSize)
	for start := 0; start < len(annotations); start += maxBatchSize {
		end := start + maxBatchSize
		if end > len(annotations) {
			end = len(annotations)
		}
		chunk := make([]GitHubCheckRunAnnotation, end-start)
		copy(chunk, annotations[start:end])
		batches = append(batches, &GitHubCheckRunOutput{
			Title:       output.Title,
			Summary:     output.Summary,
			Text:        output.Text,
			Annotations: chunk,
		})
	}
	return batches
}

func githubCheckRunsEndpoint(owner string, repo string) string {
	base := strings.TrimRight(githubAPIBaseURL(), "/")
	return fmt.Sprintf("%s/repos/%s/%s/check-runs", base, url.PathEscape(owner), url.PathEscape(repo))
}

func githubCheckRunByIDEndpoint(owner string, repo string, checkRunID int64) string {
	base := strings.TrimRight(githubAPIBaseURL(), "/")
	return fmt.Sprintf("%s/repos/%s/%s/check-runs/%d", base, url.PathEscape(owner), url.PathEscape(repo), checkRunID)
}

func normalizeCheckRunResult(result GitHubCheckRunResult) GitHubCheckRunResult {
	if strings.TrimSpace(result.URL) == "" {
		result.URL = strings.TrimSpace(result.HTMLURL)
	}
	if strings.TrimSpace(result.HTMLURL) == "" {
		result.HTMLURL = strings.TrimSpace(result.URL)
	}
	return result
}

type githubCreateCheckRunRequest struct {
	Name        string                `json:"name"`
	HeadSHA     string                `json:"head_sha"`
	DetailsURL  string                `json:"details_url,omitempty"`
	ExternalID  string                `json:"external_id,omitempty"`
	Status      string                `json:"status,omitempty"`
	Conclusion  string                `json:"conclusion,omitempty"`
	StartedAt   *time.Time            `json:"started_at,omitempty"`
	CompletedAt *time.Time            `json:"completed_at,omitempty"`
	Output      *GitHubCheckRunOutput `json:"output,omitempty"`
}

type githubUpdateCheckRunRequest struct {
	Name        *string               `json:"name,omitempty"`
	DetailsURL  *string               `json:"details_url,omitempty"`
	ExternalID  *string               `json:"external_id,omitempty"`
	Status      string                `json:"status,omitempty"`
	Conclusion  string                `json:"conclusion,omitempty"`
	StartedAt   *time.Time            `json:"started_at,omitempty"`
	CompletedAt *time.Time            `json:"completed_at,omitempty"`
	Output      *GitHubCheckRunOutput `json:"output,omitempty"`
}
