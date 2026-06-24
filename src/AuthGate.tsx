import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";
import App from "./App";
import WorldMapWiki from "./WorldMapWiki";

type View = "app" | "auth" | "reset";

type WikiSeoSettings = {
  seoTitle?: string;
  seoDescription?: string;
  seoImageUrl?: string;
  allowIndexing?: boolean;
};

function upsertMetaByName(name: string, content: string) {
  let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("name", name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function upsertMetaByProperty(property: string, content: string) {
  let el = document.querySelector(`meta[property="${property}"]`) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("property", property);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function upsertCanonical(href: string) {
  let el = document.querySelector(`link[rel="canonical"]`) as HTMLLinkElement | null;
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", "canonical");
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

function upsertFavicon(href: string) {
  if (!href) return;
  let el = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", "icon");
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

function applyNoIndex(title?: string) {
  if (title) document.title = title;
  upsertMetaByName("robots", "noindex,nofollow");
  // keep description minimal; optional
  upsertMetaByName("description", "");
}

function applySeoFromSettings(settings: WikiSeoSettings | null | undefined, fallbackTitle: string) {
  const s = settings ?? {};
  const title = (s.seoTitle ?? "").trim() || fallbackTitle || "Story Wiki";
  const desc = (s.seoDescription ?? "").trim() || "";
  const allowIndexing = s.allowIndexing !== false; // default true

  document.title = title;

  upsertMetaByName("description", desc);
  upsertMetaByName("robots", allowIndexing ? "index,follow" : "noindex,nofollow");

  // OpenGraph (previews + some crawlers)
  upsertMetaByProperty("og:title", title);
  upsertMetaByProperty("og:description", desc);
  upsertMetaByProperty("og:type", "website");

  const url = window.location.href;
  upsertMetaByProperty("og:url", url);
  upsertCanonical(url);

  const img = (s.seoImageUrl ?? "").trim();
  if (img) {
    upsertMetaByProperty("og:image", img);
    // Use the project's image as the wiki's favicon too.
    upsertFavicon(img);
  }
}

function wantsSignupFromUrl(): boolean {
  const search = window.location.search || "";
  return /[?&]auth=signup\b/.test(search);
}

function getAuthModeFromUrl(): View {
  const hash = window.location.hash || "";
  const search = window.location.search || "";
  if (hash.includes("type=recovery") || search.includes("type=recovery")) return "reset";
  // Deep link from the desktop "Sign up" action.
  if (wantsSignupFromUrl()) return "auth";
  // Default to the app (guests get a silent anonymous session); the sign-in /
  // create-account screen is reached explicitly from inside the app.
  return "app";
}

const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      minHeight: "100vh",
      backgroundColor: "#101010",
      color: "#f5f5f5",
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
    }}
  >
    {children}
  </div>
);

const Card: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      width: 380,
      maxWidth: "100%",
      border: "1px solid #333",
      borderRadius: 10,
      padding: 16,
      backgroundColor: "#181818",
      boxShadow: "0 10px 25px rgba(0,0,0,0.35)",
    }}
  >
    {children}
  </div>
);

const Input: React.FC<
  React.InputHTMLAttributes<HTMLInputElement> & { label: string }
> = ({ label, ...props }) => (
  <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
    <span style={{ fontSize: 12, opacity: 0.8 }}>{label}</span>
    <input
      {...props}
      style={{
        borderRadius: 6,
        border: "1px solid #333",
        backgroundColor: "#101010",
        color: "#f5f5f5",
        padding: "8px 10px",
        fontSize: 14,
        outline: "none",
      }}
    />
  </label>
);

const Button: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }
> = ({ variant = "primary", ...props }) => {
  const style =
    variant === "primary"
      ? { border: "1px solid #4f8cff", backgroundColor: "#1a2738", color: "#f5f5f5" }
      : variant === "danger"
        ? { border: "1px solid #aa4444", backgroundColor: "#201010", color: "#ffb0b0" }
        : { border: "1px solid #444", backgroundColor: "transparent", color: "#ddd" };

  return (
    <button
      {...props}
      style={{
        ...style,
        borderRadius: 6,
        padding: "8px 10px",
        fontSize: 14,
        cursor: props.disabled ? "default" : "pointer",
      }}
    />
  );
};

