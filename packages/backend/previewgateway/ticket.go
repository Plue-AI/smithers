package previewgateway

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// A user preview (<port>-<workspace-id>.<suffix>) is private: the API mints a
// ticket after it has checked the viewer's repository and workspace access,
// the gateway exchanges it for a host-only cookie, and every request then
// asks the API whether that grant still holds, so a removed share or a
// suspended user loses the preview within the recheck interval.
const (
	// TicketQueryParameter carries the exchange ticket on the redirect from
	// the API's preview route. The gateway consumes it and redirects to the
	// same URL without it, so guest code never sees it.
	TicketQueryParameter = "__smithers_preview_ticket"
	// SessionCookieName is host-only (the __Host- prefix forbids a Domain
	// attribute): one preview's cookie never reaches another preview host.
	SessionCookieName = "__Host-smithers_preview"

	ExchangeTicketTTL = 2 * time.Minute
	SessionTicketTTL  = 12 * time.Hour

	ticketPrefix       = "smithers_preview_v1."
	ticketKeyDomain    = "smithers:preview-ticket:v1\x00"
	maxTicketLength    = 2048
	clockSkewAllowance = 30 * time.Second
)

type TicketPurpose string

const (
	// PurposeExchange is the short-lived ticket the API puts in a URL.
	PurposeExchange TicketPurpose = "exchange"
	// PurposeSession is the cookie the gateway sets after an exchange.
	PurposeSession TicketPurpose = "session"
)

var ErrInvalidTicket = errors.New("invalid preview ticket")

// Grant is one viewer's access to one preview host.
type Grant struct {
	Domain       string `json:"d"`
	WorkspaceID  string `json:"w"`
	RepositoryID int64  `json:"r"`
	UserID       int64  `json:"u"`
}

type ticketClaims struct {
	Grant
	Purpose   TicketPurpose `json:"p"`
	ExpiresAt int64         `json:"exp"`
}

// Tickets signs and verifies preview tickets. The key derives from the relay
// token the API and the gateway already share, under a purpose-separated
// domain, so the relay credential itself is never exposed or reused raw.
type Tickets struct {
	key []byte
	now func() time.Time
}

// NewTickets returns nil for an empty secret: a nil *Tickets mints nothing
// and verifies nothing.
func NewTickets(relayToken string) *Tickets {
	relayToken = strings.TrimSpace(relayToken)
	if relayToken == "" {
		return nil
	}
	mac := hmac.New(sha256.New, []byte(relayToken))
	_, _ = mac.Write([]byte(ticketKeyDomain))
	return &Tickets{key: mac.Sum(nil), now: time.Now}
}

// Issue signs grant for purpose, valid for ttl.
func (t *Tickets) Issue(grant Grant, purpose TicketPurpose, ttl time.Duration) (string, error) {
	if t == nil {
		return "", errors.New("preview tickets are not configured")
	}
	grant.Domain = strings.ToLower(strings.TrimSpace(grant.Domain))
	if grant.Domain == "" || grant.WorkspaceID == "" || grant.RepositoryID <= 0 || grant.UserID <= 0 || ttl <= 0 {
		return "", errors.New("incomplete preview grant")
	}
	payload, err := json.Marshal(ticketClaims{Grant: grant, Purpose: purpose, ExpiresAt: t.now().Add(ttl).Unix()})
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	return ticketPrefix + encoded + "." + base64.RawURLEncoding.EncodeToString(t.sign(encoded)), nil
}

// Verify returns the grant a ticket carries when it is authentic, unexpired,
// of purpose, and issued for domain.
func (t *Tickets) Verify(ticket string, purpose TicketPurpose, domain string) (Grant, error) {
	grant, err := t.verify(ticket, purpose)
	if err != nil || grant.Domain != strings.ToLower(domain) {
		return Grant{}, ErrInvalidTicket
	}
	return grant, nil
}

// VerifySession returns the grant an authentic, unexpired session ticket
// carries, for whichever preview host it names.
func (t *Tickets) VerifySession(ticket string) (Grant, error) {
	return t.verify(ticket, PurposeSession)
}

func (t *Tickets) verify(ticket string, purpose TicketPurpose) (Grant, error) {
	if t == nil || len(ticket) > maxTicketLength || !strings.HasPrefix(ticket, ticketPrefix) {
		return Grant{}, ErrInvalidTicket
	}
	encoded, signature, ok := strings.Cut(strings.TrimPrefix(ticket, ticketPrefix), ".")
	if !ok {
		return Grant{}, ErrInvalidTicket
	}
	presented, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || !hmac.Equal(presented, t.sign(encoded)) {
		return Grant{}, ErrInvalidTicket
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return Grant{}, ErrInvalidTicket
	}
	var claims ticketClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return Grant{}, ErrInvalidTicket
	}
	if claims.Purpose != purpose || claims.Domain == "" || claims.WorkspaceID == "" ||
		claims.RepositoryID <= 0 || claims.UserID <= 0 || t.now().Add(-clockSkewAllowance).Unix() >= claims.ExpiresAt {
		return Grant{}, ErrInvalidTicket
	}
	return claims.Grant, nil
}

func (t *Tickets) sign(encoded string) []byte {
	mac := hmac.New(sha256.New, t.key)
	_, _ = mac.Write([]byte(encoded))
	return mac.Sum(nil)
}

// GrantAuthorizer answers whether a grant still holds now. nil means yes; a
// denial is ErrGrantRevoked; anything else is an outage the gateway fails
// closed on.
type GrantAuthorizer interface {
	AuthorizeGrant(ctx context.Context, ticket string) error
}

var ErrGrantRevoked = errors.New("preview grant revoked")

// AuthorizeRequest is the body of the API's grant check.
type AuthorizeRequest struct {
	Ticket string `json:"ticket,omitempty"`
	Domain string `json:"domain,omitempty"`
}

// PublicPreviewAuthorizer checks explicit, durable public access to one port.
type PublicPreviewAuthorizer interface {
	AuthorizePublicPreview(context.Context, string) error
}

// APIAuthorizer asks the API (POST /internal/workspace-previews/authorize,
// bearer relay token) to recheck the viewer's user, repository and workspace
// access for a session ticket.
type APIAuthorizer struct {
	URL        string
	RelayToken string
	HTTPClient *http.Client
}

func (a *APIAuthorizer) AuthorizeGrant(ctx context.Context, ticket string) error {
	return a.authorize(ctx, AuthorizeRequest{Ticket: ticket})
}
func (a *APIAuthorizer) AuthorizePublicPreview(ctx context.Context, domain string) error {
	return a.authorize(ctx, AuthorizeRequest{Domain: domain})
}
func (a *APIAuthorizer) authorize(ctx context.Context, grant AuthorizeRequest) error {
	body, err := json.Marshal(grant)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, a.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+a.RelayToken)
	client := a.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("authorize preview grant: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	switch response.StatusCode {
	case http.StatusNoContent, http.StatusOK:
		return nil
	case http.StatusForbidden, http.StatusNotFound, http.StatusGone:
		return ErrGrantRevoked
	default:
		return fmt.Errorf("authorize preview grant: status %d", response.StatusCode)
	}
}
