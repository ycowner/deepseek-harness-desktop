// @ts-check
/**
 * 应用图标生成脚本
 *
 * 功能：
 * 1. 生成 256x256 32位 RGBA 图像数据
 * 2. 绘制深蓝色径向渐变背景 + 白色圆润"D"字母图案（带 4x4 超采样抗锯齿）
 * 3. 将图像数据包装成 ICO 文件格式
 * 4. 输出到 build/icon.ico
 *
 * ICO 文件格式：
 *   ICONDIR(6字节) + ICONDIRENTRY(16字节) + 图像数据(BITMAPINFOHEADER + 像素数据)
 *
 * 注意事项：
 *   - BMP 像素数据从下到上排列（y=0 是最底部行）
 *   - BMP 像素格式是 BGRA（不是 RGBA）
 *   - ICO 中 BMP 的 height 是实际高度的 2 倍（含 AND mask，32位时 AND mask 无实际数据）
 *
 * 使用方式：
 *   node scripts/generate-icon.js
 */

const fs = require('fs')
const path = require('path')

// 图标参数
const WIDTH = 256
const HEIGHT = 256
const BPP = 32 // 32位 BGRA

// 前景色（D 字母）：白色
const COLOR_FG = { r: 255, g: 255, b: 255, a: 255 }

// 背景色：径向渐变（中心稍亮 -> 边缘更深）
const COLOR_BG_CENTER = { r: 37, g: 37, b: 68, a: 255 }  // #252544 中心
const COLOR_BG_EDGE = { r: 26, g: 26, b: 46, a: 255 }   // #1a1a2e 边缘

// D 字母几何参数（圆润 D 形状 = 左侧矩形条 + 右侧半圆环）
const D = {
  x0: 82,        // 左边界
  y0: 60,        // 上边界
  thickness: 24  // 笔画粗细
}
D.x1 = 174                                       // 右边界（cx + R，预计算用于居中）
D.y1 = 196                                       // 下边界
D.cx = D.x0 + D.thickness                        // 圆弧圆心 x（= 左侧条右边界）
D.cy = (D.y0 + D.y1) / 2                         // 圆弧圆心 y
D.R = (D.y1 - D.y0) / 2                          // 外半径 = 68
D.r = D.R - D.thickness                          // 内半径 = 44
D.R2 = D.R * D.R                                 // 外半径平方（避免循环里重复开方）
D.r2 = D.r * D.r                                 // 内半径平方

/**
 * 判断点 (x, y) 是否在 D 字母形状内
 * D 由两部分组成：
 *   1. 左侧矩形条：x ∈ [x0, cx], y ∈ [y0, y1]
 *   2. 右侧半圆环：圆心 (cx, cy)，r <= dist <= R，且 x >= cx
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function isInsideD(x, y) {
  // 左侧矩形条
  if (x >= D.x0 && x <= D.cx && y >= D.y0 && y <= D.y1) {
    return true
  }
  // 右侧半圆环（仅 x >= cx 部分）
  if (x < D.cx) return false
  const dx = x - D.cx
  const dy = y - D.cy
  const distSq = dx * dx + dy * dy
  return distSq <= D.R2 && distSq >= D.r2
}

/**
 * 计算像素 (x, y) 位置的背景色（径向渐变）
 * @param {number} x
 * @param {number} y
 * @returns {{r:number,g:number,b:number,a:number}}
 */
function getBackgroundColor(x, y) {
  const dx = x - WIDTH / 2
  const dy = y - HEIGHT / 2
  const dist = Math.sqrt(dx * dx + dy * dy)
  // 到角落的最大距离，用于归一化
  const maxDist = Math.sqrt((WIDTH / 2) ** 2 + (HEIGHT / 2) ** 2)
  const t = Math.min(dist / maxDist, 1)
  return {
    r: Math.round(COLOR_BG_CENTER.r + (COLOR_BG_EDGE.r - COLOR_BG_CENTER.r) * t),
    g: Math.round(COLOR_BG_CENTER.g + (COLOR_BG_EDGE.g - COLOR_BG_CENTER.g) * t),
    b: Math.round(COLOR_BG_CENTER.b + (COLOR_BG_EDGE.b - COLOR_BG_CENTER.b) * t),
    a: 255
  }
}

/**
 * 计算像素 (x, y) 的最终颜色（带 4x4 超采样抗锯齿）
 * 对每个像素采样 16 个子点，统计落在 D 形状内的比例，按比例混合前景色与背景色
 * @param {number} x 像素 x 坐标（整数）
 * @param {number} y 像素 y 坐标（整数）
 * @returns {{r:number,g:number,b:number,a:number}}
 */
function getPixelColor(x, y) {
  const SAMPLES = 4
  const step = 1 / SAMPLES
  let insideCount = 0
  const total = SAMPLES * SAMPLES

  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const px = x + (sx + 0.5) * step
      const py = y + (sy + 0.5) * step
      if (isInsideD(px, py)) {
        insideCount++
      }
    }
  }

  const ratio = insideCount / total
  // 背景渐变变化平缓，用像素中心作为整像素的背景色即可
  const bg = getBackgroundColor(x + 0.5, y + 0.5)
  return {
    r: Math.round(bg.r + (COLOR_FG.r - bg.r) * ratio),
    g: Math.round(bg.g + (COLOR_FG.g - bg.g) * ratio),
    b: Math.round(bg.b + (COLOR_FG.b - bg.b) * ratio),
    a: 255
  }
}

