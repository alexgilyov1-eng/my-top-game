/* ============================================================
   GAMES — app.js
   Использует window.AppData (см. data.js) как асинхронный слой
   хранилища. UI читает синхронно из AppData.state, мутации
   уходят в AppData.* и параллельно синхронятся в бэкенд.
   ============================================================ */

// ---------- Constants ----------
const STATUS = {
  passed:  { label: "Пройдено", cls: "st-passed",  bg: "bg-st-passed"  },
  playing: { label: "Играю",    cls: "st-playing", bg: "bg-st-playing" },
  dropped: { label: "Брошено",  cls: "st-dropped", bg: "bg-st-dropped" },
  planned: { label: "В планах", cls: "st-planned", bg: "bg-st-planned" }
};

const ACHIEVEMENTS = [
  { id: "first",     title: "Начало пути",   desc: "Добавь первую игру",  test: g => g.length >= 1 },
  { id: "ten",       title: "Десятка",       desc: "10 игр в коллекции",  test: g => g.length >= 10 },
  { id: "fifty",     title: "Полтинник",     desc: "50 игр в коллекции",  test: g => g.length >= 50 },
  { id: "passed_5",  title: "Финишёр",       desc: "5 пройденных",        test: g => g.filter(x => x.status === "passed").length >= 5 },
  { id: "passed_25", title: "Опытный",       desc: "25 пройденных",       test: g => g.filter(x => x.status === "passed").length >= 25 },
  { id: "perfect",   title: "Перфекционист", desc: "3 игры на 10/10",     test: g => g.filter(x => x.rating === 10).length >= 3 },
  { id: "critic",    title: "Критик",        desc: "Оценил 10+ игр",      test: g => g.filter(x => x.rating).length >= 10 },
  { id: "monogenre", title: "Жанровый фан",  desc: "5+ игр в одном жанре",test: g => Math.max(0, ...countGenres(g).map(x => x.count)) >= 5 },
  { id: "retro",     title: "Олдскул",       desc: "Игра до 2005 года",   test: g => g.some(x => x.released && parseInt(x.released) < 2005) },
  { id: "wishful",   title: "Мечтатель",     desc: "10+ игр в планах",    test: g => g.filter(x => x.status === "planned").length >= 10 },
  { id: "note_taker",title: "Дневник",       desc: "Заметка к 5+ играм",  test: g => g.filter(x => (x.note||"").trim()).length >= 5 }
];

// ---------- State ----------
let currentView = "library";
let currentCollectionId = null;
let sortableInstance = null;
const tgWA = window.Telegram?.WebApp;
const inTelegram = !!(tgWA && tgWA.initData);

// ---------- Tiny helpers ----------
function $(sel)  { return document.querySelector(sel); }
function $$(sel) { return [...document.querySelectorAll(sel)]; }
function escapeHtml(s) { return String(s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function escapeAttr(s) { return s.replace(/"/g, "&quot;").replace(/'/g, "\\'"); }
function fmtDate(s)    { if (!s) return ""; return new Date(s).toLocaleDateString("ru-RU", { day:"2-digit", month:"short", year:"numeric" }); }
function year(s)       { return s ? String(s).slice(0,4) : ""; }
function hapt(kind)    { try { tgWA?.HapticFeedback?.impactOccurred?.(kind || "light"); } catch (e) {} }

function countGenres(games) {
  const map = new Map();
  games.forEach(g => (g.genres||[]).forEach(gn => {
    const name = gn.name || gn;
    map.set(name, (map.get(name)||0) + 1);
  }));
  return [...map.entries()].map(([name,count]) => ({name,count})).sort((a,b) => b.count - a.count);
}

// ---------- Simple RAWG cache (for local mode; tg mode caches on proxy) ----------
const rawgCache = new Map();
function rawgKey(path, params) { return path + "?" + new URLSearchParams(params || {}).toString(); }
async function rawg(path, params, ttlMs) {
  const key = rawgKey(path, params);
  const hit = rawgCache.get(key);
  if (hit && Date.now() - hit.t < (ttlMs || 60000)) return hit.data;
  const data = await window.AppData.rawg(path, params);
  rawgCache.set(key, { data, t: Date.now() });
  return data;
}

// ---------- Init ----------
async function init() {
  // Telegram WebApp setup
  if (tgWA) {
    try {
      tgWA.ready();
      tgWA.expand();
      tgWA.setHeaderColor?.("#09090b");
      tgWA.setBackgroundColor?.("#09090b");
    } catch (e) { /* SDK may be partial */ }
  }

  // Show loader and bootstrap data layer
  showLoader(true);
  const ok = await window.AppData.bootstrap();
  showLoader(false);

  if (!ok) {
    showFatalError(window.AppData.state.error || "Не удалось подключиться к серверу");
    return;
  }

  // API-ключ панель показываем только в локальном режиме (вне Telegram)
  const settingsBtn = $("#settings-btn");
  if (inTelegram) {
    settingsBtn?.classList.add("hidden");
    $("#settings-panel")?.remove();
  } else {
    setupApiKeyPanel();
  }

  // Nav buttons
  $$(".nav-btn").forEach(b => b.onclick = () => showView(b.dataset.view));
  $("#add-btn").onclick = openSearchModal;

  // Filters
  ["filter-status","filter-min-rating","sort"].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener("change", renderLibrary);
    el.addEventListener("input",  renderLibrary);
  });

  // Search modal
  $("#search-input").addEventListener("input", onSearchInput);
  $("#modal-search-close").onclick = closeSearchModal;
  $("#modal-search").addEventListener("click", (e) => { if (e.target === $("#modal-search")) closeSearchModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      ["#modal-search","#modal-edit","#modal-detail","#modal-collection","#modal-add-to-coll"].forEach(s => {
        const m = $(s); if (m && !m.classList.contains("hidden")) m.classList.add("hidden");
      });
    }
  });

  // Edit modal
  $("#edit-status-group").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-st]");
    if (btn) setEditStatus(btn.dataset.st);
  });
  $("#edit-cancel").onclick = () => $("#modal-edit").classList.add("hidden");
  $("#edit-save").onclick   = saveEdit;
  $("#modal-edit").addEventListener("click", (e) => { if (e.target === $("#modal-edit")) $("#modal-edit").classList.add("hidden"); });

  // Detail modal
  $("#modal-detail").addEventListener("click", (e) => { if (e.target === $("#modal-detail")) $("#modal-detail").classList.add("hidden"); });

  // Collections
  $("#create-collection-btn").onclick = () => openCollectionModal();
  $("#coll-cancel").onclick = () => $("#modal-collection").classList.add("hidden");
  $("#coll-save").onclick   = saveCollection;
  $("#back-to-collections").onclick = () => showView("collections");
  $("#atc-close").onclick = () => $("#modal-add-to-coll").classList.add("hidden");

  showView("library");
  renderStatsLine();
}

