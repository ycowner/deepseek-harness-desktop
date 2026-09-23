import { net } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * DeepSeek 余额查询模块
 *
 * 数据来源：DSH 已配置的 API Key —— 复用 deepseek-harness 的凭据解析规则：
 *   1. 进程环境变量 DEEPSEEK_API_KEY（最高优先级）
 *   2. $DSH_HOME/.credentials.yaml 的 refs.DEEPSEEK_API_KEY（DSH_HOME 未设时为 ~/.dsh）
 *
 * 查询接口：GET {base}/user/balance（官方文档公开接口，免费）。
 * 远程请求统一走 Electron net.fetch（自动遵循系统代理、自动跟随重定向）。
 *
 * 安全约束：API Key 只存在于本模块内，绝不写入日志（仅打掩码）、
 * 绝不通过 IPC 回传渲染层。渲染层只消费 BalanceSnapshot 数字。
 */

export type BalanceStatus = 'ok' | 'low' | 'auth' | 'nocfg' | 'net' | 'relay' | 'loading'

export interface BalanceSnapshot {
  status: BalanceStatus
  /** 人民币总余额（元） */
  cny?: number
  /** 其中：充值余额 */
  toppedUp?: number
  /** 其中：赠送余额 */
  granted?: number
  /** 美元总余额（账户开通 USD 计费时存在） */
  usd?: number
  /** 官方返回的账户可用标记；false 即余额不足 */
  isAvailable?: boolean
  /** 最近一次查询完成时间（epoch ms） */
  updatedAt?: number
  /** 状态补充说明（直接展示给用户） */
  message?: string
}

/** 官方 API 根地址：用于识别用户是否配置了第三方中转（DEEPSEEK_BASE_URL） */
const OFFICIAL_API_HOST = 'api.deepseek.com'
const BALANCE_PATH = '/user/balance'

/** 轮询间隔：余额非流式数据，低频即可，同时避免触发接口风控 */
const POLL_INTERVAL_MS = 300_000
/** 单次查询超时 */
const FETCH_TIMEOUT_MS = 10_000

let current: BalanceSnapshot = { status: 'loading', message: '正在查询余额...' }
let pollTimer: NodeJS.Timeout | null = null
let inFlight = false
const listeners = new Set<(snapshot: BalanceSnapshot) => void>()

/** 解析 DSH Home 目录：与 dsh-manager 的 spawn 约定一致（尊重 DSH_HOME 覆盖） */
function resolveDshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * 读取 DSH 凭据文件中的 DEEPSEEK_API_KEY
 *
 * 文件为 DSH（rc 版本）内部实现、由 DSH 进程自行读写，本模块只读。
 * 结构极简（顶层键 + refs: 段下的扁平键值），故用行解析而非引入 YAML 依赖；
 * 解析失败一律返回 null 由调用方降级为 nocfg 状态，绝不抛异常。
 */
function readKeyFromCredentialsFile(): string | null {
  try {
    const file = path.join(resolveDshHome(), '.credentials.yaml')
    const text = fs.readFileSync(file, 'utf-8')
    const lines = text.split(/\r?\n/)
    let inRefs = false
    for (const line of lines) {
      if (/^refs:\s*$/.test(line)) {
        inRefs = true
        continue
      }
      // 顶层新键（行首非空白）即离开 refs 段
      if (inRefs && /^\S/.test(line)) {
        inRefs = false
      }
      if (!inRefs) continue
      const m = line.match(/^\s+DEEPSEEK_API_KEY:\s*['"]?([^\s'"]+)['"]?\s*$/)
      if (m && m[1]) return m[1]
    }
    return null
  } catch {
    return null
  }
}

/** 取 API Key：环境变量优先，其次 DSH 凭据文件 */
function resolveApiKey(): string | null {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return readKeyFromCredentialsFile()
}

/** 日志用密钥掩码：只泄前 6 位与长度，足够定位问题又不暴露完整密钥 */
function maskKey(key: string): string {
  return `${key.slice(0, 6)}***(${key.length})`
}

/**
 * 判定当前是否配置了第三方中转 Base URL
 *
 * DSH 支持 DEEPSEEK_BASE_URL 指向自建/第三方中转；中转站的 Key 通常无法通过
 * 官方 /user/balance 查余额。此情形静默降级为 relay 状态（徽章显示「余额 —」），
 * 不报错打扰用户。
 */
