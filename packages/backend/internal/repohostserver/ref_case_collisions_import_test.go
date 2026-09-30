package repohostserver

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// Real Git refs exercise the HTTP repair; only the jj import is injected to
// force a failure that cannot reliably be produced with a healthy native store.
func TestRepairCaseCollisionsImportReceipt(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "failure"}[failed], func(t *testing.T) {
			var importErr error
			if failed {
				importErr = errors.New("injected import failure")
			}
			f := newLaneHTTPFixture(t, importErr)
			var logs bytes.Buffer
			f.srv.logger = slog.New(slog.NewJSONHandler(&logs, nil))
			(&caseRepo{t: t, gitDir: f.repo.gitDir}).write(nil, map[string]string{"refs/heads/Mythical": f.base})
			rec := httptest.NewRecorder()
			mock := f.srv.ffi.(*mockFFI)
			originalImport := mock.importGitRefsFn
			mock.importGitRefsFn = func(store string) error {
				require.Zero(t, rec.Body.Len(), "response emitted before import")
				return originalImport(store)
			}
			req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/ref-case-collisions/repair", bytes.NewBufferString(`{}`))
			req.Header.Set("Authorization", validAuth())
			req.Header.Set("Content-Type", "application/json")
			f.srv.Handler().ServeHTTP(rec, req)
			require.Len(t, f.imports, 1)
			require.NotContains(t, f.imports[0], "refs/heads/Mythical")
			if failed {
				require.Equal(t, http.StatusInternalServerError, rec.Code, rec.Body.String())
				require.Contains(t, rec.Body.String(), "failed to import repaired refs")
			} else {
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestRepairCaseCollisionsPartialFailureImports(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "import_success", true: "import_failure"}[failed], func(t *testing.T) {
			var importErr error
			if failed {
				importErr = errors.New("injected import failure")
			}
			f := newLaneHTTPFixture(t, importErr)
			var logs bytes.Buffer
			f.srv.logger = slog.New(slog.NewJSONHandler(&logs, nil))
			(&caseRepo{t: t, gitDir: f.repo.gitDir}).write(map[string]string{"refs/notes/Mythical": f.base}, map[string]string{"refs/heads/Mythical": f.base})
			require.NoError(t, os.WriteFile(filepath.Join(f.repo.gitDir, "refs/notes/Mythical.lock"), nil, 0600))
			rec := httptest.NewRecorder()
			mock := f.srv.ffi.(*mockFFI)
			originalImport := mock.importGitRefsFn
			mock.importGitRefsFn = func(store string) error {
				require.Zero(t, rec.Body.Len(), "response emitted before import")
				return originalImport(store)
			}
			req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/ref-case-collisions/repair", bytes.NewBufferString(`{}`))
			req.Header.Set("Authorization", validAuth())
			req.Header.Set("Content-Type", "application/json")
			f.srv.Handler().ServeHTTP(rec, req)
			require.Equal(t, http.StatusInternalServerError, rec.Code, rec.Body.String())
			require.Contains(t, rec.Body.String(), "failed to repair refs/notes/Mythical")
			require.Len(t, f.imports, 1)
			require.NotContains(t, f.imports[0], "refs/heads/Mythical")
			require.Contains(t, f.imports[0], "refs/notes/Mythical")
			if failed {
				require.Contains(t, logs.String(), "injected import failure")
				require.Contains(t, logs.String(), "file exists")
			}
		})
	}
}

// A legacy default must never turn a stack variant into control-plane data.
func TestRepairCaseCollisionsMythicalDefaultNeverAdoptsVariant(t *testing.T) {
	for _, name := range []string{"mythical", "Mythical"} {
		t.Run(name, func(t *testing.T) {
			f := newLaneHTTPFixture(t, nil)
			out, err := exec.Command("git", "--git-dir", f.repo.gitDir, "symbolic-ref", "HEAD", "refs/heads/"+name).CombinedOutput()
			require.NoError(t, err, string(out))
			(&caseRepo{t: t, gitDir: f.repo.gitDir}).write(nil, map[string]string{"refs/heads/MYTHICAL": f.base})
			rec := serveCaseRef(t, f, http.MethodPost, "/ref-case-collisions/repair", `{}`)
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			refs := f.repo.refs()
			require.NotContains(t, refs, "refs/heads/mythical")
			require.NotContains(t, refs, "refs/heads/Mythical")
			require.NotContains(t, refs, "refs/heads/MYTHICAL")
			require.Contains(t, rec.Body.String(), `"action":"removed"`)
			require.Contains(t, rec.Body.String(), `"canonical":"refs/heads/mythical"`)
		})
	}
}

func TestRepairCaseCollisionsUnchangedDoesNotImport(t *testing.T) {
	f := newLaneHTTPFixture(t, errors.New("must not import"))
	rec := serveCaseRef(t, f, http.MethodPost, "/ref-case-collisions/repair", `{}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Empty(t, f.imports)
	require.Contains(t, rec.Body.String(), `"collisions":null`)
}
