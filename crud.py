from sqlalchemy.orm import Session
from sqlalchemy import and_
from datetime import datetime

from models import User, Team, TeamMember, Task, Comment
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


def update_task_status(db: Session, task_id: int, status_update: TaskStatusUpdate):
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
