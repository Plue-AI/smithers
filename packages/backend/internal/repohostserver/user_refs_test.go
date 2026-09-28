package repohostserver

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

const userRefWorkspace = "22222222-2222-2222-2222-222222222222"

// userRefPush builds a receive-pack request moving ref from oldOID to newOID
// with a pack of everything newOID has that main's base does not.
func (f *laneHTTPFixture) userRefPush(oldOID, newOID, ref string) []byte {
	f.t.Helper()
	var body bytes.Buffer
	line := fmt.Sprintf("%s %s %s\x00report-status\n", oldOID, newOID, ref)
	fmt.Fprintf(&body, "%04x%s0000", len(line)+4, line)
	if newOID == laneZeroOID {
		return body.Bytes()
	}
	cmd := exec.Command("git", "-C", f.clientDir, "pack-objects", "--revs", "--stdout", "-q")
	cmd.Stdin = strings.NewReader(newOID + "\n^" + f.base + "\n")
	pack, err := cmd.Output()
	require.NoError(f.t, err)
	body.Write(pack)
	return body.Bytes()
}

func pushAs(t *testing.T, f *laneHTTPFixture, user string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	return postReceivePack(t, f, body, "X-Smithers-Pusher-Id", user)
}

func userRefRequest(t *testing.T, f *laneHTTPFixture, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(encoded)
	}
	req := httptest.NewRequest(method, "/repos/alice:demo/user-refs/"+path, reader)
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.srv.Handler().ServeHTTP(rec, req)
	return rec
}

func withUserRefClock(t *testing.T, at time.Time) {
	t.Helper()
	previous := userRefNow
	userRefNow = func() time.Time { return at }
	t.Cleanup(func() { userRefNow = previous })
}

func TestUserRefLimitRefusesOnlyAnAddedRefPastTheCap(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	f.srv.config.UserRefLimit = 2
	tip := f.commit("local work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("work\n"), 0o644))
	})
	for _, name := range []string{"head", "spike"} {
		rec := pushAs(t, f, "42", f.userRefPush(laneZeroOID, tip, repohost.UserRef(42, name)))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}
	rec := pushAs(t, f, "42", f.userRefPush(laneZeroOID, tip, repohost.UserRef(42, "third")))
	require.Equal(t, http.StatusForbidden, rec.Code)
	assert.Contains(t, rec.Body.String(), "at most 2 refs")
	assert.NotContains(t, f.repo.refs(), repohost.UserRef(42, "third"))

	// Another user has a separate allowance.
	rec = pushAs(t, f, "43", f.userRefPush(laneZeroOID, tip, repohost.UserRef(43, "head")))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	// Moving and deleting are never refused; a freed slot can be reused.
	next := f.commit("more work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("more\n"), 0o644))
	})
	rec = pushAs(t, f, "42", f.userRefPush(tip, next, repohost.UserRef(42, "head")))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = pushAs(t, f, "42", f.userRefPush(tip, laneZeroOID, repohost.UserRef(42, "spike")))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = pushAs(t, f, "42", f.userRefPush(laneZeroOID, next, repohost.UserRef(42, "third")))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

func TestUserRefPushPackIsCapped(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	f.srv.config.UserRefMaxPushBytes = 64 << 10
	noise := make([]byte, 512<<10)
	_, err := rand.Read(noise)
	require.NoError(t, err)
	tip := f.commit("large", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "large.bin"), noise, 0o644))
	})
	ref := repohost.UserRef(42, "head")
	rec := pushAs(t, f, "42", f.userRefPush(laneZeroOID, tip, ref))
	assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
	assert.Equal(t, "user_ref_push_too_large", rec.Header().Get("X-Smithers-Error-Code"))
	assert.NotContains(t, f.repo.refs(), ref)

	// The cap is for user refs only: the same pack to a branch lands.
	rec = pushAs(t, f, "42", f.userRefPush(laneZeroOID, tip, "refs/heads/large"))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, tip, f.repo.refs()["refs/heads/large"])
}

