package repohost

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// StorageSetResolver allows the repohost Client to dynamically find the correct backend URL for a given repository.
type StorageSetResolver interface {
	ResolveURL(ctx context.Context, owner, repo string) (string, error)
}

// StorageSetURLResolver resolves a configured placement without requiring a
// repository row. Durable provisioning reserves placement before that row is
// published, and recovery must derive authenticated destinations from trusted
// configuration rather than a URL persisted in a mutable operation table.
type StorageSetURLResolver interface {
	ResolveStorageSetURL(ctx context.Context, storageSetID string) (string, error)
}

// StorageRouteResolver returns the stable, trusted route identifier for a
// repository while its row is still visible. Durable move/delete intents
// persist this ID so recovery can resolve the current URL after a restart or
// routing generation change.
type StorageRouteResolver interface {
	ResolveStorageRouteKey(ctx context.Context, owner, repo string) (string, error)
}

// StaticStorageSetResolver implements StorageSetResolver by always returning a fixed URL.
// Useful for tests or single-host deployments.
type StaticStorageSetResolver struct {
	URL string
}

func (s *StaticStorageSetResolver) ResolveURL(ctx context.Context, owner, repo string) (string, error) {
	return s.URL, nil
}

func (s *StaticStorageSetResolver) ResolveStorageSetURL(context.Context, string) (string, error) {
	return s.URL, nil
}

func (s *StaticStorageSetResolver) ResolveStorageRouteKey(context.Context, string, string) (string, error) {
	// This is an opaque route key for the configured single service, including
	// the in-process local handler; it is not a cluster placement identifier.
	return "static", nil
}

// Client communicates with the repo-host service.
type Client struct {
	resolver            StorageSetResolver
	authToken           string
	httpClient          *http.Client
	readTimeout         time.Duration
	metrics             RepoHostOperationDurationObserver
	localStagingBaseURL string
	inProcess           bool
}

const defaultReadTimeout = 30 * time.Second

// RepoHostOperationDurationObserver records repo-host operation durations.
type RepoHostOperationDurationObserver interface {
	ObserveRepoHostOperationDuration(operation string, seconds float64)
}

// Bookmark is a jj bookmark returned by repo-host.
type Bookmark struct {
	Name             string `json:"name"`
	TargetChangeID   string `json:"target_change_id"`
	TargetCommitID   string `json:"target_commit_id"`
	IsTrackingRemote bool   `json:"is_tracking_remote"`
}

// CreateBookmarkRequest creates a bookmark at a target change.
type CreateBookmarkRequest struct {
	Name           string `json:"name"`
	TargetChangeID string `json:"target_change_id"`
	// IfAbsent makes creation idempotent without moving an existing bookmark.
	// Repo-host evaluates the existence check under the repository write lock.
	IfAbsent bool `json:"if_absent,omitempty"`
	// ExpectedCommitID makes replacement/deletion conditional; empty means absent.
	ExpectedCommitID *string `json:"expected_commit_id,omitempty"`
	Delete           bool    `json:"delete,omitempty"`
}

type setDefaultBookmarkRequest struct {
	Name string `json:"name"`
}

// StagedDelete identifies repository storage that repo-host has atomically
// moved out of its live namespace but has not yet destroyed. BaseURL is
// captured when the live repository row still exists, so restore/finalize do
// not need to resolve storage placement after the coordinating DB transaction
// commits or rolls back.
type StagedDelete struct {
	BaseURL         string
	StorageRouteKey string
	Token           string
	Owner           string
	Repo            string
}

// StagedMove identifies a repo-host move journal created before repository
// ownership is committed in PostgreSQL. The captured URL and client-owned
// token let callers idempotently roll the move back or finalize it even after
// the repository disappears from the source namespace.
type StagedMove struct {
	BaseURL         string
	StorageRouteKey string
	Token           string
	SrcOwner        string
	SrcRepo         string
	DstOwner        string
	DstRepo         string
}

// StagedProvision is a client-owned, token-bound repository creation journal.
// Execute builds an immutable staged tree, Publish atomically installs it in
// the live namespace, and Finalize removes the journal only after PostgreSQL
// publishes the exact reserved repository ID.
type StagedProvision struct {
	BaseURL         string
	StorageSetID    string
	Token           string
	OperationType   string
	Owner           string
	Repo            string
	DefaultBookmark string
	AutoInit        bool
	SrcOwner        string
	SrcRepo         string
}

// Change describes a jj change.
type Change struct {
	ChangeID        string   `json:"change_id"`
	CommitID        string   `json:"commit_id"`
	ParentCommitID  string   `json:"parent_commit_id"`
	Description     string   `json:"description"`
	AuthorName      string   `json:"author_name"`
	AuthorEmail     string   `json:"author_email"`
	Timestamp       string   `json:"timestamp"`
	HasConflict     bool     `json:"has_conflict"`
	IsEmpty         bool     `json:"is_empty"`
	ParentChangeIDs []string `json:"parent_change_ids"`
}

// BackoutChangeRequest creates a new change by applying the inverse of an
// exact landed revision on top of the current target bookmark.
type BackoutChangeRequest struct {
	Revision       string `json:"revision"`
	TargetBookmark string `json:"target_bookmark"`
	// Base, when set, reverts the diff from Base to Revision (everything a
	// landing from Base brought in) instead of Revision's own diff.
	Base string `json:"base,omitempty"`
}

// SplitChangeRequest moves the listed paths' diff into a new change while the
// original stable change keeps every unselected path.
type SplitChangeRequest struct {
	Paths       []string `json:"paths"`
	Description string   `json:"description,omitempty"`
}

// SplitChangeResult contains both rewritten changes produced by a split.
type SplitChangeResult struct {
	Original Change `json:"original"`
	Split    Change `json:"split"`
}

// ChangeDiff includes file-level diff metadata.
type ChangeDiff struct {
	ChangeID  string     `json:"change_id"`
	FileDiffs []FileDiff `json:"file_diffs"`
}

// FileDiff describes a file change classification.
type FileDiff struct {
	Path       string `json:"path"`
	OldPath    string `json:"old_path,omitempty"`
	ChangeType string `json:"change_type"`
	Patch      string `json:"patch,omitempty"`
	IsBinary   bool   `json:"is_binary"`
	// TooLarge marks a file whose contents exceeded the diff size caps; the
	// patch and contents are omitted, like a binary file.
	TooLarge   bool   `json:"too_large,omitempty"`
	Language   string `json:"language,omitempty"`
	Additions  int    `json:"additions"`
	Deletions  int    `json:"deletions"`
	OldContent string `json:"old_content,omitempty"`
	NewContent string `json:"new_content,omitempty"`
}

// ChangeFile describes a changed file path.
type ChangeFile struct {
	Path string `json:"path"`
}

type TreeEntry struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}

// ListDirectory returns at most limit immediate children after the path cursor.
func (c *Client) ListDirectory(ctx context.Context, owner, repo, changeID, prefix, after string, limit int) ([]TreeEntry, error) {
	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return nil, fmt.Errorf("resolve storage set url: %w", err)
	}
	query := url.Values{"depth": {"1"}, "limit": {strconv.Itoa(limit)}, "prefix": {prefix}, "after": {after}}
	endpoint := repoByIDEndpoint(baseURL, owner, repo) + "/changes/" + url.PathEscape(changeID) + "/tree?" + query.Encode()
	var out []TreeEntry
	if err := c.doJSON(ctx, http.MethodGet, endpoint, nil, http.StatusOK, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Conflict describes a conflict path/type.
type Conflict struct {
	FilePath         string `json:"file_path"`
	ConflictType     string `json:"conflict_type"`
	BaseContent      string `json:"base_content,omitempty"`
	LeftContent      string `json:"left_content,omitempty"`
	RightContent     string `json:"right_content,omitempty"`
	Hunks            string `json:"hunks,omitempty"`
	ResolutionStatus string `json:"resolution_status,omitempty"`
}

// FileContent is file data at a change.
//
// Content holds UTF-8 text when Encoding is "utf8" (or empty), and the
// standard-base64 encoding of the raw blob bytes when Encoding is "base64".
// TooLarge marks a blob over the repo-host read cap; Content is then empty.
type FileContent struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding,omitempty"`
	TooLarge bool   `json:"too_large,omitempty"`
}

// LandRequest requests landing a stack to target bookmark.
type LandRequest struct {
	ChangeIDs        []string    `json:"change_ids"`
	TargetBookmark   string      `json:"target_bookmark"`
	ExpectedCommitID *string     `json:"expected_commit_id,omitempty"`
	OperationKey     string      `json:"operation_key,omitempty"`
	LookupOnly       bool        `json:"lookup_only,omitempty"`
	Append           *LandAppend `json:"append,omitempty"`
}

// LandAppend preserves a rewritten source history while publishing one main commit.
type LandAppend struct {
	SourceCommitID     string `json:"source_commit_id"`
	SourceBaseCommitID string `json:"source_base_commit_id"`
	Description        string `json:"description"`
}

// LandResult describes landing outcome.
type LandResult struct {
	LandedCount    int    `json:"landed_count"`
	TargetBookmark string `json:"target_bookmark"`
	TargetCommitID string `json:"target_commit_id"`
}

// SuperprojectMember is one member repository pinned inside an organization
// superproject: the gitlink at Path points at CommitID in the member repo.
type SuperprojectMember struct {
	Path     string `json:"path"`
	CommitID string `json:"commit_id"`
}

// ComposeSuperprojectRequest writes one superproject commit. Members override
// the gitlinks inherited from the parent; unlisted members keep the parent's
// pin. The bookmark is only used to pick the parent; it is never moved here.
type ComposeSuperprojectRequest struct {
	Members        []SuperprojectMember `json:"members"`
	Bookmark       string               `json:"bookmark,omitempty"`
	ParentChangeID string               `json:"parent_change_id,omitempty"`
	Description    string               `json:"description,omitempty"`
}

