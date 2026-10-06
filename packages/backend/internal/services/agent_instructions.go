package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// ReadAgentInstructions reads Markdown data from the last successfully activated
// main commit. New mirror content, working copies and failed loads cannot change
// the app's instructions. Empty means the built-in instructions still apply.
func (s InstallSource) ReadAgentInstructions(ctx context.Context, credential middleware.Credential, userID, repositoryID int64) (string, error) {
	owner, repository, _, err := s.readable(ctx, credential, userID, repositoryID)
	if err != nil {
		return "", err
	}
	text, _, err := s.activatedAppInstructions(ctx, owner, repository)
	return text, err
}

const BuiltinAppInstructions = "Answer the repository question as Smithers for the prompt author. To change your instructions, propose a TODO editing .smithers/instructions/app.md through todo.new; keep your current instructions until the merged change activates."

func (s InstallSource) activatedAppInstructions(ctx context.Context, owner string, repository db.Repository) (string, string, error) {
	setting, err := db.New(s.Pool).GetInstallSetting(ctx, fmt.Sprintf("agent.instructions.main:%d", repository.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	var revision string
	if err := json.Unmarshal(setting.Value, &revision); err != nil {
		return "", "", err
	}
	if revision == "" {
		return "", "", nil
	}
	host, ok := s.Repos.repoHost.(interface {
		GetFileAtCommit(context.Context, string, string, string, string) (repohost.FileContent, error)
	})
	if !ok {
		return "", "", errors.New("activated instruction reader unavailable")
	}
	file, err := host.GetFileAtCommit(ctx, owner, repository.Name, revision, ".smithers/instructions/app.md")
	if repohost.IsFileNotFound(err) {
		return "", revision, nil
	}
	if err != nil {
		return "", "", err
	}
	if file.TooLarge || len(file.Content) > 64*1024 {
		return "", "", ErrSourceTooLarge
	}
	if file.Encoding == "base64" || strings.ContainsRune(file.Content, 0) {
		return "", "", errors.New("agent instructions must be Markdown text")
	}
	return file.Content, revision, nil
}
