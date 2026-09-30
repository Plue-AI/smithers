package repohostserver

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// gitSize asks repo-host for the repository's git bytes.
func (f *laneHTTPFixture) gitSize() repohost.GitSize {
	f.t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/repos/alice/demo/git/size", nil)
	req.Header.Set("Authorization", validAuth())
	rec := httptest.NewRecorder()
	f.srv.Handler().ServeHTTP(rec, req)
	require.Equal(f.t, http.StatusOK, rec.Code, rec.Body.String())
	var size repohost.GitSize
	require.NoError(f.t, json.Unmarshal(rec.Body.Bytes(), &size))
	return size
}

func (f *laneHTTPFixture) largeCommit(name string, size int) string {
	f.t.Helper()
	noise := make([]byte, size)
	_, err := rand.Read(noise)
	require.NoError(f.t, err)
	return f.commit(name, func(dir string) {
		require.NoError(f.t, os.WriteFile(filepath.Join(dir, name+".bin"), noise, 0o644))
	})
}

// allowance leaves room bytes for a push to the fixture's repository.
func (f *laneHTTPFixture) allowance(room int64) string {
	return strconv.FormatInt(f.gitSize().GitBytes+room, 10)
}

// smithersai/plue#593: the API sends the repository's git bytes allowance; a
// pack past what it leaves is refused before git writes it, and the branch
// does not move.
func TestPushPastRemainingStorageIsRefused(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	tip := f.largeCommit("large", 256<<10)
	body := f.pushBody(f.base, tip, "refs/heads/main")

	rec := postReceivePack(t, f, body, repohost.GitBytesAllowanceHeader, f.allowance(64<<10))

	assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
	assert.Equal(t, repohost.StorageLimitCode, rec.Header().Get("X-Smithers-Error-Code"))
	assert.Equal(t, f.base, f.repo.refs()["refs/heads/main"])
	assert.Less(t, f.gitSize().GitBytes, int64(256<<10), "git kept none of the refused pack")
}

// An owner with no storage left can still move a branch to a commit the
// repository has: git sends an empty pack.
func TestPushWithNoStorageLeftMovesRefsToExistingCommits(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)

	line := fmt.Sprintf("%s %s refs/heads/copy\x00report-status\n", laneZeroOID, f.base)
	body := []byte(fmt.Sprintf("%04x%s0000", len(line)+4, line))
	cmd := exec.Command("git", "-C", f.clientDir, "pack-objects", "--revs", "--stdout", "-q")
	cmd.Stdin = strings.NewReader(f.base + "\n^" + f.base + "\n")
	emptyPack, err := cmd.Output()
	require.NoError(t, err)
	require.LessOrEqual(t, len(emptyPack), emptyPackBytes)

	rec := postReceivePack(t, f, append(body, emptyPack...), repohost.GitBytesAllowanceHeader, "0")

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, f.base, f.repo.refs()["refs/heads/copy"])
}

