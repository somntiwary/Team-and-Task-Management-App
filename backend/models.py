from sqlalchemy import (
    Column,
    Integer,
    String,
    Text,
    Date,
    DateTime,
    ForeignKey,
)
from sqlalchemy.orm import relationship
from datetime import datetime, timezone

from database import Base


# ------------------------------------------------------------------
# User Model
# ------------------------------------------------------------------

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    password = Column(String(255), nullable=False)
    role = Column(String(20), default="member")  # admin / division_head / project_director / group_head / team_lead / member

    created_at = Column(DateTime, default=datetime.now(timezone.utc))

    # Relationships (tasks = tasks assigned to this user; primaryjoin disambiguates from created_by)
    teams = relationship("TeamMember", back_populates="user")
    tasks = relationship(
        "Task",
        back_populates="assignee",
        primaryjoin="User.id == Task.assigned_to",
    )
    comments = relationship("Comment", back_populates="user")


# ------------------------------------------------------------------
# Team Model
# ------------------------------------------------------------------

class Team(Base):
    __tablename__ = "teams"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    created_by = Column(Integer, ForeignKey("users.id"))
    status = Column(String(20), default="approved")  # pending / approved (enterprise: new teams need admin approval)
    only_admins_assign = Column(Integer, default=0)  # 1 = only team admins can assign tasks (enterprise)

    created_at = Column(DateTime, default=datetime.now(timezone.utc))

    # Relationships
    members = relationship("TeamMember", back_populates="team")
    tasks = relationship("Task", back_populates="team")
    invitations = relationship("TeamInvitation", back_populates="team")
    activities = relationship("Activity", back_populates="team")


# ------------------------------------------------------------------
# TeamMember Association Table
# (Many-to-Many: Users <-> Teams)
# ------------------------------------------------------------------

class TeamMember(Base):
    __tablename__ = "team_members"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    team_id = Column(Integer, ForeignKey("teams.id"), nullable=False)
    role = Column(String(20), default="Member")  # Admin / Division Head / Project Director / Group Head / Team Lead / Member

    joined_at = Column(DateTime, default=datetime.now(timezone.utc))

    # Relationships
    user = relationship("User", back_populates="teams")
    team = relationship("Team", back_populates="members")


# ------------------------------------------------------------------
# TeamInvitation (Enterprise: invite instead of direct add)
# ------------------------------------------------------------------

