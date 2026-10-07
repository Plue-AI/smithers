package machined

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/hostexec"
)

type exportedBundle struct{ *os.File }

func (b *exportedBundle) Close() error { return errors.Join(b.File.Close(), os.Remove(b.Name())) }

type bundleLimit struct {
	file      *os.File
	remaining int64
}

func (w *bundleLimit) Write(b []byte) (int, error) {
	if int64(len(b)) > w.remaining {
		return 0, errors.New("host bundle exceeds transfer bound")
	}
	n, err := w.file.Write(b)
	w.remaining -= int64(n)
	return n, err
}

// GitBundleExporter runs inside the caller's repository maintenance exclusion.
// It validates the requested head against the native branch ref, snapshots to a
// private file, and removes its transfer ref before releasing that exclusion.
// The file then survives branch movement without holding DB/engine locks during
// network transfer. No guest-supplied path or ref name is used.
func GitBundleExporter(resolve func(context.Context, string) (string, error)) ObjectExporter {
	return func(ctx context.Context, branch, head string, stream uint32) (source io.ReadCloser, result error) {
		id, err := uuid.Parse(branch)
		if err != nil || id.String() != branch || !objectID(head) || stream < 0x80000000 || resolve == nil {
			return nil, ErrUnauthorized
		}
		repo, err := resolve(ctx, branch)
		if err != nil {
			return nil, err
		}
		if !filepath.IsAbs(repo) {
			return nil, ErrUnauthorized
		}
		git := func(ctx context.Context, args ...string) ([]byte, error) {
			argv := []string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsync=all", "-C", repo}
			return hostexec.Git(ctx, append(argv, args...)...).Output()
		}
		actual, err := git(ctx, "show-ref", "--verify", "--hash", "refs/smithers/branches/"+branch+"/head")
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(string(actual)) != head {
			return nil, ErrNotReady
		}
		ref := fmt.Sprintf("refs/smithers/xfer/%d", stream)
		// A prior crash can leave this private namespace behind. The maintenance
		// lock excludes active exporters; CAS prevents overwriting an unexpected ref.
		old, err := git(ctx, "for-each-ref", "--format=%(objectname)", ref)
		if err != nil {
			return nil, err
		}
		previous := strings.TrimSpace(string(old))
		if previous == "" {
			previous = strings.Repeat("0", 40)
		}
		if !objectID(previous) {
			return nil, ErrUnauthorized
		}
		if _, err = git(ctx, "update-ref", ref, head, previous); err != nil {
			return nil, err
		}
		defer func() {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			if _, err := git(cleanup, "update-ref", "-d", ref, head); err != nil {
				if source != nil {
					_ = source.Close()
					source = nil
				}
				result = errors.Join(result, err)
			}
		}()
		file, err := os.CreateTemp("", "smithers-host-bundle-*")
		if err != nil {
			return nil, err
		}
		keep := false
		defer func() {
			if !keep {
				_ = file.Close()
				_ = os.Remove(file.Name())
			}
		}()
		cmd := hostexec.Git(ctx, "-c", "core.hooksPath=/dev/null", "-C", repo, "bundle", "create", "-", ref)
		cmd.Stdout = &bundleLimit{file: file, remaining: maxObjectBundleSize}
		cmd.Stderr = io.Discard
		if err = cmd.Run(); err != nil {
			return nil, err
		}
		if err = file.Sync(); err != nil {
			return nil, err
		}
		if _, err = file.Seek(0, io.SeekStart); err != nil {
			return nil, err
		}
		keep = true
		return &exportedBundle{file}, nil
	}
}
