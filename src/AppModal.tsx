import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

type AlertOptions = {
  title?: string;
  okText?: string;
};

type ConfirmOptions = {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};

type PromptOptions = {
  title?: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
};

type SelectOption = {
  value: string;
  label: string;
};

type SelectOptions = {
  title?: string;
  message?: string;
  options: SelectOption[];
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
};

type ModalState =
  | {
    kind: "alert";
    title: string;
    message: string;
    okText: string;
    resolve: () => void;
  }
  | {
    kind: "confirm";
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    danger: boolean;
    resolve: (v: boolean) => void;
  }
  | {
    kind: "prompt";
    title: string;
    message?: string;
    confirmText: string;
    cancelText: string;
    value: string;
    placeholder?: string;
    resolve: (v: string | null) => void;
  }
  | {
    kind: "select";
    title: string;
    message?: string;
    confirmText: string;
    cancelText: string;
    value: string;
    options: SelectOption[];
    resolve: (v: string | null) => void;
  };

type AppModalApi = {
  alert: (message: string, opts?: AlertOptions) => Promise<void>;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
  select: (opts: SelectOptions) => Promise<string | null>;
};

const Ctx = createContext<AppModalApi | null>(null);

export const AppModalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [modal, setModal] = useState<ModalState | null>(null);

  const close = useCallback(() => setModal(null), []);

  const alert = useCallback(
    (message: string, opts?: AlertOptions) => {
      return new Promise<void>((resolve) => {
        setModal({
          kind: "alert",
          title: opts?.title ?? "Notice",
          message,
          okText: opts?.okText ?? "OK",
          resolve: () => {
            close();
            resolve();
          },
        });
      });
    },
    [close]
  );

  const confirm = useCallback(
    (opts: ConfirmOptions) => {
      return new Promise<boolean>((resolve) => {
        setModal({
          kind: "confirm",
          title: opts.title ?? "Confirm",
          message: opts.message,
          confirmText: opts.confirmText ?? "Confirm",
          cancelText: opts.cancelText ?? "Cancel",
          danger: !!opts.danger,
          resolve: (v) => {
            close();
            resolve(v);
          },
        });
      });
    },
    [close]
  );

  const prompt = useCallback(
    (opts: PromptOptions) => {
      return new Promise<string | null>((resolve) => {
        setModal({
          kind: "prompt",
          title: opts.title ?? "Enter value",
          message: opts.message,
          confirmText: opts.confirmText ?? "OK",
          cancelText: opts.cancelText ?? "Cancel",
          value: opts.defaultValue ?? "",
          placeholder: opts.placeholder,
          resolve: (v) => {
            close();
            resolve(v);
          },
        });
      });
    },
    [close]
  );

  const select = useCallback(
    (opts: SelectOptions) => {
      return new Promise<string | null>((resolve) => {
        const firstValue = opts.options[0]?.value ?? "";
        setModal({
          kind: "select",
          title: opts.title ?? "Choose an option",
          message: opts.message,
          confirmText: opts.confirmText ?? "OK",
          cancelText: opts.cancelText ?? "Cancel",
          value: opts.defaultValue ?? firstValue,
          options: opts.options,
          resolve: (v) => {
            close();
            resolve(v);
          },
        });
      });
    },
    [close]
  );

  const api = useMemo<AppModalApi>(() => ({ alert, confirm, prompt, select }), [alert, confirm, prompt, select]);

  return (
    <Ctx.Provider value={api}>
      {children}

      {modal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "var(--overlay)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (modal.kind === "alert") modal.resolve();
            if (modal.kind === "confirm") modal.resolve(false);
            if (modal.kind === "prompt") modal.resolve(null);
            if (modal.kind === "select") modal.resolve(null);
          }}
        >
          <div
            style={{
              width: 560,
              maxWidth: "100%",
              backgroundColor: "var(--bg-panel)",
              border: "1px solid var(--border-2)",
              borderRadius: 12,
              padding: 14,
              boxShadow: "0 12px 30px var(--overlay-2)",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>
              {modal.title}
            </div>

            {"message" in modal && modal.message ? (
              <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 12, lineHeight: 1.4 }}>
                {modal.message}
              </div>
            ) : null}

            {modal.kind === "prompt" && (
              <input
                value={modal.value}
                onChange={(e) => setModal((prev) => (prev && prev.kind === "prompt" ? { ...prev, value: e.target.value } : prev))}
                placeholder={modal.placeholder ?? ""}
                style={{
                  width: "100%",
                  borderRadius: 8,
                  border: "1px solid var(--border-3)",
                  backgroundColor: "var(--bg-deep)",
                  color: "var(--text-3)",
                  padding: "10px 10px",
                  fontSize: 13,
                  outline: "none",
                  marginBottom: 12,
                }}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    modal.resolve(modal.value);
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    modal.resolve(null);
                  }
                }}
              />
            )}

            {modal.kind === "select" && (
              <select className="themed-select"
                value={modal.value}
                onChange={(e) =>
                  setModal((prev) => (prev && prev.kind === "select" ? { ...prev, value: e.target.value } : prev))
                }
                style={{
                  width: "100%",
                  borderRadius: 8,
                  border: "1px solid var(--border-3)",
                  backgroundColor: "var(--bg-deep)",
                  color: "var(--text-3)",
                  padding: "10px 36px 10px 10px",
                  fontSize: 13,
                  outline: "none",
                  marginBottom: 12,

                }}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    modal.resolve(modal.value);
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    modal.resolve(null);
                  }
                }}
              >
                {modal.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              {modal.kind !== "alert" && (
                <button
                  type="button"
                  onClick={() => {
                    if (modal.kind === "confirm") modal.resolve(false);
                    if (modal.kind === "prompt") modal.resolve(null);
                    if (modal.kind === "select") modal.resolve(null);
                  }}
                  style={{
                    borderRadius: 8,
                    border: "1px solid var(--border-3)",
                    backgroundColor: "transparent",
                    color: "var(--text-2)",
                    cursor: "pointer",
                    padding: "8px 10px",
                    fontSize: 13,
                  }}
                >
                  {modal.kind === "confirm" ? modal.cancelText : modal.cancelText}
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  if (modal.kind === "alert") modal.resolve();
                  if (modal.kind === "confirm") modal.resolve(true);
                  if (modal.kind === "prompt") modal.resolve(modal.value);
                  if (modal.kind === "select") modal.resolve(modal.value);
                }}
                style={{
                  borderRadius: 8,
                  border:
                    modal.kind === "confirm" && modal.danger
                      ? "1px solid var(--danger-border-2)"
                      : "1px solid var(--accent)",
                  backgroundColor:
                    modal.kind === "confirm" && modal.danger
                      ? "var(--danger-bg-2)"
                      : "var(--accent-bg)",
                  color: "var(--text)",
                  cursor: "pointer",
                  padding: "8px 10px",
                  fontSize: 13,
                }}
              >
                {modal.kind === "alert" ? modal.okText : modal.kind === "confirm" ? modal.confirmText : modal.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
};

export const useAppModal = () => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppModal must be used inside <AppModalProvider>");
  return ctx;
};
