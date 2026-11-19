const TOKEN_KEY = "price_tracker_token";

const money = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});
const dateTime = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short",
  timeStyle: "short",
});

let token = localStorage.getItem(TOKEN_KEY);
let products = [];
let selectedId = null;
let chart = null;

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message, kind = "info") {
  const palette = {
    info: "border-sky-400/40 text-sky-100",
    success: "border-emerald-400/40 text-emerald-100",
    error: "border-rose-400/40 text-rose-100",
  };
  const node = el(
    "div",
    `card-enter pointer-events-auto rounded-xl border bg-slate-900/95 px-4 py-3 text-sm shadow-xl ${palette[kind] || palette.info}`,
    message,
  );
  $("toast").appendChild(node);
  setTimeout(() => node.remove(), 4000);
}

function handleUnauthorized() {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  syncAuth();
  renderProducts();
  toast("Сессия истекла, войдите снова", "error");
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
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
      /* ignore */
    }
    throw new Error(detail);
  }

  if (response.status === 204) return null;
  return response.json();
}

function syncAuth() {
  const authed = Boolean(token);
  $("login-btn").hidden = authed;
  $("logout-btn").hidden = !authed;
  $("admin-panel").hidden = !authed;
  $("admin-badge").hidden = !authed;
}

function logout() {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  syncAuth();
  renderProducts();
  toast("Вы вышли из режима администратора");
}

function badgeGood() {
  return el(
    "span",
    "shrink-0 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-300",
    "Выгодная цена!",
  );
}

function productCard(product) {
  const card = el(
    "div",
    "product-card card-enter group cursor-pointer rounded-2xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg transition hover:border-slate-700 hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70",
  );
  card.dataset.productId = String(product.id);
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `Показать график: ${product.title}`);

  const top = el("div", "flex items-start justify-between gap-3");
  top.appendChild(el("h3", "text-base font-semibold leading-snug text-slate-100", product.title));

  const isGood =
    product.current_price !== null &&
    product.target_price !== null &&
    product.current_price <= product.target_price;
  if (isGood) top.appendChild(badgeGood());

  card.appendChild(top);
  card.appendChild(
    el(
      "p",
      "mt-4 text-3xl font-semibold tracking-tight text-sky-300",
      product.current_price !== null ? money.format(product.current_price) : "—",
    ),
  );
  card.appendChild(
    el(
      "p",
      "mt-1 text-sm text-slate-400",
      product.target_price !== null ? `Цель: ${money.format(product.target_price)}` : "Цель не задана",
    ),
  );
  card.appendChild(
    el(
      "p",
      "mt-3 truncate font-mono text-xs text-slate-500",
      product.css_selector || "автоопределение цены",
    ),
  );

  if (/^https?:\/\//i.test(product.url)) {
    const link = el("a", "mt-3 inline-flex items-center gap-1 text-xs font-medium text-sky-400 transition hover:text-sky-300", "Открыть страницу ↗");
    link.href = product.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer nofollow";
    card.appendChild(link);
  }

  if (token) {
    const actions = el("div", "mt-4 flex gap-2 border-t border-slate-800 pt-4");
    const refresh = el(
      "button",
      "rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 transition hover:bg-sky-500/20",
      "Обновить цену",
    );
    refresh.type = "button";
    refresh.addEventListener("click", () => refreshPrice(product.id));

    const remove = el(
      "button",
      "rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20",
      "Удалить",
    );
    remove.type = "button";
    remove.addEventListener("click", () => removeProduct(product.id));

    actions.append(refresh, remove);
    card.appendChild(actions);
  }

  const activate = () => selectProduct(product.id);
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
  const box = el(
    "div",
    "rounded-2xl border border-dashed border-slate-800 bg-slate-900/30 p-10 text-center sm:col-span-2",
  );
  box.append(el("p", "font-medium text-slate-300", "Пока нет товаров"));
  box.append(
    el(
      "p",
      "mt-1 text-sm text-slate-500",
      token
        ? "Добавьте первый товар в панели администратора."
        : "Войдите как администратор, чтобы добавить товар.",
    ),
  );
  return box;
}

function renderProducts() {
  const container = $("products");
  container.replaceChildren();
  $("products-count").textContent = `Товаров: ${products.length}`;

  if (!products.length) {
    container.appendChild(emptyState());
    return;
  }

  for (const product of products) {
    container.appendChild(productCard(product));
  }
  highlightSelected();
}

function highlightSelected() {
  document.querySelectorAll("[data-product-id]").forEach((node) => {
    const active = Number(node.dataset.productId) === selectedId;
    node.classList.toggle("ring-2", active);
    node.classList.toggle("ring-sky-400/60", active);
  });
}

async function selectProduct(id) {
  selectedId = id;
  highlightSelected();
  await loadHistory(id);
}

