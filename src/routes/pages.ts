import { Hono } from "hono";
import type { AppEnv } from "../env";

export const pages = new Hono<AppEnv>();

// Placeholder until Phase 4 wires Stripe Checkout.
pages.get("/rehber/satin-al", (c) =>
  c.html(
    `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yakında — Üç Eksen</title><link rel="stylesheet" href="/fonts/fonts.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/site.css"></head>
<body><main class="wrap gutter"><header><p class="eyebrow">Rehber</p><h1>Satış çok yakında açılıyor</h1>
<p class="lede">Ödeme sayfası henüz hazır değil. Kısa süre içinde buradan satın alabileceksin.</p></header>
<p><a class="btn-ghost" href="/rehber">← Rehbere dön</a></p></main></body></html>`,
    503,
  ),
);
