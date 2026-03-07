#!/usr/bin/env python3
"""飞书文档归档 CLI — 供 OpenClaw 技能调用。"""

from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Set, Tuple

# 将 skills/ 根目录加入 path，使 shared 包可被找到
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from shared.config import FeishuEnvConfig
from shared.feishu_client import FeishuClient
from shared.output import output as _output

CST = timezone(timedelta(hours=8))


# ------------------------------------------------------------------
# URL 解析
# ------------------------------------------------------------------

DOCX_TOKEN_PATTERN = re.compile(r"/docx/([0-9A-Za-z]+)")
DOC_TOKEN_PATTERN = re.compile(r"/doc/([0-9A-Za-z]+)")
WIKI_TOKEN_PATTERN = re.compile(r"/wiki/([0-9A-Za-z]+)")
SHEET_TOKEN_PATTERN = re.compile(r"/sheets/([0-9A-Za-z]+)")


def extract_document_token(url: str) -> Optional[Tuple[str, str]]:
    """从 URL 中提取 (doc_type, token)。"""
    if not url:
        return None
    for pattern, doc_type in [
        (DOCX_TOKEN_PATTERN, "docx"),
        (DOC_TOKEN_PATTERN, "doc"),
        (WIKI_TOKEN_PATTERN, "wiki"),
        (SHEET_TOKEN_PATTERN, "sheet"),
    ]:
        match = pattern.search(url)
        if match:
            return (doc_type, match.group(1))
    return None


# ------------------------------------------------------------------
# 时间解析
# ------------------------------------------------------------------

def _parse_datetime(value: object) -> Optional[datetime]:
    if value in (None, "", 0):
        return None
    if isinstance(value, datetime):
        return value.astimezone(CST) if value.tzinfo else value.replace(tzinfo=timezone.utc).astimezone(CST)
    if isinstance(value, (int, float)):
        ts = float(value)
        if ts > 1e12:
            ts /= 1000
        return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(CST)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.isdigit():
            return _parse_datetime(int(text))
        normalised = text.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalised)
        except ValueError:
            return None
        return parsed.astimezone(CST) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc).astimezone(CST)
    return None


# ------------------------------------------------------------------
# 飞书文档元数据获取
# ------------------------------------------------------------------

def _fetch_docx_metadata(api: FeishuClient, token: str) -> Dict[str, Any]:
    resp = api.get(f"/open-apis/docx/v1/documents/{token}")
    if resp.get("code", -1) != 0:
        raise RuntimeError(f"获取文档元数据失败: code={resp.get('code')}, msg={resp.get('msg')}")
    doc = resp.get("data", {}).get("document") or {}
    doc_id = doc.get("document_id") or token
    return {
        "document_id": doc_id,
        "title": doc.get("title"),
        "doc_type": "docx",
    }


def _fetch_wiki_metadata(api: FeishuClient, token: str) -> Dict[str, Any]:
    resp = api.get(f"/open-apis/wiki/v2/spaces/get_node", params={"token": token})
    if resp.get("code", -1) != 0:
        raise RuntimeError(f"获取 Wiki 元数据失败: code={resp.get('code')}, msg={resp.get('msg')}")
    node = resp.get("data", {}).get("node") or {}
    node_token = node.get("node_token") or token
    return {
        "document_id": node_token,
        "title": node.get("title"),
        "doc_type": "wiki",
        "created_at": _parse_datetime(node.get("obj_create_time")),
        "updated_at": _parse_datetime(node.get("obj_edit_time")),
    }


def _enrich_with_drive_meta(api: FeishuClient, meta: Dict[str, Any]) -> None:
    doc_token = meta["document_id"]
    doc_type = meta["doc_type"]
    try:
        resp = api.post("/open-apis/drive/v1/metas/batch_query", body={
            "request_docs": [{"doc_token": doc_token, "doc_type": doc_type}],
            "with_url": False,
        })
        if resp.get("code", -1) != 0:
            return
        metas = resp.get("data", {}).get("metas") or []
        if not metas:
            return
        m = next((x for x in metas if x.get("doc_token") == doc_token), metas[0])
        if not meta.get("created_at"):
            meta["created_at"] = _parse_datetime(m.get("create_time"))
        if not meta.get("updated_at"):
            meta["updated_at"] = _parse_datetime(m.get("latest_modify_time"))
    except Exception:
        pass


