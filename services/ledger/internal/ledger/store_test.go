package ledger

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"

	_ "github.com/lib/pq"
)

func testStore(t *testing.T) (*Store, *sql.DB) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping ledger integration tests")
	}
	db, err := sql.Open("postgres", url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return NewStore(db), db
}

func mustBal(t *testing.T, s *Store, ws string, avail, reserved, spent int64) {
	t.Helper()
	b, err := s.Balance(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}
	if b.Available != avail || b.Reserved != reserved || b.Spent != spent {
		t.Fatalf("balance = %+v, want available=%d reserved=%d spent=%d", *b, avail, reserved, spent)
	}
}

func TestLifecycle(t *testing.T) {
	s, db := testStore(t)
	ctx, ws := context.Background(), newUUID()

	if _, err := s.Grant(ctx, ws, "g1", 100, "signup"); err != nil {
		t.Fatal(err)
	}
	r1, err := s.Reserve(ctx, ws, "r1", 40, "job-1")
	if err != nil {
		t.Fatal(err)
	}
	mustBal(t, s, ws, 60, 40, 0)

	// success path: commit less than held, the remainder is refunded
	if _, err := s.Commit(ctx, ws, "c1", r1.ReservationID, 30); err != nil {
		t.Fatal(err)
	}
	mustBal(t, s, ws, 70, 0, 30)

	// failure path: release refunds in full
	r2, _ := s.Reserve(ctx, ws, "r2", 50, "job-2")
	if _, err := s.Release(ctx, ws, "x2", r2.ReservationID, "provider failed"); err != nil {
		t.Fatal(err)
	}
	mustBal(t, s, ws, 70, 0, 30)

	// a settled reservation cannot be settled again under a new key
	if _, err := s.Commit(ctx, ws, "c2-new", r2.ReservationID, 0); !errors.Is(err, ErrAlreadySettled) {
		t.Fatalf("want ErrAlreadySettled, got %v", err)
	}
	if _, err := s.Reserve(ctx, ws, "r3", 71, "job-3"); !errors.Is(err, ErrInsufficient) {
		t.Fatalf("want ErrInsufficient, got %v", err)
	}
	// every entry has exactly one outbox event on the matching credits.* topic
	var events int
	var topics string
	db.QueryRow(`SELECT count(*), string_agg(DISTINCT topic, ',' ORDER BY topic) FROM outbox WHERE workspace_id=$1`, ws).Scan(&events, &topics)
	if events != 6 || topics != "credits.debited,credits.granted,credits.refunded,credits.reserved" {
		t.Fatalf("outbox: %d events on %q", events, topics)
	}
	es, _ := s.Entries(ctx, ws, 50)
	if len(es) != 6 { // grant, reserve, debit, refund(remainder), reserve, refund
		t.Fatalf("entries = %d, want 6", len(es))
	}
}

func TestIdempotentReplay(t *testing.T) {
	s, _ := testStore(t)
	ctx, ws := context.Background(), newUUID()
	a, _ := s.Grant(ctx, ws, "g", 100, "")
	b, err := s.Grant(ctx, ws, "g", 100, "")
	if err != nil || !b.Replayed || b.ID != a.ID {
		t.Fatalf("replay: %+v err=%v", b, err)
	}
	mustBal(t, s, ws, 100, 0, 0)
	if _, err := s.Grant(ctx, ws, "g", 999, ""); !errors.Is(err, ErrKeyConflict) {
		t.Fatalf("want ErrKeyConflict, got %v", err)
	}
	r, _ := s.Reserve(ctx, ws, "r", 10, "j")
	c1, _ := s.Commit(ctx, ws, "c", r.ReservationID, 0)
	c2, err := s.Commit(ctx, ws, "c", r.ReservationID, 0) // retried commit must not double-debit
	if err != nil || !c2.Replayed || c2.ID != c1.ID {
		t.Fatalf("commit replay: %+v err=%v", c2, err)
	}
	mustBal(t, s, ws, 90, 0, 10)
}

func TestConcurrentReservesNeverOverspend(t *testing.T) {
	s, _ := testStore(t)
	ctx, ws := context.Background(), newUUID()
	if _, err := s.Grant(ctx, ws, "g", 200, ""); err != nil {
		t.Fatal(err)
	}
	var ok, short atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 60; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := s.Reserve(ctx, ws, "r-"+string(rune('A'+i%26))+string(rune('a'+i/26)), 10, "job")
			switch {
			case err == nil:
				ok.Add(1)
			case errors.Is(err, ErrInsufficient):
				short.Add(1)
			default:
				t.Errorf("unexpected: %v", err)
			}
		}(i)
	}
	wg.Wait()
	if ok.Load() != 20 || short.Load() != 40 {
		t.Fatalf("ok=%d short=%d, want 20/40", ok.Load(), short.Load())
	}
	mustBal(t, s, ws, 0, 200, 0)
}

func TestConcurrentSameKeyAppliesOnce(t *testing.T) {
	s, _ := testStore(t)
	ctx, ws := context.Background(), newUUID()
	var wg sync.WaitGroup
	for i := 0; i < 25; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.Grant(ctx, ws, "same-key", 50, "retry storm"); err != nil {
				t.Errorf("grant: %v", err)
			}
		}()
	}
	wg.Wait()
	mustBal(t, s, ws, 50, 0, 0)
}

func TestLedgerIsAppendOnly(t *testing.T) {
	s, db := testStore(t)
	ctx, ws := context.Background(), newUUID()
	if _, err := s.Grant(ctx, ws, "g", 5, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE credit_transactions SET amount = 500 WHERE workspace_id=$1`, ws); err == nil {
		t.Fatal("UPDATE on credit_transactions must be rejected")
	}
	if _, err := db.Exec(`DELETE FROM credit_transactions WHERE workspace_id=$1`, ws); err == nil {
		t.Fatal("DELETE on credit_transactions must be rejected")
	}
}

func TestTenantIsolation(t *testing.T) {
	s, _ := testStore(t)
	ctx, a, b := context.Background(), newUUID(), newUUID()
	s.Grant(ctx, a, "g", 100, "")
	ra, _ := s.Reserve(ctx, a, "r", 10, "j")
	// workspace b cannot settle workspace a's reservation
	if _, err := s.Commit(ctx, b, "c", ra.ReservationID, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	mustBal(t, s, b, 0, 0, 0)
}