class TeamInvitation(Base):
    __tablename__ = "team_invitations"

    id = Column(Integer, primary_key=True, index=True)
    team_id = Column(Integer, ForeignKey("teams.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    invited_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    role = Column(String(20), default="Member")
    status = Column(String(20), default="pending")  # pending / accepted / declined

    created_at = Column(DateTime, default=datetime.now(timezone.utc))

    team = relationship("Team", back_populates="invitations")
    user = relationship("User", foreign_keys=[user_id])
    inviter = relationship("User", foreign_keys=[invited_by])


# ------------------------------------------------------------------
# Activity Model (Division / Project under Team)
# ------------------------------------------------------------------

class Activity(Base):
    __tablename__ = "activities"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False)
    # "Division" or "Project" (you can extend later if needed)
    type = Column(String(20), nullable=False)

    team_id = Column(Integer, ForeignKey("teams.id"), nullable=False)

    created_at = Column(DateTime, default=datetime.now(timezone.utc))

    # Relationships
    team = relationship("Team", back_populates="activities")
    tasks = relationship("Task", back_populates="activity")
    messages = relationship("ActivityMessage", back_populates="activity")


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
    # Backward-compat: keep team_id, but primary hierarchy is via activity_id.
    # activity_id -> activities.team_id -> teams.id
    team_id = Column(Integer, ForeignKey("teams.id"))
    activity_id = Column(Integer, ForeignKey("activities.id"), nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)

    # New fields for Role Enhancement
    lead_person_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    percent_share = Column(Integer, nullable=True)  # e.g. 50 for 50%
    closure_approver_id = Column(Integer, ForeignKey("users.id"), nullable=True) # If set, this person must approve closure
    is_approved = Column(Integer, default=1) # 1 = approved, 0 = pending approval (for tasks created by Members)

    # Task type: Normal / Technical / Procurement. Members need approval for Technical/Procurement.
    task_type = Column(String(20), default="Normal")
    type_approval_status = Column(String(20), default="not_required")  # not_required | pending | approved | rejected
    type_approved_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    type_approved_at = Column(DateTime, nullable=True)
    # Procurement-only: current stage in the procurement process (optional)
    procurement_stage = Column(String(100), nullable=True)

    created_at = Column(DateTime, default=datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=datetime.now(timezone.utc), onupdate=datetime.now(timezone.utc))

    # Relationships
    assignee = relationship("User", back_populates="tasks", foreign_keys=[assigned_to])
    team = relationship("Team", back_populates="tasks")
    activity = relationship("Activity", back_populates="tasks")
    comments = relationship("Comment", back_populates="task")
    creator = relationship("User", foreign_keys=[created_by])
    lead_person = relationship("User", foreign_keys=[lead_person_id])
    closure_approver = relationship("User", foreign_keys=[closure_approver_id])
    type_approver = relationship("User", foreign_keys=[type_approved_by])
    completion_requests = relationship("TaskCompletionRequest", back_populates="task")
    assignments = relationship("TaskAssignment", back_populates="task", cascade="all, delete-orphan")


# ------------------------------------------------------------------
# TaskAssignment Model (multiple assignees per task with optional share % and lead)
# ------------------------------------------------------------------

class TaskAssignment(Base):
    __tablename__ = "task_assignments"

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    percent_share = Column(Integer, nullable=True)  # 0-100, optional
    is_lead = Column(Integer, default=0)  # 0/1 for SQLite

    task = relationship("Task", back_populates="assignments")
    user = relationship("User", foreign_keys=[user_id])


# ------------------------------------------------------------------
# TaskCompletionRequest Model (proof + approval for Completed status)
# ------------------------------------------------------------------


class TaskCompletionRequest(Base):
    __tablename__ = "task_completion_requests"

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    submitted_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    previous_status = Column(String(20), nullable=False)  # status before requesting completion
    attachment_path = Column(String(500), nullable=False)  # path to uploaded file
    attachment_filename = Column(String(255), nullable=True)  # original filename for display
    status = Column(String(20), default="pending")  # pending / approved / rejected
    created_at = Column(DateTime, default=datetime.now(timezone.utc))
    decided_at = Column(DateTime, nullable=True)
    decided_by = Column(Integer, ForeignKey("users.id"), nullable=True)

    task = relationship("Task", back_populates="completion_requests")
    submitter = relationship("User", foreign_keys=[submitted_by])
    decider = relationship("User", foreign_keys=[decided_by])


# ------------------------------------------------------------------
# TaskExtensionRequest Model
# ------------------------------------------------------------------


class TaskExtensionRequest(Base):
    __tablename__ = "task_extension_requests"

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    requested_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    requested_to = Column(Integer, ForeignKey("users.id"), nullable=True)
    reason = Column(Text, nullable=False)
    requested_due_date = Column(Date, nullable=False)
    status = Column(String(20), default="pending")  # pending / approved / rejected
    created_at = Column(DateTime, default=datetime.now(timezone.utc))
    decided_at = Column(DateTime, nullable=True)
    decided_by = Column(Integer, ForeignKey("users.id"), nullable=True)


# ------------------------------------------------------------------
# Comment Model (Basic Collaboration)
# ------------------------------------------------------------------

class Comment(Base):
    __tablename__ = "comments"

    id = Column(Integer, primary_key=True, index=True)
    content = Column(Text, nullable=False)

    task_id = Column(Integer, ForeignKey("tasks.id"))
    user_id = Column(Integer, ForeignKey("users.id"))

    created_at = Column(DateTime, default=datetime.now(timezone.utc))

    # Relationships
    task = relationship("Task", back_populates="comments")
    user = relationship("User", back_populates="comments")


# ------------------------------------------------------------------
# ActivityMessage Model (Activity-level communication stream)
# ------------------------------------------------------------------

class ActivityMessage(Base):
    __tablename__ = "activity_messages"

    id = Column(Integer, primary_key=True, index=True)
    activity_id = Column(Integer, ForeignKey("activities.id"), nullable=False, index=True)

    # user_id is NULL for system-generated messages
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    message_type = Column(String(20), default="user")  # user / system

    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=datetime.now(timezone.utc), onupdate=datetime.now(timezone.utc))

    activity = relationship("Activity", back_populates="messages")
    user = relationship("User")


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

    timestamp = Column(DateTime, default=datetime.now(timezone.utc))

    # Relationships
    user = relationship("User")
