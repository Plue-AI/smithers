package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type confirmationFixture struct {
	t             *testing.T
	pool          *pgxpool.Pool
	q             *db.Queries
	service       *ApprovalsService
	todos         *MythicalService
	repo          int64
	member        db.User
	person, agent context.Context
}

func newConfirmationFixture(t *testing.T) *confirmationFixture {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maya", LowerUsername: "maya"})
	require.NoError(t, err)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben", DisplayName: "Ben"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	f := &confirmationFixture{t: t, pool: pool, q: q, repo: repo.ID, member: member}
	f.exec(`INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	f.exec(`INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo.ID, member.ID)
	f.exec(`INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, owner.ID)
	binding := fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	f.person = f.session(member, "ben-session")
	f.agent = f.token("agent-one", "read:repository,write:repository,via:codex", true)
	f.todos = NewMythicalService(pool, nil)
	f.service = NewApprovalsService(q, WithConfirmationTodos(pool, f.todos))
	return f
}
func (f *confirmationFixture) exec(sql string, args ...any) {
	f.t.Helper()
	_, err := f.pool.Exec(f.t.Context(), sql, args...)
	require.NoError(f.t, err)
}
func (f *confirmationFixture) session(user db.User, key string) context.Context {
	f.t.Helper()
	sum := sha256.Sum256([]byte(key))
	hash := hex.EncodeToString(sum[:])
	_, err := f.q.CreateAuthSession(f.t.Context(), db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(f.t, err)
	return middleware.ContextWithAuthInfo(f.t.Context(), &middleware.AuthInfo{User: &user, SessionHash: hash})
}
func (f *confirmationFixture) token(key, scopes string, system bool) context.Context {
	f.t.Helper()
	sum := sha256.Sum256([]byte(key))
	hash := hex.EncodeToString(sum[:])
	_, err := f.q.CreateAccessToken(f.t.Context(), db.CreateAccessTokenParams{UserID: f.member.ID, Name: key, TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: scopes, SystemIssued: system, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(f.t, err)
	info, err := middleware.ReloadCredential(f.t.Context(), f.q, middleware.Credential{TokenHash: hash}, time.Now())
	require.NoError(f.t, err)
	require.True(f.t, middleware.BindInstallCredential(info))
	return middleware.ContextWithAuthInfo(f.t.Context(), info)
}
func confirmationNew(key string) ConfirmationInput {
	return ConfirmationInput{Command: "todo.new", Payload: json.RawMessage(`{"title":"Keep the greeting","prompt":"Keep the exact text.\nAnd the newline.","acceptance":["Greeting remains"]}`), Key: key}
}
func (f *confirmationFixture) request(input ConfirmationInput) ConfirmationReceipt {
	f.t.Helper()
	r, err := f.service.RequestConfirmation(f.agent, input)
	require.NoError(f.t, err)
	require.Equal(f.t, "pending", r.State)
	return r
}
func (f *confirmationFixture) count(table string) int {
	f.t.Helper()
	var n int
	require.NoError(f.t, f.pool.QueryRow(f.t.Context(), "SELECT count(*) FROM "+table).Scan(&n))
	return n
}
func (f *confirmationFixture) state(id string) string {
	f.t.Helper()
	var state string
	require.NoError(f.t, f.pool.QueryRow(f.t.Context(), `SELECT state FROM approvals WHERE id=$1`, id).Scan(&state))
	return state
}
func requireConfirmationCode(t *testing.T, err error, code string) {
	t.Helper()
	require.Error(t, err)
	var access *AccessError
	if errors.As(err, &access) {
		require.Equal(t, code, access.Code)
		return
	}
	var control *TodoControlError
	require.ErrorAs(t, err, &control)
	require.Equal(t, code, control.Code)
}

func TestConfirmationCreatePressReplayPostgres(t *testing.T) {
	f := newConfirmationFixture(t)
	r := f.request(confirmationNew("create-1"))
	require.Equal(t, 0, f.count("mythical_items"))
	require.Equal(t, 1, f.count("approvals"))
	var card struct {
		Input MythicalTodoInput `json:"input"`
		Card  struct {
			AskedBy map[string]any `json:"asked_by"`
			Text    string         `json:"text"`
		} `json:"card"`
	}
	var raw []byte
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT payload FROM approvals WHERE id=$1`, r.ID).Scan(&raw))
	require.NoError(t, json.Unmarshal(raw, &card))
	require.Equal(t, "Keep the exact text.\nAnd the newline.", card.Card.Text)
	require.Equal(t, "codex", card.Card.AskedBy["agent"])
	require.Equal(t, "ben", card.Card.AskedBy["for_member"].(map[string]any)["login"])
	replay, err := f.service.RequestConfirmation(f.agent, confirmationNew("create-1"))
	require.NoError(t, err)
	require.Equal(t, r, replay)
	changed := confirmationNew("create-1")
	changed.Payload = json.RawMessage(`{"title":"Other","prompt":"Other"}`)
	_, err = f.service.RequestConfirmation(f.agent, changed)
	requireConfirmationCode(t, err, "idempotency_mismatch")
	_, err = f.service.DecideConfirmation(f.agent, r.ID, "approve", "press")
	requireConfirmationCode(t, err, "permission")
	// A finished app turn's token may disappear before the person sees the card.
	f.exec(`DELETE FROM access_tokens WHERE id=$1`, middleware.AuthInfoFromContext(f.agent).TokenID)
	_, err = f.service.RequestConfirmation(f.agent, confirmationNew("create-1"))
	requireConfirmationCode(t, err, "unauthenticated")
	approved, err := f.service.DecideConfirmation(f.person, r.ID, "approve", "press")
	require.NoError(t, err)
	require.Equal(t, ConfirmationReceipt{ID: r.ID, State: "approved"}, approved)
	repeated, err := f.service.DecideConfirmation(f.person, r.ID, "approve", "press")
	require.NoError(t, err)
	require.Equal(t, approved, repeated)
	require.Equal(t, 1, f.count("mythical_items"))
	_, err = f.service.DecideConfirmation(f.person, r.ID, "deny", "press")
	requireConfirmationCode(t, err, "idempotency_mismatch")
	_, err = f.service.DecideConfirmation(f.person, r.ID, "approve", "different-press")
	requireConfirmationCode(t, err, "confirmation_resolved")
	var author string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT revisions->0->'by'->>'login' FROM mythical_items`).Scan(&author))
	require.Equal(t, "ben", author)
	rows, err := f.q.ListMemberConfirmations(t.Context(), f.member.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	var projection struct {
		Effect struct {
			Todo    int64  `json:"todo"`
			Request string `json:"request"`
		} `json:"effect"`
		Card struct {
			Receipt struct {
				By struct {
					Login string `json:"login"`
				} `json:"by"`
				Text   string `json:"text"`
				Result string `json:"result"`
				At     string `json:"at"`
			} `json:"receipt"`
		} `json:"card"`
	}
	require.NoError(t, json.Unmarshal(rows[0].Payload, &projection))
	require.Equal(t, int64(1), projection.Effect.Todo)
	require.Equal(t, "confirmation:"+r.ID, projection.Effect.Request)
	require.Equal(t, "ben", projection.Card.Receipt.By.Login)
	require.Equal(t, "Approved", projection.Card.Receipt.Text)
	require.Equal(t, "done", projection.Card.Receipt.Result)
	_, err = time.Parse(time.RFC3339Nano, projection.Card.Receipt.At)
	require.NoError(t, err)
}

func TestConfirmationConcurrentCreateAndApprovePostgres(t *testing.T) {
	f := newConfirmationFixture(t)
	const n = 6
	var wg sync.WaitGroup
	receipts := make([]ConfirmationReceipt, n)
	errs := make([]error, n)
	for i := range n {
		wg.Go(func() { receipts[i], errs[i] = f.service.RequestConfirmation(f.agent, confirmationNew("one")) })
	}
	wg.Wait()
	for i := range n {
		require.NoError(t, errs[i])
		require.Equal(t, receipts[0], receipts[i])
	}
	require.Equal(t, 1, f.count("approvals"))
	id := receipts[0].ID
	for i := range n {
		wg.Go(func() { receipts[i], errs[i] = f.service.DecideConfirmation(f.person, id, "approve", "one-press") })
	}
	wg.Wait()
	for i := range n {
		require.NoError(t, errs[i])
		require.Equal(t, ConfirmationReceipt{ID: id, State: "approved"}, receipts[i])
	}
	require.Equal(t, 1, f.count("mythical_items"))
}

func TestConfirmationFailureRollsBackEffectPostgres(t *testing.T) {
	f := newConfirmationFixture(t)
	r := f.request(confirmationNew("create"))
	// Fail after FileTodo's nested savepoint succeeds, at the approval CAS.
	f.exec(`CREATE FUNCTION reject_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='approved' THEN RAISE EXCEPTION 'forced approval failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER reject_approval BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION reject_approval()`)
	_, err := f.service.DecideConfirmation(f.person, r.ID, "approve", "press")
	require.ErrorContains(t, err, "forced approval failure")
	require.Equal(t, 0, f.count("mythical_items"))
	require.Equal(t, "pending", f.state(r.ID))
	var facts int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.created'`).Scan(&facts))
	require.Zero(t, facts)
	f.exec(`DROP TRIGGER reject_approval ON approvals`)
	_, err = f.service.DecideConfirmation(f.person, r.ID, "approve", "press")
	require.NoError(t, err)
	require.Equal(t, 1, f.count("mythical_items"))
}

