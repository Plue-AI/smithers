package machined

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// GitBurstObjects reads data in a trusted bare host repository. Directory is
// host configuration; no branch path or repository executable is executed.
// Object-stream admission must import/verify bundles before invoking ingest.
type GitBurstObjects struct{ Directory string }

func (s GitBurstObjects) command(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", append([]string{"--git-dir=" + s.Directory}, args...)...)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_NO_REPLACE_OBJECTS=1"}
	return cmd
}
func (s GitBurstObjects) git(ctx context.Context, args ...string) ([]byte, error) {
	return s.command(ctx, args...).Output()
}
func (s GitBurstObjects) Verify(ctx context.Context, _ string, b wire.Burst) ([]string, error) {
	if s.Directory == "" {
		return nil, ErrNotReady
	}
	expected := map[string]string{}
	objects := map[string]string{b.VersionsCommit: "commit"}
	for _, f := range b.Files {
		if f.BeforeBlob == b.VersionsCommit || f.AfterBlob == b.VersionsCommit {
			return nil, wire.BadValue
		}
		if f.BeforeBlob != "" {
			expected["a/"+f.Path] = f.BeforeBlob
			objects[f.BeforeBlob] = "blob"
		}
		if f.AfterBlob != "" {
			p := f.Path
			if _, ok := expected["b/"+p]; ok {
				return nil, wire.BadValue
			}
			expected["b/"+p] = f.AfterBlob
			objects[f.AfterBlob] = "blob"
		}
	}
	var missing []string
	for oid, kind := range objects {
		if len(oid) != 40 {
			return nil, wire.BadValue
		}
		if _, err := hex.DecodeString(oid); err != nil {
			return nil, wire.BadValue
		}
		typ, err := s.git(ctx, "cat-file", "-t", oid)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			missing = append(missing, oid)
			continue
		}
		if strings.TrimSpace(string(typ)) != kind {
			return nil, wire.BadValue
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return missing, nil
	}
	commit, err := s.git(ctx, "cat-file", "commit", b.VersionsCommit)
	if err != nil {
		return nil, err
	}
	header, _, _ := bytes.Cut(commit, []byte("\n\n"))
	for _, line := range bytes.Split(header, []byte("\n")) {
		if bytes.HasPrefix(line, []byte("parent ")) {
			return nil, wire.BadValue
		}
	}
	tree, err := s.git(ctx, "ls-tree", "-r", "-z", b.VersionsCommit)
	if err != nil {
		return nil, err
	}
	for _, entry := range bytes.Split(tree, []byte{0}) {
		if len(entry) == 0 {
			continue
		}
		meta, p, ok := bytes.Cut(entry, []byte{'\t'})
		parts := strings.Fields(string(meta))
		if !ok || len(parts) != 3 || parts[0] != "100644" && parts[0] != "100755" || parts[1] != "blob" || expected[string(p)] != parts[2] {
			return nil, wire.BadValue
		}
		delete(expected, string(p))
	}
	if len(expected) > 0 {
		return nil, wire.BadValue
	}
	for _, f := range b.Files {
		if f.AfterBlob == "" {
			continue
		}
		digest := sha256.New()
		cmd := s.command(ctx, "cat-file", "blob", f.AfterBlob)
		cmd.Stdout = digest
		if err := cmd.Run(); err != nil {
			return nil, err
		}
		if hex.EncodeToString(digest.Sum(nil)) != f.PostDigest {
			return nil, wire.BadValue
		}
	}
	return nil, nil
}
func (s GitBurstObjects) Retain(ctx context.Context, branch string, b wire.Burst) error {
	id, err := uuid.Parse(branch)
	if err != nil {
		return err
	}
	ref := fmt.Sprintf("refs/smithers/branches/%s/bursts/%s", id.String(), uuid.UUID(b.ID).String())
	old, err := s.git(ctx, "rev-parse", "--verify", ref)
	if err == nil {
		if strings.TrimSpace(string(old)) == b.VersionsCommit {
			return nil
		}
		return errors.New("burst ref already names another versions commit")
	}
	_, err = s.git(ctx, "update-ref", ref, b.VersionsCommit, strings.Repeat("0", 40))
	return err
}
