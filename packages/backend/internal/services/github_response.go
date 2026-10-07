package services

import (
	"context"
	"errors"
	"net/http"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func isGitHubPermissionFailure(err error) bool {
	var failure *pkgerrors.APIError
	return errors.As(err, &failure) && failure.Code == pkgerrors.CodeGitHubPermission
}

// A temporary refresh failure does not prove that the person's grant is gone.
// Preserve a typed retry/reconnect response and keep raw transport details private.
func gitHubRefreshFailure(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	var failure *pkgerrors.APIError
	if errors.As(err, &failure) {
		return err
	}
	return pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "GitHub token refresh failed")
}

// GitHubRequestFailure separates cancellation of our work from an upstream
// failure. Error bodies and credential-bearing transport errors stay private.
func GitHubRequestFailure(ctx context.Context, message string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return pkgerrors.New(pkgerrors.CodeGitHubUnavailable, message)
}

// GitHubResponseFailure is for a required response. Callers interpret optional
// 404s before calling it. A missing resource does not prove an absent App;
// only the installation-token endpoint establishes github_not_installed.
func GitHubResponseFailure(status int, headers http.Header, now time.Time) *pkgerrors.APIError {
	if status >= 200 && status < 300 || status == http.StatusNotModified {
		return nil
	}
	if limited := GitHubRateLimitError(status, headers, now); limited != nil {
		return limited
	}
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return pkgerrors.New(pkgerrors.CodeGitHubPermission, "GitHub access denied")
	case http.StatusNotFound:
		return pkgerrors.New(pkgerrors.CodeGitHubPermission, "GitHub resource unavailable")
	default:
		return pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "GitHub request failed")
	}
}
