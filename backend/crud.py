from typing import List, Optional
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import and_, or_
from datetime import datetime, timezone, date, timedelta
from fastapi import HTTPException, status

from models import (
    User,
    UserOption,
    Holiday,
    Milestone,
    Division,
    Group,
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
    Notification,
)
from schemas import (
    UserCreate,
    HolidayCreate,
    MilestoneCreate,
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
    TaskDetailsEdit,
)
import auth
import logging

# Configure logging
logger = logging.getLogger(__name__)


def _derive_tentative_completion_date(start_date: Optional[date], duration_days: Optional[int]) -> Optional[date]:
    if start_date is None or duration_days is None:
        return None
    return start_date + timedelta(days=max(0, int(duration_days) - 1))


def _derive_tentative_duration_days(start_date: Optional[date], completion_date: Optional[date]) -> Optional[int]:
    if start_date is None or completion_date is None:
        return None
    return (completion_date - start_date).days + 1


def _resolve_tentative_schedule_fields(
    start_date: Optional[date],
    completion_date: Optional[date],
    duration_days: Optional[int],
) -> tuple[Optional[date], Optional[date], Optional[int]]:
    duration_val = int(duration_days) if duration_days is not None else None
    if duration_val is not None and duration_val <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="tentative_duration_days must be greater than 0",
        )
    completion_val = completion_date
    if completion_val is None and start_date is not None and duration_val is not None:
        completion_val = _derive_tentative_completion_date(start_date, duration_val)
    if duration_val is None and start_date is not None and completion_val is not None:
        duration_val = _derive_tentative_duration_days(start_date, completion_val)
    if start_date is not None and completion_val is not None and completion_val < start_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="tentative_completion_date cannot be earlier than tentative_start_date",
        )
    return start_date, completion_val, duration_val

DEFAULT_GLOBAL_ROLES = (
    "admin",
    "member",
    "division head",
    "project director",
    "group head",
    "team lead",
)

ALLOWED_DESIGNATIONS = (
    "Scientist H",
    "Scientist G",
    "Scientist F",
    "Scientist E",
    "Scientist D",
    "Scientist C",
    "Scientist B",
    "Scientist A",
    "Research Associate",
    "Senior Research Fellow",
    "Junior Research Fellow",
)

DESIGNATION_SENIORITY = {
    "Scientist H": 0,
    "Scientist G": 1,
    "Scientist F": 2,
    "Scientist E": 3,
    "Scientist D": 4,
    "Scientist C": 5,
    "Scientist B": 6,
    "Scientist A": 7,
    "Research Associate": 8,
    "Senior Research Fellow": 9,
    "Junior Research Fellow": 10,
}


def _normalize_option_value(value: Optional[str]) -> str:
    return " ".join(str(value or "").strip().split())


def _to_title_case_words(value: str) -> str:
    words = _normalize_option_value(value).split(" ")
    return " ".join(word[:1].upper() + word[1:].lower() if word else "" for word in words).strip()


def _seed_default_user_options(db: Session):
    existing_count = db.query(UserOption.id).count()
    if existing_count:
        return
    for role in DEFAULT_GLOBAL_ROLES:
        db.add(UserOption(option_type="role", value=_to_title_case_words(role)))
    for designation in ALLOWED_DESIGNATIONS:
        db.add(UserOption(option_type="designation", value=designation))
    db.commit()


def get_user_options(db: Session, option_type: Optional[str] = None):
    _seed_default_user_options(db)
    query = db.query(UserOption)
    if option_type:
        query = query.filter(UserOption.option_type == option_type.strip().lower())
    items = query.order_by(UserOption.value.asc()).all()
    return items


def get_allowed_role_values(db: Session):
    _seed_default_user_options(db)
    values = [row.value for row in db.query(UserOption).filter(UserOption.option_type == "role").order_by(UserOption.value.asc()).all()]
    return values or [_to_title_case_words(role) for role in DEFAULT_GLOBAL_ROLES]


def get_allowed_designation_values(db: Session):
    _seed_default_user_options(db)
    values = [row.value for row in db.query(UserOption).filter(UserOption.option_type == "designation").order_by(UserOption.value.asc()).all()]
    return values or list(ALLOWED_DESIGNATIONS)


def _resolve_task_schedule_type(task) -> str:
    schedule_type = _normalize_option_value(getattr(task, "task_schedule_type", ""))
    if schedule_type:
        lowered = schedule_type.lower()
        if lowered == "ongoing":
            return "Ongoing"
        if lowered == "time bound":
            return "Time Bound"
        return schedule_type
    return "Ongoing" if getattr(task, "due_date", None) in (None, "") else "Time Bound"


def _designation_sort_key(designation: Optional[str]) -> int:
    return DESIGNATION_SENIORITY.get((designation or "").strip(), 999)


def get_holiday_by_date(db: Session, value: Optional[date]):
    if value is None:
        return None
    return db.query(Holiday).filter(Holiday.holiday_date == value).first()


def validate_due_date_not_holiday(db: Session, value: Optional[date]):
    if value is None:
        return
    holiday = get_holiday_by_date(db, value)
    if holiday:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{value} is marked as holiday ({holiday.name}). Please choose a non-holiday due date.",
        )


