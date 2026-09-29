package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// The repository wiki the mythical stack keeps current (D-09b). After every
// fold, while the stack is current, the worker refreshes the pages the
// repository's .smithers/coding-project.json declares: it runs coding/wiki
// (flows/coding/wiki/flow.ts) on a short-lived wiki workspace standing on the
// stack tip, whose tree is exactly the folded main, carrying the last
// refresh's reviews so unchanged pages are not reviewed again. The run's
// projection records its outcome; the next pass publishes the verified pages
// as generated-<id> through the wiki store, keeping any page a person edited.

var mythicalWikiPageID = regexp.MustCompile(`^[a-z][a-z0-9-]{0,80}$`)
var mythicalWikiSourceLink = regexp.MustCompile(`\]\(\.\./sources/([A-Za-z0-9_./@-]+)(#L[1-9][0-9]*)?\)`)

const (
	mythicalWikiFlow        = "coding/wiki"
	mythicalWikiBindingKind = "mythical-wiki"
	mythicalWikiProject     = ".smithers/coding-project.json"
	// Automatic attempts at one folded main; the wiki route retries after.
	mythicalWikiAttempts = 3
	// A run that has not finished by then failed, whatever its host says.
	mythicalWikiTimeout = 3 * time.Hour
	// The published pages a stack request carries into planning.
	mythicalWikiMemoryBytes = 64 << 10
	mythicalWikiSlugPrefix  = "generated-"
)

// mythicalWikiStore is the wiki store the refresh publishes through, as the
// stack's actor.
type mythicalWikiStore interface {
	GetWikiPage(ctx context.Context, viewer *db.User, owner, repo, slug string) (WikiPageResponse, error)
	CreateWikiPage(ctx context.Context, actor *db.User, owner, repo string, input CreateWikiPageInput) (WikiPageResponse, error)
	UpdateWikiPage(ctx context.Context, actor *db.User, owner, repo, slug string, input UpdateWikiPageInput) (WikiPageResponse, error)
	DeleteWikiPageAtRevision(ctx context.Context, actor *db.User, owner, repo, slug string, revision int64) error
}

// SetWiki connects the wiki store the refresh publishes to.
func (s *MythicalService) SetWiki(store mythicalWikiStore) { s.wikiStore = store }

// mythicalWikiPage is one published page as the row keeps it. Body is the
// generated text (what planning reads); BodyDigest the digest of the body
// this service last wrote to the wiki, which tells a person's edit apart.
type mythicalWikiPage struct {
	ID          string `json:"id"`
	Slug        string `json:"slug"`
	Title       string `json:"title"`
	Kind        string `json:"kind"`
	Body        string `json:"body"`
	Ref         string `json:"ref,omitempty"`
	BodyDigest  string `json:"bodyDigest"`
	InputDigest string `json:"inputDigest"`
	Revision    int64  `json:"revision"`
	Edited      bool   `json:"edited,omitempty"`
}

// mythicalWikiResult is coding/wiki's success (flows/coding/wiki-refresh.ts
// WikiRefreshResult).
type mythicalWikiResult struct {
	CommitID       string `json:"commitId"`
	WikiRunID      string `json:"wikiRunId"`
	ArtifactDigest string `json:"artifactDigest"`
	Receipt        struct {
		SourceRevision string `json:"sourceRevision"`
		InputDigest    string `json:"inputDigest"`
		Verification   string `json:"verification"`
		Pages          int    `json:"pages"`
	} `json:"receipt"`
	// Reviews counts the pages the reviewer read this refresh (cold) and the
	// pages whose earlier review was reused; absent from an older host, whose
	// receipt then says nothing rather than zero.
	Reviews *struct {
		Cold   int `json:"cold"`
		Reused int `json:"reused"`
	} `json:"reviews"`
	Pool  json.RawMessage `json:"pool"`
	Pages []struct {
		ID            string  `json:"id"`
		Title         string  `json:"title"`
		Kind          string  `json:"kind"`
		Body          string  `json:"body"`
		InputDigest   string  `json:"inputDigest"`
		ContentDigest string  `json:"contentDigest"`
		ReviewDigest  *string `json:"reviewDigest"`
		Sources       []struct {
			Path   string `json:"path"`
			Digest string `json:"digest"`
		} `json:"sources"`
	} `json:"pages"`
}

