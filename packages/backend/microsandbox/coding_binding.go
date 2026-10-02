package microsandbox

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type codingHelperCache struct {
	once   sync.Once
	data   []byte
	digest string
	err    error
}

func (r *Runtime) InstallWorkspaceCodingBinding(ctx context.Context, workspaceID string, binding workspaceapi.WorkspaceCodingBinding) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := binding.Validate(); err != nil {
		return err
	}
	if workspaceID == "" {
		return errors.New("workspace coding binding workspace is required")
	}
	ws, err := r.runningWorkspace(workspaceID)
	if err != nil {
		return err
	}
	helper, err := r.codingHelperBytes()
	if err != nil {
		return err
	}
	current, err := r.guest(ctx, ws.Machine, []byte(r.codingHelper.digest), "coding-helper-check")
	if err != nil {
		return err
	}
	switch strings.TrimSpace(string(current)) {
	case "current":
	case "replace":
		if _, err := r.guest(ctx, ws.Machine, helper, "coding-helper"); err != nil {
			return err
		}
	default:
		return errors.New("guest coding helper check returned an invalid result")
	}
	config := struct {
		workspaceapi.WorkspaceCodingBinding
		Version          int    `json:"version"`
		WorkspaceID      string `json:"workspaceId"`
		RepositoryPath   string `json:"repositoryPath"`
		Username         string `json:"username"`
		CredentialSocket string `json:"credentialSocket"`
	}{binding, 1, workspaceID, guestRoot, guestUser, guestHome + "/.cache/smithers/git-credential/socket"}
	data, err := json.Marshal(config)
	if err != nil {
		return err
	}
	_, err = r.guest(ctx, ws.Machine, data, "coding-binding")
	return err
}

func (r *Runtime) codingHelperBytes() ([]byte, error) {
	r.codingHelper.once.Do(func() {
		r.codingHelper.data, r.codingHelper.err = r.readCodingHelper()
		if r.codingHelper.err == nil {
			sum := sha256.Sum256(r.codingHelper.data)
			r.codingHelper.digest = hex.EncodeToString(sum[:])
		}
	})
	return r.codingHelper.data, r.codingHelper.err
}

func (r *Runtime) readCodingHelper() ([]byte, error) {
	if !filepath.IsAbs(r.config.CodingHelper) {
		return nil, errors.New("packaged workspace coding helper is required")
	}
	file, err := os.Open(r.config.CodingHelper)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 || info.Size() < 64 || info.Size() > 64<<20 {
		return nil, errors.New("packaged workspace coding helper is invalid")
	}
	data, err := io.ReadAll(io.LimitReader(file, 64<<20+1))
	if err != nil {
		return nil, err
	}
	if len(data) < 64 || len(data) > 64<<20 || string(data[:4]) != "\x7fELF" || data[4] != 2 || data[5] != 1 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		return nil, errors.New("packaged workspace coding helper is not Linux arm64")
	}
	return data, nil
}

var _ workspaceapi.WorkspaceCodingBindingInstaller = (*Runtime)(nil)
