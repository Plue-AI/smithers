package routes

import "context"

// Existing delivery integration tests exercise real PostgreSQL delivery state;
// sealed credential persistence is verified by the credential-store suite.
type routeWebhookCredentialFixture string

func (f routeWebhookCredentialFixture) WebhookSecret(context.Context) (string, error) {
	return string(f), nil
}
