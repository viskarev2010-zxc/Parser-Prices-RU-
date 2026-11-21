const TOKEN_KEY = "price_tracker_token";

const money = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});
const dateTime = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" });
const relative = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });

const state = {
  token: localStorage.getItem(TOKEN_KEY),
  products: [],
  stats: null,
  selectedId: null,
  history: [],
  range: "all",
  filter: { search: "", onlyDeals: false, sort: "newest" },
};

let chart = null;
let dialogMode = "create";
let editingId = null;
let searchTimer = null;

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function relativeTime(value) {
  if (!value) return "—";
  const diff = (new Date(value).getTime() - Date.now()) / 1000;
  const steps = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, seconds] of steps) {
    if (Math.abs(diff) >= seconds) return relative.format(Math.round(diff / seconds), unit);
  }
  return "только что";
}

function toast(message, kind = "info") {
  const palette = {
    info: "border-stone-300 text-stone-800",
    success: "border-teal-300 text-teal-900",
    error: "border-red-300 text-red-800",
  };
  const node = el(
    "div",
    `card-enter pointer-events-auto rounded-lg border bg-white px-4 py-3 text-sm shadow-lg ${palette[kind] || palette.info}`,
    message,
  );
  $("toast").appendChild(node);
  setTimeout(() => node.remove(), 4000);
}

function handleUnauthorized() {
  state.token = null;
  localStorage.removeItem(TOKEN_KEY);
  syncAuth();
  renderProducts();
  toast("Сессия истекла — войдите снова", "error");
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    throw new Error("Сервер недоступен");
  }

  if (response.status === 401) {
    handleUnauthorized();
    throw new Error("Требуется авторизация");
  }

  if (!response.ok) {
    let detail = `Ошибка ${response.status}`;
    try {
      const data = await response.json();
      if (typeof data.detail === "string") detail = data.detail;
    } catch {
      /* ignore non-json errors */
    }
    throw new Error(detail);
  }

  if (response.status === 204) return null;
  return response.json();
}

function syncAuth() {
  const authed = Boolean(state.token);
  $("login-btn").hidden = authed;
  $("logout-btn").hidden = !authed;
  $("admin-badge").hidden = !authed;
  $("admin-bar").hidden = !authed;
}

function logout() {
  state.token = null;
  localStorage.removeItem(TOKEN_KEY);
  syncAuth();
  renderProducts();
  toast("Вы вышли из режима администратора");
}

function displayUrl(raw) {
  try {
    const url = new URL(raw);
    return url.host + url.pathname;
  } catch {
    return raw;
  }
}

function dealBadge() {
  return el(
    "span",
    "shrink-0 rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-800",
    "выгодно",
  );
}

function changeLabel(product) {
  if (product.change_percent === null || product.change_percent === 0) return null;
  const falling = product.change_percent < 0;
  const text = `${falling ? "↓" : "↑"} ${Math.abs(product.change_percent).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`;
  const node = el(
    "span",
    `text-xs font-medium tabular-nums ${falling ? "text-teal-700" : "text-red-600"}`,
    text,
  );
  node.title = "Изменение к предыдущему замеру";
  return node;
}

function progressBar(product) {
  const wrap = el("div", "mt-2.5 h-1 overflow-hidden rounded-full bg-stone-100");
  const fill = el("div", "h-full rounded-full bg-teal-600");
  let percent = 0;
  if (product.current_price && product.target_price !== null) {
    percent = product.current_price <= product.target_price
      ? 100
      : Math.max(4, Math.round((product.target_price / product.current_price) * 100));
  }
  fill.style.width = `${percent}%`;
  wrap.appendChild(fill);
  wrap.title = "Насколько цена близка к целевой";
  return wrap;
}

