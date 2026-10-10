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
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/machinedfake"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
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

func workspaceFileInstallFixture(t *testing.T, wrap func(*writeReplyRuntime) workspaceapi.WorkspaceRuntime) (*httptest.Server, *writeReplyRuntime, *pgxpool.Pool, string, string) {
	t.Helper()
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
	var composed workspaceapi.WorkspaceRuntime = provider
	if wrap != nil {
		composed = wrap(provider)
	}
	server.Config.Handler = startSplitProcess(t, Options{FlowHostProductAPIURL: origin, Workspace: composed, ChatHost: unusedChatHost{}})
	server.Start()
	t.Cleanup(server.Close)
	return server, provider, pool, id, cookie
}

// Retain the daemon's settlement cause when the HTTP boundary correctly hides
// infrastructure details. This delegates to the real authenticated connection.
type comparedWriteSettlement struct {
	result machined.WriteResult
	err    error
}

type comparedWriteEvidence struct {
	registry *machined.Registry
	t        *testing.T
	prefix   chan comparedWriteSettlement
	attempts chan comparedWriteSettlement
}

func (e comparedWriteEvidence) WriteFiles(ctx context.Context, branch string, actor []byte, changes []machined.FileChange) (machined.WriteResult, error) {
	result, err := e.registry.WriteFiles(ctx, branch, actor, changes)
	select {
	case <-e.attempts:
	default:
	}
	e.attempts <- comparedWriteSettlement{result, err}
	if len(changes) == 2 && changes[0].Path == "batch-prefix" && len(result.Applied) != 0 {
		e.prefix <- comparedWriteSettlement{result, err}
	}
	if err != nil {
		e.t.Logf("daemon compared-write failure: %v; applied=%v", err, result.Applied)
	}
	return result, err
}

