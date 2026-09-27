package repohost

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Per-user refs are bounded (#1968). Repo-host enforces these limits on every
// push that writes refs/smithers/users/<id>/<name>, whichever door (API, SSH,
// direct) it came through.
const (
	// DefaultUserRefLimit caps one user's refs in one repository.
	DefaultUserRefLimit = 20
	// DefaultUserRefMaxPushBytes caps the pack of a push that writes a user ref.
	DefaultUserRefMaxPushBytes int64 = 256 << 20
	// DefaultUserRefTTL expires a user ref this long after its last push.
	DefaultUserRefTTL = 30 * 24 * time.Hour
)

// DefaultReceivePackMaxDuration caps one push's wall-clock time from the
// moment repo-host takes the repository's write lock for it: a push that
// trickles in cannot hold the lock indefinitely. The front doors (the API's
// git route, SSH) allow a push the same time once it has started.
const DefaultReceivePackMaxDuration = 10 * time.Minute

// ReceivePackMaxDurationEnv overrides DefaultReceivePackMaxDuration, as a
// duration such as 10m, for repo-host and the front doors alike.
const ReceivePackMaxDurationEnv = "SMITHERS_RECEIVE_PACK_MAX_DURATION"

// ReceivePackMaxDuration is ReceivePackMaxDurationEnv's value, or
// DefaultReceivePackMaxDuration when it is unset or not a positive duration.
func ReceivePackMaxDuration() time.Duration {
	if limit, err := time.ParseDuration(strings.TrimSpace(os.Getenv(ReceivePackMaxDurationEnv))); err == nil && limit > 0 {
		return limit
	}
	return DefaultReceivePackMaxDuration
}

// UserRefName answers the <name> of refs/smithers/users/<id>/<name>.
func UserRefName(ref string) (int64, string, bool) {
	id, ok := UserIDFromRef(ref)
	if !ok {
		return 0, "", false
	}
	return id, strings.TrimPrefix(ref, UserRef(id, "")), true
}

// ValidUserRefName reports whether name may follow refs/smithers/users/<id>/.
func ValidUserRefName(name string) bool {
	_, ok := UserIDFromRef(UserRef(1, name))
	return ok
}

// UserRefInfo is one live user ref with its expiry.
type UserRefInfo struct {
	Name      string    `json:"name"`
	Ref       string    `json:"ref"`
	CommitID  string    `json:"commit_id"`
	PushedAt  time.Time `json:"pushed_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

// UserRefList is a user's live refs in one repository and the limits that
// bound them.
type UserRefList struct {
	Refs         []UserRefInfo `json:"refs"`
	Limit        int           `json:"limit"`
	MaxPushBytes int64         `json:"max_push_bytes"`
	TTLSeconds   int64         `json:"ttl_seconds"`
}

// RetainUserRefRequest names the ref of one user to pin for one workspace.
type RetainUserRefRequest struct {
	Name        string `json:"name"`
	WorkspaceID string `json:"workspace_id"`
}

// RetainedUserRef is a user ref's commit, pinned under the workspace's own
// source ref (WorkspaceSourceRef), which outlives the user ref's expiry.
type RetainedUserRef struct {
	UserRefInfo
	SourceRef string `json:"source_ref"`
}

// ListUserRefs answers one user's live refs in a repository.
func (c *Client) ListUserRefs(ctx context.Context, owner, repo string, userID int64) (UserRefList, error) {
	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return UserRefList{}, fmt.Errorf("resolve storage set url: %w", err)
	}
	var result UserRefList
	endpoint := repoByIDEndpoint(baseURL, owner, repo) + "/user-refs/" + url.PathEscape(strconv.FormatInt(userID, 10))
	err = c.doJSON(ctx, http.MethodGet, endpoint, nil, http.StatusOK, &result)
	return result, err
}

// RetainUserRef pins one user ref's commit for a workspace. A missing or
// expired ref answers a StatusError 404 with code user_ref_missing.
func (c *Client) RetainUserRef(ctx context.Context, owner, repo string, userID int64, req RetainUserRefRequest) (RetainedUserRef, error) {
	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return RetainedUserRef{}, fmt.Errorf("resolve storage set url: %w", err)
	}
	var result RetainedUserRef
	endpoint := repoByIDEndpoint(baseURL, owner, repo) + "/user-refs/" + url.PathEscape(strconv.FormatInt(userID, 10)) + "/retain"
	err = c.doJSON(ctx, http.MethodPost, endpoint, req, http.StatusOK, &result)
	return result, err
}

// RenewUserRef restarts one user ref's expiry.
func (c *Client) RenewUserRef(ctx context.Context, owner, repo string, userID int64, name string) (UserRefInfo, error) {
	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return UserRefInfo{}, fmt.Errorf("resolve storage set url: %w", err)
	}
	var result UserRefInfo
	endpoint := repoByIDEndpoint(baseURL, owner, repo) + "/user-refs/" + url.PathEscape(strconv.FormatInt(userID, 10)) + "/renew"
	err = c.doJSON(ctx, http.MethodPost, endpoint, map[string]string{"name": name}, http.StatusOK, &result)
	return result, err
}
