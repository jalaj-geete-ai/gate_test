# Scholarship Test — Global Careers by Testbook

Landing page, test engine and anti-cheat for the scholarship test on
**Sunday 18 October 2026, 2:00–5:00 PM IST**.

* Top 3 → 100% scholarship (free programme)
* Ranks 4–10 → ₹60,000 off

| File | What it is |
|---|---|
| `scholarship.html` | The whole student-facing portal: landing, countdown, registration, instructions, test engine, result. Single file, no build step. |
| `gc_scholarship_questions.json` | **The live question paper** — 30 nursing MCQs with answers and explanations. Source of truth; edit here and re-import. |
| `gc_scholarship_questions_template.csv` | CSV import format, if you prefer a spreadsheet to JSON. |
| `gc_scholarship_build_demo.py` | Regenerates the dry-run page from the live one. |
| `gc_scholarship_api.ts` | Source of the `scholarship-api` Edge Function — the whole server half: scoring, the one-attempt rule, the window. Deployed copy of record. |
| `gc-admin.html` | **Admin dashboard**, served at `/gc-admin`. Leaderboard, every registration, tie groups, CSV and Excel export. Key-gated. |
| `gc_logo.png` | Brand logo, white field flood-filled out to transparency. |
| `gc_bg_desktop.jpg` / `gc_bg_mobile.jpg` | Hero backgrounds, served at ~34% opacity under a white scrim. |

Backend lives in Supabase project `uxdrldreaockdloqvojs`:
Edge Function **`scholarship-api`** plus the `scholarship_*` tables and views.

---

## Why the answer key is not in the page

The browser never receives `correct_index`. `scholarship-api` builds each
paper with an explicit column list that omits it, and scoring happens
server-side in `finalise()`. Every `scholarship_*` table has RLS enabled with
**no policies**, and the `anon` role has had its grants revoked, so the anon
key embedded in the HTML can read nothing at all. The only way in is the Edge
Function, which runs as the service role.

This matters because the prize is a free course. If the key shipped with the
page, View Source would be worth ₹1,00,000+.

---

## Leaving the test ends the attempt

Up to the moment **Begin test** is pressed, nothing exists: a student can open
the instructions, press Back, and walk in again freely. No attempt row is
created until they begin.

After that, **refreshing or leaving the test submits the paper**. This closes
the obvious hole in the strike rule — without it, a refresh would shake off
accumulated strikes and hand back a clean slate. It works in two places so a
missed browser event cannot defeat it:

* the page fires a `keepalive` submit on `pagehide`, and catches the back
  button via `popstate`;
* `start` refuses to resume an attempt that is already open, closing it out
  with whatever was autosaved.

Answers autosave continuously, so what a student loses by leaving is the
remaining time, not the work. **The trade-off is real and worth knowing:** a
browser that reloads on its own — a crash, or an aggressive mobile OS killing
a backgrounded tab — ends that student's attempt. The `pagehide` handler
ignores back/forward-cache events precisely so an ordinary app switch does
not trigger it, but a genuine reload is indistinguishable from a deliberate
one and is treated as leaving.

## Registration is open from the moment you share the link

Registration does not wait for test day. Anyone landing on the page can enter
their name and number straight away, which is the point — the lead is captured
on first visit, days before anyone sits anything. The confirmation then states
the start time, the duration and pushes the WhatsApp community.

What waits for test day is only the Start Test button, and the server enforces
that: `start` returns `not_open` until 2:00 PM on 18 October regardless of what
the page shows.

## The dry run

> **The dry run is shut down.** `demo_enabled` is `'false'` and the rehearsal
> page is deleted, so nothing in this section is active. It is kept for the
> next time you need one — and read the note on rotating `demo_key` before you
> re-enable anything.

`seminar-edom.html` was the rehearsal page. It is **generated** from
the live page rather than maintained by hand, so it always exercises exactly
the code students will get:

```bash
python3 gc_scholarship_build_demo.py     # after any change to the live page
```

