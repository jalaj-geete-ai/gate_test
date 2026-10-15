# Scholarship Test — Global Careers by Testbook

Landing page, test engine and anti-cheat for the scholarship test on
**Sunday 18 October 2026, 2:00–5:00 PM IST**.

* Top 3 → 100% scholarship (free programme)
* Ranks 4–10 → ₹60,000 off

| File | What it is |
|---|---|
| `gc_scholarship_test.html` | The whole student-facing portal: landing, countdown, registration, instructions, test engine, result. Single file, no build step. |
| `gc_scholarship_questions.json` | **The live question paper** — 30 nursing MCQs with answers and explanations. Source of truth; edit here and re-import. |
| `gc_scholarship_questions_template.csv` | CSV import format, if you prefer a spreadsheet to JSON. |

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

### The paper no longer has a pool

With exactly 30 questions and 30 served, every student sits the same paper.
Question order and option order are still shuffled per student, which stops a
plain "answer is B, C, A…" list being useful, but it does **not** stop someone
photographing the questions at 2:30 PM and sending them to a friend who starts
at 4:00 PM. The only real fix is more questions than the paper needs: adding
30–60 more to `scholarship_questions` turns the draw back on with no code
change.

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
* **Paper selection** — random 30 of the pool, options shuffled per student.

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
* **Only 30 questions exist**, so the paper is identical for everyone — see
  "The paper no longer has a pool" above. Question and option order are still
  shuffled per student, and there are no option letters to share, but the
  questions themselves can still be photographed and passed on.