func TestUserRefsExpireAfterTheirTTL(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	start := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	withUserRefClock(t, start)
	tip := f.commit("local work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("work\n"), 0o644))
	})
	for _, name := range []string{"head", "old"} {
		rec := pushAs(t, f, "42", f.userRefPush(laneZeroOID, tip, repohost.UserRef(42, name)))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}

	rec := userRefRequest(t, f, http.MethodGet, "42", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var listed repohost.UserRefList
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &listed))
	require.Len(t, listed.Refs, 2)
	assert.Equal(t, "head", listed.Refs[0].Name)
	assert.Equal(t, tip, listed.Refs[0].CommitID)
	assert.Equal(t, start, listed.Refs[0].PushedAt)
	assert.Equal(t, start.Add(repohost.DefaultUserRefTTL), listed.Refs[0].ExpiresAt)
	assert.Equal(t, repohost.DefaultUserRefLimit, listed.Limit)
	assert.Equal(t, int64(repohost.DefaultUserRefTTL/time.Second), listed.TTLSeconds)

	// A later push renews only the ref it writes.
	withUserRefClock(t, start.Add(20*24*time.Hour))
	next := f.commit("more work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("more\n"), 0o644))
	})
	rec = pushAs(t, f, "42", f.userRefPush(tip, next, repohost.UserRef(42, "head")))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	// Past the old ref's TTL the sweep deletes it from git and the index.
	withUserRefClock(t, start.Add(repohost.DefaultUserRefTTL+time.Hour))
	f.srv.sweepUserRefs(t.Context())
	refs := f.repo.refs()
	assert.NotContains(t, refs, repohost.UserRef(42, "old"))
	assert.Equal(t, next, refs[repohost.UserRef(42, "head")])
	index, err := readUserRefIndex(f.repo.gitDir)
	require.NoError(t, err)
	assert.Equal(t, map[string]int64{repohost.UserRef(42, "head"): start.Add(20 * 24 * time.Hour).Unix()}, index)

	// Once every ref is gone the index goes with them.
	withUserRefClock(t, start.Add(60*24*time.Hour))
	rec = userRefRequest(t, f, http.MethodGet, "42", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &listed))
	assert.Empty(t, listed.Refs)
	_, err = os.Stat(filepath.Join(f.repo.gitDir, userRefIndexFile))
	assert.ErrorIs(t, err, os.ErrNotExist)
}

func TestExpiredUserRefsFreeTheirSlotAtTheNextPush(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	f.srv.config.UserRefLimit = 1
	start := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	withUserRefClock(t, start)
	tip := f.commit("local work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("work\n"), 0o644))
	})
	rec := pushAs(t, f, "42", f.userRefPush(laneZeroOID, tip, repohost.UserRef(42, "old")))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	withUserRefClock(t, start.Add(repohost.DefaultUserRefTTL))
	rec = pushAs(t, f, "42", f.userRefPush(laneZeroOID, tip, repohost.UserRef(42, "new")))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	refs := f.repo.refs()
	assert.NotContains(t, refs, repohost.UserRef(42, "old"))
	assert.Equal(t, tip, refs[repohost.UserRef(42, "new")])
}

func TestRetainUserRefPinsItsCommitForTheWorkspace(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	tip := f.commit("local work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("work\n"), 0o644))
	})
	rec := pushAs(t, f, "42", f.userRefPush(laneZeroOID, tip, repohost.UserRef(42, "head")))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	request := repohost.RetainUserRefRequest{Name: "head", WorkspaceID: userRefWorkspace}
	for range 2 {
		rec = userRefRequest(t, f, http.MethodPost, "42/retain", request)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}
	var retained repohost.RetainedUserRef
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &retained))
	assert.Equal(t, repohost.WorkspaceSourceRef(userRefWorkspace, tip), retained.SourceRef)
	assert.Equal(t, tip, retained.CommitID)
	assert.Equal(t, "head", retained.Name)
	assert.Equal(t, tip, f.repo.refs()[retained.SourceRef])

	// Another user's namespace holds no such ref.
	rec = userRefRequest(t, f, http.MethodPost, "43/retain", request)
	require.Equal(t, http.StatusNotFound, rec.Code)
	assert.Contains(t, rec.Body.String(), "user_ref_missing")

	for _, bad := range []repohost.RetainUserRefRequest{
		{Name: "../head", WorkspaceID: userRefWorkspace},
		{Name: "head", WorkspaceID: "not-a-uuid"},
	} {
		rec = userRefRequest(t, f, http.MethodPost, "42/retain", bad)
		assert.Equal(t, http.StatusBadRequest, rec.Code, "%+v", bad)
	}
	rec = userRefRequest(t, f, http.MethodGet, "042", nil)
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	// The pinned source outlives the user ref's expiry.
	withUserRefClock(t, time.Now().Add(repohost.DefaultUserRefTTL+time.Hour))
	f.srv.sweepUserRefs(t.Context())
	refs := f.repo.refs()
	assert.NotContains(t, refs, repohost.UserRef(42, "head"))
	assert.Equal(t, tip, refs[retained.SourceRef])
}

