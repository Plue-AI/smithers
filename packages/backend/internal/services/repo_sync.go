package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"

	"github.com/smithersai/smithers/packages/backend/hostexec"
)

const defaultRepoSyncRoot = "./data/repo-sync"

type RepoSyncBookmark struct {
	Name           string `json:"name"`
	TargetChangeID string `json:"target_change_id,omitempty"`
	TargetCommitID string `json:"target_commit_id,omitempty"`
}

type RepoSyncWorkingCopyParent struct {
	ChangeID string `json:"change_id,omitempty"`
	CommitID string `json:"commit_id,omitempty"`
}

type RepoSyncRequest struct {
	Bookmarks         []RepoSyncBookmark        `json:"bookmarks"`
	WorkingCopyParent RepoSyncWorkingCopyParent `json:"working_copy_parent"`
}

type repoSyncMetadata struct {
	Bookmarks         []RepoSyncBookmark        `json:"bookmarks"`
	Owner             string                    `json:"owner"`
	Repo              string                    `json:"repo"`
	SyncedAt          time.Time                 `json:"synced_at"`
	UserID            int64                     `json:"user_id"`
	WorkingCopyParent RepoSyncWorkingCopyParent `json:"working_copy_parent"`
}

type RepoSyncService struct {
	connectionChecker RepoSyncConnectionChecker
	now               func() time.Time
	root              string
	runGit            func(ctx context.Context, args ...string) error
}

type RepoSyncConnectionChecker interface {
	GetRepoConnectionStatus(ctx context.Context, userID int64, owner, repo string) (RepoConnectionStatus, error)
}

func NewRepoSyncService(root string, connectionChecker RepoSyncConnectionChecker) *RepoSyncService {
	trimmedRoot := strings.TrimSpace(root)
	if trimmedRoot == "" {
		trimmedRoot = defaultRepoSyncRoot
	}
	return &RepoSyncService{
		connectionChecker: connectionChecker,
		now:               time.Now,
		root:              trimmedRoot,
		runGit: func(ctx context.Context, args ...string) error {
			cmd := hostexec.Git(ctx, args...)
			out, err := cmd.CombinedOutput()
			if err != nil {
				trimmed := strings.TrimSpace(string(out))
				if trimmed == "" {
					return fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
				}
				return fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, trimmed)
			}
			return nil
		},
	}
}

func (s *RepoSyncService) SyncRepo(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
	req RepoSyncRequest,
) error {
	if userID <= 0 {
		return pkgerrors.Unauthorized("authentication required")
	}

	normalizedOwner, normalizedRepo, err := normalizeRepoSyncRef(owner, repo)
	if err != nil {
		return err
	}
	if err := validateRepoSyncRequest(req); err != nil {
		return err
	}
	if s.connectionChecker == nil {
		return pkgerrors.Internal("repo connection service not configured")
	}

	status, err := s.connectionChecker.GetRepoConnectionStatus(ctx, userID, normalizedOwner, normalizedRepo)
	if err != nil {
		return err
	}
	if !status.Connected {
		return pkgerrors.Forbidden("repository is not connected")
	}

	repoPath := filepath.Join(s.root, normalizedOwner, normalizedRepo+".git")
	if err := os.MkdirAll(filepath.Dir(repoPath), 0o755); err != nil {
		return pkgerrors.Internal("failed to create repo sync directory").WithCause(err)
	}
	if err := ensureBareRepoExists(ctx, s.runGit, repoPath); err != nil {
		return pkgerrors.Internal("failed to initialize bare repository").WithCause(err)
	}

	metadataPath := filepath.Join(repoPath, "jj", "metadata.json")
	metadata := repoSyncMetadata{
		Bookmarks:         req.Bookmarks,
		Owner:             normalizedOwner,
		Repo:              normalizedRepo,
		SyncedAt:          s.now().UTC(),
		UserID:            userID,
		WorkingCopyParent: req.WorkingCopyParent,
	}
	if err := writeJSONAtomically(metadataPath, metadata); err != nil {
		return pkgerrors.Internal("failed to persist repository metadata").WithCause(err)
	}

	return nil
}

func normalizeRepoSyncRef(owner string, repo string) (string, string, error) {
	normalizedOwner := strings.ToLower(strings.TrimSpace(owner))
	normalizedRepo := strings.ToLower(strings.TrimSpace(repo))
	if normalizedOwner == "" {
		return "", "", pkgerrors.BadRequest("owner is required")
	}
	if normalizedRepo == "" {
		return "", "", pkgerrors.BadRequest("repository name is required")
	}
	if invalidRepoPathComponent(normalizedOwner) {
		return "", "", pkgerrors.BadRequest("owner contains invalid characters")
	}
	if invalidRepoPathComponent(normalizedRepo) {
		return "", "", pkgerrors.BadRequest("repository name contains invalid characters")
	}
	return normalizedOwner, normalizedRepo, nil
}

func invalidRepoPathComponent(value string) bool {
	if value == "." || value == ".." {
		return true
	}
	return strings.Contains(value, "/") || strings.Contains(value, "\\")
}

func validateRepoSyncRequest(req RepoSyncRequest) error {
	if req.WorkingCopyParent.ChangeID == "" && req.WorkingCopyParent.CommitID == "" {
		return pkgerrors.BadRequest("working_copy_parent is required")
	}
	for _, bookmark := range req.Bookmarks {
		if strings.TrimSpace(bookmark.Name) == "" {
			return pkgerrors.BadRequest("bookmark name is required")
		}
	}
	return nil
}

func ensureBareRepoExists(ctx context.Context, runGit func(context.Context, ...string) error, repoPath string) error {
	stat, err := os.Stat(repoPath)
	if err == nil {
		if !stat.IsDir() {
			return fmt.Errorf("%s is not a directory", repoPath)
		}
		return nil
	}
	if !os.IsNotExist(err) {
		return err
	}
	return runGit(ctx, "init", "--bare", repoPath)
}

func writeJSONAtomically(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	// A unique temp file per call: concurrent syncs for the same repository in
	// one process must never share a temp path, or one caller renames the other
	// caller's file away and the loser fails with ENOENT (or worse, publishes a
	// mix of two requests).
	temp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	cleanup := func(err error) error {
		_ = temp.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if _, err := temp.Write(data); err != nil {
		return cleanup(err)
	}
	if err := temp.Sync(); err != nil {
		return cleanup(err)
	}
	if err := temp.Chmod(0o644); err != nil {
		return cleanup(err)
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return nil
}
