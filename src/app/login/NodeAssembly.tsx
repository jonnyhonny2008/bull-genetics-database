"use client";

// Points of light sweep in from across the whole screen and land exactly on the
// vertices of the wireframe cow, at which point the artwork fades up beneath
// them and they dissolve into it.
//
// The target coordinates are measured, not placed: the artwork was thresholded
// and its bright cyan blobs reduced to centroids (see cow-mesh.ts). They are
// fractions of the artwork's frame, so the canvas — which covers the whole page
// — can map them onto wherever the image actually sits and still line up.

import { useEffect, useRef } from "react";
import { MESH_NODES } from "./cow-mesh";

/**
 * The head carries far more measured vertices than the body, and lighting all
 * of them turns the poll into a bright smear. Thin that region out; the rest of
 * the animal keeps every point.
 */
const NODES = MESH_NODES.filter(([x, y], i) => !(x > 0.70 && y < 0.30 && i % 5 >= 2));

interface P { tx: number; ty: number; sx: number; sy: number; delay: number; tw: number; vx: number; vy: number; }

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Seconds from mount until the points have landed. The artwork fades up here. */
export const ASSEMBLE_SECONDS = 2.1;

export function NodeAssembly({ igniting, boxRef }: { igniting: boolean; boxRef: React.RefObject<HTMLElement> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const igniteRef = useRef(false);
  useEffect(() => { igniteRef.current = igniting; }, [igniting]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const pts: P[] = NODES.map(([tx, ty]) => ({
      tx, ty, sx: 0, sy: 0,
      delay: Math.random() * 0.5, tw: Math.random() * Math.PI * 2, vx: 0, vy: 0,
    }));

    let W = 0, H = 0;
    let box = { x: 0, y: 0, w: 0, h: 0 };

    function layout() {
      const c = ref.current; if (!c) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = c.clientWidth; H = c.clientHeight;
      c.width = Math.floor(W * dpr); c.height = Math.floor(H * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      const el = boxRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const cr = c.getBoundingClientRect();
        box = { x: r.left - cr.left, y: r.top - cr.top, w: r.width, h: r.height };
      }
      for (const p of pts) {
        // start anywhere across the screen, mostly from beyond its edges
        if (Math.random() < 0.6) {
          const a = Math.random() * Math.PI * 2;
          const rad = 0.62 + Math.random() * 0.6;
          p.sx = 0.5 + Math.cos(a) * rad; p.sy = 0.5 + Math.sin(a) * rad;
        } else {
          p.sx = Math.random(); p.sy = Math.random();
        }
      }
    }
    layout();
    window.addEventListener("resize", layout);
    const ro = new ResizeObserver(layout);
    if (boxRef.current) ro.observe(boxRef.current);
    const settle = window.setTimeout(layout, 300);

    // hot white core, tight cyan falloff — a crisp star, not a soft blob
    const sprite = document.createElement("canvas");
    const R = 22; sprite.width = sprite.height = R * 2;
    const sctx = sprite.getContext("2d")!;
    const g = sctx.createRadialGradient(R, R, 0, R, R, R);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.12, "rgba(240,255,253,0.95)");
    g.addColorStop(0.26, "rgba(150,255,246,0.6)");
    g.addColorStop(0.5, "rgba(70,225,215,0.18)");
    g.addColorStop(1, "rgba(40,190,185,0)");
    sctx.fillStyle = g; sctx.fillRect(0, 0, R * 2, R * 2);

    const start = performance.now();
    let igniteAt = 0, raf = 0;

    function frame(now: number) {
      const t = (now - start) / 1000;
      const ignite = igniteRef.current;
      if (ignite && !igniteAt) igniteAt = t;
      const it = igniteAt ? t - igniteAt : 0;
      ctx!.clearRect(0, 0, W, H);

      const conv = reduced ? 1 : clamp01(t / ASSEMBLE_SECONDS);
      // once landed, hand over to the artwork: the points dim as it fades up
      const handover = reduced ? 1 : clamp01((t - ASSEMBLE_SECONDS) / 0.9);

      const at = (p: P, e: number) => {
        const fx = p.sx * W, fy = p.sy * H;
        const tx = box.x + p.tx * box.w, ty = box.y + p.ty * box.h;
        return [fx + (tx - fx) * e, fy + (ty - fy) * e] as const;
      };

      ctx!.globalCompositeOperation = "lighter";
      for (const p of pts) {
        const local = clamp01((conv - p.delay * 0.45) / (1 - p.delay * 0.45 || 1));
        const e = easeOutCubic(local);
        let [x, y] = at(p, e);

        let alpha = (0.55 + 0.45 * e) * (1 - handover * 0.82);
        let size = (1.6 + 2.2 * e) * (1 - handover * 0.2);
        alpha *= 0.84 + 0.16 * Math.sin(t * 2.3 + p.tw);

        if (ignite) {
          if (p.vx === 0 && p.vy === 0) {
            const a = Math.atan2(y - H / 2, x - W / 2) + (Math.random() - 0.5) * 0.6;
            const sp = 150 + Math.random() * 380;
            p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
          }
          const k = it * it;
          x += p.vx * k; y += p.vy * k;
          size += it * 6;
          alpha = (alpha + 0.8) * Math.max(0, 1 - it * 1.3);
        }
        if (alpha <= 0.003) continue;

        // a short streak while the point is still travelling, so it reads as
        // light crossing the room rather than a dot teleporting
        if (!ignite && e > 0.02 && e < 0.96) {
          const [fx, fy] = at(p, Math.max(0, e - 0.06));
          ctx!.strokeStyle = `rgba(170,255,250,${0.45 * alpha})`;
          ctx!.lineWidth = Math.max(0.8, size * 0.45);
          ctx!.beginPath(); ctx!.moveTo(x, y); ctx!.lineTo(fx, fy); ctx!.stroke();
        }

        ctx!.globalAlpha = clamp01(alpha);
        ctx!.drawImage(sprite, x - size * 3, y - size * 3, size * 6, size * 6);
      }

      ctx!.globalAlpha = 1;
      ctx!.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      ro.disconnect();
      window.removeEventListener("resize", layout);
    };
  }, [boxRef]);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-hidden="true" />;
}
