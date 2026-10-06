package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// ErrAPIForbidden means the turn no longer has its author's API authority.
var ErrAPIForbidden = errors.New("the turn no longer acts for its author")

// TurnAPI is a host-only bearer for the turn's current producer generation.
// It is never a conversation frame, model input, or browser response.
type TurnAPI struct {
	Author  string `json:"author"`
	Token   string `json:"token"`
	TokenID int64  `json:"-"`
}

// InstallAPI issues credentials; commands use the ordinary authenticated API
// router, including its policy, confirmation, attribution and rate limits.
type InstallAPI struct{ Auth *AuthService }

// Begin rechecks the claimed subject and its author before issuing a bearer.
// Canonical shared prompts have durable author identity. Legacy private turns
// additionally retain their admitting session requirement until shell cutover.
func (a InstallAPI) Begin(ctx context.Context, credential middleware.Credential, userID int64, turnID string, generation int64) (TurnAPI, error) {
	if a.Auth == nil {
		return TurnAPI{}, &AccessError{Status: http.StatusServiceUnavailable, Class: "infra", Code: "credential_issuer_unavailable", Message: "Credential issuer unavailable"}
	}
	if err := a.Auth.requireDelegatedMember(ctx, userID); err != nil {
		return TurnAPI{}, err
	}
	q := db.New(a.Auth.Members.Pool)
	subject, err := q.GetChatTurnCredentialSubject(ctx, db.GetChatTurnCredentialSubjectParams{TurnID: turnID, UserID: userID, Generation: generation})
	if errors.Is(err, pgx.ErrNoRows) {
		return TurnAPI{}, ErrAPIForbidden
	}
	if err != nil {
		return TurnAPI{}, err
	}
	var request struct {
		SharedConversation bool `json:"sharedConversation"`
	}
	if err = json.Unmarshal(subject.RequestPayload, &request); err != nil {
		return TurnAPI{}, ErrAPIForbidden
	}
	if !request.SharedConversation {
		if _, err = turnAuthor(ctx, q, identity.NewMemberBoundary(q), credential, userID, func(info *middleware.AuthInfo) bool { return !info.IsTokenAuth && info.SessionHash != "" }); err != nil {
			if errors.Is(err, errNotTheAuthor) {
				return TurnAPI{}, ErrAPIForbidden
			}
			return TurnAPI{}, err
		}
	}
	author, err := q.GetUserByID(ctx, userID)
	if err != nil {
		return TurnAPI{}, err
	}
	token, err := a.Auth.MintForTurn(ctx, userID, turnID, generation)
	if err != nil {
		return TurnAPI{}, err
	}
	return TurnAPI{Author: author.Username, Token: token.Token, TokenID: token.ID}, nil
}

// End removes a bearer even when model execution failed or was cancelled.
// The authentication lookup independently fences it on lease/turn termination.
func (a InstallAPI) End(ctx context.Context, userID, tokenID int64) error {
	if a.Auth == nil {
		return ErrAPIForbidden
	}
	return a.Auth.DeleteToken(ctx, userID, tokenID)
}
