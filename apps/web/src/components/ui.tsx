import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type RefObject } from "react";
import { ApiError } from "../api";
import { Icon, type IconName } from "./icons";

/* ------------------------------------------------------------------ layout */

export function Card({
  title,
  subtitle,
  icon,
  actions,
  children,
  className = "",
  bodyClassName = "p-5",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`card rounded-2xl border border-line ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            {icon && (
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-surface-2 text-link">
                <Icon name={icon} size={16} />
              </span>
            )}
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
              {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {/* Wide content (tables) scrolls inside the card instead of widening the page. */}
      <div className={`overflow-x-auto ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Every status in the UI states where it came from and when. */
export function Source({ source, at }: { source: string; at?: string | null }) {
  return (
    <p className="text-xs text-muted">
      Source: {source} · updated <time dateTime={at ?? undefined} title={at ?? undefined}>{timeAgo(at)}</time>
    </p>
  );
}

/* ------------------------------------------------------------------ status */

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral" | "info";
const toneClass: Record<Tone, string> = {
  good: "border-good/35 bg-good/10 text-good",
  warning: "border-warning/35 bg-warning/10 text-warning",
  serious: "border-serious/35 bg-serious/10 text-serious",
  critical: "border-critical/40 bg-critical/10 text-critical",
  neutral: "border-line-strong bg-surface-2 text-ink-2",
  info: "border-info/35 bg-info/10 text-info",
};
const toneIcon: Record<Tone, string> = { good: "✓", warning: "!", serious: "▲", critical: "✕", neutral: "•", info: "i" };
export const toneText: Record<Tone, string> = { good: "text-good", warning: "text-warning", serious: "text-serious", critical: "text-critical", neutral: "text-ink-2", info: "text-info" };
export const toneBg: Record<Tone, string> = { good: "bg-good", warning: "bg-warning", serious: "bg-serious", critical: "bg-critical", neutral: "bg-muted", info: "bg-info" };

/** Status pill: icon + label + color — never color alone. */
export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${toneClass[tone]}`}>
      <span aria-hidden className="text-[10px] font-bold">
        {toneIcon[tone]}
      </span>
      {children}
    </span>
  );
}

/** A small pulsing dot for "live" states. Decorative; always paired with text. */
export function LiveDot({ tone = "good" }: { tone?: Tone }) {
  return (
    <span aria-hidden className="relative inline-flex h-2 w-2">
      <span className={`absolute inset-0 rounded-full ${toneBg[tone]} animate-pulse-ring`} />
      <span className={`relative inline-flex h-2 w-2 rounded-full ${toneBg[tone]}`} />
    </span>
  );
}

export const verdictTone = (v?: string): Tone =>
  v === "DO_NOT_RETRY" ? "critical" : v === "SAFE_TO_RETRY" ? "good" : v === "WAIT_AND_RECHECK" ? "warning" : v === "MANUAL_REVIEW_REQUIRED" ? "serious" : "neutral";

export const stateTone = (s?: string): Tone =>
  s === "EXECUTED_SUCCESS" ? "good" : s === "EXECUTED_FAILURE" ? "critical" : s === "PARTIALLY_COMPLETED" ? "serious" : s === "INCLUDED" ? "info" : s === "EXPIRED_OR_UNRESOLVED" ? "neutral" : "warning";

/** What each verdict means and what an agent should do. Shown on the start page and in tooltips. */
export const VERDICTS: Array<{ id: string; title: string; icon: IconName; meaning: string; agent: string }> = [
  { id: "DO_NOT_RETRY", title: "Do not retry", icon: "x", meaning: "It executed, or is executing. A new transaction would pay twice.", agent: "Stop. Treat the payment as sent." },
  { id: "WAIT_AND_RECHECK", title: "Wait and re-check", icon: "clock", meaning: "Not seen yet, but it can still land.", agent: "Wait; you may re-broadcast the identical bytes. Never sign new ones." },
  { id: "SAFE_TO_RETRY", title: "Safe to retry", icon: "check", meaning: "Proven dead on a quorum of independent operators (nonce used or expired, absent from the history they hold).", agent: "Sign a new transaction." },
  { id: "MANUAL_REVIEW_REQUIRED", title: "Manual review required", icon: "hand", meaning: "Partial multi-contract execution, or providers disagree.", agent: "Escalate to a human." },
];

/* ------------------------------------------------------------------ feedback */

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 py-6 text-sm text-muted">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-link" />
      {label}
    </div>
  );
}

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}

/** Indeterminate progress bar (decorative; pair with text). */
export function ProgressBar({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={`relative h-1 overflow-hidden rounded-full bg-surface-3 ${className}`}>
      <div className="absolute inset-y-0 w-2/5 rounded-full bg-gradient-to-r from-transparent via-link to-transparent animate-progress" />
    </div>
  );
}

export function Empty({ children, icon = "sparkles" }: { children: ReactNode; icon?: IconName }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">
      <span className="grid h-9 w-9 place-items-center rounded-full bg-surface-2 text-ink-2">
        <Icon name={icon} size={16} />
      </span>
      <div>{children}</div>
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const e = error instanceof ApiError ? error : undefined;
  return (
    <div role="alert" className="animate-fade-in rounded-xl border border-critical/40 bg-critical/10 px-4 py-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-critical">
        <Icon name="alert" size={16} />
        {e?.code === "API_UNREACHABLE" ? "Unavailable" : "Error"}
        {e?.code ? ` — ${e.code}` : ""}
      </p>
      <p className="mt-1 text-ink-2">{error instanceof Error ? error.message : String(error)}</p>
      {e?.requestId && <p className="mt-1 font-mono text-xs text-muted">request id: {e.requestId}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ text */

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[12px] ${className}`}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{children}</kbd>;
}

