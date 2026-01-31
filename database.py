from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import config

# ------------------------------------------------------------------
# Database configuration
# ------------------------------------------------------------------

# Use config for database URL
DATABASE_URL = config.DATABASE_URL

# Create SQLAlchemy engine
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False}  # Required for SQLite with FastAPI
)

# Create a configured "Session" class
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

# Base class for ORM models
Base = declarative_base()

# ------------------------------------------------------------------
# Dependency to get DB session
# ------------------------------------------------------------------

def get_db():
    """
    Provides a database session to FastAPI routes.
    Ensures session is properly closed after use.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
