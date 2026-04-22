const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const app = express();
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "probabilize.db");
const db = new Database(DB_PATH);

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.static(__dirname));

// ── Schema ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    balance       REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS markets (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    maker    TEXT NOT NULL,
    outcomes TEXT NOT NULL,   -- JSON array
    p        TEXT NOT NULL,   -- JSON array (priors)
    b        REAL NOT NULL,
    q        TEXT NOT NULL,   -- JSON array (current quantities)
    open     INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS portfolios (
    username  TEXT NOT NULL,
    market_id TEXT NOT NULL,
    q         TEXT NOT NULL,  -- JSON array
    PRIMARY KEY (username, market_id)
  );
  CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL,
    market_id   TEXT,
    market_name TEXT NOT NULL,
    action      TEXT NOT NULL,
    detail      TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
   CREATE TABLE IF NOT EXISTS market_price_history (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     market_id  TEXT NOT NULL,
     event      TEXT NOT NULL,
     probs      TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO meta (key, value) VALUES ('next_market_id', '1');
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all();
if (!userColumns.some((col) => col.name === "password_hash")) {
  db.prepare("ALTER TABLE users ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''").run();
}

const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all();
if (!sessionColumns.some((col) => col.name === "expires_at")) {
  db.prepare("ALTER TABLE sessions ADD COLUMN expires_at TEXT").run();
  const fallbackExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();
  db.prepare("UPDATE sessions SET expires_at = ? WHERE expires_at IS NULL OR expires_at = ''").run(
    fallbackExpiresAt
  );
}

const marketColumns = db.prepare("PRAGMA table_info(markets)").all();
if (!marketColumns.some((col) => col.name === "name")) {
  db.prepare("ALTER TABLE markets ADD COLUMN name TEXT NOT NULL DEFAULT ''").run();
  const existingMarkets = db.prepare("SELECT id, outcomes FROM markets WHERE name = '' OR name IS NULL").all();
  const updateMarketName = db.prepare("UPDATE markets SET name = ? WHERE id = ?");
  for (const market of existingMarkets) {
    let fallbackName = `Market #${market.id}`;
    try {
      const outcomes = JSON.parse(market.outcomes);
      if (Array.isArray(outcomes) && outcomes.length) {
        fallbackName = outcomes.join(" / ");
      }
    } catch {
      // Keep the generic fallback name for malformed legacy data.
    }
    updateMarketName.run(fallbackName, market.id);
  }
}

// ── LMSR helpers ─────────────────────────────────────────────────────────────
const EPS = 1e-9;
const INITIAL_BALANCE = 1;
const PRIOR_SUM_TOLERANCE = 1e-6;
const PASSWORD_MIN_LENGTH = 6;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

function minimum(arr) {
  return arr.reduce((m, v) => (v < m ? v : m), arr[0]);
}

function logSumExpWeighted(q, p, b) {
  const xs = q.map((qi, i) => Math.log(p[i]) + qi / b);
  const maxX = Math.max(...xs);
  const sum = xs.reduce((acc, x) => acc + Math.exp(x - maxX), 0);
  return maxX + Math.log(sum);
}

function marketL(p, b) {
  return -b * Math.log(minimum(p));
}

function marketCost(p, b, q) {
  const L = marketL(p, b);
  return L + b * logSumExpWeighted(q, p, b);
}

function impliedProbabilities(p, b, q) {
  const xs = q.map((qi, i) => Math.log(p[i]) + qi / b);
  const maxX = Math.max(...xs);
  const numerators = xs.map((x) => Math.exp(x - maxX));
  const denom = numerators.reduce((a, v) => a + v, 0);
  return numerators.map((v) => v / denom);
}

function vectorAdd(a, b) {
  return a.map((v, i) => v + b[i]);
}

function dot(a, b) {
  return a.reduce((sum, v, i) => sum + v * b[i], 0);
}

function clampNonNeg(v) {
  return v < 0 ? 0 : v;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== "string" || !storedHash.includes(":")) {
    return false;
  }
  const [salt, existingHash] = storedHash.split(":");
  const computedHash = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(existingHash, "hex");
  const b = Buffer.from(computedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  db.prepare("INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    token,
    username,
    new Date(now).toISOString(),
    expiresAt
  );
  return token;
}

// ── DB helpers ───────────────────────────────────────────────────────────────
function getUser(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

function publicUser(userRow) {
  if (!userRow) return null;
  return { username: userRow.username, balance: userRow.balance };
}

function getMarket(id) {
  const row = db.prepare("SELECT * FROM markets WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    outcomes: JSON.parse(row.outcomes),
    p: JSON.parse(row.p),
    q: JSON.parse(row.q),
    open: !!row.open,
  };
}

function getPortfolio(username, marketId, outcomes) {
  const row = db.prepare("SELECT q FROM portfolios WHERE username = ? AND market_id = ?").get(username, marketId);
  return row ? JSON.parse(row.q) : outcomes.map(() => 0);
}

function recordHistory(username, action, detail, market = null) {
  db.prepare(
    "INSERT INTO history (username, market_id, market_name, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    username,
    market?.id ?? null,
    market?.name ?? "System",
    action,
    detail,
    new Date().toISOString()
  );
}

  function recordMarketPriceSnapshot(market, event) {
    const probs = impliedProbabilities(market.p, market.b, market.q);
    db.prepare(
      "INSERT INTO market_price_history (market_id, event, probs, created_at) VALUES (?, ?, ?, ?)"
    ).run(market.id, event, JSON.stringify(probs), new Date().toISOString());
  }

function nextMarketId() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'next_market_id'").get();
  const id = String(row.value);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'next_market_id'").run(String(Number(id) + 1));
  return id;
}

function requireAuth(req, res, next) {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required." });
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }
  const session = db.prepare("SELECT username, expires_at FROM sessions WHERE token = ?").get(token);
  if (!session) {
    return res.status(401).json({ error: "Invalid session token." });
  }

  const expiresAtMs = Date.parse(session.expires_at || "");
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return res.status(401).json({ error: "Session expired. Please login again." });
  }

  const nextExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(nextExpiresAt, token);

  req.authUser = session.username;
  req.authToken = token;
  next();
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/users — list all usernames
app.get("/api/users", (req, res) => {
  const rows = db.prepare("SELECT username FROM users ORDER BY username").all();
  res.json(rows.map((r) => r.username));
});

