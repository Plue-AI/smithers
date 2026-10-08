package githubfake

import (
	"encoding/json"
	"html"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestBrowserPages(t *testing.T) {
	cfg, err := LocalSeed()
	if err != nil {
		t.Fatal(err)
	}
	other, err := LocalSeed()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PrivateKeyPEM == other.PrivateKeyPEM || cfg.ClientID == other.ClientID || cfg.ConversionCode == other.ConversionCode {
		t.Fatal("credentials reused")
	}
	if cfg.OwnerLogin != "local-owner" || cfg.Slug != "smithers-local" || cfg.Installations[0].Repositories[0].FullName != "local-owner/demo" || !cfg.Installations[0].Repositories[0].Private {
		t.Fatal("invalid local seed")
	}
	handler, err := Handler(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if handler.Server != nil {
		t.Fatal("Handler opened a listener")
	}
	fake, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	post := func(path string, form url.Values, status int) string {
		t.Helper()
		r, err := http.PostForm(fake.URL+path, form)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		body, _ := io.ReadAll(r.Body)
		if r.StatusCode != status {
			t.Fatalf("%s: %d %s", path, r.StatusCode, body)
		}
		return string(body)
	}
	get := func(path string, status int) string {
		t.Helper()
		r, err := http.Get(fake.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		body, _ := io.ReadAll(r.Body)
		if r.StatusCode != status {
			t.Fatalf("%s: %d %s", path, r.StatusCode, body)
		}
		return string(body)
	}
	target := func(page string) *url.URL {
		t.Helper()
		raw := html.UnescapeString(strings.Split(strings.Split(page, `href="`)[1], `"`)[0])
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		return u
	}
	for _, path := range []string{"/settings/apps/new", "/organizations/local/settings/apps/new"} {
		for _, manifest := range []string{"{", `{"redirect_url":"file:///tmp/x"}`, `{"redirect_url":"https:"}`, `{"redirect_url":"//localhost/callback"}`} {
			post(path, url.Values{"manifest": {manifest}}, 422)
		}
		// GitHub refuses a hook it cannot reach and default events without a hook.
		for _, hook := range []string{`"hook_attributes":{"url":"http://localhost:4000/webhooks/github","active":false}`, `"hook_attributes":{"url":"https://mini.local/webhooks/github"}`,
			`"hook_attributes":{"url":"https://192.168.1.2/webhooks/github"}`, `"hook_attributes":{"url":""},"default_events":["push"]`, `"default_events":["push"]`} {
			body := post(path, url.Values{"manifest": {`{"redirect_url":"http://localhost:4000/setup/github/callback",` + hook + `}`}}, 422)
			if !strings.Contains(body, "Hook url") {
				t.Fatal(body)
			}
		}
		// GitHub refuses a permission key outside its manifest list, such as
		// email_addresses, the REST name of the manifest key emails.
		for _, permissions := range []string{`{"contents":"write","email_addresses":"read"}`, `{"emails":"read","teleport":"write"}`} {
			body := post(path, url.Values{"manifest": {`{"redirect_url":"http://localhost:4000/setup/github/callback","default_permissions":` + permissions + `}`}}, 422)
			if !strings.Contains(body, "Default permission records resource is not included in the list") {
				t.Fatal(body)
			}
		}
		post(path, url.Values{"manifest": {`{"redirect_url":"http://localhost:4000/setup/github/callback","default_permissions":{"contents":"write","emails":"read"}}`}}, 200)
		post(path, url.Values{"manifest": {`{"redirect_url":"http://localhost:4000/setup/github/callback","hook_attributes":{"url":"https://factory.example/webhooks/github","active":true},"default_events":["push"]}`}}, 200)
		u := target(post(path, url.Values{"manifest": {`{"redirect_url":"http://localhost:4000/setup/github/callback?keep=yes","callback_urls":["http://localhost:4000/api/auth/github/callback"]}`}, "state": {"state&one"}}, 200))
		if u.Query().Get("state") != "state&one" || u.Query().Get("code") != cfg.ConversionCode || u.Query().Get("keep") != "yes" {
			t.Fatal(u)
		}
	}
	get("/login/oauth/authorize?client_id=wrong&redirect_uri=http://localhost:4000/api/auth/github/callback", 400)
	get("/login/oauth/authorize?client_id="+cfg.ClientID+"&redirect_uri=https://attacker.invalid", 400)
	response, err := http.Post(fake.URL+"/app-manifests/"+cfg.ConversionCode+"/conversions", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	var converted map[string]any
	err = json.NewDecoder(response.Body).Decode(&converted)
	response.Body.Close()
	// The last manifest carried no hook, so GitHub generates no webhook secret.
	if secret, present := converted["webhook_secret"]; err != nil || !present || secret != nil || converted["client_secret"] != cfg.ClientSecret {
		t.Fatalf("hookless conversion: %v %v", err, converted["webhook_secret"])
	}
	var previous string
	for range 2 {
		query := url.Values{"client_id": {cfg.ClientID}, "redirect_uri": {"http://localhost:4000/api/auth/github/callback"}, "state": {"state&two"}}
		u := target(get("/login/oauth/authorize?"+query.Encode(), 200))
		code := u.Query().Get("code")
		if code == previous || code == "" || u.Query().Get("state") != "state&two" {
			t.Fatal(u)
		}
		previous = code
		form := url.Values{"client_id": {cfg.ClientID}, "client_secret": {cfg.ClientSecret}, "code": {code}, "redirect_uri": {"http://localhost:4000/api/auth/github/callback"}}
		form.Set("redirect_uri", "https://attacker.invalid")
		post("/login/oauth/access_token", form, 401)
		form.Set("redirect_uri", "http://localhost:4000/api/auth/github/callback")
		post("/login/oauth/access_token", form, 200)
		post("/login/oauth/access_token", form, 401)
	}
	// A browser walk adds collaborators, then picks an account on the
	// authorize page: "Authorize" stays the owner, and each collaborator has
	// its own link whose code signs that account in.
	collaborators := func(body string, status int) {
		t.Helper()
		r, err := http.Post(fake.URL+"/_fake/collaborators", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if r.StatusCode != status {
			t.Fatalf("%s: %d", body, r.StatusCode)
		}
	}
	for _, body := range []string{`{`, `{"id":7,"login":"ben","permission":"maintain"}`, `{"id":101,"login":"","permission":"write"}`, `{"id":101,"login":"ben","permission":"owner"}`} {
		collaborators(body, 400)
	}
	collaborators(`{"id":102,"login":"alice","permission":"write"}`, 204)
	collaborators(`{"id":101,"login":"ben","permission":"maintain"}`, 204)
	query := url.Values{"client_id": {cfg.ClientID}, "redirect_uri": {"http://localhost:4000/api/auth/github/callback"}, "state": {"s"}}
	page := get("/login/oauth/authorize?"+query.Encode(), 200)
	labels := []string{}
	for _, part := range strings.Split(page, "</a>")[:3] {
		labels = append(labels, part[strings.LastIndex(part, ">")+1:])
	}
	if strings.Join(labels, ",") != "Authorize,Authorize as ben,Authorize as alice" {
		t.Fatal(page)
	}
	ben := target(strings.SplitN(page, "</p>", 2)[1])
	form := url.Values{"client_id": {cfg.ClientID}, "client_secret": {cfg.ClientSecret}, "code": {ben.Query().Get("code")}, "redirect_uri": {"http://localhost:4000/api/auth/github/callback"}}
	if body := post("/login/oauth/access_token", form, 200); !strings.Contains(body, "ghu_githubfake_user_101") {
		t.Fatal(body)
	}
	request, _ := http.NewRequest(http.MethodGet, fake.URL+"/user", nil)
	request.Header.Set("Authorization", "Bearer ghu_githubfake_user_101")
	user, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	var who map[string]any
	_ = json.NewDecoder(user.Body).Decode(&who)
	user.Body.Close()
	if who["login"] != "ben" {
		t.Fatal(who)
	}
	// A teammate opens an issue on GitHub; it shares the pull request sequence.
	opened, err := http.Post(fake.URL+"/_fake/issues", "application/json", strings.NewReader(`{"repo":"local-owner/demo","login":"alice","title":"Retry webhooks","body":"They drop on 502."}`))
	if err != nil {
		t.Fatal(err)
	}
	var number map[string]int64
	_ = json.NewDecoder(opened.Body).Decode(&number)
	opened.Body.Close()
	if issue, ok := fake.Issue("local-owner/demo", number["number"]); !ok || number["number"] != 1 || issue.Title != "Retry webhooks" || issue.Author != "alice" {
		t.Fatal(number, issue)
	}
	if bad, err := http.Post(fake.URL+"/_fake/issues", "application/json", strings.NewReader(`{"repo":"local-owner/demo"}`)); err != nil || bad.StatusCode != 400 {
		t.Fatal(err, bad.StatusCode)
	}
	// Someone comments on it; a comment needs an issue and words.
	commented, err := http.Post(fake.URL+"/_fake/comments", "application/json", strings.NewReader(`{"repo":"local-owner/demo","number":1,"login":"carol","body":"Seen it too."}`))
	if err != nil || commented.StatusCode != 200 {
		t.Fatal(err, commented.StatusCode)
	}
	commented.Body.Close()
	if issue, _ := fake.Issue("local-owner/demo", 1); len(issue.Comments) != 1 || issue.Comments[0].Author != "carol" || issue.Comments[0].Body != "Seen it too." || issue.Comments[0].ViaApp {
		t.Fatal(issue.Comments)
	}
	for body, status := range map[string]int{`{"repo":"local-owner/demo","number":9,"login":"carol","body":"x"}`: 404, `{"repo":"local-owner/demo","number":1,"login":"carol"}`: 400} {
		if bad, err := http.Post(fake.URL+"/_fake/comments", "application/json", strings.NewReader(body)); err != nil || bad.StatusCode != status {
			t.Fatal(body, err, bad.StatusCode)
		}
	}
	// A person labels it todo; a repeated label is a second event, never a second label, and a label needs an open issue.
	for range 2 {
		labeled, err := http.Post(fake.URL+"/_fake/labels", "application/json", strings.NewReader(`{"repo":"local-owner/demo","number":1,"login":"ben","label":"todo"}`))
		if err != nil || labeled.StatusCode != 200 {
			t.Fatal(err, labeled.StatusCode)
		}
		labeled.Body.Close()
	}
	if issue, _ := fake.Issue("local-owner/demo", 1); len(issue.Labels) != 1 || issue.Labels[0] != "todo" || len(issue.Events) != 2 ||
		issue.Events[0].Actor != "ben" || issue.Events[0].ViaApp || issue.Events[0].Label != "todo" {
		t.Fatal(issue.Labels, issue.Events)
	}
	for body, status := range map[string]int{`{"repo":"local-owner/demo","number":9,"login":"ben","label":"todo"}`: 404, `{"repo":"local-owner/demo","number":1,"login":"ben"}`: 400, `{"repo":"local-owner/demo","number":1,"label":"todo"}`: 400, `not json`: 400} {
		if bad, err := http.Post(fake.URL+"/_fake/labels", "application/json", strings.NewReader(body)); err != nil || bad.StatusCode != status {
			t.Fatal(body, err, bad.StatusCode)
		}
	}
	raw := get("/_fake/writes", 200)
	var rows []map[string]any
	if json.Unmarshal([]byte(raw), &rows) != nil || len(rows) == 0 {
		t.Fatal(raw)
	}
	for _, row := range rows {
		if len(row) != 3 || row["method"] == nil || row["path"] == nil || row["status"] == nil {
			t.Fatal(row)
		}
	}
	for _, secret := range []string{cfg.ClientSecret, cfg.PrivateKeyPEM, cfg.WebhookSecret, "client_secret", "body"} {
		if strings.Contains(raw, secret) {
			t.Fatalf("receipt leaked %s", secret)
		}
	}
}
