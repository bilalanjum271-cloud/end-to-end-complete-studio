// Package gateway is the cell's front door: authentication, tenant header injection,
// rate limiting, load shedding, circuit breaking and reverse proxying. It holds no
// session state; any replica can serve any request.
package gateway

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/xen-studio/xen-studio/packages/go/platform/httpx"
	"github.com/xen-studio/xen-studio/packages/go/platform/obs"
)

// Claims is the access-token payload issued by the identity service.
type Claims struct {
	WorkspaceID string `json:"ws"`
	Role        string `json:"role"`
	Plan        string `json:"plan"`
	RPM         int    `json:"rpm"`  // per-user requests/minute for the plan
	WRPM        int    `json:"wrpm"` // per-workspace requests/minute for the plan
	Priority    int    `json:"prio"` // queue / shedding priority for the plan
	jwt.RegisteredClaims
}

type Route struct {
	Prefix    string
	Upstream  string // key into Config.Upstreams
	Public    bool   // no token required (still rate limited per IP)
	PublicRPM int
}

type Config struct {
	JWTSecret    []byte
	GatewayToken string
	Upstreams    map[string]string
	Routes       []Route
	MaxInflight  int64
	Limiter      Limiter
	Log          *slog.Logger
	Reg          *obs.Registry
	Ready        func() error
}

type Gateway struct {
	cfg      Config
	shed     *Shedder
	proxies  map[string]*httputil.ReverseProxy
	breakers map[string]*Breaker
}

// DefaultRoutes is the Phase 1 routing table. Longest prefix wins. /internal is never routed.
func DefaultRoutes() []Route {
	return []Route{
		{Prefix: "/v1/auth/", Upstream: "identity", Public: true, PublicRPM: 30},
		{Prefix: "/v1/plans", Upstream: "identity", Public: true, PublicRPM: 120},
		{Prefix: "/v1/me", Upstream: "identity"},
		{Prefix: "/v1/workspaces", Upstream: "identity"},
		{Prefix: "/v1/credits", Upstream: "ledger"},
		{Prefix: "/v1/billing/webhook", Upstream: "identity", Public: true, PublicRPM: 600},
		{Prefix: "/v1/billing/", Upstream: "identity"},
		{Prefix: "/v1/projects", Upstream: "studio"},
		{Prefix: "/v1/notifications", Upstream: "studio"},
		{Prefix: "/v1/glossary", Upstream: "studio"},
		{Prefix: "/v1/review-queue", Upstream: "studio"},
		{Prefix: "/v1/admin/", Upstream: "studio"},
		{Prefix: "/v1/style-profiles", Upstream: "studio"},
		{Prefix: "/v1/consents", Upstream: "studio"},
		{Prefix: "/v1/xr/", Upstream: "studio"},
	}
}

func New(cfg Config) (*Gateway, error) {
	if len(cfg.JWTSecret) < 32 {
		return nil, errors.New("JWT_SECRET must be at least 32 bytes")
	}
	g := &Gateway{cfg: cfg, shed: &Shedder{Max: cfg.MaxInflight}, proxies: map[string]*httputil.ReverseProxy{}, breakers: map[string]*Breaker{}}
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 2 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:          2000,
		MaxIdleConnsPerHost:   500,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	for name, raw := range cfg.Upstreams {
		u, err := url.Parse(raw)
		if err != nil {
			return nil, err
		}
		br := NewBreaker(5, 10*time.Second)
		p := httputil.NewSingleHostReverseProxy(u)
		p.Transport = transport
		p.ModifyResponse = func(resp *http.Response) error {
			br.Record(resp.StatusCode < 500)
			return nil
		}
		p.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
			br.Record(false)
			cfg.Log.Warn("upstream error", "upstream", name, "err", err, "request_id", obs.RequestID(r.Context()))
			httpx.Error(w, http.StatusBadGateway, "upstream_unavailable", "the service is temporarily unavailable")
		}
		g.proxies[name], g.breakers[name] = p, br
	}
	return g, nil
}

func (g *Gateway) Handler() http.Handler {
	mux := http.NewServeMux()
	obs.MountOps(mux, g.cfg.Reg, func(context.Context) error {
		if g.cfg.Ready != nil {
			return g.cfg.Ready()
		}
		return nil
	})
	mux.HandleFunc("/", g.serve)
	return obs.Middleware("gateway", g.cfg.Log, g.cfg.Reg, mux)
}

func (g *Gateway) match(path string) *Route {
	var best *Route
	for i := range g.cfg.Routes {
		rt := &g.cfg.Routes[i]
		if strings.HasPrefix(path, rt.Prefix) || path == strings.TrimSuffix(rt.Prefix, "/") {
			if best == nil || len(rt.Prefix) > len(best.Prefix) {
				best = rt
			}
		}
	}
	return best
}

