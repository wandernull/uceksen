import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "test",
          ADMIN_EMAILS: "gizem=gizem@example.com,baran=baran@example.com",
          DEV_EMAIL: "dev@example.com",
          RESEND_API_KEY: "re_test",
          // base64("test-webhook-secret-0123456789ab")
          RESEND_INBOUND_SECRET: "whsec_dGVzdC13ZWJob29rLXNlY3JldC0wMTIzNDU2Nzg5YWI=",
          STRIPE_SECRET_KEY: "sk_test_fake",
          STRIPE_WEBHOOK_SECRET: "whsec_test_stripe_secret",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
        // Tests never reach the network: Resend and Stripe are faked in test/fake-*.ts,
        // anything else that slips through fails loudly.
        outboundService: () => new Response("network disabled in tests", { status: 599 }),
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts", "./test/fake-resend.ts", "./test/fake-stripe.ts"],
  },
});
