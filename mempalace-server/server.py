"""
MemPalace HTTP Server — NOS Town persistent memory layer.

Implements a hierarchical memory palace (Wings/Rooms/Halls/Drawers)
backed by SQLite with FTS5 for text search, plus a temporal KG triple store.
"""

import sqlite3
import json
import hashlib
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Any

from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ── Configuration ───────────────────────────────────────────────────────────

DB_PATH = os.environ.get(
    "MEMPALACE_DB",
    str(Path(__file__).parent.parent / "palace-db" / "palace.sqlite"),
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="MemPalace Server", version="0.1.0", lifespan=lifespan)

# ── Database bootstrap ───────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def init_db():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS wings (
            id       TEXT PRIMARY KEY,
            metadata TEXT
        );

        CREATE TABLE IF NOT EXISTS rooms (
            id       TEXT PRIMARY KEY,
            wing_id  TEXT NOT NULL,
            metadata TEXT
        );

        CREATE TABLE IF NOT EXISTS halls (
            id        TEXT PRIMARY KEY,
            room_id   TEXT NOT NULL,
            hall_type TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS drawers (
            id                  TEXT PRIMARY KEY,
            wing_id             TEXT NOT NULL,
            hall_type           TEXT NOT NULL,
            room_id             TEXT NOT NULL,
            content             TEXT NOT NULL,
            created_at          TEXT NOT NULL,
            embedding_keywords  TEXT
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS drawers_fts
            USING fts5(id UNINDEXED, content, embedding_keywords, content=drawers);

        CREATE TABLE IF NOT EXISTS diaries (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            wing_id    TEXT NOT NULL,
            content    TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS kg_triples (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            subject    TEXT NOT NULL,
            relation   TEXT NOT NULL,
            object     TEXT NOT NULL,
            valid_from TEXT NOT NULL,
            valid_to   TEXT,
            agent_id   TEXT NOT NULL,
            metadata   TEXT,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_kg_subject    ON kg_triples(subject);
        CREATE INDEX IF NOT EXISTS idx_kg_relation   ON kg_triples(relation);
        CREATE INDEX IF NOT EXISTS idx_kg_valid_from ON kg_triples(valid_from);
        CREATE INDEX IF NOT EXISTS idx_kg_valid_to   ON kg_triples(valid_to);

        CREATE TABLE IF NOT EXISTS tunnels (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            wing_a  TEXT NOT NULL,
            wing_b  TEXT NOT NULL,
            room_name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS checkpoints (
            id         TEXT PRIMARY KEY,
            agent_id   TEXT NOT NULL,
            plan       TEXT NOT NULL,
            bead_ids   TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
    """)
    db.commit()
    db.close()


# ── Helpers ──────────────────────────────────────────────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def today_iso() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def row_to_dict(row) -> dict:
    if row is None:
        return {}
    d = dict(row)
    for k, v in d.items():
        if isinstance(v, str) and v.startswith("{"):
            try:
                d[k] = json.loads(v)
            except Exception:
                pass
    return d


def triple_row_to_dict(row) -> dict:
    d = dict(row)
    if d.get("metadata"):
        try:
            d["metadata"] = json.loads(d["metadata"])
        except Exception:
            pass
    return d


def compute_state_hash(db: sqlite3.Connection) -> str:
    rows = db.execute(
        "SELECT id, created_at FROM kg_triples ORDER BY id DESC LIMIT 100"
    ).fetchall()
    payload = ",".join(f"{r['id']}:{r['created_at']}" for r in rows)
    return hashlib.sha256(payload.encode()).hexdigest()


def ensure_wing(db: sqlite3.Connection, wing_id: str, metadata: dict = None):
    existing = db.execute("SELECT id FROM wings WHERE id = ?", (wing_id,)).fetchone()
    if not existing:
        db.execute(
            "INSERT INTO wings (id, metadata) VALUES (?, ?)",
            (wing_id, json.dumps(metadata or {})),
        )


def ensure_room(db: sqlite3.Connection, wing_id: str, room_id: str, metadata: dict = None):
    ensure_wing(db, wing_id)
    existing = db.execute("SELECT id FROM rooms WHERE id = ?", (room_id,)).fetchone()
    if not existing:
        db.execute(
            "INSERT INTO rooms (id, wing_id, metadata) VALUES (?, ?, ?)",
            (room_id, wing_id, json.dumps(metadata or {})),
        )
    # Check for tunnel: if another wing has the same room_name, create a tunnel
    room_name = room_id.split("_", 1)[-1] if "_" in room_id else room_id
    other_wings = db.execute(
        "SELECT DISTINCT wing_id FROM rooms WHERE id != ? AND id LIKE ?",
        (room_id, f"%_{room_name}"),
    ).fetchall()
    for other in other_wings:
        other_wing = other["wing_id"]
        if other_wing != wing_id:
            exists = db.execute(
                "SELECT 1 FROM tunnels WHERE (wing_a = ? AND wing_b = ?) OR (wing_a = ? AND wing_b = ?)",
                (wing_id, other_wing, other_wing, wing_id),
            ).fetchone()
            if not exists:
                db.execute(
                    "INSERT INTO tunnels (wing_a, wing_b, room_name) VALUES (?, ?, ?)",
                    (wing_id, other_wing, room_name),
                )


# ── Pydantic models ───────────────────────────────────────────────────────────

class WakeupRequest(BaseModel):
    wing_id: str
    roles: Optional[list[str]] = None


class SearchRequest(BaseModel):
    query: str
    wing_id: Optional[str] = None
    hall_type: Optional[str] = None


class DrawerRequest(BaseModel):
    wing_id: str
    hall_type: str
    room_id: str
    content: str
    embedding_keywords: Optional[str] = None


class KGAddRequest(BaseModel):
    subject: str
    relation: str
    object: str
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    agent_id: str
    metadata: Optional[dict] = None


class KGInvalidateRequest(BaseModel):
    triple_id: int
    valid_to: str
    reason: Optional[str] = None


class DiaryWriteRequest(BaseModel):
    wing_id: str
    content: str


# ── Pydantic models (continued) ──────────────────────────────────────────────

class CheckpointSaveRequest(BaseModel):
    agent_id: str
    plan: dict
    bead_ids: list[str]


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/palace/wakeup")
def palace_wakeup(req: WakeupRequest):
    db = get_db()
    try:
        ensure_wing(db, req.wing_id)
        db.commit()

        # L0: wing identity
        wing_row = db.execute("SELECT * FROM wings WHERE id = ?", (req.wing_id,)).fetchone()
        l0 = f"Wing: {req.wing_id}"
        if wing_row and wing_row["metadata"]:
            meta = json.loads(wing_row["metadata"]) if isinstance(wing_row["metadata"], str) else wing_row["metadata"]
            if meta:
                l0 += f" | {json.dumps(meta)}"

        # L1: critical facts from hall_facts
        fact_rows = db.execute(
            """SELECT * FROM drawers
               WHERE wing_id = ? AND hall_type = 'hall_facts'
               ORDER BY created_at DESC LIMIT 5""",
            (req.wing_id,),
        ).fetchall()
        facts = [dict(r) for r in fact_rows]
        l1_parts = [f["content"][:200] for f in facts]
        l1 = " | ".join(l1_parts) if l1_parts else "No facts yet."

        return {
            "wing_id": req.wing_id,
            "l0": l0,
            "l1": l1,
            "facts": facts,
        }
    finally:
        db.close()


@app.post("/palace/search")
def palace_search(req: SearchRequest):
    db = get_db()
    try:
        # FTS5 search
        fts_query = req.query.replace('"', '""')
        sql = """
            SELECT d.* FROM drawers_fts
            JOIN drawers d ON drawers_fts.id = d.id
            WHERE drawers_fts MATCH ?
        """
        params: list[Any] = [fts_query]

        if req.wing_id:
            sql += " AND d.wing_id = ?"
            params.append(req.wing_id)
        if req.hall_type:
            sql += " AND d.hall_type = ?"
            params.append(req.hall_type)

        sql += " ORDER BY rank LIMIT 20"

        rows = db.execute(sql, params).fetchall()
        results = [dict(r) for r in rows]

        return {"results": results, "total": len(results)}
    except Exception as e:
        # FTS5 match can throw on malformed queries; fall back to LIKE
        sql = "SELECT * FROM drawers WHERE content LIKE ?"
        params = [f"%{req.query}%"]
        if req.wing_id:
            sql += " AND wing_id = ?"
            params.append(req.wing_id)
        sql += " LIMIT 20"
        rows = db.execute(sql, params).fetchall()
        return {"results": [dict(r) for r in rows], "total": len(rows)}
    finally:
        db.close()


@app.post("/palace/drawer")
def add_drawer(req: DrawerRequest):
    db = get_db()
    try:
        ensure_room(db, req.wing_id, req.room_id)

        drawer_id = str(uuid.uuid4())
        created_at = now_iso()

        db.execute(
            """INSERT INTO drawers (id, wing_id, hall_type, room_id, content, created_at, embedding_keywords)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (drawer_id, req.wing_id, req.hall_type, req.room_id, req.content, created_at, req.embedding_keywords),
        )
        # Update FTS index
        db.execute(
            "INSERT INTO drawers_fts(id, content, embedding_keywords) VALUES (?, ?, ?)",
            (drawer_id, req.content, req.embedding_keywords or ""),
        )
        db.commit()
        return {"id": drawer_id, "created_at": created_at}
    finally:
        db.close()


@app.delete("/palace/drawer/{drawer_id}")
def delete_drawer(drawer_id: str):
    db = get_db()
    try:
        existing = db.execute("SELECT id FROM drawers WHERE id = ?", (drawer_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Drawer not found")
        db.execute("DELETE FROM drawers WHERE id = ?", (drawer_id,))
        db.execute("DELETE FROM drawers_fts WHERE id = ?", (drawer_id,))
        db.commit()
        return {"success": True}
    finally:
        db.close()


@app.post("/kg/add")
def kg_add(req: KGAddRequest):
    db = get_db()
    try:
        valid_from = req.valid_from or today_iso()
        created_at = now_iso()
        metadata_json = json.dumps(req.metadata) if req.metadata else None

        cursor = db.execute(
            """INSERT INTO kg_triples (subject, relation, object, valid_from, valid_to, agent_id, metadata, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (req.subject, req.relation, req.object, valid_from, req.valid_to, req.agent_id, metadata_json, created_at),
        )
        db.commit()
        return {"triple_id": cursor.lastrowid}
    finally:
        db.close()


@app.get("/kg/query")
def kg_query(
    subject: str = Query(...),
    as_of: Optional[str] = Query(None),
    relation: Optional[str] = Query(None),
):
    db = get_db()
    try:
        date = as_of or today_iso()
        sql = """
            SELECT * FROM kg_triples
            WHERE subject = ?
              AND valid_from <= ?
              AND (valid_to IS NULL OR valid_to >= ?)
        """
        params: list[Any] = [subject, date, date]

        if relation:
            sql += " AND relation = ?"
            params.append(relation)

        sql += " ORDER BY valid_from DESC, created_at DESC"
        rows = db.execute(sql, params).fetchall()
        return [triple_row_to_dict(r) for r in rows]
    finally:
        db.close()


@app.get("/kg/timeline/{subject}")
def kg_timeline(subject: str):
    db = get_db()
    try:
        rows = db.execute(
            """SELECT * FROM kg_triples
               WHERE subject = ? OR object = ?
               ORDER BY valid_from ASC, created_at ASC""",
            (subject, subject),
        ).fetchall()
        return [triple_row_to_dict(r) for r in rows]
    finally:
        db.close()


@app.post("/kg/invalidate")
def kg_invalidate(req: KGInvalidateRequest):
    db = get_db()
    try:
        existing = db.execute(
            "SELECT id, metadata FROM kg_triples WHERE id = ?", (req.triple_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Triple not found")

        meta = {}
        if existing["metadata"]:
            try:
                meta = json.loads(existing["metadata"])
            except Exception:
                pass
        if req.reason:
            meta["invalidation_reason"] = req.reason

        db.execute(
            "UPDATE kg_triples SET valid_to = ?, metadata = ? WHERE id = ?",
            (req.valid_to, json.dumps(meta), req.triple_id),
        )
        db.commit()
        return {"success": True}
    finally:
        db.close()


@app.post("/diary/write")
def diary_write(req: DiaryWriteRequest):
    db = get_db()
    try:
        ensure_wing(db, req.wing_id)
        cursor = db.execute(
            "INSERT INTO diaries (wing_id, content, created_at) VALUES (?, ?, ?)",
            (req.wing_id, req.content, now_iso()),
        )
        db.commit()
        return {"id": cursor.lastrowid}
    finally:
        db.close()


@app.get("/diary/read/{wing_id}")
def diary_read(wing_id: str, limit: int = Query(20)):
    db = get_db()
    try:
        rows = db.execute(
            "SELECT * FROM diaries WHERE wing_id = ? ORDER BY created_at DESC LIMIT ?",
            (wing_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        db.close()


@app.get("/palace/status")
def palace_status():
    db = get_db()
    try:
        wings = db.execute("SELECT COUNT(*) FROM wings").fetchone()[0]
        rooms = db.execute("SELECT COUNT(*) FROM rooms").fetchone()[0]
        drawers = db.execute("SELECT COUNT(*) FROM drawers").fetchone()[0]
        kg_triples = db.execute("SELECT COUNT(*) FROM kg_triples").fetchone()[0]
        state_hash = compute_state_hash(db)
        return {
            "wings": wings,
            "rooms": rooms,
            "drawers": drawers,
            "kg_triples": kg_triples,
            "state_hash": state_hash,
        }
    finally:
        db.close()


@app.get("/palace/wings")
def list_wings():
    db = get_db()
    try:
        rows = db.execute("SELECT * FROM wings ORDER BY id").fetchall()
        return [row_to_dict(r) for r in rows]
    finally:
        db.close()


@app.get("/palace/rooms/{wing_id}")
def list_rooms(wing_id: str):
    db = get_db()
    try:
        rows = db.execute(
            "SELECT * FROM rooms WHERE wing_id = ? ORDER BY id", (wing_id,)
        ).fetchall()
        return [row_to_dict(r) for r in rows]
    finally:
        db.close()


@app.get("/palace/tunnels")
def list_tunnels():
    db = get_db()
    try:
        rows = db.execute("SELECT * FROM tunnels ORDER BY id").fetchall()
        return [dict(r) for r in rows]
    finally:
        db.close()


@app.post("/palace/checkpoint")
def save_checkpoint(req: CheckpointSaveRequest):
    """Save a Mayor dispatch plan checkpoint. Returns plan_checkpoint_id."""
    db = get_db()
    try:
        checkpoint_id = f"ckpt_{uuid.uuid4().hex[:12]}"
        db.execute(
            "INSERT INTO checkpoints (id, agent_id, plan, bead_ids, created_at) VALUES (?, ?, ?, ?, ?)",
            (checkpoint_id, req.agent_id, json.dumps(req.plan), json.dumps(req.bead_ids), now_iso()),
        )
        # Also store in hall_facts so wakeup can discover it
        ensure_wing(db, "wing_mayor")
        drawer_id = str(uuid.uuid4())
        content = json.dumps({"checkpoint_id": checkpoint_id, "agent_id": req.agent_id, "bead_count": len(req.bead_ids)})
        db.execute(
            """INSERT INTO drawers (id, wing_id, hall_type, room_id, content, created_at, embedding_keywords)
               VALUES (?, 'wing_mayor', 'hall_facts', 'active-convoy', ?, ?, ?)""",
            (drawer_id, content, now_iso(), "active-convoy checkpoint"),
        )
        db.execute(
            "INSERT INTO drawers_fts(id, content, embedding_keywords) VALUES (?, ?, ?)",
            (drawer_id, content, "active-convoy checkpoint"),
        )
        db.commit()
        return {"checkpoint_id": checkpoint_id}
    finally:
        db.close()


@app.get("/palace/checkpoint/{checkpoint_id}")
def verify_checkpoint(checkpoint_id: str):
    """Verify a checkpoint exists. Used by bus.ts dispatch guard."""
    db = get_db()
    try:
        row = db.execute(
            "SELECT id, agent_id, bead_ids, created_at FROM checkpoints WHERE id = ?",
            (checkpoint_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Checkpoint not found")
        return {
            "checkpoint_id": row["id"],
            "agent_id": row["agent_id"],
            "bead_count": len(json.loads(row["bead_ids"])),
            "created_at": row["created_at"],
            "valid": True,
        }
    finally:
        db.close()


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("MEMPALACE_PORT", "7474"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