func TestConfirmationScopeAndConsumerRefusalsPostgres(t *testing.T) {
	f := newConfirmationFixture(t)
	for _, tc := range []struct{ name, scopes string }{
		{"readonly", "read:repository,via:codex"},
		{"branch", "read:repository,write:repository,via:codex,branch:work"},
		{"path", "read:repository,write:repository,via:codex," + strings.Join(middleware.PathRestrictionScopes([]string{"src/**"}), ",")},
		{"wrong repo", "read:repository,write:repository,via:codex,repo:999999"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := f.token(tc.name, tc.scopes, true)
			_, err := f.service.RequestConfirmation(ctx, confirmationNew(tc.name))
			requireConfirmationCode(t, err, "permission")
		})
	}
	_, err := f.service.RequestConfirmation(f.person, confirmationNew("person"))
	requireConfirmationCode(t, err, "permission")
	for _, command := range []string{"stack.move", "merge", "settings.update", "unknown"} {
		input := confirmationNew(command)
		input.Command = command
		_, err = f.service.RequestConfirmation(f.agent, input)
		require.Error(t, err)
	}
	require.Equal(t, 0, f.count("approvals"))
	require.Equal(t, 0, f.count("mythical_items"))
	f.service.confirmationTodos = nil
	_, err = f.service.RequestConfirmation(f.agent, confirmationNew("missing"))
	requireConfirmationCode(t, err, "confirmation_unavailable")
	f.service.confirmationTodos = f.todos
	r := f.request(confirmationNew("ready"))
	f.service.confirmationTodos = nil
	_, err = f.service.DecideConfirmation(f.person, r.ID, "approve", "press")
	requireConfirmationCode(t, err, "confirmation_unavailable")
	require.Equal(t, "pending", f.state(r.ID))
	denied, err := f.service.DecideConfirmation(f.person, r.ID, "deny", "cancel")
	require.NoError(t, err)
	require.Equal(t, "rejected", denied.State)
	_, err = f.service.DecideConfirmation(f.person, r.ID, "deny", "cancel")
	require.NoError(t, err)
	require.Equal(t, 0, f.count("mythical_items"))
}

