package obs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type ctxKey int

const requestIDKey ctxKey = 1

// NewLogger returns a JSON structured logger tagged with the service and cell.
func NewLogger(service string) *slog.Logger {
	level := slog.LevelInfo
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	return slog.New(h).With("service", service, "cell", os.Getenv("CELL_ID"))
}

func RequestID(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey).(string); ok {
		return v
	}
	return ""
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) { w.status = code; w.ResponseWriter.WriteHeader(code) }
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// Middleware adds request ids, panic recovery, access logs and RED metrics.
// It honours an inbound W3C traceparent header so traces join across services.
func Middleware(service string, log *slog.Logger, reg *Registry, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		id := r.Header.Get("X-Request-Id")
		if id == "" || len(id) > 64 {
			id = newID()
			r.Header.Set("X-Request-Id", id)
		}
		if r.Header.Get("traceparent") == "" {
			r.Header.Set("traceparent", "00-"+newID()+"-"+newID()[:16]+"-01")
		}
		w.Header().Set("X-Request-Id", id)
		sw := &statusWriter{ResponseWriter: w, status: 200}
		ctx := context.WithValue(r.Context(), requestIDKey, id)
		defer func() {
			if rec := recover(); rec != nil {
				log.Error("panic", "request_id", id, "panic", rec)
				if sw.status == 200 {
					http.Error(sw, `{"error":{"code":"internal","message":"internal error"}}`, http.StatusInternalServerError)
				}
			}
			d := time.Since(start).Seconds()
			route := r.Pattern
			if route == "" {
				route = "unmatched"
			}
			reg.Counter("http_requests_total", "service", service, "route", route, "status", strconv.Itoa(sw.status)).Inc()
			reg.Histogram("http_request_duration_seconds", "service", service, "route", route).Observe(d)
			if r.URL.Path != "/healthz" && r.URL.Path != "/readyz" && r.URL.Path != "/metrics" {
				log.Info("request", "request_id", id, "trace", r.Header.Get("traceparent"), "method", r.Method,
					"path", r.URL.Path, "status", sw.status, "duration_ms", int(d*1000))
			}
		}()
		next.ServeHTTP(sw, r.WithContext(ctx))
	})
}

// MountOps registers /healthz, /readyz and /metrics. ready returns nil when dependencies are reachable.
func MountOps(mux *http.ServeMux, reg *Registry, ready func(context.Context) error) {
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if ready != nil {
			if err := ready(ctx); err != nil {
				http.Error(w, "not ready: "+err.Error(), http.StatusServiceUnavailable)
				return
			}
		}
		_, _ = w.Write([]byte("ready"))
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		reg.WriteText(w)
	})
}