def _normalize_dependency_event(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    cleaned = str(value).strip().lower()
    if cleaned in ("start", "finish"):
        return cleaned
    return None


def _status_is_started(status_value: Optional[str]) -> bool:
    value = str(status_value or "").strip().lower()
    return value in ("in progress", "completed", "pending completion")


def _status_is_finished(status_value: Optional[str]) -> bool:
    value = str(status_value or "").strip().lower()
    return value == "completed"


def _dependency_condition_resolved(dep_task: Optional[Task], dep_event: Optional[str]) -> bool:
    event = _normalize_dependency_event(dep_event)
    if dep_task is None or event is None:
        return False
    if event == "start":
        return _status_is_started(dep_task.status)
    return _status_is_finished(dep_task.status)


def _build_dependency_message(prefix: str, dep_task: Optional[Task], dep_event: Optional[str]) -> str:
    if dep_task is None:
        return f"{prefix} dependency task is not available."
    event_label = "starts" if _normalize_dependency_event(dep_event) == "start" else "finishes"
    return f"{prefix} when task \"{dep_task.title or ('Task ' + str(dep_task.id))}\" {event_label}."


def get_task_dependency_state(db: Session, task: Task, dep_task_cache: Optional[dict] = None):
    cache = dep_task_cache if isinstance(dep_task_cache, dict) else {}

    def get_dep_task(dep_task_id: Optional[int]):
        if not dep_task_id:
            return None
        dep_id = int(dep_task_id)
        if dep_id in cache:
            return cache[dep_id]
        obj = get_task_by_id(db, dep_id)
        cache[dep_id] = obj
        return obj

    start_dep_task = get_dep_task(getattr(task, "start_dependency_task_id", None))
    finish_dep_task = get_dep_task(getattr(task, "finish_dependency_task_id", None))
    start_event = _normalize_dependency_event(getattr(task, "start_dependency_event", None))
    finish_event = _normalize_dependency_event(getattr(task, "finish_dependency_event", None))

    start_locked = bool(start_dep_task and start_event and not _dependency_condition_resolved(start_dep_task, start_event))
    finish_locked = bool(finish_dep_task and finish_event and not _dependency_condition_resolved(finish_dep_task, finish_event))

    status_value = str(getattr(task, "status", "") or "").strip().lower()
    lock_active = False
    lock_message = None
    if status_value in ("", "to do") and start_locked:
        lock_active = True
        lock_message = _build_dependency_message("Can start", start_dep_task, start_event)
    elif status_value not in ("completed",) and status_value not in ("", "to do") and finish_locked:
        lock_active = True
        lock_message = _build_dependency_message("Can finish", finish_dep_task, finish_event)

    has_dependency = bool(getattr(task, "has_dependency", 0)) or bool(start_dep_task and start_event) or bool(finish_dep_task and finish_event)

    return {
        "has_dependency": has_dependency,
        "start_dependency_task_id": getattr(task, "start_dependency_task_id", None),
        "start_dependency_event": start_event,
        "start_dependency_offset_days": getattr(task, "start_dependency_offset_days", None),
        "finish_dependency_task_id": getattr(task, "finish_dependency_task_id", None),
        "finish_dependency_event": finish_event,
        "finish_dependency_offset_days": getattr(task, "finish_dependency_offset_days", None),
        "dependency_start_locked": start_locked,
        "dependency_finish_locked": finish_locked,
        "dependency_lock_active": lock_active,
        "dependency_lock_message": lock_message,
    }


def _sort_user_like_rows(rows):
    return sorted(
        rows,
        key=lambda item: (
            _designation_sort_key(item.get("designation")),
            (item.get("username") or "").lower(),
            item.get("id") or 0,
        ),
    )

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
    valid_global_roles = tuple(value.lower() for value in get_allowed_role_values(db))
    if role_normalized not in valid_global_roles:
        role_normalized = "member"
    if role_normalized == "admin":
        existing_admin = db.query(User.id).filter(User.role == "admin").first()
        if existing_admin:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Only one global Admin account is allowed"
            )

    designation_value = (user.designation or "").strip() or None
    if role_normalized == "admin":
        designation_value = None
    if designation_value and designation_value not in get_allowed_designation_values(db):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid designation"
        )

    hashed_password = auth.hash_password(user.password)

    db_user = User(
        username=user.username.strip(),
        password=hashed_password,
        role=role_normalized,
        designation=designation_value,
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


def get_accessible_division_ids_for_user(db: Session, user_id: int):
    division_ids = set()

    headed_divisions = db.query(Division.id).filter(Division.head_user_id == user_id).all()
    for row in headed_divisions:
        division_ids.add(row[0])

    group_divisions = (
        db.query(Group.division_id)
        .filter(Group.head_user_id == user_id)
        .all()
    )
    for row in group_divisions:
        division_ids.add(row[0])

    membership_divisions = (
        db.query(Group.division_id)
        .join(Activity, Activity.group_id == Group.id)
        .join(Team, Team.activity_id == Activity.id)
        .join(TeamMember, TeamMember.team_id == Team.id)
        .filter(TeamMember.user_id == user_id)
        .all()
    )
    for row in membership_divisions:
        division_ids.add(row[0])

    return sorted(division_ids)


def get_visible_group_ids_for_role_scope(db: Session, user: Optional[User]) -> List[int]:
    if not user:
        return []
    role = (user.role or "").lower()
    if role == "admin":
        rows = db.query(Group.id).order_by(Group.id.asc()).all()
        return [int(row[0]) for row in rows]
    if role == "division head":
        division_ids = get_visible_division_ids_for_role_scope(db, user)
        if not division_ids:
            return []
        rows = (
            db.query(Group.id)
            .filter(Group.division_id.in_(division_ids))
            .order_by(Group.id.asc())
            .all()
        )
        return [int(row[0]) for row in rows]
    if role == "group head":
        rows = (
            db.query(Group.id)
            .filter(Group.head_user_id == user.id)
            .order_by(Group.id.asc())
            .all()
        )
        return [int(row[0]) for row in rows]

    rows = (
        db.query(Group.id)
        .join(Activity, Activity.group_id == Group.id)
        .join(Team, Team.activity_id == Activity.id)
        .join(TeamMember, TeamMember.team_id == Team.id)
        .filter(TeamMember.user_id == user.id, Team.status == "approved")
        .distinct()
        .order_by(Group.id.asc())
        .all()
    )
    return [int(row[0]) for row in rows]


def get_visible_team_ids_for_role_scope(db: Session, user: Optional[User]) -> List[int]:
    if not user:
        return []
    role = (user.role or "").lower()
    if role == "admin":
        rows = db.query(Team.id).filter(Team.status == "approved").order_by(Team.id.asc()).all()
        return [int(row[0]) for row in rows]
    if role == "division head":
        division_ids = get_visible_division_ids_for_role_scope(db, user)
        if not division_ids:
            return []
        rows = (
            db.query(Team.id)
            .join(Activity, Team.activity_id == Activity.id)
            .join(Group, Activity.group_id == Group.id)
            .filter(Group.division_id.in_(division_ids), Team.status == "approved")
            .order_by(Team.id.asc())
            .all()
        )
        return [int(row[0]) for row in rows]
    if role == "group head":
        group_ids = get_visible_group_ids_for_role_scope(db, user)
        if not group_ids:
            return []
        rows = (
            db.query(Team.id)
            .join(Activity, Team.activity_id == Activity.id)
            .filter(Activity.group_id.in_(group_ids), Team.status == "approved")
            .order_by(Team.id.asc())
            .all()
        )
        return [int(row[0]) for row in rows]

    rows = (
        db.query(Team.id)
        .join(TeamMember, TeamMember.team_id == Team.id)
        .filter(TeamMember.user_id == user.id, Team.status == "approved")
        .distinct()
        .order_by(Team.id.asc())
        .all()
    )
    return [int(row[0]) for row in rows]


def get_all_users(db: Session, requester: Optional[User] = None):
    """
    List visible users (id, username, role) for dropdowns and management.
    Global Admin is excluded from the returned list.
    Non-admin requesters are limited to users inside their accessible divisions.
    """
    query = db.query(User.id, User.username, User.role, User.designation).filter(User.role != "admin")

    if requester and (requester.role or "").lower() != "admin":
        requester_role = (requester.role or "").lower()
        if requester_role == "division head":
            division_ids = get_visible_division_ids_for_role_scope(db, requester)
            if not division_ids:
                return []
            query = (
                query.join(TeamMember, TeamMember.user_id == User.id)
                .join(Team, Team.id == TeamMember.team_id)
                .join(Activity, Activity.id == Team.activity_id)
                .join(Group, Group.id == Activity.group_id)
                .filter(Group.division_id.in_(division_ids))
                .distinct()
            )
        elif requester_role == "group head":
            group_ids = get_visible_group_ids_for_role_scope(db, requester)
            if not group_ids:
                return []
            query = (
                query.join(TeamMember, TeamMember.user_id == User.id)
                .join(Team, Team.id == TeamMember.team_id)
                .join(Activity, Activity.id == Team.activity_id)
                .filter(Activity.group_id.in_(group_ids))
                .distinct()
            )
        else:
            team_ids = get_visible_team_ids_for_role_scope(db, requester)
            if not team_ids:
                return []
            query = (
                query.join(TeamMember, TeamMember.user_id == User.id)
                .join(Team, Team.id == TeamMember.team_id)
                .filter(Team.id.in_(team_ids))
                .distinct()
            )

    users = query.all()
    result = [{"id": u.id, "username": u.username, "role": u.role, "designation": u.designation} for u in users]
    return _sort_user_like_rows(result)


def is_user_group_head_for_team(db: Session, user_id: int, team_id: int) -> bool:
    row = (
        db.query(Group.id)
        .join(Activity, Activity.group_id == Group.id)
        .join(Team, Team.activity_id == Activity.id)
        .filter(Team.id == team_id, Group.head_user_id == user_id)
        .first()
    )
    return row is not None


def get_team_members(db: Session, team_id: int, include_membership_id: bool = False):
    """
    List team members with id, username, role. For assignee dropdown etc.
    """
    rows = (
        db.query(TeamMember.id, User.id, User.username, User.designation, TeamMember.role, User.role)
        .join(TeamMember, User.id == TeamMember.user_id)
        .filter(TeamMember.team_id == team_id)
        .order_by(User.username)
        .all()
    )
    result = []
    for membership_id, user_id, username, designation, team_role, global_role in rows:
        if (global_role or "").lower() == "admin":
            continue
        item = {
            "id": user_id,
            "username": username,
            "designation": designation,
            "role": team_role,
            "global_role": global_role,
        }
        if include_membership_id:
            item["membership_id"] = membership_id
        result.append(item)
    return _sort_user_like_rows(result)


def get_team_member_user_ids(db: Session, team_id: int) -> List[int]:
    return [int(item["id"]) for item in get_team_members(db, team_id) if item.get("id") is not None]


def get_activity_team_ids(db: Session, activity_id: int) -> List[int]:
    rows = (
        db.query(Team.id)
        .filter(Team.activity_id == activity_id)
        .order_by(Team.id.asc())
        .all()
    )
    return [int(row[0]) for row in rows]


def get_activity_member_user_ids(db: Session, activity_id: int) -> List[int]:
    rows = (
        db.query(User.id)
        .join(TeamMember, TeamMember.user_id == User.id)
        .join(Team, Team.id == TeamMember.team_id)
        .filter(Team.activity_id == activity_id)
        .distinct()
        .order_by(User.id.asc())
        .all()
    )
    return [int(row[0]) for row in rows]


def can_user_manage_activity_scope(db: Session, user: Optional[User], activity: Optional[Activity]) -> bool:
    if not user or not activity:
        return False
    role = (user.role or "").lower()
    if role == "admin":
        return True
    if role == "division head":
        if not activity.group_id:
            return False
        group = db.query(Group).filter(Group.id == activity.group_id).first()
        return bool(group and group.division_id and db.query(Division.id).filter(Division.id == group.division_id, Division.head_user_id == user.id).first())
    if role == "group head":
        return bool(activity.group_id and db.query(Group.id).filter(Group.id == activity.group_id, Group.head_user_id == user.id).first())
    return False


def can_user_manage_team_scope(db: Session, user: Optional[User], team: Optional[Team]) -> bool:
    if not user or not team:
        return False
    if (user.role or "").lower() == "admin":
        return True
    if team.activity_id:
        activity = get_activity_by_id(db, team.activity_id)
        return can_user_manage_activity_scope(db, user, activity)
    return False


def get_visible_division_ids_for_role_scope(db: Session, user: Optional[User]) -> List[int]:
    if not user:
        return []
    role = (user.role or "").lower()
    if role == "admin":
        rows = db.query(Division.id).order_by(Division.id.asc()).all()
        return [int(row[0]) for row in rows]
    if role == "division head":
        rows = db.query(Division.id).filter(Division.head_user_id == user.id).order_by(Division.id.asc()).all()
        return [int(row[0]) for row in rows]
    if role == "group head":
        rows = (
            db.query(Group.division_id)
            .filter(Group.head_user_id == user.id)
            .distinct()
            .order_by(Group.division_id.asc())
            .all()
        )
        return [int(row[0]) for row in rows if row[0] is not None]
    return get_accessible_division_ids_for_user(db, user.id)


def can_user_assign_tasks_for_team(db: Session, user: Optional[User], team: Optional[Team]) -> bool:
    if not user or not team:
        return False
    if can_user_manage_team_scope(db, user, team):
        return True
    team_role = (get_user_role_in_team(db, user.id, team.id) or "").lower()
    return team_role in ("admin", "team lead", "project director")


def can_user_admin_task_scope(db: Session, user: Optional[User], team: Optional[Team]) -> bool:
    if not user or not team:
        return False
    if can_user_manage_team_scope(db, user, team):
        return True
    return (get_user_role_in_team(db, user.id, team.id) or "").lower() == "admin"


def update_user_role(db: Session, user_id: int, new_role: str):
    """
    Update a user's global role.
    """
    user = get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    valid_global_roles = tuple(value.lower() for value in get_allowed_role_values(db))
    if new_role.lower() not in valid_global_roles:
        raise HTTPException(status_code=400, detail="Invalid role")
    if new_role.lower() == "admin":
        existing_admin = db.query(User.id).filter(User.role == "admin", User.id != user_id).first()
        if existing_admin:
            raise HTTPException(status_code=400, detail="Only one global Admin account is allowed")
        
    user.role = new_role.lower()
    if user.role == "admin":
        user.designation = None
    db.commit()
    db.refresh(user)
    return user


def update_user_designation(db: Session, user_id: int, new_designation: str):
    user = get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if (user.role or "").lower() == "admin":
        user.designation = None
        db.commit()
        db.refresh(user)
        return user

    designation_value = (new_designation or "").strip()
    if designation_value not in get_allowed_designation_values(db):
        raise HTTPException(status_code=400, detail="Invalid designation")

    user.designation = designation_value
    db.commit()
    db.refresh(user)
    return user


def create_user_option(db: Session, option_type: str, value: str, created_by: Optional[int] = None):
    option_type_value = _normalize_option_value(option_type).lower()
    if option_type_value not in ("role", "designation"):
        raise HTTPException(status_code=400, detail="Invalid option type")

    clean_value = _normalize_option_value(value)
    if not clean_value:
        raise HTTPException(status_code=400, detail="Value cannot be empty")

    stored_value = clean_value if option_type_value == "designation" else _to_title_case_words(clean_value)
    existing = db.query(UserOption).filter(UserOption.value.ilike(stored_value)).first()
    if existing:
        raise HTTPException(status_code=400, detail="Option already exists")

    if option_type_value == "role" and stored_value.lower() == "admin":
        stored_value = "Admin"

    item = UserOption(
        option_type=option_type_value,
        value=stored_value,
        created_by=created_by,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def update_user_option(db: Session, option_id: int, value: str):
    item = db.query(UserOption).filter(UserOption.id == option_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Option not found")

    clean_value = _normalize_option_value(value)
    if not clean_value:
        raise HTTPException(status_code=400, detail="Value cannot be empty")

    stored_value = clean_value if item.option_type == "designation" else _to_title_case_words(clean_value)
    if item.option_type == "role" and stored_value.lower() == "admin":
        stored_value = "Admin"

    existing = (
        db.query(UserOption)
        .filter(UserOption.id != option_id)
        .filter(UserOption.value.ilike(stored_value))
        .first()
    )
    if existing:
        raise HTTPException(status_code=400, detail="Option already exists")

    if item.option_type == "role":
        old_role_value = (item.value or "").strip().lower()
        if old_role_value:
            assigned_user = db.query(User.id).filter(User.role == old_role_value).first()
            if assigned_user:
                raise HTTPException(status_code=400, detail="Cannot edit a role that is already assigned to a user")
    else:
        old_designation_value = (item.value or "").strip()
        if old_designation_value:
            assigned_user = db.query(User.id).filter(User.designation == old_designation_value).first()
            if assigned_user:
                raise HTTPException(status_code=400, detail="Cannot edit a designation that is already assigned to a user")

    item.value = stored_value
    db.commit()
    db.refresh(item)
    return item


def delete_user_option(db: Session, option_id: int):
    item = db.query(UserOption).filter(UserOption.id == option_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Option not found")

    if item.option_type == "role":
        role_value = (item.value or "").strip().lower()
        if role_value == "admin":
            raise HTTPException(status_code=400, detail="Admin role cannot be deleted")
        assigned_user = db.query(User.id).filter(User.role == role_value).first()
        if assigned_user:
            raise HTTPException(status_code=400, detail="Cannot delete a role that is already assigned to a user")
    elif item.option_type == "designation":
        designation_value = (item.value or "").strip()
        assigned_user = db.query(User.id).filter(User.designation == designation_value).first()
        if assigned_user:
            raise HTTPException(status_code=400, detail="Cannot delete a designation that is already assigned to a user")

    db.delete(item)
    db.commit()
    return {"message": "User option deleted"}


def get_holidays(db: Session):
    return db.query(Holiday).order_by(Holiday.holiday_date.asc()).all()


def create_holiday(db: Session, payload: HolidayCreate, created_by: Optional[int] = None):
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Holiday name is required")
    if get_holiday_by_date(db, payload.holiday_date):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Holiday already exists for this date")
    item = Holiday(
        name=name,
        holiday_date=payload.holiday_date,
        created_by=created_by,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def delete_holiday(db: Session, holiday_id: int):
    item = db.query(Holiday).filter(Holiday.id == holiday_id).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Holiday not found")
    db.delete(item)
    db.commit()
    return {"message": "Holiday deleted"}


def get_milestones(db: Session):
    return db.query(Milestone).order_by(Milestone.milestone_date.asc(), Milestone.id.asc()).all()


def create_milestone(db: Session, payload: MilestoneCreate, created_by: Optional[int] = None):
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Milestone name is required")
    dependency_payload = _validate_task_dependency_payload(db, payload)
    item = Milestone(
        name=name,
        milestone_date=payload.milestone_date,
        has_dependency=dependency_payload["has_dependency"],
        start_dependency_task_id=dependency_payload["start_dependency_task_id"],
        start_dependency_event=dependency_payload["start_dependency_event"],
        finish_dependency_task_id=dependency_payload["finish_dependency_task_id"],
        finish_dependency_event=dependency_payload["finish_dependency_event"],
        created_by=created_by,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def delete_milestone(db: Session, milestone_id: int):
    item = db.query(Milestone).filter(Milestone.id == milestone_id).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Milestone not found")
    db.delete(item)
    db.commit()
    return {"message": "Milestone deleted"}


def _create_username_change_notifications(db: Session, actor_user_id: int, old_username: str, new_username: str):
    recipients = (
        db.query(User.id)
        .all()
    )
    if not recipients:
        return

    message = f"{old_username} changed his name to {new_username}."
    db.add_all([
        Notification(
            user_id=row[0],
            message=message,
            is_read=0,
        )
        for row in recipients
    ])


def update_user_username(db: Session, user: User, new_username: str):
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    username_value = (new_username or "").strip()
    if not username_value:
        raise HTTPException(status_code=400, detail="Username is required")

    existing = get_user_by_username(db, username_value)
    if existing and existing.id != user.id:
        raise HTTPException(status_code=400, detail="Username already taken")

    if auth.verify_password(username_value, user.password):
        raise HTTPException(status_code=400, detail="Username must not be the same as password")

    old_username = (user.username or "").strip()
    if username_value == old_username:
        return user

    user.username = username_value
    db.flush()
    _create_username_change_notifications(db, user.id, old_username or "User", username_value)
    db.commit()
    db.refresh(user)
    return user


def get_notifications_for_user(db: Session, user_id: int, limit: int = 25):
    rows = (
        db.query(Notification)
        .filter(Notification.user_id == user_id)
        .order_by(Notification.created_at.desc(), Notification.id.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": row.id,
            "message": row.message,
            "is_read": bool(row.is_read),
            "created_at": row.created_at,
        }
        for row in rows
    ]


def get_unread_notification_count(db: Session, user_id: int) -> int:
    return (
        db.query(Notification)
        .filter(Notification.user_id == user_id, Notification.is_read == 0)
        .count()
    )


def mark_notifications_read(db: Session, user_id: int):
    updated = (
        db.query(Notification)
        .filter(Notification.user_id == user_id, Notification.is_read == 0)
        .update({Notification.is_read: 1}, synchronize_session=False)
    )
    db.commit()
    return updated


def delete_user_account(db: Session, user_id: int, current_user: User):
    """
    Permanently delete a user account.
    Admin-only action. Global admin account and self-delete are blocked.
    Related references are cleaned up or reassigned to keep hierarchy integrity.
    """
    if (current_user.role or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Only Admin can delete user accounts")

    user = get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account while signed in")

    if (user.role or "").lower() == "admin":
        raise HTTPException(status_code=400, detail="Global Admin account cannot be deleted")

    # Reassign non-null ownership/head fields to the acting admin.
    db.query(Division).filter(Division.created_by == user_id).update(
        {Division.created_by: current_user.id}, synchronize_session=False
    )
    db.query(Division).filter(Division.head_user_id == user_id).update(
        {Division.head_user_id: current_user.id}, synchronize_session=False
    )
    db.query(Group).filter(Group.created_by == user_id).update(
        {Group.created_by: current_user.id}, synchronize_session=False
    )
    db.query(Group).filter(Group.head_user_id == user_id).update(
        {Group.head_user_id: current_user.id}, synchronize_session=False
    )
    db.query(Team).filter(Team.created_by == user_id).update(
        {Team.created_by: current_user.id}, synchronize_session=False
    )
    db.query(Activity).filter(Activity.created_by == user_id).update(
        {Activity.created_by: current_user.id}, synchronize_session=False
    )
    db.query(Task).filter(Task.created_by == user_id).update(
        {Task.created_by: current_user.id}, synchronize_session=False
    )

    # Clear nullable references.
    db.query(Task).filter(Task.assigned_to == user_id).update(
        {Task.assigned_to: None}, synchronize_session=False
    )
    db.query(Task).filter(Task.lead_person_id == user_id).update(
        {Task.lead_person_id: None}, synchronize_session=False
    )
    db.query(Task).filter(Task.closure_approver_id == user_id).update(
        {Task.closure_approver_id: None}, synchronize_session=False
    )
    db.query(Task).filter(Task.type_approved_by == user_id).update(
        {Task.type_approved_by: None}, synchronize_session=False
    )
    db.query(ActivityMessage).filter(ActivityMessage.user_id == user_id).update(
        {ActivityMessage.user_id: None}, synchronize_session=False
    )
    db.query(TaskCompletionRequest).filter(TaskCompletionRequest.decided_by == user_id).update(
        {TaskCompletionRequest.decided_by: None}, synchronize_session=False
    )
    db.query(TaskExtensionRequest).filter(TaskExtensionRequest.requested_to == user_id).update(
        {TaskExtensionRequest.requested_to: None}, synchronize_session=False
    )
    db.query(TaskExtensionRequest).filter(TaskExtensionRequest.decided_by == user_id).update(
        {TaskExtensionRequest.decided_by: None}, synchronize_session=False
    )

    # Remove records that are owned by the user and can be safely dropped.
    db.query(TeamMember).filter(TeamMember.user_id == user_id).delete(synchronize_session=False)
    db.query(TeamInvitation).filter(TeamInvitation.user_id == user_id).delete(synchronize_session=False)
    db.query(TeamInvitation).filter(TeamInvitation.invited_by == user_id).delete(synchronize_session=False)
    db.query(TaskAssignment).filter(TaskAssignment.user_id == user_id).delete(synchronize_session=False)
    db.query(Comment).filter(Comment.user_id == user_id).delete(synchronize_session=False)
    db.query(ActivityLog).filter(ActivityLog.user_id == user_id).delete(synchronize_session=False)
    db.query(TaskCompletionRequest).filter(TaskCompletionRequest.submitted_by == user_id).delete(synchronize_session=False)
    db.query(TaskExtensionRequest).filter(TaskExtensionRequest.requested_by == user_id).delete(synchronize_session=False)

    db.delete(user)
    db.commit()

    logger.info("User %s deleted by admin %s", user_id, current_user.id)
    return {"message": "Account deleted successfully"}


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

    if (creator.role or "").lower() != "admin":
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

    activity_kind = (db_activity.type or "Activity").strip() or "Activity"
    log_activity(
        db,
        created_by,
        'Created ' + activity_kind.lower() + ' "' + (db_activity.name or "Untitled") + '"',
        "Activity",
        db_activity.id
    )

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
    if (user.role or "").lower() == "admin":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Global Admin cannot be added as a team member"
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


def set_user_team_role(db: Session, user_id: int, team_id: int, role: str = "Member"):
    user = get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User with ID {user_id} not found"
        )
    team = get_team_by_id(db, team_id)
    if not team:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Team with ID {team_id} not found"
        )
    valid_roles = ["Admin", "Member", "Division Head", "Project Director", "Group Head", "Team Lead"]
    if role not in valid_roles:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid role. Must be one of: {', '.join(valid_roles)}"
        )

    membership = db.query(TeamMember).filter(
        and_(TeamMember.user_id == user_id, TeamMember.team_id == team_id)
    ).first()

    if membership:
        membership.role = role
    else:
        membership = TeamMember(user_id=user_id, team_id=team_id, role=role)
        db.add(membership)

    db.commit()
    db.refresh(membership)
    return membership


def ensure_user_in_team_for_assignment(db: Session, user_id: int, team_id: int):
    if is_user_in_team(db, user_id, team_id):
        return
    add_user_to_team(db, user_id, team_id, "Member")


def get_user_teams(db: Session, user_id: int, approved_only: bool = True):
    """
    Get all teams a user belongs to with their role in each team.
    By default returns only approved teams (enterprise: hide pending until approved).
    """
    # Admin sees all approved teams. Other roles are scoped.
    user = get_user_by_id(db, user_id)
    user_role = (user.role or "").lower() if user else "member"

    if user_role == "admin":
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

    if user_role == "division head":
        division_ids = get_visible_division_ids_for_role_scope(db, user)
        if not division_ids:
            return []
        query = (
            db.query(Team)
            .join(Activity, Team.activity_id == Activity.id)
            .join(Group, Activity.group_id == Group.id)
            .filter(Group.division_id.in_(division_ids))
        )
        if approved_only:
            query = query.filter(Team.status == "approved")
        return [{
            "id": team.id,
            "name": team.name,
            "created_by": team.created_by,
            "created_at": team.created_at,
            "user_role": "Division Head"
        } for team in query.order_by(Team.name.asc()).all()]

    if user_role == "group head":
        query = (
            db.query(Team)
            .join(Activity, Team.activity_id == Activity.id)
            .join(Group, Activity.group_id == Group.id)
            .filter(Group.head_user_id == user_id)
        )
        if approved_only:
            query = query.filter(Team.status == "approved")
        return [{
            "id": team.id,
            "name": team.name,
            "created_by": team.created_by,
            "created_at": team.created_at,
            "user_role": "Group Head"
        } for team in query.order_by(Team.name.asc()).all()]

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
    return membership is not None or is_user_group_head_for_team(db, user_id, team_id)


def get_user_role_in_team(db: Session, user_id: int, team_id: int) -> str:
    """
    Get user's role in a team.
    Returns None if user is not in the team.
    """
    membership = db.query(TeamMember).filter(
        and_(TeamMember.user_id == user_id, TeamMember.team_id == team_id)
    ).first()
    if membership:
        return membership.role
    if is_user_group_head_for_team(db, user_id, team_id):
        return "Group Head"
    return None


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


ALLOWED_ACTIVITY_TYPES = [
    "Buildup",
    "Infrastructure Activity",
    "Project",
    "Feasibility Study",
    "Others",
]

ALLOWED_TASK_TYPES = [
    "Infrastructure Development",
    "Research and Development",
    "Fabrication",
    "Simulation",
    "Measurement",
    "Analysis",
    "Design",
    "Support Services",
    "Maintenance",
    "Visit & Exhibition",
    "Professional Upgradation",
    "Committees/Meetings/Lectures/Presentations",
    "Document/Report Preparation",
    "Procurement",
    "Others",
]


def resolve_catalog_value(selected_value: Optional[str], custom_value: Optional[str], allowed_values: List[str], field_name: str) -> str:
    selected = (selected_value or "").strip()
    custom = (custom_value or "").strip()
    if not selected:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"{field_name} is required")
    if selected == "Others":
        return custom or "Others"
    if selected not in allowed_values:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} must be one of: {', '.join(allowed_values)}",
        )
    return selected


def get_dashboard_stats(db: Session, current_user: User = None):
    if current_user and (current_user.role or "").lower() != "admin":
        role = (current_user.role or "").lower()
        division_ids = get_visible_division_ids_for_role_scope(db, current_user)
        group_ids = get_visible_group_ids_for_role_scope(db, current_user)
        team_ids = get_visible_team_ids_for_role_scope(db, current_user)

        if role == "division head":
            total_groups = db.query(Group).filter(Group.division_id.in_(division_ids)).count() if division_ids else 0
            total_activities = (
                db.query(Activity)
                .join(Group, Activity.group_id == Group.id)
                .filter(Group.division_id.in_(division_ids))
                .count()
            ) if division_ids else 0
            total_teams = len(team_ids)
            total_tasks = (
                db.query(Task)
                .join(Activity, Task.activity_id == Activity.id, isouter=True)
                .join(Group, Activity.group_id == Group.id, isouter=True)
                .filter(Group.division_id.in_(division_ids))
                .count()
            ) if division_ids else 0
        elif role == "group head":
            total_groups = len(group_ids)
            total_activities = db.query(Activity).filter(Activity.group_id.in_(group_ids)).count() if group_ids else 0
            total_teams = len(team_ids)
            total_tasks = (
                db.query(Task)
                .join(Activity, Task.activity_id == Activity.id, isouter=True)
                .filter(Activity.group_id.in_(group_ids))
                .count()
            ) if group_ids else 0
        else:
            total_groups = len(group_ids)
            total_activities = (
                db.query(Activity.id)
                .join(Team, Team.activity_id == Activity.id)
                .filter(Team.id.in_(team_ids))
                .distinct()
                .count()
            ) if team_ids else 0
            total_teams = len(team_ids)
            total_tasks = (
                db.query(Task)
                .filter(Task.team_id.in_(team_ids))
                .count()
            ) if team_ids else 0

        total_members = (
            db.query(TeamMember.user_id)
            .filter(TeamMember.team_id.in_(team_ids))
            .distinct()
            .count()
        ) if team_ids else 0

        return {
            "total_users": total_members,
            "total_divisions": len(division_ids),
            "total_groups": total_groups,
            "total_activities": total_activities,
            "total_teams": total_teams,
            "total_tasks": total_tasks,
            "total_members": total_members,
        }

    return {
        "total_users": db.query(User).count(),
        "total_divisions": db.query(Division).count(),
        "total_groups": db.query(Group).count(),
        "total_activities": db.query(Activity).count(),
        "total_teams": db.query(Team).count(),
        "total_tasks": db.query(Task).count(),
        "total_members": db.query(TeamMember.user_id).distinct().count(),
    }


def create_division(db: Session, name: str, created_by: int, head_user_id: Optional[int] = None):
    resolved_head_user_id = head_user_id or created_by
    head_user = get_user_by_id(db, resolved_head_user_id)
    if not head_user:
        raise HTTPException(status_code=404, detail="Selected division head user not found")
    division = Division(name=name.strip(), created_by=created_by, head_user_id=resolved_head_user_id)
    db.add(division)
    if (head_user.role or "").lower() != "admin":
        head_user.role = "division head"
    db.commit()
    db.refresh(division)
    return division


def assign_division_head(db: Session, division_id: int, user_id: int):
    division = db.query(Division).filter(Division.id == division_id).first()
    if not division:
        raise HTTPException(status_code=404, detail="Division not found")
    user = get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    division.head_user_id = user_id
    if (user.role or "").lower() != "admin":
        user.role = "division head"
    db.commit()
    db.refresh(division)
    return division


def update_division_name(db: Session, division_id: int, name: str):
    division = db.query(Division).filter(Division.id == division_id).first()
    if not division:
        raise HTTPException(status_code=404, detail="Division not found")
    division.name = name.strip()
    db.commit()
    db.refresh(division)
    return division


def list_divisions(db: Session):
    return db.query(Division).order_by(Division.name.asc()).all()


def create_group(db: Session, division_id: int, name: str, created_by: int, head_user_id: Optional[int] = None):
    division = db.query(Division).filter(Division.id == division_id).first()
    if not division:
        raise HTTPException(status_code=404, detail="Division not found")
    resolved_head_user_id = head_user_id or created_by
    head_user = get_user_by_id(db, resolved_head_user_id)
    if not head_user:
        raise HTTPException(status_code=404, detail="Selected group head user not found")
    group = Group(
        division_id=division_id,
        name=name.strip(),
        created_by=created_by,
        head_user_id=resolved_head_user_id,
    )
    db.add(group)
    if (head_user.role or "").lower() == "member":
        head_user.role = "group head"
    db.commit()
    db.refresh(group)
    return group


def assign_group_head(db: Session, group_id: int, user_id: int):
    group = db.query(Group).filter(Group.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    user = get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    group.head_user_id = user_id
    if (user.role or "").lower() == "member":
        user.role = "group head"
    db.commit()
    db.refresh(group)
    return group


def list_groups_for_division(db: Session, division_id: int):
    return db.query(Group).filter(Group.division_id == division_id).order_by(Group.name.asc()).all()


def update_group_name(db: Session, group_id: int, name: str):
    group = db.query(Group).filter(Group.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    group.name = name.strip()
    db.commit()
    db.refresh(group)
    return group


def create_activity_under_group(db: Session, group_id: int, name: str, created_by: int, activity_type: str = "Project", custom_type: Optional[str] = None):
    group = db.query(Group).filter(Group.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    type_value = resolve_catalog_value(activity_type, custom_type, ALLOWED_ACTIVITY_TYPES, "activity_type")
    activity = Activity(
        group_id=group_id,
        name=name.strip(),
        type=type_value,
        created_by=created_by,
    )
    db.add(activity)
    db.commit()
    db.refresh(activity)
    activity_kind = (activity.type or "Activity").strip() or "Activity"
    log_activity(
        db,
        created_by,
        'Created ' + activity_kind.lower() + ' "' + (activity.name or "Untitled") + '"',
        "Activity",
        activity.id
    )
    return activity


def list_activities_for_group(db: Session, group_id: int):
    return db.query(Activity).filter(Activity.group_id == group_id).order_by(Activity.name.asc()).all()


def update_activity_name(db: Session, activity_id: int, name: str):
    activity = db.query(Activity).filter(Activity.id == activity_id).first()
    if not activity:
        raise HTTPException(status_code=404, detail="Activity not found")
    activity.name = name.strip()
    db.commit()
    db.refresh(activity)
    return activity


def create_team_under_activity(db: Session, activity_id: int, name: str, created_by: int):
    activity = db.query(Activity).filter(Activity.id == activity_id).first()
    if not activity:
        raise HTTPException(status_code=404, detail="Activity not found")
    team = Team(name=name.strip(), created_by=created_by, activity_id=activity_id, status="approved")
    db.add(team)
    db.commit()
    db.refresh(team)
    activity_name = activity.name or "Untitled"
    log_activity(
        db,
        created_by,
        'Created team "' + (team.name or "Untitled") + '" under "' + activity_name + '"',
        "Team",
        team.id
    )
    return team


def list_teams_for_activity(db: Session, activity_id: int):
    return db.query(Team).filter(Team.activity_id == activity_id).order_by(Team.name.asc()).all()


def update_team_name(db: Session, team_id: int, name: str):
    team = db.query(Team).filter(Team.id == team_id).first()
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    team.name = name.strip()
    db.commit()
    db.refresh(team)
    return team


def get_nav_tree(db: Session, requester: Optional[User] = None):
    query = (
        db.query(Division)
        .options(
            joinedload(Division.groups)
            .joinedload(Group.activities)
            .joinedload(Activity.teams)
        )
        .order_by(Division.name.asc())
    )

    requester_role = (requester.role or "").lower() if requester else ""
    visible_division_ids = []
    visible_group_ids = []
    visible_team_ids = []

    if requester and requester_role != "admin":
        visible_division_ids = get_visible_division_ids_for_role_scope(db, requester)
        visible_group_ids = get_visible_group_ids_for_role_scope(db, requester)
        visible_team_ids = get_visible_team_ids_for_role_scope(db, requester)
        division_ids = visible_division_ids
        if not division_ids:
            return []
        query = query.filter(Division.id.in_(division_ids))

    divisions = query.all()
    tree = []
    for division in divisions:
        division_node = {"id": division.id, "name": division.name, "head_user_id": division.head_user_id, "groups": []}
        for group in sorted(division.groups or [], key=lambda item: (item.name or "").lower()):
            if requester and requester_role == "group head" and group.id not in visible_group_ids:
                continue
            group_node = {"id": group.id, "name": group.name, "head_user_id": group.head_user_id, "activities": []}
            for activity in sorted(group.activities or [], key=lambda item: (item.name or "").lower()):
                teams = [
                    {"id": team.id, "name": team.name}
                    for team in sorted(activity.teams or [], key=lambda item: (item.name or "").lower())
                    if not requester or requester_role in ("admin", "division head", "group head") or team.id in visible_team_ids
                ]
                if requester and requester_role not in ("admin", "division head", "group head") and not teams:
                    continue
                group_node["activities"].append({"id": activity.id, "name": activity.name, "type": activity.type, "teams": teams})
            if requester and requester_role not in ("admin", "division head") and not group_node["activities"]:
                continue
            division_node["groups"].append(group_node)
        if requester and requester_role not in ("admin", "division head") and not division_node["groups"]:
            continue
        tree.append(division_node)
    return tree


# ------------------------------------------------------------------
# TASK CRUD OPERATIONS
# ------------------------------------------------------------------

def _validate_task_dependency_payload(
    db: Session,
    task_obj,
    *,
    current_task_id: Optional[int] = None,
):
    has_dependency = bool(getattr(task_obj, "has_dependency", False))
    start_dep_id = getattr(task_obj, "start_dependency_task_id", None)
    start_event = _normalize_dependency_event(getattr(task_obj, "start_dependency_event", None))
    start_offset_days = getattr(task_obj, "start_dependency_offset_days", None)
    finish_dep_id = getattr(task_obj, "finish_dependency_task_id", None)
    finish_event = _normalize_dependency_event(getattr(task_obj, "finish_dependency_event", None))
    finish_offset_days = getattr(task_obj, "finish_dependency_offset_days", None)

    if start_offset_days is not None:
        start_offset_days = int(start_offset_days)
        if start_offset_days < 0:
            raise HTTPException(status_code=400, detail="Start dependency offset must be 0 or greater")
    if finish_offset_days is not None:
        finish_offset_days = int(finish_offset_days)
        if finish_offset_days < 0:
            raise HTTPException(status_code=400, detail="Finish dependency offset must be 0 or greater")

    if not has_dependency and not start_dep_id and not finish_dep_id:
        return {
            "has_dependency": 0,
            "start_dependency_task_id": None,
            "start_dependency_event": None,
            "start_dependency_offset_days": None,
            "finish_dependency_task_id": None,
            "finish_dependency_event": None,
            "finish_dependency_offset_days": None,
        }

    if start_dep_id and not start_event:
        raise HTTPException(status_code=400, detail="Start dependency event must be 'start' or 'finish'")
    if finish_dep_id and not finish_event:
        raise HTTPException(status_code=400, detail="Finish dependency event must be 'start' or 'finish'")

    if not start_dep_id and not finish_dep_id:
        raise HTTPException(status_code=400, detail="Select at least one dependency task when dependency is enabled")

    dep_ids = []
    if start_dep_id:
        dep_ids.append(int(start_dep_id))
    if finish_dep_id:
        dep_ids.append(int(finish_dep_id))

    for dep_id in dep_ids:
        if current_task_id and dep_id == current_task_id:
            raise HTTPException(status_code=400, detail="A task cannot depend on itself")
        dep_task = get_task_by_id(db, dep_id)
        if not dep_task:
            raise HTTPException(status_code=404, detail=f"Dependency task {dep_id} not found")

    return {
        "has_dependency": 1,
        "start_dependency_task_id": int(start_dep_id) if start_dep_id else None,
        "start_dependency_event": start_event if start_dep_id else None,
        "start_dependency_offset_days": start_offset_days if start_dep_id else None,
        "finish_dependency_task_id": int(finish_dep_id) if finish_dep_id else None,
        "finish_dependency_event": finish_event if finish_dep_id else None,
        "finish_dependency_offset_days": finish_offset_days if finish_dep_id else None,
    }


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

    task_type_val = resolve_catalog_value(
        getattr(task, "task_type", None) or "Infrastructure Development",
        getattr(task, "custom_type", None),
        ALLOWED_TASK_TYPES,
        "task_type",
    )
    
    # Decide team/activity based on new hierarchy while staying backward compatible.
    activity = None
    team = None

    parent_task = None
    if task.parent_task_id is not None:
        parent_task = get_task_by_id(db, task.parent_task_id)
        if not parent_task:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Parent task not found",
            )
        team = get_team_by_id(db, parent_task.team_id)
        activity = get_activity_by_id(db, parent_task.activity_id) if parent_task.activity_id else None
    elif task.activity_id is not None:
        # Preferred: activity-driven tasks
        activity = get_activity_by_id(db, task.activity_id)
        if not activity:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Activity with ID {task.activity_id} not found"
            )
        if task.team_id is not None:
            team = get_team_by_id(db, task.team_id)
            if not team:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Team with ID {task.team_id} not found"
                )
            if team.activity_id != activity.id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Selected team does not belong to the selected activity"
                )
        elif activity.team_id:
            team = get_team_by_id(db, activity.team_id)
        else:
            team = (
                db.query(Team)
                .filter(Team.activity_id == activity.id)
                .order_by(Team.id.asc())
                .first()
            )
            if not team:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Select a team before creating a task for this activity"
                )
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

    if not team:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unable to resolve team for task creation"
        )
    
    # Validate creator is a member of the team OR global admin
    allowed_globals = ["admin", "division head"]
    is_global = (creator_role in allowed_globals)
    has_hierarchy_scope_access = can_user_manage_team_scope(db, creator, team) or can_user_manage_activity_scope(db, creator, activity)

    if not is_global and not has_hierarchy_scope_access and not is_user_in_team(db, created_by, team.id):
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

    task_schedule_type = (getattr(task, "task_schedule_type", None) or "").strip()
    if task_schedule_type == "Ongoing":
        task.due_date = None
    elif task_schedule_type == "Time Bound":
        if task.due_date is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="due_date is required for Time Bound tasks")
        validate_due_date_not_holiday(db, task.due_date)
    tentative_start_date_val, tentative_completion_date_val, tentative_duration_days_val = _resolve_tentative_schedule_fields(
        getattr(task, "tentative_start_date", None),
        getattr(task, "tentative_completion_date", None),
        getattr(task, "tentative_duration_days", None),
    )
    if task_schedule_type == "Ongoing":
        if tentative_start_date_val is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="tentative_start_date is required for Ongoing tasks")
        if tentative_completion_date_val is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="tentative_completion_date is required for Ongoing tasks")

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
            if parent_task is not None and creator_role in allowed_globals:
                ensure_user_in_team_for_assignment(db, task.assigned_to, team.id)
            else:
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

    requested_assignment_scope = (getattr(task, "assignment_scope", None) or "individual").strip().lower()
    if requested_assignment_scope not in ("individual", "team", "activity"):
        requested_assignment_scope = "individual"

    # Multi-assign: global Admin/Division Head OR team role Project Director/Group Head/Team Lead (in this task's team)
    privileged_roles = ["admin", "division head", "group head", "team lead", "project director"]
    creator_effective_role = creator_role
    if creator_effective_role not in privileged_roles:
        team_role = get_user_role_in_team(db, created_by, team.id)
        if team_role:
            team_role_lower = team_role.lower()
            if team_role_lower in ("project director", "group head", "team lead"):
                creator_effective_role = team_role_lower
    scoped_assignment_roles = ["admin", "division head", "group head"]
    if requested_assignment_scope in ("team", "activity") and creator_effective_role not in scoped_assignment_roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Admin, Division Head, or Group Head can assign a task to a whole team or activity/project",
        )

    if requested_assignment_scope == "team" and not can_user_manage_team_scope(db, creator, team):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can assign to a whole team only inside your allowed hierarchy scope",
        )

    if requested_assignment_scope == "activity":
        if not activity:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Select an activity/project before assigning a task to the whole activity/project",
            )
        if not can_user_manage_activity_scope(db, creator, activity):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You can assign to a whole activity/project only inside your allowed hierarchy scope",
            )

    use_multi_assign = (
        getattr(task, "assignments", None)
        and len(task.assignments) > 0
        and creator_effective_role in privileged_roles
        and requested_assignment_scope == "individual"
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

    if parent_task is not None and assigned_to_val is None:
        assigned_to_val = parent_task.assigned_to

    if requested_assignment_scope == "team":
        team_user_ids = get_team_member_user_ids(db, team.id)
        if not team_user_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot assign to the whole team because this team has no members",
            )
        assignments_to_create = [(uid, None, False) for uid in team_user_ids]
        assigned_to_val = team_user_ids[0]
        lead_person_id_val = None
        percent_share_val = None
        use_multi_assign = False

    if requested_assignment_scope == "activity":
        activity_team_ids = get_activity_team_ids(db, activity.id if activity else None)
        if not activity_team_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot assign to the whole activity/project because it has no teams",
            )
        activity_user_ids = get_activity_member_user_ids(db, activity.id)
        if not activity_user_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot assign to the whole activity/project because it has no team members",
            )
        if not team or team.id not in activity_team_ids:
            team = get_team_by_id(db, activity_team_ids[0])
        assignments_to_create = [(uid, None, False) for uid in activity_user_ids]
        assigned_to_val = activity_user_ids[0]
        lead_person_id_val = None
        percent_share_val = None
        use_multi_assign = False

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
                if parent_task is not None and creator_role in allowed_globals:
                    ensure_user_in_team_for_assignment(db, uid, team.id)
                else:
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

    # Task type approval: privileged roles create any type directly; members need approval for Procurement
    type_approval_status_val = "not_required"
    if creator_effective_role not in privileged_roles:
        if task_type_val == "Procurement":
            type_approval_status_val = "pending"

    dependency_payload = _validate_task_dependency_payload(db, task)

    db_task = Task(
        title=task.title,
        description=task.description,
        team_id=team.id,
        activity_id=activity.id if activity else None,
        parent_task_id=task.parent_task_id,
        assigned_to=assigned_to_val,
        due_date=task.due_date,
        tentative_start_date=tentative_start_date_val,
        tentative_completion_date=tentative_completion_date_val,
        tentative_duration_days=tentative_duration_days_val,
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
        has_dependency=dependency_payload["has_dependency"],
        start_dependency_task_id=dependency_payload["start_dependency_task_id"],
        start_dependency_event=dependency_payload["start_dependency_event"],
        start_dependency_offset_days=dependency_payload["start_dependency_offset_days"],
        finish_dependency_task_id=dependency_payload["finish_dependency_task_id"],
        finish_dependency_event=dependency_payload["finish_dependency_event"],
        finish_dependency_offset_days=dependency_payload["finish_dependency_offset_days"],
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
                "designation": a.user.designation if a.user else None,
                "percent_share": a.percent_share,
                "is_lead": bool(a.is_lead),
            })
    assignment_scope_label = None
    assignment_team_count = None
    if requested_assignment_scope == "activity" and activity_obj:
        assignment_scope_label = f'Whole {("Project" if str(activity_obj.type or "").strip().lower() == "project" else "Activity")}'
        assignment_team_count = len(get_activity_team_ids(db, activity_obj.id))
    elif requested_assignment_scope == "team":
        assignment_scope_label = "Whole team"
        assignment_team_count = 1
    dependency_state = get_task_dependency_state(db, db_task)
    task_dict = {
        "id": db_task.id,
        "title": db_task.title,
        "description": db_task.description,
        "status": db_task.status,
        "priority": db_task.priority,
        "task_schedule_type": _resolve_task_schedule_type(db_task),
        "due_date": db_task.due_date,
        "tentative_start_date": getattr(db_task, "tentative_start_date", None),
        "tentative_completion_date": getattr(db_task, "tentative_completion_date", None) or _derive_tentative_completion_date(
            getattr(db_task, "tentative_start_date", None),
            getattr(db_task, "tentative_duration_days", None),
        ),
        "tentative_duration_days": getattr(db_task, "tentative_duration_days", None),
        "assigned_to": db_task.assigned_to,
        "assigned_username": assignee.username if assignee else None,
        "assigned_designation": assignee.designation if assignee else None,
        "assignees": assignees_list if assignees_list else None,
        "assignment_scope_type": requested_assignment_scope if requested_assignment_scope in ("team", "activity") else None,
        "assignment_scope_label": assignment_scope_label,
        "assignment_member_count": len(assignees_list) if assignees_list else 0,
        "assignment_team_count": assignment_team_count,
        "team_id": db_task.team_id,
        "team_name": team_obj.name if team_obj else None,
        "activity_id": db_task.activity_id,
        "activity_name": activity_obj.name if activity_obj else None,
        "activity_type": activity_obj.type if activity_obj else None,
        "created_by": db_task.created_by,
        "created_at": db_task.created_at,
        "updated_at": db_task.updated_at,
        "started_at": getattr(db_task, "started_at", None),
        "is_approved": bool(db_task.is_approved),
        "lead_person_id": db_task.lead_person_id,
        "lead_person_username": db_task.lead_person.username if db_task.lead_person else None,
        "lead_person_designation": db_task.lead_person.designation if db_task.lead_person else None,
        "percent_share": db_task.percent_share,
        "closure_approver_id": db_task.closure_approver_id,
        "closure_approver_username": db_task.closure_approver.username if db_task.closure_approver else None,
        "closure_approver_designation": db_task.closure_approver.designation if db_task.closure_approver else None,
        "task_type": db_task.task_type or "Infrastructure Development",
        "type_approval_status": db_task.type_approval_status or "not_required",
        "type_approved_by": db_task.type_approved_by,
        "type_approved_at": db_task.type_approved_at,
        "type_approved_by_username": None,
        "type_approved_by_designation": None,
        "can_approve_type": None,
        "procurement_stage": getattr(db_task, "procurement_stage", None),
        "has_dependency": bool(dependency_state.get("has_dependency")),
        "start_dependency_task_id": dependency_state.get("start_dependency_task_id"),
        "start_dependency_event": dependency_state.get("start_dependency_event"),
        "finish_dependency_task_id": dependency_state.get("finish_dependency_task_id"),
        "finish_dependency_event": dependency_state.get("finish_dependency_event"),
        "dependency_start_locked": bool(dependency_state.get("dependency_start_locked")),
        "dependency_finish_locked": bool(dependency_state.get("dependency_finish_locked")),
        "dependency_lock_active": bool(dependency_state.get("dependency_lock_active")),
        "dependency_lock_message": dependency_state.get("dependency_lock_message"),
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
    selected_team = get_team_by_id(db, team_id) if team_id else None

    # Admin sees all tasks. Scoped roles are restricted to their allowed hierarchy/team scope.
    if current_user and (current_user.role or "").lower() != "admin":
        user_role = (current_user.role or "").lower()
        if user_role == "division head":
            division_ids = get_visible_division_ids_for_role_scope(db, current_user)
            if not division_ids:
                query = query.filter(Task.team_id == -1)
            else:
                query = (
                    query.join(Activity, Task.activity_id == Activity.id, isouter=True)
                    .join(Group, Activity.group_id == Group.id, isouter=True)
                    .filter(Group.division_id.in_(division_ids))
                )
        elif user_role == "group head":
            group_ids = get_visible_group_ids_for_role_scope(db, current_user)
            if not group_ids:
                query = query.filter(Task.team_id == -1)
            else:
                query = (
                    query.join(Activity, Task.activity_id == Activity.id, isouter=True)
                    .filter(Activity.group_id.in_(group_ids))
                )
        else:
            user_team_ids = get_visible_team_ids_for_role_scope(db, current_user)
            assigned_task_ids = [
                row[0] for row in
                db.query(TaskAssignment.task_id)
                .filter(TaskAssignment.user_id == current_user.id)
                .distinct().all()
            ]
            if user_team_ids:
                visibility_filters = [Task.team_id.in_(user_team_ids)]
                if assigned_task_ids:
                    visibility_filters.append(Task.id.in_(assigned_task_ids))
                if current_user.id:
                    visibility_filters.append(Task.assigned_to == current_user.id)
                query = query.filter(or_(*visibility_filters))
            elif assigned_task_ids:
                query = query.filter(or_(Task.id.in_(assigned_task_ids), Task.assigned_to == current_user.id))
            else:
                query = query.filter(Task.team_id == -1)  # no teams -> no tasks

    if team_id:
        if selected_team and selected_team.activity_id:
            query = query.filter(or_(Task.team_id == team_id, Task.activity_id == selected_team.activity_id))
        else:
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
            db.query(TaskExtensionRequest, User.username, User.designation)
            .join(User, TaskExtensionRequest.requested_by == User.id)
            .filter(TaskExtensionRequest.task_id.in_(task_ids))
            .order_by(
                TaskExtensionRequest.task_id.asc(),
                TaskExtensionRequest.created_at.desc(),
                TaskExtensionRequest.id.desc(),
            )
            .all()
        )
        for ext, uname, designation in rows:
            if ext.task_id not in latest_ext_by_task:
                latest_ext_by_task[ext.task_id] = (ext, uname, designation)

    # Preload latest completion request (if any) for all tasks
    latest_comp_by_task = {}
    if task_ids:
        comp_rows = (
            db.query(TaskCompletionRequest, User.username, User.designation)
            .join(User, TaskCompletionRequest.submitted_by == User.id)
            .filter(TaskCompletionRequest.task_id.in_(task_ids))
            .order_by(
                TaskCompletionRequest.task_id.asc(),
                TaskCompletionRequest.created_at.desc(),
                TaskCompletionRequest.id.desc(),
            )
            .all()
        )
        for comp, uname, designation in comp_rows:
            if comp.task_id not in latest_comp_by_task:
                latest_comp_by_task[comp.task_id] = (comp, uname, designation)

    # Convert to dict and add username, team and activity details
    result = []
    cleanup_needed = False
    team_member_ids_cache = {}
    activity_member_ids_cache = {}
    activity_team_ids_cache = {}
    dep_task_cache = {}
    for task in tasks:
        ext = latest_ext_by_task.get(task.id)
        ext_obj = ext[0] if ext else None
        ext_username = ext[1] if ext else None
        ext_designation = ext[2] if ext else None

        comp = latest_comp_by_task.get(task.id)
        comp_obj = comp[0] if comp else None
        comp_username = comp[1] if comp else None
        comp_designation = comp[2] if comp else None

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

        valid_assignments = []
        stale_assignment_rows = []
        activity_scope_user_ids = None
        if task.activity_id:
            activity_scope_user_ids = activity_member_ids_cache.get(task.activity_id)
            if activity_scope_user_ids is None:
                activity_scope_user_ids = sorted(set(get_activity_member_user_ids(db, task.activity_id)))
                activity_member_ids_cache[task.activity_id] = activity_scope_user_ids
        if task.assignments:
            for assignment in task.assignments:
                in_scope = (
                    assignment.user_id is not None
                    and (
                        is_user_in_team(db, assignment.user_id, task.team_id)
                        or (activity_scope_user_ids and assignment.user_id in activity_scope_user_ids)
                    )
                )
                if in_scope:
                    valid_assignments.append(assignment)
                else:
                    stale_assignment_rows.append(assignment)

        if stale_assignment_rows:
            cleanup_needed = True
            for stale_assignment in stale_assignment_rows:
                db.delete(stale_assignment)

        lead_assignment = next((assignment for assignment in valid_assignments if bool(getattr(assignment, "is_lead", False))), None)
        fallback_assignment = lead_assignment or (valid_assignments[0] if valid_assignments else None)

        # If assignee is no longer in the task's team (e.g. removed from team), recover from
        # a remaining valid assignment or treat the task as unassigned.
        assigned_to_val = task.assigned_to
        assigned_username_val = task.assignee.username if task.assignee else None
        assigned_designation_val = task.assignee.designation if task.assignee else None
        if assigned_to_val is not None and not (
            is_user_in_team(db, assigned_to_val, task.team_id)
            or (activity_scope_user_ids and assigned_to_val in activity_scope_user_ids)
        ):
            cleanup_needed = True
            task.assigned_to = fallback_assignment.user_id if fallback_assignment else None
            assigned_to_val = task.assigned_to
            assigned_username_val = fallback_assignment.user.username if fallback_assignment and fallback_assignment.user else None
            assigned_designation_val = fallback_assignment.user.designation if fallback_assignment and fallback_assignment.user else None

        if task.lead_person_id is not None and not (
            is_user_in_team(db, task.lead_person_id, task.team_id)
            or (activity_scope_user_ids and task.lead_person_id in activity_scope_user_ids)
        ):
            cleanup_needed = True
            task.lead_person_id = lead_assignment.user_id if lead_assignment else None

        assignees_list = []
        if valid_assignments:
            for a in valid_assignments:
                assignees_list.append({
                    "user_id": a.user_id,
                    "username": a.user.username if a.user else None,
                    "designation": a.user.designation if a.user else None,
                    "percent_share": a.percent_share,
                    "is_lead": bool(a.is_lead),
                })

        assignment_scope_type = None
        assignment_scope_label = None
        assignment_member_count = len(assignees_list) if assignees_list else 0
        assignment_team_count = None
        assignee_user_ids = sorted({int(a["user_id"]) for a in assignees_list if a.get("user_id") is not None})
        if assignee_user_ids:
            team_user_ids = team_member_ids_cache.get(task.team_id)
            if team_user_ids is None:
                team_user_ids = sorted(set(get_team_member_user_ids(db, task.team_id)))
                team_member_ids_cache[task.team_id] = team_user_ids
            if task.activity_id:
                activity_user_ids = activity_member_ids_cache.get(task.activity_id)
                if activity_user_ids is None:
                    activity_user_ids = sorted(set(get_activity_member_user_ids(db, task.activity_id)))
                    activity_member_ids_cache[task.activity_id] = activity_user_ids
                activity_team_ids = activity_team_ids_cache.get(task.activity_id)
                if activity_team_ids is None:
                    activity_team_ids = get_activity_team_ids(db, task.activity_id)
                    activity_team_ids_cache[task.activity_id] = activity_team_ids
                if (
                    activity_user_ids
                    and assignee_user_ids == activity_user_ids
                    and len(activity_team_ids) > 1
                ):
                    assignment_scope_type = "activity"
                    assignment_scope_label = f'Whole {("Project" if str(task.activity.type or "").strip().lower() == "project" else "Activity")}' if task.activity else "Whole Activity"
                    assignment_team_count = len(activity_team_ids)
                elif team_user_ids and assignee_user_ids == team_user_ids:
                    assignment_scope_type = "team"
                    assignment_scope_label = "Whole team"
                    assignment_team_count = 1
            elif team_user_ids and assignee_user_ids == team_user_ids:
                assignment_scope_type = "team"
                assignment_scope_label = "Whole team"
                assignment_team_count = 1

        dependency_state = get_task_dependency_state(db, task, dep_task_cache)

        task_dict = {
            "id": task.id,
            "title": task.title,
            "description": task.description,
            "status": task.status,
            "priority": task.priority,
            "task_schedule_type": _resolve_task_schedule_type(task),
            "due_date": task.due_date,
            "tentative_start_date": getattr(task, "tentative_start_date", None),
            "tentative_completion_date": getattr(task, "tentative_completion_date", None) or _derive_tentative_completion_date(
                getattr(task, "tentative_start_date", None),
                getattr(task, "tentative_duration_days", None),
            ),
            "tentative_duration_days": getattr(task, "tentative_duration_days", None),
            "assigned_to": assigned_to_val,
            "assigned_username": assigned_username_val,
            "assigned_designation": assigned_designation_val,
            "assignees": assignees_list if assignees_list else None,
            "assignment_scope_type": assignment_scope_type,
            "assignment_scope_label": assignment_scope_label,
            "assignment_member_count": assignment_member_count,
            "assignment_team_count": assignment_team_count,
            "team_id": task.team_id,
            "team_name": task.team.name if task.team else None,
            "activity_id": task.activity_id,
            "parent_task_id": getattr(task, "parent_task_id", None),
            "activity_name": task.activity.name if task.activity else None,
            "activity_type": task.activity.type if task.activity else None,
            "created_by": task.created_by,
            "created_at": task.created_at,
            "updated_at": task.updated_at,
            "started_at": getattr(task, "started_at", None),
            "extension_request_id": ext_obj.id if ext_obj else None,
            "extension_status": ext_obj.status if ext_obj else None,
            "extension_requested_due_date": ext_obj.requested_due_date if ext_obj else None,
            "extension_requested_by": ext_obj.requested_by if ext_obj else None,
            "extension_requested_by_username": ext_username,
            "extension_requested_by_designation": ext_designation,
            "extension_reason": ext_obj.reason if ext_obj else None,
            "completion_request_id": comp_obj.id if comp_obj else None,
            "completion_status": comp_obj.status if comp_obj else None,
            "completion_submitted_by": comp_obj.submitted_by if comp_obj else None,
            "completion_submitted_by_username": comp_username,
            "completion_submitted_by_designation": comp_designation,
            "completion_attachment_filename": comp_obj.attachment_filename if comp_obj else None,
            "can_approve_completion": can_approve_completion,
            "task_type": getattr(task, "task_type", None) or "Infrastructure Development",
            "type_approval_status": getattr(task, "type_approval_status", None) or "not_required",
            "type_approved_by": getattr(task, "type_approved_by", None),
            "type_approved_at": getattr(task, "type_approved_at", None),
            "type_approved_by_username": task.type_approver.username if getattr(task, "type_approver", None) else None,
            "type_approved_by_designation": task.type_approver.designation if getattr(task, "type_approver", None) else None,
            "can_approve_type": can_approve_type,
            "procurement_stage": getattr(task, "procurement_stage", None),
            "has_dependency": bool(dependency_state.get("has_dependency")),
            "start_dependency_task_id": dependency_state.get("start_dependency_task_id"),
            "start_dependency_event": dependency_state.get("start_dependency_event"),
            "start_dependency_offset_days": dependency_state.get("start_dependency_offset_days"),
            "finish_dependency_task_id": dependency_state.get("finish_dependency_task_id"),
            "finish_dependency_event": dependency_state.get("finish_dependency_event"),
            "finish_dependency_offset_days": dependency_state.get("finish_dependency_offset_days"),
            "dependency_start_locked": bool(dependency_state.get("dependency_start_locked")),
            "dependency_finish_locked": bool(dependency_state.get("dependency_finish_locked")),
            "dependency_lock_active": bool(dependency_state.get("dependency_lock_active")),
            "dependency_lock_message": dependency_state.get("dependency_lock_message"),
        }
        task_dict["subtasks"] = []
        result.append(task_dict)

    if team_id and selected_team and selected_team.activity_id:
        result = [
            task_dict for task_dict in result
            if (
                task_dict.get("team_id") == team_id
                or (
                    task_dict.get("activity_id") == selected_team.activity_id
                    and task_dict.get("assignment_scope_type") == "activity"
                )
            )
        ]

    task_dict_map = {t["id"]: t for t in result}
    final_result = []
    for task_dict in result:
        parent_id = task_dict.get("parent_task_id")
        if parent_id and parent_id in task_dict_map:
            task_dict_map[parent_id]["subtasks"].append(task_dict)
        else:
            final_result.append(task_dict)
    result = final_result

    # Persist cleanup so removed members do not reappear in later loads.
    if cleanup_needed:
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
    type_approver_roles = ["admin", "division head", "group head", "team lead", "project director"]
    approver_user = get_user_by_id(db, approver_id)
    if not approver_user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Approver not found")
    approver_global = (approver_user.role or "").lower()
    approver_team_role = get_user_role_in_team(db, approver_id, task.team_id)
    approver_team_role_lower = (approver_team_role or "").lower()
    if not can_user_manage_team_scope(db, approver_user, get_team_by_id(db, task.team_id)) and approver_global not in type_approver_roles and approver_team_role_lower not in type_approver_roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only authorized scoped leads can approve task type",
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

    actor_role = ((current_user.role if current_user else None) or "").strip().lower()
    can_update_any_task_status = actor_role in ["admin", "division head", "group head", "project director"]
    if not can_update_any_task_status:
        is_direct_assignee = task.assigned_to == user_id
        is_multi_assignee = db.query(TaskAssignment).filter(
            TaskAssignment.task_id == task.id,
            TaskAssignment.user_id == user_id
        ).first() is not None
        if not is_direct_assignee and not is_multi_assignee:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You can only update the status of tasks assigned to you"
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

    dependency_state = get_task_dependency_state(db, task)
    if status_update.status in ("In Progress", "Completed") and dependency_state.get("dependency_start_locked"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=dependency_state.get("dependency_lock_message") or "Task cannot start until start dependency is resolved",
        )
    if status_update.status == "Completed" and dependency_state.get("dependency_finish_locked"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=dependency_state.get("dependency_lock_message") or "Task cannot finish until finish dependency is resolved",
        )

    old_status = task.status
    task.status = status_update.status
    task.updated_at = datetime.now(timezone.utc)
    if status_update.status == "In Progress" and old_status != "In Progress":
        task.started_at = datetime.now(timezone.utc)
    elif status_update.status == "To Do":
        task.started_at = None

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
    dependency_state = get_task_dependency_state(db, task)
    task_dict = {
        "id": task.id,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "priority": task.priority,
        "task_schedule_type": _resolve_task_schedule_type(task),
        "due_date": task.due_date,
        "tentative_start_date": getattr(task, "tentative_start_date", None),
        "tentative_completion_date": getattr(task, "tentative_completion_date", None) or _derive_tentative_completion_date(
            getattr(task, "tentative_start_date", None),
            getattr(task, "tentative_duration_days", None),
        ),
        "tentative_duration_days": getattr(task, "tentative_duration_days", None),
        "assigned_to": task.assigned_to,
        "assigned_username": assignee.username if assignee else None,
        "team_id": task.team_id,
        "team_name": team_obj.name if team_obj else None,
        "activity_id": task.activity_id,
        "activity_name": activity_obj.name if activity_obj else None,
        "activity_type": activity_obj.type if activity_obj else None,
        "created_by": task.created_by,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
        "has_dependency": bool(dependency_state.get("has_dependency")),
        "start_dependency_task_id": dependency_state.get("start_dependency_task_id"),
        "start_dependency_event": dependency_state.get("start_dependency_event"),
        "finish_dependency_task_id": dependency_state.get("finish_dependency_task_id"),
        "finish_dependency_event": dependency_state.get("finish_dependency_event"),
        "dependency_start_locked": bool(dependency_state.get("dependency_start_locked")),
        "dependency_finish_locked": bool(dependency_state.get("dependency_finish_locked")),
        "dependency_lock_active": bool(dependency_state.get("dependency_lock_active")),
        "dependency_lock_message": dependency_state.get("dependency_lock_message"),
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
    Assign or unassign a task.
    Allowed: Admin, Division Head, Group Head within scope, and Team Lead / Project Director in their own team.
    """
    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found",
        )
    team = get_team_by_id(db, task.team_id)
    if not can_user_assign_tasks_for_team(db, current_user, team):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not allowed to assign or unassign tasks in this team",
        )
    if assigned_to is not None:
        assignee = get_user_by_id(db, assigned_to)
        if not assignee:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Assignee not found",
            )
        if not is_user_in_team(db, assigned_to, task.team_id):
            if task.parent_task_id is not None and can_user_assign_tasks_for_team(db, current_user, team):
                ensure_user_in_team_for_assignment(db, assigned_to, task.team_id)
            else:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Assignee must be a member of the team",
                )
    previous_assignee = task.assigned_to
    previous_assignment_rows = (
        db.query(TaskAssignment)
        .filter(TaskAssignment.task_id == task.id)
        .all()
    )

    # This endpoint represents a single-assignee update from the dashboard quick actions,
    # so collapse any existing multi-assignee rows into the new single state.
    if previous_assignment_rows:
        db.query(TaskAssignment).filter(TaskAssignment.task_id == task.id).delete(synchronize_session=False)

    task.assigned_to = assigned_to
    task.lead_person_id = None
    task.percent_share = None
    task.updated_at = datetime.now(timezone.utc)

    # If an unassigned parent task is assigned later, cascade that assignment to any
    # currently unassigned subtasks so the execution chain stays consistent.
    if (
        task.parent_task_id is None
        and previous_assignee is None
        and assigned_to is not None
    ):
        unassigned_subtasks = (
            db.query(Task)
            .filter(
                Task.parent_task_id == task.id,
                Task.assigned_to.is_(None),
            )
            .all()
        )
        for subtask in unassigned_subtasks:
            subtask.assigned_to = assigned_to
            subtask.updated_at = datetime.now(timezone.utc)

    # If a parent task is unassigned, also clear the same assignee from its subtasks so
    # child work does not continue to point at a user who no longer owns the parent task.
    if (
        task.parent_task_id is None
        and previous_assignee is not None
        and assigned_to is None
    ):
        assigned_subtasks = (
            db.query(Task)
            .filter(
                Task.parent_task_id == task.id,
                Task.assigned_to == previous_assignee,
            )
            .all()
        )
        for subtask in assigned_subtasks:
            subtask.assigned_to = None
            subtask.updated_at = datetime.now(timezone.utc)

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
        "task_schedule_type": task.task_schedule_type,
        "due_date": task.due_date,
        "tentative_start_date": getattr(task, "tentative_start_date", None),
        "tentative_completion_date": getattr(task, "tentative_completion_date", None) or _derive_tentative_completion_date(
            getattr(task, "tentative_start_date", None),
            getattr(task, "tentative_duration_days", None),
        ),
        "tentative_duration_days": getattr(task, "tentative_duration_days", None),
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
    Update a task's due date. Allowed for scoped heads or team admins.
    """
    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found",
        )
    team = get_team_by_id(db, task.team_id)
    if not can_user_admin_task_scope(db, current_user, team):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not allowed to change task due dates in this scope",
        )
    validate_due_date_not_holiday(db, due_date)
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
        "task_schedule_type": task.task_schedule_type,
        "due_date": task.due_date,
        "tentative_start_date": getattr(task, "tentative_start_date", None),
        "tentative_completion_date": getattr(task, "tentative_completion_date", None) or _derive_tentative_completion_date(
            getattr(task, "tentative_start_date", None),
            getattr(task, "tentative_duration_days", None),
        ),
        "tentative_duration_days": getattr(task, "tentative_duration_days", None),
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


