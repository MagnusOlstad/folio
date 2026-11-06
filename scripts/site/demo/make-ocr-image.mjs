// Renders a fictional printed recipe card to PNG (photo-like: paper, shadow, slight rotation) for the OCR screenshots.
//   node scripts/site/demo/make-ocr-image.mjs [--out file.png]
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const outIdx = process.argv.indexOf('--out')
const defaultOut = path.join(process.env.TMPDIR || '/tmp', 'folionotes-demo-card.png')

const html = `<!doctype html><html><body style="margin:0;width:1600px;height:880px;overflow:hidden;
background:
  repeating-linear-gradient(92deg, rgba(60,35,15,.10) 0 2px, transparent 2px 9px),
  repeating-linear-gradient(88deg, rgba(255,235,200,.07) 0 3px, transparent 3px 14px),
  linear-gradient(120deg,#9a7249,#7d5732 55%,#8b6439);position:relative">
<div style="position:absolute;left:210px;top:85px;width:1180px;height:710px;transform:rotate(-1.6deg);
  background:radial-gradient(ellipse at 30% 20%,#fffdf6,#f7f0dd 70%,#efe5c9);
  box-shadow:0 30px 60px rgba(0,0,0,.45),0 4px 10px rgba(0,0,0,.35);padding:60px 80px;box-sizing:border-box;
  font-family:Georgia,'Times New Roman',serif;color:#2a2118">
  <div style="border:3px double #8a3b2a;position:absolute;inset:26px"></div>
  <div style="position:relative">
    <div style="font-size:66px;font-weight:bold;letter-spacing:1px;color:#7a2f1f;text-align:center">Cardamom Buns</div>
    <div style="font-size:30px;text-align:center;margin:8px 0 26px;font-style:italic">Makes 12 buns. Bake at 200 C for 18 minutes.</div>
    <div style="display:flex;gap:60px">
      <div style="width:44%">
        <div style="font-size:36px;font-weight:bold;border-bottom:2px solid #8a3b2a;margin-bottom:12px">Ingredients</div>
        <div style="font-size:32px;line-height:1.5">500 g plain flour<br>250 ml warm milk<br>75 g sugar<br>75 g soft butter<br>7 g dry yeast<br>2 tsp ground cardamom<br>1 egg, for brushing</div>
      </div>
      <div style="flex:1">
        <div style="font-size:36px;font-weight:bold;border-bottom:2px solid #8a3b2a;margin-bottom:12px">Method</div>
        <div style="font-size:32px;line-height:1.5">1. Stir the yeast into the warm milk.<br>2. Knead all ingredients for 10 minutes.<br>3. Let the dough rise for 1 hour.<br>4. Shape 12 buns and rise 30 minutes.<br>5. Brush with egg and bake until golden.</div>
      </div>
    </div>
  </div>
</div></body></html>`

export async function renderCard(out) {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 880 } })
  await page.setContent(html)
  await page.screenshot({ path: out })
  await browser.close()
  return out
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await renderCard(outIdx > -1 ? process.argv[outIdx + 1] : defaultOut))
