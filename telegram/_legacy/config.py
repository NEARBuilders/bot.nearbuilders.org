import os
from dotenv import load_dotenv

load_dotenv()

#Skills can be overridden via ALLOWED_SKILLS in .env as a comma-separated list.
#Falls back to the default set below if not provided in .env.
_raw = os.getenv("ALLOWED_SKILLS", "")

DEFAULT_SKILLS = [
    "Frontend",
    "Backend",
    "Product Owner",
    "Smart Contract",
    "Rust",
    "Typescript",
    "DeFi",
    "AI Automation",
    "DevOps",
    "Data",
]

ALLOWED_SKILLS: list[str] = (
    [s.strip() for s in _raw.split(",") if s.strip()]
    if _raw
    else DEFAULT_SKILLS
)
