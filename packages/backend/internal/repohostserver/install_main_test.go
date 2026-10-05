package repohostserver

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// installCommand is one receive-pack ref update.
type installCommand struct{ old, new, ref string }

// multiPushBody builds one receive-pack request of several commands and a
// pack of everything their new commits reach beyond their old ones.
func multiPushBody(t *testing.T, f *laneHTTPFixture, commands ...installCommand) []byte {
	t.Helper()
	var body bytes.Buffer
	var revs strings.Builder
	for i, command := range commands {
		line := fmt.Sprintf("%s %s %s", command.old, command.new, command.ref)
		if i == 0 {
			line += "\x00report-status atomic"
		}
		line += "\n"
		fmt.Fprintf(&body, "%04x%s", len(line)+4, line)
		if command.new != laneZeroOID {
			revs.WriteString(command.new + "\n")
		}
		if command.old != laneZeroOID {
			revs.WriteString("^" + command.old + "\n")
		}
	}
	body.WriteString("0000")
	cmd := exec.Command("git", "-C", f.clientDir, "pack-objects", "--revs", "--stdout", "-q")
	cmd.Stdin = strings.NewReader(revs.String())
	pack, err := cmd.Output()
	require.NoError(t, err)
	body.Write(pack)
	return body.Bytes()
}

func installFixture(t *testing.T, defaultBookmark string) (*laneHTTPFixture, string) {
	t.Helper()
	f := newLaneHTTPFixture(t, nil)
	f.srv.config.InstallMainMirror = true
	require.NoError(t, setGitDefaultBookmark(context.Background(), f.repo.gitDir, defaultBookmark))
	tip := f.commit("reviewed", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "reviewed.txt"), []byte("reviewed\n"), 0o644))
	})
	return f, tip
}

// One request that updates a feature bookmark and main is refused whole, and
// a case or Unicode alias of main or of the default bookmark is main.
func TestReceivePackInstallMainRefusesMultiRefAndAliases(t *testing.T) {
	f, tip := installFixture(t, "trunk")
	setup := postReceivePack(t, f, f.pushBody(laneZeroOID, f.base, "refs/heads/trunk"), repohost.PusherCredentialHeader, "sync")
	require.Equal(t, http.StatusOK, setup.Code, setup.Body.String())
	for _, kind := range []string{"person", "run", "machine", "platform", ""} {
		for _, ref := range []string{"refs/heads/main", "refs/heads/MAIN", "refs/heads/ma‌in", "refs/Heads/main",
			"refs/heads/trunk", "refs/heads/Trunk", "refs/heads/tr‍unk"} {
			t.Run(kind+"/"+ref, func(t *testing.T) {
				old := f.repo.refs()[ref]
				if old == "" {
					old = laneZeroOID
				}
				rec := postReceivePack(t, f, multiPushBody(t, f,
					installCommand{laneZeroOID, tip, "refs/heads/feature-" + kind},
					installCommand{old, tip, ref}), repohost.PusherCredentialHeader, kind)
				require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
				assert.Equal(t, "permission", rec.Header().Get("X-Smithers-Error-Code"))
				refs := f.repo.refs()
				assert.Equal(t, f.base, refs["refs/heads/main"])
				assert.Equal(t, f.base, refs["refs/heads/trunk"])
				assert.NotContains(t, refs, "refs/heads/feature-"+kind, "a refused push writes none of its refs")
			})
		}
	}
	rec := postReceivePack(t, f, multiPushBody(t, f,
		installCommand{laneZeroOID, tip, "refs/heads/feature"},
		installCommand{laneZeroOID, tip, "refs/heads/topic"}), repohost.PusherCredentialHeader, "person")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, tip, f.repo.refs()["refs/heads/topic"])
	rec = postReceivePack(t, f, f.pushBody(f.base, tip, "refs/heads/trunk"), repohost.PusherCredentialHeader, "sync")
	require.Equal(t, http.StatusOK, rec.Code, "the sync fast-forwards the default bookmark: %s", rec.Body.String())
	assert.Equal(t, tip, f.repo.refs()["refs/heads/trunk"])
}

