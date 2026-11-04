import React, { useState } from "react";
import { supabase } from "./store.js";

/* Sign-in / sign-up. Deliberately one screen with a mode toggle: two screens
   for four fields is friction nobody needs. */

const C = {
  ink: "#10241B", forest: "#1B4332", btn: "#173C2C", mint: "#D7F0DF",
  mintDeep: "#95D5B2", sage: "#EDF5EF", cream: "#F6F8F4", line: "#E4EBE5",
  muted: "#6C7C73", coral: "#EF8B62",
};
const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export default function AuthScreen() {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setMsg(null);
    if (!email.trim()) return setMsg({ bad: true, text: "Enter your email." });
    if (password.length < 8) return setMsg({ bad: true, text: "Password needs at least 8 characters." });
    setBusy(true);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) throw error;
        // If confirmations are on, there's no session yet and they must check mail.
        if (!data.session) {
          setMsg({ bad: false, text: "Account created. Check your email to confirm, then sign in." });
          setMode("signin");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      }
    } catch (err) {
      setMsg({ bad: true, text: friendly(err.message) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-center px-6" style={{ background: C.cream, fontFamily: FONT }}>
      <div className="w-full max-w-sm mx-auto">
        <div className="mb-8">
          <div className="rounded-2xl flex items-center justify-center mb-5" style={{ width: 56, height: 56, background: C.forest }}>
            <span style={{ color: C.mintDeep, fontSize: 26 }} aria-hidden="true">◎</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight" style={{ color: C.ink }}>
            {mode === "signup" ? "Start your journey" : "Welcome back"}
          </h1>
          <p className="mt-2" style={{ color: C.muted }}>
            {mode === "signup"
              ? "Your goal and savings stay on your account, on every device."
              : "Pick up where you left off."}
          </p>
        </div>

        <form onSubmit={submit}>
          <label className="block mb-4">
            <span className="block text-sm mb-2" style={{ color: C.muted }}>Email</span>
            <input
              type="email" autoComplete="email" inputMode="email" value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
              className="w-full rounded-2xl px-4 text-lg outline-none"
              style={{ border: `1px solid ${C.line}`, background: "#fff", color: C.ink, minHeight: 56 }}
            />
          </label>

          <label className="block mb-2">
            <span className="block text-sm mb-2" style={{ color: C.muted }}>Password</span>
            <input
              type="password" value={password}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters"
              className="w-full rounded-2xl px-4 text-lg outline-none"
              style={{ border: `1px solid ${C.line}`, background: "#fff", color: C.ink, minHeight: 56 }}
            />
          </label>

          {msg ? (
            <div className="rounded-2xl p-3 mb-4 mt-3 text-sm"
              style={{ background: msg.bad ? "#FBEAE3" : C.mint, color: msg.bad ? "#8A3B1C" : C.forest }}
              role="status">
              {msg.text}
            </div>
          ) : <div className="mb-4" />}

          <button
            type="submit" disabled={busy}
            className="w-full rounded-full px-5 py-3 text-base font-semibold active:scale-95 transition-transform"
            style={{ background: C.btn, color: "#fff", minHeight: 52, opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "One moment…" : mode === "signup" ? "Create my account" : "Sign in"}
          </button>
        </form>

        <button
          onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setMsg(null); }}
          className="w-full mt-4 text-sm" style={{ color: C.muted }}
        >
          {mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
        </button>

        <p className="text-xs text-center mt-8 leading-relaxed" style={{ color: C.muted }}>
          Closer stores your goal and the savings you log. It never connects to a bank
          and never asks for account numbers.
        </p>
      </div>
    </div>
  );
}

function friendly(m) {
  const s = (m || "").toLowerCase();
  if (s.includes("invalid login")) return "That email and password don't match an account.";
  if (s.includes("already registered")) return "That email already has an account. Try signing in.";
  if (s.includes("confirm")) return "Check your email to confirm the account first.";
  if (s.includes("rate limit") || s.includes("too many")) return "Too many tries. Wait a minute and try again.";
  if (s.includes("fetch") || s.includes("network")) return "Can't reach the server. Check your connection.";
  return m || "Something went wrong. Try again.";
}
