from typing import Optional
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import and_
from datetime import datetime, timezone, date
from fastapi import HTTPException, status

from models import (
    User,
    Team,
    TeamMember,
    TeamInvitation,
    Task,
    TaskAssignment,
    Comment,
    ActivityLog,
    Activity,
    ActivityMessage,
    TaskExtensionRequest,
    TaskCompletionRequest,
)
from schemas import (
    UserCreate,
    TeamCreate,
    TaskCreate,
    TaskStatusUpdate,
    TaskProcurementStageUpdate,
    CommentCreate,
    ActivityCreate,
    ActivityMessageCreate,
    ActivityMessageUpdate,
    TaskExtensionRequestCreate,
    TaskExtensionRequestDecision,
    TaskCompletionRequestDecision,
)
import auth
import logging

# Configure logging
logger = logging.getLogger(__name__)

# ------------------------------------------------------------------
# USER CRUD OPERATIONS
# ------------------------------------------------------------------

def create_user(db: Session, user: UserCreate):
    """
    Create a new user with hashed password.
    Role is normalized to lowercase. Username must not equal password.
    """
    # Prevent username equal to password (avoids confusion and weak accounts)
    if (user.username or "").strip().lower() == (user.password or "").strip().lower():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username must not be the same as password"
        )
    # Normalize role to lowercase for consistent permission checks
    role_normalized = (user.role or "member").lower()
    valid_global_roles = ("admin", "member", "division head", "project director", "group head", "team lead")
    if role_normalized not in valid_global_roles:
        role_normalized = "member"

    hashed_password = auth.hash_password(user.password)

    db_user = User(
        username=user.username.strip(),
        password=hashed_password,
        role=role_normalized
    )
    db.add(db_user)
    db.commit()
    db.refresh(db_user)
    
    logger.info(f"User created: {user.username} (ID: {db_user.id})")
    return db_user


def get_user_by_username(db: Session, username: str):
    """
    Fetch user by username.
    Used for login & validation.
    """
    return db.query(User).filter(User.username == username).first()


def get_user_by_id(db: Session, user_id: int):
    """
    Fetch user by ID.
    """
    return db.query(User).filter(User.id == user_id).first()


def get_all_users(db: Session):
    """
    List all users (id, username, role) for dropdowns and management. Excludes password.
    """
    users = db.query(User.id, User.username, User.role).order_by(User.username).all()
    return [{"id": u.id, "username": u.username, "role": u.role} for u in users]


def get_team_members(db: Session, team_id: int):
    """
    List team members with id, username, role. For assignee dropdown etc.
    """
    rows = (
        db.query(User.id, User.username, TeamMember.role, User.role)
        .join(TeamMember, User.id == TeamMember.user_id)
        .filter(TeamMember.team_id == team_id)
        .order_by(User.username)
        .all()
    )
    return [{"id": r[0], "username": r[1], "role": r[2], "global_role": r[3]} for r in rows]


def update_user_role(db: Session, user_id: int, new_role: str):
    """
    Update a user's global role.
    """
    user = get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    valid_global_roles = ("admin", "member", "division head")
    if new_role.lower() not in valid_global_roles:
        raise HTTPException(status_code=400, detail="Invalid role")
        
    user.role = new_role.lower()
    db.commit()
    db.refresh(user)
    return user


# ------------------------------------------------------------------
# TEAM CRUD OPERATIONS
# ------------------------------------------------------------------

def create_team(db: Session, team: TeamCreate, created_by: int, is_global_admin: bool = False):
    """
    Create a new team.
    Creator is automatically added as team Admin.
    If creator is global admin, team is created as approved so it shows immediately.
    """
    creator = get_user_by_id(db, created_by)
    if not creator:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User with ID {created_by} not found"
        )

    # Global admins get teams approved immediately; others go to pending (if you use approval workflow)
    status_val = "approved" if is_global_admin else "pending"

    db_team = Team(
        name=team.name,
        created_by=created_by,
        status=status_val
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

    logger.info(f"Team created: {team.name} (ID: {db_team.id}) by user {created_by}")
    return db_team


def get_team_by_id(db: Session, team_id: int):
    """
    Fetch team by ID.
    """
    return db.query(Team).filter(Team.id == team_id).first()


# ------------------------------------------------------------------
# ACTIVITY CRUD OPERATIONS
# ------------------------------------------------------------------

def create_activity(db: Session, activity: ActivityCreate, created_by: int):
    """
    Create an Activity (Division / Project) under a Team.
    """
    team = get_team_by_id(db, activity.team_id)
    if not team:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Team with ID {activity.team_id} not found"
        )

    # Ensure creator is a member of the team OR global admin
    creator = get_user_by_id(db, created_by)
    allowed_globals = ["admin", "division head"]
    is_global = creator and (creator.role or "").lower() in allowed_globals
    
    if not is_global and not is_user_in_team(db, created_by, activity.team_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You must be a member of the team to create activities"
        )

    # Validate type (Division / Project)
    valid_types = ["Division", "Project"]
    if activity.type not in valid_types:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid activity type. Must be one of: {', '.join(valid_types)}"
        )

    db_activity = Activity(
        name=activity.name,
        type=activity.type,
        team_id=activity.team_id,
    )
    db.add(db_activity)
    db.commit()
    db.refresh(db_activity)

    # System message in this activity's chat
    try:
        creator = get_user_by_id(db, created_by)
        creator_name = creator.username if creator else f"User {created_by}"
        name_safe = (db_activity.name or "Untitled").replace('"', "'")
        create_activity_message_system(
            db, db_activity.id,
            f'Activity "{name_safe}" was created by {creator_name}.',
        )
    except Exception:
        pass

    logger.info(f"Activity created: {activity.name} (ID: {db_activity.id}) under team {activity.team_id} by user {created_by}")
    return db_activity


def get_activity_by_id(db: Session, activity_id: int):
    return db.query(Activity).filter(Activity.id == activity_id).first()


def get_activities_for_team(db: Session, team_id: int):
    """
    List Activities (Division / Project) for a team.
    """
    return db.query(Activity).filter(Activity.team_id == team_id).order_by(Activity.name).all()


def add_user_to_team(db: Session, user_id: int, team_id: int, role: str = "Member"):
    """
    Add a user to a team with validation.
    """
    # Validate user exists
    user = get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User with ID {user_id} not found"
        )
    
    # Validate team exists
    team = get_team_by_id(db, team_id)
    if not team:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Team with ID {team_id} not found"
        )
    
    # Check if user is already a member
    existing_membership = db.query(TeamMember).filter(
        and_(TeamMember.user_id == user_id, TeamMember.team_id == team_id)
    ).first()
    
    if existing_membership:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"User is already a member of this team"
        )
    
    # Validate role
    valid_roles = ["Admin", "Member", "Division Head", "Project Director", "Group Head", "Team Lead"]
    if role not in valid_roles:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid role. Must be one of: {', '.join(valid_roles)}"
        )
    
    membership = TeamMember(
        user_id=user_id,
        team_id=team_id,
        role=role
    )
    db.add(membership)
    db.commit()
    
    logger.info(f"User {user_id} added to team {team_id} as {role}")
    return membership