function showLoader(show) {
  let l = $("#app-loader");
  if (show && !l) {
    l = document.createElement("div");
    l.id = "app-loader";
    l.className = "fixed inset-0 flex items-center justify-center z-[100] bg-zinc-950";
    l.innerHTML = `<div class="font-mono text-zinc-500 text-sm tracking-widest uppercase animate-pulse">loading…</div>`;
    document.body.appendChild(l);
  } else if (!show && l) {
    l.remove();
  }
}

function showFatalError(msg) {
  document.body.innerHTML = `
    <div class="min-h-screen flex items-center justify-center p-6">
      <div class="panel rounded-xl p-6 max-w-md">
        <div class="section-label mb-2 text-amber-500">error</div>
        <div class="text-zinc-100 mb-3">Не удалось запустить приложение</div>
        <div class="text-sm text-zinc-500 font-mono break-words">${escapeHtml(msg)}</div>
      </div>
    </div>`;
}

function setupApiKeyPanel() {
  let apiKey = localStorage.getItem("rawg_key") || "";
  const apiInput  = $("#api-key-input");
  const apiStatus = $("#api-key-status");
  if (!apiInput || !apiStatus) return;
  apiInput.value = apiKey;
  function refresh() {
    if (apiKey) { apiStatus.textContent = "● сохранён: " + apiKey.slice(0, 8) + "…"; apiStatus.className = "text-xs mt-3 font-mono accent"; }
    else        { apiStatus.textContent = "○ ключ не задан — поиск и открытия недоступны"; apiStatus.className = "text-xs mt-3 font-mono text-amber-500"; }
  }
  refresh();
  if (!apiKey) $("#settings-panel").classList.remove("hidden");
  $("#settings-btn").onclick = () => $("#settings-panel").classList.toggle("hidden");
  $("#api-key-save").onclick = () => {
    apiKey = apiInput.value.trim();
    localStorage.setItem("rawg_key", apiKey);
    refresh();
    if (apiKey) $("#settings-panel").classList.add("hidden");
  };
}

// ---------- Stats line in header ----------
function renderStatsLine() {
  const games = window.AppData.state.games;
  if (!games.length) { $("#stats-line").textContent = ""; return; }
  const rated  = games.filter(g => g.rating);
  const avg    = rated.length ? (rated.reduce((s,g) => s+g.rating,0)/rated.length).toFixed(1) : "—";
  const passed = games.filter(g => g.status === "passed").length;
  $("#stats-line").textContent = `${games.length} в коллекции · пройдено ${passed} · средняя ${avg}`;
}

// ---------- Card HTML ----------
function gameCardHTML(g, opts = {}) {
  const st = STATUS[g.status] || STATUS.planned;
  return `
    <div class="panel panel-hover rounded-lg overflow-hidden group flex flex-col cursor-pointer relative" data-game-id="${g.id}" onclick="openDetailModal(${g.id})">
      ${opts.draggable ? `<div class="absolute top-2 right-2 z-10 chip rounded-md px-1.5 py-0.5 text-xs text-zinc-500 opacity-0 group-hover:opacity-100 transition pointer-events-none" style="background:rgba(0,0,0,.6)" title="перетащи">⋮⋮</div>` : ""}
      <div class="relative aspect-[3/4] cover-bg overflow-hidden">
        ${g.cover ? `<img src="${g.cover}" class="w-full h-full object-cover" loading="lazy" draggable="false" onerror="this.style.display='none'">` : `<div class="w-full h-full flex items-center justify-center font-mono text-zinc-700 text-4xl tracking-tighter">∅</div>`}
        <div class="absolute top-2 left-2 chip rounded-full px-2 py-0.5 text-xs flex items-center gap-1.5 backdrop-blur" style="background:rgba(0,0,0,.6)">
          <span class="dot ${st.bg}"></span><span class="${st.cls}">${st.label}</span>
        </div>
        ${g.rating ? `<div class="absolute bottom-2 right-2 font-mono font-bold text-lg accent" style="text-shadow:0 0 8px rgba(0,0,0,.8)">${g.rating}<span class="text-xs text-zinc-500">/10</span></div>` : ""}
      </div>
      <div class="p-3 flex-1 flex flex-col">
        <div class="font-medium text-sm text-zinc-100 truncate" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</div>
        <div class="text-xs text-zinc-500 font-mono mt-0.5">${year(g.released)}</div>
      </div>
    </div>`;
}

function discoverCardHTML(g) {
  return `
    <div class="panel panel-hover rounded-lg overflow-hidden cursor-pointer flex-shrink-0 w-40" onclick="openDetailModal(${g.id}, true)">
      <div class="aspect-[3/4] cover-bg overflow-hidden">
        ${g.background_image ? `<img src="${g.background_image}" class="w-full h-full object-cover" loading="lazy">` : `<div class="w-full h-full flex items-center justify-center font-mono text-zinc-700 text-3xl">∅</div>`}
      </div>
      <div class="p-2.5">
        <div class="text-xs font-medium truncate" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</div>
        <div class="text-[10px] text-zinc-500 font-mono mt-0.5">${year(g.released)} · ★ ${g.rating || "—"}</div>
      </div>
    </div>`;
}

