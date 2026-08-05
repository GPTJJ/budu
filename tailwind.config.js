/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        budu: {
          50: '#FDF4F7',
          100: '#FBE8EF',
          200: '#F7D1E0',
          300: '#F0A9C7',
          400: '#E678A6',
          500: '#D9508B',
          600: '#C0336E',
          700: '#A02558',
          800: '#84204A',
          900: '#6E1F41',
        },
        grape: {
          50: '#F6F3FE',
          100: '#EDE7FD',
          200: '#DCCFFA',
          300: '#C0A8F5',
          400: '#A078EE',
          500: '#8550E4',
          600: '#7335D4',
          700: '#6227B4',
          800: '#512193',
          900: '#431E78',
        },
      },
      fontFamily: {
        sans: ['"PingFang SC"', '"Microsoft YaHei"', '"Noto Sans SC"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(108, 66, 130, 0.04), 0 6px 24px rgba(108, 66, 130, 0.06)',
        'card-hover': '0 2px 4px rgba(108, 66, 130, 0.06), 0 10px 32px rgba(108, 66, 130, 0.1)',
      },
    },
  },
  plugins: [],
}
