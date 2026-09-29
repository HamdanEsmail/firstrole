import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(async ({ command, mode }) => ({
  plugins: [
    react(),
    ...(command === 'serve' && mode === 'ui-test'
      ? [(await import('./tests/ui/plugin.ts')).uiTestPlugin()]
      : []),
  ],
  server: {
    strictPort: true,
    port: mode === 'ui-test' ? 5174 : 5173,
    proxy: mode === 'ui-test' ? undefined : { '/api': 'http://127.0.0.1:8787' },
    watch: { ignored: ['**/docs/**', '**/artifacts/**', '**/supabase/**'] },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'supabase', test: /node_modules\/@supabase/ },
            { name: 'react', test: /node_modules\/(react|react-dom|scheduler)\// },
          ],
        },
      },
    },
  },
}));
