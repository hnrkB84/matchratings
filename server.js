const fs = require("fs");
const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const path = require("path");

// --- Blogg: Margit push
// kdown + sanering ---
const marked = require('marked');
const sanitizeHtml = require('sanitize-html');

// ---- Blogg-hemlighet (från Render) ----
const BLOG_ADMIN_SECRET = String(
  process.env.BLOG_ADMIN_SECRET || process.env.ADMIN_TOKEN || process.env.ADMIN_SECRET || ''
).trim();

// Acceptera hemligheten via header **eller** query (?key=...)
function isBlogAdmin(req) {
  const h = String(req.get('x-blog-admin-secret') || '').trim();
  const q = String(req.query.key || '').trim();
  return (h && h === BLOG_ADMIN_SECRET) || (q && q === BLOG_ADMIN_SECRET);
}
console.log('[DEBUG BLOG] Loaded BLOG_ADMIN_SECRET:', JSON.stringify(BLOG_ADMIN_SECRET));

// Konvertera MD -> säker HTML
function mdToSafeHtml(md) {
  const raw = marked.parse(md || '');
  return sanitizeHtml(raw, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img','h1','h2','h3','figure','figcaption']),
    allowedAttributes: {
      a: ['href','name','target','rel'],
      img: ['src','alt','title','loading','width','height'],
      '*': ['id','class','style']
    },
    allowedSchemes: ['http','https','mailto']
  });}
const app = express();

// Lita på Render-proxy så X-Forwarded-* fungerar korrekt (fixar rate-limit felet)
app.set("trust proxy", 1);

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
const keyByIp = (req) =>
  (req.ip || req.headers["x-forwarded-for"] || "ip-unknown").toString();

const voteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByIp
});
app.use("/api/submit", voteLimiter);
app.use("/api/rate", voteLimiter);
app.use("/api/lines-vote", voteLimiter); // återanvänd limiter för stand-alone kedjor/PP

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

