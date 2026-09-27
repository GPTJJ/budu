# budu Brand Specification

## Canonical authority

- User-visible brand name: `budu` (lowercase).
- Canonical wordmark source: `brand/source/budu-wordmark.pdf`.
- Source SHA-256: `25a4911c83fdf79d75eea023333be89700aaafb8e2aa5a275d9c6d249208b209`.
- Source format: one-page PDF 1.3, Adobe Illustrator vector paths, no fonts and no raster images.
- The source wordmark is the only geometry authority. Do not redraw it with text or another font.

## Measured geometry

Measurements below come from the PDF path objects, not from a screenshot.

| Property | Value |
|---|---:|
| PDF media box | 841.890 × 595.276 pt |
| Actual vector bounds | x 222.5192–619.3704; y 233.8839–361.3921 pt |
| Wordmark width | 396.8512 pt |
| Wordmark height | 127.5082 pt |
| Aspect ratio | 3.11235:1 |
| Original fill | DeviceCMYK 0.906 / 0.879 / 0.871 / 0.789 |
| Controlled sRGB derivative | `#050707` |
| Background | Transparent outside the vector paths |

The SVG derivative uses the exact source path coordinates and measured crop. Never change its `viewBox`, path coordinates, or aspect ratio independently.

## Controlled derivatives

- Web/vector: `brand/web/budu-wordmark.svg`.
- Document/raster: `brand/document/budu-wordmark-1600.png` (transparent, 1600 × 512 px).
- Regeneration and verification: `node scripts/generate-budu-brand-assets.mjs`.

Do not create additional independent logo files. A new delivery format should consume the SVG or a derivative produced by the generator.

## System brand slot icon

The application sidebar and mobile drawer pair the unchanged canonical wordmark with the user-approved simple character icon. The icon is a separate decorative asset; it does not replace or redraw the `budu` wordmark.

- Approved source: `brand/source/budu-brand-slot-icon-source.png` (transparent 1080 × 1080 px).
- Source SHA-256: `0a64969e00313d33093734f6438720206c832e730289c2b73309097aa8083745`.
- Web derivative: `brand/web/budu-brand-slot-icon.png` (transparent 462 × 462 px).
- Web derivative SHA-256: `cf6222f41ca8731295cc6bd2e7dde6346920f56a6d41e4ce4d81f953070d93a2`.
- Processing is limited to transparent cropping with balanced clear space; the source pixels are not redrawn, recolored, stretched, or compressed.

The authoritative application lockup is `src/components/BrandSlot.jsx`. Desktop navigation and the mobile drawer must consume this component rather than duplicating the assets. The former subtitle `甜蜜治愈日常` is intentionally absent from this brand position.

## Safe area and minimum size

Safe area is derived from the wordmark's measured height (`1H`): keep at least `0.25H` clear on every side. This preserves the open counters and the source spacing without inventing a new lockup.

Minimum tested rendered widths:

- Mobile/web navigation: 80 px.
- Desktop/web navigation: 96 px.
- Email raster: 120 px.
- A4/PDF cover: 32 mm.

At smaller sizes, use a product icon or favicon rather than compressing or retyping the wordmark.

## Typography and color

- The brand wordmark is always the asset, never live text styled to imitate it.
- Product names may use `budu` as normal lowercase text when the context is prose, a filename, subject line, or technical label rather than a formal logo position.
- Use the existing application/document font stack for all non-logo text.
- Existing rose-pink design tokens remain the product accent. The canonical wordmark keeps its own source color and must not be recolored casually.

## Prohibited use

Do not stretch, compress, rotate, skew, outline, add letter spacing, change case, replace the paths with a font, or expose the wordmark over an unreadable background. Historical identifiers such as SKU prefixes, employee numbers, database enums, internal constants, and payment-provider identifiers are not renamed by this specification.
