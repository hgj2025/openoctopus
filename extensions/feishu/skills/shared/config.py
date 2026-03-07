"""从环境变量读取飞书应用凭证。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict, Optional


@dataclass
class FeishuEnvConfig:
    """飞书凭证，统一从 os.environ 读取。"""

    app_id: str
    app_secret: str

    # Task 相关
    task_api_base: str = "https://open.larkoffice.com"
    default_owner_open_id: Optional[str] = None

    # Bitable 相关
    bitable_app_token: Optional[str] = None
    bitable_table_id: Optional[str] = None
    bitable_field_map: Dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "FeishuEnvConfig":
        """从 os.environ 构造配置，缺少必填项时抛出 ValueError。"""
        app_id = os.environ.get("FEISHU_APP_ID", "")
        app_secret = os.environ.get("FEISHU_APP_SECRET", "")
        if not app_id or not app_secret:
            raise ValueError(
                "环境变量 FEISHU_APP_ID 和 FEISHU_APP_SECRET 为必填项"
            )
        return cls(
            app_id=app_id,
            app_secret=app_secret,
            task_api_base=os.environ.get(
                "FEISHU_TASK_API_BASE", "https://open.larkoffice.com"
            ),
            default_owner_open_id=os.environ.get("FEISHU_DEFAULT_OWNER_ID"),
            bitable_app_token=os.environ.get("FEISHU_BITABLE_APP_TOKEN"),
            bitable_table_id=os.environ.get("FEISHU_BITABLE_TABLE_ID"),
            bitable_field_map={
                "title": "标题",
                "url": "链接",
                "tags": "标签",
                "created_at": "创建时间",
                "doc_created_at": "文档创建时间",
                "doc_updated_at": "文档更新时间",
            },
        )