func decodeMythicalWikiResult(raw []byte) (mythicalWikiResult, error) {
	var result mythicalWikiResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return result, errors.New("the refresh answered no readable pages")
	}
	if result.Receipt.Verification != "verified" || len(result.Pages) == 0 || len(result.Pages) > 30 {
		return result, errors.New("the refresh did not answer verified pages")
	}
	seen := map[string]bool{}
	for _, page := range result.Pages {
		if !mythicalWikiPageID.MatchString(page.ID) || seen[page.ID] || strings.TrimSpace(page.Title) == "" || len(page.Title) > 512 || page.Body == "" ||
			len(page.Body) > maxWikiBodyBytes || (page.Kind != "current" && page.Kind != "intent") {
			return result, errors.New("the refresh answered an invalid page")
		}
		seen[page.ID] = true
	}
	return result, nil
}

// mythicalWikiProjection correlates a coding/wiki run with one refresh.
type mythicalWikiProjection struct {
	Kind         string `json:"kind"`
	RepositoryID int64  `json:"repositoryId"`
	Generation   int64  `json:"generation"`
}

// wikiEnabled reads whether the folded main declares a wiki.
func (s *MythicalService) wikiEnabled(ctx context.Context, r *mythicalRun) (bool, error) {
	if !r.g.has(ctx, r.row.LandedMain) {
		if err := r.g.fetch(ctx, r.bridge.URL(), 1, 0, "refs/heads/"+r.branch); err != nil {
			return false, fmt.Errorf("fetch main: %s", sanitizeMirrorError(err, r.bridge.URL()))
		}
	}
	if _, err := r.g.git(ctx, "cat-file", "-e", r.row.LandedMain+":"+mythicalWikiProject); err != nil {
		if r.g.has(ctx, r.row.LandedMain) {
			return false, nil
		}
		return false, err
	}
	text, err := r.g.git(ctx, "show", r.row.LandedMain+":"+mythicalWikiProject)
	if err != nil {
		return false, err
	}
	var project struct {
		Wiki  bool              `json:"wiki"`
		Pages []json.RawMessage `json:"pages"`
	}
	// An unreadable project declares no wiki here; the coding host refuses it by name.
	if json.Unmarshal([]byte(text), &project) != nil {
		return false, nil
	}
	return project.Wiki && len(project.Pages) > 0, nil
}

// advanceWiki moves the repository's wiki refresh one step. The stack is
// current (its tip has the folded main's tree) when this runs.
func (s *MythicalService) advanceWiki(ctx context.Context, r *mythicalRun) {
	if s.launcher == nil || s.lanes == nil || !r.row.ActorUserID.Valid {
		return
	}
	if err := s.stepWiki(ctx, r); err != nil && ctx.Err() == nil {
		s.logger.Warn("mythical.wiki_failed", "repository_id", r.row.RepositoryID, "error", err)
	}
}

func (s *MythicalService) stepWiki(ctx context.Context, r *mythicalRun) error {
	q := s.queries()
	enabled, err := s.wikiEnabled(ctx, r)
	if err != nil {
		return err
	}
	row, err := q.GetMythicalWiki(ctx, r.row.RepositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		if !enabled {
			return nil
		}
		row, err = q.EnsureMythicalWiki(ctx, r.row.RepositoryID)
	}
	if err != nil {
		return err
	}
	now := s.now()
	switch {
	case row.State == "running":
		return s.settleWiki(ctx, r, row, now)
	case !enabled:
		if row.State == "off" && row.WorkspaceID == "" {
			return nil
		}
		next := row
		if err := s.retireWikiWorkspace(ctx, r, &next); err != nil {
			return err
		}
		next.State, next.Requested, next.Error = "off", false, ""
		return s.saveWiki(ctx, r, next)
	}
	// A launch that never started leaves its bound workspace behind.
	if row.WorkspaceID != "" {
		next := row
		if err := s.retireWikiWorkspace(ctx, r, &next); err != nil {
			return err
		}
		return s.saveWiki(ctx, r, next)
	}
	if row.State == "off" {
		next := row
		next.State = "idle"
		return s.saveWiki(ctx, r, next)
	}
	if row.PublishedCommit == r.row.LandedMain && !row.Requested {
		return nil
	}
	attempt := row.Attempt
	if row.CommitID != r.row.LandedMain {
		attempt = 0
	}
	if !row.Requested && (attempt >= mythicalWikiAttempts || (row.NextAttemptAt.Valid && now.Before(row.NextAttemptAt.Time))) {
		return nil
	}
	return s.launchWiki(ctx, r, row, attempt, now)
}

