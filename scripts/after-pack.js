// @ts-check
/**
 * electron-builder afterPack 钩子：删除 Electron 自带的可选运行时文件
 *
 * 1.0.19 起启用。当前只处理一个文件，删除任何一项前都要求先做实机验证。
 *
 * ---------------------------------------------------------------------------
 * dxcompiler.dll（24.6 MB 原始 / 10.0 MB 压缩后）
 * ---------------------------------------------------------------------------
 * 是什么：DirectX Shader Compiler（DXC），把 HLSL 编译成 DXIL。Chromium 里由
 *   WebGPU（Dawn）与部分 D3D12 图形路径按需加载。
 *
 * 为什么能删：
 * - Electron 44 已把 ANGLE 静态链接进 app.exe（libEGL.dll / libGLESv2.dll 归零），
 *   ANGLE 的 D3D11 后端不需要 DXC。
 * - 本应用渲染的是 DSH Web UI（普通网页），不使用 WebGPU。
 * - 实测（本机 2026-10-05，Electron 44.5.1 / Chromium 152）：删除后启动正常，
 *   CDP 检查两个页面（titlebar + http://127.0.0.1:3080/）均正常渲染，
 *   后者标题读出 'DeepSeek Harness'，无崩溃页面。
 *
 * 什么时候必须重新验证：
 * - 升级 Electron 大版本时（本文件是 Chromium 的一部分，能力边界可能变化）。
 * - DSH Web UI 引入 WebGPU 渲染时。
 *
 * 删掉它的最坏情况：WebGPU 不可用（回退到软件渲染），不是崩溃——但这条
 * 结论来自单次实测，升级 Electron 后务必重测，不要想当然沿用。
 */

const fs = require('fs')
const path = require('path')

/** 待删除的可选运行时文件（相对 win-unpacked 根目录） */
const OPTIONAL_RUNTIME_FILES = ['dxcompiler.dll']

/**
 * @param {{ appOutDir: string }} context electron-builder 传入的构建上下文
 * @returns {Promise<void>}
 */
module.exports = async function afterPack(context) {
  for (const name of OPTIONAL_RUNTIME_FILES) {
    const target = path.join(context.appOutDir, name)
    if (!fs.existsSync(target)) {
      // 幂等：Electron 升级后该文件可能改名或消失，此时无事可做
      console.log(`[after-pack] ${name} 不存在，跳过`)
      continue
    }
    const mb = (fs.statSync(target).size / 1048576).toFixed(1)
    try {
      fs.unlinkSync(target)
      console.log(`[after-pack] 已删除 ${name}（${mb} MB）`)
    } catch (err) {
      // 删不掉不阻断打包：留着只是安装包大一点，功能不受影响
      console.warn(`[after-pack] 删除 ${name} 失败，继续打包：${err.message}`)
    }
  }
}
