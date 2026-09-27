package repohostserver

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
)

// Like deleteStagingDirName, this contains a character rejected for normal
// owner paths and stays on the repository filesystem. The directory stores
// only durable operation journals; repository data remains at source or
// destination and is moved with same-filesystem renames.
const moveStagingDirName = ".move-staging@"

const moveDecisionDirName = ".move-decisions@"

const moveStageMetadataFile = "metadata.json"

type stagedMoveMetadata struct {
	Token    string `json:"token"`
	SrcOwner string `json:"src_owner"`
	SrcRepo  string `json:"src_repo"`
	DstOwner string `json:"dst_owner"`
	DstRepo  string `json:"dst_repo"`
}

type stageMoveResponse struct {
	Token string `json:"token"`
}

type stagedMovePath struct {
	source      string
	destination string
}

type stagedMovePair struct {
	from string
	to   string
}

func (s *Server) moveDecisionRoot() string {
	return filepath.Join(s.config.StoragePath, moveDecisionDirName)
}

func (s *Server) stageMoveRepo(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("StageMoveRepo")
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
	token := strings.TrimSpace(req.Token)
	if !validDeleteStageToken(token) {
		return badRequest("invalid repository move stage token")
	}

	metadata := stagedMoveMetadata{
		Token:    token,
		SrcOwner: req.SrcOwner,
		SrcRepo:  req.SrcRepo,
		DstOwner: req.DstOwner,
		DstRepo:  req.DstRepo,
	}
	stageDir := s.moveStageDir(token)
	paths := s.stagedMovePaths(metadata)
	unlockStage, err := s.locks.Lock(r.Context(), stageDir)
	if err != nil {
		return err
	}
	defer unlockStage()
	if _, decided, err := readTerminalStageDecision(s.moveDecisionRoot(), token); err != nil {
		return internalError("failed to read repository move completion decision", err)
	} else if decided {
		return conflict("repository move stage token is already completed")
	}
	unlockPaths, err := s.locks.LockAll(r.Context(), stagedMoveLockKeys(paths)...)
	if err != nil {
		return err
	}
	defer unlockPaths()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}

	if err := ensureDurableDirectory(filepath.Dir(stageDir), 0o700); err != nil {
		return internalError("failed to create repository move staging root", err)
	}
	stageExists, err := pathExists(stageDir)
	if err != nil {
		return internalError("failed to inspect repository move stage", err)
	}
	cleanupStage := false
	defer func() {
		if cleanupStage {
			if cleanupErr := durableRemoveAll(stageDir); cleanupErr != nil {
				slog.Error("failed to clean unused repository move stage", "error", cleanupErr)
			}
		}
	}()
	if stageExists {
		existing, exists, err := readStagedMoveMetadata(stageDir, token)
		if err != nil {
			return internalError("failed to read repository move stage", err)
		}
		if !exists {
			return conflict("repository move stage already exists without metadata")
		}
		if existing != metadata {
			return conflict("repository move stage token is already in use")
		}
		encoded, encodeErr := json.Marshal(existing)
		if encodeErr != nil {
			return internalError("failed to encode repository move stage", encodeErr)
		}
		if _, err := writeDurableJournal(stageDir, moveStageMetadataFile, encoded, 0o600); err != nil {
			return internalError("failed to settle repository move stage journal", err)
		}
	} else {
		if err := validateFreshStagedMove(paths); err != nil {
			return err
		}
		// The journal must never become durable before its destination owner
		// directory. Otherwise a crash in that window leaves rollback unable to
		// fsync the absent rename parent.
		if err := ensureDurableDirectory(filepath.Dir(paths[0].destination), 0o755); err != nil {
			return internalError("failed to create repository move destination", err)
		}
		// Until metadata is atomically installed, this directory contains no
		// recovery state and can be removed on any failure.
		cleanupStage = true
		if err := ensureDurableDirectory(stageDir, 0o700); err != nil {
			return internalError("failed to create repository move stage", err)
		}
		encoded, err := json.Marshal(metadata)
		if err != nil {
			return internalError("failed to encode repository move stage", err)
		}
		journalInstalled, err := writeDurableJournal(stageDir, moveStageMetadataFile, encoded, 0o600)
		if journalInstalled {
			// Even if the directory sync reported an error, the metadata rename
			// may be visible after a crash. Never erase that recovery record.
			cleanupStage = false
		}
		if err != nil {
			return internalError("failed to persist repository move stage", err)
		}
		// Once the journal is durable, every error is recoverable through the
		// client-owned token and must leave the journal for rollback/retry.
		cleanupStage = false
	}

	if err := reconcileStagedMove(paths, true); err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, stageMoveResponse{Token: token})
}