// launchWiki starts one refresh of the folded main on a new wiki workspace.
func (s *MythicalService) launchWiki(ctx context.Context, r *mythicalRun, row db.MythicalWiki, attempt int32, now time.Time) error {
	q := s.queries()
	// The generation is fixed first: the workspace binds to it before it is provisioned.
	bumped := row
	bumped.Generation, bumped.Requested = row.Generation+1, false
	saved, err := q.SaveMythicalWiki(ctx, bumped)
	if err != nil {
		return err
	}
	repository, owner, err := s.repository(ctx, r.row.RepositoryID)
	if err != nil {
		return err
	}
	fail := func(reason string) error {
		current, err := q.GetMythicalWiki(ctx, r.row.RepositoryID)
		if err != nil {
			return err
		}
		next := current
		next.State, next.CommitID, next.Attempt, next.Error = "failed", r.row.LandedMain, attempt+1, reason
		next.NextAttemptAt = pgtype.Timestamptz{Time: now.Add(mythicalWikiBackoff(attempt + 1)), Valid: true}
		s.wakeWikiAt(r.row.RepositoryID, next.NextAttemptAt.Time)
		return s.saveWiki(ctx, r, next)
	}
	workspaceID, err := s.lanes.Create(ctx, repository, owner, r.row.ActorUserID.Int64, fmt.Sprintf("mythical wiki g%d", saved.Generation),
		func(workspaceID string) error {
			bound, err := q.BindMythicalWikiWorkspace(ctx, r.row.RepositoryID, saved.Generation, workspaceID)
			if err == nil && !bound {
				err = errors.New("the wiki refresh moved on before its workspace was bound")
			}
			return err
		})
	if err != nil {
		return fail("no wiki workspace: " + err.Error())
	}
	ref, err := s.retainFor(ctx, r, workspaceID, r.row.TipCommit)
	if err != nil {
		return fail("the stack tip could not reach the wiki workspace: " + err.Error())
	}
	current, err := q.GetMythicalWiki(ctx, r.row.RepositoryID)
	if err != nil {
		return err
	}
	if current.Generation != saved.Generation || current.WorkspaceID != workspaceID {
		return errors.New("the wiki refresh changed while it was launched")
	}
	var prior any
	if len(current.Pool) > 0 {
		prior = current.Pool
	}
	payload, _ := json.Marshal(map[string]any{"base": map[string]string{"commitId": r.row.TipCommit, "ref": ref}, "prior": prior})
	next := current
	next.State, next.CommitID, next.BaseCommit, next.RunID, next.Outcome, next.Result = "running", r.row.LandedMain, r.row.TipCommit, "", "", nil
	next.Attempt, next.Error = attempt+1, ""
	next.StartedAt = pgtype.Timestamptz{Time: now, Valid: true}
	return s.admitWiki(ctx, r, next, payload)
}

