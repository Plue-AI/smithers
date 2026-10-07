package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

type reviewTestApp struct{ outboundTestCredentials }

func (reviewTestApp) Load(context.Context) (GitHubAppCredentials, error) {
	return GitHubAppCredentials{ID: 99, Slug: "install-app", InstallationID: 12}, nil
}

func newReviewConsumer(t *testing.T) (*mythicalOrchestration, *GitHubSyncedRepoService, db.GithubSyncedRepo, db.MythicalItem) {
	t.Helper()
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	o.service.EnableTodoSteering()
	o.service.publication = &mythicalPublication{app: reviewTestApp{}}
	pool, _ := o.runDispatcher(t, flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return nil, fmt.Errorf("no guest in this test")
	}))
	synced := NewGitHubSyncedRepoService(db.New(pool))
	require.NoError(t, synced.ConfigureInstallSync(pool))
	allowFetched(synced)
	o.service.UseInstallGitHubPolling(synced)
	_, err := pool.Exec(t.Context(), `UPDATE repositories SET mirror_destination='smithers-canary/smithers' WHERE id=$1`, o.repoID)
	require.NoError(t, err)
	row, err := db.New(pool).EnrollGitHubSyncedRepo(t.Context(), db.EnrollGitHubSyncedRepoParams{OwnerLogin: "smithers-canary", RepoName: "smithers", InstallationID: pgtype.Int8{Int64: 12, Valid: true}, GithubRepositoryID: pgtype.Int8{Int64: 100, Valid: true}, SyncMetadata: true, EnrolledVia: GitHubSyncedRepoEnrolledViaInstallation})
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,github_id,github_login,permission) VALUES($1,$2,77,'owner','admin') ON CONFLICT(repository_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET github_id=77,github_login='owner'`, o.repoID, o.userID)
	require.NoError(t, err)
	item := o.fileTodo(session, "review-todo")
	ready, _, _ := steerFixture()
	item.State = "proposed"
	item.Attempt = ready.Attempt
	item.RequestRunID = ready.RequestRunID
	workspace, err := db.New(pool).CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: o.repoID, UserID: o.userID, Name: "review-input", Kind: "container", Status: "running", TargetBookmark: "smithers/review"})
	require.NoError(t, err)
	item.WorkspaceID = workspace.ID
	item.FlowDigest = ready.FlowDigest
	checks := mythicalChecksOf(ready)
	checks.Branch = "smithers/review"
	item.Checks = checks.encode()
	item.PRNumber = pgtype.Int8{Int64: 3, Valid: true}
	item, err = db.New(pool).SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	return o, synced, row, item
}

func reviewFact(row db.GithubSyncedRepo, author int64, version, state string) gitHubFetchedObject {
	raw := fmt.Sprintf(`{"id":42,"body":"Use the backoff helper","state":%q,"user":{"id":%d,"login":"owner","type":"User"},"submitted_at":"2026-10-05T10:00:00Z"}`, state, author)
	return gitHubFetchedObject{GitHubRepository: 100, Installation: 12, Repo: row.ID, Resource: gitHubReviews, Number: 3, Version: version, Object: json.RawMessage(raw)}
}

func TestGitHubReviewConsumerAtomicReplayAndAuthority(t *testing.T) {
	for _, tc := range []struct {
		name    string
		author  int64
		state   string
		steers  int
		working bool
	}{
		{"member", 77, "CHANGES_REQUESTED", 1, true}, {"outsider", 88, "CHANGES_REQUESTED", 0, false}, {"approval", 77, "APPROVED", 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o, synced, row, item := newReviewConsumer(t)
			pool := o.pool.(*pgxpool.Pool)
			fact := reviewFact(row, tc.author, "first", tc.state)
			consume := func() error {
				return pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
					_, err := synced.install.consumers[gitHubReviews](t.Context(), tx, fact)
					return err
				})
			}
			// Crash before commit must roll back the complete effect set.
			require.Error(t, pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
				_, err := synced.install.consumers[gitHubReviews](t.Context(), tx, fact)
				require.NoError(t, err)
				return fmt.Errorf("crash before commit")
			}))
			require.Empty(t, mythicalChecksOf(o.byID(uuidString(item.ID))).GitHubInputs)
			require.NoError(t, consume())
			require.NoError(t, consume())
			next := o.byID(uuidString(item.ID))
			checks := mythicalChecksOf(next)
			require.Len(t, checks.GitHubInputs, 1)
			require.Len(t, checks.Steers, tc.steers)
			require.Len(t, o.facts(next, "todo.github_input"), 1)
			if tc.working {
				require.Equal(t, "running", next.State)
				require.Equal(t, o.userID, checks.Steers[0].Author)
				require.Equal(t, "person", stringField(t, checks.GitHubInputs[0].Actor, "kind"))
			} else {
				require.Equal(t, "proposed", next.State)
			}
			require.Equal(t, tc.steers, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer'`))
			if tc.author == 88 {
				require.Equal(t, "github", stringField(t, checks.GitHubInputs[0].Actor, "kind"))
			}
			if tc.working {
				require.Nil(t, checks.Land)
			} else {
				require.Equal(t, mythicalChecksOf(item).Land, checks.Land)
			}
		})
	}
}
func stringField(t *testing.T, raw json.RawMessage, key string) string {
	t.Helper()
	var value map[string]any
	require.NoError(t, json.Unmarshal(raw, &value))
	return value[key].(string)
}