/**
 * 生成 ICO 文件 Buffer
 * @returns {Buffer}
 */
function generateIco() {
  // 像素数据大小（32位 = 4字节/像素，已 4 字节对齐）
  const pixelDataSize = WIDTH * HEIGHT * 4
  // BITMAPINFOHEADER 大小
  const bitmapInfoHeaderSize = 40
  // 图像数据 = BITMAPINFOHEADER + 像素数据（32位不需要 AND mask 实际数据）
  const imageDataSize = bitmapInfoHeaderSize + pixelDataSize
  // ICO 文件总大小 = ICONDIR(6) + ICONDIRENTRY(16) + 图像数据
  const icoFileSize = 6 + 16 + imageDataSize

  const buffer = Buffer.alloc(icoFileSize)
  let offset = 0

  // ===== ICONDIR（6字节）=====
  buffer.writeUInt16LE(0, offset); offset += 2  // reserved
  buffer.writeUInt16LE(1, offset); offset += 2  // type (1=ICO)
  buffer.writeUInt16LE(1, offset); offset += 2  // image count

  // ===== ICONDIRENTRY（16字节）=====
  buffer.writeUInt8(WIDTH === 256 ? 0 : WIDTH, offset); offset += 1   // width (0 表示 256)
  buffer.writeUInt8(HEIGHT === 256 ? 0 : HEIGHT, offset); offset += 1 // height (0 表示 256)
  buffer.writeUInt8(0, offset); offset += 1   // color count (0=全彩)
  buffer.writeUInt8(0, offset); offset += 1   // reserved
  buffer.writeUInt16LE(1, offset); offset += 2  // color planes
  buffer.writeUInt16LE(BPP, offset); offset += 2  // bit count
  buffer.writeUInt32LE(imageDataSize, offset); offset += 4  // bytes in res（图像数据大小）
  buffer.writeUInt32LE(6 + 16, offset); offset += 4  // image offset（数据起始位置）

  // ===== BITMAPINFOHEADER（40字节）=====
  buffer.writeUInt32LE(40, offset); offset += 4   // header size
  buffer.writeInt32LE(WIDTH, offset); offset += 4   // width
  buffer.writeInt32LE(HEIGHT * 2, offset); offset += 4  // height (ICO 中是 2 倍，含 AND mask)
  buffer.writeUInt16LE(1, offset); offset += 2   // planes
  buffer.writeUInt16LE(BPP, offset); offset += 2   // bit count
  buffer.writeUInt32LE(0, offset); offset += 4   // compression (BI_RGB)
  buffer.writeUInt32LE(pixelDataSize, offset); offset += 4  // image size
  buffer.writeInt32LE(0, offset); offset += 4   // x pixels per meter
  buffer.writeInt32LE(0, offset); offset += 4   // y pixels per meter
  buffer.writeUInt32LE(0, offset); offset += 4   // colors used
  buffer.writeUInt32LE(0, offset); offset += 4   // colors important

  // ===== 像素数据 =====
  // BMP 像素数据从下到上排列（第 0 行对应图像最底部），从左到右
  // 像素格式：BGRA（不是 RGBA）
  for (let row = 0; row < HEIGHT; row++) {
    // BMP 第 row 行 -> 图像坐标 y = HEIGHT - 1 - row
    const y = HEIGHT - 1 - row
    for (let x = 0; x < WIDTH; x++) {
      const color = getPixelColor(x, y)
      buffer.writeUInt8(color.b, offset); offset += 1
      buffer.writeUInt8(color.g, offset); offset += 1
      buffer.writeUInt8(color.r, offset); offset += 1
      buffer.writeUInt8(color.a, offset); offset += 1
    }
  }

  return buffer
}

/**
 * 主流程
 */
function main() {
  console.log('================================================')
  console.log('  应用图标生成脚本')
  console.log(`  尺寸: ${WIDTH}x${HEIGHT}, ${BPP}位`)
  console.log(`  图案: 深蓝色径向渐变背景 + 白色圆润 D 字母`)
  console.log('================================================')

  console.log('[生成] 正在生成 ICO 文件（含 4x4 超采样抗锯齿，请稍候）...')
  const startTime = Date.now()
  const buffer = generateIco()
  const elapsed = Date.now() - startTime

  // 输出路径：build/icon.ico
  const outputPath = path.join(__dirname, '..', 'build', 'icon.ico')
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, buffer)

  console.log(`[完成] 图标已生成: ${outputPath}`)
  console.log(`[完成] 文件大小: ${buffer.length} 字节`)
  console.log(`[完成] 耗时: ${elapsed} ms`)

  // 简单验证：检查文件头
  const written = fs.readFileSync(outputPath)
  if (written.length !== buffer.length) {
    throw new Error(`文件大小校验失败: 期望 ${buffer.length}, 实际 ${written.length}`)
  }
  if (written.readUInt16LE(2) !== 1) {
    throw new Error('ICO type 字段校验失败：不是 ICO 文件')
  }
  if (written.readUInt16LE(4) !== 1) {
    throw new Error('ICO image count 字段校验失败')
  }
  console.log('[验证] ICO 文件头校验通过')
}

main()
