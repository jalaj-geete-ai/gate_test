import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Server-side answer key (0-indexed option positions)
const ANSWER_KEY: Record<string, number> = {
  q1: 1,  // 60–100 bpm
  q2: 1,  // 120/80 mmHg
  q3: 1,  // Nothing by Mouth
  q4: 2,  // 37°C
  q5: 3,  // 95–100%
  q6: 3,  // Vitamin K
  q7: 2,  // Pancreas
  q8: 1,  // 12–20 / min
  q9: 2,  // 1000 mL
  q10: 2, // 20 seconds
  q11: 3, // Intravenous
  q12: 2, // Hypoglycaemia
  q13: 1, // Intensive Care Unit
  q14: 2, // Airborne precautions
  q15: 2, // 2 tablets
  q16: 2, // Anerkennung
  q17: 3, // B2
  q18: 2, // Europe
  q19: 2, // Euro
  q20: 1, // 112
  q21: 2, // 800–2000 mL/day
  q22: 3, // O−
  q23: 1, // Level of consciousness
  q24: 2, // Fowler's position
  q25: 2, // +200 mL
  q26: 2, // Production of red blood cells (NOT a skin function)
  q27: 1, // Fast heart rate
  q28: 1, // As needed / when required
  q29: 1, // Krankenversicherung
  q30: 3, // Berlin
};

const TOTAL = Object.keys(ANSWER_KEY).length;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const body = await req.json().catch(() => ({}));
  const { action } = body;

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  // ── register ──────────────────────────────────────────────
  if (action === "register") {
    const name = (body.name || "").trim();
    const phone = (body.phone || "").replace(/\D/g, "");
    if (!name || phone.length < 10)
      return json({ error: "Valid name and 10-digit phone required." }, 400);

    const { data: existing } = await sb
      .from("lq_leads")
      .select("id, lq_attempts(score,total,passed)")
      .eq("phone", phone)
      .maybeSingle();

    if (existing) {
      const attempt = (existing as any).lq_attempts?.[0];
      if (attempt) {
        const premium = attempt.score / (attempt.total || TOTAL) > 0.9;
        return json({ ok: true, token: existing.id, already_attempted: true, result: { ...attempt, premium } });
      }
      return json({ ok: true, token: existing.id, already_attempted: false });
    }

    const { data: lead, error } = await sb
      .from("lq_leads")
      .insert({ name, phone })
      .select("id")
      .single();

    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, token: lead.id, already_attempted: false });
  }

  // ── submit ────────────────────────────────────────────────
  if (action === "submit") {
    const { token, answers, duration } = body;
    if (!token || typeof answers !== "object")
      return json({ error: "token and answers required" }, 400);

    // Idempotent: return existing result if already submitted
    const { data: existing } = await sb
      .from("lq_attempts")
      .select("score,total,passed")
      .eq("lead_id", token)
      .maybeSingle();

    if (existing) {
      const premium = existing.score / (existing.total || TOTAL) > 0.9;
      return json({ ok: true, ...existing, premium });
    }

    // Score server-side
    let score = 0;
    for (const [qid, chosen] of Object.entries(answers as Record<string, number>)) {
      if (ANSWER_KEY[qid] !== undefined && chosen === ANSWER_KEY[qid]) score++;
    }

    const passed = score > TOTAL / 2; // strictly more than 50%
    const premium = score / TOTAL > 0.9; // >90% for ₹40,000

    const { error } = await sb.from("lq_attempts").insert({
      lead_id: token,
      score,
      total: TOTAL,
      passed,
      answers,
      duration_seconds: duration ?? null,
    });

    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, score, total: TOTAL, passed, premium });
  }

  return json({ error: "unknown action" }, 400);
});