func TestGitHubReviewFetchedWorkerRetainsMissingProvider(t *testing.T) {
	o, synced, row, item := newReviewConsumer(t)
	pool := o.pool.(*pgxpool.Pool)
	fact := reviewFact(row, 77, "first", "CHANGES_REQUESTED")
	// Admit through the production fetched dispatcher, then restart it after a
	// provider refusal. Fetched facts remain replayable until the provider returns.
	require.NoError(t, pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
		return synced.admitFetchedObject(t.Context(), tx, row, gitHubReviews, 42, 3, fact.Object)
	}))
	o.service.todoFlow = nil
	stop := runFetchedFixture(t, synced)
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_dispatches WHERE last_error<>''`) > 0
	}, 5*time.Second, 10*time.Millisecond)
	stop()
	require.Empty(t, mythicalChecksOf(o.byID(uuidString(item.ID))).GitHubInputs)
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND state='completed'`))
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	stop = runFetchedFixture(t, synced)
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND state='completed'`) == 1
	}, 5*time.Second, 10*time.Millisecond)
	stop()
	require.Len(t, mythicalChecksOf(o.byID(uuidString(item.ID))).Steers, 1)
	require.Len(t, o.facts(item, "todo.github_input"), 1)
}

func TestGitHubHeldReviewEditsDeletionAndMemberRemoval(t *testing.T) {
	o, synced, row, item := newReviewConsumer(t)
	pool := o.pool.(*pgxpool.Pool)
	item.State = "blocked"
	var err error
	_, err = db.New(pool).SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	fact := reviewFact(row, 77, "first", "CHANGES_REQUESTED")
	consume := func() error {
		return pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
			_, err := synced.install.consumers[gitHubReviews](t.Context(), tx, fact)
			return err
		})
	}
	require.NoError(t, consume())
	held := o.byID(uuidString(item.ID))
	checks := mythicalChecksOf(held)
	require.Equal(t, "blocked", held.State)
	require.Len(t, checks.Steers, 1)
	require.True(t, checks.Steers[0].ReleasePending)
	id := checks.Steers[0].ID
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer'`))
	fact.Version = "edited"
	fact.Object = json.RawMessage(`{"id":42,"body":"Use the shared helper instead","state":"CHANGES_REQUESTED","user":{"id":77,"login":"owner"},"submitted_at":"2026-10-05T10:01:00Z"}`)
	require.NoError(t, consume())
	checks = mythicalChecksOf(o.byID(uuidString(item.ID)))
	require.Len(t, checks.Steers, 1)
	require.Equal(t, id, checks.Steers[0].ID)
	require.Equal(t, "Use the shared helper instead", checks.Steers[0].Text)
	_, err = pool.Exec(t.Context(), `UPDATE collaborators SET suspended_at=now() WHERE github_id=77`)
	require.NoError(t, err)
	require.NoError(t, pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
		active, err := currentGitHubFeedbackAuthor(t.Context(), tx, o.repoID, checks.Steers[0])
		require.NoError(t, err)
		require.False(t, active)
		return nil
	}))
	fact.Version = "revoked-edit"
	require.NoError(t, consume())
	require.Empty(t, mythicalChecksOf(o.byID(uuidString(item.ID))).Steers)
	fact.Version = "deleted"
	fact.Object = json.RawMessage(`{"id":42,"body":"Use the shared helper instead","state":"CHANGES_REQUESTED","deleted":true,"user":{"id":77,"login":"owner"},"submitted_at":"2026-10-05T10:02:00Z"}`)
	require.NoError(t, consume())
	require.True(t, mythicalChecksOf(o.byID(uuidString(item.ID))).GitHubInputs[0].Hidden)
}

