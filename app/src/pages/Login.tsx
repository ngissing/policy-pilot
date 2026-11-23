import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Bell, Eye, EyeOff, Landmark, Lock, Quote } from "lucide-react";
import { api } from "../api";
import { useMe } from "../App";
import { Spinner } from "../components/bits";

type Mode = "signin" | "school" | "join";

export default function Login() {
  const { me, refresh } = useMe();
  // An invitation link from the owner looks like https://…/?invite=TOKEN
  const [inviteToken] = useState(() => new URLSearchParams(window.location.search).get("invite"));
  const [invite, setInvite] = useState<{ valid: boolean; note?: string | null } | null>(null);
  const [mode, setMode] = useState<Mode>(inviteToken || !me.hasAccounts ? "school" : "signin");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!inviteToken) return;
    api(`/auth/invite/${encodeURIComponent(inviteToken)}`)
      .then((d) => {
        setInvite(d);
        if (!d.valid) setMode("signin");
      })
      // If the check can't be made, the server still checks the invitation when the form is sent.
      .catch(() => {});
  }, [inviteToken]);

  const canCreateSchool = !!invite?.valid || me.signup?.schools === "open" || !!me.signup?.ownerSetup;
  const firstRun = !me.hasAccounts;

  const switchTo = (m: Mode) => {
    setMode(m);
    setError(null);
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body = { ...Object.fromEntries(new FormData(e.currentTarget)), invite: inviteToken ?? undefined };
    setBusy(true);
    setError(null);
    try {
      const path = mode === "signin" ? "/auth/login" : mode === "school" ? "/auth/signup-school" : "/auth/join";
      await api(path, { body });
      if (inviteToken) window.history.replaceState(null, "", "/");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const heading =
    mode === "signin" ? "Welcome back" : mode === "join" ? "Join your school" : firstRun ? "Set up PolicyPilot" : "Set up your school";
  const intro =
    mode === "signin"
      ? "Sign in with your school email."
      : mode === "join"
        ? "Your school's PolicyPilot admin can give you the join code."
        : invite?.valid
          ? `You've been invited to set up ${invite.note || "your school"}. You'll be its admin.`
          : firstRun
            ? "You're the first person here, so you'll also look after the shared PAL library."
            : "Create a private space for your school. You'll be its admin.";

  return (
    <div className="login">
      <header className="login-top">
        <div className="login-brand">
          <img src="/favicon.svg" width={28} height={28} alt="" />
          <span>PolicyPilot</span>
        </div>
        <span className="login-for">For Victorian government schools</span>
      </header>

      <main className="login-main">
        <section className="login-story" aria-label="About PolicyPilot">
          <h1>Policy answers you can point&nbsp;to.</h1>
          <p className="login-lede">
            Ask a question in plain words. PolicyPilot reads the Department's Policy and Advisory Library and your
            school's own policies, then answers with the exact source behind every point.
          </p>
          <AnswerPreview />
          <ul className="login-facts">
            <li><Quote size={16} aria-hidden /> Every answer links to the passage it came from</li>
            <li><Lock size={16} aria-hidden /> Your school's documents stay private to your school</li>
            <li><Bell size={16} aria-hidden /> You're told when a PAL topic your policies rely on changes</li>
          </ul>
        </section>

        <section className="login-panel">
          <div className="login-card">
            {mode !== "school" && (
              <div className="login-tabs" role="tablist" aria-label="How do you want to get in?">
                <button type="button" role="tab" aria-selected={mode === "signin"} onClick={() => switchTo("signin")}>Sign in</button>
                <button type="button" role="tab" aria-selected={mode === "join"} onClick={() => switchTo("join")}>Join with a code</button>
              </div>
            )}

            <form onSubmit={submit} className="login-form" noValidate={false}>
              <div>
                <h2>{heading}</h2>
                <p className="muted">{intro}</p>
              </div>

              {invite && !invite.valid && (
                <div className="notice error" role="alert">That invitation link has expired or has already been used. Ask for a new one.</div>
              )}

              {mode === "school" && (
                <div className="field">
                  <label htmlFor="schoolName">School name</label>
                  <input className="input" id="schoolName" name="schoolName" required autoComplete="organization" defaultValue={invite?.note ?? ""} />
                </div>
              )}
              {mode === "join" && (
                <div className="field">
                  <label htmlFor="code">Join code</label>
                  <input className="input login-code" id="code" name="code" required placeholder="K7QM-4XPD" autoComplete="off" spellCheck={false} />
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
                <input className="input" id="email" name="email" type="email" required autoComplete="email" placeholder="name@school.vic.edu.au" />
              </div>
              <div className="field">
                <label htmlFor="password">Password</label>
                <div className="login-password">
                  <input
                    className="input" id="password" name="password" required
                    type={showPassword ? "text" : "password"}
                    minLength={mode === "signin" ? undefined : 10}
                    autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  />
                  <button
                    type="button"
                    className="login-reveal"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
                {mode !== "signin" && <span className="hint">At least 10 characters.</span>}
              </div>

              {error && <div className="notice error" role="alert">{error}</div>}

              <button className="btn primary login-submit" type="submit" disabled={busy}>
                {busy && <Spinner />}
                {mode === "signin" ? "Sign in" : mode === "school" ? "Create school" : "Join school"}
              </button>

              {mode === "signin" && (
                <p className="small muted">Forgot your password? Your school's PolicyPilot admin can give you a one-time password.</p>
              )}
              {mode === "school" && me.hasAccounts && (
                <p className="small">Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); switchTo("signin"); }}>Sign in</a></p>
              )}
            </form>
          </div>

          {mode !== "school" && (
            <p className="login-newschool small">
              {canCreateSchool ? (
                <>New to PolicyPilot? <a href="#" onClick={(e) => { e.preventDefault(); switchTo("school"); }}>Set up your school</a></>
              ) : (
                "Setting up PolicyPilot for a new school? Ask whoever runs this site for an invitation link."
              )}
            </p>
          )}
        </section>
      </main>

      <footer className="login-foot">
        <span><Landmark size={13} aria-hidden /> PAL content © State of Victoria (Department of Education), linked to its source.</span>
      </footer>
    </div>
  );
}

/**
 * A real example of what an answer looks like, quoted from the PAL "Allergies" topic. The cited sentence is
 * highlighted once when the page loads.
 */
function AnswerPreview() {
  return (
    <figure className="preview" aria-label="Example of a PolicyPilot answer">
      <div className="preview-q">Do we need a plan for a student who has a Green Plan?</div>
      <div className="preview-a">
        <p>
          Yes. <mark className="preview-mark">Schools must develop an Individual Allergic Reactions Risk Management Plan for students who have a Green Plan</mark>
          <span className="nowrap"><span className="cite" aria-label="Source 1">1</span>.</span> It isn't needed for every student with
          allergies, only those whose Green Plan has been supplied to the school by their parents or{" "}
          <span className="nowrap">carers<span className="cite" aria-label="Source 1">1</span>.</span>
        </p>
        <div className="preview-source">
          <span className="cite" aria-hidden>1</span>
          <span><strong>Allergies</strong> › Policy › Summary</span>
          <span className="muted">PAL, updated 23 Jan 2026</span>
        </div>
      </div>
    </figure>
  );
}
