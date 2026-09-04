# Saralta

Saralta is a LAN-ready team and task management platform for structured internal collaboration. It models work from organizational hierarchy through task execution, approvals, evidence-based completion, analytics, and activity history.

## Features

- Organizational hierarchy: Division -> Group -> Activity/Project -> Team -> Task -> Subtask
- Role-based access control for Admin, Division Head, Group Head, Project Director, Team Lead, and Member roles
- User registration, login, password hashing with bcrypt, username/password reset, logout, and session expiration
- Team creation, invitations, member management, team roles, and team approval workflows
- Task creation with priority, due dates, ongoing/time-bound schedules, task types, subtasks, and multiple assignees
- Lead-person assignment, percentage ownership, closure approvers, and task approval controls
- Start/finish dependencies with optional schedule offsets
- Milestones and conversion between milestones and tasks
- Procurement-stage tracking for procurement tasks
- Completion proof uploads with approval or rejection workflows
- Deadline extension requests with review and optional final due-date overrides
- Activity-level chat, system messages, comments, notifications, and audit history
- Statistics dashboards with completion rate, task status, priority, timeline, workload, and hierarchy metrics
- Gantt view for task schedules, milestones, dependencies, and delay visibility
- Local Ollama-powered assistant that answers questions using permission-filtered live workspace data
- SQLite development support and PostgreSQL migration support for larger deployments

## Technology Stack

### Backend

- Python
- FastAPI
- Uvicorn
- SQLAlchemy ORM
- Pydantic
- Alembic
- SQLite for local development
- PostgreSQL support through `psycopg2-binary`
- bcrypt password hashing

### Frontend

- HTML5
- CSS3
- Vanilla JavaScript
- Fetch API for REST communication
- Chart.js for analytics charts
- Browser local/session storage for session and assistant state

### AI Integration

- Ollama-compatible local language model server
- Default model: `llama3:latest`
- Database-grounded answers with citations and deterministic fallback responses when the model is unavailable

## Architecture

```text
Browser
  |
  | Fetch API + X-Session-Token
  v
FastAPI REST API
  |
  +-- Authentication and session management
  +-- Role and scope authorization
  +-- Task, team, hierarchy, approval, and history services
  +-- Ollama assistant integration
  v
SQLAlchemy ORM
  |
  +-- SQLite database for local development
  +-- PostgreSQL database for production/multi-server deployments
```

## Project Structure

```text
.
├── backend/
│   ├── main.py                         # FastAPI application and routes
│   ├── models.py                       # SQLAlchemy database models
│   ├── schemas.py                      # Pydantic request/response schemas
│   ├── crud.py                         # Database operations and business rules
│   ├── auth.py                         # Authentication and authorization helpers
│   ├── sessions.py                     # In-memory session management
│   ├── assistant_service.py            # Ollama assistant and fallback logic
│   ├── config.py                       # Environment-based configuration
│   ├── database.py                     # SQLAlchemy engine and sessions
│   ├── verify_roles.py                 # Role and hierarchy verification script
│   └── sqlite_to_postgres_migration.py # SQLite-to-PostgreSQL migration utility
├── frontend/
│   ├── index.html                      # Login and registration
│   ├── home.html                       # Platform overview
│   ├── dashboard.html                  # Workspace management view
│   ├── workspace-views.html            # Task dashboard view
│   ├── statistics.html                 # Analytics view
│   ├── gantt-view.html                 # Gantt scheduling view
│   ├── my-info.html                    # Membership and team comparison view
│   ├── help.html                       # Interactive help center
│   ├── css/style.css                   # Shared application styling
│   └── js/                             # API, authentication, UI, analytics, and assistant logic
├── run.bat                             # Windows startup helper
└── START.md                            # Additional startup notes
```

## Local Setup

### Prerequisites

- Python 3.8 or newer
- Internet access for the first dependency installation, unless dependencies are already available locally
- Optional: Ollama, if you want to use the AI assistant

### Start the backend

From the project root:

```powershell
cd backend
python -m venv venv
venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The backend will be available at:

- API: `http://127.0.0.1:8000`
- Interactive API documentation: `http://127.0.0.1:8000/docs`
- Health check: `http://127.0.0.1:8000/`

### Start the frontend

Open a second terminal:

```powershell
cd frontend
python -m http.server 3000
```

Open `http://localhost:3000/index.html` in a browser.

## Configuration

The backend uses environment variables when provided:

| Variable | Purpose | Default |
|---|---|---|
| `TARGET_DATABASE_URL` | PostgreSQL connection string | Local SQLite database |
| `APP_ENV` | Runtime environment | `development` |
| `APP_HOST` | Backend bind host | `0.0.0.0` |
| `APP_PORT` | Configured application port | `8080` |
| `OLLAMA_BASE_URL` | Ollama server URL | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | Ollama model name | `llama3:latest` |
| `OLLAMA_TIMEOUT_SECONDS` | Assistant request timeout | `120` |
| `ENABLE_SEED_DATA` | Enable seed/demo data behavior | `true` |

When `APP_ENV=production`, the backend rejects SQLite and requires `TARGET_DATABASE_URL` to point to PostgreSQL.

## Ollama Assistant

The assistant is optional. To enable it:

1. Install and start Ollama.
2. Download the configured model, for example:

```powershell
ollama pull llama3:latest
```

3. Start the backend normally.

The assistant filters context according to the current user’s visible teams and permissions. If Ollama is unavailable, Saralta returns a local deterministic fallback for supported questions.

## Database Migration

To migrate the local SQLite database to PostgreSQL, set a target connection string and run:

```powershell
$env:TARGET_DATABASE_URL = "postgresql+psycopg2://user:password@localhost:5432/team_task_app"
python -m backend.sqlite_to_postgres_migration
```

## Verification

The role verification script exercises authentication, hierarchy creation, team membership, task creation, subtasks, and permission checks:

```powershell
cd backend
python verify_roles.py
```

## LAN Deployment

The application can run on an isolated internal network. Bind the backend to `0.0.0.0`, allow the selected backend/frontend ports through the host firewall, and have other users open the host machine’s IP address in their browsers.

For production or multi-server use, configure PostgreSQL instead of SQLite and replace the in-memory session store with a shared session solution such as Redis or a database-backed session service.

## API Areas

The FastAPI application exposes routes for:

- Authentication and user management
- Divisions, groups, activities, teams, invitations, and memberships
- Tasks, subtasks, assignments, dependencies, milestones, and procurement stages
- Completion proof and extension requests
- Activity chat, comments, notifications, and audit history
- Dashboard statistics and session monitoring
- AI assistant chat
