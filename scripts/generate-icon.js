// @ts-check
/**
 * 应用图标生成脚本（融合徽标：鲸鱼 + 浏览器窗框）
 *
 * 功能：
 * 1. 读取 build/icon-src/whale.png（鲸鱼源图：256x256、白底黑鲸、透明圆角）
 * 2. 合成 256x256 主图：
 *    - 底砖：复用源图 alpha 通道的圆角形状（不重绘、不改圆角）
 *    - 窗框：黑色 #000 单线浏览器窗框（外框 + 标题栏分隔线 + 三个圆点），几何取自
 *      网站 assets/lab-mark.png（192px 稿）逐项实测值，等比 4/3 映射到 256；烧瓶不参与合成
 *    - 鲸鱼：源图中裁剪鲸鱼外接矩形、按灰度取 alpha，等比缩至高 136px 嵌入内容区居中
 * 3. 预乘 alpha 面积平均降采样出 16/32/48/64/128，与 256 一起打包为 ICO
 * 4. 输出 build/icon.ico（32bpp BMP 帧结构，与历史文件一致）
 *
 * 渲染细节：
 *   - 窗框/圆点/分隔线用圆角矩形符号距离场解析抗锯齿（像素中心 1px 过渡带）
 *   - 鲸鱼缩放用 4x4 子采样 + 双线性插值的面积平均，避免细部丢线
 *   - 无第三方依赖（PNG 解码 = zlib 反滤波手写实现），离线可跑
 *
 * ICO 文件格式：
 *   ICONDIR(6字节) + ICONDIRENTRY(16字节/帧) + 各帧图像数据(BITMAPINFOHEADER + 像素数据)
 *   注意：BMP 像素自下而上；像素格式 BGRA；ICO 中 BMP 的 height 是实际高度的 2 倍（含 AND mask）
 *
 * 使用方式：
 *   node scripts/generate-icon.js
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 256
const WHALE_SRC = path.join(__dirname, '..', 'build', 'icon-src', 'whale.png')
const ICON_OUT = path.join(__dirname, '..', 'build', 'icon.ico')

// 设计规格：鲸鱼在窗框内容区居中，高度 136（内容区高约 144，上下各留约 4px）
const WHALE_HEIGHT = 136
// 鲸鱼外接矩形（源图 256 坐标系内实测值，用于裁剪）
const WHALE_BOX = { x: 29, y: 53, w: 197, h: 145 }

// 窗框几何：取自网站 assets/lab-mark.png（192px 稿）逐项实测值
const FRAME_192 = {
  x0: 15,                     // 外框外边界（左）
  y0: 22,                     // 外框外边界（上）
  x1: 177,                    // 外框外边界（右）
  y1: 170,                    // 外框外边界（下）
  stroke: 3,                  // 线条宽度
  radius: 15.5,               // 外框圆角半径（按像素轮廓拟合）
  sepTop: 56,                 // 标题栏分隔线（上沿）
  sepBot: 59,                 // 标题栏分隔线（下沿）
  dotsCy: 40.75,              // 三个圆点圆心 y
  dotsR: 4.507,               // 三个圆点半径
  dotsCxs: [35, 52.5, 69.5]   // 三个圆点圆心 x
}

// 192 稿 -> 256
const K = SIZE / 192
const FRAME = {
  x0: FRAME_192.x0 * K,
  y0: FRAME_192.y0 * K,
  x1: FRAME_192.x1 * K,
  y1: FRAME_192.y1 * K,
  stroke: FRAME_192.stroke * K,
  radius: FRAME_192.radius * K,
  sepTop: FRAME_192.sepTop * K,
  sepBot: FRAME_192.sepBot * K,
  dotsCy: FRAME_192.dotsCy * K,
  dotsR: FRAME_192.dotsR * K,
  dotsCxs: FRAME_192.dotsCxs.map(function (v) { return v * K })
}

/**
 * 解码 PNG（仅支持 8bit RGB/RGBA，非隔行）
 * @param {Buffer} buf
 * @returns {{w:number,h:number,ch:number,data:Buffer}}
 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('不是 PNG 文件')
  }
  let off = 8
  let w = 0
  let h = 0
  let bitDepth = 0
  let colorType = 0
  /** @type {Buffer[]} */
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      bitDepth = data.readUInt8(8)
      colorType = data.readUInt8(9)
      if (data.readUInt8(12) !== 0) throw new Error('不支持隔行 PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error('仅支持 8bit RGB/RGBA PNG，实际 bitDepth=' + bitDepth + ' colorType=' + colorType)
  }
  const ch = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  let pos = 0
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++]
    const line = Buffer.from(raw.subarray(pos, pos + stride))
    pos += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0
      const b = prev[i]
      const c = i >= ch ? prev[i - ch] : 0
      let v = line[i]
      if (filter === 1) v = (v + a) & 255
      else if (filter === 2) v = (v + b) & 255
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
        v = (v + pr) & 255
      }
      line[i] = v
    }
    line.copy(out, y * stride)
    prev = line
  }
  return { w: w, h: h, ch: ch, data: out }
}

const clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

/**
 * 读取源图：返回底砖 alpha 掩码与鲸鱼 alpha 精灵
 * @returns {{tileAlpha:Buffer, sprite:Float32Array}}
 */
function loadSource() {
  const img = decodePng(fs.readFileSync(WHALE_SRC))
  if (img.w !== SIZE || img.h !== SIZE) {
    throw new Error('源图必须是 ' + SIZE + 'x' + SIZE + '，实际 ' + img.w + 'x' + img.h)
  }
  const tileAlpha = Buffer.alloc(SIZE * SIZE)
  for (let i = 0; i < SIZE * SIZE; i++) tileAlpha[i] = img.ch === 4 ? img.data[i * 4 + 3] : 255

  // 鲸鱼外接矩形校验：源图里只有「白色砖 + 黑色鲸」，luma < 64 视为鲸鱼实体
  let minx = SIZE
  let miny = SIZE
  let maxx = -1
  let maxy = -1
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * img.ch
      const luma = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]
      if (luma < 64 && tileAlpha[y * SIZE + x] > 128) {
        if (x < minx) minx = x
        if (x > maxx) maxx = x
        if (y < miny) miny = y
        if (y > maxy) maxy = y
      }
    }
  }
  const dx = Math.abs(minx - WHALE_BOX.x) + Math.abs(miny - WHALE_BOX.y) + Math.abs(maxx - (WHALE_BOX.x + WHALE_BOX.w - 1)) + Math.abs(maxy - (WHALE_BOX.y + WHALE_BOX.h - 1))
  if (dx > 2) {
    console.warn('[警告] 源图鲸鱼外接矩形与 WHALE_BOX 偏差 ' + dx + 'px（实测 x[' + minx + '..' + maxx + '] y[' + miny + '..' + maxy + ']），仍按 WHALE_BOX 常量裁剪')
  }

  // 精灵 alpha：白=0、黑=1，抗锯齿灰阶按比例取 alpha（含源图自身的半透明边缘）
  const sprite = new Float32Array(WHALE_BOX.w * WHALE_BOX.h)
  let nonGray = 0
  for (let y = 0; y < WHALE_BOX.h; y++) {
    for (let x = 0; x < WHALE_BOX.w; x++) {
      const i = ((WHALE_BOX.y + y) * SIZE + (WHALE_BOX.x + x)) * img.ch
      const r = img.data[i]
      const g = img.data[i + 1]
      const b = img.data[i + 2]
      const al = img.ch === 4 ? img.data[i + 3] : 255
      if (Math.max(r, g, b) - Math.min(r, g, b) > 8) nonGray++
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) * (al / 255)
      sprite[y * WHALE_BOX.w + x] = clamp((255 - luma) / 255, 0, 1)
    }
  }
  if (nonGray > 0) console.warn('[警告] 鲸鱼区域存在 ' + nonGray + ' 个非灰度像素（源图应只有黑白两色）')
  return { tileAlpha: tileAlpha, sprite: sprite }
}

