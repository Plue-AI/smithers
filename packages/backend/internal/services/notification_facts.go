package services

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type NotificationFactQueries interface {
	GetNotificationJournal(context.Context, int64) (db.NotificationJournal, error)
	ListNotificationFacts(context.Context, db.ListNotificationFactsParams) ([]db.ListNotificationFactsRow, error)
}

type NotificationFactCoverage struct {
	Kind      string     `json:"kind"`
	StartedAt *time.Time `json:"started_at,omitempty"`
}

type NotificationFactPage struct {
	SchemaVersion      int16                    `json:"schema_version"`
	StreamID           string                   `json:"stream_id"`
	Events             []NotificationFact       `json:"events"`
	Cursor             int64                    `json:"cursor"`
	Head               int64                    `json:"head"`
	HasMore            bool                     `json:"has_more"`
	VisibilityFiltered bool                     `json:"visibility_filtered"`
	Coverage           NotificationFactCoverage `json:"coverage"`
}

// DecodeNotificationFact decodes the immutable stored post-image. It is shared
// by serving and raw projection verification so the wire and projector agree.
func DecodeNotificationFact(row db.ListNotificationFactsRow) (NotificationFact, db.Notification, error) {
	var notification db.Notification
	if err := json.Unmarshal(row.PostImage, &notification); err != nil {
		return NotificationFact{}, notification, err
	}
	notification.UserID = row.UserID
	notification.CreatedAt = notification.CreatedAt.UTC()
	notification.UpdatedAt = notification.UpdatedAt.UTC()
	if notification.ReadAt.Valid {
		notification.ReadAt.Time = notification.ReadAt.Time.UTC()
	}
	result := NotificationFact{StreamID: fmt.Sprintf("notifications:%d", row.UserID), ID: row.EventID, Sequence: row.Sequence, SchemaVersion: row.SchemaVersion, Type: row.EventType, NotificationID: row.NotificationID, RecordedAt: row.RecordedAt.UTC()}
	if row.EventType != "notification.deleted" {
		value := toNotificationResponse(notification)
		result.Notification = &value
	}
	if err := validateNotificationFact(result); err != nil {
		return NotificationFact{}, notification, err
	}
	return result, notification, nil
}

// ListNotificationFacts returns a bounded, currently authorized journal page.
// Head is captured first, and both facts and their final post-image are read
// through that head. Current repository permissions remain an external input.
func (s *NotificationService) ListNotificationFacts(ctx context.Context, userID, after int64, limit int) (NotificationFactPage, error) {
	if after < 0 {
		return NotificationFactPage{}, pkgerrors.BadRequest("invalid notification journal cursor")
	}
	if limit < 1 || limit > 1000 {
		limit = 1000
	}
	q, ok := s.q.(NotificationFactQueries)
	if !ok {
		return NotificationFactPage{}, pkgerrors.Internal("notification journal unavailable")
	}
	page := NotificationFactPage{SchemaVersion: 1, StreamID: fmt.Sprintf("notifications:%d", userID), Events: []NotificationFact{}, Cursor: after, Coverage: NotificationFactCoverage{Kind: "from_creation"}}
	journal, err := q.GetNotificationJournal(ctx, userID)
	if err == pgx.ErrNoRows {
		if after > 0 {
			return NotificationFactPage{}, pkgerrors.UnknownCursor("notification cursor is ahead of journal")
		}
		return page, nil
	}
	if err != nil {
		return NotificationFactPage{}, pkgerrors.Internal("read notification journal: " + err.Error())
	}
	page.Head = journal.Head
	page.Coverage = NotificationFactCoverage{Kind: journal.CoverageKind, StartedAt: &journal.CoverageStartedAt}
	if after > journal.Head {
		return NotificationFactPage{}, pkgerrors.UnknownCursor("notification cursor is ahead of journal")
	}
	rows, err := q.ListNotificationFacts(ctx, db.ListNotificationFactsParams{UserID: userID, AfterSequence: after, ThroughSequence: journal.Head, PageSize: int32(limit)})
	if err != nil {
		return NotificationFactPage{}, pkgerrors.Internal("read notification facts: " + err.Error())
	}
	checker := &notificationAccessChecker{q: s.q, userID: userID, issueRepos: map[int64]int64{}, landingRepos: map[int64]int64{}, branchLockRepos: map[int64]int64{}, repoReadable: map[int64]bool{}}
	for _, row := range rows {
		// A gap in this raw counter cannot be explained by another user's events.
		if row.Sequence != page.Cursor+1 {
			return NotificationFactPage{}, pkgerrors.Internal("notification journal gap")
		}
		fact, historical, decodeErr := DecodeNotificationFact(row)
		if decodeErr != nil {
			return NotificationFactPage{}, pkgerrors.Internal("decode notification fact: " + decodeErr.Error())
		}
		var current db.Notification
		if err := json.Unmarshal(row.CurrentPostImage, &current); err != nil {
			return NotificationFactPage{}, pkgerrors.Internal("decode current notification fact: " + err.Error())
		}
		current.UserID = userID
		canSeeCurrent, err := checker.canSee(ctx, current)
		if err != nil {
			return NotificationFactPage{}, err
		}
		canSeeHistorical := false
		if canSeeCurrent {
			canSeeHistorical, err = checker.canSee(ctx, historical)
			if err != nil {
				return NotificationFactPage{}, err
			}
		}
		if canSeeCurrent && canSeeHistorical {
			page.Events = append(page.Events, fact)
		} else {
			page.VisibilityFiltered = true
		}
		page.Cursor = row.Sequence
	}
	page.HasMore = page.Cursor < page.Head
	if page.HasMore && len(rows) == 0 {
		return NotificationFactPage{}, pkgerrors.Internal("notification journal truncated")
	}
	return page, nil
}