// admitWiki saves the running refresh and admits its launch in one
// transaction, so a crash never leaves a launch the row does not know about.
func (s *MythicalService) admitWiki(ctx context.Context, r *mythicalRun, next db.MythicalWiki, payload json.RawMessage) error {
	tx, err := s.store.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	saved, err := db.New(tx).SaveMythicalWiki(ctx, next)
	if err != nil {
		return err
	}
	tenant, principal := "repository:"+strconv.FormatInt(r.row.RepositoryID, 10), "user:"+strconv.FormatInt(r.row.ActorUserID.Int64, 10)
	projection, _ := json.Marshal(mythicalWikiProjection{Kind: mythicalWikiBindingKind, RepositoryID: r.row.RepositoryID, Generation: saved.Generation})
	authorization, _ := json.Marshal(map[string]any{"repositoryId": r.row.RepositoryID, "userId": r.row.ActorUserID.Int64,
		"workspaceId": saved.WorkspaceID, "generation": saved.Generation})
	if _, err := s.launcher.AdmitInTx(ctx, tx, flowdispatch.LaunchRequest{
		Scope:     jobs.Scope{TenantID: tenant, PrincipalID: principal},
		RequestID: fmt.Sprintf("mythical-wiki:%d:%d:%s", r.row.RepositoryID, saved.Generation, saved.CommitID),
		Target: flowruntime.FlowRuntimeTarget{TenantID: tenant, PrincipalID: principal, WorkspaceID: saved.WorkspaceID,
			BindingKind: mythicalWikiBindingKind, BindingID: strconv.FormatInt(r.row.RepositoryID, 10)},
		FlowID: mythicalWikiFlow, Payload: payload, AuthorizationContext: authorization, Projection: projection,
		// The owner turned the stack on; its wiki refreshes run without a per-run approval.
		ApprovalPolicy: flowdispatch.ApprovalAuto,
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		// The acknowledgment may be lost after PostgreSQL committed: the persisted row decides.
		if persisted, readErr := s.queries().GetMythicalWiki(context.WithoutCancel(ctx), r.row.RepositoryID); readErr == nil && persisted.Version == saved.Version {
			s.notify(ctx, s.queries(), r.row.RepositoryID, r.row.Generation, "stack", "")
			return nil
		}
		return err
	}
	s.notify(ctx, s.queries(), r.row.RepositoryID, r.row.Generation, "stack", "")
	return nil
}

// settleWiki publishes a finished refresh, or records its failure.
func (s *MythicalService) settleWiki(ctx context.Context, r *mythicalRun, row db.MythicalWiki, now time.Time) error {
	timedOut := row.StartedAt.Valid && now.Sub(row.StartedAt.Time) > mythicalWikiTimeout
	next := row
	switch {
	case row.Outcome == "succeeded":
		result, err := decodeMythicalWikiResult(row.Result)
		if err == nil && result.CommitID != row.BaseCommit {
			err = errors.New("the refresh reviewed another commit than it was launched on")
		}
		if err == nil {
			var pages []mythicalWikiPage
			if pages, err = s.publishWiki(ctx, r, row, result); err == nil {
				encoded, _ := json.Marshal(pages)
				next.State, next.Outcome, next.Result, next.Error, next.Attempt = "idle", "", nil, "", 0
				next.PublishedCommit, next.PublishedBase = row.CommitID, row.BaseCommit
				next.PublishedAt = pgtype.Timestamptz{Time: now, Valid: true}
				next.Pages, next.Receipt = encoded, mythicalWikiReceipt(row, result, pages)
				if len(result.Pool) > 0 && string(result.Pool) != "null" {
					next.Pool = result.Pool
				}
				if err := s.retireWikiWorkspace(ctx, r, &next); err != nil {
					s.logger.Warn("mythical.wiki_retire_failed", "repository_id", r.row.RepositoryID, "error", err)
				}
				return s.saveWiki(ctx, r, next)
			}
			if !timedOut {
				// The pages stay in the row; the next pass publishes them again.
				next.Error = "publishing the wiki failed: " + err.Error()
				return s.saveWiki(ctx, r, next)
			}
		}
		next.Error = err.Error()
	case row.Outcome != "":
		next.Error = strings.TrimPrefix(row.Outcome, "failed: ")
	case timedOut:
		next.Error = "the refresh did not finish within " + mythicalWikiTimeout.String()
	default:
		return nil
	}
	next.State, next.Outcome, next.Result = "failed", "", nil
	next.NextAttemptAt = pgtype.Timestamptz{Time: now.Add(mythicalWikiBackoff(row.Attempt)), Valid: true}
	if row.Attempt >= 2 {
		// Reviews the refresh cannot read must not fail every later attempt.
		next.Pool = nil
	}
	s.wakeWikiAt(r.row.RepositoryID, next.NextAttemptAt.Time)
	if err := s.retireWikiWorkspace(ctx, r, &next); err != nil {
		s.logger.Warn("mythical.wiki_retire_failed", "repository_id", r.row.RepositoryID, "error", err)
	}
	return s.saveWiki(ctx, r, next)
}

// wakeWikiAt asks the stack worker to look again when a backed-off retry is due.
func (s *MythicalService) wakeWikiAt(repositoryID int64, at time.Time) {
	time.AfterFunc(time.Until(at)+time.Second, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		s.MainMoved(ctx, repositoryID)
	})
}

