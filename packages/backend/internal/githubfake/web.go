package githubfake

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"html"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// publicHookURL mirrors GitHub's manifest check that a hook is reachable over
// the public Internet: loopback, private, link-local and .local hosts refuse.
func publicHookURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsGlobalUnicast() && !ip.IsPrivate()
	}
	return strings.Contains(host, ".") && !strings.HasSuffix(host, ".localhost") && !strings.HasSuffix(host, ".local")
}

// manifestPermissions are the default_permissions keys github.com accepted in
// the install's manifest (J1 setup walk, 2026-10-05). GitHub refuses a manifest
// naming any other key, such as email_addresses, the REST name of the manifest
// key emails. The fake refuses the same way, so a key joins this list only
// after GitHub has accepted it.
var manifestPermissions = map[string]bool{"administration": true, "checks": true, "contents": true, "emails": true, "issues": true, "members": true, "metadata": true, "pull_requests": true, "statuses": true, "workflows": true}

func unknownManifestPermission(permissions map[string]string) bool {
	for key := range permissions {
		if !manifestPermissions[key] {
			return true
		}
	}
	return false
}

func freshCode() string {
	var bytes [24]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(bytes[:])
}

// web supplies only the two browser provider pages absent from the HTTP fake.
// Called under the server lock; the public receipt intentionally has no bodies.
func (s *Server) web(w http.ResponseWriter, r *http.Request) bool {
	if s.people(w, r) {
		return true
	}
	if r.Method == "GET" && r.URL.Path == "/_fake/writes" {
		rows := []struct {
			Method string `json:"method"`
			Path   string `json:"path"`
			Status int    `json:"status"`
		}{}
		for _, v := range s.writes {
			rows = append(rows, struct {
				Method string `json:"method"`
				Path   string `json:"path"`
				Status int    `json:"status"`
			}{v.Method, v.Path, v.Status})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(rows)
		return true
	}
	path := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	manifest := r.URL.Path == "/settings/apps/new" || (len(path) == 5 && path[0] == "organizations" && path[2] == "settings" && path[3] == "apps" && path[4] == "new")
	link := func(label, target, code, state string) {
		u, _ := url.Parse(target)
		q := u.Query()
		q.Set("code", code)
		q.Set("state", state)
		u.RawQuery = q.Encode()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<a href="` + html.EscapeString(u.String()) + `">` + label + `</a>`))
	}
	if manifest && r.Method == "POST" {
		status, refusal := 200, "invalid manifest"
		var m struct {
			RedirectURL    string   `json:"redirect_url"`
			CallbackURLs   []string `json:"callback_urls"`
			HookAttributes *struct {
				URL string `json:"url"`
			} `json:"hook_attributes"`
			DefaultEvents      []string          `json:"default_events"`
			DefaultPermissions map[string]string `json:"default_permissions"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		err := r.ParseForm()
		u, parseErr := url.Parse(m.RedirectURL)
		if err == nil {
			err = json.Unmarshal([]byte(r.Form.Get("manifest")), &m)
			u, parseErr = url.Parse(m.RedirectURL)
		}
		hook := ""
		if m.HookAttributes != nil {
			hook = m.HookAttributes.URL
		}
		if err != nil || parseErr != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
			status = 422
		} else if hook != "" && !publicHookURL(hook) {
			// GitHub's own refusal for a hook it cannot deliver to.
			status, refusal = 422, "Hook url is not supported because it isn't reachable over the public Internet (localhost)"
		} else if hook == "" && (m.HookAttributes != nil || len(m.DefaultEvents) > 0) {
			status, refusal = 422, "Hook url cannot be blank"
		} else if unknownManifestPermission(m.DefaultPermissions) {
			status, refusal = 422, "The configuration does not appear to be a valid GitHub App manifest. Error Default permission records resource is not included in the list"
		}
		s.writes = append(s.writes, Write{Sequence: uint64(len(s.writes) + 1), Method: r.Method, Path: r.URL.Path, Status: status})
		if status != 200 {
			http.Error(w, refusal, status)
			return true
		}
		// GitHub generates a webhook secret only for an App created with a hook.
		s.hookless = hook == ""
		// A manifest that names permissions limits what the owner token reads.
		s.permissions = m.DefaultPermissions
		s.callbacks = append([]string(nil), m.CallbackURLs...)
		link("Create GitHub App", m.RedirectURL, s.config.ConversionCode, r.Form.Get("state"))
		return true
	}
	// A browser walk adds collaborators (SetCollaborator) before the owner
	// adds them on the Members card.
	if r.Method == "POST" && r.URL.Path == "/_fake/collaborators" {
		var body struct {
			ID         int64  `json:"id"`
			Login      string `json:"login"`
			Permission string `json:"permission"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil || body.ID <= 0 || body.ID == 7 || body.Login == "" ||
			!map[string]bool{"admin": true, "maintain": true, "write": true, "triage": true, "read": true, "none": true}[body.Permission] {
			http.Error(w, "id (not 7), login and permission are required", 400)
			return true
		}
		s.accounts[body.ID] = body.Login
		s.access[body.Login] = body.Permission
		w.WriteHeader(http.StatusNoContent)
		return true
	}
	// A teammate opens an issue on GitHub (J2.1), as OpenIssue does.
	if r.Method == "POST" && r.URL.Path == "/_fake/issues" {
		var body struct {
			Repo, Login, Title, Body string
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil || body.Repo == "" || body.Title == "" {
			http.Error(w, "repo and title are required", 400)
			return true
		}
		if body.Login == "" {
			body.Login = s.config.OwnerLogin
		}
		number := s.nextNumber(body.Repo)
		now := time.Now().UTC()
		s.opened[issueKey(body.Repo, number)] = &issue{Number: number, Title: body.Title, Body: body.Body, Author: body.Login, State: "open", CreatedAt: now, UpdatedAt: now}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int64{"number": number})
		return true
	}
	// A person comments on an issue on GitHub (J2.1), as CommentIssue does.
	if r.Method == "POST" && r.URL.Path == "/_fake/comments" {
		var body struct {
			Repo, Login, Body string
			Number            int64
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil || body.Repo == "" || body.Login == "" || body.Body == "" {
			http.Error(w, "repo, number, login and body are required", 400)
			return true
		}
		id := s.personComment(body.Repo, body.Number, body.Login, body.Body)
		if id == 0 {
			http.Error(w, "issue not found", 404)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int64{"id": id})
		return true
	}
	if r.Method == "GET" && r.URL.Path == "/login/oauth/authorize" {
		q := r.URL.Query()
		known := false
		for _, callback := range s.callbacks {
			known = known || callback == q.Get("redirect_uri")
		}
		if q.Get("client_id") != s.config.ClientID || !known {
			http.Error(w, "unknown client or callback", 400)
			return true
		}
		code := freshCode()
		s.codes[code] = q.Get("redirect_uri")
		// GitHub's account switcher: "Authorize" signs in the owner; each
		// collaborator account has its own "Authorize as <login>" link.
		ids := make([]int64, 0, len(s.accounts))
		for id := range s.accounts {
			if id != 7 {
				ids = append(ids, id)
			}
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		var page strings.Builder
		anchor := func(label, code string) {
			u, _ := url.Parse(q.Get("redirect_uri"))
			values := u.Query()
			values.Set("code", code)
			values.Set("state", q.Get("state"))
			u.RawQuery = values.Encode()
			page.WriteString(`<p><a href="` + html.EscapeString(u.String()) + `">` + html.EscapeString(label) + `</a></p>`)
		}
		anchor("Authorize", code)
		for _, id := range ids {
			as := freshCode()
			s.codes[as] = q.Get("redirect_uri")
			s.signIns[as] = id
			anchor("Authorize as "+s.accounts[id], as)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(page.String()))
		return true
	}
	return false
}
