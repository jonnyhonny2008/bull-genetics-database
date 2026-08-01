import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Palette matched to the Haystack portal (Flat-UI colours):
        //   brand = TEAL primary (buttons, links, active nav, chart line)
        //   navy  = dark sidebar/header chrome
        //   accent = orange highlight
        // The app themes off brand-* via globals.css, so that scale drives
        // buttons / links / inputs / badges everywhere.
        brand: {
          // Turquoise / Green Sea
          50: "#e8f8f5",
          100: "#d0ece7",
          200: "#a2d9ce",
          300: "#73c6b6",
          400: "#45b39d",
          500: "#1abc9c",
          600: "#16a085",
          700: "#128f76",
          800: "#0e7d67",
          900: "#0b5f4e",
        },
        navy: {
          // Midnight Blue / Wet Asphalt
          50: "#f4f6f7",
          100: "#e5e8eb",
          200: "#c8ced5",
          300: "#9aa5b1",
          400: "#5d6d7e",
          500: "#3d566e",
          600: "#34495e",
          700: "#2c3e50",
          800: "#273746",
          900: "#1f2d3a",
        },
        accent: {
          // Carrot orange
          50: "#fdf2e9",
          100: "#fae5d3",
          200: "#f5cba7",
          300: "#f0b27a",
          400: "#eb984e",
          500: "#e67e22",
          600: "#ca6f1e",
          700: "#a5641b",
          800: "#7e4e15",
          900: "#6e2c00",
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
