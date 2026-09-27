package repohostserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// Provisioning is deliberately split into stage and publish. The API process
// persists the client-generated token and reserved database ID before stage is
// called; repo-host builds outside the live namespace, then publish performs a
// same-filesystem rename. The journal remains until PostgreSQL confirms that
// exact reserved row was inserted.
const (
	provisionStagingDirName = ".provision-staging@"
	provisionMetadataFile   = "metadata.json"
	provisionRepositoryDir  = "repository"

	provisionTypeInit   = "init"
	provisionTypeFork   = "fork"
	provisionTypeImport = "import"

	provisionPhaseReserved  = "reserved"
	provisionPhaseReady     = "ready"
	provisionPhasePublished = "published"

	provisionConflictDestinationOccupied = "destination_occupied"
)

type stageProvisionRequest struct {
	Token           string `json:"token"`
	OperationType   string `json:"operation_type"`
	Owner           string `json:"owner"`
	Repo            string `json:"repo"`
	DefaultBookmark string `json:"default_bookmark,omitempty"`
	AutoInit        bool   `json:"auto_init,omitempty"`
	SrcOwner        string `json:"src_owner,omitempty"`
	SrcRepo         string `json:"src_repo,omitempty"`
}

type stageProvisionResponse struct {
	Token string `json:"token"`
	Phase string `json:"phase"`
}

type stagedProvisionMetadata struct {
	Token           string `json:"token"`
	OperationType   string `json:"operation_type"`
	Owner           string `json:"owner"`
	Repo            string `json:"repo"`
	DefaultBookmark string `json:"default_bookmark,omitempty"`
	AutoInit        bool   `json:"auto_init,omitempty"`
	SrcOwner        string `json:"src_owner,omitempty"`
	SrcRepo         string `json:"src_repo,omitempty"`
	Phase           string `json:"phase"`
}

func (m stagedProvisionMetadata) sameOperation(other stagedProvisionMetadata) bool {
	m.Phase = ""
	other.Phase = ""
	return m == other
}

