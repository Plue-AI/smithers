package compose

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// sseFrame is one event of a server-sent stream. Comments arrive as event
// "comment" with the comment text in data.
type sseFrame struct{ id, event, data string }

// liveSSE is an open server-sent stream read frame by frame.
type liveSSE struct {
	status int
	body   string
	frames chan sseFrame
	cancel context.CancelFunc
	mu     sync.Mutex
	seen   []sseFrame
	closed chan struct{}
}

// openLiveSSE connects over real HTTP. lastEventID is sent as given when set.
func openLiveSSE(t *testing.T, server *httptest.Server, path, token, lastEventID string) *liveSSE {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+path, nil)
	require.NoError(t, err)
	req.Header.Set("Accept", "text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	stream := &liveSSE{frames: make(chan sseFrame, 256), cancel: cancel, closed: make(chan struct{})}
	t.Cleanup(cancel)
	response, err := server.Client().Do(req)
	require.NoError(t, err)
	stream.status = response.StatusCode
	if response.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 1<<16))
		response.Body.Close()
		stream.body = string(data)
		close(stream.frames)
		close(stream.closed)
		return stream
	}
	go func() {
		defer close(stream.closed)
		defer close(stream.frames)
		defer response.Body.Close()
		reader := bufio.NewReader(response.Body)
		var frame sseFrame
		var data []string
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\r\n")
			switch {
			case line == "":
				if frame.event != "" || frame.id != "" || len(data) > 0 {
					frame.data = strings.Join(data, "\n")
					stream.mu.Lock()
					stream.seen = append(stream.seen, frame)
					stream.mu.Unlock()
					stream.frames <- frame
				}
				frame, data = sseFrame{}, nil
			case strings.HasPrefix(line, ":"):
				stream.frames <- sseFrame{event: "comment", data: strings.TrimSpace(line[1:])}
			case strings.HasPrefix(line, "id:"):
				frame.id = strings.TrimSpace(line[3:])
			case strings.HasPrefix(line, "event:"):
				frame.event = strings.TrimSpace(line[6:])
			case strings.HasPrefix(line, "data:"):
				data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			}
		}
	}()
	return stream
}

// next returns the first frame the predicate accepts within the budget.
func (s *liveSSE) next(match func(sseFrame) bool, budget time.Duration) (sseFrame, bool) {
	timer := time.NewTimer(budget)
	defer timer.Stop()
	for {
		select {
		case frame, ok := <-s.frames:
			if !ok {
				return sseFrame{}, false
			}
			if match(frame) {
				return frame, true
			}
		case <-timer.C:
			return sseFrame{}, false
		}
	}
}

// ended reports whether the server closed the stream within the budget.
func (s *liveSSE) ended(budget time.Duration) bool {
	select {
	case <-s.closed:
		return true
	case <-time.After(budget):
		return false
	}
}

func (s *liveSSE) history() []sseFrame {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]sseFrame(nil), s.seen...)
}

func withID(id int64) func(sseFrame) bool {
	return func(frame sseFrame) bool { return frame.id == strconv.FormatInt(id, 10) }
}

func containing(text string) func(sseFrame) bool {
	return func(frame sseFrame) bool { return frame.event != "comment" && strings.Contains(frame.data, text) }
}

// resilienceRig is one composed product with alice's streams seeded.
type resilienceRig struct {
	server *httptest.Server
	pool   *pgxpool.Pool
	// silent writes durable rows through connections whose pg_notify is a
	// no-op, so no subscriber ever hears a wakeup for what it writes.
	silent     *db.Queries
	silentPool *pgxpool.Pool
	f          liveStreamFixture
	step       db.WorkflowStep
	sequence   int64
	mu         sync.Mutex
}

func (r *resilienceRig) nextSequence() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sequence++
	return r.sequence
}