func (s *Server) rollbackStagedMove(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("RollbackStagedMove")
	defer done()
	return s.completeStagedMove(w, r, false)
}

func (s *Server) finalizeStagedMove(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("FinalizeStagedMove")
	defer done()
	return s.completeStagedMove(w, r, true)
}

func (s *Server) completeStagedMove(w http.ResponseWriter, r *http.Request, finalize bool) error {
	token := chi.URLParam(r, "token")
	if !validDeleteStageToken(token) {
		return badRequest("invalid repository move stage token")
	}
	stageDir := s.moveStageDir(token)
	// Serialize by token before reading metadata. A rollback issued after a
	// lost stage response must wait for the in-flight stage handler.
	unlockStage, err := s.locks.Lock(r.Context(), stageDir)
	if err != nil {
		return err
	}
	defer unlockStage()
	action := "rollback"
	if finalize {
		action = "finalize"
	}
	decision, decided, err := readTerminalStageDecision(s.moveDecisionRoot(), token)
	if err != nil {
		return internalError("failed to read repository move completion decision", err)
	}
	if decided && decision.Action != action {
		return conflict("repository move stage was already completed with a different action")
	}
	metadata, exists, err := readStagedMoveMetadata(stageDir, token)
	if err != nil {
		return internalError("failed to read repository move stage", err)
	}
	if !exists {
		if decided {
			w.WriteHeader(http.StatusNoContent)
			return nil
		}
		if err := checkMutationDeadline(r.Context()); err != nil {
			return err
		}
		if err := writeTerminalStageDecision(s.moveDecisionRoot(), token, action); err != nil {
			return internalError("failed to persist repository move completion decision", err)
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	paths := s.stagedMovePaths(metadata)
	unlockPaths, err := s.locks.LockAll(r.Context(), stagedMoveLockKeys(paths)...)
	if err != nil {
		return err
	}
	defer unlockPaths()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}
	// Recovery must also handle journals created by older servers before the
	// destination owner directory was durable.
	if err := ensureDurableDirectory(filepath.Dir(paths[0].destination), 0o755); err != nil {
		return internalError("failed to create repository move destination", err)
	}
	if !decided {
		if err := writeTerminalStageDecision(s.moveDecisionRoot(), token, action); err != nil {
			return internalError("failed to persist repository move completion decision", err)
		}
	}

	if err := reconcileStagedMove(paths, finalize); err != nil {
		return err
	}
	if err := durableRemoveAll(stageDir); err != nil {
		return internalError("failed to remove repository move stage", err)
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// validateFreshStagedMove distinguishes a new operation from recovery. Retry
// reconciliation may accept the primary repository already at destination,
// but a fresh token must never adopt and later roll back an unrelated
// destination repository.
func validateFreshStagedMove(paths []stagedMovePath) error {
	if len(paths) == 0 {
		return internalError("repository move stage has no paths", fmt.Errorf("empty move path set"))
	}
	for _, path := range paths {
		destinationExists, err := pathExists(path.destination)
		if err != nil {
			return internalError("failed to inspect repository move destination", err)
		}
		if destinationExists {
			return conflict("repository move destination already exists")
		}
	}
	sourceExists, err := pathExists(paths[0].source)
	if err != nil {
		return internalError("failed to inspect repository move source", err)
	}
	if !sourceExists {
		return notFound("source repository not found")
	}
	return nil
}

// reconcileStagedMove ensures all present repository components are at the
// destination (forward=true) or source (forward=false). It accepts components
// already at the desired side, so retries and recovery from a process stop
// between individual sidecar renames are idempotent.
func reconcileStagedMove(paths []stagedMovePath, forward bool) error {
	if len(paths) == 0 {
		return internalError("repository move stage has no paths", fmt.Errorf("empty move path set"))
	}
	pairs := make([]stagedMovePair, 0, len(paths))
	mainPresent := false
	for index, path := range paths {
		pair := stagedMovePair{from: path.source, to: path.destination}
		if !forward {
			pair = stagedMovePair{from: path.destination, to: path.source}
		}
		fromExists, err := pathExists(pair.from)
		if err != nil {
			return internalError("failed to inspect repository move source", err)
		}
		toExists, err := pathExists(pair.to)
		if err != nil {
			return internalError("failed to inspect repository move destination", err)
		}
		if fromExists && toExists {
			return conflict("repository move stage has storage at both namespaces")
		}
		if index == 0 {
			mainPresent = fromExists || toExists
		}
		pairs = append(pairs, pair)
	}
	if !mainPresent {
		return notFound("source repository not found")
	}
	if err := ensureDurableDirectory(filepath.Dir(pairs[0].to), 0o755); err != nil {
		return internalError("failed to create repository move destination", err)
	}

	moved := make([]stagedMovePair, 0, len(pairs))
	for _, pair := range pairs {
		fromExists, err := pathExists(pair.from)
		if err != nil {
			if rollbackErr := rollbackMovePairs(moved); rollbackErr != nil {
				slog.Error("failed to roll back partial staged repository move", "error", rollbackErr)
			}
			return internalError("failed to inspect repository move source", err)
		}
		if !fromExists {
			// A previous attempt may have completed os.Rename but failed one of
			// its directory fsyncs. Settle both namespace entries before a
			// completion path is allowed to remove the journal.
			if err := syncRenameParents(pair.from, pair.to); err != nil {
				if rollbackErr := rollbackMovePairs(moved); rollbackErr != nil {
					slog.Error("failed to roll back partial staged repository move", "error", rollbackErr)
				}
				return internalError("failed to persist repository move state", err)
			}
			continue
		}
		if err := durableRenamePath(pair.from, pair.to); err != nil {
			if rollbackErr := rollbackMovePairs(moved); rollbackErr != nil {
				slog.Error("failed to roll back partial staged repository move", "error", rollbackErr)
			}
			return internalError("failed to move repository", err)
		}
		moved = append(moved, pair)
	}
	return nil
}

func rollbackMovePairs(pairs []stagedMovePair) error {
	var rollbackErr error
	for index := len(pairs) - 1; index >= 0; index-- {
		if err := durableRenamePath(pairs[index].to, pairs[index].from); err != nil {
			rollbackErr = fmt.Errorf("restore %s: %w", pairs[index].from, err)
		}
	}
	return rollbackErr
}

func (s *Server) moveStageDir(token string) string {
	return filepath.Join(s.config.StoragePath, moveStagingDirName, token)
}

func (s *Server) stagedMovePaths(metadata stagedMoveMetadata) []stagedMovePath {
	return []stagedMovePath{
		{source: s.config.RepoPath(metadata.SrcOwner, metadata.SrcRepo), destination: s.config.RepoPath(metadata.DstOwner, metadata.DstRepo)},
		{source: s.config.WikiRepoPath(metadata.SrcOwner, metadata.SrcRepo), destination: s.config.WikiRepoPath(metadata.DstOwner, metadata.DstRepo)},
		{source: s.config.DocsRepoPath(metadata.SrcOwner, metadata.SrcRepo), destination: s.config.DocsRepoPath(metadata.DstOwner, metadata.DstRepo)},
	}
}

func stagedMoveLockKeys(paths []stagedMovePath) []string {
	keys := make([]string, 0, len(paths)*2)
	for _, path := range paths {
		keys = append(keys, path.source, path.destination)
	}
	return keys
}

func readStagedMoveMetadata(stageDir, expectedToken string) (stagedMoveMetadata, bool, error) {
	data, err := os.ReadFile(filepath.Join(stageDir, moveStageMetadataFile))
	if err != nil {
		if os.IsNotExist(err) {
			return stagedMoveMetadata{}, false, nil
		}
		return stagedMoveMetadata{}, false, err
	}
	var metadata stagedMoveMetadata
	if err := json.Unmarshal(data, &metadata); err != nil {
		return stagedMoveMetadata{}, false, err
	}
	if err := validateOwnerRepo(metadata.SrcOwner, metadata.SrcRepo); err != nil {
		return stagedMoveMetadata{}, false, fmt.Errorf("invalid staged move source metadata: %w", err)
	}
	if err := validateOwnerRepo(metadata.DstOwner, metadata.DstRepo); err != nil {
		return stagedMoveMetadata{}, false, fmt.Errorf("invalid staged move destination metadata: %w", err)
	}
	if metadata.Token != expectedToken || !validDeleteStageToken(metadata.Token) {
		return stagedMoveMetadata{}, false, fmt.Errorf("invalid staged move metadata token")
	}
	return metadata, true, nil
}
