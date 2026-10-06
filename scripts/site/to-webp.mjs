// Converts every PNG in the screenshots dir to WebP using Chromium's encoder (no cwebp needed).
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { here, argValue } from './lib.mjs'
const dir = path.resolve(argValue('--dir', path.join(here, '..', '..', 'site', 'assets', 'screenshots')))
const browser = await chromium.launch()
const page = await browser.newPage()
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.png'))) {
  const b64 = fs.readFileSync(path.join(dir, f)).toString('base64')
  const webp = await page.evaluate(async (data) => {
    const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode()
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
    c.getContext('2d').drawImage(img, 0, 0)
    return c.toDataURL('image/webp', 0.92).split(',')[1]
  }, b64)
  fs.writeFileSync(path.join(dir, f.replace(/\.png$/, '.webp')), Buffer.from(webp, 'base64'))
  console.log(f, '->', fs.statSync(path.join(dir, f.replace(/\.png$/, '.webp'))).size)
}
await browser.close()