func (s *Server) stageProvisionRepo(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("StageProvisionRepo")
	defer done()

	var req stageProvisionRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	metadata, err := validateStageProvisionRequest(req)
	if err != nil {
		return err
	}
	stageDir := s.provisionStageDir(metadata.Token)
	stagedPath := filepath.Join(stageDir, provisionRepositoryDir)
	livePath := s.config.RepoPath(metadata.Owner, metadata.Repo)
	if err := s.validateProvisionPaths(stageDir, stagedPath, livePath); err != nil {
		return err
	}
	lockKeys := []string{stagedPath, livePath}
	if metadata.OperationType == provisionTypeFork {
		sourcePath := s.config.RepoPath(metadata.SrcOwner, metadata.SrcRepo)
		if err := s.validateProvisionPaths(sourcePath); err != nil {
			return err
		}
		lockKeys = append(lockKeys, sourcePath)
	}
	// Every provision endpoint takes the token lock first, then the same sorted
	// path-lock set. Mixing LockAll(stage,path) with stage-then-path permits an
	// ABBA deadlock for destinations that sort before the staging root.
	unlockStage := s.locks.Lock(stageDir)
	defer unlockStage()
	unlockPaths := s.locks.LockAll(lockKeys...)
	defer unlockPaths()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	if err := ensureDurableDirectory(filepath.Dir(stageDir), 0o700); err != nil {
		return internalError("failed to create repository provisioning root", err)
	}
	existing, exists, err := readStagedProvisionMetadata(stageDir, metadata.Token)
	if err != nil {
		return internalError("failed to read repository provisioning journal", err)
	}
	if exists {
		if !existing.sameOperation(metadata) {
			return conflict("repository provisioning token is already in use")
		}
		metadata = existing
		// Retry the atomic journal write even when the existing bytes decode:
		// the prior rename may have become visible before its directory fsync
		// failed or its response was lost.
		if err := writeStagedProvisionMetadata(stageDir, metadata); err != nil {
			return internalError("failed to settle repository provisioning journal", err)
		}
	} else {
		if err := ensureDurableDirectory(stageDir, 0o700); err != nil {
			return internalError("failed to create repository provisioning stage", err)
		}
		if err := writeStagedProvisionMetadata(stageDir, metadata); err != nil {
			return internalError("failed to persist repository provisioning journal", err)
		}
	}

	switch metadata.Phase {
	case provisionPhasePublished:
		if err := verifyPublishedProvision(stagedPath, livePath); err != nil {
			return err
		}
		if err := syncRenameParents(stagedPath, livePath); err != nil {
			return internalError("failed to settle published repository", err)
		}
		if err := writeStagedProvisionMetadata(stageDir, metadata); err != nil {
			return internalError("failed to settle published repository journal", err)
		}
		return writeJSON(w, http.StatusCreated, stageProvisionResponse{Token: metadata.Token, Phase: metadata.Phase})
	case provisionPhaseReady:
		// A ready stage is immutable. Reusing it is the lost-response path; the
		// caller separately chooses when to publish.
		stagedExists, inspectErr := pathExists(stagedPath)
		if inspectErr != nil {
			return internalError("failed to inspect staged repository", inspectErr)
		}
		if !stagedExists {
			liveExists, liveErr := pathExists(livePath)
			if liveErr != nil {
				return internalError("failed to inspect live repository", liveErr)
			}
			if !liveExists {
				return conflict("repository provisioning stage is missing")
			}
			// Rename happened and its response/phase update was lost. Publish will
			// settle the parent directories and advance the journal.
		}
		if stagedExists {
			if err := syncProvisionTree(stagedPath); err != nil {
				return internalError("failed to settle staged repository", err)
			}
		}
		if err := writeStagedProvisionMetadata(stageDir, metadata); err != nil {
			return internalError("failed to settle ready repository journal", err)
		}
		return writeJSON(w, http.StatusCreated, stageProvisionResponse{Token: metadata.Token, Phase: metadata.Phase})
	case provisionPhaseReserved:
	default:
		return conflict("repository provisioning journal has an invalid phase")
	}

	liveExists, err := pathExists(livePath)
	if err != nil {
		return internalError("failed to inspect repository destination", err)
	}
	if liveExists {
		return conflictCode(provisionConflictDestinationOccupied, "destination repository already exists")
	}
	// Reserved means no completed staged tree is owned by this token. A crash
	// while initializing/copying may leave a partial tree; erase only that
	// token-owned path and rebuild it from scratch.
	if err := durableRemoveAll(stagedPath); err != nil {
		return internalError("failed to reset partial repository provisioning stage", err)
	}

	switch metadata.OperationType {
	case provisionTypeInit, provisionTypeImport:
		if metadata.AutoInit {
			_, err = s.ffi.AutoInitRepo(stagedPath, metadata.DefaultBookmark, metadata.Repo)
		} else {
			_, err = s.ffi.InitRepo(stagedPath)
			if err == nil {
				err = setGitDefaultBookmark(r.Context(), filepath.Join(stagedPath, ".jj", "repo", "store", "git"), metadata.DefaultBookmark)
			}
		}
	case provisionTypeFork:
		sourcePath := s.config.RepoPath(metadata.SrcOwner, metadata.SrcRepo)
		if _, statErr := os.Stat(sourcePath); statErr != nil {
			if os.IsNotExist(statErr) {
				return notFound("source repository not found")
			}
			return internalError("failed to inspect source repository", statErr)
		}
		err = copyDir(sourcePath, stagedPath)
	}
	if err != nil {
		return internalError("failed to build staged repository", err)
	}
	if err := syncProvisionTree(stagedPath); err != nil {
		return internalError("failed to persist staged repository", err)
	}
	metadata.Phase = provisionPhaseReady
	if err := writeStagedProvisionMetadata(stageDir, metadata); err != nil {
		return internalError("failed to persist ready repository provisioning journal", err)
	}
	return writeJSON(w, http.StatusCreated, stageProvisionResponse{Token: metadata.Token, Phase: metadata.Phase})
}

