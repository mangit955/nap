/**
 * Tailwind v4 hooks into the build through a PostCSS plugin rather than a config file;
 * the theme itself lives in src/app/globals.css.
 */
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
