package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/machinedfake"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Only the unavailable guest is faked. HTTP, owner auth, repository authority,
// workspace service and PostgreSQL use the single-owner install composition.
// This does not qualify the guest's atomicity or real-machine race retention.
type writeReplyRuntime struct {
	*process.Runtime
	repo   int64
	clone  string
	writer workspaceapi.WorkspaceCompareWriter
	reader func(context.Context, string, string) ([]byte, error)
}

func (r *writeReplyRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceRunning}, nil
}
func (r *writeReplyRuntime) ListFiles(_ context.Context, _, path string) ([]workspaceapi.FileEntry, error) {
	if path == ".git" {
		return []workspaceapi.FileEntry{{Name: "smithers-workspace-initialization.json"}}, nil
	}
	return []workspaceapi.FileEntry{{Name: ".git", IsDir: true}, {Name: ".jj", IsDir: true}}, nil
}
func (r *writeReplyRuntime) ReadFile(ctx context.Context, id, path string) ([]byte, error) {
	if path != ".git/smithers-workspace-initialization.json" {
		panic("ordinary read reached helper fallback")
	}
	return json.Marshal(map[string]any{"version": 1, "workspace_id": id, "repository_id": r.repo, "clone_url": r.clone, "source_bookmark": "smithers/digest", "source_revision": strings.Repeat("a", 40), "initialized_at": time.Now().UTC()})
}
func (r *writeReplyRuntime) ReadWorkingCopyFile(ctx context.Context, id, path string) ([]byte, error) {
	if r.reader == nil {
		return nil, workspaceapi.ErrReadFileUnavailable
	}
	return r.reader(ctx, id, path)
}
func (r *writeReplyRuntime) ExecuteCommand(_ context.Context, _ string, c workspaceapi.Command) (workspaceapi.CommandResult, error) {
	if len(c.Args) >= 4 && c.Args[0] == "git" && c.Args[1] == "remote" {
		return workspaceapi.CommandResult{Stdout: r.clone + "\n"}, nil
	}
	return workspaceapi.CommandResult{}, nil
}
func (r *writeReplyRuntime) CompareWriteFiles(ctx context.Context, id string, changes []workspaceapi.FileMutation) (*workspaceapi.FileWriteResult, error) {
	if r.writer != nil {
		return r.writer.CompareWriteFiles(ctx, id, changes)
	}
	for _, change := range changes {
		if change.BaseDigest != "absent" {
			return nil, &workspaceapi.StaleFileError{Path: change.Path, CurrentDigest: "absent"}
		}
	}
	result := &workspaceapi.FileWriteResult{Raced: []workspaceapi.FileRace{}}
	for _, change := range changes {
		digest := "absent"
		if change.Content != nil {
			digest = fmt.Sprintf("%x", sha256.Sum256(change.Content))
		}
		result.Paths = append(result.Paths, workspaceapi.FileMutationResult{Path: change.Path, Digest: digest})
		if change.Path == "raced" {
			result.Raced = append(result.Raced, workspaceapi.FileRace{Path: change.Path, Version: "retained-outside"})
		}
	}
	return result, nil
}