// git receive-pack writes through a symbolic ref, so an existing alias of
// main is main. The alias is resolved under the repository write lock.
func TestReceivePackInstallMainRefusesSymbolicAlias(t *testing.T) {
	for _, install := range []bool{true, false} {
		t.Run(fmt.Sprintf("install=%v", install), func(t *testing.T) {
			f, tip := installFixture(t, "main")
			f.srv.config.InstallMainMirror = install
			for alias, target := range map[string]string{
				"refs/heads/alias":   "refs/heads/main",
				"refs/heads/hop":     "refs/heads/alias",
				"refs/tags/main-tag": "refs/heads/main",
			} {
				out, err := exec.Command("git", "--git-dir", f.repo.gitDir, "symbolic-ref", alias, target).CombinedOutput()
				require.NoError(t, err, string(out))
			}
			for _, ref := range []string{"refs/heads/alias", "refs/heads/hop", "refs/heads/ALIAS", "refs/tags/main-tag"} {
				rec := postReceivePack(t, f, f.pushBody(f.base, tip, ref), repohost.PusherCredentialHeader, "person")
				if install {
					require.Equal(t, http.StatusForbidden, rec.Code, "%s: %s", ref, rec.Body.String())
					assert.Equal(t, "permission", rec.Header().Get("X-Smithers-Error-Code"), ref)
					assert.Equal(t, f.base, f.repo.refs()["refs/heads/main"], "%s moved main", ref)
				}
			}
			if !install {
				// Hosted repositories keep git's own behavior: the alias
				// writes the ref it names.
				assert.Equal(t, tip, f.repo.refs()["refs/heads/main"])
				return
			}
			// HEAD names main too, and bare names are not refs: git itself
			// refuses both, so neither writes main.
			for _, ref := range []string{"HEAD", "main"} {
				postReceivePack(t, f, f.pushBody(f.base, tip, ref), repohost.PusherCredentialHeader, "person")
				assert.Equal(t, f.base, f.repo.refs()["refs/heads/main"], "%s moved main", ref)
			}
		})
	}
}

// On an install the sync fast-forwards main and the default bookmark but
// never rewinds or deletes them: a GitHub rewrite waits for the owner's
// reset (§12.3) and leaves main where it was. Other refs follow GitHub as
// they are, and hosted repositories keep the sync's exemption.
func TestReceivePackInstallSyncOnlyFastForwardsMain(t *testing.T) {
	for _, defaultBookmark := range []string{"main", "trunk"} {
		t.Run(defaultBookmark, func(t *testing.T) {
			f, tip := installFixture(t, defaultBookmark)
			if defaultBookmark != "main" {
				rec := postReceivePack(t, f, f.pushBody(laneZeroOID, f.base, "refs/heads/"+defaultBookmark), repohost.PusherCredentialHeader, "sync")
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			}
			// Git refuses to delete the branch HEAD names; jj export can detach
			// HEAD, and then only the persisted default protects it.
			require.NoError(t, os.WriteFile(filepath.Join(f.repo.gitDir, "HEAD"), []byte(f.base+"\n"), 0o644))
			f.git("reset", "-q", "--hard", f.base)
			rewrite := f.commit("rewritten on GitHub", func(dir string) {
				require.NoError(t, os.WriteFile(filepath.Join(dir, "reviewed.txt"), []byte("rewritten\n"), 0o644))
			})
			refs := []string{"refs/heads/main"}
			if defaultBookmark != "main" {
				refs = append(refs, "refs/heads/"+defaultBookmark)
			}
			for _, ref := range refs {
				rec := postReceivePack(t, f, f.pushBody(f.base, tip, ref), repohost.PusherCredentialHeader, "sync")
				require.Equal(t, http.StatusOK, rec.Code, "%s fast-forward: %s", ref, rec.Body.String())
				for _, op := range []struct{ name, new string }{{"rewrite", rewrite}, {"delete", laneZeroOID}} {
					rec = postReceivePack(t, f, f.pushBody(tip, op.new, ref), repohost.PusherCredentialHeader, "sync")
					require.Equal(t, http.StatusForbidden, rec.Code, "%s %s: %s", ref, op.name, rec.Body.String())
					assert.Equal(t, tip, f.repo.refs()[ref], "%s %s moved it", ref, op.name)
				}
			}
			rec := postReceivePack(t, f, f.pushBody(laneZeroOID, tip, "refs/heads/feature"), repohost.PusherCredentialHeader, "sync")
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			rec = postReceivePack(t, f, f.pushBody(tip, rewrite, "refs/heads/feature"), repohost.PusherCredentialHeader, "sync")
			require.Equal(t, http.StatusOK, rec.Code, "the sync rewrites other refs as GitHub does: %s", rec.Body.String())

			f.srv.config.InstallMainMirror = false
			rec = postReceivePack(t, f, f.pushBody(tip, rewrite, "refs/heads/main"), repohost.PusherCredentialHeader, "sync")
			require.Equal(t, http.StatusOK, rec.Code, "hosted sync copies GitHub's rewrite: %s", rec.Body.String())
			assert.Equal(t, rewrite, f.repo.refs()["refs/heads/main"])
		})
	}
}

