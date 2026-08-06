"use client";

import { useState, useTransition } from "react";
import { toggleFavourite } from "@/app/(app)/animals/favourites-actions";

// A star toggle backed by the Watchlist. Optimistic-ish: flips immediately and
// reconciles with the server's authoritative result.
export default function FavouriteStar({ animalId, initial, size = "md" }: { animalId: string; initial: boolean; size?: "sm" | "md" | "lg" }) {
  const [fav, setFav] = useState(initial);
  const [pending, start] = useTransition();
  const cls = size === "lg" ? "text-2xl" : size === "sm" ? "text-sm" : "text-lg";
  return (
    <button
      type="button"
      aria-pressed={fav}
      aria-label={fav ? "Remove from favourites" : "Add to favourites"}
      title={fav ? "Favourited — click to remove" : "Add to favourites"}
      disabled={pending}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = !fav;
        setFav(next); // optimistic
        start(async () => {
          try {
            const r = await toggleFavourite(animalId);
            setFav(r.favourited);
          } catch {
            setFav(!next); // revert on failure
          }
        });
      }}
      className={`${cls} leading-none transition ${fav ? "text-amber-400 hover:text-amber-500" : "text-slate-300 hover:text-amber-300"} ${pending ? "opacity-60" : ""}`}
    >
      {fav ? "★" : "☆"}
    </button>
  );
}
