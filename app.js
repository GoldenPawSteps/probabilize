const INITIAL_BALANCE = 1;
const EPS = 1e-9;
const PRIOR_SUM_TOLERANCE = 1e-6;
const STORAGE_KEY = "probabilize-state";

const state = loadState();
let selectedMarketId = null;

const elements = {
  authView: document.getElementById("auth-view"),
  appView: document.getElementById("app-view"),
  currentUser: document.getElementById("current-user"),
  registerUsername: document.getElementById("register-username"),
  registerBtn: document.getElementById("register-btn"),
  loginUsername: document.getElementById("login-username"),
  loginBtn: document.getElementById("login-btn"),
  logoutBtn: document.getElementById("logout-btn"),
  authError: document.getElementById("auth-error"),
  userBalance: document.getElementById("user-balance"),
  marketList: document.getElementById("market-list"),
  dashboardError: document.getElementById("dashboard-error"),
  outcomesInput: document.getElementById("outcomes-input"),
  priorsInput: document.getElementById("priors-input"),
  bInput: document.getElementById("b-input"),
  createMarketBtn: document.getElementById("create-market-btn"),
  createError: document.getElementById("create-error"),
  marketTitle: document.getElementById("market-title"),
  marketMaker: document.getElementById("market-maker"),
  marketB: document.getElementById("market-b"),
  priceList: document.getElementById("price-list"),
  deltaqInput: document.getElementById("deltaq-input"),
  tradeBtn: document.getElementById("trade-btn"),
  tradePreview: document.getElementById("trade-preview"),
  tradeError: document.getElementById("trade-error"),
  closeMarketBtn: document.getElementById("close-market-btn"),
  portfolioList: document.getElementById("portfolio-list"),
  tabs: [...document.querySelectorAll(".tabs button[data-tab]")],
  tabContents: [...document.querySelectorAll(".tab-content")],
};

elements.registerBtn.addEventListener("click", registerUser);
elements.loginBtn.addEventListener("click", loginUser);
elements.logoutBtn.addEventListener("click", logoutUser);
elements.createMarketBtn.addEventListener("click", createMarket);
elements.tradeBtn.addEventListener("click", takePosition);
elements.closeMarketBtn.addEventListener("click", closeMarket);
elements.deltaqInput.addEventListener("input", renderTradePreview);
elements.tabs.forEach((tab) => tab.addEventListener("click", () => openTab(tab.dataset.tab)));

render();

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return { users: {}, markets: {}, currentUser: null, nextMarketId: 1 };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      users: parsed.users || {},
      markets: parsed.markets || {},
      currentUser: parsed.currentUser || null,
      nextMarketId: parsed.nextMarketId || 1,
    };
  } catch {
    return { users: {}, markets: {}, currentUser: null, nextMarketId: 1 };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function resetErrors() {
  elements.authError.textContent = "";
  elements.dashboardError.textContent = "";
  elements.createError.textContent = "";
  elements.tradeError.textContent = "";
}

function registerUser() {
  resetErrors();
  const username = elements.registerUsername.value.trim();
  if (!username) {
    elements.authError.textContent = "Username is required.";
    return;
  }
  if (state.users[username]) {
    elements.authError.textContent = "Username already exists.";
    return;
  }

  state.users[username] = { balance: INITIAL_BALANCE, portfolios: {} };
  state.currentUser = username;
  elements.registerUsername.value = "";
  saveState();
  render();
}

function loginUser() {
  resetErrors();
  const username = elements.loginUsername.value;
  if (!username || !state.users[username]) {
    elements.authError.textContent = "Choose a valid user to login.";
    return;
  }
  state.currentUser = username;
  saveState();
  render();
}

function logoutUser() {
  state.currentUser = null;
  selectedMarketId = null;
  saveState();
  render();
}

function parseNumberList(input, field) {
  const values = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));
  if (!values.length || values.some((v) => !Number.isFinite(v))) {
    throw new Error(`${field} must be a comma-separated numeric list.`);
  }
  return values;
}

function vectorAdd(a, b) {
  return a.map((v, i) => v + b[i]);
}

function dot(a, b) {
  return a.reduce((sum, v, i) => sum + v * b[i], 0);
}

function minimum(arr) {
  return arr.reduce((m, v) => (v < m ? v : m), arr[0]);
}

function logSumExpWeighted(q, p, b) {
  if (!q.length || !p.length || q.length !== p.length) {
    throw new Error("Invalid market vectors for LMSR cost computation.");
  }
  const xs = q.map((qi, i) => Math.log(p[i]) + qi / b);
  const maxX = Math.max(...xs);
  const sum = xs.reduce((acc, x) => acc + Math.exp(x - maxX), 0);
  return maxX + Math.log(sum);
}

function marketL(market) {
  return -market.b * Math.log(minimum(market.p));
}