// installJSON serves one repo-host JSON request.
func installJSON(t *testing.T, f *laneHTTPFixture, method, path, body string) (int, string, string) {
	t.Helper()
	rec := serveCaseRef(t, f, method, path, body)
	return rec.Code, rec.Header().Get("X-Smithers-Error-Code"), rec.Body.String()
}

// No JSON route carries the sync's authority: on an install, creating,
// moving or deleting main or the default bookmark through the bookmark or
// landing routes is refused before the engine is called, whatever the name's
// spelling. The import's create-if-absent neither moves nor deletes.
func TestInstallMainJSONWritesAreRefused(t *testing.T) {
	for _, install := range []bool{true, false} {
		t.Run(fmt.Sprintf("install=%v", install), func(t *testing.T) {
			f, _ := installFixture(t, "trunk")
			f.srv.config.InstallMainMirror = install
			mock := f.srv.ffi.(*mockFFI)
			calls := map[string]int{}
			mock.createBookmarkFn = func(_, name, _ string) (repohost.Bookmark, error) {
				calls["create"]++
				return repohost.Bookmark{Name: name}, nil
			}
			mock.createBookmarkIfAbsentFn = func(_, name, _ string) (repohost.Bookmark, error) {
				calls["if_absent"]++
				return repohost.Bookmark{Name: name}, nil
			}
			var deleted []string
			mock.deleteBookmarkFn = func(_, name string) error {
				calls["delete"]++
				deleted = append(deleted, name)
				return nil
			}
			mock.getBookmarkFn = func(string, string) (*repohost.Bookmark, error) {
				return &repohost.Bookmark{Name: "main", TargetCommitID: f.base}, nil
			}
			mock.landChangesFn = func(string, repohost.LandRequest) (repohost.LandResult, error) {
				calls["land"]++
				return repohost.LandResult{}, nil
			}
			expected := `"` + f.base + `"`
			for _, name := range []string{"main", "MAIN", "ma‌in", "trunk", "Trunk", "tr‍unk"} {
				encoded := strings.ReplaceAll(name, "‌", "%E2%80%8C")
				encoded = strings.ReplaceAll(encoded, "‍", "%E2%80%8D")
				for _, write := range []struct{ method, path, body string }{
					{http.MethodPost, "/bookmarks", `{"name":"` + name + `","target_change_id":"x"}`},
					{http.MethodPost, "/bookmarks", `{"name":"` + name + `","target_change_id":"x","expected_commit_id":` + expected + `}`},
					{http.MethodPost, "/bookmarks", `{"name":"` + name + `","delete":true,"expected_commit_id":` + expected + `}`},
					{http.MethodPost, "/bookmarks", `{"name":"` + name + `","delete":true,"if_absent":true,"expected_commit_id":` + expected + `}`},
					{http.MethodDelete, "/bookmarks/" + encoded, ``},
					{http.MethodPost, "/land", `{"change_ids":["x"],"target_bookmark":"` + name + `"}`},
					{http.MethodPost, "/land/append", `{"change_ids":["x"],"target_bookmark":"` + name + `","append":{"source_commit_id":"` + f.base + `","source_base_commit_id":"` + f.base + `"}}`},
				} {
					before := fmt.Sprint(calls)
					code, errCode, body := installJSON(t, f, write.method, write.path, write.body)
					if install {
						require.Equal(t, http.StatusForbidden, code, "%s %s %s: %s", write.method, write.path, write.body, body)
						assert.Equal(t, "permission", errCode)
						assert.Contains(t, body, `"class":"permission"`)
						assert.Equal(t, before, fmt.Sprint(calls), "%s %s reached the engine", write.method, write.body)
					} else if name == "main" || name == "trunk" {
						assert.NotEqual(t, http.StatusForbidden, code, "hosted %s %s %s: %s", write.method, write.path, write.body, body)
					}
				}
			}
			// The import's create-if-absent and every other bookmark remain.
			code, _, body := installJSON(t, f, http.MethodPost, "/bookmarks", `{"name":"main","target_change_id":"x","if_absent":true}`)
			require.Equal(t, http.StatusCreated, code, body)
			assert.Equal(t, 1, calls["if_absent"])
			code, _, body = installJSON(t, f, http.MethodPost, "/bookmarks", `{"name":"feature","target_change_id":"x"}`)
			require.Equal(t, http.StatusCreated, code, body)
			// The guard and the engine read the same, decoded name.
			code, _, body = installJSON(t, f, http.MethodDelete, "/bookmarks/feature%2Fx", ``)
			require.Equal(t, http.StatusNoContent, code, body)
			assert.Equal(t, "feature/x", deleted[len(deleted)-1])
			code, _, body = installJSON(t, f, http.MethodPost, "/land", `{"change_ids":["x"],"target_bookmark":"feature"}`)
			require.Equal(t, http.StatusOK, code, body)
			// A receipt lookup writes nothing.
			code, _, body = installJSON(t, f, http.MethodPost, "/land/append", `{"change_ids":["x"],"target_bookmark":"main","lookup_only":true,"append":{"source_commit_id":"`+f.base+`","source_base_commit_id":"`+f.base+`"}}`)
			require.Equal(t, http.StatusOK, code, body)
		})
	}
}

