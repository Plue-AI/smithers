package process

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func withinRoot(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

// resolveWorkspacePath validates lexical traversal and resolves every existing
// symlink before use. For writes, the final path may be absent but its parent
// must already resolve inside root.
func resolveWorkspacePath(root, requested string, directory, allowRoot bool) (string, error) {
	if requested == "" {
		requested = "."
	}
	if filepath.IsAbs(requested) {
		return "", errors.New("workspace path must be relative")
	}
	cleaned := filepath.Clean(requested)
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", errors.New("workspace path escapes root")
	}
	if cleaned == "." && !allowRoot {
		return "", errors.New("workspace root cannot be modified")
	}
	candidate := filepath.Join(root, cleaned)
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) || directory {
			return "", err
		}
		parent, parentErr := filepath.EvalSymlinks(filepath.Dir(candidate))
		if parentErr != nil {
			return "", parentErr
		}
		resolved = filepath.Join(parent, filepath.Base(candidate))
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	if !withinRoot(canonicalRoot, resolved) {
		return "", errors.New("workspace path resolves outside root")
	}
	if directory {
		info, err := os.Stat(resolved)
		if err != nil {
			return "", err
		}
		if !info.IsDir() {
			return "", errors.New("workspace path is not a directory")
		}
	}
	return resolved, nil
}

func resolveWorkspaceMutationPath(root, requested string) (string, error) {
	if requested == "" || filepath.IsAbs(requested) {
		return "", errors.New("workspace mutation path must be relative")
	}
	cleaned := filepath.Clean(requested)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", errors.New("workspace mutation path escapes or replaces root")
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Join(root, filepath.Dir(cleaned)))
	if err != nil {
		return "", err
	}
	if !withinRoot(canonicalRoot, parent) {
		return "", errors.New("workspace mutation path resolves outside root")
	}
	lexical := filepath.Join(root, cleaned)
	if info, err := os.Lstat(lexical); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("workspace mutation target is a symlink")
	} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(cleaned)), nil
}

func ensureWorkspaceMutationParent(root, requested string) error {
	cleaned := filepath.Clean(requested)
	parent := filepath.Dir(cleaned)
	if parent == "." {
		return nil
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	current := canonicalRoot
	for _, component := range strings.Split(parent, string(filepath.Separator)) {
		if component == "" || component == "." || component == ".." {
			return errors.New("workspace mutation path has an invalid parent")
		}
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			if err := os.Mkdir(current, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
				return err
			}
			info, err = os.Lstat(current)
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || !withinRoot(canonicalRoot, current) {
			return errors.New("workspace mutation parent is not a directory inside root")
		}
	}
	return nil
}

func (r *Runtime) workspaceRoot(id string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, err := r.workspaceLocked(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(ws.directory, "root"), nil
}

func (r *Runtime) ReadFile(ctx context.Context, workspaceID, path string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	root, err := r.workspaceRoot(workspaceID)
	if err != nil {
		return nil, err
	}
	resolved, err := resolveWorkspacePath(root, path, false, false)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace file: %w", err)
	}
	// Do not wait for a writer if a repository path names a FIFO. Validate
	// the opened object before reading so other special files are rejected too.
	file, err := os.OpenFile(resolved, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, fmt.Errorf("open workspace file: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect workspace file: %w", err)
	}
	if info.IsDir() {
		return nil, errors.New("workspace file is a directory")
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("workspace file is not a regular file")
	}
	if info.Size() > r.fileReadLimit {
		return nil, fmt.Errorf("workspace file exceeds read limit of %d bytes", r.fileReadLimit)
	}
	contents, err := io.ReadAll(io.LimitReader(file, r.fileReadLimit+1))
	if err != nil {
		return nil, fmt.Errorf("read workspace file: %w", err)
	}
	if int64(len(contents)) > r.fileReadLimit {
		return nil, fmt.Errorf("workspace file exceeds read limit of %d bytes", r.fileReadLimit)
	}
	return contents, nil
}

func (r *Runtime) WriteFile(ctx context.Context, workspaceID, path string, content []byte, mode fs.FileMode) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	root, err := r.workspaceRoot(workspaceID)
	if err != nil {
		return err
	}
	if err := ensureWorkspaceMutationParent(root, path); err != nil {
		return fmt.Errorf("prepare workspace file parent: %w", err)
	}
	resolved, err := resolveWorkspaceMutationPath(root, path)
	if err != nil {
		return fmt.Errorf("resolve workspace file: %w", err)
	}
	if mode == 0 {
		mode = 0o600
	}
	mode &= 0o777
	temporary, err := os.CreateTemp(filepath.Dir(resolved), ".smithers-write-*")
	if err != nil {
		return fmt.Errorf("create workspace file: %w", err)
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(mode); err != nil {
		return fmt.Errorf("set workspace file mode: %w", err)
	}
	if _, err := temporary.Write(content); err != nil {
		return fmt.Errorf("write workspace file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync workspace file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close workspace file: %w", err)
	}
	if err := os.Rename(temporaryPath, resolved); err != nil {
		return fmt.Errorf("commit workspace file: %w", err)
	}
	committed = true
	return nil
}

func (r *Runtime) ListFiles(ctx context.Context, workspaceID, path string) ([]workspaceapi.FileEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	root, err := r.workspaceRoot(workspaceID)
	if err != nil {
		return nil, err
	}
	resolved, err := resolveWorkspacePath(root, path, true, true)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace directory: %w", err)
	}
	entries, err := os.ReadDir(resolved)
	if err != nil {
		return nil, fmt.Errorf("list workspace directory: %w", err)
	}
	result := make([]workspaceapi.FileEntry, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			return nil, fmt.Errorf("inspect workspace entry %s: %w", entry.Name(), err)
		}
		result = append(result, workspaceapi.FileEntry{Name: entry.Name(), Mode: info.Mode(), Size: info.Size(), IsDir: info.IsDir()})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func (r *Runtime) RemoveFile(ctx context.Context, workspaceID, path string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	root, err := r.workspaceRoot(workspaceID)
	if err != nil {
		return err
	}
	resolved, err := resolveWorkspaceMutationPath(root, path)
	if err != nil {
		return fmt.Errorf("resolve workspace file: %w", err)
	}
	if err := os.RemoveAll(resolved); err != nil {
		return fmt.Errorf("remove workspace file: %w", err)
	}
	return nil
}