// SuperprojectCommit is a superproject commit with the full member vector it
// pins: the cross-repository changeset as stored on repo-host.
type SuperprojectCommit struct {
	ChangeID        string               `json:"change_id"`
	CommitID        string               `json:"commit_id"`
	ParentCommitIDs []string             `json:"parent_commit_ids"`
	Description     string               `json:"description"`
	Members         []SuperprojectMember `json:"members"`
}

// Operation describes a repo operation-log entry.
type Operation struct {
	OperationID string `json:"operation_id"`
	Description string `json:"description"`
	Timestamp   string `json:"timestamp"`
}

// WorkingTreeChange describes a single changed path in the working tree,
// mirroring the Rust FFI `StatusFile` JSON shape.
type WorkingTreeChange struct {
	Path   string `json:"path"`
	Status string `json:"status"`
	Staged bool   `json:"staged"`
	Add    uint32 `json:"add"`
	Del    uint32 `json:"del"`
}

// WorkingTreeStatus describes the live working-tree status of a repository:
// the VCS backend ("git" or "jj"), the checked-out branch, the working-copy
// head, and the set of changed files. Mirrors the Rust FFI `WorkingTreeStatus`.
type WorkingTreeStatus struct {
	Backend string              `json:"backend"`
	Branch  string              `json:"branch"`
	Head    string              `json:"head"`
	Changes []WorkingTreeChange `json:"changes"`
}

// SnapshotRequest requests a snapshot at a change.
type SnapshotRequest struct {
	ChangeID string `json:"change_id"`
}

// SnapshotResult describes created snapshot path and materialized file count.
type SnapshotResult struct {
	ChangeID     string `json:"change_id"`
	SnapshotPath string `json:"snapshot_path"`
	FileCount    int    `json:"file_count"`
}

// WikiRevision describes a wiki page revision returned by repo-host.
type WikiRevision struct {
	CommitSHA string    `json:"commit_sha"`
	Message   string    `json:"message"`
	Author    string    `json:"author"`
	Email     string    `json:"email"`
	Timestamp time.Time `json:"timestamp"`
}

// DocumentRevision describes a docs-sidecar file revision returned by repo-host.
type DocumentRevision = WikiRevision

type wikiCommitRequest struct {
	Content     string `json:"content"`
	AuthorName  string `json:"author_name"`
	AuthorEmail string `json:"author_email"`
	Message     string `json:"message"`
}

type wikiCommitResponse struct {
	CommitSHA string `json:"commit_sha"`
}

type wikiContentResponse struct {
	Content   string `json:"content"`
	CommitSHA string `json:"commit_sha"`
}

type wikiDeleteRequest struct {
	AuthorName  string `json:"author_name"`
	AuthorEmail string `json:"author_email"`
}

// NewClient creates a new repo-host client.
// The HTTP transport is wrapped with otelhttp so outgoing requests propagate
// trace context (traceparent header) to the repo-host service.
func NewClient(resolver StorageSetResolver, authToken string, metrics ...RepoHostOperationDurationObserver) *Client {
	client := &Client{
		resolver:    resolver,
		authToken:   authToken,
		readTimeout: defaultReadTimeout,
		httpClient: &http.Client{
			Transport: refusalTransport{next: otelhttp.NewTransport(http.DefaultTransport)},
		},
	}
	if len(metrics) > 0 {
		client.metrics = metrics[0]
	}
	return client
}

type initRepoRequest struct {
	Owner           string `json:"owner"`
	Repo            string `json:"repo"`
	AutoInit        bool   `json:"auto_init"`
	DefaultBookmark string `json:"default_bookmark,omitempty"`
	RepoName        string `json:"repo_name,omitempty"`
}

type forkRepoRequest struct {
	SrcOwner string `json:"src_owner"`
	SrcRepo  string `json:"src_repo"`
	DstOwner string `json:"dst_owner"`
	DstRepo  string `json:"dst_repo"`
}

type moveRepoRequest struct {
	SrcOwner string `json:"src_owner"`
	SrcRepo  string `json:"src_repo"`
	DstOwner string `json:"dst_owner"`
	DstRepo  string `json:"dst_repo"`
	Token    string `json:"token,omitempty"`
}

type stageMoveRepoResponse struct {
	Token string `json:"token"`
}

const maxErrorBodyDiscardBytes = 4096

// StatusError is returned when repo-host responds with an unexpected HTTP status.
// It preserves the upstream status code so callers can map it to an appropriate API error.
type StatusError struct {
	StatusCode int
	Code       string
	Message    string
	// RetryAfter is repo-host's Retry-After, in seconds, when it sent one.
	RetryAfter int
}

// RepositoryHeldCode is repo-host's error code for a write to a repository
// it holds while maintenance outside it may still run: retry after
// RetryAfter.
const RepositoryHeldCode = "repository_held"

// HeldRetryAfter reports whether err, anywhere in its chain, is repo-host
// refusing a write to a held repository, and when to try again: repo-host's
// Retry-After, or the hold's re-check interval when it sent none. It is how
// background writers (landings, the stack, changesets) tell "wait" from
// "failed".
func HeldRetryAfter(err error) (time.Duration, bool) {
	status, ok := IsStatusError(err)
	if !ok || !status.Held() {
		return 0, false
	}
	if status.RetryAfter > 0 {
		return time.Duration(status.RetryAfter) * time.Second, true
	}
	return 5 * time.Second, true
}

// Held reports whether e refuses a write to a held repository.
func (e *StatusError) Held() bool {
	return e.StatusCode == http.StatusServiceUnavailable && e.Code == RepositoryHeldCode
}

// gitStatusError is statusError for a git route: only the messages meant for
// the pusher (a hold, a push stopped at its duration limit) are repo-host's
// to show, and any other body stays out of the error.
func gitStatusError(resp *http.Response) *StatusError {
	status := statusError(resp)
	if !status.Held() && status.Code != PushTooSlowCode {
		status.Message = ""
	}
	return status
}

// statusError reads repo-host's error response: its code from the JSON body
// or the X-Smithers-Error-Code header (git routes answer in plain text), and
// its Retry-After.
func statusError(resp *http.Response) *StatusError {
	upstream := readErrorResponse(resp.Body)
	code := upstream.Code
	if code == "" {
		code = resp.Header.Get("X-Smithers-Error-Code")
	}
	retryAfter, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
	return &StatusError{StatusCode: resp.StatusCode, Code: code, Message: upstream.Message, RetryAfter: max(retryAfter, 0)}
}

// refusalTransport records, on the calling request's context, repo-host's
// refusal of a write to a held repository, whichever client call received it
// and whatever the caller makes of the error: the product's error layer
// answers with it (middleware.DependencyRefusals). It sees every response the
// client gets, JSON and git alike.
type refusalTransport struct{ next http.RoundTripper }

func (t refusalTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.next.RoundTrip(req)
	if err == nil && resp.StatusCode == http.StatusServiceUnavailable && resp.Header.Get("X-Smithers-Error-Code") == RepositoryHeldCode {
		refusal := apierrors.New(apierrors.CodeRepositoryHeld, "Repository is busy")
		if retryAfter, _ := strconv.Atoi(resp.Header.Get("Retry-After")); retryAfter > 0 {
			refusal.RetryAfter = retryAfter
		}
		apierrors.RecordRefusal(req.Context(), refusal)
	}
	return resp, err
}

func (e *StatusError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("repo-host returned status %d: %s", e.StatusCode, e.Message)
	}
	return fmt.Sprintf("repo-host returned status %d", e.StatusCode)
}

// IsStatusError returns the *StatusError in err's chain, if any.
func IsStatusError(err error) (*StatusError, bool) {
	var se *StatusError
	if !errors.As(err, &se) {
		return nil, false
	}
	return se, true
}

// errorMessage is a minimal JSON error body from repo-host.
type errorMessage struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Error   string `json:"error"`
}

type paginatedResponse[T any] struct {
	Items      []T    `json:"items"`
	TotalCount int64  `json:"total_count"`
	NextCursor string `json:"next_cursor"`
}

