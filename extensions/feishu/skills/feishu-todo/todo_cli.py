#!/usr/bin/env python3
"""飞书待办任务 CLI — 供 OpenClaw 技能调用。"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

# 将 skills/ 根目录加入 path，使 shared 包可被找到
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from shared.config import FeishuEnvConfig
from shared.feishu_client import FeishuClient
from shared.output import output as _output

CST = timezone(timedelta(hours=8))


# ------------------------------------------------------------------
# 任务 payload 构建
# ------------------------------------------------------------------

def _build_members(
    owner: Optional[str],
    collaborators: List[str],
    followers: List[str],
) -> List[Dict[str, Any]]:
    """构造去重的成员列表。"""
    members: List[Dict[str, Any]] = []
    seen: set = set()

    def _add(open_id: Optional[str], role: str) -> None:
        if not open_id or open_id in seen:
            return
        members.append({"id": open_id, "type": "user", "role": role})
        seen.add(open_id)

    _add(owner, "assignee")
    for oid in collaborators:
        _add(oid, "follower")
    for oid in followers:
        _add(oid, "follower")
    return members


def build_task_payload(data: Dict[str, Any], default_owner: Optional[str]) -> Dict[str, Any]:
    """从用户提供的 JSON 构造飞书 Task v2 API 请求体。"""
    title = str(data.get("title") or "").strip()
    if not title:
        raise ValueError("title 为必填字段")

    description = str(data.get("description") or "").strip()
    due_time_str = data.get("due_time")
    owner = data.get("owner_open_id") or default_owner
    collaborators = data.get("collaborator_open_ids") or []
    followers = data.get("follower_open_ids") or []

    members = _build_members(owner, collaborators, followers)
    payload: Dict[str, Any] = {
        "summary": title,
        "description": description,
        "members": members,
    }

    if due_time_str:
        dt = datetime.fromisoformat(str(due_time_str))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=CST)
        ts_ms = int(dt.astimezone(timezone.utc).timestamp() * 1000)
        payload["due"] = {"timestamp": str(ts_ms), "is_all_day": False}

    notify_all = data.get("notify_all", False)
    if notify_all:
        payload["reminders"] = [{"relative_fire_minute": 0}]

    priority = data.get("priority")
    if priority is not None:
        payload["priority"] = int(priority)

    start_time_str = data.get("start_time")
    if start_time_str:
        sdt = datetime.fromisoformat(str(start_time_str))
        if sdt.tzinfo is None:
            sdt = sdt.replace(tzinfo=CST)
        sts_ms = int(sdt.astimezone(timezone.utc).timestamp() * 1000)
        payload["start_time"] = {"timestamp": str(sts_ms), "is_all_day": False}

    return payload


# ------------------------------------------------------------------
# 子命令实现
# ------------------------------------------------------------------

def cmd_create(args: argparse.Namespace) -> None:
    """创建飞书待办任务。"""
    cfg = FeishuEnvConfig.from_env()
    client = FeishuClient(cfg.app_id, cfg.app_secret, base_url=cfg.task_api_base)

    try:
        data = json.loads(args.json)
    except json.JSONDecodeError as exc:
        _output(False, error=f"JSON 解析失败：{exc}")
        return

    try:
        payload = build_task_payload(data, cfg.default_owner_open_id)
    except ValueError as exc:
        _output(False, error=str(exc))
        return

    try:
        response = client.post("/open-apis/task/v2/tasks", body=payload)
    except Exception as exc:
        _output(False, error=str(exc))
        return

    if response.get("code"):
        _output(False, error=f"飞书接口返回错误：{response}")
        return

    task_data = response.get("data", response)
    task_info = task_data.get("task") if isinstance(task_data, dict) else None
    task_id = None
    if isinstance(task_info, dict):
        task_id = task_info.get("id") or task_info.get("task_id")
    elif isinstance(task_data, dict):
        task_id = task_data.get("id") or task_data.get("task_id")

    _output(True, data={"task_id": task_id, "title": data.get("title")})


def cmd_query(args: argparse.Namespace) -> None:
    """查询用户的待办列表。"""
    cfg = FeishuEnvConfig.from_env()
    client = FeishuClient(cfg.app_id, cfg.app_secret, base_url=cfg.task_api_base)

    params: Dict[str, Any] = {
        "user_id": args.user_id,
        "page_size": args.limit,
    }
    if args.status:
        params["status"] = args.status

    try:
        response = client.get("/open-apis/task/v1/tasks", params=params)
    except Exception as exc:
        _output(False, error=str(exc))
        return

    if response.get("code"):
        _output(False, error=f"飞书接口返回错误：{response}")
        return

    _output(True, data=response.get("data", response))


# ------------------------------------------------------------------
# CLI 入口
# ------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="飞书待办任务 CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p_create = sub.add_parser("create", help="创建待办任务")
    p_create.add_argument("--json", required=True, help="任务 JSON 字符串")

    p_query = sub.add_parser("query", help="查询待办列表")
    p_query.add_argument("--user-id", required=True, help="飞书用户 open_id")
    p_query.add_argument("--status", default=None, help="筛选状态")
    p_query.add_argument("--limit", type=int, default=20, help="返回数量")

    args = parser.parse_args()
    if args.command == "create":
        cmd_create(args)
    elif args.command == "query":
        cmd_query(args)


if __name__ == "__main__":
    main()
