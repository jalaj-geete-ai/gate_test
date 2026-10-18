// ===========================================================================
// scholarship-api — Global Careers by Testbook scholarship test
//
// Every rule that decides who gets a free course lives in this file, on the
// server, because anything shipped to the browser is negotiable. In
// particular the answer key never crosses the wire: papers go out with the
// options only, and scoring happens here against question_ids the client
// cannot change.
//
// The client holds the anon key. The anon role has no RLS policy on any
// scholarship_* table, so it can read nothing directly; this function runs
// under the service role and is the only way in.
// ===========================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const fail = (code: string, message: string, status = 400, extra: Record<string, unknown> = {}) =>
  json({ ok: false, code, message, ...extra }, status);

// --- config ---------------------------------------------------------------
let cfgCache: Record<string, string> | null = null;
let cfgAt = 0;
async function config(): Promise<Record<string, string>> {
  if (cfgCache && Date.now() - cfgAt < 30_000) return cfgCache;
  const { data } = await db.from("scholarship_config").select("key,value");
  cfgCache = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  cfgAt = Date.now();
  return cfgCache;
}
const num = (c: Record<string, string>, k: string, d: number) => {
  const n = Number(c[k]);
  return Number.isFinite(n) ? n : d;
};

// --- validation -----------------------------------------------------------
// "Strictly 10 numerical digits" as specified, plus the leading 6-9 that every
// real Indian mobile number has. That extra digit-class check is what rejects
// 1234567890 and 0000000000, the two most common junk entries in a lead form.
const PHONE_RE = /^[6-9][0-9]{9}$/;
// \p{M} matters: Indic scripts build a syllable from a letter plus combining
// marks, so "प्रिया" is letter+mark+letter+mark+... Without \p{M} this regex
// rejects most names written in Devanagari, Tamil or Bengali.
const NAME_RE = /^[\p{L}][\p{L}\p{M}\s.'-]{1,59}$/u;

const clean = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return (xff.split(",")[0] || req.headers.get("x-real-ip") || "").trim() || "unknown";
}

