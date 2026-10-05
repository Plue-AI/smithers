package microsandbox

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/smithersai/smithers/packages/backend/installbundle"
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
	// The guest re-hashes the bytes it receives against the same digest.
	current, err := r.guest(ctx, ws.Machine, nil, "coding-helper-check", r.codingHelper.digest)
	if err != nil {
		return err
	}
	switch strings.TrimSpace(string(current)) {
	case "current":
	case "replace":
		if _, err := r.guest(ctx, ws.Machine, helper, "coding-helper", r.codingHelper.digest); err != nil {
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

// codingHelperBundlePath is the packaged Linux arm64 source-publication
// helper's place in the installed bundle (flowmanifest's jjExport host).
const codingHelperBundlePath = "bin/linux-arm64/smithers-jj-export"

// codingHelperBytes reads the helper once from the approved installed
// bundle, with the digest and mode its pinned manifest declares; a runtime
// without a bundle installs no helper and so no binding.
func (r *Runtime) codingHelperBytes() ([]byte, error) {
	r.codingHelper.once.Do(func() {
		r.codingHelper.data, r.codingHelper.digest, r.codingHelper.err = r.readCodingHelper()
	})
	return r.codingHelper.data, r.codingHelper.err
}

func (r *Runtime) readCodingHelper() ([]byte, string, error) {
	if r.config.Bundle == nil {
		return nil, "", fmt.Errorf("%w: the packaged workspace coding helper requires the installed bundle", ErrUnapprovedArtifact)
	}
	return codingHelperFrom(r.config.Bundle)
}

// codingHelperFrom reads the helper from bundle with the digest and mode its
// pinned manifest declares, and only when it is a Linux arm64 executable.
func codingHelperFrom(bundle *installbundle.Bundle) ([]byte, string, error) {
	return linuxArm64From(bundle, codingHelperBundlePath, "packaged workspace coding helper")
}

// guestJJBundlePath is the bundle's Linux arm64 jj, built from the jj
// revision the helper's jj-lib pins. Repository setup and the helper run
// `jj` in the guest, and a repository's detected toolchain carries none.
const guestJJBundlePath = "bin/linux-arm64/jj"

// guestJJName is where the guest helper plants it: /usr/local/bin/jj.
const guestJJName = "jj"

func guestJJFrom(bundle *installbundle.Bundle) ([]byte, string, error) {
	return linuxArm64From(bundle, guestJJBundlePath, "packaged guest jj")
}

func linuxArm64From(bundle *installbundle.Bundle, relative, label string) ([]byte, string, error) {
	data, digest, err := plantable(bundle, relative)
	if err != nil {
		return nil, "", err
	}
	if len(data) < 64 || string(data[:4]) != "\x7fELF" || data[4] != 2 || data[5] != 1 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		return nil, "", errors.New(label + " is not Linux arm64")
	}
	return data, digest, nil
}

// installGuestJJ plants the bundle's jj as root-owned /usr/local/bin/jj on a
// fresh or woken machine, replacing drifted bytes; a runtime without a bundle
// plants nothing.
func (r *Runtime) installGuestJJ(ctx context.Context, machine string) error {
	if r.config.Bundle == nil {
		return nil
	}
	r.guestJJ.once.Do(func() {
		r.guestJJ.data, r.guestJJ.digest, r.guestJJ.err = guestJJFrom(r.config.Bundle)
	})
	if r.guestJJ.err != nil {
		return r.guestJJ.err
	}
	current, err := r.guest(ctx, machine, nil, "coding-helper-check", r.guestJJ.digest, guestJJName)
	if err != nil {
		return err
	}
	switch strings.TrimSpace(string(current)) {
	case "current":
		return nil
	case "replace":
		_, err := r.guest(ctx, machine, r.guestJJ.data, "coding-helper", r.guestJJ.digest, guestJJName)
		return err
	default:
		return errors.New("guest jj check returned an invalid result")
	}
}

var _ workspaceapi.WorkspaceCodingBindingInstaller = (*Runtime)(nil)
