package auth

import "fmt"

// githubResponseLimit bounds each token or identity response.
const githubResponseLimit = 1 << 20

// GitHubOAuthError is a failed GitHub OAuth token-endpoint call. Code is
// GitHub's OAuth error code (bad_verification_code, redirect_uri_mismatch,
// incorrect_client_credentials, ...) and is empty when the response carried
// none, for example a 5xx HTML page.
type GitHubOAuthError struct {
	Action      string
	Status      int
	Code        string
	Description string
}

func (e *GitHubOAuthError) Error() string {
	switch {
	case e.Code != "" && e.Description != "":
		return fmt.Sprintf("github oauth %s failed (status %d): %s: %s", e.Action, e.Status, e.Code, e.Description)
	case e.Code != "":
		return fmt.Sprintf("github oauth %s failed (status %d): %s", e.Action, e.Status, e.Code)
	case e.Description != "":
		return fmt.Sprintf("github oauth %s failed (status %d): %s", e.Action, e.Status, e.Description)
	default:
		return fmt.Sprintf("github oauth %s failed with status %d", e.Action, e.Status)
	}
}
