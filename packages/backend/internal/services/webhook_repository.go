package services

import (
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// webhookRepositoryPayload names the repository of a webhook event. Consumers
// such as github-sync match a repository by full_name because a bare name is
// ambiguous across owners, so every event that knows its owner sets it.
func webhookRepositoryPayload(owner string, repository db.Repository) webhooks.RepositoryPayload {
	payload := webhooks.RepositoryPayload{
		ID:   repository.ID,
		Name: repository.Name,
	}
	if owner != "" {
		payload.FullName = owner + "/" + repository.Name
	}
	return payload
}
