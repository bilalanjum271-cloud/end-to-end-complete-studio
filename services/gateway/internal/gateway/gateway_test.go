package gateway

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"

	"github.com/xen-studio/xen-studio/packages/go/platform/obs"
)

var secret = []byte("test-secret-test-secret-test-secret-1234")

func token(t *testing.T, mut func(*Claims)) string {
	t.Helper()
	c := &Claims{WorkspaceID: "11111111-1111-4111-8111-111111111111", Role: "owner", Plan: "studio", RPM: 600, WRPM: 3000, Priority: 90,
		RegisteredClaims: jwt.RegisteredClaims{Subject: "user-1", Issuer: "xen-studio", Audience: jwt.ClaimStrings{"xen-studio"},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}}
	if mut != nil {
		mut(c)
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(secret)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func newGW(t *testing.T, upstream http.Handler, lim Limiter, max int64) (*httptest.Server, *httptest.Server) {
	t.Helper()
	up := httptest.NewServer(upstream)
	t.Cleanup(up.Close)
	if lim == nil {
		lim = NewMemLimiter()
	}
	g, err := New(Config{JWTSecret: secret, GatewayToken: "gw-token",
		Upstreams: map[string]string{"identity": up.URL, "ledger": up.URL}, Routes: DefaultRoutes(),
		MaxInflight: max, Limiter: lim, Log: slog.New(slog.NewJSONHandler(io.Discard, nil)), Reg: obs.NewRegistry()})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(g.Handler())
	t.Cleanup(srv.Close)
	return srv, up
}

func do(t *testing.T, method, url, tok string, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(method, url, nil)
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func TestAuthAndTenantHeaderInjection(t *testing.T) {
	var got http.Header
	srv, _ := newGW(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got = r.Header.Clone() }), nil, 100)

	if res := do(t, "GET", srv.URL+"/v1/credits", "", nil); res.StatusCode != 401 {
		t.Fatalf("no token: %d", res.StatusCode)
	}
	expired := token(t, func(c *Claims) { c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Minute)) })
	if res := do(t, "GET", srv.URL+"/v1/credits", expired, nil); res.StatusCode != 401 {
		t.Fatalf("expired token: %d", res.StatusCode)
	}
	forged, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"sub": "x", "exp": time.Now().Add(time.Hour).Unix(), "iss": "xen-studio", "aud": "xen-studio"}).SignedString([]byte("wrong-key-wrong-key-wrong-key-wrong-key"))
	if res := do(t, "GET", srv.URL+"/v1/credits", forged, nil); res.StatusCode != 401 {
		t.Fatalf("forged token: %d", res.StatusCode)
	}

	// a client trying to spoof tenant headers must be overwritten by the verified claims
	res := do(t, "GET", srv.URL+"/v1/credits", token(t, nil), map[string]string{
		"X-Workspace-Id": "99999999-9999-4999-8999-999999999999", "X-Role": "superadmin", "X-Internal-Token": "stolen"})
	if res.StatusCode != 200 {
		t.Fatalf("valid token: %d", res.StatusCode)
	}
	if got.Get("X-Workspace-Id") != "11111111-1111-4111-8111-111111111111" || got.Get("X-Role") != "owner" ||
		got.Get("X-User-Id") != "user-1" || got.Get("X-Gateway-Token") != "gw-token" || got.Get("X-Internal-Token") != "" {
		t.Fatalf("tenant headers not enforced: %v", got)
	}
}

func TestInternalAndUnknownRoutesAreNotExposed(t *testing.T) {
	srv, _ := newGW(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("must not reach upstream") }), nil, 100)
	for _, p := range []string{"/internal/v1/workspaces/x/credits/grant", "/v1/unknown", "/"} {
		if res := do(t, "POST", srv.URL+p, token(t, nil), nil); res.StatusCode != 404 {
			t.Fatalf("%s: %d", p, res.StatusCode)
		}
	}
}

func TestPerUserRateLimit(t *testing.T) {
	srv, _ := newGW(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}), nil, 100)
	tok := token(t, func(c *Claims) { c.RPM = 10; c.Subject = "limited-user" }) // burst = 6
	okN, limN := 0, 0
	for i := 0; i < 20; i++ {
		res := do(t, "GET", srv.URL+"/v1/me", tok, nil)
		switch res.StatusCode {
		case 200:
			okN++
		case 429:
			limN++
			if res.Header.Get("Retry-After") == "" {
				t.Fatal("429 must carry Retry-After")
			}
		}
	}
	if okN != 6 || limN != 14 {
		t.Fatalf("ok=%d limited=%d, want 6/14", okN, limN)
	}
	// another user is unaffected
	if res := do(t, "GET", srv.URL+"/v1/me", token(t, func(c *Claims) { c.Subject = "other" }), nil); res.StatusCode != 200 {
		t.Fatalf("other user: %d", res.StatusCode)
	}
}

