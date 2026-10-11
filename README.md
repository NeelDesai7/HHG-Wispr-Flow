# Vachan

**वचन: a promise.** Vachan listens through your laptop's microphone in English, Hindi or Marathi,
picks out what you've committed to, and turns each one into a task with a date, a time and a
priority. When you say it's done, it ticks it off. Everything runs on this laptop.

## The privacy contract, and where the code enforces it

| Rule | How it's enforced |
| --- | --- |
| Speech is recognised on the device | Chrome's recogniser runs with `processLocally = true` ([public/js/ears.js](public/js/ears.js)). If a language has no on-device pack, Vachan refuses to listen in it instead of falling back to Google's servers. |
| Audio is never stored | Audio never reaches our code, only text does. The server accepts only `application/json` up to 32 KB, so an audio upload gets `415` ([server.js](server.js)). The database has no table for audio. |
| The AI is local | Gemma 4 runs in Ollama on `127.0.0.1:11434`. The client refuses any Ollama address that isn't loopback, and ignores Ollama "cloud" models ([src/ollama.js](src/ollama.js)). |
| Only this computer can talk to the server | It binds to `127.0.0.1` only. Requests must come from a loopback socket, carry a `localhost`/`127.0.0.1` Host header (which blocks DNS rebinding), and be same-origin (which blocks other websites in your browser) ([src/guard.js](src/guard.js)). |
| Nothing goes to the cloud | The page's Content-Security-Policy allows connections to this server only, and the status bar counts every blocked attempt. There are no npm dependencies. |

## Run

```bash
npm start
```

Then open **http://127.0.0.1:5181 in Google Chrome**. The preflight panel lists anything still missing.

```bash
npm test
```

## How the brain works

1. Chrome splits speech into short lines, often mid-sentence ("Reminding me to call" / "Showroom").
   While words are still appearing, the page sends a no-text "still talking" ping. After a
   1.5-second pause (3 s if the line ends mid-sentence, like "…task of" or "…tak"), Vachan reads the
   waiting lines.
2. **It re-reads the whole thought.** Lines that came just before, within 6 s of each other, are
   read again with the new ones, together with what was made from them. So the first half can be
   corrected once the second half arrives: "Call" becomes "Call the showroom", and "Add one more
   task" is removed. Only tasks made from that same thought can be removed.
3. Gemma 4 receives the passages along with a date table where every way of saying a day is already
   resolved ("उद्या → 2026-10-10", "शुक्रवार → 2026-10-16"), your open tasks, and a few earlier lines.
   Its reply is constrained to a JSON schema with four lists: `done`, `update`, `remove` and `add`
   ([src/brain.js](src/brain.js)).
4. The reply is streamed. Each action is checked and saved the moment its closing brace arrives, and
   tick-offs come first.
5. Checks before anything is written:
   - low-confidence actions are dropped;
   - repeats of an open task are merged into it, so new details aren't lost;
   - tick-offs and updates must quote words from the new lines, not the earlier context;
   - "in 20 minutes" and dates are computed by the code;
   - a weekday said on that same weekday means next week's;
   - announcements ("add one more task") and placeholder titles ("…about something") are refused;
   - a proposal built from the same words as a task from this thought, plus more, updates that task;
   - dates and "Remind me to" are kept out of titles.
6. Gemma is primed at startup and re-primed while idle, so the fixed part of the prompt stays in
   Ollama's cache (prompt reading takes about 0.5 s).
7. Each run is logged with what Gemma proposed, what was applied, why anything was skipped, and how
   long it took from when you stopped speaking to when the board changed. Click ▸ on a `gemma` row to
   see it.

Measured on an RTX 4060 laptop GPU with gemma4:e4b, from the end of speech to the change on the
board, with speech arriving at the pace Chrome really finalises it (about 2.2 s per line): tick-off
about 2.3 s, new task about 2.7 s (median), correction about 3.0 s. Score on the 17-scenario
Hinglish, Marathi and English benchmark, which includes the user's own recorded speech: 22/22 checks.

Typed tasks go through the same parser, so "call the bank tomorrow 10am" gets a date and time. If
Gemma isn't loaded, the task is added exactly as typed.

## Capture sources (read, decide, forget)

All capture follows one rule — read, decide, **forget** — and goes through the same pipeline
([src/screen.js](src/screen.js) → Gemma → task, raw text discarded). Protections (hide OTPs /
passwords / keys, mask cards) are **on by default** and can be turned off per kind in Settings.

- **Voice** and **typing** — always on. Live speech is recognised in Chrome on-device; Marathi (no
  Chrome pack) falls back to the Hindi recogniser. A **High accuracy** toggle instead records a clip
  and transcribes it with **Gemma's own audio model** via local Ollama — far better for Hindi,
  Marathi and fast speech — the audio staying in memory and never written to disk
  ([src/ollama.js](src/ollama.js) `transcribeAudio`, `POST /api/transcribe`). Gemma also silently
  corrects misheard words using your learned names and terms.
- **This laptop's notifications** (Windows, opt-in) — [src/win-notifications.js](src/win-notifications.js)
  runs Windows' `UserNotificationListener` ([the .ps1 sensor](src/sensors/win-notifications.ps1)) to
  read desktop app notifications (Slack, Teams, Outlook, WhatsApp desktop, Claude…) and make tasks
  from the actionable ones. Off until enabled in Settings; it baselines what's already there and only
  captures new notifications after that.