// POST /api/register — { username }
app.post("/api/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || typeof username !== "string" || !username.trim()) {
    return res.status(400).json({ error: "Username is required." });
  }
  if (!password || typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }
  const name = username.trim();
  if (getUser(name)) {
    return res.status(409).json({ error: "Username already exists." });
  }
  const passwordHash = hashPassword(password);
  db.prepare("INSERT INTO users (username, password_hash, balance) VALUES (?, ?, ?)").run(
    name,
    passwordHash,
    INITIAL_BALANCE
  );
  const token = createSession(name);
  res.json({ token, user: { username: name, balance: INITIAL_BALANCE } });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || typeof username !== "string" || !username.trim()) {
    return res.status(400).json({ error: "Username is required." });
  }
  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "Password is required." });
  }
  const user = getUser(username.trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  const token = createSession(user.username);
  res.json({ token, user: publicUser(user) });
});

app.get("/api/me", requireAuth, (req, res) => {
  const user = getUser(req.authUser);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }
  res.json(publicUser(user));
});

app.post("/api/logout", requireAuth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(req.authToken);
  res.json({ ok: true });
});

app.get("/api/sessions", requireAuth, (req, res) => {
  const rows = db
    .prepare("SELECT token, created_at, expires_at FROM sessions WHERE username = ? ORDER BY created_at DESC")
    .all(req.authUser);
  const sessions = rows.map((row) => ({
    created_at: row.created_at,
    expires_at: row.expires_at,
    current: row.token === req.authToken,
  }));
  res.json(sessions);
});

app.post("/api/logout-all", requireAuth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE username = ?").run(req.authUser);
  res.json({ ok: true });
});

// GET /api/users/:username — get user info
app.get("/api/users/:username", requireAuth, (req, res) => {
  if (req.params.username !== req.authUser) {
    return res.status(403).json({ error: "Forbidden." });
  }
  const user = getUser(req.params.username);
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json(publicUser(user));
});

// GET /api/markets — list all markets
app.get("/api/markets", (req, res) => {
  const rows = db.prepare("SELECT * FROM markets ORDER BY CAST(id AS INTEGER)").all();
  res.json(
    rows.map((row) => ({
      ...row,
      outcomes: JSON.parse(row.outcomes),
      p: JSON.parse(row.p),
      q: JSON.parse(row.q),
      open: !!row.open,
    }))
  );
});

// GET /api/markets/:id — single market
app.get("/api/markets/:id", (req, res) => {
  const market = getMarket(req.params.id);
  if (!market) return res.status(404).json({ error: "Market not found." });
  res.json(market);
});

