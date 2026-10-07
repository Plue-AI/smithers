package compose

import (
	"context"
	"encoding/json"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Review results use the same branch authority and retained journal as chat.
// No model is launched to deliver a completed machine's findings.
type reviewConversationDelivery struct {
	store   *chat.Store
	resolve func(context.Context, chat.Scope, string) (string, error)
}

func (d reviewConversationDelivery) Ready(ctx context.Context, a services.ReviewAdmission) error {
	scope := chat.Scope{RepositoryID: a.RepositoryID, UserID: a.RequesterID}
	branch, err := d.resolve(ctx, scope, a.Conversation)
	if err != nil {
		return err
	}
	_, err = d.store.SharedEntries(ctx, scope, branch)
	return err
}

func (d reviewConversationDelivery) Deliver(ctx context.Context, id string, a services.ReviewAdmission, change json.RawMessage) error {
	scope := chat.Scope{RepositoryID: a.RepositoryID, UserID: a.RequesterID}
	branch, err := d.resolve(ctx, scope, a.Conversation)
	if err != nil {
		return err
	}
	return d.store.DeliverReview(ctx, scope, branch, id, a.Number, change)
}

var _ services.ReviewDelivery = reviewConversationDelivery{}
