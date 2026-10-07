package compose

import (
	"encoding/json"
	"fmt"
	"strconv"
	"testing"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// C-J4-01 "merged since you looked", server half: the shared home snapshot
// carries each merged TODO once, at the repository position of the first
// fact that recorded it merged, oldest first. Nothing per member rides on it:
// each browser counts the entries above its own last_seen_seq.
func TestLiveHomeServesMergeHistory(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	people := make([]db.User, 3)
	for i, login := range []string{"mergeowner", "mergemaintainer", "mergemember"} {
		user, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login})
		require.NoError(t, err)
		people[i] = user
	}
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, people[0].ID)
	require.NoError(t, err)
	var repository, other int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, people[0].ID).Scan(&repository))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'other','other') RETURNING id`, people[0].ID).Scan(&other))
	for i, permission := range []string{"admin", "admin", "write"} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repository, people[i].ID, permission)
		require.NoError(t, err)
	}
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"mergeowner","repository_name":"app","repository_id":%d}`, repository))}))
	item := func(repo, n int64, state string) string {
		t.Helper()
		var id string
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,number,stack_position,title,owner_id,created_by) VALUES($1,'todo',$2,$3,$3,$4,$5,$5) RETURNING id::text`,
			repo, state, n, fmt.Sprintf("T%d", n), people[0].ID).Scan(&id))
		return id
	}
	// fact records one TODO source fact and answers its repository position.
	fact := func(repo int64, id, kind, state string) int64 {
		t.Helper()
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer tx.Rollback(ctx)
		event, err := jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: strconv.FormatInt(repo, 10), PrincipalID: "todo:" + id}, uuid.NewString(), kind, state, json.RawMessage(`{}`))
		require.NoError(t, err)
		require.NoError(t, tx.Commit(ctx))
		require.Positive(t, event.RepositorySequence)
		return event.RepositorySequence
	}
	t1, t2, t3 := item(repository, 1, "landed"), item(repository, 2, "landed"), item(repository, 3, "queued")
	elsewhere := item(other, 1, "landed")
	fact(repository, t1, "todo.created", "queued")
	fact(repository, t2, "todo.created", "queued")
	fact(repository, t3, "todo.created", "queued")
	merged2 := fact(repository, t2, "todo.github_merged", "merged")
	// A later fact about a merged TODO keeps its first merge position.
	fact(repository, t2, "todo.github_operation_settled", "merged")
	merged1 := fact(repository, t1, "todo.github_operation_settled", "merged")
	fact(repository, t3, "todo.run_updated", "working")
	fact(other, elsewhere, "todo.github_merged", "merged")
	require.Less(t, merged2, merged1)

	topics := &liveTopics{queries: q, todos: services.NewMythicalService(pool, nil)}
	var first string
	for _, index := range []int{2, 1, 0, 0, 1, 2} {
		person := people[index]
		source, refusal := topics.resolve(ctx, "home", repository, "mergeowner/app", person.ID)
		require.Empty(t, refusal)
		got, err := source.Build(ctx)
		require.NoError(t, err, person.Username)
		var model struct {
			MergeHistory []struct {
				N   int64 `json:"n"`
				Seq int64 `json:"seq"`
			} `json:"merge_history"`
			MergedSinceLastLook []int64 `json:"merged_since_last_look"`
		}
		require.NoError(t, json.Unmarshal(got, &model))
		require.Equal(t, []struct {
			N   int64 `json:"n"`
			Seq int64 `json:"seq"`
		}{{2, merged2}, {1, merged1}}, model.MergeHistory, person.Username)
		// The shared topic never carries a member's own count.
		require.Empty(t, model.MergedSinceLastLook, person.Username)
		if first == "" {
			first = string(got)
		} else {
			require.Equal(t, first, string(got), person.Username)
		}
	}
}
