# CC Prompter

**一句话：Shift+Alt 点击页面元素 → Claude Code 直接改代码 → 页面自动刷新**

一个 Vite 插件，将 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 接入你的前端开发工作流。通过可视化元素定位 + 常驻 PTY 会话，实现「点击 → 描述 → 代码自动修改 → HMR 刷新」的闭环。

## 功能特性

* 🎯 **元素定位** — Shift+Alt 悬停元素，自动获取源码路径、行列号、DOM 信息

* 💬 **多 Session 管理** — 多个独立 Claude 会话并行，tab 切换互不干扰

* 📝 **流式渲染** — Markdown 实时渲染、工具调用按序展示、进度指示

* ⏹ **中断控制** — 随时 Stop 打断 Claude 生成，无需杀死会话

* 🔌 **零配置** — 一个插件搞定 code-inspector + PTY sidecar + 脚本注入

* 🖼 **可拖拽面板** — 浮动 iframe 面板，支持拖拽移动、边缘/角缩放

## 快速开始

### 安装

```bash
npm install cc-prompter
```

> 需要本地已安装 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（`claude` 命令可用）。

### 配置

在 `vite.config.ts` 中添加插件：

```typescript
import { ccPromptPlugin } from 'cc-prompter';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    ccPromptPlugin(),  // ← 这一行就够了
    react(),
  ],
});
```

### 使用

1. **启动开发服务器** — `npm run dev`

2. **Shift+Alt 悬停** — 将鼠标移到页面元素上，按住 Shift + Alt (Mac: Option)

3. **点击元素** — 自动弹出 CC Prompter 面板，附带源码定位信息

4. **描述修改** — 在输入框输入你想要的修改，按 Enter 发送

5. **Claude 修改代码** — Claude Code 通过 PTY 直接操作你的代码文件

6. **HMR 刷新** — Vite 热更新自动生效

### 快捷键

| 快捷键                | 作用             |
| ------------------ | -------------- |
| `Shift + Alt + 点击` | 定位元素并打开面板      |
| `Ctrl + Shift + P` | Toggle 面板显示/隐藏 |
| `Escape`           | 隐藏面板           |

## 配置选项

```typescript
interface CcPromptOptions {
  /** Sidecar 启动端口，默认 3456（被占用时自动 +1） */
  port?: number;
  /** 项目根目录，默认 vite config.root */
  root?: string;
  /** 是否启用 code-inspector，默认 true */
  inspector?: boolean;
}
```

### 示例

```typescript
// 自定义端口
ccPromptPlugin({ port: 4000 })

// 禁用内置的 code-inspector（你自己配置）
ccPromptPlugin({ inspector: false })
```

## 工作原理

```text
┌─────────────────────────────────────────────────┐
│                  Vite Dev Server                 │
│                                                  │
│  ┌──────────┐   ┌───────────┐   ┌────────────┐  │
│  │  React    │   │  inject.js│   │  panel.html│  │
│  │  App      │◄──│  (main)   │──►│  (iframe)  │  │
│  └──────────┘   └─────┬─────┘   └─────┬──────┘  │
│                       │ postMessage       │ SSE   │
└───────────────────────┼──────────────────┼────────┘
                        │                  │
                   ┌────▼──────────────────▼────┐
                   │     Sidecar (Express)       │
                   │     localhost:3456          │
                   │                             │
                   │  ┌───────┐  ┌───────┐      │
                   │  │ PTY 1 │  │ PTY 2 │ ...  │
                   │  │ Claude│  │ Claude│      │
                   │  └───────┘  └───────┘      │
                   └─────────────────────────────┘
```

### 核心组件

| 组件              | 说明                                                            |
| --------------- | ------------------------------------------------------------- |
| **vite-plugin** | Vite 插件，组合 code-inspector + sidecar 启动 + 脚本注入                 |
| **sidecar**     | Express 服务器，管理 PTY session 生命周期，提供 REST API + SSE 流           |
| **pty-session** | 封装 node-pty，管理 Claude CLI 进程，双通道解析（PTY 输出 + JSONL transcript） |
| **panel.html**  | iframe 面板 UI，多 session tab 管理，Markdown 渲染                     |
| **inject.js**   | 注入主应用的脚本，监听 code-inspector 事件，管理面板容器                          |

### API 端点

Sidecar 自动启动在端口 3456（被占用时自动递增）：

| 方法       | 路径                            | 说明                 |
| -------- | ----------------------------- | ------------------ |
| `GET`    | `/api/sessions`               | 列出所有会话             |
| `POST`   | `/api/sessions`               | 创建新会话              |
| `POST`   | `/api/sessions/:id/message`   | 发送消息（SSE 流式响应）     |
| `POST`   | `/api/sessions/:id/command`   | 发送命令（如 `/compact`） |
| `POST`   | `/api/sessions/:id/interrupt` | 中断当前生成             |
| `DELETE` | `/api/sessions/:id`           | 销毁会话               |

## Session 独立性

每个 Session 完全独立：

* **独立 PTY 进程** — 每个 session 对应一个 Claude CLI 进程

* **独立源码定位** — 各 session 维护自己的 source info

* **独立流式渲染** — SSE 事件只路由到对应的 session，切 tab 不串

* **独立对话上下文** — Claude 的对话历史互不影响

可以在 session 1 执行修改的同时，在 session 2 发起另一个请求。

## 开发

```bash
# 安装依赖
cd packages/cc-prompter && npm install

# 构建
npm run build

# 监听模式
npm run dev

# 在 demo 项目中测试
cd ../../demo && npm link cc-prompter
npm run dev
```

## 技术栈

* **TypeScript** — 类型安全

* **tsup** — ESM + CJS 双格式构建

* **node-pty** — 终端模拟器，交互式 Claude CLI

* **Express** — Sidecar HTTP 服务器

* **code-inspector-plugin** — 编译时 DOM 打标 + 运行时交互

* **纯 HTML/CSS/JS** — 面板 UI，零框架依赖

## License

MIT

⠀