// ---------- Sortable.js helper ----------
function makeSortable(containerEl, onReorder) {
  if (sortableInstance) { try { sortableInstance.destroy(); } catch (e) {} sortableInstance = null; }
  if (!window.Sortable) return;
  sortableInstance = window.Sortable.create(containerEl, {
    animation: 150,
    delay: 120,           // small hold-to-drag, so taps still open detail
    delayOnTouchOnly: true,
    ghostClass: "opacity-30",
    chosenClass: "ring-2",
    onEnd: (evt) => {
      if (evt.oldIndex === evt.newIndex) return;
      hapt("medium");
      const ids = [...containerEl.querySelectorAll("[data-game-id]")].map(el => parseInt(el.dataset.gameId));
      onReorder(ids);
    }
  });
}

// ---------- View routing ----------
function showView(name) {
  currentView = name;
  ["library","collections","collection-detail","discover","profile"].forEach(v => {
    const el = $("#view-" + v);
    if (el) el.classList.toggle("hidden", v !== name);
  });
  $$(".nav-btn").forEach(b => {
    const active = b.dataset.view === name || (name === "collection-detail" && b.dataset.view === "collections");
    b.className = (active ? "tab-active" : "tab-inactive") + " nav-btn px-4 py-1.5 rounded-md text-sm transition";
  });

  // Telegram BackButton on nested views
  if (tgWA?.BackButton) {
    if (name === "collection-detail") {
      tgWA.BackButton.show();
      tgWA.BackButton.onClick(() => showView("collections"));
    } else {
      try { tgWA.BackButton.hide(); } catch (e) {}
    }
  }

  if (name === "library")     renderLibrary();
  if (name === "collections") renderCollections();
  if (name === "discover")    renderDiscover();
  if (name === "profile")     renderProfile();
}

// ============================================================
// LIBRARY
// ============================================================
function renderLibrary() {
  const all = window.AppData.state.games;
  let games = all.slice();
  const st  = $("#filter-status").value;
  const min = parseInt($("#filter-min-rating").value) || 0;
  if (st)  games = games.filter(g => g.status === st);
  if (min) games = games.filter(g => (g.rating || 0) >= min);
  const sort = $("#sort").value;
  const isManual = sort === "manual";
  games.sort((a,b) => {
    if (sort === "manual")       return (a.manualOrder ?? 1e9) - (b.manualOrder ?? 1e9);
    if (sort === "date-desc")    return b.addedAt - a.addedAt;
    if (sort === "rating-desc")  return (b.rating||0) - (a.rating||0);
    if (sort === "rating-asc")   return (a.rating||11) - (b.rating||11);
    if (sort === "passed-desc")  return (new Date(b.passedAt||0)) - (new Date(a.passedAt||0));
    if (sort === "name")         return a.name.localeCompare(b.name);
    return 0;
  });

  $("#library-counter").textContent = all.length ? `${games.length} / ${all.length}${isManual ? " · перетаскивай карточки" : ""}` : "";

  if (!all.length) {
    $("#library-empty").classList.remove("hidden");
    $("#library-grid").innerHTML = "";
    return;
  }
  $("#library-empty").classList.add("hidden");
  $("#library-grid").innerHTML = games.map(g => gameCardHTML(g, { draggable: isManual })).join("");

  if (isManual) {
    makeSortable($("#library-grid"), async (orderedIds) => {
      try { await window.AppData.reorderGames(orderedIds); }
      catch (e) { console.error(e); alert("Не удалось сохранить порядок: " + e.message); }
    });
  }
}

// ============================================================
// SEARCH
// ============================================================
let searchTimer;
function openSearchModal() {
  hapt();
  $("#modal-search").classList.remove("hidden");
  $("#search-input").value = "";
  $("#search-results").innerHTML = "";
  $("#search-hint").classList.remove("hidden");
  $("#search-hint").textContent = "type to search";
  setTimeout(() => $("#search-input").focus(), 50);
}
function closeSearchModal() { $("#modal-search").classList.add("hidden"); }

function onSearchInput() {
  clearTimeout(searchTimer);
  const q = $("#search-input").value.trim();
  if (!q) {
    $("#search-results").innerHTML = "";
    $("#search-hint").textContent = "type to search";
    $("#search-hint").classList.remove("hidden");
    return;
  }
  searchTimer = setTimeout(() => doSearch(q), 350);
}

async function doSearch(q) {
  $("#search-hint").textContent = "searching...";
  $("#search-hint").classList.remove("hidden");
  $("#search-results").innerHTML = "";
  try {
    const data = await rawg("/games", { search: q, page_size: 16 }, 60000);
    if (!data.results?.length) { $("#search-hint").textContent = "ничего не найдено"; return; }
    const existing = new Set(window.AppData.state.games.map(g => g.id));
    $("#search-results").innerHTML = data.results.map(g => {
      const inList = existing.has(g.id);
      return `
        <div class="panel panel-hover rounded-lg p-3 flex gap-3 cursor-pointer" onclick="openDetailModal(${g.id}, true)">
          <div class="w-16 h-20 rounded cover-bg overflow-hidden flex-shrink-0">
            ${g.background_image ? `<img src="${g.background_image}" class="w-full h-full object-cover" loading="lazy">` : ""}
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-medium text-zinc-100 truncate">${escapeHtml(g.name)}</div>
            <div class="text-xs text-zinc-500 font-mono mt-0.5">${year(g.released)} · ★ ${g.rating || "—"}</div>
            <div class="mt-2">
              ${inList
                ? `<span class="text-xs text-zinc-500 font-mono">✓ в коллекции</span>`
                : `<button class="text-xs px-3 py-1 rounded-md bg-accent font-medium" onclick="event.stopPropagation(); addFromSearch(${escapeAttr(JSON.stringify({id:g.id, name:g.name, released:g.released, cover:g.background_image, genres:g.genres, platforms:g.platforms, metacritic:g.metacritic}))})">＋ Добавить</button>`}
            </div>
          </div>
        </div>`;
    }).join("");
    $("#search-hint").classList.add("hidden");
  } catch (e) {
    $("#search-hint").textContent = "ошибка: " + e.message;
  }
}