/**
 * 圆角矩形符号距离场（负值在形状内）
 */
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r)
  const qy = Math.abs(y - cy) - (hh - r)
  const mx = Math.max(qx, 0)
  const my = Math.max(qy, 0)
  return Math.hypot(mx, my) + Math.min(Math.max(qx, qy), 0) - r
}

/**
 * 窗框黑色覆盖率（外框描边 + 分隔线 + 三个圆点），坐标取像素中心
 */
function frameCoverage(x, y) {
  const cx = (FRAME.x0 + FRAME.x1) / 2
  const cy = (FRAME.y0 + FRAME.y1) / 2
  const hw = (FRAME.x1 - FRAME.x0) / 2
  const hh = (FRAME.y1 - FRAME.y0) / 2
  const dOut = sdRoundRect(x, y, cx, cy, hw, hh, FRAME.radius)
  const dIn = sdRoundRect(x, y, cx, cy, hw - FRAME.stroke, hh - FRAME.stroke, Math.max(FRAME.radius - FRAME.stroke, 0.01))
  let cov = clamp(0.5 - dOut, 0, 1) * clamp(0.5 + dIn, 0, 1)
  // 标题栏分隔线：横贯外框内宽
  const xs = FRAME.x0 + FRAME.stroke
  const xe = FRAME.x1 - FRAME.stroke
  const aX = clamp(x - xs + 0.5, 0, 1) * clamp(xe - x + 0.5, 0, 1)
  const aY = clamp(y - FRAME.sepTop + 0.5, 0, 1) * clamp(FRAME.sepBot - y + 0.5, 0, 1)
  cov = Math.max(cov, aX * aY)
  // 三个圆点
  for (let i = 0; i < FRAME.dotsCxs.length; i++) {
    const d = Math.hypot(x - FRAME.dotsCxs[i], y - FRAME.dotsCy) - FRAME.dotsR
    cov = Math.max(cov, clamp(0.5 - d, 0, 1))
  }
  return cov
}

/**
 * 鲸鱼精灵双线性采样（u/v 为精灵连续坐标，像素中心在 i+0.5）
 */
function spriteSample(sprite, u, v) {
  const x = clamp(u - 0.5, 0, WHALE_BOX.w - 1 - 1e-6)
  const y = clamp(v - 0.5, 0, WHALE_BOX.h - 1 - 1e-6)
  const i0 = Math.floor(x)
  const j0 = Math.floor(y)
  const fx = x - i0
  const fy = y - j0
  const w = WHALE_BOX.w
  const h = WHALE_BOX.h
  const at = function (i, j) { return sprite[Math.min(j, h - 1) * w + Math.min(i, w - 1)] }
  return at(i0, j0) * (1 - fx) * (1 - fy) + at(i0 + 1, j0) * fx * (1 - fy) + at(i0, j0 + 1) * (1 - fx) * fy + at(i0 + 1, j0 + 1) * fx * fy
}

/**
 * 合成 256x256 主图（黑 = 窗框/鲸鱼覆盖率并集，alpha = 源图底砖 alpha）
 * @returns {Buffer} RGBA（直通 alpha）
 */
