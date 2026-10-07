package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/stretchr/testify/require"
)

func TestGitHubInboundOutOfOrderProductionPoll(t *testing.T) {
	for _, mode := range []string{"contained", "missing manifest", "superseded", "missing head read", "dropped contained", "precommit crash", "lost close answer", "lost comment answer", "settled issue before comment", "unknown merge", "fixing issue", "nonfixing issue"} {
		t.Run(mode, func(t *testing.T) {
			h := newMergeHarness(t)
			ctx := context.Background()
			n1, _, pr1 := h.first("First")
			n2, _, pr2 := h.todoInReview("Second", h.item(n1).CandidateHead)
			n3, _, _ := h.todoInReview("Third", h.item(n2).CandidateHead)
			for range 4 {
				h.pass()
			}
			var linkedIssue int64
			if mode == "fixing issue" || mode == "nonfixing issue" {
				linkedIssue = h.fake.OpenIssue("rehearsal-owner/app", "rehearsal-owner", "Original issue", "Fix it")
				h.exec(`UPDATE mythical_items SET issue_number=$2,issue_url=$3,fixes_issue=$4,version=version+1 WHERE number=$1`, n1, linkedIssue, fmt.Sprintf("https://github.com/rehearsal-owner/app/issues/%d", linkedIssue), mode == "fixing issue")
			}
			second := h.item(n2)
			require.NotEmpty(t, mythicalChecksOf(second).PRManifests)
			if mode == "missing manifest" {
				h.exec(`UPDATE mythical_items SET checks=checks-'prManifests',version=version+1 WHERE number=$1`, n2)
			}
			if mode == "superseded" {
				h.exec(`UPDATE mythical_items SET candidate_head=$2,version=version+1 WHERE number=$1`, n1, h.main)
			}
			if mode == "dropped contained" {
				// Terminal absorption must not hide proof of a change already on main.
				h.exec(`UPDATE mythical_items SET state='rejected',version=version+1 WHERE number=$1`, n1)
			}
			if mode == "unknown merge" {
				require.NoError(t, h.press(h.ctx, n1, h.item(n1).PRHead))
				h.exec(`UPDATE mythical_items SET pending_op=jsonb_set(pending_op,'{state}','"unknown"'),version=version+1 WHERE number=$1`, n1)
			}
			synced, row := configureInboundPullPolling(t, h.publicationFixture)
			var deliveries atomic.Int32
			consumer := synced.install.consumers[GitHubRepoMetadataPulls]
			synced.RegisterFetchedConsumer(GitHubRepoMetadataPulls, func(ctx context.Context, tx pgx.Tx, fact gitHubFetchedObject) (json.RawMessage, error) {
				deliveries.Add(1)
				return consumer(ctx, tx, fact)
			})
			if mode == "precommit crash" {
				h.exec(`CREATE FUNCTION reject_order_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='operation.completed' THEN RAISE EXCEPTION 'injected order precommit crash'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_order_receipt BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION reject_order_receipt()`)
			}
			stop := runFetchedFixture(t, synced)
			defer stop()
			h.fake.UpdatePull("rehearsal-owner/app", pr2, func(p *githubfake.Pull) { p.Draft = false })
			h.fake.MergeAsPerson("rehearsal-owner/app", pr2)
			require.True(t, h.pull(pr2).Merged)
			mainSync := NewGitHubMainPullService(db.New(h.pool), h.host, h.connections, h.connections)
			qualifyMainPullFixture(mainSync)
			mainSync.Sweep(ctx)
			require.NoError(t, mainSync.PollOnce(ctx))
			if mode == "missing head read" {
				h.fake.FailNextReads(fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr2), 1)
				require.Error(t, synced.pollInstallPull(ctx, row, pr2))
				require.Equal(t, "proposed", h.item(n1).State)
				require.Equal(t, "proposed", h.item(n2).State)
				rows, err := readStackAttention(ctx, h.pool, h.repoID)
				require.NoError(t, err)
				require.Empty(t, rows)
				require.Equal(t, "open", h.pull(pr1).State)
			}
			require.NoError(t, synced.pollInstallPull(ctx, row, pr2))
			pool := h.pool.(*pgxpool.Pool)
			if mode == "precommit crash" {
				require.Eventually(t, func() bool { return deliveries.Load() > 1 }, 10*time.Second, 20*time.Millisecond)
				stop()
				require.Equal(t, "proposed", h.item(n1).State)
				require.Equal(t, "proposed", h.item(n2).State)
				rows, err := readStackAttention(ctx, h.pool, h.repoID)
				require.NoError(t, err)
				require.Empty(t, rows)
				require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_merged'`))
				h.exec(`DROP TRIGGER reject_order_receipt ON product_job_events; DROP FUNCTION reject_order_receipt()`)
				stop = runFetchedFixture(t, synced)
				defer stop()
			}
			require.Eventually(t, func() bool { return h.item(n2).State == "landed" }, 10*time.Second, 20*time.Millisecond)
			rows, err := readStackAttention(ctx, h.pool, h.repoID)
			require.NoError(t, err)
			require.Len(t, rows, 1)
			require.Equal(t, int64(1), rows[0].Revision)
			require.Len(t, rows[0].Entries, 1)
			if mode != "missing manifest" && mode != "superseded" {
				require.Equal(t, "landed", h.item(n1).State)
				require.Equal(t, "T2 merged before T1; T1's change is in T2's commit", h.item(n1).Reason)
				require.NotNil(t, mythicalChecksOf(h.item(n1)).MergedVia)
				require.Equal(t, pr2, mythicalChecksOf(h.item(n1)).MergedVia.Pull)
				if mode != "unknown merge" {
					require.Nil(t, mythicalChecksOf(h.item(n1)).Land)
				} else {
					require.NotNil(t, mythicalChecksOf(h.item(n1)).Land)
				}
				if mode == "unknown merge" {
					require.Equal(t, "unknown", h.operation(n1).State, "fold preserves the lookup obligation")
				}
				if mode == "settled issue before comment" {
					h.exec(`UPDATE mythical_items SET checks=jsonb_set(checks,'{completion,outcome}','"closed"'),version=version+1 WHERE number=$1`, n1)
				}
				if mode == "lost close answer" {
					path := fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr1)
					h.fake.OnNextRequest(http.MethodPatch, path, func() { h.fake.LoseNextResponses(path, 1) })
				}
				if mode == "lost comment answer" {
					path := fmt.Sprintf("/repos/rehearsal-owner/app/issues/%d/comments", pr1)
					h.fake.OnNextRequest(http.MethodPost, path, func() { h.fake.LoseNextResponses(path, 1) })
				}
				for range 4 {
					h.pass()
				}
				if mode == "unknown merge" {
					require.Equal(t, "open", h.pull(pr1).State, "an unresolved merge keeps its lookup obligation")
					require.Equal(t, "unknown", h.operation(n1).State)
					h.push(n1, "moved after fold\n")
					for range 4 {
						h.pass()
					}
				}
				require.Equal(t, "closed", h.pull(pr1).State)
				if linkedIssue > 0 {
					for range 4 {
						h.pass()
					}
					issue, ok := h.fake.Issue("rehearsal-owner/app", linkedIssue)
					require.True(t, ok)
					expected := "open"
					if mode == "fixing issue" {
						expected = "closed"
					}
					require.Equal(t, expected, issue.State)
				}
				card, err := h.service.Todo(ctx, h.repoID, n1)
				require.NoError(t, err)
				require.Equal(t, n2, card["merged_via"])
			} else {
				require.Equal(t, "proposed", h.item(n1).State)
				require.Equal(t, "T2 merged out of order; containment of T1 is unverified", rows[0].Entries[0].Text)
				require.Equal(t, "open", h.pull(pr1).State)
			}
			require.NoError(t, synced.pollInstallPull(ctx, row, pr2))
			require.Eventually(t, func() bool {
				return fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id='pulls' AND state<>'completed'`) == 0
			}, 10*time.Second, 20*time.Millisecond)
			after, err := readStackAttention(ctx, h.pool, h.repoID)
			require.NoError(t, err)
			require.Equal(t, rows, after)
			if mode != "missing manifest" && mode != "superseded" {
				posts := 0
				for _, write := range h.fake.Writes() {
					if write.Method == http.MethodPost && write.Path == fmt.Sprintf("/repos/rehearsal-owner/app/issues/%d/comments", pr1) {
						var body struct {
							Body string `json:"body"`
						}
						require.NoError(t, json.Unmarshal(write.Body, &body))
						if strings.Contains(body.Body, "Merged via #") {
							posts++
						}
					}
				}
				require.Equal(t, 1, posts, "recovery and duplicate polling retain one effective PR note")
			}
			require.Empty(t, h.merges(), "external merge must never produce a Smithers merge PUT")
			_, block := h.mergeCard(n3)
			require.Equal(t, "attention", block["reason"])
			attention, err := h.service.StackAttention(h.ctx, h.repoID, h.userID)
			require.NoError(t, err)
			require.Len(t, attention, 1)
			require.Equal(t, rows[0].ID, attention[0]["id"])
			require.Equal(t, "stale_attention", refusalOf(t, h.service.OrderOK(h.ctx, h.repoID, rows[0].ID, 2)).Code)
			require.NoError(t, h.service.OrderOK(h.ctx, h.repoID, rows[0].ID, 1))
			require.NoError(t, h.service.OrderOK(h.ctx, h.repoID, rows[0].ID, 1), "duplicate OK is harmless")
			require.NoError(t, stackMergeAttention(ctx, h.pool, h.repoID))
			require.Equal(t, 1, fetchedCount(t, pool, fmt.Sprintf(`SELECT count(*) FROM product_job_events WHERE event_type='todo.github_merged' AND data->>'n'='%d'`, n2)))
		})
	}
}

func TestOrderAttentionAppendRollbackAndRevision(t *testing.T) {
	h := newMergeHarness(t)
	h.exec(`INSERT INTO install_settings(key,value) VALUES ('owner.access', jsonb_build_object('last_access_check_at','2026-10-07T00:00:00Z','owner_login','smithers-canary','repository_name','smithers','repository_id',$1::bigint)) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, h.repoID)
	ctx := context.Background()
	add := func(tx pgx.Tx, key, text string) error {
		return appendOrderAttention(ctx, tx, h.repoID, stackAttentionEntry{Key: key, Text: text, Todo: 3})
	}
	tx, err := h.pool.Begin(ctx)
	require.NoError(t, err)
	require.NoError(t, add(tx, "3:sha", "first"))
	require.NoError(t, tx.Rollback(ctx))
	rows, err := readStackAttention(ctx, h.pool, h.repoID)
	require.NoError(t, err)
	require.Empty(t, rows)
	require.NoError(t, pgx.BeginFunc(ctx, h.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT repository_id FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, h.repoID); err != nil {
			return err
		}
		require.NoError(t, add(tx, "3:sha", "first"))
		require.NoError(t, add(tx, "3:sha", "duplicate"))
		return add(tx, "4:sha", "second")
	}))
	rows, err = readStackAttention(ctx, h.pool, h.repoID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, int64(2), rows[0].Revision)
	require.Equal(t, []stackAttentionEntry{{Key: "3:sha", Text: "first", Todo: 3}, {Key: "4:sha", Text: "second", Todo: 3}}, rows[0].Entries)
	require.Equal(t, "stale_attention", refusalOf(t, h.service.OrderOK(h.ctx, h.repoID, rows[0].ID, 1)).Code)
	require.NoError(t, h.service.OrderOK(h.ctx, h.repoID, rows[0].ID, 2))
}

