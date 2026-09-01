# Tasks

- [x] Task 1: 标题栏「帮助」按钮左移（`src/renderer/titlebar.html`）
  - [x] SubTask 1.1: `.help-btn` 样式定位从右侧（`right: 146px`）改为左侧固定定位（`left: 130px` 左右，位于标题「DSH Desktop」之后），保留 `top: 4px; width: 48px; height: 28px` 等现有尺寸与配色
  - [x] SubTask 1.2: 删除 `.help-btn` 的 `@supports (width: env(titlebar-area-width))` WCO 定位块（不再需要紧贴系统三键）
  - [x] SubTask 1.3: 点击逻辑不变（`getBoundingClientRect()` 坐标传主进程，菜单自动在按钮正下方弹出），验证无需改动 JS

- [x] Task 2: 「关于」模态框 GitHub 按钮叠加图标（`src/main/index.ts` 的 `showAboutModal()`）
  - [x] SubTask 2.1: 「GitHub 仓库」按钮 HTML 内叠加 GitHub octocat 内联 SVG（白色填充，置于文字左侧），按钮保持现有蓝色底白字样式
  - [x] SubTask 2.2: 点击跳转逻辑不变（`window.dsh.openExternal`），仅改按钮视觉

- [x] Task 3: 移除 GitHub 浮动图标注入及死代码（`src/main/index.ts`）
  - [x] SubTask 3.1: 删除 `injectGitHubLink()` 函数及其在 `startDshAndLoad()`、`performUpdate()` 中的调用点
  - [x] SubTask 3.2: 删除 `adjustFloatingIconsPosition()` 函数及其在 `injectDshUpdateBanner()`、`injectAppUpdateBanner()` 中的调用点
  - [x] SubTask 3.3: 删除 `injectDshUpdateBanner()` / `injectAppUpdateBanner()` 注入代码中全部 `[data-dsh-github-link]` 位置联动逻辑（close 按钮回调内的下移复位、container 高度联动）
  - [x] SubTask 3.4: 更新 `GITHUB_REPO_URL` 常量注释（仅剩「关于」模态框使用）

- [x] Task 4: 同步 AGENTS.md 描述
  - [x] SubTask 4.1: 更新 §5.4 IPC 表中 `open-external` 的触发方描述（删除「DSH UI 中的 GitHub 图标」，保留「关于模态框 GitHub 按钮」）

- [x] Task 5: 编译与运行验证
  - [x] SubTask 5.1: `npm run build` TS 编译通过
  - [x] SubTask 5.2: `npm run dev` 手动验证：帮助按钮位置/菜单弹出、DSH 页面右上角无浮动图标、关于模态框 GitHub 按钮跳转
    - 备注：主进程/titlebar 加载验证通过且无 JS 报错；DSH 子进程因 TRAE 沙箱 EPERM 无法完整拉起（环境限制，与改动无关），交互项（菜单弹出、关于模态框跳转）经代码路径复核，建议用户本地做最终视觉确认

# Task Dependencies
- Task 1、Task 2、Task 3 相互独立，可并行
- Task 4 依赖 Task 3 完成后描述才准确（可与之并行执行，描述以目标状态为准）
- Task 5 依赖 Task 1-4 全部完成
