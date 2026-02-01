from sqlalchemy import (
    Column,
    Integer,
    String,
    Text,
    Date,
    DateTime,
    ForeignKey
)
from sqlalchemy.orm import relationship
from datetime import datetime

from database import Base


# ------------------------------------------------------------------
# User Model
# ------------------------------------------------------------------

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    password = Column(String(255), nullable=False)
    role = Column(String(20), default="member")  # admin / member

    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    teams = relationship("TeamMember", back_populates="user")
    tasks = relationship("Task", back_populates="assignee")
    comments = relationship("Comment", back_populates="user")


# ------------------------------------------------------------------
# Team Model
# ------------------------------------------------------------------

class Team(Base):
    __tablename__ = "teams"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    created_by = Column(Integer, ForeignKey("users.id"))

    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    members = relationship("TeamMember", back_populates="team")
    tasks = relationship("Task", back_populates="team")


# ------------------------------------------------------------------
# TeamMember Association Table
# (Many-to-Many: Users <-> Teams)
# ------------------------------------------------------------------

class TeamMember(Base):
    __tablename__ = "team_members"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    team_id = Column(Integer, ForeignKey("teams.id"), nullable=False)

    joined_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="teams")
    team = relationship("Team", back_populates="members")


# ------------------------------------------------------------------
# Task Model
# ------------------------------------------------------------------

class Task(Base):
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(200), nullable=False)
    description = Column(Text)

    status = Column(String(20), default="To Do")      # To Do / In Progress / Completed
    priority = Column(String(20), default="Medium")  # Low / Medium / High

    due_date = Column(Date)

    assigned_to = Column(Integer, ForeignKey("users.id"))
    team_id = Column(Integer, ForeignKey("teams.id"))

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    assignee = relationship("User", back_populates="tasks")
    team = relationship("Team", back_populates="tasks")
    comments = relationship("Comment", back_populates="task")


# ------------------------------------------------------------------
# Comment Model (Basic Collaboration)
# ------------------------------------------------------------------

class Comment(Base):
    __tablename__ = "comments"

    id = Column(Integer, primary_key=True, index=True)
    content = Column(Text, nullable=False)

    task_id = Column(Integer, ForeignKey("tasks.id"))
    user_id = Column(Integer, ForeignKey("users.id"))

    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    task = relationship("Task", back_populates="comments")
    user = relationship("User", back_populates="comments")


# ------------------------------------------------------------------
# Activity Log Model (Basic Activity Tracking)
# ------------------------------------------------------------------

class ActivityLog(Base):
    __tablename__ = "activity_logs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    action = Column(String(100), nullable=False)  # e.g., "Created task", "Updated task status"
    entity_type = Column(String(50), nullable=False)  # e.g., "Task", "Team"
    entity_id = Column(Integer, nullable=False)  # ID of the task/team/etc.

    timestamp = Column(DateTime, default=datetime.utcnow)

    # Relationships
    user = relationship("User")