def get_user_teams(db: Session, user_id: int, approved_only: bool = True):
    """
    Get all teams a user belongs to with their role in each team.
    By default returns only approved teams (enterprise: hide pending until approved).
    """
    # Check if user is global Admin/Division Head
    user = get_user_by_id(db, user_id)
    is_global_admin = user and (user.role or "").lower() in ("admin", "division head")

    if is_global_admin:
        # Return all approved teams with "Admin" role simulation for UI consistency
        query = db.query(Team).filter(Team.status == "approved")
        all_teams = query.all()
        result = []
        for team in all_teams:
            result.append({
                "id": team.id,
                "name": team.name,
                "created_by": team.created_by,
                "created_at": team.created_at,
                "user_role": "Admin" # Simulate Admin role for full access
            })
        return result

    query = (
        db.query(Team, TeamMember.role)
        .join(TeamMember)
        .filter(TeamMember.user_id == user_id)
    )
    if approved_only:
        query = query.filter(Team.status == "approved")
    teams_with_roles = query.all()
    
    # Convert to dict format for API response
    result = []
    for team, role in teams_with_roles:
        team_dict = {
            "id": team.id,
            "name": team.name,
            "created_by": team.created_by,
            "created_at": team.created_at,
            "user_role": role
        }
        result.append(team_dict)
    
    return result


def is_user_in_team(db: Session, user_id: int, team_id: int) -> bool:
    """
    Check if a user is a member of a team.
    """
    membership = db.query(TeamMember).filter(
        and_(TeamMember.user_id == user_id, TeamMember.team_id == team_id)
    ).first()
    return membership is not None


def get_user_role_in_team(db: Session, user_id: int, team_id: int) -> str:
    """
    Get user's role in a team.
    Returns None if user is not in the team.
    """
    membership = db.query(TeamMember).filter(
        and_(TeamMember.user_id == user_id, TeamMember.team_id == team_id)
    ).first()
    return membership.role if membership else None


def is_user_team_admin(db: Session, user_id: int, team_id: int) -> bool:
    """
    Check if a user is an admin of a team.
    """
    role = get_user_role_in_team(db, user_id, team_id)
    return role == "Admin"


def get_pending_teams(db: Session):
    """Teams awaiting admin approval (enterprise)."""
    return db.query(Team).filter(Team.status == "pending").all()


def approve_team(db: Session, team_id: int):
    """Set team status to approved. Returns team or None."""
    team = get_team_by_id(db, team_id)
    if not team:
        return None
    team.status = "approved"
    db.commit()
    db.refresh(team)
    return team


def create_invitation(db: Session, team_id: int, user_id: int, invited_by: int, role: str = "Member"):
    """Create a team invitation (enterprise: invite instead of direct add)."""
    if get_user_by_id(db, user_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    team = get_team_by_id(db, team_id)
    if not team:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Team not found")
    existing = db.query(TeamInvitation).filter(
        TeamInvitation.team_id == team_id,
        TeamInvitation.user_id == user_id,
        TeamInvitation.status == "pending"
    ).first()
    if existing:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invitation already pending")
    if is_user_in_team(db, user_id, team_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="User is already a member")
        
    # Validate role
    valid_roles = ["Admin", "Member", "Division Head", "Project Director", "Group Head", "Team Lead"]
    if role not in valid_roles:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid role. Must be one of: {', '.join(valid_roles)}"
        )
        
    inv = TeamInvitation(team_id=team_id, user_id=user_id, invited_by=invited_by, role=role, status="pending")
    db.add(inv)
    db.commit()
    db.refresh(inv)
    return inv


def get_invitations_for_user(db: Session, user_id: int):
    """Pending invitations for a user (id, team_id, team_name, invited_by_username, role)."""
    rows = (
        db.query(TeamInvitation, Team.name, User.username)
        .join(Team, TeamInvitation.team_id == Team.id)
        .join(User, TeamInvitation.invited_by == User.id)
        .filter(TeamInvitation.user_id == user_id, TeamInvitation.status == "pending")
        .all()
    )
    return [
        {"id": inv.id, "team_id": inv.team_id, "team_name": name, "invited_by_username": uname, "role": inv.role}
        for inv, name, uname in rows
    ]


def accept_invitation(db: Session, invitation_id: int, user_id: int):
    """Accept invitation and add user to team. Returns membership."""
    inv = db.query(TeamInvitation).filter(TeamInvitation.id == invitation_id).first()
    if not inv:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invitation not found")
    if inv.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your invitation")
    if inv.status != "pending":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invitation already handled")
    inv.status = "accepted"
    db.commit()
    add_user_to_team(db, inv.user_id, inv.team_id, inv.role)
    return {"message": "Invitation accepted", "team_id": inv.team_id}


# ------------------------------------------------------------------
# TASK CRUD OPERATIONS
# ------------------------------------------------------------------

