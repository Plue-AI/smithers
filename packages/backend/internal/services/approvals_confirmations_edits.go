package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

type RepositoryEditInput struct {
	Name    string  `json:"name,omitempty"`
	Request string  `json:"request"`
	Diff    *string `json:"diff,omitempty"`
}

func (s *MythicalService) prepareRepositoryEditConfirmation(ctx context.Context, tx pgx.Tx, repository int64, input ConfirmationInput, inspect bool) (preparedConfirmation, error) {
	p := preparedConfirmation{}
	var subject struct {
		Kind string `json:"kind"`
		Ref  string `json:"ref"`
	}
	var request RepositoryEditInput
	if confirmationJSON(input.Subject, &subject) != nil || subject.Kind != strings.TrimSuffix(input.Command, ".edit") || confirmationJSON(input.Payload, &request) != nil || request.Name != "" && request.Name != subject.Ref || strings.TrimSpace(request.Request) == "" || len(request.Request) > 64<<10 {
		return p, invalidConfirmation()
	}
	request.Name = subject.Ref
	if subject.Kind == "flow" && !Overridable(request.Name) {
		return p, &TodoControlError{Status: 409, Class: "conflict", Code: "flow_builtin", Message: "Flow is built in"}
	}
	if subject.Kind == "agent" {
		if _, ok := AgentInstructionsPath(request.Name); !ok {
			return p, invalidConfirmation()
		}
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
	flowName := request.Name
	if subject.Kind == "agent" {
		flowName = "todo"
	}
	cards, err := RepositoryFlowCatalog(ctx, q, repository)
	if err != nil {
		return p, err
	}
	digest := ""
	for _, card := range cards {
		if card.Name == flowName && !card.System {
			for _, version := range card.Versions {
				if version.State == "active" {
					digest = version.ID
				}
			}
		}
	}
	if subject.Kind == "agent" && request.Name == "app" {
		key := fmt.Sprintf("agent.instructions.main:%d", repository)
		if _, err = tx.Exec(ctx, `SELECT 1 FROM install_settings WHERE key=$1 FOR SHARE`, key); err != nil {
			return p, err
		}
		setting, readErr := q.GetInstallSetting(ctx, key)
		if readErr != nil && !errors.Is(readErr, pgx.ErrNoRows) {
			return p, readErr
		}
		digest = "builtin-app-instructions:" + BuiltinAppInstructions
		if readErr == nil {
			digest = "activated-app-instructions:" + string(setting.Value)
		}
	}
	if digest == "" {
		return p, &TodoControlError{Status: 404, Class: "user", Code: "flow_not_found", Message: "Flow unavailable"}
	}
	title := request.Name + " flow"
	if request.Name == "todo" {
		title = "TODO flow"
	}
	path := "flows/" + request.Name + "/flow.ts"
	if subject.Kind == "agent" {
		path, _ = AgentInstructionsPath(request.Name)
		title = strings.ToUpper(request.Name[:1]) + request.Name[1:] + " agent"
	}
	first, _, _ := strings.Cut(request.Request, "\n")
	todo := MythicalTodoInput{Title: "Change the " + title + ": " + strings.TrimSpace(first), Prompt: "Change " + path + ": " + request.Request + "; start from the built-in composition when no override exists", Request: input.Key}
	if subject.Kind == "agent" {
		todo.Prompt = "Change instructions for the " + title + " in " + path + ": " + request.Request + "; keep current instructions until the TODO merges"
	}
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
	p.editTodo = &todo
	p.card = map[string]any{"kind": "one_click", "action": map[string]string{"tag": input.Command, "verb": "Commit"}, "summary": p.title, "text": todo.Prompt,
		"subject": map[string]string{"kind": subject.Kind, "ref": subject.Ref, "revision": p.revision}, "asked_by": todoActor(ctx, *middleware.AuthInfoFromContext(ctx).User)}
	return p, nil
}

// FileRepositoryEdit proposes ordinary repository work; it never applies the diff.
func (s *MythicalService) FileRepositoryEdit(ctx context.Context, repository, actor int64, command, name string, request RepositoryEditInput, key string) (MythicalItemView, error) {
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
		subject, _ := json.Marshal(map[string]string{"kind": strings.TrimSuffix(command, ".edit"), "ref": name})
		payload, _ := json.Marshal(request)
		prepared, err := s.prepareRepositoryEditConfirmation(ctx, tx, repository, ConfirmationInput{Command: command, Subject: subject, Payload: payload, Key: key}, true)
		if err != nil {
			return err
		}
		consumer := *s
		consumer.store = tx
		item, err = consumer.FileTodo(ctx, repository, actor, *prepared.editTodo)
		return err
	})
	return item, err
}
