package services

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
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
	ID     int64
	Event  string
	Actor  gitHubActor
	ViaApp bool
	Label  string
	Issue  int64
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
		out = append(out, mythicalIssueEvent{ID: event.ID, Event: event.Event, Actor: event.Actor,
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
		if event.Event == "labeled" && strings.EqualFold(event.Label, todoLabel) && !event.Pull && !event.ViaApp && gitHubPerson(&event.Actor) {
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
	issue, err := s.github.Issue(ctx, gh, event.Issue)
	if err != nil {
		return err
	}
	applied := gitHubLabelApplication{Label: todoLabel, By: event.Actor.Login, EventID: event.ID}
	if applied.ByMaintainer, err = s.github.Maintainer(ctx, gh, event.Actor); err != nil {
		return err
	}
	if issue.TextByMaintainer, err = s.github.IssueTextByMaintainer(ctx, gh, issue); err != nil {
		return err
	}
	return s.ObserveIssue(ctx, repositoryID, issue, applied)
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
