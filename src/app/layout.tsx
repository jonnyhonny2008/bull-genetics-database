import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bull Stud Genetics Intelligence Platform",
  description: "Phase 1 — Historical Genetic Proof Database",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
