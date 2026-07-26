import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0f7f4",
          100: "#dcebe3",
          200: "#bcd8ca",
          300: "#8fbda8",
          400: "#5e9c82",
          500: "#3f7f66",
          600: "#2f6551",
          700: "#285142",
          800: "#234137",
          900: "#1f3730",
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