func TestGitHubReviewPollBatchesAnchorsAndReplays(t *testing.T) {
	o, synced, row, item := newReviewConsumer(t)
	pool := o.pool.(*pgxpool.Pool)
	read, err := synced.beginPullRead(t.Context(), row, 3)
	require.NoError(t, err)
	require.NoError(t, pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
		return synced.commitFetchedIssue(t.Context(), tx, row, GitHubRepoMetadataPulls, read, json.RawMessage(`{"id":707,"number":3,"state":"open","title":"Change","head":{"sha":"head","ref":"smithers/review"},"updated_at":"2026-10-05T10:00:00Z"}`))
	}))
	synced.SetConditionalFetcherFactory(func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
		return func(_ context.Context, resource string, _ url.Values, _ string) (GitHubSyncedRepoConditionalPage, error) {
			raw := ""
			switch resource {
			case "issues/3/comments":
				raw = `[]`
			case "pulls/3/reviews":
				raw = `[{"id":42,"user":{"id":77,"login":"owner"},"state":"CHANGES_REQUESTED","body":"Fix these","submitted_at":"2026-10-05T10:00:00Z"}]`
			case "pulls/3/comments":
				raw = `[{"id":101,"pull_request_review_id":42,"user":{"id":77,"login":"owner"},"path":"a.go","line":9,"commit_id":"head","body":"one","updated_at":"2026-10-05T10:00:00Z"},{"id":102,"pull_request_review_id":42,"user":{"id":77,"login":"owner"},"path":"b.go","original_line":3,"original_commit_id":"original","body":"two","updated_at":"2026-10-05T10:00:00Z"},{"id":103,"pull_request_review_id":42,"user":{"id":77,"login":"owner"},"path":"c.go","line":5,"commit_id":"head","body":"three","updated_at":"2026-10-05T10:00:00Z"}]`
			default:
				return GitHubSyncedRepoConditionalPage{}, fmt.Errorf("unexpected read %s", resource)
			}
			return GitHubSyncedRepoConditionalPage{Body: json.RawMessage(raw)}, nil
		}
	})
	require.NoError(t, synced.ReadInstallPullFacts(t.Context(), row, 3, "head", "reviews"))
	require.NoError(t, synced.ReadInstallPullFacts(t.Context(), row, 3, "head", "reviews"))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='pulls/reviews'`))
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='pulls/comments'`))
	var snapshot []byte
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT related_facts FROM github_synced_issues WHERE resource='pulls' AND number=3`).Scan(&snapshot))
	require.Contains(t, string(snapshot), "original_line")
	stop := runFetchedFixture(t, synced)
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='pulls/reviews' AND state='completed'`) == 1
	}, 5*time.Second, 10*time.Millisecond)
	stop()
	checks := mythicalChecksOf(o.byID(uuidString(item.ID)))
	require.Len(t, checks.Steers, 1)
	require.Equal(t, "Fix these\n\na.go:9 @ head\none\n\nb.go:3 @ original\ntwo\n\nc.go:5 @ head\nthree", checks.Steers[0].Text)
}

func TestGitHubReviewMissingProvidersCommitNoEffects(t *testing.T) {
	for _, missing := range []string{"flow", "dispatcher", "storage", "app", "authority", "gate", "pin", "attachment"} {
		t.Run(missing, func(t *testing.T) {
			o, synced, row, item := newReviewConsumer(t)
			pool := o.pool.(*pgxpool.Pool)
			switch missing {
			case "flow":
				o.service.todoFlow = nil
			case "dispatcher":
				o.service.launcher = nil
			case "storage":
				o.service.store = nil
			case "app":
				o.service.publication = nil
			case "authority":
				synced.install.authorize = nil
			case "gate":
				o.service.todoSteering = false
			case "pin":
				item.FlowDigest.Valid = false
				_, err := db.New(pool).SaveMythicalItem(t.Context(), item)
				require.NoError(t, err)
			case "attachment":
				checks := mythicalChecksOf(item)
				checks.RunAttached = false
				item.Checks = checks.encode()
				_, err := db.New(pool).SaveMythicalItem(t.Context(), item)
				require.NoError(t, err)
			}
			fact := reviewFact(row, 77, "first", "CHANGES_REQUESTED")
			require.Error(t, pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
				_, err := synced.install.consumers[gitHubReviews](t.Context(), tx, fact)
				return err
			}))
			current, err := db.New(pool).GetMythicalItem(t.Context(), item.ID)
			require.NoError(t, err)
			require.Equal(t, "proposed", current.State)
			require.Empty(t, mythicalChecksOf(current).GitHubInputs)
			require.Empty(t, mythicalChecksOf(current).Steers)
			require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer'`))
		})
	}
}