It differs in three ways and no others: a standing purple banner, a Start Test
button that ignores the countdown, and a demo key carried on every API call.

The key is what actually opens the paper. It is verified **server-side**
against `scholarship_config.demo_key` — the page only presents it, so the
window check cannot be bypassed by editing the page. Everything a demo caller
creates is flagged `is_demo` and filtered out of `scholarship_results`,
`scholarship_tie_groups` and `scholarship_lead_export`, so a rehearsal can
never reach the leaderboard, the CRM or the integrity review: all four views
-- `scholarship_lead_export`, `scholarship_results`, `scholarship_tie_groups`
and `scholarship_integrity` -- exclude them. Note what this does and does not
mean: a rehearsal still **writes rows** to `scholarship_leads`,
`scholarship_attempts` and `scholarship_events`. They are tagged and invisible
to everything you report from, not absent. `delete from scholarship_leads where
is_demo;` removes them whenever you want. Demo attempts are also repeatable: the
one-attempt rule holds absolutely for real students, but a demo attempt is
cleared and re-run so the team can go round more than once.

A dry run is also **invisible to the live page**. Both pages sit on one origin
and share one `localStorage` key, so after a rehearsal the live page boots
holding the tester's number — and `status`, `register` and `result` would have
reported that rehearsal as a real attempt, greeting the team with "You have
already taken this test" on the page they are about to send to students. All
three now hide an `is_demo` attempt from any caller without the demo key, and
`start` clears one outright so it can never consume a student's single real
attempt.

### Shutting the dry run down before go-live

```sql
update scholarship_config set value = 'false' where key = 'demo_enabled';
```

That one row kills the demo path entirely — the key stops working everywhere,
within the 30-second config cache and without a redeploy. Both steps are done
for 18 October: the row is set and `seminar-edom.html` is deleted.

Rotate `demo_key` to a fresh value every time you re-enable a dry run.
Cloudflare Pages keeps every past deployment alive at its own permanent URL, so
an old snapshot of a rehearsal page still exists and still presents whatever key
it was built with. A new key is what makes those snapshots inert — it is why the
`gcb-dryrun-…` key from the first rehearsal no longer opens anything.

Leads and attempts left over from the rehearsal are all flagged `is_demo`, so
they are already absent from `scholarship_lead_export`, `scholarship_results`
and `scholarship_tie_groups`. To remove them outright:

```sql
delete from scholarship_leads;   -- cascades to attempts and events
```

One thing to know if you keep them: a number that registered during the
rehearsal still carries `is_demo = true` on its **lead** row. If that person
sits the real test, their attempt counts normally and the one-attempt rule
applies to them as to anyone else, but the lead stays out of the CRM export.
The `delete` above is the clean fix.

## The admin dashboard

`/gc-admin` on the same domain. Three tabs — leaderboard, every registration,
and the tie groups that need a lucky draw — each sortable, searchable and
exportable to CSV or Excel.

It is gated on `scholarship_config.admin_key`, checked **server-side** in the
`admin` action with a constant-time compare. The page never contains the key:
it asks whoever opens it and holds the answer in `sessionStorage`, so closing
the tab forgets it. Rotate the key by updating that one config row; every open
session is locked out at its next refresh.

Everything the endpoint returns comes from the three reporting views, so demo
rows are excluded there as everywhere else.

### Attempts that were never finished

An attempt closes itself from the browser — the student submits, the timer
fires, or the page is left and the exit handler submits it. **A browser killed
outright does none of those**, so the row stays `in_progress` with its answers
saved but never marked, and a never-marked attempt has no score and does not
appear in `scholarship_results`.

The dashboard flags these in red once the window is closed, because at that
point they are abandoned papers rather than people still writing. They need
finalising before results go out, or those students simply vanish from the
rankings.

## Load

Sized for roughly 1,250 concurrent students. What each one costs:

