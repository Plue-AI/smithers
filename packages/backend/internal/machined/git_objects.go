package machined

import (
	"bufio"
	"context"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

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
