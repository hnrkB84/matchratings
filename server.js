// server.js — HV71 Ratings: trupp per match + röstarkontext + AI-export + ⭐
// Install: npm i express better-sqlite3 cors express-rate-limit
// Start:   node server.js

const fs = require("fs");
const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();

// --- Robust DB-init + tydlig logg ---
const NODE = process.versions.node;
console.log("[BOOT] Node version:", NODE);

// Sätt DB_PATH (Render: /var/data/hv71.db, lokalt: ./data/hv71.db)
const localDataDir = path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH || path.join(localDataDir, "hv71.db");

// Se till att katalogen där DB-filen ligger existerar
const dbDir = path.dirname(DB_PATH);
try {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log("[BOOT] Ensured DB dir:", dbDir);
} catch (e) {
  console.error("[BOOT] Failed to create DB dir", dbDir, e);
  process.exit(1);
}

// Öppna SQLite med tydlig felhantering
let db;
try {
  db = new Database(DB_PATH);
  console.log("[BOOT] SQLite opened OK at", DB_PATH);
} catch (err) {
  console.error("[BOOT] FAILED opening SQLite at", DB_PATH, err);
  process.exit(1);
}

// --- Middleware ---
app.use(express.json());

// CORS: localhost i dev + PROD_ORIGIN i prod
const allowedOrigins = [
  "http://localhost:3000",
  process.env.PROD_ORIGIN // sätt i Render när du har din onrender-URL
].filter(Boolean);
app.use(cors({ origin: allowedOrigins }));

// Health-check för snabb koll av deploy och DB-path
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, node: NODE, db: DB_PATH });
});

// --- Rate limits (express-rate-limit v8: använd 'limit', inte 'max') ---
const voteLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20 });
app.use("/api/rate", voteLimiter);
app.use("/api/submit", voteLimiter);
// --- Tabeller & index ---
db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  jersey_number INTEGER,
  name TEXT UNIQUE,
  position TEXT,               -- G/D/F (eller B för back om du vill)
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  date TEXT,                   -- ISO yyyy-mm-dd
  opponent TEXT,
  home INTEGER,                -- 1=hemma, 0=borta
  season TEXT,
  competition TEXT,
  voting_open INTEGER DEFAULT 0,
  closes_at TEXT               -- ISO timestamp, valfri
);

