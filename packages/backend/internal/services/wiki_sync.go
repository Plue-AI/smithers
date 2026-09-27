package services

import (
	"context"
	"encoding/json"
	"errors"
	"path"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// SyncDocument is a provider port, not a second wiki model. Content is read
// through the provider or the existing wiki revision content API.
type SyncDocument struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	Digest    string `json:"digest"`
	Version   string `json:"version"`
	MediaType string `json:"media_type"`
}

// WikiSyncAdapter runs under host scheduling. Apply must compare the expected
// copy, acknowledge an already applied desired copy, and never blindly retry
// an ambiguous remote write. A nil desired document explicitly means deletion.
type WikiSyncAdapter interface {
	Provider() string
	Scope() string
	Scan(context.Context) ([]SyncDocument, error)
	Read(context.Context, SyncDocument) ([]byte, error)
	Apply(context.Context, string, *SyncDocument, *SyncDocument, []byte) (*SyncDocument, error)
}
type wikiSyncBaseline struct {
	Wiki     WikiEvent    `json:"wiki"`
	External SyncDocument `json:"external"`
}
type wikiSyncState struct {
	Projection WikiProjection             `json:"projection"`
	Baselines  map[int64]wikiSyncBaseline `json:"baselines"`
}
type documentSyncIntent struct {
	Expected *SyncDocument `json:"expected"`
	Desired  *SyncDocument `json:"desired"`
	Page     WikiEvent     `json:"page"`
}

