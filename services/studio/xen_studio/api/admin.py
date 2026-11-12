"""Admin & Analytics API (platform staff only).

These endpoints are the only place the platform reads across tenants, so every request
re-checks the caller's platform role in the database (it is deliberately not trusted from the
token) and every write is audit-logged. Aggregates come from the operational database today;
at scale they move to ClickHouse (infra/analytics) with the same response shapes.
"""
from __future__ import annotations

import json
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

PLATFORM_RANK = {"user": 0, "staff": 1, "superadmin": 2}


class ModerationReview(BaseModel):
    status: Literal["upheld", "overturned"]
    note: str = Field(default="", max_length=1000)


class UserStatus(BaseModel):
    status: Literal["active", "suspended"]
    reason: str = Field(min_length=3, max_length=500)


def build(deps, actor_dep) -> APIRouter:
    r = APIRouter(prefix="/v1/admin")

    def staff(a=Depends(actor_dep)):
        with deps.db() as conn:
            row = conn.execute("SELECT platform_role, status FROM users WHERE id=%s", (a.user_id,)).fetchone()
        if not row or row["status"] != "active" or PLATFORM_RANK.get(row["platform_role"], 0) < 1:
            raise HTTPException(403, "Admin & Analytics is limited to Xen Studio staff")
        a.platform_role = row["platform_role"]
        return a

    def audit(conn, a, action: str, target: str, meta: dict, ws: str) -> None:
        conn.execute("INSERT INTO audit_logs (workspace_id,id,actor_id,action,target,metadata) VALUES (%s,%s,%s,%s,%s,%s)",
                     (ws, str(uuid.uuid4()), a.user_id, action, target, json.dumps(meta)))

    @r.get("/overview")
    def overview(a=Depends(staff), days: int = 14):
        days = max(1, min(days, 90))
        with deps.db() as conn:
            q = lambda sql, *args: conn.execute(sql, args).fetchall()  # noqa: E731
            one = lambda sql, *args: conn.execute(sql, args).fetchone()  # noqa: E731
            users = one("SELECT count(*) AS total, count(*) FILTER (WHERE created_at > now() - interval '7 days') AS new_7d FROM users WHERE status <> 'deleted'")
            plans = q("SELECT p.id, p.name, p.monthly_price_cents, count(w.id)::int AS workspaces FROM plans p LEFT JOIN workspaces w ON w.plan_id = p.id AND w.status='active' GROUP BY p.id ORDER BY p.monthly_price_cents")
            mrr = sum(p["monthly_price_cents"] * p["workspaces"] for p in plans)
            credits = one("""SELECT COALESCE(sum(amount) FILTER (WHERE type='grant'),0)::bigint AS granted, COALESCE(sum(amount) FILTER (WHERE type='debit'),0)::bigint AS spent,
                                    COALESCE(sum(amount) FILTER (WHERE type='refund'),0)::bigint AS refunded FROM credit_transactions""")
            reserved = one("SELECT COALESCE(sum(reserved),0)::bigint AS r FROM credit_accounts")["r"]
            signups = q("""SELECT d::date AS day, count(u.id) AS n FROM generate_series(current_date - (%s - 1), current_date, interval '1 day') d
                           LEFT JOIN users u ON u.created_at::date = d::date GROUP BY d ORDER BY d""", days)
            cost_by_day = q("""SELECT d::date AS day, COALESCE(sum(j.cost_microusd),0)::bigint AS cost FROM generate_series(current_date - (%s - 1), current_date, interval '1 day') d
                               LEFT JOIN jobs j ON j.created_at::date = d::date GROUP BY d ORDER BY d""", days)
            spend_by_day = q("""SELECT d::date AS day, COALESCE(sum(t.amount),0)::bigint AS credits FROM generate_series(current_date - (%s - 1), current_date, interval '1 day') d
                                LEFT JOIN credit_transactions t ON t.created_at::date = d::date AND t.type='debit' GROUP BY d ORDER BY d""", days)
            providers = q("""SELECT type, provider, count(*) AS jobs, count(*) FILTER (WHERE status='failed') AS failed, COALESCE(sum(cost_microusd),0)::bigint AS cost,
                                    COALESCE(round(avg(duration_ms)),0)::bigint AS avg_ms FROM jobs WHERE created_at > now() - make_interval(days => %s)
                             GROUP BY type, provider ORDER BY cost DESC, jobs DESC""", days)
            queues = q("SELECT status, count(*) AS n FROM projects GROUP BY status ORDER BY status")
            loc_queue = one("SELECT count(*) AS n FROM localizations WHERE status='in_review'")["n"]
            exports = one("SELECT count(*) FILTER (WHERE status IN ('queued','running')) AS active, count(*) FILTER (WHERE status='failed') AS failed FROM exports")
            mod = one("""SELECT count(*) FILTER (WHERE decision='blocked') AS blocked, count(*) FILTER (WHERE decision<>'allowed' AND review_status='none') AS pending
                         FROM moderation_events WHERE created_at > now() - make_interval(days => %s)""", days)
            videos = one("SELECT count(*) AS n, COALESCE(sum(duration_ms),0)::bigint AS ms FROM renders WHERE created_at > now() - make_interval(days => %s)", days)
            outbox = one("SELECT count(*) AS n, COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)),0)::bigint AS oldest_s FROM outbox WHERE published_at IS NULL")
        total_cost = sum(c["cost"] for c in cost_by_day)
        minutes = videos["ms"] / 60000
        return {
            "users": users, "mrr_cents": mrr, "plans": plans,
            "credits": {**credits, "reserved": reserved},
            "videos": {"renders": videos["n"], "minutes": round(minutes, 1),
                       "provider_cost_usd": round(total_cost / 1e6, 4), "cost_per_minute_usd": round(total_cost / 1e6 / minutes, 4) if minutes else None},
            "series": {"signups": [{"day": str(x["day"]), "value": x["n"]} for x in signups],
                       "provider_cost_usd": [{"day": str(x["day"]), "value": round(x["cost"] / 1e6, 4)} for x in cost_by_day],
                       "credits_spent": [{"day": str(x["day"]), "value": x["credits"]} for x in spend_by_day]},
            "providers": [{**p, "cost_usd": round(p["cost"] / 1e6, 4), "failure_rate": round(p["failed"] / p["jobs"], 3) if p["jobs"] else 0} for p in providers],
            "queues": {"projects": {x["status"]: x["n"] for x in queues}, "localization_review": loc_queue, "exports": exports,
                       "moderation_pending": mod["pending"], "outbox_backlog": outbox["n"], "outbox_oldest_seconds": int(outbox["oldest_s"])},
            "moderation": {"blocked": mod["blocked"], "pending_review": mod["pending"]},
            "days": days,
        }

    @r.get("/users")
    def users(a=Depends(staff), q: str = "", limit: int = 50):
        like = f"%{q.strip().lower()}%"
        with deps.db() as conn:
            rows = conn.execute("""SELECT u.id, u.email, u.name, u.status, u.platform_role, u.created_at,
                                          (SELECT json_agg(json_build_object('id', w.id, 'name', w.name, 'plan', w.plan_id, 'role', m.role))
                                             FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = u.id) AS workspaces,
                                          (SELECT count(*) FROM projects p WHERE p.created_by = u.id) AS projects
                                   FROM users u WHERE (%s = '%%%%' OR lower(u.email) LIKE %s OR lower(u.name) LIKE %s)
                                   ORDER BY u.created_at DESC LIMIT %s""", (like, like, like, max(1, min(limit, 200)))).fetchall()
        return {"users": [{**x, "id": str(x["id"]), "created_at": str(x["created_at"]), "workspaces": x["workspaces"] or []} for x in rows]}

    @r.post("/users/{uid}/status")
    def set_user_status(uid: str, body: UserStatus, a=Depends(staff)):
        try:
            uuid.UUID(uid)
        except ValueError:
            raise HTTPException(404, "user not found") from None
        if uid == a.user_id:
            raise HTTPException(400, "you cannot change your own status")
        with deps.db() as conn:
            target = conn.execute("SELECT platform_role FROM users WHERE id=%s", (uid,)).fetchone()
            if not target:
                raise HTTPException(404, "user not found")
            if PLATFORM_RANK.get(target["platform_role"], 0) >= PLATFORM_RANK[a.platform_role]:
                raise HTTPException(403, "you cannot change a staff member at or above your level")
            conn.execute("UPDATE users SET status=%s, updated_at=now() WHERE id=%s", (body.status, uid))
            if body.status == "suspended":  # end every session now; access tokens expire within their 15-minute life
                conn.execute("UPDATE sessions SET revoked_at=now() WHERE user_id=%s AND revoked_at IS NULL", (uid,))
            audit(conn, a, f"admin.user.{body.status}", uid, {"reason": body.reason}, a.workspace_id)
        return {"id": uid, "status": body.status}

    @r.get("/moderation")
    def moderation(a=Depends(staff), state: Literal["pending", "all"] = "pending", limit: int = 50):
        with deps.db() as conn:
            rows = conn.execute("""SELECT m.workspace_id, m.id, m.subject_type, m.subject_id, m.decision, m.reason, m.provider, m.review_status, m.review_note, m.created_at,
                                          w.name AS workspace_name, p.title, p.prompt
                                   FROM moderation_events m JOIN workspaces w ON w.id = m.workspace_id
                                   LEFT JOIN projects p ON p.workspace_id = m.workspace_id AND p.id::text = split_part(m.subject_id, ':', 1)
                                   WHERE m.decision <> 'allowed' AND (%s = 'all' OR m.review_status = 'none')
                                   ORDER BY m.created_at DESC LIMIT %s""", (state, max(1, min(limit, 200)))).fetchall()
        return {"items": [{**x, "workspace_id": str(x["workspace_id"]), "id": str(x["id"]), "created_at": str(x["created_at"])} for x in rows]}

    @r.post("/moderation/{ws}/{mid}")
    async def review_moderation(ws: str, mid: str, body: ModerationReview, request: Request, a=Depends(staff)):
        try:
            uuid.UUID(ws), uuid.UUID(mid)
        except ValueError:
            raise HTTPException(404, "event not found") from None
        with deps.db() as conn:
            row = conn.execute("""UPDATE moderation_events SET review_status=%s, review_note=%s, reviewer_id=%s, updated_at=now()
                                  WHERE workspace_id=%s AND id=%s AND decision<>'allowed' RETURNING id, subject_type, subject_id""", (body.status, body.note, a.user_id, ws, mid)).fetchone()
            if not row:
                raise HTTPException(404, "event not found")
            audit(conn, a, f"admin.moderation.{body.status}", mid, {"note": body.note}, ws)
        if row["subject_type"] == "rights":
            # "overturned" = the hold was wrong, the project continues; "upheld" = the link may not be used
            await request.app.state.orch.signal(ws, row["subject_id"], "rights_decision", {"approved": body.status == "overturned"})
        return {"id": mid, "review_status": body.status}

    return r
