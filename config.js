/**
 * Заполни перед деплоем фронта. Значения берутся в Supabase:
 *   Settings → API
 *
 * Эти ключи безопасно держать в публичном коде — anon key защищён RLS,
 * а supabaseUrl всё равно виден в HTTP-запросах.
 */
window.APP_CONFIG = {
  supabaseUrl:      "https://evmkxvduhtxtqerewfvr.supabase.co",
  supabaseAnonKey:  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2bWt4dmR1aHR4dHFlcmV3ZnZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzMjA3NTAsImV4cCI6MjA5NTg5Njc1MH0.-78EZ7XWY-ZDNTJv0UVqiF0FFgBvOtiB7VrYK5GEmhA",

  // true → форсировать локальный режим (localStorage + ввод RAWG-ключа).
  // Полезно, чтобы потестить вёрстку в браузере без бэкенда.
  // В Telegram-режиме всё равно автоматически включится backend, если detected.
  forceLocal: false,
};
