package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestCreateDesktopSessionRejectsInvalidCreatorBeforeStoreOrProvider(t *testing.T) {
	for _, userID := range []int64{0, -1} {
		t.Run(strconv.FormatInt(userID, 10), func(t *testing.T) {
			storeCalls, providerCalls := 0, 0
			q := &mockWorkspaceQuerier{
				getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
					storeCalls++
					return sampleDBWorkspace("ws-invalid-creator"), nil
				},
			}
			provider := &desktopSandbox{}
			provider.writeFileFn = func(context.Context, string, string, sandbox.WriteFileRequest) error {
				providerCalls++
				return nil
			}
			provider.execAwaitFn = func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
				providerCalls++
				return sandbox.ExecResult{}, nil
			}
			_, err := NewWorkspaceService(q, WithWorkspaceSandboxClient(provider)).CreateDesktopSession(
				context.Background(), "ws-invalid-creator", 101, userID,
			)
			assertAPIStatus(t, err, 401)
			require.Zero(t, storeCalls)
			require.Zero(t, providerCalls)
			require.Empty(t, provider.published)
		})
	}
}

func TestAuthorizeDesktopRelayRequiresCurrentCreatorWriteAccess(t *testing.T) {
	for _, tc := range []struct {
		name       string
		creator    int64
		shareLevel string
		shareErr   error
		wantStatus int
		wantTouch  int
	}{
		{name: "owner", creator: 1, wantTouch: 1},
		{name: "member write", creator: 2, shareLevel: "write", wantTouch: 1},
		{name: "member read", creator: 2, shareLevel: "read", wantStatus: 403},
		{name: "member removed", creator: 2, shareErr: pgx.ErrNoRows, wantStatus: 403},
		{name: "share store failure", creator: 2, shareErr: errors.New("database unavailable"), wantStatus: 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token, hash := generateDesktopSessionToken(tc.creator)
			workspace := sampleDBWorkspace("ws-desktop-creator")
			workspace.UserID = 1
			workspace.Kind = "desktop"
			workspace.DesktopSessionTokenHash = hash
			workspace.DesktopSessionExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}
			shareCalls, touches := 0, 0
			q := &mockWorkspaceQuerier{
				getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return workspace, nil },
				getWorkspaceShareFn: func(_ context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
					shareCalls++
					require.Equal(t, workspace.ID, arg.WorkspaceID)
					require.Equal(t, tc.creator, arg.GranteeUserID)
					if tc.shareErr != nil {
						return db.WorkspaceShare{}, tc.shareErr
					}
					return db.WorkspaceShare{Level: tc.shareLevel}, nil
				},
				touchWorkspaceActivityFn: func(context.Context, string) error { touches++; return nil },
			}
			target, err := NewWorkspaceService(q).AuthorizeDesktopRelay(context.Background(), workspace.ID, token)
			if tc.wantStatus != 0 {
				assertAPIStatus(t, err, tc.wantStatus)
			} else {
				require.NoError(t, err)
				require.Equal(t, tc.creator, target.UserID)
				require.Equal(t, workspace.UserID, target.OwnerUserID)
				require.Equal(t, workspace.ID, target.WorkspaceID)
			}
			require.Equal(t, tc.wantTouch, touches, "rejected credentials must not extend activity")
			if tc.creator != workspace.UserID {
				require.Equal(t, 1, shareCalls)
			} else {
				require.Zero(t, shareCalls)
			}
		})
	}
}

func TestAuthorizeDesktopRelayRejectsMalformedAndTamperedCreatorTokens(t *testing.T) {
	entropy := strings.Repeat("a", 48)
	for _, tc := range []struct {
		name, token string
		tamper      bool
	}{
		{name: "legacy token", token: "smithers_desk_" + entropy},
		{name: "missing creator", token: "smithers_desk_v1__" + entropy},
		{name: "missing delimiter", token: "smithers_desk_v1_2"},
		{name: "zero creator", token: "smithers_desk_v1_0_" + entropy},
		{name: "negative creator", token: "smithers_desk_v1_-2_" + entropy},
		{name: "leading zero creator", token: "smithers_desk_v1_02_" + entropy},
		{name: "plus sign creator", token: "smithers_desk_v1_+2_" + entropy},
		{name: "overflow creator", token: "smithers_desk_v1_9223372036854775808_" + entropy},
		{name: "short entropy", token: "smithers_desk_v1_2_" + entropy[:47]},
		{name: "long entropy", token: "smithers_desk_v1_2_" + entropy + "aa"},
		{name: "nonhex entropy", token: "smithers_desk_v1_2_" + entropy[:47] + "z"},
		{name: "uppercase entropy", token: "smithers_desk_v1_2_" + entropy[:47] + "A"},
		{name: "trailing segment", token: "smithers_desk_v1_2_" + entropy + "_extra"},
		{name: "tampered creator ID", tamper: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token, hash := tc.token, ""
			if tc.tamper {
				valid, validHash := generateDesktopSessionToken(2)
				token = strings.Replace(valid, "_2_", "_1_", 1)
				hash = validHash
			} else {
				sum := sha256.Sum256([]byte(token))
				hash = hex.EncodeToString(sum[:])
			}
			workspace := sampleDBWorkspace("ws-desktop-invalid")
			workspace.Kind = "desktop"
			workspace.DesktopSessionTokenHash = hash
			workspace.DesktopSessionExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}
			shareCalls, touches := 0, 0
			q := &mockWorkspaceQuerier{
				getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return workspace, nil },
				getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
					shareCalls++
					return db.WorkspaceShare{Level: "write"}, nil
				},
				touchWorkspaceActivityFn: func(context.Context, string) error { touches++; return nil },
			}
			_, err := NewWorkspaceService(q).AuthorizeDesktopRelay(context.Background(), workspace.ID, token)
			assertAPIStatus(t, err, 401)
			require.Zero(t, shareCalls, "invalid token must not resolve a share")
			require.Zero(t, touches)
		})
	}
}