const token = () =>
  [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

// Fisher-Yates. Math.random is fine here: shuffling a paper is not a secret,
// it only has to be unpredictable to a student comparing notes.
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- window ---------------------------------------------------------------
type Phase = "before" | "open" | "entry_closed" | "closed";
async function windowState() {
  const c = await config();
  const now = new Date();
  const open = new Date(c.window_open_utc);
  const entry = new Date(c.window_entry_utc);
  const close = new Date(c.window_close_utc);
  let phase: Phase = "before";
  if (now >= close) phase = "closed";
  else if (now >= entry) phase = "entry_closed";
  else if (now >= open) phase = "open";
  return { now, open, entry, close, phase, cfg: c };
}

// When the answer key and marks become visible (6:00 PM IST on test day), and
// when the winners are announced. Scores exist from the moment a paper is
// submitted -- the test is marked hand to hand -- but nothing is shown until
// this moment, so no one can work out the key from other students' results
// while the window is still open.
async function resultGate() {
  const c = await config();
  const at = new Date(c.results_visible_utc);
  const winners = new Date(c.winners_announce_utc);
  return { ready: new Date() >= at, at, winners };
}

// A dry run for the team before the real thing. Demo callers must present the
// key held in config, which is checked here rather than trusted from the
// page, and `demo_enabled` turns the whole path off with one row before
// go-live. Everything a demo caller creates is flagged is_demo and filtered
// out of every reporting view, so a rehearsal cannot reach the leaderboard,
// the CRM export or the integrity review.
async function isDemo(body: Record<string, unknown>): Promise<boolean> {
  const c = await config();
  if (c.demo_enabled === "false") return false;
  const k = clean(body.demo_key, 64);
  return !!k && !!c.demo_key && k === c.demo_key;
}

// ===========================================================================
// admin — the internal leaderboard. Everything it returns is personal data
// (names, numbers, scores), so it is gated on a key held in config and never
// shipped in the page: the page asks the operator for it and forwards it.
// Reads come from the three reporting views, which already exclude demo rows
// and carry rank, tie groups and the prize band.
// ===========================================================================
async function isAdmin(body: Record<string, unknown>): Promise<boolean> {
  const c = await config();
  const k = clean(body.admin_key, 80);
  if (!k || !c.admin_key) return false;
  // Length-independent compare, so a wrong key cannot be narrowed down by
  // timing the response.
  const a = new TextEncoder().encode(k);
  const b = new TextEncoder().encode(c.admin_key);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function admin(body: Record<string, unknown>) {
  if (!(await isAdmin(body))) {
    return fail("unauthorized", "That admin key is not valid.", 401);
  }
  const w = await windowState();
  const g = await resultGate();

  const [lead, att, results, ties, leads] = await Promise.all([
    db.from("scholarship_leads").select("id,is_demo"),
    db.from("scholarship_attempts").select("status,submit_reason,score,is_demo"),
    db.from("scholarship_results").select("*").order("rank", { ascending: true }),
    db.from("scholarship_tie_groups").select("*").order("rank", { ascending: true }),
    db.from("scholarship_lead_export").select("*").order("registered_at", { ascending: false }),
  ]);

  const realLeads = (lead.data ?? []).filter((r) => r.is_demo !== true);
  const realAtt = (att.data ?? []).filter((r) => r.is_demo !== true);
  const done = realAtt.filter((a) => a.status !== "in_progress");
  const scores = done.map((a) => a.score ?? 0);
  const by = (reason: string) => done.filter((a) => a.submit_reason === reason).length;

  return json({
    ok: true,
    server_now: w.now.toISOString(),
    phase: w.phase,
    results_visible_at: g.at.toISOString(),
    results_published: g.ready,
    summary: {
      registered: realLeads.length,
      started: realAtt.length,
      in_progress: realAtt.length - done.length,
      submitted: done.length,
      not_started: realLeads.length - realAtt.length,
      submitted_manually: by("manual"),
      auto_timer: by("timer"),
      auto_navigation: by("navigation"),
      auto_strikes: by("strikes"),
      highest: scores.length ? Math.max(...scores) : null,
      lowest: scores.length ? Math.min(...scores) : null,
      average: scores.length
        ? Math.round((scores.reduce((x, y) => x + y, 0) / scores.length) * 10) / 10
        : null,
    },
    leaderboard: results.data ?? [],
    tie_groups: ties.data ?? [],
    registrations: leads.data ?? [],
  });
}

// ===========================================================================
// register — create the lead. This is the lead-gen moment, so it stays as
// forgiving as it can be while still throttling the obvious abuse.
// ===========================================================================
async function register(req: Request, body: Record<string, unknown>) {
  const name = clean(body.name, 60);
  const phone = clean(body.phone, 10);
  const deviceId = clean(body.device_id, 64);
  const fpHash = clean(body.fp_hash, 64);
  const ip = clientIp(req);

  if (!NAME_RE.test(name)) return fail("bad_name", "Please enter your full name.");
  if (!PHONE_RE.test(phone)) {
    return fail("bad_phone", "Enter a valid 10-digit mobile number (starting 6, 7, 8 or 9).");
  }
  const demo = await isDemo(body);

  // Already registered? Re-registering is not an error — a student may come
  // back on test day from the same link. Hand back the same lead.
  const { data: existing } = await db
    .from("scholarship_leads").select("id,name").eq("phone", phone).maybeSingle();

  if (existing) {
    const { data: att } = await db
      .from("scholarship_attempts").select("status,is_demo").eq("lead_id", existing.id).maybeSingle();
    const countsAgainstThem = !!att && (att.is_demo !== true || demo);
    return json({
      ok: true, lead_id: existing.id, name: existing.name, returning: true,
      attempted: countsAgainstThem && att!.status !== "in_progress",
    });
  }

  const c = await config();
  if (c.registration_open === "false") {
    return fail("registration_closed", "Registration for this test has closed.", 403);
  }

  // Device throttle. A fresh localStorage id is cheap to clear, so it is
  // paired with a passive fingerprint: clearing one still trips the other.
  const maxDev = num(c, "max_leads_per_device", 3);
  // A rehearsing team shares a handful of laptops, so the throttles that
  // protect the real funnel would block them within minutes.
  if (deviceId && !demo) {
    const { count } = await db.from("scholarship_leads")
      .select("id", { count: "exact", head: true }).eq("device_id", deviceId);
    if ((count ?? 0) >= maxDev) {
      return fail("device_limit",
        "This device has already been used to register the maximum number of students.", 429);
    }
  }
  if (fpHash && !demo) {
    const { count } = await db.from("scholarship_leads")
      .select("id", { count: "exact", head: true }).eq("fp_hash", fpHash);
    if ((count ?? 0) >= maxDev * 3) {
      return fail("device_limit",
        "This device has already been used to register the maximum number of students.", 429);
    }
  }
  // IP throttle is deliberately loose: a school lab or a college hostel puts
  // dozens of genuine students behind one address.
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count: ipCount } = await db.from("scholarship_leads")
    .select("id", { count: "exact", head: true })
    .eq("register_ip", ip).gte("registered_at", since);
  if (!demo && (ipCount ?? 0) >= num(c, "max_leads_per_ip_hour", 30)) {
    return fail("ip_limit", "Too many registrations from this network. Please try again later.", 429);
  }

  const { data: lead, error } = await db.from("scholarship_leads").insert({
    name, phone, device_id: deviceId || null, fp_hash: fpHash || null,
    register_ip: ip, user_agent: clean(req.headers.get("user-agent"), 300),
    utm: (body.utm && typeof body.utm === "object") ? body.utm : {},
    is_demo: demo,
  }).select("id,name").single();

  // Two tabs submitting at once both pass the existence check above.
  if (error?.code === "23505") {
    const { data: raced } = await db
      .from("scholarship_leads").select("id,name").eq("phone", phone).single();
    return json({ ok: true, lead_id: raced!.id, name: raced!.name, returning: true });
  }
  if (error) return fail("db_error", "Could not complete registration. Please try again.", 500);

  return json({ ok: true, lead_id: lead.id, name: lead.name, returning: false });
}

// ===========================================================================
// status — what the landing page polls. Server time is authoritative so the
// countdown cannot be skipped by changing the device clock.
// ===========================================================================
async function status(body: Record<string, unknown>) {
  const w = await windowState();
  const out: Record<string, unknown> = {
    ok: true,
    server_now: w.now.toISOString(),
    window_open: w.open.toISOString(),
    window_entry_close: w.entry.toISOString(),
    window_close: w.close.toISOString(),
    phase: w.phase,
    duration_minutes: num(w.cfg, "duration_minutes", 30),
    questions_per_paper: num(w.cfg, "questions_per_paper", 30),
    max_strikes: num(w.cfg, "max_strikes", 3),
    tab_away_seconds: num(w.cfg, "tab_away_seconds", 10),
    results_visible_at: w.cfg.results_visible_utc,
    winners_announce_at: w.cfg.winners_announce_utc,
    results_ready: new Date() >= new Date(w.cfg.results_visible_utc),
    // Served from config so the community link can be rotated without a
    // redeploy; the page carries the same URL as a fallback.
    whatsapp_url: w.cfg.whatsapp_community_url ?? null,
  };
  const phone = clean(body.phone, 10);
  if (PHONE_RE.test(phone)) {
    const { data: lead } = await db
      .from("scholarship_leads").select("id,name").eq("phone", phone).maybeSingle();
    if (lead) {
      out.lead_id = lead.id;
      out.name = lead.name;
      const { data: att } = await db.from("scholarship_attempts")
        .select("status,score,is_demo").eq("lead_id", lead.id).maybeSingle();
      // A rehearsal attempt is not an attempt. The team dry-runs the demo
      // page with their own numbers, and the live page shares an origin with
      // it, so without this filter the first thing they see on the real page
      // is "You have already taken this test" -- a lock the live `start`
      // would never actually have applied.
      const demoCaller = await isDemo(body);
      out.attempt_status = (att && (att.is_demo !== true || demoCaller))
        ? att.status : null;
    }
  }
  return json(out);
}

// ===========================================================================
// start — issues the paper. Enforces the window and the one-attempt rule,
// and returns questions with the answer key stripped.
// ===========================================================================
async function start(req: Request, body: Record<string, unknown>) {
  const w = await windowState();
  const c = w.cfg;

  const leadId = clean(body.lead_id, 40);
  const phone = clean(body.phone, 10);
  let lead: { id: string; name: string } | null = null;
  if (leadId) {
    const { data } = await db.from("scholarship_leads")
      .select("id,name").eq("id", leadId).maybeSingle();
    lead = data;
  } else if (PHONE_RE.test(phone)) {
    const { data } = await db.from("scholarship_leads")
      .select("id,name").eq("phone", phone).maybeSingle();
    lead = data;
  }
  if (!lead) return fail("not_registered", "Please register before starting the test.", 404);

  const demo = await isDemo(body);

  // An attempt already on file decides everything that follows.
  let { data: prior } = await db.from("scholarship_attempts")
    .select("*").eq("lead_id", lead.id).maybeSingle();

  // A rehearsal is meant to be repeatable, so whatever the demo lead left
  // behind is cleared and run again. The same clearance applies to a live
  // caller: a dry run must never consume a student's one real attempt, and
  // the one-attempt unique index would otherwise refuse the real row.
  if (prior && prior.is_demo === true) {
    await db.from("scholarship_events").delete().eq("attempt_id", prior.id);
    await db.from("scholarship_attempts").delete().eq("id", prior.id);
    prior = null;
  }

  if (prior && prior.status === "in_progress") {
    // The student opened the paper, left it, and has come back. Leaving ends
    // the attempt: resuming would make a refresh the way to shake off
    // accumulated strikes, which is exactly the hole the strike rule exists
    // to close. The answers autosaved up to that point are what gets marked,
    // so they lose the remaining time rather than the work.
    const over = w.now >= new Date(prior.expires_at);
    await finalise(prior, prior.answers ?? {},
      over ? "timer" : "navigation",
      over ? "expired" : "auto_submitted");
    return fail("submitted_on_exit",
      over
        ? "Your 30 minutes are over and the test has been submitted."
        : "Your test was submitted when you left the test page. Only one attempt is allowed.",
      403);
  }

  if (prior) {
    return fail("already_attempted",
      "Our records show you have already taken this test. Only one attempt is allowed.", 403);
  }

  // The window is the real gate; only a verified demo caller steps past it.
  if (!demo) {
    if (w.phase === "before") return fail("not_open", "The test has not started yet.", 403);
    if (w.phase === "entry_closed") {
      return fail("entry_closed", "Entry to the test has closed. The last start time was 4:30 PM.", 403);
    }
    if (w.phase === "closed") return fail("closed", "This test is now closed.", 403);
  }

  // Draw the paper. Each student gets a different subset in a different
  // order with the options shuffled, so a screenshot shared mid-window is
  // worth very little to whoever receives it.
  const wanted = num(c, "questions_per_paper", 30);
  const { data: pool } = await db.from("scholarship_questions")
    .select("id,options").eq("active", true);
  if (!pool || pool.length === 0) {
    return fail("no_questions", "The question paper is not ready. Please contact support.", 503);
  }
  const picked = shuffle(pool).slice(0, Math.min(wanted, pool.length));
  const qids = picked.map((q) => q.id);
  const order: Record<string, number[]> = {};
  for (const q of picked) {
    order[String(q.id)] = shuffle([...Array((q.options as unknown[]).length).keys()]);
  }

  const durationMs = num(c, "duration_minutes", 30) * 60_000;
  // Whichever comes first: the student's own 30 minutes, or the hard close.
  // A demo run is not inside the window at all, so it just gets the full 30.
  const expires = demo
    ? new Date(w.now.getTime() + durationMs)
    : new Date(Math.min(w.now.getTime() + durationMs, w.close.getTime()));

  const { data: created, error } = await db.from("scholarship_attempts").insert({
    lead_id: lead.id, token: token(), question_ids: qids, option_order: order,
    expires_at: expires.toISOString(), start_ip: clientIp(req),
    device_id: clean(body.device_id, 64) || null, is_demo: demo,
  }).select("*").single();

  if (error?.code === "23505") {
    return fail("already_attempted",
      "Our records show you have already taken this test. Only one attempt is allowed.", 403);
  }
  if (error) return fail("db_error", "Could not start the test. Please try again.", 500);

  return json({
    ok: true, resumed: false, token: created.token, name: lead.name,
    questions: await buildPaper(qids, order), answers: {}, marked_review: [], strikes: 0,
    server_now: w.now.toISOString(), expires_at: created.expires_at,
    max_strikes: num(c, "max_strikes", 3),
    tab_away_seconds: num(c, "tab_away_seconds", 10),
  });
}

// Build the student-facing paper. The select list is explicit and omits
// correct_index — the key is never loaded into this function's memory at all
// on this path, let alone serialised to the client.
async function buildPaper(qids: number[], order: Record<string, number[]>) {
  const { data } = await db.from("scholarship_questions")
    .select("id,question,options,subject").in("id", qids);
  const byId = new Map((data ?? []).map((q) => [q.id, q]));
  return qids.map((id, i) => {
    const q = byId.get(id)!;
    const opts = q.options as string[];
    const ord = order[String(id)] ?? [...Array(opts.length).keys()];
    return { n: i + 1, id, question: q.question, subject: q.subject, options: ord.map((o) => opts[o]) };
  });
}

// ===========================================================================
// sync — autosave plus the integrity log. Called on every answer change and
// on every proctoring event, so a browser that dies mid-test still has the
// student's work on the server.
// ===========================================================================
async function sync(body: Record<string, unknown>) {
  const t = clean(body.token, 64);
  const { data: att } = await db.from("scholarship_attempts")
    .select("*").eq("token", t).maybeSingle();
  if (!att) return fail("bad_token", "Session not found.", 404);
  if (att.status !== "in_progress") {
    return fail("already_submitted", "This test has already been submitted.", 409);
  }

  const now = new Date();
  const patch: Record<string, unknown> = { last_seen_at: now.toISOString() };
  if (body.answers && typeof body.answers === "object") patch.answers = body.answers;
  if (Array.isArray(body.marked_review)) patch.marked_review = body.marked_review;
  if (typeof body.strikes === "number") patch.strikes = Math.max(att.strikes, body.strikes | 0);

  await db.from("scholarship_attempts").update(patch).eq("id", att.id);

  if (body.event && typeof body.event === "object") {
    const ev = body.event as Record<string, unknown>;
    await db.from("scholarship_events").insert({
      attempt_id: att.id, lead_id: att.lead_id,
      kind: clean(ev.kind, 40) || "unknown",
      detail: ev.detail ?? {}, counted: ev.counted !== false,
    });
  }

  const remaining = Math.max(0, Math.floor((new Date(att.expires_at).getTime() - now.getTime()) / 1000));
  return json({ ok: true, server_now: now.toISOString(), remaining_seconds: remaining });
}

// ===========================================================================
// submit — the only place a score is ever produced.
// ===========================================================================
async function submit(body: Record<string, unknown>) {
  const t = clean(body.token, 64);
  const { data: att } = await db.from("scholarship_attempts")
    .select("*").eq("token", t).maybeSingle();
  if (!att) return fail("bad_token", "Session not found.", 404);

  const g = await resultGate();
  const gateInfo = {
    results_ready: g.ready,
    results_visible_at: g.at.toISOString(),
    winners_announce_at: g.winners.toISOString(),
    server_now: new Date().toISOString(),
  };

  if (att.status !== "in_progress") {
    return json({
      ok: true, already: true, submitted: true, ...gateInfo,
      total: att.question_ids.length,
      ...(g.ready
        ? { score: att.score, correct: att.correct_count,
            wrong: att.wrong_count, unanswered: att.unanswered_count }
        : {}),
    });
  }

  const answers = (body.answers && typeof body.answers === "object")
    ? body.answers as Record<string, number> : (att.answers ?? {});
  const reason = clean(body.reason, 20) || "manual";
  const r = await finalise(att, answers, reason,
    reason === "manual" ? "submitted" : "auto_submitted");

  // The paper is marked immediately, but the marks stay behind the gate.
  return json({
    ok: true, submitted: true, ...gateInfo,
    total: r.total, status: r.status,
    ...(g.ready
      ? { score: r.score, correct: r.correct, wrong: r.wrong, unanswered: r.unanswered }
      : {}),
  });
}

// ===========================================================================
// result -- marks plus the full answer key, released only after the gate.
// ===========================================================================
async function result(body: Record<string, unknown>) {
  const g = await resultGate();
  const now = new Date();

  let att: Record<string, any> | null = null;
  let leadName = "";

  const t = clean(body.token, 64);
  if (t) {
    const { data } = await db.from("scholarship_attempts").select("*").eq("token", t).maybeSingle();
    att = data;
    if (att) {
      const { data: l } = await db.from("scholarship_leads")
        .select("name").eq("id", att.lead_id).maybeSingle();
      leadName = l?.name ?? "";
    }
  } else {
    const phone = clean(body.phone, 10);
    if (!PHONE_RE.test(phone)) {
      return fail("bad_phone", "Enter the 10-digit mobile number you registered with.");
    }
    const { data: lead } = await db.from("scholarship_leads")
      .select("id,name").eq("phone", phone).maybeSingle();
    if (!lead) return fail("not_registered", "We have no record of this number.", 404);
    leadName = lead.name;
    const { data } = await db.from("scholarship_attempts")
      .select("*").eq("lead_id", lead.id).maybeSingle();
    att = data;
  }

  // Same rule as `status`: a rehearsal attempt is not the student's result.
  // Without this, a team member who dry-ran the demo would be shown their
  // practice score as their real one on 21 October.
  if (att && att.is_demo === true && !(await isDemo(body))) att = null;
  if (!att) return fail("no_attempt", "We could not find a test attempt for this number.", 404);
  if (att.status === "in_progress") {
    return fail("in_progress", "Your test is still in progress.", 409);
  }

  // A demo attempt can see its own key immediately; real attempts wait for
  // the published release time like everyone else.
  const ready = g.ready || (att.is_demo === true && await isDemo(body));

  const base: Record<string, unknown> = {
    ok: true, name: leadName, is_demo: att.is_demo === true,
    results_ready: ready,
    results_visible_at: g.at.toISOString(),
    winners_announce_at: g.winners.toISOString(),
    server_now: now.toISOString(),
    total: (att.question_ids as number[]).length,
  };
  if (!ready) return json(base);

  // Past the gate, so the key can go out. Each entry is rebuilt in the option
  // order this particular student saw, otherwise "you answered B" would point
  // at a different option than the one on their screen.
  const { data: qs } = await db.from("scholarship_questions")
    .select("id,question,options,subject,correct_index,explanation").in("id", att.question_ids);
  const byId = new Map((qs ?? []).map((q) => [q.id, q]));

  const key = (att.question_ids as number[]).map((id, i) => {
    const q = byId.get(id);
    if (!q) return null;
    const opts = q.options as string[];
    const ord: number[] = att!.option_order?.[String(id)] ?? [...Array(opts.length).keys()];
    const shown = ord.map((o) => opts[o]);
    const correctPos = ord.indexOf(q.correct_index);
    const raw = (att!.answers ?? {})[String(id)];
    const yourPos = (raw === undefined || raw === null || raw < 0) ? null : Number(raw);
    return {
      n: i + 1, subject: q.subject, question: q.question, options: shown,
      your_choice: yourPos, correct_choice: correctPos,
      is_correct: yourPos !== null && yourPos === correctPos,
      explanation: q.explanation,
      marks: yourPos === null ? 0 : (yourPos === correctPos ? 4 : -1),
    };
  }).filter(Boolean);

  return json({
    ...base,
    score: att.score, correct: att.correct_count, wrong: att.wrong_count,
    unanswered: att.unanswered_count, duration_seconds: att.duration_seconds,
    status: att.status, submitted_at: att.submitted_at,
    answer_key: key,
  });
}

// Scores the paper against the key and closes the attempt out. Answers arrive
// as a display position; option_order maps that back to the real option, so a
// student reading the network tab learns nothing about which one is right.
async function finalise(
  att: Record<string, any>,
  answers: Record<string, number>,
  reason: string,
  status: string,
) {
  const c = await config();
  const marksRight = num(c, "marks_correct", 4);
  const marksWrong = num(c, "marks_wrong", -1);
  const { data: keys } = await db.from("scholarship_questions")
    .select("id,correct_index").in("id", att.question_ids);
  const keyById = new Map((keys ?? []).map((k) => [k.id, k.correct_index]));

  let correct = 0, wrong = 0, unanswered = 0;
  for (const qid of att.question_ids as number[]) {
    const raw = answers[String(qid)];
    if (raw === undefined || raw === null || raw < 0) { unanswered++; continue; }
    const ord: number[] = att.option_order?.[String(qid)] ?? [0, 1, 2, 3];
    const chosenOriginal = ord[raw as number];
    if (chosenOriginal === keyById.get(qid)) correct++; else wrong++;
  }
  const score = correct * marksRight + wrong * marksWrong;
  const now = new Date();
  const duration = Math.max(0,
    Math.round((now.getTime() - new Date(att.started_at).getTime()) / 1000));

  await db.from("scholarship_attempts").update({
    answers, status, submit_reason: reason, submitted_at: now.toISOString(),
    score, correct_count: correct, wrong_count: wrong,
    unanswered_count: unanswered, duration_seconds: duration,
  }).eq("id", att.id);

  return {
    score, correct, wrong, unanswered,
    total: (att.question_ids as number[]).length,
    duration_seconds: duration, status,
  };
}

// ===========================================================================
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail("method", "POST only", 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail("bad_json", "Invalid request body."); }

  const action = clean(body.action, 20);
  try {
    switch (action) {
      case "register": return await register(req, body);
      case "status":   return await status(body);
      case "start":    return await start(req, body);
      case "sync":     return await sync(body);
      case "submit":   return await submit(body);
      case "result":   return await result(body);
      case "admin":    return await admin(body);
      default:         return fail("bad_action", "Unknown action.");
    }
  } catch (e) {
    console.error("scholarship-api", action, e);
    return fail("server_error", "Something went wrong. Please try again.", 500);
  }
});
