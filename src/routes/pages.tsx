import { Hono } from "hono";
import type { AppEnv } from "../env";
import { MessagePage } from "../views/layout";

export const pages = new Hono<AppEnv>();

// Placeholder until Phase 4 wires Stripe Checkout.
pages.get("/rehber/satin-al", (c) =>
  c.html(
    "<!doctype html>" +
      (
        <MessagePage
          title="Yakında"
          eyebrow="Rehber"
          heading="Satış çok yakında açılıyor"
          text="Ödeme sayfası henüz hazır değil. Kısa süre içinde buradan satın alabileceksin."
          back={["/rehber", "← Rehbere dön"]}
        />
      ),
    503,
  ),
);
