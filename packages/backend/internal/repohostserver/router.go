package repohostserver

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	jjmiddleware "github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

const maxJSONBodyBytes int64 = 1 << 20

// maxRefAdvertisementBytes caps the git info/refs advertisement buffered in
// memory (64 MiB ≈ several hundred thousand refs — far beyond any legitimate
// repository). Larger advertisements fail closed. Variable so tests can
// lower it.
var maxRefAdvertisementBytes int64 = 64 * 1024 * 1024

// maxDecompressedGitRequestSize caps gzip-decompressed git RPC request bodies
// as defense in depth against gzip-amplification: the API tier decompresses
// client gzip itself, so any gzip body arriving here comes from a bearer-token
// caller, but a compromised caller must still not be able to force unbounded
// decompression work. Mirrors the API-tier cap in internal/routes.
const maxDecompressedGitRequestSize int64 = 512 * 1024 * 1024

type Server struct {
	config     Config
	ffi        FFIClient
	metrics    *Metrics
	locks      *repoLocker
	refExports *refExportCache
	logger     *slog.Logger
	httpClient *http.Client
	background sync.WaitGroup
	pushOutbox *pushHookOutbox
	stopReplay context.CancelFunc
	stopSweep  context.CancelFunc
	// stopMaintenance stops repository maintenance (maintenance.go).
	stopMaintenance context.CancelFunc
	maintenanceMu   sync.Mutex
	maintenanceDue  map[string]struct{}
	// stopHolds stops checking repositories held for orphaned maintenance
	// (orphaned_maintenance.go).
	stopHolds context.CancelFunc
}

type loadableFFIClient interface {
	FFIClient
	Load() error
}

var (
	newRawFFIClient     = func(path string) loadableFFIClient { return repohostffi.New(path) }
	newMetricsForServer = NewMetrics
	copyDirRel          = filepath.Rel
)

type initRepoRequest struct {
	Owner           string `json:"owner"`
	Repo            string `json:"repo"`
	AutoInit        bool   `json:"auto_init"`
	DefaultBookmark string `json:"default_bookmark,omitempty"`
	RepoName        string `json:"repo_name,omitempty"`
}

type setDefaultBookmarkRequest struct {
	Name string `json:"name"`
}

type initRepoResponse struct {
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
	Path  string `json:"path"`
}

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

type pagination struct {
	Page    uint32
	PerPage uint32
}

func New(cfg Config) (*Server, error) {
	ffi := newRawFFIClient(cfg.FFILibraryPath)
	if err := ffi.Load(); err != nil {
		return nil, err
	}
	server, err := NewWithFFI(cfg, ffi)
	if err != nil {
		return nil, err
	}
	server.startPushHookReplay(pushHookReplayInterval)
	server.startUserRefSweep(userRefSweepInterval)
	server.startMaintenance(maintenanceInterval)
	return server, nil
}

// startPushHookReplay delivers push events a previous process persisted but
// never delivered, then keeps retrying failed deliveries until Shutdown.
func (s *Server) startPushHookReplay(interval time.Duration) {
	if s.config.PushHookCallbackURL == "" || s.stopReplay != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.stopReplay = cancel
	s.background.Add(1)
	go func() {
		defer s.background.Done()
		s.pushOutbox.runReplay(ctx, interval)
	}()
}

// NewWithFFI creates a Server with the given FFI client implementation.
// This is useful for testing where a mock FFIClient can be substituted.
func NewWithFFI(cfg Config, ffi FFIClient) (*Server, error) {
	if strings.TrimSpace(cfg.AuthToken) == "" {
		return nil, fmt.Errorf("repository auth token is required")
	}
	metrics, err := newMetricsForServer()
	if err != nil {
		return nil, err
	}

	logger := slog.New(jjmiddleware.NewGCPJSONHandler(os.Stdout, slog.LevelInfo))
	server := &Server{
		config:     cfg,
		ffi:        ffi,
		metrics:    metrics,
		locks:      newRepoLocker(),
		refExports: newRefExportCache(),
		logger:     logger,
		httpClient: pushHookClient(),
	}
	server.pushOutbox = newPushHookOutbox(server)
	server.reapOrphanedMaintenance()
	return server, nil
}