function addFromSearch(meta) {
  closeSearchModal();
  openEditModalAdd(meta);
}

// ============================================================
// EDIT MODAL
// ============================================================
let editContext = null;
function setEditStatus(value) {
  $("#edit-status").value = value;
  $$("#edit-status-group button").forEach(b => {
    const active = b.dataset.st === value;
    b.style.borderColor = active ? "var(--accent)" : "";
    b.style.background  = active ? "rgba(163,230,53,.08)" : "";
    b.style.color       = active ? "#fafafa" : "";
  });
}
function openEditModalAdd(meta) {
  editContext = { mode: "add", meta };
  $("#edit-mode").textContent = "add · entry";
  $("#edit-title").textContent = meta.name;
  $("#edit-rating").value = "";
  $("#edit-passed-at").value = "";
  $("#edit-note").value = "";
  setEditStatus("passed");
  $("#modal-edit").classList.remove("hidden");
  setTimeout(() => $("#edit-rating").focus(), 50);
}
function openEditModalEdit(id) {
  const g = window.AppData.state.games.find(x => x.id === id);
  if (!g) return;
  editContext = { mode: "edit", game: g };
  $("#edit-mode").textContent = "edit · entry";
  $("#edit-title").textContent = g.name;
  $("#edit-rating").value = g.rating || "";
  $("#edit-passed-at").value = g.passedAt || "";
  $("#edit-note").value = g.note || "";
  setEditStatus(g.status || "passed");
  $("#modal-detail").classList.add("hidden");
  $("#modal-edit").classList.remove("hidden");
}

async function saveEdit() {
  if (!editContext) return;
  let rating = parseInt($("#edit-rating").value);
  if (isNaN(rating) || rating < 1 || rating > 10) rating = null;
  const passedAt = $("#edit-passed-at").value || null;
  const status = $("#edit-status").value;
  const note = $("#edit-note").value.trim();

  $("#modal-edit").classList.add("hidden");
  hapt("medium");

  try {
    if (editContext.mode === "add") {
      const m = editContext.meta;
      const games = window.AppData.state.games;
      const nextOrder = games.length ? Math.max(...games.map(g => g.manualOrder ?? 0)) + 1 : 0;
      await window.AppData.addGame({
        id: m.id, name: m.name,
        released: m.released || null,
        cover: m.cover || null,
        genres: (m.genres || []).map(x => ({ id: x.id, name: x.name, slug: x.slug })),
        platforms: (m.platforms || []).map(p => p.platform ? { id: p.platform.id, name: p.platform.name } : { name: p.name }),
        metacritic: m.metacritic || null,
        rating, status, note, passedAt,
        addedAt: Date.now(),
        manualOrder: nextOrder
      });
    } else {
      await window.AppData.updateGame(editContext.game.id, { rating, status, note, passedAt });
    }
  } catch (e) {
    console.error(e); alert("Не удалось сохранить: " + e.message);
  }

  renderStatsLine();
  if (currentView === "library")           renderLibrary();
  if (currentView === "collection-detail") renderCollectionDetail(currentCollectionId);
  if (currentView === "profile")           renderProfile();
}

async function deleteGame(id) {
  const g = window.AppData.state.games.find(x => x.id === id);
  if (!g) return;
  if (!confirm("Удалить «" + g.name + "» из коллекции?")) return;
  $("#modal-detail").classList.add("hidden");
  try { await window.AppData.removeGame(id); }
  catch (e) { alert("Не удалось удалить: " + e.message); return; }
  renderStatsLine();
  if (currentView === "library")           renderLibrary();
  if (currentView === "collection-detail") renderCollectionDetail(currentCollectionId);
  if (currentView === "profile")           renderProfile();
  if (currentView === "collections")       renderCollections();
}

// ============================================================
// DETAIL MODAL
// ============================================================
async function openDetailModal(id, fromExternal) {
  const modal = $("#modal-detail");
  modal.classList.remove("hidden");
  $("#detail-content").innerHTML = `<div class="p-10 text-center text-zinc-500 font-mono text-sm">loading...</div>`;

  const saved = window.AppData.state.games.find(g => g.id === id);
  let detail = null, screenshots = [];
  try {
    [detail, screenshots] = await Promise.all([
      rawg("/games/" + id, {}, 7 * 86400000).catch(() => null),
      rawg("/games/" + id + "/screenshots", {}, 7 * 86400000).then(d => d.results || []).catch(() => []),
    ]);
  } catch (e) {
    $("#detail-content").innerHTML = `<div class="p-10 text-center">
      <div class="text-amber-500 mb-2">ошибка: ${escapeHtml(e.message)}</div>
      <button onclick="document.getElementById('modal-detail').classList.add('hidden')" class="chip rounded-md px-4 py-2 text-sm mt-2">Закрыть</button>
    </div>`;
    return;
  }
  $("#detail-content").innerHTML = renderDetail({ saved, detail, screenshots });
}

