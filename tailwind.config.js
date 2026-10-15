/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.ts'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        osu: { pink: '#ff66aa', cyan: '#22d3ee', dark: '#0b0e17', panel: '#121726', card: '#181f33', border: '#26304d' },
      },
    },
  },
  plugins: [],
};