// repo-host measures the repository under the push's lock, so an allowance
// the API computed before its last measurement was recorded still caps the
// repository: the second push with the same allowance is refused.
func TestPushAllowanceCountsTheRepositoryAsItIs(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	allowance := f.allowance(384 << 10)
	first := f.largeCommit("first", 256<<10)
	rec := postReceivePack(t, f, f.pushBody(f.base, first, "refs/heads/main"), repohost.GitBytesAllowanceHeader, allowance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	second := f.largeCommit("second", 256<<10)
	rec = postReceivePack(t, f, f.pushBody(first, second, "refs/heads/main"), repohost.GitBytesAllowanceHeader, allowance)

	assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
	assert.Equal(t, repohost.StorageLimitCode, rec.Header().Get("X-Smithers-Error-Code"))
	assert.Equal(t, first, f.repo.refs()["refs/heads/main"])
}

// A pack small enough to pass as empty still may not carry an object when
// no storage is left.
func TestPushWithNoStorageLeftCannotAddATinyObject(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	hash := exec.Command("git", "-C", f.clientDir, "hash-object", "-w", "--stdin")
	hash.Stdin = strings.NewReader("")
	out, err := hash.Output()
	require.NoError(t, err)
	blob := strings.TrimSpace(string(out))
	cmd := exec.Command("git", "-C", f.clientDir, "pack-objects", "--stdout", "-q")
	cmd.Stdin = strings.NewReader(blob + "\n")
	tinyPack, err := cmd.Output()
	require.NoError(t, err)
	require.LessOrEqual(t, len(tinyPack), emptyPackBytes, "the pack must fit the empty-pack allowance")
	line := fmt.Sprintf("%s %s refs/heads/copy\x00report-status\n", laneZeroOID, f.base)
	body := append([]byte(fmt.Sprintf("%04x%s0000", len(line)+4, line)), tinyPack...)

	rec := postReceivePack(t, f, body, repohost.GitBytesAllowanceHeader, "0")

	assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
	assert.Equal(t, repohost.StorageLimitCode, rec.Header().Get("X-Smithers-Error-Code"))
	assert.NotContains(t, f.repo.refs(), "refs/heads/copy")
}

func TestParseCountObjects(t *testing.T) {
	gitBytes, err := parseCountObjects([]byte("count: 3\nsize: 12\nin-pack: 9\npacks: 1\nsize-pack: 100\nprune-packable: 0\ngarbage: 0\nsize-garbage: 4\n"))
	require.NoError(t, err)
	assert.Equal(t, int64(116<<10), gitBytes)

	for name, output := range map[string]string{
		"no packs line": "count: 0\nsize: 0\n",
		"malformed":     "size: 1\nsize-pack: lots\n",
		"negative":      "size-pack: -1\n",
	} {
		_, err := parseCountObjects([]byte(output))
		assert.Error(t, err, name)
	}
}

// A push within the remaining storage lands, and the repository's measured
// git bytes include the new objects.
func TestPushWithinRemainingStorageReportsGitBytes(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	tip := f.largeCommit("fits", 256<<10)
	body := f.pushBody(f.base, tip, "refs/heads/main")

	rec := postReceivePack(t, f, body, repohost.GitBytesAllowanceHeader, strconv.Itoa(8<<20))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, tip, f.repo.refs()["refs/heads/main"])
	size := f.gitSize()
	assert.GreaterOrEqual(t, size.GitBytes, int64(256<<10), "random content does not compress")
	assert.Positive(t, size.MeasuredAt)
}

// Without the header the owner has no storage limit, and the push lands.
func TestPushWithoutStorageLimitReportsGitBytes(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	tip := f.largeCommit("unlimited", 128<<10)

	rec := postReceivePack(t, f, f.pushBody(f.base, tip, "refs/heads/main"))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.GreaterOrEqual(t, f.gitSize().GitBytes, int64(128<<10))
}

// The measurement waits for a push that holds the repository, so it counts
// what that push kept.
func TestGitSizeWaitsForAPushHoldingTheRepository(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	unlock, err := f.srv.lockRepo(context.Background(), f.srv.config.RepoPath("alice", "demo"))
	require.NoError(t, err)
	measured := make(chan repohost.GitSize, 1)
	go func() { measured <- f.gitSize() }()
	select {
	case <-measured:
		t.Fatal("measured while a push held the repository")
	case <-time.After(200 * time.Millisecond):
	}
	unlock()
	select {
	case size := <-measured:
		assert.Positive(t, size.GitBytes)
	case <-time.After(10 * time.Second):
		t.Fatal("measurement never ran")
	}
}

func TestGitSizeOfAMissingRepositoryIsNotFound(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	req := httptest.NewRequest(http.MethodGet, "/repos/alice/missing/git/size", nil)
	req.Header.Set("Authorization", validAuth())
	rec := httptest.NewRecorder()
	f.srv.Handler().ServeHTTP(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
}

// A malformed allowance header fails closed.
func TestPushWithMalformedRemainingStorageIsRefused(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	tip := f.largeCommit("malformed", 1<<10)
	for _, value := range []string{"-1", "lots"} {
		rec := postReceivePack(t, f, f.pushBody(f.base, tip, "refs/heads/main"), repohost.GitBytesAllowanceHeader, value)
		assert.Equal(t, http.StatusBadRequest, rec.Code, "%s: %s", value, rec.Body.String())
	}
	assert.Equal(t, f.base, f.repo.refs()["refs/heads/main"])
}
