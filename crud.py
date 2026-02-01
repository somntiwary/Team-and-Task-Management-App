from sqlalchemy.orm import Session
from sqlalchemy import and_
from datetime import datetime

from models import User, Team, TeamMember, Task, Comment, ActivityLog
from schemas import (
    UserCreate,
    TeamCreate,
    TaskCreate,
    TaskStatusUpdate,
    CommentCreate
)

# ------------------------------------------------------------------
# USER CRUD OPERATIONS
# ------------------------------------------------------------------

def create_user(db: Session, user: UserCreate):
    """
    Create a new user.
    Password is stored as plain text for Phase-1 (LAN demo only).
    """
    db_user = User(
        username=user.username,
        password=user.password,
        role=user.role
    )
    db.add(db_user)
    db.commit()
    db.refresh(db_user)
    return db_user


def get_user_by_username(db: Session, username: str):
    """
    Fetch user by username.
    Used for login & validation.
    """
    return db.query(User).filter(User.username == username).first()


# ------------------------------------------------------------------
# TEAM CRUD OPERATIONS
# ------------------------------------------------------------------

def create_team(db: Session, team: TeamCreate, created_by: int):
    """
    Create a new team.
    Creator is automatically added as Admin.
    """
    db_team = Team(
        name=team.name,
        created_by=created_by
    )
    db.add(db_team)
    db.commit()
    db.refresh(db_team)

    # Add creator as team admin
    membership = TeamMember(
        user_id=created_by,
        team_id=db_team.id,
        role="Admin"
    )
    db.add(membership)
    db.commit()

    return db_team


def add_user_to_team(db: Session, user_id: int, team_id: int, role: str = "Member"):
    """
    Add a user to a team.
    """
    membership = TeamMember(
        user_id=user_id,
        team_id=team_id,
        role=role
    )
    db.add(membership)
    db.commit()
    return membership


def get_user_teams(db: Session, user_id: int):
    """
    Get all teams a user belongs to.
    """
    return (
        db.query(Team)
        .join(TeamMember)
        .filter(TeamMember.user_id == user_id)
        .all()
    )


# ------------------------------------------------------------------
# TASK CRUD OPERATIONS
# ------------------------------------------------------------------

def create_task(db: Session, task: TaskCreate, created_by: int):
    """
    Create a task and assign it to a user.
    """
    db_task = Task(
        title=task.title,
        description=task.description,
        team_id=task.team_id,
        assigned_to=task.assigned_to,
        due_date=task.due_date,
        priority=task.priority,
        status="To Do",
        created_by=created_by
    )
    db.add(db_task)
    db.commit()
    db.refresh(db_task)

    # Log activity
    log_activity(db, created_by, "Created task", "Task", db_task.id)

    return db_task


def get_tasks(
    db: Session,
    team_id: int = None,
    assigned_to: int = None,
    status: str = None
):
    """
    Fetch tasks with optional filters:
    - team
    - assigned user
    - status
    """
    query = db.query(Task)

    if team_id:
        query = query.filter(Task.team_id == team_id)

    if assigned_to:
        query = query.filter(Task.assigned_to == assigned_to)

    if status:
        query = query.filter(Task.status == status)

    return query.all()


def update_task_status(db: Session, task_id: int, status_update: TaskStatusUpdate, user_id: int):
    """
    Update task status (To Do / In Progress / Completed).
    """
    task = db.query(Task).filter(Task.id == task_id).first()

    if not task:
        return None

    task.status = status_update.status
    task.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(task)

    # Log activity
    log_activity(db, user_id, f"Updated task status to {status_update.status}", "Task", task_id)

    return task


# ------------------------------------------------------------------
# COMMENT CRUD OPERATIONS
# ------------------------------------------------------------------

def create_comment(db: Session, comment: CommentCreate, task_id: int, user_id: int):
    """
    Create a new comment on a task.
    """
    db_comment = Comment(
        content=comment.content,
        task_id=task_id,
        user_id=user_id
    )
    db.add(db_comment)
    db.commit()
    db.refresh(db_comment)
    return db_comment


def get_comments_by_task(db: Session, task_id: int):
    """
    Get all comments for a task.
    """
    return db.query(Comment).filter(Comment.task_id == task_id).all()


# ------------------------------------------------------------------
# ACTIVITY LOG CRUD OPERATIONS
# ------------------------------------------------------------------

def log_activity(db: Session, user_id: int, action: str, entity_type: str, entity_id: int):
    """
    Log an activity (e.g., task creation, update).
    """
    log_entry = ActivityLog(
        user_id=user_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id
    )
    db.add(log_entry)
    db.commit()


def get_activity_logs(db: Session, user_id: int = None, entity_type: str = None, entity_id: int = None, limit: int = 50):
    """
    Get activity logs with optional filters.
    """
    query = db.query(ActivityLog)
    if user_id:
        query = query.filter(ActivityLog.user_id == user_id)
    if entity_type:
        query = query.filter(ActivityLog.entity_type == entity_type)
    if entity_id:
        query = query.filter(ActivityLog.entity_id == entity_id)
    return query.order_by(ActivityLog.timestamp.desc()).limit(limit).all()
