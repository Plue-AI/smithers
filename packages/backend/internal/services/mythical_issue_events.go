package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// The install's issue-events stream (T-GH-02, engineering spec §12.2): the
// repository's GitHub issue events, read past a durable event-id cursor, hand
// each person's `todo` label to the label door (ObserveIssue, T-STK-09) once,
// in event-id order. An install gets no webhooks (M-03), so this read is the
// door that makes "label the issue todo on GitHub" commit a TODO (J2 step 2).

const (
	// mythicalIssueEventsCursor prefixes a repository's cursor key in
	// install_settings (spec §12.2.1: the issue-events cursor is an
	// install_settings key).
	mythicalIssueEventsCursor = "github.issue_events.cursor:"
)

// mythicalIssueEvent is one event of a repository's issue-events list.
type mythicalIssueEvent struct {
	CreatedAt time.Time
	ID        int64
	Event     string
	Actor     gitHubActor
	ViaApp    bool
	Label     string
	Issue     int64
	// Pull marks an event on a pull request, which shares the list.
	Pull bool
}

// mythicalIssueEventsReader reads a repository's issue events;
// mythicalGitHubAPI implements it.
type mythicalIssueEventsReader interface {
	IssueEvents(ctx context.Context, gh mythicalGitHubRepo, after int64) ([]mythicalIssueEvent, int64, error)
}