def _get_task_descendant_ids(task: Optional[Task]) -> set:
    descendant_ids = set()
    if not task:
        return descendant_ids
    stack = list(task.subtasks or [])
    while stack:
        current = stack.pop()
        if not current or current.id in descendant_ids:
            continue
        descendant_ids.add(current.id)
        if current.subtasks:
            stack.extend(current.subtasks)
    return descendant_ids


def _sync_task_assignments_for_edit(
    db: Session,
    task: Task,
    *,
    team_id: Optional[int],
    assigned_to,
    lead_person_id,
    percent_share,
    assignments,
    fields_set,
):
    assignments_provided = "assignments" in fields_set
    single_assignment_fields = {"assigned_to", "lead_person_id", "percent_share"}
    single_fields_provided = bool(fields_set.intersection(single_assignment_fields))

    if not assignments_provided and not single_fields_provided:
        return

    if assignments_provided:
        db.query(TaskAssignment).filter(TaskAssignment.task_id == task.id).delete(synchronize_session=False)
        assignment_rows = assignments or []
        if assignment_rows:
            seen_user_ids = set()
            lead_count = 0
            for assignment in assignment_rows:
                uid = getattr(assignment, "user_id", None)
                if uid in seen_user_ids:
                    raise HTTPException(status_code=400, detail="Each assignee can be added only once")
                seen_user_ids.add(uid)
                user = get_user_by_id(db, uid)
                if not user:
                    raise HTTPException(status_code=404, detail=f"User {uid} not found")
                if team_id and not is_user_in_team(db, uid, team_id):
                    raise HTTPException(status_code=400, detail=f"User {uid} is not a member of the selected team")
                share = getattr(assignment, "percent_share", None)
                if share is not None and (int(share) < 0 or int(share) > 100):
                    raise HTTPException(status_code=400, detail="percent_share must be between 0 and 100")
                is_lead = bool(getattr(assignment, "is_lead", False))
                if is_lead:
                    lead_count += 1
                db.add(TaskAssignment(
                    task_id=task.id,
                    user_id=uid,
                    percent_share=int(share) if share is not None else None,
                    is_lead=1 if is_lead else 0,
                ))
            if lead_count > 1:
                raise HTTPException(status_code=400, detail="At most one assignee can be marked as lead")
            lead_assignment = next((assignment for assignment in assignment_rows if bool(getattr(assignment, "is_lead", False))), None)
            first_assignment = assignment_rows[0]
            task.assigned_to = lead_assignment.user_id if lead_assignment else first_assignment.user_id
            task.lead_person_id = lead_assignment.user_id if lead_assignment else None
            task.percent_share = None
        else:
            task.assigned_to = None
            task.lead_person_id = None
            task.percent_share = None
        return

    db.query(TaskAssignment).filter(TaskAssignment.task_id == task.id).delete(synchronize_session=False)
    if assigned_to is not None:
        assignee = get_user_by_id(db, assigned_to)
        if not assignee:
            raise HTTPException(status_code=404, detail=f"Assignee with ID {assigned_to} not found")
        if team_id and not is_user_in_team(db, assigned_to, team_id):
            raise HTTPException(status_code=400, detail="Assignee is not a member of the selected team")
        task.assigned_to = int(assigned_to)
    elif "assigned_to" in fields_set:
        task.assigned_to = None

    if lead_person_id is not None:
        lead_user = get_user_by_id(db, lead_person_id)
        if not lead_user:
            raise HTTPException(status_code=404, detail=f"Lead person with ID {lead_person_id} not found")
        if team_id and not is_user_in_team(db, lead_person_id, team_id):
            raise HTTPException(status_code=400, detail="Lead person is not a member of the selected team")
        task.lead_person_id = int(lead_person_id)
        if task.assigned_to is None:
            task.assigned_to = int(lead_person_id)
    elif "lead_person_id" in fields_set:
        task.lead_person_id = None

    if "percent_share" in fields_set:
        if percent_share is not None and (int(percent_share) < 0 or int(percent_share) > 100):
            raise HTTPException(status_code=400, detail="percent_share must be between 0 and 100")
        task.percent_share = int(percent_share) if percent_share is not None else None


