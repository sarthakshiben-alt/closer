/* ============================================================================
   Closer — data layer.

   Cloud is the source of truth; localStorage is a read cache plus an outbox
   so the app still works on the metro with no signal. Nothing here knows
   about React.
   ========================================================================== */

import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://zrmlelxhhoceifjwuiuq.supabase.co";
export const SUPABASE_KEY = "sb_publishable_B7KJO5IaIXBV3AuLBtMVdQ_XJahXxg9";

/* The publishable key is meant to ship in the browser. Row-level security,
   not key secrecy, is what stops one user reading another's data.          */
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const CACHE_KEY = "closer.cache.v2";
const OUTBOX_KEY = "closer.outbox.v2";

const readLS = (k, fallback) => {
  try {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
};
const writeLS = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
};

/* ---------------------------- shape mapping ------------------------------ */
/* DB columns are snake_case; the UI speaks its own language. One place to
   translate, so a column rename never leaks into components.               */

const goalFromRow = (r) => ({
  id: r.id,
  name: r.display_name || "there",
  goal: Number(r.target_amount),
  age: r.current_age,
  targetAge: r.target_age,
  startingBalance: Number(r.starting_balance),
  monthly: Number(r.monthly),
  annual: Number(r.annual_return),
  risk: r.risk,
  inflationOn: r.inflation_on,
  streak: r.streak,
  lastActiveDay: r.last_active_day,
  startedAt: new Date(r.started_at),
});

const goalToRow = (g, userId) => ({
  user_id: userId,
  display_name: g.name,
  target_amount: g.goal,
  current_age: g.age,
  target_age: g.targetAge,
  starting_balance: g.startingBalance,
  monthly: g.monthly,
  annual_return: g.annual,
  risk: g.risk,
  inflation_on: !!g.inflationOn,
  streak: g.streak || 0,
  last_active_day: g.lastActiveDay || null,
});

const contribFromRow = (r) => ({
  id: r.id,
  amount: Number(r.amount),
  type: r.kind,
  note: r.note,
  skipped: r.skipped,
  daysSaved: Number(r.days_saved),
  date: new Date(r.occurred_at),
});

/* ------------------------------- outbox ---------------------------------- */
/* Every write is attempted immediately. If it fails (offline, flaky metro
   wifi) it lands here and is replayed on the next successful connection.    */

const outbox = {
  all: () => readLS(OUTBOX_KEY, []),
  push(op) {
    const q = outbox.all();
    q.push({ ...op, queuedAt: Date.now() });
    writeLS(OUTBOX_KEY, q);
  },
  clear: () => writeLS(OUTBOX_KEY, []),
  async flush(userId) {
    const q = outbox.all();
    if (!q.length) return { flushed: 0 };
    const remaining = [];
    let flushed = 0;
    for (const op of q) {
      try {
        const { error } = await applyOp(op, userId);
        if (error) remaining.push(op); else flushed++;
      } catch (e) { remaining.push(op); }
    }
    writeLS(OUTBOX_KEY, remaining);
    return { flushed, stuck: remaining.length };
  },
};

async function applyOp(op, userId) {
  if (op.kind === "upsertGoal") {
    return supabase.from("goals").upsert({ id: op.goalId, ...goalToRow(op.goal, userId) });
  }
  if (op.kind === "insertContribution") {
    return supabase.from("contributions").insert({
      id: op.row.id,
      user_id: userId,
      goal_id: op.row.goalId,
      amount: op.row.amount,
      kind: op.row.type,
      note: op.row.note,
      skipped: op.row.skipped || null,
      days_saved: op.row.daysSaved || 0,
      occurred_at: new Date(op.row.date).toISOString(),
    });
  }
  if (op.kind === "deleteGoal") {
    return supabase.from("goals").delete().eq("id", op.goalId);
  }
  return { error: null };
}

/* ------------------------------- the API --------------------------------- */

export const store = {
  cached: () => {
    const c = readLS(CACHE_KEY, null);
    if (!c || !c.profile) return null;
    return {
      profile: { ...c.profile, startedAt: new Date(c.profile.startedAt) },
      contributions: (c.contributions || []).map((x) => ({ ...x, date: new Date(x.date) })),
    };
  },

  cache(profile, contributions) {
    writeLS(CACHE_KEY, { profile, contributions });
  },

  clearCache() {
    try { localStorage.removeItem(CACHE_KEY); localStorage.removeItem(OUTBOX_KEY); } catch (e) {}
  },

  pendingWrites: () => outbox.all().length,

  /** Pull everything for the signed-in user. Falls back to cache when offline. */
  async pull(userId) {
    try {
      await outbox.flush(userId);
      const { data: goals, error: ge } = await supabase
        .from("goals").select("*").order("created_at", { ascending: true }).limit(1);
      if (ge) throw ge;
      if (!goals || !goals.length) return { profile: null, contributions: [], online: true };

      const profile = goalFromRow(goals[0]);
      const { data: rows, error: ce } = await supabase
        .from("contributions").select("*")
        .eq("goal_id", profile.id).order("occurred_at", { ascending: false });
      if (ce) throw ce;

      const contributions = (rows || []).map(contribFromRow);
      store.cache(profile, contributions);
      return { profile, contributions, online: true };
    } catch (e) {
      const c = store.cached();
      return c
        ? { ...c, online: false, error: e.message }
        : { profile: null, contributions: [], online: false, error: e.message };
    }
  },

  /** Create or update the user's goal. Returns the goal id. */
  async saveGoal(goal, userId) {
    const goalId = goal.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const op = { kind: "upsertGoal", goalId, goal: { ...goal, id: goalId } };
    try {
      const { error } = await applyOp(op, userId);
      if (error) throw error;
    } catch (e) {
      outbox.push(op);
    }
    return goalId;
  },

  async addContribution(row, userId) {
    const id = row.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const op = { kind: "insertContribution", row: { ...row, id } };
    try {
      const { error } = await applyOp(op, userId);
      if (error) throw error;
    } catch (e) {
      outbox.push(op);
    }
    return id;
  },

  async deleteGoal(goalId) {
    const op = { kind: "deleteGoal", goalId };
    try {
      const { error } = await applyOp(op, null);
      if (error) throw error;
    } catch (e) { outbox.push(op); }
    store.clearCache();
  },

  async flush(userId) { return outbox.flush(userId); },
};

/* --------------------------- local -> cloud lift -------------------------- */
/* Anyone who used the old localStorage-only build has real data on their
   phone. Lift it into their new account once, then retire the old key.      */

const LEGACY_KEY = "closer.state.v1";

export async function migrateLegacyLocal(userId) {
  const legacy = readLS(LEGACY_KEY, null);
  if (!legacy || !legacy.profile) return { migrated: false };
  const goalId = await store.saveGoal({ ...legacy.profile, id: undefined }, userId);
  for (const c of legacy.contributions || []) {
    await store.addContribution({ ...c, id: undefined, goalId, date: new Date(c.date) }, userId);
  }
  try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
  return { migrated: true, count: (legacy.contributions || []).length };
}
