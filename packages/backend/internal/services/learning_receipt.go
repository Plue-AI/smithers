package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const learningBindingKind = "learning"

type LearningLesson struct {
	Title string `json:"title"`
	Ref   string `json:"ref"`
}
type LearningReceipt struct {
	Todo    int64            `json:"todo"`
	Run     string           `json:"run"`
	Lessons []LearningLesson `json:"lessons"`
}

// LearningRuntime consumes only the dispatcher's persisted, pinned machine
// completion. It is not a run-credential write API.
type LearningRuntime struct {
	service *MythicalService
	wiki    *WikiService
}

func NewLearningRuntime(service *MythicalService, wiki *WikiService) *LearningRuntime {
	return &LearningRuntime{service: service, wiki: wiki}
}
func (r *LearningRuntime) ProjectFlowRuntime(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	cp := update.Checkpoint
	if cp.Target.BindingKind != learningBindingKind {
		return nil
	}
	if update.State != jobs.StateCompleted {
		return nil
	}
	if r == nil || r.service == nil || r.wiki == nil || cp.FlowID != "learning" || cp.Run == nil || cp.Run.Status != "completed" || cp.Run.FinalOutput == nil || cp.RunID == "" || cp.Run.RunID != cp.RunID || cp.Run.FlowID != "learning" {
		return ErrLearningBinding
	}
	var output LearningOutput
	if err := json.Unmarshal([]byte(*cp.Run.FinalOutput), &output); err != nil {
		return err
	}
	store := &learningReceiptStore{runtime: r, update: update}
	// The repository name and number are resolved from the persisted item in
	// Receipt; the output's claimed identity cannot select any writable row.
	repository, ok := scopedFlowRuntimeID(cp.Target.TenantID, "repository:")
	if !ok {
		return ErrLearningBinding
	}
	item, err := r.service.queries().GetMythicalItemByNumber(ctx, repository, output.Todo)
	if err != nil || uuidString(item.ID) != cp.Target.BindingID {
		return ErrLearningBinding
	}
	repo, owner, err := r.service.repository(ctx, repository)
	if err != nil {
		return err
	}
	binding := LearningBinding{Repository: owner + "/" + repo.Name, Todo: item.Number.Int64, Run: cp.RunID, State: todoState(item)}
	return CommitLearning(ctx, store, binding, output, r.service.now())
}

type learningReceiptStore struct {
	runtime *LearningRuntime
	update  flowdispatch.ProjectionUpdate
}

func (s *learningReceiptStore) Transaction(ctx context.Context, f func(LearningTransaction) error) error {
	return pgx.BeginFunc(ctx, s.runtime.service.store, func(tx pgx.Tx) error {
		return f(&learningReceiptTx{store: s, tx: tx, receipt: LearningReceipt{Lessons: []LearningLesson{}}})
	})
}

type learningReceiptTx struct {
	store      *learningReceiptStore
	tx         pgx.Tx
	item       db.MythicalItem
	repository int64
	actor      int64
	receipt    LearningReceipt
}

