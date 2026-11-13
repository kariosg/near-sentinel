import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type HealthSnapshot } from "./api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Icon, Logo, type IconName } from "./components/icons";
import { IdentityBanner, IdentityStatus, useWalletCallback } from "./components/Identity";
import { Kbd, LiveDot, Pill, useFocusTrap } from "./components/ui";
import { BenchmarksPage } from "./pages/Benchmarks";
import { IncidentsPage } from "./pages/Incidents";
import { InspectPage } from "./pages/Inspect";
import { IntegratePage } from "./pages/Integrate";
import { OverviewPage } from "./pages/Overview";
import { ProvidersPage } from "./pages/Providers";
import { SettingsPage } from "./pages/Settings";
import { StartPage } from "./pages/Start";

type Route = { path: string; label: string; icon: IconName; group: string; description: string; render: () => ReactNode };

const ROUTES: Route[] = [
  { path: "start", label: "Start here", icon: "rocket", group: "Get started", description: "What NEAR Sentinel does and a 3-minute guided tour for judges.", render: () => <StartPage /> },
  { path: "inspect", label: "Inspect & retry check", icon: "search", group: "Use it", description: "Paste any testnet transaction: get a verdict with per-provider evidence and the receipt graph. Also look up Guard contract intents.", render: () => <InspectPage /> },
  { path: "overview", label: "Overview", icon: "gauge", group: "Use it", description: "Live health of the RPC providers Sentinel cross-checks, and recent inspections on this server.", render: () => <OverviewPage /> },
  { path: "providers", label: "RPC providers", icon: "server", group: "Use it", description: "Each provider's tested capabilities, latency history and request metrics.", render: () => <ProvidersPage /> },
  { path: "incidents", label: "Incidents", icon: "alert", group: "Use it", description: "Provider outages, lag, wrong-chain and capability changes, opened and closed automatically.", render: () => <IncidentsPage /> },
  { path: "benchmarks", label: "Benchmarks", icon: "chart", group: "Prove it", description: "Fault-injection scenarios (one click, no key) and real provider measurements.", render: () => <BenchmarksPage /> },
  { path: "integrate", label: "Integrate (SDK · MCP · API)", icon: "plug", group: "Build with it", description: "Copy-paste setup for AI agents (MCP), TypeScript, REST and the Guard contract.", render: () => <IntegratePage /> },
  { path: "settings", label: "Settings", icon: "settings", group: "Build with it", description: "How this server is set up, and the guarantees Sentinel keeps.", render: () => <SettingsPage /> },
];
const GROUPS = [...new Set(ROUTES.map((r) => r.group))];

