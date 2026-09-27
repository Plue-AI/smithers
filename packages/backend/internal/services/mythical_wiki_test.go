package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// fakeWikiStore is the wiki store: pages by slug, with revisions.
type fakeWikiStore struct {
	mu      sync.Mutex
	pages   map[string]WikiPageResponse
	writes  []string
	actorID int64
	// afterRead runs once after the next read of a slug, as a person saving
	// between the service's read and its write would.
	afterRead map[string]func()
}

func (w *fakeWikiStore) GetWikiPage(_ context.Context, viewer *db.User, _, _, slug string) (WikiPageResponse, error) {
	w.mu.Lock()
	hook := w.afterRead[slug]
	delete(w.afterRead, slug)
	defer func() {
		w.mu.Unlock()
		if hook != nil {
			hook()
		}
	}()
	w.actorID = viewer.ID
	page, ok := w.pages[slug]
	if !ok {
		return WikiPageResponse{}, pkgerrors.NotFound("wiki page not found")
	}
	return page, nil
}

func (w *fakeWikiStore) CreateWikiPage(_ context.Context, _ *db.User, _, _ string, input CreateWikiPageInput) (WikiPageResponse, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.pages[input.Slug]; ok {
		return WikiPageResponse{}, pkgerrors.Conflict("exists")
	}
	page := WikiPageResponse{Slug: input.Slug, Title: input.Title, Body: input.Body, Revision: 1}
	w.pages[input.Slug] = page
	w.writes = append(w.writes, "create "+input.Slug)
	return page, nil
}

func (w *fakeWikiStore) UpdateWikiPage(_ context.Context, _ *db.User, _, _, slug string, input UpdateWikiPageInput) (WikiPageResponse, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	page, ok := w.pages[slug]
	if !ok {
		return WikiPageResponse{}, pkgerrors.NotFound("wiki page not found")
	}
	if input.ExpectedRevision != nil && *input.ExpectedRevision != page.Revision {
		return WikiPageResponse{}, pkgerrors.Conflict("wiki changed")
	}
	if input.Title != nil {
		page.Title = *input.Title
	}
	if input.Body != nil {
		page.Body = *input.Body
	}
	page.Revision++
	w.pages[slug] = page
	w.writes = append(w.writes, "update "+slug)
	return page, nil
}

func (w *fakeWikiStore) DeleteWikiPageAtRevision(_ context.Context, _ *db.User, _, _, slug string, revision int64) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if page, ok := w.pages[slug]; ok && page.Revision != revision {
		return pkgerrors.Conflict("wiki changed")
	}
	delete(w.pages, slug)
	w.writes = append(w.writes, "delete "+slug)
	return nil
}

// personEdits changes a page as a person would.
func (w *fakeWikiStore) personEdits(slug, body string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	page := w.pages[slug]
	page.Body, page.Revision = body, page.Revision+1
	w.pages[slug] = page
}

func (w *fakeWikiStore) body(slug string) string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.pages[slug].Body
}

func (w *fakeWikiStore) takeWrites() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	writes := w.writes
	w.writes = nil
	return writes
}

const wikiProject = `{"wiki": true, "wikiOutput": "../wiki", "reviewer": "r", "implementation": "coding/implementation",
"pages": [{"id": "runtime"}, {"id": "flows"}], "checks": []}`

// wikiResult is coding/wiki's answer for the named pages at commit.
func wikiResult(commit, pool string, pages ...string) string {
	type page struct {
		ID          string `json:"id"`
		Title       string `json:"title"`
		Kind        string `json:"kind"`
		Body        string `json:"body"`
		InputDigest string `json:"inputDigest"`
	}
	var out []page
	for i := 0; i+1 < len(pages); i += 2 {
		out = append(out, page{ID: pages[i], Title: pages[i] + " title", Kind: "current", Body: pages[i+1], InputDigest: "sha-" + pages[i+1]})
	}
	encoded, _ := json.Marshal(map[string]any{"commitId": commit, "wikiRunId": "wiki-run", "artifactDigest": fmt.Sprintf("%064d", 1),
		"receipt": map[string]any{"schemaVersion": 1, "sourceRevision": "sha256:x", "inputDigest": "x", "output": "/o", "pages": len(out), "verification": "verified"},
		"reviews": map[string]any{"cold": len(out) - 1, "reused": 1}, "pool": json.RawMessage(pool), "pages": out})
	return string(encoded)
}

func (o *mythicalOrchestration) wiki() db.MythicalWiki {
	o.t.Helper()
	row, err := db.New(o.pool).GetMythicalWiki(context.Background(), o.repoID)
	require.NoError(o.t, err)
	return row
}

