import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Hosted builds must not load the Mac's gitignored .env.local.
  envDir: process.env.HUB_HOSTED_BUILD === '1' ? 'hosted-env-empty' : undefined,
});
