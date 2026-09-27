package repohostserver

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Git stores loose refs as files, so on a case-insensitive filesystem
// (macOS, Windows) refs/heads/Mythical is the file refs/heads/mythical.
// Repo-host refuses every ref that differs only in case from an existing
// one, on every platform, so no case variant reaches another ref.
func TestReceivePackRefusesCaseVariantRefs(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	updateRef := func(ref, oid string) {
		out, err := exec.Command("git", "--git-dir", f.repo.gitDir, "update-ref", ref, oid).CombinedOutput()
		require.NoError(t, err, string(out))
	}
	updateRef("refs/heads/mythical", f.base)
	tip := f.commit("work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("work\n"), 0o644))
	})

	// An update of the variant: on a case-insensitive filesystem git reads
	// mythical's value as the variant's old value.
	rec := postReceivePack(t, f, f.pushBody(f.base, tip, "refs/heads/Mythical"))
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	assert.Equal(t, f.base, f.repo.refs()["refs/heads/mythical"], "a case variant overwrote mythical")

	for _, ref := range []string{"refs/heads/MAIN", "refs/heads/Main"} {
		create := f.pushBody(f.base, tip, ref)
		copy(create[4:44], laneZeroOID)
		rec = postReceivePack(t, f, create)
		require.Equal(t, http.StatusConflict, rec.Code, "%s: %s", ref, rec.Body.String())
		assert.Equal(t, f.base, f.repo.refs()["refs/heads/main"], "%s overwrote main", ref)
		_, stored := f.repo.refs()[ref]
		assert.False(t, stored, "%s was created", ref)
	}

	create := f.pushBody(f.base, tip, "refs/heads/feature")
	copy(create[4:44], laneZeroOID)
	rec = postReceivePack(t, f, create)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	next := f.commit("more work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("more\n"), 0o644))
	})
	rec = postReceivePack(t, f, f.pushBody(tip, next, "refs/heads/Feature"))
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	assert.Equal(t, tip, f.repo.refs()["refs/heads/feature"], "a case variant moved feature")
	rec = postReceivePack(t, f, f.pushBody(tip, next, "refs/heads/feature"))
	require.Equal(t, http.StatusOK, rec.Code, "the exact ref still updates: %s", rec.Body.String())
}

// The bookmark API is the other way a bookmark comes to exist; it refuses a
// case variant of an existing ref before jj records it.
func TestCreateBookmarkRefusesCaseVariant(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	for _, name := range []string{"Main", "MAIN"} {
		req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/bookmarks",
			bytes.NewBufferString(`{"name":"`+name+`","target_change_id":"abc"}`))
		req.Header.Set("Authorization", validAuth())
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		f.srv.Handler().ServeHTTP(rec, req)
		assert.Equal(t, http.StatusConflict, rec.Code, "%s: %s", name, rec.Body.String())
	}
}
