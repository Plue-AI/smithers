package chat

import (
	"sync"
	"testing"
	"time"
)

func expectChatSignal(t *testing.T, changed <-chan struct{}) {
	t.Helper()
	select {
	case _, open := <-changed:
		if !open {
			t.Fatal("a closed subscription is not a journal-change hint")
		}
	default:
		t.Fatal("subscriber did not receive its journal-change hint")
	}
}

func expectNoChatSignal(t *testing.T, changed <-chan struct{}) {
	t.Helper()
	select {
	case <-changed:
		t.Fatal("subscriber received an unrelated or duplicate journal-change hint")
	default:
	}
}

func TestChatSignalsUnitFanoutIsScopedAndHintsCoalesce(t *testing.T) {
	var signals turnSignals
	// Notifications are hints for existing streams, not retained journal data.
	signals.notify("absent")
	first, stopFirst := signals.watch("first")
	defer stopFirst()
	second, stopSecond := signals.watch("first")
	defer stopSecond()
	other, stopOther := signals.watch("other")
	defer stopOther()
	for range 3 {
		signals.notify("first")
	}
	expectChatSignal(t, first)
	expectChatSignal(t, second)
	expectNoChatSignal(t, first)
	expectNoChatSignal(t, second)
	expectNoChatSignal(t, other)
	// A stream that has drained its hint must wake again after another commit.
	signals.notify("first")
	expectChatSignal(t, first)
	expectChatSignal(t, second)
	signals.notify("other")
	expectChatSignal(t, other)
	expectNoChatSignal(t, first)
	expectNoChatSignal(t, second)
}

func TestChatSignalsUnitStoppingOneStreamKeepsOtherStreamsAndReconnections(t *testing.T) {
	var signals turnSignals
	first, stopFirst := signals.watch("run")
	second, stopSecond := signals.watch("run")
	stopFirst()
	stopFirst()
	signals.notify("run")
	expectNoChatSignal(t, first)
	expectChatSignal(t, second)
	stopSecond()
	stopSecond()
	signals.notify("run")
	expectNoChatSignal(t, second)
	// A stale cleanup must not remove a new subscription to the same run.
	reconnected, stopReconnected := signals.watch("run")
	defer stopReconnected()
	stopFirst()
	stopSecond()
	signals.notify("run")
	expectChatSignal(t, reconnected)
	expectNoChatSignal(t, first)
	expectNoChatSignal(t, second)
}

func TestChatSignalsUnitSlowStreamDoesNotBlockAnotherStream(t *testing.T) {
	var signals turnSignals
	slow, stopSlow := signals.watch("run")
	defer stopSlow()
	fast, stopFast := signals.watch("run")
	defer stopFast()
	for range 64 {
		signals.notify("run")
		expectChatSignal(t, fast)
	}
	expectChatSignal(t, slow)
	expectNoChatSignal(t, slow)
	expectNoChatSignal(t, fast)
}

func TestChatSignalsUnitConcurrentNotifyAndCleanupPreserveSurvivingStream(t *testing.T) {
	var signals turnSignals
	survivor, stopSurvivor := signals.watch("run")
	defer stopSurvivor()
	const count = 16
	stopped := make([]<-chan struct{}, count)
	start := make(chan struct{})
	var workers sync.WaitGroup
	for index := range count {
		changed, stop := signals.watch("run")
		stopped[index] = changed
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			for range 32 {
				signals.notify("run")
			}
			stop()
			stop()
		}()
	}
	close(start)
	done := make(chan struct{})
	go func() { workers.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("concurrent notifications and cleanup did not finish")
	}
	expectChatSignal(t, survivor)
	for _, changed := range stopped {
		// A hint sent before cleanup may still be buffered. Drain it before
		// checking that later commits no longer reach that subscription.
		select {
		case _, open := <-changed:
			if !open {
				t.Fatal("cleanup closed a change-hint channel")
			}
		default:
		}
	}
	signals.notify("run")
	expectChatSignal(t, survivor)
	for _, changed := range stopped {
		expectNoChatSignal(t, changed)
	}
}
