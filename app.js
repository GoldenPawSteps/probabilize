const EPS = 1e-9;
const PRIOR_SUM_TOLERANCE = 1e-6;

// currentUser persists across page refreshes within the same session
const persistedToken = localStorage.getItem("authToken");
let currentUser = sessionStorage.getItem("currentUser") || localStorage.getItem("currentUser") || null;
let authToken = persistedToken || sessionStorage.getItem("authToken") || null;
let rememberSession = !!persistedToken;
let currentBalance = null;
let selectedMarketId = null;
let activeMarketSort = "highest-c";
let marketSearchQuery = "";
let state = { markets: {}, history: [], portfolios: {} }; // local cache refreshed from server
// state.tradeCosts = { [marketId]: sumOfTradeCosts }

const elements = {
  authView: document.getElementById("auth-view"),
  appView: document.getElementById("app-view"),
  currentUser: document.getElementById("current-user"),
  registerUsername: document.getElementById("register-username"),
  registerPassword: document.getElementById("register-password"),
  registerBtn: document.getElementById("register-btn"),
  loginUsername: document.getElementById("login-username"),
  loginPassword: document.getElementById("login-password"),
  rememberMe: document.getElementById("remember-me"),
  loginBtn: document.getElementById("login-btn"),
  logoutBtn: document.getElementById("logout-btn"),
  authError: document.getElementById("auth-error"),
  userBalance: document.getElementById("user-balance"),
  marketSearchInput: document.getElementById("market-search-input"),
  activeMarketSort: document.getElementById("active-market-sort"),
  marketList: document.getElementById("market-list"),
  closedMarketList: document.getElementById("closed-market-list"),
  historyList: document.getElementById("history-list"),
  sessionList: document.getElementById("session-list"),
  logoutAllBtn: document.getElementById("logout-all-btn"),
  dashboardError: document.getElementById("dashboard-error"),
  marketNameInput: document.getElementById("market-name-input"),
  outcomesInput: document.getElementById("outcomes-input"),
  priorsInput: document.getElementById("priors-input"),
  bInput: document.getElementById("b-input"),
  createCostInfo: document.getElementById("create-cost-info"),
  createMarketBtn: document.getElementById("create-market-btn"),
  createError: document.getElementById("create-error"),
  marketTitle: document.getElementById("market-title"),
  marketMaker: document.getElementById("market-maker"),
  marketB: document.getElementById("market-b"),
  marketChart: document.getElementById("market-chart"),
  priceList: document.getElementById("price-list"),
  tradeSection: document.getElementById("trade-section"),
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
elements.logoutAllBtn.addEventListener("click", logoutAllDevices);
elements.createMarketBtn.addEventListener("click", createMarket);
elements.priorsInput.addEventListener("input", renderCreateCostInfo);
elements.bInput.addEventListener("input", renderCreateCostInfo);
elements.priorsInput.addEventListener("change", renderCreateCostInfo);
elements.bInput.addEventListener("change", renderCreateCostInfo);
elements.tradeBtn.addEventListener("click", takePosition);
elements.closeMarketBtn.addEventListener("click", closeMarket);
elements.deltaqInput.addEventListener("input", renderTradePreview);
elements.tabs.forEach((tab) => tab.addEventListener("click", () => openTab(tab.dataset.tab)));
if (elements.activeMarketSort) {
  activeMarketSort = elements.activeMarketSort.value || activeMarketSort;
  elements.activeMarketSort.addEventListener("change", () => {
    activeMarketSort = elements.activeMarketSort.value || "uncertain";
    renderDashboard();
  });
}
if (elements.marketSearchInput) {
  marketSearchQuery = elements.marketSearchInput.value.trim().toLowerCase();
  elements.marketSearchInput.addEventListener("input", () => {
    marketSearchQuery = elements.marketSearchInput.value.trim().toLowerCase();
    renderDashboard();
  });
}
document.addEventListener("touchstart", dismissKeyboardOnOutsideTap, { passive: true });
document.addEventListener("mousedown", dismissKeyboardOnOutsideTap);

init();

function dismissKeyboardOnOutsideTap(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const isEditableTarget =
    target.closest("input, textarea, select, [contenteditable='true']") ||
    target.closest("label[for]");
  if (isEditableTarget) {
    return;
  }

  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return;
  }

  const isActiveEditable =
    active.matches("input, textarea, select, [contenteditable='true']") ||
    active.getAttribute("contenteditable") === "true";
  if (isActiveEditable) {
    active.blur();
  }
}

async function init() {
  try {
    await refreshState();
    render();
    renderCreateCostInfo();
  } catch (err) {
    elements.authError.textContent = "Startup error: " + err.message;
  }
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(method, path, body) {
  let url;
  let normalizedPath;

  try {
    if (window.location.protocol === "file:") {
      throw new Error("Open the app from a proper URL (http:// or https://).");
    }
    const startsWithApi = path.startsWith("/api/");
    normalizedPath = startsWithApi
      ? path
      : `/api${path.startsWith("/") ? path : `/${path}`}`;
    url = new URL(normalizedPath, window.location.origin).toString();
  } catch (err) {
    throw new Error("Invalid app URL. " + err.message);
  }

  let res;
  try {
    const headers = body ? { "Content-Type": "application/json" } : {};
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error("Cannot reach server at " + url + ". Error: " + err.message);
  }

  const raw = await res.text();
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { error: raw };
    }
  }

  if (!res.ok) {
    const detail = data.error ? `: ${String(data.error)}` : "";
    throw new Error(`Request failed (${res.status})${detail}`);
  }

  const rotatedToken = res.headers.get("X-Session-Token");
  if (rotatedToken) {
    authToken = rotatedToken;
    persistAuth(authToken, currentUser, rememberSession);
  }

  return data;
}