def create_task(db: Session, task: TaskCreate, created_by: int):
    """
    Create a task and assign it to a user with validation.
    Handles role-based logic:
    - Members: Task is pending approval (is_approved=False).
    - Team Lead: Can set closure control.
    """
    # Validate creator exists
    creator = get_user_by_id(db, created_by)
    if not creator:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Creator with ID {created_by} not found"
        )
    
    # Check Role for Approval Logic
    creator_role = (creator.role or "member").lower()

    # Admin, Division Head, Project Director, Group Head, Team Lead -> Approved immediately
    # Member -> Pending Approval
    is_approved_val = True
    if creator_role == "member":
        is_approved_val = False

    # Task type: Normal | Technical | Procurement
    task_type_val = (getattr(task, "task_type", None) or "Normal").strip()
    if task_type_val not in ("Normal", "Technical", "Procurement"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="task_type must be one of: Normal, Technical, Procurement",
        )
    
    # Decide team/activity based on new hierarchy while staying backward compatible.
    activity = None
    team = None

    if task.activity_id is not None:
        # Preferred: activity-driven tasks
        activity = get_activity_by_id(db, task.activity_id)
        if not activity:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Activity with ID {task.activity_id} not found"
            )
        team = get_team_by_id(db, activity.team_id)
    elif task.team_id is not None:
        # Backward-compat mode: tasks created directly under a team.
        team = get_team_by_id(db, task.team_id)
        if not team:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Team with ID {task.team_id} not found"
            )
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Either activity_id or team_id must be provided to create a task"
        )
    
    # Validate creator is a member of the team OR global admin
    allowed_globals = ["admin", "division head"]
    is_global = (creator_role in allowed_globals)

    if not is_global and not is_user_in_team(db, created_by, team.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You must be a member of the team to create tasks"
        )
    
    # Task assignment limits (enterprise): only team admins can assign to others if team.only_admins_assign
    team_obj = team
    if team_obj and getattr(team_obj, "only_admins_assign", 0) == 1:
        if not is_user_team_admin(db, created_by, team.id):
            if task.assigned_to and task.assigned_to != created_by:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Only team admins can assign tasks to other members in this team"
                )

    # Validate assignee if provided
    if task.assigned_to:
        assignee = get_user_by_id(db, task.assigned_to)
        if not assignee:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Assignee with ID {task.assigned_to} not found"
            )
        
        # Validate assignee is in the team
        if not is_user_in_team(db, task.assigned_to, team.id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot assign task to user who is not in the team"
            )
    
    # Validate priority
    valid_priorities = ["Low", "Medium", "High"]
    if task.priority not in valid_priorities:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid priority. Must be one of: {', '.join(valid_priorities)}"
        )
    
    # Validate status
    valid_statuses = ["To Do", "In Progress", "Completed"]
    if task.status not in valid_statuses:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid status. Must be one of: {', '.join(valid_statuses)}"
        )

    # Multi-assign: global Admin/Division Head OR team role Project Director/Group Head/Team Lead (in this task's team)
    privileged_roles = ["admin", "division head", "group head", "team lead", "project director"]
    creator_effective_role = creator_role
    if creator_effective_role not in privileged_roles:
        team_role = get_user_role_in_team(db, created_by, team.id)
        if team_role:
            team_role_lower = team_role.lower()
            if team_role_lower in ("project director", "group head", "team lead"):
                creator_effective_role = team_role_lower
    use_multi_assign = (
        getattr(task, "assignments", None)
        and len(task.assignments) > 0
        and creator_effective_role in privileged_roles
    )

    # Only privileged roles can set assignee(s). Members cannot assign.
    if creator_effective_role not in privileged_roles:
        assigned_to_val = None
        lead_person_id_val = None
        percent_share_val = None
        assignments_to_create = []
        use_multi_assign = False
    else:
        assigned_to_val = task.assigned_to
        lead_person_id_val = task.lead_person_id
        percent_share_val = task.percent_share
        assignments_to_create = []

    if use_multi_assign:
        lead_count = sum(1 for a in task.assignments if getattr(a, "is_lead", False))
        if lead_count > 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="At most one assignee can be marked as lead",
            )
        for a in task.assignments:
            uid = a.user_id
            u = get_user_by_id(db, uid)
            if not u:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"User {uid} not found")
            if not is_user_in_team(db, uid, team.id):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Cannot assign to user who is not in the team",
                )
            share = getattr(a, "percent_share", None)
            if share is not None and (share < 0 or share > 100):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="percent_share must be between 0 and 100",
                )
            assignments_to_create.append((uid, share, getattr(a, "is_lead", False)))
        lead_user = next((a for a in task.assignments if getattr(a, "is_lead", False)), None)
        first_user = task.assignments[0].user_id
        assigned_to_val = lead_user.user_id if lead_user else first_user
        lead_person_id_val = lead_user.user_id if lead_user else None
        percent_share_val = None

    # Task type approval: privileged roles create any type directly; members need approval for Technical/Procurement
    type_approval_status_val = "not_required"
    if creator_effective_role not in privileged_roles:
        if task_type_val in ("Technical", "Procurement"):
            type_approval_status_val = "pending"

    db_task = Task(
        title=task.title,
        description=task.description,
        team_id=team.id,
        activity_id=activity.id if activity else None,
        assigned_to=assigned_to_val,
        due_date=task.due_date,
        priority=task.priority,
        status=task.status,
        task_type=task_type_val,
        type_approval_status=type_approval_status_val,
        type_approved_by=None,
        type_approved_at=None,
        created_by=created_by,
        lead_person_id=lead_person_id_val,
        percent_share=percent_share_val,
        closure_approver_id=task.closure_approver_id,
        is_approved=int(is_approved_val),
        procurement_stage=getattr(task, "procurement_stage", None),
    )
    db.add(db_task)
    db.commit()
    db.refresh(db_task)

    for uid, share, is_lead in assignments_to_create:
        db.add(TaskAssignment(
            task_id=db_task.id,
            user_id=uid,
            percent_share=share,
            is_lead=1 if is_lead else 0,
        ))
    if assignments_to_create:
        db.commit()

    # Log activity
    log_activity(db, created_by, "Created task", "Task", db_task.id)

    # System message in activity chat
    if db_task.activity_id:
        try:
            creator_name = creator.username if creator else f"User {created_by}"
            title_safe = (db_task.title or "Untitled").replace('"', "'")
            create_activity_message_system(
                db, db_task.activity_id,
                f'Task "{title_safe}" was created by {creator_name}.',
            )
        except Exception:
            pass

    db.refresh(db_task)
    assignee = db_task.assignee
    team_obj = db_task.team
    activity_obj = db_task.activity
    assignees_list = []
    assignment_rows = (
        db.query(TaskAssignment)
        .options(joinedload(TaskAssignment.user))
        .filter(TaskAssignment.task_id == db_task.id)
        .all()
    )
    if assignment_rows:
        for a in assignment_rows:
            assignees_list.append({
                "user_id": a.user_id,
                "username": a.user.username if a.user else None,
                "percent_share": a.percent_share,
                "is_lead": bool(a.is_lead),
            })
    task_dict = {
        "id": db_task.id,
        "title": db_task.title,
        "description": db_task.description,
        "status": db_task.status,
        "priority": db_task.priority,
        "due_date": db_task.due_date,
        "assigned_to": db_task.assigned_to,
        "assigned_username": assignee.username if assignee else None,
        "assignees": assignees_list if assignees_list else None,
        "team_id": db_task.team_id,
        "team_name": team_obj.name if team_obj else None,
        "activity_id": db_task.activity_id,
        "activity_name": activity_obj.name if activity_obj else None,
        "activity_type": activity_obj.type if activity_obj else None,
        "created_by": db_task.created_by,
        "created_at": db_task.created_at,
        "updated_at": db_task.updated_at,
        "is_approved": bool(db_task.is_approved),
        "lead_person_id": db_task.lead_person_id,
        "lead_person_username": db_task.lead_person.username if db_task.lead_person else None,
        "percent_share": db_task.percent_share,
        "closure_approver_id": db_task.closure_approver_id,
        "closure_approver_username": db_task.closure_approver.username if db_task.closure_approver else None,
        "task_type": db_task.task_type or "Normal",
        "type_approval_status": db_task.type_approval_status or "not_required",
        "type_approved_by": db_task.type_approved_by,
        "type_approved_at": db_task.type_approved_at,
        "type_approved_by_username": None,
        "can_approve_type": None,
        "procurement_stage": getattr(db_task, "procurement_stage", None),
    }
    logger.info(f"Task created: {task.title} (ID: {db_task.id}) by user {created_by}. Type: {task_type_val}, type_approval: {type_approval_status_val}")
    return task_dict


