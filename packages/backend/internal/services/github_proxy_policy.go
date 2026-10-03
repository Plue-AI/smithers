package services

import (
	"encoding/json"
	pathpkg "path"
	"strings"
)

const (
	gitHubProxyReasonRepositoryMismatch = "request path repository does not match workflow repository"
	gitHubProxyReasonMergeDenied        = "pull request merges are not allowed for workflows"
	gitHubProxyReasonPullWriteDenied    = "pull request creation and updates are not allowed for workflows"
	gitHubProxyReasonDeleteBranchDenied = "deleting branches is not allowed for workflows"
	gitHubProxyReasonPushBranchDenied   = "can only push to smithers/* branches"
	gitHubProxyReasonDefaultDenied      = "action is not allowed for workflows"
	gitHubProxyReasonConversationDenied = "a run started from an outsider's text works from its approved copy, not the live conversation"
)

type GitHubProxyPolicyInput struct {
	Method             string
	Path               string
	Body               json.RawMessage
	RepoOwner          string
	RepoName           string
	AllowPullWrites    bool
	AllowMerges        bool
	AllowBranchDeletes bool
	// WithholdConversation refuses issues, comments and pull request
	// conversation, and the pull request list, whose bodies are live text,
	// to a run started from an outsider's approved text.
	WithholdConversation bool
}

type GitHubProxyPolicyDecision struct {
	Allowed bool
	Reason  string
}

func EvaluateGitHubProxyPolicy(input GitHubProxyPolicyInput) GitHubProxyPolicyDecision {
	method := strings.ToUpper(strings.TrimSpace(input.Method))
	if method == "" {
		return denyGitHubProxyPolicy("method is required")
	}

	normalizedPath := normalizeGitHubProxyPath(input.Path)
	if normalizedPath == "" {
		return denyGitHubProxyPolicy("path is required")
	}

	owner, repo, subpath, ok := parseGitHubRepoPath(normalizedPath)
	if !ok {
		return denyGitHubProxyPolicy("path must target /repos/{owner}/{repo}")
	}

	if !strings.EqualFold(strings.TrimSpace(input.RepoOwner), owner) || !strings.EqualFold(strings.TrimSpace(input.RepoName), repo) {
		return denyGitHubProxyPolicy(gitHubProxyReasonRepositoryMismatch)
	}

	if input.WithholdConversation && isConversationPath(subpath) {
		return denyGitHubProxyPolicy(gitHubProxyReasonConversationDenied)
	}

	if isPullMergePath(subpath) && (method == "PUT" || method == "POST" || method == "DELETE") && !input.AllowMerges {
		return denyGitHubProxyPolicy(gitHubProxyReasonMergeDenied)
	}
	if isPullMergePath(subpath) && method == "PUT" && input.AllowMerges {
		return allowGitHubProxyPolicy("pull request merge allowed")
	}

	if method == "POST" && subpath == "/pulls" && !input.AllowPullWrites {
		return denyGitHubProxyPolicy(gitHubProxyReasonPullWriteDenied)
	}
	if method == "POST" && subpath == "/pulls" && input.AllowPullWrites {
		return allowGitHubProxyPolicy("pull request creation allowed")
	}
	if method == "PATCH" && isPullItemPath(subpath) && !input.AllowPullWrites {
		return denyGitHubProxyPolicy(gitHubProxyReasonPullWriteDenied)
	}
	if method == "PATCH" && isPullItemPath(subpath) && input.AllowPullWrites {
		return allowGitHubProxyPolicy("pull request update allowed")
	}

	if method == "DELETE" && isGitHeadsRefPath(subpath) && !input.AllowBranchDeletes {
		return denyGitHubProxyPolicy(gitHubProxyReasonDeleteBranchDenied)
	}
	if method == "DELETE" && isGitHeadsRefPath(subpath) && input.AllowBranchDeletes {
		ref := strings.TrimPrefix(subpath, "/git/refs/")
		if !isSmithersBranchRef(ref) {
			return denyGitHubProxyPolicy(gitHubProxyReasonPushBranchDenied)
		}
		return allowGitHubProxyPolicy("git ref delete allowed")
	}

	if method == "POST" && subpath == "/git/refs" {
		ref, ok := extractRefFromRequestBody(input.Body)
		if !ok || !isSmithersBranchRef(ref) {
			return denyGitHubProxyPolicy(gitHubProxyReasonPushBranchDenied)
		}
		return allowGitHubProxyPolicy("git ref write allowed")
	}

	if method == "PATCH" && strings.HasPrefix(subpath, "/git/refs/") {
		ref := strings.TrimPrefix(subpath, "/git/refs/")
		if !isSmithersBranchRef(ref) {
			return denyGitHubProxyPolicy(gitHubProxyReasonPushBranchDenied)
		}
		return allowGitHubProxyPolicy("git ref write allowed")
	}

	if method == "GET" && (subpath == "/contents" || strings.HasPrefix(subpath, "/contents/")) {
		return allowGitHubProxyPolicy("contents read allowed")
	}

	if method == "POST" && (isIssueCommentPath(subpath) || isPullCommentPath(subpath)) {
		return allowGitHubProxyPolicy("comment creation allowed")
	}

	if method == "GET" && (subpath == "" || subpath == "/" || strings.HasPrefix(subpath, "/pulls") || strings.HasPrefix(subpath, "/issues")) {
		return allowGitHubProxyPolicy("metadata read allowed")
	}

	if method == "GET" && subpath == "/actions/runs" {
		return allowGitHubProxyPolicy("workflow runs read allowed")
	}

	return denyGitHubProxyPolicy(gitHubProxyReasonDefaultDenied)
}

