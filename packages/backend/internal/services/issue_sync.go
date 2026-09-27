package services

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

var slackID = regexp.MustCompile(`^[A-Z][A-Z0-9]{2,31}$`)
var slackTS = regexp.MustCompile(`^[0-9]{1,12}\.[0-9]{1,9}$`)

type IssueSyncInput struct {
	Provider       string `json:"provider"`
	ConnectionID   string `json:"connection_id"`
	ScopeID        string `json:"scope_id"`
	ConversationID string `json:"conversation_id"`
	ThreadID       string `json:"thread_id"`
	ExternalUserID string `json:"external_user_id"`
}

func (in IssueSyncInput) validate() error {
	if strings.TrimSpace(in.ConnectionID) == "" || len(in.ConnectionID) > 128 {
		return api.BadRequest("invalid connection")
	}
	switch in.Provider {
	case "slack":
		if !slackID.MatchString(in.ScopeID) || !regexp.MustCompile(`^[CDG][A-Z0-9]{2,31}$`).MatchString(in.ConversationID) || (in.ThreadID != "" && !slackTS.MatchString(in.ThreadID)) || (in.ExternalUserID != "" && !slackID.MatchString(in.ExternalUserID)) {
			return api.BadRequest("invalid Slack mapping")
		}
	case "telegram":
		if !providerInteger.MatchString(in.ScopeID) || !providerChat.MatchString(in.ConversationID) || (in.ThreadID != "" && !providerInteger.MatchString(in.ThreadID)) || (in.ExternalUserID != "" && !providerInteger.MatchString(in.ExternalUserID)) {
			return api.BadRequest("invalid Telegram mapping")
		}
	default:
		return api.BadRequest("unsupported sync provider")
	}
	return nil
}

var providerInteger = regexp.MustCompile(`^[1-9][0-9]{0,15}$`)
var providerChat = regexp.MustCompile(`^-?[1-9][0-9]{0,15}$`)

