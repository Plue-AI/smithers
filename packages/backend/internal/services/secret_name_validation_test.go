package services

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// The injector rejects any stored name that is not an environment variable
// name, which fails every workflow run in the repository or org. The setters
// must refuse such names up front.
func TestSecretAndVariableSetters_RejectNonEnvNames(t *testing.T) {
	actor := &db.User{ID: 1, IsAdmin: true}
	ctx := context.Background()
	for _, name := range []string{"MY-KEY", "1ABC", "a b", "deploy.token"} {
		t.Run(name, func(t *testing.T) {
			_, err := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}).SetSecret(ctx, actor, "alice", "demo", name, "v", nil, nil)
			assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err), "SetSecret")
			_, err = NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}).SetOrgSecret(ctx, actor, "acme", name, "v", nil)
			assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err), "SetOrgSecret")
			_, err = NewVariableService(&mockVariableQuerier{}).SetVariable(ctx, actor, "alice", "demo", name, "v")
			assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err), "SetVariable")
			_, err = NewVariableService(&mockVariableQuerier{}).SetOrgVariable(ctx, actor, "acme", name, "v")
			assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err), "SetOrgVariable")
		})
	}
}
