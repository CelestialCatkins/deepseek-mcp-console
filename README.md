# deepseek-mcp-console
为 DeepSeek 网页版打造的 MCP 客户端用户脚本：通过  ```mcp  指令通道让 AI 调用 Streamable HTTP MCP 工具，内置悬浮球面板、多服务管理、风险确认、工具说明生成与系统提示词注入。
# MCP 控制台

> 为 DeepSeek 网页版打造的 MCP 客户端面板 —— 用 ` ```mcp ` 指令通道，让 AI 真正调用你的 MCP 工具。

![version](https://img.shields.io/badge/version-1.3.0-blue)
![platform](https://img.shields.io/badge/platform-DeepSeek-4d6bfe)
![protocol](https://img.shields.io/badge/MCP-2025--03--26-059669)
![license](https://img.shields.io/badge/license-MIT-green)

---

## 简介

**MCP 控制台** 是一个运行在 [DeepSeek](https://chat.deepseek.com/) 网页版上的油猴脚本（userscript）。它在页面右上角挂一个悬浮球，点开后是一个完整的 MCP 客户端面板：

- 连接任意 **Streamable HTTP**（含 SSE）MCP 服务
- 扫描并展示全部工具，按只读 / 写入标注权限
- 表单或 JSON 两种方式直接调用工具
- 让 AI 通过 ` ```mcp ` 代码块「请求」调用工具，由你在面板里确认后执行
- 自动生成工具说明文档，可作附件交给 AI 阅读
- 一键注入系统提示词，把工具清单「告诉」模型

所有数据（服务配置、调用记录、界面偏好）都存在浏览器本地的 GM 存储里，不上传任何服务器。

---

## 特性

### 悬浮球
- **单击**：打开 / 关闭控制台面板
- **双击**：暂停 / 恢复 AI 指令识别（暂停时球体变虚线）
- **长按 550ms**：重扫全部服务的工具列表
- **拖动**：自由摆放位置，松手后自动吸附在可视区域内
- 球体外圈是扫描进度环，右上角红点表示有未读的调用请求

### 工具页
- 多服务切换（「全部」/ 单个服务）
- 实时搜索工具名与描述
- 只读 / 写入徽章，基于 `annotations.readOnlyHint`、`annotations.destructiveHint` 与危险动词匹配综合判断
- 点击工具卡片 → 弹出调用表单，自动根据 `inputSchema` 生成字段（支持 enum、boolean、number、object/array）
- 表单 / JSON 模式一键切换
- AI 请求调用会以醒目卡片置顶，可「确认执行」或「忽略」

### 记录页
- 最近 60 条调用记录，含工具名、耗时、结果摘要
- 失败调用保留错误信息
- 一键清空

### 设置页
- **服务管理**：增删改 MCP 服务，支持自定义 Headers（如 `Authorization: Bearer xxx`）
- **外观**：5 套配色（墨 / 靛 / 松 / 紫 / 橙）+ 深色模式
- **风险控制**：全部允许 / 部分确认 / 全部确认 三档
- **AI 通道**：
  - 生成《MCP-工具调用说明.md》并尝试作为附件挂到输入框（不支持时自动降级为下载或复制）
  - 复制说明文本到剪贴板
  - 注入系统提示词（可仅填入或直接发送）
  - 重置当前会话状态
  - 重扫工具

### 会话感知
- 自动识别 DeepSeek 的会话切换（`/a/chat/s/<id>`）
- 新对话开始时清空待确认请求、搜索状态与注入标记，避免串会话

---

## 快速开始

### 1. 安装脚本

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)
2. 打开本仓库的 `dist/mcp-console.user.js`（或直接复制根目录脚本内容）
3. 在扩展面板里「添加新脚本」→ 粘贴 → 保存
4. 访问 <https://chat.deepseek.com/>，右上角出现悬浮球即安装成功

> 脚本需要 `GM_getValue` / `GM_setValue` / `GM_deleteValue` 权限用于本地存储。

### 2. 添加 MCP 服务

点击悬浮球 → **设置** → **服务管理** → **添加服务**：

| 字段 | 说明 | 示例 |
|---|---|---|
| 名称 | 面板与指令中使用的服务标识 | `filesystem` |
| URL | Streamable HTTP 端点 | `https://mcp.example.com/mcp` |
| Headers | 每行 `Key: Value` | `Authorization: Bearer sk-xxx` |

保存后会自动扫描工具列表。

### 3. 让 AI 调用工具

先让 AI 知道有哪些工具可用，两种方式任选：

- **附件方式**：设置 → AI 通道 → **生成说明附件**，把生成的 `MCP-工具调用说明.md` 随消息一起发送
- **提示词方式**：设置 → AI 通道 → **注入并发送**，把服务名清单和调用格式告诉模型

然后 AI 就会在回复里写这样的代码块：
