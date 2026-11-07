import { defineConfig } from 'vite'

// Tauri 需要固定端口与可预测的产物目录，见 src-tauri/tauri.conf.json
export default defineConfig({
  root: 'src/renderer',
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
