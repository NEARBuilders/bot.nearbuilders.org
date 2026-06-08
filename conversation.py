"""
In-memory conversation state machine for builder onboarding.
Each user's state is stored in a dict keyed by user_id.
"""

from dataclasses import dataclass, field
from typing import Optional
from config import ALLOWED_SKILLS

# Conversation steps in order
STEPS = ["near_address", "name", "bio", "skills", "location", "links"]

BIO_MAX_CHARS = 1000
NAME_MAX_CHARS = 100
SKILL_MAX_CHARS = 50
MAX_SKILLS = 20


STEP_QUESTIONS = {
    "near_address": (
        "🔗 What is your NEAR address?\n\n"
        "Accepted formats:\n"
        "  • <code>yourname.near</code>\n"
        "  • <code>yourname.tg</code>\n"
        "  • 64-character hex address"
    ),
    "name":     "👤 What's your name?",
    "bio":      f"📝 Describe yourself in a short bio:\n\nMax {BIO_MAX_CHARS} characters - anything longer will be trimmed.",
    "skills":   "🛠 Select your skills - tap to toggle, then press <b>Done</b>:",
    "location": "📍 Where are you based?",
    "links":    "🔗 Add your links below. You can add as many as you like.",
}


STEP_LABELS = {
    "near_address": "NEAR Address",
    "name":     "Name",
    "bio":      "Bio",
    "skills":   "Skills",
    "location": "Location",
    "links":    "Links",
}


@dataclass
class ConversationState:
    user_id: int
    current_step: Optional[str] = None   # None = not started, "done" = complete
    editing_field: Optional[str] = None  # Set when user chose to edit a specific field
    links_sub_step: Optional[str] = None  # "awaiting_label" | "awaiting_url" | None
    pending_link_label: Optional[str] = None  # label entered, waiting for URL
    data: dict = field(default_factory=lambda: {
        "near_address": None,
        "name": None,
        "bio": None,
        "skills": None,
        "location": None,
        "links": None,
    })


# Global in-memory store  {user_id: ConversationState}
_sessions: dict[int, ConversationState] = {}


def get_session(user_id: int) -> ConversationState:
    if user_id not in _sessions:
        _sessions[user_id] = ConversationState(user_id=user_id)
    return _sessions[user_id]


def clear_session(user_id: int):
    _sessions.pop(user_id, None)


def start_session(user_id: int) -> ConversationState:
    _sessions[user_id] = ConversationState(user_id=user_id, current_step=STEPS[0])
    return _sessions[user_id]


def next_step(state: ConversationState) -> Optional[str]:
    """Advance to next unanswered step. Returns the new step name or None if done."""
    if state.editing_field:
        # After editing, jump back to summary
        state.editing_field = None
        state.current_step = "done"
        return "done"

    if state.current_step is None:
        state.current_step = STEPS[0]
        return state.current_step

    if state.current_step == "done":
        return "done"

    idx = STEPS.index(state.current_step)
    if idx + 1 < len(STEPS):
        state.current_step = STEPS[idx + 1]
    else:
        state.current_step = "done"

    return state.current_step


def skip_current_step(state: ConversationState):
    """Set the current step's data to None (skipped)."""
    step = state.editing_field or state.current_step
    if step and step in state.data:
        state.data[step] = None


def get_selected_skills(state: "ConversationState") -> list[str]:
    """Return currently selected skills (empty list if none)."""
    return state.data.get("skills") or []


def toggle_skill(state: "ConversationState", skill: str):
    """Add skill if not selected, remove if already selected."""
    current = get_selected_skills(state)
    if skill in current:
        current.remove(skill)
    else:
        if len(current) < MAX_SKILLS:
            current.append(skill)
    state.data["skills"] = current if current else None


def parse_skills(raw: str) -> tuple[list[str], list[str]]:
    """
    Parse comma-separated skills against the allowed list.
    Returns (valid_skills, invalid_skills).
    """
    allowed_lower = {s.lower(): s for s in ALLOWED_SKILLS}
    entered = [s.strip() for s in raw.split(",") if s.strip()]
    valid, invalid = [], []
    for entry in entered:
        if entry.lower() in allowed_lower:
            valid.append(allowed_lower[entry.lower()])
        else:
            invalid.append(entry)
    return valid[:MAX_SKILLS], invalid