func TestUserRefBoundsFromEnv(t *testing.T) {
	t.Setenv("SMITHERS_USER_REF_LIMIT", "5")
	t.Setenv("SMITHERS_USER_REF_MAX_PUSH_BYTES", "1048576")
	t.Setenv("SMITHERS_USER_REF_TTL", "168h")
	var cfg Config
	require.NoError(t, userRefBoundsFromEnv(&cfg))
	policy := cfg.userRefPolicy()
	assert.Equal(t, userRefPolicy{limit: 5, maxPushBytes: 1 << 20, ttl: 7 * 24 * time.Hour}, policy)
	assert.Equal(t, userRefPolicy{limit: repohost.DefaultUserRefLimit, maxPushBytes: repohost.DefaultUserRefMaxPushBytes, ttl: repohost.DefaultUserRefTTL}, Config{}.userRefPolicy())
	for key, value := range map[string]string{"SMITHERS_USER_REF_LIMIT": "0", "SMITHERS_USER_REF_MAX_PUSH_BYTES": "999999999999", "SMITHERS_USER_REF_TTL": "soon"} {
		t.Run(key, func(t *testing.T) {
			t.Setenv(key, value)
			assert.Error(t, userRefBoundsFromEnv(&Config{}))
		})
	}
}

func TestRenewUserRefRestartsItsTTL(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	start := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	withUserRefClock(t, start)
	tip := f.commit("local work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("work\n"), 0o644))
	})
	rec := pushAs(t, f, "42", f.userRefPush(laneZeroOID, tip, repohost.UserRef(42, "head")))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	renewed := start.Add(25 * 24 * time.Hour)
	withUserRefClock(t, renewed)
	rec = userRefRequest(t, f, http.MethodPost, "42/renew", map[string]string{"name": "head"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var info repohost.UserRefInfo
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &info))
	assert.Equal(t, renewed.Add(repohost.DefaultUserRefTTL), info.ExpiresAt)

	withUserRefClock(t, start.Add(repohost.DefaultUserRefTTL+time.Hour))
	f.srv.sweepUserRefs(t.Context())
	assert.Equal(t, tip, f.repo.refs()[repohost.UserRef(42, "head")])

	rec = userRefRequest(t, f, http.MethodPost, "42/renew", map[string]string{"name": "gone"})
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestForkLeavesUserRefsBehind(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	tip := f.commit("local work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("work\n"), 0o644))
	})
	rec := pushAs(t, f, "42", f.userRefPush(laneZeroOID, tip, repohost.UserRef(42, "head")))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	body, err := json.Marshal(forkRepoRequest{SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "demo"})
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/repos/fork", bytes.NewReader(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	f.srv.Handler().ServeHTTP(res, req)
	require.Equal(t, http.StatusCreated, res.Code, res.Body.String())

	forked := f.srv.config.GitBackendPath("bob", "demo")
	refs, err := listGitRefs(t.Context(), forked)
	require.NoError(t, err)
	assert.Equal(t, f.base, refs["refs/heads/main"])
	assert.NotContains(t, refs, repohost.UserRef(42, "head"))
	_, err = os.Stat(filepath.Join(forked, userRefIndexFile))
	assert.ErrorIs(t, err, os.ErrNotExist)
	assert.Equal(t, tip, f.repo.refs()[repohost.UserRef(42, "head")], "the source keeps its refs")
}

