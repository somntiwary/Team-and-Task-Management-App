from fastapi import FastAPI, Depends, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from sqlalchemy import text, inspect
from typing import List
import logging
from logging.handlers import RotatingFileHandler
import os
import mimetypes
import re

import models
import schemas
import crud
import auth
import sessions
import config
import assistant_service

from database import engine, get_db
from models import User

# ---------------------------------------------------------
# LOGGING CONFIGURATION
# ---------------------------------------------------------

# Create logs directory if it doesn't exist
os.makedirs("logs", exist_ok=True)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        # File handler with rotation (max 10MB per file, keep 5 backup files)
        RotatingFileHandler(
            'logs/app.log',
            maxBytes=10*1024*1024,
            backupCount=5
        ),
        # Console handler for development
        logging.StreamHandler()
    ]
)

logger = logging.getLogger(__name__)


def _is_global_hierarchy_admin(user: User) -> bool:
    return (user.role or "").lower() in ("admin", "division head")


def _can_manage_group_scope(db: Session, current_user: User, group_id: int) -> bool:
    if _is_global_hierarchy_admin(current_user):
        return True
    group = db.query(models.Group).filter(models.Group.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    return group.head_user_id == current_user.id


def _can_manage_activity_scope(db: Session, current_user: User, activity_id: int) -> bool:
    if _is_global_hierarchy_admin(current_user):
        return True
    activity = db.query(models.Activity).filter(models.Activity.id == activity_id).first()
    if not activity:
        raise HTTPException(status_code=404, detail="Activity not found")
    if not activity.group_id:
        return False
    return _can_manage_group_scope(db, current_user, activity.group_id)


def _can_manage_team_scope(db: Session, current_user: User, team_id: int) -> bool:
    if _is_global_hierarchy_admin(current_user):
        return True
    team = db.query(models.Team).filter(models.Team.id == team_id).first()
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    if not team.activity_id:
        return False
    return _can_manage_activity_scope(db, current_user, team.activity_id)

# ---------------------------------------------------------
# CREATE DATABASE TABLES
# ---------------------------------------------------------
models.Base.metadata.create_all(bind=engine)
logger.info("Database tables created successfully")

# ---------------------------------------------------------
# ONE-TIME MIGRATION: add new columns to existing DBs
# ---------------------------------------------------------
def _run_column_migrations():
    """Add new columns and tables to existing DBs."""
    with engine.connect() as conn:
        inspector = inspect(engine)
        dialect = engine.dialect.name.lower()

        def has_column(table_name: str, column_name: str) -> bool:
            try:
                cols = inspector.get_columns(table_name)
            except Exception:
                return False
            return any((col.get("name") or "").lower() == column_name.lower() for col in cols)

        def normalize_migration_sql(stmt: str) -> str:
            if dialect == "postgresql":
                # Older handwritten migrations use SQLite-style DATETIME.
                # PostgreSQL expects TIMESTAMP for those statements.
                stmt = re.sub(r"\bDATETIME\b", "TIMESTAMP", stmt)
            return stmt

        def ensure_column(table_name: str, column_name: str, stmt: str):
            if has_column(table_name, column_name):
                return
            try:
                conn.execute(text(normalize_migration_sql(stmt)))
                conn.commit()
                logger.info("Migration: added column %s.%s", table_name, column_name)
            except Exception as e:
                conn.rollback()
                msg = str(e).lower()
                if "duplicate column" in msg or "already exists" in msg:
                    logger.info("Migration: column already exists %s.%s", table_name, column_name)
                    return
                raise

        def ensure_varchar_capacity(table_name: str, column_name: str, target_length: int):
            try:
                cols = inspector.get_columns(table_name)
            except Exception:
                return
            col = next((c for c in cols if (c.get("name") or "").lower() == column_name.lower()), None)
            if not col:
                return
            col_type = col.get("type")
            current_length = getattr(col_type, "length", None)
            if current_length is not None and current_length >= target_length:
                return

            stmt = None
            if dialect == "postgresql":
                stmt = f"ALTER TABLE {table_name} ALTER COLUMN {column_name} TYPE VARCHAR({target_length})"
            elif dialect in ("mysql", "mariadb"):
                stmt = f"ALTER TABLE {table_name} MODIFY COLUMN {column_name} VARCHAR({target_length})"
            else:
                logger.info(
                    "Migration: skipped varchar resize for %s.%s on dialect %s",
                    table_name, column_name, dialect
                )
                return

            try:
                conn.execute(text(stmt))
                conn.commit()
                logger.info(
                    "Migration: resized column %s.%s to VARCHAR(%s)",
                    table_name, column_name, target_length
                )
            except Exception as e:
                conn.rollback()
                logger.warning(
                    "Migration: failed to resize column %s.%s to VARCHAR(%s): %s",
                    table_name, column_name, target_length, e
                )

        for stmt, name in [
            ("ALTER TABLE users ADD COLUMN designation VARCHAR(100)", "users.designation"),
            ("ALTER TABLE tasks ADD COLUMN created_by INTEGER DEFAULT 1", "tasks.created_by"),
            ("ALTER TABLE team_members ADD COLUMN role VARCHAR(20) DEFAULT 'Member'", "team_members.role"),
            ("ALTER TABLE teams ADD COLUMN status VARCHAR(20) DEFAULT 'approved'", "teams.status"),
            ("ALTER TABLE teams ADD COLUMN only_admins_assign INTEGER DEFAULT 0", "teams.only_admins_assign"),
            # New hierarchy: activities + link from tasks to activities
            ("ALTER TABLE tasks ADD COLUMN activity_id INTEGER", "tasks.activity_id"),
            # New Role & Permission fields
            ("ALTER TABLE tasks ADD COLUMN lead_person_id INTEGER", "tasks.lead_person_id"),
            ("ALTER TABLE tasks ADD COLUMN percent_share INTEGER", "tasks.percent_share"),
            ("ALTER TABLE tasks ADD COLUMN closure_approver_id INTEGER", "tasks.closure_approver_id"),
            ("ALTER TABLE tasks ADD COLUMN is_approved INTEGER DEFAULT 1", "tasks.is_approved"),
            ("ALTER TABLE tasks ADD COLUMN task_schedule_type VARCHAR(20) DEFAULT 'Time Bound'", "tasks.task_schedule_type"),
            ("ALTER TABLE tasks ADD COLUMN task_type VARCHAR(100) DEFAULT 'Infrastructure Development'", "tasks.task_type"),
            ("ALTER TABLE tasks ADD COLUMN type_approval_status VARCHAR(20) DEFAULT 'not_required'", "tasks.type_approval_status"),
            ("ALTER TABLE tasks ADD COLUMN type_approved_by INTEGER", "tasks.type_approved_by"),
            ("ALTER TABLE tasks ADD COLUMN type_approved_at DATETIME", "tasks.type_approved_at"),
            ("ALTER TABLE tasks ADD COLUMN procurement_stage VARCHAR(100)", "tasks.procurement_stage"),
            ("ALTER TABLE task_completion_requests ADD COLUMN batch_id VARCHAR(64)", "task_completion_requests.batch_id"),
            ("ALTER TABLE milestones ADD COLUMN has_dependency INTEGER DEFAULT 0", "milestones.has_dependency"),
            ("ALTER TABLE milestones ADD COLUMN start_dependency_task_id INTEGER", "milestones.start_dependency_task_id"),
            ("ALTER TABLE milestones ADD COLUMN start_dependency_event VARCHAR(20)", "milestones.start_dependency_event"),
            ("ALTER TABLE milestones ADD COLUMN finish_dependency_task_id INTEGER", "milestones.finish_dependency_task_id"),
            ("ALTER TABLE milestones ADD COLUMN finish_dependency_event VARCHAR(20)", "milestones.finish_dependency_event"),
        ]:
            table_name, column_name = name.split(".", 1)
            ensure_column(table_name, column_name, stmt)

        ensure_varchar_capacity("tasks", "task_type", 100)
        ensure_varchar_capacity("activities", "type", 100)
        try:
            conn.execute(text(normalize_migration_sql("""
                CREATE TABLE IF NOT EXISTS team_invitations (
                    id INTEGER NOT NULL PRIMARY KEY,
                    team_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    invited_by INTEGER NOT NULL,
                    role VARCHAR(20) DEFAULT 'Member',
                    status VARCHAR(20) DEFAULT 'pending',
                    created_at DATETIME,
                    FOREIGN KEY(team_id) REFERENCES teams (id),
                    FOREIGN KEY(user_id) REFERENCES users (id),
                    FOREIGN KEY(invited_by) REFERENCES users (id)
                )
            """)))
            conn.commit()
            logger.info("Migration: ensured team_invitations table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        # New table for Activities (Division / Project) under Teams
        try:
            conn.execute(text(normalize_migration_sql("""
                CREATE TABLE IF NOT EXISTS activities (
                    id INTEGER NOT NULL PRIMARY KEY,
                    name VARCHAR(200) NOT NULL,
                    type VARCHAR(100),
                    team_id INTEGER,
                    group_id INTEGER,
                    created_by INTEGER,
                    created_at DATETIME,
                    FOREIGN KEY(team_id) REFERENCES teams (id)
                )
            """)))
            conn.commit()
            logger.info("Migration: ensured activities table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        # NEW: Division / Group hierarchy + Team.activity_id + Task.parent_task_id
        try:
            conn.execute(text(normalize_migration_sql("""
                CREATE TABLE IF NOT EXISTS divisions (
                    id INTEGER NOT NULL PRIMARY KEY,
                    name VARCHAR(200) NOT NULL,
                    created_by INTEGER NOT NULL,
                    head_user_id INTEGER NOT NULL,
                    created_at DATETIME,
                    FOREIGN KEY(created_by) REFERENCES users (id),
                    FOREIGN KEY(head_user_id) REFERENCES users (id)
                )
            """)))
            conn.commit()
            logger.info("Migration: ensured divisions table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        try:
            conn.execute(text(normalize_migration_sql("""
                CREATE TABLE IF NOT EXISTS groups (
                    id INTEGER NOT NULL PRIMARY KEY,
                    division_id INTEGER NOT NULL,
                    name VARCHAR(200) NOT NULL,
                    created_by INTEGER NOT NULL,
                    head_user_id INTEGER NOT NULL,
                    created_at DATETIME,
                    FOREIGN KEY(division_id) REFERENCES divisions (id),
                    FOREIGN KEY(created_by) REFERENCES users (id),
                    FOREIGN KEY(head_user_id) REFERENCES users (id)
                )
            """)))
            conn.commit()
            logger.info("Migration: ensured groups table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        for stmt, name in [
            ("ALTER TABLE divisions ADD COLUMN created_by INTEGER DEFAULT 1", "divisions.created_by"),
            ("ALTER TABLE divisions ADD COLUMN head_user_id INTEGER DEFAULT 1", "divisions.head_user_id"),
            ("ALTER TABLE divisions ADD COLUMN created_at TIMESTAMP", "divisions.created_at"),
            ("ALTER TABLE groups ADD COLUMN created_by INTEGER DEFAULT 1", "groups.created_by"),
            ("ALTER TABLE groups ADD COLUMN head_user_id INTEGER DEFAULT 1", "groups.head_user_id"),
            ("ALTER TABLE groups ADD COLUMN created_at TIMESTAMP", "groups.created_at"),
            ("ALTER TABLE teams ADD COLUMN activity_id INTEGER", "teams.activity_id"),
            ("ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER", "tasks.parent_task_id"),
            ("ALTER TABLE tasks ADD COLUMN tentative_start_date DATE", "tasks.tentative_start_date"),
            ("ALTER TABLE tasks ADD COLUMN tentative_completion_date DATE", "tasks.tentative_completion_date"),
            ("ALTER TABLE tasks ADD COLUMN tentative_duration_days INTEGER", "tasks.tentative_duration_days"),
            ("ALTER TABLE tasks ADD COLUMN has_dependency INTEGER DEFAULT 0", "tasks.has_dependency"),
            ("ALTER TABLE tasks ADD COLUMN start_dependency_task_id INTEGER", "tasks.start_dependency_task_id"),
            ("ALTER TABLE tasks ADD COLUMN start_dependency_event VARCHAR(20)", "tasks.start_dependency_event"),
            ("ALTER TABLE tasks ADD COLUMN start_dependency_offset_days INTEGER", "tasks.start_dependency_offset_days"),
            ("ALTER TABLE tasks ADD COLUMN finish_dependency_task_id INTEGER", "tasks.finish_dependency_task_id"),
            ("ALTER TABLE tasks ADD COLUMN finish_dependency_event VARCHAR(20)", "tasks.finish_dependency_event"),
            ("ALTER TABLE tasks ADD COLUMN finish_dependency_offset_days INTEGER", "tasks.finish_dependency_offset_days"),
            ("ALTER TABLE tasks ADD COLUMN started_at DATETIME", "tasks.started_at"),
            ("ALTER TABLE activities ADD COLUMN group_id INTEGER", "activities.group_id"),
            ("ALTER TABLE activities ADD COLUMN created_by INTEGER", "activities.created_by"),
        ]:
            table_name, column_name = name.split(".", 1)
            ensure_column(table_name, column_name, stmt)

        try:
            conn.execute(text("""
                UPDATE tasks
                SET tentative_completion_date = DATE(
                    tentative_start_date,
                    '+' || CASE
                        WHEN tentative_duration_days IS NOT NULL AND tentative_duration_days > 0 THEN tentative_duration_days - 1
                        ELSE 0
                    END || ' day'
                )
                WHERE tentative_completion_date IS NULL
                  AND tentative_start_date IS NOT NULL
                  AND tentative_duration_days IS NOT NULL
            """))
            conn.commit()
            logger.info("Migration: backfilled tasks.tentative_completion_date from tentative_duration_days")
        except Exception as e:
            conn.rollback()
            logger.warning("Migration: could not backfill tasks.tentative_completion_date: %s", e)

        try:
            conn.execute(text("""
                UPDATE tasks
                SET started_at = COALESCE(started_at, updated_at, created_at)
                WHERE status = 'In Progress' AND started_at IS NULL
            """))
            conn.commit()
            logger.info("Migration: backfilled tasks.started_at for in-progress tasks")
        except Exception as e:
            conn.rollback()
            logger.warning("Migration: unable to backfill tasks.started_at (%s)", e)

        # New table for Activity-level messages (project logbook / discussion panel)
        try:
            conn.execute(text(normalize_migration_sql("""
                CREATE TABLE IF NOT EXISTS activity_messages (
                    id INTEGER NOT NULL PRIMARY KEY,
                    activity_id INTEGER NOT NULL,
                    user_id INTEGER,
                    message_type VARCHAR(20) DEFAULT 'user',
                    content TEXT NOT NULL,
                    created_at DATETIME,
                    updated_at DATETIME,
                    FOREIGN KEY(activity_id) REFERENCES activities (id),
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
            """)))
            conn.commit()
            logger.info("Migration: ensured activity_messages table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        # New table for Task completion requests (proof + approval)
        try:
            conn.execute(text(normalize_migration_sql("""
                CREATE TABLE IF NOT EXISTS task_completion_requests (
                    id INTEGER NOT NULL PRIMARY KEY,
                    task_id INTEGER NOT NULL,
                    submitted_by INTEGER NOT NULL,
                    previous_status VARCHAR(20) NOT NULL,
                    attachment_path VARCHAR(500) NOT NULL,
                    attachment_filename VARCHAR(255),
                    batch_id VARCHAR(64),
                    status VARCHAR(20) DEFAULT 'pending',
                    created_at DATETIME,
                    decided_at DATETIME,
                    decided_by INTEGER,
                    FOREIGN KEY(task_id) REFERENCES tasks (id),
                    FOREIGN KEY(submitted_by) REFERENCES users (id),
                    FOREIGN KEY(decided_by) REFERENCES users (id)
                )
            """)))
            conn.commit()
            logger.info("Migration: ensured task_completion_requests table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        # New table for Task extension requests
        try:
            conn.execute(text(normalize_migration_sql("""
                CREATE TABLE IF NOT EXISTS task_extension_requests (
                    id INTEGER NOT NULL PRIMARY KEY,
                    task_id INTEGER NOT NULL,
                    requested_by INTEGER NOT NULL,
                    requested_to INTEGER,
                    reason TEXT NOT NULL,
                    requested_due_date DATE NOT NULL,
                    status VARCHAR(20) DEFAULT 'pending',
                    created_at DATETIME,
                    decided_at DATETIME,
                    decided_by INTEGER,
                    FOREIGN KEY(task_id) REFERENCES tasks (id),
                    FOREIGN KEY(requested_by) REFERENCES users (id),
                    FOREIGN KEY(requested_to) REFERENCES users (id),
                    FOREIGN KEY(decided_by) REFERENCES users (id)
                )
            """)))
            conn.commit()
            logger.info("Migration: ensured task_extension_requests table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        # Task assignments (multiple assignees per task with optional share % and lead)
        try:
            conn.execute(text(normalize_migration_sql("""
                CREATE TABLE IF NOT EXISTS task_assignments (
                    id INTEGER NOT NULL PRIMARY KEY,
                    task_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    percent_share INTEGER,
                    is_lead INTEGER DEFAULT 0,
                    FOREIGN KEY(task_id) REFERENCES tasks (id),
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
            """)))
            conn.commit()
            logger.info("Migration: ensured task_assignments table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        # Notifications for top-bar updates
        try:
            conn.execute(text(normalize_migration_sql("""
                CREATE TABLE IF NOT EXISTS notifications (
                    id INTEGER NOT NULL PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    message TEXT NOT NULL,
                    is_read INTEGER DEFAULT 0,
                    created_at DATETIME,
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
            """)))
            conn.commit()
            logger.info("Migration: ensured notifications table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        try:
            conn.execute(text(normalize_migration_sql("""
                CREATE TABLE IF NOT EXISTS user_options (
                    id INTEGER NOT NULL PRIMARY KEY,
                    option_type VARCHAR(30) NOT NULL,
                    value VARCHAR(100) NOT NULL UNIQUE,
                    created_by INTEGER,
                    created_at DATETIME,
                    FOREIGN KEY(created_by) REFERENCES users (id)
                )
            """)))
            conn.commit()
            logger.info("Migration: ensured user_options table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        try:
            conn.execute(text(normalize_migration_sql("""
                CREATE TABLE IF NOT EXISTS holidays (
                    id INTEGER NOT NULL PRIMARY KEY,
                    name VARCHAR(200) NOT NULL,
                    holiday_date DATE NOT NULL UNIQUE,
                    created_by INTEGER,
                    created_at DATETIME,
                    FOREIGN KEY(created_by) REFERENCES users (id)
                )
            """)))
            conn.commit()
            logger.info("Migration: ensured holidays table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        try:
            conn.execute(text(normalize_migration_sql("""
                CREATE TABLE IF NOT EXISTS milestones (
                    id INTEGER NOT NULL PRIMARY KEY,
                    name VARCHAR(200) NOT NULL,
                    milestone_date DATE NOT NULL,
                    created_by INTEGER,
                    created_at DATETIME,
                    FOREIGN KEY(created_by) REFERENCES users (id)
                )
            """)))
            conn.commit()
            logger.info("Migration: ensured milestones table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

_run_column_migrations()

# ---------------------------------------------------------
# FASTAPI APP INIT
# ---------------------------------------------------------
app = FastAPI(
    title="Saralta",
    description="LAN-based Task Management App for Academic & Research Teams",
    version="1.0"
)

# CORS middleware for frontend integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for LAN; restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _dashboard_stats_handler(
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    try:
        return crud.get_dashboard_stats(db, current_user)
    except Exception as e:
        logger.error(f"Dashboard stats error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to load statistics")


# Register stats on multiple paths so one of them works (restart backend after changes)
app.add_api_route("/stats", _dashboard_stats_handler, methods=["GET"])
app.add_api_route("/dashboard/stats", _dashboard_stats_handler, methods=["GET"])
app.add_api_route("/api/dashboard/statistics", _dashboard_stats_handler, methods=["GET"])

logger.info("FastAPI application initialized (stats: /stats, /dashboard/stats, /api/dashboard/statistics)")


@app.on_event("startup")
def startup_log_routes():
    """Log registered routes at startup so you can confirm /stats is loaded."""
    try:
        routes = [r.path for r in app.routes if getattr(r, "path", None) and "/stats" in r.path]
        if routes:
            logger.info("Statistics routes registered: %s", routes)
        else:
            logger.warning("No /stats routes found on app.routes - check that this main.py is the one running")
    except Exception as e:
        logger.warning("Could not list routes: %s", e)


# ---------------------------------------------------------
# AUTH ROUTES
# ---------------------------------------------------------

@app.post("/login")
def login(user_login: schemas.UserLogin, db: Session = Depends(get_db)):
    """
    User login with password verification.
    Returns session token and user info on success.
    """
    try:
        logger.info(f"Login attempt for user: {user_login.username}")
        result = auth.login_user(user_login, db)
        logger.info(f"Login successful for user: {user_login.username}")
        return result
    except HTTPException as e:
        logger.warning(f"Login failed for user: {user_login.username} - {e.detail}")
        raise
    except Exception as e:
        logger.error(f"Unexpected error during login: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal server error during login")


@app.post("/auth/reset-username")
def reset_username(payload: schemas.UsernameReset, db: Session = Depends(get_db)):
    """
    Public endpoint to reset a forgotten username.
    Requires user ID and current password for verification.
    """
    try:
        user = crud.get_user_by_id(db, payload.user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        if not auth.verify_password(payload.current_password, user.password):
            raise HTTPException(status_code=401, detail="Current password is incorrect")

        crud.update_user_username(db, user, payload.new_username)
        return {"detail": "Username updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error resetting username for user {payload.user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to reset username")


@app.post("/auth/reset-password")
def reset_password(payload: schemas.PasswordReset, db: Session = Depends(get_db)):
    """
    Public endpoint to reset a forgotten password.
    Requires user ID and username for verification.
    """
    try:
        user = crud.get_user_by_id(db, payload.user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        if (user.username or "").strip() != payload.username.strip():
            raise HTTPException(status_code=401, detail="Username does not match this user ID")

        if payload.new_password.strip().lower() == payload.username.strip().lower():
            raise HTTPException(status_code=400, detail="Password must not be the same as username")

        user.password = auth.hash_password(payload.new_password)
        db.commit()
        return {"detail": "Password updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error resetting password for user {payload.user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to reset password")


@app.put("/tasks/{task_id}/procurement-stage")
def update_procurement_stage(
    task_id: int,
    stage_update: schemas.TaskProcurementStageUpdate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Update the procurement stage for a Procurement task.
    Allowed for members of the task's team.
    """
    try:
        crud.update_procurement_stage(db, task_id, stage_update, current_user.id, current_user)
        logger.info(f"Task {task_id} procurement stage updated to '{stage_update.procurement_stage}' by user {current_user.id}")
        return {"detail": "Procurement stage updated"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating procurement stage for task {task_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update procurement stage")


@app.post("/logout")
def logout(session_token: str):
    """
    User logout. Invalidates the session token.
    """
    try:
        logger.info(f"Logout attempt with session token")
        result = auth.logout_user(session_token)
        logger.info(f"Logout successful")
        return result
    except HTTPException as e:
        logger.warning(f"Logout failed - {e.detail}")
        raise
    except Exception as e:
        logger.error(f"Unexpected error during logout: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal server error during logout")


# ---------------------------------------------------------
# USER ROUTES
# ---------------------------------------------------------

@app.get("/users/me", response_model=schemas.UserListResponse)
def get_current_user_info(
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Return the current user's id, username, and role from the database.
    Use this so the dashboard can sync role after an admin changes it (e.g. promote to Division Head).
    """
    role = (current_user.role or "member").lower()
    return {
        "id": current_user.id,
        "username": current_user.username or "",
        "role": role,
        "designation": current_user.designation,
        "unread_notifications": crud.get_unread_notification_count(db, current_user.id),
    }


@app.post("/assistant/chat", response_model=schemas.AssistantChatResponse)
def assistant_chat(
    payload: schemas.AssistantChatRequest,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Local assistive chatbot backed by Ollama and live database context.
    Answers are permission-aware because all context is scoped server-side first.
    """
    try:
        return assistant_service.chat_with_assistant(
            db=db,
            current_user=current_user,
            message=payload.message,
            history=[item.model_dump() for item in (payload.history or [])],
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Assistant chat failed: %s", e)
        raise HTTPException(status_code=500, detail="Assistant is unavailable right now")


@app.get("/users", response_model=List[schemas.UserListResponse])
def list_users(
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    List visible users for dropdowns and management.
    Admin sees all non-admin users.
    Other users are limited to users under their accessible division scope.
    """
    try:
        users = crud.get_all_users(db, current_user)
        return users
    except Exception as e:
        logger.error(f"Error listing users: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to list users")


@app.put("/users/me/username", response_model=schemas.UserResponse)
def update_my_username(
    payload: schemas.UserUsernameUpdate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Let a signed-in user update their own username.
    The new username must stay unique across the whole system.
    """
    try:
        user = crud.update_user_username(db, current_user, payload.username)
        logger.info("User %s changed username to %s", current_user.id, user.username)
        return user
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error updating username for user %s: %s", current_user.id, str(e))
        raise HTTPException(status_code=500, detail="Failed to update username")


@app.put("/users/{user_id}/username", response_model=schemas.UserResponse)
def update_user_username(
    user_id: int,
    payload: schemas.UserUsernameUpdate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Let a global admin update another user's username.
    The new username must stay unique across the whole system.
    """
    try:
        auth.require_global_admin(current_user)
        user = crud.get_user_by_id(db, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        user = crud.update_user_username(db, user, payload.username)
        logger.info("User %s username updated to %s by %s", user_id, user.username, current_user.username)
        return user
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error updating username for user %s by %s: %s", user_id, current_user.id, str(e))
        raise HTTPException(status_code=500, detail="Failed to update user username")


@app.get("/notifications", response_model=List[schemas.NotificationResponse])
def get_notifications(
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    try:
        return crud.get_notifications_for_user(db, current_user.id)
    except Exception as e:
        logger.error("Error loading notifications for user %s: %s", current_user.id, str(e))
        raise HTTPException(status_code=500, detail="Failed to load notifications")


@app.post("/notifications/read-all")
def read_all_notifications(
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    try:
        updated = crud.mark_notifications_read(db, current_user.id)
        return {"message": "Notifications marked as read", "updated": updated}
    except Exception as e:
        logger.error("Error marking notifications as read for user %s: %s", current_user.id, str(e))
        raise HTTPException(status_code=500, detail="Failed to update notifications")


# ---------------------------------------------------------
# DIVISION / GROUP / ACTIVITY / TEAM (NEW hierarchy)
# ---------------------------------------------------------

@app.post("/divisions", response_model=schemas.DivisionResponse)
def create_division_route(
    payload: schemas.DivisionCreate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    # Admin creates division; head selection is optional.
    auth.require_global_admin(current_user)
    return crud.create_division(db, payload.name, current_user.id, payload.head_user_id)


@app.put("/divisions/{division_id}/head", response_model=schemas.DivisionResponse)
def assign_division_head_route(
    division_id: int,
    payload: schemas.DivisionHeadAssign,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    # Same permissions as role management in dashboard.
    auth.require_global_admin(current_user)
    return crud.assign_division_head(db, division_id, payload.user_id)


@app.put("/groups/{group_id}/head", response_model=schemas.GroupResponse)
def assign_group_head_route(
    group_id: int,
    payload: schemas.GroupHeadAssign,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    auth.require_global_admin(current_user)
    return crud.assign_group_head(db, group_id, payload.user_id)


@app.put("/divisions/{division_id}", response_model=schemas.DivisionResponse)
def rename_division_route(
    division_id: int,
    payload: schemas.DivisionRename,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    allowed_roles = ["admin", "division head", "group head"]
    if (current_user.role or "").lower() not in allowed_roles:
        raise HTTPException(status_code=403, detail="Not authorized to edit division")
    return crud.update_division_name(db, division_id, payload.name)


@app.put("/divisions/{division_id}/rename", response_model=schemas.DivisionResponse)
def rename_division_alias_route(
    division_id: int,
    payload: schemas.DivisionRename,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    return rename_division_route(division_id, payload, current_user, db)


@app.delete("/divisions/{division_id}")
def delete_division_route(
    division_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    try:
        return crud.delete_division(db, division_id, current_user)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting division {division_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete division")


@app.get("/divisions", response_model=List[schemas.DivisionResponse])
def list_divisions_route(
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    # For now: any authenticated user can list divisions (UI needs tree).
    return crud.list_divisions(db)


@app.post("/groups", response_model=schemas.GroupResponse)
def create_group_route(
    payload: schemas.GroupCreate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    # Division head (of that division) or global admin can create group and select group head
    allowed_globals = ["admin", "division head"]
    if (current_user.role or "").lower() not in allowed_globals:
        raise HTTPException(status_code=403, detail="Only Admin/Division Head can create groups")
    return crud.create_group(db, payload.division_id, payload.name, current_user.id, payload.head_user_id)


@app.get("/divisions/{division_id}/groups", response_model=List[schemas.GroupResponse])
def list_groups_route(
    division_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    return crud.list_groups_for_division(db, division_id)


@app.put("/groups/{group_id}", response_model=schemas.GroupResponse)
def rename_group_route(
    group_id: int,
    payload: schemas.GroupRename,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    if not _can_manage_group_scope(db, current_user, group_id):
        raise HTTPException(status_code=403, detail="Not authorized to edit group")
    return crud.update_group_name(db, group_id, payload.name)


@app.put("/groups/{group_id}/rename", response_model=schemas.GroupResponse)
def rename_group_alias_route(
    group_id: int,
    payload: schemas.GroupRename,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    return rename_group_route(group_id, payload, current_user, db)


@app.delete("/groups/{group_id}")
def delete_group_route(
    group_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    try:
        return crud.delete_group(db, group_id, current_user)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting group {group_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete group")


@app.post("/activities/group", response_model=schemas.ActivityResponse)
def create_activity_under_group_route(
    payload: schemas.ActivityCreate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    if not payload.group_id:
        raise HTTPException(status_code=400, detail="group_id is required")
    if not _can_manage_group_scope(db, current_user, payload.group_id):
        raise HTTPException(status_code=403, detail="Not authorized to create activities")
    return crud.create_activity_under_group(
        db,
        payload.group_id,
        payload.name,
        current_user.id,
        payload.type or "Project",
        payload.custom_type,
    )


@app.get("/groups/{group_id}/activities", response_model=List[schemas.ActivityResponse])
def list_group_activities_route(
    group_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    return crud.list_activities_for_group(db, group_id)


@app.put("/activities/{activity_id}", response_model=schemas.ActivityResponse)
def rename_activity_route(
    activity_id: int,
    payload: schemas.ActivityRename,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    if not _can_manage_activity_scope(db, current_user, activity_id):
        raise HTTPException(status_code=403, detail="Not authorized to edit activity")
    return crud.update_activity_name(db, activity_id, payload.name)


@app.put("/activities/{activity_id}/rename", response_model=schemas.ActivityResponse)
def rename_activity_alias_route(
    activity_id: int,
    payload: schemas.ActivityRename,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    return rename_activity_route(activity_id, payload, current_user, db)


@app.post("/teams/activity/{activity_id}", response_model=schemas.TeamResponse)
def create_team_under_activity_route(
    activity_id: int,
    payload: schemas.TeamCreate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    if not _can_manage_activity_scope(db, current_user, activity_id):
        raise HTTPException(status_code=403, detail="Not authorized to create teams")
    return crud.create_team_under_activity(db, activity_id, payload.name, current_user.id)


@app.get("/activities/{activity_id}/teams", response_model=List[schemas.TeamResponse])
def list_teams_for_activity_route(
    activity_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    return crud.list_teams_for_activity(db, activity_id)


@app.put("/teams/{team_id}/rename", response_model=schemas.TeamResponse)
def rename_team_route(
    team_id: int,
    payload: schemas.TeamRename,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    if not _can_manage_team_scope(db, current_user, team_id):
        raise HTTPException(status_code=403, detail="Not authorized to edit team")
    return crud.update_team_name(db, team_id, payload.name)


@app.put("/teams/{team_id}", response_model=schemas.TeamResponse)
def rename_team_alias_route(
    team_id: int,
    payload: schemas.TeamRename,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    return rename_team_route(team_id, payload, current_user, db)


@app.get("/nav/tree", response_model=List[schemas.NavDivisionNode])
def get_nav_tree_route(
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    return crud.get_nav_tree(db, current_user)


@app.post("/users", response_model=schemas.UserResponse)
def create_user(user: schemas.UserCreate, db: Session = Depends(get_db)):
    """
    Create a new user with hashed password.
    """
    try:
        existing_user = crud.get_user_by_username(db, user.username)
        if existing_user:
            logger.warning(f"User creation failed: Username '{user.username}' already exists")
            raise HTTPException(status_code=400, detail="Username already exists")

        new_user = crud.create_user(db, user)
        logger.info(f"New user created: {user.username} (ID: {new_user.id})")
        return new_user
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating user: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to create user")


@app.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Permanently delete a user account. Admin only.
    """
    try:
        return crud.delete_user_account(db, user_id, current_user)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete user account")


# ---------------------------------------------------------
# TEAM ROUTES
# ---------------------------------------------------------

@app.post("/teams", response_model=schemas.TeamResponse)
def create_team(
    team: schemas.TeamCreate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Create a new team.
    Only global admins can create teams.
    Creator is automatically added as team Admin.
    """
    try:
        # Check if user has global admin role (case-insensitive)
        auth.require_global_admin(current_user)

        new_team = crud.create_team(db, team, current_user.id, is_global_admin=True)
        logger.info(f"Team created: {team.name} (ID: {new_team.id}) by admin {current_user.username}")
        return new_team
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating team: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to create team")


@app.delete("/teams/{team_id}")
def delete_team_route(
    team_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Delete a team with hierarchy-based permissions.
    """
    try:
        result = crud.delete_team(db, team_id, current_user)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting team {team_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete team")


@app.post("/teams/{team_id}/add-member")
def add_member(
    team_id: int,
    user_id: int,
    role: str = "Member",
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Add a user to a team.
    Only team admins can add members.
    Validates that both user and team exist.
    """
    try:
        # Check if current user is team admin
        auth.require_team_admin(db, current_user.id, team_id)
        
        membership = crud.add_user_to_team(db, user_id, team_id, role)
        crud.log_activity(db, current_user.id, "Added member to team", "TeamMember", membership.id)
        new_member = crud.get_user_by_id(db, user_id)
        new_name = new_member.username if new_member else str(user_id)
        actor = current_user.username or "Admin"
        crud.post_system_message_to_team_activities(
            db, team_id,
            f'"{new_name}" was added to the team by {actor}.',
        )
        logger.info(f"User {user_id} added to team {team_id} as {role} by {current_user.username}")
        return {"message": "User added to team successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error adding user to team: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to add user to team")


@app.delete("/teams/{team_id}/members/{user_id}")
def remove_member_route(
    team_id: int,
    user_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Remove a member from a team.
    Global admins or team admins only.
    """
    try:
        return crud.remove_team_member(db, team_id, user_id, current_user)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error removing user {user_id} from team {team_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to remove member from team")


@app.put("/teams/{team_id}/members/{user_id}/role")
def update_member_role_route(
    team_id: int,
    user_id: int,
    role: str,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create or update a user's role inside a specific team.
    """
    try:
        auth.require_team_admin(db, current_user.id, team_id)
        membership = crud.set_user_team_role(db, user_id, team_id, role)
        return {"message": "Member role updated", "membership_id": membership.id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating member role for user {user_id} in team {team_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update member role")


@app.get("/teams/{team_id}/members")
def get_team_members(
    team_id: int,
    include_membership_id: bool = False,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    List team members (id, username, role).
    Global admins can view any team. Other users must belong to the team.
    If include_membership_id=true, each member includes membership_id for history.
    """
    try:
        allowed_globals = ["admin", "division head"]
        if (current_user.role or "").lower() not in allowed_globals:
            auth.require_team_member(db, current_user.id, team_id)
        members = crud.get_team_members(db, team_id, include_membership_id=include_membership_id)
        return members
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving team members: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve team members")


# ---------- Enterprise: Team approval (admin only) ----------
@app.get("/admin/teams/pending")
def get_pending_teams(
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """Teams awaiting admin approval. Global admin only."""
    auth.require_global_admin(current_user)
    teams = crud.get_pending_teams(db)
    return [{"id": t.id, "name": t.name, "created_by": t.created_by, "created_at": t.created_at} for t in teams]


@app.post("/admin/teams/{team_id}/approve")
def approve_team(
    team_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """Approve a pending team. Global admin only."""
    auth.require_global_admin(current_user)
    team = crud.approve_team(db, team_id)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    return {"message": "Team approved", "team": {"id": team.id, "name": team.name}}


# ---------------------------------------------------------
# ACTIVITY ROUTES (Division / Project under Team)
# ---------------------------------------------------------

from schemas import (
    ActivityCreate,
    ActivityResponse,
    ActivityMessageCreate,
    ActivityMessageUpdate,
    ActivityMessageResponse,
    TaskExtensionRequestCreate,
    TaskExtensionRequestDecision,
    TaskCompletionRequestDecision,
)


@app.post("/activities", response_model=ActivityResponse)
def create_activity_route(
    activity: ActivityCreate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Create an Activity (Division / Project) under a team.
    """
    return crud.create_activity(db, activity, current_user.id)


@app.delete("/activities/{activity_id}")
def delete_activity_route(
    activity_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Delete an activity with hierarchy-based permissions.
    """
    try:
        return crud.delete_activity(db, activity_id, current_user)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting activity {activity_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete activity")


@app.get("/teams/{team_id}/activities", response_model=List[ActivityResponse])
def list_team_activities(
    team_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    List Activities (Division / Project) for a given team.
    User must be a member of the team.
    """
    allowed_globals = ["admin", "division head"]
    if not crud.is_user_in_team(db, current_user.id, team_id) and (current_user.role or "").lower() not in allowed_globals:
        raise HTTPException(status_code=403, detail="You must be a member of the team to view its activities")
    return crud.get_activities_for_team(db, team_id)


# ---------------------------------------------------------
# ACTIVITY CHAT ROUTES (Activity-level discussion panel)
# ---------------------------------------------------------

@app.get("/activities/{activity_id}/messages", response_model=List[ActivityMessageResponse])
def list_activity_messages(
    activity_id: int,
    limit: int = 200,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    List messages for an activity (user + system).
    Requires: user is a member of the activity's team (or global admin).
    """
    return crud.list_activity_messages(db, activity_id, current_user, limit=limit)


@app.post("/activities/{activity_id}/messages", response_model=ActivityMessageResponse)
def create_activity_message(
    activity_id: int,
    payload: ActivityMessageCreate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create a user message in an activity stream.
    """
    return crud.create_activity_message(db, activity_id, payload, current_user)


@app.put("/activities/{activity_id}/messages/{message_id}", response_model=ActivityMessageResponse)
def update_activity_message(
    activity_id: int,
    message_id: int,
    payload: ActivityMessageUpdate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Edit a user message (author or global admin). System messages cannot be edited.
    """
    return crud.update_activity_message(db, activity_id, message_id, payload, current_user)


@app.delete("/activities/{activity_id}/messages/{message_id}")
def delete_activity_message(
    activity_id: int,
    message_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Delete a user message (author or global admin). System messages cannot be deleted.
    """
    return crud.delete_activity_message(db, activity_id, message_id, current_user)


# ---------- Enterprise: Member invitations ----------
@app.post("/teams/{team_id}/invite")
def invite_member(
    team_id: int,
    user_id: int,
    role: str = "Member",
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """Send team invitation (instead of direct add). Team admin only."""
    auth.require_team_admin(db, current_user.id, team_id)
    inv = crud.create_invitation(db, team_id, user_id, current_user.id, role)
    return {"message": "Invitation sent", "invitation_id": inv.id}


@app.get("/users/me/invitations")
def get_my_invitations(
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """List pending invitations for current user."""
    return crud.get_invitations_for_user(db, current_user.id)


@app.post("/invitations/{invitation_id}/accept")
def accept_invitation(
    invitation_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """Accept a team invitation."""
    return crud.accept_invitation(db, invitation_id, current_user.id)


@app.get("/users/{user_id}/teams")
def get_user_teams(
    user_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get all teams of a user with their role in each team.
    Users can only request their own teams unless global admin.
    """
    try:
        allowed_globals = ["admin", "division head"]
        if current_user.id != user_id and (current_user.role or "").lower() not in allowed_globals:
            raise HTTPException(status_code=403, detail="Can only view your own teams")
        teams = crud.get_user_teams(db, user_id)
        logger.info(f"Retrieved {len(teams)} teams for user {user_id}")
        return teams
    except Exception as e:
        logger.error(f"Error retrieving teams for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve user teams")


@app.put("/users/{user_id}/role", response_model=schemas.UserResponse)
def update_user_role(
    user_id: int,
    payload: schemas.UserRoleUpdate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Update a user's global role.
    Global admins / Division Heads only.
    """
    try:
        auth.require_global_admin(current_user)
        user = crud.update_user_role(db, user_id, payload.role)
        logger.info(f"User {user_id} role updated to {payload.role} by {current_user.username}")
        return user
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating user role: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update user role")


@app.put("/users/{user_id}/designation", response_model=schemas.UserResponse)
def update_user_designation(
    user_id: int,
    payload: schemas.UserDesignationUpdate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Update a user's designation.
    Global admin only.
    """
    try:
        auth.require_global_admin(current_user)
        user = crud.update_user_designation(db, user_id, payload.designation)
        logger.info(f"User {user_id} designation updated to {payload.designation} by {current_user.username}")
        return user
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating user designation: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update user designation")


@app.get("/user-options", response_model=List[schemas.UserOptionResponse])
def list_user_options(
    option_type: str | None = None,
    db: Session = Depends(get_db)
):
    try:
        return crud.get_user_options(db, option_type)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving user options: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve user options")


@app.post("/user-options", response_model=schemas.UserOptionResponse)
def create_user_option(
    payload: schemas.UserOptionCreate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    try:
        auth.require_global_admin(current_user)
        item = crud.create_user_option(db, payload.option_type, payload.value, current_user.id)
        logger.info(
            "User option created: %s=%s by %s",
            payload.option_type,
            payload.value,
            current_user.username,
        )
        return item
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating user option: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to create user option")


@app.put("/user-options/{option_id}", response_model=schemas.UserOptionResponse)
def update_user_option(
    option_id: int,
    payload: schemas.UserOptionUpdate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    try:
        auth.require_global_admin(current_user)
        return crud.update_user_option(db, option_id, payload.value)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating user option {option_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update user option")


@app.delete("/user-options/{option_id}")
def delete_user_option(
    option_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    try:
        auth.require_global_admin(current_user)
        return crud.delete_user_option(db, option_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting user option {option_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete user option")


@app.get("/holidays", response_model=List[schemas.HolidayResponse])
def list_holidays(
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    try:
        return crud.get_holidays(db)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving holidays: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve holidays")


@app.post("/holidays", response_model=schemas.HolidayResponse)
def create_holiday(
    payload: schemas.HolidayCreate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    try:
        auth.require_global_admin(current_user)
        return crud.create_holiday(db, payload, current_user.id)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating holiday: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to create holiday")


@app.delete("/holidays/{holiday_id}")
def delete_holiday(
    holiday_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    try:
        auth.require_global_admin(current_user)
        return crud.delete_holiday(db, holiday_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting holiday {holiday_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete holiday")


@app.get("/milestones", response_model=List[schemas.MilestoneResponse])
def list_milestones(
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    try:
        return crud.get_milestones(db)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving milestones: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve milestones")


@app.post("/milestones", response_model=schemas.MilestoneResponse)
def create_milestone(
    payload: schemas.MilestoneCreate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    try:
        role = (current_user.role or "").strip().lower()
        if role not in ("admin", "division head", "group head", "project director", "team lead"):
            raise HTTPException(status_code=403, detail="Only admin/division head/group head/project director/team lead can create milestones")
        return crud.create_milestone(db, payload, current_user.id)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating milestone: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to create milestone")


@app.delete("/milestones/{milestone_id}")
def delete_milestone(
    milestone_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    try:
        role = (current_user.role or "").strip().lower()
        if role not in ("admin", "division head", "group head"):
            raise HTTPException(status_code=403, detail="Only admin/division head/group head can delete milestones")
        return crud.delete_milestone(db, milestone_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting milestone {milestone_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete milestone")


@app.get("/users", response_model=List[schemas.UserListResponse])
def list_users(
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    List all users.
    Authenticated users only.
    """
    try:
        users = crud.get_all_users(db, current_user)
        return users
    except Exception as e:
        logger.error(f"Error listing users: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to list users")


# ---------------------------------------------------------
# TASK ROUTES
# ---------------------------------------------------------

@app.post("/tasks", response_model=schemas.TaskResponse)
def create_task(
    task: schemas.TaskCreate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Create and assign a task.
    Validates that current user is a team member. Uses session user as creator.
    """
    try:
        new_task = crud.create_task(db, task, current_user.id)
        logger.info(f"Task created: {task.title} (ID: {new_task['id']}) by user {current_user.id}")
        return new_task
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error creating task: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to create task")


@app.get("/tasks", response_model=List[schemas.TaskResponse])
def get_tasks(
    team_id: int = None,
    assigned_to: int = None,
    status: str = None,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Fetch tasks with optional filters. Requires auth.
    Non-admins only see tasks from teams they belong to.
    """
    try:
        tasks = crud.get_tasks(db, team_id, assigned_to, status, current_user)
        logger.info(f"Retrieved {len(tasks)} tasks with filters: team_id={team_id}, assigned_to={assigned_to}, status={status}")
        return tasks
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving tasks: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve tasks")


@app.post("/tasks/{task_id}/approve", response_model=schemas.TaskResponse)
def approve_task_endpoint(
    task_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Approve a pending task.
    Allowed for: Admin, Division Head, Project Director, Group Head, Team Lead.
    """
    # Permission check
    allowed_roles = ["admin", "division head", "project director", "group head", "team lead"]
    user_role = (current_user.role or "").lower()
    if user_role not in allowed_roles:
         raise HTTPException(status_code=403, detail="Not authorized to approve tasks")

    try:
        task = crud.approve_task(db, task_id, current_user.id)
        return task
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error approving task {task_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to approve task")


@app.put("/tasks/{task_id}/status", response_model=schemas.TaskResponse)
def update_task_status(
    task_id: int,
    status_update: schemas.TaskStatusUpdate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Update task status.
    Validates that current user is a team member.
    """
    try:
        task = crud.update_task_status(db, task_id, status_update, current_user.id, current_user)
        logger.info(f"Task {task_id} status updated to '{status_update.status}' by user {current_user.id}")
        return task
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating task status: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update task status")


@app.delete("/tasks/{task_id}")
def delete_task_route(
    task_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Delete a task and its related records.
    Global admins or team admins only.
    """
    try:
        return crud.delete_task(db, task_id, current_user)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting task {task_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete task")


@app.put("/tasks/{task_id}/approve-type", response_model=schemas.TaskResponse)
def approve_task_type_route(
    task_id: int,
    payload: schemas.TaskTypeApprovalUpdate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Approve or reject a task's type for Procurement tasks created by a member.
    Allowed: Admin, Division Head, Team Lead, Project Director.
    """
    try:
        crud.approve_task_type(db, task_id, current_user.id, payload.approved)
        tasks = crud.get_tasks(db, team_id=None, assigned_to=None, status=None, current_user=current_user)
        for t in tasks:
            if t.get("id") == task_id:
                return t
        raise HTTPException(status_code=500, detail="Task not found after approval")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error approving task type {task_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to approve task type")


@app.put("/tasks/{task_id}/assign", response_model=schemas.TaskResponse)
def assign_task(
    task_id: int,
    payload: schemas.TaskAssignUpdate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Assign or unassign a task. Admin only. Assignee must be a member of the task's team.
    """
    try:
        return crud.update_task_assignee(db, task_id, payload.assigned_to, current_user)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error assigning task {task_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to assign task")


@app.put("/tasks/{task_id}/due-date", response_model=schemas.TaskResponse)
def update_task_due_date_route(
    task_id: int,
    payload: schemas.TaskDueDateUpdate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Change a task's due date. Admin only.
    """
    try:
        return crud.update_task_due_date(db, task_id, payload.due_date, current_user)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating due date for task {task_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update due date")


@app.put("/tasks/{task_id}/details", response_model=schemas.TaskResponse)
def update_task_details_route(
    task_id: int,
    payload: schemas.TaskDetailsEdit,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Edit task/subtask fields with role checks:
    - Admin/Division Head/Group Head: edit task/subtask details.
    - Member: edit only their own subtasks.
    """
    def _find_task_in_tree(items, target_id):
        for item in items or []:
            if item.get("id") == target_id:
                return item
            nested = _find_task_in_tree(item.get("subtasks") or [], target_id)
            if nested:
                return nested
        return None

    try:
        crud.update_task_details(db, task_id, payload, current_user)
        tasks = crud.get_tasks(db, team_id=None, assigned_to=None, status=None, current_user=current_user)
        found = _find_task_in_tree(tasks, task_id)
        if found:
            return found
        raise HTTPException(status_code=500, detail="Task not found after update")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating task details for task {task_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update task details")


@app.post("/tasks/{task_id}/convert-to-milestone", response_model=schemas.MilestoneResponse)
def convert_task_to_milestone_route(
    task_id: int,
    payload: schemas.TaskConvertToMilestone,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    try:
        return crud.convert_task_to_milestone(db, task_id, payload, current_user)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error converting task {task_id} to milestone: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to convert task to milestone")


@app.put("/milestones/{milestone_id}", response_model=schemas.MilestoneResponse)
def update_milestone_route(
    milestone_id: int,
    payload: schemas.MilestoneEdit,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    try:
        return crud.update_milestone(db, milestone_id, payload, current_user)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating milestone {milestone_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update milestone")


@app.post("/milestones/{milestone_id}/convert-to-task", response_model=schemas.TaskResponse)
def convert_milestone_to_task_route(
    milestone_id: int,
    payload: schemas.MilestoneConvertToTask,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    try:
        created_task = crud.convert_milestone_to_task(db, milestone_id, payload, current_user)
        tasks = crud.get_tasks(db, team_id=None, assigned_to=None, status=None, current_user=current_user)
        def _find_task_in_tree(items, target_id):
            for item in items or []:
                if item.get("id") == target_id:
                    return item
                nested = _find_task_in_tree(item.get("subtasks") or [], target_id)
                if nested:
                    return nested
            return None
        found = _find_task_in_tree(tasks, created_task.get("id") if isinstance(created_task, dict) else created_task.id)
        if found:
            return found
        raise HTTPException(status_code=500, detail="Task not found after update")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error converting milestone {milestone_id} to task: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to convert milestone to task")


# ---------------------------------------------------------
# TASK EXTENSION REQUEST ROUTES
# ---------------------------------------------------------


@app.post("/tasks/{task_id}/extension-requests")
def create_extension_request(
    task_id: int,
    payload: TaskExtensionRequestCreate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create an extension request for a task.
    Any member of the task's team can request an extension.
    """
    try:
        ext = crud.create_task_extension_request(db, task_id, payload, current_user)
        return {
            "id": ext.id,
            "task_id": ext.task_id,
            "requested_by": ext.requested_by,
            "requested_to": ext.requested_to,
            "reason": ext.reason,
            "requested_due_date": ext.requested_due_date,
            "status": ext.status,
            "created_at": ext.created_at,
            "decided_at": ext.decided_at,
            "decided_by": ext.decided_by,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating extension request for task {task_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to create extension request")


# ---------------------------------------------------------
# TASK COMPLETION REQUEST ROUTES (proof + approval)
# ---------------------------------------------------------


@app.post("/tasks/{task_id}/completion-requests")
def create_completion_request(
    task_id: int,
    files: List[UploadFile] = File(...),
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Submit task completion proof (one or more files: PDF, Word, PowerPoint, or images).
    Total size limit 100 MB. Task status becomes 'Pending Completion' until admin approves.
    """
    try:
        upload_dir = str(config.UPLOAD_DIR)
        if not files:
            raise HTTPException(status_code=400, detail="At least one file is required")
        files_list = []
        for f in files:
            content = f.file.read()
            filename = f.filename or "attachment"
            files_list.append((content, filename))
        if len(files_list) == 1:
            req = crud.create_task_completion_request(
                db, task_id, current_user, files_list[0][0], files_list[0][1], upload_dir
            )
        else:
            req = crud.create_task_completion_request_batch(
                db, task_id, current_user, files_list, upload_dir
            )
        return {
            "id": req.id,
            "task_id": req.task_id,
            "submitted_by": req.submitted_by,
            "status": req.status,
            "created_at": req.created_at,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating completion request for task {task_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to submit completion proof")


@app.get("/tasks/completion-requests/{request_id}/attachment")
def get_completion_attachment(
    request_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Download/view the completion proof attachment.
    User must be team member or admin.
    """
    from models import TaskCompletionRequest
    req = db.query(TaskCompletionRequest).filter(TaskCompletionRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Completion request not found")
    task = crud.get_task_by_id(db, req.task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    allowed_globals = ["admin", "division head"]
    if not crud.is_user_in_team(db, current_user.id, task.team_id) and (current_user.role or "").lower() not in allowed_globals:
        raise HTTPException(status_code=403, detail="Access denied")
    import os
    if not os.path.isfile(req.attachment_path):
        raise HTTPException(status_code=404, detail="Attachment file not found")

    # Try to send a correct Content-Type so the browser can open the file
    # in the same format it was uploaded (PDF, Word, image, etc.).
    guessed_type, _ = mimetypes.guess_type(req.attachment_filename or req.attachment_path)
    media_type = guessed_type or "application/octet-stream"

    return FileResponse(
        req.attachment_path,
        media_type=media_type,
        filename=req.attachment_filename or os.path.basename(req.attachment_path) or "attachment",
    )


@app.put("/tasks/completion-requests/{request_id}")
def decide_completion_request(
    request_id: int,
    payload: TaskCompletionRequestDecision,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Approve or reject a completion request.
    Only global admins or team admins can decide.
    """
    try:
        req = crud.decide_task_completion_request(db, request_id, payload, current_user)
        return {
            "id": req.id,
            "task_id": req.task_id,
            "status": req.status,
            "decided_at": req.decided_at,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deciding completion request {request_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update completion request")


# ---------------------------------------------------------
# TASK EXTENSION REQUEST ROUTES
# ---------------------------------------------------------


@app.put("/tasks/extension-requests/{request_id}")
def decide_extension_request(
    request_id: int,
    payload: TaskExtensionRequestDecision,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Approve or reject an extension request.
    Only global admins or team admins can decide.
    """
    try:
        ext = crud.decide_task_extension_request(db, request_id, payload, current_user)
        return {
            "id": ext.id,
            "task_id": ext.task_id,
            "requested_by": ext.requested_by,
            "requested_to": ext.requested_to,
            "reason": ext.reason,
            "requested_due_date": ext.requested_due_date,
            "status": ext.status,
            "created_at": ext.created_at,
            "decided_at": ext.decided_at,
            "decided_by": ext.decided_by,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deciding extension request {request_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update extension request")


# ---------------------------------------------------------
# COMMENT ROUTES
# ---------------------------------------------------------

@app.post("/tasks/{task_id}/comments", response_model=schemas.CommentResponse)
def create_comment(
    task_id: int,
    comment: schemas.CommentCreate,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Add a comment to a task.
    Validates that current user is a team member.
    """
    try:
        new_comment = crud.create_comment(db, comment, task_id, current_user.id)
        logger.info(f"Comment added to task {task_id} by user {current_user.id}")
        return new_comment
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating comment: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to create comment")


@app.get("/tasks/{task_id}/comments", response_model=List[schemas.CommentResponse])
def get_task_comments(
    task_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get all comments for a task. User must be a member of the task's team.
    """
    try:
        comments = crud.get_comments_by_task(db, task_id, current_user.id)
        logger.info(f"Retrieved {len(comments)} comments for task {task_id}")
        return comments
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving comments for task {task_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve comments")


# ---------------------------------------------------------
# ACTIVITY LOG ROUTES
# ---------------------------------------------------------

@app.get("/activity", response_model=List[schemas.ActivityLogResponse])
def get_activity_logs(
    user_id: int = None,
    entity_type: str = None,
    entity_id: int = None,
    limit: int = 50,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get activity logs with optional filters.
    When entity_type and entity_id are provided, returns all logs for that entity (user must have access to the entity's team).
    Otherwise non-admins only see their own logs.
    """
    try:
        allowed_globals = ["admin", "division head"]
        is_global_admin = (current_user.role or "").lower() in allowed_globals

        if entity_type and entity_id:
            entity_kind = (entity_type or "").lower()
            if entity_kind == "activity":
                activity_context = crud._get_activity_hierarchy_context(db, entity_id)
                if not activity_context or not activity_context.get("activity"):
                    raise HTTPException(status_code=404, detail="Entity not found")
                if not is_global_admin:
                    division = activity_context.get("division")
                    accessible_division_ids = crud.get_accessible_division_ids_for_user(db, current_user.id)
                    if not division or division.id not in accessible_division_ids:
                        raise HTTPException(status_code=403, detail="Access denied to this entity")
            else:
                team_id = crud.get_entity_team_id_for_log_access(db, entity_type, entity_id)
                if team_id is None:
                    raise HTTPException(status_code=404, detail="Entity not found")
                if not is_global_admin and not crud.is_user_in_team(db, current_user.id, team_id):
                    raise HTTPException(status_code=403, detail="Access denied to this entity")
            logs = crud.get_activity_logs(db, None, entity_type, entity_id, limit=300)
        else:
            if not is_global_admin and user_id is not None and user_id != current_user.id:
                raise HTTPException(status_code=403, detail="Can only view your own activity")
            if not is_global_admin:
                user_id = current_user.id
            logs = crud.get_activity_logs(db, user_id, entity_type, entity_id, limit)
        logger.info(f"Retrieved {len(logs)} activity logs")
        return logs
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving activity logs: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve activity logs")


@app.delete("/activity")
def delete_activity_logs(
    entity_type: str = None,
    entity_id: int = None,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Delete activity logs for a specific entity (admin/division head only).
    Requires entity_type and entity_id.
    """
    try:
        allowed_globals = ["admin", "division head"]
        is_global_admin = (current_user.role or "").lower() in allowed_globals
        if not is_global_admin:
            raise HTTPException(status_code=403, detail="Only admins can clear history")
        
        if not entity_type or entity_id is None:
            raise HTTPException(status_code=400, detail="entity_type and entity_id are required")
        
        entity_kind = (entity_type or "").lower()
        if entity_kind == "activity":
            activity_context = crud._get_activity_hierarchy_context(db, entity_id)
            if not activity_context or not activity_context.get("activity"):
                raise HTTPException(status_code=404, detail="Entity not found")
        else:
            team_id = crud.get_entity_team_id_for_log_access(db, entity_type, entity_id)
            if team_id is None:
                raise HTTPException(status_code=404, detail="Entity not found")

        # Delete logs for this entity (includes system messages for tasks)
        deleted_count = crud.delete_activity_logs_for_entity(db, entity_type, entity_id)
        logger.info(f"Deleted {deleted_count} history entries (activity logs + system messages) for {entity_type} {entity_id} by admin {current_user.id}")
        return {"message": f"Deleted {deleted_count} history entries", "deleted_count": deleted_count}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting activity logs: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete activity logs")


# ---------------------------------------------------------
# ROOT CHECK (LAN TEST)
# ---------------------------------------------------------

@app.get("/")
def root():
    """
    Health check endpoint to verify the app is running.
    """
    logger.info("Health check endpoint accessed")
    return {
        "message": "Saralta is running on LAN",
        "status": "operational",
        "version": "1.0",
        "active_sessions": sessions.get_active_sessions_count()
    }


# ---------------------------------------------------------
# SESSION MONITORING (ADMIN)
# ---------------------------------------------------------

@app.get("/sessions/cleanup")
def cleanup_sessions():
    """
    Manually trigger cleanup of expired sessions.
    Useful for monitoring and maintenance.
    """
    try:
        count = sessions.cleanup_expired_sessions()
        logger.info(f"Session cleanup completed: {count} sessions removed")
        return {
            "message": "Session cleanup completed",
            "expired_sessions_removed": count,
            "active_sessions": sessions.get_active_sessions_count()
        }
    except Exception as e:
        logger.error(f"Error during session cleanup: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to cleanup sessions")
