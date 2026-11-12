// Package ledger implements exactly-once credit accounting on an append-only ledger.
//
// Lifecycle of credits for one generation job:
//
//	reserve (available -> reserved)  before generation
//	commit  (reserved  -> spent)     on success   -> "debit" entry
//	release (reserved  -> available) on failure   -> "refund" entry
//
// Every write carries an idempotency key. A retry with the same key returns the first
// result and never moves credits twice; a retry with the same key but different
// arguments is rejected.
package ledger

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/lib/pq"
)

var (
	ErrInsufficient   = errors.New("insufficient credits")
	ErrNotFound       = errors.New("reservation not found")
	ErrAlreadySettled = errors.New("reservation already settled")
	ErrKeyConflict    = errors.New("idempotency key reused with different arguments")
	ErrInvalid        = errors.New("invalid argument")
)

type Balance struct {
	WorkspaceID string `json:"workspace_id"`
	Available   int64  `json:"available"`
	Reserved    int64  `json:"reserved"`
	Spent       int64  `json:"spent"`
}

type Entry struct {
	ID             string    `json:"id"`
	WorkspaceID    string    `json:"workspace_id"`
	Type           string    `json:"type"`
	Amount         int64     `json:"amount"`
	ReservationID  string    `json:"reservation_id,omitempty"`
	JobID          string    `json:"job_id,omitempty"`
	IdempotencyKey string    `json:"idempotency_key"`
	Reason         string    `json:"reason,omitempty"`
	AvailableAfter int64     `json:"balance_after"`
	ReservedAfter  int64     `json:"reserved_after"`
	CreatedAt      time.Time `json:"created_at"`
	Replayed       bool      `json:"replayed"`
}

type Store struct{ db *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func isCode(err error, codes ...string) bool {
	var pe *pq.Error
	if errors.As(err, &pe) {
		for _, c := range codes {
			if string(pe.Code) == c {
				return true
			}
		}
	}
	return false
}

// inTx runs fn in a transaction, retrying serialization failures (40001) and deadlocks
// (40P01), which distributed SQL engines return under contention.
func (s *Store) inTx(ctx context.Context, fn func(*sql.Tx) error) error {
	var err error
	for attempt := 0; attempt < 8; attempt++ {
		var tx *sql.Tx
		if tx, err = s.db.BeginTx(ctx, nil); err != nil {
			return err
		}
		if err = fn(tx); err == nil {
			if err = tx.Commit(); err == nil {
				return nil
			}
		} else {
			_ = tx.Rollback()
		}
		if !isCode(err, "40001", "40P01") {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(5*(1<<attempt)) * time.Millisecond):
		}
	}
	return err
}

const entryCols = `id, workspace_id, type, amount, COALESCE(reservation_id::text,''), COALESCE(job_id,''),
  idempotency_key, reason, balance_after, reserved_after, created_at`

func scanEntry(row interface{ Scan(...any) error }) (*Entry, error) {
	var e Entry
	if err := row.Scan(&e.ID, &e.WorkspaceID, &e.Type, &e.Amount, &e.ReservationID, &e.JobID,
		&e.IdempotencyKey, &e.Reason, &e.AvailableAfter, &e.ReservedAfter, &e.CreatedAt); err != nil {
		return nil, err
	}
	return &e, nil
}

func findByKey(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, ws, key string) (*Entry, error) {
	e, err := scanEntry(q.QueryRowContext(ctx,
		`SELECT `+entryCols+` FROM credit_transactions WHERE workspace_id=$1 AND idempotency_key=$2`, ws, key))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return e, err
}

// lockAccount creates the account row if needed and locks it for the transaction.
func lockAccount(ctx context.Context, tx *sql.Tx, ws string) (avail, reserved, spent int64, err error) {
	if _, err = tx.ExecContext(ctx,
		`INSERT INTO credit_accounts (workspace_id) VALUES ($1) ON CONFLICT (workspace_id) DO NOTHING`, ws); err != nil {
		return
	}
	err = tx.QueryRowContext(ctx,
		`SELECT available, reserved, spent FROM credit_accounts WHERE workspace_id=$1 FOR UPDATE`, ws).
		Scan(&avail, &reserved, &spent)
	return
}

func saveAccount(ctx context.Context, tx *sql.Tx, ws string, avail, reserved, spent int64) error {
	_, err := tx.ExecContext(ctx,
		`UPDATE credit_accounts SET available=$2, reserved=$3, spent=$4, updated_at=now() WHERE workspace_id=$1`,
		ws, avail, reserved, spent)
	return err
}

