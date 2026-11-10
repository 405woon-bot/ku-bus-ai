/** KU Bus 팔레트(지정 11색) + 상태색(파생) */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#206DEF', active: '#0057CD', soft: '#EDF3FE', line: '#C7DAFB' },
        bus: { DEFAULT: '#4A92EB', soft: '#E9F2FD' },
        surface: '#F9F9F9',
        panel: '#FFFFFF',
        ink: { DEFAULT: '#222222', muted: '#888888' },
        line: '#E5E5E5',
        road: { DEFAULT: '#FECA7D', edge: '#E7AD55' },
        park: '#D0E2C2',
        building: { DEFAULT: '#DCE9F1', edge: '#BFD1DD' },
        ok: { DEFAULT: '#1E7B45', soft: '#E6F4EC' },
        warn: { DEFAULT: '#A35F00', soft: '#FFF3DD' },
        danger: { DEFAULT: '#D0342C', soft: '#FDECEB' },
        branch: '#3E9B4F',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans KR"', '"Apple SD Gothic Neo"', '"Malgun Gothic"', '"Noto Sans KR"', '"Noto Sans CJK KR"', 'system-ui', 'sans-serif'],
        num: ['"Barlow Semi Condensed"', '"Arial Narrow"', '"IBM Plex Sans KR"', '"Noto Sans CJK KR"', 'sans-serif'],
      },
      boxShadow: { card: '0 1px 2px rgba(34,34,34,.05), 0 6px 18px rgba(34,34,34,.06)', pop: '0 12px 36px rgba(34,34,34,.18)' },
    },
  },
  plugins: [],
};
