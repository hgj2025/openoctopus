---
name: feishu-meeting
description: >-
  飞书会议室预约。当用户提到预约会议室、约会议室、订会议室、开会、booking meeting room 时激活。
  支持自然语言描述，会主动询问缺失信息（城市/工区、时间、人数等）。
allowed-tools: Bash, Read
---

# 飞书会议室预约

## 激活条件

用户提到**预约会议室、约会议室、订会议室、开会、booking room** 时激活。

## 绝对禁止

1. **禁止编造预约结果** — 只有 bash 命令的 stdout 才是真实结果。
2. **禁止跳过 bash 执行** — 每次预约必须实际运行 CLI 命令。
3. **禁止伪造 JSON 输出** — 真实结果只来自命令执行。

---

## 交互流程（必须遵守顺序）

### 第一步：确认城市/工区（最优先）

**如果用户消息未指定城市或工区，必须先问**：

> 您在哪个城市/工区开会？
> - 北京大钟寺（`dazhongsi`）
> - 杭州T1园区（`hangzhou-t1`，需先确认 building_level_id）
> - 其他园区（我可以帮您查询可用楼宇列表）

收到用户回复后，映射到 `area` 字段或 `building_level_id`（见下方区域配置表）。

**如果用户消息中已包含城市/工区信息**（如"杭州的会议室"、"大钟寺附近"），直接识别，不必再问。

### 第二步：收集会议信息（可在一轮完成，也可分轮）

从用户的自然语言中提取，缺什么问什么：

| 字段 | 是否必填 | 问法示例 |
|------|---------|---------|
| 时间 | **必填** | "什么时候开？" |
| 时长 | 选填，默认 60 分钟 | "开多久？（默认1小时）" |
| 人数 | 选填 | "几个人参会？" |
| 会议标题 | 选填，默认"会议" | — |

**允许用户一次性提供全部信息**，不要强制多轮问答。例如：
> "帮我约明天下午3点大钟寺的会议室，5个人，开1小时，主题是项目评审"

→ 直接提取所有字段，跳过询问，直接执行。

### 第三步：执行预约

构造 JSON 并调用 CLI。

---

## 区域配置表

| 用户说 | area | 说明 |
|--------|------|------|
| 北京 / 大钟寺 / 北京大钟寺 | `dazhongsi` | 已预设，直接可用 |
| 杭州 / 杭州T1 / T1园区 | `hangzhou-t1` | 需先运行 `list-buildings` 确认真实 building_level_id |
| 其他园区/城市 | 动态 | 运行 `list-buildings` 获取 `room_level_id`，作为 `building_level_id` 传入 |

### 杭州等非预设区域的处理流程

1. 运行 `list-buildings` 列出所有楼宇
2. 告诉用户列表，请其确认目标楼宇
3. 将对应的 `room_level_id` 作为 `building_level_id` 传入 schedule JSON

```bash
python3 {baseDir}/meeting_cli.py list-buildings
```

---

## CLI 命令

### 预约会议室

```bash
python3 {baseDir}/meeting_cli.py schedule --json '<JSON>'
```

**JSON 字段完整说明**：

```jsonc
{
  "title": "项目评审",                      // 会议标题（默认"会议"）
  "time_slots": [                           // 候选时间段（必填）
    {
      "start": "2025-01-15T14:00:00+08:00", // ISO 8601，必须含时区
      "end":   "2025-01-15T15:00:00+08:00",
      "flexible": false                     // true = 系统在此窗口内按30min步长找空闲
    }
  ],
  "duration_minutes": 60,                   // 会议时长（分钟）
  "attendee_count": 5,                      // 参会人数（用于筛选容量）
  "attendee_open_ids": ["ou_xxx"],          // 参会人 open_id，自动检查忙闲并邀请
  "preferred_rooms": ["大会议室A"],         // 偏好会议室名称
  "preferred_floor": "F3",                  // 偏好楼层
  "force_time": false,                      // true = 允许预约午休(12-14)和晚餐(18-20)时段
  "notes": "备注内容",

  // --- 区域参数（三选一）---
  "area": "dazhongsi",                      // 预设区域 key（见区域配置表）
  "building_level_id": "omb_xxx",           // 直接指定楼宇 ID（覆盖 area）
  "allowed_floors": ["F2", "F3", "F4"],     // 限制楼层（配合 building_level_id）
  "min_capacity": 4                         // 最小容量过滤（默认4）
}
```

