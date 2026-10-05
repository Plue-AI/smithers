package services

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// TodoAmendInput is a new prompt revision on the same TODO. Authority and the
// idempotency key come from the authenticated request, never its JSON body.
type TodoAmendInput struct {
	Prompt     string   `json:"prompt"`
	Acceptance []string `json:"acceptance"`
	Repository int64    `json:"-"`
	Actor      int64    `json:"-"`
	Request    string   `json:"-"`
}

func (input TodoAmendInput) feedback() (string, error) {
	invalid := &TodoControlError{http.StatusBadRequest, "invalid_amendment", "user", "Invalid amendment"}
	if strings.TrimSpace(input.Prompt) == "" || !utf8.ValidString(input.Prompt) || len(input.Prompt) > mythicalPromptBytes {
		return "", invalid
	}
	var text strings.Builder
	text.WriteString(input.Prompt)
	if len(input.Acceptance) > 0 {
		text.WriteString("\n\nAcceptance:")
		for _, criterion := range input.Acceptance {
			if !utf8.ValidString(criterion) || len(criterion) > mythicalPromptBytes-text.Len()-3 {
				return "", invalid
			}
			text.WriteString("\n- ")
			text.WriteString(criterion)
		}
	}
	return text.String(), nil
}

// AmendTodo commits a revision and its attributed feedback together. It uses
// Steer's disabled-until-qualified gate and delivery path. Delegated requests
// cannot pass Authorize until the shared confirmation provider is available.
func (s *MythicalService) AmendTodo(ctx context.Context, number int64, input TodoAmendInput) (TodoControlReceipt, error) {
	if number <= 0 {
		return TodoControlReceipt{}, &TodoControlError{http.StatusBadRequest, "invalid_todo", "user", "Invalid TODO number"}
	}
	text, err := input.feedback()
	if err != nil {
		return TodoControlReceipt{}, err
	}
	return s.admitTodoFeedback(ctx, number, TodoControlInput{Repository: input.Repository, Actor: input.Actor, Request: input.Request, Steer: &text}, &input)
}

func prepareTodoAmend(ctx context.Context, item db.MythicalItem, input TodoControlInput, amendment TodoAmendInput, by json.RawMessage, attribution map[string]string, now time.Time) (db.MythicalItem, todoSteer, bool, error) {
	credential, err := todoFeedbackCredential(ctx, input.Actor)
	if err != nil {
		return item, todoSteer{}, false, err
	}
	var revisions []json.RawMessage
	if json.Unmarshal(item.Revisions, &revisions) != nil || len(revisions) == 0 {
		return item, todoSteer{}, false, todoControlUnavailable()
	}
	for _, feedback := range mythicalChecksOf(item).Steers {
		if feedback.Request != input.Request || feedback.Author != input.Actor {
			continue
		}
		if feedback.Credential == "" {
			return item, todoSteer{}, false, todoControlUnavailable()
		}
		if feedback.Credential != credential {
			continue
		}
		var revision struct {
			Text       string   `json:"text"`
			Acceptance []string `json:"acceptance"`
		}
		if feedback.Revision <= 1 || feedback.Revision > len(revisions) ||
			json.Unmarshal(revisions[feedback.Revision-1], &revision) != nil ||
			revision.Text != amendment.Prompt || !slices.Equal(revision.Acceptance, amendment.Acceptance) {
			return item, todoSteer{}, false, todoFeedbackMismatch()
		}
		return item, feedback, true, nil
	}
	if mythicalMergeFenced(item) {
		return item, todoSteer{}, false, &TodoControlError{http.StatusConflict, "merging", "conflict", "TODO is merging"}
	}
	next, feedback, _, _, err := prepareTodoSteer(ctx, item, input, by, attribution, now)
	if err != nil {
		return item, todoSteer{}, false, err
	}
	acceptance := slices.Clone(amendment.Acceptance)
	if acceptance == nil {
		acceptance = []string{}
	}
	revision, err := json.Marshal(map[string]any{"text": amendment.Prompt, "acceptance": acceptance, "by": by, "at": now.UTC().Format(time.RFC3339Nano), "reason": "amend"})
	if err != nil {
		return item, todoSteer{}, false, err
	}
	next.Revisions, err = json.Marshal(append(revisions, revision))
	if err != nil {
		return item, todoSteer{}, false, err
	}
	feedback.Revision = len(revisions) + 1
	checks := mythicalChecksOf(next)
	checks.Steers[len(checks.Steers)-1] = feedback
	next.Checks = checks.encode()
	return next, feedback, false, nil
}