func mythicalWikiBackoff(attempt int32) time.Duration {
	switch {
	case attempt <= 1:
		return 30 * time.Second
	case attempt == 2:
		return 2 * time.Minute
	default:
		return 10 * time.Minute
	}
}

// mythicalWikiReceipt is what the row retains of a published refresh: the
// runs, the reviewed commits, the snapshot, how many pages were reviewed cold
// or reused an earlier review, the retired source-index pages migration 0037
// removed, and per page its review and exact sources. The review evidence
// itself stays in the run's journal.
func mythicalWikiReceipt(row db.MythicalWiki, result mythicalWikiResult, published []mythicalWikiPage) json.RawMessage {
	type page struct {
		ID            string  `json:"id"`
		InputDigest   string  `json:"inputDigest"`
		ContentDigest string  `json:"contentDigest"`
		ReviewDigest  *string `json:"reviewDigest"`
		Sources       any     `json:"sources"`
	}
	pages := make([]page, 0, len(result.Pages))
	for _, p := range result.Pages {
		pages = append(pages, page{ID: p.ID, InputDigest: p.InputDigest, ContentDigest: p.ContentDigest, ReviewDigest: p.ReviewDigest, Sources: p.Sources})
	}
	// Compare with the last saved refresh so a retried publication reports
	// the same counts even when an earlier attempt already wrote its pages.
	var previous []mythicalWikiPage
	_ = json.Unmarshal(row.Pages, &previous)
	revisions := make(map[string]int64, len(previous))
	for _, p := range previous {
		revisions[p.ID] = p.Revision
	}
	rewritten, unchanged := 0, 0
	for _, p := range published {
		if p.Edited {
			continue
		}
		if revision, had := revisions[p.ID]; had && revision == p.Revision {
			unchanged++
		} else {
			rewritten++
		}
	}
	receipt := map[string]any{"runId": row.RunID, "wikiRunId": result.WikiRunID, "commit": row.CommitID,
		"reviewedCommit": result.CommitID, "artifactDigest": result.ArtifactDigest, "sourceRevision": result.Receipt.SourceRevision,
		"inputDigest": result.Receipt.InputDigest, "verification": result.Receipt.Verification, "reviews": result.Reviews,
		"legacyPagesRemoved": row.LegacyPagesRemoved, "pages": pages, "rewritten": rewritten, "unchanged": unchanged}
	if result.Reviews == nil {
		delete(receipt, "reviews")
	}
	encoded, _ := json.Marshal(receipt)
	return encoded
}

func mythicalWikiDigest(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])
}

// Bind the generator's archived-source links to immutable repository content.
// The retained stack tip has the folded main's tree, but main is the durable
// source address after the refresh workspace and later stack tips are retired.
func mythicalWikiBody(body, owner, repo, commit string) string {
	return mythicalWikiSourceLink.ReplaceAllStringFunc(body, func(link string) string {
		parts := mythicalWikiSourceLink.FindStringSubmatch(link)
		path := strings.Split(parts[1], "/")
		for i, part := range path {
			if part == "" || part == "." || part == ".." {
				return link
			}
			path[i] = url.PathEscape(part)
		}
		return "](/api/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo) + "/contents/" + strings.Join(path, "/") + "?ref=" + url.QueryEscape(commit) + parts[2] + ")"
	})
}

func mythicalWikiNotFound(err error) bool {
	var api *pkgerrors.APIError
	return errors.As(err, &api) && api.Status == 404
}

func mythicalWikiConflict(err error) bool {
	var api *pkgerrors.APIError
	return errors.As(err, &api) && api.Status == 409
}

