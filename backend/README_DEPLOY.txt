# Saralta - Deployment Guide

## Overview
This is a basic LAN-based backend for Team and Task Management, built with FastAPI and SQLite. It's designed for deployment in isolated network environments like DRDO.

## Prerequisites
- Python 3.8 or higher installed on the target machine.
- No internet required after initial setup (dependencies are local).
- Ensure the machine's firewall allows traffic on port 8000.

## Installation Steps
1. Copy the entire `backend` folder to the target machine.
2. Open a terminal/command prompt in the `backend` folder.
3. Install dependencies:
   ```
   pip install -r requirements.txt
   ```
4. The SQLite database (`task.db`) will be created automatically on first run.

## Running the Application
1. Start the server:
   ```
   uvicorn main:app --host 0.0.0.0 --port 8000
   ```
2. The app will be accessible at `http://<machine-ip>:8000` (e.g., `http://192.168.1.100:8000`).
3. Test connectivity: Visit `http://<machine-ip>:8000/` in a browser or use curl:
   ```
   curl http://<machine-ip>:8000/
   ```
   Expected response: `{"message": "Saralta is running on LAN"}`

## API Documentation
- Interactive docs: `http://<machine-ip>:8000/docs`
- Use tools like Postman or curl to test endpoints.

## Key Endpoints
- POST `/login` - User login
- POST `/users` - Create user
- POST `/teams` - Create team
- POST `/teams/{team_id}/add-member` - Add member to team
- GET `/users/{user_id}/teams` - Get user teams
- POST `/tasks` - Create task
- GET `/tasks` - Get tasks (with filters)
- PUT `/tasks/{task_id}/status` - Update task status
- POST `/tasks/{task_id}/comments` - Add comment
- GET `/tasks/{task_id}/comments` - Get task comments

## Security Notes
- This is a basic version with plain-text authentication.
- For production, ensure the LAN is isolated and secure.
- Future versions will include hashed passwords and JWT.

## Troubleshooting
- If port 8000 is in use, change it in the command.
- Check logs in the terminal for errors.
- Database file: `task.db` in the backend folder.

## Stopping the App
- Press Ctrl+C in the terminal to stop the server.