// Health checks whether repo-host is reachable and healthy.
// Because we have multiple storage sets now, this probes a specific physical host rather than an abstract owner/repo.
func (c *Client) Health(ctx context.Context, hostURL string) error {
	defer c.observeOperationDuration("Health", time.Now())
	requestCtx, cancel := c.readRequestContext(ctx)
	defer cancel()

	req, err := http.NewRequestWithContext(
		requestCtx,
		http.MethodGet,
		strings.TrimRight(hostURL, "/")+"/health",
		nil,
	)
	if err != nil {
		return fmt.Errorf("create repo-host health request: %w", err)
	}
	c.applyAuthHeader(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("repo-host health request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		discardErrorBody(resp.Body)
		return fmt.Errorf("repo-host health returned status %d", resp.StatusCode)
	}

	return nil
}

// InitRepo tells the repo-host to create a new jj repo on disk.
func (c *Client) InitRepo(ctx context.Context, owner, repo, defaultBookmark string, autoInit bool) error {
	defer c.observeOperationDuration("InitRepo", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("resolve storage set url: %w", err)
	}

	return c.doJSON(
		ctx,
		http.MethodPost,
		baseURL+"/repos/init",
		initRepoRequest{
			Owner:           owner,
			Repo:            repo,
			AutoInit:        autoInit,
			DefaultBookmark: defaultBookmark,
			RepoName:        repo,
		},
		http.StatusCreated,
		nil,
	)
}

// ForkRepo tells the repo-host to copy srcOwner/srcRepo data to dstOwner/dstRepo.
// The repo-host locks source and destination paths during the copy so concurrent
// writes cannot corrupt the fork. The caller is responsible for creating the DB
// record first and deleting it on failure.
func (c *Client) ForkRepo(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) error {
	defer c.observeOperationDuration("ForkRepo", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, srcOwner, srcRepo)
	if err != nil {
		return fmt.Errorf("resolve storage set url: %w", err)
	}

	return c.doJSON(
		ctx,
		http.MethodPost,
		strings.TrimRight(baseURL, "/")+"/repos/fork",
		forkRepoRequest{
			SrcOwner: srcOwner,
			SrcRepo:  srcRepo,
			DstOwner: dstOwner,
			DstRepo:  dstRepo,
		},
		http.StatusCreated,
		nil,
	)
}

const (
	provisionOperationInit   = "init"
	provisionOperationFork   = "fork"
	provisionOperationImport = "import"
)

type stageProvisionRepoRequest struct {
	Token           string `json:"token"`
	OperationType   string `json:"operation_type"`
	Owner           string `json:"owner"`
	Repo            string `json:"repo"`
	DefaultBookmark string `json:"default_bookmark,omitempty"`
	AutoInit        bool   `json:"auto_init,omitempty"`
	SrcOwner        string `json:"src_owner,omitempty"`
	SrcRepo         string `json:"src_repo,omitempty"`
}

// PrepareStagedImport creates a hidden, token-owned repository that can accept
// an internal Git mirror push before it is published into the live namespace.
func (c *Client) PrepareStagedImport(
	ctx context.Context,
	storageSetID, owner, repo, defaultBookmark string,
) (StagedProvision, error) {
	defer c.observeOperationDuration("PrepareStagedImport", time.Now())
	return c.prepareStagedProvision(ctx, StagedProvision{
		StorageSetID: storageSetID, OperationType: provisionOperationImport,
		Owner: owner, Repo: repo, DefaultBookmark: defaultBookmark,
	})
}

// StagedProvisionGitEndpoint returns the token-scoped internal smart-HTTP
// remote and its bearer credential. The credential is intended for
// GIT_CONFIG_* environment injection and must never be placed in argv or URL.
func (c *Client) StagedProvisionGitEndpoint(ctx context.Context, staged StagedProvision) (string, string, error) {
	if staged.OperationType != provisionOperationImport {
		return "", "", fmt.Errorf("staged git endpoint requires an import provision")
	}
	baseURL, err := c.trustedStagedProvisionURL(ctx, staged)
	if err != nil {
		return "", "", err
	}
	if c.localStagingBaseURL != "" {
		baseURL = c.localStagingBaseURL
	}
	return baseURL + "/repos/provision-stages/" + url.PathEscape(staged.Token) + "/git",
		StagedProvisionBearer(c.authToken, staged.Token), nil
}

// StagedProvisionBearer derives a capability distinct from the route/journal
// token. The route token may appear in argv or access logs; only this HMAC is
// injected into the git subprocess environment as the bearer credential.
func StagedProvisionBearer(repoHostSecret, token string) string {
	mac := hmac.New(sha256.New, []byte(repoHostSecret))
	_, _ = mac.Write([]byte("smithers:staged-provision-git:v1:"))
	_, _ = mac.Write([]byte(token))
	return hex.EncodeToString(mac.Sum(nil))
}

type stageProvisionRepoResponse struct {
	Token string `json:"token"`
	Phase string `json:"phase"`
}

// PrepareStagedInit creates a recovery handle without touching repo-host.
func (c *Client) PrepareStagedInit(
	ctx context.Context,
	storageSetID, owner, repo, defaultBookmark string,
	autoInit bool,
) (StagedProvision, error) {
	defer c.observeOperationDuration("PrepareStagedInit", time.Now())
	return c.prepareStagedProvision(ctx, StagedProvision{
		StorageSetID: storageSetID, OperationType: provisionOperationInit,
		Owner: owner, Repo: repo, DefaultBookmark: defaultBookmark, AutoInit: autoInit,
	})
}

// PrepareStagedFork creates a recovery handle for a source snapshot copy.
func (c *Client) PrepareStagedFork(
	ctx context.Context,
	storageSetID, srcOwner, srcRepo, dstOwner, dstRepo string,
) (StagedProvision, error) {
	defer c.observeOperationDuration("PrepareStagedFork", time.Now())
	return c.prepareStagedProvision(ctx, StagedProvision{
		StorageSetID: storageSetID, OperationType: provisionOperationFork,
		Owner: dstOwner, Repo: dstRepo, SrcOwner: srcOwner, SrcRepo: srcRepo,
	})
}

func (c *Client) prepareStagedProvision(ctx context.Context, staged StagedProvision) (StagedProvision, error) {
	token, err := newStagedDeleteToken()
	if err != nil {
		return staged, fmt.Errorf("generate repository provisioning token: %w", err)
	}
	staged.Token = token
	baseURL, err := c.resolveStorageSetURL(ctx, staged.StorageSetID)
	if err != nil {
		return staged, fmt.Errorf("resolve repository provisioning storage set: %w", err)
	}
	staged.BaseURL = baseURL
	return staged, nil
}

// ExecuteStagedProvision builds (or verifies) the token-owned staging tree but
// does not make it live. Retrying after a lost response is idempotent.
func (c *Client) ExecuteStagedProvision(ctx context.Context, staged StagedProvision) error {
	defer c.observeOperationDuration("ExecuteStagedProvision", time.Now())
	baseURL, err := c.trustedStagedProvisionURL(ctx, staged)
	if err != nil {
		return err
	}
	var response stageProvisionRepoResponse
	if err := c.doJSON(ctx, http.MethodPost, baseURL+"/repos/provision-stages", stageProvisionRepoRequest{
		Token: staged.Token, OperationType: staged.OperationType,
		Owner: staged.Owner, Repo: staged.Repo,
		DefaultBookmark: staged.DefaultBookmark, AutoInit: staged.AutoInit,
		SrcOwner: staged.SrcOwner, SrcRepo: staged.SrcRepo,
	}, http.StatusCreated, &response); err != nil {
		return err
	}
	if response.Token != staged.Token || (response.Phase != "ready" && response.Phase != "published") {
		return fmt.Errorf("repo-host returned an inconsistent repository provisioning journal")
	}
	return nil
}

func (c *Client) PublishStagedProvision(ctx context.Context, staged StagedProvision) error {
	defer c.observeOperationDuration("PublishStagedProvision", time.Now())
	return c.completeStagedProvision(ctx, staged, "publish")
}

func (c *Client) FinalizeStagedProvision(ctx context.Context, staged StagedProvision) error {
	defer c.observeOperationDuration("FinalizeStagedProvision", time.Now())
	return c.completeStagedProvision(ctx, staged, "finalize")
}

func (c *Client) AbortStagedProvision(ctx context.Context, staged StagedProvision) error {
	defer c.observeOperationDuration("AbortStagedProvision", time.Now())
	return c.completeStagedProvision(ctx, staged, "abort")
}

func (c *Client) completeStagedProvision(ctx context.Context, staged StagedProvision, action string) error {
	baseURL, err := c.trustedStagedProvisionURL(ctx, staged)
	if err != nil {
		return err
	}
	return c.doJSON(ctx, http.MethodPost,
		baseURL+"/repos/provision-stages/"+url.PathEscape(staged.Token)+"/"+action,
		nil, http.StatusNoContent, nil)
}

func (c *Client) trustedStagedProvisionURL(ctx context.Context, staged StagedProvision) (string, error) {
	if strings.TrimSpace(staged.Token) == "" || strings.TrimSpace(staged.StorageSetID) == "" ||
		strings.TrimSpace(staged.Owner) == "" || strings.TrimSpace(staged.Repo) == "" {
		return "", fmt.Errorf("invalid staged repository provisioning handle")
	}
	baseURL, err := c.resolveStorageSetURL(ctx, staged.StorageSetID)
	if err != nil {
		return "", fmt.Errorf("resolve repository provisioning storage set: %w", err)
	}
	return strings.TrimRight(baseURL, "/"), nil
}

func (c *Client) resolveStorageSetURL(ctx context.Context, storageSetID string) (string, error) {
	resolver, ok := c.resolver.(StorageSetURLResolver)
	if !ok {
		return "", fmt.Errorf("storage resolver does not support unpublished repository placement")
	}
	baseURL, err := resolver.ResolveStorageSetURL(ctx, storageSetID)
	if err != nil {
		return "", err
	}
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return "", fmt.Errorf("resolved repo-host URL is empty")
	}
	return baseURL, nil
}

// MoveRepo tells the repo-host to rename srcOwner/srcRepo storage to dstOwner/dstRepo.
// Used during repository transfer. The rename is atomic at the OS level on the
// same filesystem. The caller must handle compensating DB rollback on failure.
func (c *Client) MoveRepo(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) error {
	defer c.observeOperationDuration("MoveRepo", time.Now())

	// During a coordinated ownership transfer the repository row is visible
	// under exactly one namespace: the source while a serialized transaction is
	// uncommitted, or the destination after an autocommit transfer. Resolve both
	// sides so forward moves and commit-failure move-backs use the same storage
	// set even though one namespace no longer exists in the DB.
	baseURL, sourceErr := c.resolver.ResolveURL(ctx, srcOwner, srcRepo)
	if sourceErr != nil {
		var destinationErr error
		baseURL, destinationErr = c.resolver.ResolveURL(ctx, dstOwner, dstRepo)
		if destinationErr != nil {
			return fmt.Errorf("resolve storage set url for move: %w", errors.Join(sourceErr, destinationErr))
		}
	}

	return c.doJSON(
		ctx,
		http.MethodPost,
		strings.TrimRight(baseURL, "/")+"/repos/move",
		moveRepoRequest{
			SrcOwner: srcOwner,
			SrcRepo:  srcRepo,
			DstOwner: dstOwner,
			DstRepo:  dstRepo,
		},
		http.StatusOK,
		nil,
	)
}