// newResilienceRig starts the multitenant product and shadows pg_notify for
// the silent writer: the trigger functions and queries call pg_notify
// unqualified, and a session whose search_path lists public before
// pg_catalog resolves it to the no-op.
func newResilienceRig(t *testing.T) *resilienceRig {
	t.Helper()
	pool, server, _ := startIsolationProduct(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `CREATE FUNCTION public.pg_notify(channel text, payload text) RETURNS void LANGUAGE sql AS 'SELECT'`)
	require.NoError(t, err)
	config := pool.Config().Copy()
	config.ConnConfig.RuntimeParams["search_path"] = "public, pg_catalog"
	silentPool, err := pgxpool.NewWithConfig(ctx, config)
	require.NoError(t, err)
	t.Cleanup(silentPool.Close)
	var notified bool
	require.NoError(t, silentPool.QueryRow(ctx, `SELECT pg_notify('probe', 'x') IS NULL`).Scan(&notified))
	rig := &resilienceRig{server: server, pool: pool, silentPool: silentPool, silent: db.New(silentPool)}
	carol, err := db.New(pool).CreateUser(ctx, db.CreateUserParams{Username: "carol", LowerUsername: "carol", DisplayName: "carol"})
	require.NoError(t, err)
	rig.f.alice = seedIsolationTenant(t, pool, "alice", carol.ID, canary)
	rig.f.bob = seedIsolationTenant(t, pool, "bob", 0, func(kind string) string { return "bob-" + kind })
	rig.step, err = db.New(pool).CreateWorkflowStep(ctx, db.CreateWorkflowStepParams{WorkflowRunID: rig.f.alice.run.ID, Name: "build", Position: 1, Status: "running"})
	require.NoError(t, err)
	return rig
}

// token mints another full-scope token for alice.
func (r *resilienceRig) token(t *testing.T, name string) (string, db.AccessToken) {
	t.Helper()
	return isolationToken(t, db.New(r.pool), r.f.alice.user, name)
}

// replayStream is one row of docs/live-streams.md that replays past events.
type replayStream struct {
	name    string
	pattern string
	// write persists one event carrying the marker without announcing it and
	// returns the stream event ID it will carry.
	write func(t *testing.T, r *resilienceRig, marker string) int64
	// expire removes the persisted event, as retention does.
	expire func(t *testing.T, r *resilienceRig, id int64)
}

func (r *resilienceRig) path(s replayStream) string {
	path := liveStreamPath(r.f, s.pattern)
	if strings.HasSuffix(s.pattern, "/wiki/{slug}/stream") {
		path += "?visibility=private&page_id=" + strconv.FormatInt(r.f.alice.wiki.ID, 10)
	}
	return path
}

