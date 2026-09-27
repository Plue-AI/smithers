package repohostserver

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
)

// deleteStagingDirName contains a character rejected by validateOwnerRepo, so
// a user-controlled owner/repository path can never collide with tombstones.
// It remains under StoragePath so os.Rename stays on the same filesystem.
const deleteStagingDirName = ".delete-staging@"

// Completion decisions live outside the transient staging tree so the stage
// itself can still be removed while a durable token fence remains.
const deleteDecisionDirName = ".delete-decisions@"

const (
	deleteStageMetadataFile = "metadata.json"
	deleteStageRepoDir      = "repository"
	deleteStageWikiDir      = "wiki"
	deleteStageDocsDir      = "docs"
	deleteStageTokenBytes   = 32
)

type stageDeleteRequest struct {
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
	Token string `json:"token"`
}

type stageDeleteResponse struct {
	Token string `json:"token"`
}

type stagedDeleteMetadata struct {
	Token string `json:"token"`
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
}

type stagedDeletePath struct {
	live   string
	staged string
}

func (s *Server) deleteDecisionRoot() string {
	return filepath.Join(s.config.StoragePath, deleteDecisionDirName)
}

func (s *Server) stageDeleteRepo(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("StageDeleteRepo")
	defer done()

	var req stageDeleteRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	if err := validateOwnerRepo(req.Owner, req.Repo); err != nil {
		return err
	}

	token := strings.TrimSpace(req.Token)
	if !validDeleteStageToken(token) {
		return badRequest("invalid repository delete stage token")
	}
	stageDir := s.deleteStageDir(token)
	paths := s.deleteStagePaths(req.Owner, req.Repo, stageDir)
	unlockStage, err := s.locks.Lock(r.Context(), stageDir)
	if err != nil {
		return err
	}
	defer unlockStage()
	if _, decided, err := readTerminalStageDecision(s.deleteDecisionRoot(), token); err != nil {
		return internalError("failed to read repository delete completion decision", err)
	} else if decided {
		return conflict("repository delete stage token is already completed")
	}
	lockKeys := make([]string, 0, len(paths)*2)
	for _, path := range paths {
		lockKeys = append(lockKeys, path.live, path.staged)
	}
	unlock, err := s.locks.LockAll(r.Context(), lockKeys...)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	if err := ensureDurableDirectory(filepath.Dir(stageDir), 0o700); err != nil {
		return internalError("failed to create repository delete staging root", err)
	}
	stageExists, err := pathExists(stageDir)
	if err != nil {
		return internalError("failed to inspect repository delete stage", err)
	}
	cleanupStage := false
	defer func() {
		if cleanupStage {
			if cleanupErr := durableRemoveAll(stageDir); cleanupErr != nil {
				slog.Error("failed to clean unused repository delete stage", "error", cleanupErr)
			}
		}
	}()
	if stageExists {
		metadata, exists, err := readStagedDeleteMetadata(stageDir, token)
		if err != nil {
			return internalError("failed to read repository delete stage", err)
		}
		if !exists {
			return conflict("repository delete stage already exists without metadata")
		}
		if metadata.Owner != req.Owner || metadata.Repo != req.Repo {
			return conflict("repository delete stage token is already in use")
		}
		encoded, encodeErr := json.Marshal(metadata)
		if encodeErr != nil {
			return internalError("failed to encode repository delete stage", encodeErr)
		}
		if _, err := writeDurableJournal(stageDir, deleteStageMetadataFile, encoded, 0o600); err != nil {
			return internalError("failed to settle repository delete stage journal", err)
		}
	} else {
		// Until metadata is atomically installed, this directory contains no
		// recovery state and can be removed on any failure.
		cleanupStage = true
		if err := ensureDurableDirectory(stageDir, 0o700); err != nil {
			return internalError("failed to create repository delete stage", err)
		}
		metadata, err := json.Marshal(stagedDeleteMetadata{Token: token, Owner: req.Owner, Repo: req.Repo})
		if err != nil {
			return internalError("failed to encode repository delete stage", err)
		}
		journalInstalled, err := writeDurableJournal(stageDir, deleteStageMetadataFile, metadata, 0o600)
		if journalInstalled {
			// Even if the directory sync reported an error, the metadata rename
			// may be visible after a crash. Never erase that recovery record.
			cleanupStage = false
		}
		if err != nil {
			return internalError("failed to persist repository delete stage", err)
		}
		// Every later operation is recoverable through the client-owned token.
		cleanupStage = false
	}

	moved := make([]stagedDeletePath, 0, len(paths))
	for _, path := range paths {
		liveExists, err := pathExists(path.live)
		if err != nil {
			if restoreErr := restoreMovedStagePaths(moved); restoreErr != nil {
				slog.Error("failed to restore partial repository delete stage", "error", restoreErr)
				cleanupStage = false
			}
			return internalError("failed to inspect repository storage", err)
		}
		stagedExists, err := pathExists(path.staged)
		if err != nil {
			if restoreErr := restoreMovedStagePaths(moved); restoreErr != nil {
				slog.Error("failed to restore partial repository delete stage", "error", restoreErr)
				cleanupStage = false
			}
			return internalError("failed to inspect staged repository storage", err)
		}
		if stagedExists {
			if liveExists {
				return conflict("repository delete stage conflicts with live storage")
			}
			if err := syncRenameParents(path.live, path.staged); err != nil {
				return internalError("failed to persist staged repository state", err)
			}
			continue
		}
		if !liveExists {
			// No entry moved at either namespace, so there is no rename state to
			// persist (and the live owner directory may never have existed).
			continue
		}
		if err := durableRenamePath(path.live, path.staged); err != nil {
			if restoreErr := restoreMovedStagePaths(moved); restoreErr != nil {
				slog.Error("failed to restore partial repository delete stage", "error", restoreErr)
				cleanupStage = false
			}
			return internalError("failed to stage repository deletion", err)
		}
		moved = append(moved, path)
	}

	cleanupStage = false
	return writeJSON(w, http.StatusCreated, stageDeleteResponse{Token: token})
}

