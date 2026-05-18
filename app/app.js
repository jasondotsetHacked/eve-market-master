let watchlist = [];
let selectedTypeId = null;

document.querySelector("#refresh-watchlist")?.addEventListener("click", loadWatchlist);

await loadSession();
await loadWatchlist();

async function loadSession() {
  const status = document.querySelector("#session-status");
  const login = document.querySelector("#login-link");
  const logout = document.querySelector("#logout-link");
  const params = new URLSearchParams(window.location.search);
  const authError = params.get("auth_error");

  try {
    const response = await fetch("/api/session");
    const session = await response.json();
    if (session.authenticated) {
      if (status) status.textContent = `Logged in as ${session.character.name || session.character.id}`;
      login?.classList.add("hidden");
      logout?.classList.remove("hidden");
    } else {
      if (status) status.textContent = authError ? `SSO failed: ${authError}` : "Log in with EVE SSO to load your market activity.";
      login?.classList.remove("hidden");
      logout?.classList.add("hidden");
    }
  } catch {
    if (status) status.textContent = "Unable to check SSO session.";
  }
}

async function loadWatchlist() {
  const tbody = document.querySelector("#watchlist-body");
  const meta = document.querySelector("#watchlist-meta");
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="8" class="status-cell">Loading ESI market activity...</td></tr>`;
  }

  try {
    const response = await fetch("/api/watchlist?days=365&hub=jita&marketLimit=40");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Failed to load watchlist");
    watchlist = payload.rows;
    selectedTypeId = watchlist[0]?.typeID || null;
    if (meta) {
      meta.textContent = `${payload.character.name || payload.character.id} - ${payload.window.itemCount} traded items from ${payload.window.fetchedTransactions} transactions`;
    }
    renderWatchlist();
    renderChart();
  } catch (error) {
    if (meta) meta.textContent = "Unable to load authenticated market activity";
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8" class="status-cell">${escapeHtml(error.message)}</td></tr>`;
    }
    renderChart();
  }
}

function renderWatchlist() {
  const tbody = document.querySelector("#watchlist-body");
  if (!tbody) return;

  if (watchlist.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="status-cell">No buy or sell transactions found in the selected window.</td></tr>`;
    return;
  }

  tbody.replaceChildren(...watchlist.map((row) => {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.className = row.typeID === selectedTypeId ? "selected" : "";
    tr.innerHTML = `
      <td><strong>${escapeHtml(row.name)}</strong><span>${row.transactionCount} tx - ${formatDate(row.lastTransactionDate)}</span></td>
      <td>${formatIsk(row.buys.weightedAverageUnitPrice)}</td>
      <td>${formatIsk(row.sells.weightedAverageUnitPrice)}</td>
      <td>${formatNumber(row.buys.quantity)}</td>
      <td>${formatNumber(row.sells.quantity)}</td>
      <td class="${row.position.estimatedQuantity < 0 ? "negative" : ""}">${formatNumber(row.position.estimatedQuantity)}</td>
      <td>${formatIsk(row.market?.bestSell?.price)}</td>
      <td>${formatIsk(row.market?.bestBuy?.price)}</td>
    `;
    tr.addEventListener("click", () => selectRow(row.typeID));
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectRow(row.typeID);
      }
    });
    return tr;
  }));
}

function selectRow(typeId) {
  selectedTypeId = typeId;
  renderWatchlist();
  renderChart();
}

function renderChart() {
  const container = document.querySelector("#market-chart");
  if (!container || !window.d3) return;

  const row = watchlist.find((entry) => entry.typeID === selectedTypeId);
  const title = document.querySelector("#chart-title");
  const subtitle = document.querySelector("#chart-subtitle");
  if (title) title.textContent = row?.name || "Market Price";
  if (subtitle) subtitle.textContent = row ? "Weighted average buy/sell vs current Jita station prices" : "No item selected";

  container.replaceChildren();
  if (!row) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Authenticate with EVE SSO and refresh the watchlist.";
    container.append(empty);
    return;
  }

  const data = [
    { label: "Avg Buy", value: row.buys.weightedAverageUnitPrice, color: "#53c7b7" },
    { label: "Avg Sell", value: row.sells.weightedAverageUnitPrice, color: "#7f9cf5" },
    { label: "Jita Sell", value: row.market?.bestSell?.price, color: "#d8a542" },
    { label: "Jita Buy", value: row.market?.bestBuy?.price, color: "#e06f62" }
  ].filter((entry) => Number.isFinite(entry.value));

  if (data.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No price data available for the selected item.";
    container.append(empty);
    return;
  }

  const width = Math.max(container.clientWidth, 320);
  const height = Math.max(container.clientHeight, 320);
  const margin = { top: 24, right: 24, bottom: 56, left: 78 };

  const svg = d3.select(container)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("role", "img")
    .attr("aria-label", "Placeholder market price comparison chart");

  const x = d3.scaleBand()
    .domain(data.map((d) => d.label))
    .range([margin.left, width - margin.right])
    .padding(0.28);

  const y = d3.scaleLinear()
    .domain([0, d3.max(data, (d) => d.value) * 1.2])
    .nice()
    .range([height - margin.bottom, margin.top]);

  svg.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x))
    .call((g) => g.select(".domain").attr("stroke", "#303a45"))
    .call((g) => g.selectAll("line").remove())
    .call((g) => g.selectAll("text").attr("fill", "#9aa7b4"));

  svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat((value) => compactIsk(value)))
    .call((g) => g.select(".domain").attr("stroke", "#303a45"))
    .call((g) => g.selectAll("line").attr("stroke", "#303a45"))
    .call((g) => g.selectAll("text").attr("fill", "#9aa7b4"));

  svg.selectAll("rect")
    .data(data)
    .join("rect")
    .attr("x", (d) => x(d.label))
    .attr("y", (d) => y(d.value))
    .attr("width", x.bandwidth())
    .attr("height", (d) => y(0) - y(d.value))
    .attr("rx", 4)
    .attr("fill", (d) => d.color);

  svg.selectAll(".bar-label")
    .data(data)
    .join("text")
    .attr("class", "bar-label")
    .attr("x", (d) => x(d.label) + x.bandwidth() / 2)
    .attr("y", (d) => y(d.value) - 8)
    .attr("text-anchor", "middle")
    .attr("fill", "#edf2f7")
    .attr("font-size", 12)
    .text((d) => compactIsk(d.value));
}

window.addEventListener("resize", renderChart);

function formatIsk(value) {
  if (!Number.isFinite(value)) return "-";
  return `${formatNumber(value)} ISK`;
}

function compactIsk(value) {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}b`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return formatNumber(value);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}
