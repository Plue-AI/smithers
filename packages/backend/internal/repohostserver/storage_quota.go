package repohostserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// emptyPackBytes is the largest pack that carries no object: a 12-byte
// header and a SHA-256 trailer. git sends one for a push whose objects the
// repository already has, so an owner at the limit can still move refs.
const emptyPackBytes = 12 + 32

// gitBytesAllowance reads the most bytes the API allows the repository's git
// objects to occupy after a push (smithersai/plue#593). limited is false when
// the owner has no storage limit; a malformed value fails the push.
func gitBytesAllowance(h http.Header) (allowance int64, limited bool, err *appError) {
	raw := h.Get(repohost.GitBytesAllowanceHeader)
	if raw == "" {
		return 0, false, nil
	}
	n, parseErr := strconv.ParseInt(raw, 10, 64)
	if parseErr != nil || n < 0 {
		return 0, false, badRequest("malformed " + repohost.GitBytesAllowanceHeader)
	}
	return n, true, nil
}

// remainingGitBytes measures the repository while the push holds its write
// lock and returns what the allowance leaves for the push, never negative.
// The allowance counts this repository's git bytes afresh at every push, so a
// measurement the API has not recorded yet cannot let the repository grow
// past it.
func remainingGitBytes(ctx context.Context, gitDir string, allowance int64) (int64, error) {
	current, err := measureGitBytes(ctx, gitDir)
	if err != nil {
		return 0, err
	}
	return max(allowance-current, 0), nil
}

// storagePackCap is the largest pack a push may send with remaining bytes
// of storage left. The cap counts pack bytes; receive-pack keeps every pack
// whole (receive.unpackLimit=1), so what lands on disk is that pack, its
// index, and any base objects git copies in to complete a thin pack. The
// measurement after the push records the true size, so an owner overshoots
// by at most that much per push in flight.
func storagePackCap(remaining int64) int64 {
	return max(remaining, emptyPackBytes)
}

// packHeaderBytes is a pack's "PACK" signature, version, and object count.
const packHeaderBytes = 12

// objectFreePack passes a push body through and fails it with errPushTooLarge
// once the pack after its command section declares an object. An owner with
// less storage left than an empty pack may only move refs to objects the
// repository already has.
type objectFreePack struct {
	r      io.Reader
	skip   int64
	header []byte
}

// requireObjectFreePack wraps body, whose first commandBytes bytes are the
// command section, when remaining storage is below an empty pack.
func requireObjectFreePack(body io.Reader, commandBytes, remaining int64) io.Reader {
	if remaining >= emptyPackBytes {
		return body
	}
	return &objectFreePack{r: body, skip: commandBytes}
}

func (p *objectFreePack) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	chunk := b[:n]
	if p.skip > 0 {
		passed := min(p.skip, int64(len(chunk)))
		p.skip -= passed
		chunk = chunk[passed:]
	}
	if need := packHeaderBytes - len(p.header); need > 0 && len(chunk) > 0 {
		p.header = append(p.header, chunk[:min(need, len(chunk))]...)
		if len(p.header) == packHeaderBytes && binary.BigEndian.Uint32(p.header[8:]) != 0 {
			return 0, errPushTooLarge
		}
	}
	return n, err
}

// storageLimitReached answers a pack larger than the storage the owner has
// left.
func storageLimitReached() *appError {
	return &appError{StatusCode: http.StatusRequestEntityTooLarge, Code: repohost.StorageLimitCode,
		Message: "this push would exceed the storage limit for the current plan"}
}

// gitSize answers the repository's git object bytes, measured once no push
// holds the repository, so a push the API lost track of is counted too.
func (s *Server) gitSize(w http.ResponseWriter, r *http.Request) error {
	owner, repo := chi.URLParam(r, "owner"), chi.URLParam(r, "repo")
	if err := validateOwnerRepo(owner, repo); err != nil {
		return err
	}
	unlock, err := s.locks.RLock(r.Context(), s.config.RepoPath(owner, repo))
	if err != nil {
		return err
	}
	defer unlock()
	gitDir := s.config.GitBackendPath(owner, repo)
	if _, err := os.Stat(gitDir); err != nil {
		return notFound("repository not found")
	}
	measuredAt := time.Now()
	gitBytes, err := measureGitBytes(r.Context(), gitDir)
	if err != nil {
		return internalError("failed to measure repository git bytes", err)
	}
	return writeJSON(w, http.StatusOK, repohost.GitSize{GitBytes: gitBytes, MeasuredAt: measuredAt.UnixNano()})
}

// measureGitBytes returns the bytes the repository's git object store
// occupies: loose objects, packs, and garbage, as git count-objects reports
// them.
func measureGitBytes(ctx context.Context, gitDir string) (int64, error) {
	output, err := exec.CommandContext(ctx, "git", "--git-dir", gitDir, "count-objects", "-v").Output()
	if err != nil {
		return 0, fmt.Errorf("count git objects: %w", err)
	}
	return parseCountObjects(output)
}

func parseCountObjects(output []byte) (int64, error) {
	var kib int64
	sawPacks := false
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		key, value, ok := strings.Cut(scanner.Text(), ": ")
		if !ok || (key != "size" && key != "size-pack" && key != "size-garbage") {
			continue
		}
		n, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("count git objects: malformed %s %q", key, value)
		}
		sawPacks = sawPacks || key == "size-pack"
		kib += n
	}
	if !sawPacks {
		return 0, fmt.Errorf("count git objects: no size-pack in %q", output)
	}
	return kib << 10, nil
}
