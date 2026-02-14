from fastapi import Depends, HTTPException, status, Request
from sqlalchemy.orm import Session
from passlib.context import CryptContext

from database import get_db
from models import User
from schemas import UserLogin
import crud
import sessions

# ------------------------------------------------------------------
# PASSWORD HASHING CONFIGURATION
# ------------------------------------------------------------------

# Configure bcrypt for password hashing
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    """
    Hash a plain text password using bcrypt.
    """
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """
    Verify a plain text password against a hashed password.
    """
    return pwd_context.verify(plain_password, hashed_password)


# ------------------------------------------------------------------
# AUTHENTICATION UTILITIES
# ------------------------------------------------------------------

def authenticate_user(db: Session, username: str, password: str):
    """
    Verify username and password.
    Now uses bcrypt password hashing for security.
    """
    user = crud.get_user_by_username(db, username)

    if not user:
        return None

    if not verify_password(password, user.password):
        return None

    return user


def login_user(user_login: UserLogin, db: Session = Depends(get_db)):
    """
    Login endpoint logic.
    Returns session token and user info on success.
    """
    user = authenticate_user(db, user_login.username, user_login.password)

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password"
        )

    # Normalize role to lowercase for consistent checks (admin / member)
    role_normalized = (user.role or "member").lower()

    # Create session with normalized role
    session_token = sessions.create_session(user.id, user.username, role_normalized)

    return {
        "message": "Login successful",
        "session_token": session_token,
        "user_id": user.id,
        "username": user.username,
        "role": role_normalized
    }


def logout_user(session_token: str):
    """
    Logout user by deleting session.
    """
    if sessions.delete_session(session_token):
        return {"message": "Logout successful"}
    else:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found"
        )


# ------------------------------------------------------------------
# SESSION-BASED AUTH GUARD
# ------------------------------------------------------------------

def get_current_user(request: Request, db: Session = Depends(get_db)):
    """
    Dependency to get current authenticated user from session.
    Use this to protect routes that require authentication.
    """
    session_data = sessions.verify_session(request)
    
    # Get user from database to ensure it still exists
    user = crud.get_user_by_id(db, session_data["user_id"])
    
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found"
        )
    
    return user


def get_current_user_session(request: Request) -> dict:
    """
    Get current user's session data without database query.
    Useful when you only need user_id or role.
    """
    return sessions.verify_session(request)


# ------------------------------------------------------------------
# PERMISSION CHECKING UTILITIES
# ------------------------------------------------------------------

def require_global_admin(user: User):
    """
    Check if user has global admin role (case-insensitive).
    Raises HTTPException if not authorized.
    """
    allowed_globals = ["admin", "division head"]
    if (user.role or "").lower() not in allowed_globals:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Global admin/Division Head access required"
        )


def require_team_admin(db: Session, user_id: int, team_id: int):
    """
    Check if user is admin of the specified team.
    Raises HTTPException if not authorized.
    """
    # Allow global admins and division heads to bypass team admin check
    allowed_globals = ["admin", "division head"]
    user = crud.get_user_by_id(db, user_id)
    if user and (user.role or "").lower() in allowed_globals:
        return

    from crud import is_user_team_admin
    if not is_user_team_admin(db, user_id, team_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Team admin access required"
        )


def require_team_member(db: Session, user_id: int, team_id: int):
    """
    Check if user is a member of the specified team.
    Raises HTTPException if not authorized.
    """
    from crud import is_user_in_team
    if not is_user_in_team(db, user_id, team_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Team membership required"
        )
