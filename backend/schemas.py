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


class UsernameReset(BaseModel):
    """Public endpoint payload to reset a forgotten username."""
    user_id: int
    current_password: str
    new_username: str


class PasswordReset(BaseModel):
    """Public endpoint payload to reset a forgotten password."""
    user_id: int
    username: str
    new_password: str


class UserRoleUpdate(BaseModel):
    role: str
class UserResponse(UserBase):
    id: int
    created_at: datetime

    class Config:
        from_attributes = True


class UserListResponse(BaseModel):
    """Lightweight user for dropdowns (id, username)."""
    id: int
    username: str
    role: str = "Member"

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


class UserTeamResponse(TeamBase):
    id: int
    created_by: int
    created_at: datetime
    user_role: str  # The user's role in this team

    class Config:
        from_attributes = True


# =========================
# 🔹 TEAM MEMBER SCHEMAS
# =========================

class TeamMemberAdd(BaseModel):
    user_id: int
    role: str = "member"   # admin / division_head / project_director / group_head / team_lead / member


class TeamMemberResponse(BaseModel):
    id: int
    user_id: int
    team_id: int
    role: str
    joined_at: datetime

    class Config:
        from_attributes = True


# =========================
# 🔹 ACTIVITY SCHEMAS (Division / Project under Team)
# =========================

class ActivityBase(BaseModel):
    name: str
    type: str  # "Division" or "Project"


class ActivityCreate(ActivityBase):
    team_id: int


class ActivityResponse(ActivityBase):
    id: int
    team_id: int
    created_at: datetime

    class Config:
        from_attributes = True


# =========================
# 🔹 TASK SCHEMAS
# =========================

class TaskBase(BaseModel):
    title: str
    description: Optional[str] = None
    due_date: Optional[date] = None
    priority: str = "Medium"     # Low / Medium / High
    status: str = "To Do"        # To Do / In Progress / Completed
    task_type: str = "Normal"    # Normal | Technical | Procurement
    percent_share: Optional[int] = None
    is_approved: Optional[bool] = True # For responses, showing if it is active
    # For Procurement tasks only – current stage in procurement lifecycle
    procurement_stage: Optional[str] = None


class TaskAssignmentCreate(BaseModel):
    user_id: int
    percent_share: Optional[int] = None  # 0-100
    is_lead: Optional[bool] = False


class TaskCreate(TaskBase):
    # New hierarchy: tasks belong to an activity.
    # For backward-compatibility, keep team_id but prefer activity_id.
    team_id: Optional[int] = None
    activity_id: Optional[int] = None
    assigned_to: Optional[int] = None  # single assignee (used when assignments not provided)
    lead_person_id: Optional[int] = None
    closure_approver_id: Optional[int] = None
    percent_share: Optional[int] = None
    # Multiple assignees with optional share % and lead (for Admin, Division Head, Group Head, Team Lead, Project Director)
    assignments: Optional[List[TaskAssignmentCreate]] = None


class TaskStatusUpdate(BaseModel):
    status: str


class TaskAssignUpdate(BaseModel):
    assigned_to: Optional[int] = None


class TaskProcurementStageUpdate(BaseModel):
    procurement_stage: Optional[str] = None


class TaskDueDateUpdate(BaseModel):
    due_date: Optional[date] = None


class TaskUpdate(BaseModel):
    title: Optional[str]
    description: Optional[str]
    due_date: Optional[date]
    priority: Optional[str]
    status: Optional[str]
    assigned_to: Optional[int]


class TaskAssigneeResponse(BaseModel):
    user_id: int
    username: Optional[str] = None
    percent_share: Optional[int] = None
    is_lead: bool = False


class TaskResponse(TaskBase):
    id: int
    team_id: int
    activity_id: Optional[int] = None
    assigned_to: Optional[int]
    assigned_username: Optional[str]
    assignees: Optional[List[TaskAssigneeResponse]] = None  # multiple assignees with share and lead
    team_name: Optional[str]
    activity_name: Optional[str] = None
    activity_type: Optional[str] = None
    created_by: int
    created_at: datetime
    updated_at: datetime
    
    lead_person_id: Optional[int] = None
    lead_person_username: Optional[str] = None
    closure_approver_id: Optional[int] = None
    closure_approver_username: Optional[str] = None
    is_approved: bool = True

    # Latest extension request summary (if any)
    extension_request_id: Optional[int] = None
    extension_status: Optional[str] = None
    extension_requested_due_date: Optional[date] = None
    extension_requested_by: Optional[int] = None
    extension_requested_by_username: Optional[str] = None
    extension_reason: Optional[str] = None

    # Latest completion request summary (proof + approval)
    completion_request_id: Optional[int] = None
    completion_status: Optional[str] = None
    completion_submitted_by: Optional[int] = None
    completion_submitted_by_username: Optional[str] = None
    completion_attachment_filename: Optional[str] = None
    can_approve_completion: Optional[bool] = None

    # Task type approval (for members creating Technical/Procurement)
    type_approval_status: Optional[str] = None   # not_required | pending | approved | rejected
    type_approved_by: Optional[int] = None
    type_approved_at: Optional[datetime] = None
    type_approved_by_username: Optional[str] = None
    can_approve_type: Optional[bool] = None

    class Config:
        from_attributes = True


class TaskTypeApprovalUpdate(BaseModel):
    approved: bool
    reason: Optional[str] = None


# =========================
# 🔹 TASK EXTENSION REQUEST SCHEMAS
# =========================


class TaskExtensionRequestCreate(BaseModel):
    requested_due_date: date
    reason: str


class TaskExtensionRequestDecision(BaseModel):
    status: str  # "approved" or "rejected"
    # Optional override if Head/Admin wants a different final date
    new_due_date: Optional[date] = None


# =========================
# 🔹 TASK COMPLETION REQUEST SCHEMAS
# =========================


class TaskCompletionRequestDecision(BaseModel):
    status: str  # "approved" or "rejected"


# =========================
# 🔹 COMMENT SCHEMAS
# =========================

class CommentCreate(BaseModel):
    content: str


class CommentResponse(BaseModel):
    id: int
    task_id: int
    user_id: int
    username: Optional[str] = None
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
    username: Optional[str] = None
    action: str
    entity_type: str
    entity_id: int
    timestamp: datetime

    class Config:
        from_attributes = True


# =========================
# 🔹 ACTIVITY CHAT (Activity Messages)
# =========================

class ActivityMessageCreate(BaseModel):
    content: str


class ActivityMessageUpdate(BaseModel):
    content: str


class ActivityMessageResponse(BaseModel):
    id: int
    activity_id: int
    user_id: Optional[int] = None
    username: Optional[str] = None
    message_type: str  # user / system
    content: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
