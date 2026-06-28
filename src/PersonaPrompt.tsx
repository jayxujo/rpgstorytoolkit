import React from "react";
import { useLang } from "./i18n";
import { PERSONAS, setPersona, type PersonaId } from "./persona";

// Reusable grid of selectable persona cards (controlled).
export const PersonaPicker: React.FC<{
  value: PersonaId | null;
  onChange: (id: PersonaId) => void;
  columns?: number;
}> = ({ value, onChange, columns = 2 }) => {
  const { t } = useLang();
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 10 }}>
      {PERSONAS.map((p) => {
        const sel = value === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              textAlign: "left",
              border: sel ? "2px solid var(--accent)" : "1px solid var(--border-2)",
              background: sel ? "var(--bg-row-sel)" : "var(--bg-surface)",
              color: "var(--text)",
              borderRadius: 12,
              padding: "12px 14px",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }} aria-hidden>{p.emoji}</span>
            <span>{t("persona." + p.id)}</span>
          </button>
        );
      })}
    </div>
  );
};

// First-run overlay asking the user what they build. Returns the chosen persona id
// (or null when skipped) via onDone.
export const PersonaPrompt: React.FC<{ onDone: (id: PersonaId | null) => void }> = ({ onDone }) => {
  const { t } = useLang();
  const [sel, setSel] = React.useState<PersonaId | null>(null);

  const commit = () => {
    if (!sel) return;
    setPersona(sel);
    onDone(sel);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 4000,
        background: "var(--overlay-3, rgba(0,0,0,0.6))",
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 560,
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-2)",
          borderRadius: 16,
          padding: 24,
          boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 6, color: "var(--text)" }}>{t("persona.title")}</div>
        <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 18, color: "var(--text)" }}>{t("persona.subtitle")}</div>

        <PersonaPicker value={sel} onChange={setSel} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 20 }}>
          <button
            type="button"
            onClick={() => onDone(null)}
            style={{ border: "none", background: "transparent", color: "var(--text-dim)", cursor: "pointer", fontSize: 13 }}
          >
            {t("common.skip")}
          </button>
          <button
            type="button"
            onClick={commit}
            disabled={!sel}
            style={{
              borderRadius: 8,
              border: "none",
              background: sel ? "var(--accent)" : "var(--bg-hover)",
              color: sel ? "#fff" : "var(--text-dim)",
              cursor: sel ? "pointer" : "not-allowed",
              padding: "10px 22px",
              fontSize: 14,
              fontWeight: 700,
            }}
          >
            {t("common.continue")}
          </button>
        </div>
      </div>
    </div>
  );
};