function renderDetail({ saved, detail, screenshots }) {
  const name = detail?.name || saved?.name || "...";
  const cover = detail?.background_image || saved?.cover;
  const bg = detail?.background_image_additional || cover;
  const desc = (detail?.description_raw || "").slice(0, 800);
  const genres = (detail?.genres || saved?.genres || []).map(g => g.name);
  const platforms = (detail?.platforms || []).map(p => p.platform?.name || p.name).filter(Boolean);
  const devs = (detail?.developers || []).map(d => d.name);
  const meta = detail?.metacritic;
  const rawgRating = detail?.rating;
  const released = detail?.released || saved?.released;
  const playtime = detail?.playtime;

  const inCollection = !!saved;
  const st = saved ? STATUS[saved.status] || STATUS.planned : null;

  return `
    <div class="relative">
      <div class="aspect-[16/7] cover-bg overflow-hidden rounded-t-xl relative">
        ${bg ? `<img src="${bg}" class="w-full h-full object-cover opacity-60">` : ""}
        <div class="absolute inset-0" style="background:linear-gradient(180deg, transparent 30%, var(--panel) 100%)"></div>
        <button onclick="document.getElementById('modal-detail').classList.add('hidden')" class="absolute top-3 right-3 chip rounded-md px-2 py-1 text-xs hover:border-zinc-600" style="background:rgba(0,0,0,.6)">esc ✕</button>
      </div>
      <div class="px-6 pb-6 -mt-20 relative">
        <div class="flex items-end gap-4 flex-wrap">
          <div class="w-32 aspect-[3/4] cover-bg rounded-lg overflow-hidden flex-shrink-0 border border-zinc-800 shadow-2xl">
            ${cover ? `<img src="${cover}" class="w-full h-full object-cover">` : ""}
          </div>
          <div class="flex-1 min-w-0">
            <div class="section-label mb-1">${released || ""}${devs.length ? " · " + devs.join(", ") : ""}</div>
            <h2 class="text-2xl font-bold mb-2">${escapeHtml(name)}</h2>
            <div class="flex flex-wrap gap-1.5">${genres.map(g => `<span class="badge">${escapeHtml(g)}</span>`).join("")}</div>
          </div>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 mb-6">
          ${meta ? `<div class="panel-2 rounded-lg p-3"><div class="section-label">metacritic</div><div class="font-mono text-2xl font-bold mt-1 ${meta >= 75 ? "accent" : meta >= 50 ? "text-amber-500" : "text-rose-500"}">${meta}</div></div>` : ""}
          ${rawgRating ? `<div class="panel-2 rounded-lg p-3"><div class="section-label">rawg ★</div><div class="font-mono text-2xl font-bold mt-1">${rawgRating}</div></div>` : ""}
          ${playtime ? `<div class="panel-2 rounded-lg p-3"><div class="section-label">avg playtime</div><div class="font-mono text-2xl font-bold mt-1">${playtime}ч</div></div>` : ""}
          ${platforms.length ? `<div class="panel-2 rounded-lg p-3"><div class="section-label">платформы</div><div class="text-xs mt-1 line-clamp-2">${platforms.slice(0,4).join(" · ")}</div></div>` : ""}
        </div>

        ${desc ? `<div class="text-sm text-zinc-300 leading-relaxed mb-6">${escapeHtml(desc)}${detail?.description_raw && detail.description_raw.length > 800 ? "…" : ""}</div>` : ""}

        ${screenshots.length ? `
          <div class="mb-6">
            <div class="section-label mb-2">скриншоты</div>
            <div class="flex gap-2 overflow-x-auto scroll-x pb-1">
              ${screenshots.slice(0,8).map(s => `<img src="${s.image}" class="h-32 rounded flex-shrink-0 cursor-pointer hover:opacity-80 transition" onclick="window.open('${s.image}','_blank')">`).join("")}
            </div>
          </div>` : ""}

        ${inCollection ? `
          <div class="panel-2 rounded-lg p-4 mb-4">
            <div class="section-label mb-3">в моей коллекции</div>
            <div class="grid grid-cols-3 gap-3 text-sm">
              <div><div class="text-xs text-zinc-500 mb-0.5">оценка</div><div class="font-mono text-lg ${saved.rating ? "accent" : "text-zinc-600"}">${saved.rating ? saved.rating + "/10" : "—"}</div></div>
              <div><div class="text-xs text-zinc-500 mb-0.5">статус</div><div class="${st.cls} text-sm"><span class="dot ${st.bg}"></span> ${st.label}</div></div>
              <div><div class="text-xs text-zinc-500 mb-0.5">прошёл</div><div class="font-mono text-xs">${saved.passedAt ? fmtDate(saved.passedAt) : "—"}</div></div>
            </div>
            ${saved.note ? `<div class="text-sm text-zinc-400 mt-3 pt-3 border-t border-zinc-800">${escapeHtml(saved.note)}</div>` : ""}
          </div>` : ""}

        <div class="flex gap-2 flex-wrap">
          ${inCollection
            ? `<button onclick="openEditModalEdit(${saved.id})" class="chip rounded-md px-4 py-2 text-sm hover:border-zinc-600">Изменить</button>
               <button onclick="openAddToCollectionModal(${saved.id})" class="chip rounded-md px-4 py-2 text-sm hover:border-zinc-600">В подборку…</button>
               <button onclick="deleteGame(${saved.id})" class="chip rounded-md px-4 py-2 text-sm hover:border-rose-600 hover:text-rose-400">Удалить</button>`
            : `<button onclick="addFromDetail(${escapeAttr(JSON.stringify({id: detail?.id, name, released, cover, genres: detail?.genres, platforms: detail?.platforms, metacritic: meta}))})" class="bg-accent rounded-md px-5 py-2 text-sm font-medium">＋ Добавить в коллекцию</button>`
          }
        </div>
      </div>
    </div>`;
}

function addFromDetail(meta) {
  $("#modal-detail").classList.add("hidden");
  openEditModalAdd(meta);
}

