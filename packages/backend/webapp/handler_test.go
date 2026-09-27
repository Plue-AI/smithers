package webapp

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/net/html"
)

func TestPackagedApplicationAndAPIBoundary(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte(`<!doctype html><html><head><meta name="smithers-application-target" content='{"apiOrigin":"https://stale.invalid"}'></head><body><div id="root"></div></body></html>`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "app.js"), []byte("export const ready=true"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "LICENSE"), []byte("license"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "private.txt")
	os.WriteFile(outside, []byte("private"), 0600)
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []Mode{SelfHosted, Hosted} {
		t.Run(string(mode), func(t *testing.T) {
			h, err := New(root, mode)
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/ping" {
					w.Header().Set("Content-Type", "application/json")
					io.WriteString(w, `{"ok":true}`)
					return
				}
				h.ServeHTTP(w, r)
			}))
			defer server.Close()
			for _, tc := range []struct {
				path, method, accept string
				status               int
			}{
				{"/", "GET", "text/html", 200}, {"/repositories/example", "GET", "text/html", 200},
				{"/smithersai/smithers/", "GET", "text/html", 200},
				{"/smithersai/smithers/", "HEAD", "text/html", 200},
				{"/smithersai/smithers/?view=wiki", "GET", "text/html", 200},
				{"/smithersai/smithers/", "GET", "application/json", 404},
				{"/smithersai/smithers/", "GET", "text/html;q=0", 404},
				{"/smithersai/smithers/", "POST", "text/html", 404},
				{"/smithersai/smithers//", "GET", "text/html", 404},
				{"//smithersai/smithers/", "GET", "text/html", 404},
				{"/smithersai//smithers/", "GET", "text/html", 404},
				{"/smithersai/../smithers/", "GET", "text/html", 404},
				{"/smithersai/%2e%2e/smithers/", "GET", "text/html", 404},
				{"/api/missing/", "GET", "text/html", 404},
				{"/auth/missing/", "GET", "text/html", 404},
				{"/git/missing/", "GET", "text/html", 404},
				{"/owner/repository.git/", "GET", "text/html", 404},
				{"/readyz/", "GET", "text/html", 404},
				{"/.env/", "GET", "text/html", 404},
				{"/escape/", "GET", "text/html", 404},
				{"/index.html/", "GET", "text/html", 404},
				{"/app.js/", "GET", "text/html", 404},
				{"/missing.js/", "GET", "text/html", 404},
				{"/LICENSE", "GET", "text/html", 200},
				{"/LICENSE/", "GET", "text/html", 404},
				{"/assets/", "GET", "text/html", 404},
				{"//", "GET", "text/html", 404},
				{"/app.js", "GET", "*/*", 200}, {"/app.js", "HEAD", "*/*", 200},
				{"/missing.js", "GET", "text/html", 404}, {"/api/missing", "GET", "text/html", 404},
				{"/owner/repository.git/info/refs", "GET", "text/html", 404}, {"/auth/missing", "GET", "text/html", 404},
				{"/readyz", "GET", "text/html", 404}, {"/.env", "GET", "text/html", 404},
				{"/escape", "GET", "text/html", 404}, {"/unknown", "POST", "text/html", 404},
				{"/unknown", "GET", "application/json", 404}, {"/unknown", "GET", "text/html;q=0", 404},
				{"/api/ping", "GET", "application/json", 200},
			} {
				req, _ := http.NewRequest(tc.method, server.URL+tc.path, nil)
				req.Header.Set("Accept", tc.accept)
				response, err := server.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				body, _ := io.ReadAll(response.Body)
				response.Body.Close()
				if response.StatusCode != tc.status {
					t.Errorf("%s %s: %d: %s", tc.method, tc.path, response.StatusCode, body)
				}
				if tc.method == "HEAD" && len(body) != 0 {
					t.Error("HEAD returned body")
				}
				if tc.path == "/" || (strings.HasPrefix(tc.path, "/smithersai/smithers/") && tc.status == 200 && tc.method == "GET") {
					if response.Header.Get("Cache-Control") != "no-cache" {
						t.Error("index cached across configchanges")
					}
					doc, err := html.Parse(strings.NewReader(string(body)))
					if err != nil {
						t.Fatal(err)
					}
					count := 0
					var visit func(*html.Node)
					visit = func(n *html.Node) {
						if n.Type == html.ElementNode && n.Data == "meta" {
							attrs := map[string]string{}
							for _, a := range n.Attr {
								attrs[a.Key] = a.Val
							}
							if attrs["name"] == "smithers-application-target" {
								count++
								var target map[string]any
								if err := json.Unmarshal([]byte(attrs["content"]), &target); err != nil {
									t.Fatal(err)
								}
								if target["mode"] != string(mode) || target["apiOrigin"] != "" {
									t.Fatalf("incorrect target: %v", target)
								}
							}
						}
						for c := n.FirstChild; c != nil; c = c.NextSibling {
							visit(c)
						}
					}
					visit(doc)
					if count != 1 {
						t.Fatalf("target documents: %d", count)
					}
					conditional, _ := http.NewRequest("GET", server.URL+tc.path, nil)
					conditional.Header.Set("Accept", tc.accept)
					conditional.Header.Set("If-None-Match", response.Header.Get("ETag"))
					cached, err := server.Client().Do(conditional)
					if err != nil {
						t.Fatal(err)
					}
					cached.Body.Close()
					if cached.StatusCode != 304 {
						t.Errorf("conditional index: %d", cached.StatusCode)
					}
				}
			}
		})
	}
}
func TestStartupRejectsMissingBundle(t *testing.T) {
	if _, err := New(t.TempDir(), SelfHosted); err == nil {
		t.Fatal("missing index accepted")
	}
	if _, err := New(t.TempDir(), Mode("unknown")); err == nil {
		t.Fatal("invalid mode accepted")
	}
}
