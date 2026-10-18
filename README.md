# 层叠生活态 · Layered Life State

将生活照片、物件与情绪标注转化为可交互的建筑展示。项目包括照片接收、情绪轮盘、AI 图片分析、Rodin 三维建模、建筑展示，以及实体旋转轴串口同步。

## 项目结构

主要程序位于 `层叠生活态_便携版/`：

| 目录 / 文件 | 用途 |
| --- | --- |
| `receiver/src/` | Node.js / TypeScript 本地服务、会话、分析与建模流程 |
| `receiver/public/` | 展示页面、情绪交互和 API Key 设置页面 |
| `receiver/tests/` | 串口、模型失败恢复和密钥配置测试 |
| `scripts/test_deepseek_json_mode.ps1` | DeepSeek 主线路、Qwen 备用图片分析线路 |
| `Techathon_完整交付_20261017/pipelines/model-production/` | Rodin 建模、照片裁剪、场景构建脚本 |
| `hardware/dashboard/` | Python 串口桥接与旋转轴数据解析 |
| `deepseek-image-analysis/` | 图片分析提示词 |
| `shared/` | 应用与物件目录数据 |

项目介绍、成员占位信息、功能说明和待确认的原创声明见 [项目说明文档](层叠生活态_项目说明文档.md)。

## 从源码运行（Windows）

本仓库不包含便携运行时、`node_modules`、浏览器安装文件和个人会话数据。原来的 `启动层叠生活.cmd` 用于带运行时的本地便携包；从 GitHub 克隆后按以下步骤运行。

准备 Node.js 24、Python 3.11 或以上版本和 PowerShell 7，确保 `node`、`npm`、`python`、`pwsh` 可在终端调用。

在仓库根目录打开 PowerShell：

```powershell
Set-Location './层叠生活态_便携版/receiver'
npm ci
npx playwright install chromium
python -m pip install Pillow pyserial
npm run build
$env:RECEIVER_PORT = '8790'
npm start
```

打开 `http://127.0.0.1:8790/`。服务默认只监听本机。每次正常启动会开启新一轮；如需恢复现有会话，在启动前设置 `$env:RECEIVER_RESUME_SESSION = '1'`。

需要 Blender 的场景构建与重新渲染流程，还需自行准备 Blender。源码仓库不包含已有会话的照片、生成模型和导出海报。

## 配置三个 API Key

启动后打开 `http://127.0.0.1:8790/api-keys.html`，填写 DeepSeek、Rodin、Qwen 三个 Key 并保存。

- 页面文件：`receiver/public/api-keys.html`。
- 唯一密钥文件：项目程序目录下的 `.local/api-keys.json`，不存在时自动创建。
- 新 Key 从下一次调用开始生效；输入框留空保留原值。
- 页面只返回配置状态，不回显已保存的 Key。
- API Key 不再从 `.env.local` 或 `provider-keys.cjs` 读取。
- API 地址和模型名称仍使用分析、建模脚本中的配置。Qwen 当前调用 `maas.qianwenaiapi.com`，所填 Key 必须与该接口匹配。

自动创建的文件结构如下（请只在本机填写真实值）：

```json
{
  "DEEPSEEK_API_KEY": "",
  "RODIN_API_KEY": "",
  "QWEN_API_KEY": ""
}
```

`.gitignore` 已排除密钥、环境文件、运行时、依赖、浏览器资料、个人会话、串口日志、旧版备份和生成输出。手工打包分享时也应排除这些本地内容。

## 验证

在 `receiver/` 目录运行：

```powershell
npm run build
node --test dist/tests/*.test.js
```

测试覆盖串口服务识别、端口冲突处理、部分模型失败后继续展示、Windows 文件写入恢复及 API Key 配置。测试不调用付费 AI 服务。

## 旋转轴和建模

实体旋转轴需要通过 UART / USB-UART 接口连接，在工作人员控制中选择串口并连接同步。连接步骤见程序目录中的 `本次更新与旋转轴使用.txt`。

个别模型生成失败时，系统保留失败原因并跳过该模型，使用已成功生成的模型继续展示；全部模型失败时会明确提示失败。