// publishWiki writes the refresh's pages as generated-<id>. A page a person
// edited, renamed or deleted since this service last wrote it is kept as it
// is and counted as edited; pages the catalog no longer declares are removed
// unless a person edited them.
func (s *MythicalService) publishWiki(ctx context.Context, r *mythicalRun, row db.MythicalWiki, result mythicalWikiResult) ([]mythicalWikiPage, error) {
	if s.wikiStore == nil {
		return nil, errors.New("the wiki store is not configured")
	}
	actor, err := s.queries().GetUserByIDNotDeleted(ctx, r.row.ActorUserID.Int64)
	if err != nil {
		return nil, fmt.Errorf("the stack's actor is unavailable: %w", err)
	}
	previous := map[string]mythicalWikiPage{}
	var old []mythicalWikiPage
	if len(row.Pages) > 0 && json.Unmarshal(row.Pages, &old) == nil {
		for _, page := range old {
			previous[page.ID] = page
		}
	}
	published := make([]mythicalWikiPage, 0, len(result.Pages))
	declared := map[string]bool{}
	for _, page := range result.Pages {
		declared[page.ID] = true
		prev, had := previous[page.ID]
		ref, priorRef := row.CommitID, prev.Ref
		if priorRef == "" {
			// Older receipts rewrote every citation at the published commit.
			priorRef = row.PublishedCommit
		}
		if had && !prev.Edited && page.InputDigest != "" && page.InputDigest == prev.InputDigest &&
			mythicalWikiDigest(prev.Body) == prev.BodyDigest && mythicalWikiBody(page.Body, r.owner, r.repo, priorRef) == prev.Body {
			// Keep immutable source refs only when both reviewed inputs and
			// rendered text match: cross-page labels can change independently.
			page.Body = prev.Body
			ref = priorRef
		} else {
			page.Body = mythicalWikiBody(page.Body, r.owner, r.repo, row.CommitID)
		}
		slug := mythicalWikiSlugPrefix + page.ID
		title := strings.TrimSpace(page.Title)
		digest := mythicalWikiDigest(page.Body)
		entry := mythicalWikiPage{ID: page.ID, Slug: slug, Title: title, Kind: page.Kind, Body: page.Body, Ref: ref, InputDigest: page.InputDigest,
			BodyDigest: prev.BodyDigest, Revision: prev.Revision, Edited: prev.Edited}
		existing, err := s.wikiStore.GetWikiPage(ctx, &actor, r.owner, r.repo, slug)
		switch {
		case err != nil && !mythicalWikiNotFound(err):
			return nil, err
		case err == nil && mythicalWikiDigest(existing.Body) == digest && existing.Title == title:
			// Already this text: written by an earlier pass that did not finish saving.
			entry.BodyDigest, entry.Revision, entry.Edited = digest, existing.Revision, false
		case err != nil && had:
			// A person deleted or renamed the page: it is theirs now.
			entry.Edited = true
		case err != nil:
			created, err := s.wikiStore.CreateWikiPage(ctx, &actor, r.owner, r.repo, CreateWikiPageInput{Slug: slug, Title: title, Body: page.Body})
			if err != nil {
				return nil, err
			}
			entry.BodyDigest, entry.Revision, entry.Edited = digest, created.Revision, false
		case !had || prev.Edited || mythicalWikiDigest(existing.Body) != prev.BodyDigest || existing.Title != prev.Title:
			// A page this service never wrote, or one a person changed since.
			entry.Edited = true
		case prev.BodyDigest == digest && existing.Title == title:
			entry.Revision = existing.Revision
		default:
			revision := existing.Revision
			updated, err := s.wikiStore.UpdateWikiPage(ctx, &actor, r.owner, r.repo, slug,
				UpdateWikiPageInput{ExpectedRevision: &revision, Title: &title, Body: &page.Body})
			if err != nil {
				return nil, err
			}
			entry.BodyDigest, entry.Revision = digest, updated.Revision
		}
		published = append(published, entry)
	}
	for _, prev := range old {
		if declared[prev.ID] || prev.Edited {
			continue
		}
		existing, err := s.wikiStore.GetWikiPage(ctx, &actor, r.owner, r.repo, prev.Slug)
		if err != nil {
			if mythicalWikiNotFound(err) {
				continue
			}
			return nil, err
		}
		if mythicalWikiDigest(existing.Body) == prev.BodyDigest && existing.Title == prev.Title {
			// Only the revision just read is deleted: a person's save in
			// between is kept as theirs.
			err := s.wikiStore.DeleteWikiPageAtRevision(ctx, &actor, r.owner, r.repo, prev.Slug, existing.Revision)
			if err != nil && !mythicalWikiNotFound(err) && !mythicalWikiConflict(err) {
				return nil, err
			}
		}
	}
	return published, nil
}