func TestConfirmationCredentialIsolationAndRevocationPostgres(t *testing.T) {
	f := newConfirmationFixture(t)
	r := f.request(confirmationNew("same-key"))
	// Legacy install PATs follow the same live credential reload and policy.
	second := f.token("second", "read:repository,write:repository", false)
	other, err := f.service.RequestConfirmation(second, confirmationNew("same-key"))
	require.NoError(t, err)
	require.NotEqual(t, r.ID, other.ID)
	stranger, err := f.q.CreateUser(t.Context(), db.CreateUserParams{Username: "alice", LowerUsername: "alice"})
	require.NoError(t, err)
	f.exec(`INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, f.repo, stranger.ID)
	_, err = f.service.DecideConfirmation(f.session(stranger, "alice"), r.ID, "approve", "press")
	requireConfirmationCode(t, err, "permission")
	f.exec(`UPDATE collaborators SET permission='read' WHERE user_id=$1`, f.member.ID)
	_, err = f.service.DecideConfirmation(f.person, r.ID, "approve", "press")
	requireConfirmationCode(t, err, "unauthenticated")
	f.exec(`UPDATE collaborators SET permission='write' WHERE user_id=$1`, f.member.ID)
	f.exec(`DELETE FROM auth_sessions WHERE session_key=$1`, middleware.AuthInfoFromContext(f.person).SessionHash)
	_, err = f.service.DecideConfirmation(f.person, r.ID, "approve", "press")
	requireConfirmationCode(t, err, "unauthenticated")
	require.Equal(t, "pending", f.state(r.ID))
	require.Equal(t, 0, f.count("mythical_items"))
}

func TestConfirmationExpiryAndSubjectChangePostgres(t *testing.T) {
	f := newConfirmationFixture(t)
	r := f.request(confirmationNew("expired"))
	f.exec(`UPDATE approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, r.ID)
	_, err := f.service.DecideConfirmation(f.person, r.ID, "approve", "press")
	requireConfirmationCode(t, err, "confirmation_resolved")
	require.Equal(t, "expired", f.state(r.ID))
	created, err := f.todos.FileTodo(f.person, f.repo, f.member.ID, MythicalTodoInput{Title: "Drop me", Prompt: "Only this revision", Request: "seed"})
	require.NoError(t, err)
	var n int64
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT number FROM mythical_items WHERE id=$1`, created.ID).Scan(&n))
	input := ConfirmationInput{Command: "todo.drop", Subject: json.RawMessage(fmt.Sprintf(`{"kind":"todo","ref":"T%d"}`, n)), Payload: json.RawMessage(`{"op":"drop"}`), Key: "drop-stale"}
	stale := f.request(input)
	f.exec(`UPDATE mythical_items SET version=version+1 WHERE id=$1`, created.ID)
	_, err = f.service.DecideConfirmation(f.person, stale.ID, "approve", "stale-press")
	requireConfirmationCode(t, err, "confirmation_resolved")
	require.Equal(t, "expired", f.state(stale.ID))
	input.Key = "drop-current"
	current := f.request(input)
	_, err = f.service.DecideConfirmation(f.person, current.ID, "approve", "drop-press")
	require.NoError(t, err)
	var state string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT state FROM mythical_items WHERE id=$1`, created.ID).Scan(&state))
	require.Equal(t, "cancelled", state)
	replay, err := f.service.RequestConfirmation(f.agent, input)
	require.NoError(t, err)
	require.Equal(t, "approved", replay.State)
}

