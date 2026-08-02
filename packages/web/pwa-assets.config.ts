import { defineConfig } from '@vite-pwa/assets-generator/config'

// PWA icon set generator (#40). One source (public/favicon.svg — the brand mark)
// → the full set, written next to the source in public/ and committed. We
// generate ONCE and ship the PNGs rather than letting vite-plugin-pwa rasterize
// at build time, so the production Docker build (and `npm run build`) never needs
// sharp. Regenerate after editing the source:  npm run pwa:assets -w @notarium/web
//
// padding:0 + the accent background: the source is already a full-bleed accent
// square with the glyph centred inside the maskable safe zone, so no extra frame
// is added — the maskable/apple variants stay edge-to-edge accent, not a white
// border around a smaller square.
export default defineConfig({
  preset: {
    transparent: { sizes: [64, 192, 512], favicons: [[48, 'favicon.ico']] },
    maskable: { sizes: [512], padding: 0, resizeOptions: { background: '#6d4ee0' } },
    apple: { sizes: [180], padding: 0, resizeOptions: { background: '#6d4ee0' } },
  },
  images: ['public/favicon.svg'],
})
