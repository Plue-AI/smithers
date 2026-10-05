package services

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTodoReadyLookupBindsIdentityAndHead(t *testing.T) {
	g := &fakeMythicalGitHub{pulls: map[int64]*mythicalPull{7: {Number: 7, NodeID: "PR_7", State: "open", BaseRef: "main", HeadSHA: "head", Draft: true}}}
	st := &mythicalItemStep{s: &MythicalService{github: g}}
	item := db.MythicalItem{PRNumber: pgtype.Int8{Int64: 7, Valid: true}, PRHead: "head"}
	op := MythicalOutboundOp{Kind: "ready", Target: "7", Precondition: "draft:head", Desired: "ready:head", State: "intended"}
	pull, err := st.readyPull(context.Background(), mythicalGitHubRepo{}, item, op)
	require.NoError(t, err)
	require.True(t, pull.Draft)
	for _, change := range []func(*MythicalOutboundOp){
		func(o *MythicalOutboundOp) { o.Target = "8" }, func(o *MythicalOutboundOp) { o.Target = "-1" }, func(o *MythicalOutboundOp) { o.Target = "invalid" },
		func(o *MythicalOutboundOp) { o.Precondition = "draft:old" }, func(o *MythicalOutboundOp) { o.Desired = "ready:old" },
	} {
		bad := op
		change(&bad)
		_, err = st.readyPull(context.Background(), mythicalGitHubRepo{}, item, bad)
		require.ErrorIs(t, err, errMythicalReadyStale)
	}
	for _, change := range []func(*mythicalPull){
		func(p *mythicalPull) { p.State = "closed" }, func(p *mythicalPull) { p.HeadSHA = "old" }, func(p *mythicalPull) { p.BaseRef = "other" },
		func(p *mythicalPull) { p.NodeID = "" }, func(p *mythicalPull) { p.Merged = true },
	} {
		bad := pull
		change(&bad)
		g.pulls[7] = &bad
		_, err = st.readyPull(context.Background(), mythicalGitHubRepo{}, item, op)
		require.ErrorIs(t, err, errMythicalReadyStale)
	}
}

func FuzzTodoReadyOutbound(f *testing.F) {
	f.Add("head", "draft:head", "ready:head")
	f.Add("a", "changed", "ready:a")
	f.Fuzz(func(t *testing.T, head, observed, desired string) {
		// JSON stores UTF-8 text; compare its canonical representation.
		head = strings.ToValidUTF8(head, "\uFFFD")
		if head == "" || len(head) > 1024 {
			return
		}
		op := MythicalOutboundOp{Kind: "ready", Target: "7", Precondition: "draft:" + head, Desired: "ready:" + head, State: "unknown"}
		raw, _ := json.Marshal(op)
		decoded, err := decodeMythicalOutbound(raw)
		require.NoError(t, err)
		require.Equal(t, op, decoded)
		got := outboundResult(op, observed, false)
		switch {
		case observed == op.Desired:
			require.Equal(t, "done", got)
		case observed == op.Precondition:
			require.Equal(t, "intended", got)
		default:
			require.Equal(t, "conflict", got)
		}
		op.Desired = desired
		if desired == "" {
			raw, _ = json.Marshal(op)
			_, err = decodeMythicalOutbound(raw)
			require.Error(t, err)
		}
	})
}

func readyWrites(f *publicationFixture) int {
	n := 0
	for _, w := range f.fake.Writes() {
		if w.Path == "/graphql" && strings.Contains(string(w.Body), "markPullRequestReadyForReview") {
			n++
		}
	}
	return n
}

