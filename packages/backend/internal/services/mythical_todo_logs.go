package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"io"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

const todoLogLimit = 10 << 20

func (s *MythicalService) SetTodoLogStore(store blob.Store) { s.todoLogs = store }
func todoLogKey(repository int64, digest string) string {
	return fmt.Sprintf("repos/%d/todo-logs/%s", repository, digest)
}

// Blob writes precede the item transaction commit. Failed transactions leave
// unreachable content, never a published evidence reference without its bytes.
func (s *MythicalService) persistTodoLogs(ctx context.Context, item *db.MythicalItem) error {
	if !mythicalTodo(*item) {
		return nil
	}
	checks := mythicalChecksOf(*item)
	if checks.Receipts == nil {
		return nil
	}
	for i := range checks.Receipts.Checks {
		receipt := &checks.Receipts.Checks[i]
		if receipt.Evidence == "" {
			continue
		}
		if len(receipt.Evidence) > todoLogLimit {
			return fmt.Errorf("TODO log exceeds retention limit")
		}
		if s.todoLogs == nil {
			return fmt.Errorf("TODO log store unavailable")
		}
		hash := sha256.Sum256([]byte(receipt.Evidence))
		digest := hex.EncodeToString(hash[:])
		if err := blob.Put(ctx, s.todoLogs, todoLogKey(item.RepositoryID, digest), "text/plain", strings.NewReader(receipt.Evidence)); err != nil {
			return err
		}
		receipt.LogDigest, receipt.Evidence = digest, ""
	}
	item.Checks = checks.encode()
	return nil
}

// TodoLog serves only a digest retained by the named attempt of this item.
func (s *MythicalService) TodoLog(ctx context.Context, repository, number int64, attempt int32, digest string) ([]byte, error) {
	missing := &TodoControlError{404, "not_found", "user", "Log not found"}
	decoded, err := hex.DecodeString(digest)
	if err != nil || len(decoded) != sha256.Size || digest != strings.ToLower(digest) || attempt <= 0 {
		return nil, missing
	}
	if InstallExecutionCredential(ctx) {
		if _, err := Authorize(ctx, s.queries(), "todo.read", InstallSubject{RepositoryID: repository, TodoNumber: number, Attempt: attempt, PayloadDigest: digest}); err != nil {
			return nil, err
		}
	}
	item, err := s.queries().GetMythicalItemByNumber(ctx, repository, number)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, missing
	}
	if err != nil {
		return nil, err
	}
	if InstallExecutionCredential(ctx) {
		info := middleware.AuthInfoFromContext(ctx)
		workspace := info.WorkspaceRestriction()
		if info.CredentialKind() == middleware.CredentialAgentRun {
			workspace = middleware.ParseTokenLandingWorkspace(info.RawScopes)
		}
		if item.WorkspaceID != workspace || item.RequestRunID == "" || item.Attempt != attempt {
			return nil, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Credential cannot read this log"}
		}
	}
	allowed := false
	references := func(items []map[string]any) bool {
		for _, entry := range items {
			if entry["log_digest"] == digest {
				return true
			}
		}
		return false
	}
	// Authorization uses retained source references, including a current
	// attempt snapshot whose candidate has since changed.
	attempts := append(mythicalChecksOf(item).Attempts, currentTodoEvidence(item))
	for _, evidence := range attempts {
		if evidence.Attempt != attempt {
			continue
		}
		if references(evidence.Items) || evidence.Previous != nil && references(evidence.Previous.Items) {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, missing
	}
	if s.todoLogs == nil {
		return nil, fmt.Errorf("TODO log store unavailable")
	}
	reader, err := s.todoLogs.NewReader(ctx, todoLogKey(repository, digest))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	payload, err := io.ReadAll(io.LimitReader(reader, todoLogLimit+1))
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(payload)
	if len(payload) > todoLogLimit || hex.EncodeToString(hash[:]) != digest {
		return nil, fmt.Errorf("TODO log integrity failure")
	}
	return payload, nil
}
