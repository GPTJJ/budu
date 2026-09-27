#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = path.join(root, 'brand/source/budu-wordmark.pdf')
const svg = path.join(root, 'brand/web/budu-wordmark.svg')
const png = path.join(root, 'brand/document/budu-wordmark-1600.png')
const expectedSourceHash = '25a4911c83fdf79d75eea023333be89700aaafb8e2aa5a275d9c6d249208b209'
const expectedViewBox = '222.5192 233.8839 396.8512 127.5082'

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

if (sha256(source) !== expectedSourceHash) throw new Error('Canonical budu logo source hash mismatch')
const svgText = fs.readFileSync(svg, 'utf8')
if (!svgText.includes(`viewBox="${expectedViewBox}"`)) throw new Error('Canonical budu wordmark viewBox mismatch')
if (/<text\b/i.test(svgText)) throw new Error('Canonical budu wordmark derivative must remain vector paths')

fs.mkdirSync(path.dirname(png), { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 512 }, deviceScaleFactor: 1 })
  await page.setContent('<!doctype html><html><style>html,body{margin:0;width:1600px;height:512px;background:transparent}img{display:block;width:1600px;height:512px}</style><body><img id="logo"></body></html>')
  await page.locator('#logo').evaluate((image, value) => { image.src = value }, `data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}`)
  await page.locator('#logo').waitFor({ state: 'visible' })
  await page.screenshot({ path: png, omitBackground: true })
} finally {
  await browser.close()
}

process.stdout.write(`${JSON.stringify({ source: expectedSourceHash, svg: sha256(svg), png: sha256(png), width: 1600, height: 512 })}\n`)
