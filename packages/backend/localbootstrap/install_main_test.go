package localbootstrap

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// The install composition is what turns the engine's install main policy on:
// after Prepare, a person's receive of main is refused by the engine and
// every door in front of it reads the same fact from its client.
func TestPrepareRefusesPersonReceiveOfMain(t *testing.T) {
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if ffi == "" {
		t.Skip("SMITHERS_FFI_LIBRARY_PATH is required for the real repository engine")
	}
	clearBootstrapEnvironment(t)
	hooks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	t.Cleanup(hooks.Close)
	t.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_URL", hooks.URL)
	t.Setenv("SMITHERS_FFI_LIBRARY_PATH", ffi)
	runtime, err := Prepare(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := runtime.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	client := runtime.Client()
	if !client.InstallMainMirror() {
		t.Fatal("the install engine's client must carry the install main fact")
	}
	ctx := context.Background()
	if err := client.InitRepo(ctx, "owner", "app", "main", false); err != nil {
		t.Fatal(err)
	}
	commit, pack := rootCommitPack(t)
	push := func(ref string) error {
		line := fmt.Sprintf("%s %s %s\x00report-status\n", strings.Repeat("0", 40), commit, ref)
		body := bytes.NewBufferString(fmt.Sprintf("%04x%s0000", len(line)+4, line))
		body.Write(pack)
		var out bytes.Buffer
		return client.ProxyReceivePack(ctx, "owner", "app", body, &out, repohost.ReceivePackMetadata{PusherID: 1, PusherLogin: "owner", PusherCredential: middleware.CredentialPerson})
	}
	err = push("refs/heads/main")
	var status *repohost.StatusError
	if !errors.As(err, &status) || status.StatusCode != http.StatusForbidden || !strings.Contains(status.Message, "GitHub mirror") {
		t.Fatalf("a person's receive of main on the install = %v, want the 403 permission refusal", err)
	}
	if _, found, err := repohost.LookupBookmark(ctx, client, "owner", "app", "main"); err != nil || found {
		t.Fatalf("main after the refused receive: found=%v err=%v", found, err)
	}
	// The same pack under another name is an ordinary push.
	if err := push("refs/heads/feature"); err != nil {
		t.Fatalf("a person's feature push: %v", err)
	}
	if bookmark, found, err := repohost.LookupBookmark(ctx, client, "owner", "app", "feature"); err != nil || !found || bookmark.TargetCommitID != commit {
		t.Fatalf("feature after the push: %+v found=%v err=%v", bookmark, found, err)
	}
}

// rootCommitPack returns one root commit and a pack of everything it holds.
func rootCommitPack(t *testing.T) (string, []byte) {
	t.Helper()
	dir := t.TempDir()
	git := func(stdin string, args ...string) []byte {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Stdin = strings.NewReader(stdin)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull,
			"GIT_AUTHOR_NAME=Owner", "GIT_AUTHOR_EMAIL=owner@example.test", "GIT_COMMITTER_NAME=Owner", "GIT_COMMITTER_EMAIL=owner@example.test")
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return out
	}
	git("", "init", "-q", "--initial-branch=main")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("member change\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	git("", "add", "README.md")
	git("", "commit", "-q", "-m", "member change")
	commit := strings.TrimSpace(string(git("", "rev-parse", "HEAD")))
	return commit, git(commit+"\n", "pack-objects", "--revs", "--stdout", "-q")
}
