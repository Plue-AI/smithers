package microsandbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"strconv"
	"strings"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// fileOperation runs a root-confined helper file operation as the workspace
// user. The helper resolves symlinks inside the guest and refuses any path
// that leaves the root, mirroring the process adapter's rules.
func (r *Runtime) fileOperation(ctx context.Context, workspaceID, root string, stdin []byte, operation ...string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	ws, err := r.runningWorkspace(workspaceID)
	if err != nil {
		return nil, err
	}
	callCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	args := guestArgs(ws.Machine, nil, false, append([]string{"fs", guestUser, operation[0], root}, operation[1:]...)...)
	output, err := r.cli.run(callCtx, stdin, args...)
	if err == nil {
		return output, nil
	}
	var cliErr *cliError
	if !errors.As(err, &cliErr) {
		return nil, err
	}
	message := strings.TrimPrefix(strings.TrimSpace(cliErr.stderr), "smithers-guest: ")
	switch cliErr.exitCode {
	case 2:
		return nil, fmt.Errorf("workspace file %s: %w", operation[1], fs.ErrNotExist)
	case 3, 4, 5:
		return nil, errors.New(message)
	case 6:
		if operation[0] == "compare-write" {
			if stale := decodeMutationStale(cliErr.stderr); stale != nil {
				return nil, stale
			}
		}
	}
	return nil, fmt.Errorf("%w: guest file operation: %v", ErrUnavailable, err)
}

// decodeMutationStale accepts one bounded, exact diagnostic. Paths may contain
// colons and newlines, so the batch path and digest use JSON instead of splitting
// a branch-controlled delimiter. No duplicate/unknown field can change identity.
func decodeMutationStale(stderr string) *workspaceapi.StaleFileError {
	if len(stderr) > 16<<10 {
		return nil
	}
	body, ok := strings.CutPrefix(strings.TrimSuffix(stderr, "\n"), "smithers-guest: stale:")
	if !ok {
		return nil
	}
	decoder := json.NewDecoder(strings.NewReader(body))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return nil
	}
	values := make(map[string]string, 2)
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return nil
		}
		name, ok := key.(string)
		if !ok || (name != "path" && name != "current_digest") {
			return nil
		}
		if _, exists := values[name]; exists {
			return nil
		}
		var value string
		if decoder.Decode(&value) != nil {
			return nil
		}
		values[name] = value
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') || decoder.Decode(new(any)) != io.EOF || len(values) != 2 {
		return nil
	}
	name, digest := values["path"], values["current_digest"]
	if name == "" || len(name) > 4096 || name == "." || path.IsAbs(name) || path.Clean(name) != name || strings.HasPrefix(name, "../") || name == ".." || strings.ContainsRune(name, 0) {
		return nil
	}
	if digest != "absent" && !sha256Pattern.MatchString(digest) {
		return nil
	}
	return &workspaceapi.StaleFileError{Path: name, CurrentDigest: digest}
}

func (r *Runtime) ReadFile(ctx context.Context, workspaceID, path string) ([]byte, error) {
	return r.fileOperation(ctx, workspaceID, guestRoot, nil, "read", path, strconv.FormatInt(r.config.FileReadLimit, 10))
}

func (r *Runtime) WriteFile(ctx context.Context, workspaceID, path string, content []byte, mode fs.FileMode) error {
	ctx, releaseFence, fenceErr := r.CleanupGate.Enter(ctx, workspaceID)
	if fenceErr != nil {
		return fenceErr
	}
	defer releaseFence()
	if mode == 0 {
		mode = 0o600
	}
	if content == nil {
		content = []byte{}
	}
	_, err := r.fileOperation(ctx, workspaceID, guestRoot, content, "write", path, strconv.FormatUint(uint64(mode&0o777), 8))
	return err
}

const repositoryReceiptPath = ".git/smithers-workspace-initialization.json"

// These preparation-only methods do not expose a caller-selected path. The
// receipt must exist before the working copy can admit its daemon.
func (r *Runtime) ReadRepositoryReceipt(ctx context.Context, id string) ([]byte, error) {
	return r.fileOperation(ctx, id, guestRoot, nil, "read", repositoryReceiptPath, "65536")
}
func (r *Runtime) WriteRepositoryReceipt(ctx context.Context, id string, content []byte) error {
	if len(content) > 65536 {
		return fmt.Errorf("%w: repository receipt exceeds limit", ErrUnavailable)
	}
	_, err := r.fileOperation(ctx, id, guestRoot, content, "write", repositoryReceiptPath, "600")
	return err
}

func (r *Runtime) ListFiles(ctx context.Context, workspaceID, path string) ([]workspaceapi.FileEntry, error) {
	output, err := r.fileOperation(ctx, workspaceID, guestRoot, nil, "list", path)
	if err != nil {
		return nil, err
	}
	var entries []struct {
		Name string `json:"name"`
		Mode uint32 `json:"mode"`
		Size int64  `json:"size"`
		Dir  bool   `json:"dir"`
	}
	if err := json.Unmarshal(output, &entries); err != nil {
		return nil, fmt.Errorf("decode guest directory listing: %w", err)
	}
	result := make([]workspaceapi.FileEntry, 0, len(entries))
	for _, entry := range entries {
		result = append(result, workspaceapi.FileEntry{Name: entry.Name, Mode: unixMode(entry.Mode), Size: entry.Size, IsDir: entry.Dir})
	}
	return result, nil
}

func (r *Runtime) RemoveFile(ctx context.Context, workspaceID, path string) error {
	ctx, releaseFence, fenceErr := r.CleanupGate.Enter(ctx, workspaceID)
	if fenceErr != nil {
		return fenceErr
	}
	defer releaseFence()
	_, err := r.fileOperation(ctx, workspaceID, guestRoot, nil, "remove", path)
	return err
}

// unixMode converts a Linux st_mode to an fs.FileMode.
func unixMode(mode uint32) fs.FileMode {
	result := fs.FileMode(mode & 0o777)
	switch mode & 0o170000 {
	case 0o040000:
		result |= fs.ModeDir
	case 0o120000:
		result |= fs.ModeSymlink
	case 0o010000:
		result |= fs.ModeNamedPipe
	case 0o140000:
		result |= fs.ModeSocket
	case 0o020000:
		result |= fs.ModeDevice | fs.ModeCharDevice
	case 0o060000:
		result |= fs.ModeDevice
	}
	if mode&0o4000 != 0 {
		result |= fs.ModeSetuid
	}
	if mode&0o2000 != 0 {
		result |= fs.ModeSetgid
	}
	if mode&0o1000 != 0 {
		result |= fs.ModeSticky
	}
	return result
}