func (s *Server) publishStagedProvision(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("PublishStagedProvision")
	defer done()
	return s.completeStagedProvision(w, r, "publish")
}

func (s *Server) finalizeStagedProvision(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("FinalizeStagedProvision")
	defer done()
	return s.completeStagedProvision(w, r, "finalize")
}

func (s *Server) abortStagedProvision(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("AbortStagedProvision")
	defer done()
	return s.completeStagedProvision(w, r, "abort")
}

func (s *Server) completeStagedProvision(w http.ResponseWriter, r *http.Request, action string) error {
	token := strings.TrimSpace(chi.URLParam(r, "token"))
	if !validDeleteStageToken(token) {
		return badRequest("invalid repository provisioning token")
	}
	stageDir := s.provisionStageDir(token)
	unlockStage := s.locks.Lock(stageDir)
	defer unlockStage()
	metadata, exists, err := readStagedProvisionMetadata(stageDir, token)
	if err != nil {
		return internalError("failed to read repository provisioning journal", err)
	}
	if !exists {
		if action == "publish" {
			return notFound("repository provisioning journal not found")
		}
		// A previous finalize/abort may have removed stageDir successfully and
		// then failed while syncing its parent. Retry that durability barrier
		// before allowing the control plane to discard the operation record.
		if err := settleMissingProvisionJournal(stageDir); err != nil {
			return internalError("failed to settle removed repository provisioning stage", err)
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	stagedPath := filepath.Join(stageDir, provisionRepositoryDir)
	livePath := s.config.RepoPath(metadata.Owner, metadata.Repo)
	if err := s.validateProvisionPaths(stageDir, stagedPath, livePath); err != nil {
		return err
	}
	unlockPaths := s.locks.LockAll(stagedPath, livePath)
	defer unlockPaths()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	switch action {
	case "publish":
		if metadata.Phase == provisionPhasePublished {
			if err := verifyPublishedProvision(stagedPath, livePath); err != nil {
				return err
			}
			if err := syncRenameParents(stagedPath, livePath); err != nil {
				return internalError("failed to settle published repository", err)
			}
			if err := writeStagedProvisionMetadata(stageDir, metadata); err != nil {
				return internalError("failed to settle published repository journal", err)
			}
			w.WriteHeader(http.StatusNoContent)
			return nil
		}
		if metadata.Phase != provisionPhaseReady {
			return conflict("repository provisioning stage is not ready")
		}
		stagedExists, err := pathExists(stagedPath)
		if err != nil {
			return internalError("failed to inspect staged repository", err)
		}
		liveExists, err := pathExists(livePath)
		if err != nil {
			return internalError("failed to inspect live repository", err)
		}
		if stagedExists && liveExists {
			return conflictCode(provisionConflictDestinationOccupied, "repository provisioning destination is occupied")
		}
		if !stagedExists && !liveExists {
			return conflict("repository provisioning stage is missing")
		}
		if stagedExists {
			// Import stages are mutated by token-scoped receive-pack after their
			// initial creation. Re-sync the complete tree under the same path lock
			// immediately before rename so "published" never points at writes that
			// were only in the page cache when repo-host crashed.
			if err := syncProvisionTree(stagedPath); err != nil {
				return internalError("failed to seal staged repository", err)
			}
			if err := ensureDurableDirectory(filepath.Dir(livePath), 0o755); err != nil {
				return internalError("failed to create repository owner namespace", err)
			}
			if err := durableRenamePath(stagedPath, livePath); err != nil {
				return internalError("failed to publish staged repository", err)
			}
		} else if err := syncRenameParents(stagedPath, livePath); err != nil {
			return internalError("failed to settle published repository", err)
		}
		metadata.Phase = provisionPhasePublished
		if err := writeStagedProvisionMetadata(stageDir, metadata); err != nil {
			return internalError("failed to persist published repository journal", err)
		}
		w.WriteHeader(http.StatusNoContent)
		return nil

	case "finalize":
		if metadata.Phase != provisionPhasePublished {
			return conflict("cannot finalize an unpublished repository provisioning stage")
		}
		if err := verifyPublishedProvision(stagedPath, livePath); err != nil {
			return err
		}
		// One recursive durable removal is crash-idempotent. Removing metadata
		// first can strand an empty, unreadable stage if the process stops before
		// removing the directory.
		if err := durableRemoveAll(stageDir); err != nil {
			return internalError("failed to remove repository provisioning stage", err)
		}
		w.WriteHeader(http.StatusNoContent)
		return nil

	case "abort":
		stagedExists, err := pathExists(stagedPath)
		if err != nil {
			return internalError("failed to inspect staged repository", err)
		}
		liveExists, err := pathExists(livePath)
		if err != nil {
			return internalError("failed to inspect live repository", err)
		}
		if stagedExists && liveExists && metadata.Phase == provisionPhasePublished {
			return conflict("cannot safely abort repository storage present at both paths")
		}
		occupiedAlongsideStage := stagedExists && liveExists
		if (metadata.Phase == provisionPhaseReserved || occupiedAlongsideStage) && liveExists {
			// Reserved never proved a token-owned staged tree. The destination is
			// unrelated storage and must never be deleted. Ready+both similarly
			// proves the staged path is ours and the live path is an interloper.
		} else if liveExists {
			if err := durableRemoveAll(livePath); err != nil {
				return internalError("failed to abort published repository", err)
			}
		}
		if !liveExists && metadata.Phase != provisionPhaseReserved {
			// A prior attempt may have removed the live path and then failed its
			// parent fsync. Settle the nearest surviving directory before dropping
			// the only recovery journal.
			if err := syncExistingAncestor(filepath.Dir(livePath)); err != nil {
				return internalError("failed to settle aborted repository", err)
			}
		}
		if stagedExists {
			if err := durableRemoveAll(stagedPath); err != nil {
				return internalError("failed to abort staged repository", err)
			}
		}
		if err := durableRemoveAll(stageDir); err != nil {
			return internalError("failed to remove aborted repository provisioning stage", err)
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	default:
		return internalError("unknown repository provisioning action", fmt.Errorf("action %q", action))
	}
}

// lockStagedImportRepository resolves an unguessable provisioning token to its
// hidden repository while holding the exact token→path lock order used by
// publish/finalize. The returned release function must always be called.
func (s *Server) lockStagedImportRepository(r *http.Request) (string, string, func(), error) {
	token := strings.TrimSpace(chi.URLParam(r, "token"))
	if !validDeleteStageToken(token) {
		return "", "", nil, badRequest("invalid repository provisioning token")
	}
	stageDir := s.provisionStageDir(token)
	unlockStage := s.locks.Lock(stageDir)
	releaseStage := true
	defer func() {
		if releaseStage {
			unlockStage()
		}
	}()
	metadata, exists, err := readStagedProvisionMetadata(stageDir, token)
	if err != nil {
		return "", "", nil, internalError("failed to read repository provisioning journal", err)
	}
	if !exists {
		return "", "", nil, notFound("repository provisioning journal not found")
	}
	if metadata.OperationType != provisionTypeImport || metadata.Phase != provisionPhaseReady {
		return "", "", nil, conflict("repository provisioning stage does not accept git pushes")
	}
	stagedPath := filepath.Join(stageDir, provisionRepositoryDir)
	livePath := s.config.RepoPath(metadata.Owner, metadata.Repo)
	if err := s.validateProvisionPaths(stageDir, stagedPath, livePath); err != nil {
		return "", "", nil, err
	}
	unlockPaths := s.locks.LockAll(stagedPath, livePath)
	if err := checkMutationDeadline(r.Context()); err != nil {
		unlockPaths()
		return "", "", nil, err
	}
	stagedExists, err := pathExists(stagedPath)
	if err != nil {
		unlockPaths()
		return "", "", nil, internalError("failed to inspect staged repository", err)
	}
	liveExists, err := pathExists(livePath)
	if err != nil {
		unlockPaths()
		return "", "", nil, internalError("failed to inspect live repository", err)
	}
	if !stagedExists || liveExists {
		unlockPaths()
		return "", "", nil, conflict("repository provisioning stage is not hidden and writable")
	}
	releaseStage = false
	return stagedPath, filepath.Join(stagedPath, ".jj", "repo", "store", "git"), func() {
		unlockPaths()
		unlockStage()
	}, nil
}

func (s *Server) stagedProvisionInfoRefs(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("StagedProvisionInfoRefs")
	defer done()
	repoPath, gitDir, release, err := s.lockStagedImportRepository(r)
	if err != nil {
		return err
	}
	defer release()
	service := strings.TrimSpace(r.URL.Query().Get("service"))
	if service != "git-receive-pack" {
		return badRequest("unsupported staged git service")
	}
	if _, err := os.Stat(gitDir); err != nil {
		if os.IsNotExist(err) {
			return notFound("staged repository not found")
		}
		return internalError("failed to inspect staged git repository", err)
	}
	if err := s.ffi.ExportGitRefs(repoPath); err != nil {
		return err
	}
	cmdCtx, cancel := context.WithCancel(r.Context())
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, "git", "receive-pack", "--stateless-rpc", "--advertise-refs", gitDir)
	cmd.Env = gitServiceEnv("receive-pack", maxDecompressedGitRequestSize, 0)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return internalError("create staged git advertisement", err)
	}
	if err := cmd.Start(); err != nil {
		return internalError("start staged git advertisement", err)
	}
	refOutput, readErr := io.ReadAll(io.LimitReader(stdout, maxRefAdvertisementBytes+1))
	tooLarge := int64(len(refOutput)) > maxRefAdvertisementBytes
	if tooLarge {
		cancel()
	}
	_, _ = io.Copy(io.Discard, stdout)
	waitErr := cmd.Wait()
	if tooLarge {
		return internalError("ref advertisement exceeds maximum size", nil)
	}
	if readErr != nil {
		return internalError("read staged git advertisement", readErr)
	}
	if waitErr != nil {
		return internalError("staged git advertisement failed", fmt.Errorf("%w: %s", waitErr, strings.TrimSpace(stderr.String())))
	}
	serviceLine := "# service=git-receive-pack\n"
	prefix := fmt.Sprintf("%04x%s0000", len(serviceLine)+4, serviceLine)
	w.Header().Set("Content-Type", "application/x-git-receive-pack-advertisement")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, prefix)
	_, _ = w.Write(refOutput)
	return nil
}

