import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { DateTime } from "luxon";
import type { AppEnv } from "../env";
import { formatSize } from "../lib/attachments";
import { checkToken, consumeToken, currentGuide, sendFreshLink } from "../lib/guide";
import { allow, clientIp } from "../lib/rate-limit";
import { getHostTz } from "../lib/settings";
import { createGuideCheckout } from "../lib/stripe";
import { MessagePage, SiteLayout } from "../views/layout";

/** Guide sales: /rehber/satin-al, /rehber/tesekkurler, /indir, /d/{token}. */
export const rehber = new Hono<AppEnv>();
// Mounted at "/": keep middleware scoped to these paths.
rehber.use("/rehber/*", csrf());
rehber.use("/indir", csrf());

export const SALES_RATE = { checkout: 20, indir: 3, indirPerEmail: 3, windowSec: 3600 } as const;

const html = (el: unknown) => "<!doctype html>" + String(el);

const soon = () =>
  html(
    <MessagePage
      title="Yakında"
      eyebrow="Rehber"
      heading="Satış çok yakında açılıyor"
      text="Ödeme sayfası henüz hazır değil. Kısa süre içinde buradan satın alabileceksin."
      back={["/rehber", "← Rehbere dön"]}
    />,
  );

// The button on /rehber posts here. A plain GET (old link, crawler) just goes back.
rehber.get("/rehber/satin-al", (c) => c.redirect("/rehber", 303));

rehber.post("/rehber/satin-al", async (c) => {
  if (!(await currentGuide(c.env.DB))) return c.html(soon(), 503);
  if (!(await allow(c.env.KV, `checkout:${clientIp(c.req.raw)}`, SALES_RATE.checkout, SALES_RATE.windowSec))) {
    return c.html(
      html(
        <MessagePage title="Çok fazla deneme" eyebrow="Rehber" heading="Biraz bekle"
          text="Kısa sürede çok fazla ödeme sayfası açıldı. Bir saat sonra tekrar dene."
          back={["/rehber", "← Rehbere dön"]} />,
      ),
      429,
    );
  }
  try {
    const s = await createGuideCheckout(c.env);
    if (!s.url) throw new Error(`checkout session ${s.id} has no url`);
    return c.redirect(s.url, 303);
  } catch (err) {
    console.error("checkout create failed", err);
    return c.html(
      html(
        <MessagePage title="Ödeme sayfası açılamadı" eyebrow="Rehber" heading="Ödeme sayfası açılamadı"
          text="Bir sorun oldu, ödeme alınmadı. Biraz sonra tekrar dene."
          back={["/rehber", "← Rehbere dön"]} />,
      ),
      502,
    );
  }
});

rehber.get("/rehber/tesekkurler", (c) =>
  c.html(
    html(
      <MessagePage
        title="Teşekkürler"
        eyebrow="Rehber"
        heading="Ödemen alındı"
        text="İndirme bağlantısını birkaç dakika içinde e-postana gönderiyoruz. Gelmezse spam klasörüne bak ya da satın alma e-postanla yeni bağlantı iste."
        back={["/indir", "Bağlantı gelmedi mi?"]}
      />,
    ),
  ),
);

// --- /indir: fresh link by email -------------------------------------------------

const INDIR_MSG = {
  sent: "Bu adresle yapılmış bir satın alma varsa yeni indirme bağlantısını e-postana gönderdik. Birkaç dakika içinde gelmezse spam klasörüne bak.",
  email: "Geçerli bir e-posta adresi yaz.",
  rate: "Kısa sürede çok fazla istek gönderildi. Bir saat sonra tekrar dene.",
} as const;

function IndirPage({ error, sent, email }: { error?: string; sent?: boolean; email?: string }) {
  return (
    <SiteLayout title="Yeni indirme bağlantısı — Üç Eksen" current="/rehber">
      <header>
        <p class="eyebrow">Rehber</p>
        <h1>Yeni indirme bağlantısı</h1>
        <p class="lede">Rehberi satın alırken kullandığın e-posta adresini yaz. Yeni bağlantıyı o adrese gönderelim.</p>
      </header>
      <section>
        {sent ? (
          <p class="note" role="status">{INDIR_MSG.sent}</p>
        ) : (
          <form class="form-stack" method="post" action="/indir">
            {error && <p class="form-error" role="alert">{error}</p>}
            <label for="i-email">E-posta</label>
            <input id="i-email" name="email" type="email" required autocomplete="email" maxlength={254} value={email ?? ""} />
            <div class="hp" aria-hidden="true">
              <label for="i-website">Web sitesi</label>
              <input id="i-website" name="website" type="text" tabindex={-1} autocomplete="off" />
            </div>
            <button class="btn" type="submit">Bağlantı gönder</button>
          </form>
        )}
      </section>
    </SiteLayout>
  );
}