async function loadHistory(id) {
  const product = products.find((item) => item.id === id);
  if (!product) return;
  try {
    const history = await api(`/api/products/${id}/history`);
    history.sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
    drawChart(product, history);
  } catch (error) {
    toast(error.message, "error");
  }
}

function drawChart(product, history) {
  $("chart-title").textContent = product.title;
  const canvas = $("chart-canvas");
  const empty = $("chart-empty");

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
  const prices = history.map((item) => item.price);
  const datasets = [
    {
      label: "Цена",
      data: prices,
      borderColor: "#38bdf8",
      backgroundColor: "rgba(56, 189, 248, 0.12)",
      pointBackgroundColor: "#38bdf8",
      pointBorderColor: "#0b1220",
      fill: true,
      tension: 0.35,
      borderWidth: 2,
      pointRadius: 3,
      pointHoverRadius: 5,
    },
  ];

  if (product.target_price !== null) {
    datasets.push({
      label: "Целевая цена",
      data: prices.map(() => product.target_price),
      borderColor: "#f59e0b",
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
      animation: { duration: 500, easing: "easeOutQuart" },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#cbd5e1", usePointStyle: true, boxWidth: 8 } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${money.format(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#94a3b8", maxRotation: 0, autoSkip: true },
          grid: { color: "rgba(148, 163, 184, 0.08)" },
        },
        y: {
          ticks: { color: "#94a3b8", callback: (value) => money.format(value) },
          grid: { color: "rgba(148, 163, 184, 0.08)" },
        },
      },
    },
  });
}

async function loadProducts() {
  try {
    products = await api("/api/products");
    if (selectedId !== null && !products.some((item) => item.id === selectedId)) {
      selectedId = null;
    }
    renderProducts();

    if (selectedId !== null) {
      await loadHistory(selectedId);
    } else if (products.length) {
      await selectProduct(products[0].id);
    } else {
      $("chart-title").textContent = "Выберите товар";
      if (chart) chart.destroy();
      chart = null;
      $("chart-canvas").hidden = true;
      const empty = $("chart-empty");
      empty.hidden = false;
      empty.textContent = "Нет данных для графика";
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

async function refreshPrice(id) {
  try {
    const updated = await api(`/api/products/${id}/check`, { method: "POST" });
    toast(`Новая цена: ${updated.current_price !== null ? money.format(updated.current_price) : "—"}`, "success");
    await loadProducts();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function removeProduct(id) {
  if (!window.confirm("Удалить товар и всю историю цен?")) return;
  try {
    await api(`/api/products/${id}`, { method: "DELETE" });
    if (selectedId === id) selectedId = null;
    toast("Товар удалён", "success");
    await loadProducts();
  } catch (error) {
    toast(error.message, "error");
  }
}

function fillDemo(kind) {
  const isLaptop = kind === "laptop";
  $("add-title").value = isLaptop ? "Ноутбук DemoBook 15" : "Смартфон DemoPhone X";
  $("add-url").value = isLaptop
    ? "http://127.0.0.1:8000/demo-store/laptop"
    : "http://127.0.0.1:8000/demo-store/phone";
  $("add-selector").value = isLaptop ? ".product-price" : "";
  $("add-target").value = isLaptop ? "90000" : "50000";
}

$("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const selector = $("add-selector").value.trim();
  const target = $("add-target").value.trim();

  const payload = {
    title: $("add-title").value.trim(),
    url: $("add-url").value.trim(),
    css_selector: selector || null,
    target_price: target ? Number(target) : null,
  };

  try {
    const created = await api("/api/products", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    $("add-form").reset();
    selectedId = created.id;
    toast(`Товар «${created.title}» добавлен`, "success");
    await loadProducts();
  } catch (error) {
    toast(error.message, "error");
  }
});

$("fill-laptop").addEventListener("click", () => fillDemo("laptop"));
$("fill-phone").addEventListener("click", () => fillDemo("phone"));

$("export-btn").addEventListener("click", async () => {
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch("/api/export/excel", { headers });
    if (response.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!response.ok) throw new Error(`Ошибка экспорта (${response.status})`);

    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const objectUrl = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = match ? match[1] : "price_report.xlsx";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    toast("Отчёт Excel скачан", "success");
  } catch (error) {
    toast(error.message, "error");
  }
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
        response.status === 429 ? "Слишком много попыток, подождите минуту" : "Неверный пароль";
      $("login-error").hidden = false;
      return;
    }

    const data = await response.json();
    token = data.access_token;
    localStorage.setItem(TOKEN_KEY, token);
    $("login-dialog").close();
    syncAuth();
    await loadProducts();
    toast("Вы вошли как администратор", "success");
  } catch {
    toast("Сервер недоступен", "error");
  }
});

$("logout-btn").addEventListener("click", logout);

syncAuth();
loadProducts();
