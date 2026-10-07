package services

import (
	"context"
	"encoding/base64"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

const fastGatewayClientID = "smithers_fast_model_installs"

var ErrFastSignIn = errors.New("fast-model sign-in refused")

// FastGatewaySignIn uses the existing OAuth grant store, PKCE verifier and
// atomic consume query. Its grants issue install credentials, never user tokens.
type FastGatewaySignIn struct {
	Pool  *pgxpool.Pool
	Quota credits.FastQuota
}
type FastGatewayAuthorize struct{ Install, Redirect, Challenge, Method, State string }

func ValidateFastGatewayAuthorize(in FastGatewayAuthorize) error {
	if _, err := uuid.Parse(in.Install); err != nil {
		return ErrFastSignIn
	}
	u, err := url.Parse(in.Redirect)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "/api/model/fast/return" || u.RawQuery != "" || u.Fragment != "" || len(in.Redirect) > 4096 {
		return ErrFastSignIn
	}
	challenge, err := base64.RawURLEncoding.DecodeString(in.Challenge)
	if err != nil || len(challenge) != 32 || in.Method != "S256" || in.State == "" || len(in.State) > 512 {
		return ErrFastSignIn
	}
	return nil
}
func (s FastGatewaySignIn) Authorize(ctx context.Context, owner int64, in FastGatewayAuthorize) (string, error) {
	if err := ValidateFastGatewayAuthorize(in); err != nil {
		return "", err
	}
	code := generateOAuth2Code()
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		// This fixed internal first-party client is never accepted by the ordinary
		// OAuth token endpoint, whose FirstPartyClientID guard remains unchanged.
		_, err := tx.Exec(ctx, `INSERT INTO oauth2_applications(client_id,client_secret_hash,name,redirect_uris,scopes,owner_id,confidential)
   VALUES($1,'','Smithers fast model','{}','{}',$2,false) ON CONFLICT(client_id) DO NOTHING`, fastGatewayClientID, owner)
		if err != nil {
			return err
		}
		q := db.New(tx)
		app, err := q.GetOAuth2ApplicationByClientID(ctx, fastGatewayClientID)
		if err != nil {
			return err
		}
		var permitted bool
		if err := tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM fast_model_installs WHERE install_id=$1 AND owner_id<>$2)`, in.Install, owner).Scan(&permitted); err != nil {
			return err
		}
		if !permitted {
			return ErrFastSignIn
		}
		return q.CreateOAuth2AuthorizationCode(ctx, db.CreateOAuth2AuthorizationCodeParams{CodeHash: hashOAuth2Secret(code), AppID: app.ID, UserID: owner, Scopes: []string{in.Install}, RedirectUri: in.Redirect, CodeChallenge: in.Challenge, CodeChallengeMethod: "S256", ExpiresAt: time.Now().Add(oauth2AuthCodeTTL)})
	})
	if err != nil {
		return "", err
	}
	return code, nil
}
func (s FastGatewaySignIn) Exchange(ctx context.Context, code, verifier, redirect string) (string, string, error) {
	if len(code) > 4096 || len(verifier) < 43 || len(verifier) > 128 {
		return "", "", ErrFastSignIn
	}
	q := db.New(s.Pool)
	app, err := q.GetOAuth2ApplicationByClientID(ctx, fastGatewayClientID)
	if err != nil {
		return "", "", ErrFastSignIn
	}
	grant, err := q.GetOAuth2AuthorizationCodeByHash(ctx, hashOAuth2Secret(code))
	if err != nil {
		return "", "", ErrFastSignIn
	}
	if grant.AppID != app.ID || grant.RedirectUri != redirect || len(grant.Scopes) != 1 || !verifyPKCE(grant.CodeChallenge, grant.CodeChallengeMethod, verifier) {
		return "", "", ErrFastSignIn
	}
	install := grant.Scopes[0]
	if _, err := uuid.Parse(install); err != nil {
		return "", "", ErrFastSignIn
	}
	user, err := q.GetUserByID(ctx, grant.UserID)
	if err != nil || !user.IsActive || user.ProhibitLogin || user.DeletedAt.Valid {
		return "", "", ErrFastSignIn
	}
	var credential string
	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if _, err := db.New(tx).ConsumeOAuth2AuthorizationCode(ctx, hashOAuth2Secret(code)); err != nil {
			return ErrFastSignIn
		}
		var err error
		credential, err = s.Quota.IssueInTransaction(ctx, tx, grant.UserID, install)
		return err
	})
	if err != nil {
		return "", "", err
	}
	return install, credential, nil
}

// FastGatewayAuthorizeFromValues is shared by the consent GET and POST.
func FastGatewayAuthorizeFromValues(v url.Values) FastGatewayAuthorize {
	return FastGatewayAuthorize{Install: strings.TrimSpace(v.Get("install_id")), Redirect: v.Get("redirect_uri"), Challenge: v.Get("code_challenge"), Method: v.Get("code_challenge_method"), State: v.Get("state")}
}