function productCard(product) {
  const card = el(
    "article",
    "product-card card-enter flex cursor-pointer flex-col rounded-lg border border-stone-200 bg-white p-4 text-left shadow-sm transition hover:border-stone-300 hover:shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600",
  );
  card.dataset.productId = String(product.id);
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `Показать историю цен: ${product.title}`);

  const top = el("div", "flex items-start justify-between gap-3");
  top.appendChild(el("h3", "text-sm font-medium leading-snug text-stone-900", product.title));

  const isDeal =
    product.current_price !== null &&
    product.target_price !== null &&
    product.current_price <= product.target_price;
  if (isDeal) top.appendChild(dealBadge());
  card.appendChild(top);

  card.appendChild(el("p", "mt-1 truncate text-xs text-stone-500", displayUrl(product.url)));

  const priceRow = el("div", "mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1");
  priceRow.appendChild(
    el(
      "span",
      "text-2xl font-semibold tabular-nums text-stone-900",
      product.current_price !== null ? money.format(product.current_price) : "—",
    ),
  );
  const change = changeLabel(product);
  if (change) priceRow.appendChild(change);
  card.appendChild(priceRow);

  card.appendChild(
    el(
      "p",
      "mt-1 text-xs text-stone-500",
      product.target_price !== null
        ? `Цель: ${money.format(product.target_price)}`
        : "Целевая цена не задана",
    ),
  );

  if (product.current_price !== null) card.appendChild(progressBar(product));

  if (product.notes) {
    card.appendChild(el("p", "mt-3 line-clamp-2 text-xs leading-relaxed text-stone-500", product.notes));
  }

  const footer = el("div", "mt-auto flex items-center justify-between gap-2 pt-4 text-xs");
  footer.appendChild(
    el(
      "span",
      "text-stone-400",
      `${product.checks_count} ${plural(product.checks_count, "замер", "замера", "замеров")}`,
    ),
  );

  if (/^https?:\/\//i.test(product.url)) {
    const link = el("a", "font-medium text-teal-700 transition hover:text-teal-900", "на сайт ↗");
    link.href = product.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer nofollow";
    footer.appendChild(link);
  }
  card.appendChild(footer);

  if (state.token) {
    const actions = el("div", "mt-3 flex items-center gap-3 border-t border-stone-100 pt-3 text-xs");
    const refresh = el("button", "font-medium text-teal-700 transition hover:text-teal-900", "Обновить");
    refresh.type = "button";
    refresh.addEventListener("click", () => refreshPrice(product.id));

    const edit = el("button", "text-stone-500 transition hover:text-stone-800", "Изменить");
    edit.type = "button";
    edit.addEventListener("click", () => openProductDialog(product));

    const remove = el("button", "ml-auto text-stone-500 transition hover:text-red-600", "Удалить");
    remove.type = "button";
    remove.addEventListener("click", () => removeProduct(product.id));

    actions.append(refresh, edit, remove);
    card.appendChild(actions);
  }

  const activate = () => selectProduct(product.id, true);
  card.addEventListener("click", (event) => {
    if (event.target.closest("button, a")) return;
    activate();
  });
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  });

  return card;
}

function emptyState() {
  const filtered = Boolean(state.filter.search) || state.filter.onlyDeals;
  const box = el(
    "div",
    "rounded-lg border border-dashed border-stone-300 bg-white px-6 py-12 text-center sm:col-span-2 lg:col-span-3",
  );
  box.appendChild(
    el("p", "text-sm font-medium text-stone-700", filtered ? "Ничего не найдено" : "Пока нет товаров"),
  );
  box.appendChild(
    el(
      "p",
      "mt-1 text-sm text-stone-500",
      filtered
        ? "Попробуйте изменить запрос или сбросить фильтр «Выгодные»."
        : state.token
          ? "Добавьте первый товар или заполните список демо-товарами."
          : "Войдите как администратор, чтобы добавить товар.",
    ),
  );
  return box;
}

