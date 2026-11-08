import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { DateTime } from "luxon";
import type { AppEnv } from "../../env";
import { requireAdmin } from "../../lib/admin-auth";
import { availableSlots } from "../../lib/booking";
import { getSlotSettings } from "../../lib/settings";
import { formatSlot, isHhmm, isValidZone, WEEKDAYS_TR } from "../../lib/slots";
import { nowIso } from "../../lib/time";
import { AdminLayout } from "../../views/layout";

/** /admin/takvim: when customers can book. */
export const adminSchedule = new Hono<AppEnv>();
adminSchedule.use("*", requireAdmin);
adminSchedule.use("*", csrf());

type RuleRow = { id: number; weekday: number; start_time: string; end_time: string };
type OverrideRow = { id: number; date: string; type: "block" | "extra"; start_time: string | null; end_time: string | null; note: string | null };
type UpcomingRow = { id: number; start_utc: string; state: string; customer_tz: string; name: string | null; email: string; conversation_id: number | null };

const ZONES_TOP = ["Europe/Istanbul", "Europe/Amsterdam", "Europe/Berlin", "Europe/London"];
function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return ZONES_TOP;
  }
}

const adminName = (a: { author: string }) => (a.author === "gizem" ? "Gizem" : "Baran");
const MSG: Record<string, string> = {
  ayarlar: "Ayarlar kaydedildi.",
  kural: "Çalışma saati eklendi.",
  kuralsil: "Çalışma saati silindi.",
  istisna: "İstisna eklendi.",
  istisnasil: "İstisna silindi.",
};