// PrepareStagedMove resolves placement and generates the repo-host journal
// token without mutating storage. Callers that coordinate repo-host with a DB
// transaction persist the returned handle before ExecuteStagedMove.
func (c *Client) PrepareStagedMove(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) (StagedMove, error) {
	defer c.observeOperationDuration("PrepareStagedMove", time.Now())
	token, err := newStagedDeleteToken()
	if err != nil {
		return StagedMove{}, fmt.Errorf("generate staged move token: %w", err)
	}
	routeKey, baseURL, sourceErr := c.resolveStagedRoute(ctx, srcOwner, srcRepo)
	if sourceErr != nil {
		var destinationErr error
		routeKey, baseURL, destinationErr = c.resolveStagedRoute(ctx, dstOwner, dstRepo)
		if destinationErr != nil {
			return StagedMove{Token: token, SrcOwner: srcOwner, SrcRepo: srcRepo, DstOwner: dstOwner, DstRepo: dstRepo}, fmt.Errorf("resolve storage set url for staged move: %w", errors.Join(sourceErr, destinationErr))
		}
	}
	staged := StagedMove{
		BaseURL:         baseURL,
		StorageRouteKey: routeKey,
		Token:           token,
		SrcOwner:        srcOwner,
		SrcRepo:         srcRepo,
		DstOwner:        dstOwner,
		DstRepo:         dstRepo,
	}
	return staged, nil
}

// ExecuteStagedMove installs/continues the prepared journal and moves all
// repository components to the destination. The prepared token makes retries
// idempotent even when the first HTTP response is lost.
func (c *Client) ExecuteStagedMove(ctx context.Context, staged StagedMove) error {
	defer c.observeOperationDuration("ExecuteStagedMove", time.Now())
	baseURL, resolveErr := c.trustedStagedStorageURL(ctx, staged.StorageRouteKey, staged.BaseURL)
	if resolveErr != nil {
		return resolveErr
	}
	token := strings.TrimSpace(staged.Token)
	if baseURL == "" || token == "" || strings.TrimSpace(staged.SrcOwner) == "" || strings.TrimSpace(staged.SrcRepo) == "" ||
		strings.TrimSpace(staged.DstOwner) == "" || strings.TrimSpace(staged.DstRepo) == "" {
		return fmt.Errorf("invalid staged move handle")
	}

	var response stageMoveRepoResponse
	if err := c.doJSON(
		ctx,
		http.MethodPost,
		baseURL+"/repos/move-stages",
		moveRepoRequest{
			SrcOwner: staged.SrcOwner,
			SrcRepo:  staged.SrcRepo,
			DstOwner: staged.DstOwner,
			DstRepo:  staged.DstRepo,
			Token:    token,
		},
		http.StatusCreated,
		&response,
	); err != nil {
		return err
	}
	if response.Token != token {
		return fmt.Errorf("repo-host staged move returned an unexpected token")
	}
	return nil
}

// StageMoveRepo is the compatibility one-shot API. Durable coordinators use
// PrepareStagedMove + ExecuteStagedMove so the prepared token/base URL can be
// committed before repo-host sees the stage request.
func (c *Client) StageMoveRepo(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) (StagedMove, error) {
	staged, err := c.PrepareStagedMove(ctx, srcOwner, srcRepo, dstOwner, dstRepo)
	if err != nil {
		return staged, err
	}
	return staged, c.ExecuteStagedMove(ctx, staged)
}

// RollbackStagedMove restores storage to the source namespace using the URL
// captured before any DB ownership change became externally visible.
func (c *Client) RollbackStagedMove(ctx context.Context, staged StagedMove) error {
	defer c.observeOperationDuration("RollbackStagedMove", time.Now())
	return c.completeStagedMove(ctx, staged, "rollback")
}

// FinalizeStagedMove removes the move journal after the ownership change is
// durable. Storage remains in the destination namespace.
func (c *Client) FinalizeStagedMove(ctx context.Context, staged StagedMove) error {
	defer c.observeOperationDuration("FinalizeStagedMove", time.Now())
	return c.completeStagedMove(ctx, staged, "finalize")
}

func (c *Client) completeStagedMove(ctx context.Context, staged StagedMove, action string) error {
	baseURL, resolveErr := c.trustedStagedStorageURL(ctx, staged.StorageRouteKey, staged.BaseURL)
	if resolveErr != nil {
		return resolveErr
	}
	token := strings.TrimSpace(staged.Token)
	if baseURL == "" || token == "" {
		return fmt.Errorf("invalid staged move handle")
	}
	return c.doJSON(
		ctx,
		http.MethodPost,
		baseURL+"/repos/move-stages/"+url.PathEscape(token)+"/"+action,
		nil,
		http.StatusNoContent,
		nil,
	)
}

// DeleteRepo tells the repo-host to remove a repository from disk.
// A missing on-disk repository is treated as a successful no-op.
func (c *Client) DeleteRepo(ctx context.Context, owner, repo string) error {
	defer c.observeOperationDuration("DeleteRepo", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("resolve storage set url: %w", err)
	}

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodDelete,
		repoEndpoint(baseURL, owner, repo),
		nil,
	)
	if err != nil {
		return fmt.Errorf("create repo-host delete request: %w", err)
	}
	c.applyAuthHeader(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("repo-host delete request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound {
		return nil
	}

	discardErrorBody(resp.Body)
	return fmt.Errorf("repo-host delete returned status %d", resp.StatusCode)
}

type stageDeleteRepoRequest struct {
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
	Token string `json:"token"`
}

type stageDeleteRepoResponse struct {
	Token string `json:"token"`
}

// PrepareStagedDelete resolves placement and generates the repo-host journal
// token without mutating storage. Persist this handle before executing it.
func (c *Client) PrepareStagedDelete(ctx context.Context, owner, repo string) (StagedDelete, error) {
	defer c.observeOperationDuration("PrepareStagedDelete", time.Now())
	token, err := newStagedDeleteToken()
	if err != nil {
		return StagedDelete{}, fmt.Errorf("generate staged delete token: %w", err)
	}
	routeKey, baseURL, err := c.resolveStagedRoute(ctx, owner, repo)
	if err != nil {
		return StagedDelete{Token: token, Owner: owner, Repo: repo}, fmt.Errorf("resolve storage set url: %w", err)
	}
	return StagedDelete{BaseURL: baseURL, StorageRouteKey: routeKey, Token: token, Owner: owner, Repo: repo}, nil
}

func (c *Client) resolveStagedRoute(ctx context.Context, owner, repo string) (string, string, error) {
	if resolver, ok := c.resolver.(StorageRouteResolver); ok {
		routeKey, err := resolver.ResolveStorageRouteKey(ctx, owner, repo)
		if err != nil {
			return "", "", err
		}
		if strings.TrimSpace(routeKey) == "" {
			return "", "", fmt.Errorf("resolved repository route id is empty")
		}
		baseURL, err := c.resolveStorageSetURL(ctx, routeKey)
		return routeKey, baseURL, err
	}
	// URL-only resolvers remain usable for ephemeral one-shot operations.
	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	return "", baseURL, err
}

// ExecuteStagedDelete installs/continues the prepared delete journal and
// atomically moves repository components out of the live namespace.
func (c *Client) ExecuteStagedDelete(ctx context.Context, staged StagedDelete) error {
	defer c.observeOperationDuration("ExecuteStagedDelete", time.Now())
	baseURL, resolveErr := c.trustedStagedStorageURL(ctx, staged.StorageRouteKey, staged.BaseURL)
	if resolveErr != nil {
		return resolveErr
	}
	token := strings.TrimSpace(staged.Token)
	if baseURL == "" || token == "" || strings.TrimSpace(staged.Owner) == "" || strings.TrimSpace(staged.Repo) == "" {
		return fmt.Errorf("invalid staged delete handle")
	}

	var response stageDeleteRepoResponse
	if err := c.doJSON(
		ctx,
		http.MethodPost,
		baseURL+"/repos/delete-stages",
		stageDeleteRepoRequest{Owner: staged.Owner, Repo: staged.Repo, Token: token},
		http.StatusCreated,
		&response,
	); err != nil {
		return err
	}
	if response.Token != token {
		return fmt.Errorf("repo-host stage delete returned an unexpected token")
	}
	return nil
}

// StageDeleteRepo is the compatibility one-shot API. Durable coordinators use
// PrepareStagedDelete + ExecuteStagedDelete.
func (c *Client) StageDeleteRepo(ctx context.Context, owner, repo string) (StagedDelete, error) {
	staged, err := c.PrepareStagedDelete(ctx, owner, repo)
	if err != nil {
		return staged, err
	}
	return staged, c.ExecuteStagedDelete(ctx, staged)
}

// RestoreStagedDelete puts a staged repository back into its original live
// namespace. It deliberately uses the URL captured by StageDeleteRepo rather
// than consulting the repository row again.
func (c *Client) RestoreStagedDelete(ctx context.Context, staged StagedDelete) error {
	defer c.observeOperationDuration("RestoreStagedDelete", time.Now())
	return c.completeStagedDelete(ctx, staged, "restore")
}

// FinalizeStagedDelete permanently destroys a staged repository after the DB
// transaction has committed. It deliberately uses the URL captured by
// StageDeleteRepo because the repository row no longer exists at this point.
func (c *Client) FinalizeStagedDelete(ctx context.Context, staged StagedDelete) error {
	defer c.observeOperationDuration("FinalizeStagedDelete", time.Now())
	return c.completeStagedDelete(ctx, staged, "finalize")
}

func (c *Client) completeStagedDelete(ctx context.Context, staged StagedDelete, action string) error {
	baseURL, resolveErr := c.trustedStagedStorageURL(ctx, staged.StorageRouteKey, staged.BaseURL)
	if resolveErr != nil {
		return resolveErr
	}
	token := strings.TrimSpace(staged.Token)
	if baseURL == "" || token == "" {
		return fmt.Errorf("invalid staged delete handle")
	}
	return c.doJSON(
		ctx,
		http.MethodPost,
		baseURL+"/repos/delete-stages/"+url.PathEscape(token)+"/"+action,
		nil,
		http.StatusNoContent,
		nil,
	)
}

