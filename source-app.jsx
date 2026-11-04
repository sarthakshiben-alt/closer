import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, PieChart, Pie, Cell, Legend,
} from "recharts";

import { supabase, store, migrateLegacyLocal } from "./store.js";
import AuthScreen from "./auth.jsx";

/* ============================================================================
   CLOSER — turn money into time.
   Single-file prototype. All financial math lives in the `fin` module below and
   is never inlined into a component.
   ========================================================================== */

/* ------------------------------- 1. TOKENS -------------------------------- */

const C = {
  ink: "#10241B",
  forest: "#1B4332",
  btn: "#173C2C",
  mint: "#D7F0DF",
  mintDeep: "#95D5B2",
  sage: "#EDF5EF",
  cream: "#F6F8F4",
  card: "#FFFFFF",
  line: "#E4EBE5",
  muted: "#6C7C73",
  gold: "#E0A33C",
  coral: "#EF8B62",
  lav: "#A99BDC",
  sky: "#7FB3D5",
};
const FONT =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

const DAYS_PER_MONTH = 30.436875;

/* ------------------------- 2. FINANCE ENGINE (pure) ------------------------ */
/* Every function here is a pure function of its arguments. No React, no DOM. */

export const fin = {
  monthlyRate(annual) {
    if (!annual || annual <= 0) return 0;
    return Math.pow(1 + annual, 1 / 12) - 1;
  },

  /** FV of a lump sum plus a monthly contribution, monthly compounding. */
  futureValue(pv, pmt, annual, months) {
    const r = fin.monthlyRate(annual);
    const n = Math.max(0, months);
    if (r === 0) return pv + pmt * n;
    const g = Math.pow(1 + r, n);
    return pv * g + pmt * ((g - 1) / r);
  },

  /** How much per month is needed to land exactly on target in `months`. */
  requiredMonthlyContribution(pv, annual, months, target) {
    if (months <= 0) return Infinity;
    const r = fin.monthlyRate(annual);
    if (r === 0) return Math.max(0, (target - pv) / months);
    const g = Math.pow(1 + r, months);
    const need = target - pv * g;
    if (need <= 0) return 0;
    return need / ((g - 1) / r);
  },

  /** Months until the portfolio first reaches `target`. Infinity if never. */
  monthsToGoal(pv, pmt, annual, target) {
    if (pv >= target) return 0;
    const r = fin.monthlyRate(annual);
    if (r === 0) return pmt > 0 ? (target - pv) / pmt : Infinity;
    if (pmt <= 0) {
      if (pv <= 0) return Infinity;
      return Math.log(target / pv) / Math.log(1 + r);
    }
    const num = target * r + pmt;
    const den = pv * r + pmt;
    if (num <= 0 || den <= 0) return Infinity;
    return Math.log(num / den) / Math.log(1 + r);
  },

  daysToGoal(pv, pmt, annual, target) {
    const m = fin.monthsToGoal(pv, pmt, annual, target);
    return m === Infinity ? Infinity : m * DAYS_PER_MONTH;
  },

  /** Days pulled forward by adding `extra` to the balance right now. */
  daysSavedBy(extra, pv, pmt, annual, target) {
    const before = fin.daysToGoal(pv, pmt, annual, target);
    const after = fin.daysToGoal(pv + extra, pmt, annual, target);
    if (before === Infinity) return after === Infinity ? 0 : Infinity;
    return Math.max(0, before - after);
  },

  /** Days pulled forward by permanently raising the monthly contribution. */
  daysSavedByMonthly(extraMonthly, pv, pmt, annual, target) {
    const before = fin.daysToGoal(pv, pmt, annual, target);
    const after = fin.daysToGoal(pv, pmt + extraMonthly, annual, target);
    if (before === Infinity) return after === Infinity ? 0 : Infinity;
    return Math.max(0, before - after);
  },

  goalDate(from, pv, pmt, annual, target) {
    const d = fin.daysToGoal(pv, pmt, annual, target);
    if (d === Infinity) return null;
    return new Date(from.getTime() + d * 86400000);
  },

  /** Year-by-year split of principal vs growth, for the projection chart. */
  projectionSeries(pv, pmt, annual, years) {
    const out = [];
    for (let y = 0; y <= years; y++) {
      const n = y * 12;
      const balance = fin.futureValue(pv, pmt, annual, n);
      const principal = pv + pmt * n;
      out.push({
        label: y === 0 ? "Now" : `${y}Y`,
        contributions: Math.round(Math.min(principal, balance)),
        growth: Math.round(Math.max(0, balance - principal)),
        balance: Math.round(balance),
      });
    }
    return out;
  },

  scenario(pv, pmt, annual, target, horizonMonths, from) {
    return {
      annual,
      requiredMonthly: fin.requiredMonthlyContribution(pv, annual, horizonMonths, target),
      projectedAtHorizon: fin.futureValue(pv, pmt, annual, horizonMonths),
      goalDate: fin.goalDate(from, pv, pmt, annual, target),
      daysToGoal: fin.daysToGoal(pv, pmt, annual, target),
    };
  },

  /** What an amount not spent today could be worth later. */
  futurePurchaseValue(amount, annual, years) {
    return amount * Math.pow(1 + annual, years);
  },

  progress(totalSaved, target) {
    if (target <= 0) return 0;
    return Math.max(0, Math.min(1, totalSaved / target));
  },

  realTarget(target, inflation, years) {
    return target * Math.pow(1 + inflation, years);
  },
};

/* --------------------------- 3. SELF-CHECKS ------------------------------- */
/* Runs once in dev; surfaces silently in the console rather than in the UI. */

export function runEngineChecks() {
  const t = [];
  const ok = (name, cond) => t.push({ name, pass: !!cond });
  const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

  ok("zero return, FV is linear", near(fin.futureValue(1000, 100, 0, 10), 2000, 0.001));
  ok("FV grows a lump sum", fin.futureValue(100000, 0, 0.1, 12) > 109999);
  const n = fin.monthsToGoal(500000, 130000, 0.1, 10000000);
  ok("goal date lands on target", near(fin.futureValue(500000, 130000, 0.1, n), 10000000, 5));
  ok("already achieved returns 0", fin.monthsToGoal(2e7, 1000, 0.1, 1e7) === 0);
  ok("no contribution, no return, never", fin.monthsToGoal(1000, 0, 0, 1e7) === Infinity);
  ok("no contribution but returns still gets there", fin.monthsToGoal(1e6, 0, 0.1, 1e7) < 1000);
  ok("zero return still reachable by saving", near(fin.monthsToGoal(0, 100, 0, 1000), 10, 0.001));
  ok("extra money never pushes the goal away", fin.daysSavedBy(1000, 5e5, 1.3e5, 0.1, 1e7) >= 0);
  ok("bigger extra buys more days",
    fin.daysSavedBy(50000, 5e5, 1.3e5, 0.1, 1e7) > fin.daysSavedBy(2000, 5e5, 1.3e5, 0.1, 1e7));
  ok("required monthly is 0 when goal is already funded",
    fin.requiredMonthlyContribution(2e7, 0.1, 66, 1e7) === 0);
  ok("required monthly hits the target",
    near(fin.futureValue(5e5, fin.requiredMonthlyContribution(5e5, 0.1, 66, 1e7), 0.1, 66), 1e7, 5));
  ok("contribution larger than goal finishes inside a month",
    fin.monthsToGoal(0, 2e7, 0.1, 1e7) < 1);
  ok("very short horizon still returns a number",
    isFinite(fin.requiredMonthlyContribution(0, 0.1, 1, 1e5)));
  ok("progress is clamped", fin.progress(5e7, 1e7) === 1 && fin.progress(-5, 1e7) === 0);

  const failed = t.filter((x) => !x.pass);
  if (failed.length) console.warn("[closer] engine checks failed:", failed);
  else console.log(`[closer] engine checks passed (${t.length})`);
  return t;
}

