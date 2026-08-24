; DSH Desktop 自定义 NSIS 安装器脚本
;
; 背景：
; electron-builder 25 的 NSIS 模板里已经有一套完整的"任务栏固定图标保留"机制：
; 1) 首次安装结束时向 HKEY_...\Software\<appId> 写入 KeepShortcuts=true；
; 2) 升级场景下，新安装器读取上一版本写入的 KeepShortcuts=true，
;    并在调旧 Uninstaller.exe 时额外附 --keep-shortcuts / --updated 参数；
; 3) 旧 Uninstaller.exe 看到 --keep-shortcuts 后，
;    会跳过 Delete "$SMPROGRAMS\DSH Desktop.lnk" 与
;    WinShell::UninstAppUserModelId "${APP_ID}" 两条语句，
;    让 Windows 任务栏已"固定"的图标继续有效。
;
; 关键开关是 CLI 参数 --updated。它是 NSIS 宏 ${isUpdated} 的真实值来源；
; 仅当该宏为真时，模板里的 setIsTryToKeepShortcuts 才会保持 $isTryToKeepShortcuts=true，
; 进而 --keep-shortcuts 才会被附加到旧 Uninstaller.exe 的调用参数上。
;
; 自 1.0.3 起，客户端不再自动下载安装（electron-updater 与 Gitee 回退源均已移除），
; 用户从 GitHub Release 页面手动下载安装包后双击运行升级。
; 注意：手动双击安装器时不会带 --updated 参数，NSIS 模板的 keep-shortcuts 链路不会激活，
; 因此跨版本手动升级可能丢失任务栏已固定图标（已知限制，升级后重新固定即可）。
;
; 本文件提供 electron-builder 模板支持的钩子宏占位实现，供后续扩展使用。
; 当前为空实现，因为核心机制由 electron-builder 模板 + 上述 CLI 参数共同保证。

; 安装前钩子（在 electron-builder 模板的 install 区段首部被调用）
!macro NSIS_HOOK_PREINSTALL
  ; 保留以备后续使用。修改时注意：
  ; - 调用前 $INSTDIR 已经是当前用户已选/已记忆的目标目录
  ; - 不要在此删除 $SMPROGRAMS 下与本 appId 对应的快捷方式
!macroend

; 安装后钩子（文件复制/注册表写入完成后被调用）
!macro NSIS_HOOK_POSTINSTALL
  ; 保留以备后续使用，例如可以在这里主动刷新 SHChangeNotify(SHCNE_ASSOCCHANGED)
  ; 让 explorer 重新解析 $SMPROGRAMS 下的 .lnk 属性。
!macroend

; 卸载前钩子。
!macro NSIS_HOOK_PREUNINSTALL
  ; 用户主动卸载时不要拦截，让 electron-builder 默认行为完整清理快捷方式
  ; 与注册表项即可（控制面板里"卸载"操作不需要保留任务栏固定图标）。
  ; 升级场景不会走到这里：升级路径上旧的 Uninstaller.exe 是被新安装器主动调起，
  ; 模板会先读 KeepShortcuts=true 再追加 --keep-shortcuts，
  ; 删/不删 .lnk 的逻辑在 uninstaller.nsh 172-189 行按 isKeepShortcuts 分支决定。
!macroend