rehber.get("/indir", (c) => c.html(html(<IndirPage sent={c.req.query("gonderildi") === "1"} />)));

rehber.post("/indir", async (c) => {
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const done = () => c.redirect("/indir?gonderildi=1", 303);
  if (String(form.get("website") ?? "").trim()) return done(); // honeypot

  if (!(await allow(c.env.KV, `indir:${clientIp(c.req.raw)}`, SALES_RATE.indir, SALES_RATE.windowSec))) {
    return c.html(html(<IndirPage error={INDIR_MSG.rate} email={email} />), 429);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return c.html(html(<IndirPage error={INDIR_MSG.email} email={email} />), 400);
  }
  // Per address too, so nobody can flood a purchaser's inbox from many IPs.
  // Same answer whether or not the address bought anything: no account enumeration.
  if (await allow(c.env.KV, `indir-email:${email}`, SALES_RATE.indirPerEmail, SALES_RATE.windowSec)) {
    await sendFreshLink(c.env, email).catch((err) => console.error("sendFreshLink failed", err));
  }
  return done();
});

// --- /d/{token}: the download ------------------------------------------------------
// GET shows a page with a button; only the POST counts a download. Mail scanners and
// link previews open links with GET, and must not use up the customer's downloads.

const TOKEN = "{[A-Za-z0-9_-]{32}}";

rehber.use("/d/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow");
});

function tokenProblem(reason: "unknown" | "expired" | "used_up") {
  if (reason === "unknown") {
    return html(
      <MessagePage title="Bulunamadı" eyebrow="Rehber" heading="Bu bağlantı geçersiz"
        text="Bağlantı e-postadan kopyalanırken eksik kalmış olabilir. Satın alma e-postanla yeni bağlantı isteyebilirsin."
        back={["/indir", "Yeni bağlantı al"]} />,
    );
  }
  return html(
    <MessagePage
      title="Bağlantı kullanılamıyor"
      eyebrow="Rehber"
      heading={reason === "expired" ? "Bu bağlantının süresi doldu" : "Bu bağlantının indirme hakkı doldu"}
      text="Satın alma e-postanı yazarak yeni bir bağlantı alabilirsin."
      back={["/indir", "Yeni bağlantı al"]}
    />,
  );
}

const unavailable = () =>
  html(
    <MessagePage title="Geçici sorun" eyebrow="Rehber" heading="Rehber şu an indirilemiyor"
      text="Dosyayı güncelliyoruz. Birkaç dakika sonra tekrar dene; indirme hakkın azalmadı."
      back={["/", "← Ana sayfa"]} />,
  );

rehber.get(`/d/:token${TOKEN}`, async (c) => {
  const token = c.req.param("token");
  const state = await checkToken(c.env.DB, token);
  if (!state.ok) return c.html(tokenProblem(state.reason), state.reason === "unknown" ? 404 : 410);
  const [guide, tz] = await Promise.all([currentGuide(c.env.DB), getHostTz(c.env.DB)]);
  if (!guide) return c.html(unavailable(), 503);
  const until = DateTime.fromISO(state.expiresAt, { zone: "utc" }).setZone(tz).setLocale("tr").toFormat("d LLLL yyyy");
  return c.html(
    html(
      <SiteLayout title="Rehberi indir — Üç Eksen" noindex>
        <header>
          <p class="eyebrow">Rehber</p>
          <h1>Üç Eksen rehberi</h1>
          <p class="lede">
            Sürüm {guide.version} · PDF{guide.size ? ` · ${formatSize(guide.size)}` : ""}
          </p>
        </header>
        <section>
          <p>
            {state.remaining} indirme hakkın kaldı. Bağlantı {until} tarihine kadar geçerli.
          </p>
          <form method="post" action={`/d/${token}`}>
            <button class="btn" type="submit">PDF'i indir</button>
          </form>
        </section>
      </SiteLayout>,
    ),
  );
});

rehber.post(`/d/:token${TOKEN}`, async (c) => {
  const token = c.req.param("token");
  const state = await checkToken(c.env.DB, token);
  if (!state.ok) return c.html(tokenProblem(state.reason), state.reason === "unknown" ? 404 : 410);
  const guide = await currentGuide(c.env.DB);
  const obj = guide && (await c.env.BUCKET.get(guide.r2_key));
  if (!guide || !obj) return c.html(unavailable(), 503);
  if (!(await consumeToken(c.env.DB, token))) {
    await obj.body.cancel();
    return c.html(tokenProblem("used_up"), 410);
  }
  // Streamed through the Worker (no presigned R2 URL): the file never has a public URL.
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(obj.size),
      "Content-Disposition": `attachment; filename="uc-eksen-rehber-${guide.version.replace(/[^0-9A-Za-z.-]/g, "_")}.pdf"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});