def get_tasks(
    db: Session,
    team_id: int = None,
    assigned_to: int = None,
    status: str = None,
    current_user: User = None
):
    """
    Fetch tasks with optional filters.
    Non-admin users only see tasks from teams they belong to.
    """
    query = db.query(Task).options(
        joinedload(Task.assignee),
        joinedload(Task.team),
        joinedload(Task.activity),
        joinedload(Task.assignments).joinedload(TaskAssignment.user),
        joinedload(Task.type_approver),
    )

    # Team-based permission: non-admins see only tasks from their approved teams
    allowed_globals = ["admin", "division head"]
    if current_user and (current_user.role or "").lower() not in allowed_globals:
        user_team_ids = [
            row[0] for row in
            db.query(TeamMember.team_id)
            .join(Team)
            .filter(TeamMember.user_id == current_user.id, Team.status == "approved")
            .distinct().all()
        ]
        if user_team_ids:
            query = query.filter(Task.team_id.in_(user_team_ids))
        else:
            query = query.filter(Task.team_id == -1)  # no teams -> no tasks

    if team_id:
        query = query.filter(Task.team_id == team_id)

    if assigned_to:
        subq = db.query(TaskAssignment.task_id).filter(TaskAssignment.user_id == assigned_to).distinct()
        query = query.filter((Task.assigned_to == assigned_to) | Task.id.in_(subq))

    if status:
        # Validate status
        valid_statuses = ["To Do", "In Progress", "Completed", "Pending Completion"]
        if status not in valid_statuses:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid status. Must be one of: {', '.join(valid_statuses)}"
            )
        query = query.filter(Task.status == status)

    tasks = query.all()

    # Preload latest extension request (if any) for all tasks
    task_ids = [t.id for t in tasks]
    latest_ext_by_task = {}
    if task_ids:
        rows = (
            db.query(TaskExtensionRequest, User.username)
            .join(User, TaskExtensionRequest.requested_by == User.id)
            .filter(TaskExtensionRequest.task_id.in_(task_ids))
            .order_by(
                TaskExtensionRequest.task_id.asc(),
                TaskExtensionRequest.created_at.desc(),
                TaskExtensionRequest.id.desc(),
            )
            .all()
        )
        for ext, uname in rows:
            if ext.task_id not in latest_ext_by_task:
                latest_ext_by_task[ext.task_id] = (ext, uname)

    # Preload latest completion request (if any) for all tasks
    latest_comp_by_task = {}
    if task_ids:
        comp_rows = (
            db.query(TaskCompletionRequest, User.username)
            .join(User, TaskCompletionRequest.submitted_by == User.id)
            .filter(TaskCompletionRequest.task_id.in_(task_ids))
            .order_by(
                TaskCompletionRequest.task_id.asc(),
                TaskCompletionRequest.created_at.desc(),
                TaskCompletionRequest.id.desc(),
            )
            .all()
        )
        for comp, uname in comp_rows:
            if comp.task_id not in latest_comp_by_task:
                latest_comp_by_task[comp.task_id] = (comp, uname)

    # Convert to dict and add username, team and activity details
    result = []
    task_ids_to_clear_assignee = []  # tasks whose assignee is no longer in team – clear in DB
    for task in tasks:
        ext = latest_ext_by_task.get(task.id)
        ext_obj = ext[0] if ext else None
        ext_username = ext[1] if ext else None

        comp = latest_comp_by_task.get(task.id)
        comp_obj = comp[0] if comp else None
        comp_username = comp[1] if comp else None

        allowed_globals = ["admin", "division head"]
        is_global_admin = current_user and (current_user.role or "").lower() in allowed_globals
        is_team_admin = current_user and is_user_team_admin(db, current_user.id, task.team_id)
        can_approve_completion = is_global_admin or is_team_admin
        # Type approval: Admin, Division Head, Team Lead, Project Director (not Group Head)
        type_approver_roles = ["admin", "division head", "team lead", "project director"]
        user_role_lower = (current_user.role or "").lower() if current_user else ""
        user_team_role = get_user_role_in_team(db, current_user.id, task.team_id) if current_user else None
        user_team_role_lower = (user_team_role or "").lower()
        can_approve_type = (
            current_user
            and task.type_approval_status == "pending"
            and (
                user_role_lower in type_approver_roles
                or user_team_role_lower in type_approver_roles
            )
        )

        # If assignee is no longer in the task's team (e.g. removed from team), treat as unassigned and clear in DB
        assigned_to_val = task.assigned_to
        assigned_username_val = task.assignee.username if task.assignee else None
        if assigned_to_val is not None and not is_user_in_team(db, assigned_to_val, task.team_id):
            task_ids_to_clear_assignee.append(task.id)
            assigned_to_val = None
            assigned_username_val = None

        assignees_list = []
        if task.assignments:
            for a in task.assignments:
                assignees_list.append({
                    "user_id": a.user_id,
                    "username": a.user.username if a.user else None,
                    "percent_share": a.percent_share,
                    "is_lead": bool(a.is_lead),
                })

        task_dict = {
            "id": task.id,
            "title": task.title,
            "description": task.description,
            "status": task.status,
            "priority": task.priority,
            "due_date": task.due_date,
            "assigned_to": assigned_to_val,
            "assigned_username": assigned_username_val,
            "assignees": assignees_list if assignees_list else None,
            "team_id": task.team_id,
            "team_name": task.team.name if task.team else None,
            "activity_id": task.activity_id,
            "activity_name": task.activity.name if task.activity else None,
            "activity_type": task.activity.type if task.activity else None,
            "created_by": task.created_by,
            "created_at": task.created_at,
            "updated_at": task.updated_at,
            "extension_request_id": ext_obj.id if ext_obj else None,
            "extension_status": ext_obj.status if ext_obj else None,
            "extension_requested_due_date": ext_obj.requested_due_date if ext_obj else None,
            "extension_requested_by": ext_obj.requested_by if ext_obj else None,
            "extension_requested_by_username": ext_username,
            "extension_reason": ext_obj.reason if ext_obj else None,
            "completion_request_id": comp_obj.id if comp_obj else None,
            "completion_status": comp_obj.status if comp_obj else None,
            "completion_submitted_by": comp_obj.submitted_by if comp_obj else None,
            "completion_submitted_by_username": comp_username,
            "completion_attachment_filename": comp_obj.attachment_filename if comp_obj else None,
            "can_approve_completion": can_approve_completion,
            "task_type": getattr(task, "task_type", None) or "Normal",
            "type_approval_status": getattr(task, "type_approval_status", None) or "not_required",
            "type_approved_by": getattr(task, "type_approved_by", None),
            "type_approved_at": getattr(task, "type_approved_at", None),
            "type_approved_by_username": task.type_approver.username if getattr(task, "type_approver", None) else None,
            "can_approve_type": can_approve_type,
            "procurement_stage": getattr(task, "procurement_stage", None),
        }
        result.append(task_dict)

    # Persist: clear assigned_to for tasks whose assignee is no longer in the team (so re-adding member doesn't auto-assign)
    if task_ids_to_clear_assignee:
        db.query(Task).filter(Task.id.in_(task_ids_to_clear_assignee)).update(
            {Task.assigned_to: None}, synchronize_session=False
        )
        db.commit()

    return result


def approve_task(db: Session, task_id: int, approver_id: int):
    """
    Approve a pending task.
    """
    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    if task.is_approved:
        return task # Already approved
        
    task.is_approved = 1
    db.commit()
    db.refresh(task)
    
    # Log activity
    log_activity(db, approver_id, "Approved task", "Task", task.id)
    
    # System message
    if task.activity_id:
        try:
            approver = get_user_by_id(db, approver_id)
            name = approver.username if approver else "Unknown"
            create_activity_message_system(
                db, task.activity_id,
                f"Task \"{task.title}\" was approved by {name}."
            )
        except:
             pass

    return task


def approve_task_type(db: Session, task_id: int, approver_id: int, approved: bool):
    """
    Approve or reject a task's type (for Technical/Procurement created by a member).
    Allowed approvers: Admin, Division Head, Team Lead, Project Director.
    """
    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    if (getattr(task, "type_approval_status", None) or "not_required") != "pending":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This task is not pending type approval",
        )
    type_approver_roles = ["admin", "division head", "team lead", "project director"]
    approver_user = get_user_by_id(db, approver_id)
    if not approver_user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Approver not found")
    approver_global = (approver_user.role or "").lower()
    approver_team_role = get_user_role_in_team(db, approver_id, task.team_id)
    approver_team_role_lower = (approver_team_role or "").lower()
    if approver_global not in type_approver_roles and approver_team_role_lower not in type_approver_roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Admin, Division Head, Team Lead, or Project Director can approve task type",
        )
    task.type_approval_status = "approved" if approved else "rejected"
    task.type_approved_by = approver_id
    task.type_approved_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(task)
    log_activity(db, approver_id, "Approved task type" if approved else "Rejected task type", "Task", task.id)
    return task


def get_task_by_id(db: Session, task_id: int):
    """
    Fetch task by ID.
    """
    return db.query(Task).filter(Task.id == task_id).first()


