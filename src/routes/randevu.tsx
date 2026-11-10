import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { DateTime } from "luxon";
import type { AppEnv } from "../env";
import {
  bookSlot, cancelBooking, CONSULT, fulfillConsult, isLive, loadIntent, offeredSlots, policy, rescheduleBooking,
  type Booking, type Intent,
} from "../lib/booking";
import { buildIcs } from "../lib/ics";
import { getHostTz } from "../lib/settings";
import { formatSlot, isValidZone, SESSION_MINUTES, type Slot } from "../lib/slots";
import { retrieveCheckoutSession } from "../lib/stripe";
import { MessagePage, SiteLayout } from "../views/layout";

/** Consulting after payment: /odeme/tamam, /randevu/{token}, /randevu/{token}/degistir. */
export const randevu = new Hono<AppEnv>();
// Mounted at "/": middleware stays scoped to these paths.
randevu.use("/randevu/*", csrf());
for (const p of ["/randevu/*", "/odeme/*"]) {
  randevu.use(p, async (c, next) => {
    await next();
    // The URL is the credential.
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex, nofollow");
  });
}

const TOKEN = "{[A-Za-z0-9_-]{32}}";
const html = (el: unknown) => "<!doctype html>" + String(el);

const notFound = () =>
  html(
    <MessagePage title="Bulunamadı" eyebrow="Randevu" heading="Bu bağlantı geçersiz"
      text="Bağlantı e-postadan kopyalanırken eksik kalmış olabilir. Sorun sürerse merhaba@uceksen.com adresine yaz."
      back={["/", "← Ana sayfa"]} />,
  );

// --- Time zones ------------------------------------------------------------------------------

const COMMON_ZONES = [
  "Europe/Istanbul", "Europe/Amsterdam", "Europe/Berlin", "Europe/Brussels", "Europe/Paris", "Europe/Vienna",
  "Europe/Zurich", "Europe/London", "Europe/Madrid", "Europe/Lisbon", "Europe/Rome", "Europe/Stockholm", "Europe/Athens",
];
function allZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return COMMON_ZONES;
  }
}
const zoneLabel = (z: string) => z.replace(/_/g, " ");

function TzForm({ tz, action }: { tz: string; action: string }) {
  const rest = allZones().filter((z) => !COMMON_ZONES.includes(z));
  return (
    <form class="tz-form" method="get" action={action}>
      <label for="tz">Saat dilimi</label>
      <select id="tz" name="tz" data-autosubmit>
        <optgroup label="Sık kullanılan">
          {COMMON_ZONES.map((z) => <option value={z} selected={z === tz}>{zoneLabel(z)}</option>)}
        </optgroup>
        <optgroup label="Tümü">
          {rest.map((z) => <option value={z} selected={z === tz}>{zoneLabel(z)}</option>)}
        </optgroup>
      </select>
      <button class="btn-ghost btn-small" type="submit">Göster</button>
    </form>
  );
}