function marketCost(market, q) {
  const L = marketL(market);
  return L + market.b * logSumExpWeighted(q, market.p, market.b);
}

function impliedProbabilities(market, q) {
  if (!q.length || !market.p.length || q.length !== market.p.length) {
    throw new Error("Invalid market vectors for probability computation.");
  }
  const xs = q.map((qi, i) => Math.log(market.p[i]) + qi / market.b);
  const maxX = Math.max(...xs);
  const numerators = xs.map((x) => Math.exp(x - maxX));
  const denom = numerators.reduce((a, b) => a + b, 0);
  return numerators.map((v) => v / denom);
}

function ensurePortfolioVector(user, market) {
  if (!user.portfolios[market.id]) {
    user.portfolios[market.id] = market.outcomes.map(() => 0);
  }
  return user.portfolios[market.id];
}

function createMarket() {
  resetErrors();
  const makerName = state.currentUser;
  const maker = state.users[makerName];

  try {
    const outcomes = elements.outcomesInput.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const priors = parseNumberList(elements.priorsInput.value, "Priors");
    const b = Number(elements.bInput.value);

    if (outcomes.length < 2) {
      throw new Error("Provide at least 2 outcomes.");
    }
    if (outcomes.length !== priors.length) {
      throw new Error("Outcomes and priors lengths must match.");
    }
    if (priors.some((v) => v <= 0)) {
      throw new Error("Each prior must be greater than 0.");
    }
    const priorSum = priors.reduce((a, v) => a + v, 0);
    if (Math.abs(priorSum - 1) > PRIOR_SUM_TOLERANCE) {
      throw new Error("Priors must sum to 1.");
    }
    if (!Number.isFinite(b) || b <= 0) {
      throw new Error("Liquidity b must be greater than 0.");
    }

    const market = {
      id: String(state.nextMarketId++),
      maker: makerName,
      outcomes,
      p: priors,
      b,
      q: outcomes.map(() => 0),
      open: true,
    };

    const L = marketL(market);
    if (maker.balance + EPS < L) {
      throw new Error(`Insufficient maker balance. Need at least ${L.toFixed(6)}.`);
    }

    maker.balance = clampNonNegative(maker.balance - L);
    state.markets[market.id] = market;

    saveState();
    elements.outcomesInput.value = "";
    elements.priorsInput.value = "";
    elements.bInput.value = "";
    selectedMarketId = market.id;
    openTab("market-tab");
    render();
  } catch (error) {
    elements.createError.textContent = error.message;
  }
}

function takePosition() {
  resetErrors();
  const market = getSelectedOpenMarket();
  if (!market) {
    elements.tradeError.textContent = "Select an open market first.";
    return;
  }

  const user = state.users[state.currentUser];
  try {
    const delta = parseNumberList(elements.deltaqInput.value, "Δq");
    if (delta.length !== market.outcomes.length) {
      throw new Error("Δq length must match market outcomes.");
    }

    const currentPersonal = ensurePortfolioVector(user, market);
    const nextPersonal = vectorAdd(currentPersonal, delta);
    if (nextPersonal.some((v) => v < -EPS)) {
      throw new Error("Invalid trade: q_t + Δq must stay non-negative componentwise.");
    }

    const nextQ = vectorAdd(market.q, delta);
    const deltaC = marketCost(market, nextQ) - marketCost(market, market.q);

    if (user.balance + EPS < deltaC) {
      throw new Error(`Insufficient balance. Need ΔC = ${deltaC.toFixed(6)}.`);
    }

    market.q = nextQ;
    user.portfolios[market.id] = nextPersonal.map((v) => (Math.abs(v) < EPS ? 0 : v));
    user.balance = clampNonNegative(user.balance - deltaC);

    saveState();
    render();
  } catch (error) {
    elements.tradeError.textContent = error.message;
  }
}

function closeMarket() {
  resetErrors();
  const market = getSelectedOpenMarket();
  if (!market) {
    elements.tradeError.textContent = "Select an open market first.";
    return;
  }
  if (market.maker !== state.currentUser) {
    elements.tradeError.textContent = "Only the market maker can close this market.";
    return;
  }

  const grad = impliedProbabilities(market, market.q);
  const maker = state.users[market.maker];
  const makerPayout = marketCost(market, market.q) - dot(grad, market.q);
  maker.balance = clampNonNegative(maker.balance + makerPayout);

  Object.entries(state.users).forEach(([username, user]) => {
    if (username === market.maker) {
      return;
    }
    const qT = user.portfolios[market.id];
    if (!qT) {
      return;
    }
    user.balance = clampNonNegative(user.balance + dot(grad, qT));
    user.portfolios[market.id] = market.outcomes.map(() => 0);
  });

  market.open = false;
  saveState();
  render();
}

function clampNonNegative(value) {
  return value < 0 ? 0 : value;
}

