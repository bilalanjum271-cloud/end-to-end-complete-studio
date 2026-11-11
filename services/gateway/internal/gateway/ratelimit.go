package gateway

import (
	"context"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Limiter is a token bucket: `perMinute` tokens refill per minute up to `burst`.
type Limiter interface {
	Allow(ctx context.Context, key string, perMinute, burst int) (ok bool, retryAfter time.Duration, err error)
}

// RedisLimiter keeps buckets in Redis (Cluster-safe: one key per bucket) so limits hold
// across every gateway replica. The script is atomic and uses the Redis server clock.
type RedisLimiter struct{ Client redis.UniversalClient }

var bucketScript = redis.NewScript(`
local rate  = tonumber(ARGV[1]) / 60000.0
local burst = tonumber(ARGV[2])
local t     = redis.call('TIME')
local now   = t[1] * 1000 + math.floor(t[2] / 1000)
local b     = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1])
local ts     = tonumber(b[2])
if tokens == nil then tokens = burst; ts = now end
tokens = math.min(burst, tokens + (now - ts) * rate)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate) + 1000)
return {allowed, retry}
`)

func (l *RedisLimiter) Allow(ctx context.Context, key string, perMinute, burst int) (bool, time.Duration, error) {
	res, err := bucketScript.Run(ctx, l.Client, []string{"rl:{" + key + "}"}, perMinute, burst).Int64Slice()
	if err != nil {
		return false, 0, err
	}
	return res[0] == 1, time.Duration(res[1]) * time.Millisecond, nil
}

// MemLimiter is the per-replica fallback used when Redis is unreachable (graceful
// degradation: limits become per-pod instead of global, traffic keeps flowing).
type MemLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	now     func() time.Time
}

type bucket struct {
	tokens float64
	ts     time.Time
}

func NewMemLimiter() *MemLimiter { return &MemLimiter{buckets: map[string]*bucket{}, now: time.Now} }

func (l *MemLimiter) Allow(_ context.Context, key string, perMinute, burst int) (bool, time.Duration, error) {
	rate := float64(perMinute) / 60.0 // tokens per second
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.buckets) > 500_000 { // bounded memory
		l.buckets = map[string]*bucket{}
	}
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: float64(burst), ts: now}
		l.buckets[key] = b
	}
	b.tokens += now.Sub(b.ts).Seconds() * rate
	if b.tokens > float64(burst) {
		b.tokens = float64(burst)
	}
	b.ts = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0, nil
	}
	return false, time.Duration((1-b.tokens)/rate*float64(time.Second)) + time.Millisecond, nil
}

// FallbackLimiter tries the primary and degrades to the secondary on error.
type FallbackLimiter struct {
	Primary, Secondary Limiter
	OnDegrade          func(error)
}

func (f *FallbackLimiter) Allow(ctx context.Context, key string, perMinute, burst int) (bool, time.Duration, error) {
	cctx, cancel := context.WithTimeout(ctx, 150*time.Millisecond)
	defer cancel()
	ok, retry, err := f.Primary.Allow(cctx, key, perMinute, burst)
	if err == nil {
		return ok, retry, nil
	}
	if f.OnDegrade != nil {
		f.OnDegrade(err)
	}
	return f.Secondary.Allow(ctx, key, perMinute, burst)
}