func (in IssueSyncInput) validEventIdentity(id, version, user string) bool {
	if in.Provider == "slack" {
		return slackTS.MatchString(id) && slackTS.MatchString(version) && slackID.MatchString(user)
	}
	return providerInteger.MatchString(id) && regexp.MustCompile(`^[0-9]{1,16}(\.[0-9]{1,10})?$`).MatchString(version) && providerInteger.MatchString(user)
}
func (in IssueSyncInput) root(messageID, user string) string {
	if in.Provider == "telegram" {
		if in.ThreadID == "" {
			return "chat"
		}
		return in.ThreadID
	}
	if strings.HasPrefix(in.ConversationID, "D") {
		return "dm:" + user
	}
	if in.ThreadID == "" {
		return messageID
	}
	return in.ThreadID
}
func (s *IssueService) syncQueries() (*db.Queries, error) {
	q, ok := s.queries.(*db.Queries)
	if !ok {
		return nil, api.Internal("issue sync storage unavailable")
	}
	return q, nil
}
func (s *IssueService) GetIssueSync(ctx context.Context, actor *db.User, owner, repo string, number int64) (db.IssueSyncMapping, error) {
	_, i, err := s.resolveReadableIssue(ctx, actor, owner, repo, number)
	if err != nil {
		return db.IssueSyncMapping{}, err
	}
	if actor == nil || i.AuthorID != actor.ID {
		return db.IssueSyncMapping{}, api.NotFound("issue not found")
	}
	q, err := s.syncQueries()
	if err != nil {
		return db.IssueSyncMapping{}, err
	}
	m, err := q.GetIssueSyncMapping(ctx, i.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return m, api.NotFound("Sync mapping not found")
	}
	return m, err
}
func (s *IssueService) PutIssueSync(ctx context.Context, actor *db.User, owner, repo string, number int64, in IssueSyncInput) (db.IssueSyncMapping, error) {
	if err := in.validate(); err != nil {
		return db.IssueSyncMapping{}, err
	}
	_, i, err := s.resolveWritableIssue(ctx, actor, owner, repo, number)
	if err != nil {
		return db.IssueSyncMapping{}, err
	}
	if i.Kind != "chat" || actor == nil || i.AuthorID != actor.ID {
		return db.IssueSyncMapping{}, api.NotFound("chat issue not found")
	}
	q, err := s.syncQueries()
	if err != nil {
		return db.IssueSyncMapping{}, err
	}
	if in.Provider == "slack" && strings.HasPrefix(in.ConversationID, "D") {
		if in.ExternalUserID == "" {
			return db.IssueSyncMapping{}, api.BadRequest("direct messages require external_user_id")
		}
		in.ThreadID = "dm:" + in.ExternalUserID
	}
	if in.Provider == "telegram" {
		in.ThreadID = in.root("", "")
	}
	m := db.IssueSyncMapping{Provider: in.Provider, IssueID: i.ID, OwnerID: actor.ID, ConnectionID: in.ConnectionID, ScopeID: in.ScopeID, ConversationID: in.ConversationID, ThreadID: in.ThreadID}
	if err = q.PutIssueSyncMapping(ctx, m); err != nil {
		return m, api.Conflict("external thread already mapped")
	}
	current, err := q.GetIssueSyncMapping(ctx, i.ID)
	if err != nil {
		return current, err
	}
	if current.Provider != m.Provider || current.IssueID != m.IssueID || current.OwnerID != m.OwnerID || current.ConnectionID != m.ConnectionID || current.ScopeID != m.ScopeID || current.ConversationID != m.ConversationID || current.ThreadID != m.ThreadID {
		return current, api.Conflict("issue already mapped to a different external thread")
	}
	return current, nil
}
func (s *IssueService) ConfigureIssueSyncChannel(ctx context.Context, actor *db.User, owner, repo string, in IssueSyncInput) error {
	if actor == nil {
		return api.Unauthorized("authentication required")
	}
	check := in
	if in.Provider == "slack" && in.ConversationID == "direct" && in.ExternalUserID != "" {
		check.ConversationID = "D000"
	}
	if err := check.validate(); err != nil {
		return err
	}
	r, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err = s.requireWriteAccess(ctx, r, actor); err != nil {
		return err
	}
	q, err := s.syncQueries()
	if err != nil {
		return err
	}
	tx, err := q.BeginTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	admissionThread := ""
	if in.Provider == "telegram" {
		admissionThread = in.ThreadID
	}
	tag, err := tx.Exec(ctx, `INSERT INTO issue_sync_channels(owner_id,repository_id,connection_id,scope_id,conversation_id,external_user_id,provider,thread_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner_id,provider,connection_id,scope_id,conversation_id,thread_id) DO UPDATE SET external_user_id=EXCLUDED.external_user_id WHERE issue_sync_channels.repository_id=EXCLUDED.repository_id`, actor.ID, r.ID, in.ConnectionID, in.ScopeID, in.ConversationID, in.ExternalUserID, in.Provider, admissionThread)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return api.Conflict("sync conversation already configured for another repository")
	}
	return tx.Commit(ctx)
}

// IssueSyncIgnored is a routine refusal of one provider event (unmapped
// conversation or message, disallowed user, unknown reaction name). The event
// can never apply, so the connection acknowledges it instead of redelivering it.
type IssueSyncIgnored struct{ Reason string }

func (e IssueSyncIgnored) Error() string { return e.Reason }

type IssueSyncEvent struct {
	Reaction string `json:"reaction"`
	IssueSyncInput
	DeliveryKey string `json:"delivery_key"`
	MessageID   string `json:"message_id"`
	Version     string `json:"version"`
	UserID      string `json:"user_id"`
	Body        string `json:"body"`
	Kind        string `json:"kind"` // message, edit, delete
}

