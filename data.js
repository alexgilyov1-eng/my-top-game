/* ============================================================
 * data.js — единый асинхронный слой данных.
 *   - В Telegram WebApp → Supabase (через tg-auth JWT) + rawg-proxy.
 *   - Иначе              → localStorage + прямой fetch к RAWG.
 *
 * UI пишет в state синхронно через addGame/updateGame/…, и эти же
 * вызовы фоном синкаются в бэкенд. Чтения берут готовые массивы
 * из state.games / state.collections.
 * ============================================================ */
(function () {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const tgWA = window.Telegram?.WebApp;
  const inTelegram = !!(tgWA && tgWA.initData) && !CFG.forceLocal;

  const state = {
    mode: inTelegram ? "tg" : "local",
    user: null,
    games: [],
    collections: [],
    error: null,
  };

  // ===================== Utilities =====================
  function err(msg, raw) { const e = new Error(msg); e.raw = raw; return e; }

  // Generates a UUID-ish id for local collections.
  function localId(prefix) { return prefix + Date.now() + "-" + Math.random().toString(36).slice(2, 7); }

  // ===================== Local storage backend =====================
  const local = {
    async bootstrap() {
      state.games       = JSON.parse(localStorage.getItem("games")       || "[]");
      state.collections = JSON.parse(localStorage.getItem("collections") || "[]");
    },
    saveGames()       { localStorage.setItem("games",       JSON.stringify(state.games)); },
    saveCollections() { localStorage.setItem("collections", JSON.stringify(state.collections)); },

    async addGame(g)        { state.games.push(g); this.saveGames(); },
    async updateGame(id, p) { const i = state.games.findIndex(x => x.id === id); if (i >= 0) state.games[i] = { ...state.games[i], ...p }; this.saveGames(); },
    async removeGame(id)    {
      state.games = state.games.filter(x => x.id !== id);
      state.collections = state.collections.map(c => ({ ...c, gameIds: c.gameIds.filter(g => g !== id) }));
      this.saveGames(); this.saveCollections();
    },
    async reorderGames(orderedIds) {
      const orderMap = new Map(orderedIds.map((id, i) => [id, i]));
      state.games.forEach(g => { if (orderMap.has(g.id)) g.manualOrder = orderMap.get(g.id); });
      this.saveGames();
    },

    async addCollection(c) {
      const coll = { id: localId("c"), name: c.name, desc: c.desc || "", gameIds: [], createdAt: Date.now() };
      state.collections.push(coll); this.saveCollections(); return coll;
    },
    async updateCollection(id, patch) {
      const c = state.collections.find(x => x.id === id);
      if (c) { Object.assign(c, patch); this.saveCollections(); }
    },
    async removeCollection(id) {
      state.collections = state.collections.filter(c => c.id !== id);
      this.saveCollections();
    },
    async addGameToCollection(collId, rawgId) {
      const c = state.collections.find(x => x.id === collId);
      if (c && !c.gameIds.includes(rawgId)) { c.gameIds.push(rawgId); this.saveCollections(); }
    },
    async removeGameFromCollection(collId, rawgId) {
      const c = state.collections.find(x => x.id === collId);
      if (c) { c.gameIds = c.gameIds.filter(x => x !== rawgId); this.saveCollections(); }
    },
    async reorderCollectionGames(collId, orderedIds) {
      const c = state.collections.find(x => x.id === collId);
      if (c) { c.gameIds = orderedIds.slice(); this.saveCollections(); }
    },

    async rawg(path, params) {
      const key = localStorage.getItem("rawg_key");
      if (!key) throw err("Нужен RAWG ключ (⚙ настройки)");
      const u = new URL("https://api.rawg.io/api" + path);
      Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
      u.searchParams.set("key", key);
      const r = await fetch(u);
      if (!r.ok) throw err("RAWG HTTP " + r.status);
      return r.json();
    },
  };

  // ===================== Telegram + Supabase backend =====================
  const tgBackend = {
    _token: null,

    async bootstrap() {
      if (!CFG.supabaseUrl || CFG.supabaseUrl.startsWith("https://YOUR-")) {
        throw err("config.js не заполнен — нужно вставить supabaseUrl и supabaseAnonKey");
      }
      // 1. Exchange initData for JWT
      const r = await fetch(CFG.supabaseUrl + "/functions/v1/tg-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: CFG.supabaseAnonKey },
        body: JSON.stringify({ initData: tgWA.initData }),
      });
      if (!r.ok) {
        const t = await r.text(); throw err("Auth failed: " + r.status + " " + t);
      }
      const { token, user } = await r.json();
      this._token = token;
      state.user = user;

      // 2. Load games + collections in parallel
      const [games, colls] = await Promise.all([
        this.sb("GET", "/games?select=*&order=manual_order.asc"),
        this.sb("GET", "/collections?select=*,collection_games(position,games(rawg_id))&order=created_at.asc"),
      ]);
      state.games       = (games || []).map(fromDbGame);
      state.collections = (colls || []).map(c => ({
        id:        c.id,
        name:      c.name,
        desc:      c.description || "",
        gameIds:   (c.collection_games || [])
                      .sort((a, b) => a.position - b.position)
                      .map(x => x.games?.rawg_id)
                      .filter(Boolean),
        createdAt: c.created_at ? new Date(c.created_at).getTime() : Date.now(),
      }));
    },

    sb(method, pathQ, body) {
      return fetch(CFG.supabaseUrl + "/rest/v1" + pathQ, {
        method,
        headers: {
          apikey: CFG.supabaseAnonKey,
          Authorization: "Bearer " + this._token,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: body ? JSON.stringify(body) : undefined,
      }).then(async r => {
        if (r.status === 204) return null;
        const text = await r.text();
        if (!r.ok) throw err("Supabase " + r.status + ": " + text, text);
        return text ? JSON.parse(text) : null;
      });
    },

    // ---------- games ----------
    async addGame(g) {
      state.games.push(g);
      const row = toDbGame(g);
      const rows = await this.sb("POST", "/games", row);
      // Replace optimistic insert with real row to capture dbId
      if (rows && rows[0]) {
        const i = state.games.findIndex(x => x.id === g.id);
        if (i >= 0) state.games[i] = { ...state.games[i], dbId: rows[0].id };
      }
    },
    async updateGame(rawgId, patch) {
      const i = state.games.findIndex(x => x.id === rawgId);
      if (i < 0) return;
      state.games[i] = { ...state.games[i], ...patch };
      const dbPatch = {};
      if ("rating"   in patch) dbPatch.rating    = patch.rating;
      if ("status"   in patch) dbPatch.status    = patch.status;
      if ("note"     in patch) dbPatch.note      = patch.note;
      if ("passedAt" in patch) dbPatch.passed_at = patch.passedAt;
      await this.sb("PATCH", "/games?rawg_id=eq." + rawgId, dbPatch);
    },
    async removeGame(rawgId) {
      state.games = state.games.filter(x => x.id !== rawgId);
      state.collections.forEach(c => c.gameIds = c.gameIds.filter(g => g !== rawgId));
      await this.sb("DELETE", "/games?rawg_id=eq." + rawgId);
      // Junction rows are removed by ON DELETE CASCADE.
    },
    async reorderGames(orderedIds) {
      const orderMap = new Map(orderedIds.map((id, i) => [id, i]));
      // Update local state first
      state.games.forEach(g => { if (orderMap.has(g.id)) g.manualOrder = orderMap.get(g.id); });
      // Bulk PATCH — Supabase doesn't have native bulk-by-id update without RPC,
      // so we issue parallel patches. Acceptable for <500 items.
      await Promise.all(orderedIds.map((id, i) =>
        this.sb("PATCH", "/games?rawg_id=eq." + id, { manual_order: i })
      ));
    },

    // ---------- collections ----------
    async addCollection({ name, desc }) {
      const rows = await this.sb("POST", "/collections", { name, description: desc || null });
      const row = rows && rows[0];
      const coll = {
        id: row.id, name: row.name, desc: row.description || "",
        gameIds: [], createdAt: new Date(row.created_at).getTime(),
      };
      state.collections.push(coll);
      return coll;
    },
    async updateCollection(id, patch) {
      const c = state.collections.find(x => x.id === id);
      if (c) Object.assign(c, patch);
      const dbPatch = {};
      if ("name" in patch) dbPatch.name = patch.name;
      if ("desc" in patch) dbPatch.description = patch.desc;
      await this.sb("PATCH", "/collections?id=eq." + id, dbPatch);
    },
    async removeCollection(id) {
      state.collections = state.collections.filter(c => c.id !== id);
      await this.sb("DELETE", "/collections?id=eq." + id);
    },
    async addGameToCollection(collId, rawgId) {
      const c = state.collections.find(x => x.id === collId);
      if (!c || c.gameIds.includes(rawgId)) return;
      const game = state.games.find(g => g.id === rawgId);
      if (!game?.dbId) throw err("Игра не сохранена в БД");
      c.gameIds.push(rawgId);
      await this.sb("POST", "/collection_games",
        { collection_id: collId, game_id: game.dbId, position: c.gameIds.length - 1 });
    },
    async removeGameFromCollection(collId, rawgId) {
      const c = state.collections.find(x => x.id === collId);
      if (!c) return;
      const game = state.games.find(g => g.id === rawgId);
      c.gameIds = c.gameIds.filter(x => x !== rawgId);
      if (game?.dbId) {
        await this.sb("DELETE",
          "/collection_games?collection_id=eq." + collId + "&game_id=eq." + game.dbId);
      }
    },
    async reorderCollectionGames(collId, orderedIds) {
      const c = state.collections.find(x => x.id === collId);
      if (!c) return;
      c.gameIds = orderedIds.slice();
      await Promise.all(orderedIds.map((rawgId, i) => {
        const game = state.games.find(g => g.id === rawgId);
        if (!game?.dbId) return Promise.resolve();
        return this.sb("PATCH",
          "/collection_games?collection_id=eq." + collId + "&game_id=eq." + game.dbId,
          { position: i });
      }));
    },

    async rawg(path, params) {
      const u = new URL(CFG.supabaseUrl + "/functions/v1/rawg-proxy");
      u.searchParams.set("path", path);
      Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
      const r = await fetch(u, {
        headers: {
          apikey: CFG.supabaseAnonKey,
          Authorization: "Bearer " + this._token,
        },
      });
      if (!r.ok) {
        const t = await r.text(); throw err("rawg-proxy " + r.status + " " + t);
      }
      return r.json();
    },
  };

  // ----- DB row mapping -----
  function fromDbGame(row) {
    return {
      id:           row.rawg_id,
      dbId:         row.id,
      name:         row.name,
      released:     row.released,
      cover:        row.cover,
      genres:       row.genres || [],
      platforms:    row.platforms || [],
      metacritic:   row.metacritic,
      rating:       row.rating,
      status:       row.status,
      note:         row.note || "",
      passedAt:     row.passed_at,
      manualOrder:  row.manual_order ?? 0,
      addedAt:      row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    };
  }
  function toDbGame(g) {
    return {
      rawg_id:      g.id,
      name:         g.name,
      released:     g.released || null,
      cover:        g.cover || null,
      genres:       g.genres || null,
      platforms:    g.platforms || null,
      metacritic:   g.metacritic ?? null,
      rating:       g.rating ?? null,
      status:       g.status || null,
      note:         g.note || null,
      passed_at:    g.passedAt || null,
      manual_order: g.manualOrder ?? 0,
    };
  }

  // ===================== Public API =====================
  const backend = inTelegram ? tgBackend : local;

  window.AppData = {
    state,

    async bootstrap() {
      try {
        await backend.bootstrap();
        return true;
      } catch (e) {
        state.error = e.message;
        console.error("[AppData] bootstrap failed:", e);
        // In Telegram mode we cannot proceed; in local mode we just start empty.
        if (state.mode === "local") return true;
        return false;
      }
    },

    // Pass-through to chosen backend
    addGame:                 (g)         => backend.addGame(g),
    updateGame:              (id, p)     => backend.updateGame(id, p),
    removeGame:              (id)        => backend.removeGame(id),
    reorderGames:            (ids)       => backend.reorderGames(ids),
    addCollection:           (c)         => backend.addCollection(c),
    updateCollection:        (id, p)     => backend.updateCollection(id, p),
    removeCollection:        (id)        => backend.removeCollection(id),
    addGameToCollection:     (cid, rid)  => backend.addGameToCollection(cid, rid),
    removeGameFromCollection:(cid, rid)  => backend.removeGameFromCollection(cid, rid),
    reorderCollectionGames:  (cid, ids)  => backend.reorderCollectionGames(cid, ids),
    rawg:                    (p, params) => backend.rawg(p, params),
  };
})();