func TestGitHubInstallAppReviewIsIgnored(t *testing.T) {
	o, synced, row, item := newReviewConsumer(t)
	pool := o.pool.(*pgxpool.Pool)
	fact := reviewFact(row, 77, "app", "CHANGES_REQUESTED")
	fact.Object = json.RawMessage(`{"id":42,"body":"App text must not steer","state":"CHANGES_REQUESTED","user":{"id":77,"login":"owner"},"performed_via_github_app":{"id":99},"submitted_at":"2026-10-05T10:00:00Z"}`)
	require.NoError(t, pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
		_, err := synced.install.consumers[gitHubReviews](t.Context(), tx, fact)
		return err
	}))
	require.Empty(t, mythicalChecksOf(o.byID(uuidString(item.ID))).GitHubInputs)
	require.Empty(t, mythicalChecksOf(o.byID(uuidString(item.ID))).Steers)
	require.Empty(t, o.facts(item, "todo.github_input"))
}

func TestGitHubConversationSnapshotWithdrawsHeldInputAndReplays(t *testing.T) {
	o, synced, row, item := newReviewConsumer(t)
	pool := o.pool.(*pgxpool.Pool)
	item.State = "blocked"
	_, err := db.New(pool).SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	pullRead, err := synced.beginPullRead(t.Context(), row, 3)
	require.NoError(t, err)
	require.NoError(t, pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
		return synced.commitFetchedIssue(t.Context(), tx, row, GitHubRepoMetadataPulls, pullRead, json.RawMessage(`{"id":707,"number":3,"state":"open","title":"Change","head":{"sha":"head","ref":"smithers/review"},"updated_at":"2026-10-05T10:00:00Z"}`))
	}))
	body := `[{"id":901,"body":"Use backoff","user":{"id":77,"login":"owner"},"issue_url":"https://api.github.com/repos/smithers-canary/smithers/issues/3","created_at":"2026-10-05T10:00:00Z","updated_at":"2026-10-05T10:00:00Z"}]`
	synced.SetConditionalFetcherFactory(func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
		return func(_ context.Context, resource string, _ url.Values, _ string) (GitHubSyncedRepoConditionalPage, error) {
			raw := `[]`
			if resource == "issues/3/comments" {
				raw = body
			}
			return GitHubSyncedRepoConditionalPage{Body: json.RawMessage(raw)}, nil
		}
	})
	read := func() error { return synced.ReadInstallPullFacts(t.Context(), row, 3, "head", "reviews") }
	require.NoError(t, read())
	drain := func(want int) {
		stop := runFetchedFixture(t, synced)
		require.Eventually(t, func() bool {
			return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/comments' AND state='completed'`) == want
		}, 5*time.Second, 10*time.Millisecond)
		stop()
	}
	drain(1)
	checks := mythicalChecksOf(o.byID(uuidString(item.ID)))
	require.Len(t, checks.Steers, 1)
	require.True(t, checks.Steers[0].ReleasePending)
	body = `[]`
	// A failed cache/delivery transaction cannot publish a partial tombstone.
	_, err = pool.Exec(t.Context(), `CREATE FUNCTION reject_conversation_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='github.fetched.consume' AND NEW.payload->'object'->>'deleted'='true' THEN RAISE EXCEPTION 'tombstone crash'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_conversation_tombstone BEFORE INSERT ON product_job_requests FOR EACH ROW EXECUTE FUNCTION reject_conversation_tombstone()`)
	require.NoError(t, err)
	require.ErrorContains(t, read(), "tombstone crash")
	var deleted bool
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT COALESCE((payload->>'deleted')::boolean,false) FROM github_synced_issue_comments WHERE github_id=901`).Scan(&deleted))
	require.False(t, deleted)
	_, err = pool.Exec(t.Context(), `DROP TRIGGER reject_conversation_tombstone ON product_job_requests`)
	require.NoError(t, err)
	require.NoError(t, read())
	require.NoError(t, read())
	drain(2)
	checks = mythicalChecksOf(o.byID(uuidString(item.ID)))
	require.Empty(t, checks.Steers)
	require.Len(t, checks.GitHubInputs, 1)
	require.True(t, checks.GitHubInputs[0].Hidden)
	require.Equal(t, "blocked", o.byID(uuidString(item.ID)).State)
	require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer'`))
	// Restart preserves the cache tombstone and its one delivery identity.
	require.NoError(t, read())
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/comments'`))
}