-- Ny STAND-ALONE-tabell för kedjor/PP1 utan match_id
CREATE TABLE IF NOT EXISTS line_pp_votes (
  id INTEGER PRIMARY KEY,
  anon_fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL, -- {"lines":{...},"pp1":[...],"scratch":[...]}
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(anon_fingerprint)
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  excerpt TEXT,
  content_md TEXT NOT NULL,
  content_html TEXT NOT NULL,
  tags TEXT,
  cover_image_url TEXT,
  published INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_linepp_fingerprint ON line_pp_votes(anon_fingerprint);

CREATE INDEX IF NOT EXISTS idx_ratings_match ON ratings(match_id);
CREATE INDEX IF NOT EXISTS idx_ratings_player ON ratings(player_id);
CREATE INDEX IF NOT EXISTS idx_context_match ON vote_context(match_id);
CREATE INDEX IF NOT EXISTS idx_stars_match ON stars(match_id);
CREATE INDEX IF NOT EXISTS idx_roster_match ON match_roster(match_id);
`);

// Lägg till nya tidskolumner om de saknas
(function migrateMatchesAddOpenClose() {
  const cols = db.prepare(`PRAGMA table_info(matches)`).all();
  const names = new Set(cols.map((c) => c.name));
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
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("referee_level_tenths")) {
    console.log("[MIGRATE] Adding vote_context.referee_level_tenths");
    try {
      db.exec(`ALTER TABLE vote_context ADD COLUMN referee_level_tenths INTEGER`);
    } catch (e) {
      console.warn(
        "[MIGRATE] Could not add referee_level_tenths (maybe exists):",
        e.message
      );
    }
  }
})();

// Migration: säkerställ att line_pp_votes är STAND-ALONE (utan match_id)
(function migrateLinePPVotesStandalone() {
  try {
    const cols = db.prepare(`PRAGMA table_info(line_pp_votes)`).all();
    if (!cols.length) return; // tabellen skapades ovan om den inte fanns
    const hasMatchId = cols.some((c) => c.name === "match_id");
    if (!hasMatchId) return; // redan stand-alone

    console.log("[MIGRATE] Converting line_pp_votes to stand-alone (dropping match_id)");
    const tx = db.transaction(() => {
      // Byt namn på gamla tabellen
      db.exec(`ALTER TABLE line_pp_votes RENAME TO line_pp_votes_old;`);

      // Skapa nya stand-alone
      db.exec(`
        CREATE TABLE line_pp_votes (
          id INTEGER PRIMARY KEY,
          anon_fingerprint TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(anon_fingerprint)
        );
      `);

      // Migrera data: ta senaste posten per fingerprint
      db.exec(`
        INSERT INTO line_pp_votes (anon_fingerprint, payload_json, created_at, updated_at)
        SELECT anon_fingerprint,
               payload_json,
               MAX(created_at) AS created_at,
               MAX(updated_at) AS updated_at
        FROM line_pp_votes_old
        GROUP BY anon_fingerprint;
      `);

      // Index
      db.exec(`CREATE INDEX IF NOT EXISTS idx_linepp_fingerprint ON line_pp_votes(anon_fingerprint);`);

      // Rensa gammal tabell
      db.exec(`DROP TABLE line_pp_votes_old;`);
    });
    tx();
    console.log("[MIGRATE] line_pp_votes migration complete");
  } catch (e) {
    console.warn("[MIGRATE] line_pp_votes migration skipped/error:", e.message);
  }
})();

// --- Helpers ---
const clampToTenths = (num) => {
  if (typeof num !== "number") return null;
  const t = Math.round(num * 10);
  return t >= 10 && t <= 100 ? t : null;
};
const validAttendance = (s) =>
  s === "arena" || s === "tv" || s === "skip" ? s : null;

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
  if (m.open_at && m.close_at) return now >= m.open_at && now <= m.close_at;
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
    const rows = db
      .prepare(
        `
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
    `
      )
      .all(matchId);
    return res.json(rows);
  }

  const rows = db
    .prepare(
      `
    SELECT * FROM players
    WHERE active=1
    ORDER BY 
      CASE position WHEN 'G' THEN 0 WHEN 'D' THEN 1 WHEN 'B' THEN 1 WHEN 'F' THEN 2 ELSE 3 END,
      COALESCE(jersey_number, 999), name
  `
    )
    .all();
  res.json(rows);
});

// --- API: Matches ---
app.get("/api/matches", (_req, res) => {
  const rows = db
    .prepare(
      `
    SELECT id, date, opponent, home, season, competition,
           voting_open, closes_at, open_at, close_at
    FROM matches
    ORDER BY date DESC, id DESC
  `
    )
    .all();
  res.json(rows.map((m) => ({ ...m, voting_open: isVotingOpen(m) })));
});

app.get("/api/matches/latest", (_req, res) => {
  const m = db
    .prepare(
      `
    SELECT id, date, opponent, home, season, competition,
           voting_open, closes_at, open_at, close_at
    FROM matches
    ORDER BY date DESC, id DESC
    LIMIT 1
  `
    )
    .get();
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
  const m = db
    .prepare(
      `
    SELECT id, date, opponent, home, season, competition,
           voting_open, closes_at, open_at, close_at
    FROM matches
    WHERE open_at IS NOT NULL AND close_at IS NOT NULL
      AND open_at <= datetime('now') AND close_at >= datetime('now')
    ORDER BY date DESC, id DESC
    LIMIT 1
  `
    )
    .get();
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

  const inRoster = db
    .prepare("SELECT 1 FROM match_roster WHERE match_id=? AND player_id=?")
    .get(match_id, player_id);
  if (!inRoster) return res.status(400).json({ error: "Player not on roster for this match" });

  db.prepare(
    `
    INSERT INTO ratings (match_id,player_id,anon_fingerprint,rating_tenths)
    VALUES (?,?,?,?)
    ON CONFLICT(match_id,player_id,anon_fingerprint)
    DO UPDATE SET rating_tenths=excluded.rating_tenths, updated_at=CURRENT_TIMESTAMP
  `
  ).run(match_id, player_id, anon_fingerprint, tenths);

  res.json({ ok: true });
});

// --- Submit (alla betyg + ⭐ + kontext) ---
app.post("/api/submit", (req, res) => {
  const {
    match_id,
    anon_fingerprint,
    ratings,
    star_player_id,
    attendance,
    match_overall,
    result_reflection,
    referee_level
  } = req.body || {};
  if (!match_id || !anon_fingerprint || !Array.isArray(ratings)) {
    return res.status(400).json({ error: "match_id, anon_fingerprint, ratings[]" });
  }

  const m = matchByIdStmt.get(match_id);
  if (!m || !isVotingOpen(m)) return res.status(403).json({ error: "Voting closed" });

  const upsertRating = db.prepare(
    `
    INSERT INTO ratings (match_id,player_id,anon_fingerprint,rating_tenths)
    VALUES (?,?,?,?)
    ON CONFLICT(match_id,player_id,anon_fingerprint)
    DO UPDATE SET rating_tenths=excluded.rating_tenths, updated_at=CURRENT_TIMESTAMP
  `
  );
  const upsertStar = db.prepare(
    `
    INSERT INTO stars (match_id, player_id, anon_fingerprint)
    VALUES (?,?,?)
    ON CONFLICT(match_id, anon_fingerprint)
    DO UPDATE SET player_id=excluded.player_id, created_at=CURRENT_TIMESTAMP
  `
  );
  const upsertContext = db.prepare(
    `
    INSERT INTO vote_context (match_id, anon_fingerprint, attendance, match_overall_tenths, result_reflection_tenths, referee_level_tenths)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_id, anon_fingerprint)
    DO UPDATE SET
      attendance = COALESCE(excluded.attendance, vote_context.attendance),
      match_overall_tenths = COALESCE(excluded.match_overall_tenths, vote_context.match_overall_tenths),
      result_reflection_tenths = COALESCE(excluded.result_reflection_tenths, vote_context.result_reflection_tenths),
      referee_level_tenths = COALESCE(excluded.referee_level_tenths, vote_context.referee_level_tenths),
      updated_at = CURRENT_TIMESTAMP
  `
  );

  const a = validAttendance(attendance);
  const mo = clampToTenths(match_overall);
  const rr = clampToTenths(result_reflection);
  const rl = clampToTenths(referee_level);

  const rosterIds = new Set(
    db
      .prepare("SELECT player_id FROM match_roster WHERE match_id=?")
      .all(match_id)
      .map((r) => r.player_id)
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

// --- STAND-ALONE Lines/PP votes (fansens kedjor + PP1) ---
// OBS: tidigare /api/match/:id/lines-vote är borttagen – inget match_id längre.

// Enkel schema-validering för lines/pp1
function validateLinesPayload(body) {
  const { anon_fingerprint, lines, pp1, scratch } = body || {};
  if (!anon_fingerprint || typeof anon_fingerprint !== "string" || !anon_fingerprint.trim()) {
    throw new Error("anon_fingerprint krävs");
  }

  const Ls = ["1", "2", "3", "4"];
  const Rs = ["LW", "C", "RW"];
  if (!lines || typeof lines !== "object") throw new Error("lines saknas");
  for (const L of Ls) {
    if (!Array.isArray(lines[L]) || lines[L].length !== 3)
      throw new Error(`lines.${L} måste ha exakt 3 poster`);
    for (const item of lines[L]) {
      if (!item || !Rs.includes(item.pos) || typeof item.id !== "string" || !item.id.trim())
        throw new Error(`lines.${L} fel format`);
    }
  }

  const PP = ["PNT", "LFL", "BUM", "RFL", "NET"];
  if (!Array.isArray(pp1) || pp1.length !== 5) throw new Error("pp1 måste ha exakt 5 poster");
  for (const item of pp1) {
    if (!item || !PP.includes(item.role) || typeof item.id !== "string" || !item.id.trim())
      throw new Error("pp1 fel format");
  }

  if (!Array.isArray(scratch)) throw new Error("scratch måste vara array");

  return { anon_fingerprint: anon_fingerprint.trim(), lines, pp1, scratch };
}

app.post("/api/lines-vote", (req, res) => {
  let payload;
  try {
    payload = validateLinesPayload(req.body);
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }

  const upsert = db.prepare(`
    INSERT INTO line_pp_votes (anon_fingerprint, payload_json)
    VALUES (?, json(?))
    ON CONFLICT(anon_fingerprint)
    DO UPDATE SET payload_json=excluded.payload_json, updated_at=CURRENT_TIMESTAMP
  `);
  upsert.run(payload.anon_fingerprint, JSON.stringify({ lines: payload.lines, pp1: payload.pp1, scratch: payload.scratch }));

  res.json({ ok: true });
});

app.get("/api/lines-results", (_req, res) => {
  const rows = db
    .prepare(
      `
      SELECT id, anon_fingerprint, payload_json, created_at, updated_at
      FROM line_pp_votes
      ORDER BY updated_at DESC, id DESC
    `
    )
    .all();

  // Returnera count och hela listan (payload som sträng för enkelhet; klient kan JSON.parse)
  res.json({ count: rows.length, votes: rows });
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

  const rows = db
    .prepare(
      `
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
  `
    )
    .all(matchId);

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

  const summary = db
    .prepare(
      `
    SELECT
      COUNT(*) AS submissions,
      ROUND(AVG(match_overall_tenths)/10.0,1) AS match_overall_avg,
      ROUND(AVG(result_reflection_tenths)/10.0,1) AS result_reflection_avg,
      ROUND(AVG(referee_level_tenths)/10.0,1) AS referee_level_avg
    FROM vote_context
    WHERE match_id = ? AND ${whereAttendance}
  `
    )
    .get(matchId);

  const byAtt = db
    .prepare(
      `
    SELECT COALESCE(attendance,'unknown') AS attendance,
           COUNT(*) AS submissions,
           ROUND(AVG(match_overall_tenths)/10.0,1) AS match_overall_avg,
           ROUND(AVG(result_reflection_tenths)/10.0,1) AS result_reflection_avg,
           ROUND(AVG(referee_level_tenths)/10.0,1) AS referee_level_avg
    FROM vote_context
    WHERE match_id = ?
    GROUP BY COALESCE(attendance,'unknown')
    ORDER BY submissions DESC
  `
    )
    .all(matchId);

  res.json({ summary, by_attendance: byAtt });
});

// --- Results summary (för resultat.html) ---
app.get("/api/results/summary", (req, res) => {
  const match_id = parseInt(req.query.match_id, 10);
  if (!match_id) return res.status(400).json({ error: "match_id krävs" });

  const match = db
    .prepare(
      `
    SELECT id, date, opponent, home, competition, season,
           open_at, close_at, voting_open, closes_at
    FROM matches WHERE id = ?
  `
    )
    .get(match_id);

  // per-spelare snitt + count
  const perPlayer = db
    .prepare(
      `
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
  `
    )
    .all(match_id, match_id);

  const starCounts = db
    .prepare(
      `
    SELECT player_id, COUNT(*) AS stars
    FROM stars
    WHERE match_id = ?
    GROUP BY player_id
  `
    )
    .all(match_id);
  const starsMap = Object.fromEntries(starCounts.map((r) => [r.player_id, r.stars]));

  const overall =
    db
      .prepare(
        `
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
  `
      )
      .get(match_id) || {
      match_overall_avg: null,
      result_reflection_avg: null,
      referee_level_avg: null,
      arena: 0,
      tv: 0,
      skip: 0,
      voters: 0
    };

  const players = perPlayer.map((p) => ({
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
  const {
    date,
    opponent,
    home,
    season,
    competition,
    voting_open = 0,
    closes_at = null,
    open_at = null,
    close_at = null
  } = req.body || {};
  const info = db
    .prepare(
      `
    INSERT INTO matches (date,opponent,home,season,competition,voting_open,closes_at,open_at,close_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `
    )
    .run(
      date,
      opponent,
      home ? 1 : 0,
      season,
      competition,
      voting_open ? 1 : 0,
      closes_at,
      open_at,
      close_at
    );
  res.json({ id: info.lastInsertRowid });
});

app.post("/api/admin/toggle-voting", requireAdmin, (req, res) => {
  const { id, open, closes_at = null } = req.body || {};
  // Bakåtkomp: behåll stöd men rekommendera tidsstyrning istället
  db.prepare("UPDATE matches SET voting_open=?, closes_at=? WHERE id=?").run(
    open ? 1 : 0,
    closes_at,
    id
  );
  const m = matchByIdStmt.get(id);
  res.json({ ok: true, match: { ...m, voting_open: isVotingOpen(m) } });
});

// Ny: spara tidsfönster (UTC-ISO i body)
app.post("/api/admin/matches/schedule", requireAdmin, (req, res) => {
  const { match_id, open_at, close_at } = req.body || {};
  const id = parseInt(match_id, 10);
  if (!id || !open_at || !close_at)
    return res.status(400).send("match_id/open_at/close_at krävs (UTC ISO)");
  if (open_at >= close_at) return res.status(400).send("open_at måste vara före close_at");

  db.prepare(`UPDATE matches SET open_at=?, close_at=? WHERE id=?`).run(open_at, close_at, id);
  const m = matchByIdStmt.get(id);
  res.json({ ok: true, match: { ...m, voting_open: isVotingOpen(m) } });
});

app.post("/api/admin/bulk-upsert-players", requireAdmin, (req, res) => {
  const players = req.body?.players;
  if (!Array.isArray(players) || players.length === 0) {
    return res
      .status(400)
      .json({ error: "Provide players: [{jersey_number, name, position, active}]" });
  }

  const findByName = db.prepare("SELECT id FROM players WHERE name = ? LIMIT 1");
  const insert = db.prepare(
    "INSERT INTO players (jersey_number, name, position, active) VALUES (?,?,?,?)"
  );
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

// >>> FIXAD ROUTE HÄR <<<
app.post("/api/admin/set-roster", requireAdmin, (req, res) => {
  const { match_id, player_ids, dressed_default = 1 } = req.body || {};
  if (!match_id || !Array.isArray(player_ids))
    return res.status(400).json({ error: "match_id & player_ids[]" });

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM match_roster WHERE match_id=?").run(match_id);
    const ins = db.prepare(
      "INSERT INTO match_roster (match_id, player_id, dressed) VALUES (?,?,?)"
    );
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

  db.prepare(
    `
    INSERT INTO match_roster (match_id, player_id, dressed, role)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(match_id, player_id)
    DO UPDATE SET dressed=excluded.dressed, role=excluded.role
  `
  ).run(match_id, player_id, dressed ? 1 : 0, role);

  res.json({ ok: true });
});

// --- Admin – extra: spelare ---
app.get("/api/admin/players", requireAdmin, (_req, res) => {
  const rows = db
    .prepare(
      `
    SELECT id, jersey_number, name, position, active
    FROM players
    ORDER BY 
      CASE position WHEN 'G' THEN 0 WHEN 'D' THEN 1 WHEN 'B' THEN 1 WHEN 'F' THEN 2 ELSE 3 END,
      COALESCE(jersey_number, 999), name
  `
    )
    .all();
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
    sets.push("name=?");
    vals.push(name.trim());
  }
  if (jersey_number === null || typeof jersey_number === "number") {
    sets.push("jersey_number=?");
    vals.push(jersey_number === null ? null : jersey_number);
  }
  if (typeof position === "string") {
    sets.push("position=?");
    vals.push(position || null);
  }
  if (active === 0 || active === 1) {
    sets.push("active=?");
    vals.push(active);
  }

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

// --- Export ---
const toCSV = (rows) => {
  if (!rows || !rows.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    // använd bara strängkonkat, inga template-literals (för att undvika ts(1005)-varningar)
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join(
    "\n"
  );
};

app.get("/api/export/ratings", (req, res) => {
  const matchId = parseInt(req.query.match_id || "0", 10);
  const format = (req.query.format || "csv").toLowerCase();
  if (!matchId) return res.status(400).json({ error: "match_id required" });

  const rows = db
    .prepare(
      `
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
  `
    )
    .all(matchId);

  if (format === "jsonl") {
    res.type("text/plain").send(rows.map((r) => JSON.stringify(r)).join("\n"));
  } else {
    res.type("text/csv").send(toCSV(rows));
  }
});

app.get("/api/export/votes", (req, res) => {
  const matchId = parseInt(req.query.match_id || "0", 10);
  const format = (req.query.format || "csv").toLowerCase();
  if (!matchId) return res.status(400).json({ error: "match_id required" });

  const rows = db
    .prepare(
      `
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
  `
    )
    .all(matchId);

  if (format === "jsonl") {
    res.type("text/plain").send(rows.map((r) => JSON.stringify(r)).join("\n"));
  } else {
    res.type("text/csv").send(toCSV(rows));
  }
});

app.get("/api/export/aggregates", (req, res) => {
  const matchId = parseInt(req.query.match_id || "0", 10);
  const format = (req.query.format || "csv").toLowerCase();
  if (!matchId) return res.status(400).json({ error: "match_id required" });

  const rows = db
    .prepare(
      `
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
  `
    )
    .all(matchId);

  if (format === "jsonl") {
    res.type("text/plain").send(rows.map((r) => JSON.stringify(r)).join("\n"));
  } else {
    res.type("text/csv").send(toCSV(rows));
  }
});

// === BLOGGADMIN: NY SIDFÖR INLÄGG ===
app.get('/blog-admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'blog-admin.html'));
});

// === BLOGG API ===

// Hämta alla (admin)
app.get('/api/blog/posts', (req, res) => {
  if (!isBlogAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const rows = db.prepare(`SELECT * FROM posts ORDER BY datetime(created_at) DESC`).all();
  res.json(rows);
});

// Skapa nytt inlägg
app.post('/api/blog/posts', express.json({ limit: '1mb' }), (req, res) => {
  if (!isBlogAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { title, slug, excerpt, content_md, tags, cover_image_url, published } = req.body || {};
  if (!title || !slug || !content_md)
    return res.status(400).json({ error: 'title, slug, content_md krävs' });
  const html = mdToSafeHtml(content_md);
  try {
    const info = db
      .prepare(
        `INSERT INTO posts (title, slug, excerpt, content_md, content_html, tags, cover_image_url, published)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        title,
        slug,
        excerpt || null,
        content_md,
        html,
        tags || null,
        cover_image_url || null,
        published ? 1 : 0
      );
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Uppdatera befintligt inlägg
app.put('/api/blog/posts/:id', express.json({ limit: '1mb' }), (req, res) => {
  if (!isBlogAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const id = +req.params.id;
  const { title, slug, excerpt, content_md, tags, cover_image_url, published } = req.body || {};
  if (!title || !slug || !content_md)
    return res.status(400).json({ error: 'title, slug, content_md krävs' });
  const html = mdToSafeHtml(content_md);
  try {
    db.prepare(
      `UPDATE posts SET
        title=?, slug=?, excerpt=?, content_md=?, content_html=?,
        tags=?, cover_image_url=?, published=?, updated_at=datetime('now')
       WHERE id=?`
    ).run(
      title,
      slug,
      excerpt || null,
      content_md,
      html,
      tags || null,
      cover_image_url || null,
      published ? 1 : 0,
      id
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// === PUBLIKA BLOGGSIDOR ===

// /inlagg – lista alla publicerade (hero + grid, inga inline-styles)
app.get('/inlagg', (req, res) => {
  const posts = db.prepare(`
    SELECT id, title, slug, excerpt, cover_image_url, created_at
    FROM posts
    WHERE published = 1
    ORDER BY datetime(created_at) DESC
  `).all();

  const hasPosts = posts && posts.length > 0;
  const hero = hasPosts ? posts[0] : null;
  const rest = hasPosts ? posts.slice(1) : [];

  const fmt = (d) => new Date(d).toLocaleDateString('sv-SE', { year: 'numeric', month: 'short', day: 'numeric' });

  res.send(`<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Inlägg</title>
  <meta name="description" content="Senaste analyser, krönikor och sammanställningar från HV71 Ratings." />
  <link href="https://fonts.googleapis.com/css2?family=Teko:wght@600;700&family=Oswald:wght@600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="blog-body">
  <header class="blog-header">
    <div class="blog-header__inner">
      <a class="blog-brand" href="/inlagg">Inlägg</a>
      <nav class="blog-nav">
        <a href="/index.html#rosta">Rösta</a>
        <a href="/senastematch.html">Senaste matchen</a>
      </nav>
    </div>
  </header>

  <main class="blog-wrap">
    ${hero ? `
    <section class="blog-hero">
      <a class="blog-hero__image" href="/post/${hero.slug}" aria-label="Läs: ${hero.title}">
        ${hero.cover_image_url
          ? `<img src="${hero.cover_image_url}" alt="" loading="eager" decoding="async" fetchpriority="high">`
          : `<div class="blog-no-cover" aria-hidden="true"></div>`}
      </a>
      <div class="blog-hero__content">
        <time class="blog-meta">${fmt(hero.created_at)}</time>
        <h1 class="blog-hero__title"><a href="/post/${hero.slug}">${hero.title}</a></h1>
        ${hero.excerpt ? `<p class="blog-hero__excerpt">${hero.excerpt}</p>` : ``}
        <p><a class="btn" href="/post/${hero.slug}">Läs inlägget</a></p>
      </div>
    </section>
    ` : `
    <section class="blog-empty">
      <h1>Inga inlägg ännu</h1>
      <p>När första inlägget publiceras hamnar det här.</p>
    </section>
    `}

    ${rest.length ? `
    <section class="blog-grid" aria-label="Fler inlägg">
      ${rest.map(p => `
        <article class="blog-card">
          <a class="blog-card__media" href="/post/${p.slug}" aria-label="Läs: ${p.title}">
            ${p.cover_image_url
              ? `<img src="${p.cover_image_url}" alt="" loading="lazy" decoding="async">`
              : `<div class="blog-no-cover" aria-hidden="true"></div>`}
          </a>
          <div class="blog-card__body">
            <time class="blog-meta">${fmt(p.created_at)}</time>
            <h2 class="blog-card__title"><a href="/post/${p.slug}">${p.title}</a></h2>
            ${p.excerpt ? `<p class="blog-card__excerpt">${p.excerpt}</p>` : ``}
            <a class="btn btn--sm" href="/post/${p.slug}">Läs</a>
          </div>
          <a class="blog-card__link" href="/post/${p.slug}" aria-hidden="true" tabindex="-1"></a>
        </article>
      `).join('')}
    </section>
    ` : ``}
  </main>
</body>
</html>`);
});


// /post/:slug – visa ett inlägg
app.get('/post/:slug', (req, res) => {
  const p = db.prepare(`SELECT * FROM posts WHERE slug=? AND published=1`).get(req.params.slug);
  if (!p) return res.status(404).send('Inlägget finns inte.');

  res.send(`<!DOCTYPE html><html lang="sv"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${p.title} – HV71</title>
<meta property="og:title" content="${p.title}">
${p.cover_image_url ? `<meta property="og:image" content="${p.cover_image_url}">` : ``}
${p.excerpt ? `<meta property="og:description" content="${p.excerpt}">` : ``}
<link href="https://fonts.googleapis.com/css2?family=Teko:wght@600;700&family=Oswald:wght@600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
<style>
:root{--hv-blue:#0a2240;--hv-yellow:#ffcb01;--ink:#e8eef6;--card:#0b1f3a}
body{background:#061429;color:#eaf1fb}
.wrap{max-width:820px;margin:0 auto;padding:18px}
h1{font-family:'Teko',sans-serif;color:var(--hv-yellow);font-size:44px;margin:8px 0 12px}
.meta{opacity:.8;margin-bottom:10px}
.cover{width:100%;border-radius:14px;overflow:hidden;background:#091b34;margin:6px 0 14px}
.cover img{width:100%;height:auto;display:block}
.post{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:16px;line-height:1.6}
.post p{margin:0 0 10px}
.post h2,.post h3{font-family:'Oswald',sans-serif;margin:16px 0 8px}
a.back{display:inline-block;margin:10px 0 16px}
.btn{display:inline-block;background:var(--hv-yellow);color:#111;padding:8px 12px;border-radius:10px;font-weight:700;text-decoration:none}
</style>
</head><body>
  <div class="wrap">
    <a class="back" href="/inlagg">← Alla inlägg</a>
    <h1>${p.title}</h1>
    <div class="meta">${new Date(p.created_at).toLocaleDateString('sv-SE')}</div>
    ${p.cover_image_url ? `<div class="cover"><img src="${p.cover_image_url}" alt=""></div>` : ``}
    <article class="post">${p.content_html}</article>
    <p style="margin-top:14px"><a class="btn" href="/index.html#rosta">Rösta på matchen</a></p>
  </div>
</body></html>`);
});

// =======================================================
// 🗑️  DELETE /api/blog/posts/:id
// =======================================================
// Denna route används av bloggens admin-sida för att
// ta bort ett inlägg permanent från databasen.
// Den kan bara anropas av den som har rätt admin-nyckel.
//
// Exempel från frontend (blog-admin.html):
// fetch('/api/blog/posts/12', { method:'DELETE', headers:{'x-blog-admin-secret': 'DIN_NYCKEL'} })
//
// Om allt går bra svarar servern med:
// { ok: true }
//
// Om nyckeln är fel, eller ID saknas, skickas ett felmeddelande.
//
app.delete('/api/blog/posts/:id', (req, res) => {
  // 1️⃣  Kontrollera att den som anropar har rätt admin-nyckel.
  const key = req.headers['x-blog-admin-secret'];
  if (key !== process.env.BLOG_ADMIN_SECRET) {
    // Fel nyckel → stoppa direkt.
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 2️⃣  Hämta ut ID:t från URL:en (exempel: /api/blog/posts/12 → id = 12)
  const id = Number(req.params.id);
  if (!id) {
    // Om ID:t inte är ett giltigt nummer → skicka fel tillbaka.
    return res.status(400).json({ error: 'Ogiltigt ID' });
  }

  // 3️⃣  Kör SQL-kommandot som tar bort posten ur databasen.
  //     Tabellen heter 'posts' och fältet 'id' identifierar rätt rad.
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);

  // 4️⃣  Skicka ett enkelt JSON-svar så admin-gränssnittet vet att det lyckades.
  res.json({ ok: true });
});

// Redirect root to /inlagg
app.get(['/', '/index.html'], (req, res) => {
  res.redirect(301, '/inlagg');
});

// --- Static ---
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running http://localhost:${PORT}`);
});
