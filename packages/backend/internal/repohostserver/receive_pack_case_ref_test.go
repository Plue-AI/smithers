package repohostserver

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

// The existing fixture mocks only the jj FFI: this regression exercises the
// HTTP planner and real packed Git refs, and must perform no repair/import.
func TestRepairCaseCollisionsPreservesCanonicalDirectory(t *testing.T) {
	for _, name := range []string{"Main", "main"} {
		for _, present := range []bool{false, true} {
			t.Run(fmt.Sprintf("default=%s/present=%t", name, present), func(t *testing.T) {
				f := newLaneHTTPFixture(t, nil)
				git := func(args ...string) {
					out, err := exec.Command("git", append([]string{"--git-dir", f.repo.gitDir}, args...)...).CombinedOutput()
					require.NoError(t, err, string(out))
				}
				git("update-ref", "-d", "refs/heads/main")
				git("symbolic-ref", "HEAD", "refs/heads/"+name)
				packed := map[string]string{"refs/heads/Main/x": f.base, "refs/heads/main/x": f.base}
				if present {
					packed["refs/heads/"+name] = f.base
				}
				(&caseRepo{t: t, gitDir: f.repo.gitDir}).write(nil, packed)
				before := f.repo.refs()
				for i := 0; i < 2; i++ {
					rec := serveCaseRef(t, f, http.MethodPost, "/ref-case-collisions/repair", `{}`)
					require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
					var report repohost.RefCaseCollisionReport
					require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &report))
					require.Equal(t, []repohost.RefCaseCollision{{Refs: []string{"refs/heads/Main/x", "refs/heads/main/x"}, Action: repohost.RefCaseCollisionReported}}, report.Collisions)
					require.Equal(t, before, f.repo.refs(), "both directory refs and all other refs remain")
					require.Empty(t, f.imports, "a reported collision performs no repair")
				}
			})
		}
	}
}

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

// serveCaseRef posts a JSON repo-host API request for alice/demo.
func serveCaseRef(t *testing.T, f *laneHTTPFixture, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/repos/alice%3Ademo"+path, bytes.NewBufferString(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.srv.Handler().ServeHTTP(rec, req)
	return rec
}

// A bookmark jj created but never exported (the export failed) still counts:
// the bookmark API, a landing target and the default bookmark refuse its case
// variants.
func TestBookmarkWritesRefuseCaseVariantOfJJBookmark(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	mock := f.srv.ffi.(*mockFFI)
	mock.createBookmarkFn = func(_, name, _ string) (repohost.Bookmark, error) {
		f.repo.jj("bookmark", "create", name, "-r", "main")
		return repohost.Bookmark{Name: name}, nil
	}
	mock.exportGitRefsFn = func(string) error { return errors.New("export failed") }
	mock.listBookmarksFn = func(string, uint32, uint32) (repohostffi.Paginated[repohost.Bookmark], error) {
		var items []repohost.Bookmark
		for _, name := range strings.Fields(f.repo.jj("bookmark", "list", "-T", `name ++ "\n"`)) {
			items = append(items, repohost.Bookmark{Name: name})
		}
		return repohostffi.Paginated[repohost.Bookmark]{Items: items, TotalCount: len(items)}, nil
	}
	landed := 0
	mock.landChangesFn = func(string, repohost.LandRequest) (repohost.LandResult, error) {
		landed++
		return repohost.LandResult{}, nil
	}

	rec := serveCaseRef(t, f, http.MethodPost, "/bookmarks", `{"name":"foo","target_change_id":"abc"}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	_, exported := f.repo.refs()["refs/heads/foo"]
	require.False(t, exported, "the fixture must leave foo unexported")
	rec = serveCaseRef(t, f, http.MethodPost, "/bookmarks", `{"name":"Foo","target_change_id":"abc"}`)
	assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "differ only in case")

	for _, target := range []string{"Main", "FOO"} {
		rec = serveCaseRef(t, f, http.MethodPost, "/land", fmt.Sprintf(`{"change_ids":["abc"],"target_bookmark":%q}`, target))
		assert.Equal(t, http.StatusConflict, rec.Code, "land %s: %s", target, rec.Body.String())
		rec = serveCaseRef(t, f, http.MethodPut, "/default-bookmark", fmt.Sprintf(`{"name":%q}`, target))
		assert.Equal(t, http.StatusConflict, rec.Code, "default %s: %s", target, rec.Body.String())
	}
	assert.Zero(t, landed, "a refused landing reached jj")
	rec = serveCaseRef(t, f, http.MethodPost, "/land", `{"change_ids":["abc"],"target_bookmark":"main"}`)
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = serveCaseRef(t, f, http.MethodPut, "/default-bookmark", `{"name":"main"}`)
	assert.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
}

// The stack service's own push of mythical and its notes, which share no
// spelling with another ref, still creates and updates both.
func TestControlPlaneMythicalPushStillWrites(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	tip := f.commit("stack", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "stack.txt"), []byte("1\n"), 0o644))
	})
	next := f.commit("stack 2", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "stack.txt"), []byte("2\n"), 0o644))
	})
	push := func(old, packBase, newOID string) *httptest.ResponseRecorder {
		body := f.pushBody(packBase, newOID, "refs/heads/mythical")
		copy(body[4:44], old)
		second := fmt.Sprintf("%s %s refs/notes/mythical\n", old, newOID)
		command := fmt.Sprintf("%04x%s", len(second)+4, second)
		var end int
		_, err := fmt.Sscanf(string(body[:4]), "%04x", &end)
		require.NoError(t, err)
		body = append(append(append([]byte{}, body[:end]...), command...), body[end:]...)
		return postReceivePack(t, f, body, "X-Smithers-Control-Plane", "mythical")
	}
	rec := push(laneZeroOID, f.base, tip)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = push(tip, tip, next)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	refs := f.repo.refs()
	assert.Equal(t, next, refs["refs/heads/mythical"])
	assert.Equal(t, next, refs["refs/notes/mythical"])
}

func TestInvisibleCharacterRefRefused(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	tip := f.commit("work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("w\n"), 0o644))
	})
	create := f.pushBody(f.base, tip, "refs/heads/ma\u200cin")
	copy(create[4:44], laneZeroOID)
	rec := postReceivePack(t, f, create)
	assert.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
}