func insertEntry(ctx context.Context, tx *sql.Tx, e *Entry) error {
	e.ID = newUUID()
	var res, job any
	if e.ReservationID != "" {
		res = e.ReservationID
	}
	if e.JobID != "" {
		job = e.JobID
	}
	if err := tx.QueryRowContext(ctx,
		`INSERT INTO credit_transactions (workspace_id,id,type,amount,reservation_id,job_id,idempotency_key,reason,balance_after,reserved_after)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING created_at`,
		e.WorkspaceID, e.ID, e.Type, e.Amount, res, job, e.IdempotencyKey, e.Reason, e.AvailableAfter, e.ReservedAfter).
		Scan(&e.CreatedAt); err != nil {
		return err
	}
	// Transactional outbox: the Kafka event is recorded in the same transaction as the entry,
	// so billing, analytics and fraud consumers see every credit movement exactly once.
	payload, err := json.Marshal(e)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx,
		`INSERT INTO outbox (workspace_id, id, topic, event_type, payload) VALUES ($1,$2,$3,$4,$5)`,
		e.WorkspaceID, newUUID(), topicFor[e.Type], topicFor[e.Type], string(payload))
	return err
}

// topicFor maps a ledger entry type to its Kafka topic (Master Stack "Kafka topics").
var topicFor = map[string]string{
	"reserve": "credits.reserved",
	"debit":   "credits.debited",
	"refund":  "credits.refunded",
	"grant":   "credits.granted",
}

// write wraps one idempotent ledger operation. want describes the operation for replay checks.
func (s *Store) write(ctx context.Context, ws, key string, match func(*Entry) bool, apply func(*sql.Tx) (*Entry, error)) (*Entry, error) {
	if key == "" || len(key) > 200 {
		return nil, fmt.Errorf("%w: Idempotency-Key is required (max 200 chars)", ErrInvalid)
	}
	replay := func(e *Entry) (*Entry, error) {
		if !match(e) {
			return nil, ErrKeyConflict
		}
		e.Replayed = true
		return e, nil
	}
	var out *Entry
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		out = nil
		// Lock first so concurrent retries of the same key serialize on the account row.
		if _, _, _, err := lockAccount(ctx, tx, ws); err != nil {
			return err
		}
		prev, err := findByKey(ctx, tx, ws, key)
		if err != nil {
			return err
		}
		if prev != nil {
			out, err = replay(prev)
			return err
		}
		out, err = apply(tx)
		return err
	})
	if err != nil && isCode(err, "23505") { // lost a race on the unique key: return the winner
		prev, ferr := findByKey(ctx, s.db, ws, key)
		if ferr != nil {
			return nil, ferr
		}
		if prev != nil {
			return replay(prev)
		}
	}
	return out, err
}

// Grant adds credits (plan renewal, purchase, promo).
func (s *Store) Grant(ctx context.Context, ws, key string, amount int64, reason string) (*Entry, error) {
	if amount <= 0 {
		return nil, fmt.Errorf("%w: amount must be positive", ErrInvalid)
	}
	return s.write(ctx, ws, key,
		func(e *Entry) bool { return e.Type == "grant" && e.Amount == amount },
		func(tx *sql.Tx) (*Entry, error) {
			a, r, sp, err := lockAccount(ctx, tx, ws)
			if err != nil {
				return nil, err
			}
			a += amount
			e := &Entry{WorkspaceID: ws, Type: "grant", Amount: amount, IdempotencyKey: key, Reason: reason, AvailableAfter: a, ReservedAfter: r}
			if err := insertEntry(ctx, tx, e); err != nil {
				return nil, err
			}
			return e, saveAccount(ctx, tx, ws, a, r, sp)
		})
}

