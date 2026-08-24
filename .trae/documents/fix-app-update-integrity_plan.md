# 桌面端应用更新 NSIS 完整性检查失败 — 修复方案

## 问题概述

用户在 DSH Desktop 应用中点击"更新"按钮后，系统弹出 NSIS 错误对话框：

> **NSIS Error: Installer integrity check has failed. Common causes include incomplete download and damaged media.**

点击"确定"后安装流程终止。

---

## 根因分析

NSIS (Nullsoft Scriptable Install System) 在启动安装时会校验自身 EXE 文件的完整性（如校验和/哈希）。如果下载的安装包文件不完整或已损坏，NSIS 会拒绝执行并弹出此错误。

经审查代码，发现以下 **4 个问题** 共同导致此故障：

### 问题 1：`downloadAppUpdate()` 缺少下载完整性校验 🔴（核心原因）

**文件**: `src/main/app-update.ts` 第 244–281 行

```
现状：
- 未读取 HTTP 响应的 content-length 头
- 下载完成后仅检查 createWriteStream 是否写入完毕
- 未验证实际下载字节数是否等于预期大小
- 网络中断/不稳定时可能产生部分文件（如 100MB 安装包只下载了 80MB）
```

**后果**：文件不完整但被判定为"下载成功"，后续 `spawn()` 启动安装包时 NSIS 校验失败。

### 问题 2：损坏文件检测缺失 🟠

**文件**: `src/main/index.ts` 第 309–335 行 (`checkAndDownloadAppUpdate`) 和第 462–497 行 (`performAppUpdate`)

```
现状：
- checkAndDownloadAppUpdate: 仅用 existsSync 检查文件是否存在，
  存在即跳过下载（即使已损坏）
- performAppUpdate: 仅用 existsSync 检查文件是否存在，
  不校验文件完整性就直接 spawn
```

**后果**：一旦某次下载产生损坏文件，后续所有更新都会使用这个损坏的文件，因为 `existsSync` 会命中并跳过重新下载。

### 问题 3：`createWriteStream` 完成时机判断不严谨 🟡

**文件**: `src/main/app-update.ts` 第 267–272 行

```
现状：
- 使用 stream.on('finish') 事件触发 resolve
- Node.js 的 finish 事件在所有数据写入完成后触发，
  但不保证 HTTP 响应体已完整接收
- 应该用 response.on('end') 来确认 HTTP 传输完成，
  再配合 stream.on('finish') 来确认写入完成
```

### 问题 4：下载文件存放到 Program Files 目录 🔵

**文件**: `src/main/app-update.ts` 第 74–76 行 (`getInstallDir`)

```
现状：
- 下载路径 = dirname(app.getPath('exe'))
- 即 C:\Program Files\DSH Desktop\DSH-Desktop-Setup-{version}.exe
- 该目录受 Windows UAC 保护
- 杀毒软件实时保护可能在文件写入过程中扫描，
  导致写入被拦截或文件句柄冲突
```

**风险等级**：中等。虽然应用以管理员权限运行可绕过 UAC，但杀毒软件是独立因素。

---

## 修复方案

### 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/main/app-update.ts` | 修改 | 添加 content-length 校验、修复完成时机、添加原子写入 |
| `src/main/index.ts` | 修改 | 添加损坏检测、改进文件路径逻辑 |

### 步骤 1：改造 `downloadAppUpdate` — 添加完整性校验 + 原子写入

**修改 `src/main/app-update.ts`**

1. 读取 HTTP 响应的 `content-length` 头
2. 下载过程中累计已下载字节数
3. 下载完成后校验实际字节数与 `content-length` 是否匹配
4. 不匹配时返回明确的错误信息
5. 采用**原子写入**策略：先写临时文件 `.tmp`，下载完成并校验通过后再重命名为最终文件名
6. 同时使用 `res.on('end')` + `stream.on('finish')` 双重确认完成

```
downloadAppUpdate 改造后的伪代码：
┌─ 解析 downloadUrl 获取目标目录
├─ 创建临时文件路径 (destPath + '.tmp')
├─ 读取 content-length
├─ pipe 写入临时文件，累计 downloaded 字节
├─ 等待 res.on('end') + stream.on('finish')
├─ 校验 downloaded === content-length
│   ├─ 匹配 → rename .tmp → destPath → resolve
│   └─ 不匹配 → 删除 .tmp → reject(完整性校验失败)
└─ 任何错误 → 删除 .tmp → reject
```

