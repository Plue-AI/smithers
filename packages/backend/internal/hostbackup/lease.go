package hostbackup

import (
	"context"
	"time"
)

type leaseAuthority interface {
	Renew(context.Context, string) error
}

// Renewal must cover the initial drain as well as hashing and publication.
// A failed renewal cancels work; cleanup waits until the renewal request exits.
func renewLease(ctx context.Context, authority leaseAuthority, op string) (context.Context, func()) {
	work, cancel := context.WithCancelCause(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-work.Done():
				return
			case <-ticker.C:
				renewal, stop := context.WithTimeout(work, 5*time.Second)
				err := authority.Renew(renewal, op)
				stop()
				if err != nil {
					cancel(err)
					return
				}
			}
		}
	}()
	return work, func() { cancel(nil); <-done }
}
