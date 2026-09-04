import difflib
import json
import logging
import re
import urllib.error
import urllib.request
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

import config
import crud
from models import Activity, Division, Group, Milestone, Task, TaskAssignment, Team, TeamMember, User

logger = logging.getLogger(__name__)

ASSISTANT_STOPWORDS = {
    "a", "an", "and", "are", "about", "all", "am", "at", "be", "belong", "belongs",
    "can", "could", "details", "do", "does", "everything", "for", "from", "give",
    "i", "in", "into", "is", "it", "me", "my", "of", "on", "or", "our", "show",
    "task", "team", "tell", "the", "to", "too", "up", "what", "which", "who", "you",
    "your"
}


def chat_with_assistant(db: Session, current_user: User, message: str, history: Optional[List[Dict[str, str]]] = None) -> Dict[str, Any]:
    prompt = _normalize_whitespace(message)
    if not prompt:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Message is required")

    prompt_norm = prompt.lower()
    if _question_requests_task_status_overview(prompt_norm):
        status_overview = _build_task_status_overview_response(db, current_user)
        return {
            "answer": status_overview["answer"],
            "model": config.OLLAMA_MODEL,
            "used_fallback": False,
            "citations": status_overview["citations"][:6],
        }

    sanitized_history = _sanitize_history(history)
    context = _build_assistant_context(db, current_user, prompt)
    citations = _build_citations(context)

    try:
        answer = _query_ollama(prompt, sanitized_history, context)
        used_fallback = False
    except Exception as exc:
        logger.warning("Assistant model call failed, using deterministic fallback: %s", exc)
        answer = _build_fallback_answer(current_user, prompt, context)
        used_fallback = True

    return {
        "answer": answer,
        "model": config.OLLAMA_MODEL,
        "used_fallback": used_fallback,
        "citations": citations[:6],
    }