- **Phone** — the Android sensor (notifications + messages you send), sent over `adb reverse` with a
  pairing token. Capture surface is built; the Android app is the next step.
- **Paste / share** — the box in the Sources tab.

## The phone feed (read, decide, forget)

Vachan can take in your phone's app events — notifications from every app, and the messages you
send — and turn the ones that need you into tasks. It's built on the capture points meant for this
(Android's notification listener and a scoped accessibility service), not a screen scraper, and it
follows a read-decide-forget rule:

1. **Screen** ([src/screen.js](src/screen.js)): OTPs, verification codes, passwords, PINs, API keys
   and password-manager content are dropped before the model sees them, and card numbers are masked.
   This runs on the phone and again on the laptop. Only the reason for a withhold is counted, never
   the text.
2. **Decide**: Gemma reads each surviving event and adds a task only if it needs you — a request
   someone made, a commitment you made in a message, a bill, a delivery, an appointment. Most
   notifications (news, promos, likes, group chatter) produce nothing.
3. **Forget**: once the task is made, the raw event text is discarded. For phone events Vachan keeps
   only the distilled task (title, person, date) — not even the quote. Nothing is stored as an
   utterance, and the model's wording-bearing output is not written to the run log. What remains is
   the task plus a per-app tally (events read, tasks made, withheld) with no content.

The hub stays loopback-only. The phone reaches it over an `adb reverse` tunnel (USB or wireless
debugging), so nothing travels the network, and every event must carry a pairing token. The
**Phone feed** panel shows the tallies and a "Try it without your phone" box that runs pasted
notifications through the real pipeline.

Tested end to end ([test/screen.test.js](test/screen.test.js) and a phone-ingest harness): a burst
of 8 realistic notifications produced 4 correct tasks (medicines, credit-card bill, a report
promised in a sent message, a deck request), withheld the OTP, ignored promos, likes and group
banter, and left no raw message body on disk.

## Build plan

1. ✅ **Ears**: the local-only server, privacy guards, preflight checks, continuous on-device
   transcription in en/hi/mr, and a transcript log you can delete lines from.
2. ✅ **Brain**: Gemma 4 extracts tasks (what, for whom, due date and time, priority, category,
   kind) from each pause in speech, and ticks tasks off when you say they're done. It also parses
   typed tasks, and the board shows tasks grouped by due date.
   - ✅ **2.1 Accuracy and speed**: streaming, `update` corrections, details and cut-off warnings,
     grounding checks, name hints for Chrome's recogniser, and a primed prompt cache.
   - ✅ **2.2 Whole-thought understanding**: re-reading the thought, `remove`, and refusing announcements and placeholders.
   - ✅ **2.3 Lists, plans and learning**: a long dictation becomes one task per item; "Monday's task… Tuesday's task…" sets each day; project names and acronyms are kept verbatim; new tasks no longer merge into stale ones from an earlier session; and Vachan learns your recurring terms (feeding them to the model and the recogniser) so names stay consistent.
   - ✅ **2.4 Coreference and editing**: one task described across pieces stays one ("order the component for the ESD project… it's the STM32 Blackpill" → a single task), a fuller restatement edits the earlier stub instead of duplicating it, and "add another task for X" is recognised as an announcement, not a task.
   - ✅ **2.5 Robust dedup**: a plan item re-heard slightly differently, or re-dictated later, collapses into one task — same-day tasks that share words, or near-identical titles, merge (keeping the fuller wording) regardless of how long ago the first was added.
3. 🟡 **Phone feed**: notifications from every app + messages you send → tasks, on-device, read-decide-forget. Laptop pipeline ✅; Android sensor next.
4. ✅ **Calendar**: a built-in week calendar that auto-schedules timeless tasks into free slots
   (accept or clear each suggestion), and an iCalendar feed ([src/calendar.js](src/calendar.js))
   the desktop calendar app subscribes to or imports — served only from `127.0.0.1`, key-gated.
   Windows has no API to write the built-in Calendar store directly, so sync is the standard `.ics`
   subscription/import; Google Calendar (cloud) can't reach the laptop, so it uses the download.
5. ✅ **Ask**: questions like *"What did I promise people this week?"* answered on-device by Gemma
   from your own task list ([src/brain.js](src/brain.js) `ask()`, `POST /api/ask`).
6. ✅ **Clean multi-tab UI**: a left-sidebar app with Tasks (Today/Upcoming/All), Calendar, Sources
   (tasks grouped by person or app, with provenance, + the phone feed), Ask, and Settings
   (permission toggles incl. an OTP/banking opt-in, working hours, model status, calendar sync,
   languages, the opt-in assistant bridge, theme). Light and dark.
7. ✅ **Habits**: priority that adapts to you. Gemma judges genuine importance from tone (it sees
   through sarcasm — "the MOST important task ever haha" about a trivial errand stays low), and
   [src/habits.js](src/habits.js) learns from what you actually do — finishing a kind fast, skipping
   it, or re-prioritising it by hand (tap a task's P badge) — then nudges new tasks' priority to
   match, with a visible reason. Cleanup dismissals and the generic "todo/other" defaults are
   ignored so they don't skew what it learns.
7. ⬜ **Sync**: an .ics export for the device calendar, plus an opt-in Google Calendar push that sends
   task titles and times only.
