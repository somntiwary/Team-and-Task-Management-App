"""
Application Configuration File

This file centralizes all configuration variables so that:
- deployment changes do not require code changes
- LAN / offline environments are supported
- future upgrades (security, env-based config) are easy
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
DATABASE_NAME = "task.db"
DATABASE_PATH = BASE_DIR / DATABASE_NAME

DATABASE_URL = f"sqlite:///{DATABASE_PATH}"

# -------------------------------------------------
# APPLICATION SETTINGS
# -------------------------------------------------
APP_NAME = "Saralta"
APP_VERSION = "1.0"
DEBUG = True   # Set False in production deployment

# -------------------------------------------------
# AUTHENTICATION SETTINGS (PHASE-1)
# -------------------------------------------------
# NOTE:
# Phase-1 uses simple authentication (no JWT, no hashing).
# Secure mechanisms will be added in Phase-2.
AUTH_MODE = "BASIC"

# -------------------------------------------------
# NETWORK / LAN SETTINGS
# -------------------------------------------------
DEFAULT_HOST = "0.0.0.0"   # Accessible across LAN
DEFAULT_PORT = 8000

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
# UPLOAD SETTINGS (Task completion proof)
# -------------------------------------------------
UPLOAD_DIR = BASE_DIR / "uploads" / "completion_proofs"

# -------------------------------------------------
# SEED / DEMO SETTINGS
# -------------------------------------------------
ENABLE_SEED_DATA = True  # Disable in real deployment
