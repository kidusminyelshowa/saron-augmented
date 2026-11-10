import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [
    // HTTPS is required for camera access on mobile devices
    basicSsl(),
  ],
  server: {
    // Expose to network so you can test on your phone
    host: true,
    // Use HTTPS (required for getUserMedia on non-localhost)
    https: {},
  },
  // Ensure .mind files are served correctly as static assets
  assetsInclude: ['**/*.mind'],
  define: {
    // Shown in the ?debug=1 readout, to confirm which build a phone is running.
    __BUILD_ID__: JSON.stringify((process.env.VERCEL_GIT_COMMIT_SHA ?? 'local').slice(0, 7)),
  },
});
