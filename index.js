import express from "express";
import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";
import Database from "better-sqlite3";
import crypto from "crypto";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing in .env");

const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- DB ---
const db = new Database("users.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  lat REAL,
  lon REAL,
  method INTEGER DEFAULT 4,
  tz TEXT,
  reminders_enabled INTEGER DEFAULT 1,
  last_day_key TEXT,
  cached_timings_json TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS sent (
  user_id INTEGER,
  day_key TEXT,
  prayer_key TEXT,
  PRIMARY KEY(user_id, day_key, prayer_key)
);
`);

const upsertUser = db.prepare(`
INSERT INTO users (user_id, lat, lon, method, tz, reminders_enabled, updated_at)
VALUES (@user_id, @lat, @lon, @method, @tz, @reminders_enabled, @updated_at)
ON CONFLICT(user_id) DO UPDATE SET
  lat=excluded.lat,
  lon=excluded.lon,
  method=excluded.method,
  tz=excluded.tz,
  reminders_enabled=excluded.reminders_enabled,
  updated_at=excluded.updated_at
`);

const getAllUsers = db.prepare(`SELECT * FROM users WHERE reminders_enabled=1 AND lat IS NOT NULL AND lon IS NOT NULL`);
const markSent = db.prepare(`INSERT OR IGNORE INTO sent(user_id, day_key, prayer_key) VALUES (?, ?, ?)`);
const isSent = db.prepare(`SELECT 1 FROM sent WHERE user_id=? AND day_key=? AND prayer_key=? LIMIT 1`);

const updateCache = db.prepare(`
UPDATE users SET last_day_key=?, cached_timings_json=? WHERE user_id=?
`);

// --- Telegram bot (polling) ---
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, async (msg) => {
  const userId = msg.chat.id;
  await bot.sendMessage(
    userId,
    "Ассаляму алейкум 🤍\n\nЯ буду присылать напоминания за 15 минут до намаза.\nОткрой мини-апп и выбери город — и всё заработает ✅"
  );
});

bot.onText(/\/off/, async (msg) => {
  const userId = msg.chat.id;
  db.prepare(`UPDATE users SET reminders_enabled=0 WHERE user_id=?`).run(userId);
  await bot.sendMessage(userId, "Оповещения выключены. Включить: /on");
});

bot.onText(/\/on/, async (msg) => {
  const userId = msg.chat.id;
  db.prepare(`UPDATE users SET reminders_enabled=1 WHERE user_id=?`).run(userId);
  await bot.sendMessage(userId, "Оповещения включены ✅");
});

// ---------------------------
// SECURITY: verify initData from Telegram Mini App
// ---------------------------
function verifyTelegramInitData(initData) {
  // initData string: "query_id=...&user=...&auth_date=...&hash=..."
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no hash" };
  params.delete("hash");

  // build data_check_string
  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push([k, v]);
  pairs.sort(([a],[b]) => a.localeCompare(b));
  const dataCheckString = pairs.map(([k,v]) => `${k}=${v}`).join("\n");

  // secretKey = HMAC_SHA256("WebAppData", bot_token)
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) return { ok: false, reason: "hash mismatch" };

  // parse user
  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "no user" };
  let user;
  try { user = JSON.parse(userRaw); } catch { return { ok: false, reason: "bad user json" }; }

  return { ok: true, user };
}

// ---------------------------
// API from Mini App
// ---------------------------

// Save user settings from mini app
app.post("/api/save", async (req, res) => {
  const { initData, lat, lon, method } = req.body || {};
  if (!initData) return res.status(400).json({ ok:false, error:"initData required" });
  if (typeof lat !== "number" || typeof lon !== "number") return res.status(400).json({ ok:false, error:"lat/lon required" });

  const v = verifyTelegramInitData(initData);
  if (!v.ok) return res.status(401).json({ ok:false, error:"unauthorized: " + v.reason });

  const userId = v.user.id;

  // determine timezone using Aladhan meta.timezone (cheap and easy)
  const mId = Number(method || 4);
  let tz = null;
  try {
    const t = await fetchPrayerTimings(lat, lon, mId);
    tz = t.timezone || null;
  } catch (_) {}

  upsertUser.run({
    user_id: userId,
    lat,
    lon,
    method: mId,
    tz,
    reminders_enabled: 1,
    updated_at: Date.now()
  });

  // optional: send "linked" message
  try {
    await bot.sendMessage(userId, "Город сохранён ✅ Напоминания будут приходить за 15 минут до намаза.");
  } catch (_) {
    // user may not have pressed /start yet
  }

  res.json({ ok:true });
});

// Enable/disable reminders from mini app (optional)
app.post("/api/reminders", (req, res) => {
  const { initData, enabled } = req.body || {};
  if (!initData) return res.status(400).json({ ok:false, error:"initData required" });

  const v = verifyTelegramInitData(initData);
  if (!v.ok) return res.status(401).json({ ok:false, error:"unauthorized: " + v.reason });

  const userId = v.user.id;
  db.prepare(`UPDATE users SET reminders_enabled=? WHERE user_id=?`).run(enabled ? 1 : 0, userId);
  res.json({ ok:true });
});

app.get("/health", (_, res) => res.json({ ok:true }));

app.listen(PORT, () => console.log("Server listening on", PORT));

// ---------------------------
// Prayer timings: Aladhan
// ---------------------------
const PRAYERS = ["Fajr","Dhuhr","Asr","Maghrib","Isha"];

function dayKeyUTC(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,"0");
  const dd = String(d.getUTCDate()).padStart(2,"0");
  return `${y}${m}${dd}`;
}

async function fetchPrayerTimings(lat, lon, methodId) {
  const url = `https://api.aladhan.com/v1/timings?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&method=${encodeURIComponent(methodId)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("aladhan http " + r.status);
  const j = await r.json();
  const timings = j?.data?.timings;
  const tz = j?.data?.meta?.timezone || null;
  if (!timings) throw new Error("no timings");
  const out = {};
  for (const k of PRAYERS) {
    out[k] = String(timings[k] || "").slice(0,5); // "HH:MM"
  }
  return { timings: out, timezone: tz };
}