func (c *Client) trustedStagedStorageURL(ctx context.Context, routeKey, compatibilityURL string) (string, error) {
	if strings.TrimSpace(routeKey) != "" {
		return c.resolveStorageSetURL(ctx, routeKey)
	}
	// Compatibility for one-shot callers that have not persisted an operation.
	// Durable recovery handles always carry a storage route key and never trust a URL
	// read from PostgreSQL.
	compatibilityURL = strings.TrimRight(strings.TrimSpace(compatibilityURL), "/")
	if compatibilityURL == "" {
		return "", fmt.Errorf("staged repository operation has no trusted storage placement")
	}
	return compatibilityURL, nil
}

func newStagedDeleteToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// InitWikiRepo ensures the repository's wiki backend exists on disk.
func (c *Client) InitWikiRepo(ctx context.Context, owner, repo string) error {
	defer c.observeOperationDuration("InitWikiRepo", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("resolve storage set url: %w", err)
	}

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPut,
		repoByIDEndpoint(baseURL, owner, repo)+"/wiki",
		nil,
	)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	c.applyAuthHeader(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("repo-host request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		return statusError(resp)
	}

	return nil
}

// InitDocsRepo ensures the repository's docs backend exists on disk.
func (c *Client) InitDocsRepo(ctx context.Context, owner, repo string) error {
	defer c.observeOperationDuration("InitDocsRepo", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("resolve storage set url: %w", err)
	}

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPut,
		repoByIDEndpoint(baseURL, owner, repo)+"/docs",
		nil,
	)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	c.applyAuthHeader(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("repo-host request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		return statusError(resp)
	}

	return nil
}

// CommitWikiPage creates or updates wiki page content.
func (c *Client) CommitWikiPage(ctx context.Context, owner, repo, pageName, content, authorName, authorEmail, message string) (string, error) {
	defer c.observeOperationDuration("CommitWikiPage", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return "", fmt.Errorf("resolve storage set url: %w", err)
	}

	var out wikiCommitResponse
	err = c.doJSON(
		ctx,
		http.MethodPut,
		repoByIDEndpoint(baseURL, owner, repo)+"/wiki/pages/"+url.PathEscape(pageName),
		wikiCommitRequest{
			Content:     content,
			AuthorName:  authorName,
			AuthorEmail: authorEmail,
			Message:     message,
		},
		http.StatusOK,
		&out,
	)
	if err != nil {
		return "", err
	}

	return out.CommitSHA, nil
}

// CommitDoc creates or updates a docs-sidecar file.
func (c *Client) CommitDoc(ctx context.Context, owner, repo, filePath, content, authorName, authorEmail, message string) (string, error) {
	defer c.observeOperationDuration("CommitDoc", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return "", fmt.Errorf("resolve storage set url: %w", err)
	}

	var out wikiCommitResponse
	err = c.doJSON(
		ctx,
		http.MethodPut,
		repoByIDEndpoint(baseURL, owner, repo)+"/docs/files/"+escapePathSegments(filePath),
		wikiCommitRequest{
			Content:     content,
			AuthorName:  authorName,
			AuthorEmail: authorEmail,
			Message:     message,
		},
		http.StatusOK,
		&out,
	)
	if err != nil {
		return "", err
	}

	return out.CommitSHA, nil
}

// GetWikiPageContent reads wiki page content at a specific commit.
func (c *Client) GetWikiPageContent(ctx context.Context, owner, repo, pageName, commitSHA string) (string, error) {
	defer c.observeOperationDuration("GetWikiPageContent", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return "", fmt.Errorf("resolve storage set url: %w", err)
	}

	endpoint := repoByIDEndpoint(baseURL, owner, repo) + "/wiki/pages/" + url.PathEscape(pageName)
	if trimmed := strings.TrimSpace(commitSHA); trimmed != "" {
		endpoint += "?commit_sha=" + url.QueryEscape(trimmed)
	}

	var out wikiContentResponse
	if err := c.doJSON(ctx, http.MethodGet, endpoint, nil, http.StatusOK, &out); err != nil {
		return "", err
	}

	return out.Content, nil
}

// GetDocContent reads docs-sidecar content at a specific commit.
func (c *Client) GetDocContent(ctx context.Context, owner, repo, filePath, commitSHA string) (string, error) {
	defer c.observeOperationDuration("GetDocContent", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return "", fmt.Errorf("resolve storage set url: %w", err)
	}

	endpoint := repoByIDEndpoint(baseURL, owner, repo) + "/docs/files/" + escapePathSegments(filePath)
	if trimmed := strings.TrimSpace(commitSHA); trimmed != "" {
		endpoint += "?commit_sha=" + url.QueryEscape(trimmed)
	}

	var out wikiContentResponse
	if err := c.doJSON(ctx, http.MethodGet, endpoint, nil, http.StatusOK, &out); err != nil {
		return "", err
	}

	return out.Content, nil
}

// ListWikiPageHistory lists revision history for a wiki page.
func (c *Client) ListWikiPageHistory(ctx context.Context, owner, repo, pageName string, limit int32) ([]WikiRevision, error) {
	defer c.observeOperationDuration("ListWikiPageHistory", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return nil, fmt.Errorf("resolve storage set url: %w", err)
	}

	endpoint := repoByIDEndpoint(baseURL, owner, repo) + "/wiki/pages/" + url.PathEscape(pageName) + "/history"
	if limit > 0 {
		endpoint += "?limit=" + url.QueryEscape(strconv.FormatInt(int64(limit), 10))
	}

	var out []WikiRevision
	if err := c.doJSON(ctx, http.MethodGet, endpoint, nil, http.StatusOK, &out); err != nil {
		return nil, err
	}

	return out, nil
}

// ListDocHistory lists revision history for a docs-sidecar file.
func (c *Client) ListDocHistory(ctx context.Context, owner, repo, filePath string, limit int32) ([]DocumentRevision, error) {
	defer c.observeOperationDuration("ListDocHistory", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return nil, fmt.Errorf("resolve storage set url: %w", err)
	}

	endpoint := repoByIDEndpoint(baseURL, owner, repo) + "/docs/history/" + escapePathSegments(filePath)
	if limit > 0 {
		endpoint += "?limit=" + url.QueryEscape(strconv.FormatInt(int64(limit), 10))
	}

	var out []DocumentRevision
	if err := c.doJSON(ctx, http.MethodGet, endpoint, nil, http.StatusOK, &out); err != nil {
		return nil, err
	}

	return out, nil
}

// DeleteWikiPage removes a wiki page from the wiki repository.
func (c *Client) DeleteWikiPage(ctx context.Context, owner, repo, pageName, authorName, authorEmail string) error {
	defer c.observeOperationDuration("DeleteWikiPage", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("resolve storage set url: %w", err)
	}

	return c.doJSON(
		ctx,
		http.MethodDelete,
		repoByIDEndpoint(baseURL, owner, repo)+"/wiki/pages/"+url.PathEscape(pageName),
		wikiDeleteRequest{
			AuthorName:  authorName,
			AuthorEmail: authorEmail,
		},
		http.StatusNoContent,
		nil,
	)
}

// DeleteDoc removes a docs-sidecar file.
func (c *Client) DeleteDoc(ctx context.Context, owner, repo, filePath, authorName, authorEmail string) error {
	defer c.observeOperationDuration("DeleteDoc", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("resolve storage set url: %w", err)
	}

	return c.doJSON(
		ctx,
		http.MethodDelete,
		repoByIDEndpoint(baseURL, owner, repo)+"/docs/files/"+escapePathSegments(filePath),
		wikiDeleteRequest{
			AuthorName:  authorName,
			AuthorEmail: authorEmail,
		},
		http.StatusNoContent,
		nil,
	)
}

// ListBookmarks lists bookmarks for a repository.
func (c *Client) ListBookmarks(ctx context.Context, owner, repo string, cursor string, limit int) ([]Bookmark, string, error) {
	defer c.observeOperationDuration("ListBookmarks", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return nil, "", fmt.Errorf("resolve storage set url: %w", err)
	}

	return doJSONPaginated[Bookmark](ctx, c, http.MethodGet, repoByIDEndpoint(baseURL, owner, repo)+"/bookmarks", cursor, limit, http.StatusOK)
}

// CreateBookmark creates a bookmark at target change.
func (c *Client) CreateBookmark(ctx context.Context, owner, repo string, req CreateBookmarkRequest) (Bookmark, error) {
	defer c.observeOperationDuration("CreateBookmark", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return Bookmark{}, fmt.Errorf("resolve storage set url: %w", err)
	}

	var out Bookmark
	if err := c.doJSON(ctx, http.MethodPost, repoByIDEndpoint(baseURL, owner, repo)+"/bookmarks", req, http.StatusCreated, &out); err != nil {
		return Bookmark{}, err
	}
	return out, nil
}

// SetDefaultBookmark points the repository's Git HEAD symref at name.
func (c *Client) SetDefaultBookmark(ctx context.Context, owner, repo, name string) error {
	defer c.observeOperationDuration("SetDefaultBookmark", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("resolve storage set url: %w", err)
	}

	return c.doJSON(
		ctx,
		http.MethodPut,
		repoByIDEndpoint(baseURL, owner, repo)+"/default-bookmark",
		setDefaultBookmarkRequest{Name: name},
		http.StatusNoContent,
		nil,
	)
}