func replayStreams() []replayStream {
	logs := func(pattern string) replayStream {
		return replayStream{name: pattern, pattern: pattern, write: func(t *testing.T, r *resilienceRig, marker string) int64 {
			row, err := r.silent.InsertWorkflowLog(context.Background(), db.InsertWorkflowLogParams{WorkflowStepID: r.step.ID, Sequence: r.nextSequence(), Stream: "stdout", Entry: marker, WorkflowRunID: r.f.alice.run.ID})
			require.NoError(t, err)
			return row.ID
		}, expire: func(t *testing.T, r *resilienceRig, id int64) {
			_, err := r.pool.Exec(context.Background(), `DELETE FROM workflow_logs WHERE id = $1`, id)
			require.NoError(t, err)
		}}
	}
	return []replayStream{
		{name: "notification facts", pattern: "/api/notifications/events/stream", write: func(t *testing.T, r *resilienceRig, marker string) int64 {
			_, err := r.silent.CreateNotification(context.Background(), db.CreateNotificationParams{SourceType: "issue", SourceID: pgtype.Int8{Int64: r.f.alice.issue.ID, Valid: true}, Subject: marker, Body: marker, UserID: r.f.alice.user.ID})
			require.NoError(t, err)
			var head int64
			require.NoError(t, r.pool.QueryRow(context.Background(), `SELECT head FROM notification_journals WHERE user_id = $1`, r.f.alice.user.ID).Scan(&head))
			return head
		}},
		{name: "issue facts", pattern: "/api/repos/{owner}/{repo}/issues/state-events/stream", write: func(t *testing.T, r *resilienceRig, marker string) int64 {
			_, err := r.silent.CreateIssue(context.Background(), db.CreateIssueParams{RepositoryID: r.f.alice.repo.ID, Title: marker, Body: marker, AuthorID: r.f.alice.user.ID, Kind: "issue", IdempotencyKey: marker})
			require.NoError(t, err)
			var head int64
			require.NoError(t, r.pool.QueryRow(context.Background(), `SELECT head FROM issue_state_journals WHERE repository_id = $1`, r.f.alice.repo.ID).Scan(&head))
			return head
		}},
		{name: "wiki page revisions", pattern: "/api/repos/{owner}/{repo}/wiki/{slug}/stream", write: func(t *testing.T, r *resilienceRig, marker string) int64 {
			var revision int64
			require.NoError(t, r.silentPool.QueryRow(context.Background(), `
INSERT INTO wiki_page_revisions(repository_id, page_id, revision, slug, title, body, visibility, path, content_digest, author_id, author_username, update_id, update_bytes, deleted, sequence)
SELECT p.repository_id, p.id, COALESCE((SELECT MAX(revision) FROM wiki_page_revisions WHERE page_id = p.id), 0) + 1, p.slug, $2, $2, p.visibility, p.path, $2, p.author_id, 'alice', gen_random_uuid(), ''::bytea, false, COALESCE((SELECT MAX(sequence) FROM wiki_page_revisions WHERE repository_id = p.repository_id AND visibility = p.visibility), 0) + 1
FROM wiki_pages p WHERE p.id = $1 RETURNING revision`, r.f.alice.wiki.ID, marker).Scan(&revision))
			return revision
		}, expire: func(t *testing.T, r *resilienceRig, id int64) {
			_, err := r.pool.Exec(context.Background(), `DELETE FROM wiki_page_revisions WHERE page_id = $1 AND revision = $2`, r.f.alice.wiki.ID, id)
			require.NoError(t, err)
		}},
		logs("/api/repos/{owner}/{repo}/runs/{id}/logs"),
		logs("/api/repos/{owner}/{repo}/runs/{id}/events"),
		logs("/api/repos/{owner}/{repo}/workflows/runs/{id}/events"),
		{name: "agent session messages", pattern: "/api/repos/{owner}/{repo}/agent/sessions/{id}/stream", write: func(t *testing.T, r *resilienceRig, marker string) int64 {
			row, err := r.silent.CreateAgentMessage(context.Background(), db.CreateAgentMessageParams{RepositoryID: r.f.alice.repo.ID, Role: "assistant", Sequence: r.nextSequence(), SessionID: r.f.alice.agentSession.ID})
			require.NoError(t, err)
			_, err = r.silentPool.Exec(context.Background(), `INSERT INTO agent_parts(message_id, repository_id, session_id, part_index, part_type, content) VALUES ($1, $2, $3, 0, 'text', $4::jsonb)`, row.ID, r.f.alice.repo.ID, r.f.alice.agentSession.ID, fmt.Sprintf(`{"text":%q}`, marker))
			require.NoError(t, err)
			return row.ID
		}, expire: func(t *testing.T, r *resilienceRig, id int64) {
			_, err := r.pool.Exec(context.Background(), `DELETE FROM agent_messages WHERE id = $1`, id)
			require.NoError(t, err)
		}},
	}
}

// limit caps how many stream-holding subtests run at once: the broker allows
// an account five concurrent streams.
func limited(slots chan struct{}, body func(t *testing.T)) func(t *testing.T) {
	return func(t *testing.T) {
		t.Parallel()
		slots <- struct{}{}
		defer func() { <-slots }()
		body(t)
	}
}

const (
	unknownCursor   = "99999999"
	wakeupBudget    = 15 * time.Second
	replayBudget    = 3 * time.Second
	revocationBound = 8 * time.Second
)

