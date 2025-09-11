// server.js — HV71 Ratings: tidsstyrd röstning, trupp per match, sammanställning, export
// Install: npm i express better-sqlite3 cors express-rate-limit
// Start:   node server.js

const fs = require("fs");
const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();

// Lita på Render-proxy så X-Forwarded-* fungerar korrekt (fixar rate-limit felet)
app.set('trust proxy', 1);

// --- BOOT/DB-path ---
const NODE = process.versions.node;
console.log("[BOOT] Node version:", NODE);

const localDataDir = path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH || path.join(localDataDir, "hv71.db");

const dbDir = path.dirname(DB_PATH);
fs.mkdirSync(dbDir, { recursive: true });
console.log("[BOOT] DB dir OK:", dbDir);

// Öppna DB
const db = new Database(DB_PATH);
console.log("[BOOT] SQLite opened at", DB_PATH);

// --- Middleware ---
app.use(express.json());

// CORS
const allowedOrigins = [
  "http://localhost:3000",
  process.env.PROD_ORIGIN // sätt i Render: https://din-app.onrender.com
].filter(Boolean);
app.use(cors({ origin: allowedOrigins }));

// Health
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, node: NODE, db: DB_PATH, now: new Date().toISOString() });
});

// --- Rate limits ---
const keyByIp = (req) => (req.ip || req.headers['x-forwarded-for'] || 'ip-unknown').toString();

const voteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByIp
});
app.use("/api/submit", voteLimiter);
app.use("/api/rate", voteLimiter);

// (valfritt men bra): mild limiter för admin-API
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByIp
});
app.use("/api/admin", adminLimiter);

// --- Schema + auto-migrering ---
db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  jersey_number INTEGER,
  name TEXT UNIQUE,
  position TEXT,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  date TEXT,
  opponent TEXT,
  home INTEGER,
  season TEXT,
  competition TEXT,
  voting_open INTEGER DEFAULT 0,   -- kvar för bakåtkomp
  closes_at TEXT                   -- gammalt fält (bakåtkomp)
);

