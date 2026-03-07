---
name: feishu-todo
description: 飞书待办/todo/任务/备忘管理。当用户要记 todo、记一下、备忘、创建待办、设置提醒、查询任务时使用。
---

# feishu-todo — 飞书待办任务管理

## 何时激活

当用户提到**记一下、备忘、todo、待办、任务、提醒、todolist**，或要求**记/创建/查询/列出 任务/待办/todo**时，**必须**使用本技能。

常见触发表达：「记一个 todo」「帮我记一下」「加个待办」「提醒我」「备忘一下」「有什么任务」

**重要**：不要尝试用浏览器打开飞书，不要建议用户手动操作。直接运行下面的 CLI 命令即可，无需浏览器。

## 能力

### 1. 创建待办

从用户消息中提取以下字段，构造 JSON 后调用 CLI：

- `title`（string，必填）：任务标题，不超过 30 字
- `description`（string）：任务描述
- `due_time`（ISO 8601）：截止时间，带时区（+08:00）。用户说"明天下午3点"时转换为完整 ISO 8601
- `owner_open_id`（string）：负责人飞书 open_id，默认由系统分配
- `priority`（int）：优先级 1-4
- `notify_all`（bool）：是否立即提醒，默认 false

**时间转换指南**（当前时区 Asia/Shanghai, UTC+8）：
- "今天" → 当天 18:00
- "明天" → 次日 18:00
- "下周五" → 下一个周五 18:00
- "后天下午3点" → 后天 15:00
- 如果未指定时间，默认 18:00
- 如果未指定日期，默认 3 天后

```bash
python3 {baseDir}/todo_cli.py create --json '{"title":"写周报","due_time":"2025-01-15T18:00:00+08:00"}'
```

### 2. 查询待办

```bash
python3 {baseDir}/todo_cli.py query --user-id <open_id> [--status <status>] [--limit <n>]
```

- `--user-id`：必填，飞书用户 open_id
- `--status`：可选，筛选状态
- `--limit`：可选，返回数量，默认 20

## 输出格式

CLI 以 JSON 输出结果到 stdout，包含 `success` 布尔值和 `data`/`error` 字段。请将结果用自然语言总结给用户。