func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(jjmiddleware.RequestIDEcho)
	// OpenTelemetry HTTP middleware — continues traces from incoming
	// traceparent headers (the API's repohost client propagates them).
	r.Use(otelhttp.NewMiddleware("smithers-repo-host"))
	r.Use(jjmiddleware.InjectLogger(s.logger))
	r.Use(jjmiddleware.StructuredLogger(s.logger))
	r.Use(chiMiddleware.Recoverer)

	r.Get("/health", s.health)
	r.Handle("/metrics", s.metrics.Handler())

	r.Group(func(r chi.Router) {
		r.Use(s.authMiddleware)
		// A stored CRDT state is larger than its rendered Markdown. Bound this
		// stateless endpoint independently without raising other request limits.
		r.With(jsonTimeout(30*time.Second, s.logger), limitRequestBody(13<<20)).
			Post("/repos/{id}/wiki/document", s.withAppError(s.mergeWikiDocument))
		r.With(jsonTimeout(30*time.Second, s.logger), limitRequestBody(2<<20)).Post("/repos/{id}/wiki/revisions", s.withAppError(s.projectWikiRevision))

		r.Group(func(r chi.Router) {
			r.Use(jsonTimeout(30*time.Second, s.logger))
			r.Use(limitRequestBody(maxJSONBodyBytes))
			r.Method(http.MethodPost, "/repos/init", s.withAppError(s.initRepo))
			r.Method(http.MethodPost, "/repos/fork", s.withAppError(s.forkRepo))
			r.Method(http.MethodPost, "/repos/provision-stages", s.withAppError(s.stageProvisionRepo))
			r.Method(http.MethodPost, "/repos/provision-stages/{token}/publish", s.withAppError(s.publishStagedProvision))
			r.Method(http.MethodPost, "/repos/provision-stages/{token}/finalize", s.withAppError(s.finalizeStagedProvision))
			r.Method(http.MethodPost, "/repos/provision-stages/{token}/abort", s.withAppError(s.abortStagedProvision))
			r.Method(http.MethodPost, "/repos/move", s.withAppError(s.moveRepo))
			r.Method(http.MethodPost, "/repos/move-stages", s.withAppError(s.stageMoveRepo))
			r.Method(http.MethodPost, "/repos/move-stages/{token}/rollback", s.withAppError(s.rollbackStagedMove))
			r.Method(http.MethodPost, "/repos/move-stages/{token}/finalize", s.withAppError(s.finalizeStagedMove))
			r.Method(http.MethodPost, "/repos/delete-stages", s.withAppError(s.stageDeleteRepo))
			r.Method(http.MethodPost, "/repos/delete-stages/{token}/restore", s.withAppError(s.restoreStagedDelete))
			r.Method(http.MethodPost, "/repos/delete-stages/{token}/finalize", s.withAppError(s.finalizeStagedDelete))
			r.Method(http.MethodDelete, "/repos/{owner}/{repo}", s.withAppError(s.deleteRepo))
			r.Method(http.MethodPost, "/repos/{owner}/{repo}/git/import-refs", s.withAppError(s.importRefs))
			r.Method(http.MethodPut, "/repos/{id}/wiki", s.withAppError(s.initWikiRepo))
			r.Method(http.MethodPut, "/repos/{id}/docs", s.withAppError(s.initDocsRepo))
			r.Method(http.MethodPut, "/repos/{id}/wiki/pages/{page_name}", s.withAppError(s.commitWikiPage))
			r.Method(http.MethodPut, "/repos/{id}/docs/files/*", s.withAppError(s.commitDoc))
			r.Method(http.MethodGet, "/repos/{id}/wiki/pages/{page_name}", s.withAppError(s.getWikiPageContent))
			r.Method(http.MethodGet, "/repos/{id}/docs/files/*", s.withAppError(s.getDocContent))
			r.Method(http.MethodGet, "/repos/{id}/wiki/pages/{page_name}/history", s.withAppError(s.listWikiPageHistory))
			r.Method(http.MethodGet, "/repos/{id}/docs/history/*", s.withAppError(s.listDocHistory))
			r.Method(http.MethodDelete, "/repos/{id}/wiki/pages/{page_name}", s.withAppError(s.deleteWikiPage))
			r.Method(http.MethodDelete, "/repos/{id}/docs/files/*", s.withAppError(s.deleteDoc))
			r.Method(http.MethodGet, "/repos/{id}/bookmarks", s.withAppError(s.listBookmarks))
			r.Method(http.MethodPost, "/repos/{id}/bookmarks", s.withAppError(s.createBookmark))
			r.Method(http.MethodPut, "/repos/{id}/default-bookmark", s.withAppError(s.setDefaultBookmark))
			r.Method(http.MethodPost, "/repos/{id}/ref-case-collisions/repair", s.withAppError(s.repairRefCaseCollisions))
			r.Method(http.MethodGet, "/repos/{id}/bookmarks/{name}", s.withAppError(s.getBookmark))
			r.Method(http.MethodDelete, "/repos/{id}/bookmarks/{name}", s.withAppError(s.deleteBookmark))
			r.Method(http.MethodGet, "/repos/{id}/changes", s.withAppError(s.listChanges))
			r.Method(http.MethodGet, "/repos/{id}/changes/{change_id}", s.withAppError(s.getChange))
			r.Method(http.MethodPost, "/repos/{id}/changes/{change_id}/backout", s.withAppError(s.backoutChange))
			r.Method(http.MethodPost, "/repos/{id}/changes/{change_id}/split", s.withAppError(s.splitChange))
			r.Method(http.MethodGet, "/repos/{id}/changes/{change_id}/diff", s.withAppError(s.getChangeDiff))
			r.Method(http.MethodGet, "/repos/{id}/changes/{change_id}/files", s.withAppError(s.getChangeFiles))
			r.Method(http.MethodGet, "/repos/{id}/changes/{change_id}/tree", s.withAppError(s.listFilesAtChange))
			r.Method(http.MethodGet, "/repos/{id}/changes/{change_id}/conflicts", s.withAppError(s.getChangeConflicts))
			r.Method(http.MethodGet, "/repos/{id}/file/{change_id}/*", s.withAppError(s.getFileAtChange))
			r.Method(http.MethodPost, "/repos/{id}/land", s.withAppError(s.landChanges))
			r.Method(http.MethodPost, "/repos/{id}/land/append", s.withAppError(s.landAppend))
			r.Method(http.MethodPost, "/repos/{id}/land/append/prepare", s.withAppError(s.prepareLandAppend))
			r.Method(http.MethodPost, "/repos/{id}/workspace-source", s.withAppError(s.readWorkspaceSource))
			r.Method(http.MethodGet, "/repos/{id}/user-refs/{user_id}", s.withAppError(s.listUserRefs))
			r.Method(http.MethodPost, "/repos/{id}/user-refs/{user_id}/retain", s.withAppError(s.retainUserRef))
			r.Method(http.MethodPost, "/repos/{id}/user-refs/{user_id}/renew", s.withAppError(s.renewUserRef))
			r.Method(http.MethodPost, "/repos/{id}/superproject", s.withAppError(s.composeSuperproject))
			r.Method(http.MethodGet, "/repos/{id}/superproject/{revision}", s.withAppError(s.getSuperproject))
			r.Method(http.MethodGet, "/repos/{id}/operations", s.withAppError(s.listOperations))
			r.Method(http.MethodGet, "/repos/{id}/status", s.withAppError(s.getWorkingTreeStatus))
			r.Method(http.MethodPost, "/repos/{id}/snapshot", s.withAppError(s.createSnapshot))
		})

		r.Method(http.MethodGet, "/repos/{owner}/{repo}/git/info-refs", s.withGitError(s.infoRefs))
		r.Method(http.MethodPost, "/repos/{owner}/{repo}/git/receive-pack", s.withGitError(s.receivePack))
		r.Method(http.MethodPost, "/repos/{owner}/{repo}/git/upload-pack", s.withGitError(s.uploadPack))
	})

	// Hidden import smart-HTTP uses an HMAC derived from the unguessable journal
	// token as a short-lived capability. It is scoped to one staging path and
	// expires when finalize/abort removes that journal; neither the route token
	// nor the broad repo-host control token is exposed as a bearer to git.
	r.Group(func(r chi.Router) {
		r.Use(s.stagedProvisionAuthMiddleware)
		r.Method(http.MethodGet, "/repos/provision-stages/{token}/git/info/refs", s.withGitError(s.stagedProvisionInfoRefs))
		r.Method(http.MethodPost, "/repos/provision-stages/{token}/git/git-receive-pack", s.withGitError(s.stagedProvisionReceivePack))
	})

	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeAppError(w, notFound("route not found"), s.logger)
	})

	return r
}

func (s *Server) Shutdown(ctx context.Context) error {
	if s.stopReplay != nil {
		s.stopReplay()
	}
	if s.stopSweep != nil {
		s.stopSweep()
	}
	if s.stopMaintenance != nil {
		s.stopMaintenance()
	}
	if s.stopHolds != nil {
		s.stopHolds()
	}
	done := make(chan struct{})
	go func() {
		s.background.Wait()
		close(done)
	}()

	// A context that is already expired (the HTTP drain used the whole
	// budget) must not turn completed background work into an error.
	select {
	case <-done:
		return nil
	default:
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		select {
		case <-done:
			return nil
		default:
			return ctx.Err()
		}
	}
}

func (s *Server) withAppError(fn func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			writeAppError(w, err, s.logger)
		}
	}
}

// withGitError is withAppError for git smart-HTTP routes: errors are plain
// text git shows its user.
func (s *Server) withGitError(fn func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			writeGitAppError(w, err, s.logger)
		}
	}
}

