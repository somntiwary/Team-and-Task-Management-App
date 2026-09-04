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


def utc_now():
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------
# Division / Group hierarchy (NEW)
# Division -> Group -> Activity -> Team -> Task -> SubTask (Task.parent_task_id)
# ------------------------------------------------------------------

class Division(Base):
    __tablename__ = "divisions"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False, index=True)

    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    head_user_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    created_at = Column(DateTime, default=utc_now)

    head = relationship("User", foreign_keys=[head_user_id])
    creator = relationship("User", foreign_keys=[created_by])
    groups = relationship("Group", back_populates="division")


class Group(Base):
    __tablename__ = "groups"

    id = Column(Integer, primary_key=True, index=True)
    division_id = Column(Integer, ForeignKey("divisions.id"), nullable=False, index=True)
    name = Column(String(200), nullable=False, index=True)

    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    head_user_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    created_at = Column(DateTime, default=utc_now)

    division = relationship("Division", back_populates="groups")
    head = relationship("User", foreign_keys=[head_user_id])
    creator = relationship("User", foreign_keys=[created_by])
    activities = relationship("Activity", back_populates="group")


# ------------------------------------------------------------------
# User Model
# ------------------------------------------------------------------

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    password = Column(String(255), nullable=False)
    role = Column(String(20), default="member")  # admin / division_head / project_director / group_head / team_lead / member
    designation = Column(String(100), nullable=True)

    created_at = Column(DateTime, default=utc_now)

    # Relationships (tasks = tasks assigned to this user; primaryjoin disambiguates from created_by)
    teams = relationship("TeamMember", back_populates="user")
    tasks = relationship(
        "Task",
        back_populates="assignee",
        primaryjoin="User.id == Task.assigned_to",
    )
    comments = relationship("Comment", back_populates="user")
    notifications = relationship("Notification", back_populates="user")


class UserOption(Base):
    __tablename__ = "user_options"

    id = Column(Integer, primary_key=True, index=True)
    option_type = Column(String(30), nullable=False, index=True)
    value = Column(String(100), nullable=False, unique=True, index=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=utc_now)

    creator = relationship("User", foreign_keys=[created_by])


class Holiday(Base):
    __tablename__ = "holidays"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False)
    holiday_date = Column(Date, nullable=False, unique=True, index=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=utc_now)

    creator = relationship("User", foreign_keys=[created_by])


class Milestone(Base):
    __tablename__ = "milestones"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False)
    milestone_date = Column(Date, nullable=False, index=True)
    has_dependency = Column(Integer, default=0)
    start_dependency_task_id = Column(Integer, ForeignKey("tasks.id"), nullable=True, index=True)
    start_dependency_event = Column(String(20), nullable=True)
    finish_dependency_task_id = Column(Integer, ForeignKey("tasks.id"), nullable=True, index=True)
    finish_dependency_event = Column(String(20), nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=utc_now)

    creator = relationship("User", foreign_keys=[created_by])
    start_dependency_task = relationship("Task", foreign_keys=[start_dependency_task_id])
    finish_dependency_task = relationship("Task", foreign_keys=[finish_dependency_task_id])


# ------------------------------------------------------------------
# Team Model
# ------------------------------------------------------------------

