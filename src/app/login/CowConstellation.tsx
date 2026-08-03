"use client";

// ---------------------------------------------------------------------------
// The login backdrop: points of light drifting in the dark that converge into a
// LOW-POLY WIREFRAME of a cow — every scattered data point assembling into a
// complete animal, which is what this platform does with proof rounds.
//
// The mesh is generated, not drawn: the silhouette below is traced from a
// photograph of one of the stud's own cows, filled with interior points, and
// triangulated (Bowyer–Watson) at load. Triangles whose centre falls outside
// the animal are discarded, so the mesh hugs the real shape including the udder
// and between the legs.
//
// Hand-rolled canvas 2D — one page does not justify shipping an animation lib.
// Phases: scatter → assemble → settle → ignite (on a successful sign-in).
// ---------------------------------------------------------------------------

import { useEffect, useRef } from "react";

/**
 * The silhouette, EXTRACTED rather than drawn.
 *
 * A sculpt render of a dairy cow was thresholded (background 25, animal 152 —
 * a clean split), the largest connected component taken, its boundary walked
 * with Moore neighbour tracing (2,767 pixels), and the result simplified with
 * Douglas–Peucker to 184 points. The plinth she was standing on is cropped at
 * y=356 — the last row where the four legs still read as separate runs, so the
 * legs stay apart instead of webbing together — and she stands in the spotlight
 * rather than on a slab.
 *
 * Coordinates are already normalised into a 100-unit box, y downward, head to
 * the right. Do not hand-edit: re-run the trace if the reference changes.
 */
const TRACED =
  "82.8,20.6 83.6,20.6 84.3,21.8 88.3,22.6 89.9,23.7 92.9,24.7 98.3,28.2 99.5,28.6 100.0,29.3 100.0,30.1 98.4,32.1 96.7,32.4 96.5,32.8 97.2,32.9 95.8,32.9 95.8,32.4 94.6,32.4 90.2,33.4 84.3,33.6 83.8,34.1 83.8,35.2 85.2,35.5 84.8,36.4 83.3,38.2 81.9,39.0 81.9,39.5 82.6,39.2 82.8,39.5 80.3,43.2 79.1,44.4 78.9,43.9 76.5,46.9 72.8,52.6 71.4,55.6 71.3,57.3 70.2,59.4 68.6,61.3 67.6,61.7 70.2,58.9 69.7,58.7 67.6,60.8 67.9,58.5 69.2,55.1 70.4,52.8 69.9,54.2 70.4,54.7 73.3,48.8 75.8,45.3 74.2,45.3 74.0,44.9 71.6,49.1 68.8,51.9 68.1,53.5 68.1,55.4 67.6,55.7 67.1,60.6 66.2,62.4 66.2,67.8 65.7,70.2 64.5,72.0 63.4,72.3 61.8,71.4 61.8,73.3 62.7,76.5 62.7,73.0 63.4,72.6 65.2,73.0 65.3,75.3 66.7,79.4 60.6,79.4 60.5,78.7 61.3,78.2 61.0,77.9 59.4,77.9 59.1,76.0 59.8,72.6 59.9,68.6 59.4,67.8 59.1,61.7 60.1,62.0 60.6,60.8 59.2,59.4 59.1,60.1 58.5,60.1 54.7,59.2 54.5,58.9 49.8,59.2 52.3,56.6 52.3,55.9 49.5,58.7 46.7,58.9 45.5,59.6 41.6,59.2 38.5,58.2 37.8,58.5 38.5,58.9 36.1,58.5 35.4,58.7 35.5,59.1 35.0,59.4 31.7,57.3 30.8,58.0 29.8,57.1 27.4,56.1 27.4,57.0 28.2,58.7 27.0,58.0 25.6,59.2 22.6,60.1 22.1,60.6 20.4,60.6 19.2,61.8 20.2,62.4 20.0,62.7 18.6,62.5 18.8,62.0 17.4,62.0 17.4,61.5 17.1,61.5 15.7,67.2 15.2,72.3 14.5,74.4 14.5,79.4 11.0,79.4 10.6,76.8 10.3,77.0 10.3,79.4 6.8,79.4 7.1,76.3 6.8,64.3 8.2,61.8 10.1,62.7 10.3,61.5 9.8,59.9 9.6,60.6 6.8,58.2 5.6,56.3 5.6,55.2 4.7,55.1 4.9,54.5 4.2,53.8 4.4,49.1 5.9,46.5 5.4,43.2 5.1,42.9 4.9,43.2 4.0,41.8 4.0,39.7 4.9,41.3 5.1,40.6 3.5,36.2 3.0,36.4 3.1,38.3 2.6,40.8 2.6,53.3 3.1,59.4 5.2,68.1 4.4,71.8 3.5,72.5 3.3,71.4 2.4,73.5 2.3,72.5 1.9,73.5 1.6,73.5 0.5,72.0 0.7,71.6 0.0,70.2 0.0,65.2 1.9,55.6 1.7,36.9 3.0,33.8 5.4,32.2 10.3,32.4 13.4,31.7 19.5,31.5 23.3,30.8 29.4,31.0 58.0,29.3 70.2,29.8 74.6,28.2 77.9,25.1 80.1,22.1 81.9,21.6 82.6,20.7";