// IngestIssueSync commits the provider identity, issue/comment and external link together.
// Only an authenticated connection host may call this owner-scoped route.
func (s *IssueService) IngestIssueSync(ctx context.Context, actor *db.User, owner, repo string, in IssueSyncEvent) (int64, error) {
	if actor == nil {
		return 0, api.Unauthorized("authentication required")
	}
	if err := in.IssueSyncInput.validate(); err != nil {
		return 0, err
	}
	if in.DeliveryKey == "" || len(in.DeliveryKey) > 256 || !in.IssueSyncInput.validEventIdentity(in.MessageID, in.Version, in.UserID) || (in.Kind != "message" && in.Kind != "edit" && in.Kind != "delete" && in.Kind != "reaction_add" && in.Kind != "reaction_remove") {
		return 0, api.BadRequest("invalid sync event")
	}
	r, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return 0, err
	}
	if err = s.requireWriteAccess(ctx, r, actor); err != nil {
		return 0, err
	}
	q, err := s.syncQueries()
	if err != nil {
		return 0, err
	}
	tx, err := q.BeginTx(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	// Serializes one owner's mapping and identities, including simultaneous thread roots/replies.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, actor.ID); err != nil {
		return 0, err
	}
	var prior pgtype.Int8
	err = tx.QueryRow(ctx, `SELECT r.issue_id FROM issue_sync_receipts r JOIN issues i ON i.id=r.issue_id WHERE r.owner_id=$1 AND r.delivery_key=$2 AND i.repository_id=$3`, actor.ID, syncReceiptKey(in, r.ID), r.ID).Scan(&prior)
	if err == nil {
		return prior.Int64, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `SELECT set_config('smithers.issue_origin',$1,true)`, in.Provider); err != nil {
		return 0, err
	}
	root := in.root(in.MessageID, in.UserID)
	var issueID int64
	err = tx.QueryRow(ctx, `SELECT t.issue_id FROM issue_sync_threads t JOIN issues i ON i.id=t.issue_id WHERE t.owner_id=$1 AND t.connection_id=$2 AND t.scope_id=$3 AND t.conversation_id=$4 AND t.thread_id=$5 AND i.repository_id=$6 AND t.provider=$7 FOR UPDATE`, actor.ID, in.ConnectionID, in.ScopeID, in.ConversationID, root, r.ID, in.Provider).Scan(&issueID)
	if errors.Is(err, pgx.ErrNoRows) && in.Kind != "message" {
		err = tx.QueryRow(ctx, `SELECT t.issue_id FROM issue_sync_threads t JOIN issues i ON i.id=t.issue_id JOIN issue_external_messages m ON m.issue_id=t.issue_id WHERE t.owner_id=$1 AND t.connection_id=$2 AND t.scope_id=$3 AND t.conversation_id=$4 AND m.message_id=$5 AND i.repository_id=$6 AND t.provider=$7`, actor.ID, in.ConnectionID, in.ScopeID, in.ConversationID, in.MessageID, r.ID, in.Provider).Scan(&issueID)
	}
	tq := q.WithTx(tx)
	inner := NewIssueService(tq)
	if errors.Is(err, pgx.ErrNoRows) {
		var allowed string
		err = tx.QueryRow(ctx, `SELECT external_user_id FROM issue_sync_channels WHERE owner_id=$1 AND repository_id=$2 AND connection_id=$3 AND scope_id=$4 AND (conversation_id=$5 OR (conversation_id='direct' AND left($5,1)='D' AND external_user_id=$6)) AND provider=$7 AND (thread_id='' OR thread_id=$8) ORDER BY (thread_id=$8) DESC,(conversation_id=$5) DESC LIMIT 1`, actor.ID, r.ID, in.ConnectionID, in.ScopeID, in.ConversationID, in.UserID, in.Provider, root).Scan(&allowed)
		if err != nil {
			return 0, IssueSyncIgnored{"sync conversation not mapped"}
		}
		if allowed != "" && allowed != in.UserID {
			return 0, IssueSyncIgnored{"user not allowed"}
		}
		if in.Kind == "reaction_add" || in.Kind == "reaction_remove" {
			return 0, IssueSyncIgnored{"external message not mapped"}
		}
		title := []rune(strings.TrimSpace(in.Body))
		if len(title) > 80 {
			title = title[:80]
		}
		if len(title) == 0 {
			title = []rune(in.Provider)
		}
		created, e := inner.CreateIssue(ctx, actor, owner, repo, CreateIssueInput{Title: string(title), Kind: "chat"})
		if e != nil {
			return 0, e
		}
		issueID = created.ID
		err = tq.PutIssueSyncMapping(ctx, db.IssueSyncMapping{Provider: in.Provider, IssueID: issueID, OwnerID: actor.ID, ConnectionID: in.ConnectionID, ScopeID: in.ScopeID, ConversationID: in.ConversationID, ThreadID: root})
		if err != nil {
			return 0, err
		}
	} else if err != nil {
		return 0, err
	}
	// Channel admission remains enforced on every event, not only thread creation.
	var allowed string
	err = tx.QueryRow(ctx, `SELECT external_user_id FROM issue_sync_channels WHERE owner_id=$1 AND repository_id=$2 AND connection_id=$3 AND scope_id=$4 AND (conversation_id=$5 OR (conversation_id='direct' AND left($5,1)='D' AND external_user_id=$6)) AND provider=$7 AND (thread_id='' OR thread_id=$8) ORDER BY (thread_id=$8) DESC,(conversation_id=$5) DESC LIMIT 1`, actor.ID, r.ID, in.ConnectionID, in.ScopeID, in.ConversationID, in.UserID, in.Provider, root).Scan(&allowed)
	if err == nil && allowed != "" && allowed != in.UserID {
		return 0, IssueSyncIgnored{"user not allowed"}
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	if in.Kind == "reaction_add" || in.Kind == "reaction_remove" {
		if !reactionName.MatchString(in.Reaction) {
			return 0, IssueSyncIgnored{"invalid reaction"}
		}
		var cid int64
		if err = tx.QueryRow(ctx, `SELECT comment_id FROM issue_external_messages WHERE issue_id=$1 AND message_id=$2 AND NOT deleted`, issueID, in.MessageID).Scan(&cid); err != nil {
			return 0, IssueSyncIgnored{"external message not mapped"}
		}
		who := in.Provider + ":" + in.ScopeID + ":" + in.UserID
		active := in.Kind == "reaction_add"

		var reactionID pgtype.Int8
		var newer bool
		err = tx.QueryRow(ctx, `INSERT INTO issue_external_reactions(issue_id,comment_id,actor,name,version) VALUES($1,$2,$3,$4,$5::numeric) ON CONFLICT(issue_id,comment_id,actor,name) DO UPDATE SET version=EXCLUDED.version WHERE issue_external_reactions.version<EXCLUDED.version RETURNING reaction_id,true`, issueID, cid, who, in.Reaction, in.Version).Scan(&reactionID, &newer)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return 0, err
		}
		if newer {
			if active && !reactionID.Valid {
				var rid int64
				err = tx.QueryRow(ctx, `INSERT INTO reactions(target_type,target_id,emoji) VALUES('issue_comment',$1,$2) RETURNING id`, cid, in.Reaction).Scan(&rid)
				if err == nil {
					_, err = tx.Exec(ctx, `UPDATE issue_external_reactions SET reaction_id=$5 WHERE issue_id=$1 AND comment_id=$2 AND actor=$3 AND name=$4`, issueID, cid, who, in.Reaction, rid)
				}
			} else if !active && reactionID.Valid {
				_, err = tx.Exec(ctx, `DELETE FROM reactions WHERE id=$1`, reactionID.Int64)
			} else {
				err = nil
			}
			if err != nil {
				return 0, err
			}
			if err = recordReaction(ctx, tx, issueID, cid, actor.ID, in.Reaction, who, active, false); err != nil {
				return 0, err
			}
		}
		_, err = tx.Exec(ctx, `INSERT INTO issue_sync_receipts(owner_id,delivery_key,issue_id) VALUES($1,$2,$3)`, actor.ID, syncReceiptKey(in, r.ID), issueID)
		if err != nil {
			return 0, err
		}
		return issueID, tx.Commit(ctx)
	}
	var commentRef pgtype.Int8
	var stale bool
	err = tx.QueryRow(ctx, `SELECT comment_id,deleted OR provider_version >= $3::numeric FROM issue_external_messages WHERE issue_id=$1 AND message_id=$2 FOR UPDATE`, issueID, in.MessageID, in.Version).Scan(&commentRef, &stale)
	if errors.Is(err, pgx.ErrNoRows) {
		if in.Kind == "delete" {
			_, err = tx.Exec(ctx, `INSERT INTO issue_external_messages(issue_id,message_id,provider_version,deleted) VALUES($1,$2,$3::numeric,true)`, issueID, in.MessageID, in.Version)
		} else {
			issue, e := tq.GetIssueByID(ctx, issueID)
			if e != nil {
				return 0, e
			}
			c, e := inner.CreateIssueComment(ctx, actor, owner, repo, issue.Number, CreateIssueCommentInput{externalCommenter: in.UserID, Body: in.Body, IdempotencyKey: in.Provider + ":" + in.MessageID})
			if e != nil {
				return 0, e
			}
			commentID := c.ID
			_, err = tx.Exec(ctx, `INSERT INTO issue_external_messages(issue_id,comment_id,message_id,provider_version) VALUES($1,$2,$3,$4::numeric)`, issueID, commentID, in.MessageID, in.Version)
		}
	} else if err == nil && !stale {
		commentID := commentRef.Int64
		if in.Kind == "delete" {
			err = inner.DeleteIssueComment(ctx, actor, owner, repo, commentID)
		} else {
			_, err = inner.UpdateIssueComment(ctx, actor, owner, repo, commentID, UpdateIssueCommentInput{Body: in.Body})
		}
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE issue_external_messages SET provider_version=$3::numeric,deleted=$4 WHERE issue_id=$1 AND message_id=$2`, issueID, in.MessageID, in.Version, in.Kind == "delete")
		}
	}
	if err != nil {
		return 0, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO issue_sync_receipts(owner_id,delivery_key,issue_id) VALUES($1,$2,$3)`, actor.ID, syncReceiptKey(in, r.ID), issueID)
	if err != nil {
		return 0, err
	}
	return issueID, tx.Commit(ctx)
}
func (s *IssueService) IssueSyncDeliveries(ctx context.Context, actor *db.User, owner, repo string, afterID ...int64) ([]db.IssueSyncDelivery, error) {
	if actor == nil {
		return nil, api.Unauthorized("authentication required")
	}
	r, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, err
	}
	if err = s.requireWriteAccess(ctx, r, actor); err != nil {
		return nil, err
	}
	q, err := s.syncQueries()
	if err != nil {
		return nil, err
	}
	after := int64(0)
	if len(afterID) > 0 {
		after = afterID[0]
	}
	return q.ListIssueSyncDeliveries(ctx, actor.ID, r.ID, after)
}

