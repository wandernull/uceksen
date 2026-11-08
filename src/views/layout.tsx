import { raw } from "hono/html";
import type { Child } from "hono/jsx";

/** Theme switch button; same markup as in the static pages (public/*.html), driven by /theme.js. */
const THEME_TOGGLE = raw(
  `<button class="theme-toggle" type="button" data-theme-toggle aria-label="Tema" title="Tema"><svg class="i-auto" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg><svg class="i-light" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><svg class="i-dark" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.5A5.75 5.75 0 1 1 6.5 2.5a4.75 4.75 0 0 0 7 7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button>`,
);

const FOOTER_NOTE =
  "Bu sitedeki mali ve hukuki bilgiler Ekim 2026 itibarıyla geçerlidir ve deneyim aktarımıdır; hukuki veya mali danışmanlık değildir. Göçmenlik dosyaları kişiye özeldir. Şirket ve oturum kararlarınızı avukat ve mali müşavirle alın.";

const NAV = [
  ["/rehber", "Rehber"],
  ["/danismanlik", "Danışmanlık"],
  ["/hakkimizda", "Hakkımızda"],
] as const;

const FOOT = [...NAV, ["/gizlilik", "Gizlilik"], ["/satis-kosullari", "Satış Koşulları"]] as const;

function Head({ title, extraCss = [], noindex = false }: { title: string; extraCss?: string[]; noindex?: boolean }) {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      {noindex && <meta name="robots" content="noindex, nofollow" />}
      <title>{title}</title>
      <script src="/theme.js"></script>
      <link rel="stylesheet" href="/fonts/fonts.css" />
      <link rel="stylesheet" href="/styles.css" />
      <link rel="stylesheet" href="/site.css" />
      {extraCss.map((href) => (
        <link rel="stylesheet" href={href} />
      ))}
    </head>
  );
}

/** Customer-facing page shell: same nav and footer as the static pages in public/. */
export function SiteLayout({ title, current, noindex, children }: { title: string; current?: string; noindex?: boolean; children: Child }) {
  return (
    <html lang="tr">
      <Head title={title} noindex={noindex} />
      <body>
        <nav class="nav">
          <div class="nav-inner gutter">
            <a class="brand" href="/">Üç Eksen</a>
            <div class="nav-links">
              {NAV.map(([href, label]) => (
                <a href={href} aria-current={href === current ? "page" : undefined}>{label}</a>
              ))}
              {THEME_TOGGLE}
            </div>
          </div>
        </nav>
        <main class="wrap gutter">{children}</main>
        <footer class="foot">
          <div class="foot-inner gutter">
            <div class="foot-links">
              {FOOT.map(([href, label]) => (
                <a href={href}>{label}</a>
              ))}
            </div>
            <p>{FOOTER_NOTE}</p>
          </div>
        </footer>
      </body>
    </html>
  );
}

/** Short message page: heading, one paragraph, one link back. */
export function MessagePage(props: { title: string; eyebrow: string; heading: string; text: string; back: [href: string, label: string] }) {
  return (
    <SiteLayout title={`${props.title} — Üç Eksen`}>
      <header>
        <p class="eyebrow">{props.eyebrow}</p>
        <h1>{props.heading}</h1>
        <p class="lede">{props.text}</p>
      </header>
      <p>
        <a class="btn-ghost" href={props.back[0]}>{props.back[1]}</a>
      </p>
    </SiteLayout>
  );
}

const ADMIN_NAV = [["/admin/", "Konuşmalar"], ["/admin/takvim", "Takvim"], ["/admin/rehber", "Rehber"], ["/admin/eslesmeyen", "Eşleşmeyen"]] as const;

export function AdminLayout({ title, current, adminName, children }: { title: string; current: string; adminName: string; children: Child }) {
  return (
    <html lang="tr">
      <Head title={`${title} — Üç Eksen Yönetim`} extraCss={["/admin.css"]} noindex />
      <body>
        <nav class="nav">
          <div class="nav-inner admin-inner gutter">
            <a class="brand" href="/admin/">Üç Eksen · Yönetim</a>
            <div class="nav-links">
              {ADMIN_NAV.map(([href, label]) => (
                <a href={href} aria-current={href === current ? "page" : undefined}>{label}</a>
              ))}
              <span class="admin-who">{adminName}</span>
              {/* Handled by Cloudflare Access (not the Worker): revokes the Access session, then shows Cloudflare's "logged out" page. */}
              <a href="/cdn-cgi/access/logout" rel="nofollow">Çıkış</a>
              {THEME_TOGGLE}
            </div>
          </div>
        </nav>
        <main class="wrap admin-wrap gutter">{children}</main>
      </body>
    </html>
  );
}
