package githubfake

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"html"
	"net/http"
	"net/url"
	"strings"
)

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
		status := 200
		var m struct {
			RedirectURL  string   `json:"redirect_url"`
			CallbackURLs []string `json:"callback_urls"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		err := r.ParseForm()
		u, parseErr := url.Parse(m.RedirectURL)
		if err == nil {
			err = json.Unmarshal([]byte(r.Form.Get("manifest")), &m)
			u, parseErr = url.Parse(m.RedirectURL)
		}
		if err != nil || parseErr != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
			status = 422
		}
		s.writes = append(s.writes, Write{Sequence: uint64(len(s.writes) + 1), Method: r.Method, Path: r.URL.Path, Status: status})
		if status != 200 {
			http.Error(w, "invalid manifest", status)
			return true
		}
		s.callbacks = append([]string(nil), m.CallbackURLs...)
		link("Create GitHub App", m.RedirectURL, s.config.ConversionCode, r.Form.Get("state"))
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
		link("Authorize", q.Get("redirect_uri"), code, q.Get("state"))
		return true
	}
	return false
}
