/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./public/**/*.html', './public/**/*.js'],
  theme: {
    extend: {}
  },
  safelist: [
    { pattern: /^(bg|hover:bg)-(red|yellow)-(500|600)$/ }
  ],
  plugins: []
};