// retireWikiWorkspace deletes the refresh's workspace and clears it on next.
func (s *MythicalService) retireWikiWorkspace(ctx context.Context, r *mythicalRun, next *db.MythicalWiki) error {
	if next.WorkspaceID == "" {
		return nil
	}
	if err := s.lanes.Delete(ctx, r.row.RepositoryID, r.row.ActorUserID.Int64, next.WorkspaceID); err != nil {
		return err
	}
	next.WorkspaceID = ""
	return nil
}

func (s *MythicalService) saveWiki(ctx context.Context, r *mythicalRun, next db.MythicalWiki) error {
	if _, err := s.queries().SaveMythicalWiki(ctx, next); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// A projection saved first; the next pass sees it.
			s.MainMoved(ctx, r.row.RepositoryID)
			return nil
		}
		return err
	}
	s.notify(ctx, s.queries(), r.row.RepositoryID, r.row.Generation, "stack", "")
	return nil
}

// projectWiki records a coding/wiki run's id and terminal outcome on its
// refresh and wakes the worker. An older generation's projection changes nothing.
func (s *MythicalService) projectWiki(ctx context.Context, update flowdispatch.ProjectionUpdate, projection mythicalWikiProjection) error {
	q := s.queries()
	for range 3 {
		row, err := q.GetMythicalWiki(ctx, projection.RepositoryID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if row.Generation != projection.Generation || row.State != "running" {
			return nil
		}
		next := row
		if runID := strings.TrimSpace(update.Checkpoint.RunID); runID != "" {
			next.RunID = runID
		}
		if row.Outcome == "" {
			switch update.State {
			case jobs.StateCompleted:
				output := ""
				if update.Checkpoint.Run != nil && update.Checkpoint.Run.FinalOutput != nil {
					output = *update.Checkpoint.Run.FinalOutput
				}
				if _, err := decodeMythicalWikiResult([]byte(output)); err != nil {
					next.Outcome = "failed: " + err.Error()
				} else {
					next.Outcome, next.Result = "succeeded", json.RawMessage(output)
				}
			case jobs.StateFailed, jobs.StateCancelled:
				next.Outcome = "failed: " + mythicalWikiFailure(update)
			}
		}
		if next.RunID == row.RunID && next.Outcome == row.Outcome {
			return nil
		}
		if _, err := q.SaveMythicalWiki(ctx, next); errors.Is(err, pgx.ErrNoRows) {
			continue
		} else if err != nil {
			return err
		}
		if next.Outcome != row.Outcome {
			s.MainMoved(ctx, projection.RepositoryID)
		}
		if stack, err := q.GetMythicalStack(ctx, projection.RepositoryID); err == nil {
			s.notify(ctx, q, projection.RepositoryID, stack.Generation, "stack", "")
		}
		return nil
	}
	return errors.New("the wiki refresh is busy; retry the projection")
}

// mythicalWikiFailure is one line naming why a refresh run failed.
func mythicalWikiFailure(update flowdispatch.ProjectionUpdate) string {
	reason := strings.TrimSpace(update.Checkpoint.FailureCode)
	if update.Checkpoint.Receipt != nil {
		if message := strings.TrimSpace(update.Checkpoint.Receipt.Message); message != "" {
			reason = message
		}
	}
	if reason == "" {
		reason = string(update.State)
	}
	if line, _, found := strings.Cut(reason, "\n"); found {
		reason = line
	}
	if len(reason) > 300 {
		reason = reason[:300]
	}
	return reason
}

// RequestWiki asks for a refresh now, or a retry of a failed one. It returns
// at once; the stack worker does the work.
func (s *MythicalService) RequestWiki(ctx context.Context, repositoryID int64) error {
	q := s.queries()
	stack, err := q.GetMythicalStack(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Conflict("create the history first; the stack keeps the wiki current")
	}
	if err != nil {
		return err
	}
	// The stack's first pass after main declares a wiki creates the row.
	row, err := q.GetMythicalWiki(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && row.State == "off") {
		return pkgerrors.Conflict("this repository declares no wiki in " + mythicalWikiProject)
	}
	if err != nil {
		return err
	}
	if _, err := q.RequestMythicalWiki(ctx, repositoryID); err != nil {
		return err
	}
	s.MainMoved(ctx, repositoryID)
	s.notify(ctx, q, repositoryID, stack.Generation, "stack", "")
	return nil
}

// MythicalWikiView is @smthrs/rpc/Mythical MythicalWikiSchema.
type MythicalWikiView struct {
	State           string `json:"state"`
	Commit          string `json:"commit,omitempty"`
	PublishedCommit string `json:"publishedCommit,omitempty"`
	PublishedAt     string `json:"publishedAt,omitempty"`
	Pages           int    `json:"pages"`
	Edited          int    `json:"edited"`
	Attempt         int32  `json:"attempt"`
	RunID           string `json:"runId,omitempty"`
	Error           string `json:"error,omitempty"`
}

// mythicalWikiView answers the snapshot's wiki, or nil while the repository
// declares none.
func mythicalWikiView(row db.MythicalWikiSummary, landedMain string) *MythicalWikiView {
	if row.State == "off" {
		return nil
	}
	view := &MythicalWikiView{Commit: row.CommitID, PublishedCommit: row.PublishedCommit, Attempt: row.Attempt, RunID: row.RunID, Error: row.Error,
		Pages: int(row.Pages), Edited: int(row.Edited)}
	if row.PublishedAt.Valid {
		view.PublishedAt = row.PublishedAt.Time.UTC().Format(time.RFC3339)
	}
	switch {
	// A person's request is refreshing from the moment it is recorded.
	case row.State == "running" || row.Requested:
		view.State = "refreshing"
	case row.State == "failed":
		view.State = "failed"
	case row.PublishedCommit != "" && row.PublishedCommit == landedMain:
		view.State, view.Error = "current", ""
	default:
		view.State = "stale"
	}
	return view
}

// suppliedWiki is the published wiki a stack request carries into planning
// (flows/coding/schema.ts SuppliedWiki), trimmed to the memory budget; nil
// with ok false when the repository declares none.
func (s *MythicalService) suppliedWiki(ctx context.Context, repositoryID int64) (any, bool) {
	row, err := s.queries().GetMythicalWiki(ctx, repositoryID)
	if err != nil || row.State == "off" {
		return nil, false
	}
	var pages []mythicalWikiPage
	if row.PublishedCommit == "" || json.Unmarshal(row.Pages, &pages) != nil || len(pages) == 0 {
		return nil, true
	}
	type supplied struct {
		ID          string `json:"id"`
		Title       string `json:"title"`
		Kind        string `json:"kind"`
		Body        string `json:"body"`
		InputDigest string `json:"inputDigest"`
	}
	out, total := []supplied{}, 0
	for _, page := range pages {
		if len(page.Body) > 64<<10 || total+len(page.Body) > mythicalWikiMemoryBytes {
			continue
		}
		total += len(page.Body)
		out = append(out, supplied{ID: page.ID, Title: page.Title, Kind: page.Kind, Body: page.Body, InputDigest: page.InputDigest})
	}
	return map[string]any{"sourceRevision": "main@" + row.PublishedCommit, "pages": out}, true
}

// resolveWikiTarget authorizes a coding/wiki launch against the repository's
// refresh and stack before the flowhost resolver starts a host.
func (resolver *MythicalFlowHostTargetResolver) resolveWikiTarget(ctx context.Context, target flowruntime.FlowRuntimeTarget) (flowhost.Authority, error) {
	repositoryID, repositoryOK := scopedFlowRuntimeID(target.TenantID, "repository:")
	userID, userOK := scopedFlowRuntimeID(target.PrincipalID, "user:")
	bound, err := strconv.ParseInt(target.BindingID, 10, 64)
	if !repositoryOK || !userOK || err != nil || bound != repositoryID {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_target_invalid"}
	}
	q := resolver.service.queries()
	row, err := q.GetMythicalWiki(ctx, repositoryID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_target_not_found"}
		}
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_binding_unavailable", retryable: true}
	}
	stack, err := q.GetMythicalStack(ctx, repositoryID)
	if err != nil {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_binding_unavailable", retryable: !errors.Is(err, pgx.ErrNoRows)}
	}
	if !stack.ActorUserID.Valid || stack.ActorUserID.Int64 != userID || row.WorkspaceID == "" ||
		(target.WorkspaceID != "" && target.WorkspaceID != row.WorkspaceID) {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_target_forbidden"}
	}
	return flowhost.Authority{Target: target, RepositoryID: repositoryID, UserID: userID, WorkspaceID: row.WorkspaceID,
		CatalogKey: flowhost.CatalogCoding}, nil
}