def fetch_metadata(api: FeishuClient, doc_type: str, token: str, original_url: str) -> Dict[str, Any]:
    if doc_type == "docx":
        meta = _fetch_docx_metadata(api, token)
    elif doc_type == "wiki":
        meta = _fetch_wiki_metadata(api, token)
    else:
        meta = {
            "document_id": token,
            "title": None,
            "doc_type": doc_type,
        }
    # 始终使用用户提供的原始 URL
    meta["url"] = original_url
    _enrich_with_drive_meta(api, meta)
    return meta


# ------------------------------------------------------------------
# Bitable 写入
# ------------------------------------------------------------------

def _format_datetime_ms(value: datetime) -> int:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.astimezone(timezone.utc).timestamp() * 1000)


def write_bitable_record(
    api: FeishuClient,
    app_token: str,
    table_id: str,
    field_map: Dict[str, str],
    meta: Dict[str, Any],
    tags: Set[str],
) -> str:
    fields: Dict[str, object] = {}

    def assign(key: str, value: object) -> None:
        field_name = field_map.get(key)
        if field_name and value is not None:
            fields[field_name] = value

    title = meta.get("title") or meta.get("document_id", "")
    url = meta.get("url") or ""

    assign("title", title)
    assign("url", {"text": title, "link": url})
    assign("created_at", _format_datetime_ms(datetime.now(CST)))

    created_at = meta.get("created_at")
    if isinstance(created_at, datetime):
        assign("doc_created_at", _format_datetime_ms(created_at))
    updated_at = meta.get("updated_at")
    if isinstance(updated_at, datetime):
        assign("doc_updated_at", _format_datetime_ms(updated_at))

    if tags:
        tag_field = field_map.get("tags")
        if tag_field:
            fields[tag_field] = sorted(tags)

    resp = api.post(
        f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records",
        body={"fields": fields},
    )
    if resp.get("code", -1) != 0:
        raise RuntimeError(f"Bitable 写入失败: code={resp.get('code')}, msg={resp.get('msg')}")

    record = resp.get("data", {}).get("record") or {}
    record_id = record.get("record_id")
    if not record_id:
        raise RuntimeError("Bitable 返回数据缺少 record_id")
    return record_id


# ------------------------------------------------------------------
# 子命令
# ------------------------------------------------------------------

def cmd_save(args: argparse.Namespace) -> None:
    cfg = FeishuEnvConfig.from_env()

    if not cfg.bitable_app_token or not cfg.bitable_table_id:
        _output(False, error="缺少 FEISHU_BITABLE_APP_TOKEN 或 FEISHU_BITABLE_TABLE_ID 环境变量")
        return

    extracted = extract_document_token(args.url)
    if not extracted:
        _output(False, error=f"无法从 URL 中提取文档 token: {args.url}")
        return

    doc_type, token = extracted
    api = FeishuClient(cfg.app_id, cfg.app_secret)

    try:
        meta = fetch_metadata(api, doc_type, token, args.url)
    except Exception as exc:
        _output(False, error=f"获取文档元数据失败: {exc}")
        return

    if args.title:
        meta["title"] = args.title

    tags: Set[str] = set()
    if args.tags:
        tags = {t.strip() for t in args.tags.split(",") if t.strip()}

    try:
        write_bitable_record(
            api, cfg.bitable_app_token, cfg.bitable_table_id,
            cfg.bitable_field_map, meta, tags,
        )
    except Exception as exc:
        _output(False, error=f"写入多维表格失败: {exc}")
        return

    title = meta.get("title") or "未知文档"
    tag_str = "、".join(sorted(tags)) if tags else "无"
    _output(True, data={"message": f"已归档《{title}》，标签：{tag_str}"})


# ------------------------------------------------------------------
# CLI 入口
# ------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="飞书文档归档 CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p_save = sub.add_parser("save", help="归档文档链接")
    p_save.add_argument("--url", required=True, help="飞书文档链接")
    p_save.add_argument("--tags", default=None, help="逗号分隔的标签")
    p_save.add_argument("--title", default=None, help="自定义标题")

    args = parser.parse_args()
    if args.command == "save":
        cmd_save(args)


if __name__ == "__main__":
    main()
