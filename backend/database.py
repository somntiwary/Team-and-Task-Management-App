from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from sqlalchemy.engine.url import make_url
import config

# ------------------------------------------------------------------
# Database configuration
# ------------------------------------------------------------------

# Use config for database URL (can be SQLite or PostgreSQL, etc.)
DATABASE_URL = config.DATABASE_URL

# Detect backend to apply engine-specific options
url = make_url(DATABASE_URL)
engine_kwargs = {}
if url.get_backend_name().startswith("sqlite"):
    # Required for SQLite with FastAPI; NOT valid for PostgreSQL
    engine_kwargs["connect_args"] = {"check_same_thread": False}

# Create SQLAlchemy engine
engine = create_engine(DATABASE_URL, **engine_kwargs)

# Create a configured "Session" class
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
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
