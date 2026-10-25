import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {loadConfig} from './src/core/config.ts';
// Keep the frontend on the same configured backend as the source checkout.
// A developer checkout may coexist with an installed desktop on port 4317.
// Keep shared dependencies in their own cacheable chunk instead of one large application transform.
// This also avoids esbuild's >1 MiB temporary-file transport on Windows builds.
export default defineConfig({plugins:[react()],build:{outDir:'dist',rollupOptions:{output:{manualChunks(id){
  if(id.replaceAll('\\','/').includes('/node_modules/'))return 'vendor';
}}}},server:{host:'127.0.0.1',proxy:{'/api':`http://127.0.0.1:${loadConfig().port}`}}});
