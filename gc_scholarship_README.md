# Scholarship Test — Global Careers by Testbook

Landing page, test engine and anti-cheat for the scholarship test on
**Sunday 18 October 2026, 2:00–5:00 PM IST**.

* Top 3 → 100% scholarship (free programme)
* Ranks 4–10 → ₹50,000 off

| File | What it is |
|---|---|
| `gc_scholarship_test.html` | The whole student-facing portal: landing, countdown, registration, instructions, test engine, result. Single file, no build step. |
| `gc_scholarship_questions_template.csv` | Drop the real questions in here, then import (below). |

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

## Loading the real questions

1. Fill in `gc_scholarship_questions_template.csv`. One row per question:
   `code, subject, difficulty, question, option_a..option_d, correct_option`
   where `correct_option` is the letter `A`–`D`.
2. Supabase dashboard → Table Editor → `scholarship_questions` → Import CSV,
   **or** run the import SQL in the "Operations" section below.
3. Deactivate the placeholders:
   ```sql
   update scholarship_questions set active = false where is_placeholder;
   ```
4. Confirm the live pool:
   ```sql
   select count(*) from scholarship_questions where active and not is_placeholder;
   ```

**The pool should be larger than 30.** Each student is served a random 30
drawn from the active pool with the options shuffled, so a bigger pool is what
stops the paper leaking on WhatsApp during the three-hour window. 90 is a good
target; 60 still helps a lot; exactly 30 means everyone sits the same paper.

The 90 rows currently loaded are **placeholders** — real arithmetic, so the
scoring path is testable end to end, but clearly labelled `[PLACEHOLDER n]`.
They must be deactivated before go-live.

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
select * from scholarship_results order by rank;        -- ranked, with scholarship band
select * from scholarship_lead_export;                  -- every lead, for the CRM
select * from scholarship_integrity order by strikes desc;  -- who to look at twice
```

`scholarship_results` ranks on score, breaking ties on time taken, and labels
the top 3 and ranks 4–10. `scholarship_lead_export` includes people who
registered and never showed up — still leads worth calling.

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
* **Results show a score, not a rank.** Ranks depend on everyone finishing, so
  they're announced afterwards by SMS.
