"use client";

// A horizontally scrollable region with a MIRROR scrollbar pinned at its top.
//
// Wide tables normally put the scrollbar at the very bottom, so panning means
// scrolling the page down first. This renders a second scrollbar directly above
// the content and keeps the two in sync, so side-to-side scrolling is always
// reachable right where you are looking. The mirror hides itself when the
// content already fits.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export function HScroll({
  children,
  className = "",
  label,
  stickyTop = false,
}: {
  children: ReactNode;
  className?: string;
  /** Optional hint shown beside the mirror bar when scrolling is possible. */
  label?: string;
  /** Keep the mirror bar pinned to the top of the viewport while scrolling a
   *  long list, so side-to-side scrolling stays reachable at any row. */
  stickyTop?: boolean;
}) {
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollW, setScrollW] = useState(0);
  const [needed, setNeeded] = useState(false);
  // Guards the two-way sync so each element doesn't echo the other's scroll.
  const lock = useRef<"top" | "body" | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const update = () => {
      setScrollW(el.scrollWidth);
      setNeeded(el.scrollWidth > el.clientWidth + 1);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    window.addEventListener("resize", update);
    return () => { ro.disconnect(); window.removeEventListener("resize", update); };
  }, [children]);

  const onTopScroll = useCallback(() => {
    if (lock.current === "body") { lock.current = null; return; }
    lock.current = "top";
    if (bodyRef.current && topRef.current) bodyRef.current.scrollLeft = topRef.current.scrollLeft;
  }, []);
  const onBodyScroll = useCallback(() => {
    if (lock.current === "top") { lock.current = null; return; }
    lock.current = "body";
    if (bodyRef.current && topRef.current) topRef.current.scrollLeft = bodyRef.current.scrollLeft;
  }, []);

  // Shift + wheel pans horizontally, which is the habit most people already have.
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!e.shiftKey || !bodyRef.current) return;
    const el = bodyRef.current;
    if (el.scrollWidth <= el.clientWidth) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  }, []);

  return (
    <div className={className}>
      {needed && (
        <div className={`flex items-center gap-2 ${stickyTop ? "sticky top-0 z-20 border-b border-slate-200 bg-white py-1" : ""}`}>
          <div
            ref={topRef}
            onScroll={onTopScroll}
            className="h-3 flex-1 overflow-x-auto overflow-y-hidden"
            style={{ scrollbarWidth: "thin" }}
            aria-hidden
          >
            <div style={{ width: scrollW, height: 1 }} />
          </div>
          {label && <span className="shrink-0 text-[10px] text-slate-400">↔ {label}</span>}
        </div>
      )}
      <div ref={bodyRef} onScroll={onBodyScroll} onWheel={onWheel} className="overflow-x-auto">
        {children}
      </div>
    </div>
  );
}