def update_task_status(db: Session, task_id: int, status_update: TaskStatusUpdate, user_id: int, current_user: User = None):
    """
    Update task status (To Do / In Progress / Completed).
    Members cannot directly set Completed; they must submit a completion request with proof.
    """
    task = get_task_by_id(db, task_id)

    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task with ID {task_id} not found"
        )
    
    # Validate user is in the team (derived from task.team_id, which is kept for backward compatibility)
    if not is_user_in_team(db, user_id, task.team_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You must be a member of the team to update tasks"
        )

    # Members cannot directly set Completed; they must submit completion proof
    if status_update.status == "Completed":
        allowed_globals = ["admin", "division head"]
        is_global_admin = current_user and (current_user.role or "").lower() in allowed_globals
        is_team_admin = current_user and is_user_team_admin(db, user_id, task.team_id)
        if not is_global_admin and not is_team_admin:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Please attach task completion proof using the completion request flow. Select 'Completed' to open the proof upload dialog."
            )
    
    # Validate status
    valid_statuses = ["To Do", "In Progress", "Completed"]
    if status_update.status not in valid_statuses:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid status. Must be one of: {', '.join(valid_statuses)}"
        )

    old_status = task.status
    task.status = status_update.status
    task.updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(task)

    # Log activity
    log_activity(db, user_id, f"Updated task status from '{old_status}' to '{status_update.status}'", "Task", task_id)

    # System message to activity stream (only when task belongs to an activity)
    try:
        if task.activity_id is not None:
            actor = get_user_by_id(db, user_id)
            actor_name = actor.username if actor else f"User {user_id}"
            if status_update.status == "Completed":
                create_activity_message_system(
                    db,
                    activity_id=task.activity_id,
                    content=f"Task “{task.title}” marked Completed by {actor_name}."
                )
            else:
                create_activity_message_system(
                    db,
                    activity_id=task.activity_id,
                    content=f"Task “{task.title}” status updated from “{old_status}” to “{status_update.status}” by {actor_name}."
                )
    except Exception:
        # Never break the core flow if chat logging fails
        pass
    
    # Load relationships for response
    assignee = task.assignee
    team_obj = task.team
    activity_obj = task.activity
    
    # Convert to dict with username, team and activity details
    task_dict = {
        "id": task.id,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "priority": task.priority,
        "due_date": task.due_date,
        "assigned_to": task.assigned_to,
        "assigned_username": assignee.username if assignee else None,
        "team_id": task.team_id,
        "team_name": team_obj.name if team_obj else None,
        "activity_id": task.activity_id,
        "activity_name": activity_obj.name if activity_obj else None,
        "activity_type": activity_obj.type if activity_obj else None,
        "created_by": task.created_by,
        "created_at": task.created_at,
        "updated_at": task.updated_at
    }
    
    logger.info(f"Task {task_id} status updated from '{old_status}' to '{status_update.status}' by user {user_id}")
    return task_dict


def update_procurement_stage(
    db: Session,
    task_id: int,
    stage_update: TaskProcurementStageUpdate,
    user_id: int,
    current_user: User = None
):
    """
    Update the procurement stage for a Procurement task.
    Only members of the task's team can update it.
    """
    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task with ID {task_id} not found"
        )

    # Validate user is in the team
    if not is_user_in_team(db, user_id, task.team_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You must be a member of the team to update procurement stage"
        )

    # Only apply to Procurement tasks
    if (getattr(task, "task_type", None) or "Normal") != "Procurement":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Procurement stage is only available for Procurement tasks"
        )

    allowed_stages = [
        "Specification Preparation",
        "Cost Estimation",
        "Demand Initiation",
        "Tendering",
        "TCEC",
        "CNC",
        "Purchase Order",
        "Delivery",
        "Acceptance / IDIV Issue",
    ]

    new_stage = (stage_update.procurement_stage or "").strip()
    if new_stage and new_stage not in allowed_stages:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid procurement stage"
        )

    old_stage = getattr(task, "procurement_stage", None)

    # Enforce progression rules:
    # - From start up to (but including) "Tendering" (indexes 0..3), movement is one-way forward only (no going back).
    # - From "Tendering" onward (indexes 3..8), you can move up or down within that later group,
    #   but you cannot move back into an earlier-than-Tendering stage.
    if old_stage:
        idx_current = allowed_stages.index(old_stage)
        idx_new = allowed_stages.index(new_stage) if new_stage else -1

        if idx_new != -1:
            boundary = allowed_stages.index("Tendering")  # 3

            # Before Tendering: forbid going backwards (e.g. Cost Estimation -> Specification Preparation)
            if idx_current < boundary and idx_new < boundary and idx_new < idx_current:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="You can only move procurement stage forward before Tendering (no backward changes).",
                )

            # From Tendering or later: forbid moving back to an earlier-than-Tendering stage
            if idx_current >= boundary and idx_new < boundary:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="You cannot move from Tendering or later back to earlier procurement stages.",
                )
    task.procurement_stage = new_stage or None
    task.updated_at = datetime.now(timezone.utc)
    db.commit()

    try:
        if old_stage != task.procurement_stage:
            log_activity(
                db,
                user_id,
                f"Updated procurement stage from '{old_stage or '—'}' to '{task.procurement_stage or '—'}'",
                "Task",
                task_id,
            )
    except Exception:
        # Never block main flow if activity logging fails
        pass


def update_task_assignee(db: Session, task_id: int, assigned_to: Optional[int], current_user: User):
    """
    Assign or unassign a task. Only Admin and Division Head (global role) can assign.
    Assigning the unassigned task is separate from type approval; only Admin/Division Head have assign power.
    Assignee must be a member of the task's team.
    """
    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found",
        )
    allowed_assign_roles = ["admin", "division head"]
    if (current_user.role or "").lower() not in allowed_assign_roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Admin or Division Head can assign or unassign tasks",
        )
    if assigned_to is not None:
        assignee = get_user_by_id(db, assigned_to)
        if not assignee:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Assignee not found",
            )
        if not is_user_in_team(db, assigned_to, task.team_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Assignee must be a member of the team",
            )
    task.assigned_to = assigned_to
    task.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(task)
    # System message in activity chat
    try:
        if task.activity_id:
            actor = current_user.username or "Admin"
            title_safe = (task.title or "Untitled").replace('"', "'")
            if assigned_to is not None:
                assignee = get_user_by_id(db, assigned_to)
                assignee_name = assignee.username if assignee else str(assigned_to)
                create_activity_message_system(
                    db, task.activity_id,
                    f'Task "{title_safe}" was assigned to {assignee_name} by {actor}.',
                )
            else:
                create_activity_message_system(
                    db, task.activity_id,
                    f'Task "{title_safe}" was unassigned by {actor}.',
                )
    except Exception:
        pass
    # Return task dict in same shape as get_tasks
    assignee_obj = task.assignee
    team_obj = task.team
    activity_obj = task.activity
    return {
        "id": task.id,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "priority": task.priority,
        "due_date": task.due_date,
        "assigned_to": task.assigned_to,
        "assigned_username": assignee_obj.username if assignee_obj else None,
        "team_id": task.team_id,
        "team_name": team_obj.name if team_obj else None,
        "activity_id": task.activity_id,
        "activity_name": activity_obj.name if activity_obj else None,
        "activity_type": activity_obj.type if activity_obj else None,
        "created_by": task.created_by,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
    }