// RepairRefCaseCollisions renames or removes a repository's case variants of
// reserved refs (keeping backups) and reports every other case collision.
func (c *Client) RepairRefCaseCollisions(ctx context.Context, owner, repo string, req RefCaseCollisionRequest) (RefCaseCollisionReport, error) {
	defer c.observeOperationDuration("RepairRefCaseCollisions", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return RefCaseCollisionReport{}, fmt.Errorf("resolve storage set url: %w", err)
	}
	if req.ProtectedPatterns == nil {
		req.ProtectedPatterns = []string{}
	}
	var report RefCaseCollisionReport
	err = c.doJSON(ctx, http.MethodPost, repoByIDEndpoint(baseURL, owner, repo)+"/ref-case-collisions/repair", req, http.StatusOK, &report)
	return report, err
}

// DeleteBookmark deletes a bookmark by name.
func (c *Client) DeleteBookmark(ctx context.Context, owner, repo, name string) error {
	defer c.observeOperationDuration("DeleteBookmark", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("resolve storage set url: %w", err)
	}

	return c.doJSON(ctx, http.MethodDelete, repoByIDEndpoint(baseURL, owner, repo)+"/bookmarks/"+url.PathEscape(name), nil, http.StatusNoContent, nil)
}

// ListChanges lists changes in a repository.
func (c *Client) ListChanges(ctx context.Context, owner, repo string, cursor string, limit int) ([]Change, string, error) {
	defer c.observeOperationDuration("ListChanges", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return nil, "", fmt.Errorf("resolve storage set url: %w", err)
	}

	return doJSONPaginated[Change](ctx, c, http.MethodGet, repoByIDEndpoint(baseURL, owner, repo)+"/changes", cursor, limit, http.StatusOK)
}

// GetChange retrieves a single change by stable change ID.
func (c *Client) GetChange(ctx context.Context, owner, repo, changeID string) (Change, error) {
	defer c.observeOperationDuration("GetChange", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return Change{}, fmt.Errorf("resolve storage set url: %w", err)
	}

	var out Change
	if err := c.doJSON(ctx, http.MethodGet, repoByIDEndpoint(baseURL, owner, repo)+"/changes/"+url.PathEscape(changeID), nil, http.StatusOK, &out); err != nil {
		return Change{}, err
	}
	return out, nil
}

// BackoutChange creates an unbookmarked reverting change on repo-host.
func (c *Client) BackoutChange(ctx context.Context, owner, repo, changeID string, req BackoutChangeRequest) (Change, error) {
	defer c.observeOperationDuration("BackoutChange", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return Change{}, fmt.Errorf("resolve storage set url: %w", err)
	}

	var out Change
	endpoint := repoByIDEndpoint(baseURL, owner, repo) + "/changes/" + url.PathEscape(changeID) + "/backout"
	if err := c.doJSON(ctx, http.MethodPost, endpoint, req, http.StatusCreated, &out); err != nil {
		return Change{}, err
	}
	return out, nil
}

// SplitChange moves selected paths into a new change on repo-host.
func (c *Client) SplitChange(ctx context.Context, owner, repo, changeID string, req SplitChangeRequest) (SplitChangeResult, error) {
	defer c.observeOperationDuration("SplitChange", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return SplitChangeResult{}, fmt.Errorf("resolve storage set url: %w", err)
	}

	var out SplitChangeResult
	endpoint := repoByIDEndpoint(baseURL, owner, repo) + "/changes/" + url.PathEscape(changeID) + "/split"
	if err := c.doJSON(ctx, http.MethodPost, endpoint, req, http.StatusOK, &out); err != nil {
		return SplitChangeResult{}, err
	}
	return out, nil
}

// GetChangeDiff retrieves per-file diff metadata for a change.
func (c *Client) GetChangeDiff(ctx context.Context, owner, repo, changeID string) (ChangeDiff, error) {
	defer c.observeOperationDuration("GetChangeDiff", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return ChangeDiff{}, fmt.Errorf("resolve storage set url: %w", err)
	}

	var out ChangeDiff
	if err := c.doJSON(ctx, http.MethodGet, repoByIDEndpoint(baseURL, owner, repo)+"/changes/"+url.PathEscape(changeID)+"/diff", nil, http.StatusOK, &out); err != nil {
		return ChangeDiff{}, err
	}
	return out, nil
}

// GetRevisionDiff retrieves a revision-to-revision interdiff. An empty
// fromCommitID asks repo-host to compare the destination with its own parent.
func (c *Client) GetRevisionDiff(ctx context.Context, owner, repo, changeID, fromCommitID, toCommitID, path string) (ChangeDiff, error) {
	defer c.observeOperationDuration("GetChangeDiff", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return ChangeDiff{}, fmt.Errorf("resolve storage set url: %w", err)
	}

	endpoint := repoByIDEndpoint(baseURL, owner, repo) + "/changes/" + url.PathEscape(changeID) + "/diff"
	query := url.Values{}
	if strings.TrimSpace(fromCommitID) != "" {
		query.Set("from", fromCommitID)
	}
	query.Set("to", toCommitID)
	if path != "" {
		query.Set("path", path)
	}
	endpoint += "?" + query.Encode()

	var out ChangeDiff
	if err := c.doJSON(ctx, http.MethodGet, endpoint, nil, http.StatusOK, &out); err != nil {
		return ChangeDiff{}, err
	}
	return out, nil
}