// TestLiveStreamResiliencePostgres drives every replaying stream in
// docs/live-streams.md through a resume cursor the stream cannot honour, a
// lost wakeup and a mid-stream loss of access.
func TestLiveStreamResiliencePostgres(t *testing.T) {
	rig := newResilienceRig(t)
	streams := replayStreams()
	slots := make(chan struct{}, 3)
	token := rig.f.alice.token

	t.Run("resume cursor", func(t *testing.T) {
		for _, stream := range streams {
			t.Run(stream.name, func(t *testing.T) {
				path := rig.path(stream)
				first := stream.write(t, rig, "cursor-first-"+stream.name)
				second := stream.write(t, rig, "cursor-second-"+stream.name)
				third := stream.write(t, rig, "cursor-third-"+stream.name)

				// A cursor the stream never issued is refused before any event.
				ahead := openLiveSSE(t, rig.server, path, token, unknownCursor)
				require.Equal(t, http.StatusConflict, ahead.status, ahead.body)
				require.Contains(t, ahead.body, "cursor_unknown")
				require.Contains(t, ahead.body, `"resync":true`)
				require.Empty(t, ahead.history())

				// A known cursor resumes strictly after it: nothing skipped, nothing repeated.
				resumed := openLiveSSE(t, rig.server, path, token, strconv.FormatInt(first, 10))
				require.Equal(t, http.StatusOK, resumed.status, resumed.body)
				_, ok := resumed.next(withID(third), replayBudget)
				require.True(t, ok, "resume after %d lost events: %+v", first, resumed.history())
				var ids []string
				for _, frame := range resumed.history() {
					if frame.id != "" {
						ids = append(ids, frame.id)
					}
				}
				require.Equal(t, []string{strconv.FormatInt(second, 10), strconv.FormatInt(third, 10)}, ids, "resume after %d", first)
				resumed.cancel()

				if stream.expire == nil {
					return
				}
				// A cursor whose record was pruned cannot prove the events
				// between it and the oldest retained one were seen.
				stream.expire(t, rig, second)
				expired := openLiveSSE(t, rig.server, path, token, strconv.FormatInt(second, 10))
				require.Equal(t, http.StatusConflict, expired.status, expired.body)
				require.Contains(t, expired.body, "cursor_unknown")
			})
		}
		t.Run("run status snapshot", func(t *testing.T) {
			// A snapshot stream carries no cursor: any Last-Event-ID resyncs to the current status.
			path := liveStreamPath(rig.f, "/api/repos/{owner}/{repo}/runs/{id}/status/stream")
			stream := openLiveSSE(t, rig.server, path, token, unknownCursor)
			require.Equal(t, http.StatusOK, stream.status, stream.body)
			frame, ok := stream.next(containing(`"status":"running"`), replayBudget)
			require.True(t, ok)
			require.Equal(t, "status", frame.event)
		})
	})

	t.Run("lost wakeup", func(t *testing.T) {
		for _, stream := range streams {
			t.Run(stream.name, limited(slots, func(t *testing.T) {
				path := rig.path(stream)
				live := openLiveSSE(t, rig.server, path, token, "")
				require.Equal(t, http.StatusOK, live.status, live.body)
				_, ok := live.next(func(f sseFrame) bool { return f.event == "comment" && f.data == "connected" }, replayBudget)
				require.True(t, ok, "stream never connected")

				// The row commits and its NOTIFY is swallowed: only the repair poll can deliver it.
				id := stream.write(t, rig, "lost-wakeup-"+stream.name)
				_, ok = live.next(withID(id), wakeupBudget)
				require.True(t, ok, "event %d written without a wakeup never arrived: %+v", id, live.history())
				live.cancel()

				// Written while nobody listens: the reconnect catches up from its cursor.
				missed := stream.write(t, rig, "missed-"+stream.name)
				reconnected := openLiveSSE(t, rig.server, path, token, strconv.FormatInt(id, 10))
				require.Equal(t, http.StatusOK, reconnected.status, reconnected.body)
				_, ok = reconnected.next(withID(missed), replayBudget)
				require.True(t, ok, "reconnect after %d lost event %d: %+v", id, missed, reconnected.history())
			}))
		}
		t.Run("run status", limited(slots, func(t *testing.T) {
			run := rig.newRun(t)
			path := fmt.Sprintf("/api/repos/%s/%s/runs/%d/status/stream", rig.f.alice.user.Username, rig.f.alice.repo.Name, run)
			live := openLiveSSE(t, rig.server, path, token, "")
			require.Equal(t, http.StatusOK, live.status, live.body)
			_, ok := live.next(containing(`"status":"running"`), replayBudget)
			require.True(t, ok, "no opening snapshot")
			_, err := rig.silentPool.Exec(context.Background(), `UPDATE workflow_runs SET status = 'success', completed_at = now() WHERE id = $1`, run)
			require.NoError(t, err)
			_, ok = live.next(containing(`"status":"success"`), wakeupBudget)
			require.True(t, ok, "a status change without a wakeup never arrived: %+v", live.history())
			live.cancel()

			// A reconnect opens with the current status.
			_, err = rig.silentPool.Exec(context.Background(), `UPDATE workflow_runs SET status = 'failure' WHERE id = $1`, run)
			require.NoError(t, err)
			again := openLiveSSE(t, rig.server, path, token, "")
			_, ok = again.next(containing(`"status":"failure"`), replayBudget)
			require.True(t, ok, "reconnect snapshot is stale: %+v", again.history())
		}))
		t.Run("github import", limited(slots, func(t *testing.T) {
			job := rig.newImport(t)
			live := openLiveSSE(t, rig.server, "/api/github/import/"+job, token, "")
			require.Equal(t, http.StatusOK, live.status, live.body)
			_, ok := live.next(containing(`"stage":"cloning-stage"`), replayBudget)
			require.True(t, ok, "no opening snapshot")
			_, err := rig.silentPool.Exec(context.Background(), `UPDATE import_jobs SET stage = 'indexing-stage' WHERE id = $1`, job)
			require.NoError(t, err)
			_, ok = live.next(containing(`"stage":"indexing-stage"`), wakeupBudget)
			require.True(t, ok, "an import change without a wakeup never arrived: %+v", live.history())
		}))
	})

	t.Run("revoked access", func(t *testing.T) {
		type target struct {
			name string
			path func(t *testing.T) string
			// wait blocks until the stream has established.
			established func(sseFrame) bool
		}
		connected := func(f sseFrame) bool { return f.event == "comment" && f.data == "connected" }
		var targets []target
		for _, stream := range streams {
			targets = append(targets, target{name: stream.name, path: func(*testing.T) string { return rig.path(stream) }, established: connected})
		}
		targets = append(targets,
			target{name: "run status", path: func(*testing.T) string {
				return liveStreamPath(rig.f, "/api/repos/{owner}/{repo}/runs/{id}/status/stream")
			}, established: connected},
			target{name: "github import", path: func(t *testing.T) string { return "/api/github/import/" + rig.newImport(t) }, established: func(f sseFrame) bool { return f.event == "import_job" }},
		)
		for _, target := range targets {
			t.Run(target.name, limited(slots, func(t *testing.T) {
				own, row := rig.token(t, "revoked-"+target.name)
				path := target.path(t)
				live := openLiveSSE(t, rig.server, path, own, "")
				require.Equal(t, http.StatusOK, live.status, live.body)
				_, ok := live.next(target.established, replayBudget)
				require.True(t, ok, "stream never established: %+v", live.history())

				// Alice deletes the credential the stream is open under.
				response := isolationRequest(t, rig.server, token, http.MethodDelete, "/api/user/tokens/"+strconv.FormatInt(row.ID, 10), nil)
				require.Less(t, response.status, 300, response.body)
				_, ok = live.next(func(f sseFrame) bool { return f.event == "revoked" }, revocationBound)
				require.True(t, ok, "stream was not revoked: %+v", live.history())
				require.True(t, live.ended(revocationBound), "stream stayed open after revocation")

				// Nothing further is served under it, on a new connection either.
				again := openLiveSSE(t, rig.server, path, own, "")
				require.True(t, isolationDenied(again.status), "revoked credential reopened the stream: %d %s", again.status, again.body)
			}))
		}
	})
}

// newRun seeds a running workflow run of alice's and returns its ID.
func (r *resilienceRig) newRun(t *testing.T) int64 {
	t.Helper()
	run, err := db.New(r.pool).CreateWorkflowRun(context.Background(), db.CreateWorkflowRunParams{RepositoryID: r.f.alice.repo.ID, WorkflowDefinitionID: r.f.alice.definition.ID, Status: "running",
		TriggerEvent: "manual", TriggerRef: "resilience", TriggerCommitSha: strings.Repeat("a", 40), DispatchInputs: []byte(`{}`), ExecutionPlane: "sandbox"})
	require.NoError(t, err)
	return run.ID
}

// newImport seeds a running GitHub import of alice's and returns its ID.
func (r *resilienceRig) newImport(t *testing.T) string {
	t.Helper()
	var id string
	require.NoError(t, r.pool.QueryRow(context.Background(), `INSERT INTO import_jobs(user_id, github_owner, github_repo, status, stage) VALUES ($1, 'octo', 'hello-' || gen_random_uuid()::text, 'cloning', 'cloning-stage') RETURNING id::text`,
		r.f.alice.user.ID).Scan(&id))
	return id
}
