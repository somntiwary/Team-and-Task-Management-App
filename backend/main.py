from fastapi import FastAPI, Depends, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from sqlalchemy import text
from typing import List
import logging
from logging.handlers import RotatingFileHandler
import os
import mimetypes

import models
import schemas
import crud
import auth
import sessions
import config

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
        for stmt, name in [
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
            ("ALTER TABLE tasks ADD COLUMN task_type VARCHAR(20) DEFAULT 'Normal'", "tasks.task_type"),
            ("ALTER TABLE tasks ADD COLUMN type_approval_status VARCHAR(20) DEFAULT 'not_required'", "tasks.type_approval_status"),
            ("ALTER TABLE tasks ADD COLUMN type_approved_by INTEGER", "tasks.type_approved_by"),
            ("ALTER TABLE tasks ADD COLUMN type_approved_at DATETIME", "tasks.type_approved_at"),
            ("ALTER TABLE tasks ADD COLUMN procurement_stage VARCHAR(100)", "tasks.procurement_stage"),
        ]:
            try:
                conn.execute(text(stmt))
                conn.commit()
                logger.info("Migration: added column %s", name)
            except Exception as e:
                conn.rollback()
                if "duplicate column" not in str(e).lower():
                    raise
        try:
            conn.execute(text("""
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
            """))
            conn.commit()
            logger.info("Migration: ensured team_invitations table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        # New table for Activities (Division / Project) under Teams
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS activities (
                    id INTEGER NOT NULL PRIMARY KEY,
                    name VARCHAR(200) NOT NULL,
                    type VARCHAR(20) NOT NULL,
                    team_id INTEGER NOT NULL,
                    created_at DATETIME,
                    FOREIGN KEY(team_id) REFERENCES teams (id)
                )
            """))
            conn.commit()
            logger.info("Migration: ensured activities table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        # New table for Activity-level messages (project logbook / discussion panel)
        try:
            conn.execute(text("""
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
            """))
            conn.commit()
            logger.info("Migration: ensured activity_messages table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        # New table for Task completion requests (proof + approval)
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS task_completion_requests (
                    id INTEGER NOT NULL PRIMARY KEY,
                    task_id INTEGER NOT NULL,
                    submitted_by INTEGER NOT NULL,
                    previous_status VARCHAR(20) NOT NULL,
                    attachment_path VARCHAR(500) NOT NULL,
                    attachment_filename VARCHAR(255),
                    status VARCHAR(20) DEFAULT 'pending',
                    created_at DATETIME,
                    decided_at DATETIME,
                    decided_by INTEGER,
                    FOREIGN KEY(task_id) REFERENCES tasks (id),
                    FOREIGN KEY(submitted_by) REFERENCES users (id),
                    FOREIGN KEY(decided_by) REFERENCES users (id)
                )
            """))
            conn.commit()
            logger.info("Migration: ensured task_completion_requests table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        # New table for Task extension requests
        try:
            conn.execute(text("""
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
            """))
            conn.commit()
            logger.info("Migration: ensured task_extension_requests table")
        except Exception as e:
            conn.rollback()
            if "already exists" not in str(e).lower():
                raise

        # Task assignments (multiple assignees per task with optional share % and lead)
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS task_assignments (
                    id INTEGER NOT NULL PRIMARY KEY,
                    task_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    percent_share INTEGER,
                    is_lead INTEGER DEFAULT 0,
                    FOREIGN KEY(task_id) REFERENCES tasks (id),
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
            """))
            conn.commit()
            logger.info("Migration: ensured task_assignments table")
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

logger.info("FastAPI application initialized")

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

        existing = crud.get_user_by_username(db, payload.new_username.strip())
        if existing and existing.id != user.id:
            raise HTTPException(status_code=400, detail="Username already taken")

        if payload.new_username.strip().lower() == payload.current_password.strip().lower():
            raise HTTPException(status_code=400, detail="Username must not be the same as password")

        user.username = payload.new_username.strip()
        db.commit()
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
):
    """
    Return the current user's id, username, and role from the database.
    Use this so the dashboard can sync role after an admin changes it (e.g. promote to Division Head).
    """
    role = (current_user.role or "member").lower()
    return {"id": current_user.id, "username": current_user.username or "", "role": role}


@app.get("/users", response_model=List[schemas.UserListResponse])
def list_users(
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    List all users (id, username) for dropdowns. Requires auth.
    """
    try:
        users = crud.get_all_users(db)
        return users
    except Exception as e:
        logger.error(f"Error listing users: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to list users")


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
    Delete a team (admin only).
    For safety, teams with members, activities or tasks cannot be deleted.
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
        
        crud.add_user_to_team(db, user_id, team_id, role)
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


@app.get("/teams/{team_id}/members")
def get_team_members(
    team_id: int,
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db)
):
    """
    List team members (id, username, role). User must be a member of the team.
    """
    try:
        auth.require_team_member(db, current_user.id, team_id)
        members = crud.get_team_members(db, team_id)
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
    Delete an activity (Division / Project).
    Global admins or admins of the parent team only.
    Activities with tasks cannot be deleted.
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
        users = crud.get_all_users(db)
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
        logger.error(f"Error creating task: {str(e)}")
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
    Approve or reject a task's type (Technical/Procurement created by a member).
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
    file: UploadFile = File(...),
    current_user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Submit task completion proof (PDF, Word, or image).
    Task status becomes 'Pending Completion' until admin approves.
    """
    try:
        content = file.file.read()
        filename = file.filename or "attachment"
        upload_dir = str(config.UPLOAD_DIR)
        req = crud.create_task_completion_request(
            db, task_id, current_user, content, filename, upload_dir
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
    Get activity logs with optional filters. Non-admins only see their own logs.
    """
    try:
        allowed_globals = ["admin", "division head"]
        if (current_user.role or "").lower() not in allowed_globals and user_id is not None and user_id != current_user.id:
            raise HTTPException(status_code=403, detail="Can only view your own activity")
        if (current_user.role or "").lower() not in allowed_globals:
            user_id = current_user.id  # non-admins only see their own activity
        logs = crud.get_activity_logs(db, user_id, entity_type, entity_id, limit)
        logger.info(f"Retrieved {len(logs)} activity logs")
        return logs
    except Exception as e:
        logger.error(f"Error retrieving activity logs: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve activity logs")


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