/** Hover/focus tooltip. The trigger must be focusable for keyboard users. */
export function Tooltip({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <span className="group relative inline-flex" aria-describedby={id}>
      {children}
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 w-64 -translate-x-1/2 translate-y-1 rounded-lg border border-line-strong bg-surface-3 px-3 py-2 text-xs leading-relaxed text-ink-2 opacity-0 shadow-xl transition group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100"
      >
        {tip}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ numbers */

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Counts up to `value` once it changes (ease-out, ~0.8 s). Renders the final value instantly with reduced motion. */
export function CountUp({ value, format = (n) => Math.round(n).toLocaleString() }: { value: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(reducedMotion() ? value : 0);
  const from = useRef(0);
  useEffect(() => {
    if (reducedMotion()) return setShown(value);
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / 800);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(a + (value - a) * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className="tabular">{format(shown)}</span>;
}

/** Circular gauge (0..1). Decorative: the caller shows the value as text too. */
export function Ring({ value, size = 56, stroke = 6, tone = "good" }: { value: number; size?: number; stroke?: number; tone?: Tone }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const [v, setV] = useState(reducedMotion() ? value : 0);
  useEffect(() => {
    const t = setTimeout(() => setV(value), 50);
    return () => clearTimeout(t);
  }, [value]);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className={`-rotate-90 ${toneText[tone]}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-surface-3)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(1, v)))}
        style={{ transition: "stroke-dashoffset 1s cubic-bezier(.2,.7,.2,1)" }}
      />
    </svg>
  );
}

export function Stat({ label, value, hint, icon, tone }: { label: string; value: ReactNode; hint?: ReactNode; icon?: IconName; tone?: Tone }) {
  return (
    <div className="card card-hover relative rounded-2xl border border-line px-5 py-4">
      {/* label, value and hint are siblings: the label's parent is the whole stat */}
      {icon && (
        <span aria-hidden className={`absolute right-4 top-4 grid h-7 w-7 place-items-center rounded-lg bg-surface-2 ${tone ? toneText[tone] : "text-link"}`}>
          <Icon name={icon} size={15} />
        </span>
      )}
      <p className="pr-9 text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-ink">{value}</p>
      {hint && <div className="mt-1.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ controls */

export function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  size = "md",
  disabled,
  icon,
  className = "",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "ghost" | "subtle";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  icon?: IconName;
  className?: string;
  title?: string;
}) {
  const v =
    variant === "primary"
      ? "bg-gradient-to-b from-accent to-accent-2 text-white shadow-[0_8px_24px_-10px_rgb(37_99_235/0.8)] hover:brightness-110"
      : variant === "subtle"
        ? "bg-surface-2 text-ink hover:bg-surface-3 border border-line"
        : "border border-line-strong text-ink-2 hover:border-link/60 hover:bg-surface-2 hover:text-ink";
  const s = size === "sm" ? "px-2.5 py-1 text-xs" : size === "lg" ? "px-5 py-2.5 text-sm" : "px-3.5 py-2 text-sm";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 ${v} ${s} ${className}`}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 13 : 16} />}
      {children}
    </button>
  );
}

/** Labelled text input. The label text is the accessible name (tests use getByLabel). */
export function Field({ label, hint, className = "", ...input }: { label: string; hint?: ReactNode; className?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={`block text-xs font-medium text-ink-2 ${className}`}>
      {label}
      <input
        {...input}
        className="mt-1.5 w-full rounded-lg border border-line-strong bg-page/70 px-3 py-2.5 font-mono text-sm text-ink transition placeholder:font-sans focus:border-link focus:outline-none focus:ring-2 focus:ring-link/30"
      />
      {hint && <span className="mt-1 block font-normal text-muted">{hint}</span>}
    </label>
  );
}

/* ------------------------------------------------------------------ dialogs */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal behaviour for a dialog element while `active`: Tab / Shift+Tab cycle inside it, the page behind
 * does not scroll, and focus returns to whatever was focused before it opened.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const before = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (before && document.contains(before)) before.focus();
    };
  }, [active, ref]);
}