func (o *mythicalOrchestration) wikiView() *MythicalWikiView {
	o.t.Helper()
	view, err := o.service.Snapshot(context.Background(), o.repoID, "smithers-canary/smithers", "", MythicalViewer{})
	require.NoError(o.t, err)
	return view.Wiki
}

// dueWiki makes a backed-off wiki refresh due now.
func (o *mythicalOrchestration) dueWiki() {
	o.t.Helper()
	_, err := o.pool.Exec(context.Background(), `UPDATE mythical_wikis SET next_attempt_at = NOW() WHERE repository_id = $1`, o.repoID)
	require.NoError(o.t, err)
}

func (o *mythicalOrchestration) declareWiki() string {
	o.t.Helper()
	require.NoError(o.t, os.MkdirAll(filepath.Join(o.work, ".smithers"), 0o755))
	o.commit("🔧 chore: declare the wiki", ".smithers/coding-project.json", wikiProject)
	return o.publish()
}

func TestMythicalWikiRefreshesAfterEveryFoldAndKeepsEdits(t *testing.T) {
	o := newMythicalOrchestration(t)
	store := &fakeWikiStore{pages: map[string]WikiPageResponse{}}
	o.service.SetWiki(store)
	ctx := context.Background()

	// A stack without a declared wiki has none.
	o.wake()
	assert.Nil(t, o.wikiView())
	assert.Empty(t, o.launcher.requests)
	require.Error(t, o.service.RequestWiki(ctx, o.repoID), "no wiki is declared")

	// Main declares the wiki: the fold starts a refresh on the folded tip.
	main := o.declareWiki()
	stack := o.wake()
	require.Equal(t, main, stack.LandedMain, stack.LastError)
	request := o.launcher.last(mythicalWikiFlow)
	require.Equal(t, mythicalWikiBindingKind, request.Target.BindingKind)
	row := o.wiki()
	require.Equal(t, "running", row.State, row.Error)
	assert.Equal(t, main, row.CommitID)
	assert.Equal(t, request.Target.WorkspaceID, row.WorkspaceID)
	var payload struct {
		Base struct {
			CommitID string `json:"commitId"`
			Ref      string `json:"ref"`
		} `json:"base"`
		Prior json.RawMessage `json:"prior"`
	}
	require.NoError(t, json.Unmarshal(request.Payload, &payload))
	assert.Equal(t, stack.TipCommit, payload.Base.CommitID, "the refresh stands on the tip, whose tree is the folded main")
	assert.Equal(t, stack.TipCommit, o.hostRef(payload.Base.Ref))
	assert.Equal(t, "null", string(payload.Prior), "a first refresh carries no reviews")
	assert.Equal(t, "refreshing", o.wikiView().State)

	// The target resolver authorizes exactly the bound workspace.
	resolver := NewMythicalFlowHostTargetResolver(o.service)
	authority, err := resolver.ResolveFlowHostTarget(ctx, request.Target)
	require.NoError(t, err)
	assert.Equal(t, row.WorkspaceID, authority.WorkspaceID)
	forged := request.Target
	forged.WorkspaceID = "00000000-0000-4000-8000-000000000000"
	_, err = resolver.ResolveFlowHostTarget(ctx, forged)
	require.Error(t, err)

	// A running refresh is never launched twice, and a person's request waits for it.
	require.NoError(t, o.service.RequestWiki(ctx, o.repoID))
	o.wake()
	assert.Len(t, o.launcher.requests, 1)

	// Migration 0037 counted the retired source-index pages it removed.
	_, err = o.pool.Exec(ctx, `UPDATE mythical_wikis SET legacy_pages_removed = 3 WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)

	// It succeeds: the pages are published as generated-<id>, and the
	// workspace is retired.
	o.project(request, jobs.StateCompleted, "wiki-run-1", wikiResult(stack.TipCommit, `{"policyDigest":"p","policySources":[],"candidates":{}}`,
		"runtime", "Runtime v1", "flows", "Flows v1"))
	o.wake()
	row = o.wiki()
	require.Equal(t, "idle", row.State, row.Error)
	assert.Equal(t, main, row.PublishedCommit)
	assert.ElementsMatch(t, []string{"create generated-runtime", "create generated-flows"}, store.takeWrites())
	assert.Equal(t, "Runtime v1", store.body("generated-runtime"))
	assert.Equal(t, o.userID, store.actorID, "the stack's actor publishes")
	assert.Contains(t, o.lanes.deleted, request.Target.WorkspaceID)
	view := o.wikiView()
	assert.Equal(t, "current", view.State)
	assert.Equal(t, 2, view.Pages)
	var receipt map[string]any
	require.NoError(t, json.Unmarshal(row.Receipt, &receipt))
	assert.Equal(t, "wiki-run-1", receipt["runId"])
	assert.Equal(t, "verified", receipt["verification"])
	assert.Equal(t, map[string]any{"cold": 1.0, "reused": 1.0}, receipt["reviews"], "the receipt says how many pages were reviewed cold")
	assert.Equal(t, 3.0, receipt["legacyPagesRemoved"])

	// A stack request plans with the published pages.
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 7, Title: "Docs", State: "open", AuthorAssociation: "OWNER"}, gitHubLabelApplication{}))
	o.wake()
	var planning struct {
		Wiki struct {
			SourceRevision string `json:"sourceRevision"`
			Pages          []struct {
				ID          string `json:"id"`
				InputDigest string `json:"inputDigest"`
			} `json:"pages"`
		} `json:"wiki"`
	}
	require.NoError(t, json.Unmarshal(o.launcher.last("coding/request").Payload, &planning))
	assert.Equal(t, "main@"+main, planning.Wiki.SourceRevision)
	require.Len(t, planning.Wiki.Pages, 2)
	assert.Equal(t, "sha-Runtime v1", planning.Wiki.Pages[0].InputDigest)

	// Main moves: the wiki is stale until the next refresh, which carries
	// the last reviews. A person edited one page meanwhile.
	store.personEdits("generated-flows", "Flows, as a person wrote it")
	o.commit("✨ feat: three", "c.txt", "c\n")
	next := o.publish()
	stack = o.wake()
	require.Equal(t, next, stack.LandedMain)
	second := o.launcher.last(mythicalWikiFlow)
	require.NotEqual(t, request.RequestID, second.RequestID)
	require.NoError(t, json.Unmarshal(second.Payload, &payload))
	assert.JSONEq(t, `{"policyDigest":"p","policySources":[],"candidates":{}}`, string(payload.Prior))
	assert.Equal(t, "refreshing", o.wikiView().State)

	// An older run's late projection changes nothing.
	o.project(request, jobs.StateFailed, "wiki-run-1", "")
	assert.Equal(t, "running", o.wiki().State)

	// The catalog dropped a page and changed another: the edited page is kept.
	o.project(second, jobs.StateCompleted, "wiki-run-2", wikiResult(stack.TipCommit, `{"policyDigest":"p","policySources":[],"candidates":{}}`,
		"flows", "Flows v2"))
	o.wake()
	row = o.wiki()
	require.Equal(t, "idle", row.State, row.Error)
	assert.Equal(t, next, row.PublishedCommit)
	assert.Equal(t, []string{"delete generated-runtime"}, store.takeWrites(), "the edited page is not overwritten; the dropped one is removed")
	assert.Equal(t, "Flows, as a person wrote it", store.body("generated-flows"))
	view = o.wikiView()
	assert.Equal(t, "current", view.State)
	assert.Equal(t, 1, view.Pages)
	assert.Equal(t, 1, view.Edited)
}

func TestMythicalWikiFailuresStayVisibleAndRetry(t *testing.T) {
	o := newMythicalOrchestration(t)
	store := &fakeWikiStore{pages: map[string]WikiPageResponse{}}
	o.service.SetWiki(store)
	ctx := context.Background()
	o.declareWiki()
	o.wake()
	first := o.launcher.last(mythicalWikiFlow)
	require.NotEmpty(t, first.RequestID)

	// A failed review is visible, retried with backoff, never shown as current.
	failure := jobs.StateFailed
	o.project(first, failure, "wiki-run-1", "")
	o.wake()
	row := o.wiki()
	require.Equal(t, "failed", row.State)
	assert.NotEmpty(t, row.Error)
	view := o.wikiView()
	assert.Equal(t, "failed", view.State)
	assert.Zero(t, view.Pages)
	assert.Contains(t, o.lanes.deleted, first.Target.WorkspaceID)
	o.wake()
	assert.Equal(t, first.RequestID, o.launcher.last(mythicalWikiFlow).RequestID, "backoff holds the retry")

	// After the backoff the worker retries by itself.
	o.dueWiki()
	o.wake()
	second := o.launcher.last(mythicalWikiFlow)
	require.NotEqual(t, first.RequestID, second.RequestID)
	assert.EqualValues(t, 2, o.wiki().Attempt)

	// An answer that is not verified pages fails the refresh.
	o.project(second, jobs.StateCompleted, "wiki-run-2", `{"pages":[]}`)
	o.wake()
	assert.Equal(t, "failed", o.wiki().State)
	o.dueWiki()
	o.wake()
	third := o.launcher.last(mythicalWikiFlow)
	o.project(third, jobs.StateFailed, "wiki-run-3", "")
	o.wake()

	// Three attempts at one main: automatic retries stop; the route retries.
	o.dueWiki()
	o.wake()
	assert.Equal(t, third.RequestID, o.launcher.last(mythicalWikiFlow).RequestID)
	require.NoError(t, o.service.RequestWiki(ctx, o.repoID))
	o.wake()
	retry := o.launcher.last(mythicalWikiFlow)
	require.NotEqual(t, third.RequestID, retry.RequestID)

	// A run that never finishes fails after the timeout.
	_, err := o.pool.Exec(ctx, `UPDATE mythical_wikis SET started_at = $2 WHERE repository_id = $1`, o.repoID, time.Now().Add(-mythicalWikiTimeout-time.Minute))
	require.NoError(t, err)
	o.wake()
	row = o.wiki()
	assert.Equal(t, "failed", row.State)
	assert.Contains(t, row.Error, "did not finish")
}

func TestMythicalWikiRequestIsRefreshingAndAnUnsavedPublishIsStillOurs(t *testing.T) {
	o := newMythicalOrchestration(t)
	store := &fakeWikiStore{pages: map[string]WikiPageResponse{}}
	o.service.SetWiki(store)
	ctx := context.Background()
	o.declareWiki()
	stack := o.wake()
	first := o.launcher.last(mythicalWikiFlow)
	o.project(first, jobs.StateCompleted, "wiki-run-1", wikiResult(stack.TipCommit, `null`, "runtime", "Runtime v1"))
	o.wake()
	require.Equal(t, "current", o.wikiView().State)
	store.takeWrites()

	// A crash after the pages were written but before the row was saved.
	_, err := o.pool.Exec(ctx, `UPDATE mythical_wikis SET pages = '[]'::jsonb WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)

	// A person's request reads as refreshing at once, not as the old current.
	require.NoError(t, o.service.RequestWiki(ctx, o.repoID))
	assert.Equal(t, "refreshing", o.wikiView().State)
	o.wake()
	second := o.launcher.last(mythicalWikiFlow)
	require.NotEqual(t, first.RequestID, second.RequestID)

	// A result for another commit than the launch's is refused.
	o.project(second, jobs.StateCompleted, "wiki-run-2", wikiResult(strings.Repeat("0", 40), `null`, "runtime", "Runtime v1"))
	o.wake()
	assert.Equal(t, "failed", o.wiki().State)
	require.NoError(t, o.service.RequestWiki(ctx, o.repoID))
	o.wake()
	third := o.launcher.last(mythicalWikiFlow)
	o.project(third, jobs.StateCompleted, "wiki-run-3", wikiResult(stack.TipCommit, `null`, "runtime", "Runtime v1"))
	o.wake()
	view := o.wikiView()
	assert.Equal(t, "current", view.State)
	assert.Equal(t, 1, view.Pages)
	assert.Zero(t, view.Edited, "the page this service already wrote is still its own")
	assert.Empty(t, store.takeWrites())
}

