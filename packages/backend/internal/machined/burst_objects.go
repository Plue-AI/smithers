package machined

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// GitBurstObjects reads data only from the host-selected repository. Resolve
// must serialize against repository maintenance, as for GitBundleImporter.
type GitBurstObjects struct {
	Resolve func(context.Context, string) (string, error)
}

// WithBurstObjects is for a repository whose lifetime is already held by the
// caller. The install uses its transaction-bound repository capability instead.
func (s GitBurstObjects) WithBurstObjects(ctx context.Context, _ pgx.Tx, _ string, visit func(BurstObjects) error) error {
	return visit(s)
}

func (s GitBurstObjects) repository(ctx context.Context, branch string) (string, error) {
	if _, err := uuid.Parse(branch); err != nil || s.Resolve == nil {
		return "", ErrUnauthorized
	}
	repo, err := s.Resolve(ctx, branch)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(repo) {
		return "", ErrUnauthorized
	}
	return repo, nil
}

// Bound hostile object output independently of the transport's frame bound.
type boundedObjectOutput struct {
	bytes.Buffer
	remaining int
}

func (w *boundedObjectOutput) Write(p []byte) (int, error) {
	if len(p) > w.remaining {
		return 0, errors.New("machine object exceeds verification bound")
	}
	w.remaining -= len(p)
	return w.Buffer.Write(p)
}
func burstGit(ctx context.Context, repo string, limit int, args ...string) ([]byte, error) {
	cmd := hostexec.Git(ctx, append([]string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync", "-C", repo}, args...)...)
	out := &boundedObjectOutput{remaining: limit}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	err := cmd.Run()
	return out.Bytes(), err
}
func objectID(s string) bool {
	b, e := hex.DecodeString(s)
	return e == nil && len(b) == 20 && s == strings.ToLower(s)
}

func (s GitBurstObjects) VerifyBurst(ctx context.Context, branch string, b wire.Burst) ([]string, error) {
	repo, err := s.repository(ctx, branch)
	if err != nil {
		return nil, err
	}
	if !objectID(b.Versions) || len(b.Files) == 0 {
		return nil, wire.BadValue
	}
	expected := map[string]string{}
	for _, f := range b.Files {
		if !validBurstPath(f.Path) {
			return nil, wire.BadValue
		}
		for _, v := range []struct{ prefix, oid string }{{"a/", f.BeforeBlob}, {"b/", f.AfterBlob}} {
			if v.oid == "" {
				continue
			}
			if !objectID(v.oid) {
				return nil, wire.BadValue
			}
			key := v.prefix + f.Path
			if _, ok := expected[key]; ok {
				return nil, wire.BadValue
			}
			expected[key] = v.oid
		}
	}
	kind, err := burstGit(ctx, repo, 64, "cat-file", "-t", b.Versions)
	if err != nil {
		return []string{b.Versions}, nil
	}
	if string(kind) != "commit\n" {
		return nil, wire.BadValue
	}
	commit, err := burstGit(ctx, repo, 1<<20, "cat-file", "commit", b.Versions)
	if err != nil {
		return nil, err
	}
	header, _, ok := strings.Cut(string(commit), "\n\n")
	if !ok || !strings.HasPrefix(header, "tree ") {
		return nil, wire.BadValue
	}
	for _, line := range strings.Split(header, "\n") {
		if strings.HasPrefix(line, "parent ") {
			return nil, wire.BadValue
		}
	}
	tree, err := burstGit(ctx, repo, 8<<20, "ls-tree", "-rz", "--full-tree", b.Versions)
	if err != nil {
		return nil, err
	}
	actual := map[string]string{}
	for _, entry := range bytes.Split(tree, []byte{0}) {
		if len(entry) == 0 {
			continue
		}
		meta, path, ok := strings.Cut(string(entry), "\t")
		fields := strings.Fields(meta)
		if !ok || len(fields) != 3 || (fields[0] != "100644" && fields[0] != "100755") || fields[1] != "blob" || expected[path] != fields[2] {
			return nil, wire.BadValue
		}
		actual[path] = fields[2]
	}
	if len(actual) != len(expected) {
		return nil, wire.BadValue
	}
	missing := []string{}
	digests := map[string]string{}
	absent := map[string]bool{}
	for _, f := range b.Files {
		for _, oid := range []string{f.BeforeBlob, f.AfterBlob} {
			if oid == "" {
				continue
			}
			digest, verified := digests[oid]
			if absent[oid] {
				continue
			}
			if !verified {
				blob, err := burstGit(ctx, repo, 16<<20, "cat-file", "blob", oid)
				if err != nil {
					missing = append(missing, oid)
					absent[oid] = true
					continue
				}
				sum := sha256.Sum256(blob)
				digest = hex.EncodeToString(sum[:])
				digests[oid] = digest
			}
			if oid == f.AfterBlob && f.PostDigest != digest {
				return nil, wire.BadValue
			}
		}
	}
	return missing, nil
}

func (s GitBurstObjects) PublishBurst(ctx context.Context, branch, burst, versions string) error {
	repo, err := s.repository(ctx, branch)
	if err != nil {
		return err
	}
	id, err := uuid.Parse(burst)
	if err != nil || !objectID(versions) {
		return wire.BadValue
	}
	branchID, _ := uuid.Parse(branch)
	ref := "refs/smithers/branches/" + branchID.String() + "/bursts/" + id.String()
	// Immutable refs: replay can retain the same commit, never replace it.
	_, err = burstGit(ctx, repo, 64, "update-ref", ref, versions, strings.Repeat("0", 40))
	if err == nil {
		return nil
	}
	current, readErr := burstGit(ctx, repo, 64, "rev-parse", "--verify", ref)
	if readErr == nil && strings.TrimSpace(string(current)) == versions {
		return nil
	}
	return fmt.Errorf("retain burst ref: %w", err)
}
