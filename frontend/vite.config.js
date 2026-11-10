import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

// 기본 build        : 백엔드(/api, 서울시 실시간)와 함께 배포하는 실제 서비스 빌드
// build --mode preview : 서버 없이 여는 단일 HTML 미리보기(서울시 API 형식의 샘플 응답을 재생, '실시간 아님' 표시)
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'preview' ? [viteSingleFile()] : [])],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
      // 샘플 응답은 미리보기 빌드에만 포함 — 실서비스 번들에는 모의 데이터가 없습니다.
      '@source': fileURLToPath(new URL(mode === 'preview' ? './src/lib/sampleSource.js' : './src/lib/noSample.js', import.meta.url)),
    },
  },
  server: { fs: { allow: ['..'] }, proxy: { '/api': 'http://localhost:8787' } },
  define: { __DATA_MODE__: JSON.stringify(mode === 'preview' ? 'sample' : 'api') },
  build: { outDir: mode === 'preview' ? 'dist-preview' : 'dist', assetsInlineLimit: 100000000 },
}));