// SyncWiki reconciles one explicitly configured repository, visibility and
// provider scope. The host invokes it in the background; it owns no worker.
func (s *WikiService) SyncWiki(ctx context.Context, actor *db.User, owner, repo, connection string, adapter WikiSyncAdapter) error {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if actor == nil {
		return api.Unauthorized("authentication required")
	}
	if err = s.requireWriteAccess(ctx, repository, actor); err != nil {
		return err
	}
	if adapter == nil || (adapter.Provider() != "obsidian" && adapter.Provider() != "notion") || strings.TrimSpace(connection) == "" || len(connection) > 128 || adapter.Scope() == "" {
		return api.BadRequest("invalid document sync connection")
	}
	q, ok := s.queries.(*db.Queries)
	if !ok {
		return wikiUnavailable("sync storage unavailable")
	}
	visibility := wikiVisibility(ctx)
	scopeBytes, _ := json.Marshal([]any{repository.ID, actor.ID, adapter.Provider(), connection, visibility, adapter.Scope()})
	scope := string(scopeBytes)
	// A transaction-scoped advisory lock serializes this host invocation while
	// durable intents and provider receipts commit independently of external IO.
	lock, err := q.BeginTx(ctx)
	if err != nil {
		return err
	}
	defer lock.Rollback(ctx)
	var acquired bool
	if err = lock.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))`, scope).Scan(&acquired); err != nil {
		return err
	}
	if !acquired {
		return api.Conflict("sync is already running")
	}
	_, err = lock.Exec(ctx, `INSERT INTO issue_sync_channels(owner_id,repository_id,provider,connection_id,scope_id,conversation_id,thread_id) VALUES($1,$2,$3,$4,$5,$6,'') ON CONFLICT DO NOTHING`, actor.ID, repository.ID, adapter.Provider(), connection, visibility, adapter.Scope())
	if err != nil {
		return err
	}
	var raw []byte
	err = lock.QueryRow(ctx, `SELECT document_state FROM issue_sync_channels WHERE owner_id=$1 AND repository_id=$2 AND provider=$3 AND connection_id=$4 AND scope_id=$5 AND conversation_id=$6 AND thread_id='' FOR UPDATE`, actor.ID, repository.ID, adapter.Provider(), connection, visibility, adapter.Scope()).Scan(&raw)
	if err != nil {
		return err
	}
	state := wikiSyncState{}
	if err = json.Unmarshal(raw, &state); err != nil {
		return err
	}
	if state.Baselines == nil {
		state.Baselines = map[int64]wikiSyncBaseline{}
	}
	// Recover committed intents first. Their expected copy is immutable across
	// restart, and the adapter acknowledges exact desired state without rewriting.
	if err = s.replayWikiDeliveries(ctx, q, actor, owner, repo, scope, adapter); err != nil {
		return err
	}
	for {
		events, e := s.ListWikiEvents(ctx, actor, owner, repo, state.Projection.Sequence)
		if e != nil {
			return e
		}
		state.Projection, e = FoldWikiEvents(state.Projection, events)
		if e != nil {
			return e
		}
		if len(events) < 100 {
			break
		}
	}
	external, err := adapter.Scan(ctx)
	if err != nil {
		return err
	}
	byID := map[string]SyncDocument{}
	byPath := map[string]SyncDocument{}
	for _, d := range external {
		if d.ID == "" || d.Digest == "" {
			return api.BadRequest("invalid provider document")
		}
		if _, ok := byID[d.ID]; ok {
			return api.Conflict("duplicate provider identity")
		}
		key := strings.ToLower(d.Path)
		if _, ok := byPath[key]; ok {
			return api.Conflict("duplicate provider path")
		}
		byID[d.ID] = d
		byPath[key] = d
	}
	ids := map[int64]bool{}
	for id := range state.Baselines {
		ids[id] = true
	}
	for id := range state.Projection.Pages {
		ids[id] = true
	}
	ordered := make([]int64, 0, len(ids))
	for id := range ids {
		ordered = append(ordered, id)
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i] < ordered[j] })
	for _, id := range ordered {
		base, known := state.Baselines[id]
		page, live := state.Projection.Pages[id]
		var local *SyncDocument
		if known {
			if d, ok := byID[base.External.ID]; ok {
				local = &d
			} else if d, ok := byPath[strings.ToLower(base.External.Path)]; ok {
				local = &d
			}
		} else if live {
			if d, ok := byPath[strings.ToLower(page.Path)]; ok {
				local = &d
			}
		}
		if local != nil {
			delete(byID, local.ID)
			delete(byPath, strings.ToLower(local.Path))
		}
		var remote *SyncDocument
		if live {
			remote = &SyncDocument{Path: page.Path, Digest: page.ContentDigest, MediaType: "text/markdown"}
			if page.Attachment != nil {
				remote.MediaType = page.Attachment.MediaType
			}
		}
		same := sameSyncContent(local, remote)
		localChanged := known && !sameSyncContent(local, &base.External)
		remoteChanged := !known || !live || page.Revision != base.Wiki.Revision
		if same {
			if live {
				state.Baselines[id] = wikiSyncBaseline{Wiki: page, External: *local}
			} else {
				delete(state.Baselines, id)
			}
			continue
		}
		if localChanged && remoteChanged {
			return api.Conflict("wiki sync conflict: " + base.External.Path)
		}
		if !known && local != nil {
			return api.Conflict("wiki sync conflict: " + local.Path)
		}
		if localChanged {
			if !live {
				return api.Conflict("wiki sync conflict: deleted page")
			}
			if local == nil {
				if err = s.DeleteWikiPageAtRevision(ctx, actor, owner, repo, page.Slug, page.Revision); err != nil {
					return err
				}
				delete(state.Baselines, id)
				continue
			}
			updated, e := s.importSyncDocument(ctx, actor, owner, repo, adapter, *local, &page)
			if e != nil {
				return e
			}
			state.Baselines[id] = wikiSyncBaseline{Wiki: updated, External: *local}
		} else {
			var expected *SyncDocument
			if known {
				copy := base.External
				expected = &copy
			}
			event := page
			if !live {
				row, e := q.GetWikiLatestRevision(ctx, db.GetWikiLatestRevisionParams{RepositoryID: repository.ID, Visibility: visibility, PageID: id})
				if e != nil {
					return e
				}
				event = wikiEvent(row)
			}
			if err = s.deliverWikiDocument(ctx, q, actor, owner, repo, scope, adapter, documentSyncIntent{Expected: expected, Desired: remote, Page: event}); err != nil {
				if errors.Is(err, errWikiSyncSkipped) {
					continue
				}
				return err
			}
			if live {
				// Obtain the provider identity/version after its receipt, never guess it.
				docs, e := adapter.Scan(ctx)
				if e != nil {
					return e
				}
				found := false
				for _, d := range docs {
					if sameSyncContent(&d, remote) {
						state.Baselines[id] = wikiSyncBaseline{Wiki: page, External: d}
						found = true
						break
					}
				}
				if !found {
					return api.Conflict("provider receipt content changed")
				}
			} else {
				delete(state.Baselines, id)
			}
		}
	}
	// Remaining provider documents are new. The stable slug makes an interrupted
	// create discoverable on replay; a divergent existing page is a conflict.
	paths := make([]string, 0, len(byPath))
	for p := range byPath {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		d := byPath[p]
		page, e := s.importSyncDocument(ctx, actor, owner, repo, adapter, d, nil)
		if e != nil {
			return e
		}
		state.Baselines[page.PageID] = wikiSyncBaseline{Wiki: page, External: d}
	}
	// Catch up our own writes before committing the baseline and cursor together.
	for {
		events, e := s.ListWikiEvents(ctx, actor, owner, repo, state.Projection.Sequence)
		if e != nil {
			return e
		}
		state.Projection, e = FoldWikiEvents(state.Projection, events)
		if e != nil {
			return e
		}
		if len(events) < 100 {
			break
		}
	}
	if err = s.wikiWriteStillAuthorized(ctx, actor, owner, repo, repository.ID); err != nil {
		return err
	}
	raw, err = json.Marshal(state)
	if err != nil {
		return err
	}
	_, err = lock.Exec(ctx, `UPDATE issue_sync_channels SET document_state=$7 WHERE owner_id=$1 AND repository_id=$2 AND provider=$3 AND connection_id=$4 AND scope_id=$5 AND conversation_id=$6 AND thread_id=''`, actor.ID, repository.ID, adapter.Provider(), connection, visibility, adapter.Scope(), raw)
	if err != nil {
		return err
	}
	return lock.Commit(ctx)
}
func sameSyncContent(a, b *SyncDocument) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Path == b.Path && a.Digest == b.Digest
}
func (s *WikiService) importSyncDocument(ctx context.Context, actor *db.User, owner, repo string, adapter WikiSyncAdapter, d SyncDocument, previous *WikiEvent) (WikiEvent, error) {
	data, err := adapter.Read(ctx, d)
	if err != nil {
		return WikiEvent{}, err
	}
	if wikiDigest(data) != d.Digest {
		return WikiEvent{}, api.Conflict("provider content changed")
	}
	slug := "sync-" + wikiDigest([]byte(adapter.Provider() + ":" + adapter.Scope() + ":" + d.ID))[:32]
	revision := int64(0)
	if previous != nil {
		slug = previous.Slug
		revision = previous.Revision
	}
	var page WikiPageResponse
	if strings.HasSuffix(d.Path, ".md") {
		if previous == nil {
			page, err = s.CreateWikiPage(ctx, actor, owner, repo, CreateWikiPageInput{Slug: slug, Title: path.Base(d.Path), Path: d.Path, Body: string(data)})
		} else {
			body := string(data)
			page, err = s.UpdateWikiPage(ctx, actor, owner, repo, slug, UpdateWikiPageInput{Path: &d.Path, Body: &body, ExpectedRevision: &revision})
		}
	} else {
		page, err = s.PutWikiAttachment(ctx, actor, owner, repo, slug, PutWikiAttachmentInput{Path: d.Path, MediaType: d.MediaType, ExpectedRevision: revision, Data: data})
	}
	if err != nil {
		return WikiEvent{}, err
	}
	return WikiEvent{Version: 1, PageID: page.ID, Revision: page.Revision, Visibility: page.Visibility, Slug: page.Slug, Path: page.Path, Title: page.Title, ContentDigest: page.ContentDigest, Attachment: page.Attachment}, nil
}
func (s *WikiService) deliverWikiDocument(ctx context.Context, q *db.Queries, actor *db.User, owner, repo, scope string, adapter WikiSyncAdapter, intent documentSyncIntent) error {
	raw, err := json.Marshal(intent)
	if err != nil {
		return err
	}
	key := "document:" + wikiDigest(append([]byte(scope), raw...))
	tx, err := q.BeginTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO issue_sync_deliveries(document_scope,document_payload,reconcile_key,document_owner_id,document_repository_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(reconcile_key) DO NOTHING`, scope, raw, key, actor.ID, repository.ID)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if err = s.replayWikiDeliveries(ctx, q, actor, owner, repo, scope, adapter); err != nil {
		return err
	}
	read, err := q.BeginTx(ctx)
	if err != nil {
		return err
	}
	defer read.Rollback(ctx)
	var state string
	if err = read.QueryRow(ctx, "SELECT state FROM issue_sync_deliveries WHERE reconcile_key=$1", key).Scan(&state); err != nil {
		return err
	}
	if state == "unsupported" {
		return errWikiSyncSkipped
	}
	return nil
}
func (s *WikiService) replayWikiDeliveries(ctx context.Context, q *db.Queries, actor *db.User, owner, repo, scope string, adapter WikiSyncAdapter) error {
	for {
		tx, err := q.BeginTx(ctx)
		if err != nil {
			return err
		}
		var id int64
		var raw []byte
		var state, token, key string
		err = tx.QueryRow(ctx, `SELECT id,document_payload,state,claim_token,reconcile_key FROM issue_sync_deliveries WHERE document_scope=$1 AND state NOT IN ('sent','unsupported') ORDER BY id LIMIT 1 FOR UPDATE`, scope).Scan(&id, &raw, &state, &token, &key)
		if errors.Is(err, pgx.ErrNoRows) {
			tx.Rollback(ctx)
			return nil
		}
		if err != nil {
			tx.Rollback(ctx)
			return err
		}
		if state == "dispatching" && adapter.Provider() == "notion" {
			_, err = q.WithTx(tx).SettleSyncDelivery(ctx, id, token, "outcome_unknown", "", "Interrupted Notion write requires owner resolution")
			if err != nil {
				tx.Rollback(ctx)
				return err
			}
			if err = tx.Commit(ctx); err != nil {
				return err
			}
			return ErrSyncOutcomeUnknown
		}
		if state == "pending" {
			token = uuid.NewString()
			_, err = q.WithTx(tx).ClaimSyncDelivery(ctx, id, token)
		}
		if state == "outcome_unknown" || state == "failed" {
			tx.Rollback(ctx)
			return api.Conflict("document delivery requires resolution")
		}
		if err != nil {
			tx.Rollback(ctx)
			return err
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		var intent documentSyncIntent
		if err = json.Unmarshal(raw, &intent); err != nil {
			return err
		}
		var data []byte
		if intent.Desired != nil {
			content, e := s.GetWikiRevisionContent(ctx, actor, owner, repo, intent.Page.PageID, intent.Page.Revision)
			if e != nil {
				return e
			}
			data = content.Data
		}
		// Wiki authorization is rechecked even for deletions and replayed claims.
		repository, e := s.resolveRepoByOwnerAndName(ctx, owner, repo)
		if e != nil {
			return e
		}
		if e = s.requireWriteAccess(ctx, repository, actor); e != nil {
			return e
		}
		result, e := adapter.Apply(ctx, key, intent.Expected, intent.Desired, data)
		receiptState, message, failure := "sent", "deleted", ""
		if result != nil {
			message = result.ID
		}
		if e != nil {
			// Local compare failures are safe to retry after explicit conflict repair;
			// remote ambiguous writes must not be repeated without evidence.
			if errors.Is(e, ErrSyncOutcomeUnknown) {
				receiptState = "outcome_unknown"
				failure = "Provider write outcome unknown"
			} else {
				return e
			}
		}
		settled, settleErr := q.SettleSyncDelivery(ctx, id, token, receiptState, message, failure)
		if settleErr != nil {
			return settleErr
		}
		if !settled {
			return api.Conflict("delivery claim changed")
		}
		if e != nil {
			return e
		}
	}
}

var ErrSyncOutcomeUnknown = errors.New("provider write outcome unknown")
var errWikiSyncSkipped = errors.New("owner skipped document delivery")

// ResolveWikiSyncDelivery is the owner resolution port for the same durable
// receipt states as chat. Evidence and the previous receipt stay on the row.
// A retry explicitly accepts duplicate risk and obtains a fresh claim identity.
func (s *WikiService) ResolveWikiSyncDelivery(ctx context.Context, actor *db.User, owner, repo string, id int64, in IssueSyncReceipt) error {
	if actor == nil {
		return api.Unauthorized("authentication required")
	}
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err = s.requireWriteAccess(ctx, repository, actor); err != nil {
		return err
	}
	expected := map[string]string{"sent": "sent", "skip": "unsupported", "retry": "pending"}[in.Resolution]
	if expected == "" || in.State != expected || in.ExpectedToken == "" || strings.TrimSpace(in.Error) == "" || len(in.Error) > 4096 || in.Token != "" {
		return api.BadRequest("resolution requires an action, expected token and evidence")
	}
	if in.State == "sent" && (in.MessageID == "" || len(in.MessageID) > 4096) {
		return api.BadRequest("provider identity required")
	}
	q, ok := s.queries.(*db.Queries)
	if !ok {
		return wikiUnavailable("sync storage unavailable")
	}
	tx, err := q.BeginTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE issue_sync_deliveries d SET state=$5,claim_token='',message_id=$6,error=$7,updated_at=now(),
 document_payload=document_payload||jsonb_build_object('resolutions',COALESCE(document_payload->'resolutions','[]'::jsonb)||jsonb_build_array(jsonb_build_object('actor_id',$2::bigint,'action',$8::text,'evidence',$7::text,'at',now(),'previous',to_jsonb(d)-'claim_token'-'document_payload')))
 WHERE id=$1 AND document_owner_id=$2 AND document_repository_id=$3 AND claim_token=$4 AND state='outcome_unknown' AND document_payload->'page'->>'visibility'=$9`, id, actor.ID, repository.ID, in.ExpectedToken, in.State, in.MessageID, in.Error, in.Resolution, wikiVisibility(ctx))
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return api.Conflict("delivery is no longer unknown")
	}
	return tx.Commit(ctx)
}

// WikiSyncDeliveries exposes blocked receipts to the trusted host without
// revealing another owner's routing, payloads or resolution tokens.
func (s *WikiService) WikiSyncDeliveries(ctx context.Context, actor *db.User, owner, repo string) ([]db.IssueSyncDelivery, error) {
	if actor == nil {
		return nil, api.Unauthorized("authentication required")
	}
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, err
	}
	if err = s.requireWriteAccess(ctx, repository, actor); err != nil {
		return nil, err
	}
	q, ok := s.queries.(*db.Queries)
	if !ok {
		return nil, wikiUnavailable("sync storage unavailable")
	}
	tx, err := q.BeginTx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT id,state,claim_token,document_payload,message_id FROM issue_sync_deliveries WHERE document_owner_id=$1 AND document_repository_id=$2 AND document_payload->'page'->>'visibility'=$3 AND state='outcome_unknown' ORDER BY id`, actor.ID, repository.ID, wikiVisibility(ctx))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []db.IssueSyncDelivery{}
	for rows.Next() {
		var d db.IssueSyncDelivery
		if err = rows.Scan(&d.ID, &d.State, &d.ClaimToken, &d.Payload, &d.MessageID); err != nil {
			return nil, err
		}
		d.Event = "document.changed"
		result = append(result, d)
	}
	return result, rows.Err()
}
