import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
// Normal multi-file build for Cloudflare. SINGLEFILE=1 inlines everything into one HTML (used for the claude.ai demo).
export default defineConfig({ plugins: [react(), ...(process.env.SINGLEFILE ? [viteSingleFile()] : [])] })