/* ---------------------------- 4. FORMATTING ------------------------------- */

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const money = (n) => `₹${inr.format(Math.round(n || 0))}`;
const shortMoney = (n) => {
  const a = Math.abs(n);
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(a >= 1e8 ? 0 : 2)}Cr`;
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  if (a >= 1e3) return `₹${Math.round(n / 1e3)}K`;
  return `₹${Math.round(n)}`;
};
const monthsToWords = (m) => {
  if (!isFinite(m)) return "beyond the horizon";
  const y = Math.floor(m / 12);
  const mo = Math.round(m - y * 12);
  if (y <= 0) return `${mo} month${mo === 1 ? "" : "s"}`;
  return `${y} year${y === 1 ? "" : "s"}${mo ? ` ${mo} month${mo === 1 ? "" : "s"}` : ""}`;
};
const dateLabel = (d) =>
  d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
const monthLabel = (d) =>
  d ? d.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) : "—";

/** Honest phrasing for a days-saved figure. Never invents precision. */
function daysPhrase(days) {
  if (!isFinite(days)) return { big: "—", unit: "", note: "" };
  if (days >= 1) {
    const whole = Math.floor(days);
    return { big: inr.format(whole), unit: whole === 1 ? "day" : "days", note: "" };
  }
  const hours = Math.floor(days * 24);
  if (hours >= 1)
    return { big: String(hours), unit: hours === 1 ? "hour" : "hours", note: "You're building momentum." };
  return { big: "", unit: "", note: "Every bit counts. Keep going." };
}

/* ------------------------------ 5. SEED DATA ------------------------------ */

const SKIP_CATEGORIES = [
  "Food delivery", "Shopping", "Entertainment", "Gadgets", "Travel", "Subscriptions", "Other",
];

const ALLOCATIONS = {
  conservative: {
    label: "Conservative", annual: 0.05,
    mix: [
      { name: "Equity / mutual funds", value: 30, color: C.forest },
      { name: "Debt / fixed income", value: 45, color: C.coral },
      { name: "Gold", value: 10, color: C.gold },
      { name: "Emergency cash", value: 15, color: C.lav },
    ],
  },
  balanced: {
    label: "Balanced", annual: 0.08,
    mix: [
      { name: "Equity / mutual funds", value: 50, color: C.forest },
      { name: "Debt / fixed income", value: 30, color: C.coral },
      { name: "Gold", value: 10, color: C.gold },
      { name: "Emergency cash", value: 10, color: C.lav },
    ],
  },
  growth: {
    label: "Growth", annual: 0.1,
    mix: [
      { name: "Equity / mutual funds", value: 60, color: C.forest },
      { name: "Debt / fixed income", value: 20, color: C.coral },
      { name: "Gold", value: 10, color: C.gold },
      { name: "Emergency cash", value: 10, color: C.lav },
    ],
  },
};

/* --------------------------- 5b. PERSISTENCE ------------------------------ */
/* Everything the user owns is saved locally on their own device. Nothing
   leaves the phone. Dates need reviving because JSON flattens them.        */

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** Streak counts days on which the user actually saved, not days they opened the app. */
function nextStreak(prevStreak, lastActiveDay, now) {
  const todayKey = dayKey(now);
  if (lastActiveDay === todayKey) return { streak: prevStreak, lastActiveDay };
  const yesterday = dayKey(new Date(now.getTime() - 86400000));
  const streak = lastActiveDay === yesterday ? prevStreak + 1 : 1;
  return { streak, lastActiveDay: todayKey };
}

/* ------------------------------- 6. HOOKS --------------------------------- */

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = (e) => setReduced(e.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** Animates a number towards `value`. Respects reduced motion. */
function useCountUp(value, duration = 900) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(0);
  useEffect(() => {
    if (reduced || !isFinite(value)) { setShown(value); fromRef.current = value; return; }
    const start = performance.now();
    const from = fromRef.current;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(from + (value - from) * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration, reduced]);
  return shown;
}

function haptic(pattern = 12) {
  try { navigator.vibrate?.(pattern); } catch (e) { /* not supported */ }
}

/* ---------------------------- 7. UI PRIMITIVES ---------------------------- */

function Card({ children, className = "", style = {}, ...rest }) {
  return (
    <div
      className={`rounded-3xl ${className}`}
      style={{ background: C.card, border: `1px solid ${C.line}`, boxShadow: "0 1px 2px rgba(16,36,27,0.04)", ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}

function Button({ children, onClick, variant = "primary", className = "", type = "button", disabled }) {
  const styles = {
    primary: { background: C.btn, color: "#fff", border: "1px solid transparent" },
    mint: { background: C.mint, color: C.forest, border: `1px solid ${C.mintDeep}` },
    ghost: { background: "#fff", color: C.forest, border: `1px solid ${C.line}` },
    quiet: { background: "transparent", color: C.muted, border: "1px solid transparent" },
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-5 py-3 text-base font-semibold transition-transform active:scale-95 focus:outline-none focus:ring-2 focus:ring-offset-2 ${className}`}
      style={{ ...styles, opacity: disabled ? 0.5 : 1, minHeight: 48, fontFamily: FONT }}
    >
      {children}
    </button>
  );
}

function Field({ label, children, hint }) {
  return (
    <label className="block mb-4">
      <span className="block text-sm mb-2" style={{ color: C.muted }}>{label}</span>
      {children}
      {hint ? <span className="block text-xs mt-1" style={{ color: C.muted }}>{hint}</span> : null}
    </label>
  );
}

function TextInput({ value, onChange, prefix = "₹", placeholder, inputMode = "numeric", ariaLabel }) {
  return (
    <div className="flex items-center rounded-2xl px-4" style={{ border: `1px solid ${C.line}`, background: "#fff", minHeight: 56 }}>
      {prefix ? <span className="mr-2 text-lg" style={{ color: C.ink }}>{prefix}</span> : null}
      <input
        aria-label={ariaLabel || placeholder}
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent text-lg outline-none py-3"
        style={{ color: C.ink, fontFamily: FONT }}
      />
    </div>
  );
}

function Chip({ active, children, onClick }) {
  return (
    <button
      onClick={onClick}
      className="rounded-full px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2"
      style={{
        background: active ? C.btn : "#fff",
        color: active ? "#fff" : C.forest,
        border: `1px solid ${active ? C.btn : C.line}`,
        minHeight: 40,
      }}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, sub, icon, tint = C.sage }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-center rounded-xl mb-3" style={{ width: 34, height: 34, background: tint }}>
        <span aria-hidden="true">{icon}</span>
      </div>
      <div className="text-xs mb-1" style={{ color: C.muted }}>{label}</div>
      <div className="text-xl font-semibold" style={{ color: C.ink }}>{value}</div>
      {sub ? <div className="text-xs mt-1" style={{ color: C.muted }}>{sub}</div> : null}
    </Card>
  );
}

function Disclaimer({ children }) {
  return (
    <p className="text-xs leading-relaxed mt-3" style={{ color: C.muted }}>{children}</p>
  );
}

/* --------------------------- 8. PROGRESS RING ----------------------------- */

function Ring({ pct, days, reduced }) {
  const size = 236, stroke = 14, r = (size - stroke) / 2, circ = 2 * Math.PI * r;
  const shown = useCountUp(isFinite(days) ? days : 0);
  const p = Math.max(0, Math.min(1, pct));
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} role="img" aria-label={`${Math.round(days)} days to go, ${Math.round(p * 100)} percent funded`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={C.sage} strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={C.mintDeep} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ * (1 - p)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: reduced ? "none" : "stroke-dashoffset 900ms cubic-bezier(.22,.9,.28,1)" }}
        />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={C.coral} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={`${circ * 0.03} ${circ}`}
          strokeDashoffset={circ * (1 - p) - circ * 0.03}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: reduced ? "none" : "stroke-dashoffset 900ms cubic-bezier(.22,.9,.28,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
        <div className="text-sm" style={{ color: C.muted }}>Time to go</div>
        <div className="font-semibold tracking-tight" style={{ fontSize: 52, lineHeight: 1.05, color: C.ink }}>
          {isFinite(days) ? inr.format(Math.round(shown)) : "—"}
        </div>
        <div className="text-sm" style={{ color: C.muted }}>days</div>
        <div className="text-xs mt-1" style={{ color: C.muted }}>
          ≈ {monthsToWords(days / DAYS_PER_MONTH)}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- 9. CONFETTI -------------------------------- */

function Confetti({ active }) {
  const reduced = useReducedMotion();
  if (!active || reduced) return null;
  const colors = [C.mintDeep, C.gold, C.coral, C.lav, "#fff"];
  const pieces = Array.from({ length: 28 }, (_, i) => ({
    left: (i * 37) % 100,
    delay: (i % 9) * 0.09,
    color: colors[i % colors.length],
    size: 6 + (i % 4) * 3,
    rot: (i * 47) % 360,
  }));
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <style>{`@keyframes closerFall{0%{transform:translateY(-20px) rotate(0deg);opacity:0}
      12%{opacity:1}100%{transform:translateY(560px) rotate(540deg);opacity:0}}`}</style>
      {pieces.map((p, i) => (
        <span key={i} style={{
          position: "absolute", top: -20, left: `${p.left}%`, width: p.size, height: p.size * 1.6,
          background: p.color, borderRadius: 2, transform: `rotate(${p.rot}deg)`,
          animation: `closerFall ${2 + (i % 5) * 0.25}s ${p.delay}s ease-in forwards`,
        }} />
      ))}
    </div>
  );
}

/* ---------------------------- 10. ONBOARDING ------------------------------ */

const GOAL_PRESETS = [1000000, 2500000, 5000000, 10000000, 50000000];
const RETURN_PRESETS = [
  { key: "conservative", label: "Conservative", value: 0.05, note: "Mostly debt and deposits" },
  { key: "balanced", label: "Balanced", value: 0.08, note: "A mix of equity and debt" },
  { key: "growth", label: "Growth", value: 0.10, note: "Equity-heavy, more ups and downs" },
];