// Reserve holds credits for a job before generation starts.
func (s *Store) Reserve(ctx context.Context, ws, key string, amount int64, jobID string) (*Entry, error) {
	if amount <= 0 {
		return nil, fmt.Errorf("%w: amount must be positive", ErrInvalid)
	}
	return s.write(ctx, ws, key,
		func(e *Entry) bool { return e.Type == "reserve" && e.Amount == amount && e.JobID == jobID },
		func(tx *sql.Tx) (*Entry, error) {
			a, r, sp, err := lockAccount(ctx, tx, ws)
			if err != nil {
				return nil, err
			}
			if a < amount {
				return nil, ErrInsufficient
			}
			a, r = a-amount, r+amount
			resID := newUUID()
			var job any
			if jobID != "" {
				job = jobID
			}
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO credit_reservations (workspace_id,id,amount,status,job_id) VALUES ($1,$2,$3,'held',$4)`,
				ws, resID, amount, job); err != nil {
				return nil, err
			}
			e := &Entry{WorkspaceID: ws, Type: "reserve", Amount: amount, ReservationID: resID, JobID: jobID, IdempotencyKey: key, AvailableAfter: a, ReservedAfter: r}
			if err := insertEntry(ctx, tx, e); err != nil {
				return nil, err
			}
			return e, saveAccount(ctx, tx, ws, a, r, sp)
		})
}

func lockReservation(ctx context.Context, tx *sql.Tx, ws, id string) (amount int64, status, job string, err error) {
	err = tx.QueryRowContext(ctx,
		`SELECT amount, status, COALESCE(job_id,'') FROM credit_reservations WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, ws, id).
		Scan(&amount, &status, &job)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

// Commit debits a held reservation after a successful job. If actual is lower than the
// held amount (the job cost less than estimated) the remainder returns to available
// with its own "refund" entry. actual <= 0 means the full held amount.
func (s *Store) Commit(ctx context.Context, ws, key, reservationID string, actual int64) (*Entry, error) {
	return s.write(ctx, ws, key,
		func(e *Entry) bool { return e.Type == "debit" && e.ReservationID == reservationID },
		func(tx *sql.Tx) (*Entry, error) {
			a, r, sp, err := lockAccount(ctx, tx, ws)
			if err != nil {
				return nil, err
			}
			held, status, job, err := lockReservation(ctx, tx, ws, reservationID)
			if err != nil {
				return nil, err
			}
			if status != "held" {
				return nil, ErrAlreadySettled
			}
			if actual <= 0 {
				actual = held
			}
			if actual > held {
				return nil, fmt.Errorf("%w: actual %d exceeds held %d", ErrInvalid, actual, held)
			}
			r, sp = r-actual, sp+actual
			e := &Entry{WorkspaceID: ws, Type: "debit", Amount: actual, ReservationID: reservationID, JobID: job, IdempotencyKey: key, AvailableAfter: a, ReservedAfter: r}
			if err := insertEntry(ctx, tx, e); err != nil {
				return nil, err
			}
			if rest := held - actual; rest > 0 {
				a, r = a+rest, r-rest
				re := &Entry{WorkspaceID: ws, Type: "refund", Amount: rest, ReservationID: reservationID, JobID: job, IdempotencyKey: key + ":remainder", Reason: "unused reservation", AvailableAfter: a, ReservedAfter: r}
				if err := insertEntry(ctx, tx, re); err != nil {
					return nil, err
				}
			}
			if _, err := tx.ExecContext(ctx,
				`UPDATE credit_reservations SET status='committed', settled_at=now() WHERE workspace_id=$1 AND id=$2`, ws, reservationID); err != nil {
				return nil, err
			}
			return e, saveAccount(ctx, tx, ws, a, r, sp)
		})
}

// Release refunds a held reservation after a failed or cancelled job.
func (s *Store) Release(ctx context.Context, ws, key, reservationID, reason string) (*Entry, error) {
	return s.write(ctx, ws, key,
		func(e *Entry) bool { return e.Type == "refund" && e.ReservationID == reservationID },
		func(tx *sql.Tx) (*Entry, error) {
			a, r, sp, err := lockAccount(ctx, tx, ws)
			if err != nil {
				return nil, err
			}
			held, status, job, err := lockReservation(ctx, tx, ws, reservationID)
			if err != nil {
				return nil, err
			}
			if status != "held" {
				return nil, ErrAlreadySettled
			}
			a, r = a+held, r-held
			e := &Entry{WorkspaceID: ws, Type: "refund", Amount: held, ReservationID: reservationID, JobID: job, IdempotencyKey: key, Reason: reason, AvailableAfter: a, ReservedAfter: r}
			if err := insertEntry(ctx, tx, e); err != nil {
				return nil, err
			}
			if _, err := tx.ExecContext(ctx,
				`UPDATE credit_reservations SET status='released', settled_at=now() WHERE workspace_id=$1 AND id=$2`, ws, reservationID); err != nil {
				return nil, err
			}
			return e, saveAccount(ctx, tx, ws, a, r, sp)
		})
}

func (s *Store) Balance(ctx context.Context, ws string) (*Balance, error) {
	b := &Balance{WorkspaceID: ws}
	err := s.db.QueryRowContext(ctx,
		`SELECT available, reserved, spent FROM credit_accounts WHERE workspace_id=$1`, ws).Scan(&b.Available, &b.Reserved, &b.Spent)
	if errors.Is(err, sql.ErrNoRows) {
		return b, nil
	}
	return b, err
}

func (s *Store) Entries(ctx context.Context, ws string, limit int) ([]Entry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+entryCols+` FROM credit_transactions WHERE workspace_id=$1 ORDER BY created_at DESC, id LIMIT $2`, ws, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}