func TestConfirmationMalformedRequestsPostgres(t *testing.T) {
	f := newConfirmationFixture(t)
	for _, payload := range []string{`null`, `{}`, `{"title":"a","prompt":"b","extra":true}`, `{"title":"a","prompt":"b"} {}`, `{"title":"a","prompt":"b","place":{"mode":"append","n":1}}`, "{"} {
		input := confirmationNew("bad")
		input.Payload = json.RawMessage(payload)
		_, err := f.service.RequestConfirmation(f.agent, input)
		require.Error(t, err, payload)
	}
	for _, key := range []string{"", strings.Repeat("k", 257)} {
		input := confirmationNew(key)
		_, err := f.service.RequestConfirmation(f.agent, input)
		requireConfirmationCode(t, err, "invalid_confirmation")
	}
	require.Equal(t, 0, f.count("approvals"))
	require.Equal(t, 0, f.count("mythical_items"))
}

func TestConfirmationQueuedPressReloadsAuthorityPostgres(t *testing.T) {
	for _, change := range []string{"revoke", "downgrade", "expire", "cancel"} {
		t.Run(change, func(t *testing.T) {
			f := newConfirmationFixture(t)
			r := f.request(confirmationNew("new"))
			lock, err := f.pool.Begin(t.Context())
			require.NoError(t, err)
			defer lock.Rollback(t.Context())
			_, err = lock.Exec(t.Context(), `SELECT pg_advisory_xact_lock($1)`, f.repo)
			require.NoError(t, err)
			ctx, cancel := context.WithCancel(f.person)
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := f.service.DecideConfirmation(ctx, r.ID, "approve", "press"); done <- err }()
			require.Eventually(t, func() bool {
				var n int
				err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT pg_advisory_xact_lock($1)'`).Scan(&n)
				return err == nil && n == 1
			}, 5*time.Second, 10*time.Millisecond)
			code := ""
			switch change {
			case "revoke":
				f.exec(`DELETE FROM auth_sessions WHERE session_key=$1`, middleware.AuthInfoFromContext(f.person).SessionHash)
				code = "unauthenticated"
			case "downgrade":
				f.exec(`UPDATE collaborators SET permission='read' WHERE user_id=$1`, f.member.ID)
				// Losing the roster's required write access kills the credential.
				code = "unauthenticated"
			case "expire":
				f.exec(`UPDATE approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, r.ID)
				code = "confirmation_resolved"
			case "cancel":
				cancel()
			}
			require.NoError(t, lock.Commit(t.Context()))
			select {
			case err := <-done:
				if change == "cancel" {
					require.ErrorIs(t, err, context.Canceled)
				} else {
					requireConfirmationCode(t, err, code)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("approval did not finish")
			}
			want := "pending"
			if change == "expire" {
				want = "expired"
			}
			require.Equal(t, want, f.state(r.ID))
			require.Equal(t, 0, f.count("mythical_items"))
		})
	}
}

func TestConfirmationPressKeyCannotApproveAnotherSubjectPostgres(t *testing.T) {
	f := newConfirmationFixture(t)
	first := f.request(confirmationNew("first"))
	second := f.request(confirmationNew("second"))
	_, err := f.service.DecideConfirmation(f.person, first.ID, "approve", "one-press")
	require.NoError(t, err)
	_, err = f.service.DecideConfirmation(f.person, second.ID, "approve", "one-press")
	requireConfirmationCode(t, err, "idempotency_mismatch")
	require.Equal(t, "pending", f.state(second.ID))
	require.Equal(t, 1, f.count("mythical_items"))
}

func TestConfirmationRosterRemovalDoesNotDeadlockPostgres(t *testing.T) {
	f := newConfirmationFixture(t)
	r := f.request(confirmationNew("request"))
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	roster, err := f.pool.Begin(ctx)
	require.NoError(t, err)
	defer roster.Rollback(t.Context())
	_, err = roster.Exec(ctx, `SELECT user_id FROM self_host_owners FOR UPDATE`)
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() { _, err := f.service.DecideConfirmation(f.person, r.ID, "approve", "press"); done <- err }()
	require.Eventually(t, func() bool {
		var n int
		err := f.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT 1 FROM self_host_owners WHERE singleton FOR SHARE'`).Scan(&n)
		return err == nil && n == 1
	}, 3*time.Second, 10*time.Millisecond)
	// This is the production removal's credential revocation inside its roster
	// transaction. Approval must not already hold a user/session lock it needs.
	require.NoError(t, revokeMemberCredentials(ctx, roster, f.repo, f.member.ID, f.member.ID))
	require.NoError(t, roster.Commit(ctx))
	select {
	case err := <-done:
		requireConfirmationCode(t, err, "unauthenticated")
	case <-ctx.Done():
		t.Fatal("member removal deadlocked with approval")
	}
	require.Equal(t, "pending", f.state(r.ID))
	require.Equal(t, 0, f.count("mythical_items"))
}

func TestConfirmationInstallBindingChangeWhileWaitingPostgres(t *testing.T) {
	f := newConfirmationFixture(t)
	other, err := f.q.CreateRepo(t.Context(), db.CreateRepoParams{UserID: pgtype.Int8{Int64: f.member.ID, Valid: true}, Name: "other", LowerName: "other", DefaultBookmark: "main"})
	require.NoError(t, err)
	lock, err := f.pool.Begin(t.Context())
	require.NoError(t, err)
	defer lock.Rollback(t.Context())
	_, err = lock.Exec(t.Context(), `SELECT pg_advisory_xact_lock($1)`, f.repo)
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() {
		_, err := f.service.RequestConfirmation(f.agent, confirmationNew("moving-install"))
		done <- err
	}()
	require.Eventually(t, func() bool {
		var n int
		err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT pg_advisory_xact_lock($1)'`).Scan(&n)
		return err == nil && n == 1
	}, 3*time.Second, 10*time.Millisecond)
	binding := fmt.Sprintf(`{"owner_login":"ben","repository_name":"other","repository_id":%d}`, other.ID)
	require.NoError(t, f.q.UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, lock.Commit(t.Context()))
	select {
	case err := <-done:
		requireConfirmationCode(t, err, "confirmation_resolved")
	case <-time.After(3 * time.Second):
		t.Fatal("request did not finish")
	}
	require.Equal(t, 0, f.count("approvals"))
	require.Equal(t, 0, f.count("mythical_items"))
}

func TestConfirmationAmendUnavailableAndMalformedPostgres(t *testing.T) {
	f := newConfirmationFixture(t)
	created, err := f.todos.FileTodo(f.person, f.repo, f.member.ID, MythicalTodoInput{Title: "Amend me", Prompt: "Original", Request: "seed-amend"})
	require.NoError(t, err)
	input := ConfirmationInput{Command: "todo.amend", Subject: json.RawMessage(fmt.Sprintf(`{"kind":"todo","ref":"T%d"}`, created.Number)), Payload: json.RawMessage(`{"prompt":"Revised","acceptance":["Keep cancel"]}`), Key: "unavailable-amend"}
	_, err = f.service.RequestConfirmation(f.agent, input)
	requireConfirmationCode(t, err, "confirmation_unavailable")
	for _, raw := range []string{`{}`, `null`, `{"prompt":" "}`, `{"prompt":"Revised","actor":1}`, `{"prompt":"Revised","acceptance":"check"}`} {
		input.Payload = json.RawMessage(raw)
		_, err = f.service.RequestConfirmation(f.agent, input)
		require.Error(t, err, raw)
	}
	require.Equal(t, 0, f.count("approvals"))
	var revisions []byte
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT revisions FROM mythical_items WHERE id=$1`, created.ID).Scan(&revisions))
	var entries []any
	require.NoError(t, json.Unmarshal(revisions, &entries))
	require.Len(t, entries, 1)
}

func TestConfirmationCancelUnavailableConsumerPostgres(t *testing.T) {
	f := newConfirmationFixture(t)
	r := f.request(confirmationNew("cancel-unavailable"))
	// The service remains composed, but the original command consumer has
	// disappeared. Cancellation must never invoke that command.
	f.exec(`UPDATE mythical_stacks SET state='frozen' WHERE repository_id=$1`, f.repo)
	_, err := f.service.DecideConfirmation(f.person, r.ID, "approve", "approve")
	requireConfirmationCode(t, err, "confirmation_unavailable")
	require.Equal(t, "pending", f.state(r.ID))
	for range 2 {
		receipt, err := f.service.DecideConfirmation(f.person, r.ID, "deny", "cancel")
		require.NoError(t, err)
		require.Equal(t, "rejected", receipt.State)
	}
	require.Zero(t, f.count("mythical_items"))
}

func newMergeConfirmation(t *testing.T) (*mergeHarness, *ApprovalsService, context.Context, ConfirmationInput, int64) {
	h := newMergeHarness(t)
	n, head, _ := h.first("Confirm one merge")
	sum := sha256.Sum256([]byte("confirmation-merge-agent"))
	hash := hex.EncodeToString(sum[:])
	_, err := h.q.CreateAccessToken(h.ctx, db.CreateAccessTokenParams{UserID: h.userID, Name: "agent", TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: "read:repository,write:repository,via:codex", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	info, err := middleware.ReloadCredential(h.ctx, h.q, middleware.Credential{TokenHash: hash}, time.Now())
	require.NoError(t, err)
	require.True(t, middleware.BindInstallCredential(info))
	agent := middleware.ContextWithAuthInfo(t.Context(), info)
	service := NewApprovalsService(h.q, WithConfirmationTodos(h.pool, h.service))
	input := ConfirmationInput{Command: "merge", Subject: json.RawMessage(fmt.Sprintf(`{"kind":"todo","ref":"T%d"}`, n)), Payload: json.RawMessage(fmt.Sprintf(`{"reviewed_head_sha":%q}`, head)), Key: "request-merge"}
	return h, service, agent, input, n
}

func TestConfirmationMergeConfirmedOnlyPostgres(t *testing.T) {
	h, service, agent, input, n := newMergeConfirmation(t)
	_ = n
	row, err := service.RequestConfirmation(agent, input)
	require.NoError(t, err)
	require.Equal(t, "pending", row.State)
	require.Empty(t, h.merges())
	_, err = service.DecideConfirmation(agent, row.ID, "approve", "bad")
	requireConfirmationCode(t, err, "permission")
	h.fake.HoldMain()
	receipt, err := service.DecideConfirmation(h.ctx, row.ID, "approve", "person-press")
	require.NoError(t, err)
	require.Equal(t, "pending", receipt.State)
	require.Empty(t, h.merges())
	receipt, err = service.DecideConfirmation(h.ctx, row.ID, "approve", "person-press")
	require.NoError(t, err)
	require.Equal(t, "pending", receipt.State)
	_, err = service.DecideConfirmation(h.ctx, row.ID, "deny", "cancel-in-flight")
	requireConfirmationCode(t, err, "merging")
	rows, err := h.q.ListMemberConfirmations(h.ctx, h.userID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, "pending", rows[0].State)
	h.pass()
	require.Len(t, h.merges(), 1)
	rows, err = h.q.ListMemberConfirmations(h.ctx, h.userID)
	require.NoError(t, err)
	require.Equal(t, "pending", rows[0].State)
	h.fake.ReleaseMain()
	h.pass()
	rows, err = h.q.ListMemberConfirmations(h.ctx, h.userID)
	require.NoError(t, err)
	require.Equal(t, "approved", rows[0].State)
	require.Contains(t, string(rows[0].Payload), `"text": "Merged"`)
	receipt, err = service.DecideConfirmation(h.ctx, row.ID, "approve", "person-press")
	require.NoError(t, err)
	require.Equal(t, "approved", receipt.State)
	h.pass()
	require.Len(t, h.merges(), 1)
}

func TestConfirmationMergeRefusalRetryPostgres(t *testing.T) {
	h, service, agent, input, n := newMergeConfirmation(t)
	row, err := service.RequestConfirmation(agent, input)
	require.NoError(t, err)
	_, err = service.DecideConfirmation(h.ctx, row.ID, "approve", "first-press")
	require.NoError(t, err)
	pr := h.item(n).PRNumber.Int64
	h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.MergeableState = "blocked" })
	h.pass()
	rows, err := h.q.ListMemberConfirmations(h.ctx, h.userID)
	require.NoError(t, err)
	require.Equal(t, "pending", rows[0].State)
	require.NotContains(t, string(rows[0].Payload), `"effect"`)
	require.Contains(t, string(rows[0].Payload), `"merge_attempt": 1`)
	_, err = service.DecideConfirmation(h.ctx, row.ID, "approve", "first-press")
	requireConfirmationCode(t, err, "github")
	h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.MergeableState = "clean" })
	_, err = service.DecideConfirmation(h.ctx, row.ID, "approve", "second-press")
	require.NoError(t, err)
	_, err = service.DecideConfirmation(h.ctx, row.ID, "approve", "first-press")
	requireConfirmationCode(t, err, "github")
	h.pass()
	rows, err = h.q.ListMemberConfirmations(h.ctx, h.userID)
	require.NoError(t, err)
	require.Equal(t, "approved", rows[0].State)
	require.Len(t, h.merges(), 1)
}

func TestConfirmationMergeGenerationAndRollbackPostgres(t *testing.T) {
	for _, change := range []string{"generation", "remote-head", "approval-write"} {
		t.Run(change, func(t *testing.T) {
			h, service, agent, input, n := newMergeConfirmation(t)
			row, err := service.RequestConfirmation(agent, input)
			require.NoError(t, err)
			if change == "generation" {
				h.exec(`UPDATE mythical_items SET generation=generation+1 WHERE repository_id=$1 AND number=$2`, h.repoID, n)
			} else if change == "remote-head" {
				h.push(n, "Moved after review")
			} else {
				h.exec(`CREATE FUNCTION fail_merge_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.decision_key IS NOT NULL THEN RAISE EXCEPTION 'fail approval write'; END IF; RETURN NEW; END $$`)
				h.exec(`CREATE TRIGGER fail_merge_confirmation BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION fail_merge_confirmation()`)
			}
			_, err = service.DecideConfirmation(h.ctx, row.ID, "approve", "press")
			require.Error(t, err)
			require.Empty(t, h.merges())
			require.Empty(t, h.item(n).PendingOp)
			saved, err := h.q.GetMemberConfirmation(h.ctx, row.ID, h.userID)
			require.NoError(t, err)
			if change != "approval-write" {
				require.Equal(t, "expired", saved.State)
			} else {
				require.Equal(t, "pending", saved.State)
				h.exec(`DROP TRIGGER fail_merge_confirmation ON approvals`)
				_, err = service.DecideConfirmation(h.ctx, row.ID, "approve", "press")
				require.NoError(t, err)
			}
		})
	}
}

func TestConfirmationMergeRefreshChecksAndGenerationPostgres(t *testing.T) {
	h, service, agent, input, n := newMergeConfirmation(t)
	var request MythicalMergeInput
	require.NoError(t, json.Unmarshal(input.Payload, &request))
	h.fake.RequireCheck("unit")
	h.fake.SetCheck("rehearsal-owner/app", request.Head, "unit", "in_progress", "")
	h.fake.SetCheck("rehearsal-owner/app", request.Head, "lint", "completed", "failure")
	row, err := service.RequestConfirmation(agent, input)
	require.NoError(t, err)
	_, err = service.DecideConfirmation(h.ctx, row.ID, "approve", "blocked-press")
	requireConfirmationCode(t, err, "checks")
	require.Empty(t, h.item(n).PendingOp)
	require.Empty(t, h.merges())
	rows, err := h.q.ListMemberConfirmations(h.ctx, h.userID)
	require.NoError(t, err)
	require.Contains(t, string(rows[0].Payload), `"state": "pending"`)
	h.fake.SetCheck("rehearsal-owner/app", request.Head, "unit", "completed", "success")
	require.NoError(t, service.RefreshConfirmationCards(h.ctx, h.userID, rows))
	rows, err = h.q.ListMemberConfirmations(h.ctx, h.userID)
	require.NoError(t, err)
	var saved struct {
		Card struct {
			AskedBy map[string]any `json:"asked_by"`
			Review  struct {
				Merge struct {
					State string `json:"state"`
				} `json:"merge"`
				Evidence struct {
					Items []map[string]any `json:"items"`
				} `json:"evidence"`
			} `json:"review"`
		} `json:"card"`
	}
	require.NoError(t, json.Unmarshal(rows[0].Payload, &saved))
	require.Equal(t, "ready", saved.Card.Review.Merge.State)
	require.Contains(t, saved.Card.Review.Evidence.Items, map[string]any{"kind": "github_check", "name": "lint", "required": false, "state": "failed", "url": fmt.Sprintf("https://github.com/rehearsal-owner/app/pull/%d/checks", h.item(n).PRNumber.Int64)})
	require.Equal(t, "agent", saved.Card.AskedBy["kind"])
	h.exec(`UPDATE mythical_items SET generation=generation+1 WHERE id=$1`, h.item(n).ID)
	require.NoError(t, service.RefreshConfirmationCards(h.ctx, h.userID, rows))
	savedRow, err := h.q.GetMemberConfirmation(h.ctx, row.ID, h.userID)
	require.NoError(t, err)
	require.Equal(t, "expired", savedRow.State)
	require.Empty(t, h.merges())
}

func TestConfirmationMergeGitHubRefusalPostgres(t *testing.T) {
	h, service, agent, input, n := newMergeConfirmation(t)
	row, err := service.RequestConfirmation(agent, input)
	require.NoError(t, err)
	h.fake.RefuseNextMerge("rehearsal-owner/app", h.item(n).PRNumber.Int64, githubfake.Refusal{Status: 405, Message: "Base changed; review again"})
	_, err = service.DecideConfirmation(h.ctx, row.ID, "approve", "refused-press")
	require.NoError(t, err)
	h.pass()
	require.Len(t, h.merges(), 1)
	require.Equal(t, 405, h.merges()[0].Status)
	rows, err := h.q.ListMemberConfirmations(h.ctx, h.userID)
	require.NoError(t, err)
	require.Equal(t, "pending", rows[0].State)
	require.Contains(t, string(rows[0].Payload), "Base changed; review again")
	require.NotContains(t, string(rows[0].Payload), `"effect"`)
	_, err = service.DecideConfirmation(h.ctx, row.ID, "approve", "refused-press")
	requireConfirmationCode(t, err, "github_refused")
	h.pass()
	require.Len(t, h.merges(), 1)
	_, err = service.DecideConfirmation(h.ctx, row.ID, "approve", "fresh-person-press")
	require.NoError(t, err)
	h.pass()
	require.Len(t, h.merges(), 2)
	rows, err = h.q.ListMemberConfirmations(h.ctx, h.userID)
	require.NoError(t, err)
	require.Equal(t, "approved", rows[0].State)
	_, err = service.DecideConfirmation(h.ctx, row.ID, "approve", "refused-press")
	requireConfirmationCode(t, err, "github_refused")
}

func TestBoundInstallCredentialReloadPostgres(t *testing.T) {
	for _, scenario := range []string{"same grant", "replaced credential", "wrong principal", "removed member", "revoked session", "changed scopes", "changed role", "role downgrade"} {
		t.Run(scenario, func(t *testing.T) {
			f := newConfirmationFixture(t)
			ctx := f.person
			if scenario == "role downgrade" {
				f.exec(`UPDATE collaborators SET permission='admin' WHERE repository_id=$1 AND user_id=$2`, f.repo, f.member.ID)
			}
			if scenario == "changed scopes" {
				ctx = f.token("reload", "read:repository,write:repository,via:codex", true)
			}
			command := "todo.read"
			decision, err := Authorize(ctx, f.q, command)
			require.NoError(t, err)
			subject := InstallSubject{RepositoryID: f.repo}
			if scenario == "wrong principal" {
				decision.UserID++
			}
			ctx = WithInstallAuthorization(ctx, command, decision, subject)
			info := middleware.AuthInfoFromContext(ctx)
			switch scenario {
			case "replaced credential":
				copy := *info
				ctx = middleware.ContextWithAuthInfo(ctx, &copy)
				info = &copy
			case "removed member":
				f.exec(`DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, f.repo, f.member.ID)
			case "revoked session":
				f.exec(`DELETE FROM auth_sessions WHERE session_key=$1`, info.SessionHash)
			case "changed role":
				f.exec(`UPDATE collaborators SET permission='admin' WHERE repository_id=$1 AND user_id=$2`, f.repo, f.member.ID)
			case "role downgrade":
				f.exec(`UPDATE collaborators SET permission='write' WHERE repository_id=$1 AND user_id=$2`, f.repo, f.member.ID)
			case "changed scopes":
				f.exec(`UPDATE access_tokens SET scopes='read:repository,via:codex' WHERE id=$1`, info.TokenID)
			}
			tx, err := f.pool.Begin(t.Context())
			require.NoError(t, err)
			defer tx.Rollback(t.Context())
			fresh, repository, err := lockInstallWriteCredential(ctx, tx, info)
			if scenario != "same grant" && scenario != "changed role" && scenario != "role downgrade" {
				require.Error(t, err)
				if scenario == "removed member" {
					var refusal *AccessError
					require.ErrorAs(t, err, &refusal)
					require.Equal(t, 401, refusal.Status)
					require.Equal(t, "unauthenticated", refusal.Code)
				}
				return
			}
			require.NoError(t, err)
			require.Equal(t, f.repo, repository)
			require.NotSame(t, info, middleware.AuthInfoFromContext(fresh))
			got, err := Authorize(fresh, nil, command, subject)
			require.NoError(t, err)
			require.Equal(t, decision, got)
			_, err = Authorize(fresh, nil, "todo.new", subject)
			require.Error(t, err)
			subject.RepositoryID++
			_, err = Authorize(fresh, nil, command, subject)
			require.Error(t, err)
		})
	}
}
