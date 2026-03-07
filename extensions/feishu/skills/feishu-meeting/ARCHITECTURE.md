# feishu-meeting 架构文档

## 概览

飞书会议室预约 CLI 工具，供 OpenClaw 技能系统调用。使用 `requests` 直接调用飞书 HTTP API（避免 `lark_oapi` 的 13 秒导入开销）。

## 身份与权限模型

系统使用两种身份，职责严格隔离：

```
┌─────────────────────────────────────────────────────┐
│                    Bot (tenant_access_token)         │
│                                                     │
│  ✅ 查询会议室列表 (vc/v1/rooms)                      │
│  ✅ 查询房间空闲状态 (freebusy/list)                   │
│  ✅ 查询参会人空闲 (freebusy/list)                     │
│  ✅ 取消 bot 日历上的旧事件 (兼容历史数据)               │
│  ❌ 不再用于创建日程                                   │
│  ❌ 无法操作用户个人日历                                │
├─────────────────────────────────────────────────────┤
│                User (user_access_token via OAuth)    │
│                                                     │
│  ✅ 创建日历事件 (calendar.event:create)               │
│  ✅ 添加参会人/会议室 (calendar.event:update)           │
│  ✅ 取消会议 (calendar.event:delete)                   │
│  ✅ 读取日历信息 (calendar:read, event:read)           │
└─────────────────────────────────────────────────────┘
```

### 为什么不用 bot 创建日程？

- bot 创建的日程在 bot 日历上，用户无法自行取消或编辑
- 用户身份创建的日程在用户个人日历上，用户拥有完全控制权

## OAuth 授权

### 必须显式请求 scope

飞书 OAuth **不会自动授予**应用配置的所有权限。必须在授权 URL 的 `scope` 参数中显式列出需要的权限，否则 token 不包含这些 scope。

当前请求的 scope（`OAUTH_SCOPES` 常量）：

| scope | 用途 |
|-------|------|
| `calendar:calendar.event:create` | 创建日程 |
| `calendar:calendar.event:read` | 读取日程 |
| `calendar:calendar.event:update` | 添加参会人/会议室 |
| `calendar:calendar.event:delete` | 取消会议 |
| `calendar:calendar:read` | 读取日历列表（获取主日历 ID） |
| `calendar:calendar.free_busy:read` | 查询空闲状态 |

### 授权流程

```
用户 ──请求预约──→ OpenClaw ──schedule──→ CLI
                                          │
                                    _ensure_user_token()
                                          │
                              ┌─── token 有效 ───→ 继续预约
                              │
                              └─── token 无效 ───→ 返回 auth_url
                                          │
用户 ←── 授权链接 ←── OpenClaw ←───────────┘
  │
  └──→ 浏览器授权 → redirect → localhost?code=xxx
  │
  └──→ 发 code 给 OpenClaw ──auth --code──→ CLI
                                            │
                                    v2/oauth/token 换 token
                                            │
                                    存储到 user_oauth_token.json
```

### Token 存储

文件：`user_oauth_token.json`

```json
{
  "user_access_token": "u-xxx",
  "refresh_token": "",
  "token_expires": 1770962233,
  "refresh_expires": 1773554233,
  "user_calendar_id": "user@bytedance.com"
}
```

`user_calendar_id` 动态补获取：如果首次授权未拿到，`_book_event` 和 `cmd_cancel` 会在运行时自动调用 `_get_user_calendar_id()` 补获取并持久化。

### API 版本

- 授权页面：`/open-apis/authen/v1/authorize`（v1，带 scope 参数）
- 换 token：`/open-apis/authen/v2/oauth/token`（v2，用 client_id + client_secret）

选择 v2 token endpoint 的原因：不需要先获取 app_access_token，减少一次 API 调用。

## 预约链路

### 完整流程

```
suggest_schedule()
│
├─ 1. 授权检查
│     _ensure_user_token() → 无效则返回 auth_url 错误
│
├─ 2. 加载会议室
│     _get_floor_rooms()
│     ├─ 优先读缓存 (meeting_rooms_cache.json, TTL 7天)
│     └─ 缓存失效 → API 拉取 F2-F5 楼层会议室
│        ├─ _get_floors() → /vc/v1/room_levels (bot token)
│        └─ _get_rooms_on_floor() → /vc/v1/rooms (bot token)
│           └─ 过滤: capacity >= 4
│
├─ 3. 准备候选
│     _prepare_candidates()
│     ├─ 有偏好 → 按偏好排序: 偏好 > 普通 > 应急
│     └─ 无偏好 → 普通随机打散, 应急追加末尾
│     └─ 过滤: 容量匹配 + 时长匹配(短时会议室 ≤ 30min)
│
├─ 4. 遍历时间槽
│     for slot in time_slots:
│       for (start, end) in _iter_slot_candidates():
│         ├─ 跳过屏蔽时段 (12-14午休, 18-20晚餐, 除非 force_time)
│         ├─ 检查参会人空闲 _users_available() (bot token)
│         │
│         ├─ 5. 查找空闲房间 _find_available_rooms()
│         │     ├─ 优先: 批量 API /meeting_room/freebusy/batch_get
│         │     │        (1 次请求查 20 间, 失败则缓存跳过)
│         │     └─ 降级: 并发 freebusy/list (8间一批, 找够即停)
│         │            └─ 跳过 decline 缓存中的房间
│         │
│         └─ 6. 创建事件 _book_event()
│               ├─ 获取 user_token + user_calendar_id
│               ├─ POST /calendars/{cal}/events (user token)
│               │   └─ 创建日程到用户个人日历
│               ├─ POST /calendars/{cal}/events/{id}/attendees (user token)
│               │   ├─ 组织者自己 (避免"不参与"状态)
│               │   ├─ 会议室 (resource)
│               │   └─ 其他参会人 (user)
│               └─ 返回 (event_id, app_link, calendar_id)
│
├─ 7a. 有空闲房间 → 返回预约结果 (含 event_id, calendar_id)
│
├─ 7b. 无空闲房间 → 创建无房间事件, 返回 no_room: true
│
└─ 7c. 创建也失败 → 返回错误
```

