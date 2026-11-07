// Generates Screen Scout's tray + app icons as PNGs without external tools.
// Renders the brand mark (emerald viewfinder on a dark rounded plate) with
// supersampled SDF rasterization, then encodes PNG with node:zlib.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, '..', 'assets')

// ---------------------------------------------------------------- PNG encode
function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// ---------------------------------------------------------------- SDF helpers
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

function roundedRectSDF(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ox, oy) - r
}

function segmentDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax
  const aby = by - ay
  const apx = px - ax
  const apy = py - ay
  const t = clamp((apx * abx + apy * aby) / (abx * abx + aby * aby), 0, 1)
  return Math.hypot(apx - abx * t, apy - aby * t)
}

function mix(a, b, t) {
  return a.map((v, i) => v + (b[i] - v) * t)
}

// ---------------------------------------------------------------- icon render
function renderIcon(size) {
  const SS = 4 // supersampling
  const W = size * SS
  const rgba = Buffer.alloc(size * size * 4)

  const cx = W / 2
  const cy = W / 2
  const hw = W * 0.47
  const hh = W * 0.47
  const radius = W * 0.22
  const borderW = Math.max(1.5 * SS, W * 0.045)

  const emeraldTop = [0x2d, 0xf5, 0x98]
  const emeraldBottom = [0x0f, 0x9d, 0x58]
  const emerald = [0x22, 0xe8, 0x87]
  const plateTop = [0x10, 0x18, 0x13]
  const plateBottom = [0x0a, 0x0f, 0x0c]

  // viewfinder geometry (in icon units of W)
  const inset = W * 0.26
  const len = W * 0.13
  const strokeW = W * 0.052
  const ringR = W * 0.135
  const ringW = W * 0.05
  const dotR = W * 0.048

  const segs = []
  // four corner brackets
  const corners = [
    [cx - inset, cy - inset, cx - inset + len, cy - inset],
    [cx - inset, cy - inset, cx - inset, cy - inset + len],
    [cx + inset, cy - inset, cx + inset - len, cy - inset],
    [cx + inset, cy - inset, cx + inset, cy - inset + len],
    [cx - inset, cy + inset, cx - inset + len, cy + inset],
    [cx - inset, cy + inset, cx - inset, cy + inset - len],
    [cx + inset, cy + inset, cx + inset - len, cy + inset],
    [cx + inset, cy + inset, cx + inset, cy + inset - len]
  ]
  for (const [ax, ay, bx, by] of corners) segs.push([ax, ay, bx, by])

  const samples = new Float64Array(W * W * 4) // r,g,b,a accumulators

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const plateD = roundedRectSDF(px, py, cx, cy, hw, hh, radius)

      if (plateD > 1.5) continue // fully outside

      // start with plate / border color
      let color
      let alpha = 0
      const t = (py - (cy - hh)) / (2 * hh)
      if (plateD < -borderW / 2) {
        color = mix(plateTop, plateBottom, t)
        alpha = 255
      } else if (plateD < borderW / 2) {
        const bT = t
        color = mix(emeraldTop, emeraldBottom, bT)
        alpha = 255
      } else {
        // soft outer glow of the border
        const g = clamp(1 - (plateD - borderW / 2) / (W * 0.02), 0, 1)
        color = mix(emeraldTop, emeraldBottom, t)
        alpha = 255 * g * 0.35
      }

      // viewfinder strokes + ring + dot override
      let strokeAlpha = 0
      for (const [ax, ay, bx, by] of segs) {
        const d = segmentDist(px, py, ax, ay, bx, by)
        if (d < strokeW / 2) strokeAlpha = 255
        else if (d < strokeW) strokeAlpha = Math.max(strokeAlpha, 255 * (1 - (d - strokeW / 2) / (strokeW / 2)) * 0.4)
      }
      const rd = Math.hypot(px - cx, py - cy)
      if (Math.abs(rd - ringR) < ringW / 2) strokeAlpha = 255
      else if (Math.abs(rd - ringR) < ringW * 1.6) {
        const fall = 1 - (Math.abs(rd - ringR) - ringW / 2) / (ringW * 1.1)
        strokeAlpha = Math.max(strokeAlpha, 255 * clamp(fall, 0, 1) * 0.35)
      }
      if (rd < dotR) strokeAlpha = 255
      else if (rd < dotR * 2.2) {
        const fall = 1 - (rd - dotR) / (dotR * 1.2)
        strokeAlpha = Math.max(strokeAlpha, 255 * clamp(fall, 0, 1) * 0.5)
      }

      if (strokeAlpha > 0) {
        const sa = clamp(strokeAlpha / 255, 0, 1)
        color = color.map((c, ci) => c * (1 - sa) + emerald[ci] * sa)
      }

      const idx = (y * W + x) * 4
      samples[idx] = color[0]
      samples[idx + 1] = color[1]
      samples[idx + 2] = color[2]
      samples[idx + 3] = alpha
    }
  }

  // downsample
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const idx = ((y * SS + sy) * W + (x * SS + sx)) * 4
          const alpha = samples[idx + 3]
          r += samples[idx] * alpha
          g += samples[idx + 1] * alpha
          b += samples[idx + 2] * alpha
          a += alpha
          n += 255
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        rgba[o] = clamp(Math.round(r / a), 0, 255)
        rgba[o + 1] = clamp(Math.round(g / a), 0, 255)
        rgba[o + 2] = clamp(Math.round(b / a), 0, 255)
      }
      rgba[o + 3] = clamp(Math.round(a / (SS * SS)), 0, 255)
    }
  }

  return encodePNG(size, size, rgba)
}

// ---------------------------------------------------------------- run
mkdirSync(outDir, { recursive: true })
for (const size of [16, 32, 256, 512]) {
  const png = renderIcon(size)
  const name = size === 32 ? 'tray.png' : size === 256 ? 'icon.png' : `icon-${size}.png`
  writeFileSync(join(outDir, name), png)
  console.log(`wrote assets/${name} (${png.length} bytes)`)
}
