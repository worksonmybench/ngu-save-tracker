import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// connect-src 'none' is what backs the "saves never leave your browser" claim:
// the built page cannot make network requests. Build-only, since dev needs HMR.
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export default defineConfig({
  base: './',
  plugins: [
    preact(),
    {
      name: 'csp',
      apply: 'build',
      transformIndexHtml: (html) =>
        html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
    },
  ],
  test: { environment: 'node' },
});