| Request | When | Per student |
|---|---|---|
| `status` | landing page, every 60s while waiting | ~15 |
| `start` | once, at 2:00 PM | 1 |
| `sync` | ~1.2s after each answer, clear or review toggle | ~40 |
| `sync` | 45s heartbeat — **only if something is unsaved** | ~0 |
| `submit` | once | 1 |

The heartbeat used to fire every 20 seconds whether or not anything had
changed, so a student reading one question for three minutes wrote the same
row nine times. Every change already saves itself ~1.2s later, so the
heartbeat is now purely a safety net for a save that failed, and sends nothing
when nothing is pending.

That matters because each `sync` rewrites a wide row — `question_ids`,
`option_order` and `answers`, around 3 KB — and Postgres MVCC rewrites the
whole row every time. At 1,250 students this takes the test window from
roughly 160,000 row rewrites to 56,000, and the sustained request rate from
about 90/s to about 31/s. The pre-test polling burst halves to ~21/s.

`api()` resolves whatever the HTTP status was, so a 500 arrives as a body with
`ok` false rather than as a rejection. `doSync` therefore checks `ok === true`
before considering the work saved; anything else leaves it pending and retries
with exponential backoff and jitter, so a server wobble does not put the whole
cohort into lockstep retries.

If you ever expect appreciably more than 1,250, the lever is compute: the
project runs on a Micro instance (256 MB shared buffers), and autovacuum is
what falls behind first. Upgrade it in the Supabase dashboard **well before**
the window opens, not during.

## Timeline

| When (IST) | What |
|---|---|
| Sun 18 Oct, 2:00 PM | Test opens. Countdown hits zero, Start Test appears. |
| Sun 18 Oct, 4:30 PM | Last entry. Anyone who has started keeps their full 30 minutes. |
| Sun 18 Oct, 5:00 PM | Hard close. Any paper still open auto-submits. |
| Wed 21 Oct, 2:00 PM | **Everything lands together:** marks unlock on the result page, the answer key with explanations becomes downloadable, and the **winners are announced in the WhatsApp community**. |

The time of day on Wednesday was not specified, so 2:00 PM IST is assumed.
Change `results_visible_utc` and `winners_announce_utc` if the WhatsApp
announcement goes out at a different hour — both are config rows, no redeploy.

Papers are marked the instant they are submitted — the score exists in
`scholarship_attempts` immediately. What is withheld is *showing* it. On
submission the student gets confetti and a congratulations message naming the
6 PM release, and nothing else. The Edge Function refuses to return a score or
a key before `results_visible_utc`, so the gate is not a UI trick.

That gap exists for a reason: if scores were shown at 2:30 PM, students still
inside the window would learn the key from friends who had finished.

### The WhatsApp community

Winners are announced in the community, so joining it is how a student finds
out. The invite is offered in three places: on the registration confirmation,
in a popup after submitting (2.4 seconds in, once the confetti has landed so
the ask arrives on a clean screen), and as a standing card on the result page
for anyone who dismissed the popup.

The link lives in `scholarship_config.whatsapp_community_url` and is served
through `status`, so it can be rotated with one SQL update if the invite is
ever revoked. The page carries the same URL as a hard-coded fallback for the
case where the status call has not landed yet:

```sql
update scholarship_config set value = '<new invite link>'
 where key = 'whatsapp_community_url';
```

### Tie-break: lucky draw

Scholarships are decided on marks alone. Where students finish level, the
winners among them are drawn by lot — this is stated in the test instructions,
in the T&C the student ticks before starting, on the result screen and in the
downloaded answer key.

`scholarship_tie_groups` tells you exactly which draws to run:

```sql
select * from scholarship_tie_groups;   -- one row per score, with the action needed
select * from scholarship_results;      -- every student, ranked, ties sharing a rank
```

A tied group is flagged `DRAW`, with the positions it covers. A group that
straddles the top-3 cutoff needs a draw for both bands — e.g. four students on
116 occupying positions 2–5 means one of them misses the 100% band entirely.

