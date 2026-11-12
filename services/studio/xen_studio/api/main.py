import os

import uvicorn

from .app import create_app

if __name__ == "__main__":
    level = os.environ.get("LOG_LEVEL", "info").lower()
    uvicorn.run(create_app(), host="0.0.0.0", port=int(os.environ.get("STUDIO_PORT", "8104")), log_level={"warn": "warning"}.get(level, level))