class Team(Base):
    __tablename__ = "teams"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    created_by = Column(Integer, ForeignKey("users.id"))
    # New hierarchy: team is under an Activity
    activity_id = Column(Integer, ForeignKey("activities.id"), nullable=True, index=True)
    status = Column(String(20), default="approved")  # pending / approved (enterprise: new teams need admin approval)
    only_admins_assign = Column(Integer, default=0)  # 1 = only team admins can assign tasks (enterprise)

    created_at = Column(DateTime, default=utc_now)

    # Relationships
    members = relationship("TeamMember", back_populates="team")
    tasks = relationship("Task", back_populates="team")
    invitations = relationship("TeamInvitation", back_populates="team")
    # Back-compat: keep Team.activities for older UI that lists activities under team.
    # New model: Team belongs to Activity; the Activity -> teams direction is the primary one.
    activities = relationship("Activity", back_populates="team", foreign_keys="Activity.team_id")
    activity = relationship("Activity", foreign_keys=[activity_id], back_populates="teams")


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

    joined_at = Column(DateTime, default=utc_now)

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

    created_at = Column(DateTime, default=utc_now)

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
    # Back-compat: previously Activity was under Team, and had a type ("Division" | "Project")
    type = Column(String(100), nullable=True)
    team_id = Column(Integer, ForeignKey("teams.id"), nullable=True)
    # New hierarchy: Activity is under Group
    group_id = Column(Integer, ForeignKey("groups.id"), nullable=True, index=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)

    created_at = Column(DateTime, default=utc_now)

    # Relationships
    # Back-compat relationship (old)
    team = relationship("Team", back_populates="activities", foreign_keys=[team_id])
    # New relationship (primary)
    group = relationship("Group", back_populates="activities", foreign_keys=[group_id])
    creator = relationship("User", foreign_keys=[created_by])
    teams = relationship("Team", back_populates="activity", foreign_keys="Team.activity_id")
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
    tentative_start_date = Column(Date, nullable=True)
    tentative_completion_date = Column(Date, nullable=True)
    tentative_duration_days = Column(Integer, nullable=True)
    task_schedule_type = Column(String(20), default="Time Bound")

    assigned_to = Column(Integer, ForeignKey("users.id"))
    # Backward-compat: keep team_id, but primary hierarchy is via activity_id.
    # activity_id -> activities.team_id -> teams.id
    team_id = Column(Integer, ForeignKey("teams.id"))
    activity_id = Column(Integer, ForeignKey("activities.id"), nullable=True)
    # Subtasks: a Task can have children tasks (created by members)
    parent_task_id = Column(Integer, ForeignKey("tasks.id"), nullable=True, index=True)
    has_dependency = Column(Integer, default=0)
    start_dependency_task_id = Column(Integer, ForeignKey("tasks.id"), nullable=True, index=True)
    start_dependency_event = Column(String(20), nullable=True)   # start | finish
    start_dependency_offset_days = Column(Integer, nullable=True)
    finish_dependency_task_id = Column(Integer, ForeignKey("tasks.id"), nullable=True, index=True)
    finish_dependency_event = Column(String(20), nullable=True)  # start | finish
    finish_dependency_offset_days = Column(Integer, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)

    # New fields for Role Enhancement
    lead_person_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    percent_share = Column(Integer, nullable=True)  # e.g. 50 for 50%
    closure_approver_id = Column(Integer, ForeignKey("users.id"), nullable=True) # If set, this person must approve closure
    is_approved = Column(Integer, default=1) # 1 = approved, 0 = pending approval (for tasks created by Members)

    # Task type catalog. Procurement still participates in the approval/stage workflow.
    task_type = Column(String(100), default="Infrastructure Development")
    type_approval_status = Column(String(20), default="not_required")  # not_required | pending | approved | rejected
    type_approved_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    type_approved_at = Column(DateTime, nullable=True)
    # Procurement-only: current stage in the procurement process (optional)
    procurement_stage = Column(String(100), nullable=True)

    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
    started_at = Column(DateTime, nullable=True)

    # Relationships
    assignee = relationship("User", back_populates="tasks", foreign_keys=[assigned_to])
    team = relationship("Team", back_populates="tasks")
    activity = relationship("Activity", back_populates="tasks")
    parent_task = relationship("Task", remote_side=[id], foreign_keys=[parent_task_id], back_populates="subtasks")
    subtasks = relationship("Task", back_populates="parent_task", foreign_keys=[parent_task_id])
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
    batch_id = Column(String(64), nullable=True, index=True)  # groups multiple files in one submission
    status = Column(String(20), default="pending")  # pending / approved / rejected
    created_at = Column(DateTime, default=utc_now)
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
    created_at = Column(DateTime, default=utc_now)
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

    created_at = Column(DateTime, default=utc_now)

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
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

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

    timestamp = Column(DateTime, default=utc_now)

    # Relationships
    user = relationship("User")


# ------------------------------------------------------------------
# Notification Model
# ------------------------------------------------------------------

class Notification(Base):
    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    message = Column(Text, nullable=False)
    is_read = Column(Integer, default=0)
    created_at = Column(DateTime, default=utc_now)

    user = relationship("User", back_populates="notifications")