## Loading the real questions

The live paper is **already loaded**: 30 nursing MCQs, placeholders retired.
`gc_scholarship_questions.json` is the source of truth — edit it there and
re-import so the repo and the database never drift apart.

```sql
-- confirm what is live
select count(*) filter (where not is_placeholder) as real_questions,
       count(*) filter (where is_placeholder)     as placeholders
from scholarship_questions where active;           -- expect 30, 0
```

### Question 4 — corrected

As supplied, Q4 gave **B) Blood sugar level** as the answer while its own
explanation described **Diabetes Insipidus**, which is monitored by urine
output and specific gravity. The answer and its explanation disagreed, and
the explanation publishes to every student at 6 PM.

It is now **C) Urine output and specific gravity**, with the explanation
rewritten to match (`SCH-04`). Both the database and
`gc_scholarship_questions.json` carry the correction.

If you ever need to change an answer again, do it **before 2 PM on test day**.
Scores are computed at submission, so an edit afterwards would leave the
published key disagreeing with marks already awarded.

### No A/B/C/D labels

Options carry no letter — not on the paper, not in the downloaded answer key.
Each student sees the options in their own shuffled order, so a letter would
point at a different option for the next student; removing it means there is
no shorthand ("Q2 is B, Q3 is C") worth passing around mid-window. The key
names the correct answer in words instead.

This is cosmetic only. An answer is stored as the *position* the student
clicked and mapped back through `option_order` on the server, so scoring never
used the letters and is unaffected.

### One paper for everyone — a deliberate choice

With exactly 30 questions and 30 served, every student sits the same paper.
**Keep it that way.** This was decided on fairness grounds: drawing a random
subset from a larger pool means two students are scored against different
questions, and with a ₹60,000 scholarship on the line the student who happened
to draw the harder set has a real grievance. One paper for everyone removes
that argument entirely.

The cost is accepted knowingly. Question order and option order are still
shuffled per student, which stops a plain "answer is B, C, A…" list being
useful, but it does **not** stop someone photographing the questions at
2:30 PM and sending them to a friend who starts at 4:00 PM. That is what
`scholarship_integrity` and the manual top-10 review before awarding are for.

**Do not "fix" this by loading more questions.** Adding more rows to
`scholarship_questions` than `questions_per_paper` silently switches the draw
back on and every student gets a different paper — which is the thing this
decision rules out. If the pool ever does need to grow, raise
`questions_per_paper` to match it in the same change.

---

## Operations

Everything is config, not code. Change a row in `scholarship_config` and it
takes effect within 30 seconds — no redeploy.

| Key | Value | Meaning |
|---|---|---|
| `window_open_utc` | `2026-10-18T08:30:00Z` | 2:00 PM IST |
| `window_entry_utc` | `2026-10-18T11:00:00Z` | 4:30 PM IST — last moment anyone may *start* |
| `window_close_utc` | `2026-10-18T11:30:00Z` | 5:00 PM IST — hard close, everything auto-submits |
| `duration_minutes` | `30` | Per-student clock |
| `questions_per_paper` | `30` | Drawn from the active pool |
| `marks_correct` / `marks_wrong` | `4` / `-1` | Unanswered always scores 0 |
| `max_strikes` | `3` | Strikes before auto-submission |
| `tab_away_seconds` | `10` | Seconds off-tab that count as a strike |
| `max_leads_per_device` | `3` | Registrations per device |
| `max_leads_per_ip_hour` | `30` | Loose on purpose — college labs share one IP |
| `registration_open` | `true` | Set `false` to close the form |
| `results_visible_utc` | `2026-10-21T08:30:00Z` | Wed 21 Oct, 2:00 PM IST — marks and key unlock |
| `winners_announce_utc` | `2026-10-21T08:30:00Z` | Wed 21 Oct, 2:00 PM IST — winners on WhatsApp |
| `whatsapp_community_url` | the invite link | Served to the page; rotate here if revoked |

