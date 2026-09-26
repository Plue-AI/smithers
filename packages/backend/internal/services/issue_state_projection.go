package services

import (
	"encoding/json"
	"fmt"
	"maps"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// IssueStateFact records accepted owned rows; it is not the actor timeline.
// User/label display data and linked domain rows are external inputs.
type IssueStateFact struct {
	ID            string          `json:"id"`
	StreamID      string          `json:"stream_id"`
	Sequence      int64           `json:"sequence"`
	SchemaVersion int16           `json:"schema_version"`
	EntityType    string          `json:"entity_type"`
	Operation     string          `json:"operation"`
	IssueID       int64           `json:"issue_id"`
	EntityKey     string          `json:"entity_key"`
	PostImage     json.RawMessage `json:"post_image,omitempty"`
	RecordedAt    time.Time       `json:"recorded_at"`
}

type IssueStateProjection struct {
	Comments  map[int64]db.IssueComment  `json:"comments"`
	StreamID  string                     `json:"stream_id"`
	Cursor    int64                      `json:"cursor"`
	Issues    map[int64]db.Issue         `json:"issues"`
	Labels    map[string]db.IssueLabel   `json:"labels"`
	Assignees map[int64]db.IssueAssignee `json:"assignees"`
}

func DecodeIssueStateFact(row db.IssueStateFact) (IssueStateFact, error) {
	fact := IssueStateFact{ID: row.EventID, StreamID: fmt.Sprintf("issues:%d", row.RepositoryID), Sequence: row.Sequence, SchemaVersion: row.SchemaVersion, EntityType: row.EntityType, Operation: row.Operation, IssueID: row.IssueID, EntityKey: row.EntityKey, PostImage: append(json.RawMessage(nil), row.PostImage...), RecordedAt: row.RecordedAt.UTC()}
	return fact, validateIssueStateFact(fact)
}
func validateIssueStateFact(f IssueStateFact) error {
	var repo int64
	if _, err := fmt.Sscanf(f.StreamID, "issues:%d", &repo); err != nil || repo <= 0 || f.StreamID != fmt.Sprintf("issues:%d", repo) {
		return fmt.Errorf("invalid issue stream identity")
	}
	if _, err := uuid.Parse(f.ID); err != nil {
		return fmt.Errorf("invalid issue fact UUID")
	}
	if f.SchemaVersion != 1 || f.Sequence <= 0 || f.IssueID <= 0 || f.RecordedAt.IsZero() {
		return fmt.Errorf("invalid issue fact version, position or timestamp")
	}
	switch f.Operation {
	case "baseline", "created", "updated":
		if len(f.PostImage) == 0 {
			return fmt.Errorf("issue fact missing post-image")
		}
	case "deleted":
		if len(f.PostImage) != 0 {
			return fmt.Errorf("issue delete must omit post-image")
		}
	default:
		return fmt.Errorf("invalid issue fact operation")
	}
	switch f.EntityType {
	case "issue":
		if f.EntityKey != strconv.FormatInt(f.IssueID, 10) {
			return fmt.Errorf("issue identity mismatch")
		}
		if f.Operation != "deleted" {
			var row db.Issue
			if err := json.Unmarshal(f.PostImage, &row); err != nil {
				return err
			}
			if row.ID != f.IssueID || row.RepositoryID != repo || row.Number <= 0 || row.CreatedAt.IsZero() || row.UpdatedAt.IsZero() {
				return fmt.Errorf("issue post-image identity or timestamp mismatch")
			}
			switch row.State {
			case "open", "closed", "fixed", "verified":
			default:
				return fmt.Errorf("invalid issue state")
			}
		}
	case "issue_label":
		parts := strings.Split(f.EntityKey, ":")
		if len(parts) != 2 || parts[0] != strconv.FormatInt(f.IssueID, 10) {
			return fmt.Errorf("issue label identity mismatch")
		}
		labelID, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || labelID <= 0 {
			return fmt.Errorf("issue label identity mismatch")
		}
		if f.Operation != "deleted" {
			var row db.IssueLabel
			if err := json.Unmarshal(f.PostImage, &row); err != nil {
				return err
			}
			if row.IssueID != f.IssueID || row.LabelID <= 0 || f.EntityKey != fmt.Sprintf("%d:%d", row.IssueID, row.LabelID) || row.CreatedAt.IsZero() {
				return fmt.Errorf("issue label identity mismatch")
			}
		}
	case "issue_comment":
		id, err := strconv.ParseInt(f.EntityKey, 10, 64)
		if err != nil || id <= 0 {
			return fmt.Errorf("invalid comment identity")
		}
		if f.Operation != "deleted" {
			var row db.IssueComment
			if err := json.Unmarshal(f.PostImage, &row); err != nil {
				return err
			}
			if row.ID != id || row.IssueID != f.IssueID {
				return fmt.Errorf("comment parent mismatch")
			}
		}
	case "issue_assignee":
		assignmentID, err := strconv.ParseInt(f.EntityKey, 10, 64)
		if err != nil || assignmentID <= 0 {
			return fmt.Errorf("issue assignment identity mismatch")
		}
		if f.Operation != "deleted" {
			var row db.IssueAssignee
			if err := json.Unmarshal(f.PostImage, &row); err != nil {
				return err
			}
			if row.IssueID != f.IssueID || row.ID <= 0 || f.EntityKey != strconv.FormatInt(row.ID, 10) || row.CreatedAt.IsZero() {
				return fmt.Errorf("issue assignee identity mismatch")
			}
		}
	default:
		return fmt.Errorf("invalid issue fact entity")
	}
	return nil
}
func newIssueStateProjection() IssueStateProjection {
	return IssueStateProjection{Comments: map[int64]db.IssueComment{}, Issues: map[int64]db.Issue{}, Labels: map[string]db.IssueLabel{}, Assignees: map[int64]db.IssueAssignee{}}
}
func applyIssueStateFact(s *IssueStateProjection, f IssueStateFact) error {
	if f.Operation == "deleted" {
		switch f.EntityType {
		case "issue":
			delete(s.Issues, f.IssueID)
			for k, v := range s.Comments {
				if v.IssueID == f.IssueID {
					delete(s.Comments, k)
				}
			}
			for k, v := range s.Labels {
				if v.IssueID == f.IssueID {
					delete(s.Labels, k)
				}
			}
			for k, v := range s.Assignees {
				if v.IssueID == f.IssueID {
					delete(s.Assignees, k)
				}
			}
		case "issue_comment":
			id, _ := strconv.ParseInt(f.EntityKey, 10, 64)
			delete(s.Comments, id)
		case "issue_label":
			delete(s.Labels, f.EntityKey)
		case "issue_assignee":
			id, err := strconv.ParseInt(f.EntityKey, 10, 64)
			if err != nil {
				return err
			}
			if row, ok := s.Assignees[id]; ok && row.IssueID != f.IssueID {
				return fmt.Errorf("issue assignment parent mismatch")
			}
			delete(s.Assignees, id)
		}
	} else {
		switch f.EntityType {
		case "issue":
			var row db.Issue
			if err := json.Unmarshal(f.PostImage, &row); err != nil {
				return err
			}
			row.CreatedAt = row.CreatedAt.UTC()
			row.UpdatedAt = row.UpdatedAt.UTC()
			row.ClosedAt.Time = row.ClosedAt.Time.UTC()
			row.FixedAt.Time = row.FixedAt.Time.UTC()
			row.VerifiedAt.Time = row.VerifiedAt.Time.UTC()
			s.Issues[row.ID] = row
		case "issue_comment":
			var row db.IssueComment
			if err := json.Unmarshal(f.PostImage, &row); err != nil {
				return err
			}
			s.Comments[row.ID] = row
		case "issue_label":
			var row db.IssueLabel
			if err := json.Unmarshal(f.PostImage, &row); err != nil {
				return err
			}
			if _, ok := s.Issues[row.IssueID]; !ok {
				return fmt.Errorf("membership precedes issue")
			}
			row.CreatedAt = row.CreatedAt.UTC()
			s.Labels[f.EntityKey] = row
		case "issue_assignee":
			var row db.IssueAssignee
			if err := json.Unmarshal(f.PostImage, &row); err != nil {
				return err
			}
			if _, ok := s.Issues[row.IssueID]; !ok {
				return fmt.Errorf("membership precedes issue")
			}
			row.CreatedAt = row.CreatedAt.UTC()
			s.Assignees[row.ID] = row
		}
	}
	s.StreamID = f.StreamID
	s.Cursor = f.Sequence
	return nil
}

// ApplyIssueStateFact is pure and idempotent for previously applied positions.
func ApplyIssueStateFact(state IssueStateProjection, fact IssueStateFact) (IssueStateProjection, error) {
	if err := validateIssueStateFact(fact); err != nil {
		return state, err
	}
	if state.StreamID != "" && state.StreamID != fact.StreamID {
		return state, fmt.Errorf("issue stream identity mismatch")
	}
	if fact.Sequence <= state.Cursor {
		return state, nil
	}
	if fact.Sequence != state.Cursor+1 {
		return state, fmt.Errorf("issue journal gap")
	}
	next := newIssueStateProjection()
	next.StreamID = state.StreamID
	next.Cursor = state.Cursor
	maps.Copy(next.Comments, state.Comments)
	maps.Copy(next.Issues, state.Issues)
	maps.Copy(next.Labels, state.Labels)
	maps.Copy(next.Assignees, state.Assignees)
	if err := applyIssueStateFact(&next, fact); err != nil {
		return state, err
	}
	return next, nil
}

// RebuildIssueStateProjection folds the raw retained journal. Issue deletion
// also removes its projected membership rows.
func RebuildIssueStateProjection(facts []IssueStateFact) (IssueStateProjection, error) {
	state := newIssueStateProjection()
	for _, fact := range facts {
		if err := validateIssueStateFact(fact); err != nil {
			return IssueStateProjection{}, err
		}
		if state.StreamID != "" && state.StreamID != fact.StreamID {
			return IssueStateProjection{}, fmt.Errorf("issue stream identity mismatch")
		}
		if fact.Sequence != state.Cursor+1 {
			return IssueStateProjection{}, fmt.Errorf("issue journal gap")
		}
		if err := applyIssueStateFact(&state, fact); err != nil {
			return IssueStateProjection{}, err
		}
	}
	return state, nil
}