func (t *learningReceiptTx) Receipt(ctx context.Context, b LearningBinding) (bool, error) {
	u := t.store.update
	// Lock the dispatch row as well as the item. A completion cannot borrow
	// another launch's target, run, principal, or immutable flow pin.
	var raw, checkpoint []byte
	err := t.tx.QueryRow(ctx, `SELECT r.payload,d.external_receipt FROM product_job_requests r JOIN product_job_dispatches d ON d.operation_id=r.id WHERE r.id=$1 AND r.operation='flow.runtime.launch' AND r.tenant_id=$2 AND r.principal_id=$3 FOR UPDATE OF r,d`, u.OperationID, u.Scope.TenantID, u.Scope.PrincipalID).Scan(&raw, &checkpoint)
	if err != nil {
		return false, ErrLearningBinding
	}
	var launch struct {
		Target  flowruntime.FlowRuntimeTarget `json:"target"`
		FlowID  string                        `json:"flowId"`
		Pin     *flowruntime.Pin              `json:"pin"`
		Payload struct {
			Todo int64 `json:"todo"`
		} `json:"payload"`
	}
	var saved flowdispatch.RuntimeCheckpoint
	if json.Unmarshal(raw, &launch) != nil || json.Unmarshal(checkpoint, &saved) != nil || launch.Target != u.Checkpoint.Target || launch.FlowID != "learning" || launch.Payload.Todo != b.Todo || launch.Pin == nil || !launch.Pin.Valid() || launch.Pin.Flow != "learning" || saved.RunID != b.Run || saved.Target != launch.Target || saved.FlowID != "learning" || saved.ExecutionDigest != launch.Pin.ExecutionDigest || saved.Identity.SourceRevision != launch.Pin.SourceCommit || saved.Run == nil || saved.Run.Status != "completed" || saved.Run.FinalOutput == nil || *saved.Run.FinalOutput != *u.Checkpoint.Run.FinalOutput {
		return false, ErrLearningBinding
	}
	t.repository, _ = scopedFlowRuntimeID(launch.Target.TenantID, "repository:")
	t.actor, _ = scopedFlowRuntimeID(launch.Target.PrincipalID, "user:")
	if t.repository <= 0 || t.actor <= 0 || launch.Target.TenantID != u.Scope.TenantID || launch.Target.PrincipalID != u.Scope.PrincipalID || launch.Target.WorkspaceID == "" {
		return false, ErrLearningBinding
	}
	var receipt []byte
	err = t.tx.QueryRow(ctx, `SELECT learning_receipt FROM mythical_items WHERE id=$1 AND repository_id=$2 AND number=$3 AND state='landed' AND pr_state='merged' FOR UPDATE`, launch.Target.BindingID, t.repository, b.Todo).Scan(&receipt)
	if err != nil {
		return false, ErrLearningBinding
	}
	if len(receipt) > 0 {
		var committed LearningReceipt
		if json.Unmarshal(receipt, &committed) != nil || committed.Run != b.Run || committed.Todo != b.Todo {
			return false, ErrLearningBinding
		}
		return true, nil
	}
	t.item, err = db.New(t.tx).GetMythicalItemByNumber(ctx, t.repository, b.Todo)
	if err != nil {
		return false, err
	}
	t.receipt.Todo, t.receipt.Run = b.Todo, b.Run
	return false, nil
}
func (t *learningReceiptTx) Page(ctx context.Context, b LearningBinding, p LearningPage) error {
	if t.item.PRURL == "" || t.item.PRMergeCommit == "" || !strings.Contains(p.Body, t.item.PRURL) || !strings.Contains(p.Body, t.item.PRMergeCommit) {
		return ErrLearningBinding
	}

	title, err := normalizeWikiTitle(p.Title)
	if err != nil {
		return err
	}
	if err = validWikiBody(p.Body); err != nil {
		return err
	}
	if _, err = t.store.runtime.wiki.putWikiContent(ctx, t.repository, []byte(p.Body)); err != nil {
		return err
	}
	author, _ := json.Marshal(map[string]string{"agent": "coding", "run": b.Run})
	if _, err = t.tx.Exec(ctx, `SELECT set_config('smithers.learning_author',$1,true)`, string(author)); err != nil {
		return err
	}
	// One page per typed page, deterministically named within this receipt.
	sum := sha256.Sum256([]byte(b.Run + "\x00" + strconv.Itoa(len(t.receipt.Lessons))))
	slug := "learning-t" + strconv.FormatInt(b.Todo, 10) + "-" + hex.EncodeToString(sum[:8])
	_, err = db.New(t.tx).CreateWikiPage(ctx, db.CreateWikiPageParams{RepositoryID: t.repository, AuthorID: t.actor, Slug: slug, Title: title, Body: p.Body, Visibility: "public", Path: slug + ".md", TitleSource: pgtype.Text{String: "explicit", Valid: true}})
	if err != nil {
		return err
	}
	t.receipt.Lessons = append(t.receipt.Lessons, LearningLesson{title, "wiki:" + slug})
	return nil
}
func (t *learningReceiptTx) Proposal(ctx context.Context, b LearningBinding, p LearningProposal, now time.Time) (bool, error) {
	namespace := learningNamespace(t.repository)
	// Repository-wide serialization also covers concurrent signatures on
	// different merged TODOs; the note's primary key is its stable signature.
	if _, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, namespace+":"+p.Signature); err != nil {
		return false, err
	}
	sum := sha256.Sum256([]byte(namespace + "\x00" + p.Signature))
	id := "learning-" + hex.EncodeToString(sum[:])
	var status string
	var at *int64
	err := t.tx.QueryRow(ctx, `SELECT id,status,status_at_ms FROM memory_notes WHERE namespace_kind='flow' AND namespace_id=$1 AND provenance_json::jsonb->>'signature'=$2 ORDER BY (status='pending') DESC,(status='rejected') DESC,status_at_ms DESC NULLS FIRST LIMIT 1 FOR UPDATE`, namespace, p.Signature).Scan(&id, &status, &at)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	if err == nil {
		var dismissed *time.Time
		if at != nil {
			v := time.UnixMilli(*at)
			dismissed = &v
		}
		if LearningSuppressed(status, dismissed, now) {
			return false, nil
		}
	}
	note, _ := json.Marshal(LearningProposalNote{LearningProposal: p, Repository: b.Repository, Run: b.Run})
	_, err = t.tx.Exec(ctx, `INSERT INTO memory_notes(id,namespace_kind,namespace_id,text,tags_json,provenance_json,status,created_at_ms) VALUES($1,'flow',$2,$3,'[]',$4,'pending',$5) ON CONFLICT(id) DO UPDATE SET text=EXCLUDED.text,provenance_json=EXCLUDED.provenance_json,status='pending',status_at_ms=NULL,accepted_todo=NULL,created_at_ms=EXCLUDED.created_at_ms`, id, namespace, p.Title, string(note), now.UnixMilli())
	if err != nil {
		return false, err
	}
	t.receipt.Lessons = append(t.receipt.Lessons, LearningLesson{p.Title, "proposal:" + id})
	return true, nil
}
func (t *learningReceiptTx) RecordReceipt(ctx context.Context, b LearningBinding, n int) error {
	receipt, _ := json.Marshal(t.receipt)
	_, err := t.tx.Exec(ctx, `UPDATE mythical_items SET lessons=$2,learning_receipt=$3 WHERE id=$1`, t.item.ID, n, receipt)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"kind": "learning", "itemId": uuidString(t.item.ID), "todo": b.Todo, "lessons": n, "topics": []string{fmt.Sprintf("todo:%d", b.Todo), "home", "proposals"}})
	if _, err = jobs.RecordFactInTx(ctx, t.tx, t.store.update.Scope, uuid.NewSHA1(uuid.NameSpaceOID, []byte("learning.receipt:"+uuidString(t.item.ID))).String(), "learning.receipt", "completed", payload); err != nil {
		return err
	}
	_, err = t.tx.Exec(ctx, `SELECT pg_notify($1,$2)`, "mythical_"+strconv.FormatInt(t.repository, 10), string(payload))
	return err
}

func (s *MythicalService) SetLearningWiki(wiki *WikiService) { s.learningWiki = wiki }
func (s *MythicalService) LearningRuntime() *LearningRuntime {
	return NewLearningRuntime(s, s.learningWiki)
}