function composeMaster() {
  const src = loadSource()

  const scale = WHALE_HEIGHT / WHALE_BOX.h
  const whaleW = WHALE_BOX.w * scale
  const contentX0 = FRAME.x0 + FRAME.stroke
  const contentX1 = FRAME.x1 - FRAME.stroke
  const contentY0 = FRAME.sepBot
  const contentY1 = FRAME.y1 - FRAME.stroke
  const whaleX0 = (contentX0 + contentX1) / 2 - whaleW / 2
  const whaleY0 = (contentY0 + contentY1) / 2 - WHALE_HEIGHT / 2
  console.log('[合成] 内容区 x[' + contentX0.toFixed(1) + '..' + contentX1.toFixed(1) + '] y[' + contentY0.toFixed(1) + '..' + contentY1.toFixed(1) + ']')
  console.log('[合成] 鲸鱼 ' + whaleW.toFixed(1) + 'x' + WHALE_HEIGHT + ' @ (' + whaleX0.toFixed(1) + ',' + whaleY0.toFixed(1) + ') scale=' + scale.toFixed(4))

  const out = Buffer.alloc(SIZE * SIZE * 4)
  const SS = 4 // 鲸鱼缩放每像素子采样数
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const fc = frameCoverage(x + 0.5, y + 0.5)
      let wc = 0
      const u0 = (x - whaleX0) / scale
      const u1 = (x + 1 - whaleX0) / scale
      const v0 = (y - whaleY0) / scale
      const v1 = (y + 1 - whaleY0) / scale
      if (!(u1 < 0 || u0 > WHALE_BOX.w || v1 < 0 || v0 > WHALE_BOX.h)) {
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            wc += spriteSample(src.sprite, u0 + (u1 - u0) * (sx + 0.5) / SS, v0 + (v1 - v0) * (sy + 0.5) / SS)
          }
        }
        wc /= SS * SS
      }
      const cov = 1 - (1 - fc) * (1 - wc)
      const v = Math.round(255 * (1 - cov))
      const i = (y * SIZE + x) * 4
      out[i] = v
      out[i + 1] = v
      out[i + 2] = v
      out[i + 3] = src.tileAlpha[y * SIZE + x]
    }
  }
  return out
}

/**
 * 预乘 alpha 面积平均降采样（256 -> s）
 * @param {Buffer} src
 * @param {number} s
 * @returns {Buffer}
 */
function downscale(src, s) {
  const out = Buffer.alloc(s * s * 4)
  for (let dy = 0; dy < s; dy++) {
    const sy0 = dy * SIZE / s
    const sy1 = (dy + 1) * SIZE / s
    for (let dx = 0; dx < s; dx++) {
      const sx0 = dx * SIZE / s
      const sx1 = (dx + 1) * SIZE / s
      let a = 0
      let r = 0
      let g = 0
      let b = 0
      let wsum = 0
      for (let sy = Math.floor(sy0); sy < sy1; sy++) {
        const fy = Math.min(sy + 1, sy1) - Math.max(sy, sy0)
        if (fy <= 0) continue
        for (let sx = Math.floor(sx0); sx < sx1; sx++) {
          const fx = Math.min(sx + 1, sx1) - Math.max(sx, sx0)
          if (fx <= 0) continue
          const wgt = fx * fy
          const i = (sy * SIZE + sx) * 4
          const al = src[i + 3] / 255
          r += src[i] * al * wgt
          g += src[i + 1] * al * wgt
          b += src[i + 2] * al * wgt
          a += src[i + 3] * wgt
          wsum += wgt
        }
      }
      const ia = wsum > 0 ? (a / wsum) / 255 : 0
      const o = (dy * s + dx) * 4
      out[o] = ia > 0 ? Math.round(r / wsum / ia) : 255
      out[o + 1] = ia > 0 ? Math.round(g / wsum / ia) : 255
      out[o + 2] = ia > 0 ? Math.round(b / wsum / ia) : 255
      out[o + 3] = wsum > 0 ? Math.round(a / wsum) : 0
    }
  }
  return out
}

/**
 * 打包单帧：BITMAPINFOHEADER(40) + 自下而上的 BGRA 像素
 * @param {Buffer} rgba
 * @param {number} s
 * @returns {Buffer}
 */
function buildIcoFrame(rgba, s) {
  const pixelDataSize = s * s * 4
  const buf = Buffer.alloc(40 + pixelDataSize)
  let off = 0
  buf.writeUInt32LE(40, off); off += 4          // header size
  buf.writeInt32LE(s, off); off += 4            // width
  buf.writeInt32LE(s * 2, off); off += 4        // height（ICO 中是 2 倍，含 AND mask）
  buf.writeUInt16LE(1, off); off += 2           // planes
  buf.writeUInt16LE(32, off); off += 2          // bit count
  buf.writeUInt32LE(0, off); off += 4           // compression (BI_RGB)
  buf.writeUInt32LE(pixelDataSize, off); off += 4
  buf.writeInt32LE(0, off); off += 4
  buf.writeInt32LE(0, off); off += 4
  buf.writeUInt32LE(0, off); off += 4
  buf.writeUInt32LE(0, off); off += 4
  for (let row = 0; row < s; row++) {
    const y = s - 1 - row
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4
      buf[off++] = rgba[i + 2]
      buf[off++] = rgba[i + 1]
      buf[off++] = rgba[i]
      buf[off++] = rgba[i + 3]
    }
  }
  if (off !== buf.length) {
    throw new Error('帧数据长度校验失败: 期望 ' + buf.length + ' 字节, 实际写入 ' + off + ' 字节')
  }
  return buf
}