// The unit fixture reuses the real PostgreSQL stack worker and GitHub HTTP
// fake. The composed J4 rehearsal additionally proves actual rebase and HTTP.
func TestTodoReadyPromotionRecoversAndDeduplicates(t *testing.T) {
	for _, fault := range []string{"none", "failure", "lost response", "read failure"} {
		t.Run(fault, func(t *testing.T) {
			h := newMergeHarness(t)
			first, head, _ := h.first("First greeting")
			firstItem := h.item(first)
			second := h.todo("Second greeting", "Say goodbye", firstItem.CandidateHead, "SECOND.md", "Goodbye\n")
			h.pass()
			item := h.item(second.Number.Int64)
			require.True(t, mythicalChecksOf(item).PRDraft)
			require.Equal(t, 0, readyWrites(h.publicationFixture), "later PR is not promoted")
			require.NoError(t, h.press(h.ctx, first, head))
			h.pass()
			require.Equal(t, "landed", h.item(first).State)
			// The flow/rebase path is exercised in J4. Here keep this fixture's
			// candidate on its current main so the PR lifecycle is tested alone.
			h.exec(`UPDATE mythical_items SET candidate_base=$1 WHERE id=$2`, h.main, item.ID)
			switch fault {
			case "failure":
				h.fake.FailNextWrites("/graphql", 1)
			case "lost response":
				h.fake.LoseNextResponses("/graphql", 1)
			case "read failure":
				h.fake.FailNextReads("/repos/rehearsal-owner/app/pulls/"+strconv.FormatInt(item.PRNumber.Int64, 10), 1)
			}
			for i := 0; i < 6; i++ {
				h.pass()
			}
			item = h.item(second.Number.Int64)
			require.Empty(t, item.PendingOp)
			require.False(t, mythicalChecksOf(item).PRDraft, item.Reason)
			require.False(t, h.pull(item.PRNumber.Int64).Draft)
			want := 1
			if fault == "failure" {
				want = 2
			}
			require.Equal(t, want, readyWrites(h.publicationFixture))
			h.pass()
			h.pass()
			assert.Equal(t, want, readyWrites(h.publicationFixture))
			successful := 0
			for _, w := range h.fake.Writes() {
				if w.Path == "/graphql" && w.Status == http.StatusOK {
					successful++
				}
			}
			assert.Equal(t, 1, successful)
			state, merge := h.mergeCard(second.Number.Int64)
			assert.Equal(t, "in_review", state)
			assert.Equal(t, "ready", merge["state"])
			// A person can redraft the promoted PR; the worker leaves it alone.
			h.fake.UpdatePull("rehearsal-owner/app", item.PRNumber.Int64, func(p *githubfake.Pull) { p.Draft = true })
			h.pass()
			assert.True(t, mythicalChecksOf(h.item(second.Number.Int64)).PRDraft)
			assert.Equal(t, want, readyWrites(h.publicationFixture))
		})
	}
}

func TestTodoReadyCancelledIntentNeverRepeats(t *testing.T) {
	f := newPublicationFixture(t, false)
	todo := f.todo("Cancelled greeting", "Say hello", f.main, "CANCEL.md", "Hi\n")
	f.wake()
	item := f.item(todo.Number.Int64)
	f.fake.UpdatePull("rehearsal-owner/app", item.PRNumber.Int64, func(p *githubfake.Pull) { p.Draft = true })
	op := MythicalOutboundOp{Kind: "ready", Target: strconv.FormatInt(item.PRNumber.Int64, 10), Precondition: "draft:" + item.PRHead, Desired: "ready:" + item.PRHead, State: "unknown"}
	raw, _ := json.Marshal(op)
	_, err := f.pool.Exec(context.Background(), `UPDATE mythical_items SET state='cancelled',pending_op=$1 WHERE id=$2`, raw, item.ID)
	require.NoError(t, err)
	f.wake()
	require.Equal(t, 0, readyWrites(f))
	require.NotEmpty(t, f.item(todo.Number.Int64).PendingOp)
}

func TestTodoReadyGateIgnoresIneligibleItems(t *testing.T) {
	st := &mythicalItemStep{}
	for _, item := range []db.MythicalItem{
		{}, {State: "landed"}, {State: "cancelled"}, {PRHead: "head", PRNumber: pgtype.Int8{Int64: 1, Valid: true}},
	} {
		next, saved, err := st.readyForReview(context.Background(), item)
		require.NoError(t, err)
		require.Nil(t, next)
		require.False(t, saved)
	}
}

func TestTodoReadyRecoveryYieldsChangedPull(t *testing.T) {
	for _, change := range []string{"head", "closed", "base"} {
		t.Run(change, func(t *testing.T) {
			f := newPublicationFixture(t, false)
			todo := f.todo("Changed greeting", "Say hello", f.main, "CHANGED.md", "Hi\n")
			f.wake()
			item := f.item(todo.Number.Int64)
			f.fake.UpdatePull("rehearsal-owner/app", item.PRNumber.Int64, func(p *githubfake.Pull) {
				p.Draft = true
				switch change {
				case "head":
					p.Head.SHA = "foreign-head"
				case "closed":
					p.State = "closed"
				case "base":
					p.Base.Ref = "topic"
				}
			})
			op := MythicalOutboundOp{Kind: "ready", Target: strconv.FormatInt(item.PRNumber.Int64, 10), Precondition: "draft:" + item.PRHead, Desired: "ready:" + item.PRHead, State: "unknown"}
			raw, _ := json.Marshal(op)
			_, err := f.pool.Exec(context.Background(), `UPDATE mythical_items SET pending_op=$1 WHERE id=$2`, raw, item.ID)
			require.NoError(t, err)
			f.wake()
			require.Equal(t, 0, readyWrites(f))
			require.Empty(t, f.item(todo.Number.Int64).PendingOp)
		})
	}
}
