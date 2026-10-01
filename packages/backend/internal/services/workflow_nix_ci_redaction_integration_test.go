package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/require"
)

// The VM execution port controls poll boundaries; every secret write/read,
// producer byte, log transaction, notification and replay is real. A local Bash
// producer exercises this contract without provisioning a NixOS guest.
func TestNixCIStreamEncryptedMultilineSecretsReachOnlyRedactedReplay(t *testing.T) {
	for _, newline := range []struct{ name, value string }{{"LF", "\n"}, {"CRLF", "\r\n"}} {
		for _, partition := range []string{"whole", "internal_newline", "before_LF", "single_byte"} {
			t.Run(newline.name+"/"+partition, func(t *testing.T) {
				pool := newProductTestPool(t)
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cancel()
				q := db.New(pool)
				repositoryID, definitionID := sandboxClaimFixture(t, pool)
				runID := sandboxClaimRun(t, pool, repositoryID, definitionID, "sandbox", "queued", "push")
				store := NewProductWorkflowSandboxScheduler(q)
				claims, err := store.ClaimQueuedWorkflowRuns(ctx, 1)
				require.NoError(t, err)
				require.Len(t, claims, 1)
				require.Equal(t, runID, claims[0].ID)
				require.Equal(t, "running", sandboxClaimStatus(t, pool, runID))
				repository, err := q.GetRepoByID(ctx, repositoryID)
				require.NoError(t, err)
				require.True(t, repository.UserID.Valid)
				owner, err := q.GetUserByID(ctx, repository.UserID.Int64)
				require.NoError(t, err)
				codec, err := webhook.NewSecretCodec("nix-ci-multiline-integration")
				require.NoError(t, err)
				api := NewWorkflowAPIService(q, nil)
				logsSince := func(afterID int64) []db.WorkflowLog {
					logs, err := api.ListWorkflowLogsSince(ctx, runID, afterID, 100)
					require.NoError(t, err)
					return logs
				}
				secret := "fixture-private-key-first-line" + newline.value + "fixture-private-key-second-line"
				_, err = NewSecretService(q, codec, WithSecretOwnershipGuard(NewRepoOwnershipFence(pool))).SetSecret(ctx, &owner, owner.Username, repository.Name, "PRIVATE_KEY", secret, nil, nil)
				require.NoError(t, err)
				encrypted, err := q.GetSecretValueByName(ctx, db.GetSecretValueByNameParams{RepositoryID: repositoryID, Name: "PRIVATE_KEY"})
				require.NoError(t, err)
				require.NotContains(t, string(encrypted), "fixture-private-key")
				environment, redaction, err := NewSecretInjector(q, codec).RepositoryEnvironmentAndSecrets(ctx, repositoryID, true)
				require.NoError(t, err)
				require.Equal(t, secret, environment["PRIVATE_KEY"])
				require.Equal(t, secret, redaction["PRIVATE_KEY"])
				bash, err := exec.LookPath("bash")
				require.NoError(t, err, "the real producer is required, never skipped")
				producer := exec.CommandContext(ctx, bash, "-c", `printf 'ordinary\nbefore %s after\nnext\n' "$PRIVATE_KEY"`)
				producer.Env = []string{"PRIVATE_KEY=" + environment["PRIVATE_KEY"]}
				output, err := producer.Output()
				require.NoError(t, err)
				text := string(output)
				require.Equal(t, "ordinary\nbefore "+secret+" after\nnext\n", text)
				chunks := []string{text}
				// Locate the secret's internal newline, after the ordinary prefix.
				boundary := strings.Index(text, "fixture-private-key-first-line") + len("fixture-private-key-first-line") + len(newline.value)
				switch partition {
				case "internal_newline":
					chunks = []string{text[:boundary], text[boundary:]}
				case "before_LF":
					boundary--
					chunks = []string{text[:boundary], text[boundary:]}
				case "single_byte":
					chunks = make([]string, len(text))
					for i := range text {
						chunks[i] = text[i : i+1]
					}
				}
				step, err := q.CreateWorkflowStep(ctx, db.CreateWorkflowStepParams{WorkflowRunID: runID, Name: "print", Position: 1, Status: "running"})
				require.NoError(t, err)
				listener, err := pool.Acquire(ctx)
				require.NoError(t, err)
				defer listener.Release()
				channel := fmt.Sprintf("workflow_run_%d", runID)
				_, err = listener.Exec(ctx, "LISTEN "+channel)
				require.NoError(t, err)
				polls := 0
				client := &mockWorkflowSandboxVMClient{}
				client.execAwaitFn = func(_ context.Context, _ string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
					// Ordinary output must be durable before the next poll, while a
					// partial secret still waits and the job has not announced exit.
					if polls == 1 && partition == "internal_newline" {
						logs := logsSince(0)
						require.Len(t, logs, 1)
						require.Equal(t, "ordinary", logs[0].Entry)
					}
					offset := 1
					for _, chunk := range chunks[:polls] {
						offset += len(chunk)
					}
					require.Contains(t, request.Command, fmt.Sprintf("tail -c +%d ", offset))
					ok := int32(0)
					if polls < len(chunks) {
						chunk := chunks[polls]
						polls++
						return sandbox.ExecResult{Stdout: chunk, StatusCode: &ok}, nil
					}
					return sandbox.ExecResult{Stderr: nixCITaskExitMarker + "0", StatusCode: &ok}, nil
				}
				worker := NewWorkflowSandboxSchedulerWorker(store, client, WithWorkflowSandboxSchedulerCIPollInterval(time.Millisecond))
				code, outcome := worker.streamNixCITask(ctx, "controlled-poll-port", nixCITask{ID: 1, WorkflowRunID: runID, StepID: step.ID}, nixCIRunEnvironment{RedactEnv: redaction})
				require.Equal(t, int32(0), code)
				require.Equal(t, nixCITaskDone, outcome)
				require.Equal(t, len(chunks), polls)
				logs := logsSince(0)
				expected := []string{"ordinary", "before " + redactedSecretValue + " after", "next"}
				require.Len(t, logs, len(expected))
				for i, log := range logs {
					require.Equal(t, expected[i], log.Entry)
					require.Equal(t, int64(i+1), log.Sequence)
					require.NotContains(t, log.Entry, "fixture-private-key")
					notification, err := listener.Conn().WaitForNotification(ctx)
					require.NoError(t, err)
					require.Equal(t, channel, notification.Channel)
					var event struct {
						Entry string `json:"entry"`
						ID    int64  `json:"log_id"`
					}
					require.NoError(t, json.Unmarshal([]byte(notification.Payload), &event))
					require.Equal(t, log.Entry, event.Entry)
					require.Equal(t, log.ID, event.ID)
					require.NotContains(t, notification.Payload, "fixture-private-key")
				}
				after := logsSince(logs[0].ID)
				require.Equal(t, logs[1:], after, "reconnect replay preserves the same safe rows")
			})
		}
	}
}
