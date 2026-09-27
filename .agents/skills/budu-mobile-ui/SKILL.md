---
name: budu-mobile-ui
description: Use automatically for BUDU frontend, UI, responsive layout, mobile, iPhone, iPad, WebKit, POS interface, Bottom Sheet, navigation, cards, forms, or visual interaction changes. Do not expand a display-only task into data or business-logic refactoring.
---

# BUDU Mobile UI

Preserve the BUDU visual language: white primary surfaces, very light pink support, rose-pink primary actions, deep blue-gray text, generous rounded corners, light borders/shadows, and clear whitespace. Avoid dense traditional-ERP presentation.

Prioritize business information over technical fields. For products: product name → price → business state → SKU → sort order.

- Use solid BUDU rose pink for primary actions.
- Use light or outlined styles for tools.
- Use a distinct danger color for destructive actions.
- Prefer Bottom Sheets for secondary mobile actions when appropriate.

## Required Responsive Checks

Check 320, 340, 375, 390, and 430 px widths, plus iPad/WebKit and desktop when affected. Verify no horizontal overflow, bottom-navigation overlap, sticky-action overlap, safe-area error, keyboard-obscured confirmation action, or long-name truncation caused by lower-priority IDs/SKUs.

For shared sheets/modals, verify overlay stacking, background interaction lock, internal scrolling, keyboard recovery, and `safe-area-inset-bottom`. Keep UI-only work UI-only.