-- Vilka spelare är uttagna till en viss match? (dagens trupp)
CREATE TABLE IF NOT EXISTS match_roster (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  dressed INTEGER DEFAULT 1,   -- 1=spelar/uttagna, 0=reserv/extra
  role TEXT,                   -- valfritt: "PP1", "PK", "Line1" etc.
  UNIQUE(match_id, player_id),
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  anon_fingerprint TEXT NOT NULL,
  rating_tenths INTEGER CHECK(rating_tenths BETWEEN 10 AND 100),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(match_id, player_id, anon_fingerprint),
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stars (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  anon_fingerprint TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(match_id, anon_fingerprint),
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
);

-- Frivillig röstarkontext (en post per match & fingerprint)
CREATE TABLE IF NOT EXISTS vote_context (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL,
  anon_fingerprint TEXT NOT NULL,
  attendance TEXT CHECK(attendance IN ('arena','tv','skip')),
  match_overall_tenths INTEGER CHECK(match_overall_tenths BETWEEN 10 AND 100),
  result_reflection_tenths INTEGER CHECK(result_reflection_tenths BETWEEN 10 AND 100),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(match_id, anon_fingerprint),
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE
);

-- Nyttiga index
CREATE INDEX IF NOT EXISTS idx_ratings_match ON ratings(match_id);
CREATE INDEX IF NOT EXISTS idx_ratings_player ON ratings(player_id);
CREATE INDEX IF NOT EXISTS idx_context_match ON vote_context(match_id);
CREATE INDEX IF NOT EXISTS idx_stars_match ON stars(match_id);
CREATE INDEX IF NOT EXISTS idx_roster_match ON match_roster(match_id);
`);

// --- Hjälpare ---
const clampToTenths = (num) => {
  if (typeof num !== "number") return null;
  const t = Math.round(num * 10);
  if (t < 10 || t > 100) return null;
  return t;
};
const validAttendance = (s) => (s === "arena" || s === "tv" || s === "skip") ? s : null;

// --- API: Players ---
// Om ?match_id anges -> returnera ENDAST spelare i truppen (default dressed=1).
// Skicka include_reserves=1 om du vill få även reserver.
app.get("/api/players", (req, res) => {
  const matchId = parseInt(req.query.match_id || "0", 10);
  const includeReserves = req.query.include_reserves === "1";

  if (matchId) {
    const rows = db.prepare(`
      SELECT p.*
      FROM match_roster mr
      JOIN players p ON p.id = mr.player_id
      WHERE mr.match_id = ?
        AND p.active = 1
        ${includeReserves ? "" : "AND mr.dressed = 1"}
      ORDER BY 
        CASE p.position WHEN 'G' THEN 0 WHEN 'D' THEN 1 WHEN 'B' THEN 1 WHEN 'F' THEN 2 ELSE 3 END,
        COALESCE(p.jersey_number, 999),
        p.name
    `).all(matchId);
    return res.json(rows);
  }

  // Utan match_id -> alla aktiva (för admin/uppslag)
  const rows = db.prepare(`
    SELECT * FROM players
    WHERE active=1
    ORDER BY 
      CASE position WHEN 'G' THEN 0 WHEN 'D' THEN 1 WHEN 'B' THEN 1 WHEN 'F' THEN 2 ELSE 3 END,
      COALESCE(jersey_number, 999),
      name
  `).all();
  res.json(rows);
});


// --- API: Matches ---
app.get("/api/matches", (req, res) => {
  res.json(db.prepare("SELECT * FROM matches ORDER BY date ASC, id ASC").all());
});
app.get("/api/matches/latest", (req, res) => {
  res.json(db.prepare("SELECT * FROM matches ORDER BY date DESC, id DESC LIMIT 1").get());
});
app.get("/api/matches/by-id", (req, res) => {
  const m = db.prepare("SELECT * FROM matches WHERE id=?").get(req.query.id);
  res.json(m || {});
});

// Senaste match med öppen röstning (tar hänsyn till closes_at)
app.get("/api/matches/current", (req, res) => {
  const row = db.prepare(`
    SELECT *
    FROM matches
    WHERE voting_open = 1
      AND (closes_at IS NULL OR datetime(closes_at) > datetime('now'))
    ORDER BY date DESC, id DESC
    LIMIT 1
  `).get();
  res.json(row || {});
});

// --- Enstaka rate (bakåtkomp) ---
app.post("/api/rate", (req, res) => {
  const { match_id, player_id, anon_fingerprint, rating } = req.body || {};
  if (!match_id || !player_id || !anon_fingerprint || typeof rating !== "number") {
    return res.status(400).json({ error: "Missing fields" });
  }
  const tenths = clampToTenths(rating);
  if (tenths === null) return res.status(400).json({ error: "Invalid rating" });

  const match = db.prepare("SELECT voting_open, closes_at FROM matches WHERE id=?").get(match_id);
  if (!match || !match.voting_open) return res.status(403).json({ error: "Voting closed" });
  if (match.closes_at && new Date(match.closes_at) < new Date()) return res.status(403).json({ error: "Voting closed" });

  // Tillåt endast spelare i trupp
  const inRoster = db.prepare("SELECT 1 FROM match_roster WHERE match_id=? AND player_id=?").get(match_id, player_id);
  if (!inRoster) return res.status(400).json({ error: "Player not on roster for this match" });

  db.prepare(`
    INSERT INTO ratings (match_id,player_id,anon_fingerprint,rating_tenths)
    VALUES (?,?,?,?)
    ON CONFLICT(match_id,player_id,anon_fingerprint)
    DO UPDATE SET rating_tenths=excluded.rating_tenths, updated_at=CURRENT_TIMESTAMP
  `).run(match_id, player_id, anon_fingerprint, tenths);

  res.json({ ok: true });
});

// --- Submit (alla betyg + ev ⭐ + kontext) ---
app.post("/api/submit", (req, res) => {
  const { match_id, anon_fingerprint, ratings, star_player_id,
          attendance, match_overall, result_reflection } = req.body || {};
  if (!match_id || !anon_fingerprint || !Array.isArray(ratings)) {
    return res.status(400).json({ error: "match_id, anon_fingerprint, ratings[]" });
  }

  const match = db.prepare("SELECT voting_open, closes_at FROM matches WHERE id=?").get(match_id);
  if (!match || !match.voting_open) return res.status(403).json({ error: "Voting closed" });
  if (match.closes_at && new Date(match.closes_at) < new Date()) return res.status(403).json({ error: "Voting closed" });

  const upsertRating = db.prepare(`
    INSERT INTO ratings (match_id,player_id,anon_fingerprint,rating_tenths)
    VALUES (?,?,?,?)
    ON CONFLICT(match_id,player_id,anon_fingerprint)
    DO UPDATE SET rating_tenths=excluded.rating_tenths, updated_at=CURRENT_TIMESTAMP
  `);
  const upsertStar = db.prepare(`
    INSERT INTO stars (match_id, player_id, anon_fingerprint)
    VALUES (?,?,?)
    ON CONFLICT(match_id, anon_fingerprint)
    DO UPDATE SET player_id=excluded.player_id, created_at=CURRENT_TIMESTAMP
  `);
  const upsertContext = db.prepare(`
    INSERT INTO vote_context (match_id, anon_fingerprint, attendance, match_overall_tenths, result_reflection_tenths)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(match_id, anon_fingerprint)
    DO UPDATE SET
      attendance = COALESCE(excluded.attendance, vote_context.attendance),
      match_overall_tenths = COALESCE(excluded.match_overall_tenths, vote_context.match_overall_tenths),
      result_reflection_tenths = COALESCE(excluded.result_reflection_tenths, vote_context.result_reflection_tenths),
      updated_at = CURRENT_TIMESTAMP
  `);

  const a = validAttendance(attendance);
  const mo = clampToTenths(match_overall);
  const rr = clampToTenths(result_reflection);

  // Hämtar roster som Set för snabba kollar
  const rosterIds = new Set(
    db.prepare("SELECT player_id FROM match_roster WHERE match_id=?").all(match_id).map(r => r.player_id)
  );

  const tx = db.transaction(() => {
    if (a || mo || rr) upsertContext.run(match_id, anon_fingerprint, a, mo, rr);

    for (const r of ratings) {
      if (!r || typeof r.player_id !== "number" || typeof r.rating !== "number") continue;
      if (!rosterIds.has(r.player_id)) continue; // ignorera spelare ej i trupp
      const tenths = clampToTenths(r.rating);
      if (tenths === null) continue;
      upsertRating.run(match_id, r.player_id, anon_fingerprint, tenths);
    }

    if (Number.isInteger(star_player_id) && rosterIds.has(star_player_id)) {
      upsertStar.run(match_id, star_player_id, anon_fingerprint);
    }
  });
  tx();

  res.json({ ok: true, saved: ratings.length, starred: Number.isInteger(star_player_id) && rosterIds.has(star_player_id) });
});

// --- Averages (attendance-filter) ---
app.get("/api/averages", (req, res) => {
  const matchId = req.query.match_id;
  if (!matchId) return res.status(400).json({ error: "match_id required" });

  const attendance = (req.query.attendance || "all").toLowerCase();
  const allowed = ["arena", "tv", "unknown", "all"];
  if (!allowed.includes(attendance)) return res.status(400).json({ error: "attendance must be arena|tv|unknown|all" });

  let whereAttendance = "1=1";
  if (attendance === "arena") whereAttendance = "vc.attendance = 'arena'";
  else if (attendance === "tv") whereAttendance = "vc.attendance = 'tv'";
  else if (attendance === "unknown") whereAttendance = "(vc.attendance IS NULL OR vc.attendance = 'skip')";

  const rows = db.prepare(`
    SELECT p.id,p.name,p.jersey_number,
           COUNT(r.rating_tenths) AS votes,
           ROUND(AVG(r.rating_tenths)/10.0,1) AS avg
    FROM match_roster mr
    JOIN players p ON p.id = mr.player_id
    LEFT JOIN ratings r
      ON r.player_id = p.id AND r.match_id = mr.match_id
    LEFT JOIN vote_context vc
      ON vc.match_id = r.match_id AND vc.anon_fingerprint = r.anon_fingerprint
    WHERE mr.match_id = ? AND p.active=1 AND ${whereAttendance}
    GROUP BY p.id
    ORDER BY avg DESC, votes DESC, p.name ASC
  `).all(matchId);

  res.json(rows);
});

// --- Matchfeedback (attendance-filter) ---
app.get("/api/match-feedback", (req, res) => {
  const matchId = req.query.match_id;
  if (!matchId) return res.status(400).json({ error: "match_id required" });

  const attendance = (req.query.attendance || "all").toLowerCase();
  const allowed = ["arena", "tv", "unknown", "all"];
  if (!allowed.includes(attendance)) return res.status(400).json({ error: "attendance must be arena|tv|unknown|all" });

  let whereAttendance = "1=1";
  if (attendance === "arena") whereAttendance = "attendance = 'arena'";
  else if (attendance === "tv") whereAttendance = "attendance = 'tv'";
  else if (attendance === "unknown") whereAttendance = "(attendance IS NULL OR attendance = 'skip')";

  const summary = db.prepare(`
    SELECT
      COUNT(*) AS submissions,
      ROUND(AVG(match_overall_tenths)/10.0,1) AS match_overall_avg,
      ROUND(AVG(result_reflection_tenths)/10.0,1) AS result_reflection_avg
    FROM vote_context
    WHERE match_id = ? AND ${whereAttendance}
  `).get(matchId);

  const byAtt = db.prepare(`
    SELECT COALESCE(attendance,'unknown') AS attendance,
           COUNT(*) AS submissions,
           ROUND(AVG(match_overall_tenths)/10.0,1) AS match_overall_avg,
           ROUND(AVG(result_reflection_tenths)/10.0,1) AS result_reflection_avg
    FROM vote_context
    WHERE match_id = ?
    GROUP BY COALESCE(attendance,'unknown')
    ORDER BY submissions DESC
  `).all(matchId);

  res.json({ summary, by_attendance: byAtt });
});

// --- Admin ---
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "secret123";

app.post("/api/admin/create-match", (req, res) => {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) return res.status(403).json({ error: "forbidden" });
  const { date, opponent, home, season, competition, voting_open = 0, closes_at = null } = req.body || {};
  const info = db.prepare(`
    INSERT INTO matches (date,opponent,home,season,competition,voting_open,closes_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(date, opponent, home ? 1 : 0, season, competition, voting_open ? 1 : 0, closes_at);
  res.json({ id: info.lastInsertRowid });
});