def update_task_due_date(db: Session, task_id: int, due_date: Optional[date], current_user: User):
    """
    Update a task's due date. Only global admins or team admins.
    """
    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found",
        )
    allowed_globals = ["admin", "division head"]
    is_global_admin = (current_user.role or "").lower() in allowed_globals
    is_team_admin = is_user_team_admin(db, current_user.id, task.team_id)
    if not is_global_admin and not is_team_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can change task due dates",
        )
    old_due = task.due_date
    task.due_date = due_date
    task.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(task)
    # System message in activity chat
    try:
        if task.activity_id:
            actor = current_user.username or "Admin"
            title_safe = (task.title or "Untitled").replace('"', "'")
            if due_date is not None:
                create_activity_message_system(
                    db, task.activity_id,
                    f'Due date for task "{title_safe}" was changed to {due_date} by {actor}.',
                )
            else:
                create_activity_message_system(
                    db, task.activity_id,
                    f'Due date for task "{title_safe}" was cleared by {actor}.',
                )
    except Exception:
        pass
    assignee_obj = task.assignee
    team_obj = task.team
    activity_obj = task.activity
    return {
        "id": task.id,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "priority": task.priority,
        "due_date": task.due_date,
        "assigned_to": task.assigned_to,
        "assigned_username": assignee_obj.username if assignee_obj else None,
        "team_id": task.team_id,
        "team_name": team_obj.name if team_obj else None,
        "activity_id": task.activity_id,
        "activity_name": activity_obj.name if activity_obj else None,
        "activity_type": activity_obj.type if activity_obj else None,
        "created_by": task.created_by,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
    }


# ------------------------------------------------------------------
# TASK EXTENSION REQUEST OPERATIONS
# ------------------------------------------------------------------


def create_task_extension_request(
    db: Session,
    task_id: int,
    payload: TaskExtensionRequestCreate,
    current_user: User,
):
    """
    Create an extension request for a task.
    Any member of the task's team can request an extension.
    """
    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task with ID {task_id} not found",
        )

    # Validate current user is in the team
    if not is_user_in_team(db, current_user.id, task.team_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You must be a member of the team to request an extension",
        )

    reason = (payload.reason or "").strip()
    if not reason:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Reason is required for extension request",
        )

    # Determine a default approver (first team admin, if any)
    approver_id = None
    admin_members = (
        db.query(TeamMember)
        .filter(TeamMember.team_id == task.team_id, TeamMember.role == "Admin")
        .order_by(TeamMember.id.asc())
        .all()
    )
    if admin_members:
        approver_id = admin_members[0].user_id

    ext = TaskExtensionRequest(
        task_id=task.id,
        requested_by=current_user.id,
        requested_to=approver_id,
        reason=reason,
        requested_due_date=payload.requested_due_date,
        status="pending",
    )
    db.add(ext)
    db.commit()
    db.refresh(ext)

    # System message in activity chat
    try:
        if task.activity_id is not None:
            requester = current_user.username or f"User {current_user.id}"
            title_safe = (task.title or "Untitled").replace('"', "'")
            create_activity_message_system(
                db, task.activity_id,
                f'Extension requested for task "{title_safe}" by {requester}.',
            )
    except Exception:
        pass

    logger.info(
        "Extension requested for task %s by user %s to %s",
        task.id,
        current_user.id,
        payload.requested_due_date,
    )
    return ext


def decide_task_extension_request(
    db: Session,
    request_id: int,
    payload: TaskExtensionRequestDecision,
    current_user: User,
):
    """
    Approve or reject an extension request.
    Only global admins or team admins can decide.
    On approval, updates the task's due date and posts a system message.
    """
    ext = (
        db.query(TaskExtensionRequest)
        .filter(TaskExtensionRequest.id == request_id)
        .first()
    )
    if not ext:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Extension request not found",
        )

    task = get_task_by_id(db, ext.task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task with ID {ext.task_id} not found",
        )

    # Permission check: global admin or team admin
    allowed_globals = ["admin", "division head"]
    is_global_admin = (current_user.role or "").lower() in allowed_globals
    is_team_admin = is_user_team_admin(db, current_user.id, task.team_id)
    if not is_global_admin and not is_team_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can decide on extension requests",
        )

    if ext.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Extension request has already been decided",
        )

    decision = (payload.status or "").strip().lower()
    if decision not in ("approved", "rejected"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Status must be 'approved' or 'rejected'",
        )

    ext.status = decision
    ext.decided_at = datetime.now(timezone.utc)
    ext.decided_by = current_user.id

    # On approval, update task due_date
    if decision == "approved":
        # Use override if provided, otherwise requested_due_date
        final_due_date = payload.new_due_date or ext.requested_due_date
        old_due = task.due_date
        task.due_date = final_due_date
        # Keep extension record in sync with the actual applied date
        ext.requested_due_date = final_due_date
        task.updated_at = datetime.now(timezone.utc)

        # Log activity
        log_activity(
            db,
            current_user.id,
            f"Approved extension for task (old due: {old_due}, new due: {final_due_date})",
            "Task",
            task.id,
        )

        # System message in activity chat (if task linked to activity)
        try:
            if task.activity_id is not None:
                approver_name = current_user.username or f"User {current_user.id}"
                create_activity_message_system(
                    db,
                    activity_id=task.activity_id,
                    content=(
                        f"Extension request for task “{task.title}” approved by {approver_name}. "
                        f"New due date: {final_due_date}."
                    ),
                )
        except Exception:
            pass
    else:
        # Rejected – log and add system message
        log_activity(
            db,
            current_user.id,
            "Rejected extension request for task",
            "Task",
            task.id,
        )
        try:
            if task.activity_id is not None:
                approver_name = current_user.username or f"User {current_user.id}"
                create_activity_message_system(
                    db,
                    activity_id=task.activity_id,
                    content=(
                        f"Extension request for task “{task.title}” was rejected by {approver_name}."
                    ),
                )
        except Exception:
            pass

    db.commit()
    db.refresh(ext)
    return ext


# ------------------------------------------------------------------
# TASK COMPLETION REQUEST OPERATIONS (proof + approval)
# ------------------------------------------------------------------

# Allowed file extensions for completion proof
COMPLETION_PROOF_ALLOWED = {".pdf", ".doc", ".docx", ".png", ".jpg", ".jpeg", ".gif"}
COMPLETION_PROOF_MAX_BYTES = 10 * 1024 * 1024  # 10 MB


def create_task_completion_request(
    db: Session,
    task_id: int,
    current_user: User,
    file_content: bytes,
    filename: str,
    upload_dir: str,
):
    """
    Submit a completion request with proof attachment.
    Sets task status to 'Pending Completion' until admin approves.
    """
    import os
    import uuid

    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found",
        )

    if not is_user_in_team(db, current_user.id, task.team_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You must be a member of the team to submit completion proof",
        )

    # Reject if user is admin/team admin (they can directly complete) - optional: we allow anyway for consistency
    # Only one pending completion request per task
    existing = (
        db.query(TaskCompletionRequest)
        .filter(TaskCompletionRequest.task_id == task_id, TaskCompletionRequest.status == "pending")
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A completion request is already pending for this task",
        )

    # Validate file
    ext = os.path.splitext(filename)[1].lower() if filename else ""
    if ext not in COMPLETION_PROOF_ALLOWED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid file type. Allowed: PDF, Word (.doc/.docx), images (.png, .jpg, .jpeg, .gif)",
        )
    if len(file_content) > COMPLETION_PROOF_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File too large. Maximum 10 MB.",
        )

    # Save file
    os.makedirs(upload_dir, exist_ok=True)
    safe_name = f"{task_id}_{uuid.uuid4().hex[:8]}{ext}"
    file_path = os.path.join(upload_dir, safe_name)
    with open(file_path, "wb") as f:
        f.write(file_content)

    previous_status = task.status
    task.status = "Pending Completion"
    task.updated_at = datetime.now(timezone.utc)

    req = TaskCompletionRequest(
        task_id=task_id,
        submitted_by=current_user.id,
        previous_status=previous_status,
        attachment_path=file_path,
        attachment_filename=filename or safe_name,
        status="pending",
    )
    db.add(req)
    db.commit()
    db.refresh(req)

    log_activity(db, current_user.id, "Submitted task completion proof (awaiting approval)", "Task", task_id)

    try:
        if task.activity_id is not None:
            actor_name = current_user.username or f"User {current_user.id}"
            create_activity_message_system(
                db, activity_id=task.activity_id,
                content=f'Task "{task.title}" completion proof submitted by {actor_name}. Awaiting approval.',
            )
    except Exception:
        pass

    logger.info(f"Completion request created for task {task_id} by user {current_user.id}")
    return req