func clientIP(r *http.Request) string {
	// The edge load balancer appends the real client address as the last X-Forwarded-For hop.
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[len(parts)-1])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (g *Gateway) verify(r *http.Request) (*Claims, error) {
	raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if raw == "" || raw == r.Header.Get("Authorization") {
		return nil, errors.New("missing bearer token")
	}
	var c Claims
	_, err := jwt.ParseWithClaims(raw, &c, func(*jwt.Token) (any, error) { return g.cfg.JWTSecret, nil },
		jwt.WithValidMethods([]string{"HS256"}), jwt.WithExpirationRequired(), jwt.WithIssuer("xen-studio"), jwt.WithAudience("xen-studio"))
	if err != nil {
		return nil, err
	}
	if c.Subject == "" {
		return nil, errors.New("token has no subject")
	}
	return &c, nil
}

func (g *Gateway) limited(w http.ResponseWriter, scope string, retry time.Duration) {
	g.cfg.Reg.Counter("gateway_rate_limited_total", "scope", scope).Inc()
	secs := int(retry.Seconds()) + 1
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	httpx.Error(w, http.StatusTooManyRequests, "rate_limited", "too many requests ("+scope+" limit); retry in "+strconv.Itoa(secs)+"s")
}

var tenantHeaders = []string{"X-User-Id", "X-Workspace-Id", "X-Role", "X-Plan", "X-Priority", "X-Gateway-Token", "X-Internal-Token"}

func (g *Gateway) serve(w http.ResponseWriter, r *http.Request) {
	rt := g.match(r.URL.Path)
	if rt == nil || strings.HasPrefix(r.URL.Path, "/internal") {
		httpx.Error(w, http.StatusNotFound, "not_found", "no such route")
		return
	}
	// Never trust tenant headers from the outside.
	for _, h := range tenantHeaders {
		r.Header.Del(h)
	}

	var claims *Claims
	if !rt.Public {
		c, err := g.verify(r)
		if err != nil {
			httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "a valid access token is required")
			return
		}
		claims = c
	} else if c, err := g.verify(r); err == nil {
		claims = c // optional auth on public routes
	}

	priority := 0
	if claims != nil {
		priority = claims.Priority
	}
	// 1. admission control: shed lowest priorities first under load
	if !g.shed.Acquire(priority) {
		g.cfg.Reg.Counter("gateway_shed_total", "priority", strconv.Itoa(priority)).Inc()
		w.Header().Set("Retry-After", "2")
		httpx.Error(w, http.StatusServiceUnavailable, "overloaded", "the service is busy; please retry shortly")
		return
	}
	defer g.shed.Release()
	g.cfg.Reg.Gauge("gateway_inflight").Set(g.shed.Inflight())

	// 2. rate limits: per IP on public routes, per user and per workspace otherwise
	ctx := r.Context()
	if claims == nil {
		rpm := rt.PublicRPM
		if rpm <= 0 {
			rpm = 60
		}
		if ok, retry, _ := g.cfg.Limiter.Allow(ctx, "ip:"+clientIP(r)+":"+rt.Prefix, rpm, rpm); !ok {
			g.limited(w, "ip", retry)
			return
		}
	} else {
		rpm, wrpm := claims.RPM, claims.WRPM
		if rpm <= 0 {
			rpm = 60
		}
		if wrpm <= 0 {
			wrpm = 120
		}
		if ok, retry, _ := g.cfg.Limiter.Allow(ctx, "user:"+claims.Subject, rpm, rpm/2+1); !ok {
			g.limited(w, "user", retry)
			return
		}
		if claims.WorkspaceID != "" {
			if ok, retry, _ := g.cfg.Limiter.Allow(ctx, "ws:"+claims.WorkspaceID, wrpm, wrpm/2+1); !ok {
				g.limited(w, "workspace", retry)
				return
			}
		}
		r.Header.Set("X-User-Id", claims.Subject)
		r.Header.Set("X-Workspace-Id", claims.WorkspaceID)
		r.Header.Set("X-Role", claims.Role)
		r.Header.Set("X-Plan", claims.Plan)
		r.Header.Set("X-Priority", strconv.Itoa(claims.Priority))
	}
	r.Header.Set("X-Gateway-Token", g.cfg.GatewayToken)

	// 3. circuit breaker (bulkhead per upstream), then proxy
	br := g.breakers[rt.Upstream]
	proxy := g.proxies[rt.Upstream]
	if proxy == nil {
		httpx.Error(w, http.StatusBadGateway, "upstream_unavailable", "route has no upstream")
		return
	}
	if !br.Allow() {
		g.cfg.Reg.Counter("gateway_breaker_rejected_total", "upstream", rt.Upstream).Inc()
		w.Header().Set("Retry-After", "5")
		httpx.Error(w, http.StatusServiceUnavailable, "upstream_unavailable", "the service is temporarily unavailable")
		return
	}
	proxy.ServeHTTP(w, r)
}