```sql
-- move the window (e.g. postpone by a week)
update scholarship_config set value='2026-10-25T08:30:00Z' where key='window_open_utc';

-- import questions from a staged CSV table
insert into scholarship_questions (code,subject,difficulty,question,options,correct_index,active)
select code, subject, difficulty, question,
       to_jsonb(array[option_a,option_b,option_c,option_d]),
       ascii(upper(correct_option)) - 65,
       true
from staging_questions;
```

### Test day

```sql
select * from scholarship_results order by rank;            -- ranked; ties share a rank
select * from scholarship_tie_groups;                       -- which lucky draws to run
select * from scholarship_lead_export;                      -- every lead, for the CRM
select * from scholarship_integrity order by strikes desc;  -- who to look at twice
```

`scholarship_results` ranks on score alone; tied students share a rank and are
labelled `LUCKY DRAW` with the positions at stake. `scholarship_lead_export`
includes people who registered and never showed up — still leads worth calling.

### Before go-live

Twelve rows named `ZZTEST …` were inserted to prove the ranking and tie logic,
then marked `disqualified` so they are already excluded from every view. They
are harmless but untidy; deleting them needs a confirmed statement:

```sql
delete from scholarship_leads where name like 'ZZTEST %';   -- cascades to attempts
```

**Verify the top 10 against `scholarship_integrity` before promising anyone
money.** Look for high `strikes`, `leads_on_same_device > 1`, a suspiciously
low `minutes_taken`, or non-zero `devtools_attempts`.

---

## What the anti-cheat does and does not do

Enforced on the server, cannot be bypassed from a browser:

* **One attempt per lead** — a unique index on `scholarship_attempts.lead_id`.
  Not application logic; the database physically refuses a second row.
* **One lead per mobile number** — unique index, plus a `^[0-9]{10}$` check.
* **The clock** — start, expiry and the window are all server time. Changing
  the device clock does nothing.
* **The score** — computed server-side from question IDs the client can't alter.
* **Paper selection** — the same 30 questions for everyone, with question
  order and option order shuffled per student.

Client-side, a deterrent and an audit trail:

* 10 seconds off-tab = a strike; 3 strikes auto-submits.
* Copy, cut, paste, drag and right-click (mouse only — long-press still works
  on phones, where it's how you scroll) blocked.
* F12, Ctrl+Shift+I/J/C/K, Ctrl+U/S/P blocked; print CSS blanks the page.
* The paper is hidden the moment the window loses focus, so a screenshot taken
  mid-switch captures nothing.
* Opening the test in a second tab locks the older one.
* Fullscreen on desktop; leaving it is logged.
* Every switch, strike, clipboard attempt and devtools attempt is written to
  `scholarship_events` against the attempt.

**It cannot stop a second device.** Nothing that runs in a browser can. A
student with a phone beside their laptop is invisible to all of the above.
That is why scoring is server-side and why the top 10 should be verified —
and, if the scholarship is worth defending, why a short video call with the
winners before awarding is worth the half hour.

---

## Known gaps

* **Identity is unverified.** Name + number with no OTP was the chosen
  trade-off for conversion. A student can register a second number and sit the
  test again; the device and IP throttles raise the cost but do not remove it.
  Adding OTP later is a change to `register` in `scholarship-api` only.
* **No admin web page yet.** Reporting is the three SQL views above. A browser
  dashboard needs an `SCHOLARSHIP_ADMIN_KEY` secret set in the Supabase
  dashboard first.
* **Result lookup is by mobile number alone.** Anyone who knows a student's
  number could view that student's marks. That follows from having no OTP; it
  is consistent with the rest of the identity model, but worth knowing.
* **The paper is identical for everyone**, by choice — see "One paper for
  everyone" above. Question and option order are still shuffled per student,
  and there are no option letters to share, but the questions themselves can
  still be photographed and passed on. This is the accepted cost of scoring
  every student against the same questions.