function renderProducts() {
  const grid = $("products-grid");
  grid.replaceChildren();

  const total = state.stats ? state.stats.total_products : state.products.length;
  const count = state.products.length;
  $("products-count").textContent =
    count === total
      ? `${count} ${plural(count, "товар", "товара", "товаров")}`
      : `Найдено ${count} из ${total}`;

  if (!state.products.length) {
    grid.appendChild(emptyState());
    return;
  }

  for (const product of state.products) grid.appendChild(productCard(product));
  highlightSelected();
}

function highlightSelected() {
  document.querySelectorAll("[data-product-id]").forEach((node) => {
    const active = Number(node.dataset.productId) === state.selectedId;
    node.classList.toggle("border-teal-600", active);
    node.classList.toggle("ring-1", active);
    node.classList.toggle("ring-teal-600", active);
  });
}

async function selectProduct(id, scroll = false) {
  state.selectedId = id;
  highlightSelected();
  await loadHistory(id);
  if (scroll) {
    $("analytics").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function loadHistory(id) {
  const product = state.products.find((item) => item.id === id);
  if (!product) return;
  try {
    const history = await api(`/api/products/${id}/history`);
    history.sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
    state.history = history;
    drawChart(product, history);
  } catch (error) {
    toast(error.message, "error");
  }
}

function filterHistory(history) {
  if (state.range === "all") return history;
  const days = Number(state.range);
  const since = Date.now() - days * 86400000;
  const filtered = history.filter((item) => new Date(item.recorded_at).getTime() >= since);
  return filtered.length ? filtered : history.slice(-1);
}

function drawChart(product, fullHistory) {
  const history = filterHistory(fullHistory);
  const canvas = $("chart-canvas");
  const empty = $("chart-empty");
  const title = $("chart-title");

  title.textContent = product.title;

  const prices = history.map((item) => item.price);
  if (prices.length) {
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const from = dateTime.format(new Date(history[0].recorded_at));
    const to = dateTime.format(new Date(history[history.length - 1].recorded_at));
    $("chart-meta").textContent =
      `Замеров: ${history.length} · ${from} — ${to} · мин ${money.format(min)} · макс ${money.format(max)}`;
  } else {
    $("chart-meta").textContent = "";
  }

  if (!history.length) {
    if (chart) chart.destroy();
    chart = null;
    canvas.hidden = true;
    empty.hidden = false;
    empty.textContent = "История цен пока пуста";
    return;
  }

  canvas.hidden = false;
  empty.hidden = true;

  const labels = history.map((item) => dateTime.format(new Date(item.recorded_at)));
  const datasets = [
    {
      label: "Цена",
      data: prices,
      borderColor: "#0f766e",
      backgroundColor: "rgba(15, 118, 110, 0.08)",
      pointBackgroundColor: "#0f766e",
      pointBorderColor: "#ffffff",
      pointBorderWidth: 1.5,
      fill: true,
      tension: 0.3,
      borderWidth: 2,
      pointRadius: 3,
      pointHoverRadius: 5,
    },
  ];

  if (product.target_price !== null) {
    datasets.push({
      label: "Целевая цена",
      data: prices.map(() => product.target_price),
      borderColor: "#b45309",
      borderDash: [6, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
    });
  }

  if (chart) chart.destroy();
  chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400, easing: "easeOutQuart" },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#57534e", usePointStyle: true, boxWidth: 8 } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${money.format(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#78716c", maxRotation: 0, autoSkip: true },
          grid: { color: "rgba(120, 113, 108, 0.08)" },
        },
        y: {
          ticks: { color: "#78716c", callback: (value) => money.format(value) },
          grid: { color: "rgba(120, 113, 108, 0.08)" },
        },
      },
    },
  });
}

