// Package webapp serves the same browser application from an owned or hosted backend.
package webapp

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"golang.org/x/net/html"
)

type Mode string

const (
	SelfHosted Mode = "web-selfhost"
	Hosted     Mode = "web-plue"
)

// Handler owns a filesystem root. Close it after HTTP requests have drained.
// Use it as the API router's NotFound handler, never in front of API routes.
type Handler struct {
	root  *os.Root
	index []byte
	etag  string
}

// New verifies the packaged index and supplies a secret-free, same-origin target.
func New(directory string, mode Mode) (*Handler, error) {
	if mode != SelfHosted && mode != Hosted {
		return nil, fmt.Errorf("unsupported web deployment mode %q", mode)
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, fmt.Errorf("open web assets: %w", err)
	}
	raw, err := root.ReadFile("index.html")
	if err != nil {
		root.Close()
		return nil, fmt.Errorf("read web index: %w", err)
	}
	document, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		root.Close()
		return nil, fmt.Errorf("parse web index: %w", err)
	}
	var head *html.Node
	var visit func(*html.Node)
	visit = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "head" {
			head = n
		}
		for child := n.FirstChild; child != nil; {
			next := child.NextSibling
			remove := false
			if child.Type == html.ElementNode && child.Data == "meta" {
				for _, a := range child.Attr {
					if a.Key == "name" && a.Val == "smithers-application-target" {
						remove = true
					}
				}
			}
			if remove {
				n.RemoveChild(child)
			} else {
				visit(child)
			}
			child = next
		}
	}
	visit(document)
	if head == nil {
		root.Close()
		return nil, fmt.Errorf("web index has no head")
	}
	target, _ := json.Marshal(map[string]any{"apiVersion": 1, "mode": mode, "apiOrigin": "", "auth": map[string]string{"kind": "session"}, "cors": "same-origin", "developerExternal": false})
	head.AppendChild(&html.Node{Type: html.ElementNode, Data: "meta", Attr: []html.Attribute{{Key: "name", Val: "smithers-application-target"}, {Key: "content", Val: string(target)}}})
	var rendered bytes.Buffer
	if err := html.Render(&rendered, document); err != nil {
		root.Close()
		return nil, err
	}
	index := rendered.Bytes()
	digest := sha256.Sum256(index)
	return &Handler{root: root, index: index, etag: fmt.Sprintf("\"%x\"", digest)}, nil
}
func (h *Handler) Close() error { return h.root.Close() }

func reserved(name string) bool {
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".git") {
			return true
		}
	}
	first, _, _ := strings.Cut(name, "/")
	switch first {
	case "api", "auth", "git", "healthz", "readyz", "metrics", "ssh":
		return true
	}
	return false
}
func wantsHTML(r *http.Request) bool {
	for _, value := range strings.Split(r.Header.Get("Accept"), ",") {
		typ, params, err := mime.ParseMediaType(strings.TrimSpace(value))
		if err == nil && typ == "text/html" && params["q"] != "0" {
			return true
		}
	}
	return false
}
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.NotFound(w, r)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	// A single terminal slash is valid for an app route. Keep the original
	// asset path so a file followed by a slash never becomes a file request.
	routeName := strings.TrimSuffix(name, "/")
	if !fs.ValidPath(routeName) || reserved(routeName) {
		http.NotFound(w, r)
		return
	}
	if name == "index.html" {
		h.serveIndex(w, r)
		return
	}
	f, err := h.root.Open(name)
	if err == nil {
		defer f.Close()
		info, statErr := f.Stat()
		if statErr == nil && info.Mode().IsRegular() {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Cache-Control", "public, max-age=3600")
			http.ServeContent(w, r, name, info.ModTime(), f)
			return
		}
		http.NotFound(w, r)
		return
	}
	if !os.IsNotExist(err) || path.Ext(routeName) != "" || !wantsHTML(r) {
		http.NotFound(w, r)
		return
	}
	h.serveIndex(w, r)
}
func (h *Handler) serveIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("ETag", h.etag)
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(h.index))
}