func limitRequestBody(limit int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body != nil {
				r.Body = http.MaxBytesReader(w, r.Body, limit)
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			writeAppError(w, unauthorized("authorization header is required"), s.logger)
			return
		}

		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			writeAppError(w, unauthorized("bearer token is required"), s.logger)
			return
		}
		if subtle.ConstantTimeCompare([]byte(parts[1]), []byte(s.config.AuthToken)) != 1 {
			writeAppError(w, unauthorized("invalid bearer token"), s.logger)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (s *Server) stagedProvisionAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimSpace(chi.URLParam(r, "token"))
		parts := strings.SplitN(r.Header.Get("Authorization"), " ", 2)
		expectedBearer := repohost.StagedProvisionBearer(s.config.AuthToken, token)
		if !validDeleteStageToken(token) || len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") ||
			subtle.ConstantTimeCompare([]byte(strings.TrimSpace(parts[1])), []byte(expectedBearer)) != 1 {
			writeAppError(w, unauthorized("invalid staged repository capability"), s.logger)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	s.metrics.SetServiceHealth(true)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) initRepo(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("InitRepo")
	defer done()

	var req initRepoRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	if err := validateOwnerRepo(req.Owner, req.Repo); err != nil {
		return err
	}

	repoPath := s.config.RepoPath(req.Owner, req.Repo)
	unlock, err := s.lockRepo(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	var result repohostffi.InitRepoResult
	if req.AutoInit {
		defaultBookmark := strings.TrimSpace(req.DefaultBookmark)
		if defaultBookmark == "" {
			defaultBookmark = "main"
		}
		if err := repohost.ValidateBookmarkName(defaultBookmark); err != nil {
			return badRequest("invalid default bookmark name: " + err.Error())
		}
		repoName := strings.TrimSpace(req.RepoName)
		if repoName == "" {
			repoName = req.Repo
		}
		result, err = s.ffi.AutoInitRepo(repoPath, defaultBookmark, repoName)
	} else {
		if req.DefaultBookmark != "" {
			if err := repohost.ValidateBookmarkName(req.DefaultBookmark); err != nil {
				return badRequest("invalid default bookmark name: " + err.Error())
			}
		}
		result, err = s.ffi.InitRepo(repoPath)
	}
	if err != nil {
		return err
	}
	if err := disableAutoMaintenance(context.WithoutCancel(r.Context()), repoGitDir(repoPath)); err != nil {
		return internalError("failed to configure repository", err)
	}
	if !req.AutoInit && req.DefaultBookmark != "" {
		if err := setGitDefaultBookmark(r.Context(), s.config.GitBackendPath(req.Owner, req.Repo), req.DefaultBookmark); err != nil {
			return internalError("failed to set default bookmark", err)
		}
	}

	return writeJSON(w, http.StatusCreated, initRepoResponse{
		Owner: req.Owner,
		Repo:  req.Repo,
		Path:  result.Path,
	})
}

func (s *Server) deleteRepo(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("DeleteRepo")
	defer done()

	owner := chi.URLParam(r, "owner")
	repo := chi.URLParam(r, "repo")
	if err := validateOwnerRepo(owner, repo); err != nil {
		return err
	}

	repoPath := s.config.RepoPath(owner, repo)
	wikiPath := s.config.WikiRepoPath(owner, repo)
	docsPath := s.config.DocsRepoPath(owner, repo)
	unlock, err := s.locks.LockAll(r.Context(), repoPath, wikiPath, docsPath)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	if err := s.ffi.DeleteRepo(repoPath); err != nil {
		return err
	}
	s.refExports.forget(repoPath)
	// Remove the wiki/docs sidecar stores too: leaving them behind leaks disk
	// and lets a future repo with the same owner/name silently inherit the
	// deleted repo's wiki/docs content.
	for _, sidecar := range []string{wikiPath, docsPath} {
		if err := os.RemoveAll(sidecar); err != nil {
			return internalError("failed to delete repository sidecar store", err)
		}
	}
	if err := removeEmptyOwnerDir(filepath.Dir(repoPath)); err != nil {
		return err
	}

	w.WriteHeader(http.StatusNoContent)
	return nil
}

type forkRepoRequest struct {
	SrcOwner string `json:"src_owner"`
	SrcRepo  string `json:"src_repo"`
	DstOwner string `json:"dst_owner"`
	DstRepo  string `json:"dst_repo"`
}

// forkRepo copies a source repository's on-disk data to a new destination path.
// It write-locks both the source and the destination for the whole copy, so
// clones and ref advertisements of the source wait until the fork finishes.
// It creates the destination directory hierarchy before the recursive copy.
func (s *Server) forkRepo(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("ForkRepo")
	defer done()

	var req forkRepoRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	if err := validateOwnerRepo(req.SrcOwner, req.SrcRepo); err != nil {
		return err
	}
	if err := validateOwnerRepo(req.DstOwner, req.DstRepo); err != nil {
		return err
	}

	srcPath := s.config.RepoPath(req.SrcOwner, req.SrcRepo)
	dstPath := s.config.RepoPath(req.DstOwner, req.DstRepo)

	unlock, err := s.locks.LockAll(r.Context(), srcPath, dstPath)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	// Ensure source exists.
	if _, err := os.Stat(srcPath); err != nil {
		if os.IsNotExist(err) {
			return notFound("source repository not found")
		}
		return internalError("internal server error", err)
	}

	// Destination must not already exist.
	if _, err := os.Stat(dstPath); err == nil {
		return badRequest("destination repository already exists")
	}

	if err := os.MkdirAll(filepath.Dir(dstPath), 0o755); err != nil {
		return internalError("internal server error", err)
	}
	if err := copyDir(srcPath, dstPath); err != nil {
		// Best-effort cleanup of partial destination.
		_ = os.RemoveAll(dstPath)
		return internalError("failed to copy repository", err)
	}
	// A user's pushed refs belong to the repository they pushed to.
	if err := dropUserRefs(r.Context(), s.config.GitBackendPath(req.DstOwner, req.DstRepo)); err != nil {
		_ = os.RemoveAll(dstPath)
		return internalError("failed to copy repository", err)
	}
	if err := disableAutoMaintenance(context.WithoutCancel(r.Context()), repoGitDir(dstPath)); err != nil {
		_ = os.RemoveAll(dstPath)
		return internalError("failed to configure repository", err)
	}

	return writeJSON(w, http.StatusCreated, map[string]string{
		"src_owner": req.SrcOwner,
		"src_repo":  req.SrcRepo,
		"dst_owner": req.DstOwner,
		"dst_repo":  req.DstRepo,
	})
}

type moveRepoRequest struct {
	SrcOwner string `json:"src_owner"`
	SrcRepo  string `json:"src_repo"`
	DstOwner string `json:"dst_owner"`
	DstRepo  string `json:"dst_repo"`
	Token    string `json:"token,omitempty"`
}

// moveRepo renames a repository's on-disk storage from one owner/name to another.
// It is used during transfer to atomically move storage after the DB record is updated.
func (s *Server) moveRepo(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("MoveRepo")
	defer done()

	var req moveRepoRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	if err := validateOwnerRepo(req.SrcOwner, req.SrcRepo); err != nil {
		return err
	}
	if err := validateOwnerRepo(req.DstOwner, req.DstRepo); err != nil {
		return err
	}

	srcPath := s.config.RepoPath(req.SrcOwner, req.SrcRepo)
	dstPath := s.config.RepoPath(req.DstOwner, req.DstRepo)

	// The wiki/docs sidecar stores live next to the repo and must relocate
	// with it, otherwise the new owner loses them and they linger (and can be
	// inherited by a future same-named repo) under the old owner.
	renames := []struct{ src, dst string }{
		{srcPath, dstPath},
		{s.config.WikiRepoPath(req.SrcOwner, req.SrcRepo), s.config.WikiRepoPath(req.DstOwner, req.DstRepo)},
		{s.config.DocsRepoPath(req.SrcOwner, req.SrcRepo), s.config.DocsRepoPath(req.DstOwner, req.DstRepo)},
	}
	lockKeys := make([]string, 0, len(renames)*2)
	for _, r := range renames {
		lockKeys = append(lockKeys, r.src, r.dst)
	}
	unlock, err := s.locks.LockAll(r.Context(), lockKeys...)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	if _, err := os.Stat(srcPath); err != nil {
		if os.IsNotExist(err) {
			return notFound("source repository not found")
		}
		return internalError("internal server error", err)
	}

	for _, r := range renames {
		if _, err := os.Stat(r.src); err != nil {
			continue // absent sidecars have nothing to collide with
		}
		if _, err := os.Stat(r.dst); err == nil {
			return badRequest("destination repository already exists")
		}
	}

	if err := os.MkdirAll(filepath.Dir(dstPath), 0o755); err != nil {
		return internalError("internal server error", err)
	}
	moved := make([]struct{ src, dst string }, 0, len(renames))
	for _, r := range renames {
		if _, err := os.Stat(r.src); err != nil {
			continue // sidecar was never initialized
		}
		if err := os.Rename(r.src, r.dst); err != nil {
			// Roll the already-moved stores back so the repo and its sidecars
			// never end up split across two owners.
			for i := len(moved) - 1; i >= 0; i-- {
				if rerr := os.Rename(moved[i].dst, moved[i].src); rerr != nil {
					slog.Error("failed to roll back partial repository move",
						"src", moved[i].src, "dst", moved[i].dst, "error", rerr)
				}
			}
			return internalError("failed to move repository", err)
		}
		moved = append(moved, r)
	}
	// A relocated store leaves no refs behind at the old path; drop its cached
	// export state so a future repository created there cannot inherit it.
	s.refExports.forget(srcPath)
	s.refExports.forget(dstPath)

	// Prune the old owner dir if it is now empty.
	_ = removeEmptyOwnerDir(filepath.Dir(srcPath))

	return writeJSON(w, http.StatusOK, map[string]string{
		"src_owner": req.SrcOwner,
		"src_repo":  req.SrcRepo,
		"dst_owner": req.DstOwner,
		"dst_repo":  req.DstRepo,
	})
}

// copyDir recursively copies src directory to dst.
func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := copyDirRel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		if info.Mode()&os.ModeSymlink != 0 {
			linkTarget, readErr := os.Readlink(path)
			if readErr != nil {
				return fmt.Errorf("read symlink %s: %w", path, readErr)
			}
			if linkErr := os.Symlink(linkTarget, target); linkErr != nil {
				return fmt.Errorf("copy symlink %s: %w", path, linkErr)
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("unsupported repository file type at %s", path)
		}
		return copyFile(path, target, info.Mode())
	})
}