function SlotPicker({ slots, tz, action, button, error, extra, problem }: { slots: Slot[]; tz: string; action: string; button: string; error?: string; extra?: unknown; problem?: boolean }) {
  const days = new Map<string, Slot[]>();
  for (const s of slots) {
    const key = DateTime.fromISO(s.start, { zone: "utc" }).setZone(tz).toISODate()!;
    days.set(key, [...(days.get(key) ?? []), s]);
  }
  // Weeks (Mon–Sun in the shown zone) as collapsible groups, the first one open.
  const weeks = new Map<string, [string, Slot[]][]>();
  for (const [day, list] of days) {
    const d = DateTime.fromISO(day, { zone: tz });
    const k = `${d.weekYear}-${d.weekNumber}`;
    weeks.set(k, [...(weeks.get(k) ?? []), [day, list]]);
  }
  if (problem) {
    return (
      <>
        {error && <p class="form-error" role="alert">{error}</p>}
        <p class="note" role="status">Takvimi şu an kontrol edemiyoruz. Birkaç dakika sonra sayfayı yenile; sorun sürerse bu konuşmadan bize yaz.</p>
      </>
    );
  }
  if (!slots.length) {
    return <p class="note">Şu an seçilebilecek boş saat yok. Takvimi sık güncelliyoruz; birkaç gün sonra tekrar bak ya da bu konuşmadan bize yaz.</p>;
  }
  return (
    <form class="slot-form" method="post" action={action}>
      {error && <p class="form-error" role="alert">{error}</p>}
      <input type="hidden" name="tz" value={tz} />
      {extra}
      {[...weeks.values()].map((wk, i) => (
        <details class="slot-week" open={i === 0}>
          <summary>{weekLabel(wk[0]![1][0]!.start, wk.at(-1)![1][0]!.start, tz)}</summary>
          {wk.map(([, list]) => (
            <fieldset class="slot-day">
              <legend>{formatSlot(list[0]!.start, tz, "d LLLL cccc")}</legend>
              <div class="slot-options">
                {list.map((s) => (
                  <label class="slot">
                    <input type="radio" name="start" value={s.start} required />
                    <span>{formatSlot(s.start, tz, "HH:mm")}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </details>
      ))}
      <button class="btn" type="submit">{button}</button>
    </form>
  );
}

function weekLabel(firstIso: string, lastIso: string, tz: string): string {
  const a = DateTime.fromISO(firstIso, { zone: "utc" }).setZone(tz).setLocale("tr");
  const b = DateTime.fromISO(lastIso, { zone: "utc" }).setZone(tz).setLocale("tr");
  if (a.hasSame(b, "day")) return a.toFormat("d LLLL");
  return a.hasSame(b, "month") ? `${a.toFormat("d")}–${b.toFormat("d LLLL")}` : `${a.toFormat("d LLLL")} – ${b.toFormat("d LLLL")}`;
}

function pickTz(q: string | undefined, fallback: string): string {
  return q && isValidZone(q) ? q : fallback;
}

function BookingFacts({ b, tz }: { b: Booking; tz: string }) {
  return (
    <dl class="facts">
      <dt>Tarih</dt><dd>{formatSlot(b.start_utc, tz)}</dd>
      <dt>Saat dilimi</dt><dd>{zoneLabel(tz)}</dd>
      <dt>Süre</dt><dd>{SESSION_MINUTES} dakika</dd>
      <dt>Bağlantı</dt><dd>{b.meet_url ? <a href={b.meet_url}>{b.meet_url}</a> : "Google Meet bağlantısı görüşmeden önce e-postana gelecek."}</dd>
    </dl>
  );
}

// --- After Checkout -----------------------------------------------------------------------------

randevu.get("/odeme/tamam", async (c) => {
  const sid = c.req.query("oturum") ?? "";
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sid)) return c.html(notFound(), 404);
  const row = await c.env.DB.prepare("SELECT token FROM booking_intents WHERE stripe_session_id = ?1").bind(sid).first<{ token: string }>();
  let token = row?.token;
  if (!token) {
    // The webhook may not have arrived yet: ask Stripe directly (fulfilment is idempotent).
    try {
      const s = await retrieveCheckoutSession(c.env, sid);
      token = (await fulfillConsult(c.env, s)).token;
    } catch (err) {
      console.error("odeme/tamam", sid, err);
    }
  }
  if (token) return c.redirect(`/randevu/${token}`, 303);
  return c.html(
    html(
      <MessagePage title="Ödeme işleniyor" eyebrow="Durum Analizi" heading="Ödemen işleniyor"
        text="Onaylandığında saat seçme bağlantısını e-postana gönderiyoruz. Birkaç dakika sürebilir."
        back={["/", "← Ana sayfa"]} />,
    ),
  );
});

// --- Pick a time ----------------------------------------------------------------------------------

async function pickPage(env: Env, intent: Intent, tz: string, error?: string) {
  const { slots, problem } = await offeredSlots(env);
  return html(
    <SiteLayout title="Görüşme saatini seç — Üç Eksen" noindex>
      <header>
        <p class="eyebrow">Durum Analizi</p>
        <h1>Görüşme saatini seç</h1>
        <p class="lede">{intent.name ? `${intent.name}, ö` : "Ö"}demen alındı. {SESSION_MINUTES} dakikalık görüşme için sana uyan saati seç; saatler aşağıdaki saat diliminde gösteriliyor.</p>
      </header>
      <section>
        <TzForm tz={tz} action={`/randevu/${intent.token}`} />
        <SlotPicker slots={slots} tz={tz} action={`/randevu/${intent.token}`} button="Bu saati seç" error={error} problem={!!problem} />
      </section>
      <script src="/randevu.js" defer></script>
    </SiteLayout>,
  );
}

function bookedPage(intent: Intent, b: Booking, tz: string, flash?: string) {
  const p = policy(b);
  const cancelled = b.state === "cancelled";
  return html(
    <SiteLayout title="Görüşmen — Üç Eksen" noindex>
      <header>
        <p class="eyebrow">Durum Analizi</p>
        <h1>{cancelled ? "Görüşme iptal edildi" : "Görüşmen ayarlandı"}</h1>
        {flash && <p class="note" role="status">{flash}</p>}
      </header>
      <section>
        <BookingFacts b={b} tz={tz} />
        {cancelled ? (
          <p>
            {b.refund_status === "refunded" ? "Ücretin iade edildi." : b.refund_status === "failed" ? "İadeyi elle yapıp sana yazacağız." : "Bu görüşme için iade yapılmadı."}
          </p>
        ) : (
          <p class="actions">
            <a class="btn-ghost" href={`/randevu/${intent.token}/takvim.ics`}>Takvime ekle (.ics)</a>{" "}
            {(p.canReschedule || p.canCancel) && <a class="btn-ghost" href={`/randevu/${intent.token}/degistir`}>Değiştir ya da iptal et</a>}
          </p>
        )}
      </section>
    </SiteLayout>,
  );
}

const PICK_ERRORS = {
  taken: "Bu saat az önce doldu. Başka bir saat seç.",
  unavailable: "Bu saat artık seçilemiyor. Güncel saatler aşağıda.",
  calendar: "Takvimi şu an kontrol edemiyoruz; saat kaydedilmedi. Birkaç dakika sonra tekrar dene.",
} as const;

randevu.get(`/randevu/:token${TOKEN}`, async (c) => {
  const found = await loadIntent(c.env.DB, c.req.param("token"));
  if (!found) return c.html(notFound(), 404);
  const { intent, booking } = found;
  const host = await getHostTz(c.env.DB);
  if (booking) {
    const tz = pickTz(c.req.query("tz"), booking.customer_tz);
    const flash = c.req.query("ayarlandi") ? "Onay e-postası ve takvim dosyası yolda." : c.req.query("degisti") ? "Yeni saat kaydedildi; güncel takvim dosyası e-postanda." : c.req.query("iptal") ? "İptal edildi; ayrıntılar e-postanda." : undefined;
    return c.html(bookedPage(intent, booking, tz, flash));
  }
  if (DateTime.fromISO(intent.expires_at, { zone: "utc" }) <= DateTime.utc()) {
    return c.html(
      html(<MessagePage title="Süresi doldu" eyebrow="Randevu" heading="Bu bağlantının süresi doldu"
        text={`Saat seçme bağlantısı ${CONSULT.intentDays} gün geçerliydi. Yeni bir saat için merhaba@uceksen.com adresine yaz.`} back={["/", "← Ana sayfa"]} />),
      410,
    );
  }
  return c.html(await pickPage(c.env, intent, pickTz(c.req.query("tz"), host)));
});

randevu.post(`/randevu/:token${TOKEN}`, async (c) => {
  const found = await loadIntent(c.env.DB, c.req.param("token"));
  if (!found) return c.html(notFound(), 404);
  const { intent } = found;
  const form = await c.req.parseBody();
  const start = typeof form.start === "string" ? form.start : "";
  const tz = pickTz(typeof form.tz === "string" ? form.tz : undefined, await getHostTz(c.env.DB));
  const r = await bookSlot(c.env, intent, start, tz);
  if (r.ok) return c.redirect(`/randevu/${intent.token}?ayarlandi=1`, 303);
  if (r.reason === "already") return c.redirect(`/randevu/${intent.token}`, 303);
  if (r.reason === "expired") return c.redirect(`/randevu/${intent.token}`, 303);
  return c.html(await pickPage(c.env, intent, tz, PICK_ERRORS[r.reason]), 409);
});

randevu.get(`/randevu/:token${TOKEN}/takvim.ics`, async (c) => {
  const found = await loadIntent(c.env.DB, c.req.param("token"));
  if (!found?.booking) return c.html(notFound(), 404);
  const ics = buildIcs({
    ...found.booking,
    manageUrl: `${c.env.APP_URL}/randevu/${found.intent.token}/degistir`,
    domain: c.env.MAIL_DOMAIN,
  });
  return c.body(ics, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": 'attachment; filename="durum-analizi.ics"',
  });
});

// --- Reschedule / cancel ----------------------------------------------------------------------------

async function changePage(env: Env, intent: Intent, b: Booking, tz: string, error?: string) {
  const p = policy(b);
  const offered = p.canReschedule ? await offeredSlots(env, b.id) : { slots: [], problem: null };
  const slots = offered.slots.filter((s) => s.start !== b.start_utc);
  const left = CONSULT.maxReschedules - b.reschedule_count;
  return html(
    <SiteLayout title="Görüşmeyi değiştir — Üç Eksen" noindex>
      <header>
        <p class="eyebrow">Durum Analizi</p>
        <h1>Görüşmeyi değiştir</h1>
      </header>
      <section>
        <BookingFacts b={b} tz={tz} />
      </section>
      {error && <p class="form-error" role="alert">{error}</p>}

      <section id="ertele">
        <h2>Saati değiştir</h2>
        {p.canReschedule ? (
          <>
            <p class="small">Görüşmeye {CONSULT.rescheduleHours} saatten fazla varken yapılabilir. {left} değişiklik hakkın kaldı.</p>
            <TzForm tz={tz} action={`/randevu/${intent.token}/degistir`} />
            <SlotPicker slots={slots} tz={tz} action={`/randevu/${intent.token}/degistir`} button="Yeni saati kaydet"
              extra={<input type="hidden" name="islem" value="ertele" />} problem={!!offered.problem} />
          </>
        ) : (
          <p class="small">
            {b.reschedule_count >= CONSULT.maxReschedules
              ? `Saat en fazla ${CONSULT.maxReschedules} kez değiştirilebiliyor; bu hakkın doldu.`
              : `Görüşmeye ${CONSULT.rescheduleHours} saatten az kaldığı için saat artık değiştirilemiyor.`}
          </p>
        )}
      </section>

      {p.canCancel && (
        <section id="iptal">
          <h2>İptal et</h2>
          <p class="small">
            {p.refundable
              ? `Görüşmeye ${CONSULT.refundHours} saatten fazla var: iptal edersen ücretin tamamı iade edilir.`
              : `Görüşmeye ${CONSULT.refundHours} saatten az kaldı: iptal edersen satış koşullarına göre iade yapılmaz.`}
          </p>
          <form class="form-stack" method="post" action={`/randevu/${intent.token}/degistir`}>
            <input type="hidden" name="islem" value="iptal" />
            <input type="hidden" name="tz" value={tz} />
            <label class="check"><input type="checkbox" name="onay" required /> Görüşmeyi iptal etmek istiyorum.</label>
            <button class="btn-ghost" type="submit">Görüşmeyi iptal et</button>
          </form>
        </section>
      )}
      <script src="/randevu.js" defer></script>
    </SiteLayout>,
  );
}

randevu.get(`/randevu/:token${TOKEN}/degistir`, async (c) => {
  const found = await loadIntent(c.env.DB, c.req.param("token"));
  if (!found) return c.html(notFound(), 404);
  if (!isLive(found.booking)) return c.redirect(`/randevu/${found.intent.token}`, 303);
  return c.html(await changePage(c.env, found.intent, found.booking, pickTz(c.req.query("tz"), found.booking.customer_tz)));
});

randevu.post(`/randevu/:token${TOKEN}/degistir`, async (c) => {
  const found = await loadIntent(c.env.DB, c.req.param("token"));
  if (!found) return c.html(notFound(), 404);
  const { intent, booking } = found;
  if (!isLive(booking)) return c.redirect(`/randevu/${intent.token}`, 303);
  const form = await c.req.parseBody();
  const tz = pickTz(typeof form.tz === "string" ? form.tz : undefined, booking.customer_tz);

  if (form.islem === "iptal") {
    if (!form.onay) return c.html(await changePage(c.env, intent, booking, tz, "İptal için onay kutusunu işaretle."), 400);
    const r = await cancelBooking(c.env, intent, booking, "customer");
    if (!r.ok) return c.html(await changePage(c.env, intent, booking, tz, "Bu görüşme artık iptal edilemiyor."), 409);
    return c.redirect(`/randevu/${intent.token}?iptal=1`, 303);
  }
  const start = typeof form.start === "string" ? form.start : "";
  const r = await rescheduleBooking(c.env, intent, booking, start, tz);
  if (r.ok) return c.redirect(`/randevu/${intent.token}?degisti=1`, 303);
  const msg = r.reason === "not_allowed" ? "Saat artık değiştirilemiyor." : PICK_ERRORS[r.reason];
  const fresh = (await loadIntent(c.env.DB, intent.token))!.booking!;
  return c.html(await changePage(c.env, intent, fresh, tz, msg), 409);
});
