import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
export default defineConfig({root,plugins:[react(),{name:'web-typescript-check',apply:'build',buildStart(){execFileSync(process.execPath,[join(dirname(require.resolve('typescript/package.json')),'bin','tsc'),'-p',join(root,'tsconfig.json'),'--noEmit'],{stdio:'inherit'});}}],build:{outDir:join(root,'dist'),emptyOutDir:true},server:{host:'127.0.0.1',port:5173,proxy:{'/api':{target:'http://127.0.0.1:4317',changeOrigin:true}}}});