app.post("/api/admin/toggle-voting", (req, res) => {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) return res.status(403).json({ error: "forbidden" });
  const { id, open, closes_at = null } = req.body || {};
  db.prepare("UPDATE matches SET voting_open=?, closes_at=? WHERE id=?").run(open ? 1 : 0, closes_at, id);
  res.json({ ok: true });
});

app.post("/api/admin/bulk-upsert-players", (req, res) => {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) return res.status(403).json({ error: "forbidden" });
  const players = req.body?.players;
  if (!Array.isArray(players) || players.length === 0) {
    return res.status(400).json({ error: "Provide players: [{jersey_number, name, position, active}]" });
  }

  const findByName = db.prepare("SELECT id FROM players WHERE name = ? LIMIT 1");
  const insert = db.prepare("INSERT INTO players (jersey_number, name, position, active) VALUES (?,?,?,?)");
  const update = db.prepare("UPDATE players SET jersey_number=?, position=?, active=? WHERE id=?");

  const tx = db.transaction((rows) => {
    for (const p of rows) {
      const { jersey_number = null, name, position = null, active = 1 } = p;
      if (!name) continue;
      const existing = findByName.get(name);
      if (existing) update.run(jersey_number, position, active, existing.id);
      else insert.run(jersey_number, name, position, active);
    }
  });
  tx(players);

  res.json({ ok: true, count: players.length });
});

