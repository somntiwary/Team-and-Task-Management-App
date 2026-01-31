from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from database import get_db
from models import User
from schemas import UserLogin
import crud

# ------------------------------------------------------------------
# AUTHENTICATION UTILITIES (PHASE-1)
# ------------------------------------------------------------------

def authenticate_user(db: Session, username: str, password: str):
    """
    Verify username and password.
    Phase-1: Plain-text password comparison (LAN-only demo).
    """
    user = crud.get_user_by_username(db, username)

    if not user:
        return None

    if user.password != password:
        return None

    return user


def login_user(user_login: UserLogin, db: Session = Depends(get_db)):
    """
    Login endpoint logic.
    Returns basic user info on success.
    """
    user = authenticate_user(db, user_login.username, user_login.password)

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password"
        )

    return {
        "message": "Login successful",
        "user_id": user.id,
        "username": user.username,
        "role": user.role
    }


# ------------------------------------------------------------------
# SIMPLE AUTH GUARD (OPTIONAL FOR PHASE-1)
# ------------------------------------------------------------------

def get_current_user(user_id: int, db: Session = Depends(get_db)):
    """
    Fetch user based on user_id.
    Used for protecting routes (basic level).
    """
    user = db.query(User).filter(User.id == user_id).first()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found"
        )

    return user