def decide_task_completion_request(
    db: Session,
    request_id: int,
    payload: TaskCompletionRequestDecision,
    current_user: User,
):
    """
    Approve or reject a completion request.
    Only global admins or team admins can decide.
    """
    req = (
        db.query(TaskCompletionRequest)
        .filter(TaskCompletionRequest.id == request_id)
        .first()
    )
    if not req:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Completion request not found")

    task = get_task_by_id(db, req.task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    allowed_globals = ["admin", "division head"]
    is_global_admin = (current_user.role or "").lower() in allowed_globals
    is_team_admin = is_user_team_admin(db, current_user.id, task.team_id)
    if not is_global_admin and not is_team_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can approve or reject completion requests",
        )

    if req.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Completion request has already been decided",
        )

    decision = (payload.status or "").strip().lower()
    if decision not in ("approved", "rejected"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Status must be 'approved' or 'rejected'",
        )

    req.status = decision
    req.decided_at = datetime.now(timezone.utc)
    req.decided_by = current_user.id

    if decision == "approved":
        task.status = "Completed"
        task.updated_at = datetime.now(timezone.utc)
        log_activity(db, current_user.id, "Approved task completion proof", "Task", task.id)
        try:
            if task.activity_id is not None:
                approver_name = current_user.username or f"User {current_user.id}"
                create_activity_message_system(
                    db, activity_id=task.activity_id,
                    content=f'Task "{task.title}" marked Completed (proof approved by {approver_name}).',
                )
        except Exception:
            pass
    else:
        task.status = req.previous_status
        task.updated_at = datetime.now(timezone.utc)
        log_activity(db, current_user.id, "Rejected task completion proof", "Task", task.id)
        try:
            if task.activity_id is not None:
                approver_name = current_user.username or f"User {current_user.id}"
                create_activity_message_system(
                    db, activity_id=task.activity_id,
                    content=f'Task "{task.title}" completion proof rejected by {approver_name}. Status reverted to {req.previous_status}.',
                )
        except Exception:
            pass

    db.commit()
    db.refresh(req)
    return req


# ------------------------------------------------------------------
# COMMENT CRUD OPERATIONS
# ------------------------------------------------------------------

def create_comment(db: Session, comment: CommentCreate, task_id: int, user_id: int):
    """
    Create a new comment on a task with validation.
    """
    # Validate task exists
    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task with ID {task_id} not found"
        )
    
    # Validate user exists
    user = get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User with ID {user_id} not found"
        )
    
    # Validate user is in the team
    if not is_user_in_team(db, user_id, task.team_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You must be a member of the team to comment on tasks"
        )
    
    db_comment = Comment(
        content=comment.content,
        task_id=task_id,
        user_id=user_id
    )
    db.add(db_comment)
    db.commit()
    db.refresh(db_comment)
    
    logger.info(f"Comment added to task {task_id} by user {user_id}")
    return db_comment


