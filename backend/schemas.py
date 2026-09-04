from pydantic import BaseModel, EmailStr, Field
from datetime import datetime, date
from typing import Optional, List


# =========================
# 🔹 USER SCHEMAS
# =========================

class UserBase(BaseModel):
    username: str
    role: str = "Member"
    designation: Optional[str] = None


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


class UserDesignationUpdate(BaseModel):
    designation: str


class UserOptionCreate(BaseModel):
    option_type: str
    value: str


class UserOptionUpdate(BaseModel):
    value: str


class UserOptionResponse(BaseModel):
    id: int
    option_type: str
    value: str
    created_by: Optional[int] = None
    created_at: datetime

    class Config:
        from_attributes = True


class HolidayCreate(BaseModel):
    name: str
    holiday_date: date


class HolidayResponse(BaseModel):
    id: int
    name: str
    holiday_date: date
    created_by: Optional[int] = None
    created_at: datetime

    class Config:
        from_attributes = True


class MilestoneCreate(BaseModel):
    name: str
    milestone_date: date
    has_dependency: Optional[bool] = False
    start_dependency_task_id: Optional[int] = None
    start_dependency_event: Optional[str] = None
    finish_dependency_task_id: Optional[int] = None
    finish_dependency_event: Optional[str] = None


class MilestoneResponse(BaseModel):
    id: int
    name: str
    milestone_date: date
    has_dependency: Optional[bool] = False
    start_dependency_task_id: Optional[int] = None
    start_dependency_event: Optional[str] = None
    finish_dependency_task_id: Optional[int] = None
    finish_dependency_event: Optional[str] = None
    created_by: Optional[int] = None
    created_at: datetime

    class Config:
        from_attributes = True


class MilestoneEdit(BaseModel):
    name: Optional[str] = None
    milestone_date: Optional[date] = None
    has_dependency: Optional[bool] = None
    start_dependency_task_id: Optional[int] = None
    start_dependency_event: Optional[str] = None
    finish_dependency_task_id: Optional[int] = None
    finish_dependency_event: Optional[str] = None


class UserUsernameUpdate(BaseModel):
    username: str


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
    designation: Optional[str] = None
    unread_notifications: Optional[int] = 0

    class Config:
        from_attributes = True


class NotificationResponse(BaseModel):
    id: int
    message: str
    is_read: bool = False
    created_at: datetime

    class Config:
        from_attributes = True


class AssistantChatTurn(BaseModel):
    role: str
    content: str


class AssistantChatRequest(BaseModel):
    message: str
    history: Optional[List[AssistantChatTurn]] = None


class AssistantCitation(BaseModel):
    kind: str
    title: str
    meta: Optional[str] = None


class AssistantChatResponse(BaseModel):
    answer: str
    model: str
    used_fallback: bool = False
    citations: List[AssistantCitation] = Field(default_factory=list)


# =========================
# 🔹 TEAM SCHEMAS
# =========================

class TeamBase(BaseModel):
    name: str


class TeamCreate(TeamBase):
    pass


class TeamRename(BaseModel):
    name: str


class TeamResponse(TeamBase):
    id: int
    created_by: int
    activity_id: Optional[int] = None
    created_at: datetime

    class Config:
        from_attributes = True


class UserTeamResponse(TeamBase):
    id: int
    created_by: int
    activity_id: Optional[int] = None
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
# 🔹 DIVISION / GROUP / ACTIVITY SCHEMAS (NEW hierarchy)
# =========================

class DivisionBase(BaseModel):
    name: str


class DivisionCreate(DivisionBase):
    head_user_id: Optional[int] = None


class DivisionRename(BaseModel):
    name: str


class DivisionResponse(DivisionBase):
    id: int
    created_by: int
    head_user_id: Optional[int] = None
    created_at: datetime

    class Config:
        from_attributes = True


class GroupBase(BaseModel):
    name: str


class GroupCreate(GroupBase):
    division_id: int
    head_user_id: Optional[int] = None


class GroupRename(BaseModel):
    name: str


class DivisionHeadAssign(BaseModel):
    user_id: int


class GroupHeadAssign(BaseModel):
    user_id: int


class GroupResponse(GroupBase):
    id: int
    division_id: int
    created_by: int
    head_user_id: Optional[int] = None
    created_at: datetime

    class Config:
        from_attributes = True