def update_task_details(db: Session, task_id: int, payload: TaskDetailsEdit, current_user: User):
    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    allowed_roles = ["admin", "division head", "group head"]
    current_role = (current_user.role or "").lower()
    if current_role not in allowed_roles:
        if task.parent_task_id is None or task.created_by != current_user.id:
            raise HTTPException(status_code=403, detail="Not authorized to edit this item")

    fields_set = set(getattr(payload, "__fields_set__", set()) or [])
    is_full_editor = current_role in allowed_roles
    if not is_full_editor:
        restricted_fields = {
            "assigned_to",
            "lead_person_id",
            "percent_share",
            "assignments",
            "parent_task_id",
            "task_type",
            "custom_type",
            "has_dependency",
            "start_dependency_task_id",
            "start_dependency_event",
            "start_dependency_offset_days",
            "finish_dependency_task_id",
            "finish_dependency_event",
            "finish_dependency_offset_days",
            "team_id",
            "activity_id",
        }
        attempted = fields_set.intersection(restricted_fields)
        if attempted:
            raise HTTPException(status_code=403, detail="Not authorized to change assignment, dependency, or hierarchy details")

    if payload.title is not None:
        task.title = payload.title.strip()
    if payload.description is not None:
        task.description = payload.description
    if payload.priority is not None:
        if payload.priority not in ("Low", "Medium", "High"):
            raise HTTPException(status_code=400, detail="Invalid priority")
        task.priority = payload.priority
    if "task_schedule_type" in getattr(payload, "__fields_set__", set()):
        schedule_type = (payload.task_schedule_type or "").strip() or "Time Bound"
        if schedule_type not in ("Time Bound", "Ongoing"):
            raise HTTPException(status_code=400, detail="Invalid task mode")
        task.task_schedule_type = schedule_type
    if "due_date" in getattr(payload, "__fields_set__", set()):
        task.due_date = payload.due_date
    if "tentative_start_date" in getattr(payload, "__fields_set__", set()):
        task.tentative_start_date = payload.tentative_start_date
    if "tentative_completion_date" in getattr(payload, "__fields_set__", set()):
        task.tentative_completion_date = payload.tentative_completion_date
    if "tentative_duration_days" in getattr(payload, "__fields_set__", set()):
        task.tentative_duration_days = int(payload.tentative_duration_days) if payload.tentative_duration_days is not None else None
    if payload.task_type is not None:
        task.task_type = resolve_catalog_value(payload.task_type, payload.custom_type, ALLOWED_TASK_TYPES, "task_type")

    if "parent_task_id" in fields_set:
        new_parent_id = payload.parent_task_id
        if new_parent_id == task.id:
            raise HTTPException(status_code=400, detail="A task cannot be its own parent")
        if new_parent_id is None:
            task.parent_task_id = None
        else:
            new_parent = get_task_by_id(db, int(new_parent_id))
            if not new_parent:
                raise HTTPException(status_code=404, detail="Selected parent task not found")
            if new_parent.id in _get_task_descendant_ids(task):
                raise HTTPException(status_code=400, detail="A task cannot be moved under its own descendant")
            task.parent_task_id = new_parent.id
            task.team_id = new_parent.team_id
            task.activity_id = new_parent.activity_id
            for descendant in list(task.subtasks or []):
                stack = [descendant]
                while stack:
                    child = stack.pop()
                    if not child:
                        continue
                    child.team_id = new_parent.team_id
                    child.activity_id = new_parent.activity_id
                    if child.subtasks:
                        stack.extend(list(child.subtasks))

    if task.parent_task_id is None and ("team_id" in fields_set or "activity_id" in fields_set):
        next_activity = None
        next_team = None
        if payload.activity_id is not None:
            next_activity = get_activity_by_id(db, int(payload.activity_id))
            if not next_activity:
                raise HTTPException(status_code=404, detail="Selected activity not found")
        elif task.activity_id is not None:
            next_activity = get_activity_by_id(db, int(task.activity_id))

        if payload.team_id is not None:
            next_team = get_team_by_id(db, int(payload.team_id))
            if not next_team:
                raise HTTPException(status_code=404, detail="Selected team not found")
            if next_activity and next_team.activity_id != next_activity.id:
                raise HTTPException(status_code=400, detail="Selected team does not belong to the selected activity")
        elif next_activity is not None:
            next_team = (
                db.query(Team)
                .filter(Team.activity_id == next_activity.id)
                .order_by(Team.id.asc())
                .first()
            )
            if not next_team:
                raise HTTPException(status_code=400, detail="Select a team for the selected activity")
        elif task.team_id is not None:
            next_team = get_team_by_id(db, int(task.team_id))

        if next_team is not None:
            task.team_id = next_team.id
            if "activity_id" not in fields_set:
                task.activity_id = next_team.activity_id
        if "activity_id" in fields_set:
            task.activity_id = next_activity.id if next_activity else None

        for descendant in list(task.subtasks or []):
            stack = [descendant]
            while stack:
                child = stack.pop()
                if not child:
                    continue
                child.team_id = task.team_id
                child.activity_id = task.activity_id
                if child.subtasks:
                    stack.extend(list(child.subtasks))

    effective_team_id = task.team_id

    if is_full_editor:
        _sync_task_assignments_for_edit(
            db,
            task,
            team_id=effective_team_id,
            assigned_to=payload.assigned_to,
            lead_person_id=payload.lead_person_id,
            percent_share=payload.percent_share,
            assignments=payload.assignments,
            fields_set=fields_set,
        )

    dependency_source = type("DependencySource", (), {
        "has_dependency": payload.has_dependency if "has_dependency" in fields_set else task.has_dependency,
        "start_dependency_task_id": payload.start_dependency_task_id if "start_dependency_task_id" in fields_set else task.start_dependency_task_id,
        "start_dependency_event": payload.start_dependency_event if "start_dependency_event" in fields_set else task.start_dependency_event,
        "start_dependency_offset_days": payload.start_dependency_offset_days if "start_dependency_offset_days" in fields_set else getattr(task, "start_dependency_offset_days", None),
        "finish_dependency_task_id": payload.finish_dependency_task_id if "finish_dependency_task_id" in fields_set else task.finish_dependency_task_id,
        "finish_dependency_event": payload.finish_dependency_event if "finish_dependency_event" in fields_set else task.finish_dependency_event,
        "finish_dependency_offset_days": payload.finish_dependency_offset_days if "finish_dependency_offset_days" in fields_set else getattr(task, "finish_dependency_offset_days", None),
    })()
    dependency_payload = _validate_task_dependency_payload(db, dependency_source, current_task_id=task.id)
    task.has_dependency = dependency_payload["has_dependency"]
    task.start_dependency_task_id = dependency_payload["start_dependency_task_id"]
    task.start_dependency_event = dependency_payload["start_dependency_event"]
    task.start_dependency_offset_days = dependency_payload["start_dependency_offset_days"]
    task.finish_dependency_task_id = dependency_payload["finish_dependency_task_id"]
    task.finish_dependency_event = dependency_payload["finish_dependency_event"]
    task.finish_dependency_offset_days = dependency_payload["finish_dependency_offset_days"]

    effective_schedule_type = (getattr(task, "task_schedule_type", None) or "").strip() or "Time Bound"
    task.tentative_start_date, task.tentative_completion_date, task.tentative_duration_days = _resolve_tentative_schedule_fields(
        getattr(task, "tentative_start_date", None),
        getattr(task, "tentative_completion_date", None),
        getattr(task, "tentative_duration_days", None),
    )
    if effective_schedule_type == "Ongoing":
        task.due_date = None
        if task.tentative_start_date is None:
            raise HTTPException(status_code=400, detail="tentative_start_date is required for Ongoing tasks")
        if task.tentative_completion_date is None:
            raise HTTPException(status_code=400, detail="tentative_completion_date is required for Ongoing tasks")
    elif task.due_date is None:
        raise HTTPException(status_code=400, detail="due_date is required for Time Bound tasks")
    else:
        validate_due_date_not_holiday(db, task.due_date)

    task.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(task)
    return task