func TestPublicRouteLimitedPerIP(t *testing.T) {
	srv, _ := newGW(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}), nil, 100)
	limited := 0
	for i := 0; i < 40; i++ {
		if do(t, "POST", srv.URL+"/v1/auth/login", "", nil).StatusCode == 429 {
			limited++
		}
	}
	if limited != 10 {
		t.Fatalf("limited=%d, want 10 (30 rpm on auth routes)", limited)
	}
}

func TestLoadSheddingPrefersHigherPlans(t *testing.T) {
	s := &Shedder{Max: 100}
	for i := 0; i < 55; i++ { // fill to 55% with studio traffic
		if !s.Acquire(90) {
			t.Fatal("studio must be admitted at low load")
		}
	}
	if s.Acquire(10) {
		t.Fatal("starter (prio 10) must be shed at 55% load")
	}
	if s.Acquire(0) {
		t.Fatal("anonymous must be shed at 55% load")
	}
	if !s.Acquire(90) {
		t.Fatal("studio must still be admitted at 55% load")
	}
	for s.Acquire(90) {
	}
	if s.Inflight() != 95 {
		t.Fatalf("studio ceiling = %d, want 95", s.Inflight())
	}
}

func TestBreakerOpensAndRecovers(t *testing.T) {
	fail := true
	srv, _ := newGW(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if fail {
			w.WriteHeader(500)
		}
	}), nil, 100)
	tok := token(t, nil)
	for i := 0; i < 5; i++ {
		if res := do(t, "GET", srv.URL+"/v1/me", tok, nil); res.StatusCode != 500 {
			t.Fatalf("pass-through: %d", res.StatusCode)
		}
	}
	if res := do(t, "GET", srv.URL+"/v1/me", tok, nil); res.StatusCode != 503 {
		t.Fatalf("breaker should be open: %d", res.StatusCode)
	}

	b := NewBreaker(2, time.Minute)
	now := time.Now()
	b.now = func() time.Time { return now }
	b.Record(false)
	b.Record(false)
	if b.Allow() {
		t.Fatal("open breaker must reject")
	}
	now = now.Add(2 * time.Minute)
	if !b.Allow() || b.Allow() {
		t.Fatal("half-open must allow exactly one probe")
	}
	b.Record(true)
	if !b.Allow() {
		t.Fatal("breaker must close after a successful probe")
	}
}

func TestRedisLimiterAndFallback(t *testing.T) {
	url := os.Getenv("TEST_REDIS_URL")
	if url == "" {
		t.Skip("TEST_REDIS_URL not set")
	}
	opt, _ := redis.ParseURL(url)
	rdb := redis.NewClient(opt)
	defer rdb.Close()
	ctx := context.Background()
	key := "test:" + time.Now().Format(time.RFC3339Nano)
	l := &RedisLimiter{Client: rdb}
	okN := 0
	for i := 0; i < 12; i++ {
		ok, retry, err := l.Allow(ctx, key, 60, 5)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			okN++
		} else if retry <= 0 {
			t.Fatal("rejected call must report retry-after")
		}
	}
	if okN != 5 {
		t.Fatalf("redis bucket allowed %d, want burst of 5", okN)
	}
	time.Sleep(1100 * time.Millisecond) // 60/min refills one token per second
	if ok, _, _ := l.Allow(ctx, key, 60, 5); !ok {
		t.Fatal("bucket must refill")
	}

	// unreachable Redis degrades to the in-memory limiter instead of failing requests
	dead := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1", DialTimeout: 50 * time.Millisecond, MaxRetries: -1})
	defer dead.Close()
	degraded := 0
	f := &FallbackLimiter{Primary: &RedisLimiter{Client: dead}, Secondary: NewMemLimiter(), OnDegrade: func(error) { degraded++ }}
	if ok, _, err := f.Allow(ctx, "k", 60, 5); !ok || err != nil || degraded != 1 {
		t.Fatalf("fallback: ok=%v err=%v degraded=%d", ok, err, degraded)
	}
}
