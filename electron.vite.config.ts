import { defineConfig } from 'electron-vite'
import { resolve } from 'path'

// electron-vite 配置：分别定义主进程、preload 和渲染进程的入口
// 渲染进程使用多页面入口（loading.html 和 error.html）
// 输出目录统一为 dist，与 package.json 的 main 字段保持一致
export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          loading: resolve(__dirname, 'src/renderer/loading.html'),
          error: resolve(__dirname, 'src/renderer/error.html')
        }
      }
    }
  }
})
