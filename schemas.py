from pydantic import BaseModel, EmailStr
from datetime import datetime, date
from typing import Optional, List


# =========================
# 🔹 USER SCHEMAS
# =========================

class UserBase(BaseModel):
    username: str
    role: str = "Member"


class UserCreate(UserBase):
    password: str


class UserLogin(BaseModel):
    username: str
    password: str


class UserResponse(UserBase):
    id: int
    created_at: datetime

    class Config:
        from_attributes = True


# =========================
# 🔹 TEAM SCHEMAS
# =========================

class TeamBase(BaseModel):
    name: str


class TeamCreate(TeamBase):
    pass


class TeamResponse(TeamBase):
    id: int
    created_by: int
    created_at: datetime

    class Config:
        from_attributes = True


# =========================
# 🔹 TEAM MEMBER SCHEMAS
# =========================

class TeamMemberAdd(BaseModel):
    user_id: int
    role: str = "member"   # admin / member


class TeamMemberResponse(BaseModel):
    id: int
    user_id: int
    team_id: int
    role: str
    joined_at: datetime

    class Config:
        orm_mode = True


# =========================
# 🔹 TASK SCHEMAS
# =========================

class TaskBase(BaseModel):
    title: str
    description: Optional[str] = None
    due_date: Optional[date] = None
    priority: str = "Medium"     # Low / Medium / High
    status: str = "To Do"        # To Do / In Progress / Completed


class TaskCreate(TaskBase):
    team_id: int
    assigned_to: Optional[int] = None


class TaskStatusUpdate(BaseModel):
    status: str


class TaskUpdate(BaseModel):
    title: Optional[str]
    description: Optional[str]
    due_date: Optional[date]
    priority: Optional[str]
    status: Optional[str]
    assigned_to: Optional[int]


class TaskResponse(TaskBase):
    id: int
    team_id: int
    assigned_to: Optional[int]
    created_by: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# =========================
# 🔹 COMMENT SCHEMAS
# =========================

class CommentCreate(BaseModel):
    content: str


class CommentResponse(BaseModel):
    id: int
    task_id: int
    user_id: int
    content: str
    created_at: datetime

    class Config:
        from_attributes = True


# =========================
# 🔹 ACTIVITY LOG SCHEMAS
# =========================

class ActivityLogResponse(BaseModel):
    id: int
    user_id: int
    action: str
    entity_type: str
    entity_id: int
    timestamp: datetime

    class Config:
        from_attributes = True