// --- Admin: sätt/ersätt trupp för match ---
app.post("/api/admin/set-roster", (req, res) => {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) return res.status(403).json({ error: "forbidden" });
  const { match_id, player_ids, dressed_default = 1 } = req.body || {};
  if (!match_id || !Array.isArray(player_ids)) return res.status(400).json({ error: "match_id & player_ids[]" });

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM match_roster WHERE match_id=?").run(match_id);
    const ins = db.prepare("INSERT INTO match_roster (match_id, player_id, dressed) VALUES (?,?,?)");
    for (const pid of player_ids) {
      if (Number.isInteger(pid)) ins.run(match_id, pid, dressed_default ? 1 : 0);
    }
  });
  tx();
  res.json({ ok: true, count: player_ids.length });
});

// --- Admin: lägg till/uppdatera enskild i trupp (t.ex. role/dressed) ---
app.post("/api/admin/upsert-roster-row", (req, res) => {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) return res.status(403).json({ error: "forbidden" });
  const { match_id, player_id, dressed = 1, role = null } = req.body || {};
  if (!match_id || !player_id) return res.status(400).json({ error: "match_id & player_id required" });

  db.prepare(`
    INSERT INTO match_roster (match_id, player_id, dressed, role)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(match_id, player_id)
    DO UPDATE SET dressed=excluded.dressed, role=excluded.role
  `).run(match_id, player_id, dressed ? 1 : 0, role);

  res.json({ ok: true });
});

