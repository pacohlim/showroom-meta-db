/**
 * NETOGREEN - Meta Showroom Reservation API
 * - Cloudflare Workers + D1
 * - Aligo Alimtalk (UE_6466/UE_6467/UE_6470) + failover SMS
 * - Resend email to paco@netogreenkr.com with .ics attachment
 * - Cron (scheduled) sends D-1 and D-day reminders
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS (원하면 Firebase 도메인으로 제한 가능)
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (path === "/api/health") return json({ ok: true }, cors);

      if (path === "/api/calendar" && request.method === "GET") {
        const yyyy = toInt(url.searchParams.get("yyyy"));
        const mm = toInt(url.searchParams.get("mm"));
        if (!yyyy || !mm || mm < 1 || mm > 12) return json({ error: "invalid yyyy/mm" }, cors, 400);
        const data = await buildCalendar(env.DB, yyyy, mm);
        return json(data, cors);
      }

      if (path === "/api/times" && request.method === "GET") {
        const date = url.searchParams.get("date");
        if (!isYMD(date)) return json({ error: "invalid date" }, cors, 400);

        const times = allowedTimesForDate(date);
        const closed = await getClosedTimes(env.DB, date);
        const available = times.filter((t) => !closed.includes(t));

        return json({ date, times, closed, available }, cors);
      }

      if (path === "/api/reserve" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));

        const date = body?.date;
        const time = body?.time;
        const name = (body?.name || "").trim();
        const phone = digitsOnly(body?.phone || "");
        const password = String(body?.password || "").trim();
        const landAddress = (body?.landAddress || "").trim();
        const notes = (body?.notes || "").trim();

        const utm_source = (body?.utm_source || "").trim();
        const utm_medium = (body?.utm_medium || "").trim();
        const utm_campaign = (body?.utm_campaign || "").trim();

        if (!isYMD(date)) return json({ error: "invalid date" }, cors, 400);
        if (!isHM(time)) return json({ error: "invalid time" }, cors, 400);
        if (name.length < 2) return json({ error: "name required" }, cors, 400);
        if (phone.length < 9) return json({ error: "phone required" }, cors, 400);
        if (password.length < 4) return json({ error: "password(>=4) required" }, cors, 400);

        const allowed = allowedTimesForDate(date);
        if (!allowed.includes(time)) return json({ error: "time not allowed for that date" }, cors, 400);

        const id = crypto.randomUUID();
        const createdAt = new Date().toISOString();

        // 1) DB insert (중복 예약 차단: unique index)
        try {
          await env.DB.batch([
            env.DB.prepare("BEGIN"),
            env.DB.prepare(
              `INSERT INTO reservations
               (id, created_at, source, utm_source, utm_medium, utm_campaign,
                date, time, name, phone, password, land_address, notes, status)
               VALUES (?, ?, 'meta', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked')`
            ).bind(
              id,
              createdAt,
              emptyToNull(utm_source),
              emptyToNull(utm_medium),
              emptyToNull(utm_campaign),
              date,
              time,
              name,
              phone,
              password,
              emptyToNull(landAddress),
              emptyToNull(notes)
            ),
            env.DB.prepare("COMMIT"),
          ]);
        } catch (e) {
          try { await env.DB.prepare("ROLLBACK").run(); } catch {}
          const msg = String(e?.message || e);
          if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("constraint")) {
            return json({ error: "already booked" }, cors, 409);
          }
          return json({ error: "db error", detail: msg }, cors, 500);
        }

        // 2) 알림톡(확정) - 실패해도 예약은 유지
        try {
          await sendConfirmAlimtalk(env, { name, phone, date, time });
          await env.DB.prepare(
            `UPDATE reservations SET notify_confirm_at=?, notify_last_error=NULL WHERE id=?`
          ).bind(new Date().toISOString(), id).run();
        } catch (e) {
          await env.DB.prepare(
            `UPDATE reservations SET notify_last_error=? WHERE id=?`
          ).bind(String(e?.message || e), id).run();
        }

        // 3) 관리자 메일(Resend + ICS) - 실패해도 예약은 유지
        try {
          await sendAdminEmailWithICS(env, { id, date, time, name, phone, landAddress, notes });
          await env.DB.prepare(
            `UPDATE reservations SET email_sent_at=?, email_last_error=NULL WHERE id=?`
          ).bind(new Date().toISOString(), id).run();
        } catch (e) {
          await env.DB.prepare(
            `UPDATE reservations SET email_last_error=? WHERE id=?`
          ).bind(String(e?.message || e), id).run();
        }

        return json({ ok: true, id }, cors);
      }

      if (path === "/api/my" && request.method === "GET") {
        const name = (url.searchParams.get("name") || "").trim();
        const phone = digitsOnly(url.searchParams.get("phone") || "");
        const password = (url.searchParams.get("password") || "").trim();
        if (!name || !phone || !password) return json({ error: "name/phone/password required" }, cors, 400);

        const rs = await env.DB.prepare(
          `SELECT id, created_at, date, time, status
           FROM reservations
           WHERE name=? AND phone=? AND password=?
           ORDER BY created_at DESC
           LIMIT 20`
        ).bind(name, phone, password).all();

        return json({ ok: true, items: rs.results || [] }, cors);
      }

      if (path === "/api/cancel" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const id = String(body?.id || "").trim();
        const name = (body?.name || "").trim();
        const phone = digitsOnly(body?.phone || "");
        const password = String(body?.password || "").trim();
        if (!id || !name || !phone || !password) return json({ error: "id/name/phone/password required" }, cors, 400);

        const r = await env.DB.prepare(
          `UPDATE reservations
           SET status='canceled'
           WHERE id=? AND name=? AND phone=? AND password=? AND status='booked'`
        ).bind(id, name, phone, password).run();

        if ((r.meta?.changes || 0) < 1) return json({ error: "not found or already canceled" }, cors, 404);
        return json({ ok: true }, cors);
      }

      return json({ error: "not found" }, cors, 404);
    } catch (e) {
      return json({ error: "server error", detail: String(e?.message || e) }, cors, 500);
    }
  },

  // Cron Triggers -> scheduled handler
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
};

/* -------------------- 공통 유틸 -------------------- */
function json(obj, headers = {}, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}
function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function isYMD(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function isHM(s) {
  return typeof s === "string" && /^\d{2}:\d{2}$/.test(s);
}
function digitsOnly(s) {
  return String(s).replace(/\D/g, "");
}
function emptyToNull(v) {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

/* -------------------- 예약 시간 규칙 -------------------- */
/* 월~금: 13:00, 15:00 / 토: 14:00, 16:00 / 일: 없음 */
function allowedTimesForDate(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`); // 날짜만 쓰므로 UTC로 충분
  const dow = d.getUTCDay(); // 0=Sun ... 6=Sat
  if (dow === 0) return [];
  if (dow === 6) return ["14:00", "16:00"];
  return ["13:00", "15:00"];
}
async function getClosedTimes(db, ymd) {
  const r = await db.prepare(
    `SELECT time FROM reservations WHERE date=? AND status='booked'`
  ).bind(ymd).all();
  return (r.results || []).map((x) => x.time);
}

/* -------------------- 달력 생성(6주 42칸) -------------------- */
async function buildCalendar(db, yyyy, mm) {
  const first = new Date(Date.UTC(yyyy, mm - 1, 1));
  const start = new Date(first);
  start.setUTCDate(first.getUTCDate() - first.getUTCDay()); // 그 주 일요일

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const cur = new Date(start);
    cur.setUTCDate(start.getUTCDate() + i);

    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
    const d = String(cur.getUTCDate()).padStart(2, "0");
    const ymd = `${y}-${m}-${d}`;

    const allowed = allowedTimesForDate(ymd);
    let timeStr = "";
    if (allowed.length) {
      const closed = await getClosedTimes(db, ymd);
      const available = allowed.filter((t) => !closed.includes(t));
      timeStr = available.join("\n");
    }

    const cm = (cur.getUTCMonth() + 1 === mm) ? 0 : (cur < first ? -1 : 1);
    cells.push({ date: ymd, time: timeStr, cm, ann: null });
  }

  const prevDate = new Date(Date.UTC(yyyy, mm - 2, 1));
  const nextDate = new Date(Date.UTC(yyyy, mm, 1));

  return {
    yyyy,
    mm: String(mm).padStart(2, "0"),
    prev: { yyyy: prevDate.getUTCFullYear(), mm: String(prevDate.getUTCMonth() + 1).padStart(2, "0") },
    next: { yyyy: nextDate.getUTCFullYear(), mm: String(nextDate.getUTCMonth() + 1).padStart(2, "0") },
    dates: cells,
  };
}

/* -------------------- 알리고 알림톡 -------------------- */
async function aligoGetToken(env) {
  const url = "https://kakaoapi.aligo.in/akv10/token/create/30/s/";
  const form = new URLSearchParams({ apikey: env.ALIGO_APIKEY, userid: env.ALIGO_USERID });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ALIGO token HTTP ${res.status}`);
  if (data.code !== 0 || !data.token) throw new Error(`ALIGO token fail: ${data.message || "unknown"}`);
  return data.token;
}
function fillVars(templateText, vars) {
  let msg = templateText;
  for (const [k, v] of Object.entries(vars)) msg = msg.replaceAll(`#{${k}}`, String(v ?? ""));
  return msg;
}

const TPL_TEXT_CONFIRM = `돈버는 농사 파트너 네토그린의
스마트팜을 경험해보세요!

#{고객명} 고객님의 예약이 확정되었습니다.

▶ 일시
#{예약일} #{예약시} 

▶ 주소
경기 화성시 동탄첨단산업1로 14
동탄K밸리 312호

▶ 문의 
대표번호 :  010-8257-8007

- 무료 주차 가능`;

const TPL_TEXT_D1 = `돈버는 농사 파트너 네토그린의
스마트팜을 경험해보세요!

내일은 #{고객명} 고객님의 예약일 입니다.

▶ 일시
#{예약일} #{예약시} 

▶ 주소
경기 화성시 동탄첨단산업1로 14
동탄K밸리 312호

▶ 문의 
대표번호 :  010-8257-8007

- 무료 주차 가능`;

const TPL_TEXT_D0 = `안녕하세요 #{고객명} 고객님
오늘은 네토그린 쇼룸 방문일 입니다.

▶ 일시
#{예약일} #{예약시} 

▶ 주소
경기 화성시 동탄첨단산업1로 14
동탄K밸리 312호 

▶ 문의 
대표번호 : 010-8257-8007

- 무료 주차 가능`;

async function aligoSendAlimtalk(env, { tpl_code, receiver, subject, message }) {
  const token = await aligoGetToken(env);

  const form = new URLSearchParams({
    apikey: env.ALIGO_APIKEY,
    userid: env.ALIGO_USERID,
    token,
    senderkey: env.ALIGO_SENDERKEY,
    tpl_code,
    sender: env.ALIGO_SENDER,
    receiver_1: receiver,
    subject_1: subject,
    message_1: message,
  });

  if ((env.ALIGO_FAILOVER || "").toUpperCase() === "Y") {
    form.set("failover", "Y");
  }

  const res = await fetch("https://kakaoapi.aligo.in/akv10/alimtalk/send/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ALIGO send HTTP ${res.status}`);
  if (data.code !== 0) throw new Error(`ALIGO send fail: ${data.message || "unknown"}`);
  return data;
}

async function sendConfirmAlimtalk(env, { name, phone, date, time }) {
  const msg = fillVars(TPL_TEXT_CONFIRM, { "고객명": name, "예약일": date, "예약시": time });
  await aligoSendAlimtalk(env, {
    tpl_code: env.ALIGO_TPL_CONFIRM,
    receiver: phone,
    subject: "쇼룸 예약 확정",
    message: msg,
  });
}

async function sendReminderAlimtalk(env, { kind, name, phone, date, time }) {
  const isD1 = kind === "D1";
  const tpl = isD1 ? env.ALIGO_TPL_D1 : env.ALIGO_TPL_D0;
  const subject = isD1 ? "내일 쇼룸 방문 안내" : "오늘 쇼룸 방문 안내";
  const template = isD1 ? TPL_TEXT_D1 : TPL_TEXT_D0;

  const msg = fillVars(template, { "고객명": name, "예약일": date, "예약시": time });
  await aligoSendAlimtalk(env, { tpl_code: tpl, receiver: phone, subject, message: msg });
}

/* -------------------- Resend 메일 + ICS -------------------- */
function escapeICS(s) {
  return String(s || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}
function toICSStampUTC(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
function toLocalICS(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}
function buildICS({ uid, title, startLocal, endLocal, location, description }) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NETOGREEN//Meta Showroom//KR",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toICSStampUTC(new Date())}`,
    `DTSTART:${startLocal}`,
    `DTEND:${endLocal}`,
    `SUMMARY:${escapeICS(title)}`,
    `LOCATION:${escapeICS(location)}`,
    `DESCRIPTION:${escapeICS(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}
function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function sendAdminEmailWithICS(env, booking) {
  const to = env.ADMIN_EMAIL_TO || "paco@netogreenkr.com";
  const from = env.RESEND_FROM;
  if (!env.RESEND_API_KEY) throw new Error("missing RESEND_API_KEY");
  if (!from) throw new Error("missing RESEND_FROM");

  const subject = `[META 쇼룸예약] ${booking.date} ${booking.time} / ${booking.name}`;

  const safeNotes = String(booking.notes || "-")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  const html = `
    <h3>메타 전용 쇼룸 예약</h3>
    <ul>
      <li><b>일시</b>: ${booking.date} ${booking.time}</li>
      <li><b>이름</b>: ${booking.name}</li>
      <li><b>전화</b>: ${booking.phone}</li>
      <li><b>설치 희망 주소</b>: ${booking.landAddress || "-"}</li>
      <li><b>요청사항</b>: ${safeNotes}</li>
    </ul>
    <p>이 메일에는 캘린더(.ics) 초대장이 첨부되어 있습니다.</p>
  `;

  const start = new Date(`${booking.date}T${booking.time}:00+09:00`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  const ics = buildICS({
    uid: booking.id,
    title: `네토그린 쇼룸 방문 (${booking.name})`,
    startLocal: toLocalICS(start),
    endLocal: toLocalICS(end),
    location: "경기 화성시 동탄첨단산업1로 14, 동탄K밸리 312호",
    description: `예약자: ${booking.name}\n전화: ${booking.phone}\n(메타 전용 예약)\n`,
  });

  const payload = {
    from,
    to: [to],
    subject,
    html,
    attachments: [
      {
        filename: "netogreen-showroom.ics",
        content: b64utf8(ics),
        contentType: "text/calendar; charset=utf-8; method=REQUEST",
      },
    ],
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`RESEND send failed HTTP ${res.status}: ${t}`);
  }
}

/* -------------------- Cron: D-1 / D-day 자동 발송 -------------------- */
async function runReminders(env) {
  // KST 기준 날짜 문자열 생성
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  const today = `${y}-${m}-${d}`;

  const tomorrowDate = new Date(Date.UTC(y, kst.getUTCMonth(), kst.getUTCDate() + 1));
  const ty = tomorrowDate.getUTCFullYear();
  const tm = String(tomorrowDate.getUTCMonth() + 1).padStart(2, "0");
  const td = String(tomorrowDate.getUTCDate()).padStart(2, "0");
  const tomorrow = `${ty}-${tm}-${td}`;

  await sendBatch(env, { date: tomorrow, kind: "D1", markCol: "notify_d1_at" });
  await sendBatch(env, { date: today, kind: "D0", markCol: "notify_d0_at" });
}

async function sendBatch(env, { date, kind, markCol }) {
  const rows = await env.DB.prepare(
    `SELECT id, name, phone, date, time
     FROM reservations
     WHERE status='booked' AND date=? AND ${markCol} IS NULL
     LIMIT 200`
  ).bind(date).all();

  for (const r of (rows.results || [])) {
    try {
      await sendReminderAlimtalk(env, { kind, name: r.name, phone: r.phone, date: r.date, time: r.time });
      await env.DB.prepare(
        `UPDATE reservations SET ${markCol}=?, notify_last_error=NULL WHERE id=?`
      ).bind(new Date().toISOString(), r.id).run();
    } catch (e) {
      await env.DB.prepare(
        `UPDATE reservations SET notify_last_error=? WHERE id=?`
      ).bind(String(e?.message || e), r.id).run();
    }
  }
}