function persistAuth(token, username, remember) {
  if (remember) {
    localStorage.setItem("authToken", token);
    localStorage.setItem("currentUser", username || "");
    sessionStorage.removeItem("authToken");
    sessionStorage.removeItem("currentUser");
  } else {
    sessionStorage.setItem("authToken", token);
    sessionStorage.setItem("currentUser", username || "");
    localStorage.removeItem("authToken");
    localStorage.removeItem("currentUser");
  }
}

function clearAuthStorage() {
  sessionStorage.removeItem("authToken");
  sessionStorage.removeItem("currentUser");
  localStorage.removeItem("authToken");
  localStorage.removeItem("currentUser");
}

function formatIsoDate(isoString) {
  const ts = Date.parse(isoString || "");
  if (!Number.isFinite(ts)) {
    return "unknown";
  }
  return new Date(ts).toLocaleString();
}

async function refreshState() {
  const markets = await api("GET", "/api/markets");

  state.markets = {};
  for (const m of markets) {
    state.markets[m.id] = m;
  }

  if (authToken) {
    try {
      const user = await api("GET", "/api/me");
      currentUser = user.username;
      currentBalance = user.balance;
      sessionStorage.setItem("currentUser", currentUser);
      state.history = await api("GET", "/api/history");
      state.portfolios = await api("GET", "/api/portfolio/me");
      state.tradeCosts = await api("GET", "/api/portfolio/costs");
    } catch {
      authToken = null;
      currentUser = null;
      currentBalance = null;
      rememberSession = false;
      state.history = [];
      state.portfolios = {};
      state.tradeCosts = {};
      clearAuthStorage();
    }
  } else {
    currentBalance = null;
    state.history = [];
    state.portfolios = {};
    state.tradeCosts = {};
  }
}

// ── Parsing / math helpers ────────────────────────────────────────────────────
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

function parseFiniteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : NaN;
  }
  if (typeof value !== "string") {
    return NaN;
  }
  const normalized = value.trim().replace(",", ".");
  if (!normalized) {
    return NaN;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function vectorAdd(a, b) {
  return a.map((v, i) => v + b[i]);
}

function logSumExpWeighted(q, p, b) {
  const xs = q.map((qi, i) => Math.log(p[i]) + qi / b);
  const maxX = Math.max(...xs);
  const sum = xs.reduce((acc, x) => acc + Math.exp(x - maxX), 0);
  return maxX + Math.log(sum);
}

function marketL(p, b) {
  return -b * Math.log(Math.min(...p));
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

// ── Auth ──────────────────────────────────────────────────────────────────────
function resetErrors() {
  elements.authError.textContent = "";
  elements.dashboardError.textContent = "";
  elements.createError.textContent = "";
  elements.tradeError.textContent = "";
}

async function logoutAllDevices() {
  resetErrors();
  if (!authToken) {
    elements.dashboardError.textContent = "You are not logged in.";
    return;
  }
  try {
    await api("POST", "/api/logout-all");
    authToken = null;
    currentUser = null;
    currentBalance = null;
    rememberSession = false;
    selectedMarketId = null;
    clearAuthStorage();
    render();
  } catch (err) {
    elements.dashboardError.textContent = err.message;
  }
}

async function registerUser() {
  resetErrors();
  const username = elements.registerUsername.value.trim();
  const password = elements.registerPassword.value;
  if (!username) {
    elements.authError.textContent = "Username is required.";
    return;
  }
  if (!password || password.length < 6) {
    elements.authError.textContent = "Password must be at least 6 characters.";
    return;
  }
  try {
    rememberSession = !!elements.rememberMe?.checked;
    const response = await api("POST", "/api/register", { username, password });
    authToken = response.token;
    currentUser = response.user.username;
    currentBalance = response.user.balance;
    persistAuth(authToken, currentUser, rememberSession);
    elements.registerUsername.value = "";
    elements.registerPassword.value = "";
    await refreshState();
    render();
  } catch (err) {
    elements.authError.textContent = err.message;
  }
}

async function loginUser() {
  resetErrors();
  const username = elements.loginUsername.value.trim();
  const password = elements.loginPassword.value;
  if (!username) {
    elements.authError.textContent = "Username is required.";
    return;
  }
  if (!password) {
    elements.authError.textContent = "Password is required.";
    return;
  }
  try {
    rememberSession = !!elements.rememberMe?.checked;
    const response = await api("POST", "/api/login", { username, password });
    authToken = response.token;
    currentUser = response.user.username;
    currentBalance = response.user.balance;
    persistAuth(authToken, currentUser, rememberSession);
    elements.loginPassword.value = "";
    await refreshState();
    render();
  } catch (err) {
    elements.authError.textContent = err.message;
  }
}

function logoutUser() {
  if (authToken) {
    api("POST", "/api/logout").catch(() => {});
  }
  authToken = null;
  currentUser = null;
  currentBalance = null;
  rememberSession = false;
  selectedMarketId = null;
  clearAuthStorage();
  render();
}

// ── Market actions ────────────────────────────────────────────────────────────
async function createMarket() {
  resetErrors();
  try {
    const name = elements.marketNameInput.value.trim();
    const outcomes = elements.outcomesInput.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const priors = parseNumberList(elements.priorsInput.value, "Priors");
    const b = parseFiniteNumber(elements.bInput.value);
    if (!Number.isFinite(b) || b <= 0) {
      throw new Error("Liquidity b must be greater than 0.");
    }

    const market = await api("POST", "/api/markets", { name, outcomes, priors, b });
    await refreshState();
    elements.marketNameInput.value = "";
    elements.outcomesInput.value = "";
    elements.priorsInput.value = "";
    elements.bInput.value = "";
    renderCreateCostInfo();
    selectedMarketId = market.id;
    openTab("market-tab");
    render();
  } catch (err) {
    elements.createError.textContent = err.message;
  }
}

function renderCreateCostInfo() {
  const createCostInfo = ensureCreateCostInfoElement();
  if (!createCostInfo) {
    return;
  }

  const priorsText = elements.priorsInput.value.trim();
  const bText = elements.bInput.value;
  const b = parseFiniteNumber(bText);
  if (!priorsText || !String(bText).trim()) {
    createCostInfo.textContent = "Cost preview appears after valid priors and liquidity b.";
    return;
  }

  let priors;
  try {
    priors = parseNumberList(priorsText, "Priors");
  } catch {
    createCostInfo.textContent = "Enter priors as numeric values, e.g. 0.5,0.5.";
    return;
  }

  if (priors.some((value) => value <= 0)) {
    createCostInfo.textContent = "Each prior must be greater than 0.";
    return;
  }
  const priorSum = priors.reduce((acc, value) => acc + value, 0);
  if (Math.abs(priorSum - 1) > PRIOR_SUM_TOLERANCE) {
    createCostInfo.textContent = "Priors must sum to 1 to calculate creation cost.";
    return;
  }
  if (!Number.isFinite(b) || b <= 0) {
    createCostInfo.textContent = "Liquidity b must be greater than 0.";
    return;
  }

  const cost = marketL(priors, b);
  const parts = [`C_0 = ${cost.toFixed(6)}`];
  if (Number.isFinite(currentBalance)) {
    const enough = currentBalance + EPS >= cost;
    const balanceText = enough
      ? `Balance after create: ${(currentBalance - cost).toFixed(6)}`
      : `Need ${(cost - currentBalance).toFixed(6)} more balance`;
    parts.push(balanceText);
  }
  createCostInfo.textContent = parts.join(" | ");
}

function ensureCreateCostInfoElement() {
  if (elements.createCostInfo) {
    return elements.createCostInfo;
  }
  const createTab = document.getElementById("create-tab");
  if (!createTab || !elements.createMarketBtn) {
    return null;
  }

  const info = document.createElement("p");
  info.id = "create-cost-info";
  info.className = "muted";
  info.textContent = "Cost preview appears after valid priors and liquidity b.";
  createTab.insertBefore(info, elements.createMarketBtn);
  elements.createCostInfo = info;
  return info;
}

async function takePosition() {
  resetErrors();
  const market = state.markets[selectedMarketId];
  if (!market || !market.open) {
    elements.tradeError.textContent = "Select an open market first.";
    return;
  }
  if (market.maker === currentUser) {
    elements.tradeError.textContent = "Market makers cannot trade their own market.";
    return;
  }
  let delta;
  try {
    delta = parseNumberList(elements.deltaqInput.value, "Δq");
  } catch (err) {
    elements.tradeError.textContent = err.message;
    return;
  }
  try {
    await api("POST", `/api/markets/${market.id}/trade`, { delta });
    await refreshState();
    render();
  } catch (err) {
    elements.tradeError.textContent = err.message;
  }
}

async function closeMarket() {
  resetErrors();
  const market = state.markets[selectedMarketId];
  if (!market || !market.open) {
    elements.tradeError.textContent = "Select an open market first.";
    return;
  }
  if (market.maker !== currentUser) {
    elements.tradeError.textContent = "Only the market maker can close this market.";
    return;
  }
  try {
    await api("POST", `/api/markets/${market.id}/close`);
    await refreshState();
    render();
  } catch (err) {
    elements.tradeError.textContent = err.message;
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function openTab(tabId) {
  elements.tabContents.forEach((section) => section.classList.add("hidden"));
  const tab = document.getElementById(tabId);
  if (tab) tab.classList.remove("hidden");
  if (tabId === "create-tab") {
    renderCreateCostInfo();
  }
}

function render() {
  renderAuth();
  renderDashboard();
  renderMarket();
  renderPortfolio();
}

function renderAuth() {
  if (elements.rememberMe) {
    elements.rememberMe.checked = rememberSession;
  }

  const loggedIn = !!currentUser;
  elements.authView.classList.toggle("hidden", loggedIn);
  elements.appView.classList.toggle("hidden", !loggedIn);

  if (!loggedIn) {
    elements.currentUser.textContent = "";
    return;
  }

  const balance = Number.isFinite(currentBalance) ? currentBalance.toFixed(6) : "...";
  elements.currentUser.textContent = `User: ${currentUser} | Balance: ${balance}`;
  elements.userBalance.textContent = balance;
  const visibleTab = document.querySelector(".tab-content:not(.hidden)");
  const marketTabStale =
    visibleTab?.id === "market-tab" && (!selectedMarketId || !state.markets[selectedMarketId]);
  if (!visibleTab || marketTabStale) {
    openTab("dashboard-tab");
  }
}

function renderDashboard() {
  const activeMarkets = Object.values(state.markets).filter((market) => market.open && marketMatchesSearch(market));
  const closedMarkets = Object.values(state.markets)
    .filter((market) => !market.open && marketMatchesSearch(market))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const sortedActiveMarkets = sortActiveMarkets(activeMarkets, activeMarketSort);

  elements.marketList.replaceChildren();
  if (!sortedActiveMarkets.length) {
    const item = document.createElement("li");
    item.textContent = "No active markets.";
    elements.marketList.appendChild(item);
  } else {
    sortedActiveMarkets.forEach((m) => {
      const item = buildDashboardMarketEntry(m);
      elements.marketList.appendChild(item);
    });
  }

  elements.closedMarketList.replaceChildren();
  if (!closedMarkets.length) {
    const item = document.createElement("li");
    item.textContent = "No closed markets.";
    elements.closedMarketList.appendChild(item);
  } else {
    closedMarkets.forEach((m) => {
      const item = buildDashboardMarketEntry(m);
      elements.closedMarketList.appendChild(item);
    });
  }

  renderHistory();
  renderSessions();
}

function marketMatchesSearch(market) {
  if (!marketSearchQuery) {
    return true;
  }
  const haystack = [
    String(market.id),
    String(market.name || ""),
    String(market.maker || ""),
    ...(Array.isArray(market.outcomes) ? market.outcomes : []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(marketSearchQuery);
}

function sortActiveMarkets(markets, sortMode) {
  const rows = markets.map((market) => {
    const probs = impliedProbabilities(market.p, market.b, market.q);
    const maxProb = Math.max(...probs);
    const qSum = market.q.reduce((sum, value) => sum + value, 0);
    const cost = marketCost(market.p, market.b, market.q);
    return { market, maxProb, qSum, cost };
  });

  if (sortMode === "qsum") {
    rows.sort((a, b) => b.qSum - a.qSum || Number(b.market.id) - Number(a.market.id));
  } else if (sortMode === "highest-c") {
    rows.sort((a, b) => b.cost - a.cost || b.qSum - a.qSum || Number(b.market.id) - Number(a.market.id));
  } else if (sortMode === "newest") {
    rows.sort((a, b) => Number(b.market.id) - Number(a.market.id));
  } else if (sortMode === "id") {
    rows.sort((a, b) => Number(a.market.id) - Number(b.market.id));
  } else {
    rows.sort((a, b) => a.maxProb - b.maxProb || b.qSum - a.qSum || Number(b.market.id) - Number(a.market.id));
  }

  return rows.map((row) => row.market);
}

function buildDashboardMarketEntry(market) {
  const item = document.createElement("li");
  item.className = "dashboard-market-item";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `dashboard-market-btn ${market.open ? "dashboard-market-btn-open" : "dashboard-market-btn-closed"}`;
  if (String(selectedMarketId) === String(market.id)) {
    btn.classList.add("dashboard-market-btn-selected");
  }
  btn.addEventListener("click", () => openMarket(String(market.id)));

  const header = document.createElement("div");
  header.className = "dashboard-market-header";

  const name = document.createElement("span");
  name.className = "dashboard-market-name";
  name.textContent = `#${market.id} ${market.name}`;

  const status = document.createElement("span");
  status.className = `dashboard-market-status ${market.open ? "dashboard-market-status-open" : "dashboard-market-status-closed"}`;
  status.textContent = market.open ? "Open" : "Closed";

  header.append(name, status);

  const probs = impliedProbabilities(market.p, market.b, market.q);
  const leaderIndex = probs.reduce((best, value, index, arr) => (value > arr[best] ? index : best), 0);
  const leader = document.createElement("div");
  leader.className = "dashboard-market-leader";
  leader.textContent = `Leader: ${market.outcomes[leaderIndex]} (${(probs[leaderIndex] * 100).toFixed(2)}%)`;

  const detail = document.createElement("div");
  detail.className = "dashboard-market-detail";
  const totalQ = market.q.reduce((sum, value) => sum + value, 0);
  const cost = marketCost(market.p, market.b, market.q);
  detail.textContent = `Maker: ${market.maker} | Liquidity b: ${Number(market.b).toFixed(3)} | C = ${cost.toFixed(6)} | Volume q-sum: ${totalQ.toFixed(3)}`;

  const prices = document.createElement("div");
  prices.className = "dashboard-market-prices";
  prices.textContent = market.outcomes.map((outcome, index) => `${outcome} ${(probs[index] * 100).toFixed(1)}%`).join(" | ");

  const userMeta = document.createElement("div");
  userMeta.className = "dashboard-market-user-meta";
  const position = state.portfolios[market.id] || market.outcomes.map(() => 0);
  const hasPosition = position.some((value) => Math.abs(value) > EPS);
  if (market.maker === currentUser) {
    userMeta.textContent = "You are the maker";
    userMeta.classList.add("dashboard-market-user-maker");
  } else if (hasPosition) {
    userMeta.textContent = "In your portfolio";
    userMeta.classList.add("dashboard-market-user-position");
  } else {
    userMeta.textContent = market.open ? "No current position" : "";
  }

  btn.append(header, leader, detail, prices, userMeta);
  item.appendChild(btn);
  return item;
}

function renderHistory() {
  elements.historyList.replaceChildren();
  if (!currentUser) {
    return;
  }
  if (!state.history.length) {
    const item = document.createElement("li");
    item.textContent = "No history yet.";
    elements.historyList.appendChild(item);
    return;
  }

  state.history.forEach((entry) => {
    const item = document.createElement("li");
    item.className = "history-item";
    const targetMarket = entry.market_id ? state.markets[entry.market_id] : null;
    if (targetMarket) {
      item.classList.add("history-item-clickable");
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("aria-label", `Open ${entry.market_name}`);
      item.addEventListener("click", () => openMarket(entry.market_id));
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openMarket(entry.market_id);
        }
      });
    }

    const header = document.createElement("div");
    header.className = "history-header";

    const badge = document.createElement("span");
    badge.className = `history-badge history-badge-${entry.action}`;
    badge.textContent = formatHistoryAction(entry.action);

    const marketName = document.createElement("span");
    marketName.className = "history-market-name";
    marketName.textContent = entry.market_name;

    const timestamp = document.createElement("span");
    timestamp.className = "history-timestamp";
    timestamp.textContent = formatIsoDate(entry.created_at);

    header.append(badge, marketName, timestamp);

    const detail = document.createElement("div");
    detail.className = "history-detail";
    let detailText = entry.detail;
    const sourceMarket = entry.market_id ? state.markets[entry.market_id] : null;
    if (entry.action === "create") {
      if (sourceMarket) {
        if (!/priors\s+/i.test(String(detailText))) {
          detailText = `${detailText} Priors ${sourceMarket.p.join(",")}.`;
        }
        if (!/C_0\s*=/.test(String(detailText))) {
          const c0 = marketL(sourceMarket.p, sourceMarket.b);
          detailText = `${detailText} C_0 = ${c0.toFixed(6)}.`;
        }
      }
    } else if (entry.action === "settlement") {
      if (sourceMarket && !/posteriors\s+/i.test(String(detailText))) {
        const posteriors = impliedProbabilities(sourceMarket.p, sourceMarket.b, sourceMarket.q)
          .map((value) => value.toFixed(6))
          .join(",");
        detailText = `${detailText} Posteriors ${posteriors}.`;
      }
    }
    if (sourceMarket) {
      detailText = withOutcomePercentSeries(detailText, "Prices", sourceMarket.outcomes);
      detailText = withOutcomePercentSeries(detailText, "Posteriors", sourceMarket.outcomes);
      detailText = withOutcomePercentSeries(detailText, "Priors", sourceMarket.outcomes);
    }
    appendHistoryDetail(detail, detailText);

    item.append(header, detail);
    elements.historyList.appendChild(item);
  });
}

function withOutcomePercentSeries(detailText, label, outcomes) {
  const text = String(detailText);
  const match = text.match(new RegExp(`(${label}\\s+)(.+?)(?=\\.\\s|\\.$)`, "i"));
  if (!match) {
    return text;
  }

  const [fullMatch, prefix, rawSeries] = match;
  let values;
  if (rawSeries.includes(":")) {
    const labeledParts = rawSeries.split(",").map((part) => part.trim());
    if (labeledParts.length !== outcomes.length) {
      return text;
    }
    values = [];
    for (const part of labeledParts) {
      const labeledMatch = part.match(/^([^:]+):\s*([+-]?\d+(?:\.\d+)?)%?$/);
      if (!labeledMatch) {
        return text;
      }
      let value = Number(labeledMatch[2]);
      if (!Number.isFinite(value)) {
        return text;
      }
      if (value > 1 + EPS) {
        value /= 100;
      }
      values.push(value);
    }
  } else {
    values = rawSeries
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value));
    if (values.length !== outcomes.length) {
      return text;
    }
    if (values.some((value) => value > 1 + EPS)) {
      values = values.map((value) => value / 100);
    }
  }

  const labeled = outcomes.map((outcome, index) => `${outcome}: ${(values[index] * 100).toFixed(2)}%`).join(", ");
  return text.replace(fullMatch, `${prefix}${labeled}`);
}

function formatHistoryAction(action) {
  switch (action) {
    case "create":
      return "Created";
    case "trade":
      return "Trade";
    case "close":
      return "Closed";
    case "settlement":
      return "Settled";
    default:
      return action;
  }
}

function appendHistoryDetail(container, detail) {
  const parts = String(detail).split(/([+-]?\d+(?:\.\d+)?)/g);
  parts.forEach((part) => {
    if (!part) {
      return;
    }
    if (/^[+-]?\d+(?:\.\d+)?$/.test(part)) {
      const amount = document.createElement("span");
      amount.className = "history-amount";
      amount.textContent = part;
      container.appendChild(amount);
      return;
    }
    container.appendChild(document.createTextNode(part));
  });
}

function openMarket(marketId) {
  if (!state.markets[marketId]) {
    return;
  }
  selectedMarketId = marketId;
  openTab("market-tab");
  render();
}

function renderMarket() {
  const market = state.markets[selectedMarketId];
  if (!market) {
    elements.marketTitle.textContent = "Market Detail";
    elements.marketMaker.textContent = "Select a market from dashboard.";
    elements.marketB.textContent = "";
    elements.marketChart.replaceChildren();
    elements.priceList.innerHTML = "";
    elements.tradeSection.classList.remove("hidden");
    elements.tradePreview.textContent = "";
    elements.closeMarketBtn.classList.add("hidden");
    return;
  }

  const probs = impliedProbabilities(market.p, market.b, market.q);
  const status = market.open ? "Open" : "Closed";
  const cost = marketCost(market.p, market.b, market.q);

  elements.marketTitle.textContent = `${market.name} (#${market.id}) — ${status}`;
  elements.marketMaker.textContent = `Maker: ${market.maker}`;
  elements.marketB.textContent = `Liquidity b: ${market.b} | C = ${cost.toFixed(6)}`;
  renderMarketChart(market, probs);
  elements.priceList.replaceChildren();
  market.outcomes.forEach((outcome, i) => {
    const row = document.createElement("div");
    row.textContent = `${outcome}: π = ${probs[i].toFixed(6)} | q = ${market.q[i].toFixed(6)}`;
    elements.priceList.appendChild(row);
  });

  if (market.open) {
    renderTradePreview();
  } else {
    elements.tradePreview.textContent = "Trading disabled on closed markets.";
  }

  const isMaker = currentUser === market.maker;
  const canClose = market.open && isMaker;
  elements.tradeSection.classList.toggle("hidden", isMaker || !market.open);
  elements.closeMarketBtn.classList.toggle("hidden", !canClose);
  elements.tradeBtn.disabled = !market.open || isMaker;
}

async function renderMarketChart(market, probabilities) {
  elements.marketChart.replaceChildren();
  if (!market.outcomes.length) {
    return;
  }

  const loading = document.createElement("div");
  loading.className = "market-line-meta";
  loading.textContent = "Loading price history...";
  elements.marketChart.appendChild(loading);

  let history = [];
  try {
    history = await api("GET", `/api/markets/${market.id}/price-history`);
  } catch {
    history = [];
  }

  if (selectedMarketId !== market.id) {
    return;
  }

  const snapshots = Array.isArray(history)
    ? history
        .filter((entry) => Array.isArray(entry.probs) && entry.probs.length === market.outcomes.length)
        .map((entry) => ({
          probs: entry.probs.map((p) => Math.max(0, Math.min(1, Number(p) || 0))),
          created_at: entry.created_at,
          event: entry.event || "update",
        }))
    : [];
  if (!snapshots.length) {
    snapshots.push({ probs: probabilities, created_at: new Date().toISOString(), event: "current" });
  }

  elements.marketChart.replaceChildren();

  const svgNs = "http://www.w3.org/2000/svg";
  const width = 760;
  const height = 260;
  const paddingX = 46;
  const paddingY = 20;
  const plotWidth = width - paddingX * 2;
  const plotHeight = height - paddingY * 2;
  const stepX = snapshots.length > 1 ? plotWidth / (snapshots.length - 1) : 0;
  const colors = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];

  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "market-line-chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Price history chart");

  [0, 0.25, 0.5, 0.75, 1].forEach((p) => {
    const y = paddingY + (1 - p) * plotHeight;
    const line = document.createElementNS(svgNs, "line");
    line.setAttribute("x1", String(paddingX));
    line.setAttribute("x2", String(width - paddingX));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("class", "market-line-grid");
    svg.appendChild(line);

    const label = document.createElementNS(svgNs, "text");
    label.setAttribute("x", String(paddingX - 8));
    label.setAttribute("y", String(y + 4));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "market-line-axis-label");
    label.textContent = `${Math.round(p * 100)}%`;
    svg.appendChild(label);
  });

  market.outcomes.forEach((_, outcomeIndex) => {
    const points = snapshots.map((snapshot, index) => {
      const x = snapshots.length === 1 ? width / 2 : paddingX + index * stepX;
      const y = paddingY + (1 - snapshot.probs[outcomeIndex]) * plotHeight;
      return { x, y };
    });

    const polyline = document.createElementNS(svgNs, "polyline");
    polyline.setAttribute(
      "points",
      points.map((point) => `${point.x},${point.y}`).join(" ")
    );
    polyline.setAttribute("class", "market-line-path");
    polyline.setAttribute("style", `stroke: ${colors[outcomeIndex % colors.length]}`);
    svg.appendChild(polyline);
  });

  const focusLine = document.createElementNS(svgNs, "line");
  focusLine.setAttribute("class", "market-line-focus-line");
  focusLine.setAttribute("y1", String(paddingY));
  focusLine.setAttribute("y2", String(height - paddingY));
  svg.appendChild(focusLine);

  const focusDots = market.outcomes.map((_, outcomeIndex) => {
    const dot = document.createElementNS(svgNs, "circle");
    dot.setAttribute("r", "5");
    dot.setAttribute("class", "market-line-focus-point");
    dot.setAttribute("style", `fill: ${colors[outcomeIndex % colors.length]}; stroke: ${colors[outcomeIndex % colors.length]}`);
    svg.appendChild(dot);
    return dot;
  });

  const interactionLayer = document.createElementNS(svgNs, "rect");
  interactionLayer.setAttribute("x", String(paddingX));
  interactionLayer.setAttribute("y", String(paddingY));
  interactionLayer.setAttribute("width", String(plotWidth));
  interactionLayer.setAttribute("height", String(plotHeight));
  interactionLayer.setAttribute("class", "market-line-interaction");
  svg.appendChild(interactionLayer);

  const axisLabelMode = getHistoryAxisLabelMode(snapshots);
  const timeLabels = [0, Math.floor((snapshots.length - 1) / 2), snapshots.length - 1]
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .map((snapshotIndex) => ({
      x: snapshots.length === 1 ? width / 2 : paddingX + snapshotIndex * stepX,
      text: formatHistoryChartTime(snapshots[snapshotIndex].created_at, axisLabelMode),
    }));

  timeLabels.forEach((labelItem) => {
    const label = document.createElementNS(svgNs, "text");
    label.setAttribute("x", String(labelItem.x));
    label.setAttribute("y", String(height - 6));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "market-line-axis-label");
    label.textContent = labelItem.text;
    svg.appendChild(label);
  });

  elements.marketChart.appendChild(svg);

  const meta = document.createElement("div");
  meta.className = "market-line-meta";
  meta.textContent = `Price history points: ${snapshots.length}`;
  elements.marketChart.appendChild(meta);

  const hoverInfo = document.createElement("div");
  hoverInfo.className = "market-line-hover-info";
  elements.marketChart.appendChild(hoverInfo);

  const legend = document.createElement("div");
  legend.className = "market-line-legend";
  const legendRows = [];
  market.outcomes.forEach((outcome, index) => {
    const item = document.createElement("div");
    item.className = "market-line-legend-item";

    const left = document.createElement("div");
    left.className = "market-line-legend-left";

    const swatch = document.createElement("span");
    swatch.className = "market-line-legend-swatch";
    swatch.style.background = colors[index % colors.length];

    const name = document.createElement("span");
    name.className = "market-line-legend-name";
    name.textContent = outcome;
    left.append(swatch, name);

    const pct = document.createElement("span");
    pct.className = "market-line-legend-pct";
    pct.textContent = "--";

    item.append(left, pct);
    legend.appendChild(item);
    legendRows.push({ item, pct });
  });
  elements.marketChart.appendChild(legend);

  function snapshotX(index) {
    return snapshots.length === 1 ? width / 2 : paddingX + index * stepX;
  }

  function updateSelection(index) {
    const safeIndex = Math.max(0, Math.min(snapshots.length - 1, index));
    const snapshot = snapshots[safeIndex];
    const selectedProbs = snapshot.probs;
    const leaderProbability = Math.max(...selectedProbs);
    const x = snapshotX(safeIndex);

    focusLine.setAttribute("x1", String(x));
    focusLine.setAttribute("x2", String(x));

    selectedProbs.forEach((prob, outcomeIndex) => {
      const y = paddingY + (1 - prob) * plotHeight;
      focusDots[outcomeIndex].setAttribute("cx", String(x));
      focusDots[outcomeIndex].setAttribute("cy", String(y));
      const isLeader = Math.abs(prob - leaderProbability) <= EPS;
      focusDots[outcomeIndex].setAttribute("r", isLeader ? "6" : "5");
    });

    legendRows.forEach(({ item, pct }, outcomeIndex) => {
      const prob = selectedProbs[outcomeIndex];
      pct.textContent = `${(prob * 100).toFixed(2)}%`;
      item.classList.toggle("market-line-legend-item-leader", Math.abs(prob - leaderProbability) <= EPS);
    });

    hoverInfo.textContent = `Selected: ${formatHistoryChartDateTime(snapshot.created_at)} | Event: ${snapshot.event} | Point ${safeIndex + 1} of ${snapshots.length}`;
  }

  function eventToIndex(event) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) {
      return snapshots.length - 1;
    }
    const normalizedX = ((event.clientX - rect.left) / rect.width) * width;
    if (snapshots.length === 1) {
      return 0;
    }
    const raw = (normalizedX - paddingX) / stepX;
    return Math.max(0, Math.min(snapshots.length - 1, Math.round(raw)));
  }

  interactionLayer.addEventListener("mousemove", (event) => {
    updateSelection(eventToIndex(event));
  });
  interactionLayer.addEventListener("touchmove", (event) => {
    if (!event.touches.length) {
      return;
    }
    event.preventDefault();
    updateSelection(eventToIndex(event.touches[0]));
  });
  interactionLayer.addEventListener("touchstart", (event) => {
    if (!event.touches.length) {
      return;
    }
    updateSelection(eventToIndex(event.touches[0]));
  });
  interactionLayer.addEventListener("mouseleave", () => {
    updateSelection(snapshots.length - 1);
  });

  updateSelection(snapshots.length - 1);
}