// A JSON bookmark write fails closed when the install's default bookmark
// cannot be read: main could not be told apart.
func TestInstallMainJSONWriteUnreadableDefaultFailsClosed(t *testing.T) {
	f, _ := installFixture(t, "main")
	require.NoError(t, os.Remove(filepath.Join(f.repo.gitDir, "smithers-default-bookmark")))
	require.NoError(t, os.WriteFile(filepath.Join(f.repo.gitDir, "HEAD"), []byte(f.base+"\n"), 0o644))
	mock := f.srv.ffi.(*mockFFI)
	created := 0
	mock.createBookmarkFn = func(_, name, _ string) (repohost.Bookmark, error) {
		created++
		return repohost.Bookmark{Name: name}, nil
	}
	code, errCode, body := installJSON(t, f, http.MethodPost, "/bookmarks", `{"name":"feature","target_change_id":"x"}`)
	require.Equal(t, http.StatusForbidden, code, body)
	assert.Equal(t, "permission", errCode)
	assert.Contains(t, body, "default bookmark cannot be read")
	assert.Zero(t, created)
}

// The install's default bookmark is GitHub's default branch: naming another
// would hand the sync's ref to every writer, so only a no-op is accepted.
func TestInstallMainDefaultBookmarkCannotBeRenamed(t *testing.T) {
	for _, install := range []bool{true, false} {
		t.Run(fmt.Sprintf("install=%v", install), func(t *testing.T) {
			f, _ := installFixture(t, "main")
			f.srv.config.InstallMainMirror = install
			code, errCode, body := installJSON(t, f, http.MethodPut, "/default-bookmark", `{"name":"feature"}`)
			current, err := gitDefaultBookmark(context.Background(), f.repo.gitDir)
			require.NoError(t, err)
			if install {
				require.Equal(t, http.StatusForbidden, code, body)
				assert.Equal(t, "permission", errCode)
				assert.Equal(t, "main", current)
				code, _, body = installJSON(t, f, http.MethodPut, "/default-bookmark", `{"name":"main"}`)
				require.Equal(t, http.StatusNoContent, code, body)
				return
			}
			require.Equal(t, http.StatusNoContent, code, body)
			assert.Equal(t, "feature", current)
		})
	}
}