class ActivityBase(BaseModel):
    name: str
    # Keep type optional for backward-compat; new hierarchy doesn't require it
    type: Optional[str] = None
    custom_type: Optional[str] = None


class ActivityCreate(ActivityBase):
    # New hierarchy: activity under group
    group_id: Optional[int] = None
    # Backward-compat: activity under team
    team_id: Optional[int] = None


class ActivityRename(BaseModel):
    name: str


class ActivityResponse(ActivityBase):
    id: int
    team_id: Optional[int] = None
    group_id: Optional[int] = None
    created_by: Optional[int] = None
    created_at: datetime

    class Config:
        from_attributes = True


class NavTeamNode(BaseModel):
    id: int
    name: str


class NavActivityNode(BaseModel):
    id: int
    name: str
    type: Optional[str] = None
    teams: List[NavTeamNode] = []


class NavGroupNode(BaseModel):
    id: int
    name: str
    head_user_id: Optional[int] = None
    activities: List[NavActivityNode] = []


class NavDivisionNode(BaseModel):
    id: int
    name: str
    head_user_id: Optional[int] = None
    groups: List[NavGroupNode] = []


# =========================
# 🔹 TASK SCHEMAS
# =========================

class TaskBase(BaseModel):
    title: str
    description: Optional[str] = None
    due_date: Optional[date] = None
    priority: str = "Medium"     # Low / Medium / High
    status: str = "To Do"        # To Do / In Progress / Completed
    task_type: str = "Infrastructure Development"
    custom_type: Optional[str] = None
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
    parent_task_id: Optional[int] = None
    assigned_to: Optional[int] = None  # single assignee (used when assignments not provided)
    lead_person_id: Optional[int] = None
    closure_approver_id: Optional[int] = None
    percent_share: Optional[int] = None
    task_schedule_type: Optional[str] = None
    tentative_start_date: Optional[date] = None
    tentative_completion_date: Optional[date] = None
    tentative_duration_days: Optional[int] = None
    assignment_scope: Optional[str] = None
    has_dependency: Optional[bool] = False
    start_dependency_task_id: Optional[int] = None
    start_dependency_event: Optional[str] = None  # start | finish
    start_dependency_offset_days: Optional[int] = None
    finish_dependency_task_id: Optional[int] = None
    finish_dependency_event: Optional[str] = None  # start | finish
    finish_dependency_offset_days: Optional[int] = None
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


