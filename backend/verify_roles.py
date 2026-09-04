import os
import sys
import logging

# Set up logging for output
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Switch to test database
os.environ["DATABASE_URL"] = "sqlite:///./test_verify.db"

from fastapi.testclient import TestClient
from main import app
from database import engine, Base, SessionLocal
from models import User

# Initialize TestClient
client = TestClient(app)

def setup_db():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    
    # Create test users
    users = [
        {"username": "admin_user", "password": "pw", "role": "admin"},
        {"username": "divhead_user", "password": "pw", "role": "division head"},
        {"username": "grouphead_user", "password": "pw", "role": "group head"},
        {"username": "member_user", "password": "pw", "role": "member"},
        {"username": "membertwo_user", "password": "pw", "role": "member"},
    ]
    
    # Register users
    for u in users:
        client.post("/users", json=u)
    
    db.close()

def teardown_db():
    Base.metadata.drop_all(bind=engine)
    if os.path.exists("./test_verify.db"):
        os.remove("./test_verify.db")

def login(username):
    response = client.post("/login", json={"username": username, "password": "pw"})
    return response.json()["session_token"], response.json()["user_id"]

def run_tests():
    setup_db()
    
    try:
        # Get tokens & IDs
        tokens = {}
        user_ids = {}
        for role in ["admin", "division head", "group head", "member", "membertwo"]:
            username = f"{role.replace(' ', '')}_user"
            tok, uid = login(username)
            tokens[role] = tok
            user_ids[role] = uid
            
        def auth_headers(role):
            return {"Cookie": f"session_token={tokens[role]}"}

        logger.info("TEST: Division Creation")
        # Admin can create division
        res = client.post("/divisions", json={"name": "Div A", "head_user_id": user_ids["division head"]}, headers=auth_headers("admin"))
        assert res.status_code == 200, f"Admin failed to create division: {res.text}"
        div_id = res.json()["id"]

        # Member cannot create division
        res = client.post("/divisions", json={"name": "Div B", "head_user_id": user_ids["division head"]}, headers=auth_headers("member"))
        assert res.status_code == 403, "Member should not be able to create division"

        logger.info("TEST: Group Creation")
        # Div head can create group
        res = client.post(f"/divisions/{div_id}/groups", json={"name": "Group A", "head_user_id": user_ids["group head"]}, headers=auth_headers("division head"))
        assert res.status_code == 200, f"Div head failed to create group: {res.text}"
        group_id = res.json()["id"]

        logger.info("TEST: Team & Activity Creation")
        # Group head can create activity
        res = client.post(f"/groups/{group_id}/activities", json={"name": "Act A", "type": "Division"}, headers=auth_headers("group head"))
        assert res.status_code == 200, f"Group head failed to create activity: {res.text}"
        act_id = res.json()["id"]

        # Div head can create team (since activity needs a team or team is standalone, in dashboard it's standalone first)
        res = client.post("/teams", json={"name": "Team A"}, headers=auth_headers("division head"))
        assert res.status_code == 200, "Div head failed to create team"
        team_id = res.json()["id"]

        # Add member to team (admin/divhead can do this)
        res = client.post(f"/teams/{team_id}/add-member?user_id={user_ids['member']}&role=Member", headers=auth_headers("admin"))
        assert res.status_code == 200, "Failed to add member to team"
        res = client.post(f"/teams/{team_id}/add-member?user_id={user_ids['membertwo']}&role=Member", headers=auth_headers("admin"))
        assert res.status_code == 200, "Failed to add second member to team"

        logger.info("TEST: Main Task Creation")
        # Admin / Div head / Group head can create main tasks
        payload = {"title": "Main Task", "team_id": team_id, "priority": "Low", "status": "To Do", "task_type": "Infrastructure Development", "assigned_to": user_ids["member"]}
        res = client.post("/tasks", json=payload, headers=auth_headers("group head"))
        assert res.status_code == 200, f"Group Head failed to create main task: {res.text}"
        task_id = res.json()["id"]

        # Member trying to create main task -> should fail with 403
        payload2 = {"title": "Main Task 2", "team_id": team_id, "priority": "Low", "status": "To Do", "task_type": "Infrastructure Development"}
        res = client.post("/tasks", json=payload2, headers=auth_headers("member"))
        assert res.status_code == 403, "Member was able to create a main task!"
        
        logger.info("TEST: Subtask Creation")
        # Assigned member trying to create subtask -> should succeed
        subtask_payload = {"title": "Sub Task", "team_id": team_id, "parent_task_id": task_id, "priority": "Low", "status": "To Do", "task_type": "Infrastructure Development"}
        res = client.post("/tasks", json=subtask_payload, headers=auth_headers("member"))
        assert res.status_code == 200, f"Member failed to create subtask: {res.text}"
        subtask_id = res.json()["id"]

        # Unrelated member cannot create subtask for someone else's task
        res = client.post("/tasks", json=subtask_payload, headers=auth_headers("membertwo"))
        assert res.status_code == 403, "Unrelated member was able to create a subtask!"

        # Group head can create subtask for any member
        manager_subtask_payload = {
            "title": "Manager Sub Task",
            "team_id": team_id,
            "parent_task_id": task_id,
            "priority": "Medium",
            "status": "To Do",
            "task_type": "Infrastructure Development",
        }
        res = client.post("/tasks", json=manager_subtask_payload, headers=auth_headers("group head"))
        assert res.status_code == 200, f"Group Head failed to create member subtask: {res.text}"
        manager_subtask = res.json()
        assert manager_subtask.get("assigned_to") == user_ids["member"], "Manager-created subtask did not inherit parent assignee"

        logger.info("TEST: Nested Task Listing")
        res = client.get("/tasks", headers=auth_headers("group head"))
        assert res.status_code == 200, f"Failed to fetch tasks: {res.text}"
        tasks = res.json()
        parent_task = next((t for t in tasks if t["id"] == task_id), None)
        assert parent_task is not None, "Parent task not returned"
        subtasks = parent_task.get("subtasks") or []
        assert any(st["id"] == subtask_id for st in subtasks), "Created subtask was not nested under parent task"
        assert all(st.get("parent_task_id") == task_id for st in subtasks), "Nested subtasks missing correct parent ID"

        logger.info("ALL TESTS PASSED SUCCESSFULLY!")

    except AssertionError as e:
        logger.error(f"Test failed: {str(e)}")
        sys.exit(1)
    finally:
        teardown_db()

if __name__ == "__main__":
    run_tests()