function getSelectedOpenMarket() {
  const market = state.markets[selectedMarketId];
  return market && market.open ? market : null;
}

function openTab(tabId) {
  elements.tabContents.forEach((section) => section.classList.add("hidden"));
  const tab = document.getElementById(tabId);
  if (tab) {
    tab.classList.remove("hidden");
  }
}

function render() {
  renderAuth();
  renderDashboard();
  renderMarket();
  renderPortfolio();
}

function renderAuth() {
  const usernames = Object.keys(state.users).sort();
  elements.loginUsername.innerHTML = `<option value="">Select user</option>${usernames
    .map((u) => `<option value="${u}">${u}</option>`)
    .join("")}`;

  const loggedIn = !!state.currentUser;
  elements.authView.classList.toggle("hidden", loggedIn);
  elements.appView.classList.toggle("hidden", !loggedIn);

  if (!loggedIn) {
    elements.currentUser.textContent = "";
    return;
  }

  const user = state.users[state.currentUser];
  elements.currentUser.textContent = `User: ${state.currentUser} | Balance: ${user.balance.toFixed(6)}`;
  elements.userBalance.textContent = user.balance.toFixed(6);
  if (!document.querySelector(".tab-content:not(.hidden)")) {
    openTab("dashboard-tab");
  }
}

function renderDashboard() {
  const markets = Object.values(state.markets).sort((a, b) => Number(a.id) - Number(b.id));
  if (!markets.length) {
    elements.marketList.innerHTML = "<li>No markets yet.</li>";
    return;
  }

  elements.marketList.innerHTML = markets
    .map((m) => {
      const status = m.open ? "open" : "closed";
      return `<li><button data-market-id="${m.id}">#${m.id} ${m.outcomes.join(" / ")} (${status})</button></li>`;
    })
    .join("");

  [...elements.marketList.querySelectorAll("button[data-market-id]")].forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedMarketId = btn.dataset.marketId;
      openTab("market-tab");
      render();
    });
  });
}

function renderMarket() {
  const market = state.markets[selectedMarketId];
  if (!market) {
    elements.marketTitle.textContent = "Market Detail";
    elements.marketMaker.textContent = "Select a market from dashboard.";
    elements.marketB.textContent = "";
    elements.priceList.innerHTML = "";
    elements.tradePreview.textContent = "";
    elements.closeMarketBtn.classList.add("hidden");
    return;
  }

  const probs = impliedProbabilities(market, market.q);
  const status = market.open ? "Open" : "Closed";

  elements.marketTitle.textContent = `Market #${market.id} — ${status}`;
  elements.marketMaker.textContent = `Maker: ${market.maker}`;
  elements.marketB.textContent = `Liquidity b: ${market.b}`;
  elements.priceList.innerHTML = market.outcomes
    .map((outcome, i) => {
      return `<div>${outcome}: π = ${probs[i].toFixed(6)} | q = ${market.q[i].toFixed(6)}</div>`;
    })
    .join("");

  if (market.open) {
    renderTradePreview();
  } else {
    elements.tradePreview.textContent = "Trading disabled on closed markets.";
  }

  const isMaker = state.currentUser === market.maker;
  const canClose = market.open && isMaker;
  elements.closeMarketBtn.classList.toggle("hidden", !canClose);
  elements.tradeBtn.disabled = !market.open;
}

function renderTradePreview() {
  const market = getSelectedOpenMarket();
  if (!market) {
    elements.tradePreview.textContent = "";
    return;
  }

  let delta;
  try {
    delta = parseNumberList(elements.deltaqInput.value, "Δq");
  } catch {
    elements.tradePreview.textContent = "Enter Δq to preview cost change ΔC.";
    return;
  }

  if (delta.length !== market.outcomes.length) {
    elements.tradePreview.textContent = "Δq length must match outcomes.";
    return;
  }

  const nextQ = vectorAdd(market.q, delta);
  const deltaC = marketCost(market, nextQ) - marketCost(market, market.q);
  elements.tradePreview.textContent = `ΔC = ${deltaC.toFixed(6)}`;
}

function renderPortfolio() {
  const username = state.currentUser;
  if (!username) {
    elements.portfolioList.innerHTML = "";
    return;
  }
  const user = state.users[username];
  const entries = Object.entries(user.portfolios).filter(([, vec]) => vec.some((v) => Math.abs(v) > EPS));
  if (!entries.length) {
    elements.portfolioList.innerHTML = "<li>No active positions.</li>";
    return;
  }

  elements.portfolioList.innerHTML = entries
    .map(([marketId, vec]) => {
      const market = state.markets[marketId];
      if (!market) {
        return "";
      }
      const detail = vec.map((v, i) => `${market.outcomes[i]}: ${v.toFixed(6)}`).join(", ");
      return `<li>Market #${marketId}: ${detail}</li>`;
    })
    .join("");
}