def convert_task_to_milestone(db: Session, task_id: int, payload, current_user: User):
    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if (current_user.role or "").lower() not in ("admin", "division head", "group head"):
        raise HTTPException(status_code=403, detail="Not authorized to convert this task")

    milestone_name = (payload.name or task.title or "").strip()
    if not milestone_name:
        raise HTTPException(status_code=400, detail="Milestone name is required")
    milestone_date = payload.milestone_date or task.due_date or getattr(task, "tentative_start_date", None)
    if milestone_date is None:
        raise HTTPException(status_code=400, detail="Choose a milestone date before converting")
    use_existing_dependency = (
        getattr(payload, "has_dependency", None) is None
        and getattr(payload, "start_dependency_task_id", None) is None
        and getattr(payload, "finish_dependency_task_id", None) is None
    )
    dependency_payload = (
        {
            "has_dependency": int(bool(task.has_dependency or task.start_dependency_task_id or task.finish_dependency_task_id)),
            "start_dependency_task_id": task.start_dependency_task_id,
            "start_dependency_event": task.start_dependency_event,
            "finish_dependency_task_id": task.finish_dependency_task_id,
            "finish_dependency_event": task.finish_dependency_event,
        }
        if use_existing_dependency
        else _validate_task_dependency_payload(db, payload)
    )

    item = Milestone(
        name=milestone_name,
        milestone_date=milestone_date,
        has_dependency=dependency_payload["has_dependency"],
        start_dependency_task_id=dependency_payload["start_dependency_task_id"],
        start_dependency_event=dependency_payload["start_dependency_event"],
        finish_dependency_task_id=dependency_payload["finish_dependency_task_id"],
        finish_dependency_event=dependency_payload["finish_dependency_event"],
        created_by=current_user.id,
    )
    db.add(item)

    parent_id = task.parent_task_id
    for child in list(task.subtasks or []):
        child.parent_task_id = parent_id

    db.commit()
    db.refresh(item)
    delete_task(db, task_id, current_user)
    return item


