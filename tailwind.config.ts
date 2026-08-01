import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Haystack-style blue (primary = brand-600 #337AB7, bright accent = #3598DC).
        // The whole app themes off this scale via globals.css (@apply bg-brand-600
        // etc.), so this one block re-colours buttons, links, inputs, badges, nav.
        brand: {
          50: "#eef6fc",
          100: "#d6e8f6",
          200: "#afd0ec",
          300: "#80b4e0",
          400: "#5098d3",
          500: "#3a8fce",
          600: "#337ab7",
          700: "#2b6396",
          800: "#254f77",
          900: "#20425f",
        },
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Arial", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
