package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Literal C-SEC-03 label fixtures cross the install router, real roster,
// PostgreSQL and the production issue-events worker. Repository write access
// alone must never count as install membership.
func TestTodoTrustInstallLabelMatrix(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_TODO_LABEL_REHEARSAL", "C-SEC-03", "trust-")
	const repo = "rehearsal-owner/app"
	if !r.install("Install ready") {
		return
	}
	for i, member := range []struct{ login, permission string }{{"mia", "maintain"}, {"ben", "write"}, {"erin", "write"}, {"carol", "write"}} {
		r.fake.SetCollaborator(int64(208+i), member.login, member.permission)
		if member.login != "carol" {
			_, err := r.member(member.login, int64(208+i), member.permission)
			require.NoError(t, err)
		}
	}
	_, err := r.pool.Exec(r.ctx, `UPDATE collaborators SET suspended_at=now() WHERE github_login='erin'`)
	require.NoError(t, err)
	type fixture struct {
		name, text, actor string
		admitted          bool
		reason            string
		number            int64
	}
	var fixtures []fixture
	for _, text := range []string{"team", "outsider", "outsider-edit"} {
		for _, actor := range []struct {
			login          string
			team, outsider bool
			reason         string
		}{
			{"rehearsal-owner", true, true, ""}, {"mia", true, true, ""},
			{"ben", true, false, "Only a maintainer can make a TODO from this issue"},
			{"erin", false, false, "only members of this install can add `todo`"},
			{"carol", false, false, "only members of this install can add `todo`"},
			{"other-app[bot]", false, false, "only members of this install can add `todo`"},
		} {
			name := text + "/" + actor.login
			author := "ben"
			if text == "outsider" {
				author = "dana"
			}
			number := r.fake.OpenIssue(repo, author, name, "Frozen issue body")
			if text == "outsider-edit" {
				require.True(t, r.fake.EditIssue(repo, number, "carol", name, "Outsider edited body"))
			}
			r.fake.LabelIssue(repo, number, actor.login, "todo")
			admitted := actor.team
			if text != "team" {
				admitted = actor.outsider
			}
			fixtures = append(fixtures, fixture{name, text, actor.login, admitted, actor.reason, number})
		}
	}
	deadline := time.Now().Add(60 * time.Second)
	for {
		raw, err := r.expect("GET", "/api/todos", "", 200)
		require.NoError(t, err)
		var todos []struct {
			Issue *struct {
				Number int64 `json:"number"`
			} `json:"issue"`
		}
		require.NoError(t, json.Unmarshal(raw, &todos))
		counts := map[int64]int{}
		for _, todo := range todos {
			if todo.Issue != nil {
				counts[todo.Issue.Number]++
			}
		}
		var pending []string
		for _, f := range fixtures {
			view, ok := r.fake.Issue(repo, f.number)
			require.True(t, ok)
			if f.admitted {
				require.LessOrEqual(t, counts[f.number], 1, f.name)
				if counts[f.number] != 1 {
					pending = append(pending, f.name)
				}
			} else {
				require.Zero(t, counts[f.number], f.name)
				if containsTodoLabel(view.Labels) || len(view.Comments) == 0 {
					pending = append(pending, f.name)
					continue
				}
				require.Len(t, view.Comments, 1, f.name)
				require.Contains(t, view.Comments[0].Body, f.reason, f.name)
			}
		}
		if len(pending) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("unsettled trust fixtures: %s", strings.Join(pending, ", "))
		}
		time.Sleep(100 * time.Millisecond)
	}
	// The CLI's delegated read binds the same immutable snapshot to its member.
	// It is not a browser session and must still receive a commit-capable digest.
	var ownerID int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT user_id FROM self_host_owners`).Scan(&ownerID))
	token := "smithers_" + strings.Repeat("a", 40)
	hash := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hash[:])
	_, err = db.New(r.pool).CreateAccessToken(r.ctx, db.CreateAccessTokenParams{UserID: ownerID, Name: "trust-cli", TokenHash: tokenHash, TokenLastEight: tokenHash[len(tokenHash)-8:], Scopes: "read:repository,write:repository,via:cli", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	number := r.fake.OpenIssue(repo, "dana", "CLI snapshot", "Original outsider body")
	req, err := http.NewRequestWithContext(r.ctx, "GET", fmt.Sprintf("%s/api/issues/%d", r.origin, number), nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	raw, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	response.Body.Close()
	require.Equal(t, 200, response.StatusCode, string(raw))
	var snapshot struct {
		Digest  string `json:"issue_digest"`
		Allowed bool   `json:"make_todo_allowed"`
	}
	require.NoError(t, json.Unmarshal(raw, &snapshot))
	require.Len(t, snapshot.Digest, 64)
	require.True(t, snapshot.Allowed)
	var bound int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE principal_id=$1 AND data->>'digest'=$2`, fmt.Sprintf("issue-read:%d", ownerID), snapshot.Digest).Scan(&bound))
	require.Positive(t, bound)
	require.True(t, r.fake.EditIssue(repo, number, "dana", "Later title", "Later outsider body"))
	body := fmt.Sprintf(`{"title":"Reviewed CLI draft","prompt":"Resolve the reported bug","issue":%d,"issue_digest":%q}`, number, snapshot.Digest)
	req, err = http.NewRequestWithContext(r.ctx, "POST", r.origin+"/api/todos", strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "cli-snapshot")
	response, err = http.DefaultClient.Do(req)
	require.NoError(t, err)
	raw, err = io.ReadAll(response.Body)
	require.NoError(t, err)
	response.Body.Close()
	require.Equal(t, 202, response.StatusCode, string(raw))
	var pending struct {
		Confirmation string `json:"confirmation"`
	}
	require.NoError(t, json.Unmarshal(raw, &pending))
	require.NotEmpty(t, pending.Confirmation)
	var admitted int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items WHERE issue_number=$1`, number).Scan(&admitted))
	require.Zero(t, admitted)
	_, err = r.expect("POST", "/api/confirmations/"+pending.Confirmation+"/approve", "{}", 200)
	require.NoError(t, err)
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items WHERE issue_number=$1 AND issue_body='Original outsider body' AND issue_digest=$2`, number, snapshot.Digest).Scan(&admitted))
	require.Equal(t, 1, admitted)

	// Session and delegated CLI doors use the same literal role/text oracle.
	// Seed real authentication records, then enter only production HTTP routes.
	origin, err := url.Parse(r.origin)
	require.NoError(t, err)
	for actorIndex, actor := range []struct {
		login          string
		team, outsider bool
	}{
		{"rehearsal-owner", true, true}, {"mia", true, true}, {"ben", true, false}, {"erin", false, false}, {"carol", false, false}, {"other-app[bot]", false, false},
	} {
		userID := ownerID
		if actorIndex != 0 {
			username := strings.ReplaceAll(strings.ReplaceAll(actor.login, "[", "-"), "]", "")
			user, err := db.New(r.pool).CreateUser(r.ctx, db.CreateUserParams{Username: username, LowerUsername: username})
			require.NoError(t, err)
			userID = user.ID
			_, err = r.pool.Exec(r.ctx, `UPDATE collaborators SET user_id=$1 WHERE github_login=$2`, userID, actor.login)
			require.NoError(t, err)
		}
		session := "trust-session-" + actor.login
		sessionHash := sha256.Sum256([]byte(session))
		_, err = db.New(r.pool).CreateAuthSession(r.ctx, db.CreateAuthSessionParams{UserID: userID, Username: actor.login, SessionKey: hex.EncodeToString(sessionHash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		jar, err := cookiejar.New(nil)
		require.NoError(t, err)
		jar.SetCookies(origin, []*http.Cookie{{Name: "smithers_session", Value: session}, {Name: "__csrf", Value: "trust-csrf"}})
		delegated := "smithers_" + fmt.Sprintf("%040x", userID+1000)
		delegatedHash := sha256.Sum256([]byte(delegated))
		encoded := hex.EncodeToString(delegatedHash[:])
		_, err = db.New(r.pool).CreateAccessToken(r.ctx, db.CreateAccessTokenParams{UserID: userID, Name: "trust-cli-" + actor.login, TokenHash: encoded, TokenLastEight: encoded[len(encoded)-8:], Scopes: "read:repository,write:repository,via:cli", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		for _, text := range []string{"team", "outsider", "outsider-edit"} {
			for _, door := range []string{"session", "cli"} {
				name := actor.login + "/" + text + "/" + door
				author := "ben"
				if text == "outsider" {
					author = "dana"
				}
				number := r.fake.OpenIssue(repo, author, name, "Frozen person-door body")
				if text == "outsider-edit" {
					require.True(t, r.fake.EditIssue(repo, number, "carol", name, "Edited outsider body"))
				}
				call := func(method, path, body string) (int, []byte) {
					req, err := http.NewRequestWithContext(r.ctx, method, r.origin+path, strings.NewReader(body))
					require.NoError(t, err)
					req.Header.Set("Content-Type", "application/json")
					req.Header.Set("Idempotency-Key", name)
					client := &http.Client{Jar: jar}
					if door == "cli" {
						client.Jar = nil
						req.Header.Set("Authorization", "Bearer "+delegated)
					} else {
						req.Header.Set("Origin", r.origin)
						for _, cookie := range jar.Cookies(origin) {
							if cookie.Name == "__csrf" {
								req.Header.Set("X-CSRF-Token", cookie.Value)
							}
						}
					}
					response, err := client.Do(req)
					require.NoError(t, err)
					raw, err := io.ReadAll(response.Body)
					require.NoError(t, err)
					response.Body.Close()
					return response.StatusCode, raw
				}
				status, raw := call("GET", fmt.Sprintf("/api/issues/%d", number), "")
				digest := strings.Repeat("f", 64)
				if actor.team {
					require.Equal(t, 200, status, name+string(raw))
					var read struct {
						Digest string `json:"issue_digest"`
					}
					require.NoError(t, json.Unmarshal(raw, &read))
					require.Len(t, read.Digest, 64)
					digest = read.Digest
				} else {
					require.Equal(t, 403, status, name+string(raw))
				}
				allowed := actor.team
				if text != "team" {
					allowed = actor.outsider
				}
				var approvalsBefore int
				require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM approvals WHERE command='todo.from-issue'`).Scan(&approvalsBefore))
				body := fmt.Sprintf(`{"title":%q,"prompt":"Reviewed issue prompt","issue":%d,"issue_digest":%q}`, name, number, digest)
				status, raw = call("POST", "/api/todos", body)
				if !allowed {
					require.Equal(t, 403, status, name+string(raw))
					var refusal struct {
						Class string `json:"class"`
					}
					require.NoError(t, json.Unmarshal(raw, &refusal))
					require.Equal(t, "permission", refusal.Class, name)
					var approvalsAfter, count int
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM approvals WHERE command='todo.from-issue'`).Scan(&approvalsAfter))
					require.Equal(t, approvalsBefore, approvalsAfter, name)
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items WHERE issue_number=$1`, number).Scan(&count))
					require.Zero(t, count, name)
					continue
				}
				require.Equal(t, 202, status, name+string(raw))
				if door == "cli" {
					var receipt struct {
						Confirmation string `json:"confirmation"`
					}
					require.NoError(t, json.Unmarshal(raw, &receipt))
					require.NotEmpty(t, receipt.Confirmation, name)
					var count int
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items WHERE issue_number=$1`, number).Scan(&count))
					require.Zero(t, count, name)
					_, err = r.expectAs(jar, "POST", "/api/confirmations/"+receipt.Confirmation+"/approve", "{}", 200)
					require.NoError(t, err, name)
				}
				var count int
				require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items WHERE issue_number=$1 AND issue_digest=$2`, number, digest).Scan(&count))
				require.Equal(t, 1, count, name)
			}
		}
	}

	// Every admitted item retains one revision; refused issue context is absent
	// from launch admissions even when the scheduled worker retries its stream.
	var revisions int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items WHERE jsonb_array_length(revisions)<>1`).Scan(&revisions))
	require.Zero(t, revisions)
}