// A person's save between the prune's read and its delete is kept: the
// delete is conditioned on the revision the prune read
// (smithersai/smithers#2175).
func TestMythicalWikiPruneKeepsAConcurrentEdit(t *testing.T) {
	o := newMythicalOrchestration(t)
	store := &fakeWikiStore{pages: map[string]WikiPageResponse{}}
	o.service.SetWiki(store)
	o.declareWiki()
	stack := o.wake()
	first := o.launcher.last(mythicalWikiFlow)
	o.project(first, jobs.StateCompleted, "wiki-run-1", wikiResult(stack.TipCommit, `{"policyDigest":"p","policySources":[],"candidates":{}}`,
		"runtime", "Runtime v1", "flows", "Flows v1"))
	o.wake()
	require.Equal(t, "idle", o.wiki().State, o.wiki().Error)
	store.takeWrites()

	o.commit("✨ feat: three", "c.txt", "c\n")
	o.publish()
	stack = o.wake()
	second := o.launcher.last(mythicalWikiFlow)
	store.afterRead = map[string]func(){"generated-runtime": func() { store.personEdits("generated-runtime", "Runtime, as a person wrote it") }}
	o.project(second, jobs.StateCompleted, "wiki-run-2", wikiResult(stack.TipCommit, `{"policyDigest":"p","policySources":[],"candidates":{}}`,
		"flows", "Flows v2"))
	o.wake()
	require.Equal(t, "idle", o.wiki().State, o.wiki().Error)
	assert.Equal(t, "Runtime, as a person wrote it", store.body("generated-runtime"), "the concurrent edit survives the prune")
	assert.Equal(t, "Flows v2", store.body("generated-flows"))
}
