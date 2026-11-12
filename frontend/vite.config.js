import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  if (command === 'build' && !env.VITE_API_BASE_URL) {
    throw new Error(
      'VITE_API_BASE_URL is required for production builds. ' +
        'Set it to the deployed API origin including /api, for example ' +
        'VITE_API_BASE_URL=https://api.example.com/api npm run build'
    )
  }
  return {
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          // Split stable third-party code into long-lived chunks so an
          // application-code change does not invalidate the React runtime in
          // every visitor's browser cache.
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react-vendor";
            if (id.includes("node_modules/lucide-react/")) return "icons";
            return undefined;
          },
        },
      },
    },
  }
})
