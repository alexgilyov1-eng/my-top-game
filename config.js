/**
 * Заполни перед деплоем фронта. Значения берутся в Supabase:
 *   Settings → API
 *
 * Эти ключи безопасно держать в публичном коде — anon key защищён RLS,
 * а supabaseUrl всё равно виден в HTTP-запросах.
 */
window.APP_CONFIG = {
  supabaseUrl:      "https://evmkxvduhtxtqerewfvr.supabase.co",
  supabaseAnonKey:  "sb_publishable_ljbSyBbMZ5lWwQLHg_WuKA_mMZvvXla",

  // true → форсировать локальный режим (localStorage + ввод RAWG-ключа).
  // Полезно, чтобы потестить вёрстку в браузере без бэкенда.
  // В Telegram-режиме всё равно автоматически включится backend, если detected.
  forceLocal: false,
};