const POLY: [number, number][] = TRACED.split(" ").map((p) => {
  const [x, y] = p.split(",");
  return [parseFloat(x), parseFloat(y)];
});

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Bowyer–Watson Delaunay. Small n, so the simple O(n²) form is plenty. */
function triangulate(pts: [number, number][]): [number, number, number][] {
  const n = pts.length;
  // super-triangle large enough to contain every point
  const P = [...pts, [-1000, -1000], [1000, -1000], [0, 1000]] as [number, number][];
  let tris: [number, number, number][] = [[n, n + 1, n + 2]];

  const circum = (a: number, b: number, c: number) => {
    const [ax, ay] = P[a], [bx, by] = P[b], [cx, cy] = P[c];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-12) return { x: 0, y: 0, r: -1 };
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    return { x: ux, y: uy, r: Math.hypot(ax - ux, ay - uy) };
  };

  for (let i = 0; i < n; i++) {
    const bad: [number, number, number][] = [];
    const keep: [number, number, number][] = [];
    for (const t of tris) {
      const cc = circum(t[0], t[1], t[2]);
      if (cc.r >= 0 && Math.hypot(P[i][0] - cc.x, P[i][1] - cc.y) <= cc.r) bad.push(t);
      else keep.push(t);
    }
    // boundary of the cavity = edges belonging to exactly one bad triangle
    const edges: [number, number][] = [];
    for (const t of bad) {
      const e: [number, number][] = [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]];
      for (const [a, b] of e) {
        const idx = edges.findIndex(([c, d]) => (c === a && d === b) || (c === b && d === a));
        if (idx >= 0) edges.splice(idx, 1); else edges.push([a, b]);
      }
    }
    tris = keep;
    for (const [a, b] of edges) tris.push([a, b, i]);
  }
  // drop anything touching the super-triangle
  return tris.filter((t) => t[0] < n && t[1] < n && t[2] < n);
}

/** Resample a closed polygon at even spacing, so mesh vertices sit evenly. */
function resample(poly: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [];
  let carry = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let d = carry;
    while (d < len) {
      const t = d / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      d += step;
    }
    carry = d - len;
  }
  return out;
}

/** Build the low-poly mesh once: vertices + unique edges. */
function buildMesh() {
  const rim = resample(POLY, 3.4);
  const verts: [number, number][] = [...rim];

  // interior points on a jittered triangular lattice — a plain square grid
  // produces obvious rows, which reads as graph paper rather than a mesh
  const STEP = 7.2;
  for (let row = 0, y = MINYP() + STEP * 0.6; y < MAXYP(); y += STEP * 0.87, row++) {
    for (let x = MINXP() + (row % 2 ? STEP / 2 : 0); x < MAXXP(); x += STEP) {
      const jx = x + (Math.random() - 0.5) * STEP * 0.35;
      const jy = y + (Math.random() - 0.5) * STEP * 0.35;
      if (!pointInPolygon(jx, jy, POLY)) continue;
      // keep clear of the rim so we do not get slivers
      if (rim.some((r) => Math.hypot(r[0] - jx, r[1] - jy) < STEP * 0.62)) continue;
      verts.push([jx, jy]);
    }
  }

  const tris = triangulate(verts).filter((t) => {
    const cx = (verts[t[0]][0] + verts[t[1]][0] + verts[t[2]][0]) / 3;
    const cy = (verts[t[0]][1] + verts[t[1]][1] + verts[t[2]][1]) / 3;
    return pointInPolygon(cx, cy, POLY);   // discard anything outside the animal
  });

  const seen = new Set<string>();
  const edges: [number, number][] = [];
  for (const t of tris) {
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]] as [number, number][]) {
      const k = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push([a, b]);
    }
  }
  // The traced contour already carries the tail and ears, so there is no
  // separate "hair" pass any more.
  return { verts, edges, hairEdges: [] as [number, number][], rimCount: rim.length, meshCount: verts.length };
}