// ============================================================
// COLLECTIONS
// ============================================================
function renderCollections() {
  const games = window.AppData.state.games;
  const colls = window.AppData.state.collections;

  const smart = [
    { id: "top10",    title: "Топ-10",       desc: "Лучшие по оценке",  filter: g => g.rating, sort: (a,b) => b.rating - a.rating, limit: 10, accent: true },
    { id: "playing",  title: "Сейчас играю", desc: "В процессе",        filter: g => g.status === "playing" },
    { id: "wishlist", title: "Вишлист",      desc: "Хочу пройти",       filter: g => g.status === "planned" },
    { id: "passed",   title: "Пройдено",     desc: "Завершённые",       filter: g => g.status === "passed" },
    { id: "dropped",  title: "Брошено",      desc: "Не дошёл до конца", filter: g => g.status === "dropped" }
  ];

  $("#smart-collections").innerHTML = smart.map(s => {
    let list = games.filter(s.filter);
    if (s.sort)  list.sort(s.sort);
    if (s.limit) list = list.slice(0, s.limit);
    return collectionCardHTML("smart:" + s.id, s.title, s.desc, list, s.accent);
  }).join("");

  if (!colls.length) {
    $("#user-collections-empty").classList.remove("hidden");
    $("#user-collections").innerHTML = "";
  } else {
    $("#user-collections-empty").classList.add("hidden");
    $("#user-collections").innerHTML = colls.map(c => {
      const list = games.filter(g => c.gameIds.includes(g.id));
      return collectionCardHTML("user:" + c.id, c.name, c.desc, list);
    }).join("");
  }
}

function collectionCardHTML(key, title, desc, list, accent) {
  const covers = list.slice(0,4).map(g => g.cover).filter(Boolean);
  return `
    <div class="panel panel-hover rounded-xl overflow-hidden cursor-pointer" onclick="openCollectionDetail('${key}')">
      <div class="grid grid-cols-2 aspect-[16/9] cover-bg">
        ${[0,1,2,3].map(i => `<div class="overflow-hidden">${covers[i] ? `<img src="${covers[i]}" class="w-full h-full object-cover">` : '<div class="w-full h-full"></div>'}</div>`).join("")}
      </div>
      <div class="p-4">
        <div class="flex items-baseline justify-between">
          <div class="font-medium ${accent ? "accent" : ""}">${escapeHtml(title)}</div>
          <div class="font-mono text-xs text-zinc-500">${list.length}</div>
        </div>
        ${desc ? `<div class="text-xs text-zinc-500 mt-1 line-clamp-2">${escapeHtml(desc)}</div>` : ""}
      </div>
    </div>`;
}

function openCollectionDetail(key) {
  currentCollectionId = key;
  showView("collection-detail");
  renderCollectionDetail(key);
}

function renderCollectionDetail(key) {
  const games = window.AppData.state.games;
  let title, desc, list, isUser = false, userColl = null;

  if (key.startsWith("smart:")) {
    const id = key.slice(6);
    const map = {
      top10: { title: "Топ-10", desc: "Лучшие игры по моей оценке", filter: g => g.rating, sort: (a,b) => b.rating - a.rating, limit: 10 },
      playing: { title: "Сейчас играю", filter: g => g.status === "playing" },
      wishlist: { title: "Вишлист", filter: g => g.status === "planned" },
      passed: { title: "Пройдено", filter: g => g.status === "passed" },
      dropped: { title: "Брошено", filter: g => g.status === "dropped" }
    };
    const s = map[id];
    title = s.title; desc = s.desc;
    list = games.filter(s.filter);
    if (s.sort)  list.sort(s.sort);
    if (s.limit) list = list.slice(0, s.limit);
  } else if (key.startsWith("user:")) {
    isUser = true;
    const id = key.slice(5);
    userColl = window.AppData.state.collections.find(c => c.id === id);
    if (!userColl) { showView("collections"); return; }
    title = userColl.name; desc = userColl.desc;
    list = userColl.gameIds.map(gid => games.find(g => g.id === gid)).filter(Boolean);
  }

  $("#collection-detail-title").textContent = title;
  $("#collection-detail-meta").textContent = (list.length + " игр") + (desc ? " · " + desc : "");
  $("#collection-detail-actions").innerHTML = isUser ? `
    <button onclick='openCollectionModal(${escapeAttr(JSON.stringify(userColl))})' class="chip rounded-md px-3 py-1.5 text-sm hover:border-zinc-600">Изменить</button>
    <button onclick='deleteCollection("${userColl.id}")' class="chip rounded-md px-3 py-1.5 text-sm hover:border-rose-600 hover:text-rose-400">Удалить</button>
  ` : "";

  if (!list.length) {
    $("#collection-detail-empty").classList.remove("hidden");
    $("#collection-detail-grid").innerHTML = "";
  } else {
    $("#collection-detail-empty").classList.add("hidden");
    $("#collection-detail-grid").innerHTML = list.map(g => gameCardHTML(g, { draggable: isUser })).join("");
    if (isUser) {
      makeSortable($("#collection-detail-grid"), async (orderedIds) => {
        try { await window.AppData.reorderCollectionGames(userColl.id, orderedIds); }
        catch (e) { console.error(e); alert("Не удалось сохранить порядок: " + e.message); }
      });
    }
  }
}

// Collection create/edit
let collEditCtx = null;
function openCollectionModal(coll) {
  collEditCtx = coll || null;
  $("#coll-mode").textContent = coll ? "edit · collection" : "new · collection";
  $("#coll-name").value = coll?.name || "";
  $("#coll-desc").value = coll?.desc || "";
  $("#modal-collection").classList.remove("hidden");
  setTimeout(() => $("#coll-name").focus(), 50);
}
async function saveCollection() {
  const name = $("#coll-name").value.trim();
  if (!name) { $("#coll-name").focus(); return; }
  const desc = $("#coll-desc").value.trim();
  $("#modal-collection").classList.add("hidden");
  try {
    if (collEditCtx) await window.AppData.updateCollection(collEditCtx.id, { name, desc });
    else             await window.AppData.addCollection({ name, desc });
  } catch (e) { alert("Не удалось сохранить подборку: " + e.message); return; }
  if (currentView === "collection-detail") renderCollectionDetail(currentCollectionId);
  if (currentView === "collections")       renderCollections();
}
async function deleteCollection(id) {
  if (!confirm("Удалить подборку?")) return;
  try { await window.AppData.removeCollection(id); }
  catch (e) { alert("Не удалось удалить: " + e.message); return; }
  showView("collections");
}

