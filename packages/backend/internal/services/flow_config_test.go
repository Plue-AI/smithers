package services

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type configSource map[string]string

func (s configSource) ResolveSourceRevision(context.Context, string, string) (string, error) {
	return "89abcdef0123456789abcdef0123456789abcdef", nil
}
func (s configSource) ReadSourceFile(_ context.Context, _ workspaceapi.WorkspaceSource, name string) ([]byte, error) {
	if value, ok := s[name]; ok {
		return []byte(value), nil
	}
	return nil, fs.ErrNotExist
}

func TestInstallConfigLiteralDefaultsAndRetryPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	paths := []string{"README.md"}
	for i := 13; i >= 0; i-- {
		paths = append(paths, fmt.Sprintf("pkg%02d/index.ts", i))
	}
	source := configSource{"package.json": `{"packageManager":"pnpm@9.15.4","scripts":{"test":"vitest","lint":"eslint .","typecheck":"tsc","build":"tsc -b"}}`}
	require.NoError(t, PersistInstallCodingProject(t.Context(), pool, source, workspaceapi.WorkspaceSource{Repository: "owner/repo", Revision: "89abcdef0123456789abcdef0123456789abcdef"}, paths))
	raw, err := StoredCodingProject(t.Context(), db.New(pool))
	require.NoError(t, err)
	require.Contains(t, string(raw), `"/var/tmp/smithers/wiki"`)
	var project struct {
		Detected []struct {
			Argv []string `json:"argv"`
		} `json:"detected"`
		Pages []struct {
			ID string `json:"id"`
		} `json:"pages"`
	}
	require.NoError(t, json.Unmarshal(raw, &project))
	argv := [][]string{}
	for _, check := range project.Detected {
		argv = append(argv, check.Argv)
	}
	require.Equal(t, [][]string{{"pnpm", "test"}, {"pnpm", "lint"}, {"pnpm", "typecheck"}, {"pnpm", "build"}}, argv)
	ids := []string{}
	for _, page := range project.Pages {
		ids = append(ids, page.ID)
	}
	require.Equal(t, []string{"overview", "architecture", "package-pkg00", "package-pkg01", "package-pkg02", "package-pkg03", "package-pkg04", "package-pkg05", "package-pkg06", "package-pkg07"}, ids)
	require.NoError(t, PersistInstallCodingProject(t.Context(), pool, configSource{}, workspaceapi.WorkspaceSource{Repository: "owner/repo", Revision: "89abcdef0123456789abcdef0123456789abcdef"}, nil))
	retry, err := StoredCodingProject(t.Context(), db.New(pool))
	require.NoError(t, err)
	require.JSONEq(t, string(raw), string(retry))
}

func TestMergeCodingProjectFieldPrecedence(t *testing.T) {
	stored := []byte(`{"checks":[{"id":"test"}],"detected":[{"argv":["pnpm","test"]}],"wiki":true,"pages":[{"id":"overview"}],"seats":{"coding/implement":"auto","coding/review":"auto"}}`)
	merged, err := MergeCodingProject(stored, []byte(`{"checks":[{"id":"custom"}],"seats":{"coding/implement":"openai:gpt-6"}}`))
	require.NoError(t, err)
	require.JSONEq(t, `{"checks":[{"id":"custom"}],"wiki":true,"pages":[{"id":"overview"}],"seats":{"coding/implement":"openai:gpt-6","coding/review":"auto"}}`, string(merged))
	for _, input := range []string{"", "{", "null", "[]", `{"seats":null}`, `{"seats":[]}`} {
		_, err := MergeCodingProject(stored, []byte(input))
		require.ErrorContains(t, err, ".smithers/coding-project.json")
	}
	_, err = MergeCodingProject([]byte("null"), nil)
	require.Error(t, err)
}

func TestInstallStoredWikiDeclarationRefreshesWithoutRepositoryConfig(t *testing.T) {
	o := newMythicalOrchestration(t)
	o.service.SetWiki(&fakeWikiStore{pages: map[string]WikiPageResponse{}})
	require.NoError(t, db.New(o.pool).UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: InstallCodingProjectKey, Value: []byte(`{"wiki":true,"pages":[{"id":"overview"},{"id":"architecture"},{"id":"package-api"}]}`)}))
	stack := o.wake()
	request := o.launcher.last(mythicalWikiFlow)
	require.Equal(t, mythicalWikiBindingKind, request.Target.BindingKind)
	require.Equal(t, "running", o.wiki().State)
	var payload struct {
		Base struct {
			CommitID string `json:"commitId"`
		} `json:"base"`
	}
	require.NoError(t, json.Unmarshal(request.Payload, &payload))
	require.Equal(t, stack.TipCommit, payload.Base.CommitID)
	// An explicit repository field disables the stored declaration next fold.
	require.NoError(t, os.MkdirAll(filepath.Join(o.work, ".smithers"), 0700))
	o.commit("disable generated wiki", ".smithers/coding-project.json", `{"wiki":false}`)
	o.publish()
	o.wake()
	// A previously admitted refresh retains its own input; no second run launches.
	require.Len(t, o.launcher.requests, 1)
}

func TestInstallBuildOnlyDefaultNeverInventsCommandPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	require.NoError(t, PersistInstallCodingProject(t.Context(), pool, configSource{}, workspaceapi.WorkspaceSource{Repository: "owner/repo", Revision: "89abcdef0123456789abcdef0123456789abcdef"}, nil))
	raw, err := StoredCodingProject(t.Context(), db.New(pool))
	require.NoError(t, err)
	var value map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &value))
	require.JSONEq(t, `[{"id":"build-only","target":".","flow":"checks/build-only","tier":"fast","required":true}]`, string(value["checks"]))
	require.JSONEq(t, `[{"flow":"checks/build-only","argv":[],"timeoutMs":1800000}]`, string(value["detected"]))
}

func TestBuildOnlyEvidenceDisclosesNoDetectedChecks(t *testing.T) {
	evidence, _ := mythicalTodoEvidenceText(db.MythicalItem{Plan: []byte(`{"checks":[{"id":"build-only"}]}`)})
	require.Equal(t, "Checks:\n- no checks detected", evidence)
}
