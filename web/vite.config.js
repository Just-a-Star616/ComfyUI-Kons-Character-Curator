import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://127.0.0.1:8700';
export default defineConfig({plugins: [react()], server: {proxy: {'/api': api, '/data': api}}});