// Add game to collection modal
let atcGameId = null;
function openAddToCollectionModal(gameId) {
  atcGameId = gameId;
  const g = window.AppData.state.games.find(x => x.id === gameId);
  if (!g) return;
  $("#atc-title").textContent = g.name;
  renderAtcList();
  $("#modal-add-to-coll").classList.remove("hidden");
}
function renderAtcList() {
  const colls = window.AppData.state.collections;
  if (!colls.length) {
    $("#atc-list").innerHTML = `<div class="text-sm text-zinc-500 py-4">Подборок пока нет.</div>`;
  } else {
    $("#atc-list").innerHTML = colls.map(c => {
      const inIt = c.gameIds.includes(atcGameId);
      return `
        <button class="w-full flex items-center justify-between gap-3 chip rounded-md px-3 py-2 text-sm hover:border-zinc-600 transition" onclick="toggleGameInCollection('${c.id}')">
          <span>${escapeHtml(c.name)} <span class="text-zinc-500 font-mono text-xs ml-1">${c.gameIds.length}</span></span>
          <span class="${inIt ? "accent" : "text-zinc-600"} font-mono text-xs">${inIt ? "✓ есть" : "＋ добавить"}</span>
        </button>`;
    }).join("");
  }
  $("#atc-list").innerHTML += `<button onclick="$('#modal-add-to-coll').classList.add('hidden'); openCollectionModal()" class="w-full text-left chip rounded-md px-3 py-2 text-sm accent hover:border-zinc-600 transition mt-2">＋ создать новую подборку</button>`;
}
async function toggleGameInCollection(collId) {
  const c = window.AppData.state.collections.find(x => x.id === collId);
  if (!c) return;
  const inIt = c.gameIds.includes(atcGameId);
  try {
    if (inIt) await window.AppData.removeGameFromCollection(collId, atcGameId);
    else      await window.AppData.addGameToCollection(collId, atcGameId);
  } catch (e) { alert("Не удалось: " + e.message); return; }
  renderAtcList();
}

