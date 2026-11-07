# First message for Claude Code

> **Paste this text.** Do not tell the agent to read it from a file — rules belong in the instruction channel.
> The durable rules live in `CLAUDE.md` and load automatically every session; this message only sets the current task.

---

This repo contains `CLAUDE.md`, `SPEC.md` and `PROGRESS.md`. Read all three.

`CLAUDE.md` holds the project's binding rules: language, security, the development email guard, time handling, the booking lock, and the design system.

`SPEC.md` describes what to build: product, data model, flows, integrations, and a nine-phase implementation order.

`PROGRESS.md` tracks live state. It is empty right now — you will maintain it. Read it first in every session and update it at the end of every phase.

The UI prototype is in `design/`: `index.html`, `rehber.html`, `danismanlik.html`, `hakkimizda.html`, `gizlilik.html`, `satis-kosullari.html`, `styles.css`. The interface comes from these files.

Note on language: code, comments, commits and everything you write back to me are in English. **All user-facing copy stays Turkish** — the existing pages, every email, and any new screen you build.

## How to proceed

**Preparation check first.** Before writing any code, read `SPEC.md` section 10 and ask me which items are ready. Do not assume — ask.

The preparation list is split by phase. Proceed as long as the requirements for the **next** phase are met; gaps in later phases do not block you. Re-check the requirements before each phase and stop if something is missing.

**Then phase by phase.** Follow the order in `SPEC.md` section 9. At the end of each phase:

1. Run that phase's tests and show the results
2. Summarise what you did, which files changed, what you tested
3. Call out anything I need to check
4. Update `PROGRESS.md` and commit
5. Wait for my approval before continuing

**Stop where you must stop.** `SPEC.md` section 11 lists the steps only I can perform. When you reach one, write this and actually wait:

> Phase X complete. Before continuing I need you to: [step]. Reply "continue" when done.

## Now

Read `CLAUDE.md`, `SPEC.md` and `PROGRESS.md`, check the preparation list with me, and give me a status report. Do not write code.