// Git still advertises an expired ref until it is deleted, so its owner's
// renewal and next push (with a lease on it) revive it instead of losing it.
func TestAnExpiredButAdvertisedRefIsRevivedByItsOwner(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	start := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	withUserRefClock(t, start)
	tip := f.commit("local work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("work\n"), 0o644))
	})
	ref := repohost.UserRef(42, "head")
	rec := pushAs(t, f, "42", f.userRefPush(laneZeroOID, tip, ref))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	renewed := start.Add(repohost.DefaultUserRefTTL + time.Hour)
	withUserRefClock(t, renewed)
	rec = userRefRequest(t, f, http.MethodPost, "42/renew", map[string]string{"name": "head"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var info repohost.UserRefInfo
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &info))
	assert.Equal(t, renewed.Add(repohost.DefaultUserRefTTL), info.ExpiresAt)
	assert.Equal(t, tip, f.repo.refs()[ref])

	withUserRefClock(t, renewed.Add(repohost.DefaultUserRefTTL+time.Hour))
	next := f.commit("more", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("more\n"), 0o644))
	})
	rec = pushAs(t, f, "42", f.userRefPush(tip, next, ref))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, next, f.repo.refs()[ref])
}

func TestACorruptIndexOnlyRestampsRefs(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	tip := f.commit("local work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("work\n"), 0o644))
	})
	rec := pushAs(t, f, "42", f.userRefPush(laneZeroOID, tip, repohost.UserRef(42, "head")))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, os.WriteFile(filepath.Join(f.repo.gitDir, userRefIndexFile), []byte("{not json"), 0o644))
	rec = userRefRequest(t, f, http.MethodGet, "42", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var listed repohost.UserRefList
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &listed))
	require.Len(t, listed.Refs, 1)
}

// packLen is the size of the pack in a userRefPush body: what follows its
// command section.
func (f *laneHTTPFixture) packLen(body []byte, ref string) int64 {
	f.t.Helper()
	return int64(len(body) - len(f.userRefPush(laneZeroOID, laneZeroOID, ref)))
}

// Issue #2344: the cap counts pack bytes, so a pack one byte over it gets the
// same 413 as one far over it, whatever the pipe timing, and a pack exactly
// at the cap lands.
func TestUserRefPushPackCapIsExact(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	noise := make([]byte, 512<<10)
	_, err := rand.Read(noise)
	require.NoError(t, err)
	tip := f.commit("large", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "large.bin"), noise, 0o644))
	})
	ref := repohost.UserRef(42, "head")
	body := f.userRefPush(laneZeroOID, tip, ref)
	pack := f.packLen(body, ref)
	// One byte over repeats: the pipe timing that once decided it varies.
	for _, maxPushBytes := range []int64{pack - 1, pack - 1, pack - 1, pack / 2, 1} {
		f.srv.config.UserRefMaxPushBytes = maxPushBytes
		rec := pushAs(t, f, "42", body)
		require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, "cap %d: %s", maxPushBytes, rec.Body.String())
		assert.Equal(t, "user_ref_push_too_large", rec.Header().Get("X-Smithers-Error-Code"))
		assert.NotContains(t, f.repo.refs(), ref)
	}
	f.srv.config.UserRefMaxPushBytes = pack
	rec := pushAs(t, f, "42", body)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, tip, f.repo.refs()[ref])
}

// Issue #2344: a push past the global cap is a 413, identity-encoded or
// gzipped, not a 500.
func TestPushPastTheGlobalCapIs413(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	f.srv.config.MaxGitRequestBytes = 64 << 10
	noise := make([]byte, 512<<10)
	_, err := rand.Read(noise)
	require.NoError(t, err)
	tip := f.commit("large", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "large.bin"), noise, 0o644))
	})
	body := f.userRefPush(laneZeroOID, tip, "refs/heads/large")
	var gzipped bytes.Buffer
	zw := gzip.NewWriter(&gzipped)
	_, err = zw.Write(body)
	require.NoError(t, err)
	require.NoError(t, zw.Close())

	for name, rec := range map[string]*httptest.ResponseRecorder{
		"identity": postReceivePack(t, f, body),
		"gzip":     postReceivePack(t, f, gzipped.Bytes(), "Content-Encoding", "gzip"),
	} {
		assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, "%s: %s", name, rec.Body.String())
		assert.Equal(t, "push_too_large", rec.Header().Get("X-Smithers-Error-Code"), name)
	}
	assert.NotContains(t, f.repo.refs(), "refs/heads/large")
}