func (s *Server) stagedProvisionReceivePack(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("StagedProvisionReceivePack")
	defer done()
	repoPath, gitDir, release, err := s.lockStagedImportRepository(r)
	if err != nil {
		return err
	}
	defer release()
	beforeRefs, err := listGitRefs(r.Context(), gitDir)
	if err != nil {
		return internalError("failed to snapshot staged refs before receive-pack", err)
	}
	requestBody, err := gitRequestBody(r)
	if err != nil {
		return err
	}
	rc := http.NewResponseController(w)
	defer func() { _ = rc.SetReadDeadline(time.Time{}) }()
	// An import mirrors a user-controlled source, so it gets the same
	// reserved-ref policy as any push with no workspace attribution:
	// refs/smithers/ is written only by the control plane.
	commands, peeked, peekErr := repohost.PeekReceivePackCommands(&idleDeadlineBody{rc: rc, r: requestBody})
	if peekErr != nil {
		return badRequest("malformed receive-pack command list")
	}
	if msg := repohost.ReservedRefViolation(commands, "", 0); msg != "" {
		return forbidden(msg)
	}
	body, gitErr := runGitRPCBuffered(r.Context(), gitDir, "receive-pack", readCloserWithBody(peeked, requestBody))
	reconcileCtx, cancelReconcile := detachedPushContext(r.Context())
	defer cancelReconcile()
	afterRefs, err := listGitRefs(reconcileCtx, gitDir)
	if err != nil {
		return rollBackUnlistablePush(reconcileCtx, gitDir, err, commands, beforeRefs)
	}
	if gitErr != nil {
		return rollBackPublishedPush(reconcileCtx, gitDir, beforeRefs, afterRefs, gitErr)
	}
	if err := s.ffi.ImportGitRefs(repoPath); err != nil {
		return rollBackPublishedPush(reconcileCtx, gitDir, beforeRefs, afterRefs,
			fmt.Errorf("import staged git refs after receive-pack: %w", err))
	}
	if err := syncProvisionTree(repoPath); err != nil {
		return internalError("failed to persist staged git push", err)
	}
	w.Header().Set("Content-Type", "application/x-git-receive-pack-result")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
	return nil
}

