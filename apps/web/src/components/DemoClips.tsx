import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

/**
 * Short demo clips (recorded from this dashboard with real testnet data), shown as small muted loops.
 * Each clip loads only when it scrolls near the screen, and plays only while visible.
 * With "reduce motion" set in the system, clips do not autoplay: they show a still frame and normal video controls.
 */
export interface DemoClip {
  id: string;
  title: string;
  caption: string;
  seconds: number;
  href?: string;
  cta?: string;
}

export const DEMO_CLIPS: DemoClip[] = [
  { id: "run-it-live", title: "Run it live", caption: "The naive agent pays twice; the Sentinel-guarded agent pays once.", seconds: 15 },
  { id: "inspect-verdict", title: "Did it land?", caption: "One click on a real-money payment: DO_NOT_RETRY, with per-provider evidence.", seconds: 10, href: "#/inspect?example=guarded", cta: "Try it live" },
  { id: "guard-duplicate", title: "Guard: pay once per intent", caption: "A paid intent is PAID; a retry would be refused and refunded on-chain.", seconds: 10, href: "#/inspect?tool=guard", cta: "Try it live" },
  { id: "vault-allowance", title: "Vault: an allowance, not keys", caption: "How much the agent may spend right now, checked on every provider.", seconds: 10, href: "#/inspect?tool=vault", cta: "Try it live" },
  { id: "agent-security", title: "Agent security", caption: "A full-access key is flagged, and a prompt-injected payment is blocked before signing.", seconds: 15, href: "#/inspect?tool=keys", cta: "Try it live" },
];

function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const m = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!m) return;
    const on = () => setReduce(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduce;
}

function ClipVideo({ clip, reduce }: { clip: DemoClip; reduce: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e) return;
        if (e.isIntersecting) setNear(true);
        if (reduce) return;
        if (e.isIntersecting) void v.play().catch(() => {});
        else v.pause();
      },
      { rootMargin: "200px" },
    );
    io.observe(v);
    return () => io.disconnect();
  }, [reduce]);
  return (
    <video
      ref={ref}
      className="aspect-[800/475] w-full rounded-lg border border-line bg-surface-2 object-cover"
      poster={near ? `/media/${clip.id}.jpg` : undefined}
      src={near ? `/media/${clip.id}.mp4` : undefined}
      muted
      loop
      playsInline
      autoPlay={!reduce}
      controls={reduce}
      preload="none"
      aria-label={`${clip.title}: ${clip.caption} (${clip.seconds}-second silent clip)`}
    />
  );
}

export function DemoClips({ title = "See it in action", intro, ids }: { title?: string; intro?: string; ids?: string[] }) {
  const reduce = useReducedMotion();
  const clips = ids ? DEMO_CLIPS.filter((c) => ids.includes(c.id)) : DEMO_CLIPS;
  return (
    <section aria-labelledby="demo-clips-title" className="mt-14">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-mint">Short videos</p>
      <h2 id="demo-clips-title" className="mt-1 text-2xl font-semibold tracking-tight text-ink">
        <span aria-hidden="true">🎬 </span>
        {title}
      </h2>
      <p className="mt-1 text-sm text-muted">{intro ?? "Recorded from this dashboard with real testnet data. Each clip plays on its own, without sound."}</p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {clips.map((c) => (
          <figure key={c.id} className="card flex flex-col gap-3 rounded-xl p-3">
            <ClipVideo clip={c} reduce={reduce} />
            <figcaption className="flex flex-1 flex-col gap-1 px-1 pb-1">
              <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                <span aria-hidden="true">▶️</span>
                {c.title}
                <span className="ml-auto text-xs font-normal text-muted">{c.seconds} s</span>
              </span>
              <span className="text-xs leading-relaxed text-ink-2">{c.caption}</span>
              {c.href && (
                <a href={c.href} className="mt-auto inline-flex items-center gap-1.5 pt-1 text-xs font-medium text-link hover:underline">
                  <Icon name="play" size={12} />
                  {c.cta ?? "Try it live"}
                </a>
              )}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
