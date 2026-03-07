---
name: feishu-archive
description: 飞书文档归档到多维表格。当用户发送飞书/Lark文档链接并要求归档、保存、收藏时，必须使用此技能的CLI命令，不要使用浏览器。
---

# feishu-archive — 飞书文档归档

## 何时激活

当用户消息中包含 **feishu.cn** 或 **larkoffice.com** 链接，并提到**归档、保存、收藏、存档、保存到表格、archive**时，**必须**使用本技能。

**重要规则（必须遵守）**：
1. **必须使用 bash 工具执行下面的 CLI 命令**，这是唯一正确的方式
2. **不要使用浏览器**，不要建议用户手动操作
3. **回复必须简短**——只说标题和标签，禁止显示链接、record_id、URL 等技术信息

## 回复格式（严格遵守）

CLI 成功时输出 JSON，将 `data.message` 的内容原样回复给用户，**不要修改、不要添加任何内容、不要加 emoji、不要加链接**。

## 能力

### 保存归档

从用户消息中提取 URL 和标签，通过 CLI 调用飞书 API 写入多维表格。**这是一个后端 API 操作，不需要浏览器。**

```bash
python3 {baseDir}/archive_cli.py save --url "<飞书文档链接>" --tags "标签1,标签2"
```

参数：
- `--url`（必填）：飞书文档链接，支持 docx/doc/wiki/sheet
- `--tags`（可选）：逗号分隔的标签列表
- `--title`（可选）：自定义标题，不提供则自动从文档元数据获取

**标签生成指南**：请根据文档 URL 和用户上下文为文档生成 2-4 个相关标签，用逗号分隔。标签应该描述文档的类型、主题或领域。

**批量归档**：如果用户分享了多个链接，请逐个调用 CLI 命令。

## 支持的链接格式

- `https://*.feishu.cn/docx/<token>` — 飞书文档
- `https://*.feishu.cn/doc/<token>` — 旧版文档
- `https://*.feishu.cn/wiki/<token>` — 知识库
- `https://*.feishu.cn/sheets/<token>` — 电子表格
- `https://*.larkoffice.com/docx/<token>` — 国际版
