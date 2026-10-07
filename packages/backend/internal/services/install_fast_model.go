package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
)

const FastModelCredentialKey = "models.smithers.credential"
const fastModelPendingKey = "models.smithers.pending"
const FastModelStatusKey = "models.smithers.status"
const FastModelDisclosure = "App prompts, preflight and summaries go to Smithers and Cerebras. Smithers keeps token counts only. Use your own key to bypass Smithers."

// FastModelStatus contains only public source and quota facts. The credential
// is a separate sealed setting, never a model binding or a catalog credential.
type FastModelStatus struct {
	SignedIn  bool                 `json:"signed_in"`
	Source    string               `json:"source"`
	Cause     modelproxy.FastCause `json:"cause,omitempty"`
	Remaining *int64               `json:"remaining,omitempty"`
	ResetAt   string               `json:"reset_at,omitempty"`
}

type InstallFastModelAccess struct {
	Pool    *pgxpool.Pool
	Codec   webhook.SecretCodec
	Gateway string
	Client  *http.Client
}

func (s InstallFastModelAccess) gateway() string {
	if s.Gateway != "" {
		return strings.TrimRight(s.Gateway, "/")
	}
	return "https://api.smithers.sh"
}
func (s InstallFastModelAccess) client() *http.Client {
	c := &http.Client{Timeout: 8 * time.Second}
	if s.Client != nil {
		*c = *s.Client
		c.Timeout = 8 * time.Second
	}
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return c
}
func (s InstallFastModelAccess) seal(ctx context.Context, key string, value any, owner int64) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	sealed, err := s.Codec.EncryptString(string(raw))
	if err != nil {
		return err
	}
	raw, _ = json.Marshal(sealed)
	_, err = s.Pool.Exec(ctx, `INSERT INTO install_settings(key,value,sealed,updated_by) VALUES($1,$2,true,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,sealed=true,updated_by=EXCLUDED.updated_by,updated_at=now()`, key, raw, owner)
	return err
}
func (s InstallFastModelAccess) Credential(ctx context.Context) (string, error) {
	var raw []byte
	err := s.Pool.QueryRow(ctx, `SELECT value FROM install_settings WHERE key=$1 AND sealed`, FastModelCredentialKey).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var sealed string
	if err = json.Unmarshal(raw, &sealed); err != nil {
		return "", err
	}
	plain, err := s.Codec.DecryptString(sealed)
	if err != nil {
		return "", err
	}
	var credential string
	err = json.Unmarshal([]byte(plain), &credential)
	return credential, err
}
func (s InstallFastModelAccess) Status(ctx context.Context) (FastModelStatus, error) {
	status := FastModelStatus{Source: "coding model"}
	fast, fastErr := db.New(s.Pool).EffectiveInstallAgentModel(ctx, "fast")
	coding, codingErr := db.New(s.Pool).EffectiveInstallAgentModel(ctx, "coding")
	if fastErr == nil && codingErr == nil && string(fast) != string(coding) {
		status.Source = "team key"
	}
	fallbackSource := status.Source
	var signed bool
	err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM install_settings WHERE key=$1 AND sealed)`, FastModelCredentialKey).Scan(&signed)
	if err != nil {
		return status, err
	}
	var raw []byte
	err = s.Pool.QueryRow(ctx, `SELECT value FROM install_settings WHERE key=$1 AND NOT sealed`, FastModelStatusKey).Scan(&raw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return status, err
	}
	if err == nil {
		if err = json.Unmarshal(raw, &status); err != nil {
			return status, err
		}
	}
	if !signed {
		return FastModelStatus{Source: fallbackSource}, nil
	}
	status.SignedIn = signed
	if signed && status.Cause == "" {
		status.Source = "Smithers"
	}
	return status, nil
}
func (s InstallFastModelAccess) Record(ctx context.Context, status FastModelStatus) error {
	raw, err := json.Marshal(status)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx, `INSERT INTO install_settings(key,value) SELECT $1,$2 FROM (SELECT key FROM install_settings WHERE key='models.smithers.credential' AND sealed FOR SHARE) active ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, FastModelStatusKey, raw)
	return err
}

type fastModelPending struct {
	State      string    `json:"state"`
	Verifier   string    `json:"verifier"`
	Redirect   string    `json:"redirect"`
	Owner      int64     `json:"owner"`
	Expires    time.Time `json:"expires"`
	Exchanging bool      `json:"exchanging"`
	Request    string    `json:"request"`
}

func FastModelBearer() (string, error) {
	var b [32]byte
	_, err := rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:]), err
}

// Begin stores a PKCE lease before returning the browser's sign-in URL.
func (s InstallFastModelAccess) Begin(ctx context.Context, owner int64, redirect string, requests ...string) (string, error) {
	state, err := FastModelBearer()
	if err != nil {
		return "", err
	}
	verifier, err := FastModelBearer()
	if err != nil {
		return "", err
	}
	pending := fastModelPending{State: state, Verifier: verifier, Redirect: redirect, Owner: owner, Expires: time.Now().Add(10 * time.Minute)}
	if len(requests) > 0 {
		pending.Request = requests[0]
		var raw []byte
		if s.Pool.QueryRow(ctx, `SELECT value FROM install_settings WHERE key=$1 AND sealed`, fastModelPendingKey).Scan(&raw) == nil {
			var sealed string
			var prior fastModelPending
			if json.Unmarshal(raw, &sealed) == nil {
				if plain, err := s.Codec.DecryptString(sealed); err == nil && json.Unmarshal([]byte(plain), &prior) == nil && prior.Owner == owner && prior.Request == pending.Request && !prior.Exchanging && time.Now().Before(prior.Expires) {
					pending = prior
					state = prior.State
					verifier = prior.Verifier
				}
			}
		}
	}
	if err = s.seal(ctx, fastModelPendingKey, pending, owner); err != nil {
		return "", err
	}
	challenge := sha256.Sum256([]byte(verifier))
	installID, err := s.InstallID(ctx)
	if err != nil {
		return "", err
	}
	query := url.Values{"install_id": {installID}, "state": {state}, "redirect_uri": {redirect}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}}
	return s.gateway() + "/api/fast-model/sign-in?" + query.Encode(), nil
}