// GetChangeFiles lists changed files for a change.
func (c *Client) GetChangeFiles(ctx context.Context, owner, repo, changeID string) ([]ChangeFile, error) {
	defer c.observeOperationDuration("GetChangeFiles", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return nil, fmt.Errorf("resolve storage set url: %w", err)
	}

	var out []ChangeFile
	if err := c.doJSON(ctx, http.MethodGet, repoByIDEndpoint(baseURL, owner, repo)+"/changes/"+url.PathEscape(changeID)+"/files", nil, http.StatusOK, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListFilesAtChange lists files from the full tree at a change, optionally filtered by path prefix.
func (c *Client) ListFilesAtChange(ctx context.Context, owner, repo, changeID, prefix string) ([]ChangeFile, error) {
	defer c.observeOperationDuration("ListFilesAtChange", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return nil, fmt.Errorf("resolve storage set url: %w", err)
	}

	endpoint := repoByIDEndpoint(baseURL, owner, repo) + "/changes/" + url.PathEscape(changeID) + "/tree"
	if trimmed := strings.TrimSpace(prefix); trimmed != "" {
		endpoint += "?prefix=" + url.QueryEscape(trimmed)
	}

	var out []ChangeFile
	if err := c.doJSON(ctx, http.MethodGet, endpoint, nil, http.StatusOK, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetChangeConflicts lists conflicts for a change.
func (c *Client) GetChangeConflicts(ctx context.Context, owner, repo, changeID string) ([]Conflict, error) {
	defer c.observeOperationDuration("GetChangeConflicts", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return nil, fmt.Errorf("resolve storage set url: %w", err)
	}

	var out []Conflict
	if err := c.doJSON(ctx, http.MethodGet, repoByIDEndpoint(baseURL, owner, repo)+"/changes/"+url.PathEscape(changeID)+"/conflicts", nil, http.StatusOK, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetFileAtChange reads file content at a change.
func (c *Client) GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (FileContent, error) {
	defer c.observeOperationDuration("GetFileAtChange", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return FileContent{}, fmt.Errorf("resolve storage set url: %w", err)
	}

	var out FileContent
	endpoint := repoByIDEndpoint(baseURL, owner, repo) + "/file/" + url.PathEscape(changeID)
	if escapedPath := escapePathSegments(path); escapedPath != "" {
		endpoint += "/" + escapedPath
	}
	if err := c.doJSON(ctx, http.MethodGet, endpoint, nil, http.StatusOK, &out); err != nil {
		return FileContent{}, err
	}
	return out, nil
}

// LandChanges lands change stack into target bookmark.
func (c *Client) LandChanges(ctx context.Context, owner, repo string, req LandRequest) (LandResult, error) {
	defer c.observeOperationDuration("LandChanges", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return LandResult{}, fmt.Errorf("resolve storage set url: %w", err)
	}

	var out LandResult
	endpoint := "/land"
	if req.Append != nil {
		endpoint = "/land/append"
	}
	if err := c.doJSON(ctx, http.MethodPost, repoByIDEndpoint(baseURL, owner, repo)+endpoint, req, http.StatusOK, &out); err != nil {
		return LandResult{}, err
	}
	return out, nil
}

// ComposeSuperproject writes one superproject commit on repo-host.
func (c *Client) ComposeSuperproject(ctx context.Context, owner, repo string, req ComposeSuperprojectRequest) (SuperprojectCommit, error) {
	defer c.observeOperationDuration("ComposeSuperproject", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return SuperprojectCommit{}, fmt.Errorf("resolve storage set url: %w", err)
	}

	var out SuperprojectCommit
	if err := c.doJSON(ctx, http.MethodPost, repoByIDEndpoint(baseURL, owner, repo)+"/superproject", req, http.StatusOK, &out); err != nil {
		return SuperprojectCommit{}, err
	}
	return out, nil
}

// GetSuperproject reads the member vector pinned by a superproject revision
// (change id or commit id).
func (c *Client) GetSuperproject(ctx context.Context, owner, repo, revision string) (SuperprojectCommit, error) {
	defer c.observeOperationDuration("GetSuperproject", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return SuperprojectCommit{}, fmt.Errorf("resolve storage set url: %w", err)
	}

	var out SuperprojectCommit
	if err := c.doJSON(ctx, http.MethodGet, repoByIDEndpoint(baseURL, owner, repo)+"/superproject/"+url.PathEscape(revision), nil, http.StatusOK, &out); err != nil {
		return SuperprojectCommit{}, err
	}
	return out, nil
}

// ListOperations lists operation log entries.
func (c *Client) ListOperations(ctx context.Context, owner, repo string, cursor string, limit int) ([]Operation, string, error) {
	defer c.observeOperationDuration("ListOperations", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return nil, "", fmt.Errorf("resolve storage set url: %w", err)
	}

	return doJSONPaginated[Operation](ctx, c, http.MethodGet, repoByIDEndpoint(baseURL, owner, repo)+"/operations", cursor, limit, http.StatusOK)
}

// GetWorkingTreeStatus fetches the live working-tree status (backend, branch,
// head, and changed files) for a repository's checkout.
func (c *Client) GetWorkingTreeStatus(ctx context.Context, owner, repo string) (WorkingTreeStatus, error) {
	defer c.observeOperationDuration("GetWorkingTreeStatus", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return WorkingTreeStatus{}, fmt.Errorf("resolve storage set url: %w", err)
	}

	var out WorkingTreeStatus
	if err := c.doJSON(ctx, http.MethodGet, repoByIDEndpoint(baseURL, owner, repo)+"/status", nil, http.StatusOK, &out); err != nil {
		return WorkingTreeStatus{}, err
	}
	return out, nil
}

// CreateSnapshot requests a checkout snapshot for workflows.
func (c *Client) CreateSnapshot(ctx context.Context, owner, repo string, req SnapshotRequest) (SnapshotResult, error) {
	defer c.observeOperationDuration("CreateSnapshot", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return SnapshotResult{}, fmt.Errorf("resolve storage set url: %w", err)
	}

	var out SnapshotResult
	if err := c.doJSON(ctx, http.MethodPost, repoByIDEndpoint(baseURL, owner, repo)+"/snapshot", req, http.StatusOK, &out); err != nil {
		return SnapshotResult{}, err
	}
	return out, nil
}

// ImportRefs triggers jj import for git refs after external pushes.
func (c *Client) ImportRefs(ctx context.Context, owner, repo string) error {
	defer c.observeOperationDuration("ImportRefs", time.Now())

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("resolve storage set url: %w", err)
	}

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		repoEndpoint(baseURL, owner, repo)+"/git/import-refs",
		nil,
	)
	if err != nil {
		return fmt.Errorf("create repo-host import-refs request: %w", err)
	}
	c.applyAuthHeader(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("repo-host import-refs request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		discardErrorBody(resp.Body)
		return fmt.Errorf("repo-host import-refs returned status %d", resp.StatusCode)
	}

	return nil
}

// ReceivePackMetadata carries push context forwarded from the Go proxy layer
// to the repo-host so it can be included in the push-hook callback.
type ReceivePackMetadata struct {
	RefName     string
	CommitSHA   string
	PusherID    int64
	PusherLogin string
	// PusherCredential is the kind of credential the API authenticated for
	// this push. Repo-host refuses an agent run's write of the default
	// bookmark, and the push event carries it so a system credential's push
	// never starts a cache-saving run.
	PusherCredential middleware.CredentialKind
	// WorkspaceID names the workspace a workspace-bound credential pushes
	// for (RFD-004); repo-host lets that push touch only that workspace's
	// head ref under refs/smithers/workspaces/.
	WorkspaceID  string
	AllowedPaths []string
	// ControlPlane marks the API's own write of the mythical stack refs. It
	// is set only in-process, never from a client request.
	ControlPlane bool
}

// StartedHeader asks repo-host to answer 102 Processing once it holds the
// repository's write lock for a receive-pack.
const StartedHeader = "X-Smithers-Signal-Started"

// PushTooSlowCode is repo-host's code for a push stopped at its duration
// limit (ReceivePackMaxDuration).
const PushTooSlowCode = "push_too_slow"

type pushStartedKey struct{}

// WithPushStarted has a receive-pack made with ctx call started once
// repo-host has taken the repository's write lock for it: until then nothing
// is written, and the caller may abandon the push or keep waiting; from
// then on the push has ReceivePackMaxDuration.
func WithPushStarted(ctx context.Context, started func()) context.Context {
	return context.WithValue(ctx, pushStartedKey{}, started)
}

// PushStartedSlack is how much longer than ReceivePackMaxDuration a front
// door (the API's git route, SSH) gives a started push, so repo-host's own
// answer at the limit reaches the pusher first.
const PushStartedSlack = 30 * time.Second

// PushStarted reports, to whoever asked with WithPushStarted, that the
// receive-pack made with ctx has started. The client does it on repo-host's
// 102; a stand-in for repo-host calls it itself.
func PushStarted(ctx context.Context) {
	if started, ok := ctx.Value(pushStartedKey{}).(func()); ok {
		started()
	}
}

// PusherCredentialHeader carries ReceivePackMetadata.PusherCredential.
const PusherCredentialHeader = "X-Smithers-Pusher-Credential"

type refViewerKey struct{}

// WithRefViewer marks the git reads made with ctx (info-refs, upload-pack) as
// userID's: repo-host shows them that user's own refs/smithers/users/<id>/
// refs and no other user's (#2253). A read without it sees no user ref. A
// push names its viewer through ReceivePackMetadata.PusherID.
func WithRefViewer(ctx context.Context, userID int64) context.Context {
	return context.WithValue(ctx, refViewerKey{}, userID)
}

// RefViewer is the user WithRefViewer named for ctx, else 0.
func RefViewer(ctx context.Context) int64 {
	userID, _ := ctx.Value(refViewerKey{}).(int64)
	return userID
}

// setRefViewer adds ctx's ref viewer to a git read request.
func setRefViewer(ctx context.Context, req *http.Request) {
	if userID := RefViewer(ctx); userID > 0 {
		req.Header.Set("X-Smithers-Pusher-Id", strconv.FormatInt(userID, 10))
	}
}

// ProxyReceivePack streams a git receive-pack RPC to repo-host,
// forwarding pusher identity and ref metadata as HTTP headers.
func (c *Client) ProxyReceivePack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...ReceivePackMetadata) error {
	defer c.observeOperationDuration("ProxyReceivePack", time.Now())

	var m ReceivePackMetadata
	if len(meta) > 0 {
		m = meta[0]
	}

	if (m.RefName == "" || m.CommitSHA == "") && stdin != nil {
		update, rebuilt, _ := PeekReceivePackUpdate(stdin)
		stdin = rebuilt
		if m.RefName == "" {
			m.RefName = update.RefName
		}
		if m.CommitSHA == "" {
			m.CommitSHA = update.NewOID
		}
	}

	return c.proxyGitRPCWithMeta(
		ctx,
		owner,
		repo,
		"receive-pack",
		"application/x-git-receive-pack-request",
		"application/x-git-receive-pack-result",
		stdin,
		stdout,
		m,
	)
}

// ProxyUploadPack streams a git upload-pack RPC to repo-host.
func (c *Client) ProxyUploadPack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer) error {
	defer c.observeOperationDuration("ProxyUploadPack", time.Now())

	return c.proxyGitRPC(
		ctx,
		owner,
		repo,
		"upload-pack",
		"application/x-git-upload-pack-request",
		"application/x-git-upload-pack-result",
		stdin,
		stdout,
	)
}

// InfoRefs proxies a git smart HTTP info/refs request to repo-host.
func (c *Client) InfoRefs(ctx context.Context, owner, repo, service string, stdout io.Writer) (string, error) {
	defer c.observeOperationDuration("InfoRefs", time.Now())

	return c.proxyGitInfoRefs(ctx, owner, repo, service, stdout)
}

// ProxyUploadPackBody sends a pre-buffered upload-pack request body to repo-host.
// Unlike ProxyUploadPack, the body is a complete reader (not a live SSH stream).
func (c *Client) ProxyUploadPackBody(ctx context.Context, owner, repo string, body io.Reader, stdout io.Writer) error {
	defer c.observeOperationDuration("ProxyUploadPackBody", time.Now())

	return c.proxyGitRPC(
		ctx,
		owner,
		repo,
		"upload-pack",
		"application/x-git-upload-pack-request",
		"application/x-git-upload-pack-result",
		body,
		stdout,
	)
}

// InfoRefsUploadPack fetches the raw ref advertisement for git-upload-pack.
// Returns just the git ref data suitable for the SSH protocol (strips the
// HTTP smart protocol "# service=..." pkt-line header).
func (c *Client) InfoRefsUploadPack(ctx context.Context, owner, repo string) ([]byte, error) {
	defer c.observeOperationDuration("InfoRefsUploadPack", time.Now())

	return c.fetchRawInfoRefs(ctx, owner, repo, "git-upload-pack")
}

// InfoRefsReceivePack fetches the raw ref advertisement for git-receive-pack.
func (c *Client) InfoRefsReceivePack(ctx context.Context, owner, repo string) ([]byte, error) {
	defer c.observeOperationDuration("InfoRefsReceivePack", time.Now())

	return c.fetchRawInfoRefs(ctx, owner, repo, "git-receive-pack")
}

// fetchRawInfoRefs fetches info/refs from repo-host and strips the HTTP
// smart protocol pkt-line service header, returning just the raw git refs.
func (c *Client) fetchRawInfoRefs(ctx context.Context, owner, repo, service string) ([]byte, error) {
	var buf bytes.Buffer
	_, err := c.proxyGitInfoRefs(ctx, owner, repo, service, &buf)
	if err != nil {
		return nil, err
	}

	raw := buf.Bytes()

	// Strip the HTTP smart protocol header: "001e# service=git-upload-pack\n0000"
	// Format: 4-char hex length + "# service=<service>\n" + "0000" flush
	header := fmt.Sprintf("# service=%s\n", service)
	headerPktLen := len(header) + 4 // 4 for the hex prefix
	expectedPrefix := fmt.Sprintf("%04x%s0000", headerPktLen, header)

	if len(raw) >= len(expectedPrefix) && string(raw[:len(expectedPrefix)]) == expectedPrefix {
		raw = raw[len(expectedPrefix):]
	}

	return raw, nil
}

func (c *Client) proxyGitRPC(
	ctx context.Context,
	owner, repo, rpcPath, contentType, accept string,
	stdin io.Reader,
	stdout io.Writer,
) error {
	return c.proxyGitRPCWithMeta(ctx, owner, repo, rpcPath, contentType, accept, stdin, stdout, ReceivePackMetadata{})
}

// proxyGitRPCWithMeta is the internal implementation that also sets push metadata headers.
func (c *Client) proxyGitRPCWithMeta(
	ctx context.Context,
	owner, repo, rpcPath, contentType, accept string,
	stdin io.Reader,
	stdout io.Writer,
	meta ReceivePackMetadata,
) error {
	if stdin == nil {
		stdin = bytes.NewReader(nil)
	}
	if stdout == nil {
		stdout = io.Discard
	}

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("resolve storage set url: %w", err)
	}

	gitRPCURL := fmt.Sprintf("%s/git/%s", repoEndpoint(baseURL, owner, repo), rpcPath)
	started, _ := ctx.Value(pushStartedKey{}).(func())
	if started != nil && rpcPath == "receive-pack" {
		var once sync.Once
		ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{Got1xxResponse: func(code int, _ textproto.MIMEHeader) error {
			if code == http.StatusProcessing {
				once.Do(started)
			}
			return nil
		}})
	} else {
		started = nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, gitRPCURL, stdin)
	if err != nil {
		return fmt.Errorf("create git proxy request: %w", err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	c.applyAuthHeader(req)
	if rpcPath == "upload-pack" {
		setRefViewer(ctx, req)
	}

	if meta.RefName != "" {
		req.Header.Set("X-Smithers-Push-Ref", meta.RefName)
	}
	if meta.CommitSHA != "" {
		req.Header.Set("X-Smithers-Push-Commit-Sha", meta.CommitSHA)
	}
	if meta.PusherID != 0 {
		req.Header.Set("X-Smithers-Pusher-Id", strconv.FormatInt(meta.PusherID, 10))
	}
	if meta.PusherLogin != "" {
		req.Header.Set("X-Smithers-Pusher-Login", meta.PusherLogin)
	}
	if meta.PusherCredential != "" {
		req.Header.Set(PusherCredentialHeader, string(meta.PusherCredential))
	}
	if meta.WorkspaceID != "" {
		req.Header.Set("X-Smithers-Workspace-Id", meta.WorkspaceID)
	}
	if meta.ControlPlane {
		req.Header.Set("X-Smithers-Control-Plane", "mythical")
	}
	if started != nil {
		req.Header.Set(StartedHeader, "1")
	}
	if len(meta.AllowedPaths) > 0 {
		encoded, err := json.Marshal(meta.AllowedPaths)
		if err != nil {
			return fmt.Errorf("encode push path allowlist: %w", err)
		}
		req.Header.Set("X-Smithers-Allowed-Paths", base64.RawURLEncoding.EncodeToString(encoded))
	}

	// Packfile streams can be long-lived. Use request context for lifecycle instead of hard client timeout.
	client := *c.httpClient
	client.Timeout = 0

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("git proxy request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return gitStatusError(resp)
	}

	if _, err := io.Copy(stdout, resp.Body); err != nil {
		return fmt.Errorf("stream git proxy response: %w", err)
	}
	return nil
}

func (c *Client) proxyGitInfoRefs(
	ctx context.Context,
	owner, repo, service string,
	stdout io.Writer,
) (string, error) {
	if stdout == nil {
		stdout = io.Discard
	}

	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return "", fmt.Errorf("resolve storage set url: %w", err)
	}
	requestCtx, cancel := c.readRequestContext(ctx)
	defer cancel()

	infoRefsURL := fmt.Sprintf("%s/git/info-refs", repoEndpoint(baseURL, owner, repo))
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, infoRefsURL, nil)
	if err != nil {
		return "", fmt.Errorf("create git info-refs request: %w", err)
	}

	query := url.Values{}
	query.Set("service", service)
	req.URL.RawQuery = query.Encode()
	req.Header.Set("Accept", fmt.Sprintf("application/x-%s-advertisement", service))
	c.applyAuthHeader(req)
	setRefViewer(ctx, req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("git info-refs request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return "", gitStatusError(resp)
	}

	if _, err := io.Copy(stdout, resp.Body); err != nil {
		return "", fmt.Errorf("stream git info-refs response: %w", err)
	}

	contentType := strings.TrimSpace(resp.Header.Get("Content-Type"))
	if contentType == "" {
		contentType = fmt.Sprintf("application/x-%s-advertisement", service)
	}
	return contentType, nil
}

func (c *Client) doJSON(ctx context.Context, method, endpoint string, requestBody any, expectedStatus int, responseBody any) error {
	var bodyReader io.Reader
	if requestBody != nil {
		encoded, err := json.Marshal(requestBody)
		if err != nil {
			return fmt.Errorf("marshal request: %w", err)
		}
		bodyReader = bytes.NewReader(encoded)
	}

	requestCtx, cancel := c.requestContext(ctx, method)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, method, endpoint, bodyReader)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	if requestBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	c.applyAuthHeader(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("repo-host request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != expectedStatus {
		return statusError(resp)
	}

	if responseBody == nil || resp.ContentLength == 0 {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(responseBody); err != nil && err != io.EOF {
		return fmt.Errorf("decode response: %w", err)
	}

	return nil
}

func doJSONPaginated[T any](ctx context.Context, c *Client, method, endpoint string, cursor string, limit int, expectedStatus int) ([]T, string, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, "", fmt.Errorf("parse endpoint: %w", err)
	}
	query := parsed.Query()
	query.Set("page", strconv.Itoa(cursorToPage(cursor, limit)))
	query.Set("per_page", strconv.Itoa(limit))
	parsed.RawQuery = query.Encode()

	requestCtx, cancel := c.requestContext(ctx, method)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, method, parsed.String(), nil)
	if err != nil {
		return nil, "", fmt.Errorf("create request: %w", err)
	}
	c.applyAuthHeader(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("repo-host request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != expectedStatus {
		return nil, "", statusError(resp)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", fmt.Errorf("read response: %w", err)
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return []T{}, "", nil
	}

	var out paginatedResponse[T]
	if err := json.Unmarshal(raw, &out); err == nil {
		nextCursor := out.NextCursor
		if nextCursor == "" && out.TotalCount > 0 && len(out.Items) == limit {
			nextOffset := cursorToOffset(cursor) + int64(limit)
			if nextOffset < out.TotalCount {
				nextCursor = strconv.FormatInt(nextOffset, 10)
			}
		}
		return out.Items, nextCursor, nil
	}

	var items []T
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, "", fmt.Errorf("decode response: %w", err)
	}

	return items, "", nil
}

func cursorToOffset(cursor string) int64 {
	if cursor == "" {
		return 0
	}
	offset, err := strconv.ParseInt(cursor, 10, 64)
	if err != nil || offset < 0 {
		return 0
	}
	return offset
}

func cursorToPage(cursor string, limit int) int {
	if limit <= 0 {
		limit = 30
	}
	return int(cursorToOffset(cursor)/int64(limit)) + 1
}

func repoByIDEndpoint(baseURL, owner, repo string) string {
	id := url.PathEscape(strings.TrimSpace(owner) + ":" + strings.TrimSpace(repo))
	return fmt.Sprintf("%s/repos/%s", strings.TrimRight(baseURL, "/"), id)
}

func escapePathSegments(path string) string {
	escapedSegments := make([]string, 0)
	for _, seg := range strings.Split(path, "/") {
		if seg == "" {
			continue
		}
		escapedSegments = append(escapedSegments, url.PathEscape(seg))
	}
	return strings.Join(escapedSegments, "/")
}

func repoEndpoint(baseURL, owner, repo string) string {
	return fmt.Sprintf(
		"%s/repos/%s/%s",
		strings.TrimRight(baseURL, "/"),
		url.PathEscape(owner),
		url.PathEscape(repo),
	)
}

func discardErrorBody(body io.Reader) {
	if body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(body, maxErrorBodyDiscardBytes))
}