function resolveRelayBaseUrl(): string | null {
  const raw = (process.env.DEEPSEEK_BASE_URL || '').trim()
  if (!raw) return null
  try {
    const host = new URL(raw).hostname.toLowerCase()
    if (host === OFFICIAL_API_HOST) return null
    return raw.replace(/\/+$/, '')
  } catch {
    return null
  }
}

function notify(): void {
  const snapshot = current
  for (const cb of listeners) {
    try {
      cb(snapshot)
    } catch (err) {
      console.error(`[DSH Balance] 监听器异常: ${(err as Error).message}`)
    }
  }
}

function setSnapshot(next: BalanceSnapshot): void {
  current = next
  notify()
}

/**
 * 执行一次余额查询
 *
 * @param source 触发来源，仅用于日志
 */
export async function refreshBalance(source: 'startup' | 'focus' | 'poll' | 'manual' | 'tray'): Promise<void> {
  if (inFlight) return
  inFlight = true
  setSnapshot({ status: 'loading', message: '正在查询余额...', updatedAt: current.updatedAt })
  try {
    const relay = resolveRelayBaseUrl()
    if (relay) {
      setSnapshot({ status: 'relay', message: '检测到自定义 API 地址（中转），无法查询官方余额', updatedAt: Date.now() })
      return
    }

    const key = resolveApiKey()
    if (!key) {
      setSnapshot({ status: 'nocfg', message: '未找到 DSH 配置的 DeepSeek API Key' })
      return
    }

    const url = `https://${OFFICIAL_API_HOST}${BALANCE_PATH}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await net.fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      if (res.status === 401) {
        setSnapshot({ status: 'auth', message: 'API Key 已失效，请在 DSH「模型」页面更新' })
        console.warn(`[DSH Balance] 查询被拒(401) ${url} key=${maskKey(key)} source=${source}`)
      } else {
        setSnapshot({ status: 'net', message: `余额查询失败（HTTP ${res.status}）` })
      }
      return
    }

    const data = (await res.json()) as {
      is_available?: boolean
      balance_infos?: Array<{
        currency?: string
        total_balance?: string
        granted_balance?: string
        topped_up_balance?: string
      }>
    }

    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
    const cnyInfo = infos.find(i => i.currency === 'CNY') || infos[0]
    const usdInfo = infos.find(i => i.currency === 'USD')

    const cny = cnyInfo?.total_balance != null ? Number.parseFloat(cnyInfo.total_balance) : undefined
    const usd = usdInfo?.total_balance != null ? Number.parseFloat(usdInfo.total_balance) : undefined
    const isAvailable = data.is_available !== false

    if (!cnyInfo || cny == null || Number.isNaN(cny)) {
      setSnapshot({ status: 'net', message: '余额查询返回数据异常' })
      return
    }

    const low = !isAvailable || cny <= 0
    setSnapshot({
      status: low ? 'low' : 'ok',
      cny,
      toppedUp: cnyInfo.topped_up_balance != null ? Number.parseFloat(cnyInfo.topped_up_balance) : undefined,
      granted: cnyInfo.granted_balance != null ? Number.parseFloat(cnyInfo.granted_balance) : undefined,
      usd: usd != null && !Number.isNaN(usd) ? usd : undefined,
      isAvailable,
      updatedAt: Date.now(),
      message: low ? 'DeepSeek 余额不足，请及时充值' : undefined
    })
    console.log(`[DSH Balance] 查询成功 source=${source} CNY=${cny}`)
  } catch (err) {
    const error = err as Error
    const aborted = error.name === 'AbortError'
    setSnapshot({ status: 'net', message: aborted ? '余额查询超时，请稍后重试' : `余额查询失败: ${error.message}` })
    console.error(`[DSH Balance] 查询异常 source=${source}: ${error.message}`)
  } finally {
    inFlight = false
  }
}

/** 启动定时轮询（重复调用安全） */
export function startBalancePolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    void refreshBalance('poll')
  }, POLL_INTERVAL_MS)
  pollTimer.unref()
}

/** 停止定时轮询 */
export function stopBalancePolling(): void {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

/** 订阅余额更新；返回取消订阅函数 */
export function onBalanceUpdate(cb: (snapshot: BalanceSnapshot) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 读取当前余额快照（不触发查询） */
export function getBalanceSnapshot(): BalanceSnapshot {
  return current
}