// IssueEvents reads the repository's issue events newer than after, oldest
// first, and the newest event id it saw. GitHub lists them newest first, so
// the shared reader pages back until it reaches after. Cancellation refuses a
// partial interval; no fixed page limit can silently discard older events.
func (g *mythicalGitHubAPI) IssueEvents(ctx context.Context, gh mythicalGitHubRepo, after int64) ([]mythicalIssueEvent, int64, error) {
	objects, newest, err := readGitHubIssueEvents(ctx, after, g.api.issueEventPages(gh.Token, gh.Owner, gh.Name))
	if err != nil {
		return nil, 0, err
	}
	var out []mythicalIssueEvent
	for _, object := range objects {
		var event gitHubFetchedEvent
		if err := json.Unmarshal(object, &event); err != nil {
			return nil, 0, err
		}
		var issue gitHubIssueHeader
		if err := json.Unmarshal(event.Issue, &issue); err != nil || issue.Number <= 0 {
			return nil, 0, errors.New("invalid GitHub event issue")
		}
		newest = max(newest, event.ID)
		out = append(out, mythicalIssueEvent{CreatedAt: event.CreatedAt, ID: event.ID, Event: event.Event, Actor: event.Actor,
			ViaApp: event.ViaApp != nil && string(*event.ViaApp) != "null", Label: event.Label.Name, Issue: issue.Number, Pull: issue.PullRequest != nil})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, newest, nil
}

// ReadIssueEvents reads repositoryID's GitHub issue events past its cursor
// and hands each person's `todo` label to ObserveIssue, oldest first. The
// first read only sets the cursor at the newest event: a label applied
// before the install read GitHub is no request to it. The cursor moves past
// an event only after it was handed over, so a failed read retries that
// event and a handed one is never handed again. A repository without a
// stack reads nothing.
func (s *MythicalService) ReadIssueEvents(ctx context.Context, repositoryID int64) error {
	if s == nil || s.store == nil || s.github == nil {
		return issueTodoUnavailable()
	}
	reader, ok := s.github.(mythicalIssueEventsReader)
	if !ok {
		return issueTodoUnavailable()
	}
	if _, err := s.queries().GetMythicalStack(ctx, repositoryID); errors.Is(err, pgx.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	gh, err := s.stackGitHub(ctx, repositoryID)
	if err != nil {
		return err
	}
	key := mythicalIssueEventsCursor + strconv.FormatInt(repositoryID, 10)
	cursor, known, err := s.issueEventsCursor(ctx, key)
	if err != nil {
		return err
	}
	if !known {
		_, newest, err := reader.IssueEvents(ctx, gh, math.MaxInt64)
		if err != nil {
			return err
		}
		return s.saveIssueEventsCursor(ctx, key, newest)
	}
	events, _, err := reader.IssueEvents(ctx, gh, cursor)
	if err != nil {
		return err
	}
	for _, event := range events {
		if event.Event == "labeled" && strings.EqualFold(event.Label, todoLabel) && !event.Pull {
			if err := s.observeLabelEvent(ctx, repositoryID, gh, event); err != nil {
				return err
			}
		}
		if err := s.saveIssueEventsCursor(ctx, key, event.ID); err != nil {
			return err
		}
	}
	return nil
}

// observeLabelEvent hands one person's `todo` label to the label door with
// the issue as GitHub holds it now (its first read after the event is
// revision 1) and whether the labeler and the issue's text are a
// maintainer's.
func (s *MythicalService) observeLabelEvent(ctx context.Context, repositoryID int64, gh mythicalGitHubRepo, event mythicalIssueEvent) error {
	return s.observeLabelEventInTx(ctx, nil, repositoryID, gh, event)
}

func (s *MythicalService) observeLabelEventInTx(ctx context.Context, admission pgx.Tx, repositoryID int64, gh mythicalGitHubRepo, event mythicalIssueEvent) error {
	var consumed bool
	if err := s.store.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM install_settings WHERE key IN ($1,$2))`,
		fmt.Sprintf("todo-label:%d:%d:%d", repositoryID, event.Issue, event.ID),
		fmt.Sprintf("todo-refused:%d:%d:%d", repositoryID, event.Issue, event.ID)).Scan(&consumed); err != nil {
		return err
	}
	if consumed {
		return nil
	}
	issue, err := s.github.Issue(ctx, gh, event.Issue)
	if err != nil {
		return err
	}
	applied := gitHubLabelApplication{Label: todoLabel, By: event.Actor.Login, EventID: event.ID}
	// Only the install's own label is an acknowledgment, never another door.
	if event.ViaApp || !gitHubPerson(&event.Actor) {
		if api, ok := s.github.(*mythicalGitHubAPI); ok && api.credentials != nil {
			credentials, err := api.credentials.Load(ctx)
			if err != nil {
				return err
			}
			if strings.EqualFold(event.Actor.Login, credentials.Slug+"[bot]") {
				return nil
			}
		}
		return s.refuseTodoLabel(ctx, admission, repositoryID, gh, event, "only members of this install can add `todo`")
	}
	role, err := s.todoLabelMember(ctx, repositoryID, gh, event.Actor)
	if err != nil {
		return err
	}
	if role == "" {
		return s.refuseTodoLabel(ctx, admission, repositoryID, gh, event, "only members of this install can add `todo`")
	}
	applied.ByMember, applied.ByMaintainer = true, role == "admin" || role == "owner"
	if _, err := s.queries().GetActiveMythicalItemByIssue(ctx, repositoryID, issue.Number); err == nil {
		// Existing TODOs freeze their text; an authorized fresh label is only
		// consumed, without reconsidering edits or removing its label.
		issue.TextByMaintainer = true
		return s.observeIssueInTx(ctx, admission, repositoryID, issue, applied)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if api, ok := s.github.(*mythicalGitHubAPI); ok {
		text, err := api.text.IssueText(ctx, gh.Token, gh.Owner, gh.Name, issue.Number)
		if err != nil {
			return err
		}
		if text.Title != issue.Title || text.Body != issue.Body {
			return errGitHubIssueTextUnavailable
		}
		for _, edit := range []struct {
			writer *gitHubActor
			at     time.Time
		}{{text.BodyWriter, text.BodyEditedAt}, {text.TitleWriter, text.TitleEditedAt}} {
			if event.CreatedAt.IsZero() || !edit.at.After(event.CreatedAt) {
				continue
			}
			trusted := false
			if edit.writer != nil {
				var err error
				trusted, err = s.todoIssueWriter(ctx, repositoryID, gh, *edit.writer)
				if err != nil {
					return err
				}
			}
			if !trusted {
				return s.refuseTodoLabel(ctx, admission, repositoryID, gh, event, "Changed after it was labeled. Label it again to make a TODO.")
			}
		}
		issue.TextByMaintainer = true
		for _, writer := range []*gitHubActor{text.Author, text.TitleWriter, text.BodyWriter} {
			if writer == nil {
				issue.TextByMaintainer = false
				continue
			}
			trusted, err := s.todoIssueWriter(ctx, repositoryID, gh, *writer)
			if err != nil {
				return err
			}
			if !trusted {
				issue.TextByMaintainer = false
			}
		}
	} else if issue.TextByMaintainer, err = s.github.IssueTextByMaintainer(ctx, gh, issue); err != nil {
		return err
	}
	if !issue.TextByMaintainer && !applied.ByMaintainer {
		return s.refuseTodoLabel(ctx, admission, repositoryID, gh, event, "Only a maintainer can make a TODO from this issue")
	}

	if reader, ok := s.github.(mythicalIssueReader); ok {
		thread, found, err := reader.IssueThread(ctx, gh, issue.Number)
		if err != nil {
			return err
		}
		if !found {
			return errGitHubIssueTextUnavailable
		}
		if thread.Issue.Title != issue.Title || thread.Issue.Body != issue.Body {
			return errGitHubIssueTextUnavailable
		}
		issue.Context, _ = json.Marshal(thread)
	}
	return s.observeIssueInTx(ctx, admission, repositoryID, issue, applied)
}

// issueEventsCursor reads a repository's cursor: the largest event id
// handed over, and whether one was ever saved.
func (s *MythicalService) issueEventsCursor(ctx context.Context, key string) (int64, bool, error) {
	var value struct {
		Cursor int64 `json:"cursor"`
	}
	var raw []byte
	err := s.store.QueryRow(ctx, `SELECT value FROM install_settings WHERE key = $1`, key).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	if err = json.Unmarshal(raw, &value); err != nil {
		return 0, false, err
	}
	return value.Cursor, true, nil
}

// saveIssueEventsCursor moves a repository's cursor forward, never back.
func (s *MythicalService) saveIssueEventsCursor(ctx context.Context, key string, cursor int64) error {
	_, err := s.store.Exec(ctx, `INSERT INTO install_settings (key, value) VALUES ($1, jsonb_build_object('cursor', $2::bigint))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
WHERE (install_settings.value->>'cursor')::bigint < $2::bigint`, key, cursor)
	return err
}

// Refusal completion is keyed by the immutable label event. A failed remote
// write leaves the cursor behind it; the existing keyed comment converges on
// replay after a crash between GitHub success and local acknowledgment.
func (s *MythicalService) refuseTodoLabel(ctx context.Context, admission pgx.Tx, repositoryID int64, gh mythicalGitHubRepo, event mythicalIssueEvent, reason string) error {
	return s.withTodoLabelTransaction(ctx, admission, func(tx pgx.Tx) error {
		key := fmt.Sprintf("todo-refused:%d:%d:%d", repositoryID, event.Issue, event.ID)
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, key); err != nil {
			return err
		}
		var done bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM install_settings WHERE key=$1)`, key).Scan(&done); err != nil {
			return err
		}
		if done {
			return nil
		}
		if err := s.github.RemoveLabel(ctx, gh, event.Issue, todoLabel); err != nil {
			return err
		}
		if err := s.github.Comment(ctx, gh, event.Issue, key, reason); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES($1,'true') ON CONFLICT DO NOTHING`, key); err != nil {
			return err
		}
		return advanceTodoLabelCursor(ctx, tx, repositoryID, event.ID)
	})
}

func advanceTodoLabelCursor(ctx context.Context, tx pgx.Tx, repositoryID, eventID int64) error {
	_, err := tx.Exec(ctx, `UPDATE install_settings SET value=jsonb_build_object('cursor',$2::bigint),updated_at=now()
 WHERE key=$1 AND (value->>'cursor')::bigint<$2`, mythicalIssueEventsCursor+strconv.FormatInt(repositoryID, 10), eventID)
	return err
}

// The fetched-fact acknowledgment and TODO admission share this transaction.
func (s *MythicalService) withTodoLabelTransaction(ctx context.Context, tx pgx.Tx, apply func(pgx.Tx) error) error {
	if tx != nil {
		return apply(tx)
	}
	return pgx.BeginFunc(ctx, s.store, apply)
}

func (s *MythicalService) consumeGitHubTodoLabels(ctx context.Context, tx pgx.Tx, fact gitHubFetchedObject) (json.RawMessage, error) {
	if s == nil || s.installGitHubSync == nil || fact.Resource != gitHubIssueEvents {
		return nil, issueTodoUnavailable()
	}
	var event gitHubFetchedEvent
	if err := json.Unmarshal(fact.Object, &event); err != nil {
		return nil, err
	}
	var issue gitHubListedIssue
	if err := json.Unmarshal(event.Issue, &issue); err != nil {
		return nil, err
	}
	if event.ID != fact.EventID || issue.Number != fact.Number {
		return nil, issueTodoUnavailable()
	}
	if event.Event != "labeled" || !strings.EqualFold(event.Label.Name, todoLabel) || issue.pull() {
		return json.RawMessage(`{"todo":false}`), nil
	}
	source, err := db.New(tx).GetGitHubSyncedRepoByGitHubID(ctx, pgtype.Int8{Int64: fact.GitHubRepository, Valid: true})
	if err != nil {
		return nil, err
	}
	ids, err := db.New(tx).ListRepositoryIDsForGitHubSource(ctx, source.OwnerLogin, source.RepoName)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		stack, err := db.New(tx).GetMythicalStack(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		// Labels preceding this stack are history, not requests to the install.
		if stack.CreatedAt.Valid && !event.CreatedAt.IsZero() && event.CreatedAt.Before(stack.CreatedAt.Time) {
			continue
		}
		api, ok := s.github.(*mythicalGitHubAPI)
		if !ok {
			return nil, issueTodoUnavailable()
		}
		repository, err := db.New(tx).GetRepoByID(ctx, id)
		if err != nil {
			return nil, err
		}
		token, err := api.pushReadToken(ctx, source, "issues")
		if err != nil {
			return nil, err
		}
		gh := mythicalGitHubRepo{Owner: source.OwnerLogin, Name: source.RepoName, Token: token,
			userID: repository.UserID.Int64, orgID: repository.OrgID.Int64}
		labeled := mythicalIssueEvent{ID: event.ID, CreatedAt: event.CreatedAt, Actor: event.Actor, Label: event.Label.Name, Issue: issue.Number,
			Event: event.Event, ViaApp: event.ViaApp != nil && string(*event.ViaApp) != "null"}
		if err := s.observeLabelEventInTx(ctx, tx, id, gh, labeled); err != nil {
			return nil, err
		}
	}
	return json.RawMessage(`{"todo":true}`), nil
}
