#!/usr/bin/env python3
"""飞书会议室预约 CLI — 供 OpenClaw 技能调用。"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import os
import sys

# 将 skills/ 根目录加入 path，使 shared 包可被找到
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import requests

from shared.config import FeishuEnvConfig
from shared.feishu_client import BASE_URL, FeishuClient
from shared.output import output as _output

# ------------------------------------------------------------------
# 常量
# ------------------------------------------------------------------

CST = timezone(timedelta(hours=8))
TIMEZONE_NAME = "Asia/Shanghai"
DEFAULT_DURATION_MINUTES = 60
TIME_GRANULARITY_MINUTES = 30
CACHE_DIR = Path(__file__).resolve().parent
CACHE_TTL_SECONDS = 7 * 24 * 3600  # 7 天
BATCH_API_STATUS_FILE = CACHE_DIR / "batch_api_status.json"


def _cache_file(area: str) -> Path:
    """每个区域独立的会议室缓存文件，避免跨区域缓存污染。"""
    return CACHE_DIR / f"meeting_rooms_cache_{area}.json"


DECLINE_CACHE_FILE = Path(__file__).resolve().parent / "meeting_rooms_decline.json"
DECLINE_CACHE_TTL_SECONDS = 30 * 24 * 3600  # 30 天
OAUTH_TOKEN_FILE = Path(__file__).resolve().parent / "user_oauth_token.json"
REDIRECT_URI = "http://localhost"

# 区域配置
AREA_CONFIGS = {
    "dazhongsi": {
        "name": "大钟寺广场2号楼",
        "building_level_id": "omb_4b48ecaa40b92a0916f791881ede94c2",
        "allowed_floors": {"F2", "F3", "F4", "F5"},
        "min_capacity": 4,
    },
    "hangzhou-t1": {
        "name": "杭州T1仓南广场",
        "building_level_id": "HZ-T1-BLDG-001-LEVEL",  # 占位符，需要实际的 level_id
        "allowed_floors": {"F1", "F2", "F3", "F4", "F5"},
        "min_capacity": 4,
    },
}

# 默认区域
DEFAULT_AREA = "dazhongsi"

# 大钟寺广场2号楼的 room_level_id
BUILDING_LEVEL_ID = "omb_4b48ecaa40b92a0916f791881ede94c2"

ALLOWED_FLOORS = {"F2", "F3", "F4", "F5"}
MIN_CAPACITY = 4

# 工作时间 10:30-21:00，午休 12-14，晚餐 18-20
WORK_START = (10, 30)
WORK_END = (21, 0)
BLOCKED_HOURS = [(12, 14), (18, 20)]

SHORT_ROOM_MAX_MINUTES = 30
SHORT_ROOM_KEYWORD = "短时会议室"
EMERGENCY_ROOM_KEYWORD = "应急会议室"
FREEBUSY_BATCH_SIZE = 20
CONCURRENT_CHECKS = 10



# ------------------------------------------------------------------
# 数据结构
# ------------------------------------------------------------------

@dataclass
class RoomConfig:
    room_id: str
    name: str
    priority: int = 0
    capacity: Optional[int] = None
    location: Optional[str] = None


@dataclass
class FloorInfo:
    level_id: str
    name: str


@dataclass
class MeetingSlot:
    start: datetime
    end: datetime
    flexible: bool = False

    @property
    def duration_minutes(self) -> int:
        return int((self.end - self.start).total_seconds() // 60)


@dataclass
class FloorRooms:
    floor: FloorInfo
    rooms: List[RoomConfig]


# ------------------------------------------------------------------
# 会议室缓存
# ------------------------------------------------------------------

def _load_cache(area: str = DEFAULT_AREA) -> Optional[Dict[str, Any]]:
    cf = _cache_file(area)
    if not cf.exists():
        return None
    try:
        data = json.loads(cf.read_text(encoding="utf-8"))
    except Exception:
        return None
    if time.time() - data.get("cached_at", 0) > CACHE_TTL_SECONDS:
        return None
    return data


def _save_cache(floor_rooms: List[FloorRooms], app_calendar_id: Optional[str] = None, area: str = DEFAULT_AREA) -> None:
    payload = {
        "cached_at": time.time(),
        "app_calendar_id": app_calendar_id,
        "floors": [
            {
                "level_id": fr.floor.level_id,
                "name": fr.floor.name,
                "rooms": [
                    {
                        "room_id": r.room_id,
                        "name": r.name,
                        "priority": r.priority,
                        "capacity": r.capacity,
                        "location": r.location,
                    }
                    for r in fr.rooms
                ],
            }
            for fr in floor_rooms
        ],
    }
    try:
        _cache_file(area).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _parse_cache(data: Dict[str, Any]) -> List[FloorRooms]:
    result: List[FloorRooms] = []
    for entry in data.get("floors", []):
        floor = FloorInfo(level_id=entry["level_id"], name=entry["name"])
        rooms = [
            RoomConfig(
                room_id=r["room_id"],
                name=r["name"],
                priority=r.get("priority", 0),
                capacity=r.get("capacity"),
                location=r.get("location"),
            )
            for r in entry.get("rooms", [])
            if r.get("room_id") and r.get("name")
        ]
        result.append(FloorRooms(floor=floor, rooms=rooms))
    return result


# ------------------------------------------------------------------
# Decline 缓存 — 记住对 bot 永远 decline 的会议室
# ------------------------------------------------------------------

def _load_decline_set() -> set:
    if not DECLINE_CACHE_FILE.exists():
        return set()
    try:
        data = json.loads(DECLINE_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return set()
    now = time.time()
    # 过滤掉过期条目
    return {rid for rid, ts in data.items() if now - ts < DECLINE_CACHE_TTL_SECONDS}


# ------------------------------------------------------------------
# OAuth 用户授权
# ------------------------------------------------------------------

OAUTH_SCOPES = " ".join([
    "calendar:calendar.event:create",
    "calendar:calendar.event:read",
    "calendar:calendar.event:update",
    "calendar:calendar.event:delete",
    "calendar:calendar:read",
    "calendar:calendar.free_busy:read",
])


def _get_oauth_url(app_id: str) -> str:
    from urllib.parse import quote
    return (
        f"https://open.larkoffice.com/open-apis/authen/v1/authorize"
        f"?app_id={app_id}&redirect_uri={quote(REDIRECT_URI)}"
        f"&response_type=code&scope={quote(OAUTH_SCOPES)}"
    )


def _load_user_token() -> Optional[Dict[str, Any]]:
    if not OAUTH_TOKEN_FILE.exists():
        return None
    try:
        return json.loads(OAUTH_TOKEN_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def _save_user_token(data: Dict[str, Any]) -> None:
    try:
        OAUTH_TOKEN_FILE.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8",
        )
    except Exception:
        pass


def _exchange_code_for_token(api: FeishuClient, code: str) -> Dict[str, Any]:
    resp = requests.post(
        f"{BASE_URL}/open-apis/authen/v2/oauth/token",
        json={
            "grant_type": "authorization_code",
            "client_id": api._app_id,
            "client_secret": api._app_secret,
            "code": code,
            "redirect_uri": REDIRECT_URI,
        },
    ).json()
    # v2 错误格式: {"error": "...", "error_description": "..."}
    if resp.get("error"):
        raise RuntimeError(f"换取 token 失败: {resp.get('error_description', resp.get('error'))}")
    access_token = resp.get("access_token")
    if not access_token:
        raise RuntimeError(f"换取 token 失败: {resp}")
    now = time.time()
    token_data: Dict[str, Any] = {
        "user_access_token": access_token,
        "refresh_token": resp.get("refresh_token", ""),
        "token_expires": now + resp.get("expires_in", 7200),
        "refresh_expires": now + resp.get("refresh_expires_in", 2592000) if resp.get("refresh_expires_in") else now + 2592000,
    }
    _save_user_token(token_data)
    return token_data


def _refresh_user_token(api: FeishuClient, refresh_token: str) -> Optional[Dict[str, Any]]:
    api._ensure_token()
    try:
        resp = requests.post(
            f"{BASE_URL}/open-apis/authen/v1/oidc/refresh_access_token",
            headers={"Authorization": f"Bearer {api._token}"},
            json={"grant_type": "refresh_token", "refresh_token": refresh_token},
        ).json()
    except Exception:
        return None
    if resp.get("code", -1) != 0:
        return None
    d = resp["data"]
    now = time.time()
    old = _load_user_token() or {}
    token_data: Dict[str, Any] = {
        "user_access_token": d["access_token"],
        "refresh_token": d["refresh_token"],
        "token_expires": now + d.get("expires_in", 7200),
        "refresh_expires": now + d.get("refresh_expires_in", 2592000),
        "user_calendar_id": old.get("user_calendar_id"),
    }
    _save_user_token(token_data)
    return token_data


def _ensure_user_token(api: FeishuClient) -> Optional[str]:
    data = _load_user_token()
    if not data:
        return None
    now = time.time()
    if now < data.get("token_expires", 0):
        return data["user_access_token"]
    if now < data.get("refresh_expires", 0):
        refreshed = _refresh_user_token(api, data["refresh_token"])
        if refreshed:
            return refreshed["user_access_token"]
    return None


def _get_user_calendar_id(user_token: str) -> Optional[str]:
    try:
        page_token = None
        while True:
            params = {"page_size": 50}
            if page_token:
                params["page_token"] = page_token

            resp = requests.get(
                f"{BASE_URL}/open-apis/calendar/v4/calendars",
                headers={"Authorization": f"Bearer {user_token}"},
                params=params,
                timeout=10
            ).json()

            if resp.get("code", -1) != 0:
                return None

            for cal in resp.get("data", {}).get("calendar_list") or []:
                # 找主日历且有编辑权限的
                if (cal.get("type") == "primary" and
                    cal.get("role") in ["owner", "editor"] and
                    not cal.get("is_deleted", False)):
                    return cal.get("calendar_id")

            if not resp.get("data", {}).get("has_more"):
                break
            page_token = resp["data"]["page_token"]
        return None
    except Exception:
        return None


# ------------------------------------------------------------------
# 会议室加载（API）
# ------------------------------------------------------------------

def _get_floors(api: FeishuClient, building_id: str) -> List[FloorInfo]:
    try:
        data = api.get("/open-apis/vc/v1/room_levels", {
            "room_level_id": building_id,
            "page_size": 100,
        })
    except Exception:
        return []
    if data.get("code", -1) != 0:
        return []
    items = data.get("data", {}).get("items") or []
    floors = [FloorInfo(level_id=it["room_level_id"], name=it.get("name", ""))
              for it in items if it.get("room_level_id")]
    floors.sort(key=lambda f: f.name)
    return floors


def _get_rooms_on_floor(api: FeishuClient, floor_level_id: str) -> List[RoomConfig]:
    collected: List[RoomConfig] = []
    page_token: Optional[str] = None
    while True:
        params: Dict[str, Any] = {"room_level_id": floor_level_id, "page_size": 100}
        if page_token:
            params["page_token"] = page_token
        try:
            resp = api.get("/open-apis/vc/v1/rooms", params)
        except Exception:
            break
        if resp.get("code", -1) != 0:
            break
        resp_data = resp.get("data", {})
        for room in resp_data.get("rooms") or []:
            if room.get("room_id") and room.get("name"):
                path_list = room.get("path") or []
                collected.append(RoomConfig(
                    room_id=room["room_id"],
                    name=room["name"],
                    capacity=room.get("capacity"),
                    location=path_list[0] if path_list else None,
                ))
        if not resp_data.get("has_more"):
            break
        page_token = resp_data.get("page_token")
        if not page_token:
            break
    return collected


def _get_app_calendar_id(api: FeishuClient, area: str = DEFAULT_AREA) -> Optional[str]:
    """获取应用机器人的主日历 ID（优先从缓存读取），并确保日历权限为 public。"""
    cache = _load_cache(area)
    if cache and cache.get("app_calendar_id"):
        return cache["app_calendar_id"]
    try:
        resp = api.get("/open-apis/calendar/v4/calendars", {"page_size": 50})
    except Exception:
        return None
    if resp.get("code", -1) != 0:
        return None
    cal_list = resp.get("data", {}).get("calendar_list") or []
    cal_id: Optional[str] = None
    for cal in cal_list:
        if cal.get("type") == "primary":
            cal_id = cal.get("calendar_id")
            # 确保日历可被参会人查看
            if cal.get("permissions") != "public" and cal_id:
                try:
                    api.patch(
                        f"/open-apis/calendar/v4/calendars/{cal_id}",
                        body={"permissions": "public"},
                    )
                except Exception:
                    pass
            break
    if not cal_id and cal_list:
        cal_id = cal_list[0].get("calendar_id")
    return cal_id


def _get_floor_rooms(
    api: FeishuClient,
    area: str = DEFAULT_AREA,
    building_level_id: Optional[str] = None,
    allowed_floors: Optional[set] = None,
    min_capacity: Optional[int] = None,
) -> List[FloorRooms]:
    """获取指定区域的会议室，优先使用区域独立的缓存文件。

    可通过 building_level_id / allowed_floors / min_capacity 动态覆盖 AREA_CONFIGS，
    从而支持未预先配置的任意区域（如新的杭州园区）。
    """
    cache = _load_cache(area)
    if cache:
        return _parse_cache(cache)

    # 动态参数优先，其次 AREA_CONFIGS，最后 DEFAULT_AREA 兜底
    area_config = AREA_CONFIGS.get(area, AREA_CONFIGS[DEFAULT_AREA])
    _building_id = building_level_id or area_config["building_level_id"]
    _floors = allowed_floors or area_config["allowed_floors"]
    _min_cap = min_capacity if min_capacity is not None else area_config["min_capacity"]

    floors = _get_floors(api, _building_id)
    if not floors:
        return []

    result: List[FloorRooms] = []
    for floor in floors:
        # 如果没有限制楼层集合（传入空集合视为"不过滤"），则包含所有楼层
        if _floors and floor.name not in _floors:
            continue
        rooms = _get_rooms_on_floor(api, floor.level_id)
        rooms = [r for r in rooms if r.capacity is not None and r.capacity >= _min_cap]
        if rooms:
            result.append(FloorRooms(floor=floor, rooms=rooms))

    if result:
        cal_id = _get_app_calendar_id(api, area)
        _save_cache(result, cal_id, area)
    return result


# ------------------------------------------------------------------
# 排程核心算法
# ------------------------------------------------------------------

def _prepare_candidates(rooms: List[RoomConfig], preferred_names: List[str]) -> List[RoomConfig]:
    """排序候选会议室：偏好 > 普通 > 应急。无偏好时随机打散普通和应急各自内部顺序。"""
    preferred_order: Dict[str, int] = {}
    for idx, name in enumerate(preferred_names):
        preferred_order[name.lower()] = idx

    def _score(room: RoomConfig) -> Tuple[int, int, int]:
        name_key = room.name.lower() if room.name else ""
        id_key = room.room_id.lower() if room.room_id else ""
        pref_rank = preferred_order.get(name_key, preferred_order.get(id_key, len(preferred_order)))
        is_emergency = 1 if EMERGENCY_ROOM_KEYWORD in (room.name or "") else 0
        return (is_emergency, pref_rank, -room.priority)

    if preferred_names:
        return sorted(rooms, key=_score)

    # 无偏好时：普通房间随机打散，应急房间随机打散后追加到末尾
    regular = [r for r in rooms if EMERGENCY_ROOM_KEYWORD not in (r.name or "")]
    emergency = [r for r in rooms if EMERGENCY_ROOM_KEYWORD in (r.name or "")]
    random.shuffle(regular)
    random.shuffle(emergency)
    return regular + emergency


def _iter_slot_candidates(
    slot: MeetingSlot, duration_minutes: int, granularity: int,
) -> Iterable[Tuple[datetime, datetime]]:
    duration = timedelta(minutes=duration_minutes)
    if not slot.flexible:
        end = slot.end if slot.end > slot.start else slot.start + duration
        yield slot.start, end
        return
    step = timedelta(minutes=granularity)
    latest_start = slot.end - duration
    current = slot.start
    while current <= latest_start:
        yield current, current + duration
        current += step


def _capacity_ok(room: RoomConfig, count: Optional[int]) -> bool:
    if count is None or room.capacity is None:
        return True
    return count <= room.capacity


def _duration_ok(room: RoomConfig, duration_minutes: int) -> bool:
    """短时会议室仅在会议时长 <= 30 分钟时可用。"""
    if SHORT_ROOM_KEYWORD in room.name:
        return duration_minutes <= SHORT_ROOM_MAX_MINUTES
    return True


def _in_blocked_hours(start: datetime, end: datetime) -> bool:
    """检查时间段是否在非工作时间或午休/晚餐时段。"""
    local_start = start.astimezone(CST)
    local_end = end.astimezone(CST)
    work_begin = local_start.replace(hour=WORK_START[0], minute=WORK_START[1], second=0, microsecond=0)
    work_finish = local_start.replace(hour=WORK_END[0], minute=WORK_END[1], second=0, microsecond=0)
    if local_start < work_begin or local_end > work_finish:
        return True
    for block_start_h, block_end_h in BLOCKED_HOURS:
        block_start = local_start.replace(hour=block_start_h, minute=0, second=0, microsecond=0)
        block_end = local_start.replace(hour=block_end_h, minute=0, second=0, microsecond=0)
        if local_start < block_end and local_end > block_start:
            return True
    return False


def _users_available(api: FeishuClient, user_ids: List[str], start: datetime, end: datetime) -> bool:
    """检查所有参会人在指定时间是否空闲。"""
    t_min = start.astimezone(timezone.utc).isoformat()
    t_max = end.astimezone(timezone.utc).isoformat()
    for uid in user_ids:
        try:
            resp = api.post(
                "/open-apis/calendar/v4/freebusy/list",
                body={"user_id": uid, "time_min": t_min, "time_max": t_max},
                params={"user_id_type": "open_id"},
            )
        except Exception:
            continue
        if resp.get("code", -1) != 0:
            continue
        if resp.get("data", {}).get("freebusy_list"):
            return False
    return True


def _is_room_available(api: FeishuClient, room_id: str, start: datetime, end: datetime) -> bool:
    """通过日历 freebusy 接口检查单个会议室是否空闲。"""
    try:
        resp = api.post(
            "/open-apis/calendar/v4/freebusy/list",
            body={
                "room_id": room_id,
                "time_min": start.astimezone(timezone.utc).isoformat(),
                "time_max": end.astimezone(timezone.utc).isoformat(),
            },
        )
    except Exception:
        return False
    if resp.get("code", -1) != 0:
        return False
    return not resp.get("data", {}).get("freebusy_list")


def _is_batch_api_available() -> Optional[bool]:
    """读取 batch API 可用性（存储在独立全局文件中，与区域无关）。"""
    try:
        data = json.loads(BATCH_API_STATUS_FILE.read_text(encoding="utf-8"))
        return data.get("available")
    except Exception:
        return None


def _set_batch_api_available(available: bool) -> None:
    """将 batch API 可用性写入全局状态文件。"""
    try:
        BATCH_API_STATUS_FILE.write_text(
            json.dumps({"available": available, "updated_at": time.time()}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        pass


def _try_batch_api(
    api: FeishuClient, room_ids: List[str], time_min: str, time_max: str,
) -> Optional[Dict[str, bool]]:
    """尝试 meeting_room 批量 API。无权限时缓存到文件，后续直接跳过。"""
    cached = _is_batch_api_available()
    if cached is False:
        return None
    try:
        resp = api.post(
            "/open-apis/meeting_room/freebusy/batch_get",
            body={"room_ids": room_ids[:FREEBUSY_BATCH_SIZE], "time_min": time_min, "time_max": time_max},
        )
        if resp.get("code", -1) != 0:
            _set_batch_api_available(False)
            return None
        _set_batch_api_available(True)
        result: Dict[str, bool] = {}
        for i in range(0, len(room_ids), FREEBUSY_BATCH_SIZE):
            batch = room_ids[i:i + FREEBUSY_BATCH_SIZE]
            if i > 0:
                resp = api.post(
                    "/open-apis/meeting_room/freebusy/batch_get",
                    body={"room_ids": batch, "time_min": time_min, "time_max": time_max},
                )
            free_busy = resp.get("data", {}).get("free_busy", {})
            for rid in batch:
                result[rid] = len(free_busy.get(rid, [])) == 0
        return result
    except Exception:
        _set_batch_api_available(False)
        return None


def _find_available_rooms(
    api: FeishuClient, candidates: List[RoomConfig], start: datetime, end: datetime,
    limit: int = 0,
) -> List[RoomConfig]:
    """查找空闲房间。优先批量 API（1 次请求），降级为分批并发（找够即停）。"""
    if not candidates:
        return []

    room_ids = [r.room_id for r in candidates]
    target = limit if limit > 0 else len(candidates)

    # 优先：批量 API（1 次请求查完所有房间）
    time_min = start.astimezone(CST).strftime("%Y-%m-%dT%H:%M:%S+08:00")
    time_max = end.astimezone(CST).strftime("%Y-%m-%dT%H:%M:%S+08:00")
    batch_result = _try_batch_api(api, room_ids, time_min, time_max)
    if batch_result is not None:
        available = [r for r in candidates if batch_result.get(r.room_id, False)]
        return available[:target]

    # 降级：分批并发查，找够即停（8 间一批，通常 1 批就够）
    PROBE_SIZE = max(target + 2, 8)  # 多查几间留余量
    api._ensure_token()
    available: List[RoomConfig] = []

    for i in range(0, len(candidates), PROBE_SIZE):
        batch = candidates[i:i + PROBE_SIZE]
        results: Dict[str, bool] = {}
        with ThreadPoolExecutor(max_workers=min(len(batch), CONCURRENT_CHECKS)) as pool:
            futures = {
                pool.submit(_is_room_available, api, r.room_id, start, end): r
                for r in batch
            }
            for future in as_completed(futures):
                room = futures[future]
                try:
                    results[room.room_id] = future.result()
                except Exception:
                    results[room.room_id] = False
        # 保持原始顺序
        for room in batch:
            if results.get(room.room_id):
                available.append(room)
        if len(available) >= target:
            break

    return available[:target]


def _book_event(
    api: FeishuClient,
    start: datetime,
    end: datetime,
    title: str,
    notes: str = "",
    attendee_open_ids: Optional[List[str]] = None,
    room: Optional[RoomConfig] = None,
) -> Optional[Tuple[str, str, str]]:
    """用用户身份创建日历事件。返回 (event_id, app_link, calendar_id) 或 None。"""
    user_token = _ensure_user_token(api)
    if not user_token:
        return None

    start_ts = str(int(start.astimezone(timezone.utc).timestamp()))
    end_ts = str(int(end.astimezone(timezone.utc).timestamp()))

    token_data = _load_user_token() or {}
    used_calendar_id = token_data.get("user_calendar_id")
    if not used_calendar_id:
        # 首次授权时可能未成功获取，动态补获取并持久化
        used_calendar_id = _get_user_calendar_id(user_token)
        if used_calendar_id:
            token_data["user_calendar_id"] = used_calendar_id
            _save_user_token(token_data)
    if not used_calendar_id:
        return None

    event_body: Dict[str, Any] = {
        "summary": title,
        "description": notes,
        "need_notification": True,
        "visibility": "public",
        "attendee_ability": "can_see_others",
        "start_time": {"timestamp": start_ts, "timezone": TIMEZONE_NAME},
        "end_time": {"timestamp": end_ts, "timezone": TIMEZONE_NAME},
    }

    try:
        resp = requests.post(
            f"{BASE_URL}/open-apis/calendar/v4/calendars/{used_calendar_id}/events",
            headers={"Authorization": f"Bearer {user_token}"},
            json=event_body,
        ).json()
    except Exception:
        return None
    if resp.get("code", -1) != 0:
        return None

    event = resp.get("data", {}).get("event") or {}
    event_id = event.get("event_id")
    if not event_id:
        return None

    # 组织者也要加入参会人列表，否则飞书会显示"不参与"
    organizer_uid = event.get("event_organizer", {}).get("user_id")
    attendees: List[Dict[str, Any]] = []
    if organizer_uid:
        attendees.append({"type": "user", "user_id": organizer_uid})
    if room:
        attendees.append({"type": "resource", "room_id": room.room_id})
    for uid in (attendee_open_ids or []):
        if uid != organizer_uid:
            attendees.append({"type": "user", "user_id": uid})

    if attendees:
        try:
            # 用 user_token 添加参会人（事件在用户日历上，bot 无权操作）
            requests.post(
                f"{BASE_URL}/open-apis/calendar/v4/calendars/{used_calendar_id}/events/{event_id}/attendees",
                headers={"Authorization": f"Bearer {user_token}"},
                json={"attendees": attendees, "need_notification": True},
                params={"user_id_type": "open_id"},
            )
        except Exception:
            pass

    app_link = event.get("app_link") or f"feishu://calendar/event/{event_id}"
    return event_id, app_link, used_calendar_id


def suggest_schedule(api: FeishuClient, request_data: Dict[str, Any]) -> Dict[str, Any]:
    """核心排程：freebusy 并行查空闲 → 选第一个 → 直接创建事件，一条通知。"""
    # 前置授权检查：必须有有效的用户 OAuth token
    user_token = _ensure_user_token(api)
    if not user_token:
        cfg = FeishuEnvConfig.from_env()
        return {
            "success": False,
            "error": "未授权或授权已过期，请先运行 auth 命令。",
            "auth_url": _get_oauth_url(cfg.app_id),
        }

    slots_raw = request_data.get("time_slots", [])
    if not slots_raw:
        return {"success": False, "error": "未提供会议时间信息（time_slots）"}

    slots: List[MeetingSlot] = []
    for s in slots_raw:
        start = datetime.fromisoformat(s["start"])
        end = datetime.fromisoformat(s["end"])
        if start.tzinfo is None:
            start = start.replace(tzinfo=CST)
        if end.tzinfo is None:
            end = end.replace(tzinfo=CST)
        slots.append(MeetingSlot(start=start, end=end, flexible=s.get("flexible", False)))

    duration = request_data.get("duration_minutes")
    if not duration or duration <= 0:
        for slot in slots:
            d = slot.duration_minutes
            if d > 0:
                duration = d
                break
        if not duration or duration <= 0:
            duration = DEFAULT_DURATION_MINUTES

    attendee_count = request_data.get("attendee_count")
    preferred = request_data.get("preferred_rooms") or []
    preferred_floor = request_data.get("preferred_floor")
    title = request_data.get("title", "会议")
    notes = request_data.get("notes", "")
    granularity = max(TIME_GRANULARITY_MINUTES, 15)
    attendee_open_ids: List[str] = request_data.get("attendee_open_ids") or []
    force_time: bool = request_data.get("force_time", False)

    # 区域支持：可通过 area 指定预设区域，也可直接传 building_level_id 等动态参数
    area: str = request_data.get("area", DEFAULT_AREA)
    dyn_building_id: Optional[str] = request_data.get("building_level_id")
    dyn_floors_raw: Optional[List[str]] = request_data.get("allowed_floors")
    dyn_floors: Optional[set] = set(dyn_floors_raw) if dyn_floors_raw else None
    dyn_min_cap: Optional[int] = request_data.get("min_capacity")

    floor_rooms_list = _get_floor_rooms(
        api, area,
        building_level_id=dyn_building_id,
        allowed_floors=dyn_floors,
        min_capacity=dyn_min_cap,
    )
    if not floor_rooms_list:
        area_label = AREA_CONFIGS.get(area, {}).get("name", area)
        return {"success": False, "error": f"无法获取 {area_label} 的会议室信息，请确认 building_level_id 是否正确"}

    if preferred_floor:
        pf = preferred_floor.upper()
        floor_rooms_list.sort(key=lambda fr: (0 if pf in fr.floor.name.upper() else 1, fr.floor.name))

    # 按楼层准备候选会议室
    per_floor: List[Tuple[FloorInfo, List[RoomConfig]]] = []
    for fr in floor_rooms_list:
        candidates = _prepare_candidates(fr.rooms, preferred)
        candidates = [r for r in candidates if _capacity_ok(r, attendee_count) and _duration_ok(r, duration)]
        if candidates:
            per_floor.append((fr.floor, candidates))

    if not per_floor:
        return {"success": False, "error": "没有满足条件的候选会议室"}

    decline_set = _load_decline_set()

    for slot in slots:
        for start, end in _iter_slot_candidates(slot, duration, granularity):
            if not force_time and _in_blocked_hours(start, end):
                continue
            if attendee_open_ids and not _users_available(api, attendee_open_ids, start, end):
                continue

            # 一次性并行 freebusy，收集可用房间（跳过 decline 缓存，够用即停）
            MAX_CANDIDATES = 6
            available: List[Tuple[RoomConfig, FloorInfo]] = []
            for fl, candidates in per_floor:
                filtered = [r for r in candidates if r.room_id not in decline_set]
                remaining = MAX_CANDIDATES - len(available)
                if remaining <= 0:
                    break
                for r in _find_available_rooms(api, filtered, start, end, limit=remaining):
                    available.append((r, fl))
                    if len(available) >= MAX_CANDIDATES:
                        break

            if not available:
                continue

            # 用第一个可用房间创建事件
            room, floor = available[0]
            result = _book_event(
                api, start, end, title, notes,
                attendee_open_ids, room,
            )
            if not result:
                continue
            event_id, app_link, used_calendar_id = result

            # decline_set 已过滤已知拒绝房间，freebusy 已确认空闲，
            # 跳过 1.5s decline 轮询，直接返回结果（省 ~2.5s）。
            return {
                "success": True,
                "data": {
                    "event_id": event_id,
                    "calendar_id": used_calendar_id,
                    "room_id": room.room_id,
                    "room_name": room.name,
                    "floor": floor.name,
                    "start": start.isoformat(),
                    "end": end.isoformat(),
                    "meeting_url": app_link,
                    "message": f"已预约会议室 {room.name}（{floor.name}），"
                               f"时间 {start.strftime('%Y-%m-%d %H:%M')} - {end.strftime('%H:%M')}。",
                },
            }

    # 没有空闲房间 — 创建无会议室事件
    slot = slots[0]
    fb_start = slot.start
    fb_end = slot.end if slot.end > slot.start else slot.start + timedelta(minutes=duration)
    result = _book_event(
        api, fb_start, fb_end, title, notes,
        attendee_open_ids,
    )
    if result:
        event_id, app_link, used_calendar_id = result
        return {
            "success": True,
            "data": {
                "event_id": event_id,
                "calendar_id": used_calendar_id,
                "room_id": None,
                "room_name": None,
                "floor": None,
                "start": fb_start.isoformat(),
                "end": fb_end.isoformat(),
                "meeting_url": app_link,
                "no_room": True,
                "message": f"所有会议室已满，已创建日历事件占住时间 "
                           f"{fb_start.strftime('%Y-%m-%d %H:%M')} - {fb_end.strftime('%H:%M')}，请自行安排场地。",
            },
        }

    area_label = AREA_CONFIGS.get(area, {}).get("name", area)
    return {
        "success": False,
        "error": f"{area_label} 均未找到满足条件的空闲会议室，且日历事件创建也失败了。",
    }


# ------------------------------------------------------------------
# 子命令
# ------------------------------------------------------------------

def _build_api(cfg: FeishuEnvConfig) -> FeishuClient:
    return FeishuClient(cfg.app_id, cfg.app_secret)


def cmd_schedule(args: argparse.Namespace) -> None:
    cfg = FeishuEnvConfig.from_env()
    api = _build_api(cfg)
    try:
        data = json.loads(args.json)
    except json.JSONDecodeError as exc:
        _output(False, error=f"JSON 解析失败：{exc}")
        return
    result = suggest_schedule(api, data)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result.get("success"):
        sys.exit(1)


def cmd_list_rooms(args: argparse.Namespace) -> None:
    cfg = FeishuEnvConfig.from_env()
    api = _build_api(cfg)
    area = getattr(args, "area", DEFAULT_AREA) or DEFAULT_AREA
    floor_rooms_list = _get_floor_rooms(api, area)
    data = []
    for fr in floor_rooms_list:
        for r in fr.rooms:
            data.append({
                "room_id": r.room_id,
                "name": r.name,
                "capacity": r.capacity,
                "floor": fr.floor.name,
                "area": area,
            })
    _output(True, data=data)


def cmd_auth(args: argparse.Namespace) -> None:
    cfg = FeishuEnvConfig.from_env()
    api = _build_api(cfg)
    code = args.code
    if not code:
        url = _get_oauth_url(cfg.app_id)
        _output(True, data={
            "action": "open_url",
            "url": url,
            "message": "请在浏览器中打开以下链接完成授权，授权后从浏览器地址栏复制 code 参数，"
                       "再运行: python meeting_cli.py auth --code <code>",
        })
        return
    try:
        token_data = _exchange_code_for_token(api, code)
    except RuntimeError as exc:
        _output(False, error=str(exc))
        return
    # 获取用户主日历 ID
    user_token = token_data["user_access_token"]
    cal_id = _get_user_calendar_id(user_token)
    if cal_id:
        token_data["user_calendar_id"] = cal_id
        _save_user_token(token_data)
    _output(True, data={
        "message": "OAuth 授权成功，后续日程将以用户身份创建。",
        "user_calendar_id": cal_id,
    })


def cmd_auth_status(_args: argparse.Namespace) -> None:
    data = _load_user_token()
    if not data:
        _output(True, data={"authorized": False, "message": "未授权，日程将以 bot 身份创建。"})
        return
    now = time.time()
    token_valid = now < data.get("token_expires", 0)
    refresh_valid = now < data.get("refresh_expires", 0)
    token_exp = datetime.fromtimestamp(data.get("token_expires", 0), tz=CST).strftime("%Y-%m-%d %H:%M:%S")
    refresh_exp = datetime.fromtimestamp(data.get("refresh_expires", 0), tz=CST).strftime("%Y-%m-%d %H:%M:%S")
    if refresh_valid:
        status = "有效" if token_valid else "access_token 已过期，将自动刷新"
    else:
        status = "已完全过期，需要重新授权"
    _output(True, data={
        "authorized": True,
        "status": status,
        "token_valid": token_valid,
        "refresh_valid": refresh_valid,
        "token_expires": token_exp,
        "refresh_expires": refresh_exp,
        "user_calendar_id": data.get("user_calendar_id"),
    })


def cmd_list_buildings(_args: argparse.Namespace) -> None:
    """列出所有顶层楼宇及其 room_level_id，用于发现新区域的 building_level_id。"""
    cfg = FeishuEnvConfig.from_env()
    api = _build_api(cfg)
    try:
        resp = api.get("/open-apis/vc/v1/room_levels", {"page_size": 100})
    except Exception as exc:
        _output(False, error=f"API 请求失败: {exc}")
        return
    if resp.get("code", -1) != 0:
        _output(False, error=f"API 错误: {resp.get('msg', resp)}")
        return
    items = resp.get("data", {}).get("items") or []
    buildings = [
        {"room_level_id": it.get("room_level_id"), "name": it.get("name", ""), "path": it.get("path", [])}
        for it in items if it.get("room_level_id")
    ]
    _output(True, data={"buildings": buildings, "tip": "将 room_level_id 作为 building_level_id 传入 schedule 请求即可查询该楼宇的会议室"})


def cmd_refresh_cache(args: argparse.Namespace) -> None:
    cfg = FeishuEnvConfig.from_env()
    api = _build_api(cfg)
    area = getattr(args, "area", DEFAULT_AREA) or DEFAULT_AREA
    cf = _cache_file(area)
    if cf.exists():
        cf.unlink()
    floor_rooms_list = _get_floor_rooms(api, area)
    total = sum(len(fr.rooms) for fr in floor_rooms_list)
    area_label = AREA_CONFIGS.get(area, {}).get("name", area)
    _output(True, data={
        "area": area,
        "floors": len(floor_rooms_list),
        "rooms": total,
        "message": f"已刷新 {area_label} 缓存，共 {len(floor_rooms_list)} 个楼层，{total} 间会议室。",
    })


def cmd_cancel(args: argparse.Namespace) -> None:
    cfg = FeishuEnvConfig.from_env()
    api = _build_api(cfg)
    event_id: str = args.event_id
    calendar_id: Optional[str] = args.calendar_id

    # 尝试用用户身份删除
    user_token = _ensure_user_token(api)
    if user_token:
        if not calendar_id:
            token_data = _load_user_token() or {}
            calendar_id = token_data.get("user_calendar_id")
            if not calendar_id:
                calendar_id = _get_user_calendar_id(user_token)
                if calendar_id:
                    token_data["user_calendar_id"] = calendar_id
                    _save_user_token(token_data)
        if not calendar_id:
            _output(False, error="无法确定日历 ID，请通过 --calendar-id 指定。")
            return
        try:
            resp = requests.delete(
                f"{BASE_URL}/open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}",
                headers={"Authorization": f"Bearer {user_token}"},
                params={"need_notification": "true"},
            ).json()
        except Exception as exc:
            _output(False, error=f"请求失败：{exc}")
            return
        if resp.get("code", -1) == 0:
            _output(True, data={"message": f"已取消事件 {event_id}。"})
            return
        # 用户身份删除失败，尝试 bot 身份
        _output(False, error=f"取消失败：{resp.get('msg', resp)}")
        return

    # 无用户 token，用 bot 身份删除（兼容旧事件）
    if not calendar_id:
        calendar_id = _get_app_calendar_id(api)
    if not calendar_id:
        _output(False, error="无法确定日历 ID，请通过 --calendar-id 指定。")
        return
    try:
        resp = api.delete(
            f"/open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}",
            params={"need_notification": "true"},
        )
    except Exception as exc:
        _output(False, error=f"请求失败：{exc}")
        return
    if resp.get("code", -1) != 0:
        _output(False, error=f"取消失败：{resp.get('msg', resp)}")
        return
    _output(True, data={"message": f"已取消事件 {event_id}。"})


# ------------------------------------------------------------------
# CLI 入口
# ------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="飞书会议室预约 CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    area_choices = list(AREA_CONFIGS.keys())
    area_help = f"区域，可选: {', '.join(area_choices)}（默认 {DEFAULT_AREA}）"

    p_schedule = sub.add_parser("schedule", help="预约会议室")
    p_schedule.add_argument("--json", required=True, help="会议请求 JSON")

    p_list = sub.add_parser("list-rooms", help="列出可用会议室")
    p_list.add_argument("--area", default=DEFAULT_AREA, help=area_help)

    p_refresh = sub.add_parser("refresh-cache", help="强制刷新会议室缓存")
    p_refresh.add_argument("--area", default=DEFAULT_AREA, help=area_help)

    sub.add_parser("list-buildings", help="列出所有可用楼宇（用于获取 building_level_id）")

    p_cancel = sub.add_parser("cancel", help="取消会议")
    p_cancel.add_argument("--event-id", required=True, help="要取消的事件 ID")
    p_cancel.add_argument("--calendar-id", help="日历 ID（不传则使用用户主日历或 bot 日历）")

    p_auth = sub.add_parser("auth", help="OAuth 用户授权")
    p_auth.add_argument("--code", help="OAuth 授权码")
    sub.add_parser("auth-status", help="查看授权状态")

    args = parser.parse_args()
    if args.command == "schedule":
        cmd_schedule(args)
    elif args.command == "cancel":
        cmd_cancel(args)
    elif args.command == "list-rooms":
        cmd_list_rooms(args)
    elif args.command == "refresh-cache":
        cmd_refresh_cache(args)
    elif args.command == "list-buildings":
        cmd_list_buildings(args)
    elif args.command == "auth":
        cmd_auth(args)
    elif args.command == "auth-status":
        cmd_auth_status(args)


if __name__ == "__main__":
    main()
