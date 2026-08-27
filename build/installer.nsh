; DSH Desktop 自定义 NSIS 安装器脚本
;
; 使命：修复「跨版本手动升级后任务栏固定图标丢失」问题（方案 B'）。
;
; 根因（electron-builder 25 模板，强耦合实现细节，升级 electron-builder 需重新验证）：
; 1) 模板生成的 ${isUpdated} 是对安装器自身 CLI 参数 --updated 的运行时检测
;    （nsisScriptGenerator.js 的 flags()，LogicLib 自定义测试宏协议）。
; 2) 本项目开启 allowToChangeInstallationDirectory，installUtil.nsh 的
;    setIsTryToKeepShortcuts 在 ${isUpdated} 为假时强制 $isTryToKeepShortcuts=false，
;    导致新安装器调旧卸载器时不追加 --keep-shortcuts。
; 3) 旧卸载器收不到 --keep-shortcuts 就会执行 WinShell::UninstAppUserModelId 并删除
;    开始菜单 .lnk，任务栏固定图标的 AUMID 锚点被拔掉，Windows 随即清理固定项。
; 4) 自 1.0.3 起用户从 GitHub Release 手动下载双击升级，安装器永远不带 --updated，
;    链路断裂。
;
; 修复思路（编译期重定义 ${isUpdated} 语义，运行时无进程自重启）：
; - 在本文件（被 NsisTarget.js 插入在 flags() 生成之后）重定义 ${isUpdated} 为：
;   「CLI 带 --updated」或「存在旧安装 且 已进入安装执行阶段」。
; - 阶段分界使两方面的判断各取所需：
;   * 页面阶段（目录选择页 skipPageIfUpdated）拿到 false → 目录页正常显示，
;     升级时默认预填旧安装目录（multiUser.nsh setInstallModePerAllUsers 读 HKLM
;     InstallLocation），用户仍可改目录（也支持 /D 参数）。
;   * 安装执行阶段（CHECK_APP_RUNNING / setIsTryToKeepShortcuts /
;     uninstallOldVersion）拿到 true → keep-shortcuts 链路激活，
;     升级时自动结束运行中的应用（与 electron-updater 行为一致）。
; - 阶段标记置位：非静默走 customPageAfterChangeDir 注入的空页面（目录页之后、
;     instfiles 页之前）；静默 /S 无页面流程，由 customInit 的 ${Silent} 分支置位。
;
; 已核对的关键约束（勿随意改动）：
; - 本文件位于 StdUtils include 与 flags() 之后、installer.nsi 模板之前，
;   !undef isUpdated 必然成立（否则重定义的同名 define 会编译报错，打包即失败）。
; - customInit 展开于 .onInit（check64BitAndSetRegView 之后），HKLM 读取为 64 位视图。
; - 整套机制必须包在 !ifndef BUILD_UNINSTALLER 内：electron-builder 跑两遍 makensis，
;   卸载器 pass 不展开 customInit / customPageAfterChangeDir，若在其中声明变量，
;   变量从未赋值会触发 NSIS warning 6001，而 electron-builder 把警告当错误（/WX）。
;   卸载器 pass 保留模板原始 ${isUpdated}（纯 CLI 检测）语义即可：升级时新安装器
;   会显式给旧卸载器传 --updated / --keep-shortcuts；手动控制面板卸载（无参数）
;   行为与默认模板完全一致。
; - 历史安装（electron-builder 25 系）均已写 KeepShortcuts=true 注册表凭证，
;   从 1.0.4 升级到带本修复的版本即生效。
; - 原文件中的 NSIS_HOOK_PREINSTALL/POSTINSTALL/PREUNINSTALL 宏已删除：
;   经核实 electron-builder 25 的模板与编译产物中不存在 NSIS_HOOK_* 引用点，
;   属从未生效的死代码；模板真正支持的钩子是 customInit / customInstall /
;   customUnInstall / customPageAfterChangeDir / preInit 等。

!ifndef BUILD_UNINSTALLER

Var /GLOBAL dshIsUpgrade
Var /GLOBAL dshInstallPhase

; ---- 重定义 ${isUpdated}（LogicLib 自定义测试宏协议，与 flags() 生成方式同构）----
!ifdef isUpdated
  !undef isUpdated
!endif
!define isUpdated `"" isDshUpdated ""`

!macro _isDshUpdated _a _b _t _f
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" `${_t}` 0
  StrCpy $R9 "$dshIsUpgrade$dshInstallPhase"
  StrCmp "$R9" "11" `${_t}` `${_f}`
!macroend

; ---- .onInit：检测旧安装 + 静默模式阶段标记 ----
!macro customInit
  StrCpy $dshIsUpgrade "0"
  StrCpy $dshInstallPhase "0"
  ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${if} $R0 != ""
    StrCpy $dshIsUpgrade "1"
  ${endif}
  ; 静默安装没有页面流程，直接视为已进入安装执行阶段
  ${if} ${Silent}
    StrCpy $dshInstallPhase "1"
  ${endif}
!macroend

; ---- 目录页之后的空页面：非静默流程进入安装执行阶段的唯一标记点 ----
; 展开于 assistedInstaller.nsh 的页面定义区（MUI_PAGE_DIRECTORY 与
; MUI_PAGE_INSTFILES 之间），BUILD_UNINSTALLER pass 不展开，无副作用。
!macro customPageAfterChangeDir
  Page custom dshMarkInstallPhase
  Function dshMarkInstallPhase
    StrCpy $dshInstallPhase "1"
    ; Abort 在页面创建函数中 = 跳过本页面（无任何 UI，不闪窗）
    Abort
  FunctionEnd
!macroend

!endif