// ============================================================
// DISCOVER
// ============================================================
async function renderDiscover() {
  // Loading placeholders
  ["discover-trending","discover-upcoming","discover-recommend"].forEach(id => {
    $("#" + id).innerHTML = Array(6).fill(0).map(() => `<div class="w-40 aspect-[3/4] cover-bg rounded-lg flex-shrink-0 animate-pulse"></div>`).join("");
  });
  $("#discover-recommend-hint").classList.add("hidden");

  const today  = new Date().toISOString().slice(0,10);
  const sixMo  = new Date(Date.now()-180*86400000).toISOString().slice(0,10);
  const inYear = new Date(Date.now()+365*86400000).toISOString().slice(0,10);

  try {
    const [trending, upcoming] = await Promise.all([
      rawg("/games", { ordering: "-added", dates: `${sixMo},${today}`, page_size: 16 }, 6*3600*1000),
      rawg("/games", { dates: `${today},${inYear}`, ordering: "released", page_size: 16 }, 24*3600*1000),
    ]);
    $("#discover-trending").innerHTML = (trending.results || []).map(discoverCardHTML).join("");
    $("#discover-upcoming").innerHTML = (upcoming.results || []).map(discoverCardHTML).join("");
  } catch (e) {
    $("#discover-trending").innerHTML = $("#discover-upcoming").innerHTML =
      `<div class="text-sm text-rose-500">ошибка: ${escapeHtml(e.message)}</div>`;
  }

  // Recommendations
  const games = window.AppData.state.games;
  const top = games.filter(g => (g.rating||0) >= 8);
  if (!top.length) {
    $("#discover-recommend").innerHTML = "";
    $("#discover-recommend-hint").classList.remove("hidden");
    return;
  }
  const genreCount = new Map();
  top.forEach(g => (g.genres||[]).forEach(gn => {
    if (gn.slug) genreCount.set(gn.slug, (genreCount.get(gn.slug)||0) + 1);
  }));
  const topGenres = [...genreCount.entries()].sort((a,b) => b[1]-a[1]).slice(0,3).map(x => x[0]);
  if (!topGenres.length) {
    $("#discover-recommend").innerHTML = `<div class="text-sm text-zinc-500">Жанры не сохранены — добавь игры через поиск.</div>`;
    return;
  }
  try {
    const data = await rawg("/games", { genres: topGenres.join(","), ordering: "-rating", page_size: 16 }, 24*3600*1000);
    const existing = new Set(games.map(g => g.id));
    const filtered = (data.results || []).filter(g => !existing.has(g.id)).slice(0, 12);
    $("#discover-recommend").innerHTML = filtered.length
      ? filtered.map(discoverCardHTML).join("")
      : `<div class="text-sm text-zinc-500">Всё уже в твоей коллекции 🎯</div>`;
  } catch (e) {
    $("#discover-recommend").innerHTML = `<div class="text-sm text-rose-500">ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

// ============================================================
// PROFILE
// ============================================================
function renderProfile() {
  const games = window.AppData.state.games;
  const total   = games.length;
  const passed  = games.filter(g => g.status === "passed").length;
  const playing = games.filter(g => g.status === "playing").length;
  const rated   = games.filter(g => g.rating);
  const avg     = rated.length ? (rated.reduce((s,g) => s + g.rating, 0) / rated.length).toFixed(1) : "—";

  $("#profile-total").textContent   = total;
  $("#profile-passed").textContent  = passed;
  $("#profile-avg").textContent     = avg;
  $("#profile-playing").textContent = playing;

  renderRatingsChart(games);
  renderStatusChart(games);
  renderGenreChart(games);
  renderHeatmap(games);
  renderAchievements(games);
}

function renderRatingsChart(games) {
  const buckets = Array(10).fill(0);
  games.forEach(g => { if (g.rating) buckets[g.rating - 1]++; });
  const max = Math.max(1, ...buckets);
  $("#chart-ratings").innerHTML = `
    <div class="flex items-end gap-1 h-24">
      ${buckets.map(v => `<div class="flex-1 flex flex-col items-center gap-1"><div class="w-full rounded-t" style="height:${(v/max)*100}%; background: ${v ? "var(--accent)" : "#27272a"}; min-height: 2px;"></div></div>`).join("")}
    </div>
    <div class="flex items-center gap-1 mt-2">${buckets.map((v,i) => `<div class="flex-1 text-center font-mono text-[10px] text-zinc-500">${i+1}</div>`).join("")}</div>
    <div class="flex items-center gap-1 mt-0.5">${buckets.map(v => `<div class="flex-1 text-center font-mono text-[10px] ${v ? "accent" : "text-zinc-700"}">${v||""}</div>`).join("")}</div>`;
}

function renderStatusChart(games) {
  const counts = { passed: 0, playing: 0, dropped: 0, planned: 0 };
  games.forEach(g => { if (counts[g.status] !== undefined) counts[g.status]++; });
  const items = [
    { label: STATUS.passed.label,  color: "#a3e635", value: counts.passed  },
    { label: STATUS.playing.label, color: "#22d3ee", value: counts.playing },
    { label: STATUS.planned.label, color: "#f59e0b", value: counts.planned },
    { label: STATUS.dropped.label, color: "#71717a", value: counts.dropped }
  ];
  $("#chart-statuses").innerHTML = `
    <div class="flex-shrink-0">${makePieSvg(items)}</div>
    <div class="flex-1 space-y-1.5">
      ${items.map(i => `<div class="flex items-center gap-2 text-sm">
        <span class="dot" style="background:${i.color}"></span>
        <span class="flex-1 text-zinc-400">${i.label}</span>
        <span class="font-mono text-xs text-zinc-500">${i.value}</span>
      </div>`).join("")}
    </div>`;
}

function makePieSvg(items) {
  const total = items.reduce((s,i) => s + i.value, 0);
  if (!total) return `<svg viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="40" fill="#1a1a1d"/></svg>`;
  let angle = -90;
  const arcs = items.filter(i => i.value > 0).map(i => {
    const slice = (i.value / total) * 360;
    const start = angle * Math.PI / 180, end = (angle + slice) * Math.PI / 180;
    const x1 = 50 + 40 * Math.cos(start), y1 = 50 + 40 * Math.sin(start);
    const x2 = 50 + 40 * Math.cos(end),   y2 = 50 + 40 * Math.sin(end);
    const large = slice > 180 ? 1 : 0;
    angle += slice;
    return `<path d="M50 50 L${x1.toFixed(2)} ${y1.toFixed(2)} A40 40 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${i.color}"/>`;
  }).join("");
  return `<svg viewBox="0 0 100 100" width="100" height="100">${arcs}<circle cx="50" cy="50" r="22" fill="var(--panel)"/></svg>`;
}

function renderGenreChart(games) {
  const list = countGenres(games).slice(0, 6);
  if (!list.length) {
    $("#chart-genres").innerHTML = `<div class="text-sm text-zinc-500">Жанры подгрузятся, когда добавишь игры через поиск.</div>`;
    return;
  }
  const max = list[0].count;
  $("#chart-genres").innerHTML = list.map(g => `
    <div>
      <div class="flex justify-between text-xs mb-0.5"><span class="text-zinc-300">${escapeHtml(g.name)}</span><span class="font-mono text-zinc-500">${g.count}</span></div>
      <div class="h-1.5 rounded bg-zinc-900 overflow-hidden"><div class="h-full bg-accent" style="width:${(g.count/max)*100}%"></div></div>
    </div>`).join("");
}

function renderHeatmap(games) {
  const activity = {};
  games.forEach(g => {
    if (g.addedAt) {
      const d = new Date(g.addedAt);
      const k = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0");
      activity[k] = (activity[k] || 0) + 1;
    }
    if (g.passedAt) {
      const k = g.passedAt.slice(0,7);
      activity[k] = (activity[k] || 0) + 1;
    }
  });
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0"),
      label: d.toLocaleDateString("ru-RU", { month: "short" }),
      year: d.getFullYear()
    });
  }
  const max = Math.max(1, ...Object.values(activity));
  const level = (n) => !n ? 0 : n >= max*.75 ? 4 : n >= max*.5 ? 3 : n >= max*.25 ? 2 : 1;
  $("#chart-heatmap").innerHTML = `
    <div class="grid grid-cols-12 gap-1.5">
      ${months.map(m => { const n = activity[m.key] || 0; return `<div title="${m.label} ${m.year}: ${n}" class="heatmap-cell" data-level="${level(n)}"></div>`; }).join("")}
    </div>
    <div class="grid grid-cols-12 gap-1.5 mt-1">${months.map(m => `<div class="text-[10px] text-zinc-600 font-mono text-center">${m.label}</div>`).join("")}</div>`;
}

function renderAchievements(games) {
  $("#achievements").innerHTML = ACHIEVEMENTS.map(a => {
    const earned = a.test(games);
    return `<div class="panel-2 rounded-lg p-3 ${earned ? "" : "opacity-40"}">
      <div class="flex items-center justify-between mb-1">
        <span class="text-sm font-medium ${earned ? "accent" : "text-zinc-500"}">${a.title}</span>
        <span class="font-mono text-xs ${earned ? "accent" : "text-zinc-700"}">${earned ? "✓" : "—"}</span>
      </div>
      <div class="text-xs text-zinc-500">${a.desc}</div>
    </div>`;
  }).join("");
}

// ---------- Go ----------
init();
