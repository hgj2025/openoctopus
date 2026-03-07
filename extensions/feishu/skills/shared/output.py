"""统一的 CLI 输出函数。"""

from __future__ import annotations

import json
import sys
from typing import Any, Dict, Optional


def output(success: bool, data: Any = None, error: Optional[str] = None) -> None:
    result: Dict[str, Any] = {"success": success}
    if data is not None:
        result["data"] = data
    if error:
        result["error"] = error
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not success:
        sys.exit(1)