**时间转换规则**（当前时区 Asia/Shanghai，UTC+8）：
- "明天下午3点到4点" → `{"start":"YYYY-MM-DDT15:00:00+08:00","end":"YYYY-MM-DDT16:00:00+08:00"}`
- 只说开始时间+时长：计算出 end
- 没说时长：默认 60 分钟，`end = start + 1h`
- 时间范围内灵活安排：设 `flexible: true`，`start`=窗口开始，`end`=窗口结束

**默认屏蔽时段**：12:00-14:00（午休）、18:00-20:00（晚餐）。用户明确要求这些时段时设 `force_time: true`。

### 取消会议

```bash
python3 {baseDir}/meeting_cli.py cancel \
  --event-id <event_id> [--calendar-id <calendar_id>]
```

`event_id` 和 `calendar_id` 来自 `schedule` 返回的 `data.event_id` 和 `data.calendar_id`。

### 查看可用会议室

```bash
python3 {baseDir}/meeting_cli.py list-rooms --area <area>
```

### 查询所有楼宇（发现新区域）

```bash
python3 {baseDir}/meeting_cli.py list-buildings
```

### 刷新缓存

```bash
python3 {baseDir}/meeting_cli.py refresh-cache --area <area>
```

---

## OAuth 用户授权

预约前必须完成用户授权（以用户身份创建日历事件）。

### 何时需要授权

`schedule` 返回 `success: false` 且含 `auth_url` 字段时。

### 授权流程

**第一步：获取授权链接**

```bash
python3 {baseDir}/meeting_cli.py auth
```

将返回的 URL 发给用户，告知：
> 请在浏览器打开此链接完成授权。授权后浏览器会跳到打不开的页面（正常），请复制地址栏 `code=` 后面的值发回来。

**第二步：提交 code**

用户回复可能是以下任意形式：
- `abc123`（纯 code）
- `code=abc123`
- `http://localhost/?code=abc123`（完整 URL）

从中提取 code，**立即**执行：

```bash
python3 {baseDir}/meeting_cli.py auth --code <code>
```

**授权失败错误码**：

| 错误码 | 原因 | 处理 |
|--------|------|------|
| `20004` / `expired` | code 已过期（有效期约5分钟） | 重新获取授权链接 |
| `20003` / `has been used` | code 已使用 | 重新获取授权链接 |
| `20029` / `redirect_uri` | 重定向 URL 未配置 | 在飞书开放平台安全设置中添加 `http://localhost` |

失败后自动重新获取授权链接（运行 `auth` 不带 `--code`），发给用户重试。

---

## 输出处理

CLI 以 JSON 输出到 stdout：

- `success: true` → 告知用户预约成功，引用 `data.message`（含会议室名、楼层、时间）
- `success: false` + `auth_url` → 走授权流程
- `success: false` + `error` → 告知用户失败原因，引用 `error` 字段

---

## 完整对话示例

### 示例1：用户未指定工区

```
用户: 帮我约个明天下午3点的会议室

助手: 您在哪个城市/工区开会？
      - 北京大钟寺
      - 杭州T1园区
      - 其他（我可以查询可用楼宇列表）

用户: 北京大钟寺

助手: [bash] python3 {baseDir}/meeting_cli.py schedule --json \
      '{"title":"会议","area":"dazhongsi","time_slots":[{"start":"2025-01-15T15:00:00+08:00","end":"2025-01-15T16:00:00+08:00"}]}'

助手: 已为您预约 大钟寺F3-会议室301（10人），明天15:00-16:00。
```

### 示例2：用户一次性提供全部信息

```
用户: 帮我约杭州T1明天上午10点的会议室，5人，项目评审，开1.5小时

助手: 好的，杭州T1园区需要先确认楼宇 ID，稍等...
      [bash] python3 {baseDir}/meeting_cli.py list-buildings

助手: 请问您要预约的是以下哪个楼宇？（列出返回结果）
      1. T1仓南广场B座 (room_level_id: omb_xxx)
      2. T1仓南广场A座 (room_level_id: omb_yyy)

用户: B座

助手: [bash] python3 {baseDir}/meeting_cli.py schedule --json \
      '{"title":"项目评审","building_level_id":"omb_xxx","time_slots":[...],"attendee_count":5,"duration_minutes":90}'
```

### 示例3：信息完整直接预约

```
用户: 预约大钟寺明天下午2-3点会议室，3人

助手: [bash] python3 {baseDir}/meeting_cli.py schedule --json \
      '{"title":"会议","area":"dazhongsi","time_slots":[{"start":"...T14:00:00+08:00","end":"...T15:00:00+08:00"}],"attendee_count":3}'

助手: 已预约 大钟寺F2-快速会议室，明天14:00-15:00。
```
