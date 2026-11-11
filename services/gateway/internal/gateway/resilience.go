package gateway

import (
	"sync"
	"sync/atomic"
	"time"
)

// Shedder is priority-aware admission control. Each request carries a priority 0..100
// (from the caller's plan). As in-flight load approaches capacity, low priorities are
// refused first: priority p is admitted while inflight < max * (0.5 + 0.5*p/100).
// So anonymous traffic sheds at 50% load, Starter at 55%, Studio at 95%.
type Shedder struct {
	Max      int64
	inflight atomic.Int64
}

func (s *Shedder) Acquire(priority int) bool {
	if priority < 0 {
		priority = 0
	}
	if priority > 100 {
		priority = 100
	}
	limit := s.Max * int64(50+priority/2) / 100
	if s.inflight.Add(1) > limit {
		s.inflight.Add(-1)
		return false
	}
	return true
}

func (s *Shedder) Release()        { s.inflight.Add(-1) }
func (s *Shedder) Inflight() int64 { return s.inflight.Load() }

// Breaker is a per-upstream circuit breaker: it opens after `Threshold` consecutive
// failures, rejects for `Cooldown`, then lets one probe through (half-open).
type Breaker struct {
	Threshold int
	Cooldown  time.Duration

	mu       sync.Mutex
	failures int
	openedAt time.Time
	probing  bool
	now      func() time.Time
}

func NewBreaker(threshold int, cooldown time.Duration) *Breaker {
	return &Breaker{Threshold: threshold, Cooldown: cooldown, now: time.Now}
}

func (b *Breaker) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failures < b.Threshold {
		return true
	}
	if b.now().Sub(b.openedAt) >= b.Cooldown && !b.probing {
		b.probing = true
		return true
	}
	return false
}

func (b *Breaker) Record(success bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if success {
		b.failures, b.probing = 0, false
		return
	}
	b.failures++
	b.probing = false
	if b.failures >= b.Threshold {
		b.openedAt = b.now()
	}
}

func (b *Breaker) Open() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.failures >= b.Threshold
}