### 步骤 2：改造 `checkAndDownloadAppUpdate` — 添加损坏检测

**修改 `src/main/index.ts`**

1. 检查已有文件时，不仅用 `existsSync`，还要校验文件大小 > 0
2. 如果已有文件大小为 0 或异常（小于 1MB 视为损坏），删除后重新下载
3. 添加日志记录已存在文件的大小，便于排查

```
checkAndDownloadAppUpdate 改造后的伪代码：
┌─ existsSync(destPath)
│   ├─ 否 → 正常下载
│   └─ 是 → statSync 获取文件大小
│       ├─ size > 1MB → 跳过下载，打印日志（已有文件，大小 xxx MB）
│       └─ size <= 1MB → 判定为损坏 → 删除 → 重新下载
└─ 下载完成后记录实际文件大小
```

### 步骤 3：改造 `performAppUpdate` — 添加安装前校验

**修改 `src/main/index.ts`**

1. 在 `spawn()` 启动安装包前，校验文件大小合理性（安装包至少 > 10MB）
2. 文件过小时拒绝启动并提示用户重新下载
3. 启动安装包后不再 `app.quit()`，而是等待安装包自我处理退出流程

```
performAppUpdate 改造后的伪代码：
┌─ existsSync(installerPath) 检查
├─ statSync(installerPath) 获取文件大小
├─ size < 10MB → 拒绝安装，删除损坏文件，提示重新启动应用下载
├─ 10MB <= size <= 1GB → 合理范围，继续
├─ size > 1GB → 可疑，警告但允许继续
├─ stopDsh()
├─ 弹提示框
├─ spawn(installerPath) 启动安装
└─ 延迟 app.quit()（给安装包足够时间初始化）
```

### 步骤 4：`downloadAppUpdate` 添加重试机制

**修改 `src/main/app-update.ts`**

1. 下载失败时（完整性校验失败或其他网络错误），自动重试 1 次
2. 重试前清理临时文件
3. 最多 2 次尝试（首次 + 重试），避免无限循环

---

## 影响范围

| 模块 | 影响 |
|------|------|
| 桌面应用更新检查 (`checkAndDownloadAppUpdate`) | 会更严格地校验已有文件，必要时重新下载 |
| 桌面应用安装流程 (`performAppUpdate`) | 会在安装前增加一步文件大小校验 |
| DSH 包更新流程 (`performUpdate`) | **不受影响** — DSH 更新走 `repairDsh` 流程，使用 npm registry，与 NSIS 安装包无关 |

## 风险评估

| 风险 | 影响 | 应对措施 |
|------|------|---------|
| content-length 头部缺失（某些 CDN 不返回） | 无法校验完整性 | 降级策略：缺失时仅用文件存在性判断，日志警告 |
| 原子写入 rename 失败（文件被占用） | 临时文件无法重命名 | 重试 rename 3 次，间隔 100ms；仍失败则回退为直接写入 |
| 合理大小阈值不准确 | 可能误判损坏/误判正常 | 使用保守阈值（10MB 下限），并在日志中记录实际值 |
| 重试机制增加下载时间 | 弱网用户等待更久 | 仅重试 1 次，超时设为 120s/次 |

## 不确定点（需确认）

1. **下载目录权限**：当前方案保留将安装包下载到 `getInstallDir()`（即 `Program Files` 下）。是否需要改为下载到用户可写目录（如 `%LOCALAPPDATA%/DSH Desktop/updates/`）？后者权限更安全但需调整安装包路径逻辑。

2. **合理大小上限**：NSIS 安装包的合理大小范围是多少？当前 1.0.0 版本约 146MB，我建议设上限为 500MB。

3. **自动重试范围**：下载完整性校验失败时，是自动重试 1 次还是提示用户手动重试？

---

## 实施步骤总览

1. ✅ 修改 `src/main/app-update.ts` — `downloadAppUpdate()`：
   - 读取 content-length
   - 原子写入（.tmp → rename）
   - 完整性校验
   - 单次重试

2. ✅ 修改 `src/main/index.ts` — `checkAndDownloadAppUpdate()`：
   - 已有文件大小校验
   - 损坏文件自动清理

3. ✅ 修改 `src/main/index.ts` — `performAppUpdate()`：
   - 安装前文件大小校验
   - 损坏时拒绝启动

4. ✅ `npm run build` 验证 TypeScript 编译通过

5. ✅ 手动验证完整流程