// Maintenance never creates or moves main on an install: a legacy variant
// that would be renamed into main, or removed beside it, is reported to the
// owner and every ref stays as it was. Hosted repositories still repair.
func TestRepairRefCaseCollisionsInstallLeavesMainToOwner(t *testing.T) {
	for _, install := range []bool{true, false} {
		for _, defaultBookmark := range []string{"main", "trunk"} {
			t.Run(fmt.Sprintf("install=%v/default=%s", install, defaultBookmark), func(t *testing.T) {
				f, _ := installFixture(t, defaultBookmark)
				f.srv.config.InstallMainMirror = install
				out, err := exec.Command("git", "--git-dir", f.repo.gitDir, "update-ref", "-d", "refs/heads/main").CombinedOutput()
				require.NoError(t, err, string(out))
				variant := "refs/heads/MAIN"
				if defaultBookmark == "trunk" {
					variant = "refs/heads/TRUNK"
				}
				(&caseRepo{t: t, gitDir: f.repo.gitDir}).write(nil, map[string]string{variant: f.base})
				before := f.repo.refs()
				rec := serveCaseRef(t, f, http.MethodPost, "/ref-case-collisions/repair", `{}`)
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
				canonical := "refs/heads/" + defaultBookmark
				if install {
					assert.Contains(t, rec.Body.String(), `"action":"reported"`)
					assert.Equal(t, before, f.repo.refs(), "the repair wrote a ref of main")
					assert.Empty(t, f.importedRefs())
					return
				}
				assert.Contains(t, rec.Body.String(), `"action":"renamed"`)
				assert.Equal(t, f.base, f.repo.refs()[canonical])
			})
		}
	}
}

func TestRefuseDefaultBookmarkRewindOnInstall(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	r := newCaseRepo(t, t.TempDir())
	require.NoError(t, setGitDefaultBookmark(context.Background(), r.gitDir, "trunk"))
	main, trunk, feature := "refs/heads/main", "refs/heads/trunk", "refs/heads/feature"
	for _, tc := range []struct {
		name          string
		before, after map[string]string
		install       bool
		refused       bool
	}{
		{"main rewound", map[string]string{main: r.b}, map[string]string{main: r.a}, true, true},
		{"main deleted", map[string]string{main: r.b}, map[string]string{}, true, true},
		{"main forward", map[string]string{main: r.a}, map[string]string{main: r.b}, true, false},
		{"MAIN rewound", map[string]string{"refs/heads/MAIN": r.b}, map[string]string{"refs/heads/MAIN": r.a}, true, true},
		{"default rewound", map[string]string{trunk: r.b}, map[string]string{trunk: r.a}, true, true},
		{"feature rewound", map[string]string{feature: r.b}, map[string]string{feature: r.a}, true, false},
		{"hosted main rewound beside another default", map[string]string{main: r.b}, map[string]string{main: r.a}, false, false},
		{"hosted default rewound", map[string]string{trunk: r.b}, map[string]string{trunk: r.a}, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := refuseDefaultBookmarkRewind(context.Background(), r.gitDir, tc.before, tc.after, tc.install)
			if tc.refused {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
		})
	}
}
