package compose

import (
	"context"
	"io/fs"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type configSnapshotSource struct {
	config string
	reads  int
}

func (s *configSnapshotSource) ResolveSourceRevision(context.Context, string, string) (string, error) {
	return strings.Repeat("a", 40), nil
}
func (s *configSnapshotSource) ReadSourceFile(_ context.Context, source workspaceapi.WorkspaceSource, name string) ([]byte, error) {
	s.reads++
	if source.Revision != strings.Repeat("a", 40) || name != ".smithers/coding-project.json" {
		panic("snapshot must read only pinned main config")
	}
	if s.config == "" {
		return nil, fs.ErrNotExist
	}
	return []byte(s.config), nil
}
func TestInstallCodingProjectPinsRestartAndNextBindingPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	owner, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "config-owner", LowerUsername: "config-owner"})
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO repositories(user_id,name,lower_name,default_bookmark) VALUES($1,'app','app','main') RETURNING id`, owner.ID).Scan(&repo))
	require.NoError(t, q.UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: services.InstallCodingProjectKey, Value: []byte(`{"checks":[{"id":"test"}],"seats":{"coding/implement":"auto","coding/review":"auto"},"wiki":true}`)}))
	sources := &configSnapshotSource{}
	load := installCodingProject(pool, sources)
	launch := flowhost.HostLaunch{Binding: flowhost.Binding{ID: "first", RepositoryID: repo, OwnerGeneration: 1}}
	first, err := load(t.Context(), launch)
	require.NoError(t, err)
	require.JSONEq(t, `{"checks":[{"id":"test"}],"seats":{"coding/implement":"auto","coding/review":"auto"},"wiki":true}`, string(first))
	launch.Binding.OwnerGeneration = 2
	sources.config = `{"checks":[{"id":"lint"}],"seats":{"coding/review":"openai:gpt-6"}}`
	restarted, err := load(t.Context(), launch)
	require.NoError(t, err)
	require.Equal(t, first, restarted)
	require.Equal(t, 1, sources.reads)
	launch.Binding.ID = "second"
	second, err := load(t.Context(), launch)
	require.NoError(t, err)
	require.JSONEq(t, `{"checks":[{"id":"lint"}],"seats":{"coding/implement":"auto","coding/review":"openai:gpt-6"},"wiki":true}`, string(second))
	sources.config = "{invalid"
	launch.Binding.ID = "third"
	_, err = load(t.Context(), launch)
	require.ErrorContains(t, err, ".smithers/coding-project.json")
	var count int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM install_settings WHERE key='coding.snapshot:third'`).Scan(&count))
	require.Zero(t, count)

	_, err = q.RequestMythicalBootstrap(t.Context(), repo, owner.ID, 100, false)
	require.NoError(t, err)
	var todoID string
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO mythical_items(repository_id,issue_number,issue_title,state,attempt) VALUES($1,1,'Config attempt','queued',1) RETURNING id::text`, repo).Scan(&todoID))
	launch.Authority.Target = flowruntime.Target{BindingKind: flowdispatch.StackBindingKind, BindingID: todoID}
	sources.config = `{"wiki":false}`
	attemptOne, err := load(t.Context(), launch)
	require.NoError(t, err)
	sources.config = `{"wiki":true}`
	launch.Binding.OwnerGeneration++
	sameAttempt, err := load(t.Context(), launch)
	require.NoError(t, err)
	require.Equal(t, attemptOne, sameAttempt)
	_, err = pool.Exec(t.Context(), `UPDATE mythical_items SET attempt=2 WHERE id=$1`, todoID)
	require.NoError(t, err)
	attemptTwo, err := load(t.Context(), launch)
	require.NoError(t, err)
	require.NotEqual(t, attemptOne, attemptTwo)
	require.Contains(t, string(attemptTwo), `"wiki": true`)
}