class TaskDetailsEdit(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[str] = None
    due_date: Optional[date] = None
    task_schedule_type: Optional[str] = None
    tentative_start_date: Optional[date] = None
    tentative_completion_date: Optional[date] = None
    tentative_duration_days: Optional[int] = None
    task_type: Optional[str] = None
    custom_type: Optional[str] = None
    has_dependency: Optional[bool] = None
    start_dependency_task_id: Optional[int] = None
    start_dependency_event: Optional[str] = None
    start_dependency_offset_days: Optional[int] = None
    finish_dependency_task_id: Optional[int] = None
    finish_dependency_event: Optional[str] = None
    finish_dependency_offset_days: Optional[int] = None
    assigned_to: Optional[int] = None
    lead_person_id: Optional[int] = None
    percent_share: Optional[int] = None
    assignments: Optional[List[TaskAssignmentCreate]] = None
    parent_task_id: Optional[int] = None
    team_id: Optional[int] = None
    activity_id: Optional[int] = None


class TaskConvertToMilestone(BaseModel):
    name: Optional[str] = None
    milestone_date: Optional[date] = None
    has_dependency: Optional[bool] = None
    start_dependency_task_id: Optional[int] = None
    start_dependency_event: Optional[str] = None
    finish_dependency_task_id: Optional[int] = None
    finish_dependency_event: Optional[str] = None


class MilestoneConvertToTask(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    due_date: Optional[date] = None
    priority: Optional[str] = "Medium"
    status: Optional[str] = "To Do"
    task_type: Optional[str] = "Infrastructure Development"
    custom_type: Optional[str] = None
    team_id: Optional[int] = None
    activity_id: Optional[int] = None
    parent_task_id: Optional[int] = None
    assigned_to: Optional[int] = None
    lead_person_id: Optional[int] = None
    percent_share: Optional[int] = None
    task_schedule_type: Optional[str] = None
    tentative_start_date: Optional[date] = None
    tentative_completion_date: Optional[date] = None
    tentative_duration_days: Optional[int] = None
    has_dependency: Optional[bool] = False
    start_dependency_task_id: Optional[int] = None
    start_dependency_event: Optional[str] = None
    start_dependency_offset_days: Optional[int] = None
    finish_dependency_task_id: Optional[int] = None
    finish_dependency_event: Optional[str] = None
    finish_dependency_offset_days: Optional[int] = None
    assignments: Optional[List[TaskAssignmentCreate]] = None


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
    designation: Optional[str] = None
    percent_share: Optional[int] = None
    is_lead: bool = False


class TaskResponse(TaskBase):
    id: int
    team_id: int
    activity_id: Optional[int] = None
    parent_task_id: Optional[int] = None
    tentative_start_date: Optional[date] = None
    tentative_completion_date: Optional[date] = None
    tentative_duration_days: Optional[int] = None
    has_dependency: Optional[bool] = False
    start_dependency_task_id: Optional[int] = None
    start_dependency_event: Optional[str] = None
    start_dependency_offset_days: Optional[int] = None
    finish_dependency_task_id: Optional[int] = None
    finish_dependency_event: Optional[str] = None
    finish_dependency_offset_days: Optional[int] = None
    dependency_start_locked: Optional[bool] = False
    dependency_finish_locked: Optional[bool] = False
    dependency_lock_active: Optional[bool] = False
    dependency_lock_message: Optional[str] = None
    assigned_to: Optional[int]
    assigned_username: Optional[str]
    assigned_designation: Optional[str] = None
    assignees: Optional[List[TaskAssigneeResponse]] = None  # multiple assignees with share and lead
    assignment_scope_type: Optional[str] = None
    assignment_scope_label: Optional[str] = None
    assignment_member_count: Optional[int] = None
    assignment_team_count: Optional[int] = None
    team_name: Optional[str]
    activity_name: Optional[str] = None
    activity_type: Optional[str] = None
    created_by: int
    created_at: datetime
    updated_at: datetime
    started_at: Optional[datetime] = None
    
    lead_person_id: Optional[int] = None
    lead_person_username: Optional[str] = None
    lead_person_designation: Optional[str] = None
    closure_approver_id: Optional[int] = None
    closure_approver_username: Optional[str] = None
    closure_approver_designation: Optional[str] = None
    is_approved: bool = True

    # Latest extension request summary (if any)
    extension_request_id: Optional[int] = None
    extension_status: Optional[str] = None
    extension_requested_due_date: Optional[date] = None
    extension_requested_by: Optional[int] = None
    extension_requested_by_username: Optional[str] = None
    extension_requested_by_designation: Optional[str] = None
    extension_reason: Optional[str] = None

    # Latest completion request summary (proof + approval)
    completion_request_id: Optional[int] = None
    completion_status: Optional[str] = None
    completion_submitted_by: Optional[int] = None
    completion_submitted_by_username: Optional[str] = None
    completion_submitted_by_designation: Optional[str] = None
    completion_attachment_filename: Optional[str] = None
    completion_attachments: Optional[List["CompletionAttachmentResponse"]] = None  # all proof files in batch
    can_approve_completion: Optional[bool] = None
    can_view_completion_proof: Optional[bool] = None  # submitter, TL/GH/PD, or approver

    # Task type approval (for members creating Procurement tasks)
    type_approval_status: Optional[str] = None   # not_required | pending | approved | rejected
    type_approved_by: Optional[int] = None
    type_approved_at: Optional[datetime] = None
    type_approved_by_username: Optional[str] = None
    type_approved_by_designation: Optional[str] = None
    can_approve_type: Optional[bool] = None

    # Nested subtasks
    subtasks: Optional[List["TaskResponse"]] = None

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


class CompletionAttachmentResponse(BaseModel):
    """Single completion proof file (id + filename) for task list."""
    id: int
    filename: str


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
    designation: Optional[str] = None
    content: str
    created_at: datetime

    class Config:
        from_attributes = True


# =========================
# 🔹 ACTIVITY LOG SCHEMAS
# =========================

class ActivityLogResponse(BaseModel):
    id: int
    user_id: Optional[int] = None  # None for system messages
    username: Optional[str] = None
    designation: Optional[str] = None
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
    designation: Optional[str] = None
    message_type: str  # user / system
    content: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# Resolve forward reference so completion_attachments validates (Pydantic v2)
TaskResponse.model_rebuild()