func TestWorkspaceFileContentCompareWrite(t *testing.T) {
	server, provider, pool, id, cookie := workspaceFileInstallFixture(t, nil)
	origin := server.URL
	ctx := t.Context()
	row, err := db.New(pool).GetWorkspace(ctx, id)
	require.NoError(t, err)
	ownerID := row.UserID

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
			require.Equal(t, fmt.Sprint(ownerID), op.PrincipalID)
			if unavailable {
				return machined.ErrNotReady
			}
			return nil
		}, Client: &machinedfake.Client{OnWriteFiles: func(_ context.Context, branch string, actor []byte, changes []machined.FileChange) (machined.WriteResult, error) {
			calls++
			require.GreaterOrEqual(t, readyCalls, calls, "readiness must precede each write")
			require.Equal(t, id, branch)
			require.Equal(t, fmt.Sprint(ownerID), string(actor))
			require.NotEmpty(t, changes)
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
			{"", `{"changes":[{"path":"daemon.txt","content":null,"base_digest":"` + helloDigest + `"}]}`, 409, `"code":"stale"`},
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
		// Incomplete batch/deletion receipts are refused after one batch dispatch.
		require.Equal(t, 7, calls)
		require.Equal(t, 8, readyCalls)
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
		native := repohostffi.New(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
		require.NoError(t, native.Load())
		config := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "stale-save-campaign"}
		repository := config.RepoPath("digestowner", "demo")
		_, err = native.InitRepo(repository)
		require.NoError(t, err)
		hostRepo := filepath.Join(repository, ".jj", "repo", "store", "git")
		host, err := repohostserver.NewWithFFI(config, native)
		require.NoError(t, err)
		t.Cleanup(func() { require.NoError(t, host.Shutdown(context.Background())) })
		client := repohost.NewLocalClient(http.NotFoundHandler(), config.AuthToken)
		client.BindMachineRepository(host.WithMachineRepository)
		baseCommand := exec.Command(jj, "log", "-r", "@", "--no-graph", "-T", "commit_id")
		baseCommand.Dir = root
		baseBytes, err := baseCommand.Output()
		require.NoError(t, err)
		base := strings.TrimSpace(string(baseBytes))
		output, err = exec.Command("/usr/bin/git", "-C", hostRepo, "fetch", filepath.Join(root, ".git"), base).CombinedOutput()
		require.NoError(t, err, string(output))
		output, err = exec.Command("/usr/bin/git", "-C", hostRepo, "update-ref", "refs/smithers/branches/"+id+"/head", base).CombinedOutput()
		require.NoError(t, err, string(output))
		_, err = pool.Exec(ctx, "UPDATE workspaces SET head_commit_id=$2 WHERE id=$1", id, base)
		require.NoError(t, err)
		registry := new(machined.Registry)
		t.Cleanup(bindMachineObjects(ctx, registry, pool, client))
		t.Cleanup(func() { require.NoError(t, registry.Close()) })
		// Native writes emit durable watcher/capture events as well as RPC replies.
		// The production dispatcher commits their receipts before acknowledging;
		// without it, an otherwise valid long campaign fills the inbound queue.
		stop, err := bindMachineEvents(ctx, registry, pool, client, nil, nil)
		require.NoError(t, err)
		t.Cleanup(stop)
		evidence := t.TempDir()
		t.Cleanup(func() {
			if t.Failed() {
				log, err := os.ReadFile(filepath.Join(evidence, "machined-"+id+".log"))
				if err == nil {
					t.Logf("daemon failure evidence: %s", log)
				}
			}
		})
		require.NoError(t, startRehearsalMachined(t, ctx, registry, id, root, evidence, binary, &machined.ItemBinding{}))
		previous, previousReader := provider.writer, provider.reader
		t.Cleanup(func() { provider.writer, provider.reader = previous, previousReader })
		provider.reader = func(ctx context.Context, branch, path string) ([]byte, error) {
			file, err := registry.ReadFile(ctx, branch, path, "")
			if err != nil {
				return nil, workspaceapi.ErrReadFileUnavailable
			}
			return file.Content, nil
		}
		prefix := make(chan comparedWriteSettlement, 1)
		attempts := make(chan comparedWriteSettlement, 1)
		provider.writer = machined.WorkspaceWriter{Client: comparedWriteEvidence{registry, t, prefix, attempts}, EnsureReady: func(ctx context.Context, branch string) error {
			link, err := registry.Current(branch)
			if err != nil {
				return err
			}
			return link.RequireReady(branch)
		}}
		// Two authenticated people use the same composed GET/PUT door. The
		// daemon is real; user namespaces are not fresh/retained Mac evidence.
		q := db.New(pool)
		member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "digestmember", LowerUsername: "digestmember"})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, row.RepositoryID, member.ID)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO workspace_shares(workspace_id,owner_user_id,grantee_user_id,level) VALUES($1,$2,$3,'write')`, id, ownerID, member.ID)
		require.NoError(t, err)
		const memberCookie = "digest-member-cookie"
		memberHash := sha256.Sum256([]byte(memberCookie))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: member.ID, Username: member.Username, SessionKey: hex.EncodeToString(memberHash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		// Native capture changes jj metadata; outside saves settle asynchronously.
		// Their preflight may refuse without applying anything. A person
		// re-reads before retrying; never retry a partial/unknown settlement.
		retryPreflight := func(t *testing.T, body string, status, actual, attempt int) bool {
			t.Helper()
			var settled comparedWriteSettlement
			select {
			case settled = <-attempts:
			default:
				return false
			}
			var refusal *machined.SessionError
			if attempt >= 10 || (status == 503 && !strings.Contains(body, `"path":"batch-prefix"`)) || actual != 503 ||
				!errors.As(settled.err, &refusal) ||
				!((refusal.Code == "not_ready" && strings.Contains(refusal.Detail, "moved-off check required")) ||
					(refusal.Code == "busy" && strings.Contains(refusal.Detail, "outside writes are still settling"))) ||
				!settled.result.Preflight || len(settled.result.Applied) != 0 || len(settled.result.Raced) != 0 || settled.result.Stale != nil {
				return false
			}
			var envelope struct {
				Base    string `json:"base_digest"`
				Changes []struct {
					Path string `json:"path"`
					Base string `json:"base_digest"`
				} `json:"changes"`
			}
			require.NoError(t, json.Unmarshal([]byte(body), &envelope))
			if len(envelope.Changes) == 0 {
				envelope.Changes = append(envelope.Changes, struct {
					Path string `json:"path"`
					Base string `json:"base_digest"`
				}{"real.txt", envelope.Base})
			}
			for _, change := range envelope.Changes {
				bytes, err := os.ReadFile(filepath.Join(root, change.Path))
				if change.Base == "absent" {
					require.ErrorIs(t, err, os.ErrNotExist)
				} else {
					require.NoError(t, err)
					digest := sha256.Sum256(bytes)
					require.Equal(t, change.Base, hex.EncodeToString(digest[:]), "refused preflight changed bytes")
				}
			}
			t.Log("re-read unchanged bases after authenticated preflight refusal")
			time.Sleep(250 * time.Millisecond)
			return true
		}
		call := func(method, actorCookie, body string, status int) []byte {
			t.Helper()
			for attempt := 0; ; attempt++ {
				req, err := http.NewRequest(method, server.URL+"/api/repos/digestowner/demo/workspaces/"+id+"/files/content?path=real.txt", strings.NewReader(body))
				require.NoError(t, err)
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", origin)
				req.Header.Set("X-CSRF-Token", "digest-csrf")
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "digest-csrf"})
				req.AddCookie(&http.Cookie{Name: "smithers_session", Value: actorCookie})
				res, err := server.Client().Do(req)
				require.NoError(t, err)
				data, err := io.ReadAll(res.Body)
				require.NoError(t, err)
				require.NoError(t, res.Body.Close())
				if method == "PUT" && retryPreflight(t, body, status, res.StatusCode, attempt) {
					continue
				}
				require.Equal(t, status, res.StatusCode, string(data))
				return data
			}
		}
		const helloDigest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
		const worldDigest = "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7"
		call("PUT", cookie, `{"content":"hello","base_digest":"absent"}`, 200)
		before := call("GET", cookie, "", 200)
		require.Contains(t, string(before), `"digest":"`+helloDigest+`"`)
		require.Contains(t, string(before), `"content":"hello"`)
		call("PUT", memberCookie, `{"content":"world","base_digest":"`+helloDigest+`"}`, 200)
		refused := call("PUT", cookie, `{"content":"lost update","base_digest":"`+helloDigest+`"}`, 409)
		require.JSONEq(t, `{"code":"stale","current_digest":"`+worldDigest+`"}`, string(refused))
		for _, body := range []string{
			`{"content":"blind"}`,
			`{"content":"blind","base_digest":"` + worldDigest + `","actor":"owner"}`,
			`{"content":"blind","base_digest":"` + worldDigest + `","branch":"main"}`,
			`{"content":"blind","base_digest":"` + worldDigest + `","machine":"fixture"}`,
			`{"content":"blind","base_digest":"` + worldDigest + `","uid":0}`,
		} {
			call("PUT", cookie, body, 400)
		}
		after := call("GET", cookie, "", 200)
		require.Contains(t, string(after), `"content":"world"`)
		require.Contains(t, string(after), `"digest":"`+worldDigest+`"`)
		disk, err := os.ReadFile(filepath.Join(root, "real.txt"))
		require.NoError(t, err)
		require.Equal(t, []byte("world"), disk)
		// Qualify a new item's capture before the unrelated outside-save campaign
		// can leave a stale capture requiring reconciliation on this branch.
		t.Run("capture pending work", func(t *testing.T) {
			// A person's PUT enters the real daemon; capture drains its outbox
			// through the install's authenticated consumer before we inspect SQL.
			settledCapture := func() (machined.CaptureResult, error) {
				t.Helper()
				var result machined.CaptureResult
				var captureErr error
				require.Eventually(t, func() bool {
					bursts, docs, err := registry.IdleSafety(ctx, id)
					if err != nil || !bursts || !docs {
						return false
					}
					result, captureErr = registry.Capture(ctx, id)
					// A snapshot's jj metadata may still be in the watcher debounce.
					// Re-enter only after fresh quiet evidence, as sleep requires.
					return !errors.Is(captureErr, machined.ErrNotReady)
				}, 10*time.Second, 25*time.Millisecond)
				return result, captureErr
			}

			accepted, err := settledCapture()
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,state,landed_main) VALUES($1,'active',$2)`, row.RepositoryID, base)
			require.NoError(t, err)
			var item string
			require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,workspace_id,candidate_base,candidate_head,candidate_verified,attempt,generation,checks) VALUES($1,'todo','proposed',$2,$3,$4,true,1,1,'{"todo":true}') RETURNING id::text`, row.RepositoryID, id, base, accepted.Head).Scan(&item))
			state := func(wantVerified bool, wantWake int64, wantTree string) {
				t.Helper()
				var verified bool
				var wakes int64
				var pending []byte
				require.NoError(t, pool.QueryRow(ctx, `SELECT candidate_verified,checks->'capture' FROM mythical_items WHERE id=$1`, item).Scan(&verified, &pending))
				require.Equal(t, wantVerified, verified)
				require.NoError(t, pool.QueryRow(ctx, `SELECT requested_generation FROM mythical_stacks WHERE repository_id=$1`, row.RepositoryID).Scan(&wakes))
				require.Equal(t, wantWake, wakes)
				if wantTree == "" {
					require.Empty(t, pending)
				} else {
					var work struct {
						Tree string `json:"tree"`
					}
					require.NoError(t, json.Unmarshal(pending, &work))
					if wantTree != work.Tree {
						diff, e := exec.Command("/usr/bin/git", "-C", hostRepo, "diff", wantTree, work.Tree, "--", "real.txt").CombinedOutput()
						require.NoError(t, e)
						t.Logf("pending capture tree differs: %s", diff)
					}
					require.Equal(t, wantTree, work.Tree)
				}
			}
			var initial int64
			require.NoError(t, pool.QueryRow(ctx, `SELECT requested_generation FROM mythical_stacks WHERE repository_id=$1`, row.RepositoryID).Scan(&initial))
			_, err = settledCapture()
			require.NoError(t, err)
			state(true, initial, "")
			var current struct {
				Content string `json:"content"`
				Digest  string `json:"digest"`
			}
			require.NoError(t, json.Unmarshal(call("GET", cookie, "", 200), &current))
			body, err := json.Marshal(map[string]string{"content": "pending member edit\n", "base_digest": current.Digest})
			require.NoError(t, err)
			call("PUT", memberCookie, string(body), 200)
			edited, err := settledCapture()
			require.NoError(t, err)
			require.NotEqual(t, accepted.Tree, edited.Tree)
			state(false, initial+1, edited.Tree)
			// A new capture request is more than replaying the same frame.
			for range 2 {
				repeated, err := settledCapture()
				require.NoError(t, err)
				if edited.Tree != repeated.Tree {
					diff, e := exec.Command("/usr/bin/git", "-C", hostRepo, "diff", "--stat", edited.Tree, repeated.Tree).CombinedOutput()
					require.NoError(t, e)
					t.Fatalf("capture changed without a write: %s -> %s: %s", edited.Tree, repeated.Tree, diff)
				}
				state(false, initial+1, edited.Tree)
			}
			// Leave the following independent compare-write campaign its fixed
			// world digest, using the person's guarded write door.
			pendingDigest := fmt.Sprintf("%x", sha256.Sum256([]byte("pending member edit\n")))
			call("PUT", cookie, `{"content":"world","base_digest":"`+pendingDigest+`"}`, 200)
		})
		t.Run("batch delete move and later stale through HTTP", func(t *testing.T) {
			request := func(body string, status int) []byte {
				t.Helper()
				for attempt := 0; ; attempt++ {
					req, err := http.NewRequest("PUT", server.URL+"/api/repos/digestowner/demo/workspaces/"+id+"/files/content", strings.NewReader(body))
					require.NoError(t, err)
					req.Header.Set("Content-Type", "application/json")
					req.Header.Set("Origin", origin)
					req.Header.Set("X-CSRF-Token", "digest-csrf")
					req.AddCookie(&http.Cookie{Name: "__csrf", Value: "digest-csrf"})
					req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
					res, err := server.Client().Do(req)
					require.NoError(t, err)
					bodyBytes, err := io.ReadAll(res.Body)
					require.NoError(t, err)
					require.NoError(t, res.Body.Close())
					if retryPreflight(t, body, status, res.StatusCode, attempt) {
						continue
					}
					require.Equal(t, status, res.StatusCode, string(bodyBytes))
					return bodyBytes
				}
			}
			bytesAt := func(path, want string) {
				t.Helper()
				got, err := os.ReadFile(filepath.Join(root, path))
				require.NoError(t, err)
				require.Equal(t, want, string(got))
			}
			missing := func(path string) {
				t.Helper()
				_, err := os.Stat(filepath.Join(root, path))
				require.ErrorIs(t, err, os.ErrNotExist)
			}
			// Request admission is exercised while the real daemon is available.
			// A valid earlier entry must remain untouched when a later entry is
			// malformed, escapes confinement, or tries to supply an identity.
			request(`{"changes":[{"path":"admission-prefix","content":"hello","base_digest":"absent"}]}`, 200)
			for _, tail := range []string{
				`{"path":"admission-new","content":"world"}`,
				`{"path":"admission-new","content":"world","base_digest":"invalid"}`,
				`{"path":"../admission-outside","content":"world","base_digest":"absent"}`,
				`{"path":"/admission-outside","content":"world","base_digest":"absent"}`,
				`{"path":"admission-prefix","content":"world","base_digest":"absent"}`,
				`{"path":"admission-prefix/child","content":"world","base_digest":"absent"}`,
			} {
				request(`{"changes":[{"path":"admission-prefix","content":"world","base_digest":"`+helloDigest+`"},`+tail+`]}`, 400)
				bytesAt("admission-prefix", "hello")
				missing("admission-new")
			}
			for _, field := range []string{"actor", "branch", "machine", "uid"} {
				request(`{"changes":[{"path":"admission-prefix","content":"world","base_digest":"`+helloDigest+`"}],"`+field+`":"injected"}`, 400)
				bytesAt("admission-prefix", "hello")
			}
			request(`{"changes":[{"path":"admission-prefix","content":"world","base_digest":"`+helloDigest+`"},{"path":"admission-new","content":"`+strings.Repeat("x", 1024*1024)+`","base_digest":"absent"}]}`, 413)
			bytesAt("admission-prefix", "hello")
			missing("admission-new")
			// Supplemental Linux confinement evidence through HTTP. The namespace
			// cannot substitute for fresh/retained-machine privilege receipts.
			outside := t.TempDir()
			protected := filepath.Join(outside, "protected")
			require.NoError(t, os.WriteFile(protected, []byte("outside remains"), 0600))
			require.NoError(t, os.Symlink(protected, filepath.Join(root, "admission-link")))
			require.NoError(t, os.Symlink(outside, filepath.Join(root, "admission-ancestor")))
			for _, path := range []string{"admission-link", "admission-ancestor/protected"} {
				request(`{"changes":[{"path":"admission-prefix","content":"world","base_digest":"`+helloDigest+`"},{"path":"`+path+`","content":"must not land","base_digest":"absent"}]}`, 503)
				bytesAt("admission-prefix", "hello")
				got, err := os.ReadFile(protected)
				require.NoError(t, err)
				require.Equal(t, "outside remains", string(got))
			}
			// Empty bytes are a present file, distinct from a deletion receipt.
			const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
			empty := request(`{"changes":[{"path":"batch-empty","content":"","base_digest":"absent"}]}`, 200)
			require.Contains(t, string(empty), emptyDigest)
			bytesAt("batch-empty", "")
			request(`{"changes":[{"path":"batch-empty","content":null,"base_digest":"absent"}]}`, 409)
			bytesAt("batch-empty", "")
			request(`{"changes":[{"path":"batch-empty","content":null,"base_digest":"`+emptyDigest+`"}]}`, 200)
			missing("batch-empty")
			request(`{"changes":[{"path":"batch-a","content":"hello","base_digest":"absent"},{"path":"batch-b","content":"world","base_digest":"absent"}]}`, 200)
			bytesAt("batch-a", "hello")
			bytesAt("batch-b", "world")
			// A stale later source must not remove the earlier source or create
			// the destination. Expectations are fixed, independent SHA fixtures.
			refused := request(`{"changes":[{"path":"batch-a","content":null,"base_digest":"`+helloDigest+`"},{"path":"batch-b","content":null,"base_digest":"`+helloDigest+`"},{"path":"batch-dest","content":"hello","base_digest":"absent"}]}`, 409)
			require.Contains(t, string(refused), `"path":"batch-b"`)
			require.Contains(t, string(refused), worldDigest)
			bytesAt("batch-a", "hello")
			bytesAt("batch-b", "world")
			missing("batch-dest")
			// An outside creation invalidates an absent move destination.
			require.NoError(t, os.WriteFile(filepath.Join(root, "batch-dest"), []byte("world"), 0600))
			refused = request(`{"changes":[{"path":"batch-a","content":null,"base_digest":"`+helloDigest+`"},{"path":"batch-dest","content":"hello","base_digest":"absent"}]}`, 409)
			require.Contains(t, string(refused), `"path":"batch-dest"`)
			bytesAt("batch-a", "hello")
			bytesAt("batch-dest", "world")
			request(`{"changes":[{"path":"batch-a","content":null,"base_digest":"`+helloDigest+`"},{"path":"batch-dest","content":"hello","base_digest":"`+worldDigest+`"},{"path":"batch-b","content":null,"base_digest":"`+worldDigest+`"}]}`, 200)
			missing("batch-a")
			missing("batch-b")
			bytesAt("batch-dest", "hello")
			request(`{"changes":[{"path":"batch-dest","content":null,"base_digest":"`+worldDigest+`"}]}`, 409)
			bytesAt("batch-dest", "hello")
			request(`{"changes":[{"path":"batch-dest","content":null,"base_digest":"`+helloDigest+`"}]}`, 200)
			missing("batch-dest")
			// A real filesystem application failure is distinct from stale
			// preflight: the first durable write stays, and HTTP never reports
			// success or a stale no-op for the partially applied batch.
			request(`{"changes":[{"path":"batch-prefix","content":"hello","base_digest":"absent"}]}`, 200)
			locked := filepath.Join(root, "batch-locked")
			require.NoError(t, os.Mkdir(locked, 0555))
			t.Cleanup(func() { require.NoError(t, os.Chmod(locked, 0755)) })
			request(`{"changes":[{"path":"batch-prefix","content":"world","base_digest":"`+helloDigest+`"},{"path":"batch-locked/new","content":"hello","base_digest":"absent"}]}`, 503)
			bytesAt("batch-prefix", "world")
			select {
			case settlement := <-prefix:
				require.Error(t, settlement.err)
				require.Nil(t, settlement.result.Stale, "an applied prefix is never a stale no-op")
				require.Equal(t, []machined.AppliedFile{{Path: "batch-prefix", PostDigest: worldDigest}}, settlement.result.Applied)
			default:
				t.Fatal("HTTP failure never reached the authenticated daemon batch")
			}
			missing("batch-locked/new")
			// End the external I/O fault after proving failure and the durable
			// prefix. Recovery/flush in the independent capture check must not
			// remain blocked by this deliberately unwritable directory.
			require.NoError(t, os.Chmod(locked, 0755))
		})
		// Restore the fixture through the same guarded door before running
		// independent outside-replacement and provider-loss checks below.
		call("PUT", cookie, `{"content":"hello","base_digest":"`+worldDigest+`"}`, 200)
		for _, check := range []struct {
			body         string
			status       int
			outside      bool
			want, digest string
		}{

			{`{"content":"must not land","base_digest":"absent"}`, 409, false, "hello", helloDigest},
			{`{"content":"must not replace outside","base_digest":"` + helloDigest + `"}`, 409, true, "world", "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7"},
		} {
			if check.outside {
				temp := filepath.Join(root, "outside-save")
				require.NoError(t, os.WriteFile(temp, []byte(check.want), 0600))
				require.NoError(t, os.Rename(temp, filepath.Join(root, "real.txt")))
			}
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
			require.Contains(t, string(body), check.digest)
			disk, err := os.ReadFile(filepath.Join(root, "real.txt"))
			require.NoError(t, err)
			require.Equal(t, check.want, string(disk))
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
		// C-COL-03 W4 completed-outside-save boundary. This campaign does not
		// pause between compare and swap or qualify the full W1-W4 VM matrix.
		t.Run("outside save stale HTTP 100 runs", func(t *testing.T) {
			baseDigest := outsideDigest
			for run := 0; run < 100; run++ {
				content := fmt.Sprintf("outside save %03d\n", run)
				temporary := filepath.Join(root, "outside-save")
				require.NoError(t, os.WriteFile(temporary, []byte(content), 0600))
				require.NoError(t, os.Rename(temporary, filepath.Join(root, "real.txt")))
				request, err := http.NewRequest("PUT", server.URL+"/api/repos/digestowner/demo/workspaces/"+id+"/files/content?path=real.txt", strings.NewReader(`{"content":"must not replace outside","base_digest":"`+baseDigest+`"}`))
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
				require.Equal(t, 409, response.StatusCode, "run %d: %s", run, body)
				require.Contains(t, string(body), `"code":"stale"`)
				baseDigest = fmt.Sprintf("%x", sha256.Sum256([]byte(content)))
				require.Contains(t, string(body), baseDigest)
				disk, err := os.ReadFile(filepath.Join(root, "real.txt"))
				require.NoError(t, err)
				require.Equal(t, content, string(disk), "run %d", run)
			}
		})
		// Durable outside events must have reached the real transactional
		// consumer. Final capture convergence is a separate qualification.
		require.Eventually(t, func() bool {
			var receipts int
			return pool.QueryRow(ctx, "SELECT count(*) FROM machine_event_receipts WHERE workspace_id=$1", id).Scan(&receipts) == nil && receipts > 0
		}, 10*time.Second, 100*time.Millisecond)

		// Restore the fixed oracle used by the subsequent offline refusal.
		require.NoError(t, os.WriteFile(filepath.Join(root, "real.txt"), []byte("outside"), 0600))
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
		disk, err = os.ReadFile(filepath.Join(root, "real.txt"))
		require.NoError(t, err)
		require.Equal(t, "outside", string(disk))
	})

}

// The guest admission result is injected; router, authority, retirement and
// state publication are production code with real PostgreSQL. This is host
// boundary evidence, not the fresh/retained real-VM prerequisite campaign.
type refusedAdmissionRuntime struct {
	*writeReplyRuntime
	admissionErr, retirementErr error
	admissions, retirements     int
}

func (r *refusedAdmissionRuntime) EnsureMachined(context.Context, string) error {
	r.admissions++
	return r.admissionErr
}
func (r *refusedAdmissionRuntime) StopService(context.Context, string, string) error {
	r.retirements++
	return r.retirementErr
}

func TestMachinedProductionBoundaryFailClosed(t *testing.T) {
	for _, phase := range []string{"retire publisher", "reconcile boot", "admitted"} {
		t.Run(phase, func(t *testing.T) {
			var runtime *refusedAdmissionRuntime
			server, _, pool, id, cookie := workspaceFileInstallFixture(t, func(base *writeReplyRuntime) workspaceapi.WorkspaceRuntime {
				runtime = &refusedAdmissionRuntime{writeReplyRuntime: base}
				if phase == "retire publisher" {
					runtime.retirementErr = errors.New("retirement refused")
				}
				if phase == "reconcile boot" {
					runtime.admissionErr = errors.New("reconciliation refused")
				}
				return runtime
			})
			q := db.New(pool)
			row, err := q.GetWorkspace(t.Context(), id)
			require.NoError(t, err)
			oldToken, err := q.CreateAccessToken(t.Context(), db.CreateAccessTokenParams{UserID: row.UserID, Name: "retired reporter", TokenHash: strings.Repeat("d", 64), TokenLastEight: "dddddddd", Scopes: "write:repository", SystemIssued: true})
			require.NoError(t, err)
			_, err = pool.Exec(t.Context(), "UPDATE workspaces SET status='starting',head_push_token_id=$2 WHERE id=$1", id, oldToken.ID)
			require.NoError(t, err)
			req, err := http.NewRequest("PUT", server.URL+"/api/repos/digestowner/demo/workspaces/"+id+"/files/content?path=a", strings.NewReader(`{"content":"new","base_digest":"absent"}`))
			require.NoError(t, err)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", server.URL)
			req.Header.Set("X-CSRF-Token", "admission-csrf")
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "admission-csrf"})
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
			response, err := server.Client().Do(req)
			require.NoError(t, err)
			body, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			response.Body.Close()
			var status, head string
			var sessions int
			require.NoError(t, pool.QueryRow(t.Context(), "SELECT status,head_commit_id FROM workspaces WHERE id=$1", id).Scan(&status, &head))
			require.NoError(t, pool.QueryRow(t.Context(), "SELECT count(*) FROM workspace_sessions WHERE workspace_id=$1", id).Scan(&sessions))
			require.Empty(t, head)
			require.Zero(t, sessions)
			require.Equal(t, 1, runtime.retirements)
			var live bool
			require.NoError(t, pool.QueryRow(t.Context(), "SELECT EXISTS(SELECT 1 FROM access_tokens WHERE id=$1)", oldToken.ID).Scan(&live))
			require.Equal(t, phase == "retire publisher", live, "retirement must precede daemon admission, including failed admission")
			if phase == "admitted" {
				require.Equal(t, 200, response.StatusCode, string(body))
				require.Equal(t, "running", status)
				require.Equal(t, 1, runtime.admissions)
			} else {
				require.Equal(t, 503, response.StatusCode, string(body))
				require.JSONEq(t, `{"code":"service_unavailable","class":"infra","fault":"infra","message":"service unavailable"}`, string(body))
				// Failed starts are settled and reaped before returning the refusal.
				require.Equal(t, "failed", status)
				if phase == "retire publisher" {
					require.Zero(t, runtime.admissions)
				} else {
					require.Equal(t, 1, runtime.admissions)
				}
			}
		})
	}
}
