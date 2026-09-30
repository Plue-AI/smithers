package operator

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/localbootstrap"
)

const keysUsage = "usage: keys rotate | keys reseal"

// runKeys rotates the operator key that seals stored credentials.
//
//	keys rotate  replaces the key kept in the data root's secrets file (the
//	             app is stopped) and reseals every stored value under it.
//	keys reseal  moves stored values to SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY
//	             while SMITHERS_WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS holds
//	             the keys it replaced; it runs beside a server that holds both.
//
// Both also reset each Flow journal role's password to the one the new key
// derives.
func runKeys(ctx context.Context, args []string, cfg Config) error {
	if len(args) != 1 {
		return errors.New(keysUsage)
	}
	switch args[0] {
	case "rotate":
		resumed, err := localbootstrap.RotateOperatorKey(ctx, os.Getenv("SMITHERS_DATA_ROOT"), func(ctx context.Context, current string, previous []string) error {
			return resealKeys(ctx, cfg, current, previous)
		})
		if err != nil {
			return err
		}
		if resumed {
			_, err = fmt.Fprintln(cfg.Stdout, "operator key rotation resumed and completed")
		} else {
			_, err = fmt.Fprintln(cfg.Stdout, "operator key rotated")
		}
		return err
	case "reseal":
		keys := config.WebhookConfig{
			SecretEncryptionKey:          os.Getenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY"),
			PreviousSecretEncryptionKeys: os.Getenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS"),
		}
		return resealKeys(ctx, cfg, keys.SecretEncryptionKey, keys.PreviousKeys())
	default:
		return errors.New(keysUsage)
	}
}

func resealKeys(ctx context.Context, cfg Config, current string, previous []string) error {
	codec, err := webhook.NewSecretCodec(current, previous...)
	if err != nil {
		return fmt.Errorf("keys: %w", err)
	}
	return withDatabase(ctx, cfg, func(pool *pgxpool.Pool) error {
		counts, err := services.ResealOperatorKeySecrets(ctx, pool, codec)
		for _, count := range counts {
			if _, printErr := fmt.Fprintf(cfg.Stdout, "%s resealed=%d current=%d raced=%d\n", count.Store, count.Resealed, count.Current, count.Raced); printErr != nil && err == nil {
				err = printErr
			}
		}
		if err != nil {
			return err
		}
		// Flow journal role passwords derive from the operator key; the
		// replaced key's passwords must stop signing in.
		roles, err := flowhost.ResealJournalPasswords(ctx, pool, current)
		if _, printErr := fmt.Fprintf(cfg.Stdout, "flow journal roles resealed=%d\n", roles); printErr != nil && err == nil {
			err = printErr
		}
		return err
	})
}
