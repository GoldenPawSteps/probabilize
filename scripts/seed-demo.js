const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const dbPath = path.join(__dirname, "..", "probabilize.db");
const db = new Database(dbPath);

const EPS = 1e-9;

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function clampNonNeg(value) {
  return value < 0 ? 0 : value;
}

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
  return marketL(p, b) + b * logSumExpWeighted(q, p, b);
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

function iso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

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
    outcomes TEXT NOT NULL,
    p        TEXT NOT NULL,
    b        REAL NOT NULL,
    q        TEXT NOT NULL,
    open     INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS portfolios (
    username  TEXT NOT NULL,
    market_id TEXT NOT NULL,
    q         TEXT NOT NULL,
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
    created_at TEXT NOT NULL,
    expires_at TEXT
  );
  INSERT OR IGNORE INTO meta (key, value) VALUES ('next_market_id', '1');
`);

const seed = db.transaction(() => {
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM market_price_history").run();
  db.prepare("DELETE FROM history").run();
  db.prepare("DELETE FROM portfolios").run();
  db.prepare("DELETE FROM markets").run();
  db.prepare("DELETE FROM users").run();
  db.prepare("UPDATE meta SET value = ? WHERE key = 'next_market_id'").run("3");

  const users = {
    Alice: { password: "demo123", balance: 1.0 },
    Bob: { password: "demo123", balance: 1.0 },
    Cara: { password: "demo123", balance: 1.0 },
  };

  const markets = {};
  const portfolios = new Map();
  const historyRows = [];
  const priceHistoryRows = [];

  function getPortfolio(username, market) {
    const key = `${username}:${market.id}`;
    if (!portfolios.has(key)) {
      portfolios.set(key, market.outcomes.map(() => 0));
    }
    return portfolios.get(key);
  }

  function setPortfolio(username, market, q) {
    const key = `${username}:${market.id}`;
    portfolios.set(
      key,
      q.map((v) => (Math.abs(v) < EPS ? 0 : v))
    );
  }

  function recordHistory(username, market, action, detail, createdAt) {
    historyRows.push({
      username,
      market_id: market.id,
      market_name: market.name,
      action,
      detail,
      created_at: createdAt,
    });
  }

  function recordPriceHistory(market, event, createdAt) {
    priceHistoryRows.push({
      market_id: market.id,
      event,
      probs: impliedProbabilities(market.p, market.b, market.q),
      created_at: createdAt,
    });
  }

  function createMarket({ id, name, maker, outcomes, p, b, createdAt }) {
    const user = users[maker];
    const q = outcomes.map(() => 0);
    const creationCost = marketL(p, b);
    if (!user || user.balance + EPS < creationCost) {
      throw new Error(`Cannot create market ${id}: maker balance too low.`);
    }

    user.balance = clampNonNeg(user.balance - creationCost);
    const market = { id, name, maker, outcomes, p, b, q, open: 1 };
    markets[id] = market;

    recordHistory(
      maker,
      market,
      "create",
      `Created market with outcomes ${outcomes.join(" / ")}, priors ${p.join(",")}, and liquidity ${b}. C_0 = ${creationCost.toFixed(6)}.`,
      createdAt
    );
    recordPriceHistory(market, "create", createdAt);
  }

  function tradeMarket({ trader, marketId, delta, createdAt }) {
    const market = markets[marketId];
    const user = users[trader];
    if (!market || !user || !market.open) {
      throw new Error(`Cannot trade market ${marketId}.`);
    }
    if (market.maker === trader) {
      throw new Error(`Maker cannot trade market ${marketId}.`);
    }

    const currentPersonal = getPortfolio(trader, market);
    const nextPersonal = vectorAdd(currentPersonal, delta);
    if (nextPersonal.some((v) => v < -EPS)) {
      throw new Error(`Invalid seeded trade for ${trader} on market ${marketId}.`);
    }

    const nextQ = vectorAdd(market.q, delta);
    const deltaC = marketCost(market.p, market.b, nextQ) - marketCost(market.p, market.b, market.q);
    const priceSummary = impliedProbabilities(market.p, market.b, nextQ)
      .map((value, index) => `${market.outcomes[index]}: ${value.toFixed(6)}`)
      .join(", ");
    if (user.balance + EPS < deltaC) {
      throw new Error(`Seed trade exceeds balance for ${trader} on market ${marketId}.`);
    }

    market.q = nextQ;
    setPortfolio(trader, market, nextPersonal);
    user.balance = clampNonNeg(user.balance - deltaC);

    recordHistory(
      trader,
      market,
      "trade",
      `Traded ${delta
        .map((value, index) => `${market.outcomes[index]} ${value >= 0 ? "+" : ""}${value}`)
        .join(", ")} for cost ${deltaC.toFixed(6)}. Prices ${priceSummary}.`,
      createdAt
    );
    recordPriceHistory(market, "trade", createdAt);
  }

  function closeMarket({ maker, marketId, createdAt }) {
    const market = markets[marketId];
    if (!market || !market.open || market.maker !== maker) {
      throw new Error(`Cannot close market ${marketId}.`);
    }

    const grad = impliedProbabilities(market.p, market.b, market.q);
    const posteriorSummary = grad.map((value) => value.toFixed(6)).join(",");
    const makerPayout = marketCost(market.p, market.b, market.q) - dot(grad, market.q);
    users[maker].balance = clampNonNeg(users[maker].balance + makerPayout);

    recordHistory(
      maker,
      market,
      "close",
      `Closed market and received maker payout ${makerPayout.toFixed(6)}.`,
      createdAt
    );

    for (const username of Object.keys(users)) {
      const key = `${username}:${market.id}`;
      if (!portfolios.has(key)) {
        continue;
      }
      const qT = portfolios.get(key);
      const payout = dot(grad, qT);
      users[username].balance = clampNonNeg(users[username].balance + payout);
      portfolios.set(
        key,
        market.outcomes.map(() => 0)
      );
      recordHistory(
        username,
        market,
        "settlement",
        `Market closed and paid out ${payout.toFixed(6)} for final holdings. Posteriors ${posteriorSummary}.`,
        createdAt
      );
    }

    market.open = 0;
    recordPriceHistory(market, "close", createdAt);
  }

  createMarket({
    id: "2",
    name: "Q2 GDP above 2%?",
    maker: "Bob",
    outcomes: ["Yes", "No"],
    p: [0.6, 0.4],
    b: 0.4,
    createdAt: iso(260),
  });

  tradeMarket({
    trader: "Alice",
    marketId: "2",
    delta: [0.1, 0.5],
    createdAt: iso(230),
  });

  closeMarket({
    maker: "Bob",
    marketId: "2",
    createdAt: iso(210),
  });

  createMarket({
    id: "1",
    name: "Will it rain tomorrow?",
    maker: "Alice",
    outcomes: ["Yes", "No"],
    p: [0.5, 0.5],
    b: 0.35,
    createdAt: iso(180),
  });

  tradeMarket({
    trader: "Bob",
    marketId: "1",
    delta: [0.2, 0],
    createdAt: iso(140),
  });

  tradeMarket({
    trader: "Cara",
    marketId: "1",
    delta: [0.1, 0],
    createdAt: iso(95),
  });

  const insertUser = db.prepare(
    "INSERT INTO users (username, password_hash, balance) VALUES (?, ?, ?)"
  );
  for (const [username, user] of Object.entries(users)) {
    insertUser.run(username, hashPassword(user.password), user.balance);
  }

  const insertMarket = db.prepare(
    "INSERT INTO markets (id, name, maker, outcomes, p, b, q, open) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const market of Object.values(markets).sort((a, b) => Number(a.id) - Number(b.id))) {
    insertMarket.run(
      market.id,
      market.name,
      market.maker,
      JSON.stringify(market.outcomes),
      JSON.stringify(market.p),
      market.b,
      JSON.stringify(market.q),
      market.open
    );
  }

  const insertPortfolio = db.prepare(
    "INSERT INTO portfolios (username, market_id, q) VALUES (?, ?, ?)"
  );
  for (const [key, q] of portfolios.entries()) {
    const [username, marketId] = key.split(":");
    insertPortfolio.run(username, marketId, JSON.stringify(q));
  }

  const insertHistory = db.prepare(
    "INSERT INTO history (username, market_id, market_name, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const row of historyRows.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    insertHistory.run(row.username, row.market_id, row.market_name, row.action, row.detail, row.created_at);
  }

  const insertPriceHistory = db.prepare(
    "INSERT INTO market_price_history (market_id, event, probs, created_at) VALUES (?, ?, ?, ?)"
  );
  for (const row of priceHistoryRows.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    insertPriceHistory.run(row.market_id, row.event, JSON.stringify(row.probs), row.created_at);
  }
});

seed();

console.log("Demo seed complete.");
console.log("Users: Alice, Bob, Cara");
console.log("Password for all demo users: demo123");
console.log("Markets seeded: 2 (1 open, 1 closed)");
console.log("Values are replay-derived and internally consistent.");