func syncExistingAncestor(path string) error {
	return syncExistingAncestorWithSync(path, syncDirectory)
}

func syncExistingAncestorWithSync(path string, syncDir syncDirectoryFunc) error {
	for {
		info, err := os.Stat(path)
		if err == nil {
			if !info.IsDir() {
				return fmt.Errorf("path %s is not a directory", path)
			}
			return syncDir(path)
		}
		if !os.IsNotExist(err) {
			return err
		}
		parent := filepath.Dir(path)
		if parent == path {
			return fmt.Errorf("no existing directory ancestor for %s", path)
		}
		path = parent
	}
}

func settleMissingProvisionJournalWithSync(stageDir string, syncDir syncDirectoryFunc) error {
	return syncExistingAncestorWithSync(filepath.Dir(stageDir), syncDir)
}

func settleMissingProvisionJournal(stageDir string) error {
	return settleMissingProvisionJournalWithSync(stageDir, syncDirectory)
}

func validateStageProvisionRequest(req stageProvisionRequest) (stagedProvisionMetadata, error) {
	token := strings.TrimSpace(req.Token)
	if !validDeleteStageToken(token) {
		return stagedProvisionMetadata{}, badRequest("invalid repository provisioning token")
	}
	if err := validateOwnerRepo(req.Owner, req.Repo); err != nil {
		return stagedProvisionMetadata{}, err
	}
	metadata := stagedProvisionMetadata{
		Token: token, OperationType: strings.TrimSpace(req.OperationType),
		Owner: req.Owner, Repo: req.Repo, AutoInit: req.AutoInit,
		DefaultBookmark: strings.TrimSpace(req.DefaultBookmark),
		SrcOwner:        req.SrcOwner, SrcRepo: req.SrcRepo, Phase: provisionPhaseReserved,
	}
	switch metadata.OperationType {
	case provisionTypeInit, provisionTypeImport:
		if metadata.SrcOwner != "" || metadata.SrcRepo != "" {
			return stagedProvisionMetadata{}, badRequest("init provisioning cannot specify a source repository")
		}
		if metadata.DefaultBookmark == "" {
			metadata.DefaultBookmark = "main"
		}
		if err := repohost.ValidateBookmarkName(metadata.DefaultBookmark); err != nil {
			return stagedProvisionMetadata{}, badRequest("invalid default bookmark name: " + err.Error())
		}
	case provisionTypeFork:
		if err := validateOwnerRepo(metadata.SrcOwner, metadata.SrcRepo); err != nil {
			return stagedProvisionMetadata{}, err
		}
		metadata.DefaultBookmark = ""
		metadata.AutoInit = false
	default:
		return stagedProvisionMetadata{}, badRequest("invalid repository provisioning operation")
	}
	return metadata, nil
}

