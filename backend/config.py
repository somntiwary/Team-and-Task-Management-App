"""
Application Configuration File

Centralized configuration for:
- LAN-based, offline-first deployments
- Multi-server architecture
- Environment-based configuration (no hardcoding)
- Defense / enterprise-grade maintainability
"""

import os
from pathlib import Path

# -------------------------------------------------
# BASE DIRECTORY
# -------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent

# -------------------------------------------------
# DATABASE CONFIGURATION
# -------------------------------------------------
# Local SQLite (DEV / fallback only)
DATABASE_NAME = "task.db"
DATABASE_PATH = BASE_DIR / DATABASE_NAME
SQLITE_URL = f"sqlite:///{DATABASE_PATH}"

# PostgreSQL (PRODUCTION / MULTI-SERVER)
# MUST be provided via environment variable in real deployments
POSTGRES_URL = os.getenv("TARGET_DATABASE_URL")

if POSTGRES_URL:
    DATABASE_URL = POSTGRES_URL
else:
    # Fallback ONLY for local development
    DATABASE_URL = SQLITE_URL

# Optional safety check (recommended for production)
ENVIRONMENT = os.getenv("APP_ENV", "development")

if ENVIRONMENT == "production" and DATABASE_URL.startswith("sqlite"):
    raise RuntimeError(
        "SQLite is not allowed in production. "
        "Set TARGET_DATABASE_URL for PostgreSQL."
    )

# -------------------------------------------------
# APPLICATION SETTINGS
# -------------------------------------------------
APP_NAME = "Saralta"
APP_VERSION = "1.0"
DEBUG = os.getenv("DEBUG", "true").lower() == "true"

# -------------------------------------------------
# LOCAL ASSISTANT SETTINGS
# -------------------------------------------------
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3:latest")
OLLAMA_TIMEOUT_SECONDS = int(os.getenv("OLLAMA_TIMEOUT_SECONDS", "120"))
ASSISTANT_HISTORY_TURNS = int(os.getenv("ASSISTANT_HISTORY_TURNS", "6"))

# -------------------------------------------------
# AUTHENTICATION SETTINGS (PHASE-1)
# -------------------------------------------------
AUTH_MODE = "BASIC"  # JWT / OAuth in Phase-2

# -------------------------------------------------
# NETWORK / LAN SETTINGS
# -------------------------------------------------
DEFAULT_HOST = os.getenv("APP_HOST", "0.0.0.0")
DEFAULT_PORT = int(os.getenv("APP_PORT", "8080"))

# -------------------------------------------------
# ROLE DEFINITIONS
# -------------------------------------------------
ROLE_ADMIN = "Admin"
ROLE_MEMBER = "Member"

# -------------------------------------------------
# TASK CONSTANTS
# -------------------------------------------------
TASK_STATUS_TODO = "To Do"
TASK_STATUS_IN_PROGRESS = "In Progress"
TASK_STATUS_COMPLETED = "Completed"

TASK_PRIORITY_LOW = "Low"
TASK_PRIORITY_MEDIUM = "Medium"
TASK_PRIORITY_HIGH = "High"

# -------------------------------------------------
# UPLOAD SETTINGS
# -------------------------------------------------
UPLOAD_DIR = BASE_DIR / "uploads" / "completion_proofs"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# -------------------------------------------------
# SEED / DEMO SETTINGS
# -------------------------------------------------
ENABLE_SEED_DATA = os.getenv("ENABLE_SEED_DATA", "true").lower() == "true"