function toLocalDatePartsInTZ(date, timeZone) {
  // robust way without extra libs:
  // format parts in that timezone
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  });
  const parts = dtf.formatToParts(date);
  const get = (type) => parts.find(p => p.type === type)?.value;
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    hh: Number(get("hour")),
    mm: Number(get("minute")),
    ss: Number(get("second")),
  };
}

function makeDateInTZ(y, m, d, hh, mm, timeZone) {
  // Create a Date that corresponds to y-m-d hh:mm in that timezone.
  // Trick: start from UTC and adjust using formatter difference.
  const approxUTC = new Date(Date.UTC(y, m-1, d, hh, mm, 0, 0));
  // figure out what approxUTC is in that TZ, then correct delta
  const p = toLocalDatePartsInTZ(approxUTC, timeZone);
  const localAsUTC = Date.UTC(p.y, p.m-1, p.d, p.hh, p.mm, 0, 0);
  const targetAsUTC = Date.UTC(y, m-1, d, hh, mm, 0, 0);
  const diff = localAsUTC - targetAsUTC;
  return new Date(approxUTC.getTime() - diff);
}

// ---------------------------
// Scheduler: every minute
// ---------------------------
async function schedulerTick() {
  const users = getAllUsers.all();

  for (const u of users) {
    const methodId = Number(u.method || 4);

    // timezone: prefer cached tz, else fetch once
    let tz = u.tz;
    if (!tz) {
      try {
        const r = await fetchPrayerTimings(u.lat, u.lon, methodId);
        tz = r.timezone || "UTC";
        db.prepare(`UPDATE users SET tz=? WHERE user_id=?`).run(tz, u.user_id);
      } catch (_) {
        tz = "UTC";
      }
    }

    // current local date in user's TZ
    const now = new Date();
    const lp = toLocalDatePartsInTZ(now, tz);
    const localDayKey = `${lp.y}${String(lp.m).padStart(2,"0")}${String(lp.d).padStart(2,"0")}`;

    // load timings cache or fetch if day changed
    let timingsObj = null;
    if (u.last_day_key === localDayKey && u.cached_timings_json) {
      try { timingsObj = JSON.parse(u.cached_timings_json); } catch { timingsObj = null; }
    }
    if (!timingsObj) {
      try {
        const r = await fetchPrayerTimings(u.lat, u.lon, methodId);
        timingsObj = r.timings;
        updateCache.run(localDayKey, JSON.stringify(timingsObj), u.user_id);
      } catch (e) {
        continue;
      }
    }

    // build Date for each prayer in user's TZ for today
    for (const prayerKey of PRAYERS) {
      const hhmm = timingsObj[prayerKey];
      if (!hhmm || !hhmm.includes(":")) continue;

      const [hh, mm] = hhmm.split(":").map(n => Number(n));
      const prayerAt = makeDateInTZ(lp.y, lp.m, lp.d, hh, mm, tz);
      const fireAt = new Date(prayerAt.getTime() - 15 * 60 * 1000);

      // send window: now within [fireAt, fireAt+60s)
      if (now.getTime() >= fireAt.getTime() && now.getTime() < fireAt.getTime() + 60*1000) {
        if (isSent.get(u.user_id, localDayKey, prayerKey)) continue;

        const text = `🕌 Напоминание: через 15 минут ${prayerKey} (${hhmm})`;
        try {
          await bot.sendMessage(u.user_id, text);
          markSent.run(u.user_id, localDayKey, prayerKey);
        } catch (e) {
          // If user didn't /start or blocked the bot, send will fail
        }
      }
    }
  }
}

// start scheduler
setInterval(() => {
  schedulerTick().catch(() => {});
}, 60 * 1000);

// run once immediately
schedulerTick().catch(() => {});