func allowGitHubProxyPolicy(reason string) GitHubProxyPolicyDecision {
	return GitHubProxyPolicyDecision{Allowed: true, Reason: reason}
}

func denyGitHubProxyPolicy(reason string) GitHubProxyPolicyDecision {
	return GitHubProxyPolicyDecision{Allowed: false, Reason: reason}
}

func normalizeGitHubProxyPath(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}

	if idx := strings.IndexAny(trimmed, "?#"); idx >= 0 {
		trimmed = trimmed[:idx]
	}

	if !strings.HasPrefix(trimmed, "/") {
		return ""
	}

	cleaned := pathpkg.Clean(trimmed)
	return cleaned
}

func parseGitHubRepoPath(path string) (owner string, repo string, subpath string, ok bool) {
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) < 3 || parts[0] != "repos" {
		return "", "", "", false
	}
	if strings.TrimSpace(parts[1]) == "" || strings.TrimSpace(parts[2]) == "" {
		return "", "", "", false
	}

	owner = parts[1]
	repo = parts[2]
	if len(parts) == 3 {
		return owner, repo, "", true
	}
	return owner, repo, "/" + strings.Join(parts[3:], "/"), true
}

// isUserTokenReadPath names the read-only pull request and CI paths that
// registration asks for; only these may fall back to the importer's own
// GitHub credential when the App does not cover the imported source.
func isUserTokenReadPath(subpath string) bool {
	if subpath == "/pulls" || subpath == "/actions/runs" {
		return true
	}
	parts := strings.Split(strings.Trim(subpath, "/"), "/")
	if len(parts) != 3 || parts[0] != "pulls" || (parts[2] != "reviews" && parts[2] != "files") {
		return false
	}
	for _, r := range parts[1] {
		if r < '0' || r > '9' {
			return false
		}
	}
	return parts[1] != ""
}

func isPullMergePath(subpath string) bool {
	parts := strings.Split(strings.Trim(subpath, "/"), "/")
	return len(parts) == 3 && parts[0] == "pulls" && parts[2] == "merge"
}

func isPullItemPath(subpath string) bool {
	parts := strings.Split(strings.Trim(subpath, "/"), "/")
	return len(parts) == 2 && parts[0] == "pulls" && strings.TrimSpace(parts[1]) != ""
}

func isIssueCommentPath(subpath string) bool {
	parts := strings.Split(strings.Trim(subpath, "/"), "/")
	return len(parts) == 3 && parts[0] == "issues" && strings.TrimSpace(parts[1]) != "" && parts[2] == "comments"
}

func isPullCommentPath(subpath string) bool {
	parts := strings.Split(strings.Trim(subpath, "/"), "/")
	return len(parts) == 3 && parts[0] == "pulls" && strings.TrimSpace(parts[1]) != "" && parts[2] == "comments"
}

// isConversationPath covers every issue path, pull request comment and
// review paths, and the pull request list.
func isConversationPath(subpath string) bool {
	parts := strings.Split(strings.Trim(subpath, "/"), "/")
	switch {
	case parts[0] == "issues":
		return true
	case parts[0] != "pulls":
		return false
	case len(parts) == 1 || parts[1] == "comments":
		return true
	default:
		return len(parts) >= 3 && (parts[2] == "comments" || parts[2] == "reviews")
	}
}

func isGitHeadsRefPath(subpath string) bool {
	return strings.HasPrefix(subpath, "/git/refs/heads/")
}

func extractRefFromRequestBody(body json.RawMessage) (string, bool) {
	if len(body) == 0 {
		return "", false
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" || trimmed == "null" {
		return "", false
	}

	var payload struct {
		Ref string `json:"ref"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", false
	}
	ref := strings.TrimSpace(payload.Ref)
	if ref == "" {
		return "", false
	}
	return ref, true
}

func isSmithersBranchRef(ref string) bool {
	trimmed := strings.TrimSpace(ref)
	switch {
	case strings.HasPrefix(trimmed, "refs/heads/"):
		trimmed = strings.TrimPrefix(trimmed, "refs/heads/")
	case strings.HasPrefix(trimmed, "heads/"):
		trimmed = strings.TrimPrefix(trimmed, "heads/")
	default:
		return false
	}

	return strings.HasPrefix(trimmed, "smithers/") && len(strings.TrimPrefix(trimmed, "smithers/")) > 0
}
