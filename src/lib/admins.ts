import type { Admin, Author } from "../env";

const AUTHORS: readonly Author[] = ["gizem", "baran"];

/** Parses ADMIN_EMAILS: "gizem=a@x.com,baran=b@y.com". Unknown names are ignored. */
export function parseAdmins(raw: string | undefined): Admin[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((pair) => pair.trim().split("="))
    .flatMap(([name, email]) =>
      name && email && (AUTHORS as readonly string[]).includes(name.trim())
        ? [{ author: name.trim() as Author, email: email.trim().toLowerCase() }]
        : [],
    );
}

export function findAdmin(admins: Admin[], email: string): Admin | undefined {
  const e = email.trim().toLowerCase();
  return admins.find((a) => a.email === e);
}