func TestWorkspaceWriteReplyInstall(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "digestowner", LowerUsername: "digestowner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"digestowner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for key, value := range map[string]string{"setup.step.source": `{"id":"source","status":"done"}`, "setup.source.repository": `"digestowner/demo"`, "github.repository": binding, "owner.access": binding} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	const cookie = "digest-cookie"
	hash := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	var id string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name,kind,status,vm_id,target_bookmark) VALUES($1,$2,'digest','container','running','fixture','smithers/digest') RETURNING id`, repo.ID, owner.ID).Scan(&id))
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	provider := &writeReplyRuntime{Runtime: runtime, repo: repo.ID, clone: origin + "/digestowner/demo.git"}
	server.Config.Handler = startSplitProcess(t, Options{FlowHostProductAPIURL: origin, Workspace: provider, ChatHost: unusedChatHost{}})
	server.Start()
	defer server.Close()

	t.Run("authenticated daemon reads", func(t *testing.T) {
		registry := new(machined.Registry)
		link, peer := presenceTestLink(t, registry, id)
		require.NoError(t, link.Reconciled())
		provider.reader = func(ctx context.Context, branch, path string) ([]byte, error) {
			file, err := registry.ReadFile(ctx, branch, path, "")
			if err != nil {
				var refusal *machined.SessionError
				if errors.As(err, &refusal) && refusal.Code == "not_found" {
					return nil, fs.ErrNotExist
				}
				return nil, workspaceapi.ErrReadFileUnavailable
			}
			return file.Content, nil
		}
		defer func() { provider.reader = nil }()
		done := make(chan error, 1)
		go func() {
			for n := 0; n < 2; n++ {
				request, err := wire.Read(peer)
				if err != nil {
					done <- err
					return
				}
				correlation, method, args, err := request.Request()
				if err != nil {
					done <- err
					return
				}
				if method != byte(wire.ReadFile) {
					done <- fmt.Errorf("unexpected method %d", method)
					return
				}
				fields, err := wire.Fields("args2", args)
				if err != nil {
					done <- err
					return
				}
				if string(fields[1][2:]) != "README.md" {
					done <- fmt.Errorf("wrong path")
					return
				}
				digest, _ := hex.DecodeString("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
				result := wire.Union(byte(wire.ReadFile), wire.Field(1, wire.Bytes([]byte("hello"))), wire.Field(2, digest), wire.Field(3, wire.U32(420)))
				if n == 1 {
					result = wire.Union(255, wire.Field(1, []byte{5}))
				}
				err = wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(correlation)), wire.Field(2, result))})
				if err != nil {
					done <- err
					return
				}
			}
			done <- nil
		}()
		for _, status := range []int{200, 404, 503} {
			if status == 503 {
				require.NoError(t, link.Close())
			}
			req, err := http.NewRequest("GET", server.URL+"/api/repos/digestowner/demo/workspaces/"+id+"/files/content?path=README.md", nil)
			require.NoError(t, err)
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
			response, err := server.Client().Do(req)
			require.NoError(t, err)
			body, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			response.Body.Close()
			require.Equal(t, status, response.StatusCode, string(body))
			if status == 200 {
				require.Contains(t, string(body), `"content":"hello"`)
				require.Contains(t, string(body), `"digest":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"`)
			}
		}
		require.NoError(t, <-done)
	})

	digest := fmt.Sprintf("%x", sha256.Sum256([]byte("new")))
	for _, item := range []struct {
		query, request, reply string
		status                int
	}{
		{"?path=a", `{"content":"new","base_digest":"absent"}`, `{"paths":[{"path":"a","post_digest":"` + digest + `"}],"raced":[]}`, 200},
		{"", `{"changes":[{"path":"a","content":"new","base_digest":"absent"},{"path":"removed","content":null,"base_digest":"absent"}]}`, `{"paths":[{"path":"a","post_digest":"` + digest + `"},{"path":"removed","post_digest":"absent"}],"raced":[]}`, 200},
		{"?path=raced", `{"content":"new","base_digest":"absent"}`, `{"paths":[{"path":"raced","post_digest":"` + digest + `"}],"raced":[{"path":"raced","version":"retained-outside"}]}`, 200},
		{"?path=a", `{"content":"new","base_digest":"` + digest + `"}`, `{"code":"stale","current_digest":"absent"}`, 409},
		{"", `{"changes":[{"path":"a","content":"new","base_digest":"` + digest + `"}]}`, `{"code":"stale","path":"a","current_digest":"absent"}`, 409},
	} {
		req, err := http.NewRequest("PUT", server.URL+"/api/repos/digestowner/demo/workspaces/"+id+"/files/content"+item.query, strings.NewReader(item.request))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", "digest-csrf")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "digest-csrf"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		response, err := server.Client().Do(req)
		require.NoError(t, err)
		body, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		require.NoError(t, response.Body.Close())
		require.Equal(t, item.status, response.StatusCode, string(body))
		require.JSONEq(t, item.reply, string(body))
	}

	t.Run("daemon adapter", func(t *testing.T) {
		// Only the missing remote daemon is faked. Exercise real authorization,
		// runtime identity, adapter and HTTP receipt/error mapping together.
		const helloDigest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
		const otherDigest = "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7"
		calls := 0
		readyCalls := 0
		unavailable := false
		provider.writer = machined.WorkspaceWriter{EnsureReady: func(ctx context.Context, branch string) error {
			readyCalls++
			require.Equal(t, id, branch)
			op, ok := workspaceapi.OperationFromContext(ctx)
			require.True(t, ok)
			require.Equal(t, fmt.Sprint(owner.ID), op.PrincipalID)
			if unavailable {
				return machined.ErrNotReady
			}
			return nil
		}, Client: &machinedfake.Client{OnWriteFiles: func(_ context.Context, branch string, actor []byte, changes []machined.FileChange) (machined.WriteResult, error) {
			calls++
			require.Equal(t, calls, readyCalls, "readiness must precede each write")
			require.Equal(t, id, branch)
			require.Equal(t, fmt.Sprint(owner.ID), string(actor))
			require.Len(t, changes, 1)
			require.Equal(t, "daemon.txt", changes[0].Path)
			if string(changes[0].Content) == "offline" {
				return machined.WriteResult{}, machined.ErrNotReady
			}
			if string(changes[0].Content) == "wrong-receipt" {
				return machined.WriteResult{Applied: []machined.AppliedFile{{Path: "daemon.txt", PostDigest: helloDigest}}}, nil
			}
			if string(changes[0].Content) == "partial-stale" {
				// A provider may not combine refusal with a published change.
				// Reject this receipt rather than report an unchanged stale write.
				current := otherDigest
				return machined.WriteResult{
					Stale:   &machined.StaleFile{Path: "daemon.txt", CurrentDigest: &current},
					Applied: []machined.AppliedFile{{Path: "daemon.txt", PostDigest: helloDigest}},
				}, nil
			}
			if changes[0].BaseDigest != nil {
				current := otherDigest
				return machined.WriteResult{Stale: &machined.StaleFile{Path: "daemon.txt", CurrentDigest: &current}}, nil
			}
			require.Equal(t, "hello", string(changes[0].Content))
			return machined.WriteResult{Applied: []machined.AppliedFile{{Path: "daemon.txt", PostDigest: helloDigest}}, Raced: []machined.RacedFile{{Path: "daemon.txt", DisplacedDigest: otherDigest}}}, nil
		}}}
		for _, item := range []struct {
			query    string
			request  string
			status   int
			fragment string
		}{
			{"?path=daemon.txt", `{"content":"hello","base_digest":"absent"}`, 200, `"version":"` + otherDigest + `"`},
			{"?path=daemon.txt", `{"content":"hello","base_digest":"` + helloDigest + `"}`, 409, `"current_digest":"` + otherDigest + `"`},
			{"?path=daemon.txt", `{"content":"hello"}`, 400, "base_digest"},
			{"?path=daemon.txt", `{"content":"offline","base_digest":"absent"}`, 503, `"code":"service_unavailable"`},
			{"?path=daemon.txt", `{"content":"wrong-receipt","base_digest":"absent"}`, 503, `"code":"service_unavailable"`},
			{"?path=daemon.txt", `{"content":"partial-stale","base_digest":"absent"}`, 503, `"code":"service_unavailable"`},
			{"?path=daemon.txt", `{"content":"not-ready","base_digest":"absent"}`, 503, `"code":"service_unavailable"`},
			{"", `{"changes":[{"path":"daemon.txt","content":"hello","base_digest":"absent"},{"path":"second.txt","content":"hello","base_digest":"absent"}]}`, 503, `"code":"service_unavailable"`},
			{"", `{"changes":[{"path":"daemon.txt","content":null,"base_digest":"` + helloDigest + `"}]}`, 503, `"code":"service_unavailable"`},
		} {
			unavailable = strings.Contains(item.request, `"not-ready"`)
			req, err := http.NewRequest("PUT", server.URL+"/api/repos/digestowner/demo/workspaces/"+id+"/files/content"+item.query, strings.NewReader(item.request))
			require.NoError(t, err)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", origin)
			req.Header.Set("X-CSRF-Token", "digest-csrf")
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "digest-csrf"})
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
			response, err := server.Client().Do(req)
			require.NoError(t, err)
			body, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			require.NoError(t, response.Body.Close())
			require.Equal(t, item.status, response.StatusCode, string(body))
			require.Contains(t, string(body), item.fragment)
		}
		// Unsupported transactions and deletions must refuse before the first
		// remote write. Sequential WriteFiles receipts cannot qualify a patch.
		require.Equal(t, 5, calls)
		require.Equal(t, 6, readyCalls)
	})
	t.Run("real unprivileged daemon", func(t *testing.T) {
		binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY")
		if binary == "" {
			t.Skip("requires rehearsal_daemon and Linux user namespaces")
		}
		root := t.TempDir()
		jj, err := rehearsalJJBinary(os.Getenv("PATH"))
		require.NoError(t, err)
		init := exec.Command(jj, "git", "init", root)
		output, err := init.CombinedOutput()
		require.NoError(t, err, string(output))
		registry := new(machined.Registry)
		t.Cleanup(func() { require.NoError(t, registry.Close()) })
		require.NoError(t, startRehearsalMachined(t, ctx, registry, id, root, t.TempDir(), binary, &machined.ItemBinding{}))
		previous, previousReader := provider.writer, provider.reader
		t.Cleanup(func() { provider.writer, provider.reader = previous, previousReader })
		provider.reader = func(ctx context.Context, branch, path string) ([]byte, error) {
			file, err := registry.ReadFile(ctx, branch, path, "")
			if err != nil {
				return nil, workspaceapi.ErrReadFileUnavailable
			}
			return file.Content, nil
		}
		provider.writer = machined.WorkspaceWriter{Client: registry, EnsureReady: func(ctx context.Context, branch string) error {
			link, err := registry.Current(branch)
			if err != nil {
				return err
			}
			return link.RequireReady(branch)
		}}
		const helloDigest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
		for _, check := range []struct {
			body   string
			status int
		}{
			{`{"content":"hello","base_digest":"absent"}`, 200},
			{`{"content":"must not land","base_digest":"absent"}`, 409},
		} {
			request, err := http.NewRequest("PUT", server.URL+"/api/repos/digestowner/demo/workspaces/"+id+"/files/content?path=real.txt", strings.NewReader(check.body))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", origin)
			request.Header.Set("X-CSRF-Token", "digest-csrf")
			request.AddCookie(&http.Cookie{Name: "__csrf", Value: "digest-csrf"})
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
			response, err := server.Client().Do(request)
			require.NoError(t, err)
			body, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			require.NoError(t, response.Body.Close())
			require.Equal(t, check.status, response.StatusCode, string(body))
			require.Contains(t, string(body), helloDigest)
			disk, err := os.ReadFile(filepath.Join(root, "real.txt"))
			require.NoError(t, err)
			require.Equal(t, "hello", string(disk))
		}
		// A host edit is deliberately outside Smithers. The served File door
		// must observe it through the real daemon, with its new digest.
		require.NoError(t, os.WriteFile(filepath.Join(root, "real.txt"), []byte("outside"), 0600))
		read := func(status int, content, digest string) {
			t.Helper()
			request, err := http.NewRequest("GET", server.URL+"/api/repos/digestowner/demo/workspaces/"+id+"/files/content?path=real.txt", nil)
			require.NoError(t, err)
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
			response, err := server.Client().Do(request)
			require.NoError(t, err)
			body, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			require.NoError(t, response.Body.Close())
			require.Equal(t, status, response.StatusCode, string(body))
			if status == 200 {
				require.Contains(t, string(body), `"content":"`+content+`"`)
				require.Contains(t, string(body), `"digest":"`+digest+`"`)
			}
		}
		outsideDigest := fmt.Sprintf("%x", sha256.Sum256([]byte("outside")))
		read(200, "outside", outsideDigest)
		// Loss of the authenticated daemon must not expose a process-runtime
		// fallback for either reads or writes, even while the checkout exists.
		require.NoError(t, registry.Close())
		read(503, "", "")
		request, err := http.NewRequest("PUT", server.URL+"/api/repos/digestowner/demo/workspaces/"+id+"/files/content?path=real.txt", strings.NewReader(`{"content":"offline write","base_digest":"`+outsideDigest+`"}`))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", origin)
		request.Header.Set("X-CSRF-Token", "digest-csrf")
		request.AddCookie(&http.Cookie{Name: "__csrf", Value: "digest-csrf"})
		request.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		response, err := server.Client().Do(request)
		require.NoError(t, err)
		body, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		require.NoError(t, response.Body.Close())
		require.Equal(t, 503, response.StatusCode, string(body))
		disk, err := os.ReadFile(filepath.Join(root, "real.txt"))
		require.NoError(t, err)
		require.Equal(t, "outside", string(disk))
	})

}