const AuthScreen: React.FC<{
  // When the user is already a guest (anonymous session), "signing up" upgrades
  // that same account so their work is preserved.
  isUpgrade?: boolean;
  onBack?: () => void; // return to the app (guest keeps working)
  onGuest?: () => void; // start/continue as an anonymous guest
}> = ({ isUpgrade = false, onBack, onGuest }) => {
  const [mode, setMode] = useState<"login" | "signup">(isUpgrade || wantsSignupFromUrl() ? "signup" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // When true, we hide the signup inputs + button and show a "check your email" panel
  const [signupComplete, setSignupComplete] = useState(false);

  // Newsletter opt-in (checked by default — user can untick)
  const [subscribeToUpdates, setSubscribeToUpdates] = useState(true);

  // Password policy (reasonable baseline)
  const validatePassword = (pw: string): string | null => {
    if (pw.length < 12) return "Use at least 12 characters.";
    if (!/[a-z]/.test(pw)) return "Add at least 1 lowercase letter.";
    if (!/[A-Z]/.test(pw)) return "Add at least 1 uppercase letter.";
    if (!/[0-9]/.test(pw)) return "Add at least 1 number.";
    if (!/[^A-Za-z0-9]/.test(pw)) return "Add at least 1 symbol (e.g. !@#$).";
    return null;
  };

  // Live password requirement checks for UI
  const pwRules = useMemo(() => {
    const pw = password;
    return {
      length: pw.length >= 12,
      lower: /[a-z]/.test(pw),
      upper: /[A-Z]/.test(pw),
      number: /[0-9]/.test(pw),
      symbol: /[^A-Za-z0-9]/.test(pw),
    };
  }, [password]);

  const passwordIsValid = pwRules.length && pwRules.lower && pwRules.upper && pwRules.number && pwRules.symbol;
  const passwordsMatch = password.length > 0 && password === confirmPassword;


  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);

    // If they already completed signup, do nothing on submit.
    if (mode === "signup" && signupComplete) return;

    // Front-end validation for signup
    if (mode === "signup") {
      const pwErr = validatePassword(password);
      if (pwErr) {
        setError(pwErr);
        return;
      }
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }
    }

    setLoading(true);

    try {
      if (mode === "signup") {
        if (isUpgrade) {
          // Upgrade the current anonymous (guest) user in place — keeps the same
          // user id, so all of their existing work carries over automatically.
          const { error } = await supabase.auth.updateUser({ email, password });
          if (error) throw error;

          if (subscribeToUpdates) {
            supabase.functions
              .invoke("subscribe-newsletter", { body: { email } })
              .catch(() => {/* non-critical */});
          }

          setSignupComplete(true);
          setPassword("");
          setConfirmPassword("");
          setMessage(`Almost done — we sent a confirmation link to ${email}. Confirm it to finish creating your account. Your work is already saved.`);
        } else {
          const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: window.location.origin },
          });
          if (error) throw error;

          // Fire-and-forget newsletter subscription (opt-in)
          if (subscribeToUpdates) {
            supabase.functions
              .invoke("subscribe-newsletter", { body: { email } })
              .catch(() => {/* silently ignore — non-critical */});
          }

          // Most common case: email confirmation required => no session yet
          if (!data.session) {
            setSignupComplete(true);
            setPassword("");
            setConfirmPassword("");
            setMessage(`Account created. We sent a confirmation email to ${email}. Confirm it, then come back and log in.`);
          } else {
            // If you have email confirmation OFF (or magic), you might get a session
            setSignupComplete(false);
            setMessage("Account created and signed in.");
          }
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const sendReset = async () => {
    setError(null);
    setMessage(null);
    if (!email) {
      setError("Enter your email first, then click the reset link.");
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin,
      });
      if (error) throw error;
      setMessage("Password reset email sent (if the address exists). Check your inbox.");
    } catch (err: any) {
      setError(err?.message ?? "Failed to send reset email");
    } finally {
      setLoading(false);
    }
  };

  const resendConfirmation = async () => {
    setError(null);
    setMessage(null);

    if (!email) {
      setError("Enter your email first.");
      return;
    }

    setLoading(true);
    try {
      const authAny = supabase.auth as any;

      // supabase-js v2 supports auth.resend; if not present, fail gracefully.
      if (typeof authAny.resend !== "function") {
        setMessage("Confirmation email already sent. Please check your inbox/spam.");
        return;
      }

      const { error } = await authAny.resend({ type: "signup", email });
      if (error) throw error;

      setMessage(`Confirmation email re-sent to ${email}. Check your inbox/spam.`);
    } catch (err: any) {
      setError(err?.message ?? "Failed to resend confirmation email");
    } finally {
      setLoading(false);
    }
  };


  return (
    <Shell>
      <Card>
        {!(mode === "signup" && signupComplete) && (
          <>
            <h2 style={{ margin: 0, marginBottom: 6, fontSize: 18 }}>
              {mode === "login" ? "Log in" : isUpgrade ? "Create your account" : "Sign up"}
            </h2>

            {mode === "signup" && !signupComplete && (
              <p style={{ marginTop: 0, opacity: 0.85, lineHeight: 1.4 }}>
                {isUpgrade
                  ? "Free to create an account. Your current work will be saved to it."
                  : "Free to sign up and use. You can upgrade to Pro later if you want."}
              </p>
            )}

            {mode === "login" && isUpgrade && (
              <p style={{ marginTop: 0, opacity: 0.85, lineHeight: 1.4, color: "#ffcf99" }}>
                Heads up: logging into an existing account won't transfer the work you've done as a guest. To keep it, use “Create your account” instead.
              </p>
            )}
          </>
        )}

        {/* If signup completed (email confirmation flow), hide inputs/buttons and show a success panel */}
        {mode === "signup" && signupComplete ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {message && <div style={{ fontSize: 12, color: "#b7d7ff" }}>{message}</div>}
            {!message && (
              <div style={{ fontSize: 12, color: "#b7d7ff" }}>
                Account created. Check your email to confirm your address.
              </div>
            )}

            <Button type="button" disabled={loading} onClick={resendConfirmation}>
              {loading ? "Please wait…" : "Resend confirmation email"}
            </Button>

            {isUpgrade && onBack ? (
              <Button type="button" variant="ghost" disabled={loading} onClick={onBack}>
                Back to app
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                disabled={loading}
                onClick={() => {
                  setMode("login");
                  setSignupComplete(false);
                  setMessage(null);
                  setError(null);
                  setPassword("");
                  setConfirmPassword("");
                }}
              >
                Back to log in
              </Button>
            )}

            {error && <div style={{ fontSize: 12, color: "#ff9090" }}>{error}</div>}
          </div>
        ) : (
          <>
            <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <Input
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />

              <Input
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />

              {mode === "signup" && (
                <>
                  <Input
                    label="Confirm password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                  />

                  <div style={{ fontSize: 12, marginTop: -2, lineHeight: 1.35 }}>
                    <div style={{ opacity: 0.8, marginBottom: 6 }}>Password requirements</div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", gap: 8, color: pwRules.length ? "#9ef0b0" : "#aaa" }}>
                        <span style={{ width: 16, textAlign: "center" }}>{pwRules.length ? "✓" : "•"}</span>
                        <span>At least 12 characters</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, color: pwRules.lower ? "#9ef0b0" : "#aaa" }}>
                        <span style={{ width: 16, textAlign: "center" }}>{pwRules.lower ? "✓" : "•"}</span>
                        <span>1 lowercase letter</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, color: pwRules.upper ? "#9ef0b0" : "#aaa" }}>
                        <span style={{ width: 16, textAlign: "center" }}>{pwRules.upper ? "✓" : "•"}</span>
                        <span>1 uppercase letter</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, color: pwRules.number ? "#9ef0b0" : "#aaa" }}>
                        <span style={{ width: 16, textAlign: "center" }}>{pwRules.number ? "✓" : "•"}</span>
                        <span>1 number</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, color: pwRules.symbol ? "#9ef0b0" : "#aaa" }}>
                        <span style={{ width: 16, textAlign: "center" }}>{pwRules.symbol ? "✓" : "•"}</span>
                        <span>1 symbol (e.g. !@#$)</span>
                      </div>
                    </div>

                    {confirmPassword.length > 0 && !passwordsMatch && (
                      <div style={{ marginTop: 6, color: "#ff9090" }}>Passwords do not match.</div>
                    )}
                  </div>
                </>
              )}

              {mode === "signup" && (
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    cursor: "pointer",
                    marginTop: 2,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={subscribeToUpdates}
                    onChange={(e) => setSubscribeToUpdates(e.target.checked)}
                    style={{
                      marginTop: 2,
                      width: 14,
                      height: 14,
                      flexShrink: 0,
                      accentColor: "#4f8cff",
                      cursor: "pointer",
                    }}
                  />
                  <span style={{ fontSize: 12, color: "#bbb", lineHeight: 1.45 }}>
                    Keep me updated on app improvements and news about{" "}
                    <strong style={{ color: "#ddd" }}>Evenrift</strong> — the game this tool
                    was built for. No spam, unsubscribe any time.
                  </span>
                </label>
              )}

              <Button
                type="submit"
                disabled={loading || (mode === "signup" && (!passwordIsValid || !passwordsMatch))}
              >
                {loading ? "Please wait…" : mode === "login" ? "Log in" : "Create account"}
              </Button>

              {/* Swap: Sign up becomes the button under Log in */}
              {mode === "login" && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={loading}
                  onClick={() => {
                    setMode("signup");
                    setSignupComplete(false);
                    setMessage(null);
                    setError(null);
                    setPassword("");
                    setConfirmPassword("");
                  }}
                >
                  Need an account? Sign up
                </Button>
              )}
            </form>

            {/* Swap: Reset becomes the text link below */}
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.9 }}>
              {mode === "login" ? (
                <button
                  type="button"
                  onClick={sendReset}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "#aaa",
                    cursor: "pointer",
                    textDecoration: "underline",
                    padding: 0,
                    fontSize: 12,
                  }}
                >
                  Forgot your password? Reset it
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setMode("login");
                    setSignupComplete(false);
                    setMessage(null);
                    setError(null);
                    setPassword("");
                    setConfirmPassword("");
                  }}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "#aaa",
                    cursor: "pointer",
                    textDecoration: "underline",
                    padding: 0,
                    fontSize: 12,
                  }}
                >
                  Already have an account? Log in
                </button>
              )}
            </div>

            {message && <div style={{ marginTop: 10, fontSize: 12, color: "#b7d7ff" }}>{message}</div>}
            {error && <div style={{ marginTop: 10, fontSize: 12, color: "#ff9090" }}>{error}</div>}

            {(onBack || onGuest) && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #2a2a2a", display: "flex", flexDirection: "column", gap: 8 }}>
                {onBack && (
                  <Button type="button" variant="ghost" disabled={loading} onClick={onBack}>
                    ← Back to app
                  </Button>
                )}
                {onGuest && (
                  <Button type="button" variant="ghost" disabled={loading} onClick={onGuest}>
                    Continue without an account
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </Card>
    </Shell>
  );
};

const ResetPasswordScreen = () => {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [resetComplete, setResetComplete] = useState(false);

  // Live rules (same standard as signup)
  const pwRules = useMemo(() => {
    const p = pw1 ?? "";
    return {
      len: p.length >= 8,
      lower: /[a-z]/.test(p),
      upper: /[A-Z]/.test(p),
      number: /\d/.test(p),
      symbol: /[^A-Za-z0-9]/.test(p),
    };
  }, [pw1]);

  const passwordIsValid = useMemo(() => Object.values(pwRules).every(Boolean), [pwRules]);
  const passwordsMatch = useMemo(() => (pw1.length > 0 || pw2.length > 0 ? pw1 === pw2 : false), [pw1, pw2]);

  const submitReset = async () => {
    if (resetBusy) return;
    setResetMsg(null);

    if (!passwordIsValid) {
      setResetMsg("Password does not meet the requirements.");
      return;
    }
    if (!passwordsMatch) {
      setResetMsg("Passwords do not match.");
      return;
    }

    setResetBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: pw1 });
      if (error) throw error;

      setResetComplete(true);
      setResetMsg("Password updated. You can now log in.");
      setPw1("");
      setPw2("");
    } catch (e: any) {
      setResetMsg(e?.message ?? "Could not update password.");
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <div style={{ width: "100%", maxWidth: 560, padding: 20 }}>
      <div
        style={{
          width: "100%",
          padding: 22,
          borderRadius: 16,
          border: "1px solid rgba(255,255,255,0.12)",
          background: "rgba(10,10,10,0.65)",
          boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
          backdropFilter: "blur(10px)",
        }}
      >
        <h1 style={{ marginTop: 0, marginBottom: 14, fontSize: 36, fontWeight: 800 }}>Reset password</h1>

        {resetComplete ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {resetMsg && (
              <div style={{ color: "#bfe0ff", fontSize: 18, lineHeight: 1.35 }}>
                {resetMsg}
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                // Return to your normal auth screen (no recovery params)
                window.location.assign("/");
              }}
              style={{
                marginTop: 6,
                width: "100%",
                borderRadius: 12,
                border: "1px solid #444",
                backgroundColor: "transparent",
                color: "#ddd",
                padding: "14px 16px",
                fontSize: 22,
                fontWeight: 650,
                cursor: "pointer",
              }}
            >
              Back to log in
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ opacity: 0.85, fontSize: 18 }}>New password</label>
                <input
                  type="password"
                  value={pw1}
                  onChange={(e) => setPw1(e.target.value)}
                  autoComplete="new-password"
                  style={{
                    borderRadius: 12,
                    border: "1px solid #333",
                    backgroundColor: "#111",
                    color: "#f5f5f5",
                    padding: "14px 14px",
                    fontSize: 18,
                    outline: "none",
                  }}
                />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ opacity: 0.85, fontSize: 18 }}>Confirm new password</label>
                <input
                  type="password"
                  value={pw2}
                  onChange={(e) => setPw2(e.target.value)}
                  autoComplete="new-password"
                  style={{
                    borderRadius: 12,
                    border: "1px solid #333",
                    backgroundColor: "#111",
                    color: "#f5f5f5",
                    padding: "14px 14px",
                    fontSize: 18,
                    outline: "none",
                  }}
                />
              </div>

              {/* Live requirements */}
              <div style={{ marginTop: 2, fontSize: 14, opacity: 0.95, lineHeight: 1.4 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Password requirements</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ color: pwRules.len ? "#7CFFB2" : "#ff7a7a" }}>• At least 8 characters</div>
                  <div style={{ color: pwRules.lower ? "#7CFFB2" : "#ff7a7a" }}>• At least 1 lowercase letter</div>
                  <div style={{ color: pwRules.upper ? "#7CFFB2" : "#ff7a7a" }}>• At least 1 uppercase letter</div>
                  <div style={{ color: pwRules.number ? "#7CFFB2" : "#ff7a7a" }}>• At least 1 number</div>
                  <div style={{ color: pwRules.symbol ? "#7CFFB2" : "#ff7a7a" }}>• At least 1 symbol</div>
                  {pw2.length > 0 && (
                    <div style={{ color: passwordsMatch ? "#7CFFB2" : "#ff7a7a" }}>
                      • Passwords match
                    </div>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={submitReset}
                disabled={resetBusy || !passwordIsValid || !passwordsMatch}
                style={{
                  marginTop: 8,
                  width: "100%",
                  borderRadius: 12,
                  border: "1px solid #4f8cff",
                  backgroundColor: "#1a2738",
                  color: "#f5f5f5",
                  padding: "14px 16px",
                  fontSize: 22,
                  fontWeight: 650,
                  cursor: resetBusy || !passwordIsValid || !passwordsMatch ? "default" : "pointer",
                  opacity: resetBusy || !passwordIsValid || !passwordsMatch ? 0.6 : 1,
                }}
              >
                {resetBusy ? "Updating…" : "Update password"}
              </button>

              {resetMsg && (
                <div style={{ marginTop: 6, color: "#ff7a7a", fontSize: 18, lineHeight: 1.35 }}>
                  {resetMsg}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};


export const AuthGate: React.FC = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const initialView = useMemo(() => getAuthModeFromUrl(), []);
  const [view, setView] = useState<View>(initialView);

  // Any non-root path is treated as a public wiki slug: /[slug]/(page|collection)/...
  const isWikiRoute = useMemo(() => {
    const p = window.location.pathname || "/";
    return p !== "/" && p !== "/index.html";
  }, []);

  // ✅ Default: don't index the private app routes (auth/app UI)
  useEffect(() => {
    if (!isWikiRoute) applyNoIndex("RPG Story Toolkit");
  }, [isWikiRoute]);

  const PublicWiki: React.FC = () => {
    type Route =
      | { slug: string; kind: "home" }
      | { slug: string; kind: "page"; id: string }
      | { slug: string; kind: "collection"; id: string }
      | { slug: string; kind: "map" };

    const parseRoute = (): Route => {
      const segs = (window.location.pathname || "/").split("/").filter(Boolean);
      const slug = segs[0] ?? "";
      const rest = segs.slice(1);

      if (rest[0] === "page" && rest[1]) return { slug, kind: "page", id: rest[1] };
      if (rest[0] === "collection" && rest[1]) return { slug, kind: "collection", id: rest[1] };
      if (rest[0] === "map") return { slug, kind: "map" };
      return { slug, kind: "home" };
    };

    const [route, setRoute] = useState<Route>(() => parseRoute());
    const [wikiLoading, setWikiLoading] = useState(true);
    const [wikiErr, setWikiErr] = useState<string | null>(null);
    const [wikiRow, setWikiRow] = useState<any>(null);

    // Linked text tooltip
    const [hoverLink, setHoverLink] = useState<any | null>(null);
    const [hoverRect, setHoverRect] = useState<{ left: number; bottom: number } | null>(null);
    const [tooltipPinned, setTooltipPinned] = useState(false);
    const [coverUrlByPath, setCoverUrlByPath] = useState<Record<string, string>>({});
    const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
    const closeTimerRef = useRef<number | null>(null);

    useEffect(() => {
      const onPop = () => setRoute(parseRoute());
      window.addEventListener("popstate", onPop);
      return () => window.removeEventListener("popstate", onPop);
    }, []);

    // The public wiki follows the viewer's browser theme preference (not the
    // author's saved themeMode), and updates live if they switch it.
    useEffect(() => {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const apply = (dark: boolean) =>
        document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
      apply(mq.matches);
      const handler = (e: MediaQueryListEvent) => apply(e.matches);
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }, []);

    useEffect(() => {
      const close = (e?: Event) => {
        if (!tooltipPinned) return;
        const t = (e?.target as HTMLElement | null) ?? null;
        const insideTooltip = t?.closest?.('[data-wiki-tooltip="1"]');
        const insideLink = t?.closest?.('[data-wiki-link="1"]');
        if (insideTooltip || insideLink) return;

        setTooltipPinned(false);
        setHoverLink(null);
        setHoverRect(null);
      };

      window.addEventListener("mousedown", close);
      window.addEventListener("scroll", close, true);
      return () => {
        window.removeEventListener("mousedown", close);
        window.removeEventListener("scroll", close, true);
      };
    }, [tooltipPinned]);

    useEffect(() => {
      if (!route.slug) {
        setWikiErr("Missing wiki slug.");
        setWikiLoading(false);
        applyNoIndex("Unavailable");
        return;
      }

      let cancelled = false;
      setWikiLoading(true);
      setWikiErr(null);

      (async () => {
        const { data, error } = await supabase
          .from("public_wikis")
          .select("slug, snapshot, settings")
          .eq("slug", route.slug)
          .eq("published", true)
          .single();

        if (cancelled) return;

        if (error || !data) {
          setWikiRow(null);
          setWikiErr("Wiki not found or unpublished.");
          setWikiLoading(false);
          applyNoIndex("Unavailable");
          return;
        }

        setWikiRow(data as any);
        setWikiLoading(false);

        // ✅ Apply SEO + indexing based on saved settings
        const snapshot = (data as any).snapshot ?? {};
        const settings = (data as any).settings ?? {};
        const fallbackTitle = String(snapshot.name ?? route.slug ?? "Story Wiki");
        applySeoFromSettings(settings as WikiSeoSettings, fallbackTitle);
      })();

      return () => {
        cancelled = true;
      };
    }, [route.slug]);

    // Preload the focused collection record's cover image (signed URL) so the
    // details pane can show it. Runs whenever the route/selection changes.
    useEffect(() => {
      if (route.kind !== "collection") return;
      const snap = (wikiRow as any)?.snapshot ?? {};
      const col = (snap.collections ?? []).find((c: any) => String(c.id) === String((route as any).id));
      if (!col) return;
      const rows: any[] = col.rows ?? [];
      const entityId = new URLSearchParams(window.location.search || "").get("entity") ?? "";
      const selected = rows.find((r: any) => String(r.id) === entityId) ?? rows[0] ?? null;
      const path = String(selected?.cover?.path ?? "");
      if (!path) return;

      let cancelled = false;
      (async () => {
        try {
          const { data, error } = await supabase.storage.from("assets").createSignedUrl(path, 60 * 60);
          let url = !error ? data?.signedUrl : undefined;
          if (!url) {
            const pub = supabase.storage.from("assets").getPublicUrl(path) as any;
            url = pub?.data?.publicUrl as string | undefined;
          }
          if (url && !cancelled) setCoverUrlByPath((prev) => (prev[path] ? prev : { ...prev, [path]: url! }));
        } catch {
          /* ignore */
        }
      })();
      return () => { cancelled = true; };
    }, [route, wikiRow]);

    const goto = (path: string) => {
      window.history.pushState({}, "", path);
      setRoute(parseRoute());
    };

    if (wikiLoading) {
      return (
        <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", display: "grid", placeItems: "center" }}>
          Loading wiki…
        </div>
      );
    }

    if (wikiErr || !wikiRow) {
      return (
        <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", display: "grid", placeItems: "center", padding: 16 }}>
          <div style={{ maxWidth: 640 }}>
            <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 6 }}>Unavailable</div>
            <div style={{ opacity: 0.8 }}>{wikiErr ?? "Wiki not found."}</div>
          </div>
        </div>
      );
    }

    const snapshot = (wikiRow as any).snapshot ?? {};
    const settings = (wikiRow as any).settings ?? {};
    const docs: any[] = snapshot.documents ?? [];
    const cols: any[] = snapshot.collections ?? [];

    const homeDocId = typeof settings.homeDocumentId === "string" ? settings.homeDocumentId : (docs[0]?.id ?? "");
    const activeDocId = route.kind === "page" ? (route as any).id : homeDocId;

    const activeDoc = docs.find((d) => d.id === activeDocId) ?? docs[0] ?? null;
    const activeCol = route.kind === "collection" ? cols.find((c) => c.id === (route as any).id) : null;

    const selectedEntityId = new URLSearchParams(window.location.search || "").get("entity") ?? "";

    const getEntityForLink = (link: any) => {
      const collectionId = String(link?.collectionId ?? "");
      const entityId = String(link?.entityId ?? "");
      if (!collectionId || !entityId) return null;

      const collection = cols.find((c) => String(c.id) === collectionId) ?? null;
      const row = (collection?.rows ?? []).find((r: any) => String(r.id) === entityId) ?? null;
      if (collection && row) return { collection, row, published: true };

      // Fall back to the lightweight linkedEntities lookup so links still work even when
      // the record's table isn't published as its own page.
      const le = (snapshot.linkedEntities ?? {})[`${collectionId}:${entityId}`];
      if (le) {
        return {
          collection: { id: collectionId, name: le.collectionName, color: le.color, schema: le.schema },
          row: { id: entityId, values: le.values, cover: le.cover },
          published: !!le.published,
        };
      }
      return null;
    };

    const ensureCoverUrl = async (path: string) => {
      if (!path) return;
      if (coverUrlByPath[path]) return;

      try {
        const { data, error } = await supabase.storage.from("assets").createSignedUrl(path, 60 * 60);
        if (!error && data?.signedUrl) {
          setCoverUrlByPath((prev) => ({ ...prev, [path]: data.signedUrl }));
          return;
        }
      } catch {
        // ignore
      }

      try {
        const pub = supabase.storage.from("assets").getPublicUrl(path) as any;
        const url = pub?.data?.publicUrl as string | undefined;
        if (url) {
          setCoverUrlByPath((prev) => ({ ...prev, [path]: url }));
        }
      } catch {
        // ignore
      }
    };

    const hasFormat = (node: any, flag: number, name: string) => {
      const f = node?.format;

      if (typeof f === "number") return (f & flag) !== 0;
      if (typeof f === "string") {
        const parts = f.split(/\s+/).map((x: string) => x.trim().toLowerCase());
        return parts.includes(name);
      }

      return node?.[name] === true;
    };

    const renderDocWithLinks = (doc: any) => {
      const richJson = String(doc?.richContent ?? "").trim();
      const plainContent = String(doc?.content ?? "");
      const links: any[] = Array.isArray(doc?.entityLinks) ? [...doc.entityLinks] : [];
      links.sort((a, b) => Number(a?.start ?? 0) - Number(b?.start ?? 0));

      // `text` is a single text node; `baseOffset` is its global offset into the
      // document's plain content. Link start/end are global offsets, so we map
      // them into this node's local coordinates (and clamp to it). Without this,
      // any link outside the first text node would be skipped.
      const renderLinkedText = (text: string, keyPrefix: string, baseOffset = 0) => {
        if (!text) return null;

        const out: React.ReactNode[] = [];
        let cursor = 0; // local cursor within `text`
        const nodeEndGlobal = baseOffset + text.length;

        for (const l of links) {
          const startG = Number(l?.start ?? 0);
          const endG = Number(l?.end ?? 0);
          if (!Number.isFinite(startG) || !Number.isFinite(endG)) continue;
          if (endG <= startG) continue;
          if (startG < 0 || endG > plainContent.length) continue;
          // Skip links that don't intersect this text node.
          if (endG <= baseOffset || startG >= nodeEndGlobal) continue;

          const start = Math.max(0, startG - baseOffset);
          const sliceEnd = Math.min(text.length, endG - baseOffset);
          if (start < cursor) continue;
          if (sliceEnd <= start) continue;

          if (start > cursor) {
            out.push(text.slice(cursor, start));
          }

          {
            const entity = getEntityForLink(l);
            const linkedText = text.slice(start, sliceEnd);

            // Only show a link when its record's table is published in the wiki.
            // Otherwise render the text plainly (no link, no preview).
            if (!entity || !(entity as any).published) {
              out.push(linkedText);
              cursor = Math.max(cursor, sliceEnd);
              continue;
            }

            const linkColor = String(entity?.collection?.color ?? "var(--accent)");

            out.push(
              <span
                key={`${keyPrefix}-${String(l.id ?? `${startG}-${endG}`)}`}
                data-wiki-link="1"
                onMouseEnter={async (e) => {
                  if (closeTimerRef.current != null) {
                    window.clearTimeout(closeTimerRef.current);
                    closeTimerRef.current = null;
                  }

                  setHoverLink(l);
                  const rect = (e.currentTarget as HTMLSpanElement).getBoundingClientRect();
                  setHoverRect({ left: rect.left, bottom: rect.bottom });

                  const coverPath = String(entity?.row?.cover?.path ?? "");
                  if (coverPath) await ensureCoverUrl(coverPath);
                }}
                onMouseLeave={() => {
                  if (tooltipPinned) return;
                  if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
                  closeTimerRef.current = window.setTimeout(() => {
                    setHoverLink(null);
                    setHoverRect(null);
                  }, 120);
                }}
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setTooltipPinned(true);
                  setHoverLink(l);
                  const rect = (e.currentTarget as HTMLSpanElement).getBoundingClientRect();
                  setHoverRect({ left: rect.left, bottom: rect.bottom });

                  const coverPath = String(entity?.row?.cover?.path ?? "");
                  if (coverPath) await ensureCoverUrl(coverPath);
                }}
                style={{
                  color: linkColor,
                  textDecoration: "underline",
                  textDecorationColor: linkColor,
                  textUnderlineOffset: 2,
                  cursor: "pointer",
                }}
                title="Click to pin"
              >
                {linkedText}
              </span>
            );
          }

          cursor = Math.max(cursor, sliceEnd);
        }

        if (cursor < text.length) out.push(text.slice(cursor));
        return out;
      };

      if (!richJson) {
        return renderLinkedText(plainContent, "plain");
      }

      let parsed: any;
      try {
        parsed = JSON.parse(richJson);
      } catch {
        return renderLinkedText(plainContent, "plain");
      }

      const root = parsed?.root;
      const blocks: any[] = Array.isArray(root?.children) ? root.children : [];
      let globalOffset = 0;

      const renderInlineNode = (node: any, key: string): React.ReactNode => {
        const t = String(node?.type ?? "");

        if (t === "text") {
          // Keep the text exactly as stored (incl. any zero-width spaces) so the
          // offsets here match doc.content, which is built the same way. Stripping
          // them would shift every following link right by one (dropping a char).
          const rawText = String(node?.text ?? "");
          const start = globalOffset;
          const end = start + rawText.length;
          globalOffset = end;

          let content: React.ReactNode = <>{renderLinkedText(rawText, key, start)}</>;

          if (hasFormat(node, 1, "bold")) content = <strong>{content}</strong>;
          if (hasFormat(node, 2, "italic")) content = <em>{content}</em>;

          return <React.Fragment key={key}>{content}</React.Fragment>;
        }

        if (t === "linebreak") {
          globalOffset += 1;
          return <br key={key} />;
        }

        const children: any[] = Array.isArray(node?.children) ? node.children : [];
        return <React.Fragment key={key}>{children.map((child, i) => renderInlineNode(child, `${key}-${i}`))}</React.Fragment>;
      };

      const renderBlockNode = (node: any, index: number): React.ReactNode => {
        const t = String(node?.type ?? "");
        const children: any[] = Array.isArray(node?.children) ? node.children : [];

        if (t === "heading") {
          const tag = String(node?.tag ?? "h1").toLowerCase();
          const content = children.map((child, i) => renderInlineNode(child, `b${index}-h-${i}`));

          if (tag === "h1") {
            return (
              <h1 key={`block-${index}`} style={{ fontSize: 30, lineHeight: 1.2, fontWeight: 900, margin: "0 0 16px" }}>
                {content}
              </h1>
            );
          }

          if (tag === "h2") {
            return (
              <h2 key={`block-${index}`} style={{ fontSize: 24, lineHeight: 1.25, fontWeight: 800, margin: "6px 0 14px" }}>
                {content}
              </h2>
            );
          }

          return (
            <h3 key={`block-${index}`} style={{ fontSize: 19, lineHeight: 1.3, fontWeight: 800, margin: "6px 0 12px" }}>
              {content}
            </h3>
          );
        }

        if (t === "list") {
          const ListTag = node?.listType === "number" ? "ol" : "ul";
          return (
            <ListTag key={`block-${index}`} style={{ margin: "0 0 16px 22px", lineHeight: 1.65 }}>
              {children.map((child, i) => (
                <li key={`li-${index}-${i}`} style={{ marginBottom: 6 }}>
                  {Array.isArray(child?.children)
                    ? child.children.map((grand: any, j: number) => renderInlineNode(grand, `b${index}-li-${i}-${j}`))
                    : null}
                </li>
              ))}
            </ListTag>
          );
        }

        return (
          <p key={`block-${index}`} style={{ margin: "0 0 16px", lineHeight: 1.65, fontSize: 15 }}>
            {children.map((child, i) => renderInlineNode(child, `b${index}-p-${i}`))}
          </p>
        );
      };

      const rendered = blocks.map((block, index) => {
        const node = renderBlockNode(block, index);

        if (index < blocks.length - 1) {
          globalOffset += 2;
        }

        return node;
      });

      return rendered;
    };

    const hoverEntity = hoverLink ? getEntityForLink(hoverLink) : null;
    const hoverCoverPath = String(hoverEntity?.row?.cover?.path ?? "");
    const hoverCoverUrl = hoverCoverPath ? coverUrlByPath[hoverCoverPath] : "";

    const tooltipBox = (() => {
      if (!hoverRect) return null;
      const width = 360;
      const pad = 12;
      const left = Math.min(window.innerWidth - width - pad, Math.max(pad, hoverRect.left));
      const top = Math.min(window.innerHeight - pad, hoverRect.bottom + 10);
      return { left, top, width };
    })();

    const sectionLabelStyle: React.CSSProperties = {
      fontSize: 11,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.06em",
      color: "var(--text-dim)",
      padding: "0 8px",
      marginBottom: 6,
    };

    // Read-only folder tree for the sidebar (groups items by their folderPath).
    const renderItemTree = (
      items: any[],
      getPath: (it: any) => string[],
      getLabel: (it: any) => string,
      getId: (it: any) => string,
      onItemClick: (id: string) => void,
      activeId: string,
      keyPrefix: string
    ): React.ReactNode => {
      type TNode = { folders: Map<string, TNode>; items: { id: string; label: string }[] };
      const root: TNode = { folders: new Map(), items: [] };
      for (const it of items) {
        const path = getPath(it) ?? [];
        let node = root;
        for (const seg of path) {
          const key = String(seg);
          if (!node.folders.has(key)) node.folders.set(key, { folders: new Map(), items: [] });
          node = node.folders.get(key)!;
        }
        node.items.push({ id: getId(it), label: getLabel(it) });
      }

      const rowStyle = (active: boolean, depth: number, leaf: boolean): React.CSSProperties => ({
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        textAlign: "left",
        border: "none",
        borderRadius: 6,
        background: active ? "var(--bg-row-sel)" : "transparent",
        color: active ? "var(--text)" : "var(--text-2)",
        cursor: "pointer",
        padding: "6px 8px",
        paddingLeft: 8 + depth * 12 + (leaf ? 14 : 0),
        fontSize: 13,
        fontWeight: leaf ? 500 : 600,
      });

      const renderNode = (node: TNode, depth: number, pathKey: string): React.ReactNode => (
        <>
          {[...node.folders.entries()].map(([name, child]) => {
            const fkey = pathKey + "/" + name;
            const collapsed = collapsedFolders[fkey] ?? false;
            return (
              <div key={"f:" + fkey}>
                <button
                  type="button"
                  className="wikiRow"
                  style={rowStyle(false, depth, false)}
                  onClick={() => setCollapsedFolders((p) => ({ ...p, [fkey]: !collapsed }))}
                >
                  <span style={{ fontSize: 10, opacity: 0.7, width: 10, flexShrink: 0 }}>{collapsed ? "▸" : "▾"}</span>
                  <span style={{ opacity: 0.85 }}>📁</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                </button>
                {!collapsed && renderNode(child, depth + 1, fkey)}
              </div>
            );
          })}
          {node.items.map((it) => (
            <button
              key={keyPrefix + it.id}
              type="button"
              className="wikiRow"
              style={rowStyle(it.id === activeId, depth, true)}
              onClick={() => onItemClick(it.id)}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.label || it.id}</span>
            </button>
          ))}
        </>
      );

      return renderNode(root, 0, keyPrefix);
    };

    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 20,
            background: "var(--bg-panel)",
            borderBottom: "1px solid var(--border-2)",
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ fontWeight: 800, fontSize: 15 }}>{String(snapshot.name ?? route.slug)}</div>
          <button
            type="button"
            onClick={() => goto(`/${route.slug}`)}
            style={{ borderRadius: 8, border: "1px solid var(--border-3)", background: "transparent", color: "var(--text-2)", padding: "6px 12px", cursor: "pointer", fontSize: 13 }}
          >
            Home
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "264px 1fr", height: "calc(100vh - 49px)" }}>
          <div style={{ borderRight: "1px solid var(--border-2)", background: "var(--bg-panel)", padding: 10, overflowY: "auto" }}>
            {docs.length > 0 && (
              <>
                <div style={sectionLabelStyle}>Documents</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 14 }}>
                  {renderItemTree(docs, (d) => d.folderPath ?? [], (d) => d.title || d.id, (d) => String(d.id), (id) => goto(`/${route.slug}/page/${id}`), (route.kind === "page" || route.kind === "home") ? activeDocId : "", "doc:")}
                </div>
              </>
            )}

            {cols.length > 0 && (
              <>
                <div style={sectionLabelStyle}>Database</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {renderItemTree(cols, (c) => c.folderPath ?? [], (c) => c.name || c.id, (c) => String(c.id), (id) => goto(`/${route.slug}/collection/${id}`), route.kind === "collection" ? String((route as any).id) : "", "col:")}
                </div>
              </>
            )}

            {snapshot.worldMap?.imagePath && (
              <>
                <div style={{ ...sectionLabelStyle, marginTop: 14 }}>World Map</div>
                <button
                  type="button"
                  onClick={() => goto(`/${route.slug}/map`)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    borderRadius: 6,
                    border: "none",
                    background: route.kind === "map" ? "var(--bg-row-sel)" : "transparent",
                    color: route.kind === "map" ? "var(--text)" : "var(--text-2)",
                    padding: "6px 8px",
                    paddingLeft: 22,
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  {snapshot.worldMap.name || "World Map"}
                </button>
              </>
            )}
          </div>

          <div style={{ overflowY: "auto", padding: "22px 28px" }}>
            <div style={{ maxWidth: route.kind === "collection" ? 1100 : 820, margin: "0 auto" }}>
            {route.kind === "map" && snapshot.worldMap ? (
              <WorldMapWiki
                worldMap={snapshot.worldMap}
                docs={docs}
                cols={cols}
                slug={route.slug}
                goto={goto}
              />
            ) : route.kind === "collection" && activeCol ? (
              (() => {
                const rows: any[] = activeCol.rows ?? [];
                const selected =
                  rows.find((r: any) => String(r.id) === selectedEntityId) ?? rows[0] ?? null;
                const fields: { label: string; value: string }[] = [];
                if (selected) {
                  const schema = Array.isArray(activeCol?.schema) ? activeCol.schema : null;
                  if (schema) {
                    for (const f of schema) {
                      const key = String(f?.id ?? "");
                      if (key === "id" || key === "name") continue; // id hidden, name shown as title
                      const v = selected?.values?.[key];
                      if (v == null || v === "") continue;
                      fields.push({ label: String(f?.label ?? key), value: String(v) });
                    }
                  } else if (selected?.values && typeof selected.values === "object") {
                    for (const [k, v] of Object.entries(selected.values)) {
                      if (k === "id" || k === "name") continue;
                      if (v == null || v === "") continue;
                      fields.push({ label: String(k).replace(/_/g, " "), value: String(v) });
                    }
                  }
                }

                return (
                  <div style={{ display: "flex", gap: 22, alignItems: "flex-start" }}>
                    {/* Record list (sub-sidebar) */}
                    <div style={{ width: 220, flexShrink: 0 }}>
                      <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 10 }}>{activeCol.name || activeCol.id}</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        {rows.length === 0 && (
                          <div style={{ fontSize: 12, opacity: 0.6, padding: "6px 8px" }}>No records.</div>
                        )}
                        {rows.map((r: any) => {
                          const isSel = !!selected && String(r.id) === String(selected.id);
                          return (
                            <button
                              key={r.id}
                              type="button"
                              onClick={() =>
                                goto(`/${route.slug}/collection/${activeCol.id}?entity=${encodeURIComponent(String(r.id))}`)
                              }
                              style={{
                                textAlign: "left",
                                border: "none",
                                borderRadius: 6,
                                background: isSel ? "var(--bg-row-sel)" : "transparent",
                                color: isSel ? "var(--text)" : "var(--text-2)",
                                padding: "7px 10px",
                                cursor: "pointer",
                                fontSize: 13,
                                fontWeight: isSel ? 700 : 500,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {String(r?.values?.name ?? r.id)}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Focused record details */}
                    <div style={{ flex: 1, minWidth: 0 }} data-wiki-entity={selected?.id}>
                      {selected ? (
                        <>
                          {selected?.cover?.path && coverUrlByPath[String(selected.cover.path)] ? (
                            <img
                              src={coverUrlByPath[String(selected.cover.path)]}
                              alt=""
                              style={{ width: "100%", maxHeight: 320, objectFit: "cover", borderRadius: 12, marginBottom: 14, border: "1px solid var(--border-2)" }}
                            />
                          ) : null}
                          <div style={{ fontWeight: 900, fontSize: 22, marginBottom: 2 }}>
                            {String(selected?.values?.name ?? selected.id)}
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 16 }}>{activeCol.name || activeCol.id}</div>
                          {fields.length === 0 ? (
                            <div style={{ fontSize: 13, opacity: 0.6 }}>No additional details.</div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                              {fields.map((f) => (
                                <div key={f.label}>
                                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)", marginBottom: 3 }}>
                                    {f.label}
                                  </div>
                                  <div style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{f.value}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      ) : (
                        <div style={{ fontSize: 13, opacity: 0.6 }}>Select a record to see its details.</div>
                      )}
                    </div>
                  </div>
                );
              })()
            ) : (
              <div>
                <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>{activeDoc?.title ?? "Home"}</div>
                <div>
                  {renderDocWithLinks(activeDoc)}
                </div>

                {hoverEntity && tooltipBox ? (
                  <div
                    data-wiki-tooltip="1"
                    onMouseEnter={() => {
                      if (closeTimerRef.current != null) {
                        window.clearTimeout(closeTimerRef.current);
                        closeTimerRef.current = null;
                      }
                    }}
                    onMouseLeave={() => {
                      if (tooltipPinned) return;
                      if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
                      closeTimerRef.current = window.setTimeout(() => {
                        setHoverLink(null);
                        setHoverRect(null);
                      }, 120);
                    }}
                    style={{
                      position: "fixed",
                      left: tooltipBox.left,
                      top: tooltipBox.top,
                      width: tooltipBox.width,
                      background: "var(--bg-elevated)",
                      color: "var(--text)",
                      border: "1px solid var(--border-2)",
                      borderRadius: 12,
                      padding: 14,
                      zIndex: 999,
                      boxShadow: "0 12px 40px var(--overlay-3, rgba(0,0,0,0.55))",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 900, fontSize: 13, marginBottom: 4 }}>
                          {String(
                            hoverEntity?.row?.values?.name ??
                            hoverEntity?.row?.values?.title ??
                            hoverEntity?.row?.values?.Name ??
                            hoverEntity?.row?.id ??
                            "Entity"
                          )}
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>{String(hoverEntity?.collection?.name ?? "")}</div>
                      </div>

                      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                        <button
                          type="button"
                          onClick={() => {
                            setTooltipPinned(false);
                            setHoverLink(null);
                            setHoverRect(null);
                          }}
                          style={{
                            borderRadius: 8,
                            border: "1px solid var(--border-3)",
                            background: "transparent",
                            color: "var(--text-2)",
                            padding: "5px 8px",
                            cursor: "pointer",
                            fontSize: 12,
                          }}
                        >
                          Close
                        </button>
                      </div>
                    </div>

                    {hoverCoverUrl ? (
                      <img
                        src={hoverCoverUrl}
                        alt=""
                        style={{ width: "100%", maxHeight: 160, objectFit: "cover", borderRadius: 10, marginBottom: 10, border: "1px solid var(--border-2)" }}
                      />
                    ) : null}

                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {Array.isArray(hoverEntity?.collection?.schema)
                        ? hoverEntity.collection.schema
                          .filter((f: any) => String(f?.id ?? "") !== "id")
                          .map((f: any) => {
                            const key = String(f?.id ?? "");
                            const label = String(f?.label ?? key);
                            const v = hoverEntity?.row?.values?.[key];
                            if (v == null || v === "") return null;
                            return (
                              <div key={key} style={{ fontSize: 12, lineHeight: 1.35 }}>
                                <span style={{ opacity: 0.7 }}>{label}:</span>{" "}
                                <span style={{ opacity: 0.95 }}>{String(v)}</span>
                              </div>
                            );
                          })
                        : hoverEntity?.row?.values && typeof hoverEntity.row.values === "object"
                          ? Object.entries(hoverEntity.row.values)
                            .filter(([k]) => k !== "id")
                            .map(([k, v]) => (
                              <div key={k} style={{ fontSize: 12, lineHeight: 1.35 }}>
                                <span style={{ opacity: 0.7 }}>{String(k).replace(/_/g, " ")}:</span>{" "}
                                <span style={{ opacity: 0.95 }}>{String(v)}</span>
                              </div>
                            ))
                          : null}
                    </div>

                    {(hoverEntity as any)?.published && (
                      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <button
                          type="button"
                          onClick={() => {
                            const cid = String(hoverEntity?.collection?.id ?? "");
                            const eid = String(hoverEntity?.row?.id ?? "");
                            if (!cid) return;
                            goto(`/${route.slug}/collection/${cid}${eid ? `?entity=${encodeURIComponent(eid)}` : ""}`);
                            setTooltipPinned(false);
                            setHoverLink(null);
                            setHoverRect(null);
                          }}
                          style={{
                            borderRadius: 10,
                            border: "1px solid var(--accent)",
                            background: "var(--accent)",
                            color: "#fff",
                            padding: "8px 12px",
                            cursor: "pointer",
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          View record
                        </button>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Start (or continue) an anonymous guest session so people can use the app
  // without signing up. No-op if anonymous sign-ins aren't enabled server-side.
  const signInAsGuest = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      setSession(data.session ?? null);
      setView("app");
    } catch {
      // Anonymous sign-ins disabled/unavailable — fall back to the auth screen.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      let s = data.session ?? null;

      // No session and not on a public route → silently sign in as a guest.
      // Desktop is local-first and offline-capable, so it never auto-signs-in;
      // it manages an optional web account itself (for sync).
      const isDesktopEnv = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (!s && !isWikiRoute && !isDesktopEnv && getAuthModeFromUrl() === "app") {
        try {
          const { data: anon, error } = await supabase.auth.signInAnonymously();
          if (error) throw error;
          s = anon.session ?? null;
        } catch {
          // Anonymous sign-ins not enabled — user will see the auth screen.
        }
      }
      if (!mounted) return;
      setSession(s);
      setLoading(false);
    };

    init();

    const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      if (event === "PASSWORD_RECOVERY") setView("reset");
      if (event === "SIGNED_OUT") setView("auth");
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const isGuest = !!(session?.user as any)?.is_anonymous;

  if (view === "reset") return <ResetPasswordScreen />;

  // ✅ Public wiki bypasses auth
  if (isWikiRoute) return <PublicWiki />;

  if (loading) {
    // Reuses the inline splash styles from index.html (global), so it matches the
    // pre-mount splash exactly and is themed for both light and dark mode.
    return (
      <div className="app-splash">
        <img className="app-splash-logo" src="/rpgst_logo.png" alt="" />
        <div className="app-splash-name">RPG Story Toolkit</div>
        <div className="app-splash-bar" />
      </div>
    );
  }

  // Desktop is local-first: never gate behind the web auth screen. The app
  // manages an optional web account internally (for sync).
  const isDesktopEnv = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (isDesktopEnv) return <App />;

  // No session at all (guest sign-in disabled or the user logged out): show the
  // auth screen, with the option to continue as a guest.
  if (!session) return <AuthScreen onGuest={signInAsGuest} />;

  // Guest explicitly chose to create an account / sign in.
  if (view === "auth" && isGuest) {
    return <AuthScreen isUpgrade onBack={() => setView("app")} />;
  }

  return <App isGuest={isGuest} onRequestSignup={() => setView("auth")} />;
};