function MINXP() { return Math.min(...POLY.map((p) => p[0])); }
function MAXXP() { return Math.max(...POLY.map((p) => p[0])); }
function MINYP() { return Math.min(...POLY.map((p) => p[1])); }
function MAXYP() { return Math.max(...POLY.map((p) => p[1])); }

interface Pt {
  tx: number; ty: number; x: number; y: number;
  sx: number; sy: number; delay: number; tw: number;
  vx: number; vy: number; rim: boolean; hair: boolean;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export function CowConstellation({ igniting }: { igniting: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const igniteRef = useRef(false);
  useEffect(() => { igniteRef.current = igniting; }, [igniting]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const mesh = buildMesh();
    const pts: Pt[] = mesh.verts.map(([tx, ty], i) => ({
      tx, ty, x: 0, y: 0, sx: 0, sy: 0,
      delay: Math.random() * 0.45, tw: Math.random() * Math.PI * 2,
      vx: 0, vy: 0, rim: i < mesh.rimCount, hair: i >= mesh.meshCount,
    }));

    let W = 0, H = 0, dpr = 1, scale = 1, ox = 0, oy = 0;
    function layout() {
      const c = canvasRef.current; if (!c) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = c.clientWidth; H = c.clientHeight;
      c.width = Math.floor(W * dpr); c.height = Math.floor(H * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      const narrow = W < 820;
      // On desktop the sign-in panel owns the right ~46%, so she is scaled and
      // seated left of it — her head must not disappear behind the glass.
      scale = Math.min(W / 100, H / 100) * (narrow ? 0.84 : 0.92);
      ox = W * (narrow ? 0.5 : 0.33) - 50 * scale;
      oy = H * (narrow ? 0.46 : 0.5) - 50 * scale;
      for (const p of pts) {
        p.sx = (Math.random() * W - ox) / scale;
        p.sy = (Math.random() * H - oy) / scale;
      }
      if (reduced) for (const p of pts) { p.x = p.tx; p.y = p.ty; }
    }
    layout();
    window.addEventListener("resize", layout);

    let mx = 0, my = 0, tmx = 0, tmy = 0;
    const onMove = (e: PointerEvent) => {
      tmx = (e.clientX / window.innerWidth - 0.5) * 2;
      tmy = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("pointermove", onMove);

    const sprite = document.createElement("canvas");
    const R = 16; sprite.width = sprite.height = R * 2;
    const sctx = sprite.getContext("2d")!;
    const g = sctx.createRadialGradient(R, R, 0, R, R, R);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.25, "rgba(190,240,225,0.5)");
    g.addColorStop(1, "rgba(110,200,180,0)");
    sctx.fillStyle = g; sctx.fillRect(0, 0, R * 2, R * 2);

    const GATHER_START = 0.3, GATHER_LEN = 2.3;
    const start = performance.now();
    let igniteAt = 0, raf = 0;

    function frame(now: number) {
      const t = (now - start) / 1000;
      const ignite = igniteRef.current;
      if (ignite && !igniteAt) igniteAt = t;
      const it = igniteAt ? t - igniteAt : 0;
      mx += (tmx - mx) * 0.05; my += (tmy - my) * 0.05;
      ctx!.clearRect(0, 0, W, H);

      const conv = reduced ? 1 : Math.max(0, Math.min(1, (t - GATHER_START) / GATHER_LEN));
      const px = (v: number) => ox + v * scale + mx * 9;
      const py = (v: number) => oy + v * scale + my * 9;
      const fade = ignite ? Math.max(0, 1 - it * 1.9) : 1;

      // --- spotlight pool she stands in ---
      if (conv > 0.25) {
        const a = Math.min(1, (conv - 0.25) / 0.5) * 0.5 * fade;
        const gx = px(50), gy = py(MAXYP() + 1.5);
        const rg = ctx!.createRadialGradient(gx, gy, 0, gx, gy, 46 * scale);
        rg.addColorStop(0, `rgba(90,200,175,${0.20 * a})`);
        rg.addColorStop(0.45, `rgba(60,150,140,${0.08 * a})`);
        rg.addColorStop(1, "rgba(0,0,0,0)");
        ctx!.globalCompositeOperation = "source-over";
        ctx!.fillStyle = rg;
        ctx!.save();
        ctx!.translate(gx, gy); ctx!.scale(1, 0.17); ctx!.translate(-gx, -gy);
        ctx!.beginPath(); ctx!.arc(gx, gy, 46 * scale, 0, Math.PI * 2); ctx!.fill();
        ctx!.restore();
      }

      // --- assemble ---
      const breathe = reduced ? 0 : Math.sin(t * 0.85) * 0.3;
      for (const p of pts) {
        const local = Math.max(0, Math.min(1, (conv - p.delay * 0.5) / (1 - p.delay * 0.5 || 1)));
        const e = easeOutCubic(local);
        p.x = p.sx + (p.tx - p.sx) * e;
        p.y = p.sy + (p.ty - p.sy) * e;
        if (e >= 1 && !reduced) p.y += breathe * (1 - p.ty / 100) * 0.45;
      }

      // --- the mesh ---
      if (conv > 0.5) {
        const ea = Math.min(1, (conv - 0.5) / 0.5) * fade;
        ctx!.globalCompositeOperation = "source-over";
        ctx!.lineWidth = 0.8;
        ctx!.strokeStyle = `rgba(125,225,195,${0.17 * ea})`;
        ctx!.beginPath();
        for (const [a, b] of mesh.edges) {
          ctx!.moveTo(px(pts[a].x), py(pts[a].y));
          ctx!.lineTo(px(pts[b].x), py(pts[b].y));
        }
        ctx!.stroke();
        // the silhouette itself reads brighter than the interior facets
        ctx!.lineWidth = 1.25;
        ctx!.strokeStyle = `rgba(175,255,230,${0.42 * ea})`;
        ctx!.beginPath();
        for (let i = 0; i < mesh.rimCount; i++) {
          const p = pts[i], q = pts[(i + 1) % mesh.rimCount];
          if (i === 0) ctx!.moveTo(px(p.x), py(p.y));
          ctx!.lineTo(px(q.x), py(q.y));
        }
        ctx!.stroke();
        // tail + ear hairs, drawn from the assembled points so they move with them
        ctx!.lineWidth = 0.9;
        ctx!.strokeStyle = `rgba(175,255,230,${0.30 * ea})`;
        ctx!.beginPath();
        for (const [a, b] of mesh.hairEdges) {
          ctx!.moveTo(px(pts[a].x), py(pts[a].y));
          ctx!.lineTo(px(pts[b].x), py(pts[b].y));
        }
        ctx!.stroke();
      }

      // --- vertices ---
      ctx!.globalCompositeOperation = "lighter";
      for (const p of pts) {
        let x = px(p.x), y = py(p.y);
        let alpha = (p.rim ? 0.75 : p.hair ? 0.4 : 0.45) + 0.3 * Math.sin(t * 2 + p.tw) * 0.35 + 0.2 * conv;
        let size = (p.rim ? 1.9 : p.hair ? 1.1 : 1.4) + 1.1 * conv;
        if (ignite) {
          if (p.vx === 0 && p.vy === 0) {
            const a = Math.atan2(y - py(50), x - px(50)) + (Math.random() - 0.5) * 0.5;
            const sp = 90 + Math.random() * 280;
            p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
          }
          const k = it * it;
          x += p.vx * k; y += p.vy * k;
          size += it * 5;
          alpha *= Math.max(0, 1 - it * 1.25);
        }
        ctx!.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx!.drawImage(sprite, x - size * 3, y - size * 3, size * 6, size * 6);
      }

      if (ignite) {
        ctx!.globalCompositeOperation = "source-over";
        ctx!.globalAlpha = 1;
        const flash = Math.max(0, Math.min(1, (it - 0.35) / 0.5));
        if (flash > 0) { ctx!.fillStyle = `rgba(241,245,249,${flash})`; ctx!.fillRect(0, 0, W, H); }
      }
      ctx!.globalAlpha = 1;
      ctx!.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", layout);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />;
}