def _sanitize_history(history: Optional[List[Dict[str, str]]]) -> List[Dict[str, str]]:
    if not isinstance(history, list):
        return []

    allowed_roles = {"user", "assistant"}
    sanitized: List[Dict[str, str]] = []
    max_items = max(0, int(config.ASSISTANT_HISTORY_TURNS)) * 2
    for item in history[-max_items:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        content = _normalize_whitespace(item.get("content") or "")
        if role not in allowed_roles or not content:
            continue
        sanitized.append({"role": role, "content": content[:1600]})
    return sanitized


def _build_assistant_context(db: Session, current_user: User, message: str) -> Dict[str, Any]:
    nav_tree = crud.get_nav_tree(db, current_user)
    memberships = _get_user_membership_snapshot(db, current_user)
    visible_scope = _get_visible_scope_summary(db, current_user, nav_tree)
    message_norm = _normalize_whitespace(message).lower()
    relevant_tasks = _attach_dependency_titles(db, _search_relevant_tasks(db, current_user, message))
    relevant_milestones = _search_relevant_milestones(db, message) if _question_mentions_milestones(message_norm) else []
    hierarchy_matches = _search_relevant_hierarchy(nav_tree, message)

    return {
        "user_profile": {
            "id": current_user.id,
            "username": current_user.username,
            "role": current_user.role,
            "designation": current_user.designation,
        },
        "memberships": memberships,
        "visible_scope": visible_scope,
        "query_flags": {
            "asks_about_dependencies": _question_mentions_dependencies(message_norm),
            "asks_about_milestones": _question_mentions_milestones(message_norm),
            "asks_about_scope": _question_requests_scope(message_norm),
        },
        "relevant_hierarchy": hierarchy_matches,
        "relevant_tasks": relevant_tasks,
        "relevant_milestones": relevant_milestones,
        "response_rules": {
            "must_be_grounded": True,
            "must_respect_permissions": True,
            "must_admit_when_unknown": True,
            "must_not_dump_raw_fields": True,
            "must_not_list_scope_unless_requested": True,
            "task_scope_requested": _question_requests_scope(message_norm),
        },
    }


def _get_user_membership_snapshot(db: Session, current_user: User) -> Dict[str, Any]:
    rows = (
        db.query(TeamMember, Team, Activity, Group, Division)
        .join(Team, Team.id == TeamMember.team_id)
        .join(Activity, Activity.id == Team.activity_id, isouter=True)
        .join(Group, Group.id == Activity.group_id, isouter=True)
        .join(Division, Division.id == Group.division_id, isouter=True)
        .filter(TeamMember.user_id == current_user.id)
        .order_by(Division.name.asc(), Group.name.asc(), Activity.name.asc(), Team.name.asc())
        .all()
    )

    teams: List[Dict[str, Any]] = []
    divisions: Dict[int, str] = {}
    groups: Dict[int, str] = {}
    activities: Dict[int, str] = {}

    for member, team, activity, group, division in rows:
        if division and division.id not in divisions:
            divisions[division.id] = division.name
        if group and group.id not in groups:
            groups[group.id] = group.name
        if activity and activity.id not in activities:
            activities[activity.id] = activity.name
        teams.append({
            "team_id": team.id,
            "team_name": team.name,
            "membership_role": member.role,
            "activity_name": activity.name if activity else None,
            "group_name": group.name if group else None,
            "division_name": division.name if division else None,
        })

    return {
        "division_names": list(divisions.values()),
        "group_names": list(groups.values()),
        "activity_names": list(activities.values()),
        "teams": teams,
    }


def _get_visible_scope_summary(db: Session, current_user: User, nav_tree: List[Any]) -> Dict[str, Any]:
    team_ids = crud.get_visible_team_ids_for_role_scope(db, current_user)
    division_count = len(nav_tree or [])
    group_count = sum(len(getattr(division, "groups", []) if not isinstance(division, dict) else division.get("groups", [])) for division in nav_tree or [])
    activity_count = 0
    team_count = 0
    for division in nav_tree or []:
        groups = division.get("groups", []) if isinstance(division, dict) else getattr(division, "groups", [])
        for group in groups:
            activities = group.get("activities", []) if isinstance(group, dict) else getattr(group, "activities", [])
            activity_count += len(activities)
            for activity in activities:
                teams = activity.get("teams", []) if isinstance(activity, dict) else getattr(activity, "teams", [])
                team_count += len(teams)

    visible_task_count = _get_visible_task_query(db, current_user).count()

    return {
        "division_count": division_count,
        "group_count": group_count,
        "activity_count": activity_count,
        "team_count": max(team_count, len(team_ids)),
        "visible_task_count": visible_task_count,
    }


def _search_relevant_tasks(db: Session, current_user: User, message: str, limit: int = 5) -> List[Dict[str, Any]]:
    tasks = _get_visible_task_query(db, current_user).order_by(Task.updated_at.desc()).limit(250).all()
    message_norm = _normalize_whitespace(message).lower()
    focus_phrase = _extract_focus_phrase(message_norm)
    tokens = _extract_keywords(message_norm)

    scored: List[tuple[float, Task]] = []
    for task in tasks:
        score = _score_task_match(task, message_norm, focus_phrase, tokens)
        if score <= 0:
            continue
        scored.append((score, task))

    scored = sorted(
        scored,
        key=lambda item: (item[0], item[1].updated_at or item[1].created_at),
        reverse=True,
    )

    if scored:
        top_score, top_task = scored[0]
        top_title = _normalize_whitespace(top_task.title or "").lower()
        explicit_id_match = ("task " + str(top_task.id)) in message_norm
        explicit_title_match = bool(top_title and top_title in message_norm)
        exact_focus_match = bool(focus_phrase and top_title == focus_phrase)
        dominant_match = len(scored) == 1 or top_score >= (scored[1][0] + 0.45 if len(scored) > 1 else top_score)
        if explicit_id_match or explicit_title_match or exact_focus_match or dominant_match:
            return [_serialize_task_for_assistant(top_task)]

    selected = [task for score, task in scored[:limit] if score >= 0.22]
    if not selected and _question_mentions_tasks(message_norm):
        selected = [
            task for task in tasks
            if task.assigned_to == current_user.id or any(assignment.user_id == current_user.id for assignment in getattr(task, "assignments", []) or [])
        ][:limit]

    return [_serialize_task_for_assistant(task) for task in selected[:limit]]


def _attach_dependency_titles(db: Session, tasks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    dependency_ids = set()
    for task in tasks or []:
        for key in ("start_dependency_task_id", "finish_dependency_task_id"):
            dependency_id = task.get(key)
            if dependency_id:
                dependency_ids.add(dependency_id)

    if not dependency_ids:
        return tasks

    dependency_rows = db.query(Task.id, Task.title).filter(Task.id.in_(dependency_ids)).all()
    dependency_titles = {task_id: title for task_id, title in dependency_rows if title}

    for task in tasks or []:
        task["start_dependency_task_title"] = dependency_titles.get(task.get("start_dependency_task_id"))
        task["finish_dependency_task_title"] = dependency_titles.get(task.get("finish_dependency_task_id"))

    return tasks


def _get_visible_task_query(db: Session, current_user: User):
    query = (
        db.query(Task)
        .options(
            joinedload(Task.assignee),
            joinedload(Task.team),
            joinedload(Task.activity).joinedload(Activity.group).joinedload(Group.division),
            joinedload(Task.assignments).joinedload(TaskAssignment.user),
            joinedload(Task.parent_task),
        )
        .distinct()
    )

    role = (current_user.role or "").strip().lower()
    if role == "admin":
        return query

    visible_team_ids = crud.get_visible_team_ids_for_role_scope(db, current_user)
    filters = []
    if visible_team_ids:
        filters.append(Task.team_id.in_(visible_team_ids))
    filters.append(Task.assigned_to == current_user.id)
    filters.append(Task.assignments.any(TaskAssignment.user_id == current_user.id))
    return query.filter(or_(*filters))


def _get_all_visible_tasks_for_status_overview(db: Session, current_user: User) -> List[Task]:
    return (
        _get_visible_task_query(db, current_user)
        .order_by(Task.status.asc(), Task.updated_at.desc(), Task.created_at.desc(), Task.id.asc())
        .all()
    )


def _serialize_task_for_assistant(task: Task) -> Dict[str, Any]:
    activity = getattr(task, "activity", None)
    group = getattr(activity, "group", None) if activity else None
    division = getattr(group, "division", None) if group else None
    assignees = []
    for assignment in getattr(task, "assignments", []) or []:
        user = getattr(assignment, "user", None)
        assignees.append({
            "username": user.username if user else None,
            "designation": user.designation if user else None,
            "percent_share": assignment.percent_share,
            "is_lead": bool(assignment.is_lead),
        })

    return {
        "task_id": task.id,
        "title": task.title,
        "description": _normalize_whitespace(task.description or ""),
        "status": task.status,
        "priority": task.priority,
        "task_type": task.task_type,
        "team_name": task.team.name if task.team else None,
        "activity_name": activity.name if activity else None,
        "group_name": group.name if group else None,
        "division_name": division.name if division else None,
        "due_date": _serialize_date(task.due_date),
        "tentative_start_date": _serialize_date(task.tentative_start_date),
        "tentative_completion_date": _serialize_date(task.tentative_completion_date),
        "tentative_duration_days": task.tentative_duration_days,
        "schedule_type": task.task_schedule_type,
        "assigned_to": task.assignee.username if getattr(task, "assignee", None) else None,
        "assignees": assignees,
        "parent_task_title": task.parent_task.title if task.parent_task else None,
        "has_dependency": bool(task.has_dependency),
        "start_dependency_task_id": task.start_dependency_task_id,
        "start_dependency_event": task.start_dependency_event,
        "finish_dependency_task_id": task.finish_dependency_task_id,
        "finish_dependency_event": task.finish_dependency_event,
        "created_at": _serialize_datetime(task.created_at),
        "updated_at": _serialize_datetime(task.updated_at),
    }


def _search_relevant_milestones(db: Session, message: str, limit: int = 4) -> List[Dict[str, Any]]:
    message_norm = _normalize_whitespace(message).lower()
    tokens = _extract_keywords(message_norm)
    milestones = db.query(Milestone).order_by(Milestone.milestone_date.asc(), Milestone.id.asc()).limit(120).all()

    scored: List[tuple[float, Milestone]] = []
    for milestone in milestones:
        name_norm = _normalize_whitespace(milestone.name or "").lower()
        score = 0.0
        if name_norm and name_norm in message_norm:
            score += 0.75
        if tokens:
            hits = sum(1 for token in tokens if token in name_norm)
            score += min(0.45, hits * 0.12)
            score += difflib.SequenceMatcher(None, " ".join(tokens), name_norm).ratio() * 0.35
        if not tokens and "milestone" in message_norm:
            score += 0.2
        if score > 0:
            scored.append((score, milestone))

    if not scored and ("milestone" in message_norm or "upcoming" in message_norm or "deadline" in message_norm):
        upcoming = milestones[:limit]
        return [_serialize_milestone_for_assistant(milestone) for milestone in upcoming]

    scored.sort(key=lambda item: item[0], reverse=True)
    return [_serialize_milestone_for_assistant(milestone) for score, milestone in scored[:limit] if score >= 0.18]


def _serialize_milestone_for_assistant(milestone: Milestone) -> Dict[str, Any]:
    return {
        "milestone_id": milestone.id,
        "name": milestone.name,
        "milestone_date": _serialize_date(milestone.milestone_date),
        "has_dependency": bool(milestone.has_dependency),
    }


def _search_relevant_hierarchy(nav_tree: List[Any], message: str, limit: int = 6) -> List[Dict[str, Any]]:
    message_norm = _normalize_whitespace(message).lower()
    tokens = _extract_keywords(message_norm)
    if not tokens and not any(keyword in message_norm for keyword in ("division", "group", "activity", "team")):
        return []

    entries: List[Dict[str, Any]] = []
    for division in nav_tree or []:
        division_name = division.get("name") if isinstance(division, dict) else getattr(division, "name", None)
        groups = division.get("groups", []) if isinstance(division, dict) else getattr(division, "groups", [])
        entries.append({"kind": "division", "name": division_name})
        for group in groups:
            group_name = group.get("name") if isinstance(group, dict) else getattr(group, "name", None)
            activities = group.get("activities", []) if isinstance(group, dict) else getattr(group, "activities", [])
            entries.append({"kind": "group", "name": group_name, "division_name": division_name})
            for activity in activities:
                activity_name = activity.get("name") if isinstance(activity, dict) else getattr(activity, "name", None)
                teams = activity.get("teams", []) if isinstance(activity, dict) else getattr(activity, "teams", [])
                entries.append({
                    "kind": "activity",
                    "name": activity_name,
                    "group_name": group_name,
                    "division_name": division_name,
                })
                for team in teams:
                    team_name = team.get("name") if isinstance(team, dict) else getattr(team, "name", None)
                    entries.append({
                        "kind": "team",
                        "name": team_name,
                        "activity_name": activity_name,
                        "group_name": group_name,
                        "division_name": division_name,
                    })

    scored: List[tuple[float, Dict[str, Any]]] = []
    for entry in entries:
        name_norm = _normalize_whitespace(entry.get("name") or "").lower()
        if not name_norm:
            continue
        score = 0.0
        if name_norm in message_norm:
            score += 0.7
        if tokens:
            hits = sum(1 for token in tokens if token in name_norm)
            score += min(0.4, hits * 0.12)
            score += difflib.SequenceMatcher(None, " ".join(tokens), name_norm).ratio() * 0.28
        if entry["kind"] in message_norm:
            score += 0.12
        if score > 0:
            scored.append((score, entry))

    scored.sort(key=lambda item: item[0], reverse=True)
    deduped: List[Dict[str, Any]] = []
    seen = set()
    for score, entry in scored:
        key = (entry.get("kind"), entry.get("name"))
        if key in seen or score < 0.16:
            continue
        seen.add(key)
        deduped.append(entry)
        if len(deduped) >= limit:
            break
    return deduped


def _score_task_match(task: Task, message_norm: str, focus_phrase: str, tokens: List[str]) -> float:
    title = _normalize_whitespace(task.title or "").lower()
    description = _normalize_whitespace(task.description or "").lower()
    fields = [
        title,
        description,
        _normalize_whitespace(task.task_type or "").lower(),
        _normalize_whitespace(task.team.name if task.team else "").lower(),
        _normalize_whitespace(task.activity.name if task.activity else "").lower(),
    ]
    haystack = " ".join(part for part in fields if part)

    score = 0.0
    if title and title in message_norm:
        score += 1.1
    if focus_phrase and title and focus_phrase in title:
        score += 0.9
    if focus_phrase and title:
        score += difflib.SequenceMatcher(None, focus_phrase, title).ratio() * 0.7
    if tokens:
        token_hits = sum(1 for token in tokens if token in haystack)
        score += min(0.8, token_hits * 0.12)
        score += difflib.SequenceMatcher(None, " ".join(tokens), title or haystack[:80]).ratio() * 0.55
    if str(task.id) and ("task " + str(task.id)) in message_norm:
        score += 1.0
    return score


def _build_citations(context: Dict[str, Any]) -> List[Dict[str, Any]]:
    citations: List[Dict[str, Any]] = []
    query_flags = context.get("query_flags", {}) or {}
    include_milestones = bool(query_flags.get("asks_about_milestones"))
    include_hierarchy = bool(query_flags.get("asks_about_scope"))
    for task in context.get("relevant_tasks", []) or []:
        meta_parts = [task.get("status")]
        team_name = task.get("team_name")
        activity_name = task.get("activity_name")
        if activity_name and team_name:
            meta_parts.append(activity_name + " / " + team_name)
        elif team_name:
            meta_parts.append(team_name)
        elif activity_name:
            meta_parts.append(activity_name)
        citations.append({
            "kind": "task",
            "title": task.get("title") or ("Task " + str(task.get("task_id"))),
            "meta": " • ".join(value for value in meta_parts if value),
        })

    if include_milestones:
        for milestone in context.get("relevant_milestones", []) or []:
            citations.append({
                "kind": "milestone",
                "title": milestone.get("name") or ("Milestone " + str(milestone.get("milestone_id"))),
                "meta": milestone.get("milestone_date"),
            })

    if include_hierarchy:
        for entry in context.get("relevant_hierarchy", []) or []:
            trail = " / ".join(value for value in [
                entry.get("division_name"),
                entry.get("group_name"),
                entry.get("activity_name"),
            ] if value)
            citations.append({
                "kind": entry.get("kind") or "scope",
                "title": entry.get("name") or "Scope",
                "meta": trail or None,
            })

    return citations


def _build_task_status_overview_response(db: Session, current_user: User) -> Dict[str, Any]:
    tasks = _get_all_visible_tasks_for_status_overview(db, current_user)
    grouped = {
        "Completed": [],
        "In Progress": [],
        "To Do": [],
    }
    other_statuses: Dict[str, List[Dict[str, Any]]] = {}

    serialized_tasks = [_serialize_task_for_assistant(task) for task in tasks]
    for task in serialized_tasks:
        status_name = _normalize_whitespace(task.get("status") or "") or "Unknown"
        if status_name in grouped:
            grouped[status_name].append(task)
        else:
            other_statuses.setdefault(status_name, []).append(task)

    intro = "Here are all tasks currently visible to your account from the live database, grouped by status."
    if (current_user.role or "").strip().lower() == "admin":
        intro = "Here are all tasks currently available in the live database, grouped by status."

    lines = [
        intro,
        "",
        _format_task_status_section("Completed", grouped["Completed"]),
        "",
        _format_task_status_section("In Progress", grouped["In Progress"]),
        "",
        _format_task_status_section("To Do", grouped["To Do"]),
    ]

    for status_name in sorted(other_statuses.keys()):
        lines.extend(["", _format_task_status_section(status_name, other_statuses[status_name])])

    citations: List[Dict[str, Any]] = []
    for task in serialized_tasks[:6]:
        meta_parts = [task.get("status")]
        if task.get("activity_name") and task.get("team_name"):
            meta_parts.append(str(task.get("activity_name")) + " / " + str(task.get("team_name")))
        elif task.get("team_name"):
            meta_parts.append(str(task.get("team_name")))
        elif task.get("activity_name"):
            meta_parts.append(str(task.get("activity_name")))
        citations.append({
            "kind": "task",
            "title": task.get("title") or ("Task " + str(task.get("task_id"))),
            "meta": " | ".join(part for part in meta_parts if part),
        })

    return {
        "answer": "\n".join(lines).strip(),
        "citations": citations,
    }


def _format_task_status_section(status_name: str, tasks: List[Dict[str, Any]]) -> str:
    if not tasks:
        return status_name + " (0):\n- None"

    lines = [status_name + " (" + str(len(tasks)) + "):"]
    for task in tasks:
        label = str(task.get("title") or ("Task " + str(task.get("task_id"))))
        task_id = task.get("task_id")
        if task_id is not None:
            label += " (task " + str(task_id) + ")"
        assignee_label = _format_task_assignee_label(task)
        if assignee_label:
            label += " - " + assignee_label
        lines.append("- " + label)
    return "\n".join(lines)


def _format_task_assignee_label(task: Dict[str, Any]) -> str:
    primary_assignee = _normalize_whitespace(task.get("assigned_to") or "")
    secondary_assignees = [
        _normalize_whitespace(assignee.get("username") or "")
        for assignee in (task.get("assignees") or [])
        if _normalize_whitespace(assignee.get("username") or "")
    ]

    seen = set()
    ordered_names: List[str] = []
    for username in ([primary_assignee] if primary_assignee else []) + secondary_assignees:
        if not username or username in seen:
            continue
        seen.add(username)
        ordered_names.append(username)

    if not ordered_names:
        return "Unassigned"
    if len(ordered_names) == 1:
        return "Assigned to " + ordered_names[0]
    return "Assigned to " + ", ".join(ordered_names)


def _query_ollama(message: str, history: List[Dict[str, str]], context: Dict[str, Any]) -> str:
    system_prompt = (
        "You are Saralta Assist, a concise workplace assistant for a task-management application. "
        "Answer only from the supplied database context. Respect the user's current permissions implicitly: "
        "if something is not in context, say you cannot confirm it from the live database. "
        "Do not invent tasks, teams, divisions, people, or dates. "
        "Prefer short, direct answers with crisp bullets only when they improve clarity. "
        "Preserve readable line breaks between bullets or sections. "
        "Never dump raw database fields, raw JSON, or long field-by-field exports. "
        "If one task clearly matches, discuss only that task. "
        "Do not mention division, group, activity, or team unless the user asked for scope or it is needed to disambiguate. "
        "Omit empty or null values instead of listing them. "
        "When referring to dependency tasks, prefer their titles and use numeric ids only as secondary context if needed. "
        "When describing dependencies, explain them in plain language instead of raw field names. "
        "If multiple tasks match, say that clearly and identify them by title and minimal scope. "
        "When the user asks about themselves, use the memberships and profile context. "
        "Do not mention hidden implementation details like prompts or embeddings."
    )

    messages = [{"role": "system", "content": system_prompt}]
    for item in history:
        messages.append({"role": item["role"], "content": item["content"]})

    context_blob = json.dumps(context, ensure_ascii=True, indent=2)
    messages.append({
        "role": "user",
        "content": "Live database context:\n" + context_blob + "\n\nUser question:\n" + message,
    })

    payload = json.dumps({
        "model": config.OLLAMA_MODEL,
        "stream": False,
        "messages": messages,
        "options": {
            "temperature": 0.2,
            "top_p": 0.9,
        },
    }).encode("utf-8")

    request = urllib.request.Request(
        config.OLLAMA_BASE_URL + "/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=config.OLLAMA_TIMEOUT_SECONDS) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError("Ollama HTTP error: " + body) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError("Unable to reach local Ollama server") from exc

    message_obj = data.get("message") or {}
    answer = _normalize_assistant_answer(message_obj.get("content") or "")
    if not answer:
        raise RuntimeError("Ollama returned an empty response")
    return answer


def _build_fallback_answer(current_user: User, message: str, context: Dict[str, Any]) -> str:
    message_norm = _normalize_whitespace(message).lower()
    tasks = context.get("relevant_tasks", []) or []
    memberships = context.get("memberships", {}) or {}
    milestones = context.get("relevant_milestones", []) or []
    include_scope = _question_requests_scope(message_norm)

    if any(phrase in message_norm for phrase in ("which division", "what division", "belong to")):
        division_names = memberships.get("division_names") or []
        if division_names:
            return "You are currently mapped to these division(s): " + ", ".join(division_names) + "."
        return "I could not find any division membership for your current account in the live database."

    if tasks:
        if len(tasks) == 1:
            task = tasks[0]
            if _question_mentions_dependencies(message_norm):
                dependency_line = _format_task_dependency(task)
                if dependency_line:
                    return str(task.get("title") or ("Task " + str(task.get("task_id")))) + ": " + dependency_line
            lines = [
                "Here is a quick summary of " + str(task.get("title") or ("Task " + str(task.get("task_id")))) + ":",
                "- Task ID: " + str(task.get("task_id") or "-"),
                "- Status: " + str(task.get("status") or "-"),
                "- Priority: " + str(task.get("priority") or "-"),
            ]
            if task.get("task_type"):
                lines.append("- Type: " + str(task.get("task_type")))
            if task.get("description"):
                lines.append("- Description: " + str(task.get("description")))
            if task.get("due_date"):
                lines.append("- Due date: " + str(task.get("due_date")))
            if task.get("assigned_to"):
                lines.append("- Assigned to: " + str(task.get("assigned_to")))
            if include_scope:
                scope = " / ".join(value for value in [
                    task.get("division_name"),
                    task.get("group_name"),
                    task.get("activity_name"),
                    task.get("team_name"),
                ] if value)
                if scope:
                    lines.append("- Scope: " + scope)
            dependency_line = _format_task_dependency(task)
            if dependency_line:
                lines.append("- Dependency: " + dependency_line)
            return "\n".join(lines)

        lines = ["I found multiple matching tasks in the live database:"]
        for task in tasks[:5]:
            scope = " / ".join(value for value in [
                task.get("activity_name"),
                task.get("team_name"),
            ] if value)
            summary = "- " + str(task.get("title") or ("Task " + str(task.get("task_id"))))
            if scope:
                summary += " (" + scope + ")"
            lines.append(summary)
        return "\n".join(lines)

    if "milestone" in message_norm and milestones:
        lines = ["Here are the most relevant milestones I found:"]
        for milestone in milestones[:4]:
            lines.append("- " + str(milestone.get("name")) + " on " + str(milestone.get("milestone_date")))
        return "\n".join(lines)

    team_names = [team.get("team_name") for team in memberships.get("teams", []) if team.get("team_name")]
    if any(phrase in message_norm for phrase in ("which team", "my team", "what team")) and team_names:
        return "You are currently associated with these team(s): " + ", ".join(team_names) + "."

    return (
        "I could not reach the local assistant model just now, but I am still connected to the live database. "
        "Please try rephrasing the question with a task, team, division, activity, or milestone name."
    )


def _question_mentions_tasks(message_norm: str) -> bool:
    return any(keyword in message_norm for keyword in ("task", "subtask", "assigned", "due", "priority", "status"))


def _question_requests_task_status_overview(message_norm: str) -> bool:
    mentions_tasks = "task" in message_norm or "tasks" in message_norm
    mentions_assignees = "assignee" in message_norm or "assignees" in message_norm
    mentions_completed = any(phrase in message_norm for phrase in ("complete", "completed", "done"))
    mentions_in_progress = "in progress" in message_norm
    mentions_todo = any(phrase in message_norm for phrase in ("to do", "todo", "pending"))
    mentions_grouping = any(phrase in message_norm for phrase in (
        "group by status",
        "by status",
        "status-wise",
        "task statuses",
    ))
    mentions_status_mix = (mentions_completed and mentions_in_progress) or (mentions_completed and mentions_todo) or (mentions_in_progress and mentions_todo)
    return bool((mentions_tasks or mentions_assignees) and (mentions_status_mix or mentions_grouping))


def _question_mentions_dependencies(message_norm: str) -> bool:
    return any(keyword in message_norm for keyword in ("dependency", "depends", "dependent", "blocker", "blocked by"))


def _question_mentions_milestones(message_norm: str) -> bool:
    return any(keyword in message_norm for keyword in ("milestone", "deadline", "upcoming", "due date"))


def _question_requests_scope(message_norm: str) -> bool:
    return any(phrase in message_norm for phrase in (
        "which division",
        "what division",
        "which group",
        "what group",
        "which activity",
        "what activity",
        "which team",
        "what team",
        "scope",
        "where is",
        "where does",
    ))


def _extract_focus_phrase(message_norm: str) -> str:
    patterns = [
        r"(?:task|subtask|milestone|division|group|activity|team)\s+([a-z0-9 _/\-]+)",
        r"about\s+([a-z0-9 _/\-]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, message_norm)
        if match:
            return _normalize_whitespace(match.group(1))
    return ""


def _extract_keywords(message_norm: str) -> List[str]:
    tokens = re.findall(r"[a-z0-9]{2,}", message_norm.lower())
    return [token for token in tokens if token not in ASSISTANT_STOPWORDS]


def _normalize_whitespace(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _normalize_assistant_answer(value: Any) -> str:
    raw = str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return ""

    normalized_lines: List[str] = []
    previous_blank = False
    for raw_line in raw.split("\n"):
        line = re.sub(r"[ \t]+", " ", raw_line).strip()
        if not line:
            if normalized_lines and not previous_blank:
                normalized_lines.append("")
            previous_blank = True
            continue
        normalized_lines.append(line)
        previous_blank = False
    return "\n".join(normalized_lines).strip()


def _format_task_dependency(task: Dict[str, Any]) -> Optional[str]:
    if not task.get("has_dependency"):
        return None

    start_task_id = task.get("start_dependency_task_id")
    start_event = task.get("start_dependency_event")
    start_task_title = task.get("start_dependency_task_title")
    finish_task_id = task.get("finish_dependency_task_id")
    finish_event = task.get("finish_dependency_event")
    finish_task_title = task.get("finish_dependency_task_title")

    if start_task_id:
        return "This task can start after " + _format_task_reference(start_task_title, start_task_id) + " " + _dependency_event_phrase(start_event) + "."
    if finish_task_id:
        return "This task can finish after " + _format_task_reference(finish_task_title, finish_task_id) + " " + _dependency_event_phrase(finish_event) + "."
    return "This task has a dependency configured in the live database."


def _format_task_reference(title: Optional[str], task_id: Any) -> str:
    clean_title = _normalize_whitespace(title or "")
    if clean_title:
        return clean_title + " (task " + str(task_id) + ")"
    return "task " + str(task_id)


def _dependency_event_phrase(value: Any) -> str:
    event = str(value or "").strip().lower()
    if event == "start":
        return "starts"
    return "finishes"


def _serialize_date(value: Optional[date]) -> Optional[str]:
    if not value:
        return None
    return value.isoformat()


def _serialize_datetime(value: Optional[datetime]) -> Optional[str]:
    if not value:
        return None
    return value.isoformat()