def update_milestone(db: Session, milestone_id: int, payload, current_user: User):
    item = db.query(Milestone).filter(Milestone.id == milestone_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Milestone not found")
    if (current_user.role or "").lower() not in ("admin", "division head", "group head", "project director", "team lead"):
        raise HTTPException(status_code=403, detail="Not authorized to edit milestones")
    if payload.name is not None:
        next_name = payload.name.strip()
        if not next_name:
            raise HTTPException(status_code=400, detail="Milestone name is required")
        item.name = next_name
    if "milestone_date" in set(getattr(payload, "__fields_set__", set()) or []):
        if payload.milestone_date is None:
            raise HTTPException(status_code=400, detail="Milestone date is required")
        item.milestone_date = payload.milestone_date
    dependency_source = type("MilestoneDependencySource", (), {
        "has_dependency": payload.has_dependency if "has_dependency" in set(getattr(payload, "__fields_set__", set()) or []) else item.has_dependency,
        "start_dependency_task_id": payload.start_dependency_task_id if "start_dependency_task_id" in set(getattr(payload, "__fields_set__", set()) or []) else item.start_dependency_task_id,
        "start_dependency_event": payload.start_dependency_event if "start_dependency_event" in set(getattr(payload, "__fields_set__", set()) or []) else item.start_dependency_event,
        "finish_dependency_task_id": payload.finish_dependency_task_id if "finish_dependency_task_id" in set(getattr(payload, "__fields_set__", set()) or []) else item.finish_dependency_task_id,
        "finish_dependency_event": payload.finish_dependency_event if "finish_dependency_event" in set(getattr(payload, "__fields_set__", set()) or []) else item.finish_dependency_event,
    })()
    dependency_payload = _validate_task_dependency_payload(db, dependency_source)
    item.has_dependency = dependency_payload["has_dependency"]
    item.start_dependency_task_id = dependency_payload["start_dependency_task_id"]
    item.start_dependency_event = dependency_payload["start_dependency_event"]
    item.finish_dependency_task_id = dependency_payload["finish_dependency_task_id"]
    item.finish_dependency_event = dependency_payload["finish_dependency_event"]
    db.commit()
    db.refresh(item)
    return item


def convert_milestone_to_task(db: Session, milestone_id: int, payload, current_user: User):
    item = db.query(Milestone).filter(Milestone.id == milestone_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Milestone not found")
    if (current_user.role or "").lower() not in ("admin", "division head", "group head", "project director", "team lead"):
        raise HTTPException(status_code=403, detail="Not authorized to convert milestones")

    task_payload = TaskCreate(
        title=(payload.title or item.name or "").strip(),
        description=payload.description,
        due_date=payload.due_date or item.milestone_date,
        priority=payload.priority or "Medium",
        status=payload.status or "To Do",
        task_type=payload.task_type or "Infrastructure Development",
        custom_type=payload.custom_type,
        team_id=payload.team_id,
        activity_id=payload.activity_id,
        parent_task_id=payload.parent_task_id,
        assigned_to=payload.assigned_to,
        lead_person_id=payload.lead_person_id,
        percent_share=payload.percent_share,
        task_schedule_type=payload.task_schedule_type or "Time Bound",
        tentative_start_date=payload.tentative_start_date,
        tentative_completion_date=payload.tentative_completion_date,
        tentative_duration_days=payload.tentative_duration_days,
        has_dependency=payload.has_dependency if payload.has_dependency is not None else bool(item.has_dependency),
        start_dependency_task_id=payload.start_dependency_task_id if payload.start_dependency_task_id is not None else item.start_dependency_task_id,
        start_dependency_event=payload.start_dependency_event if payload.start_dependency_event is not None else item.start_dependency_event,
        finish_dependency_task_id=payload.finish_dependency_task_id if payload.finish_dependency_task_id is not None else item.finish_dependency_task_id,
        finish_dependency_event=payload.finish_dependency_event if payload.finish_dependency_event is not None else item.finish_dependency_event,
        assignments=payload.assignments,
    )
    created_task = create_task(db, task_payload, current_user.id)
    db.query(Milestone).filter(Milestone.id == milestone_id).delete(synchronize_session=False)
    db.commit()
    return created_task


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
    validate_due_date_not_holiday(db, payload.requested_due_date)

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

    if not can_user_admin_task_scope(db, current_user, get_team_by_id(db, task.team_id)):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not allowed to decide on extension requests in this scope",
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
        validate_due_date_not_holiday(db, final_due_date)
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

    dependency_state = get_task_dependency_state(db, task)
    if dependency_state.get("dependency_finish_locked"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=dependency_state.get("dependency_lock_message") or "Task cannot finish until finish dependency is resolved",
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


def create_task_completion_request_batch(
    db: Session,
    task_id: int,
    current_user: User,
    files: List[tuple],
    upload_dir: str,
):
    import os
    import uuid

    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    if not is_user_in_team(db, current_user.id, task.team_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You must be a member of the team to submit completion proof")

    dependency_state = get_task_dependency_state(db, task)
    if dependency_state.get("dependency_finish_locked"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=dependency_state.get("dependency_lock_message") or "Task cannot finish until finish dependency is resolved",
        )

    existing = (
        db.query(TaskCompletionRequest)
        .filter(TaskCompletionRequest.task_id == task_id, TaskCompletionRequest.status == "pending")
        .first()
    )
    if existing:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A completion request is already pending for this task")

    os.makedirs(upload_dir, exist_ok=True)
    batch_id = uuid.uuid4().hex
    previous_status = task.status
    task.status = "Pending Completion"
    task.updated_at = datetime.now(timezone.utc)

    created_requests = []
    for file_content, filename in files:
        ext = os.path.splitext(filename)[1].lower() if filename else ""
        if ext not in COMPLETION_PROOF_ALLOWED:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid file type in completion proof batch")
        if len(file_content) > COMPLETION_PROOF_MAX_BYTES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="One or more files exceed the 10 MB limit")

        safe_name = f"{task_id}_{uuid.uuid4().hex[:8]}{ext}"
        file_path = os.path.join(upload_dir, safe_name)
        with open(file_path, "wb") as f:
            f.write(file_content)

        req = TaskCompletionRequest(
            task_id=task_id,
            submitted_by=current_user.id,
            previous_status=previous_status,
            attachment_path=file_path,
            attachment_filename=filename or safe_name,
            batch_id=batch_id,
            status="pending",
        )
        db.add(req)
        created_requests.append(req)

    db.commit()
    db.refresh(created_requests[0])
    log_activity(db, current_user.id, "Submitted task completion proof (awaiting approval)", "Task", task_id)
    return created_requests[0]


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

    if not can_user_admin_task_scope(db, current_user, get_team_by_id(db, task.team_id)):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not allowed to approve or reject completion requests in this scope",
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
        db.query(Comment, User.username, User.designation)
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
            "designation": designation,
            "content": c.content,
            "created_at": c.created_at,
        }
        for c, uname, designation in rows
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
        entity_id=entity_id,
        timestamp=datetime.now(timezone.utc)
    )
    db.add(log_entry)
    db.commit()


def ensure_utc_datetime(value):
    if value is None:
        return None
    if value.tzinfo is None:
        india_tz = timezone(timedelta(hours=5, minutes=30))
        return value.replace(tzinfo=india_tz).astimezone(timezone.utc)
    return value.astimezone(timezone.utc)


def get_activity_logs(db: Session, user_id: int = None, entity_type: str = None, entity_id: int = None, limit: int = 50):
    """
    Get activity logs with optional filters. Returns list of dicts with username for display.
    """
    query = db.query(ActivityLog, User.username, User.designation).join(User, ActivityLog.user_id == User.id)
    if user_id:
        query = query.filter(ActivityLog.user_id == user_id)
    if entity_type and entity_id and (entity_type or "").lower() == "activity":
        team_ids = [
            row[0]
            for row in db.query(Team.id).filter(Team.activity_id == entity_id).all()
        ]
        activity_scope = and_(ActivityLog.entity_type == "Activity", ActivityLog.entity_id == entity_id)
        if team_ids:
            query = query.filter(
                or_(
                    activity_scope,
                    and_(ActivityLog.entity_type == "Team", ActivityLog.entity_id.in_(team_ids))
                )
            )
        else:
            query = query.filter(activity_scope)
    else:
        if entity_type:
            query = query.filter(ActivityLog.entity_type == entity_type)
        if entity_id:
            query = query.filter(ActivityLog.entity_id == entity_id)
    rows = query.order_by(ActivityLog.timestamp.desc(), ActivityLog.id.desc()).limit(limit).all()
    result = [
        {"id": log.id, "user_id": log.user_id, "username": uname, "designation": designation, "action": log.action,
         "entity_type": log.entity_type, "entity_id": log.entity_id, "timestamp": ensure_utc_datetime(log.timestamp)}
        for log, uname, designation in rows
    ]
    if entity_type and entity_id and (entity_type or "").lower() == "activity":
        result = merge_activity_history_fallback_entries(db, entity_id, result)
    return result


def merge_activity_history_fallback_entries(db: Session, activity_id: int, history_rows):
    rows = list(history_rows or [])
    activity = (
        db.query(Activity)
        .options(joinedload(Activity.creator), joinedload(Activity.teams))
        .filter(Activity.id == activity_id)
        .first()
    )
    if not activity:
        return rows

    fallback_rows = []
    activity_kind = ((activity.type or "Activity").strip() or "Activity").lower()
    activity_action = 'Created ' + activity_kind + ' "' + (activity.name or "Untitled") + '"'
    has_activity_creation_log = any(
        (row.get("entity_type") == "Activity")
        and int(row.get("entity_id") or 0) == activity.id
        and (row.get("action") or "").strip().lower() == activity_action.lower()
        for row in rows
    )
    if activity.created_at and not has_activity_creation_log:
        fallback_rows.append({
            "id": -((activity.id * 1000) + 1),
            "user_id": activity.created_by,
            "username": activity.creator.username if activity.creator else None,
            "designation": activity.creator.designation if activity.creator else None,
            "action": activity_action,
            "entity_type": "Activity",
            "entity_id": activity.id,
            "timestamp": ensure_utc_datetime(activity.created_at),
        })

    for team in sorted(activity.teams or [], key=lambda item: ((item.created_at or datetime.min.replace(tzinfo=timezone.utc)), item.id)):
        team_action = 'Created team "' + (team.name or "Untitled") + '" under "' + (activity.name or "Untitled") + '"'
        has_team_creation_log = any(
            (row.get("entity_type") == "Team")
            and int(row.get("entity_id") or 0) == team.id
            and (row.get("action") or "").strip().lower() == team_action.lower()
            for row in rows
        )
        if team.created_at and not has_team_creation_log:
            creator = get_user_by_id(db, team.created_by) if team.created_by else None
            fallback_rows.append({
                "id": -((team.id * 1000) + 2),
                "user_id": team.created_by,
                "username": creator.username if creator else None,
                "designation": creator.designation if creator else None,
                "action": team_action,
                "entity_type": "Team",
                "entity_id": team.id,
                "timestamp": ensure_utc_datetime(team.created_at),
            })

    rows.extend(fallback_rows)
    rows.sort(
        key=lambda row: (
            ensure_utc_datetime(row.get("timestamp")) or datetime.min.replace(tzinfo=timezone.utc),
            int(row.get("id") or 0)
        ),
        reverse=True
    )
    if len(rows) > 300:
        rows = rows[:300]
    return rows


def get_entity_team_id_for_log_access(db: Session, entity_type: str, entity_id: int):
    entity = (entity_type or "").lower()
    if entity == "task":
        task = db.query(Task).filter(Task.id == entity_id).first()
        return task.team_id if task else None
    if entity == "teammember":
        membership = db.query(TeamMember).filter(TeamMember.id == entity_id).first()
        return membership.team_id if membership else None
    if entity == "comment":
        comment = db.query(Comment).filter(Comment.id == entity_id).first()
        if not comment:
            return None
        task = db.query(Task).filter(Task.id == comment.task_id).first()
        return task.team_id if task else None
    if entity == "activity":
        activity = db.query(Activity).filter(Activity.id == entity_id).first()
        if not activity:
            return None
        if activity.team_id:
            return activity.team_id
        first_team = db.query(Team).filter(Team.activity_id == activity.id).order_by(Team.id.asc()).first()
        return first_team.id if first_team else None
    return None


def delete_activity_logs_for_entity(db: Session, entity_type: str, entity_id: int):
    deleted_count = (
        db.query(ActivityLog)
        .filter(ActivityLog.entity_type == entity_type, ActivityLog.entity_id == entity_id)
        .delete(synchronize_session=False)
    )
    db.commit()
    return deleted_count


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
        db.query(ActivityMessage, User.username, User.designation)
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
            "designation": designation,
            "message_type": m.message_type,
            "content": m.content,
            "created_at": m.created_at,
            "updated_at": m.updated_at,
        }
        for m, uname, designation in rows
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
        "designation": current_user.designation,
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
    user_obj = current_user if msg.user_id == current_user.id else (get_user_by_id(db, msg.user_id) if msg.user_id else None)
    return {
        "id": msg.id,
        "activity_id": msg.activity_id,
        "user_id": msg.user_id,
        "username": user_obj.username if user_obj else None,
        "designation": user_obj.designation if user_obj else None,
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


def _get_team_hierarchy_context(db: Session, team_id: int):
    team = (
        db.query(Team)
        .options(
            joinedload(Team.activity)
            .joinedload(Activity.group)
            .joinedload(Group.division)
        )
        .filter(Team.id == team_id)
        .first()
    )
    if not team:
        return None
    activity = team.activity
    group = activity.group if activity else None
    division = group.division if group else None
    return {
        "team": team,
        "activity": activity,
        "group": group,
        "division": division,
    }


def _get_activity_hierarchy_context(db: Session, activity_id: int):
    activity = (
        db.query(Activity)
        .options(joinedload(Activity.group).joinedload(Group.division))
        .filter(Activity.id == activity_id)
        .first()
    )
    if not activity:
        return None
    group = activity.group
    division = group.division if group else None
    return {
        "activity": activity,
        "group": group,
        "division": division,
    }


def _get_group_hierarchy_context(db: Session, group_id: int):
    group = (
        db.query(Group)
        .options(joinedload(Group.division))
        .filter(Group.id == group_id)
        .first()
    )
    if not group:
        return None
    return {
        "group": group,
        "division": group.division,
    }


def _require_delete_scope_access(current_user: User, division=None, group=None, min_scope: str = "team"):
    role = (current_user.role or "").lower()
    if role == "admin":
        return

    if min_scope == "division":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Admin can delete divisions",
        )

    if role == "division head":
        if division and division.head_user_id == current_user.id:
            return
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the Division Head of this division or Admin can delete this item",
        )

    if group and group.head_user_id == current_user.id and min_scope in ("activity", "team"):
        return

    if role == "group head" and min_scope in ("activity", "team"):
        if group and group.head_user_id == current_user.id:
            return
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the Group Head of this group or higher authority can delete this item",
        )

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="You are not authorized to delete this item",
    )