async function page(c: { env: Env; get: (k: "admin") => { author: string } }, flash: { ok?: string; error?: string } = {}) {
  const db = c.env.DB;
  const [s, rules, overrides, upcoming, slots] = await Promise.all([
    getSlotSettings(db),
    db.prepare("SELECT id, weekday, start_time, end_time FROM availability_rules WHERE active = 1 ORDER BY weekday, start_time").all<RuleRow>(),
    db.prepare("SELECT id, date, type, start_time, end_time, note FROM date_overrides WHERE date >= date('now', '-1 day') ORDER BY date, start_time").all<OverrideRow>(),
    db.prepare(
      `SELECT b.id, b.start_utc, b.state, b.customer_tz, ct.name, ct.email, b.conversation_id
         FROM bookings b JOIN contacts ct ON ct.id = b.contact_id
        WHERE b.state IN ('confirmed', 'rescheduled') AND b.end_utc > ?1 ORDER BY b.start_utc LIMIT 100`,
    ).bind(nowIso()).all<UpcomingRow>(),
    availableSlots(db),
  ]);
  const tz = s.host_tz;
  const allZones = zones();

  return (
    "<!doctype html>" +
    (
      <AdminLayout title="Takvim" current="/admin/takvim" adminName={adminName(c.get("admin"))}>
        <header>
          <p class="eyebrow">Yönetim</p>
          <h1>Takvim</h1>
          <p class="lede">Müşterinin seçebileceği saatler: çalışma saatleri içindeki sabit başlangıç saatleri, istisnalar, mevcut randevular ve tamponlar çıkarıldıktan sonra. Saatler {tz} saat diliminde.</p>
        </header>
        {flash.ok && <p class="note" role="status">{flash.ok}</p>}
        {flash.error && <p class="form-error" role="alert">{flash.error}</p>}

        <section>
          <h2>Yaklaşan randevular</h2>
          {upcoming.results.length === 0 ? (
            <p class="small">Yaklaşan randevu yok.</p>
          ) : (
            <ul class="conv-list">
              {upcoming.results.map((b) => (
                <li>
                  <div class="row-item">
                    <span class="conv-top">
                      <span class="conv-name">
                        {b.conversation_id ? <a href={`/admin/konusma/${b.conversation_id}#danismanlik`}>{b.name ?? b.email}</a> : (b.name ?? b.email)}
                      </span>
                      {b.state === "rescheduled" && <span class="state">Saati değişti</span>}
                    </span>
                    <span class="conv-meta">{formatSlot(b.start_utc, tz)} · müşteri: {b.customer_tz}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>Açık saatler</h2>
          <p class="small">Şu an müşteriye gösterilen {slots.length} saat{slots.length ? ` (ilk ${Math.min(slots.length, 12)})` : ""}.</p>
          {slots.length > 0 && (
            <ul class="slot-preview">
              {slots.slice(0, 12).map((x) => <li>{formatSlot(x.start, tz, "d LLL ccc HH:mm")}</li>)}
            </ul>
          )}
        </section>

        <section>
          <h2>Haftalık çalışma saatleri</h2>
          {rules.results.length === 0 ? (
            <p class="small">Henüz çalışma saati yok; müşteri hiç saat göremez.</p>
          ) : (
            <ul class="conv-list">
              {rules.results.map((r) => (
                <li>
                  <div class="row-item row-inline">
                    <span>{WEEKDAYS_TR[r.weekday]} {r.start_time}–{r.end_time}</span>
                    <form method="post" action={`/admin/takvim/kural/${r.id}/sil`}>
                      <button class="btn-ghost btn-small" type="submit">Sil</button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <form class="form-stack" method="post" action="/admin/takvim/kural">
            <label for="k-gun">Gün</label>
            <select id="k-gun" name="gun">
              {WEEKDAYS_TR.map((d, i) => <option value={String(i)}>{d}</option>)}
            </select>
            <label for="k-bas">Başlangıç</label>
            <input id="k-bas" name="baslangic" type="time" required value="10:00" />
            <label for="k-bit">Bitiş</label>
            <input id="k-bit" name="bitis" type="time" required value="18:00" />
            <button class="btn btn-small" type="submit">Ekle</button>
          </form>
        </section>

        <section>
          <h2>İstisnalar</h2>
          <p class="small">“Kapalı” bir günü ya da saat aralığını kapatır (saat boşsa bütün gün). “Ek” normalde kapalı bir güne saat açar.</p>
          {overrides.results.length > 0 && (
            <ul class="conv-list">
              {overrides.results.map((o) => (
                <li>
                  <div class="row-item row-inline">
                    <span>
                      {DateTime.fromISO(o.date).setLocale("tr").toFormat("d LLLL yyyy cccc")} · {o.type === "block" ? "Kapalı" : "Ek"}
                      {o.start_time ? ` ${o.start_time}–${o.end_time}` : " (bütün gün)"}
                      {o.note ? ` · ${o.note}` : ""}
                    </span>
                    <form method="post" action={`/admin/takvim/istisna/${o.id}/sil`}>
                      <button class="btn-ghost btn-small" type="submit">Sil</button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <form class="form-stack" method="post" action="/admin/takvim/istisna">
            <label for="i-tarih">Tarih</label>
            <input id="i-tarih" name="tarih" type="date" required />
            <label for="i-tur">Tür</label>
            <select id="i-tur" name="tur">
              <option value="block">Kapalı</option>
              <option value="extra">Ek</option>
            </select>
            <label for="i-bas">Başlangıç <span class="opt">(kapalı günde boş = bütün gün)</span></label>
            <input id="i-bas" name="baslangic" type="time" />
            <label for="i-bit">Bitiş</label>
            <input id="i-bit" name="bitis" type="time" />
            <label for="i-not">Not <span class="opt">(isteğe bağlı)</span></label>
            <input id="i-not" name="not" type="text" maxlength={200} />
            <button class="btn btn-small" type="submit">Ekle</button>
          </form>
        </section>

        <section>
          <h2>Ayarlar</h2>
          <form class="form-stack" method="post" action="/admin/takvim/ayarlar">
            <label for="a-tz">Saat dilimi <span class="opt">(değişiklik mevcut randevuları etkilemez)</span></label>
            <select id="a-tz" name="host_tz">
              {[...ZONES_TOP, ...allZones.filter((z) => !ZONES_TOP.includes(z))].map((z) => <option value={z} selected={z === tz}>{z}</option>)}
            </select>
            <label for="a-saat">Başlangıç saatleri <span class="opt">(virgülle, ör. 10:00, 14:00, 16:00)</span></label>
            <input id="a-saat" name="slot_times" type="text" required value={s.slot_times.join(", ")} />
            <label for="a-min">En erken (saat sonrası)</label>
            <input id="a-min" name="min_notice_hours" type="number" min={0} max={720} required value={String(s.min_notice_hours)} />
            <label for="a-max">En geç (gün sonrası)</label>
            <input id="a-max" name="max_horizon_days" type="number" min={1} max={365} required value={String(s.max_horizon_days)} />
            <label for="a-once">Tampon önce (dk)</label>
            <input id="a-once" name="buffer_before_min" type="number" min={0} max={240} required value={String(s.buffer_before_min)} />
            <label for="a-sonra">Tampon sonra (dk)</label>
            <input id="a-sonra" name="buffer_after_min" type="number" min={0} max={240} required value={String(s.buffer_after_min)} />
            <label for="a-hafta">Haftada en fazla görüşme</label>
            <input id="a-hafta" name="max_per_week" type="number" min={0} max={50} required value={String(s.max_per_week)} />
            <button class="btn btn-small" type="submit">Kaydet</button>
          </form>
        </section>
      </AdminLayout>
    )
  );
}

adminSchedule.get("/", async (c) => {
  const k = c.req.query("kaydedildi");
  return c.html(await page(c, { ok: k ? MSG[k] : undefined }));
});

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const int = (v: unknown, lo: number, hi: number) => {
  const n = Number(str(v));
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

adminSchedule.post("/ayarlar", async (c) => {
  const b = await c.req.parseBody();
  const fail = async (error: string) => c.html(await page(c, { error }), 400);
  const tz = str(b.host_tz);
  if (!isValidZone(tz)) return fail("Geçersiz saat dilimi.");
  const times = str(b.slot_times).split(/[\s,]+/).filter(Boolean).map((t) => (/^\d:\d\d$/.test(t) ? `0${t}` : t));
  if (!times.length || !times.every(isHhmm)) return fail("Başlangıç saatleri SS:DD biçiminde olmalı (ör. 10:00, 14:00).");
  const nums = {
    min: int(b.min_notice_hours, 0, 720), max: int(b.max_horizon_days, 1, 365),
    before: int(b.buffer_before_min, 0, 240), after: int(b.buffer_after_min, 0, 240), week: int(b.max_per_week, 0, 50),
  };
  if (Object.values(nums).some((n) => n === null)) return fail("Sayı alanlarından biri geçersiz.");
  await c.env.DB.prepare(
    `UPDATE settings SET host_tz = ?1, slot_times_json = ?2, min_notice_hours = ?3, max_horizon_days = ?4,
            buffer_before_min = ?5, buffer_after_min = ?6, max_per_week = ?7, updated_at = ?8 WHERE id = 1`,
  ).bind(tz, JSON.stringify([...new Set(times)].sort()), nums.min, nums.max, nums.before, nums.after, nums.week, nowIso()).run();
  return c.redirect("/admin/takvim?kaydedildi=ayarlar", 303);
});

adminSchedule.post("/kural", async (c) => {
  const b = await c.req.parseBody();
  const day = int(b.gun, 0, 6);
  const start = str(b.baslangic);
  const end = str(b.bitis);
  if (day === null || !isHhmm(start) || !(isHhmm(end) || end === "24:00") || end <= start) {
    return c.html(await page(c, { error: "Gün ve saatleri kontrol et: bitiş başlangıçtan sonra olmalı." }), 400);
  }
  // Same rule twice adds nothing; skip it.
  await c.env.DB.prepare(
    `INSERT INTO availability_rules (weekday, start_time, end_time)
     SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM availability_rules WHERE weekday = ?1 AND start_time = ?2 AND end_time = ?3 AND active = 1)`,
  ).bind(day, start, end).run();
  return c.redirect("/admin/takvim?kaydedildi=kural", 303);
});

adminSchedule.post("/kural/:id{[0-9]+}/sil", async (c) => {
  await c.env.DB.prepare("DELETE FROM availability_rules WHERE id = ?1").bind(Number(c.req.param("id"))).run();
  return c.redirect("/admin/takvim?kaydedildi=kuralsil", 303);
});

adminSchedule.post("/istisna", async (c) => {
  const b = await c.req.parseBody();
  const date = str(b.tarih);
  const type = str(b.tur);
  const start = str(b.baslangic);
  const end = str(b.bitis);
  const note = str(b.not).slice(0, 200) || null;
  const fail = async (error: string) => c.html(await page(c, { error }), 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !DateTime.fromISO(date).isValid) return fail("Geçerli bir tarih seç.");
  if (type !== "block" && type !== "extra") return fail("Tür geçersiz.");
  const hasTimes = !!(start || end);
  if (hasTimes && (!isHhmm(start) || !(isHhmm(end) || end === "24:00") || end <= start)) return fail("Saatleri kontrol et: bitiş başlangıçtan sonra olmalı.");
  if (type === "extra" && !hasTimes) return fail("Ek gün için başlangıç ve bitiş saati gerekli.");
  await c.env.DB.prepare("INSERT INTO date_overrides (date, type, start_time, end_time, note) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(date, type, hasTimes ? start : null, hasTimes ? end : null, note).run();
  return c.redirect("/admin/takvim?kaydedildi=istisna", 303);
});

adminSchedule.post("/istisna/:id{[0-9]+}/sil", async (c) => {
  await c.env.DB.prepare("DELETE FROM date_overrides WHERE id = ?1").bind(Number(c.req.param("id"))).run();
  return c.redirect("/admin/takvim?kaydedildi=istisnasil", 303);
});