// --- Export: AI-vänligt (CSV/JSONL) ---
const toCSV = (rows) => {
  if (!rows || !rows.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  return [headers.join(","), ...rows.map(r => headers.map(h => esc(r[h])).join(","))].join("\n");
};

// 1) Radrader per spelarbetyg
app.get("/api/export/ratings", (req, res) => {
  const matchId = parseInt(req.query.match_id || "0", 10);
  const format = (req.query.format || "csv").toLowerCase();
  if (!matchId) return res.status(400).json({ error: "match_id required" });

  const rows = db.prepare(`
    SELECT
      r.match_id,
      m.date AS match_date,
      m.opponent,
      m.home,
      p.id AS player_id,
      p.name AS player_name,
      p.position AS player_position,
      p.jersey_number,
      r.anon_fingerprint,
      ROUND(r.rating_tenths/10.0,1) AS rating,
      (SELECT player_id = r.player_id FROM stars s WHERE s.match_id=r.match_id AND s.anon_fingerprint=r.anon_fingerprint) AS is_star_for_voter,
      vc.attendance,
      ROUND(vc.match_overall_tenths/10.0,1) AS match_overall,
      ROUND(vc.result_reflection_tenths/10.0,1) AS result_reflection,
      r.created_at,
      r.updated_at
    FROM ratings r
    JOIN players p ON p.id = r.player_id
    JOIN matches m ON m.id = r.match_id
    LEFT JOIN vote_context vc ON vc.match_id=r.match_id AND vc.anon_fingerprint=r.anon_fingerprint
    WHERE r.match_id=?
    ORDER BY p.position, p.jersey_number, p.name, r.created_at
  `).all(matchId);

  if (format === "jsonl") {
    res.type("text/plain").send(rows.map(r => JSON.stringify(r)).join("\n"));
  } else {
    res.type("text/csv").send(toCSV(rows));
  }
});

// 2) En rad per röstare (kontext)
app.get("/api/export/votes", (req, res) => {
  const matchId = parseInt(req.query.match_id || "0", 10);
  const format = (req.query.format || "csv").toLowerCase();
  if (!matchId) return res.status(400).json({ error: "match_id required" });

  const rows = db.prepare(`
    SELECT
      vc.match_id,
      m.date AS match_date,
      m.opponent,
      m.home,
      vc.anon_fingerprint,
      vc.attendance,
      ROUND(vc.match_overall_tenths/10.0,1) AS match_overall,
      ROUND(vc.result_reflection_tenths/10.0,1) AS result_reflection,
      vc.created_at,
      vc.updated_at
    FROM vote_context vc
    JOIN matches m ON m.id = vc.match_id
    WHERE vc.match_id=?
    ORDER BY vc.created_at
  `).all(matchId);

  if (format === "jsonl") {
    res.type("text/plain").send(rows.map(r => JSON.stringify(r)).join("\n"));
  } else {
    res.type("text/csv").send(toCSV(rows));
  }
});

// 3) Aggregat per spelare + attendance-snitt
app.get("/api/export/aggregates", (req, res) => {
  const matchId = parseInt(req.query.match_id || "0", 10);
  const format = (req.query.format || "csv").toLowerCase();
  if (!matchId) return res.status(400).json({ error: "match_id required" });

  const rows = db.prepare(`
    WITH base AS (
      SELECT p.id AS player_id, p.name AS player_name, p.position, p.jersey_number,
             vc.attendance,
             r.rating_tenths
      FROM match_roster mr
      JOIN players p ON p.id = mr.player_id
      LEFT JOIN ratings r ON r.player_id=p.id AND r.match_id=mr.match_id
      LEFT JOIN vote_context vc ON vc.match_id = r.match_id AND vc.anon_fingerprint = r.anon_fingerprint
      WHERE mr.match_id = ?
    )
    SELECT
      player_id, player_name, position, jersey_number,
      COALESCE(attendance,'unknown') AS attendance,
      COUNT(rating_tenths) AS votes,
      ROUND(AVG(rating_tenths)/10.0,1) AS avg
    FROM base
    GROUP BY player_id, attendance
    ORDER BY position, jersey_number, player_name
  `).all(matchId);

  if (format === "jsonl") {
    res.type("text/plain").send(rows.map(r => JSON.stringify(r)).join("\n"));
  } else {
    res.type("text/csv").send(toCSV(rows));
  }
});

// --- Static (läggs sist) ---
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running http://localhost:${PORT}`);
});