def delete_division(db: Session, division_id: int, current_user: User):
    from sqlalchemy import func

    division = db.query(Division).filter(Division.id == division_id).first()
    if not division:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Division not found")

    _require_delete_scope_access(current_user, division=division, min_scope="division")

    group_ids_query = db.query(Group.id).filter(Group.division_id == division_id)
    group_count = group_ids_query.count()
    group_ids_subquery = group_ids_query.subquery()
    activity_ids_query = db.query(Activity.id).filter(Activity.group_id.in_(group_ids_subquery))
    activity_count = activity_ids_query.count()
    activity_ids_subquery = activity_ids_query.subquery()
    team_count = db.query(func.count(Team.id)).filter(Team.activity_id.in_(activity_ids_subquery)).scalar() or 0
    task_count = db.query(func.count(Task.id)).filter(Task.activity_id.in_(activity_ids_subquery)).scalar() or 0

    if group_count > 0 or activity_count > 0 or team_count > 0 or task_count > 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Division cannot be deleted while it still contains groups, activities, teams, or tasks. Delete lower hierarchy items first.",
        )

    db.delete(division)
    db.commit()
    logger.info("Division %s deleted by user %s", division_id, current_user.id)
    return {"message": "Division deleted"}


def delete_group(db: Session, group_id: int, current_user: User):
    from sqlalchemy import func

    context = _get_group_hierarchy_context(db, group_id)
    if not context:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")

    group = context["group"]
    division = context["division"]
    _require_delete_scope_access(current_user, division=division, group=group, min_scope="group")

    activity_ids_query = db.query(Activity.id).filter(Activity.group_id == group_id)
    activity_count = activity_ids_query.count()
    activity_ids_subquery = activity_ids_query.subquery()
    team_count = db.query(func.count(Team.id)).filter(Team.activity_id.in_(activity_ids_subquery)).scalar() or 0
    task_count = db.query(func.count(Task.id)).filter(Task.activity_id.in_(activity_ids_subquery)).scalar() or 0

    if activity_count > 0 or team_count > 0 or task_count > 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Group cannot be deleted while it still contains activities, teams, or tasks. Delete lower hierarchy items first.",
        )

    db.delete(group)
    db.commit()
    logger.info("Group %s deleted by user %s", group_id, current_user.id)
    return {"message": "Group deleted"}


