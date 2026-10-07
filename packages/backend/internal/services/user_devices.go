package services

import (
	"context"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	UserDevicePlatformIOS     = "ios"
	UserDevicePlatformAndroid = "android"

	// maxDeviceTokenLen bounds stored push tokens. Real APNs tokens are
	// 64-160 hex characters and FCM registration tokens are ~150-300
	// characters; anything longer only bloats the unique index.
	maxDeviceTokenLen = 512
)

type UserDeviceQuerier interface {
	UpsertUserDevice(ctx context.Context, arg db.UpsertUserDeviceParams) (db.UserDevice, error)
	DeleteUserDevice(ctx context.Context, arg db.DeleteUserDeviceParams) error
}

type UserDeviceService struct {
	install         *installAccountMutationStore
	installAdmitted bool
	q               UserDeviceQuerier
}

type RegisterUserDeviceRequest struct {
	APNSToken string `json:"apns_token"`
	Platform  string `json:"platform"`
}

type UserDeviceResponse struct {
	ID         int64     `json:"id"`
	UserID     int64     `json:"user_id"`
	APNSToken  string    `json:"apns_token"`
	Platform   string    `json:"platform"`
	CreatedAt  time.Time `json:"created_at"`
	LastSeenAt time.Time `json:"last_seen_at"`
}

func NewUserDeviceService(q UserDeviceQuerier, options ...UserDeviceServiceOption) *UserDeviceService {
	s := &UserDeviceService{q: q}
	for _, option := range options {
		option(s)
	}
	return s
}

// RegisterDevice records a push token for the user. A token identifies one
// physical device, so the upsert atomically reassigns it away from any other
// account and caps the user at 50 registered devices (evicting the least
// recently seen).
func (s *UserDeviceService) RegisterDevice(ctx context.Context, userID int64, req RegisterUserDeviceRequest) (UserDeviceResponse, error) {
	if s.install != nil && !s.installAdmitted {
		return withInstallAccountMutation(s.install, ctx, userID, "account.device.register", 0, req, func(ctx context.Context, q *db.Queries) (UserDeviceResponse, error) {
			scoped := *s
			scoped.q, scoped.installAdmitted = q, true
			return scoped.RegisterDevice(ctx, userID, req)
		})
	}
	if userID <= 0 {
		return UserDeviceResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	token := strings.TrimSpace(req.APNSToken)
	if token == "" {
		return UserDeviceResponse{}, pkgerrors.BadRequest("apns_token is required")
	}
	if len(token) > maxDeviceTokenLen {
		return UserDeviceResponse{}, pkgerrors.BadRequest("apns_token exceeds maximum length")
	}
	if !isValidDeviceToken(token) {
		return UserDeviceResponse{}, pkgerrors.BadRequest("apns_token contains invalid characters")
	}
	platform := strings.ToLower(strings.TrimSpace(req.Platform))
	if platform == "" {
		platform = UserDevicePlatformIOS
	}
	if platform != UserDevicePlatformIOS && platform != UserDevicePlatformAndroid {
		return UserDeviceResponse{}, pkgerrors.BadRequest("platform must be 'ios' or 'android'")
	}

	device, err := s.q.UpsertUserDevice(ctx, db.UpsertUserDeviceParams{
		UserID:    userID,
		ApnsToken: token,
		Platform:  platform,
	})
	if err != nil {
		return UserDeviceResponse{}, pkgerrors.Internal("register device: " + err.Error())
	}
	return toUserDeviceResponse(device), nil
}

func (s *UserDeviceService) DeleteDevice(ctx context.Context, userID int64, apnsToken string) error {
	if s.install != nil && !s.installAdmitted {
		_, err := withInstallAccountMutation(s.install, ctx, userID, "account.device.delete", 0, apnsToken, func(ctx context.Context, q *db.Queries) (struct{}, error) {
			scoped := *s
			scoped.q, scoped.installAdmitted = q, true
			return struct{}{}, scoped.DeleteDevice(ctx, userID, apnsToken)
		})
		return err
	}
	if userID <= 0 {
		return pkgerrors.Unauthorized("authentication required")
	}
	token := strings.TrimSpace(apnsToken)
	if token == "" {
		return pkgerrors.BadRequest("apns_token is required")
	}
	if err := s.q.DeleteUserDevice(ctx, db.DeleteUserDeviceParams{
		UserID:    userID,
		ApnsToken: token,
	}); err != nil {
		return pkgerrors.Internal("delete device: " + err.Error())
	}
	return nil
}

// isValidDeviceToken accepts the character sets used by APNs device tokens
// (hex) and FCM registration tokens (alphanumeric plus ':', '-', '_', '.').
func isValidDeviceToken(token string) bool {
	for _, r := range token {
		switch {
		case r >= '0' && r <= '9',
			r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r == ':', r == '-', r == '_', r == '.':
		default:
			return false
		}
	}
	return true
}

func toUserDeviceResponse(device db.UserDevice) UserDeviceResponse {
	return UserDeviceResponse{
		ID:         device.ID,
		UserID:     device.UserID,
		APNSToken:  device.ApnsToken,
		Platform:   device.Platform,
		CreatedAt:  device.CreatedAt,
		LastSeenAt: device.LastSeenAt,
	}
}