// copyFile copies a single regular file, preserving mode bits.
func copyFile(src, dst string, mode os.FileMode) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to copy symlink %s", src)
	}

	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer func() { _ = out.Close() }()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}

func (s *Server) importRefs(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("ImportRefs")
	defer done()

	owner := chi.URLParam(r, "owner")
	repo := chi.URLParam(r, "repo")
	if err := validateOwnerRepo(owner, repo); err != nil {
		return err
	}

	repoPath := s.config.RepoPath(owner, repo)
	unlock, err := s.lockRepo(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	if err := s.ffi.ImportGitRefs(repoPath); err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) infoRefs(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("InfoRefs")
	defer done()

	owner := chi.URLParam(r, "owner")
	repo := chi.URLParam(r, "repo")
	if err := validateOwnerRepo(owner, repo); err != nil {
		return err
	}

	service := strings.TrimSpace(r.URL.Query().Get("service"))
	if service != "git-upload-pack" && service != "git-receive-pack" {
		return badRequest("unsupported git service")
	}

	gitDir := s.config.GitBackendPath(owner, repo)
	repoPath := s.config.RepoPath(owner, repo)
	// A push to a held repository is refused at discovery, before its pack is
	// sent, and git shows the discovery's error text to the user.
	if service == "git-receive-pack" && s.locks.Held(repoPath) {
		return errRepositoryHeld()
	}

	// Bring the git backend up to date with the jj view only when the jj
	// operation head has moved; the advertisement itself is served by git.
	if err := s.syncGitRefs(r.Context(), repoPath, gitDir); err != nil {
		return err
	}

	// The advertisement only reads the git backend, so a read lock is enough:
	// parallel clones of the same repository no longer serialize.
	unlock, err := s.locks.RLock(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()

	if _, err := os.Stat(gitDir); err != nil {
		return notFound("repository not found")
	}

	// Run git advertise-refs; the output is normally small so we collect it
	// before writing response headers so we can still return an error on
	// failure. The read is capped: a repository with a pathological number of
	// refs must not make us buffer an unbounded advertisement in memory while
	// holding the repository lock.
	gitCommand := "upload-pack"
	if service == "git-receive-pack" {
		gitCommand = "receive-pack"
	}
	cmdCtx, cancelCmd := context.WithCancel(r.Context())
	defer cancelCmd()
	cmd := exec.CommandContext(cmdCtx, "git", gitCommand, "--stateless-rpc", "--advertise-refs", gitDir)
	cmd.Env = gitServiceEnv(gitCommand, maxDecompressedGitRequestSize, refViewer(r))
	var refStderr bytes.Buffer
	cmd.Stderr = &refStderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return internalError("internal server error", err)
	}
	if err := cmd.Start(); err != nil {
		return internalError("internal server error", err)
	}
	refOutput, readErr := io.ReadAll(io.LimitReader(stdout, maxRefAdvertisementBytes+1))
	tooLarge := int64(len(refOutput)) > maxRefAdvertisementBytes
	if tooLarge {
		// Kill git instead of draining an arbitrarily large advertisement.
		cancelCmd()
	}
	_, _ = io.Copy(io.Discard, stdout)
	waitErr := cmd.Wait()
	if tooLarge {
		return internalError("ref advertisement exceeds maximum size", nil)
	}
	if readErr != nil {
		return internalError("internal server error", readErr)
	}
	if waitErr != nil {
		return fmt.Errorf("git info-refs failed: %s", strings.TrimSpace(refStderr.String()))
	}

	serviceLine := fmt.Sprintf("# service=%s\n", service)
	pktLen := len(serviceLine) + 4
	prefix := fmt.Sprintf("%04x%s0000", pktLen, serviceLine)

	w.Header().Set("Content-Type", "application/x-"+service+"-advertisement")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, prefix)
	_, _ = w.Write(refOutput)
	return nil
}

// gitRequestBody returns the git RPC request body, transparently gunzipping
// when the client sent Content-Encoding: gzip. git's remote-curl compresses
// smart-HTTP request bodies past a size threshold, so a LARGE negotiation
// (cloning a many-ref mirror wants hundreds of refs) arrives gzipped while a
// small one arrives as identity — feeding the compressed bytes to
// `git upload-pack --stateless-rpc` made it exit silently with an empty 200
// and every large clone died with "the remote end hung up unexpectedly".
func gitRequestBody(r *http.Request) (io.ReadCloser, error) {
	if !strings.EqualFold(strings.TrimSpace(r.Header.Get("Content-Encoding")), "gzip") {
		return r.Body, nil
	}
	zr, err := gzip.NewReader(r.Body)
	if err != nil {
		return nil, badRequest("malformed gzip request body")
	}
	return limitedReadCloser{Reader: io.LimitReader(zr, maxDecompressedGitRequestSize), Closer: zr}, nil
}

// limitedReadCloser caps a decompressed stream while preserving the ability to
// close the underlying gzip reader.
type limitedReadCloser struct {
	io.Reader
	io.Closer
}