app.get("/api/markets/:id/price-history", (req, res) => {
  const market = getMarket(req.params.id);
  if (!market) return res.status(404).json({ error: "Market not found." });

  const rows = db
    .prepare(
      "SELECT event, probs, created_at FROM market_price_history WHERE market_id = ? ORDER BY datetime(created_at) ASC, id ASC"
    )
    .all(req.params.id);
  res.json(
    rows.map((row) => ({
      event: row.event,
      probs: JSON.parse(row.probs),
      created_at: row.created_at,
    }))
  );
});

// POST /api/markets — create market { maker, outcomes, priors, b }
app.post("/api/markets", requireAuth, (req, res) => {
  const { name, outcomes, priors, b } = req.body;
  try {
    const liquidity = Number(b);
    if (!name || typeof name !== "string" || !name.trim()) {
      throw new Error("Market name is required.");
    }
    if (!outcomes || !Array.isArray(outcomes) || outcomes.length < 2) {
      throw new Error("Provide at least 2 outcomes.");
    }
    if (!priors || !Array.isArray(priors) || priors.length !== outcomes.length) {
      throw new Error("Outcomes and priors lengths must match.");
    }
    if (priors.some((v) => v <= 0)) throw new Error("Each prior must be greater than 0.");
    const priorSum = priors.reduce((a, v) => a + v, 0);
    if (Math.abs(priorSum - 1) > PRIOR_SUM_TOLERANCE) throw new Error("Priors must sum to 1.");
    if (!Number.isFinite(liquidity) || liquidity <= 0) {
      throw new Error("Liquidity b must be greater than 0.");
    }

    const maker = req.authUser;
    const user = getUser(maker);
    if (!user) return res.status(404).json({ error: "Maker user not found." });

    const q = outcomes.map(() => 0);
    const L = marketL(priors, liquidity);
    if (user.balance < L - EPS) {
      throw new Error(`Insufficient maker balance. Need at least ${L.toFixed(6)}.`);
    }

    const id = nextMarketId();
    const marketName = name.trim();
    db.transaction(() => {
      db.prepare("UPDATE users SET balance = ? WHERE username = ?").run(clampNonNeg(user.balance - L), maker);
      db.prepare(
        "INSERT INTO markets (id, name, maker, outcomes, p, b, q, open) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
      ).run(id, marketName, maker, JSON.stringify(outcomes), JSON.stringify(priors), liquidity, JSON.stringify(q));
        recordMarketPriceSnapshot(
          {
            id,
            p: priors,
            b: liquidity,
            q,
          },
          "create"
        );
      recordHistory(
        maker,
        "create",
        `Created market with outcomes ${outcomes.join(" / ")}, priors ${priors.join(",")}, and liquidity ${liquidity}. C_0 = ${L.toFixed(6)}.`,
        { id, name: marketName }
      );
    })();

    res.json(getMarket(id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/markets/:id/trade — take position { trader, delta }
app.post("/api/markets/:id/trade", requireAuth, (req, res) => {
  const { delta } = req.body;
  try {
    const trader = req.authUser;
    const market = getMarket(req.params.id);
    if (!market) return res.status(404).json({ error: "Market not found." });
    if (!market.open) throw new Error("Market is closed.");
    if (market.maker === trader) throw new Error("Market makers cannot trade their own market.");

    const user = getUser(trader);
    if (!user) return res.status(404).json({ error: "Trader not found." });

    if (!Array.isArray(delta) || delta.length !== market.outcomes.length) {
      throw new Error("Δq length must match market outcomes.");
    }

    const currentPersonal = getPortfolio(trader, market.id, market.outcomes);
    const nextPersonal = vectorAdd(currentPersonal, delta);
    if (nextPersonal.some((v) => v < 0 && Math.abs(v) > EPS)) {
      throw new Error("Invalid trade: q_t + Δq must stay non-negative componentwise.");
    }

    const nextQ = vectorAdd(market.q, delta);
    const deltaC = marketCost(market.p, market.b, nextQ) - marketCost(market.p, market.b, market.q);
    const priceSummary = impliedProbabilities(market.p, market.b, nextQ)
      .map((value, index) => `${market.outcomes[index]}: ${value.toFixed(6)}`)
      .join(", ");

    if (user.balance < deltaC - EPS) {
      throw new Error(`Insufficient balance. Need ΔC = ${deltaC.toFixed(6)}.`);
    }

    db.transaction(() => {
      db.prepare("UPDATE markets SET q = ? WHERE id = ?").run(JSON.stringify(nextQ), market.id);
      db.prepare(
        "INSERT INTO portfolios (username, market_id, q) VALUES (?, ?, ?) ON CONFLICT(username, market_id) DO UPDATE SET q = excluded.q"
      ).run(trader, market.id, JSON.stringify(nextPersonal.map((v) => (Math.abs(v) < EPS ? 0 : v))));
      db.prepare("UPDATE users SET balance = ? WHERE username = ?").run(
        clampNonNeg(user.balance - deltaC),
        trader
      );
        recordMarketPriceSnapshot(
          {
            id: market.id,
            p: market.p,
            b: market.b,
            q: nextQ,
          },
          "trade"
        );
      recordHistory(
        trader,
        "trade",
        `Traded ${delta.map((value, index) => `${market.outcomes[index]} ${value >= 0 ? "+" : ""}${value}`).join(", ")} for cost ${deltaC.toFixed(6)}. Prices ${priceSummary}.`,
        market
      );
    })();

    res.json({ market: getMarket(market.id), user: getUser(trader) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/markets/:id/close — close market { maker }
app.post("/api/markets/:id/close", requireAuth, (req, res) => {
  try {
    const market = getMarket(req.params.id);
    if (!market) return res.status(404).json({ error: "Market not found." });
    if (!market.open) throw new Error("Market is already closed.");
    const maker = req.authUser;
    if (market.maker !== maker) throw new Error("Only the market maker can close this market.");

    const grad = impliedProbabilities(market.p, market.b, market.q);
    const posteriorSummary = grad.map((value) => value.toFixed(6)).join(",");
    const makerPayout = marketCost(market.p, market.b, market.q) - dot(grad, market.q);

    db.transaction(() => {
      // Pay out maker
      const makerUser = getUser(maker);
      db.prepare("UPDATE users SET balance = ? WHERE username = ?").run(
        clampNonNeg(makerUser.balance + makerPayout),
        maker
      );
      recordHistory(
        maker,
        "close",
        `Closed market and received maker payout ${makerPayout.toFixed(6)}.`,
        market
      );

      // Pay out all traders with positions in this market
      const positions = db.prepare("SELECT * FROM portfolios WHERE market_id = ?").all(market.id);
      for (const pos of positions) {
        const qT = JSON.parse(pos.q);
        const payout = dot(grad, qT);
        const u = getUser(pos.username);
        if (u) {
          db.prepare("UPDATE users SET balance = ? WHERE username = ?").run(
            clampNonNeg(u.balance + payout),
            pos.username
          );
          recordHistory(
            pos.username,
            "settlement",
            `Market closed and paid out ${payout.toFixed(6)} for final holdings. Posteriors ${posteriorSummary}.`,
            market
          );
        }
        db.prepare("UPDATE portfolios SET q = ? WHERE username = ? AND market_id = ?").run(
          JSON.stringify(market.outcomes.map(() => 0)),
          pos.username,
          market.id
        );
      }

      db.prepare("UPDATE markets SET open = 0 WHERE id = ?").run(market.id);
      recordMarketPriceSnapshot(market, "close");
    })();

    res.json({ market: getMarket(market.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/portfolio/:username — get all portfolios for a user
app.get("/api/portfolio/me", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM portfolios WHERE username = ?").all(req.authUser);
  const result = {};
  for (const row of rows) {
    result[row.market_id] = JSON.parse(row.q);
  }
  res.json(result);
});

// GET /api/portfolio/costs — sum of trade costs per market for current user
app.get("/api/portfolio/costs", requireAuth, (req, res) => {
  const rows = db
    .prepare("SELECT market_id, detail FROM history WHERE username = ? AND action = 'trade'")
    .all(req.authUser);
  const result = {};
  for (const row of rows) {
    const match = String(row.detail).match(/for cost ([+-]?\d+(?:\.\d+)?)/i);
    if (!match) continue;
    const cost = Number(match[1]);
    if (!Number.isFinite(cost)) continue;
    result[String(row.market_id)] = (result[String(row.market_id)] || 0) + cost;
  }
  res.json(result);
});

app.get("/api/history", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      "SELECT id, market_id, market_name, action, detail, created_at FROM history WHERE username = ? ORDER BY datetime(created_at) DESC, id DESC LIMIT 50"
    )
    .all(req.authUser);
  res.json(rows);
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error("Unhandled API error", err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Probabilize running at http://localhost:${PORT}`);
});