def delete_team(db: Session, team_id: int, current_user: User):
    """
    Delete a team (admin only).
    For safety, teams with members, activities or tasks cannot be deleted.
    """
    from sqlalchemy import func

    context = _get_team_hierarchy_context(db, team_id)
    if not context:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Team not found",
        )
    team = context["team"]
    _require_delete_scope_access(
        current_user,
        division=context["division"],
        group=context["group"],
        min_scope="team",
    )

    # Check for related records to avoid breaking foreign keys
    member_count = (
        db.query(func.count(TeamMember.id))
        .join(User, User.id == TeamMember.user_id)
        .filter(TeamMember.team_id == team_id, User.role != "admin")
        .scalar()
        or 0
    )
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

    impacted_tasks = (
        db.query(Task)
        .options(joinedload(Task.assignments).joinedload(TaskAssignment.user))
        .filter(Task.team_id == team_id)
        .all()
    )
    for task in impacted_tasks:
        changed = False

        removed_assignment_rows = [
            assignment for assignment in list(task.assignments or [])
            if assignment.user_id == user_id
        ]
        if removed_assignment_rows:
            changed = True
            for assignment in removed_assignment_rows:
                db.delete(assignment)

        remaining_assignments = [
            assignment for assignment in list(task.assignments or [])
            if assignment.user_id != user_id
        ]
        replacement_assignment = next(
            (assignment for assignment in remaining_assignments if bool(getattr(assignment, "is_lead", False))),
            None,
        ) or (remaining_assignments[0] if remaining_assignments else None)

        if task.assigned_to == user_id:
            task.assigned_to = replacement_assignment.user_id if replacement_assignment else None
            changed = True

        if task.lead_person_id == user_id:
            task.lead_person_id = replacement_assignment.user_id if replacement_assignment and bool(getattr(replacement_assignment, "is_lead", False)) else None
            changed = True

        if not remaining_assignments and task.assigned_to is None and task.percent_share is not None:
            task.percent_share = None
            changed = True

        if changed:
            task.updated_at = datetime.now(timezone.utc)

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
    Allowed for scoped heads or admins of the task's team.
    """
    task = get_task_by_id(db, task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found",
        )

    team = get_team_by_id(db, task.team_id)
    if not can_user_admin_task_scope(db, current_user, team):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not allowed to delete tasks in this scope",
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
    from sqlalchemy import func

    context = _get_activity_hierarchy_context(db, activity_id)
    if not context:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Activity not found",
        )
    activity = context["activity"]
    _require_delete_scope_access(
        current_user,
        division=context["division"],
        group=context["group"],
        min_scope="activity",
    )

    team_count = db.query(func.count(Team.id)).filter(Team.activity_id == activity_id).scalar() or 0
    task_count = db.query(func.count(Task.id)).filter(Task.activity_id == activity_id).scalar() or 0
    if team_count > 0 or task_count > 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Activity cannot be deleted while it still contains teams or tasks. Delete lower hierarchy items first.",
        )

    # Post system message to the activity chat so admin and members can see it before the activity is removed
    actor = current_user.username or "Admin"
    name_safe = (activity.name or "Untitled").replace('"', "'")
    create_activity_message_system(
        db, activity_id,
        f'Activity "{name_safe}" was deleted by {actor}.',
    )

    # Delete activity messages
    db.query(ActivityMessage).filter(ActivityMessage.activity_id == activity_id).delete()

    db.delete(activity)
    db.commit()
    logger.info("Activity %s deleted by user %s", activity_id, current_user.id)
    return {"message": "Activity deleted"}