function Onboarding({ onDone }) {
  const [step, setStep] = useState(0);
  const [goal, setGoal] = useState("10000000");
  const [age, setAge] = useState("29");
  const [targetAge, setTargetAge] = useState("35");
  const [savings, setSavings] = useState("500000");
  const [income, setIncome] = useState("150000");
  const [monthly, setMonthly] = useState("130000");
  const [risk, setRisk] = useState("growth");
  const [custom, setCustom] = useState("");

  const num = (s) => Number(String(s).replace(/[^\d.]/g, "")) || 0;
  const horizonMonths = Math.max(1, (num(targetAge) - num(age)) * 12);
  const annual = custom ? num(custom) / 100 : RETURN_PRESETS.find((r) => r.key === risk).value;
  const required = fin.requiredMonthlyContribution(num(savings), annual, horizonMonths, num(goal));
  const deadlineDays = horizonMonths * DAYS_PER_MONTH;

  const next = () => setStep((s) => Math.min(4, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const finish = () =>
    onDone({
      name: "Dave",
      age: num(age),
      targetAge: num(targetAge),
      goal: num(goal),
      startingBalance: num(savings),
      income: num(income),
      monthly: num(monthly),
      annual,
      risk: custom ? "growth" : risk,
      startedAt: new Date(),
    });

  const Header = ({ title, sub }) => (
    <div className="mb-6">
      <h1 className="text-3xl font-semibold tracking-tight" style={{ color: C.ink }}>{title}</h1>
      {sub ? <p className="mt-2 text-base" style={{ color: C.muted }}>{sub}</p> : null}
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col" style={{ background: C.cream, fontFamily: FONT }}>
      <div className="flex items-center justify-between px-5 pt-5">
        <button onClick={back} aria-label="Go back" className="text-2xl px-2 py-1 rounded-full" style={{ color: C.ink, visibility: step === 0 ? "hidden" : "visible" }}>‹</button>
        <div className="flex gap-1.5" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} style={{ width: i === step ? 22 : 7, height: 7, borderRadius: 99, background: i <= step ? C.forest : C.line, transition: "width 250ms" }} />
          ))}
        </div>
        <button onClick={finish} className="text-sm" style={{ color: C.muted }}>Skip</button>
      </div>

      <div className="flex-1 px-5 pt-6 pb-32 max-w-md w-full mx-auto">
        {step === 0 && (
          <>
            <Header title="What's your goal?" sub="Turn your dream into a plan." />
            <Field label="I want to save">
              <TextInput value={inr.format(num(goal))} onChange={(v) => setGoal(v)} ariaLabel="Goal amount in rupees" />
            </Field>
            <div className="flex flex-wrap gap-2 mb-6">
              {GOAL_PRESETS.map((g) => (
                <Chip key={g} active={num(goal) === g} onClick={() => setGoal(String(g))}>{shortMoney(g)}</Chip>
              ))}
            </div>
            <Card className="p-4" style={{ background: C.mint, border: "none" }}>
              <p style={{ color: C.forest }}>That's {shortMoney(num(goal))}. Big, but it's just a series of small decisions.</p>
            </Card>
          </>
        )}

        {step === 1 && (
          <>
            <Header title="By when?" sub="Pick the age you want this done by." />
            <Field label="I'll be">
              <TextInput prefix="" value={targetAge} onChange={setTargetAge} ariaLabel="Target age" />
            </Field>
            <Field label="I'm this old now">
              <TextInput prefix="" value={age} onChange={setAge} ariaLabel="Current age" />
            </Field>
            <Card className="p-4" style={{ background: C.mint, border: "none" }}>
              <p style={{ color: C.forest }}>
                {monthsToWords(horizonMonths)} — about {inr.format(Math.round(deadlineDays))} days.
              </p>
            </Card>
          </>
        )}

        {step === 2 && (
          <>
            <Header title="Where are you today?" sub="Rough numbers are fine. You can skip any of these." />
            <Field label="Current savings and investments"><TextInput value={inr.format(num(savings))} onChange={setSavings} ariaLabel="Current savings" /></Field>
            <Field label="Monthly income (optional)"><TextInput value={inr.format(num(income))} onChange={setIncome} ariaLabel="Monthly income" /></Field>
            <Field label="What you usually save each month" hint="This is what your projection is built on."><TextInput value={inr.format(num(monthly))} onChange={setMonthly} ariaLabel="Monthly savings" /></Field>
          </>
        )}

        {step === 3 && (
          <>
            <Header title="What return should we plan with?" sub="A planning assumption, not a promise." />
            <div className="grid gap-3">
              {RETURN_PRESETS.map((r) => (
                <button key={r.key} onClick={() => { setRisk(r.key); setCustom(""); }} className="text-left rounded-3xl p-4 focus:outline-none focus:ring-2"
                  style={{ background: risk === r.key && !custom ? C.mint : "#fff", border: `1px solid ${risk === r.key && !custom ? C.mintDeep : C.line}` }}>
                  <div className="flex items-baseline justify-between">
                    <span className="font-semibold" style={{ color: C.ink }}>{r.label}</span>
                    <span className="text-2xl font-semibold" style={{ color: C.forest }}>{Math.round(r.value * 100)}%</span>
                  </div>
                  <div className="text-sm mt-1" style={{ color: C.muted }}>{r.note}</div>
                </button>
              ))}
            </div>
            <div className="mt-4">
              <Field label="Or set your own (% a year)">
                <TextInput prefix="%" value={custom} placeholder="e.g. 9" onChange={setCustom} ariaLabel="Custom expected return" />
              </Field>
            </div>
            <Disclaimer>Markets don't return the same number every year. This assumption shapes the projection; it doesn't guarantee it.</Disclaimer>
          </>
        )}

        {step === 4 && (
          <>
            <Header title="Here's your plan" />
            <Card className="p-6 mb-4">
              <div className="text-sm" style={{ color: C.muted }}>Your goal</div>
              <div className="text-4xl font-semibold tracking-tight mt-1" style={{ color: C.ink }}>{money(num(goal))}</div>
              <div className="text-sm mt-1" style={{ color: C.muted }}>by age {num(targetAge)}</div>
            </Card>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="To stay exactly on time" value={isFinite(required) ? money(required) : "—"} sub="every month" icon="◎" />
              <Stat label="Planning return" value={`${(annual * 100).toFixed(1)}%`} sub="a year" icon="↗" tint={C.mint} />
              <Stat label="Time you have" value={`${inr.format(Math.round(deadlineDays))} days`} sub={monthsToWords(horizonMonths)} icon="⏳" tint="#FBEFD8" />
              <Stat label="You save today" value={money(num(monthly))} sub="every month" icon="₹" />
            </div>
            {num(monthly) < required && isFinite(required) ? (
              <Card className="p-4 mt-4" style={{ background: "#FBEFD8", border: "none" }}>
                <p style={{ color: C.ink }}>
                  You're saving {money(required - num(monthly))} less than the on-time pace. That's fixable — the app will show you exactly what closing the gap buys you.
                </p>
              </Card>
            ) : (
              <Card className="p-4 mt-4" style={{ background: C.mint, border: "none" }}>
                <p style={{ color: C.forest }}>At your current pace you're ahead of the deadline. Everything extra now buys you time.</p>
              </Card>
            )}
          </>
        )}
      </div>

      <div className="fixed bottom-0 left-0 right-0 px-5 pb-6 pt-4" style={{ background: `linear-gradient(to top, ${C.cream} 70%, rgba(246,248,244,0))` }}>
        <div className="max-w-md mx-auto">
          <Button className="w-full" onClick={step === 4 ? finish : next}>
            {step === 4 ? "Create my plan" : "Continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 11. MODALS -------------------------------- */

function Sheet({ open, onClose, title, children, tall }) {
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0" style={{ background: "rgba(16,36,27,0.45)" }} onClick={onClose} />
      <style>{`@keyframes closerUp{from{transform:translateY(28px);opacity:.4}to{transform:translateY(0);opacity:1}}`}</style>
      <div
        className="relative w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl p-6 overflow-y-auto"
        style={{ background: "#fff", maxHeight: tall ? "92vh" : "86vh", animation: reduced ? "none" : "closerUp 240ms ease-out", fontFamily: FONT }}
      >
        <div className="flex items-start justify-between mb-4">
          <h2 className="text-2xl font-semibold tracking-tight" style={{ color: C.ink }}>{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-2xl leading-none px-2" style={{ color: C.muted }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AddSavingsSheet({ open, onClose, onAdd, defaultType = "salary" }) {
  const [amount, setAmount] = useState("");
  const [type, setType] = useState(defaultType);
  const types = [
    { k: "salary", l: "Salary" }, { k: "investment", l: "Investment" },
    { k: "side", l: "Side income" }, { k: "bonus", l: "Bonus" }, { k: "other", l: "Other" },
  ];
  useEffect(() => { if (open) { setAmount(""); setType(defaultType); } }, [open, defaultType]);
  const value = Number(String(amount).replace(/[^\d]/g, "")) || 0;
  return (
    <Sheet open={open} onClose={onClose} title="Add savings">
      <p className="mb-5" style={{ color: C.muted }}>Money that went into your goal, not out of your wallet.</p>
      <Field label="How much did you save?">
        <TextInput value={amount ? inr.format(value) : ""} onChange={setAmount} placeholder="0" ariaLabel="Amount saved" />
      </Field>
      <Field label="Where did it come from?">
        <div className="flex flex-wrap gap-2">
          {types.map((t) => <Chip key={t.k} active={type === t.k} onClick={() => setType(t.k)}>{t.l}</Chip>)}
        </div>
      </Field>
      <Button className="w-full mt-2" disabled={value <= 0} onClick={() => { onAdd({ amount: value, type, note: types.find((t) => t.k === type).l }); onClose(); }}>
        Add to my journey
      </Button>
    </Sheet>
  );
}

function ExtraSheet({ open, onClose, onAdd }) {
  const [amount, setAmount] = useState("");
  const [skipped, setSkipped] = useState("Food delivery");
  const [note, setNote] = useState("");
  useEffect(() => { if (open) { setAmount(""); setNote(""); setSkipped("Food delivery"); } }, [open]);
  const value = Number(String(amount).replace(/[^\d]/g, "")) || 0;
  return (
    <Sheet open={open} onClose={onClose} title="Log extra savings" tall>
      <p className="mb-5" style={{ color: C.muted }}>
        Skipped a shopping spree? Cooked at home? Chose the experience over the expense? Add it here.
      </p>
      <Field label="Amount saved extra">
        <TextInput value={amount ? inr.format(value) : ""} onChange={setAmount} placeholder="0" ariaLabel="Extra amount saved" />
      </Field>
      <div className="flex flex-wrap gap-2 mb-5">
        {[500, 1000, 2000, 5000].map((v) => <Chip key={v} active={value === v} onClick={() => setAmount(String(v))}>{money(v)}</Chip>)}
      </div>
      <Field label="What did you choose not to buy?">
        <div className="flex flex-wrap gap-2">
          {SKIP_CATEGORIES.map((s) => <Chip key={s} active={skipped === s} onClick={() => setSkipped(s)}>{s}</Chip>)}
        </div>
      </Field>
      <Field label="Anything you want to remember about it? (optional)">
        <TextInput prefix="" inputMode="text" value={note} onChange={setNote} placeholder="Didn't order Swiggy today" ariaLabel="Note" />
      </Field>
      <Button className="w-full" disabled={value <= 0} onClick={() => { onAdd({ amount: value, type: "extra", skipped, note: note || `Skipped ${skipped.toLowerCase()}` }); }}>
        Add and see the impact
      </Button>
    </Sheet>
  );
}

function Celebration({ data, onClose }) {
  const reduced = useReducedMotion();
  useEffect(() => { if (data) haptic([10, 40, 18]); }, [data]);
  const shownDays = useCountUp(data && isFinite(data.newDays) ? data.newDays : 0);
  if (!data) return null;
  const phrase = daysPhrase(data.daysSaved);
  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: C.forest, fontFamily: FONT }} role="dialog" aria-modal="true">
      <Confetti active />
      <div className="flex justify-end p-5">
        <button onClick={onClose} aria-label="Close" className="text-2xl" style={{ color: "rgba(255,255,255,0.7)" }}>×</button>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <style>{`@keyframes closerPop{0%{transform:scale(.86);opacity:0}60%{transform:scale(1.03)}100%{transform:scale(1);opacity:1}}`}</style>
        <div style={{ animation: reduced ? "none" : "closerPop 420ms ease-out" }}>
          <div className="text-4xl mb-3" aria-hidden="true">🎉</div>
          <h1 className="text-4xl font-semibold tracking-tight" style={{ color: "#fff" }}>Amazing!</h1>
          <p className="mt-2 text-lg" style={{ color: "rgba(255,255,255,0.8)" }}>
            {phrase.big ? "You just brought your goal closer." : "That's another " + money(data.amount) + " working for future you."}
          </p>
        </div>

        <div className="w-full max-w-sm rounded-3xl p-6 mt-8" style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.16)" }}>
          {phrase.big ? (
            <>
              <div className="text-sm" style={{ color: "rgba(255,255,255,0.75)" }}>Time reduced by</div>
              <div className="font-semibold tracking-tight" style={{ fontSize: 60, lineHeight: 1.05, color: "#fff" }}>{phrase.big}</div>
              <div className="text-lg" style={{ color: "rgba(255,255,255,0.85)" }}>{phrase.unit}</div>
              {phrase.note ? <div className="text-sm mt-2" style={{ color: C.mintDeep }}>{phrase.note}</div> : null}
            </>
          ) : (
            <div className="text-lg" style={{ color: "#fff" }}>{phrase.note}</div>
          )}
          <div className="h-px my-5" style={{ background: "rgba(255,255,255,0.16)" }} />
          <div className="text-sm" style={{ color: "rgba(255,255,255,0.75)" }}>New time to go</div>
          <div className="text-3xl font-semibold" style={{ color: "#fff" }}>
            {isFinite(data.newDays) ? `${inr.format(Math.round(shownDays))} days` : "—"}
          </div>
          <div className="text-sm mt-1" style={{ color: "rgba(255,255,255,0.7)" }}>
            {data.oldDate ? `${dateLabel(data.oldDate)} → ${dateLabel(data.newDate)}` : ""}
          </div>
        </div>

        <p className="mt-8 text-base max-w-xs" style={{ color: "rgba(255,255,255,0.72)" }}>
          You just bought yourself a little more financial freedom.
        </p>
      </div>
      <div className="p-6">
        <Button variant="mint" className="w-full" onClick={onClose}>Keep going</Button>
      </div>
    </div>
  );
}

