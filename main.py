from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from typing import List

import models
import schemas
import crud
import auth

from database import engine, get_db

# ---------------------------------------------------------
# CREATE DATABASE TABLES
# ---------------------------------------------------------
models.Base.metadata.create_all(bind=engine)

# ---------------------------------------------------------
# FASTAPI APP INIT
# ---------------------------------------------------------
app = FastAPI(
    title="Team & Task Management System",
    description="LAN-based Task Management App for Academic & Research Teams",
    version="1.0"
)

# CORS middleware for future frontend integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for LAN; restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------
# AUTH ROUTES
# ---------------------------------------------------------

@app.post("/login")
def login(user_login: schemas.UserLogin, db: Session = Depends(get_db)):
    """
    User login.
    Returns basic user info on success.
    """
    return auth.login_user(user_login, db)


# ---------------------------------------------------------
# USER ROUTES
# ---------------------------------------------------------

@app.post("/users", response_model=schemas.UserResponse)
def create_user(user: schemas.UserCreate, db: Session = Depends(get_db)):
    """
    Create a new user.
    """
    existing_user = crud.get_user_by_username(db, user.username)
    if existing_user:
        raise HTTPException(status_code=400, detail="Username already exists")

    return crud.create_user(db, user)


# ---------------------------------------------------------
# TEAM ROUTES
# ---------------------------------------------------------

@app.post("/teams", response_model=schemas.TeamResponse)
def create_team(
    team: schemas.TeamCreate,
    created_by: int,
    db: Session = Depends(get_db)
):
    """
    Create a new team.
    """
    return crud.create_team(db, team, created_by)


@app.post("/teams/{team_id}/add-member")
def add_member(
    team_id: int,
    user_id: int,
    role: str = "Member",
    db: Session = Depends(get_db)
):
    """
    Add a user to a team.
    """
    crud.add_user_to_team(db, user_id, team_id, role)
    return {"message": "User added to team successfully"}


@app.get("/users/{user_id}/teams", response_model=List[schemas.TeamResponse])
def get_user_teams(user_id: int, db: Session = Depends(get_db)):
    """
    Get all teams of a user.
    """
    return crud.get_user_teams(db, user_id)


# ---------------------------------------------------------
# TASK ROUTES
# ---------------------------------------------------------

@app.post("/tasks", response_model=schemas.TaskResponse)
def create_task(
    task: schemas.TaskCreate,
    created_by: int,
    db: Session = Depends(get_db)
):
    """
    Create and assign a task.
    """
    return crud.create_task(db, task, created_by)


@app.get("/tasks", response_model=List[schemas.TaskResponse])
def get_tasks(
    team_id: int = None,
    assigned_to: int = None,
    status: str = None,
    db: Session = Depends(get_db)
):
    """
    Fetch tasks with optional filters.
    """
    return crud.get_tasks(db, team_id, assigned_to, status)


@app.put("/tasks/{task_id}/status", response_model=schemas.TaskResponse)
def update_task_status(
    task_id: int,
    status_update: schemas.TaskStatusUpdate,
    user_id: int,
    db: Session = Depends(get_db)
):
    """
    Update task status.
    """
    task = crud.update_task_status(db, task_id, status_update, user_id)

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    return task


# ---------------------------------------------------------
# COMMENT ROUTES
# ---------------------------------------------------------

@app.post("/tasks/{task_id}/comments", response_model=schemas.CommentResponse)
def create_comment(
    task_id: int,
    comment: schemas.CommentCreate,
    user_id: int,
    db: Session = Depends(get_db)
):
    """
    Add a comment to a task.
    """
    return crud.create_comment(db, comment, task_id, user_id)


@app.get("/tasks/{task_id}/comments", response_model=List[schemas.CommentResponse])
def get_task_comments(task_id: int, db: Session = Depends(get_db)):
    """
    Get all comments for a task.
    """
    return crud.get_comments_by_task(db, task_id)


# ---------------------------------------------------------
# ACTIVITY LOG ROUTES
# ---------------------------------------------------------

@app.get("/activity", response_model=List[schemas.ActivityLogResponse])
def get_activity_logs(
    user_id: int = None,
    entity_type: str = None,
    entity_id: int = None,
    limit: int = 50,
    db: Session = Depends(get_db)
):
    """
    Get activity logs with optional filters.
    """
    return crud.get_activity_logs(db, user_id, entity_type, entity_id, limit)


# ---------------------------------------------------------
# ROOT CHECK (LAN TEST)
# ---------------------------------------------------------

@app.get("/")
def root():
    return {
        "message": "Team & Task Management App is running on LAN"
    }
