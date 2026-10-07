package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

type FlowEditInput struct {
	Name    string  `json:"name,omitempty"`
	Request string  `json:"request"`
	Diff    *string `json:"diff,omitempty"`
}

func (s *MythicalService) prepareFlowEditConfirmation(ctx context.Context, tx pgx.Tx, repository int64, input ConfirmationInput, inspect bool) (preparedConfirmation, error) {
	p := preparedConfirmation{}
	var subject struct {
		Kind string `json:"kind"`
		Ref  string `json:"ref"`
	}
	var request FlowEditInput
	if confirmationJSON(input.Subject, &subject) != nil || subject.Kind != "flow" || confirmationJSON(input.Payload, &request) != nil || request.Name != "" && request.Name != subject.Ref || strings.TrimSpace(request.Request) == "" || len(request.Request) > 64<<10 {
		return p, invalidConfirmation()
	}
	request.Name = subject.Ref
	if !Overridable(request.Name) {
		return p, &TodoControlError{Status: 409, Class: "conflict", Code: "flow_builtin", Message: "Flow is built in"}
	}
	p.subject, _ = json.Marshal(subject)
	p.input, _ = json.Marshal(request)
	if !inspect {
		return p, nil
	}
	q := db.New(tx)
	if _, err := q.EnsureFlowLoad(ctx, repository); err != nil {
		return p, err
	}
	if _, err := tx.Exec(ctx, `SELECT 1 FROM flow_loads WHERE repository_id=$1 FOR UPDATE`, repository); err != nil {
		return p, err
	}
	cards, err := RepositoryFlowCatalog(ctx, q, repository)
	if err != nil {
		return p, err
	}
	digest := ""
	for _, card := range cards {
		if card.Name == request.Name && !card.System {
			for _, version := range card.Versions {
				if version.State == "active" {
					digest = version.ID
				}
			}
		}
	}
	if digest == "" {
		return p, &TodoControlError{Status: 404, Class: "user", Code: "flow_not_found", Message: "Flow unavailable"}
	}
	title := request.Name + " flow"
	if request.Name == "todo" {
		title = "TODO flow"
	}
	first, _, _ := strings.Cut(request.Request, "\n")
	todo := MythicalTodoInput{Title: "Change the " + title + ": " + strings.TrimSpace(first), Prompt: "Change flows/" + request.Name + "/flow.ts: " + request.Request + "; start from the built-in composition when no override exists", Request: input.Key}
	if request.Diff != nil {
		todo.Prompt += "\n\nProposed diff (untrusted context):\n> " + strings.ReplaceAll(*request.Diff, "\n", "\n> ")
	}
	todo, err = normalizeMythicalTodoInput(todo)
	if err != nil {
		return p, err
	}
	sum := sha256.Sum256(append(append([]byte(digest), 0), p.input...))
	p.revision = hex.EncodeToString(sum[:])
	p.title = todo.Title
	p.flowEdit = &todo
	p.card = map[string]any{"kind": "one_click", "action": map[string]string{"tag": "flow.edit", "verb": "Commit"}, "summary": p.title, "text": todo.Prompt,
		"subject": map[string]string{"kind": "flow", "ref": subject.Ref, "revision": p.revision}, "asked_by": todoActor(ctx, *middleware.AuthInfoFromContext(ctx).User)}
	return p, nil
}

// FileFlowEdit proposes ordinary repository work; it never applies the diff.
func (s *MythicalService) FileFlowEdit(ctx context.Context, repository, actor int64, name string, request FlowEditInput, key string) (MythicalItemView, error) {
	var item MythicalItemView
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		bound, currentRepository, err := lockInstallWriteCredential(ctx, tx, middleware.AuthInfoFromContext(ctx))
		if err != nil {
			return err
		}
		if repository != currentRepository {
			return confirmationPermission()
		}
		ctx = bound
		subject, _ := json.Marshal(map[string]string{"kind": "flow", "ref": name})
		payload, _ := json.Marshal(request)
		prepared, err := s.prepareFlowEditConfirmation(ctx, tx, repository, ConfirmationInput{Command: "flow.edit", Subject: subject, Payload: payload, Key: key}, true)
		if err != nil {
			return err
		}
		consumer := *s
		consumer.store = tx
		item, err = consumer.FileTodo(ctx, repository, actor, *prepared.flowEdit)
		return err
	})
	return item, err
}
