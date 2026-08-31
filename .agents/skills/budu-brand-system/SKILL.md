---
name: budu-brand-system
description: Use automatically for BUDU user-visible or external-facing UI, mobile, PDF, email, export, report, document, POS display, mini-program, print, or sharing output. Enforce the lowercase `budu` name and canonical wordmark assets without renaming internal identifiers or redesigning unrelated product surfaces.
---

# budu Brand System

Apply this Skill only to user-visible and external-facing presentation. Preserve business authority, routes, permissions, interactions and historical identifiers.

## Brand authority

- The formal name is always lowercase `budu`.
- Formal logo positions must use `brand/source/budu-wordmark.pdf` or a controlled derivative. Never typeset a replacement wordmark.
- Preserve the source geometry, aspect ratio, color and transparent background.
- Read [brand specification](../../../docs/brand/budu-brand-spec.md) before creating or changing a logo-bearing output.

## Output rules

- UI/mobile/POS/mini-program: use the SVG derivative and existing budu design tokens. Do not trigger a broad visual redesign.
- PDF/document/print: use the vector derivative where supported; use the controlled transparent PNG only where raster output is required.
- Email/report/export filenames and prose: write `budu` in lowercase. Do not expose implementation identifiers or secrets.
- Existing body typography remains the current product or document font stack. Never install a font to imitate the wordmark.

## Boundaries

Do not rename database enums, code constants, class/function names, stable employee/product identifiers, SKU prefixes, provider identifiers, historical records, or third-party content merely because they contain `BUDU` or `Budu`.

For a brand audit, classify findings as `USER_VISIBLE_FIX_REQUIRED`, `INTERNAL_KEEP`, or `HISTORICAL_KEEP`; edit only the first class when the change is low-risk and in scope. Validate the relevant desktop/mobile/PDF/email surface after a logo or naming change.
