/**
 * Pre-call intake form (Phase 10). Questions approved by the user on 2026-11-13.
 * Answers are stored as JSON in bookings.intake_json, keyed by `key`.
 */

export type IntakeQuestion = { key: string; label: string; hint: string; required: boolean };

export const INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
  { key: "simdi", label: "Şu an neredesin?", hint: "Vatandaşlığın (birden fazlaysa hepsi) ve şu an yaşadığın ülke.", required: false },
  { key: "aile", label: "Kimlerle taşınıyorsun?", hint: "Yalnız, eş, çocuklar. Eşin çalışıyorsa ya da farklı bir statüdeyse kısaca yaz.", required: false },
  { key: "gelir", label: "Gelirin nereden geliyor?", hint: "Maaş, kendi şirketin, serbest çalışma, kira ya da yatırım; hangi ülkelerde.", required: false },
  { key: "sirket", label: "Şirketin var mı?", hint: "Varsa: hangi ülkede, ortaklı mı, ne iş yapıyor, yaklaşık yıllık ciro.", required: false },
  { key: "hedef", label: "Hangi ülkeleri düşünüyorsun, zamanlaman ne?", hint: "Henüz belli değilse onu yaz.", required: false },
  { key: "beklenti", label: "Bu görüşmeden sonra neyi netleştirmiş olmak istiyorsun?", hint: "", required: true },
  { key: "ek", label: "Eklemek istediğin bir şey", hint: "Buraya kadar attığın adımlar, görüştüğün uzmanlar ya da elindeki teklifler.", required: false },
];

export const INTAKE_MAX = 3000; // characters per answer

export type IntakeAnswers = Record<string, string>;

export function parseIntake(body: Record<string, unknown>): { ok: true; answers: IntakeAnswers } | { ok: false; answers: IntakeAnswers; error: string } {
  const answers: IntakeAnswers = {};
  for (const q of INTAKE_QUESTIONS) {
    const v = body[q.key];
    answers[q.key] = (typeof v === "string" ? v : "").replace(/\r\n/g, "\n").trim().slice(0, INTAKE_MAX);
  }
  const missing = INTAKE_QUESTIONS.find((q) => q.required && !answers[q.key]);
  if (missing) return { ok: false, answers, error: `“${missing.label}” sorusunu yanıtla.` };
  return { ok: true, answers };
}

export function readIntake(json: string | null): IntakeAnswers | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as IntakeAnswers) : null;
  } catch {
    return null;
  }
}

/** Plain-text rendering for admin emails: question, then answer (or "—"). */
export function intakeText(a: IntakeAnswers): string {
  return INTAKE_QUESTIONS.map((q) => `${q.label}\n${a[q.key] || "—"}`).join("\n\n");
}