type IssueSyncReceipt struct {
	Provider  string `json:"provider,omitempty"`
	State     string `json:"state"`
	Token     string `json:"token"`
	MessageID string `json:"message_id"`
	Error     string `json:"error"`
}

func (s *IssueService) ClaimIssueSync(ctx context.Context, actor *db.User, owner, repo string, id int64) (IssueSyncReceipt, error) {
	rows, err := s.IssueSyncDeliveries(ctx, actor, owner, repo, id-1)
	if err != nil {
		return IssueSyncReceipt{}, err
	}
	found := false
	for _, d := range rows {
		if d.ID == id {
			found = true
			break
		}
	}
	if !found {
		return IssueSyncReceipt{}, api.NotFound("delivery not found")
	}
	q, _ := s.syncQueries()
	tx, err := q.BeginTx(ctx)
	if err != nil {
		return IssueSyncReceipt{}, err
	}
	defer tx.Rollback(ctx)
	token := uuid.NewString()
	var state string
	err = tx.QueryRow(ctx, `UPDATE issue_sync_deliveries SET state='dispatching',claim_token=$2,updated_at=now() WHERE id=$1 AND state='pending' AND NOT EXISTS(SELECT 1 FROM issue_sync_deliveries earlier WHERE earlier.issue_id=issue_sync_deliveries.issue_id AND earlier.id<$1 AND earlier.state NOT IN ('sent','unsupported')) RETURNING state`, id, token).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return IssueSyncReceipt{State: "outcome_unknown"}, nil
	}
	if err != nil {
		return IssueSyncReceipt{}, err
	}
	return IssueSyncReceipt{State: state, Token: token}, tx.Commit(ctx)
}
func (s *IssueService) CompleteIssueSync(ctx context.Context, actor *db.User, owner, repo string, id int64, in IssueSyncReceipt) error {
	if actor == nil {
		return api.Unauthorized("authentication required")
	}
	if in.State != "sent" && in.State != "outcome_unknown" && in.State != "failed" && in.State != "unsupported" && in.State != "pending" {
		return api.BadRequest("invalid delivery state")
	}
	if in.State == "sent" && (in.MessageID == "" || len(in.MessageID) > 4096) {
		return api.BadRequest("invalid external message identity")
	}
	r, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err = s.requireWriteAccess(ctx, r, actor); err != nil {
		return err
	}
	q, err := s.syncQueries()
	if err != nil {
		return err
	}
	tx, err := q.BeginTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if in.State == "pending" {
		tag, e := tx.Exec(ctx, `UPDATE issue_sync_deliveries d SET state='pending',claim_token='',error='',updated_at=now() FROM issues i,issue_sync_threads t WHERE d.id=$1 AND d.issue_id=i.id AND t.issue_id=i.id AND t.owner_id=$2 AND i.repository_id=$3 AND d.state='failed' AND ($4='' OR t.provider=$4)`, id, actor.ID, r.ID, in.Provider)
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 {
			return api.Conflict("only a known refused delivery can retry")
		}
		return tx.Commit(ctx)
	}
	var issueID, commentID int64
	var event, root, provider string
	err = tx.QueryRow(ctx, `SELECT d.issue_id,(e.payload->'comment'->>'id')::bigint,e.event_type,t.thread_id,t.provider FROM issue_sync_deliveries d JOIN issue_events e ON e.id=d.event_id JOIN issue_sync_threads t ON t.issue_id=d.issue_id JOIN issues i ON i.id=d.issue_id WHERE d.id=$1 AND t.owner_id=$2 AND i.repository_id=$3 AND d.state IN ('dispatching','outcome_unknown') AND (d.claim_token=$4 OR ($4='' AND $5='sent')) FOR UPDATE OF d,t`, id, actor.ID, r.ID, in.Token, in.State).Scan(&issueID, &commentID, &event, &root, &provider)
	if err != nil {
		return api.Conflict("delivery claim changed")
	}
	if in.Provider != "" && in.Provider != provider {
		return api.NotFound("delivery not found")
	}
	if in.State == "sent" {
		if provider == "slack" && !slackTS.MatchString(in.MessageID) {
			return api.BadRequest("invalid Slack timestamp")
		}
		if provider == "telegram" && !regexp.MustCompile(`^[1-9][0-9]*(,[1-9][0-9]*)*$`).MatchString(in.MessageID) {
			return api.BadRequest("invalid Telegram message ids")
		}
		if event == "comment.edited" {
			_, err = tx.Exec(ctx, `UPDATE issue_external_messages SET message_id=$3 WHERE issue_id=$1 AND comment_id=$2`, issueID, commentID, in.MessageID)
			if err != nil {
				return err
			}
		}
		if event == "comment.created" {
			_, err = tx.Exec(ctx, `INSERT INTO issue_external_messages(issue_id,comment_id,message_id) VALUES($1,$2,$3) ON CONFLICT(issue_id,comment_id) DO NOTHING`, issueID, commentID, in.MessageID)
			if err != nil {
				return err
			}
		}
		if root == "" && provider == "slack" {
			_, err = tx.Exec(ctx, `UPDATE issue_sync_threads SET thread_id=$2 WHERE issue_id=$1`, issueID, in.MessageID)
			if err != nil {
				return err
			}
		}
	}
	_, err = tx.Exec(ctx, `UPDATE issue_sync_deliveries SET state=$2,message_id=$3,error=$4,updated_at=now() WHERE id=$1`, id, in.State, in.MessageID, in.Error)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func syncReceiptKey(in IssueSyncEvent, repoID int64) string {
	if in.Provider == "slack" {
		return in.ConnectionID + ":" + in.ScopeID + ":" + in.DeliveryKey
	}
	b, _ := json.Marshal([]any{repoID, in.Provider, in.ConnectionID, in.ScopeID, in.DeliveryKey})
	return string(b)
}