// readErrorResponse reads up to maxErrorBodyDiscardBytes of an error response
// body: a JSON error, or plain text as its message.
func readErrorResponse(body io.Reader) errorMessage {
	if body == nil {
		return errorMessage{}
	}
	raw, _ := io.ReadAll(io.LimitReader(body, maxErrorBodyDiscardBytes))
	if len(raw) == 0 {
		return errorMessage{}
	}
	var em errorMessage
	if err := json.Unmarshal(raw, &em); err == nil {
		if em.Message != "" {
			return em
		}
		if em.Error != "" {
			em.Message = em.Error
			return em
		}
	}
	em.Message = strings.TrimSpace(string(raw))
	return em
}

func (c *Client) applyAuthHeader(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+c.authToken)
	// Propagate X-Request-Id from the request context to the outbound HTTP
	// request so the repo-host can correlate logs with the API server.
	if reqID := middleware.RequestIDFromContext(req.Context()); reqID != "" {
		req.Header.Set("X-Request-Id", reqID)
	}
}

// requestContext preserves the historical 30-second bound for read-only HTTP
// calls without imposing a client-side deadline on mutations. Mutations are
// coordinated by their callers with a context that starts only after the last
// safe cancellation point; an http.Client timeout here could abandon the real
// repo-host result while irreversible storage work continues.
func (c *Client) requestContext(ctx context.Context, method string) (context.Context, context.CancelFunc) {
	if method == http.MethodGet || method == http.MethodHead {
		return c.readRequestContext(ctx)
	}
	return ctx, func() {}
}

func (c *Client) readRequestContext(ctx context.Context) (context.Context, context.CancelFunc) {
	timeout := c.readTimeout
	if timeout <= 0 {
		timeout = defaultReadTimeout
	}
	return context.WithTimeout(ctx, timeout)
}

func (c *Client) observeOperationDuration(operation string, start time.Time) {
	if c == nil || c.metrics == nil {
		return
	}
	// The API observer exports smithers_repo_host_client_operation_duration_seconds;
	// repo-host server timing has its own histogram and label schema.
	c.metrics.ObserveRepoHostOperationDuration(operation, time.Since(start).Seconds())
}