function getHistoryAxisLabelMode(snapshots) {
  const validDates = snapshots
    .map((snapshot) => {
      const ts = Date.parse(snapshot.created_at || "");
      return Number.isFinite(ts) ? new Date(ts) : null;
    })
    .filter(Boolean);

  if (!validDates.length) {
    return "time";
  }

  const dayKeys = new Set(validDates.map((d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`));
  if (dayKeys.size <= 1) {
    return "time";
  }

  const years = new Set(validDates.map((d) => d.getFullYear()));
  return years.size > 1 ? "date-time-year" : "date-time";
}

function formatHistoryChartTime(isoString, mode = "time") {
  const ts = Date.parse(isoString || "");
  if (!Number.isFinite(ts)) {
    return "now";
  }
  if (mode === "date-time-year") {
    return new Date(ts).toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (mode === "date-time") {
    return new Date(ts).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatHistoryChartDateTime(isoString) {
  const ts = Date.parse(isoString || "");
  if (!Number.isFinite(ts)) {
    return "now";
  }
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderTradePreview() {
  const market = state.markets[selectedMarketId];
  if (!market || !market.open) {
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
  const deltaC = marketCost(market.p, market.b, nextQ) - marketCost(market.p, market.b, market.q);
  const parts = [`ΔC = ${deltaC.toFixed(6)}`];

  const currentPosition = state.portfolios[market.id] || market.outcomes.map(() => 0);
  const nextPosition = vectorAdd(currentPosition, delta);
  const invalidPosition = nextPosition.some((value) => value < -EPS);
  if (!invalidPosition) {
    const positionSummary = market.outcomes
      .map((outcome, index) => `${outcome}: ${nextPosition[index].toFixed(6)}`)
      .join(", ");
    parts.push(`Position after trade: ${positionSummary}`);
  } else {
    const needed = market.outcomes
      .map((outcome, index) => ({ outcome, missing: Math.max(0, -nextPosition[index]) }))
      .filter((entry) => entry.missing > EPS)
      .map((entry) => `${entry.outcome}: +${entry.missing.toFixed(6)}`)
      .join(", ");
    parts.push(`Need more position: ${needed}`);
  }

  if (Number.isFinite(currentBalance)) {
    if (deltaC <= currentBalance + EPS) {
      parts.push(`Balance after trade: ${(currentBalance - deltaC).toFixed(6)}`);
    } else {
      parts.push(`Need ${(deltaC - currentBalance).toFixed(6)} more balance`);
    }
  }
  elements.tradePreview.textContent = parts.join(" | ");
}

async function renderSessions() {
  if (!currentUser) {
    elements.sessionList.replaceChildren();
    elements.logoutAllBtn.disabled = true;
    return;
  }

  elements.logoutAllBtn.disabled = false;
  let sessions = [];
  try {
    sessions = await api("GET", "/api/sessions");
  } catch (err) {
    elements.dashboardError.textContent = err.message;
    elements.sessionList.replaceChildren();
    return;
  }

  elements.sessionList.replaceChildren();
  if (!sessions.length) {
    const item = document.createElement("li");
    item.textContent = "No active sessions.";
    elements.sessionList.appendChild(item);
    return;
  }

  sessions.forEach((session) => {
    const item = document.createElement("li");
    const currentLabel = session.current ? " (current)" : "";
    item.textContent = `Created ${formatIsoDate(session.created_at)} | Expires ${formatIsoDate(session.expires_at)}${currentLabel}`;
    elements.sessionList.appendChild(item);
  });
}

function portfolioLiquidationPnl(market, qTaker) {
  const qAfter = market.q.map((qi, i) => qi - qTaker[i]);
  return marketCost(market.p, market.b, market.q) - marketCost(market.p, market.b, qAfter);
}

function portfolioUnrealizedPnl(market, qTaker) {
  const probs = impliedProbabilities(market.p, market.b, market.q);
  return probs.reduce((sum, pi, i) => sum + pi * qTaker[i], 0);
}

function makerClosePayout(market) {
  const probs = impliedProbabilities(market.p, market.b, market.q);
  const dotPiQ = probs.reduce((sum, pi, i) => sum + pi * market.q[i], 0);
  return marketCost(market.p, market.b, market.q) - dotPiQ;
}

// Taker gross liquidation: selling all shares now via LMSR reverse
function takerGrossLiq(market, qTaker) {
  const qAfter = market.q.map((qi, i) => qi - qTaker[i]);
  return marketCost(market.p, market.b, market.q) - marketCost(market.p, market.b, qAfter);
}

// Taker gross unrealized: position valued at current prices
function takerGrossUnreal(market, qTaker) {
  const probs = impliedProbabilities(market.p, market.b, market.q);
  return probs.reduce((sum, pi, i) => sum + pi * qTaker[i], 0);
}

// Maker close L (same for liq and unrealized since maker can only close): C(q) - pi.q - C_0
function makerCloseL(market) {
  const probs = impliedProbabilities(market.p, market.b, market.q);
  const dotPiQ = probs.reduce((sum, pi, i) => sum + pi * market.q[i], 0);
  const c0 = marketL(market.p, market.b);
  return marketCost(market.p, market.b, market.q) - dotPiQ - c0;
}

function renderPortfolio() {
  if (!currentUser) {
    elements.portfolioList.replaceChildren();
    return;
  }
  const positionedEntries = Object.entries(state.portfolios)
    .filter(([marketId]) => {
      const market = state.markets[String(marketId)];
      return market && market.open;
    })
    .filter(([, vec]) => vec.some((v) => Math.abs(v) > EPS))
    .map(([marketId, vec]) => [String(marketId), vec]);

  const entryMap = new Map(positionedEntries);
  Object.values(state.markets).forEach((market) => {
    const marketId = String(market.id);
    if (!market.open || market.maker !== currentUser || entryMap.has(marketId)) return;
    entryMap.set(marketId, market.outcomes.map(() => 0));
  });

  const entries = [...entryMap.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  if (!entries.length) {
    const item = document.createElement("li");
    item.textContent = "No positions or maker markets yet.";
    elements.portfolioList.replaceChildren(item);
    return;
  }

  let sumTakerLiq = 0;
  let sumTakerUnreal = 0;
  let sumMakerCloseL = 0;
  let sumTakerGrossLiq = 0;
  let sumTakerGrossUnreal = 0;
  let sumMakerGross = 0;
  let hasTaker = false;
  let hasMaker = false;

  elements.portfolioList.replaceChildren();
  entries.forEach(([marketId, vec]) => {
    const market = state.markets[marketId];
    if (!market || !market.open) return;
    const item = document.createElement("li");
    item.className = "portfolio-entry";

    const marketBtn = document.createElement("button");
    marketBtn.type = "button";
    marketBtn.className = "portfolio-market-link";
    marketBtn.textContent = `#${marketId} ${market.name}`;
    marketBtn.addEventListener("click", () => openMarket(marketId));

    const isMaker = market.maker === currentUser;
    const probs = impliedProbabilities(market.p, market.b, market.q);
    const prices = probs.map((prob, i) => `${market.outcomes[i]}: ${(prob * 100).toFixed(2)}%`).join(", ");

    if (isMaker) {
      hasMaker = true;
      const closeL = makerCloseL(market);
      const createdCost = marketL(market.p, market.b);
      const makerGross = marketCost(market.p, market.b, market.q) - probs.reduce((s, pi, i) => s + pi * market.q[i], 0);
      sumMakerCloseL += closeL;
      sumMakerGross += makerGross;
      const qState = market.outcomes.map((o, i) => `${o}: ${market.q[i].toFixed(6)}`).join(", ");
      const line1 = document.createElement("div");
      line1.append(marketBtn, document.createTextNode(` (maker, q-state): ${qState}`));
      const line2 = document.createElement("div");
      line2.className = "portfolio-pnl";
      line2.textContent = `Prices: ${prices} | Created cost C_0: ${createdCost.toFixed(6)} | Close L: ${closeL.toFixed(6)}`;
      item.append(line1, line2);
    } else {
      hasTaker = true;
      const tradeCosts = state.tradeCosts ? (state.tradeCosts[String(marketId)] || 0) : 0;
      const grossLiq = takerGrossLiq(market, vec);
      const grossUnreal = takerGrossUnreal(market, vec);
      const liqPnl = grossLiq - tradeCosts;
      const unrealPnl = grossUnreal - tradeCosts;
      sumTakerLiq += liqPnl;
      sumTakerUnreal += unrealPnl;
      sumTakerGrossLiq += grossLiq;
      sumTakerGrossUnreal += grossUnreal;
      const holdings = market.outcomes.map((o, i) => `${o}: ${vec[i].toFixed(6)}`).join(", ");
      const line1 = document.createElement("div");
      line1.append(marketBtn, document.createTextNode(`: ${holdings}`));
      const line2 = document.createElement("div");
      line2.className = "portfolio-pnl";
      line2.textContent = `Prices: ${prices} | Trade costs: ${tradeCosts.toFixed(6)} | Liq. PnL: ${liqPnl.toFixed(6)} | Unrealized PnL: ${unrealPnl.toFixed(6)}`;
      item.append(line1, line2);
    }

    elements.portfolioList.appendChild(item);
  });

  // Totals summary
  const summary = document.createElement("li");
  summary.className = "portfolio-summary";
  const lines = [];
  if (hasTaker) {
    lines.push(`Taker — Liq. PnL: ${sumTakerLiq.toFixed(6)} | Unrealized PnL: ${sumTakerUnreal.toFixed(6)}`);
  }
  if (hasMaker) {
    lines.push(`Maker — Close L: ${sumMakerCloseL.toFixed(6)}`);
  }
  if (Number.isFinite(currentBalance)) {
    const overallLiqPnl = sumTakerLiq + sumMakerCloseL;
    const overallUnrealPnl = sumTakerUnreal + sumMakerCloseL;
    const liqTotal = sumTakerGrossLiq + sumMakerGross;
    const unrealTotal = sumTakerGrossUnreal + sumMakerGross;
    lines.push(`Overall Liq. PnL: ${overallLiqPnl.toFixed(6)} | Unrealized PnL: ${overallUnrealPnl.toFixed(6)}`);
    lines.push(`Liq. total: ${liqTotal.toFixed(6)} | Unreal. total: ${unrealTotal.toFixed(6)}`);
    lines.push(`Liq. balance: ${(currentBalance + liqTotal).toFixed(6)} | Unrealized balance: ${(currentBalance + unrealTotal).toFixed(6)}`);
  }
  if (lines.length) {
    const hr = document.createElement("hr");
    hr.className = "portfolio-summary-hr";
    summary.appendChild(hr);
    lines.forEach((text) => {
      const div = document.createElement("div");
      div.className = "portfolio-summary-line";
      div.textContent = text;
      summary.appendChild(div);
    });
    elements.portfolioList.appendChild(summary);
  }
}
