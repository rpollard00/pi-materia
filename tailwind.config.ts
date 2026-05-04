import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/webui/client/index.html', './src/webui/client/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      backgroundImage: {
        'radial-socket': 'radial-gradient(circle at 50% 42%, rgba(14, 116, 144, 0.34), rgba(15, 23, 42, 0.96) 62%, rgba(2, 6, 23, 1))',
      },
    },
  },
  plugins: [],
};

export default config;
