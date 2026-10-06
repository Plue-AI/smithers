package machined

import (
	"bufio"
	"context"
	"encoding/hex"
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

// GitBundleImporter consumes bundles as data using the existing controlled host
// git executable. resolve selects the host repository from the authenticated
// branch binding; it must serialize against repository maintenance. Guest ref
// names are never installed. Imported commits are pinned under host-chosen
// branch incoming refs before transport close certifies durable reception.
func GitBundleImporter(resolve func(context.Context, string) (string, error)) ObjectImporter {
	return func(ctx context.Context, branch string, file *os.File) error {
		id, err := uuid.Parse(branch)
		if err != nil || resolve == nil || file == nil {
			return ErrUnauthorized
		}
		repo, err := resolve(ctx, branch)
		if err != nil {
			return err
		}
		if !filepath.IsAbs(repo) {
			return ErrUnauthorized
		}
		git := func(args ...string) error {
			argv := []string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync", "-C", repo}
			cmd := hostexec.Git(ctx, append(argv, args...)...)
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			return cmd.Run()
		}
		if err := git("bundle", "verify", file.Name()); err != nil {
			return errors.New("invalid or incomplete machine bundle")
		}
		// Read only the bounded bundle header to choose incoming pins. Git has
		// already validated it; never use a ref name or path supplied by the peer.
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return err
		}
		scanner := bufio.NewScanner(io.LimitReader(file, 1<<20))
		var oids []string
		if !scanner.Scan() || (scanner.Text() != "# v2 git bundle" && scanner.Text() != "# v3 git bundle") {
			return errors.New("unsupported machine bundle")
		}
		ended := false
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				ended = true
				break
			}
			if strings.HasPrefix(line, "-") || line == "@object-format=sha1" {
				continue
			}
			oid, _, ok := strings.Cut(line, " ")
			decoded, err := hex.DecodeString(oid)
			if !ok || err != nil || len(decoded) != 20 || len(oids) >= 4096 {
				return errors.New("invalid machine bundle header")
			}
			oids = append(oids, strings.ToLower(oid))
		}
		if scanner.Err() != nil || !ended || len(oids) == 0 {
			return errors.New("incomplete machine bundle header")
		}
		if err := git("bundle", "unbundle", file.Name()); err != nil {
			return err
		}
		for _, oid := range oids {
			// Checking the complete reachable graph prevents a malformed pack
			// obtaining a durable incoming pin for a missing parent or tree.
			if err := git("fsck", "--connectivity-only", "--no-reflogs", oid); err != nil {
				return err
			}
			if err := git("update-ref", "refs/smithers/branches/"+id.String()+"/incoming/"+oid, oid); err != nil {
				return err
			}
		}
		return nil
	}
}

// GitBundleExporter pins only the host-authorized head in the resolved store.
// A full bundle is deliberate: retained guest objects are not an authority for
// selecting prerequisites. No branch executable, hook, or ref name is consumed.
func GitBundleExporter(resolve func(context.Context, string) (string, error)) ObjectExporter {
	return func(ctx context.Context, branch, head string, stream uint32) (*os.File, error) {
		if _, err := uuid.Parse(branch); err != nil || resolve == nil || stream < 0x80000000 {
			return nil, ErrUnauthorized
		}
		if _, err := oid(head); err != nil {
			return nil, err
		}
		repo, err := resolve(ctx, branch)
		if err != nil {
			return nil, err
		}
		if !filepath.IsAbs(repo) {
			return nil, ErrUnauthorized
		}
		git := func(call context.Context, args ...string) error {
			argv := []string{"-c", "core.hooksPath=/dev/null", "-C", repo}
			cmd := hostexec.Git(call, append(argv, args...)...)
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			return cmd.Run()
		}
		// Unique across boots and branches even when their stream counters coincide.
		ref := fmt.Sprintf("refs/smithers/xfer/%s/%08x", uuid.NewString(), stream)
		if err := git(ctx, "cat-file", "-e", head+"^{commit}"); err != nil {
			return nil, err
		}
		if err := git(ctx, "update-ref", ref, head, strings.Repeat("0", 40)); err != nil {
			return nil, err
		}
		defer func() {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			_ = git(cleanup, "update-ref", "-d", ref, head)
		}()
		file, err := os.CreateTemp("", "smithers-machined-wake-*.bundle")
		if err != nil {
			return nil, err
		}
		success := false
		defer func() {
			if !success {
				file.Close()
				os.Remove(file.Name())
			}
		}()
		command := hostexec.Git(ctx, "-c", "core.hooksPath=/dev/null", "-C", repo, "bundle", "create", "-", ref)
		command.Stdout, command.Stderr = &bundleWriter{Writer: file, remaining: 256 << 20}, io.Discard
		if err := command.Run(); err != nil {
			return nil, err
		}
		if err := git(ctx, "bundle", "verify", file.Name()); err != nil {
			return nil, err
		}
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return nil, err
		}
		success = true
		return file, nil
	}
}

// Bound the spool while Git produces it, rather than after filling host disk.
type bundleWriter struct {
	io.Writer
	remaining int64
}

func (w *bundleWriter) Write(data []byte) (int, error) {
	if int64(len(data)) > w.remaining {
		return 0, errors.New("host bundle exceeds transfer limit")
	}
	n, err := w.Writer.Write(data)
	w.remaining -= int64(n)
	return n, err
}