func (s *Server) provisionStageDir(token string) string {
	return filepath.Join(s.config.StoragePath, provisionStagingDirName, token)
}

func readStagedProvisionMetadata(stageDir, expectedToken string) (stagedProvisionMetadata, bool, error) {
	contents, err := os.ReadFile(filepath.Join(stageDir, provisionMetadataFile))
	if os.IsNotExist(err) {
		return stagedProvisionMetadata{}, false, nil
	}
	if err != nil {
		return stagedProvisionMetadata{}, false, err
	}
	var metadata stagedProvisionMetadata
	if err := json.Unmarshal(contents, &metadata); err != nil {
		return stagedProvisionMetadata{}, false, err
	}
	if err := validatePersistedProvisionMetadata(expectedToken, metadata); err != nil {
		return stagedProvisionMetadata{}, false, err
	}
	return metadata, true, nil
}

func validatePersistedProvisionMetadata(expectedToken string, metadata stagedProvisionMetadata) error {
	if expectedToken == "" || metadata.Token != expectedToken {
		return fmt.Errorf("repository provisioning journal token mismatch")
	}
	switch metadata.Phase {
	case provisionPhaseReserved, provisionPhaseReady, provisionPhasePublished:
	default:
		return fmt.Errorf("invalid repository provisioning journal phase %q", metadata.Phase)
	}
	validated, err := validateStageProvisionRequest(stageProvisionRequest{
		Token: metadata.Token, OperationType: metadata.OperationType,
		Owner: metadata.Owner, Repo: metadata.Repo,
		DefaultBookmark: metadata.DefaultBookmark, AutoInit: metadata.AutoInit,
		SrcOwner: metadata.SrcOwner, SrcRepo: metadata.SrcRepo,
	})
	if err != nil {
		return fmt.Errorf("invalid repository provisioning journal: %w", err)
	}
	validated.Phase = metadata.Phase
	if validated != metadata {
		return fmt.Errorf("repository provisioning journal is not canonical")
	}
	return nil
}