### 关键设计决策

| 决策 | 原因 |
|------|------|
| 组织者加入参会人列表 | 否则飞书显示组织者"不参与" |
| freebusy 用 bot token | bot 有全局会议室查询权限 |
| 创建事件用 user token | 日程在用户日历上，用户可自行管理 |
| 添加参会人用 user token | bot 无权操作用户个人日历上的事件 |
| 返回 event_id + calendar_id | 取消会议时需要这两个字段 |

## 取消链路

```
cmd_cancel(event_id, calendar_id?)
│
├─ 有 user_token
│   ├─ calendar_id 未传 → 从 token 文件读 user_calendar_id
│   │                     (无则动态获取并持久化)
│   └─ DELETE /calendars/{cal}/events/{id} (user token)
│
└─ 无 user_token (兼容 bot 创建的旧事件)
    ├─ calendar_id 未传 → 获取 bot 主日历 ID
    └─ DELETE /calendars/{cal}/events/{id} (bot token)
```

## 缓存体系

| 文件 | TTL | 内容 |
|------|-----|------|
| `meeting_rooms_cache.json` | 7 天 | F2-F5 楼层会议室列表 + bot 日历 ID + batch API 可用性 |
| `meeting_rooms_decline.json` | 30 天 | 永远 decline bot 的会议室 ID 集合 |
| `user_oauth_token.json` | token 有效期 | user_access_token + user_calendar_id |

## CLI 子命令

| 命令 | 说明 | 身份 |
|------|------|------|
| `schedule --json '{...}'` | 预约会议室 | user token (必须) + bot token (freebusy) |
| `cancel --event-id ID [--calendar-id ID]` | 取消会议 | user token 优先, bot token 兜底 |
| `list-rooms` | 列出会议室 | bot token |
| `refresh-cache` | 刷新会议室缓存 | bot token |
| `auth [--code CODE]` | OAuth 授权 | - |
| `auth-status` | 查看授权状态 | - |

## 飞书 API 调用清单

| API | 身份 | 用途 |
|-----|------|------|
| `POST /auth/v3/tenant_access_token/internal` | app credentials | 获取 bot token |
| `POST /authen/v2/oauth/token` | client_id + secret | 换取 user token |
| `GET /vc/v1/room_levels` | bot | 获取楼层列表 |
| `GET /vc/v1/rooms` | bot | 获取楼层会议室 |
| `POST /calendar/v4/freebusy/list` | bot | 查询房间/用户空闲 |
| `POST /meeting_room/freebusy/batch_get` | bot | 批量查询房间空闲 |
| `GET /calendar/v4/calendars` | user/bot | 获取日历列表 |
| `POST /calendar/v4/calendars/{cal}/events` | user | 创建日程 |
| `POST /.../events/{id}/attendees` | user | 添加参会人 |
| `DELETE /.../events/{id}` | user/bot | 取消日程 |

## 飞书开放平台配置要求

### 应用权限（tenant + user 都需要）

```
calendar:calendar.event:create
calendar:calendar.event:read
calendar:calendar.event:update    ← 注意不是 calendar:calendar:update
calendar:calendar.event:delete    ← 注意不是 calendar:calendar:delete
calendar:calendar:read
calendar:calendar.free_busy:read
vc:rooms.room.basicinfo:read
vc:rooms.roomlevel:read
```

### 安全设置

- 重定向 URL：`http://localhost`

### 常见错误

| 错误码 | 原因 | 解决 |
|--------|------|------|
| 20027 | OAuth scope 未在应用中配置 | 开放平台添加对应权限并发布 |
| 20029 | redirect_uri 不在白名单 | 安全设置添加 `http://localhost` |
| 20003 | code 已被使用 | 重新授权获取新 code |
| 20004 | code 已过期 | code 有效期约 5 分钟，需快速使用 |
| 99991679 | user token 缺少所需权限 | 检查 OAuth scope 是否显式请求 |
| 191002 | bot 无权访问用户日历 | 正常，用 user token 操作 |
