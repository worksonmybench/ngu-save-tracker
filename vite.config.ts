import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// Backs the "saves never leave your browser" claim: the built page can make no network requests
// except Cloudflare Web Analytics, whose beacon reports page loads (address, timing, browser), not
// save data. The app's own code makes no requests at all. Build-only, since dev needs HMR.
const ANALYTICS_SCRIPT = 'https://static.cloudflareinsights.com';
const ANALYTICS_REPORT = 'https://cloudflareinsights.com';
const CSP = `default-src 'self'; script-src 'self' ${ANALYTICS_SCRIPT}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${ANALYTICS_REPORT}; object-src 'none'; base-uri 'none'; form-action 'none'`;

// Cloudflare static assets read dist/_headers. Headers can also forbid framing, which a <meta> CSP can't.
// Built assets have content hashes in their names, so they can be cached for good.
const HEADERS = `/*
  Content-Security-Policy: ${CSP}; frame-ancestors 'none'
  Strict-Transport-Security: max-age=63072000; includeSubDomains
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()
  Cross-Origin-Opener-Policy: same-origin

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;

export default defineConfig({
  base: './',
  plugins: [
    preact(),
    {
      name: 'csp',
      apply: 'build',
      transformIndexHtml: (html) =>
        html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: '_headers', source: HEADERS });
      },
    },
  ],
  test: { environment: 'node' },
});