function useHashRoute(): [string, string] {
  const read = () => {
    const raw = window.location.hash.replace(/^#\/?/, "");
    const [path = "start", query = ""] = raw.split("?");
    return [ROUTES.some((r) => r.path === path) ? path : "start", query] as [string, string];
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** Live provider health over Server-Sent Events; updates the shared query cache. */
function useLiveHealth() {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  useEffect(() => {
    const es = new EventSource("/api/v1/events");
    es.addEventListener("open", () => setLive(true));
    es.addEventListener("error", () => setLive(false));
    es.addEventListener("health", (e) => {
      const snap = JSON.parse((e as MessageEvent).data) as Omit<HealthSnapshot, "source">;
      qc.setQueryData(["providerHealth"], { source: "background prober (live)", ...snap });
    });
    es.addEventListener("incident", () => qc.invalidateQueries({ queryKey: ["incidents"] }));
    return () => es.close();
  }, [qc]);
  return live;
}

function NavLinks({ route, onNavigate, openIncidents }: { route: string; onNavigate?: () => void; openIncidents?: number }) {
  return (
    <nav aria-label="Main" className="space-y-5 px-3">
      {GROUPS.map((g) => (
        <div key={g}>
          <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{g}</p>
          <ul className="space-y-0.5">
            {ROUTES.filter((r) => r.group === g).map((r) => {
              const active = r.path === route;
              return (
                <li key={r.path}>
                  <a
                    href={`#/${r.path}`}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                      active ? "bg-surface-3/80 font-medium text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                    }`}
                  >
                    {active && <span aria-hidden className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-gradient-to-b from-link to-mint animate-scale-in" />}
                    <Icon name={r.icon} size={17} className={active ? "text-link" : "text-muted transition group-hover:text-ink-2"} />
                    <span className="truncate">{r.label}</span>
                    {r.path === "incidents" && openIncidents ? (
                      <span aria-hidden className="ml-auto rounded-full bg-warning/15 px-1.5 text-[11px] font-semibold text-warning">
                        {openIncidents}
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function StatusPanel({ network, live, apiVersion, apiDown }: { network?: string; live: boolean; apiVersion?: string; apiDown: boolean }) {
  return (
    <div className="mx-3 space-y-2.5 rounded-xl border border-line bg-surface-2/60 p-3.5 text-xs text-muted">
      <p className="flex items-center justify-between gap-2">
        Network: <span className="font-medium text-ink-2">{network ?? "…"}</span>
      </p>
      <p className="flex items-center justify-between gap-2">
        API: {apiDown ? <Pill tone="critical">unreachable</Pill> : apiVersion ? <Pill tone="good">v{apiVersion}</Pill> : "…"}
      </p>
      <IdentityStatus network={network ?? "testnet"} />
      <p className="flex items-center justify-between gap-2">
        Live updates:{" "}
        <span className="inline-flex items-center gap-2">
          {live && <LiveDot />}
          {live ? <Pill tone="good">connected</Pill> : <Pill tone="warning">offline</Pill>}
        </span>
      </p>
      <p className="flex items-start gap-2 border-t border-line pt-2.5 leading-relaxed">
        <Icon name="lock" size={14} className="mt-0.5 text-mint" />
        Read-only. Sentinel never signs, submits or holds keys.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- command palette */

type Command = { id: string; label: string; hint: string; icon: IconName; run: () => void };

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, open);
  const go = (hash: string) => () => {
    window.location.hash = hash;
  };
  const commands: Command[] = useMemo(
    () => [
      ...ROUTES.map((r) => ({ id: r.path, label: r.label, hint: "Go to page", icon: r.icon, run: go(`/${r.path}`) })),
      { id: "ex-partial", label: "Inspect a partially-completed real testnet tx", hint: "Example", icon: "play" as const, run: go(`/inspect?example=partial`) },
      { id: "ex-success", label: "Inspect a successful real testnet tx", hint: "Example", icon: "play" as const, run: go(`/inspect?example=success`) },
      { id: "ex-guarded", label: "Real money: the guarded agent's payment (paid once)", hint: "Example", icon: "play" as const, run: go(`/inspect?example=guarded`) },
      { id: "ex-naive", label: "Real money: the naive agent's duplicate payment", hint: "Example", icon: "play" as const, run: go(`/inspect?example=naive2`) },
      { id: "keys", label: "Agent keys: can this agent drain its account?", hint: "Security", icon: "lock" as const, run: go(`/inspect?tool=keys`) },
      { id: "security", label: "Security & privacy for AI agents (OWASP mapping)", hint: "Security", icon: "shieldCheck" as const, run: () => { window.location.hash = "/integrate"; setTimeout(() => document.getElementById("int-security")?.scrollIntoView({ block: "start" }), 400); } },
      { id: "glossary", label: "Glossary and demo accounts", hint: "Help", icon: "book" as const, run: () => { window.location.hash = "/start"; setTimeout(() => document.getElementById("glossary")?.scrollIntoView({ block: "center" }), 400); } },
      { id: "bench", label: "Run the 12 fault-injection scenarios", hint: "Action", icon: "zap" as const, run: go(`/benchmarks?run=simulated`) },
      { id: "docs", label: "Open the interactive API docs (OpenAPI)", hint: "Link", icon: "book" as const, run: () => window.open("/docs", "_blank", "noopener") },
    ],
    [],
  );
  const list = commands.filter((c) => c.label.toLowerCase().includes(q.trim().toLowerCase()));
  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
    }
  }, [open]);
  if (!open) return null;
  const exec = (c?: Command) => {
    if (!c) return;
    c.run();
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-start bg-black/60 px-4 pt-[12vh] backdrop-blur-sm animate-fade-in" onMouseDown={onClose}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="card mx-auto w-full max-w-xl overflow-hidden rounded-2xl border border-line-strong animate-scale-in"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(list.length - 1, s + 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
          else if (e.key === "Enter") (e.preventDefault(), exec(list[sel]));
        }}
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Icon name="search" className="text-muted" />
          <input
            ref={input}
            value={q}
            onChange={(e) => (setQ(e.target.value), setSel(0))}
            placeholder="Search pages and actions…"
            aria-label="Search pages and actions"
            className="w-full rounded-md bg-transparent py-4 text-sm text-ink focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-link"
          />
          <Kbd>Esc</Kbd>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto p-2">
          {list.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">No matches.</li>}
          {list.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                onMouseEnter={() => setSel(i)}
                onClick={() => exec(c)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition ${i === sel ? "bg-surface-3 text-ink" : "text-ink-2"}`}
              >
                <Icon name={c.icon} size={16} className={i === sel ? "text-link" : "text-muted"} />
                <span className="flex-1">{c.label}</span>
                <span className="text-xs text-muted">{c.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- app */

export function App() {
  const [route] = useHashRoute();
  const live = useLiveHealth();
  const walletError = useWalletCallback();
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const incidents = useQuery({ queryKey: ["incidents", "open"], queryFn: () => api.incidents(true), refetchInterval: 60_000 });
  const current = ROUTES.find((r) => r.path === route)!;
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const main = useRef<HTMLElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(drawerRef, drawer);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        setPalette(true);
      } else if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  useEffect(() => {
    setDrawer(false);
    document.title = `${current.label} · NEAR Sentinel`;
    window.scrollTo({ top: 0 });
  }, [route, current.label]);

  const status = <StatusPanel network={providers.data?.network} live={live} apiVersion={health.data?.version} apiDown={health.isError} />;
  const brand = (
    <a href="#/start" className="flex items-center gap-3 rounded-lg px-1">
      <Logo size={34} />
      <span className="leading-none">
        <span className="block text-[10px] font-medium uppercase tracking-[0.22em] text-muted">NEAR</span>
        <span className="mt-1 block text-[17px] font-bold tracking-tight text-ink">Sentinel</span>
        <span className="sr-only"> (NEAR Sentinel, transaction-safety guard)</span>
      </span>
    </a>
  );
  const searchButton = (
    <button
      type="button"
      onClick={() => setPalette(true)}
      className="mx-3 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-sm text-muted transition hover:border-line-strong hover:text-ink-2"
    >
      <Icon name="search" size={15} />
      <span className="flex-1 text-left">Search…</span>
      <Kbd>Ctrl K</Kbd>
    </button>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[264px_1fr]">
      <button
        type="button"
        onClick={() => main.current?.focus()}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </button>

      {/* Desktop sidebar */}
      <div className="hidden border-r border-line bg-surface/70 lg:block">
      <aside className="sticky top-0 flex h-screen flex-col gap-5 overflow-y-auto py-5 backdrop-blur-xl">
        <div className="px-4">{brand}</div>
        {searchButton}
        <NavLinks route={route} openIncidents={incidents.data?.items.length} />
        <div className="mt-auto">{status}</div>
      </aside>
      </div>

      {/* Mobile / tablet top bar + drawer */}
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-line bg-page/80 px-4 py-3 backdrop-blur-xl lg:hidden">
        {brand}
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setPalette(true)} aria-label="Search pages and actions" className="grid h-9 w-9 place-items-center rounded-lg border border-line text-ink-2">
            <Icon name="search" size={17} />
          </button>
          <button
            type="button"
            onClick={() => setDrawer(true)}
            aria-label="Open menu"
            aria-expanded={drawer}
            aria-controls="mobile-drawer"
            className="grid h-9 w-9 place-items-center rounded-lg border border-line text-ink-2"
          >
            <Icon name="menu" size={17} />
          </button>
        </div>
      </header>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={() => setDrawer(false)} />
          <div ref={drawerRef} id="mobile-drawer" role="dialog" aria-modal="true" aria-label="Menu" className="absolute inset-y-0 left-0 flex w-[min(300px,85vw)] flex-col gap-5 overflow-y-auto border-r border-line bg-surface py-5 animate-slide-in-left">
            <div className="flex items-center justify-between px-4">
              {brand}
              <button type="button" onClick={() => setDrawer(false)} aria-label="Close menu" className="grid h-9 w-9 place-items-center rounded-lg border border-line text-ink-2">
                <Icon name="x" size={17} />
              </button>
            </div>
            <NavLinks route={route} onNavigate={() => setDrawer(false)} openIncidents={incidents.data?.items.length} />
            <div className="mt-auto">{status}</div>
          </div>
        </div>
      )}

      <main ref={main} tabIndex={-1} className="min-w-0 px-4 pb-10 pt-6 focus:outline-none sm:px-6 lg:px-10 lg:pt-8">
        <div className="mx-auto max-w-[1240px]">
          <IdentityBanner network={providers.data?.network} />
          {walletError && (
            <p role="alert" className="mb-5 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-ink-2 animate-fade-up">
              <Icon name="alert" size={16} className="mt-0.5 text-warning" />
              {walletError}
            </p>
          )}

          {route !== "start" && (
            <div key={`h-${route}`} className="mb-6 flex flex-wrap items-end justify-between gap-4 animate-fade-up">
              <div className="min-w-0">
                <p className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted">
                  <Icon name={current.icon} size={14} className="text-link" />
                  {current.group}
                </p>
                <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">{current.label}</h1>
                <p className="mt-1.5 max-w-2xl text-sm text-ink-2">{current.description}</p>
              </div>
              <a href="#/start" className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-3 py-2 text-sm text-ink-2 transition hover:border-link/60 hover:text-ink">
                <Icon name="rocket" size={15} />
                Judge tour
              </a>
            </div>
          )}

          <div key={route} className="animate-fade-up">
            <ErrorBoundary key={route}>{current.render()}</ErrorBoundary>
          </div>

          <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-xs text-muted">
            <p className="flex items-center gap-2">
              <Logo size={18} /> NEAR Sentinel · read-only · {providers.data?.network ?? "testnet"} · MIT licensed
            </p>
            <p className="flex items-center gap-3">
              <a className="hover:text-ink-2" href="/docs" target="_blank" rel="noreferrer">
                API docs ↗
              </a>
              <span>
                Press <Kbd>Ctrl K</Kbd> to search
              </span>
            </p>
          </footer>
        </div>
      </main>

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