func (s *Server) receivePack(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("ProxyReceivePack")
	defer done()

	owner := chi.URLParam(r, "owner")
	repo := chi.URLParam(r, "repo")
	if err := validateOwnerRepo(owner, repo); err != nil {
		return err
	}

	repoPath := s.config.RepoPath(owner, repo)
	gitDir := s.config.GitBackendPath(owner, repo)
	unlock, err := s.lockRepo(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()

	if _, err := os.Stat(gitDir); err != nil {
		return notFound("repository not found")
	}
	if r.Header.Get(repohost.StartedHeader) == "1" {
		// The caller may stop waiting for the lock until here, not after.
		w.WriteHeader(http.StatusProcessing)
	}
	allowedPaths, pathRestricted, allowErr := pushPathAllowlist(r.Header)
	if allowErr != nil {
		return allowErr
	}

	var (
		beforeRefs              map[string]string
		shouldDispatchPushHooks bool
	)
	beforeRefs, err = listGitRefs(r.Context(), gitDir)
	if err != nil {
		return internalError("failed to snapshot refs before receive-pack", err)
	}
	shouldDispatchPushHooks = s.config.PushHookCallbackURL != ""

	requestBody, err := gitRequestBody(r)
	if err != nil {
		return err
	}
	// RFD-004: refs/smithers/ belongs to the control plane. Only a push the
	// API attributed to a workspace (X-Smithers-Workspace-Id) may touch that
	// workspace's head ref; every other write under the prefix is refused
	// before git sees the pack. This is the last line behind the API and
	// SSH checks, so a bypassed proxy still cannot forge a workspace head.
	// Like those front doors it fails closed: a command list the peek cannot
	// read (over the size cap, or malformed) may still be one git applies.
	//
	// Arm an idle read deadline for the whole push body, the peek included: a
	// stalled caller must not hold the repository write lock and a git
	// subprocess until the TCP connection dies. The deadline is cleared before
	// the response is written so it cannot leak into connection reuse.
	rc := http.NewResponseController(w)
	defer func() { _ = rc.SetReadDeadline(time.Time{}) }()
	commands, peeked, peekErr := repohost.PeekReceivePackCommands(&idleDeadlineBody{rc: rc, r: requestBody})
	if peekErr != nil {
		return badRequest("malformed receive-pack command list")
	}
	// The API sets X-Smithers-Pusher-Id from the credential it authenticated;
	// it names whose refs/smithers/users/<id>/ namespace this push may write.
	sender := pushHookSenderFromHeaders(r.Header)
	pusherID := sender.PusherID
	if msg := repohost.ControlPlaneRefViolation(commands, r.Header.Get("X-Smithers-Workspace-Id"),
		pusherID, r.Header.Get("X-Smithers-Control-Plane") == "mythical"); msg != "" {
		return forbidden(msg)
	}
	if err := refuseCaseVariantRefs(beforeRefs, writtenRefNames(commands)...); err != nil {
		return err
	}
	if sender.PusherCredential == jjmiddleware.CredentialAgentRun {
		if err := refuseAgentRunDefaultBookmark(r.Context(), gitDir, commands); err != nil {
			return err
		}
	}
	// #1968: a push that writes a user ref first expires stale ones, then
	// may not leave its pusher over the ref limit, and its pack is capped.
	maxInputSize := maxDecompressedGitRequestSize
	userRefs := writesUserRef(commands)
	if userRefs {
		named := make([]string, 0, len(commands))
		for _, command := range commands {
			named = append(named, command.RefName)
		}
		if _, err := s.reconcileUserRefs(r.Context(), gitDir, beforeRefs, named...); err != nil {
			return internalError("failed to expire user refs", err)
		}
		policy := s.config.userRefPolicy()
		if msg := userRefPushViolation(commands, beforeRefs, pusherID, policy.limit); msg != "" {
			return forbidden(msg)
		}
		maxInputSize = policy.maxPushBytes
	}
	// receive-pack responses are small (sideband status lines only), so we
	// buffer them here. We must hold the full response in memory until after
	// jj ref import and push hooks so we can still return an HTTP error if the
	// git subprocess itself fails before any bytes are written to the client.
	pushed := &countingReader{r: peeked}
	body, err := runReceivePackBuffered(r.Context(), gitDir, readCloserWithBody(pushed, requestBody), maxInputSize, refViewer(r))
	gitErr := err
	if gitErr != nil && userRefs && pushed.n > maxInputSize {
		gitErr = &appError{StatusCode: http.StatusRequestEntityTooLarge, Code: "user_ref_push_too_large",
			Message: fmt.Sprintf("a push to refs/smithers/users/ is capped at %d MiB", maxInputSize>>20)}
	}

	// git has applied the ref updates. A path-restricted push is authorized
	// here, before jj imports anything, so jj never sees a ref it must later
	// forget. The listing, inspection and any rollback run on a context that
	// outlives the request: a client that disconnects after git published its
	// refs cannot leave them standing unverified.
	enforceCtx, cancelEnforce := detachedPushContext(r.Context())
	defer cancelEnforce()
	afterRefs, err := listGitRefs(enforceCtx, gitDir)
	if err != nil {
		return rollBackUnlistablePush(enforceCtx, gitDir, err, commands, beforeRefs)
	}
	if gitErr != nil {
		return rollBackPublishedPush(enforceCtx, gitDir, beforeRefs, afterRefs, gitErr)
	}
	if sender.PusherCredential != jjmiddleware.CredentialSync {
		if err := refuseDefaultBookmarkRewind(enforceCtx, gitDir, beforeRefs, afterRefs); err != nil {
			return rollBackPublishedPush(enforceCtx, gitDir, beforeRefs, afterRefs, err)
		}
	}
	if pathRestricted {
		if err := enforcePushPathAllowlist(enforceCtx, gitDir, beforeRefs, afterRefs, allowedPaths); err != nil {
			return err
		}
	}

	// Persist the push events before jj imports the refs and before git's
	// response: once the client sees success, the events survive a crash and
	// the outbox replay delivers them. A push whose events cannot be persisted
	// is rolled back rather than published without them.
	var outboxPaths []string
	if shouldDispatchPushHooks {
		payloads := pushHookPayloadsFromRefDiff(beforeRefs, afterRefs, owner, repo, sender)
		if len(payloads) > 0 {
			outboxPaths, err = s.pushOutbox.persist(payloads)
			if err != nil {
				return rollBackPublishedPush(enforceCtx, gitDir, beforeRefs, afterRefs, err)
			}
		}
	}

	// A user ref's push time is part of the push: a push whose time cannot
	// be recorded is rolled back. A later rollback leaves a newer stamp,
	// which only lengthens a life.
	if userRefs {
		if err := stampUserRefPushes(gitDir, commands, afterRefs); err != nil {
			s.pushOutbox.discard(outboxPaths)
			return rollBackPublishedPush(enforceCtx, gitDir, beforeRefs, afterRefs, err)
		}
	}

	if err := s.ffi.ImportGitRefs(repoPath); err != nil {
		if s.logger != nil {
			s.logger.Warn("git receive-pack succeeded but jj ref import failed", "owner", owner, "repo", repo, "error", err)
		}
		s.pushOutbox.discard(outboxPaths)
		return rollBackPublishedPush(enforceCtx, gitDir, beforeRefs, afterRefs, fmt.Errorf("import git refs after receive-pack: %w", err))
	}
	// Releasing the lock exports the import, so the clones CI starts right
	// after a push wait for one export instead of each running one.

	if len(outboxPaths) > 0 {
		s.background.Add(1)
		go func(paths []string) {
			defer s.background.Done()
			s.pushOutbox.deliverPaths(context.Background(), paths)
		}(outboxPaths)
	}

	w.Header().Set("Content-Type", "application/x-git-receive-pack-result")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
	return nil
}

func (s *Server) uploadPack(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("ProxyUploadPack")
	defer done()

	owner := chi.URLParam(r, "owner")
	repo := chi.URLParam(r, "repo")
	if err := validateOwnerRepo(owner, repo); err != nil {
		return err
	}

	repoPath := s.config.RepoPath(owner, repo)
	gitDir := s.config.GitBackendPath(owner, repo)

	if err := s.syncGitRefs(r.Context(), repoPath, gitDir); err != nil {
		return err
	}

	unlockRead, err := s.locks.RLock(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlockRead()

	if _, err := os.Stat(gitDir); err != nil {
		return notFound("repository not found")
	}

	requestBody, err := gitRequestBody(r)
	if err != nil {
		return err
	}

	// Arm idle read/write deadlines while the RPC streams: a caller that
	// stalls sending the negotiation or stops draining the packfile must not
	// hold the repository read lock and a git subprocess indefinitely. Both
	// deadlines are cleared afterwards so they cannot leak into connection
	// reuse.
	rc := http.NewResponseController(w)
	defer func() {
		_ = rc.SetReadDeadline(time.Time{})
		_ = rc.SetWriteDeadline(time.Time{})
	}()

	// Stream the upload-pack response directly to the client so that large
	// packfiles are never accumulated in memory. Once headers are committed
	// we cannot send an HTTP error status, so mid-stream failures are logged
	// server-side only — the broken stream will cause the git client to fail.
	w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
	w.WriteHeader(http.StatusOK)
	if err := streamGitRPCCapped(r.Context(), gitDir, "upload-pack", &idleDeadlineBody{rc: rc, r: requestBody}, &idleDeadlineWriter{rc: rc, w: w}, maxDecompressedGitRequestSize, refViewer(r)); err != nil {
		if s.logger != nil {
			s.logger.Error("upload-pack stream failed after headers committed",
				"owner", owner, "repo", repo, "error", err)
		}
		// Do not write to w: headers are already committed. The git client will
		// detect the truncated response as a protocol error.
	}
	return nil
}

func (s *Server) initWikiRepo(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("InitWikiRepo")
	defer done()

	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	wikiRepoPath := s.config.WikiRepoPath(owner, repo)
	unlock, err := s.locks.Lock(r.Context(), wikiRepoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer s.markMaintenanceDue(wikiRepoPath)
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	created, err := s.ffi.InitWikiRepo(wikiRepoPath)
	if err != nil {
		return err
	}
	if err := disableAutoMaintenance(context.WithoutCancel(r.Context()), repoGitDir(wikiRepoPath)); err != nil {
		return internalError("failed to configure repository", err)
	}
	if created {
		return writeJSON(w, http.StatusCreated, map[string]bool{"created": true})
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) initDocsRepo(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("InitDocsRepo")
	defer done()

	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	docsRepoPath := s.config.DocsRepoPath(owner, repo)
	unlock, err := s.locks.Lock(r.Context(), docsRepoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer s.markMaintenanceDue(docsRepoPath)
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	created, err := s.ffi.InitDocsRepo(docsRepoPath)
	if err != nil {
		return err
	}
	if err := disableAutoMaintenance(context.WithoutCancel(r.Context()), repoGitDir(docsRepoPath)); err != nil {
		return internalError("failed to configure repository", err)
	}
	if created {
		return writeJSON(w, http.StatusCreated, map[string]bool{"created": true})
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) commitWikiPage(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("CommitWikiPage")
	defer done()

	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	var req wikiCommitRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}

	wikiRepoPath := s.config.WikiRepoPath(owner, repo)
	unlock, err := s.locks.Lock(r.Context(), wikiRepoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer s.markMaintenanceDue(wikiRepoPath)
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	commitSHA, err := s.ffi.CommitWikiPage(
		wikiRepoPath,
		chi.URLParam(r, "page_name"),
		req.Content,
		req.AuthorName,
		req.AuthorEmail,
		req.Message,
	)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, wikiCommitResponse{CommitSHA: commitSHA})
}

func (s *Server) commitDoc(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("CommitDoc")
	defer done()

	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	var req wikiCommitRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}

	filePath := strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	if err := validateFileSubpath(filePath); err != nil {
		return err
	}

	docsRepoPath := s.config.DocsRepoPath(owner, repo)
	unlock, err := s.locks.Lock(r.Context(), docsRepoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer s.markMaintenanceDue(docsRepoPath)
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	commitSHA, err := s.ffi.CommitDoc(
		docsRepoPath,
		filePath,
		req.Content,
		req.AuthorName,
		req.AuthorEmail,
		req.Message,
	)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, wikiCommitResponse{CommitSHA: commitSHA})
}

func (s *Server) getWikiPageContent(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("GetWikiPageContent")
	defer done()

	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	wikiRepoPath := s.config.WikiRepoPath(owner, repo)
	unlock, err := s.locks.RLock(r.Context(), wikiRepoPath)
	if err != nil {
		return err
	}
	defer unlock()

	content, commitSHA, err := s.ffi.GetWikiPageContent(
		wikiRepoPath,
		chi.URLParam(r, "page_name"),
		strings.TrimSpace(r.URL.Query().Get("commit_sha")),
	)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, wikiContentResponse{
		Content:   content,
		CommitSHA: commitSHA,
	})
}

func (s *Server) getDocContent(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("GetDocContent")
	defer done()

	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	filePath := strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	if err := validateFileSubpath(filePath); err != nil {
		return err
	}
	docsRepoPath := s.config.DocsRepoPath(owner, repo)
	unlock, err := s.locks.RLock(r.Context(), docsRepoPath)
	if err != nil {
		return err
	}
	defer unlock()

	content, commitSHA, err := s.ffi.GetDocContent(
		docsRepoPath,
		filePath,
		strings.TrimSpace(r.URL.Query().Get("commit_sha")),
	)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, wikiContentResponse{
		Content:   content,
		CommitSHA: commitSHA,
	})
}

func (s *Server) listWikiPageHistory(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("ListWikiPageHistory")
	defer done()

	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	limit := uint32(30)
	if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
		parsed, err := strconv.ParseUint(rawLimit, 10, 32)
		if err != nil {
			return badRequest("limit must be a positive integer")
		}
		limit = uint32(parsed)
	}

	wikiRepoPath := s.config.WikiRepoPath(owner, repo)
	unlock, err := s.locks.RLock(r.Context(), wikiRepoPath)
	if err != nil {
		return err
	}
	defer unlock()

	result, err := s.ffi.ListWikiPageHistory(wikiRepoPath, chi.URLParam(r, "page_name"), limit)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) listDocHistory(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("ListDocHistory")
	defer done()

	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	limit := uint32(30)
	if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
		parsed, err := strconv.ParseUint(rawLimit, 10, 32)
		if err != nil {
			return badRequest("limit must be a positive integer")
		}
		limit = uint32(parsed)
	}

	filePath := strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	if err := validateFileSubpath(filePath); err != nil {
		return err
	}

	docsRepoPath := s.config.DocsRepoPath(owner, repo)
	unlock, err := s.locks.RLock(r.Context(), docsRepoPath)
	if err != nil {
		return err
	}
	defer unlock()

	result, err := s.ffi.ListDocHistory(docsRepoPath, filePath, limit)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) deleteWikiPage(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("DeleteWikiPage")
	defer done()

	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	var req wikiDeleteRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}

	wikiRepoPath := s.config.WikiRepoPath(owner, repo)
	unlock, err := s.locks.Lock(r.Context(), wikiRepoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer s.markMaintenanceDue(wikiRepoPath)
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	if err := s.ffi.DeleteWikiPage(
		wikiRepoPath,
		chi.URLParam(r, "page_name"),
		req.AuthorName,
		req.AuthorEmail,
	); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) deleteDoc(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("DeleteDoc")
	defer done()

	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	var req wikiDeleteRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}

	filePath := strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	if err := validateFileSubpath(filePath); err != nil {
		return err
	}

	docsRepoPath := s.config.DocsRepoPath(owner, repo)
	unlock, err := s.locks.Lock(r.Context(), docsRepoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer s.markMaintenanceDue(docsRepoPath)
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	if err := s.ffi.DeleteDoc(docsRepoPath, filePath, req.AuthorName, req.AuthorEmail); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listBookmarks(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("ListBookmarks")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	page, err := parsePagination(r.URL.Query())
	if err != nil {
		return err
	}

	unlock, err := s.locks.RLock(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()

	result, err := s.ffi.ListBookmarks(repoPath, page.Page, page.PerPage)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

// getBookmark serves GET /repos/{id}/bookmarks/{name}: one bookmark by exact
// name, or 404. Product callers resolve refs (contents, landing, changesets)
// through this route; without it they received 405 and every repository
// contents read failed with 500.
func (s *Server) getBookmark(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("GetBookmark")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	name := chi.URLParam(r, "name")
	// chi matches RawPath when the request carries escapes such as %2F in
	// "feature%2Fx" and then leaves the parameter escaped.
	if r.URL.RawPath != "" {
		if name, err = url.PathUnescape(name); err != nil {
			return badRequest("bookmark name must be url-encoded")
		}
	}
	if strings.TrimSpace(name) == "" {
		return badRequest("bookmark name is required")
	}

	unlock, err := s.locks.RLock(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()

	bookmark, found, err := s.findBookmark(repoPath, name)
	if err != nil {
		return err
	}
	if !found {
		return notFound("bookmark not found")
	}
	return writeJSON(w, http.StatusOK, bookmark)
}

// bookmarkLookupPageSize and bookmarkLookupMaxPages bound an in-process
// bookmark lookup over the paginated native listing.
const (
	bookmarkLookupPageSize = 100
	bookmarkLookupMaxPages = 1000
)

// findBookmark returns the bookmark with the exact name. The caller holds the
// repository lock, so the listing cannot change between pages.
func (s *Server) findBookmark(repoPath, name string) (repohost.Bookmark, bool, error) {
	for page := uint32(1); page <= bookmarkLookupMaxPages; page++ {
		bookmarks, err := s.ffi.ListBookmarks(repoPath, page, bookmarkLookupPageSize)
		if err != nil {
			return repohost.Bookmark{}, false, err
		}
		for _, bookmark := range bookmarks.Items {
			if bookmark.Name == name {
				return bookmark, true, nil
			}
		}
		if len(bookmarks.Items) == 0 || int(page)*bookmarkLookupPageSize >= bookmarks.TotalCount {
			return repohost.Bookmark{}, false, nil
		}
	}
	return repohost.Bookmark{}, false, internalError("bookmark listing exceeds lookup bound", nil)
}

func (s *Server) createBookmark(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("CreateBookmark")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}

	var req repohost.CreateBookmarkRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	req.Name = strings.TrimSpace(req.Name)
	// jj accepts any bookmark name, but every bookmark must export as a git
	// branch — a git-invalid name would be committed to jj and then silently
	// fail to export, so reject it before it enters the repo.
	if err := repohost.ValidateBookmarkName(req.Name); err != nil {
		return badRequest("invalid bookmark name: " + err.Error())
	}

	unlock, err := s.lockRepo(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}
	if req.ExpectedCommitID != nil {
		bookmark, _, err := s.findBookmark(repoPath, req.Name)
		if err != nil {
			return err
		}
		if bookmark.TargetCommitID != *req.ExpectedCommitID {
			return conflict("bookmark changed since the operation began")
		}
	}
	if req.Delete {
		if req.ExpectedCommitID == nil {
			return badRequest("conditional deletion requires expected_commit_id")
		}
		if err := s.ffi.DeleteBookmark(repoPath, req.Name); err != nil {
			return err
		}
		return writeJSON(w, http.StatusOK, repohost.Bookmark{Name: req.Name})
	}
	if err := s.refuseCaseVariantBookmark(r.Context(), chi.URLParam(r, "id"), req.Name); err != nil {
		return err
	}
	if req.IfAbsent {
		result, err := s.ffi.CreateBookmarkIfAbsent(repoPath, req.Name, req.TargetChangeID)
		if err != nil {
			return err
		}
		return writeJSON(w, http.StatusCreated, result)
	}

	result, err := s.ffi.CreateBookmark(repoPath, req.Name, req.TargetChangeID)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, result)
}

func (s *Server) setDefaultBookmark(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("SetDefaultBookmark")
	defer done()

	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	var req setDefaultBookmarkRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	req.Name = strings.TrimSpace(req.Name)
	if err := repohost.ValidateBookmarkName(req.Name); err != nil {
		return badRequest("invalid default bookmark name: " + err.Error())
	}

	repoPath := s.config.RepoPath(owner, repo)
	gitDir := s.config.GitBackendPath(owner, repo)
	unlock, err := s.lockRepo(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}
	if _, err := os.Stat(gitDir); err != nil {
		if os.IsNotExist(err) {
			return notFound("repository not found")
		}
		return internalError("failed to inspect repository", err)
	}
	if err := s.refuseCaseVariantBookmark(r.Context(), chi.URLParam(r, "id"), req.Name); err != nil {
		return err
	}
	if err := setGitDefaultBookmark(r.Context(), gitDir, req.Name); err != nil {
		return internalError("failed to set default bookmark", err)
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) deleteBookmark(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("DeleteBookmark")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}

	unlock, err := s.lockRepo(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	if err := s.ffi.DeleteBookmark(repoPath, chi.URLParam(r, "name")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listChanges(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("ListChanges")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	page, err := parsePagination(r.URL.Query())
	if err != nil {
		return err
	}

	unlock, err := s.locks.RLock(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()

	result, err := s.ffi.ListChanges(repoPath, page.Page, page.PerPage)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) getChange(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("GetChange")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}

	unlock, err := s.locks.RLock(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()

	result, err := s.ffi.GetChange(repoPath, chi.URLParam(r, "change_id"))
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) backoutChange(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("BackoutChange")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	var req repohost.BackoutChangeRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	if strings.TrimSpace(req.Revision) == "" {
		return badRequest("revision is required")
	}
	if err := repohost.ValidateBookmarkName(req.TargetBookmark); err != nil {
		return badRequest("invalid target bookmark name: " + err.Error())
	}

	unlock, err := s.lockRepo(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}
	result, err := s.ffi.BackoutChange(
		repoPath,
		chi.URLParam(r, "change_id"),
		req.Revision,
		req.TargetBookmark,
		req.Base,
	)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, result)
}

func (s *Server) splitChange(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("SplitChange")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	var req repohost.SplitChangeRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	if len(req.Paths) == 0 {
		return badRequest("paths must not be empty")
	}
	for _, path := range req.Paths {
		if strings.TrimSpace(path) == "" {
			return badRequest("paths must not contain empty values")
		}
	}

	unlock, err := s.lockRepo(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}
	result, err := s.ffi.SplitChange(
		repoPath,
		chi.URLParam(r, "change_id"),
		req.Paths,
		req.Description,
	)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) getChangeDiff(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("GetChangeDiff")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}

	unlock, err := s.locks.RLock(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()

	fromCommitID := strings.TrimSpace(r.URL.Query().Get("from"))
	toCommitID := strings.TrimSpace(r.URL.Query().Get("to"))
	path := r.URL.Query().Get("path")
	var result repohost.ChangeDiff
	if fromCommitID == "" && toCommitID == "" && path == "" {
		result, err = s.ffi.GetDiff(repoPath, chi.URLParam(r, "change_id"))
	} else {
		if toCommitID == "" {
			return badRequest("to commit is required for a revision diff")
		}
		result, err = s.ffi.GetRevisionDiff(repoPath, fromCommitID, toCommitID, path)
	}
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) getChangeFiles(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("GetChangeFiles")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}

	unlock, err := s.locks.RLock(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()

	result, err := s.ffi.GetFiles(repoPath, chi.URLParam(r, "change_id"))
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) listFilesAtChange(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("ListFilesAtChange")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}

	unlock, err := s.locks.RLock(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	if r.URL.Query().Get("depth") == "1" {
		limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
		if err != nil || limit < 1 || limit > 1001 {
			return &repohostffi.Error{Code: "bad_request", Message: "directory page limit must be between 1 and 1001"}
		}
		result, err := s.ffi.ListDirectory(repoPath, chi.URLParam(r, "change_id"), r.URL.Query().Get("prefix"), r.URL.Query().Get("after"), uint32(limit))
		if err != nil {
			return err
		}
		return writeJSON(w, http.StatusOK, result)
	}

	result, err := s.ffi.ListTreeFiles(repoPath, chi.URLParam(r, "change_id"), strings.TrimSpace(r.URL.Query().Get("prefix")))
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) getChangeConflicts(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("GetChangeConflicts")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}

	unlock, err := s.locks.RLock(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()

	result, err := s.ffi.GetConflicts(repoPath, chi.URLParam(r, "change_id"))
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) getFileAtChange(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("GetFileAtChange")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}

	filePath := strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	if err := validateFileSubpath(filePath); err != nil {
		return err
	}

	unlock, err := s.locks.RLock(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()

	result, err := s.ffi.GetFileContent(repoPath, chi.URLParam(r, "change_id"), filePath)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

// composeSuperproject writes one organization-superproject commit: a gitlink
// per member plus a generated .gitmodules. It never moves a bookmark; the
// changeset lands through the ordinary /land path.
func (s *Server) composeSuperproject(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("ComposeSuperproject")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}

	var req repohost.ComposeSuperprojectRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	if len(req.Members) == 0 {
		return badRequest("members is required")
	}
	if bookmark := strings.TrimSpace(req.Bookmark); bookmark != "" {
		if err := repohost.ValidateBookmarkName(bookmark); err != nil {
			return badRequest("invalid bookmark name: " + err.Error())
		}
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return badRequest("invalid superproject request")
	}

	unlock, err := s.lockRepo(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	result, err := s.ffi.ComposeSuperproject(repoPath, string(payload))
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) getSuperproject(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("GetSuperproject")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}

	unlock, err := s.locks.RLock(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()

	result, err := s.ffi.ReadSuperproject(repoPath, chi.URLParam(r, "revision"))
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) landAppend(w http.ResponseWriter, r *http.Request) error {
	return s.land(w, r, true)
}

func (s *Server) landChanges(w http.ResponseWriter, r *http.Request) error {
	return s.land(w, r, false)
}

func (s *Server) land(w http.ResponseWriter, r *http.Request, appendOnly bool) error {
	done := s.metrics.StartOperation("LandChanges")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}

	var req repohost.LandRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	if (req.Append != nil) != appendOnly {
		return badRequest("append requires the dedicated /land/append route")
	}
	if len(req.ChangeIDs) == 0 {
		return badRequest("change_ids is required")
	}
	if target := strings.TrimSpace(req.TargetBookmark); target != "" {
		// Landing can create the target bookmark, so it must be a valid git
		// branch name too. Empty targets are rejected by the FFI itself.
		if err := repohost.ValidateBookmarkName(target); err != nil {
			return badRequest("invalid target bookmark name: " + err.Error())
		}
	}

	unlock, err := s.lockRepo(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	if target := strings.TrimSpace(req.TargetBookmark); target != "" && !req.LookupOnly {
		if err := s.refuseCaseVariantBookmark(r.Context(), chi.URLParam(r, "id"), target); err != nil {
			return err
		}
	}

	// One jj transaction publishes the complete stack, including its receipt.
	// The FFI validates every member before it changes the bookmark.
	payload, err := json.Marshal(req)
	if err != nil {
		return err
	}
	// A land moves the target bookmark; releasing the lock exports it.
	result, err := s.ffi.LandChanges(repoPath, string(payload))
	if err != nil {
		if appendOnly && req.LookupOnly {
			if ffiErr, ok := err.(*repohostffi.Error); ok && ffiErr.Code == "landing_receipt_missing" {
				return &appError{StatusCode: http.StatusNotFound, Code: "landing_receipt_missing", Message: ffiErr.Message}
			}
		}
		return err
	}

	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) listOperations(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("ListOperations")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	page, err := parsePagination(r.URL.Query())
	if err != nil {
		return err
	}

	unlock, err := s.locks.RLock(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()

	result, err := s.ffi.ListOperations(repoPath, page.Page, page.PerPage)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) getWorkingTreeStatus(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("GetWorkingTreeStatus")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}

	unlock, err := s.lockRepo(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()

	result, err := s.ffi.GetWorkingTreeStatus(repoPath)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) createSnapshot(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("CreateSnapshot")
	defer done()

	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}

	var req repohost.SnapshotRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}

	unlock, err := s.lockRepo(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	result, err := s.ffi.CreateSnapshot(repoPath, req.ChangeID)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) repoPathFromID(repoID string) (string, error) {
	owner, repo, err := parseRepoID(repoID)
	if err != nil {
		return "", err
	}
	return s.config.RepoPath(owner, repo), nil
}

func decodeRequest(r *http.Request, out any) error {
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(out); err != nil {
		return badRequest("invalid JSON")
	}
	// Exactly one JSON value: a second value or trailing bytes would let
	// proxies, signers, and this server read the same body differently.
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return badRequest("invalid JSON")
	}
	return nil
}

func parsePagination(values url.Values) (pagination, error) {
	page := uint32(1)
	perPage := uint32(30)

	if rawPage := strings.TrimSpace(values.Get("page")); rawPage != "" {
		parsed, err := strconv.ParseUint(rawPage, 10, 32)
		if err != nil {
			return pagination{}, badRequest("page must be a positive integer")
		}
		page = uint32(parsed)
	}

	rawPerPage := strings.TrimSpace(values.Get("per_page"))
	if rawPerPage == "" {
		rawPerPage = strings.TrimSpace(values.Get("limit"))
	}
	if rawPerPage != "" {
		parsed, err := strconv.ParseUint(rawPerPage, 10, 32)
		if err != nil {
			return pagination{}, badRequest("per_page must be a positive integer")
		}
		perPage = uint32(parsed)
	}

	if page == 0 {
		return pagination{}, badRequest("page must be at least 1")
	}
	if perPage == 0 {
		return pagination{}, badRequest("per_page must be at least 1")
	}
	if perPage > 100 {
		return pagination{}, badRequest("per_page must not exceed 100")
	}
	return pagination{Page: page, PerPage: perPage}, nil
}

func removeEmptyOwnerDir(path string) error {
	entries, err := os.ReadDir(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return internalError("internal server error", err)
	}
	if len(entries) != 0 {
		return nil
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return internalError("internal server error", err)
	}
	return nil
}

// readCloserWithBody re-attaches the original body's Close to the peeked,
// rebuilt receive-pack stream.
func readCloserWithBody(body io.Reader, closer io.Closer) io.ReadCloser {
	return struct {
		io.Reader
		io.Closer
	}{body, closer}
}
