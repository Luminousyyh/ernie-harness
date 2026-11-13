import { defineConfig } from 'vitest/config';
export default defineConfig({test:{maxWorkers:4,include:['tests/**/*.test.ts'],testTimeout:15000,hookTimeout:15000}});