/**
 * 打包 ICO（各帧升序）
 * @param {Array<{size:number,rgba:Buffer}>} frames
 * @returns {Buffer}
 */
function encodeIco(frames) {
  const headerSize = 6 + 16 * frames.length
  const parts = []
  let offset = headerSize
  const dir = Buffer.alloc(headerSize)
  dir.writeUInt16LE(0, 0)                    // reserved
  dir.writeUInt16LE(1, 2)                    // type (1=ICO)
  dir.writeUInt16LE(frames.length, 4)        // image count
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    const data = buildIcoFrame(f.rgba, f.size)
    const o = 6 + 16 * i
    dir.writeUInt8(f.size === 256 ? 0 : f.size, o)        // width（0 表示 256）
    dir.writeUInt8(f.size === 256 ? 0 : f.size, o + 1)    // height
    dir.writeUInt8(0, o + 2)                              // color count
    dir.writeUInt8(0, o + 3)                              // reserved
    dir.writeUInt16LE(1, o + 4)                           // color planes
    dir.writeUInt16LE(32, o + 6)                          // bit count
    dir.writeUInt32LE(data.length, o + 8)                 // bytes in res
    dir.writeUInt32LE(offset, o + 12)                     // image offset
    offset += data.length
    parts.push(data)
  }
  return Buffer.concat([dir].concat(parts))
}

/**
 * 主流程
 */
function main() {
  console.log('================================================')
  console.log('  应用图标生成脚本（融合徽标：鲸鱼 + 浏览器窗框）')
  console.log('  输入: build/icon-src/whale.png')
  console.log('  输出: build/icon.ico（16/32/48/64/128/256 六帧）')
  console.log('================================================')

  const startTime = Date.now()
  const master = composeMaster()
  const sizes = [16, 32, 48, 64, 128, 256]
  /** @type {Array<{size:number,rgba:Buffer}>} */
  const frames = []
  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i]
    frames.push({ size: s, rgba: s === SIZE ? master : downscale(master, s) })
  }
  const ico = encodeIco(frames)
  fs.writeFileSync(ICON_OUT, ico)
  console.log('[完成] 图标已生成: ' + ICON_OUT)
  console.log('[完成] 文件大小: ' + ico.length + ' 字节, 耗时: ' + (Date.now() - startTime) + ' ms')

  // 自校验：读回文件核对头部与每帧登记信息
  const written = fs.readFileSync(ICON_OUT)
  if (written.length !== ico.length) throw new Error('文件大小校验失败: 期望 ' + ico.length + ', 实际 ' + written.length)
  if (written.readUInt16LE(0) !== 0 || written.readUInt16LE(2) !== 1) throw new Error('ICONDIR 校验失败')
  const count = written.readUInt16LE(4)
  if (count !== sizes.length) throw new Error('帧数校验失败: 期望 ' + sizes.length + ', 实际 ' + count)
  for (let i = 0; i < count; i++) {
    const o = 6 + 16 * i
    const w = written.readUInt8(o) || 256
    const bpp = written.readUInt16LE(o + 6)
    const size = written.readUInt32LE(o + 8)
    const off = written.readUInt32LE(o + 12)
    if (w !== sizes[i] || bpp !== 32 || size !== 40 + w * w * 4 || off + size > written.length) {
      throw new Error('第 ' + i + ' 帧登记信息校验失败: w=' + w + ' bpp=' + bpp + ' size=' + size + ' off=' + off)
    }
  }
  console.log('[验证] ICO 帧结构校验通过（' + sizes.join('/') + '，32bpp BMP）')
}

main()
