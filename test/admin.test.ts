import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import type { Jwk } from "../src/lib/access";
import { verifyAccessJwt } from "../src/lib/access";
import { accessKeys } from "../src/lib/admin-auth";

const TEAM = "uceksen.cloudflareaccess.com";
const AUD = "test-aud-123";

let privateKey: CryptoKey;
let jwk: Jwk;
let otherKey: CryptoKey;

const b64url = (data: Uint8Array | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function sign(claims: Record<string, unknown>, key = privateKey, kid = "k1") {
  const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const now = () => Math.floor(Date.now() / 1000);
const goodClaims = (extra: Record<string, unknown> = {}) => ({
  aud: [AUD], iss: `https://${TEAM}`, email: "Gizem@Example.com", exp: now() + 600, iat: now(), ...extra,
});

beforeAll(async () => {
  const algo = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const pair = (await crypto.subtle.generateKey(algo, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid: "k1" };
  otherKey = ((await crypto.subtle.generateKey(algo, true, ["sign", "verify"])) as CryptoKeyPair).privateKey;
  accessKeys.source = async () => [jwk];
});

const verify = (t: string) => verifyAccessJwt(t, { teamDomain: TEAM, aud: AUD, keys: async () => [jwk] });

describe("Cloudflare Access JWT verification", () => {
  it("accepts a valid token and returns the lower-cased email", async () => {
    expect(await verify(await sign(goodClaims()))).toBe("gizem@example.com");
  });
  it("rejects wrong audience", async () => {
    expect(await verify(await sign(goodClaims({ aud: ["other"] })))).toBeNull();
  });
  it("rejects wrong issuer", async () => {
    expect(await verify(await sign(goodClaims({ iss: "https://evil.cloudflareaccess.com" })))).toBeNull();
  });
  it("rejects an expired token", async () => {
    expect(await verify(await sign(goodClaims({ exp: now() - 1 })))).toBeNull();
  });
  it("rejects a token signed by another key", async () => {
    expect(await verify(await sign(goodClaims(), otherKey))).toBeNull();
  });
  it("rejects an unknown key id, garbage, and missing token", async () => {
    expect(await verify(await sign(goodClaims(), privateKey, "nope"))).toBeNull();
    expect(await verify("a.b.c")).toBeNull();
    expect(await verifyAccessJwt(undefined, { teamDomain: TEAM, aud: AUD })).toBeNull();
  });
  it("rejects alg=none even with a valid payload", async () => {
    const t = `${b64url(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64url(JSON.stringify(goodClaims()))}.`;
    expect(await verify(t)).toBeNull();
  });
});

describe("/admin on a deployed environment", () => {
  async function call(path: string, headers: Record<string, string> = {}, overrides: Partial<Env> = {}) {
    const ctx = createExecutionContext();
    const deployed = { ...env, ENVIRONMENT: "staging", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...overrides } as Env;
    const res = await app.fetch(new Request(`https://example.com${path}`, { headers }), deployed, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("redirects the bare /admin (not covered by the Access path rule) to /admin/, keeping the query", async () => {
    for (const [from, to] of [["/admin", "/admin/"], ["/admin?durum=new", "/admin/?durum=new"]] as const) {
      const res = await call(from);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(to);
    }
  });
  it("refuses requests without an Access token", async () => {
    expect((await call("/admin/")).status).toBe(403);
  });
  it("refuses everything while Access is not configured", async () => {
    const t = await sign(goodClaims());
    expect((await call("/admin/", { "cf-access-jwt-assertion": t }, { ACCESS_AUD: "", ACCESS_TEAM_DOMAIN: "" })).status).toBe(403);
  });
  it("refuses a valid token for an email not in ADMIN_EMAILS", async () => {
    const t = await sign(goodClaims({ email: "stranger@example.com" }));
    expect((await call("/admin/", { "cf-access-jwt-assertion": t })).status).toBe(403);
  });
  it("lets an admin in, with no-store and noindex", async () => {
    const res = await call("/admin/", { "cf-access-jwt-assertion": await sign(goodClaims()) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(await res.text()).toContain("Gizem");
  });
});

describe("/admin conversations (test env, no Access in front)", () => {
  async function submit(email: string, name: string, durum: string) {
    const res = await SELF.fetch("https://example.com/api/talep", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify({ ad: name, email, durum, onay: "on", kaynak: "danismanlik" }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.email = ? ORDER BY c.id DESC")
      .bind(email).first<{ id: number }>();
    return row!.id;
  }

  it("a submitted form appears in the list and in the detail view", async () => {
    const id = await submit("liste@example.com", "Zeynep Kaya", "İki ülkede gelirim var <script>alert(1)</script>");
    const list = await (await SELF.fetch("https://example.com/admin/")).text();
    expect(list).toContain("Zeynep Kaya");
    expect(list).toContain(`href="/admin/konusma/${id}"`);
    expect(list).toContain("Yeni");
    expect(list).not.toContain("<script>alert(1)</script>"); // escaped
    expect(list).toContain("&lt;script&gt;");

    const detail = await (await SELF.fetch(`https://example.com/admin/konusma/${id}`)).text();
    expect(detail).toContain("Zeynep Kaya");
    expect(detail).toContain("liste@example.com");
    expect(detail).toContain("Durum Analizi talebi");
    expect(detail).toContain("Danışmanlık sayfası");
    expect(detail).toContain("Müşteri");
    expect(detail).toMatch(/\d{1,2} (Oca|Şub|Mar|Nis|May|Haz|Tem|Ağu|Eyl|Eki|Kas|Ara) \d{4} \d\d:\d\d/); // Turkish date
  });

  it("filters by state and changes state via POST", async () => {
    const id = await submit("durum@example.com", "Can Demir", "Durum değişikliği testi");
    const res = await SELF.fetch(`https://example.com/admin/konusma/${id}/durum`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://example.com" },
      body: "durum=ours",
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/konusma/${id}?kaydedildi=1`);
    const row = await env.DB.prepare("SELECT state FROM conversations WHERE id = ?").bind(id).first<{ state: string }>();
    expect(row?.state).toBe("ours");

    const ours = await (await SELF.fetch("https://example.com/admin/?durum=ours")).text();
    expect(ours).toContain("Can Demir");
    const fresh = await (await SELF.fetch("https://example.com/admin/?durum=new")).text();
    expect(fresh).not.toContain("Can Demir");
  });

  it("rejects a cross-origin state change (CSRF) and invalid states", async () => {
    const id = await submit("csrf@example.com", "Ece", "CSRF testi");
    const evil = await SELF.fetch(`https://example.com/admin/konusma/${id}/durum`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: "durum=closed",
      redirect: "manual",
    });
    expect(evil.status).toBe(403);
    const bad = await SELF.fetch(`https://example.com/admin/konusma/${id}/durum`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://example.com" },
      body: "durum=hacked",
      redirect: "manual",
    });
    expect(bad.status).toBe(400);
    const row = await env.DB.prepare("SELECT state FROM conversations WHERE id = ?").bind(id).first<{ state: string }>();
    expect(row?.state).toBe("new");
  });

  it("404 for an unknown conversation", async () => {
    expect((await SELF.fetch("https://example.com/admin/konusma/999999")).status).toBe(404);
  });
});