def get_comments_by_task(db: Session, task_id: int, current_user_id: int = None):
    """
    Get all comments for a task with username. Optionally enforce team membership.
    """
    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task with ID {task_id} not found"
        )
    if current_user_id is not None and not is_user_in_team(db, current_user_id, task.team_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You must be a member of the team to view comments"
        )
    rows = (
        db.query(Comment, User.username)
        .join(User, Comment.user_id == User.id)
        .filter(Comment.task_id == task_id)
        .order_by(Comment.created_at)
        .all()
    )
    return [
        {
            "id": c.id,
            "task_id": c.task_id,
            "user_id": c.user_id,
            "username": uname,
            "content": c.content,
            "created_at": c.created_at,
        }
        for c, uname in rows
    ]


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
    Get activity logs with optional filters. Returns list of dicts with username for display.
    """
    query = db.query(ActivityLog, User.username).join(User, ActivityLog.user_id == User.id)
    if user_id:
        query = query.filter(ActivityLog.user_id == user_id)
    if entity_type:
        query = query.filter(ActivityLog.entity_type == entity_type)
    if entity_id:
        query = query.filter(ActivityLog.entity_id == entity_id)
    rows = query.order_by(ActivityLog.timestamp.desc()).limit(limit).all()
    return [
        {"id": log.id, "user_id": log.user_id, "username": uname, "action": log.action,
         "entity_type": log.entity_type, "entity_id": log.entity_id, "timestamp": log.timestamp}
        for log, uname in rows
    ]


# ------------------------------------------------------------------
# ACTIVITY MESSAGE CRUD OPERATIONS (Activity chat / logbook)
# ------------------------------------------------------------------

def _require_activity_member(db: Session, current_user: User, activity_id: int):
    activity = get_activity_by_id(db, activity_id)
    if not activity:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Activity not found")
    allowed_globals = ["admin", "division head"]
    if (current_user.role or "").lower() in allowed_globals:
        return activity
    if not is_user_in_team(db, current_user.id, activity.team_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You must be a member of the team to access this activity")
    return activity


def list_activity_messages(db: Session, activity_id: int, current_user: User, limit: int = 200):
    _require_activity_member(db, current_user, activity_id)
    rows = (
        db.query(ActivityMessage, User.username)
        .outerjoin(User, ActivityMessage.user_id == User.id)
        .filter(ActivityMessage.activity_id == activity_id)
        .order_by(ActivityMessage.created_at.asc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": m.id,
            "activity_id": m.activity_id,
            "user_id": m.user_id,
            "username": uname,
            "message_type": m.message_type,
            "content": m.content,
            "created_at": m.created_at,
            "updated_at": m.updated_at,
        }
        for m, uname in rows
    ]


def create_activity_message(db: Session, activity_id: int, payload: ActivityMessageCreate, current_user: User):
    activity = _require_activity_member(db, current_user, activity_id)
    content = (payload.content or "").strip()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Message cannot be empty")
    msg = ActivityMessage(
        activity_id=activity.id,
        user_id=current_user.id,
        message_type="user",
        content=content,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return {
        "id": msg.id,
        "activity_id": msg.activity_id,
        "user_id": msg.user_id,
        "username": current_user.username,
        "message_type": msg.message_type,
        "content": msg.content,
        "created_at": msg.created_at,
        "updated_at": msg.updated_at,
    }


def create_activity_message_system(db: Session, activity_id: int, content: str):
    # No permission check here: used internally by backend as a system logger.
    c = (content or "").strip()
    if not c:
        return None
    msg = ActivityMessage(
        activity_id=activity_id,
        user_id=None,
        message_type="system",
        content=c,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return msg


def post_system_message_to_team_activities(db: Session, team_id: int, content: str):
    """Post a system message to the chat of every activity in the given team."""
    activities = get_activities_for_team(db, team_id)
    for act in activities:
        try:
            create_activity_message_system(db, act.id, content)
        except Exception:
            pass


def update_activity_message(db: Session, activity_id: int, message_id: int, payload: ActivityMessageUpdate, current_user: User):
    _require_activity_member(db, current_user, activity_id)
    msg = db.query(ActivityMessage).filter(ActivityMessage.id == message_id, ActivityMessage.activity_id == activity_id).first()
    if not msg:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    if msg.message_type == "system":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="System messages cannot be edited")
    allowed_globals = ["admin", "division head"]
    if msg.user_id != current_user.id and (current_user.role or "").lower() not in allowed_globals:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only edit your own messages")
    content = (payload.content or "").strip()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Message cannot be empty")
    msg.content = content
    msg.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(msg)
    uname = current_user.username if msg.user_id == current_user.id else (get_user_by_id(db, msg.user_id).username if msg.user_id else None)
    return {
        "id": msg.id,
        "activity_id": msg.activity_id,
        "user_id": msg.user_id,
        "username": uname,
        "message_type": msg.message_type,
        "content": msg.content,
        "created_at": msg.created_at,
        "updated_at": msg.updated_at,
    }


def delete_activity_message(db: Session, activity_id: int, message_id: int, current_user: User):
    _require_activity_member(db, current_user, activity_id)
    msg = db.query(ActivityMessage).filter(ActivityMessage.id == message_id, ActivityMessage.activity_id == activity_id).first()
    if not msg:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    if msg.message_type == "system":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="System messages cannot be deleted")
    allowed_globals = ["admin", "division head"]
    if msg.user_id != current_user.id and (current_user.role or "").lower() not in allowed_globals:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only delete your own messages")
    db.delete(msg)
    db.commit()
    return {"message": "Deleted"}


# ------------------------------------------------------------------
# ADMIN / MAINTENANCE UTILITIES
# ------------------------------------------------------------------


def delete_team(db: Session, team_id: int, current_user: User):
    """
    Delete a team (admin only).
    For safety, teams with members, activities or tasks cannot be deleted.
    """
    from sqlalchemy import func

    # Permission: only global admins can delete teams
    allowed_globals = ["admin", "division head"]
    if (current_user.role or "").lower() not in allowed_globals:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only global admins can delete teams",
        )

    team = get_team_by_id(db, team_id)
    if not team:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Team not found",
        )

    # Check for related records to avoid breaking foreign keys
    member_count = db.query(func.count(TeamMember.id)).filter(TeamMember.team_id == team_id).scalar() or 0
    activity_count = db.query(func.count(Activity.id)).filter(Activity.team_id == team_id).scalar() or 0
    task_count = db.query(func.count(Task.id)).filter(Task.team_id == team_id).scalar() or 0

    if member_count > 0 or activity_count > 0 or task_count > 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Team cannot be deleted while it has members, activities, or tasks. Please clean them up first.",
        )

    db.delete(team)
    db.commit()
    logger.info("Team %s deleted by admin %s", team_id, current_user.id)
    return {"message": "Team deleted"}


def remove_team_member(db: Session, team_id: int, user_id: int, current_user: User):
    """
    Remove a member from a team.
    Allowed for global admins (Admin, Division Head), team admins, or team role Project Director / Group Head / Team Lead.
    """
    allowed_globals = ["admin", "division head"]
    is_global_admin = (current_user.role or "").lower() in allowed_globals
    is_team_admin = is_user_team_admin(db, current_user.id, team_id)
    team_role = get_user_role_in_team(db, current_user.id, team_id)
    team_role_lower = (team_role or "").lower()
    is_team_privileged = team_role_lower in ("project director", "group head", "team lead")
    if not is_global_admin and not is_team_admin and not is_team_privileged:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Admin, Division Head, Team Admin, Project Director, Group Head, or Team Lead can remove members from a team",
        )

    membership = (
        db.query(TeamMember)
        .filter(TeamMember.team_id == team_id, TeamMember.user_id == user_id)
        .first()
    )
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User is not a member of this team",
        )

    # Optional safety: prevent removing the last admin in a team
    if membership.role == "Admin":
        other_admins = (
            db.query(TeamMember)
            .filter(
                TeamMember.team_id == team_id,
                TeamMember.id != membership.id,
                TeamMember.role == "Admin",
            )
            .count()
        )
        if other_admins == 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot remove the last Admin from the team",
            )

    removed_user = get_user_by_id(db, user_id)
    removed_name = removed_user.username if removed_user else str(user_id)
    actor = current_user.username or "Admin"

    # Unassign any tasks in this team that were assigned to the removed member
    db.query(Task).filter(
        Task.team_id == team_id,
        Task.assigned_to == user_id,
    ).update({Task.assigned_to: None}, synchronize_session=False)

    db.delete(membership)
    db.commit()

    post_system_message_to_team_activities(
        db, team_id,
        f'"{removed_name}" was removed from the team by {actor}.',
    )
    logger.info("User %s removed from team %s by %s", user_id, team_id, current_user.id)
    return {"message": "Member removed from team"}


def delete_task(db: Session, task_id: int, current_user: User):
    """
    Delete a task and its related records.
    Allowed for global admins or admins of the task's team.
    """
    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found",
        )

    allowed_globals = ["admin", "division head"]
    is_global_admin = (current_user.role or "").lower() in allowed_globals
    is_team_admin = is_user_team_admin(db, current_user.id, task.team_id)
    if not is_global_admin and not is_team_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can delete tasks",
        )

    # Post system message to the activity chat so admin and members can see it
    if task.activity_id:
        actor = current_user.username or "Admin"
        title_safe = (task.title or "Untitled").replace('"', "'")
        create_activity_message_system(
            db, task.activity_id,
            f'Task "{title_safe}" was deleted by {actor}.',
        )

    # Delete related completion and extension requests and comments first
    db.query(TaskCompletionRequest).filter(TaskCompletionRequest.task_id == task_id).delete()
    db.query(TaskExtensionRequest).filter(TaskExtensionRequest.task_id == task_id).delete()
    db.query(Comment).filter(Comment.task_id == task_id).delete()

    db.delete(task)
    db.commit()
    logger.info("Task %s deleted by user %s", task_id, current_user.id)
    return {"message": "Task deleted"}


def delete_activity(db: Session, activity_id: int, current_user: User):
    """
    Delete an activity (Division / Project).
    For safety, activities that still have tasks cannot be deleted.
    Allowed for global admins or admins of the parent team.
    """
    activity = get_activity_by_id(db, activity_id)
    if not activity:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Activity not found",
        )

    team_id = activity.team_id
    allowed_globals = ["admin", "division head"]
    is_global_admin = (current_user.role or "").lower() in allowed_globals
    is_team_admin = is_user_team_admin(db, current_user.id, team_id)
    if not is_global_admin and not is_team_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can delete activities",
        )

    # Post system message to the activity chat so admin and members can see it before the activity is removed
    actor = current_user.username or "Admin"
    name_safe = (activity.name or "Untitled").replace('"', "'")
    create_activity_message_system(
        db, activity_id,
        f'Activity "{name_safe}" was deleted by {actor}.',
    )

    # Cascade: delete all tasks in this activity (and their related data) first
    activity_task_ids = [r[0] for r in db.query(Task.id).filter(Task.activity_id == activity_id).all()]
    for task_id in activity_task_ids:
        db.query(TaskCompletionRequest).filter(TaskCompletionRequest.task_id == task_id).delete()
        db.query(TaskExtensionRequest).filter(TaskExtensionRequest.task_id == task_id).delete()
        db.query(Comment).filter(Comment.task_id == task_id).delete()
        task = db.query(Task).filter(Task.id == task_id).first()
        if task:
            db.delete(task)

    # Delete activity messages
    db.query(ActivityMessage).filter(ActivityMessage.activity_id == activity_id).delete()

    db.delete(activity)
    db.commit()
    logger.info("Activity %s deleted by user %s", activity_id, current_user.id)
    return {"message": "Activity deleted"}
