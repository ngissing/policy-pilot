import { useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api";
import { useMe } from "../App";
import { Spinner } from "../components/bits";

type Mode = "signin" | "school" | "join";

export default function Login() {
  const { me, refresh } = useMe();
  const [mode, setMode] = useState<Mode>(me.hasAccounts ? "signin" : "school");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError(null);
    try {
      const path = mode === "signin" ? "/auth/login" : mode === "school" ? "/auth/signup-school" : "/auth/join";
      await api(path, { body });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <section className="auth-side">
        <div className="row" style={{ gap: 10 }}>
          <img src="/favicon.svg" width={30} height={30} alt="" />
          <strong style={{ fontSize: 18 }}>PolicyPilot</strong>
        </div>
        <div>
          <h1>Policy answers you can point to.</h1>
          <p>
            Ask a question in plain words. PolicyPilot reads the Department's Policy and Advisory Library and your
            school's own policies, then answers with the exact sources.
          </p>
        </div>
        <p className="small" style={{ color: "#8f9aa8" }}>For Victorian government schools.</p>
        <div className="auth-tabs" aria-hidden>
          <span style={{ background: "var(--dept)" }}>Department (PAL)</span>
          <span style={{ background: "var(--school)" }}>Our school</span>
          <span style={{ background: "var(--mark)", color: "var(--ink)" }}>Cited answer</span>
        </div>
      </section>

      <section className="auth-form">
        <form onSubmit={submit}>
          <div>
            <h2 style={{ fontSize: 24 }}>
              {mode === "signin" ? "Sign in" : mode === "school" ? "Set up your school" : "Join your school"}
            </h2>
            <p className="muted" style={{ marginTop: 6 }}>
              {mode === "signin" && "Use the email you registered with."}
              {mode === "school" && (me.hasAccounts ? "Create a space for your school. You'll be its admin." : "You're the first person here, so you'll also manage the shared PAL library.")}
              {mode === "join" && "Ask your school's PolicyPilot admin for the join code."}
            </p>
          </div>

          {mode === "school" && (
            <div className="field">
              <label htmlFor="schoolName">School name</label>
              <input className="input" id="schoolName" name="schoolName" required autoComplete="organization" />
            </div>
          )}
          {mode === "join" && (
            <div className="field">
              <label htmlFor="code">Join code</label>
              <input className="input" id="code" name="code" required placeholder="e.g. K7QM-4XPD" style={{ textTransform: "uppercase" }} />
            </div>
          )}
          {mode !== "signin" && (
            <div className="field">
              <label htmlFor="name">Your name</label>
              <input className="input" id="name" name="name" required autoComplete="name" />
            </div>
          )}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input className="input" id="email" name="email" type="email" required autoComplete="email" />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              className="input" id="password" name="password" type="password" required
              minLength={mode === "signin" ? undefined : 10}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
            />
            {mode !== "signin" && <span className="hint">At least 10 characters.</span>}
          </div>

          {error && <div className="notice error" role="alert">{error}</div>}

          <button className="btn primary" type="submit" disabled={busy} style={{ height: 42 }}>
            {busy && <Spinner />}
            {mode === "signin" ? "Sign in" : mode === "school" ? "Create school" : "Join school"}
          </button>

          <div className="stack small" style={{ gap: 6, marginTop: 4 }}>
            {mode !== "signin" && me.hasAccounts && (
              <p>Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); setMode("signin"); }}>Sign in</a></p>
            )}
            {mode !== "join" && me.hasAccounts && (
              <p>Got a join code from your school? <a href="#" onClick={(e) => { e.preventDefault(); setMode("join"); }}>Join your school</a></p>
            )}
            {mode !== "school" && (
              <p>New school? <a href="#" onClick={(e) => { e.preventDefault(); setMode("school"); }}>Set up your school</a></p>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
