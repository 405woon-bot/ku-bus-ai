import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

// mode 'single' : 데모용 단일 HTML(서버 없이 모의 데이터로 동작)
// 기본 build    : 백엔드(/api)와 함께 배포하는 일반 빌드
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  resolve: { alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) } },
  server: { fs: { allow: ['..'] }, proxy: { '/api': 'http://localhost:8787' } },
  define: { __DATA_MODE__: JSON.stringify(mode === 'single' ? 'mock' : 'api') },
  build: { outDir: mode === 'single' ? 'dist-single' : 'dist', assetsInlineLimit: 100000000 },
}));
