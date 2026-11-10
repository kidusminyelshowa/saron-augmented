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
});