/* ------------------------------------------------------------------ toasts */

type Toast = { id: number; text: string; tone: Tone };
const ToastCtx = createContext<(text: string, tone?: Tone) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Tone = "good") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-2), { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 2600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {/* aria-live (not role=status) so screen readers announce it without counting as a loading spinner. */}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2">
        {items.map((t) => (
          <div key={t.id} className="animate-fade-up flex items-center gap-2 rounded-xl border border-line-strong bg-surface-3/95 px-4 py-2.5 text-sm text-ink shadow-2xl backdrop-blur">
            <span className={toneText[t.tone]}>
              <Icon name={t.tone === "good" ? "check" : "info"} size={16} />
            </span>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            toast("Copied to clipboard");
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => toast("Copy failed — select the text instead", "warning"))
      }
      className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-surface-2/90 px-2 py-1 text-xs text-ink-2 backdrop-blur transition hover:border-link/60 hover:text-ink"
    >
      <Icon name={copied ? "check" : "copy"} size={13} />
      {copied ? "copied" : label}
    </button>
  );
}

/** Code block with a copy button. Focusable so keyboard users can scroll wide code (WCAG 2.1.1). */
export function CodeBlock({ children, title }: { children: string; title?: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-page/80">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-2/60 px-3 py-1.5">
        <span className="flex items-center gap-2 text-xs text-muted">
          <span aria-hidden className="flex gap-1">
            <span className="h-2.5 w-2.5 rounded-full bg-[#f47272]/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#fab219]/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#2fbf5b]/70" />
          </span>
          {title ?? "terminal"}
        </span>
        <CopyButton text={children} />
      </div>
      <pre tabIndex={0} aria-label={title ? `${title} code` : "Code example"} className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-ink-2">
        {children}
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ misc */

export function download(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const fmtMs = (n?: number | null) => (n === null || n === undefined ? "—" : `${n.toLocaleString()} ms`);
export const fmtPct = (n?: number | null) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(n === 1 ? 0 : 1)}%`);
export const short = (s?: string, n = 10) => (!s ? "" : s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-6)}`);

export const linkClass = "text-link underline underline-offset-2 hover:no-underline";
