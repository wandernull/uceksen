import { describe, expect, it } from "vitest";
import { extractPlusToken, htmlToText, isForThisEnvironment, parseAddress, parseMessageIds, stripQuotes } from "../src/lib/inbound";

describe("stripQuotes", () => {
  const cases: [string, string, string][] = [
    [
      "Gmail, English",
      "Thanks, Tuesday works.\n\nOn Sat, Nov 7, 2026 at 10:15 PM Üç Eksen <merhaba@uceksen.com> wrote:\n> Merhaba Ayşe,\n> Talebin bize ulaştı.",
      "Thanks, Tuesday works.",
    ],
    [
      "Gmail, English, attribution wrapped over two lines",
      "Sounds good.\n\nOn Sat, Nov 7, 2026 at 10:15 PM Üç Eksen <\nmerhaba+abc@reply.uceksen.com> wrote:\n\n> earlier",
      "Sounds good.",
    ],
    [
      "Gmail, Turkish",
      "Salı uygun.\n\n7 Kas 2026 Cmt, 22:15 tarihinde Üç Eksen <merhaba@uceksen.com> şunu yazdı:\n> Merhaba",
      "Salı uygun.",
    ],
    [
      "Gmail, Turkish, wrapped",
      "Tamam.\n\n7 Kas 2026 Cmt, 22:15 tarihinde Üç Eksen <\nmerhaba@uceksen.com> şunu yazdı:\n> Merhaba",
      "Tamam.",
    ],
    [
      "Apple Mail, Turkish",
      "Teşekkürler!\n\nGönderildiği yer: iPhone\n\n7 Kas 2026 tarihinde 22:15 saatinde, Üç Eksen <merhaba@uceksen.com> şunları yazdı:\n\n> Merhaba",
      "Teşekkürler!\n\nGönderildiği yer: iPhone",
    ],
    [
      "Outlook, English",
      "See attached.\n\n________________________________\nFrom: Üç Eksen <merhaba@uceksen.com>\nSent: Saturday, November 7, 2026 22:15\nTo: Ayşe\nSubject: Re: Durum Analizi",
      "See attached.",
    ],
    [
      "Outlook, Turkish, no separator",
      "Ekte.\n\nKimden: Üç Eksen <merhaba@uceksen.com>\nGönderildi: 7 Kasım 2026 Cumartesi 22:15\nKime: Ayşe\nKonu: Durum Analizi",
      "Ekte.",
    ],
    ["Original Message separator", "Yes.\n\n-----Original Message-----\nFrom: x\nolder text", "Yes."],
    ["trailing > block without attribution", "Olur.\n\n> eski satır\n>\n> başka", "Olur."],
    ["CRLF line endings", "Hi\r\n\r\nOn Mon, X <x@y.z> wrote:\r\n> q", "Hi"],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => expect(stripQuotes(input)).toBe(expected));
  }

  it("keeps interleaved replies (quotes followed by own text)", () => {
    const t = "> Ne zaman uygun?\nSalı.\n> Hangi saat?\n14:00.";
    expect(stripQuotes(t)).toBe(t);
  });
  it("keeps the whole text when stripping would leave nothing", () => {
    expect(stripQuotes("> only a quote\n> nothing else")).toBe("> only a quote\n> nothing else");
  });
  it("does not cut ordinary text that mentions writing", () => {
    const t = "Avukatım şunu yazdı: önce şirket.\nSonra oturum.";
    expect(stripQuotes(t)).toBe(t);
  });
});

describe("htmlToText", () => {
  it("drops the Gmail quote and decodes entities", () => {
    const html = '<div dir="ltr">Salı &amp; 14:00 olur<br>Teşekkürler&nbsp;&#304;yi günler</div><br><div class="gmail_quote"><div>On … wrote:</div><blockquote>eski</blockquote></div>';
    expect(htmlToText(html)).toBe("Salı & 14:00 olur\nTeşekkürler İyi günler");
  });
  it("drops Apple Mail cite blocks and style", () => {
    expect(htmlToText('<style>p{}</style><p>Tamam</p><blockquote type="cite">eski</blockquote>')).toBe("Tamam");
  });
});

describe("address helpers", () => {
  it("parseAddress", () => {
    expect(parseAddress('"Ayşe Y." <Ayse@Example.com>')).toEqual({ name: "Ayşe Y.", email: "ayse@example.com" });
    expect(parseAddress("Ayşe <a@b.co>")).toEqual({ name: "Ayşe", email: "a@b.co" });
    expect(parseAddress("a@b.co")).toEqual({ name: null, email: "a@b.co" });
    expect(parseAddress("not an address")).toBeNull();
  });
  it("parseMessageIds handles plain headers and Resend's JSON-array string", () => {
    expect(parseMessageIds("<a@x> <b@y>")).toEqual(["<a@x>", "<b@y>"]);
    expect(parseMessageIds('["<a@x>","<b@y>"]')).toEqual(["<a@x>", "<b@y>"]);
    expect(parseMessageIds(undefined)).toEqual([]);
  });
  it("extractPlusToken: case-insensitive, right domain and local part only", () => {
    const tok = "abcdefghijklmnopqrstuvwxyz234567";
    expect(extractPlusToken([`"Üç Eksen" <MERHABA+${tok.toUpperCase()}@Reply.Uceksen.com>`], "merhaba", "reply.uceksen.com")).toBe(tok);
    expect(extractPlusToken([`merhaba+${tok}@uceksen.com`], "merhaba", "reply.uceksen.com")).toBeNull();
    expect(extractPlusToken([`baska+${tok}@reply.uceksen.com`], "merhaba", "reply.uceksen.com")).toBeNull();
    expect(extractPlusToken([`merhaba+short@reply.uceksen.com`, undefined], "merhaba", "reply.uceksen.com")).toBeNull();
  });
});

describe("isForThisEnvironment (both Workers share reply.uceksen.com)", () => {
  const D = "reply.uceksen.com";
  const tok = "abcdefghijklmnopqrstuvwxyz234567";
  const staging = { ENVIRONMENT: "staging", REPLY_LOCAL: "staging", REPLY_DOMAIN: D };
  const prod = { ENVIRONMENT: "production", REPLY_LOCAL: "merhaba", REPLY_DOMAIN: D };

  it("staging keeps only mail to its own address", () => {
    expect(isForThisEnvironment(staging, [`staging+${tok}@${D}`])).toBe(true);
    expect(isForThisEnvironment(staging, [`"Üç Eksen" <STAGING@Reply.Uceksen.com>`])).toBe(true);
    expect(isForThisEnvironment(staging, [`merhaba+${tok}@${D}`])).toBe(false);
    expect(isForThisEnvironment(staging, [`nobody@${D}`, undefined])).toBe(false);
    expect(isForThisEnvironment(staging, [])).toBe(false);
  });

  it("production keeps its own, unknown and typo addresses, but not staging's", () => {
    expect(isForThisEnvironment(prod, [`merhaba+${tok}@${D}`])).toBe(true);
    expect(isForThisEnvironment(prod, [`nobody@${D}`])).toBe(true);
    expect(isForThisEnvironment(prod, [])).toBe(true);
    expect(isForThisEnvironment(prod, [`staging+${tok}@${D}`])).toBe(false);
    expect(isForThisEnvironment(prod, [`Staging@${D}`, `someone@example.com`])).toBe(false);
    expect(isForThisEnvironment(prod, [`staging+${tok}@${D}`, `merhaba+${tok}@${D}`])).toBe(true);
    // staging@ on another domain is not staging's reply address
    expect(isForThisEnvironment(prod, [`staging@uceksen.com`])).toBe(true);
  });
});
