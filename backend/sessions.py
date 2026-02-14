"""
Session Management for Authentication

This module provides simple session-based authentication for the LAN environment.
For LAN deployment, this provides basic security without complex JWT infrastructure.
"""

from fastapi import HTTPException, status, Request
from typing import Dict, Optional
from datetime import datetime, timedelta, timezone
import secrets
import logging

logger = logging.getLogger(__name__)

# In-memory session store (sufficient for LAN deployment)
# For production across multiple servers, use Redis or database
sessions: Dict[str, dict] = {}

# Session configuration
SESSION_TIMEOUT_MINUTES = 480  # 8 hours
SESSION_TOKEN_LENGTH = 32


def create_session(user_id: int, username: str, role: str) -> str:
    """
    Create a new session for a user.
    Returns a session token.
    """
    # Generate a secure random token
    session_token = secrets.token_urlsafe(SESSION_TOKEN_LENGTH)
    
    # Store session data
    sessions[session_token] = {
        "user_id": user_id,
        "username": username,
        "role": role,
        "created_at": datetime.now(timezone.utc),
        "last_active": datetime.now(timezone.utc)
    }
    
    logger.info(f"Session created for user {username} (ID: {user_id})")
    return session_token


def get_session(session_token: str) -> Optional[dict]:
    """
    Retrieve session data by token.
    Returns None if session doesn't exist or has expired.
    """
    if session_token not in sessions:
        return None
    
    session_data = sessions[session_token]
    
    # Check if session has expired
    last_active = session_data["last_active"]
    if datetime.now(timezone.utc) - last_active > timedelta(minutes=SESSION_TIMEOUT_MINUTES):
        # Session expired, remove it
        del sessions[session_token]
        logger.info(f"Session expired for user {session_data['username']}")
        return None
    
    # Update last active time
    session_data["last_active"] = datetime.now(timezone.utc)
    
    return session_data


def delete_session(session_token: str) -> bool:
    """
    Delete a session (logout).
    Returns True if session was found and deleted.
    """
    if session_token in sessions:
        username = sessions[session_token].get("username", "unknown")
        del sessions[session_token]
        logger.info(f"Session deleted for user {username}")
        return True
    return False


def verify_session(request: Request) -> dict:
    """
    Middleware function to verify session token.
    Raises HTTPException if session is invalid.
    Returns session data if valid.
    """
    # Get session token from header
    session_token = request.headers.get("X-Session-Token")
    
    if not session_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="No session token provided"
        )
    
    session_data = get_session(session_token)
    
    if not session_data:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session"
        )
    
    return session_data


def cleanup_expired_sessions():
    """
    Remove all expired sessions from memory.
    This can be called periodically to clean up old sessions.
    """
    current_time = datetime.now(timezone.utc)
    expired_tokens = []
    
    for token, data in sessions.items():
        if current_time - data["last_active"] > timedelta(minutes=SESSION_TIMEOUT_MINUTES):
            expired_tokens.append(token)
    
    for token in expired_tokens:
        username = sessions[token].get("username", "unknown")
        del sessions[token]
        logger.info(f"Cleaned up expired session for user {username}")
    
    if expired_tokens:
        logger.info(f"Cleaned up {len(expired_tokens)} expired sessions")
    
    return len(expired_tokens)


def get_active_sessions_count() -> int:
    """
    Get the number of active sessions.
    Useful for monitoring.
    """
    return len(sessions)