func TestOrderAttentionFencesMergeRequestAndDispatch(t *testing.T) {
	for _, when := range []string{"before request", "after request"} {
		t.Run(when, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, _ := h.first("Fence")
			if when == "after request" {
				require.NoError(t, h.press(h.ctx, n, head))
			}
			require.NoError(t, pgx.BeginFunc(h.ctx, h.pool, func(tx pgx.Tx) error {
				if _, err := tx.Exec(h.ctx, `SELECT repository_id FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, h.repoID); err != nil {
					return err
				}
				return appendOrderAttention(h.ctx, tx, h.repoID, stackAttentionEntry{Key: "3:merged", Text: "T3 merged before T2; T2's change is in T3's commit", Todo: 3})
			}))
			if when == "before request" {
				require.Equal(t, "attention", refusalOf(t, h.press(h.ctx, n, head)).Code)
			} else {
				h.pass()
				h.refused(n, "attention", func() string {
					rows, err := readStackAttention(h.ctx, h.pool, h.repoID)
					require.NoError(t, err)
					return "Needs you: " + rows[0].ID
				}())
			}
			require.Empty(t, h.merges())
		})
	}
}

func TestOrderAttentionAppendSerializesWithOK(t *testing.T) {
	h := newMergeHarness(t)
	configureInboundPullPolling(t, h.publicationFixture)
	// Authentic owner-access fixture, as setup's stored repository binding records it.
	h.exec(`INSERT INTO install_settings(key,value) VALUES ('owner.access', jsonb_build_object('last_access_check_at','2026-10-07T00:00:00Z','owner_login','smithers-canary','repository_name','smithers','repository_id',$1::bigint)) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, h.repoID)
	require.NoError(t, pgx.BeginFunc(h.ctx, h.pool, func(tx pgx.Tx) error {
		return appendOrderAttention(h.ctx, tx, h.repoID, stackAttentionEntry{Key: "3:sha", Text: "first", Todo: 3})
	}))
	rows, err := readStackAttention(h.ctx, h.pool, h.repoID)
	require.NoError(t, err)
	tx, err := h.pool.Begin(h.ctx)
	require.NoError(t, err)
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(h.ctx, `SELECT repository_id FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, h.repoID)
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() { done <- h.service.OrderOK(h.ctx, h.repoID, rows[0].ID, 1) }()
	require.NoError(t, appendOrderAttention(h.ctx, tx, h.repoID, stackAttentionEntry{Key: "4:sha", Text: "second", Todo: 4}))
	require.NoError(t, tx.Commit(h.ctx))
	select {
	case err := <-done:
		require.Equal(t, "stale_attention", refusalOf(t, err).Code)
	case <-time.After(10 * time.Second):
		t.Fatal("OK did not release after append")
	}
	after, err := readStackAttention(h.ctx, h.pool, h.repoID)
	require.NoError(t, err)
	require.Nil(t, after[0].SettledAt)
	require.Equal(t, int64(2), after[0].Revision)
	require.NoError(t, h.service.OrderOK(h.ctx, h.repoID, rows[0].ID, 2))
	require.NoError(t, pgx.BeginFunc(h.ctx, h.pool, func(tx pgx.Tx) error {
		return appendOrderAttention(h.ctx, tx, h.repoID, stackAttentionEntry{Key: "5:sha", Text: "third", Todo: 5})
	}))
	final, err := readStackAttention(h.ctx, h.pool, h.repoID)
	require.NoError(t, err)
	require.Len(t, final, 2)
	require.NotNil(t, final[0].SettledAt)
	require.Nil(t, final[1].SettledAt)
}

func TestGitHubInboundMultipleContainedProductionPoll(t *testing.T) {
	for _, partial := range []bool{false, true} {
		t.Run(fmt.Sprint(partial), func(t *testing.T) {
			h := newMergeHarness(t)
			ctx := context.Background()
			n1, _, pr1 := h.first("First")
			n2, _, pr2 := h.todoInReview("Second", h.item(n1).CandidateHead)
			n3, _, pr3 := h.todoInReview("Third", h.item(n2).CandidateHead)
			for range 4 {
				h.pass()
			}
			if partial {
				item := h.item(n3)
				checks := mythicalChecksOf(item)
				for i := range checks.PRManifests {
					var kept []mythicalManifestItem
					for _, included := range checks.PRManifests[i].Included {
						if included.Number != n2 {
							kept = append(kept, included)
						}
					}
					checks.PRManifests[i].Included = kept
				}
				item.Checks = checks.encode()
				_, err := h.q.SaveMythicalItem(ctx, item)
				require.NoError(t, err)
			}
			synced, row := configureInboundPullPolling(t, h.publicationFixture)
			stop := runFetchedFixture(t, synced)
			defer stop()
			h.fake.UpdatePull("rehearsal-owner/app", pr3, func(p *githubfake.Pull) { p.Draft = false })
			h.fake.MergeAsPerson("rehearsal-owner/app", pr3)
			main := NewGitHubMainPullService(h.q, h.host, h.connections, h.connections)
			qualifyMainPullFixture(main)
			main.Sweep(ctx)
			require.NoError(t, main.PollOnce(ctx))
			require.NoError(t, synced.pollInstallPull(ctx, row, pr3))
			require.Eventually(t, func() bool { return h.item(n3).State == "landed" }, 10*time.Second, 20*time.Millisecond)
			rows, err := readStackAttention(ctx, h.pool, h.repoID)
			require.NoError(t, err)
			require.Len(t, rows, 1)
			require.Len(t, rows[0].Entries, 1)
			expected := "T3 merged before T1; T1's change is in T3's commit\nT3 merged before T2; T2's change is in T3's commit"
			if partial {
				expected = "T3 merged before T1; T1's change is in T3's commit\nT3 merged out of order; containment of T2 is unverified"
			}
			require.Equal(t, expected, rows[0].Entries[0].Text)
			require.Equal(t, "landed", h.item(n1).State)
			if partial {
				require.Equal(t, "proposed", h.item(n2).State, "the inbound fold leaves unproven items unchanged")
			}
			for range 4 {
				h.pass()
			}
			require.Equal(t, "closed", h.pull(pr1).State)
			if partial {
				require.NotEqual(t, "landed", h.item(n2).State, "ordinary rebase work cannot claim containment")
				require.Equal(t, "open", h.pull(pr2).State)
			} else {
				require.Equal(t, "landed", h.item(n2).State)
				require.Equal(t, "closed", h.pull(pr2).State)
				require.Equal(t, "T3 merged before T2; T2's change is in T3's commit", h.item(n2).Reason)
			}
			require.Empty(t, h.merges())
		})
	}
}

func TestGitHubInboundLaterUndraftedProductionPoll(t *testing.T) {
	h := newMergeHarness(t)
	n1, _, _ := h.first("First")
	n2, _, pr2 := h.todoInReview("Second", h.item(n1).CandidateHead)
	for range 4 {
		h.pass()
	}
	before := len(h.fake.Writes())
	synced, row := configureInboundPullPolling(t, h.publicationFixture)
	stop := runFetchedFixture(t, synced)
	defer stop()
	h.fake.UpdatePull("rehearsal-owner/app", pr2, func(p *githubfake.Pull) { p.Draft = false })
	require.NoError(t, synced.pollInstallPull(context.Background(), row, pr2))
	require.Eventually(t, func() bool { return !mythicalChecksOf(h.item(n2)).PRDraft }, 10*time.Second, 20*time.Millisecond)
	for range 3 {
		h.pass()
	}
	require.False(t, h.pull(pr2).Draft)
	_, block := h.mergeCard(n2)
	require.Equal(t, "order", block["reason"])
	require.Empty(t, h.merges())
	for _, write := range h.fake.Writes()[before:] {
		require.NotContains(t, string(write.Body), "convertPullRequestToDraft")
	}
}

func TestGitHubInboundClaimBeforeFoldProductionPoll(t *testing.T) {
	h := newMergeHarness(t)
	ctx := context.Background()
	n1, head, pr1 := h.first("First")
	_, _, pr2 := h.todoInReview("Second", h.item(n1).CandidateHead)
	for range 4 {
		h.pass()
	}
	require.NoError(t, h.press(h.ctx, n1, head))
	h.fake.DelayNextMerge("rehearsal-owner/app", pr1)
	h.pass()
	require.Len(t, h.merges(), 1)
	require.Equal(t, "unknown", h.operation(n1).State)
	synced, row := configureInboundPullPolling(t, h.publicationFixture)
	stop := runFetchedFixture(t, synced)
	defer stop()
	h.fake.UpdatePull("rehearsal-owner/app", pr2, func(p *githubfake.Pull) { p.Draft = false })
	h.fake.MergeAsPerson("rehearsal-owner/app", pr2)
	main := NewGitHubMainPullService(h.q, h.host, h.connections, h.connections)
	qualifyMainPullFixture(main)
	main.Sweep(ctx)
	require.NoError(t, main.PollOnce(ctx))
	require.NoError(t, synced.pollInstallPull(ctx, row, pr2))
	require.Eventually(t, func() bool { return h.item(n1).State == "landed" }, 10*time.Second, 20*time.Millisecond)
	require.Equal(t, "unknown", h.operation(n1).State)
	h.pass()
	require.Len(t, h.merges(), 1)
	h.fake.CompleteDelayedMerges()
	require.True(t, h.pull(pr1).Merged)
	main.Sweep(ctx)
	require.NoError(t, main.PollOnce(ctx))
	for range 5 {
		h.pass()
	}
	require.Empty(t, h.item(n1).PendingOp)
	require.Len(t, h.merges(), 1, "fold and lookup must never issue a second merge")
	require.Equal(t, "T2 merged before T1; T1's change is in T2's commit", h.item(n1).Reason)
	require.Equal(t, 1, fetchedCount(t, h.pool.(*pgxpool.Pool), fmt.Sprintf(`SELECT count(*) FROM product_job_events WHERE event_type='todo.github_merged' AND data->>'n'='%d'`, n1)))
	comments := 0
	for _, write := range h.fake.Writes() {
		if write.Method == http.MethodPost && write.Path == fmt.Sprintf("/repos/rehearsal-owner/app/issues/%d/comments", pr1) {
			var body struct {
				Body string `json:"body"`
			}
			require.NoError(t, json.Unmarshal(write.Body, &body))
			if strings.Contains(body.Body, "Merged via #") {
				comments++
			}
		}
	}
	require.Equal(t, 1, comments, "the fold's keyed PR note is still owed if the earlier merge completes")
}