async function loadStats() {
  try {
    state.stats = await api("/api/stats");
    $("stat-total").textContent = state.stats.total_products;
    $("stat-deals").textContent = state.stats.deals_count;
    $("stat-checks").textContent = state.stats.history_entries;
    $("stat-last").textContent = relativeTime(state.stats.last_check_at);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadProducts() {
  const params = new URLSearchParams();
  if (state.filter.search) params.set("search", state.filter.search);
  if (state.filter.onlyDeals) params.set("only_deals", "true");
  params.set("sort", state.filter.sort);

  try {
    state.products = await api(`/api/products?${params.toString()}`);
  } catch (error) {
    toast(error.message, "error");
    return;
  }

  if (!state.products.some((item) => item.id === state.selectedId)) {
    state.selectedId = state.products.length ? state.products[0].id : null;
  }

  renderProducts();

  if (state.selectedId !== null) {
    await loadHistory(state.selectedId);
  } else {
    state.history = [];
    if (chart) chart.destroy();
    chart = null;
    $("chart-canvas").hidden = true;
    $("chart-title").textContent = "Выберите товар, чтобы увидеть динамику";
    $("chart-meta").textContent = "";
    const empty = $("chart-empty");
    empty.hidden = false;
    empty.textContent = "Нет данных для графика";
  }
}

async function refreshAll() {
  await Promise.all([loadStats(), loadProducts()]);
}

async function refreshPrice(id) {
  try {
    const updated = await api(`/api/products/${id}/check`, { method: "POST" });
    toast(
      `Цена обновлена: ${updated.current_price !== null ? money.format(updated.current_price) : "—"}`,
      "success",
    );
    await refreshAll();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function removeProduct(id) {
  const product = state.products.find((item) => item.id === id);
  const label = product ? `«${product.title}»` : "товар";
  if (!window.confirm(`Удалить ${label} вместе с историей цен?`)) return;
  try {
    await api(`/api/products/${id}`, { method: "DELETE" });
    if (state.selectedId === id) state.selectedId = null;
    toast("Товар удалён", "success");
    await refreshAll();
  } catch (error) {
    toast(error.message, "error");
  }
}

function fillDemo(kind) {
  const isLaptop = kind === "laptop";
  $("f-title").value = isLaptop ? "Ноутбук DemoBook 15" : "Смартфон DemoPhone X";
  $("f-url").value = `${location.origin}/demo-store/${isLaptop ? "laptop" : "phone"}`;
  $("f-selector").value = isLaptop ? ".product-price" : "";
  $("f-target").value = isLaptop ? "90000" : "50000";
  $("f-notes").value = "Цена на демо-странице генерируется случайно при каждом запросе.";
}

function openProductDialog(product = null) {
  dialogMode = product ? "edit" : "create";
  editingId = product ? product.id : null;

  $("product-dialog-title").textContent = product ? "Редактировать товар" : "Новый товар";
  $("product-submit").textContent = product ? "Сохранить" : "Добавить товар";
  $("f-title").value = product ? product.title : "";
  $("f-url").value = product ? product.url : "";
  $("f-url").disabled = Boolean(product);
  $("url-hint").hidden = !product;
  $("f-selector").value = product ? product.css_selector || "" : "";
  $("f-target").value = product && product.target_price !== null ? product.target_price : "";
  $("f-notes").value = product ? product.notes || "" : "";
  $("product-error").hidden = true;

  $("product-dialog").showModal();
  $("f-title").focus();
}

$("product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const selector = $("f-selector").value.trim();
  const target = $("f-target").value.trim();
  const notes = $("f-notes").value.trim();

  const payload = {
    title: $("f-title").value.trim(),
    css_selector: selector || null,
    target_price: target ? Number(target) : null,
    notes: notes || null,
  };

  try {
    let saved;
    if (dialogMode === "edit") {
      saved = await api(`/api/products/${editingId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    } else {
      payload.url = $("f-url").value.trim();
      saved = await api("/api/products", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      state.selectedId = saved.id;
    }

    $("product-dialog").close();
    toast(dialogMode === "edit" ? "Товар обновлён" : `Товар «${saved.title}» добавлен`, "success");
    await refreshAll();
  } catch (error) {
    $("product-error").textContent = error.message;
    $("product-error").hidden = false;
  }
});

$("fill-demo-laptop").addEventListener("click", () => fillDemo("laptop"));
$("fill-demo-phone").addEventListener("click", () => fillDemo("phone"));
$("add-btn").addEventListener("click", () => openProductDialog());
$("product-cancel").addEventListener("click", () => $("product-dialog").close());
$("product-close").addEventListener("click", () => $("product-dialog").close());

$("seed-btn").addEventListener("click", async () => {
  try {
    const created = await api("/api/products/seed-demo", { method: "POST" });
    toast(
      created.length
        ? `Добавлено демо-товаров: ${created.length}`
        : "Демо-товары уже добавлены",
      "success",
    );
    await refreshAll();
  } catch (error) {
    toast(error.message, "error");
  }
});

$("check-all-btn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Проверяем…";
  try {
    const result = await api("/api/products/check-all", { method: "POST" });
    toast(
      `Проверено ${result.checked}: обновлено ${result.updated}, ошибок ${result.failed}`,
      result.failed ? "info" : "success",
    );
    await refreshAll();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

async function downloadReport(kind) {
  try {
    const response = await fetch(`/api/export/${kind}`, {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
    });
    if (response.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!response.ok) throw new Error(`Не удалось получить отчёт (${response.status})`);

    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const objectUrl = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = match ? match[1] : `price_report.${kind === "excel" ? "xlsx" : "csv"}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    toast("Отчёт скачан", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

$("export-excel").addEventListener("click", () => downloadReport("excel"));
$("export-csv").addEventListener("click", () => downloadReport("csv"));

$("search").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value.trim();
  searchTimer = setTimeout(() => {
    state.filter.search = value;
    loadProducts();
  }, 300);
});

$("sort").addEventListener("change", (event) => {
  state.filter.sort = event.target.value;
  loadProducts();
});

document.querySelectorAll(".filter-tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter.onlyDeals = button.dataset.deals === "true";
    document.querySelectorAll(".filter-tab").forEach((tab) => {
      const active = tab.dataset.deals === button.dataset.deals;
      tab.classList.toggle("bg-stone-900", active);
      tab.classList.toggle("text-white", active);
      tab.classList.toggle("font-medium", active);
      tab.classList.toggle("text-stone-600", !active);
    });
    loadProducts();
  });
});

document.querySelectorAll(".range-tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.range = button.dataset.range;
    document.querySelectorAll(".range-tab").forEach((tab) => {
      const active = tab.dataset.range === state.range;
      tab.classList.toggle("bg-stone-900", active);
      tab.classList.toggle("text-white", active);
      tab.classList.toggle("font-medium", active);
      tab.classList.toggle("text-stone-600", !active);
    });
    if (state.selectedId !== null && state.history.length) {
      const product = state.products.find((item) => item.id === state.selectedId);
      if (product) drawChart(product, state.history);
    }
  });
});

$("login-btn").addEventListener("click", () => {
  $("login-error").hidden = true;
  $("login-password").value = "";
  $("login-dialog").showModal();
});

$("login-cancel").addEventListener("click", () => $("login-dialog").close());

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("login-password").value;
  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (!response.ok) {
      $("login-error").textContent =
        response.status === 429 ? "Слишком много попыток — подождите минуту" : "Неверный пароль";
      $("login-error").hidden = false;
      return;
    }

    const data = await response.json();
    state.token = data.access_token;
    localStorage.setItem(TOKEN_KEY, state.token);
    $("login-dialog").close();
    syncAuth();
    await refreshAll();
    toast("Вы вошли как администратор", "success");
  } catch {
    toast("Сервер недоступен", "error");
  }
});

$("logout-btn").addEventListener("click", logout);

syncAuth();
refreshAll();