// Complete consumes the state once before exchanging a code over host transport.
// An ambiguous exchange needs a fresh sign-in; it never retries an issuance.
func (s InstallFastModelAccess) Complete(ctx context.Context, owner int64, state, code string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT value FROM install_settings WHERE key=$1 AND sealed FOR UPDATE`, fastModelPendingKey).Scan(&raw)
	if err != nil {
		return errors.New("sign-in expired")
	}
	var sealed string
	var pending fastModelPending
	if json.Unmarshal(raw, &sealed) != nil {
		return errors.New("sign-in unavailable")
	}
	plain, err := s.Codec.DecryptString(sealed)
	if err != nil {
		return errors.New("sign-in unavailable")
	}
	if json.Unmarshal([]byte(plain), &pending) != nil || pending.Exchanging || pending.State != state || pending.Owner != owner || !time.Now().Before(pending.Expires) || code == "" || len(code) > 4096 {
		return errors.New("sign-in expired")
	}
	pending.Exchanging = true
	pendingRaw, _ := json.Marshal(pending)
	sealed, err = s.Codec.EncryptString(string(pendingRaw))
	if err != nil {
		return err
	}
	raw, _ = json.Marshal(sealed)
	if _, err = tx.Exec(ctx, `UPDATE install_settings SET value=$2 WHERE key=$1`, fastModelPendingKey, raw); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"code": code, "code_verifier": pending.Verifier, "redirect_uri": pending.Redirect})
	req, err := http.NewRequestWithContext(ctx, "POST", s.gateway()+"/api/fast-model/exchange", strings.NewReader(string(body)))
	if err != nil {
		return errors.New("sign-in unavailable")
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := s.client().Do(req)
	if err != nil {
		return errors.New("Smithers unreachable")
	}
	defer res.Body.Close()
	var result struct {
		Credential string `json:"credential"`
		Remaining  *int64 `json:"remaining"`
		ResetAt    string `json:"reset_at"`
	}
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 16<<10)).Decode(&result) != nil || result.Credential == "" || len(result.Credential) > 8192 || strings.ContainsAny(result.Credential, "\r\n\x00") {
		return errors.New("Smithers sign-in refused")
	}
	credentialRaw, _ := json.Marshal(result.Credential)
	encrypted, err := s.Codec.EncryptString(string(credentialRaw))
	if err != nil {
		return err
	}
	credentialRaw, _ = json.Marshal(encrypted)
	final, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer final.Rollback(context.WithoutCancel(ctx))
	var stillPending []byte
	if err = final.QueryRow(ctx, `SELECT value FROM install_settings WHERE key=$1 FOR UPDATE`, fastModelPendingKey).Scan(&stillPending); err != nil || string(stillPending) != string(raw) {
		return errors.New("sign-in cancelled")
	}
	if _, err = final.Exec(ctx, `INSERT INTO install_settings(key,value,sealed,updated_by) VALUES($1,$2,true,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,sealed=true,updated_by=EXCLUDED.updated_by,updated_at=now()`, FastModelCredentialKey, credentialRaw, owner); err != nil {
		return err
	}
	statusRaw, _ := json.Marshal(FastModelStatus{SignedIn: true, Source: "Smithers", Remaining: result.Remaining, ResetAt: result.ResetAt})
	if _, err = final.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, FastModelStatusKey, statusRaw); err != nil {
		return err
	}
	if _, err = final.Exec(ctx, `DELETE FROM install_settings WHERE key=$1`, fastModelPendingKey); err != nil {
		return err
	}
	return final.Commit(ctx)
}
func (s InstallFastModelAccess) SignOut(ctx context.Context) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	keys := []string{FastModelCredentialKey, fastModelPendingKey, FastModelStatusKey}
	rows, err := tx.Query(ctx, `SELECT key FROM install_settings WHERE key=ANY($1::text[]) ORDER BY key DESC FOR UPDATE`, keys)
	if err != nil {
		return err
	}
	for rows.Next() {
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `DELETE FROM install_settings WHERE key=ANY($1::text[])`, keys)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s InstallFastModelAccess) InferenceURL() string {
	return fmt.Sprintf("%s%s/v1/chat/completions", s.gateway(), modelproxy.FastGatewayPath)
}

// InstallID survives sign-out, so reconnecting retains the same gateway quota.
func (s InstallFastModelAccess) InstallID(ctx context.Context) (string, error) {
	raw, _ := json.Marshal(uuid.NewString())
	_, err := s.Pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('models.smithers.install_id',$1) ON CONFLICT(key) DO NOTHING`, raw)
	if err != nil {
		return "", err
	}
	err = s.Pool.QueryRow(ctx, `SELECT value#>>'{}' FROM install_settings WHERE key='models.smithers.install_id'`).Scan(&raw)
	return string(raw), err
}