func (s *Server) restoreStagedDelete(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("RestoreStagedDelete")
	defer done()
	return s.completeStagedDelete(w, r, true)
}

func (s *Server) finalizeStagedDelete(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("FinalizeStagedDelete")
	defer done()
	return s.completeStagedDelete(w, r, false)
}

func (s *Server) completeStagedDelete(w http.ResponseWriter, r *http.Request, restore bool) error {
	token := chi.URLParam(r, "token")
	if !validDeleteStageToken(token) {
		return badRequest("invalid repository delete stage token")
	}
	stageDir := s.deleteStageDir(token)
	// Always lock the client-owned token before looking for metadata. If the
	// stage response is lost while the stage handler is still moving paths, a
	// compensating restore waits for that handler and cannot incorrectly return
	// 204 just before storage becomes tombstoned.
	unlockStage, err := s.locks.Lock(r.Context(), stageDir)
	if err != nil {
		return err
	}
	defer unlockStage()
	action := "finalize"
	if restore {
		action = "restore"
	}
	decision, decided, err := readTerminalStageDecision(s.deleteDecisionRoot(), token)
	if err != nil {
		return internalError("failed to read repository delete completion decision", err)
	}
	if decided && decision.Action != action {
		return conflict("repository delete stage was already completed with a different action")
	}
	metadata, exists, err := readStagedDeleteMetadata(stageDir, token)
	if err != nil {
		return internalError("failed to read repository delete stage", err)
	}
	if !exists {
		if decided {
			w.WriteHeader(http.StatusNoContent)
			return nil
		}
		if err := checkMutationDeadline(r.Context()); err != nil {
			return err
		}
		if err := writeTerminalStageDecision(s.deleteDecisionRoot(), token, action); err != nil {
			return internalError("failed to persist repository delete completion decision", err)
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	paths := s.deleteStagePaths(metadata.Owner, metadata.Repo, stageDir)
	lockKeys := make([]string, 0, len(paths)*2)
	for _, path := range paths {
		lockKeys = append(lockKeys, path.live, path.staged)
	}
	unlock, err := s.locks.LockAll(r.Context(), lockKeys...)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}
	if !decided {
		if err := writeTerminalStageDecision(s.deleteDecisionRoot(), token, action); err != nil {
			return internalError("failed to persist repository delete completion decision", err)
		}
	}

	if restore {
		if err := restoreDeleteStage(paths); err != nil {
			return err
		}
	} else if err := s.destroyDeleteStage(paths); err != nil {
		return err
	}

	if err := durableRemoveAll(stageDir); err != nil {
		return internalError("failed to remove repository delete stage", err)
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func restoreDeleteStage(paths []stagedDeletePath) error {
	hasStagedPath := false
	for _, path := range paths {
		stagedExists, err := pathExists(path.staged)
		if err != nil {
			return internalError("failed to inspect staged repository storage", err)
		}
		if !stagedExists {
			continue
		}
		hasStagedPath = true
		liveExists, err := pathExists(path.live)
		if err != nil {
			return internalError("failed to inspect live repository storage", err)
		}
		if liveExists {
			return conflict("live repository storage already exists")
		}
	}

	if hasStagedPath && len(paths) > 0 {
		if err := ensureDurableDirectory(filepath.Dir(paths[0].live), 0o755); err != nil {
			return internalError("failed to recreate repository owner directory", err)
		}
	}
	moved := make([]stagedDeletePath, 0, len(paths))
	for _, path := range paths {
		exists, err := pathExists(path.staged)
		if err != nil {
			if restageErr := restageRestoredPaths(moved); restageErr != nil {
				slog.Error("failed to roll back partial repository delete restore", "error", restageErr)
			}
			return internalError("failed to inspect staged repository storage", err)
		}
		if !exists {
			liveExists, liveErr := pathExists(path.live)
			if liveErr != nil {
				return internalError("failed to inspect restored repository storage", liveErr)
			}
			if liveExists {
				if err := syncRenameParents(path.staged, path.live); err != nil {
					if restageErr := restageRestoredPaths(moved); restageErr != nil {
						slog.Error("failed to roll back partial repository delete restore", "error", restageErr)
					}
					return internalError("failed to persist restored repository state", err)
				}
			}
			continue
		}
		if err := durableRenamePath(path.staged, path.live); err != nil {
			if restageErr := restageRestoredPaths(moved); restageErr != nil {
				slog.Error("failed to roll back partial repository delete restore", "error", restageErr)
			}
			return internalError("failed to restore staged repository", err)
		}
		moved = append(moved, path)
	}
	return nil
}

func (s *Server) destroyDeleteStage(paths []stagedDeletePath) error {
	if len(paths) == 0 {
		return nil
	}
	repoExists, err := pathExists(paths[0].staged)
	if err != nil {
		return internalError("failed to inspect staged repository", err)
	}
	if repoExists {
		if err := s.ffi.DeleteRepo(paths[0].staged); err != nil {
			return err
		}
		// FFI implementations promise to remove the repository after validating
		// it. Removing an unexpectedly retained path makes successful mocks and
		// alternate implementations uphold the same postcondition.
		if err := durableRemoveAll(paths[0].staged); err != nil {
			return internalError("failed to finalize staged repository", err)
		}
	}
	if err := syncExistingAncestor(filepath.Dir(paths[0].live)); err != nil {
		return internalError("failed to persist finalized repository state", err)
	}
	for _, path := range paths[1:] {
		if err := durableRemoveAll(path.staged); err != nil {
			return internalError("failed to finalize staged repository sidecar", err)
		}
		if err := syncExistingAncestor(filepath.Dir(path.live)); err != nil {
			return internalError("failed to persist finalized repository sidecar state", err)
		}
	}
	return nil
}

func (s *Server) deleteStageDir(token string) string {
	return filepath.Join(s.config.StoragePath, deleteStagingDirName, token)
}

func (s *Server) deleteStagePaths(owner, repo, stageDir string) []stagedDeletePath {
	return []stagedDeletePath{
		{live: s.config.RepoPath(owner, repo), staged: filepath.Join(stageDir, deleteStageRepoDir)},
		{live: s.config.WikiRepoPath(owner, repo), staged: filepath.Join(stageDir, deleteStageWikiDir)},
		{live: s.config.DocsRepoPath(owner, repo), staged: filepath.Join(stageDir, deleteStageDocsDir)},
	}
}

func readStagedDeleteMetadata(stageDir, expectedToken string) (stagedDeleteMetadata, bool, error) {
	data, err := os.ReadFile(filepath.Join(stageDir, deleteStageMetadataFile))
	if err != nil {
		if os.IsNotExist(err) {
			return stagedDeleteMetadata{}, false, nil
		}
		return stagedDeleteMetadata{}, false, err
	}
	var metadata stagedDeleteMetadata
	if err := json.Unmarshal(data, &metadata); err != nil {
		return stagedDeleteMetadata{}, false, err
	}
	if err := validateOwnerRepo(metadata.Owner, metadata.Repo); err != nil {
		return stagedDeleteMetadata{}, false, fmt.Errorf("invalid staged delete metadata: %w", err)
	}
	if metadata.Token != expectedToken || !validDeleteStageToken(metadata.Token) {
		return stagedDeleteMetadata{}, false, fmt.Errorf("invalid staged delete metadata token")
	}
	return metadata, true, nil
}

func validDeleteStageToken(token string) bool {
	if len(token) != deleteStageTokenBytes*2 || strings.ToLower(token) != token {
		return false
	}
	_, err := hex.DecodeString(token)
	return err == nil
}

func pathExists(path string) (bool, error) {
	_, err := os.Stat(path)
	if err == nil {
		return true, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	return false, err
}

func restoreMovedStagePaths(paths []stagedDeletePath) error {
	var restoreErr error
	for i := len(paths) - 1; i >= 0; i-- {
		if err := durableRenamePath(paths[i].staged, paths[i].live); err != nil {
			restoreErr = fmt.Errorf("restore %s: %w", paths[i].live, err)
		}
	}
	return restoreErr
}

func restageRestoredPaths(paths []stagedDeletePath) error {
	var restageErr error
	for i := len(paths) - 1; i >= 0; i-- {
		if err := durableRenamePath(paths[i].live, paths[i].staged); err != nil {
			restageErr = fmt.Errorf("restage %s: %w", paths[i].live, err)
		}
	}
	return restageErr
}