CREATE TABLE IF NOT EXISTS match_roster (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  dressed INTEGER DEFAULT 1,
  role TEXT,
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

-- OBS: innehåller nu även referee_level_tenths (Domarnivå)
CREATE TABLE IF NOT EXISTS vote_context (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL,
  anon_fingerprint TEXT NOT NULL,
  attendance TEXT CHECK(attendance IN ('arena','tv','skip')),
  match_overall_tenths INTEGER CHECK(match_overall_tenths BETWEEN 10 AND 100),
  result_reflection_tenths INTEGER CHECK(result_reflection_tenths BETWEEN 10 AND 100),
  referee_level_tenths INTEGER CHECK(referee_level_tenths BETWEEN 10 AND 100),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(match_id, anon_fingerprint),
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ratings_match ON ratings(match_id);
CREATE INDEX IF NOT EXISTS idx_ratings_player ON ratings(player_id);
CREATE INDEX IF NOT EXISTS idx_context_match ON vote_context(match_id);
CREATE INDEX IF NOT EXISTS idx_stars_match ON stars(match_id);
CREATE INDEX IF NOT EXISTS idx_roster_match ON match_roster(match_id);
`);

// Lägg till nya tidskolumner om de saknas
(function migrateMatchesAddOpenClose() {
  const cols = db.prepare(`PRAGMA table_info(matches)`).all();
  const names = new Set(cols.map(c => c.name));
  if (!names.has("open_at")) {
    console.log("[MIGRATE] Adding matches.open_at");
    db.exec(`ALTER TABLE matches ADD COLUMN open_at TEXT`);
  }
  if (!names.has("close_at")) {
    console.log("[MIGRATE] Adding matches.close_at");
    db.exec(`ALTER TABLE matches ADD COLUMN close_at TEXT`);
  }
})();

// Migration: lägg till referee_level_tenths i vote_context om det saknas
(function migrateVoteContextAddReferee() {
  const cols = db.prepare(`PRAGMA table_info(vote_context)`).all();
  const names = new Set(cols.map(c => c.name));
  if (!names.has("referee_level_tenths")) {
    console.log("[MIGRATE] Adding vote_context.referee_level_tenths");
    try {
      db.exec(`ALTER TABLE vote_context ADD COLUMN referee_level_tenths INTEGER`);
    } catch (e) {
      console.warn("[MIGRATE] Could not add referee_level_tenths (maybe exists):", e.message);
    }
  }
})();

// --- Helpers ---
const clampToTenths = (num) => {
  if (typeof num !== "number") return null;
  const t = Math.round(num * 10);
  return (t >= 10 && t <= 100) ? t : null;
};
const validAttendance = (s) => (s === "arena" || s === "tv" || s === "skip") ? s : null;

// Hämta match
const matchByIdStmt = db.prepare(`
  SELECT id, date, opponent, home, season, competition,
         voting_open, closes_at, open_at, close_at
  FROM matches WHERE id = ?
`);

// Beräkna om röstning är öppen
function isVotingOpen(m) {
  if (!m) return false;
  const now = new Date().toISOString();
  // Primärt: använd open_at/close_at om båda finns
  if (m.open_at && m.close_at) return (now >= m.open_at && now <= m.close_at);
  // Bakåtkomp: använd voting_open + closes_at
  if (m.voting_open) {
    if (!m.closes_at) return true;
    return now < new Date(m.closes_at).toISOString();
  }
  return false;
}

// --- API: Players ---
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

  const rows = db.prepare(`
    SELECT * FROM players
    WHERE active=1
    ORDER BY 
      CASE position WHEN 'G' THEN 0 WHEN 'D' THEN 1 WHEN 'B' THEN 1 WHEN 'F' THEN 2 ELSE 3 END,
      COALESCE(jersey_number, 999), name
  `).all();
  res.json(rows);
});

// --- API: Matches ---
app.get("/api/matches", (_req, res) => {
  const rows = db.prepare(`
    SELECT id, date, opponent, home, season, competition,
           voting_open, closes_at, open_at, close_at
    FROM matches
    ORDER BY date DESC, id DESC
  `).all();
  res.json(rows.map(m => ({ ...m, voting_open: isVotingOpen(m) })));
});

app.get("/api/matches/latest", (_req, res) => {
  const m = db.prepare(`
    SELECT id, date, opponent, home, season, competition,
           voting_open, closes_at, open_at, close_at
    FROM matches
    ORDER BY date DESC, id DESC
    LIMIT 1
  `).get();
  res.json(m ? { ...m, voting_open: isVotingOpen(m) } : {});
});

app.get("/api/matches/by-id", (req, res) => {
  const id = parseInt(req.query.id, 10);
  if (!id) return res.status(400).json({ error: "id krävs" });
  const m = matchByIdStmt.get(id);
  if (!m) return res.status(404).json({ error: "not found" });
  res.json({ ...m, voting_open: isVotingOpen(m) });
});

// Match som är öppen just nu (via open_at/close_at)
app.get("/api/matches/current", (_req, res) => {
  const m = db.prepare(`
    SELECT id, date, opponent, home, season, competition,
           voting_open, closes_at, open_at, close_at
    FROM matches
    WHERE open_at IS NOT NULL AND close_at IS NOT NULL
      AND open_at <= datetime('now') AND close_at >= datetime('now')
    ORDER BY date DESC, id DESC
    LIMIT 1
  `).get();
  res.json(m ? { ...m, voting_open: true } : {});
});

// --- Enstaka rate (bakåtkomp) ---
app.post("/api/rate", (req, res) => {
  const { match_id, player_id, anon_fingerprint, rating } = req.body || {};
  if (!match_id || !player_id || !anon_fingerprint || typeof rating !== "number") {
    return res.status(400).json({ error: "Missing fields" });
  }
  const tenths = clampToTenths(rating);
  if (tenths === null) return res.status(400).json({ error: "Invalid rating" });

  const m = matchByIdStmt.get(match_id);
  if (!m || !isVotingOpen(m)) return res.status(403).json({ error: "Voting closed" });

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

// --- Submit (alla betyg + ⭐ + kontext) ---
app.post("/api/submit", (req, res) => {
  const { match_id, anon_fingerprint, ratings, star_player_id,
          attendance, match_overall, result_reflection, referee_level } = req.body || {};
  if (!match_id || !anon_fingerprint || !Array.isArray(ratings)) {
    return res.status(400).json({ error: "match_id, anon_fingerprint, ratings[]" });
  }

  const m = matchByIdStmt.get(match_id);
  if (!m || !isVotingOpen(m)) return res.status(403).json({ error: "Voting closed" });

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
    INSERT INTO vote_context (match_id, anon_fingerprint, attendance, match_overall_tenths, result_reflection_tenths, referee_level_tenths)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_id, anon_fingerprint)
    DO UPDATE SET
      attendance = COALESCE(excluded.attendance, vote_context.attendance),
      match_overall_tenths = COALESCE(excluded.match_overall_tenths, vote_context.match_overall_tenths),
      result_reflection_tenths = COALESCE(excluded.result_reflection_tenths, vote_context.result_reflection_tenths),
      referee_level_tenths = COALESCE(excluded.referee_level_tenths, vote_context.referee_level_tenths),
      updated_at = CURRENT_TIMESTAMP
  `);

  const a = validAttendance(attendance);
  const mo = clampToTenths(match_overall);
  const rr = clampToTenths(result_reflection);
  const rl = clampToTenths(referee_level);

  const rosterIds = new Set(
    db.prepare("SELECT player_id FROM match_roster WHERE match_id=?").all(match_id).map(r => r.player_id)
  );

  const tx = db.transaction(() => {
    if (a || mo || rr || rl) upsertContext.run(match_id, anon_fingerprint, a, mo, rr, rl);

    for (const r of ratings) {
      if (!r || typeof r.player_id !== "number" || typeof r.rating !== "number") continue;
      if (!rosterIds.has(r.player_id)) continue;
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
    ORDER BY avg DESC NULLS LAST, votes DESC, p.name ASC
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
      ROUND(AVG(result_reflection_tenths)/10.0,1) AS result_reflection_avg,
      ROUND(AVG(referee_level_tenths)/10.0,1) AS referee_level_avg
    FROM vote_context
    WHERE match_id = ? AND ${whereAttendance}
  `).get(matchId);

  const byAtt = db.prepare(`
    SELECT COALESCE(attendance,'unknown') AS attendance,
           COUNT(*) AS submissions,
           ROUND(AVG(match_overall_tenths)/10.0,1) AS match_overall_avg,
           ROUND(AVG(result_reflection_tenths)/10.0,1) AS result_reflection_avg
           ,ROUND(AVG(referee_level_tenths)/10.0,1) AS referee_level_avg
    FROM vote_context
    WHERE match_id = ?
    GROUP BY COALESCE(attendance,'unknown')
    ORDER BY submissions DESC
  `).all(matchId);

  res.json({ summary, by_attendance: byAtt });
});

// --- Results summary (för resultat.html) ---
app.get("/api/results/summary", (req, res) => {
  const match_id = parseInt(req.query.match_id, 10);
  if (!match_id) return res.status(400).json({ error: "match_id krävs" });

  const match = db.prepare(`
    SELECT id, date, opponent, home, competition, season,
           open_at, close_at, voting_open, closes_at
    FROM matches WHERE id = ?
  `).get(match_id);

  // per-spelare snitt + count
  const perPlayer = db.prepare(`
    SELECT
      p.id AS player_id,
      p.name,
      p.jersey_number,
      COALESCE(ROUND(AVG(r.rating_tenths)/10.0, 1), NULL) AS avg_rating,
      COUNT(r.rating_tenths) AS votes
    FROM players p
    LEFT JOIN ratings r
      ON r.player_id = p.id AND r.match_id = ?
    WHERE p.active = 1
      OR p.id IN (SELECT player_id FROM ratings WHERE match_id = ?)
    GROUP BY p.id
    ORDER BY avg_rating DESC NULLS LAST, votes DESC, p.jersey_number ASC
  `).all(match_id, match_id);

  const starCounts = db.prepare(`
    SELECT player_id, COUNT(*) AS stars
    FROM stars
    WHERE match_id = ?
    GROUP BY player_id
  `).all(match_id);
  const starsMap = Object.fromEntries(starCounts.map(r => [r.player_id, r.stars]));

  const overall = db.prepare(`
    SELECT
      COALESCE(ROUND(AVG(match_overall_tenths)/10.0,1), NULL) AS match_overall_avg,
      COALESCE(ROUND(AVG(result_reflection_tenths)/10.0,1), NULL) AS result_reflection_avg,
      COALESCE(ROUND(AVG(referee_level_tenths)/10.0,1), NULL) AS referee_level_avg,
      SUM(CASE WHEN attendance='arena' THEN 1 ELSE 0 END) AS arena,
      SUM(CASE WHEN attendance='tv'    THEN 1 ELSE 0 END) AS tv,
      SUM(CASE WHEN attendance='skip'  THEN 1 ELSE 0 END) AS skip,
      COUNT(DISTINCT anon_fingerprint) AS voters
    FROM vote_context
    WHERE match_id = ?
  `).get(match_id) || { match_overall_avg:null, result_reflection_avg:null, referee_level_avg:null, arena:0, tv:0, skip:0, voters:0 };

  const players = perPlayer.map(p => ({
    player_id: p.player_id,
    name: p.name,
    jersey_number: p.jersey_number,
    avg: p.avg_rating,
    votes: p.votes,
    stars: starsMap[p.player_id] || 0
  }));

  res.json({
    match: match ? { ...match, voting_open: isVotingOpen(match) } : null,
    players,
    totals: {
      voters: overall.voters,
      match_overall_avg: overall.match_overall_avg,
      result_reflection_avg: overall.result_reflection_avg,
      referee_level_avg: overall.referee_level_avg,
      attendance: { arena: overall.arena, tv: overall.tv, skip: overall.skip }
    }
  });
});

// --- Admin ---
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "secret123";
function requireAdmin(req, res, next) {
  const t = (req.headers["x-admin-token"] || "").trim();
  if (!t || t !== ADMIN_TOKEN) return res.status(401).send("Unauthorized");
  next();
}

app.post("/api/admin/create-match", requireAdmin, (req, res) => {
  const { date, opponent, home, season, competition,
          voting_open = 0, closes_at = null, open_at = null, close_at = null } = req.body || {};
  const info = db.prepare(`
    INSERT INTO matches (date,opponent,home,season,competition,voting_open,closes_at,open_at,close_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(date, opponent, home ? 1 : 0, season, competition, voting_open ? 1 : 0, closes_at, open_at, close_at);
  res.json({ id: info.lastInsertRowid });
});

app.post("/api/admin/toggle-voting", requireAdmin, (req, res) => {
  const { id, open, closes_at = null } = req.body || {};
  // Bakåtkomp: behåll stöd men rekommendera tidsstyrning istället
  db.prepare("UPDATE matches SET voting_open=?, closes_at=? WHERE id=?")
    .run(open ? 1 : 0, closes_at, id);
  const m = matchByIdStmt.get(id);
  res.json({ ok: true, match: { ...m, voting_open: isVotingOpen(m) } });
});

// Ny: spara tidsfönster (UTC-ISO i body)
app.post("/api/admin/matches/schedule", requireAdmin, (req, res) => {
  const { match_id, open_at, close_at } = req.body || {};
  const id = parseInt(match_id, 10);
  if (!id || !open_at || !close_at) return res.status(400).send("match_id/open_at/close_at krävs (UTC ISO)");
  if (open_at >= close_at) return res.status(400).send("open_at måste vara före close_at");

  db.prepare(`UPDATE matches SET open_at=?, close_at=? WHERE id=?`).run(open_at, close_at, id);
  const m = matchByIdStmt.get(id);
  res.json({ ok: true, match: { ...m, voting_open: isVotingOpen(m) } });
});

app.post("/api/admin/bulk-upsert-players", requireAdmin, (req, res) => {
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

app.post("/api/admin/set-roster", requireAdmin, (req, res) => {
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

app.post("/api/admin/upsert-roster-row", requireAdmin, (req, res) => {
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

// --- Admin – extra: spelare ---
app.get("/api/admin/players", requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT id, jersey_number, name, position, active
    FROM players
    ORDER BY 
      CASE position WHEN 'G' THEN 0 WHEN 'D' THEN 1 WHEN 'B' THEN 1 WHEN 'F' THEN 2 ELSE 3 END,
      COALESCE(jersey_number, 999), name
  `).all();
  res.json(rows);
});

// Flexibel patch: uppdatera valfria fält via id
app.post("/api/admin/player/patch", requireAdmin, (req, res) => {
  const { id, name, jersey_number, position, active } = req.body || {};
  const pid = parseInt(id, 10);
  if (!pid) return res.status(400).json({ error: "id krävs" });

  // Bygg dynamiskt SET
  const sets = [];
  const vals = [];

  if (typeof name === "string" && name.trim()) {
    const exists = db.prepare("SELECT id FROM players WHERE name=?").get(name.trim());
    if (exists && exists.id !== pid) return res.status(409).json({ error: "Namnet används redan" });
    sets.push("name=?"); vals.push(name.trim());
  }
  if (jersey_number === null || typeof jersey_number === "number") {
    sets.push("jersey_number=?"); vals.push(jersey_number === null ? null : jersey_number);
  }
  if (typeof position === "string") { sets.push("position=?"); vals.push(position || null); }
  if (active === 0 || active === 1) { sets.push("active=?"); vals.push(active); }

  if (!sets.length) return res.status(400).json({ error: "Inga fält att uppdatera" });

  vals.push(pid);
  const info = db.prepare(`UPDATE players SET ${sets.join(", ")} WHERE id=?`).run(...vals);
  res.json({ ok: true, updated: info.changes });
});

app.post("/api/admin/player/delete", requireAdmin, (req, res) => {
  const { id } = req.body || {};
  const pid = parseInt(id, 10);
  if (!pid) return res.status(400).json({ error: "id krävs" });
  const info = db.prepare("DELETE FROM players WHERE id=?").run(pid);
  res.json({ ok: true, deleted: info.changes });
});

// --- Admin – extra: rensa/ta bort match ---
app.post("/api/admin/matches/clear", requireAdmin, (req, res) => {
  const { match_id } = req.body || {};
  const id = parseInt(match_id, 10);
  if (!id) return res.status(400).json({ error: "match_id krävs" });

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM ratings WHERE match_id=?").run(id);
    db.prepare("DELETE FROM stars WHERE match_id=?").run(id);
    db.prepare("DELETE FROM vote_context WHERE match_id=?").run(id);
  });
  tx();

  res.json({ ok: true, cleared: ["ratings","stars","vote_context"], match_id: id });
});

app.post("/api/admin/matches/delete", requireAdmin, (req, res) => {
  const { match_id } = req.body || {};
  const id = parseInt(match_id, 10);
  if (!id) return res.status(400).json({ error: "match_id krävs" });
  const info = db.prepare("DELETE FROM matches WHERE id=?").run(id);
  res.json({ ok: true, deleted: info.changes });
});

// --- Export ---
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
      ROUND(vc.referee_level_tenths/10.0,1) AS referee_level,
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
      ROUND(vc.referee_level_tenths/10.0,1) AS referee_level,
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

// --- Static ---
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running http://localhost:${PORT}`);
});