func (s *Server) validateProvisionPaths(paths ...string) error {
	root, err := filepath.Abs(s.config.StoragePath)
	if err != nil {
		return internalError("failed to resolve repository storage root", err)
	}
	for _, candidate := range paths {
		absolute, err := filepath.Abs(candidate)
		if err != nil {
			return internalError("failed to resolve repository provisioning path", err)
		}
		relative, err := filepath.Rel(root, absolute)
		if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
			return conflict("repository provisioning path escapes storage root")
		}
	}
	return nil
}

func writeStagedProvisionMetadata(stageDir string, metadata stagedProvisionMetadata) error {
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = writeDurableJournal(stageDir, provisionMetadataFile, encoded, 0o600)
	return err
}

func verifyPublishedProvision(stagedPath, livePath string) error {
	stagedExists, err := pathExists(stagedPath)
	if err != nil {
		return internalError("failed to inspect staged repository", err)
	}
	liveExists, err := pathExists(livePath)
	if err != nil {
		return internalError("failed to inspect live repository", err)
	}
	if stagedExists || !liveExists {
		return conflict("published repository provisioning state is inconsistent")
	}
	return nil
}

// syncProvisionTree makes an FFI-created or recursively copied tree durable
// before the ready journal is written. Files are synced first, then
// directories deepest-first so every directory entry is persisted.
func syncProvisionTree(root string) error {
	directories := make([]string, 0, 16)
	if err := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.IsDir() {
			directories = append(directories, path)
			return nil
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		syncErr := file.Sync()
		closeErr := file.Close()
		if syncErr != nil {
			return syncErr
		}
		return closeErr
	}); err != nil {
		return err
	}
	sort.Slice(directories, func(i, j int) bool { return len(directories[i]) > len(directories[j]) })
	for _, directory := range directories {
		if err := syncDirectory(directory); err != nil {
			return err
		}
	}
	return nil
}
