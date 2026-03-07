"""精简版飞书 HTTP 客户端，封装 tenant_token 获取与请求发送。"""

from __future__ import annotations

import time
from typing import Any, Dict, Optional

import requests

BASE_URL = "https://open.larkoffice.com"


class FeishuClient:
    """带 tenant_token 自动刷新的飞书 HTTP 客户端。"""

    def __init__(
        self,
        app_id: str,
        app_secret: str,
        base_url: str = BASE_URL,
    ) -> None:
        self._app_id = app_id
        self._app_secret = app_secret
        self._base_url = base_url.rstrip("/")
        self._token: Optional[str] = None
        self._token_expires: float = 0

    # ------------------------------------------------------------------ #
    # Token 管理
    # ------------------------------------------------------------------ #

    def _ensure_token(self) -> str:
        if self._token and time.time() < self._token_expires:
            return self._token
        resp = requests.post(
            f"{self._base_url}/open-apis/auth/v3/tenant_access_token/internal",
            json={
                "app_id": self._app_id,
                "app_secret": self._app_secret,
            },
        )
        data = resp.json()
        if data.get("code", -1) != 0 and "tenant_access_token" not in data:
            raise RuntimeError(f"获取 token 失败: {data}")
        self._token = data["tenant_access_token"]
        self._token_expires = time.time() + data.get("expire", 7200) - 60
        return self._token

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self._ensure_token()}"}

    # ------------------------------------------------------------------ #
    # 公共请求方法
    # ------------------------------------------------------------------ #

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        resp = requests.get(
            f"{self._base_url}{path}", headers=self._headers(), params=params,
        )
        return resp.json()

    def post(
        self,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        resp = requests.post(
            f"{self._base_url}{path}", headers=self._headers(),
            json=body or {}, params=params,
        )
        return resp.json()

    def patch(
        self,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        resp = requests.patch(
            f"{self._base_url}{path}", headers=self._headers(),
            json=body or {}, params=params,
        )
        return resp.json()

    def delete(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        resp = requests.delete(
            f"{self._base_url}{path}", headers=self._headers(), params=params,
        )
        return resp.json()
