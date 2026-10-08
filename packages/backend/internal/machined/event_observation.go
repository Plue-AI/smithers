package machined

import "sync"

// ObserveEventFrames attaches a diagnostic to the existing authenticated reader,
// before decoding or ingestion can discard an event. It creates no subscription,
// does not ACK, and must not call registry methods or retain credential bytes.
// Only one observer is permitted. Stop joins any observation in flight.
func (r *Registry) ObserveEventFrames(observe func(string, []byte)) (func(), error) {
	if r == nil || observe == nil {
		return nil, ErrNotReady
	}
	r.observationMu.Lock()
	defer r.observationMu.Unlock()
	if r.eventObserver != nil {
		return nil, ErrNotReady
	}
	r.eventObserver = observe
	var once sync.Once
	return func() {
		once.Do(func() {
			r.observationMu.Lock()
			r.eventObserver = nil
			r.observationMu.Unlock()
		})
	}, nil
}

func (r *Registry) observeEvent(branch string, payload []byte) {
	r.observationMu.Lock()
	defer r.observationMu.Unlock()
	if r.eventObserver != nil {
		// Diagnostics cannot modify the bytes the production consumer will decode.
		r.eventObserver(branch, append([]byte(nil), payload...))
	}
}
