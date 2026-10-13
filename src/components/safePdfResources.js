// Fixed, packaged resources from pdfjs-dist 6.4.299. The official worker checks
// built-in CMap names and maps standard font names to its fixed filenames.
const base = `${import.meta.env.BASE_URL}pdfjs/6.4.299/`
export const pdfResourceOptions = Object.freeze({
  cMapUrl: `${base}cmaps/`, cMapPacked: true,
  standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`,
  iccUrl: `${base}iccs/`,
  useWorkerFetch: true, useWasm: true,
})

// These are the official static TextAnnotation icons in public/pdfjs/6.4.299/images.
export const annotationIcons = new Set(['check', 'comment', 'help', 'insert', 'key', 'newparagraph', 'note', 'paragraph'])
