const Database = require("better-sqlite3");
const path = require("path");

const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "probabilize.db");
const db = new Database(dbPath, { readonly: true });

const EPS = 1e-6;

function fail(message) {
  throw new Error(message);
}

function impliedProbabilities(p, b, q) {
  const xs = q.map((qi, i) => Math.log(p[i]) + qi / b);
  const maxX = Math.max(...xs);
  const numerators = xs.map((x) => Math.exp(x - maxX));
  const denom = numerators.reduce((a, v) => a + v, 0);
  return numerators.map((v) => v / denom);
}

function almostEqual(a, b, eps = EPS) {
  return Math.abs(a - b) <= eps;
}

function validate() {
  const users = db.prepare("SELECT username, password_hash, balance FROM users ORDER BY username").all();
  if (users.length !== 3) {
    fail(`Expected 3 users, found ${users.length}.`);
  }

  const expectedUsers = ["Alice", "Bob", "Cara"];
  for (const name of expectedUsers) {
    const user = users.find((u) => u.username === name);
    if (!user) {
      fail(`Missing demo user ${name}.`);
    }
    if (!user.password_hash || typeof user.password_hash !== "string") {
      fail(`User ${name} is missing password hash.`);
    }
    if (!Number.isFinite(user.balance)) {
      fail(`User ${name} has invalid balance.`);
    }
  }

  const markets = db.prepare("SELECT id, name, outcomes, p, b, q, open FROM markets ORDER BY CAST(id AS INTEGER)").all();
  if (markets.length !== 2) {
    fail(`Expected 2 markets, found ${markets.length}.`);
  }

  const m1 = markets.find((m) => m.id === "1");
  const m2 = markets.find((m) => m.id === "2");
  if (!m1 || !m2) {
    fail("Expected market ids 1 and 2.");
  }
  if (m1.open !== 1 || m2.open !== 0) {
    fail("Expected market #1 open and market #2 closed.");
  }

  const historyCount = db.prepare("SELECT COUNT(*) AS c FROM history").get().c;
  const priceHistoryCount = db.prepare("SELECT COUNT(*) AS c FROM market_price_history").get().c;
  if (historyCount !== 7) {
    fail(`Expected 7 history rows, found ${historyCount}.`);
  }
  if (priceHistoryCount !== 6) {
    fail(`Expected 6 market_price_history rows, found ${priceHistoryCount}.`);
  }

  const allowedActions = new Set(["create", "trade", "close", "settlement"]);
  const historyRows = db.prepare("SELECT action, created_at FROM history").all();
  for (const row of historyRows) {
    if (!allowedActions.has(row.action)) {
      fail(`Unexpected history action '${row.action}'.`);
    }
    if (!Number.isFinite(Date.parse(row.created_at || ""))) {
      fail("History row has invalid timestamp.");
    }
  }

  const portfolioRows = db.prepare("SELECT username, market_id, q FROM portfolios").all();
  for (const row of portfolioRows) {
    let q;
    try {
      q = JSON.parse(row.q);
    } catch {
      fail(`Portfolio row for ${row.username}/${row.market_id} has invalid JSON q.`);
    }
    if (!Array.isArray(q)) {
      fail(`Portfolio row for ${row.username}/${row.market_id} has non-array q.`);
    }
    if (q.some((v) => !Number.isFinite(v) || v < -EPS)) {
      fail(`Portfolio row for ${row.username}/${row.market_id} has invalid values.`);
    }
  }

  for (const market of markets) {
    const p = JSON.parse(market.p);
    const q = JSON.parse(market.q);
    const outcomes = JSON.parse(market.outcomes);

    if (!Array.isArray(p) || !Array.isArray(q) || !Array.isArray(outcomes)) {
      fail(`Market ${market.id} has invalid JSON vectors.`);
    }
    if (p.length !== q.length || q.length !== outcomes.length) {
      fail(`Market ${market.id} vectors are length-mismatched.`);
    }
    if (!Number.isFinite(market.b) || market.b <= 0) {
      fail(`Market ${market.id} has invalid b.`);
    }

    const rows = db
      .prepare(
        "SELECT event, probs, created_at FROM market_price_history WHERE market_id = ? ORDER BY datetime(created_at), id"
      )
      .all(market.id);

    if (!rows.length) {
      fail(`Market ${market.id} has no price history rows.`);
    }

    for (const row of rows) {
      if (!["create", "trade", "close"].includes(row.event)) {
        fail(`Market ${market.id} has invalid price history event '${row.event}'.`);
      }
      if (!Number.isFinite(Date.parse(row.created_at || ""))) {
        fail(`Market ${market.id} has invalid price history timestamp.`);
      }
      const probs = JSON.parse(row.probs);
      if (!Array.isArray(probs) || probs.length !== outcomes.length) {
        fail(`Market ${market.id} has malformed probs row.`);
      }
      const sum = probs.reduce((a, v) => a + v, 0);
      if (!almostEqual(sum, 1, 1e-5)) {
        fail(`Market ${market.id} price history probs do not sum to 1.`);
      }
      if (probs.some((v) => !Number.isFinite(v) || v < -EPS || v > 1 + EPS)) {
        fail(`Market ${market.id} has out-of-range probs.`);
      }
    }

    const last = rows[rows.length - 1];
    const lastProbs = JSON.parse(last.probs);
    const expectedNow = impliedProbabilities(p, market.b, q);
    for (let i = 0; i < expectedNow.length; i += 1) {
      if (!almostEqual(lastProbs[i], expectedNow[i], 1e-5)) {
        fail(`Market ${market.id} latest probs do not match current market state.`);
      }
    }

    if (market.open === 0) {
      const hasClose = rows.some((r) => r.event === "close");
      if (!hasClose) {
        fail(`Closed market ${market.id} is missing close price-history event.`);
      }
    }
  }
}

try {
  validate();
  console.log("Seed check passed.");
} catch (err) {
  console.error(`Seed check failed: ${err.message}`);
  process.exit(1);
}
