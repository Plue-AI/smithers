package live

import (
	"context"
	"errors"
	"sync"
	"time"
	"unicode/utf8"
)

// WikiSnapshot is a detached snapshot of the shared Yrs authority. Authors are
// the authenticated actor identities resolved by that authority's authors map,
// never attribution supplied with a browser update.
type WikiSnapshot struct {
	State       []byte
	StateVector []byte
	Markdown    string
	Authors     []string
}

// WikiAuthority is implemented by the shared document core (T-COL-08). Apply
// must reject foreign client IDs, authors-map writes and unrelated roots before
// mutation. This adapter adds no CRDT implementation or wire codec.
type WikiAuthority interface {
	Apply(authenticatedActor string, update []byte) error
	Snapshot() (WikiSnapshot, error)
}

// WikiPersistence commits state, Markdown and period attribution in the existing
// revision-checked wiki transaction. It returns only after commit and retries
// revision conflicts by merging with the stored state, never reseeding text.
type WikiPersistence interface {
	Commit(context.Context, int64, WikiSnapshot) error
}

// WikiDocument supplies the wiki-only persistence lifecycle missing from the
// stateless merge service (delta.md §4). The shared live transport owns admission,
// revocation, sync, awareness and sending the vector returned by Flush as saved.
// No route mounts this adapter until those dependencies are available.
type WikiDocument struct {
	mu                sync.Mutex
	pageID            int64
	authority         WikiAuthority
	persistence       WikiPersistence
	version           uint64
	persisted         uint64
	first             time.Time
	last              time.Time
	firstDuringCommit time.Time
	committing        bool
	closed            bool
	actors            map[string]bool
}

func OpenWikiDocument(pageID int64, authority WikiAuthority, persistence WikiPersistence) (*WikiDocument, error) {
	if pageID <= 0 || authority == nil || persistence == nil {
		return nil, errors.New("wiki document authority and persistence are required")
	}
	return &WikiDocument{pageID: pageID, authority: authority, persistence: persistence, actors: make(map[string]bool)}, nil
}

// Update is called only after live-channel authorization and client-id binding.
// Rejected updates never advance the persistence deadline or saved vector.
func (d *WikiDocument) Update(authenticatedActor string, update []byte, now time.Time) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return errors.New("wiki document is closed")
	}
	if authenticatedActor == "" || len(update) == 0 || len(update) > 1<<20 {
		return errors.New("invalid wiki document update")
	}
	if err := d.authority.Apply(authenticatedActor, update); err != nil {
		return err
	}
	if d.version == d.persisted {
		d.first = now
	}
	if d.committing && d.firstDuringCommit.IsZero() {
		d.firstDuringCommit = now
	}
	d.actors[authenticatedActor] = true
	d.last = now
	d.version++
	return nil
}

// Flush returns nil until a deadline, while another commit is running, and on
// every failed commit. The returned vector covers precisely the committed
// snapshot, even when more updates arrive while PostgreSQL is committing.
func (d *WikiDocument) Flush(ctx context.Context, now time.Time) ([]byte, error) {
	d.mu.Lock()
	if d.version == d.persisted || d.committing || (now.Before(d.last.Add(2*time.Second)) && now.Before(d.first.Add(10*time.Second))) {
		d.mu.Unlock()
		return nil, nil
	}
	snapshot, err := d.authority.Snapshot()
	if err == nil {
		err = validateWikiSnapshot(snapshot)
	}
	if err != nil {
		d.mu.Unlock()
		return nil, err
	}
	// Filter the authority's authors map to this period's authenticated editors.
	actors := d.actors
	periodAuthors := make([]string, 0, len(actors))
	resolved := make(map[string]bool)
	for _, actor := range snapshot.Authors {
		if actors[actor] && !resolved[actor] {
			periodAuthors = append(periodAuthors, actor)
			resolved[actor] = true
		}
	}
	if len(resolved) != len(actors) {
		d.mu.Unlock()
		return nil, errors.New("wiki authors map does not cover authenticated editors")
	}
	snapshot.Authors = periodAuthors
	// Do not depend on a core's slice ownership while committing outside the lock.
	snapshot.State = append([]byte(nil), snapshot.State...)
	snapshot.StateVector = append([]byte(nil), snapshot.StateVector...)
	snapshot.Authors = append([]string(nil), snapshot.Authors...)
	version := d.version
	d.actors = make(map[string]bool)
	d.committing = true
	d.firstDuringCommit = time.Time{}
	d.mu.Unlock()
	err = d.persistence.Commit(ctx, d.pageID, snapshot)
	d.mu.Lock()
	defer d.mu.Unlock()
	d.committing = false
	if err != nil {
		for actor := range actors {
			d.actors[actor] = true
		}
		return nil, err
	}
	d.persisted = version
	if d.version != version {
		d.first = d.firstDuringCommit
	} else {
		d.first = time.Time{}
	}
	return append([]byte(nil), snapshot.StateVector...), nil
}

func validateWikiSnapshot(snapshot WikiSnapshot) error {
	if len(snapshot.State) == 0 || len(snapshot.State) > 8<<20 || len(snapshot.StateVector) == 0 || len(snapshot.StateVector) > 8<<20 || len(snapshot.Markdown) > 1<<20 || !utf8.ValidString(snapshot.Markdown) {
		return errors.New("invalid wiki document snapshot")
	}
	return nil
}

// Close stops new input. The owner must retain a dirty authority until its
// deadline commit succeeds; closing the last subscriber never discards edits.
func (d *WikiDocument) Close() { d.mu.Lock(); defer d.mu.Unlock(); d.closed = true }
func (d *WikiDocument) Pending() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.version != d.persisted
}