def add_link(state: "ConversationState", label: str, url: str):
    """Add a label:url pair to the links dict."""
    if state.data["links"] is None:
        state.data["links"] = {}
    state.data["links"][label.strip().lower()] = url.strip()


def remove_link(state: "ConversationState", label: str):
    """Remove a link by label."""
    if state.data["links"] and label in state.data["links"]:
        del state.data["links"][label]
        if not state.data["links"]:
            state.data["links"] = None


def build_links_overview(state: "ConversationState") -> str:
    """Build the links overview message showing current links."""
    links = state.data.get("links") or {}
    if not links:
        return "🔗 <b>Links</b>\n\nNo links added yet."
    lines = ["🔗 <b>Links</b>\n"]
    for label, url in links.items():
        lines.append(f"  \u2022 <b>{_escape_html(label)}</b>: {_escape_html(url)}")
    return "\n".join(lines)


def apply_answer(state: ConversationState, text: str) -> str | None:
    """
    Store the user's answer for the current step.
    Returns a ✂️ soft warning (accepted, trimmed), ⚠️ hard error (re-ask), or None (ok).
    """
    step = state.editing_field or state.current_step

    if step == "near_address":
        addr = text.strip()
        if not addr:
            return "⚠️ NEAR address is required. Please enter your address or create a wallet."
        # Validate: must end in .near, .tg, or be a 64-char hex string
        import re
        if addr.endswith(".near") or addr.endswith(".tg"):
            state.data["near_address"] = addr
        elif re.fullmatch(r"[0-9a-fA-F]{64}", addr):
            state.data["near_address"] = addr
        else:
            return (
                "⚠️ That doesn't look like a valid NEAR address.\n\n"
                "Accepted formats:\n"
                "  • <code>yourname.near</code>\n"
                "  • <code>yourname.tg</code>\n"
                "  • 64-character hex address"
            )

    elif step == "name":
        if len(text) > NAME_MAX_CHARS:
            return f"⚠️ Name must be {NAME_MAX_CHARS} characters or fewer."
        state.data["name"] = text.strip()

    elif step == "bio":
        trimmed = text.strip()[:BIO_MAX_CHARS]
        state.data["bio"] = trimmed
        if len(text.strip()) > BIO_MAX_CHARS:
            return f"✂️ Your bio was trimmed to {BIO_MAX_CHARS} characters and saved."

    elif step == "skills":
        valid, invalid = parse_skills(text)
        if invalid:
            allowed_str = ", ".join(ALLOWED_SKILLS)
            return (
                f"⚠️ These skills aren't recognised: <b>{', '.join(invalid)}</b>\n\n"
                f"Please choose from:\n<code>{allowed_str}</code>"
            )
        state.data["skills"] = valid if valid else None

    elif step == "location":
        state.data["location"] = text.strip()

    return None


def _escape_html(text: str) -> str:
    """Escape characters that would break Telegram HTML parsing."""
    return (
        text
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def build_summary(state: ConversationState) -> str:
    """Render the current data as a readable HTML summary."""
    d = state.data

    def fmt(val) -> str:
        if val is None:
            return "<i>not provided</i>"
        if isinstance(val, list):
            return _escape_html(", ".join(val)) if val else "<i>not provided</i>"
        if isinstance(val, dict):
            if not val:
                return "<i>not provided</i>"
            return "\n".join(f"  • {_escape_html(k)}: {_escape_html(v)}" for k, v in val.items())
        return _escape_html(str(val))

    lines = [
        "📋 <b>Here's your builder profile so far:</b>\n",
        f"🔗 <b>NEAR Address:</b> {fmt(d['near_address'])}",
        f"👤 <b>Name:</b> {fmt(d['name'])}",
        f"📝 <b>Bio:</b> {fmt(d['bio'])}",
        f"🛠 <b>Skills:</b> {fmt(d['skills'])}",
        f"📍 <b>Location:</b> {fmt(d['location'])}",
        f"🔗 <b>Links:</b> {fmt(d['links'])}",
    ]
    return "\n".join(lines)


def build_api_payload(state: ConversationState) -> dict:
    """Build the POST body for the nearbuilders API."""
    d = state.data
    payload = {}
    if d["name"]:
        payload["name"] = d["name"]
    if d["bio"]:
        payload["bio"] = d["bio"]
    if d["skills"]:
        payload["skills"] = d["skills"]
    if d["location"]:
        payload["location"] = d["location"]
    if d["links"]:
        payload["links"] = d["links"]
    return payload