function ActionSheet({ open, onClose, onPick }) {
  const items = [
    { k: "savings", l: "Add savings", d: "Money you put away" },
    { k: "extra", l: "Log extra saving", d: "Something you chose not to buy" },
    { k: "investment", l: "Add investment", d: "SIP, stocks, funds" },
    { k: "income", l: "Add income", d: "Bonus, freelance, gift" },
  ];
  return (
    <Sheet open={open} onClose={onClose} title="What happened?">
      <div className="grid gap-3">
        {items.map((i) => (
          <button key={i.k} onClick={() => onPick(i.k)} className="text-left rounded-2xl p-4 focus:outline-none focus:ring-2"
            style={{ background: C.sage, border: `1px solid ${C.line}` }}>
            <div className="font-semibold" style={{ color: C.ink }}>{i.l}</div>
            <div className="text-sm" style={{ color: C.muted }}>{i.d}</div>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/* ------------------------------ 12. SCREENS ------------------------------- */

function HomeScreen({ d, onAdd, onExtra }) {
  const reduced = useReducedMotion();
  return (
    <div className="px-5 pb-8">
      {d.offline ? (
        <div className="rounded-2xl px-4 py-2 mb-3 text-sm text-center" style={{ background: "#FBEFD8", color: C.ink }}>
          Offline — your saves are stored here and will sync.
        </div>
      ) : null}
      <div className="text-center pt-2 pb-4">
        <div className="text-sm" style={{ color: C.muted }}>My savings journey</div>
        <div className="text-3xl font-semibold tracking-tight mt-1" style={{ color: C.ink }}>{money(d.goal)}</div>
        <div className="text-sm mt-1" style={{ color: C.muted }}>by age {d.targetAge} · deadline {monthLabel(d.deadlineDate)}</div>
      </div>

      <div className="flex justify-center my-2">
        <Ring pct={d.progress} days={d.daysToGo} reduced={reduced} />
      </div>

      <p className="text-center text-sm px-8 mt-2 mb-5" style={{ color: C.muted }}>
        {d.status.line}
      </p>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <Button variant="ghost" onClick={onAdd}>+ Add savings</Button>
        <Button variant="mint" onClick={onExtra}>I saved extra</Button>
      </div>

      <Card className="p-4 mb-4" style={{ background: d.status.tint, border: "none" }}>
        <div className="text-sm" style={{ color: C.forest }}>{d.status.headline}</div>
        {d.status.action ? <div className="text-sm mt-1" style={{ color: C.ink }}>{d.status.action}</div> : null}
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Stat label="Saved so far" value={shortMoney(d.totalSaved)} sub={`${(d.progress * 100).toFixed(1)}% of goal`} icon="◍" />
        <Stat label="Days bought back" value={isFinite(d.daysReduced) ? `${Math.floor(d.daysReduced)}` : "—"} sub="from extra savings" icon="⏱" tint={C.mint} />
      </div>

      <h3 className="text-lg font-semibold mt-6 mb-3" style={{ color: C.ink }}>Recent activity</h3>
      <Card className="divide-y" style={{ borderColor: C.line }}>
        {d.contributions.slice(0, 5).map((c) => (
          <div key={c.id} className="flex items-center justify-between p-4">
            <div>
              <div className="font-medium" style={{ color: C.ink }}>{c.note}</div>
              <div className="text-xs" style={{ color: C.muted }}>{dateLabel(c.date)}{c.skipped ? ` · ${c.skipped}` : ""}</div>
            </div>
            <div className="font-semibold" style={{ color: c.type === "extra" ? C.forest : C.ink }}>+{shortMoney(c.amount)}</div>
          </div>
        ))}
      </Card>
    </div>
  );
}

function PlanScreen({ d, onChangeMonthly, onChangeReturn }) {
  const [extra, setExtra] = useState(0);
  const whatIfDays = fin.daysSavedByMonthly(extra, d.totalSaved, d.monthly, d.annual, d.goal);
  const whatIfDate = fin.goalDate(new Date(), d.totalSaved, d.monthly + extra, d.annual, d.goal);
  const series = useMemo(
    () => fin.projectionSeries(d.totalSaved, d.monthly, d.annual, Math.max(1, Math.ceil(d.horizonMonths / 12))),
    [d.totalSaved, d.monthly, d.annual, d.horizonMonths]
  );

  return (
    <div className="px-5 pb-8">
      <Card className="p-5 mb-4">
        <div className="text-sm" style={{ color: C.muted }}>Monthly saving needed to finish on time</div>
        <div className="text-4xl font-semibold tracking-tight mt-1" style={{ color: C.ink }}>
          {isFinite(d.requiredMonthly) ? money(d.requiredMonthly) : "—"}
        </div>
        <div className="text-sm mt-2" style={{ color: C.muted }}>
          Based on a planning return of {(d.annual * 100).toFixed(1)}% a year over {monthsToWords(d.horizonMonths)}.
        </div>
        <div className="h-px my-4" style={{ background: C.line }} />
        <label className="block text-sm mb-2" style={{ color: C.muted }}>You're actually saving</label>
        <TextInput value={inr.format(d.monthly)} onChange={(v) => onChangeMonthly(Number(String(v).replace(/[^\d]/g, "")) || 0)} ariaLabel="Monthly saving" />
        <div className="flex flex-wrap gap-2 mt-3">
          {RETURN_PRESETS.map((r) => (
            <Chip key={r.key} active={Math.abs(d.annual - r.value) < 0.0001} onClick={() => onChangeReturn(r.value)}>
              {r.label} {Math.round(r.value * 100)}%
            </Chip>
          ))}
        </div>
      </Card>

      <h3 className="text-lg font-semibold mb-1" style={{ color: C.ink }}>Projected growth</h3>
      <p className="text-sm mb-3" style={{ color: C.muted }}>What you put in, and what the market might add on top.</p>
      <Card className="p-4 pb-2">
        <div style={{ width: "100%", height: 220 }}>
          <ResponsiveContainer>
            <BarChart data={series} margin={{ top: 8, right: 4, left: -8, bottom: 0 }}>
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: C.muted, fontSize: 12 }} />
              <YAxis tickFormatter={shortMoney} tickLine={false} axisLine={false} width={54} tick={{ fill: C.muted, fontSize: 11 }} />
              <Tooltip formatter={(v, n) => [money(v), n === "contributions" ? "Your contributions" : "Potential returns"]}
                contentStyle={{ borderRadius: 14, border: `1px solid ${C.line}`, fontSize: 12 }} />
              <Bar dataKey="contributions" stackId="a" fill={C.forest} radius={[0, 0, 4, 4]} />
              <Bar dataKey="growth" stackId="a" fill={C.mintDeep} radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="flex gap-4 justify-center text-xs pb-2" style={{ color: C.muted }}>
          <span className="flex items-center gap-2"><i style={{ width: 9, height: 9, borderRadius: 9, background: C.forest, display: "inline-block" }} />Your contributions</span>
          <span className="flex items-center gap-2"><i style={{ width: 9, height: 9, borderRadius: 9, background: C.mintDeep, display: "inline-block" }} />Potential returns</span>
        </div>
      </Card>

      <h3 className="text-lg font-semibold mt-6 mb-3" style={{ color: C.ink }}>What if you saved more each month?</h3>
      <Card className="p-5">
        <input
          type="range" min={0} max={50000} step={1000} value={extra}
          onChange={(e) => setExtra(Number(e.target.value))}
          aria-label="Extra monthly saving"
          className="w-full" style={{ accentColor: C.forest }}
        />
        <div className="flex justify-between text-xs mb-4" style={{ color: C.muted }}>
          <span>₹0</span><span>₹50,000</span>
        </div>
        <div className="text-3xl font-semibold tracking-tight" style={{ color: C.ink }}>
          {extra === 0 ? "Move the slider" : `${inr.format(Math.floor(whatIfDays))} days closer`}
        </div>
        <p className="text-sm mt-2" style={{ color: C.muted }}>
          {extra === 0
            ? "See what a permanent raise in your saving rate would buy you."
            : `Saving ${money(extra)} more every month would move your finish line to around ${dateLabel(whatIfDate)}.`}
        </p>
      </Card>

      <h3 className="text-lg font-semibold mt-6 mb-3" style={{ color: C.ink }}>If markets behave differently</h3>
      <div className="grid gap-3">
        {RETURN_PRESETS.map((r) => {
          const s = fin.scenario(d.totalSaved, d.monthly, r.value, d.goal, d.horizonMonths, new Date());
          return (
            <Card key={r.key} className="p-4">
              <div className="flex items-baseline justify-between">
                <span className="font-semibold" style={{ color: C.ink }}>{r.label}</span>
                <span className="text-xl font-semibold" style={{ color: C.forest }}>{Math.round(r.value * 100)}%</span>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-3 text-sm">
                <div><div style={{ color: C.muted }}>On-time monthly</div><div style={{ color: C.ink }}>{isFinite(s.requiredMonthly) ? money(s.requiredMonthly) : "—"}</div></div>
                <div><div style={{ color: C.muted }}>Value at deadline</div><div style={{ color: C.ink }}>{shortMoney(s.projectedAtHorizon)}</div></div>
                <div><div style={{ color: C.muted }}>Finish line</div><div style={{ color: C.ink }}>{s.goalDate ? monthLabel(s.goalDate) : "—"}</div></div>
              </div>
            </Card>
          );
        })}
      </div>
      <Disclaimer>
        These are projections under an assumed return, not forecasts. Investments can lose value, and real returns vary year to year.
      </Disclaimer>
    </div>
  );
}

function ProgressScreen({ d }) {
  const [tab, setTab] = useState("overview");
  return (
    <div className="px-5 pb-8">
      <div className="flex gap-2 mb-4">
        {[["overview", "Overview"], ["contributions", "Contributions"], ["milestones", "Milestones"]].map(([k, l]) => (
          <Chip key={k} active={tab === k} onClick={() => setTab(k)}>{l}</Chip>
        ))}
      </div>

      {tab === "overview" && (
        <>
          <Card className="p-5 mb-4">
            <div className="flex items-baseline justify-between">
              <div>
                <div className="text-sm" style={{ color: C.muted }}>Total saved so far</div>
                <div className="text-3xl font-semibold tracking-tight" style={{ color: C.ink }}>{money(d.totalSaved)}</div>
              </div>
              <div className="text-xl font-semibold" style={{ color: C.forest }}>{(d.progress * 100).toFixed(1)}%</div>
            </div>
            <div className="mt-4 h-2 rounded-full overflow-hidden" style={{ background: C.sage }}>
              <div style={{ width: `${d.progress * 100}%`, height: "100%", background: C.forest, borderRadius: 99, transition: "width 700ms" }} />
            </div>
          </Card>

          <Card className="p-4 mb-4" style={{ background: d.status.tint, border: "none" }}>
            <p style={{ color: C.forest }}>{d.status.headline}</p>
          </Card>

          <div className="grid grid-cols-2 gap-3">
            <Stat label="Average monthly saving" value={shortMoney(d.avgMonthly)} sub="last 3 months" icon="📈" />
            <Stat label="Days bought back" value={`${Math.floor(d.daysReduced)}`} sub="from extras and bonuses" icon="⏱" tint={C.mint} />
            <Stat label="Current projection" value={d.status.short} sub={`vs your deadline`} icon="🎯" tint="#FBEFD8" />
            <Stat label="Projected finish" value={d.goalDate ? monthLabel(d.goalDate) : "—"} sub={d.aheadDays >= 0 ? `${Math.floor(d.aheadDays)} days early` : `${Math.floor(-d.aheadDays)} days late`} icon="🏁" tint="#EFEAFB" />
          </div>
        </>
      )}

      {tab === "contributions" && (
        <Card className="divide-y" style={{ borderColor: C.line }}>
          {d.contributions.map((c) => (
            <div key={c.id} className="flex items-center justify-between p-4">
              <div>
                <div className="font-medium" style={{ color: C.ink }}>{c.note}</div>
                <div className="text-xs" style={{ color: C.muted }}>{dateLabel(c.date)} · {c.type}</div>
              </div>
              <div className="text-right">
                <div className="font-semibold" style={{ color: C.ink }}>+{money(c.amount)}</div>
                {c.daysSaved != null && c.daysSaved >= 1 ? (
                  <div className="text-xs" style={{ color: C.forest }}>{Math.floor(c.daysSaved)} days closer</div>
                ) : null}
              </div>
            </div>
          ))}
        </Card>
      )}

      {tab === "milestones" && (
        <>
          <Card className="p-5 mb-4">
            <div className="flex items-center gap-3">
              <span className="text-3xl" aria-hidden="true">🔥</span>
              <div>
                <div className="text-3xl font-semibold" style={{ color: C.ink }}>{d.streak}</div>
                <div className="text-sm" style={{ color: C.muted }}>{d.streak === 1 ? "day" : "days"} in a row with a saving logged</div>
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              {d.weekDots.map((dot, i) => (
                <div key={i} className="flex-1 text-center">
                  <div className="rounded-full mx-auto flex items-center justify-center" style={{ width: 30, height: 30, background: dot.hit ? C.mint : C.sage, color: dot.hit ? C.forest : C.muted }}>
                    {dot.hit ? "\u2713" : ""}
                  </div>
                  <div className="text-xs mt-1" style={{ color: C.muted }}>{dot.label}</div>
                </div>
              ))}
            </div>
            <p className="text-sm mt-4" style={{ color: C.muted }}>
              The streak counts saving, not app opens. Miss a day, nothing breaks.
            </p>
          </Card>
          <div className="grid grid-cols-2 gap-3">
            {d.milestones.map((m) => (
              <Card key={m.label} className="p-4" style={{ opacity: m.done ? 1 : 0.55 }}>
                <div className="flex items-center justify-center rounded-2xl mb-3" style={{ width: 44, height: 44, background: m.done ? C.mint : C.sage }}>
                  <span className="text-xl" aria-hidden="true">{m.icon}</span>
                </div>
                <div className="font-medium" style={{ color: C.ink }}>{m.label}</div>
                <div className="text-xs mt-1" style={{ color: C.muted }}>{m.done ? "Earned" : m.hint}</div>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function InsightsScreen({ d }) {
  const [buy, setBuy] = useState("15000");
  const amount = Number(String(buy).replace(/[^\d]/g, "")) || 0;
  const daysCloser = fin.daysSavedBy(amount, d.totalSaved, d.monthly, d.annual, d.goal);

  return (
    <div className="px-5 pb-8">
      <h3 className="text-lg font-semibold mb-3" style={{ color: C.ink }}>What's changing</h3>
      <div className="grid gap-3 mb-6">
        {d.insights.map((i, idx) => (
          <Card key={idx} className="p-4">
            <div className="text-sm" style={{ color: C.muted }}>{i.label}</div>
            <div className="text-base mt-1" style={{ color: C.ink }}>{i.text}</div>
          </Card>
        ))}
      </div>

      <h3 className="text-lg font-semibold mb-1" style={{ color: C.ink }}>Before you buy</h3>
      <p className="text-sm mb-3" style={{ color: C.muted }}>No judgement either way. Just the trade, laid out.</p>
      <Card className="p-5 mb-6">
        <TextInput value={inr.format(amount)} onChange={setBuy} ariaLabel="Purchase amount" />
        <div className="grid grid-cols-2 gap-3 mt-4">
          <div className="rounded-2xl p-4" style={{ background: C.sage }}>
            <div className="text-sm" style={{ color: C.muted }}>Spend it</div>
            <div className="text-xl font-semibold mt-1" style={{ color: C.ink }}>{money(amount)}</div>
            <div className="text-xs mt-1" style={{ color: C.muted }}>today</div>
          </div>
          <div className="rounded-2xl p-4" style={{ background: C.mint }}>
            <div className="text-sm" style={{ color: C.forest }}>Keep it invested</div>
            <div className="text-xl font-semibold mt-1" style={{ color: C.forest }}>{shortMoney(fin.futurePurchaseValue(amount, d.annual, 10))}</div>
            <div className="text-xs mt-1" style={{ color: C.forest }}>in 10 years</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 mt-3 text-center">
          {[5, 10, 20].map((y) => (
            <div key={y} className="rounded-xl py-3" style={{ background: "#fff", border: `1px solid ${C.line}` }}>
              <div className="text-xs" style={{ color: C.muted }}>{y} years</div>
              <div className="font-semibold" style={{ color: C.ink }}>{shortMoney(fin.futurePurchaseValue(amount, d.annual, y))}</div>
            </div>
          ))}
        </div>
        <p className="mt-4" style={{ color: C.ink }}>
          {daysCloser >= 1
            ? `Not buying this would move your goal about ${Math.floor(daysCloser)} days closer.`
            : `Not buying this would move your goal about ${Math.max(1, Math.floor(daysCloser * 24))} hours closer.`}
        </p>
        <p className="text-sm mt-1" style={{ color: C.muted }}>Your choice. Your future.</p>
        <Disclaimer>Future values assume a steady {(d.annual * 100).toFixed(1)}% a year, which no real investment delivers. Illustrative only.</Disclaimer>
      </Card>

      <h3 className="text-lg font-semibold mb-3" style={{ color: C.ink }}>Everything you've logged</h3>
      {d.contributions.length === 0 ? (
        <Card className="p-6 text-center">
          <div className="text-2xl mb-2" aria-hidden="true">◍</div>
          <p style={{ color: C.muted }}>Nothing logged yet. Your first saving will show up here.</p>
        </Card>
      ) : (
        <Card className="divide-y" style={{ borderColor: C.line }}>
          {d.contributions.map((c) => (
            <div key={c.id} className="flex items-center justify-between p-4">
              <div>
                <div className="font-medium" style={{ color: C.ink }}>{c.note}</div>
                <div className="text-xs" style={{ color: C.muted }}>{dateLabel(c.date)}{c.skipped ? ` \u00b7 ${c.skipped}` : ""}</div>
              </div>
              <div className="font-semibold" style={{ color: C.ink }}>+{money(c.amount)}</div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function GoalsScreen({ d, onRisk, onInflation, email, offline, onSignOut }) {
  const alloc = ALLOCATIONS[d.risk];
  return (
    <div className="px-5 pb-8">
      <Card className="p-5 mb-5">
        <div className="text-sm" style={{ color: C.muted }}>Active goal</div>
        <div className="text-2xl font-semibold tracking-tight mt-1" style={{ color: C.ink }}>{money(d.goal)} by age {d.targetAge}</div>
        <div className="text-sm mt-1" style={{ color: C.muted }}>
          {money(d.totalSaved)} saved · {isFinite(d.daysToGo) ? `${inr.format(Math.round(d.daysToGo))} days to go` : "not reachable at this pace"}
        </div>
      </Card>

      <h3 className="text-lg font-semibold mb-1" style={{ color: C.ink }}>How a portfolio like this is usually built</h3>
      <p className="text-sm mb-3" style={{ color: C.muted }}>An illustrative mix for a {monthsToWords(d.horizonMonths)} horizon.</p>
      <div className="flex flex-wrap gap-2 mb-3">
        {Object.keys(ALLOCATIONS).map((k) => (
          <Chip key={k} active={d.risk === k} onClick={() => onRisk(k)}>{ALLOCATIONS[k].label}</Chip>
        ))}
      </div>
      <Card className="p-4">
        <div style={{ width: "100%", height: 230 }}>
          <ResponsiveContainer>
            <PieChart>
              <Pie data={alloc.mix} dataKey="value" nameKey="name" innerRadius={58} outerRadius={88} paddingAngle={2} stroke="none">
                {alloc.mix.map((m) => <Cell key={m.name} fill={m.color} />)}
              </Pie>
              <Legend verticalAlign="bottom" iconType="circle" formatter={(v, e) => (
                <span style={{ color: C.muted, fontSize: 12 }}>{e?.payload?.value}% {v}</span>
              )} />
              <Tooltip formatter={(v, n) => [`${v}%`, n]} contentStyle={{ borderRadius: 14, border: `1px solid ${C.line}`, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-2 text-sm">
          <div className="rounded-xl p-3" style={{ background: C.sage }}><div style={{ color: C.muted }}>Growth potential</div><div style={{ color: C.ink }}>{d.risk === "growth" ? "High" : d.risk === "balanced" ? "Medium" : "Low"}</div></div>
          <div className="rounded-xl p-3" style={{ background: C.sage }}><div style={{ color: C.muted }}>Stability</div><div style={{ color: C.ink }}>{d.risk === "growth" ? "Low" : d.risk === "balanced" ? "Medium" : "High"}</div></div>
          <div className="rounded-xl p-3" style={{ background: C.sage }}><div style={{ color: C.muted }}>Liquidity</div><div style={{ color: C.ink }}>Medium</div></div>
          <div className="rounded-xl p-3" style={{ background: C.sage }}><div style={{ color: C.muted }}>Ups and downs</div><div style={{ color: C.ink }}>{d.risk === "growth" ? "Expect them" : d.risk === "balanced" ? "Some" : "Few"}</div></div>
        </div>
        <Disclaimer>
          An illustrative planning scenario based on your time horizon. Not personalised financial advice, and not a recommendation to buy anything.
        </Disclaimer>
      </Card>

      <h3 className="text-lg font-semibold mt-6 mb-3" style={{ color: C.ink }}>Settings</h3>
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium" style={{ color: C.ink }}>Adjust the goal for inflation</div>
            <div className="text-xs mt-1" style={{ color: C.muted }}>
              {d.inflationOn
                ? `Your goal is being treated as ${money(d.effectiveGoal)} in future rupees.`
                : "Off. Your goal is measured in today's rupees."}
            </div>
          </div>
          <button
            onClick={() => onInflation(!d.inflationOn)}
            role="switch" aria-checked={d.inflationOn} aria-label="Adjust for inflation"
            className="rounded-full" style={{ width: 52, height: 30, background: d.inflationOn ? C.forest : C.line, position: "relative", flexShrink: 0 }}
          >
            <span style={{ position: "absolute", top: 3, left: d.inflationOn ? 25 : 3, width: 24, height: 24, borderRadius: 99, background: "#fff", transition: "left 180ms" }} />
          </button>
        </div>
      </Card>
      <h3 className="text-lg font-semibold mt-6 mb-3" style={{ color: C.ink }}>Account</h3>
      <Card className="p-4">
        <div className="text-xs" style={{ color: C.muted }}>Signed in as</div>
        <div className="font-medium" style={{ color: C.ink }}>{email}</div>
        <div className="text-xs mt-2" style={{ color: C.muted }}>
          {offline
            ? "Offline right now. Anything you log is saved here and syncs when you reconnect."
            : "Your goal and savings are synced to your account."}
        </div>
        <Button variant="ghost" className="w-full mt-4" onClick={onSignOut}>Sign out</Button>
      </Card>

      <Disclaimer>
        Everything in this app is a projection, not a promise. Returns are not guaranteed, investments can lose value, and your actual result will differ.
      </Disclaimer>
    </div>
  );
}

function GoalComplete({ d, onNewGoal }) {
  return (
    <div className="px-5 pb-8 pt-6 text-center">
      <div className="text-4xl mb-3" aria-hidden="true">🏆</div>
      <h1 className="text-3xl font-semibold tracking-tight" style={{ color: C.ink }}>You did it.</h1>
      <div className="text-4xl font-semibold tracking-tight mt-4" style={{ color: C.forest }}>{money(d.totalSaved)}</div>
      <p className="mt-2" style={{ color: C.muted }}>Goal reached.</p>
      <div className="grid grid-cols-2 gap-3 mt-6 text-left">
        <Stat label="Original target date" value={monthLabel(d.deadlineDate)} icon="📅" />
        <Stat label="Finished" value={monthLabel(new Date())} icon="🏁" tint={C.mint} />
        <Stat label="Time saved" value={`${Math.max(0, Math.floor(d.aheadDays))} days`} icon="⏱" tint="#FBEFD8" />
        <Stat label="You contributed" value={shortMoney(d.contributedTotal)} icon="₹" />
      </div>
      <Button className="w-full mt-6" onClick={onNewGoal}>Set a new goal</Button>
    </div>
  );
}

/* ------------------------------ 13. NAV ----------------------------------- */

const TABS = [
  { k: "home", l: "Home", icon: "◎" },
  { k: "plan", l: "Plan", icon: "▤" },
  { k: "add", l: "Add", icon: "+" },
  { k: "progress", l: "Progress", icon: "▲" },
  { k: "insights", l: "Insights", icon: "✦" },
];

function BottomNav({ tab, setTab, onAdd }) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 md:hidden" style={{ background: "#fff", borderTop: `1px solid ${C.line}` }} aria-label="Main">
      <div className="flex items-center justify-around px-2 pt-2 pb-3">
        {TABS.map((t) =>
          t.k === "add" ? (
            <button key={t.k} onClick={onAdd} aria-label="Add savings"
              className="rounded-full flex items-center justify-center active:scale-95 transition-transform"
              style={{ width: 52, height: 52, background: C.btn, color: "#fff", fontSize: 26, marginTop: -18, boxShadow: "0 6px 16px rgba(23,60,44,0.3)" }}>
              +
            </button>
          ) : (
            <button key={t.k} onClick={() => setTab(t.k)} aria-current={tab === t.k ? "page" : undefined}
              className="flex flex-col items-center gap-1 px-3 py-1 rounded-xl" style={{ color: tab === t.k ? C.forest : C.muted, minWidth: 56 }}>
              <span aria-hidden="true" style={{ fontSize: 16 }}>{t.icon}</span>
              <span style={{ fontSize: 11 }}>{t.l}</span>
            </button>
          )
        )}
      </div>
    </nav>
  );
}

function Sidebar({ tab, setTab, onAdd, d }) {
  const items = [...TABS.filter((t) => t.k !== "add"), { k: "goals", l: "Goals", icon: "◈" }];
  return (
    <aside className="hidden md:flex flex-col w-64 shrink-0 p-6" style={{ borderRight: `1px solid ${C.line}`, background: "#fff" }}>
      <div className="mb-8">
        <div className="text-xl font-semibold tracking-tight" style={{ color: C.forest }}>Closer</div>
        <div className="text-xs mt-1" style={{ color: C.muted }}>Money in. Time back.</div>
      </div>
      <nav className="flex flex-col gap-1" aria-label="Main">
        {items.map((t) => (
          <button key={t.k} onClick={() => setTab(t.k)} aria-current={tab === t.k ? "page" : undefined}
            className="text-left rounded-2xl px-4 py-3 font-medium"
            style={{ background: tab === t.k ? C.sage : "transparent", color: tab === t.k ? C.forest : C.muted }}>
            <span className="mr-3" aria-hidden="true">{t.icon}</span>{t.l}
          </button>
        ))}
      </nav>
      <div className="mt-6"><Button className="w-full" onClick={onAdd}>+ Add savings</Button></div>
      <div className="mt-auto pt-6">
        <div className="rounded-2xl p-4" style={{ background: C.sage }}>
          <div className="text-xs" style={{ color: C.muted }}>Signed in as</div>
          <div className="font-medium" style={{ color: C.ink }}>{d.name}</div>
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------ 14. APP ----------------------------------- */

export default function CloserApp() {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [profile, setProfile] = useState(null);
  const [contributions, setContributions] = useState([]);
  const [tab, setTab] = useState("home");
  const [sheet, setSheet] = useState(null); // 'actions' | 'savings' | 'extra'
  const [savingsPreset, setSavingsPreset] = useState("salary");
  const [celebration, setCelebration] = useState(null);
  const [inflationOn, setInflationOn] = useState(false);
  const [streak, setStreak] = useState(0);
  const [lastActiveDay, setLastActiveDay] = useState(null);

  useEffect(() => { runEngineChecks(); }, []);

  // Watch auth. One listener handles first load, sign-in and sign-out alike.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session || null));
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => setSession(s || null));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Load this user's data whenever a session appears.
  useEffect(() => {
    let cancelled = false;
    if (session === undefined) return;
    if (session === null) { setLoading(false); setProfile(null); setContributions([]); return; }

    (async () => {
      setLoading(true);
      const uid = session.user.id;
      await migrateLegacyLocal(uid).catch(() => {});
      const res = await store.pull(uid);
      if (cancelled) return;
      setOffline(!res.online);
      if (res.profile) {
        setProfile(res.profile);
        setContributions(res.contributions);
        setInflationOn(!!res.profile.inflationOn);
        setStreak(res.profile.streak || 0);
        setLastActiveDay(res.profile.lastActiveDay || null);
      } else {
        setProfile(null);
        setContributions([]);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [session]);

  // Keep a local mirror so the app renders instantly and works offline.
  useEffect(() => {
    if (!profile) return;
    store.cache({ ...profile, inflationOn, streak, lastActiveDay }, contributions);
  }, [profile, contributions, inflationOn, streak, lastActiveDay]);

  // Push goal/setting changes up. Debounced so a slider drag isn't 40 writes.
  const pushTimer = useRef(null);
  useEffect(() => {
    if (!profile || !session) return;
    clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      store.saveGoal({ ...profile, inflationOn, streak, lastActiveDay }, session.user.id);
    }, 700);
    return () => clearTimeout(pushTimer.current);
  }, [profile, inflationOn, streak, lastActiveDay, session]);

  // Retry queued writes when the network comes back.
  useEffect(() => {
    if (!session) return;
    const onOnline = async () => {
      const r = await store.flush(session.user.id);
      if (r.flushed) { setOffline(false); const res = await store.pull(session.user.id); if (res.profile) setContributions(res.contributions); }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [session]);

  /* ---- derived model: one memo, everything downstream reads from it ---- */
  const d = useMemo(() => {
    if (!profile) return null;
    const now = new Date();
    const contributed = contributions.reduce((s, c) => s + c.amount, 0);
    const totalSaved = profile.startingBalance + contributed;
    const horizonMonths = Math.max(1, (profile.targetAge - profile.age) * 12);
    const deadlineDate = new Date(now.getTime() + horizonMonths * DAYS_PER_MONTH * 86400000);
    const years = horizonMonths / 12;
    const effectiveGoal = inflationOn ? fin.realTarget(profile.goal, 0.06, years) : profile.goal;

    const daysToGo = fin.daysToGoal(totalSaved, profile.monthly, profile.annual, effectiveGoal);
    const goalDate = fin.goalDate(now, totalSaved, profile.monthly, profile.annual, effectiveGoal);
    const deadlineDays = horizonMonths * DAYS_PER_MONTH;
    const aheadDays = isFinite(daysToGo) ? deadlineDays - daysToGo : -Infinity;

    // Days bought back = the effect of everything beyond the plain monthly plan.
    const boostTotal = contributions.filter((c) => c.type !== "salary").reduce((s, c) => s + c.amount, 0);
    const daysReduced = fin.daysSavedBy(boostTotal, totalSaved - boostTotal, profile.monthly, profile.annual, effectiveGoal);

    const requiredMonthly = fin.requiredMonthlyContribution(totalSaved, profile.annual, horizonMonths, effectiveGoal);
    const progress = fin.progress(totalSaved, effectiveGoal);

    const loggedDays = new Set(contributions.map((c) => dayKey(c.date)));
    const weekDots = Array.from({ length: 7 }, (_, i) => {
      const day = new Date(now.getTime() - (6 - i) * 86400000);
      return { label: "SMTWTFS"[day.getDay()], hit: loggedDays.has(dayKey(day)) };
    });

    const recent = contributions.filter((c) => now - c.date < 92 * 86400000);
    const avgMonthly = recent.reduce((s, c) => s + c.amount, 0) / 3;

    const done = totalSaved >= effectiveGoal;
    let status;
    if (done) status = { key: "done", headline: "Goal reached.", short: "Complete", line: "You got there.", tint: C.mint };
    else if (!isFinite(daysToGo))
      status = { key: "stalled", headline: "At ₹0 a month with no return assumption, this goal doesn't move.", short: "Stalled", line: "Set a monthly saving to start the countdown.", action: "Add a monthly saving amount on the Plan screen.", tint: "#FBEFD8" };
    else if (aheadDays >= 30)
      status = { key: "ahead", headline: `You're ahead of your deadline by about ${Math.floor(aheadDays)} days.`, short: "Ahead", line: "A little progress each day adds up to big results.", tint: C.mint };
    else if (aheadDays >= 0)
      status = { key: "ontrack", headline: "You're on track for your deadline.", short: "On track", line: "Steady wins this. Keep the pace.", tint: C.mint };
    else
      status = {
        key: "behind",
        headline: `You're about ${Math.floor(-aheadDays)} days behind your original path.`,
        short: "Behind",
        line: "Nothing's broken. The pace just needs a nudge.",
        action: `Saving ${money(Math.max(0, requiredMonthly - profile.monthly))} more each month would put you back on time.`,
        tint: "#FBEFD8",
      };

    const extrasCount = contributions.filter((c) => c.type === "extra").length;
    const milestones = [
      { label: "First ₹10,000", icon: "🌱", done: contributed >= 10000, hint: `${shortMoney(Math.max(0, 10000 - contributed))} to go` },
      { label: "First ₹1 lakh", icon: "💚", done: contributed >= 100000, hint: `${shortMoney(Math.max(0, 100000 - contributed))} to go` },
      { label: "7 days reduced", icon: "⏱", done: daysReduced >= 7, hint: `${Math.max(0, Math.ceil(7 - daysReduced))} days to go` },
      { label: "30 days reduced", icon: "🗓", done: daysReduced >= 30, hint: `${Math.max(0, Math.ceil(30 - daysReduced))} days to go` },
      { label: "10 extra logs", icon: "✦", done: extrasCount >= 10, hint: `${Math.max(0, 10 - extrasCount)} more to log` },
      { label: "Quarter of the way", icon: "🏅", done: progress >= 0.25, hint: `${(25 - progress * 100).toFixed(1)}% to go` },
    ];

    const insights = [
      { label: "Momentum", text: daysReduced >= 1 ? `Extra savings have pulled your goal ${Math.floor(daysReduced)} days closer so far.` : "Your first extra saving will start moving the finish line." },
      { label: "Consistency", text: `${extrasCount} extra savings logged. Average monthly total: ${money(avgMonthly)}.` },
      { label: "Projection", text: goalDate ? `On today's pace you'd reach ${money(effectiveGoal)} around ${monthLabel(goalDate)}.` : "Add a monthly saving amount to get a projection." },
      { label: "The trade", text: `At your current pace, roughly ${money(profile.monthly / DAYS_PER_MONTH)} of saving buys back one day.` },
    ];

    return {
      ...profile, name: profile.name, totalSaved, contributedTotal: contributed, horizonMonths, deadlineDate,
      deadlineDays, daysToGo, goalDate, aheadDays, daysReduced, requiredMonthly, progress, avgMonthly,
      contributions: [...contributions].sort((a, b) => b.date - a.date), status, milestones, insights, weekDots,
      inflationOn, effectiveGoal, streak, done, risk: profile.risk, id: profile.id, offline,
    };
  }, [profile, contributions, inflationOn, streak, offline]);

  /* ---- actions ---- */
  const addContribution = ({ amount, type, note, skipped }, celebrate) => {
    const now = new Date();
    const before = fin.daysToGoal(d.totalSaved, d.monthly, d.annual, d.effectiveGoal);
    const beforeDate = fin.goalDate(now, d.totalSaved, d.monthly, d.annual, d.effectiveGoal);
    const after = fin.daysToGoal(d.totalSaved + amount, d.monthly, d.annual, d.effectiveGoal);
    const afterDate = fin.goalDate(now, d.totalSaved + amount, d.monthly, d.annual, d.effectiveGoal);
    const daysSaved = isFinite(before) && isFinite(after) ? Math.max(0, before - after) : 0;

    const local = { id: `u${Date.now()}`, date: now, amount, type, note, skipped, daysSaved };
    setContributions((prev) => [...prev, local]);
    const st = nextStreak(streak, lastActiveDay, now);
    setStreak(st.streak); setLastActiveDay(st.lastActiveDay);
    if (session && d.id) {
      store.addContribution({ ...local, id: undefined, goalId: d.id }, session.user.id)
        .then((id) => setContributions((prev) => prev.map((c) => (c === local ? { ...c, id } : c))))
        .catch(() => setOffline(true));
    }
    haptic();
    if (celebrate) {
      setCelebration({ amount, daysSaved, newDays: after, oldDate: beforeDate, newDate: afterDate });
      setSheet(null);
    }
  };

  if (session === undefined || (session && loading)) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: C.cream, fontFamily: FONT, color: C.muted }}>
        Loading your journey…
      </div>
    );
  }

  if (session === null) return <AuthScreen />;

  if (!profile) {
    return (
      <Onboarding
        onDone={async (p) => {
          setContributions([]); setStreak(0); setLastActiveDay(null);
          const id = await store.saveGoal(p, session.user.id);
          setProfile({ ...p, id });
        }}
      />
    );
  }

  const openAdd = () => setSheet("actions");

  return (
    <div className="min-h-screen flex" style={{ background: C.cream, fontFamily: FONT, color: C.ink }}>
      <Sidebar tab={tab} setTab={setTab} onAdd={openAdd} d={d} />

      <div className="flex-1 min-w-0">
        <header className="flex items-center justify-between px-5 py-4 md:px-8" style={{ background: C.cream }}>
          <div className="md:hidden text-lg font-semibold tracking-tight" style={{ color: C.forest }}>Closer</div>
          <div className="hidden md:block text-2xl font-semibold tracking-tight" style={{ color: C.ink }}>
            {tab === "home" ? `Hello, ${d.name}` : TABS.concat([{ k: "goals", l: "Goals" }]).find((t) => t.k === tab)?.l}
          </div>
          <button onClick={() => setTab("goals")} className="rounded-full flex items-center justify-center" aria-label="Goals and settings"
            style={{ width: 38, height: 38, background: C.sage, color: C.forest }}>◈</button>
        </header>

        <main className="pb-28 md:pb-10 md:px-8 max-w-3xl mx-auto md:mx-0">
          {d.done && tab === "home" ? (
            <GoalComplete d={d} onNewGoal={async () => { if (d.id) await store.deleteGoal(d.id); setProfile(null); setContributions([]); setStreak(0); setLastActiveDay(null); setTab("home"); }} />
          ) : (
            <>
              {tab === "home" && <HomeScreen d={d} onAdd={() => { setSavingsPreset("salary"); setSheet("savings"); }} onExtra={() => setSheet("extra")} />}
              {tab === "plan" && <PlanScreen d={d}
                onChangeMonthly={(v) => setProfile((p) => ({ ...p, monthly: v }))}
                onChangeReturn={(v) => setProfile((p) => ({ ...p, annual: v, risk: v >= 0.1 ? "growth" : v >= 0.08 ? "balanced" : "conservative" }))} />}
              {tab === "progress" && <ProgressScreen d={d} />}
              {tab === "insights" && <InsightsScreen d={d} />}
              {tab === "goals" && <GoalsScreen d={d} email={session.user.email} offline={offline}
                onSignOut={async () => { store.clearCache(); await supabase.auth.signOut(); }}
                onRisk={(k) => setProfile((p) => ({ ...p, risk: k, annual: ALLOCATIONS[k].annual }))}
                onInflation={setInflationOn} />}
            </>
          )}
        </main>
      </div>

      <BottomNav tab={tab} setTab={setTab} onAdd={openAdd} />

      <ActionSheet
        open={sheet === "actions"}
        onClose={() => setSheet(null)}
        onPick={(k) => {
          if (k === "extra") setSheet("extra");
          else { setSavingsPreset(k === "investment" ? "investment" : k === "income" ? "side" : "salary"); setSheet("savings"); }
        }}
      />
      <AddSavingsSheet open={sheet === "savings"} defaultType={savingsPreset} onClose={() => setSheet(null)}
        onAdd={(c) => addContribution(c, false)} />
      <ExtraSheet open={sheet === "extra"} onClose={() => setSheet(null)}
        onAdd={(c) => addContribution(c, true)} />
      <Celebration data={celebration} onClose={() => { setCelebration(null); setTab("home"); }} />
    </div>
  );
}
