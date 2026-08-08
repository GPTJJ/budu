/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#F5F5F7',
        surface: '#FFFFFF',
        border: '#E5E5EA',
        budu: {
          50: '#FBF1F6',
          100: '#F7E2EC',
          200: '#EFC6D8',
          300: '#E19DBB',
          400: '#CF7099',
          500: '#BC4F7E',
          600: '#A13966',
          700: '#842C53',
          800: '#682446',
          900: '#521D3A',
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
        sans: ['-apple-system', 'BlinkMacSystemFont', '"PingFang SC"', '"Microsoft YaHei"', '"Noto Sans SC"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 15, 25, 0.04), 0 1px 3px rgba(15, 15, 25, 0.06)',
        'card-hover': '0 2px 4px rgba(15, 15, 25, 0.05), 0 4px 12px rgba(15, 15, 25, 0.08)',
        subtle: '0 1px 2px rgba(15, 15, 25, 0.05)',
        modal: '0 8px 30px rgba(15, 15, 25, 0.12)',
      },
    },
  },
  plugins: [],
}
