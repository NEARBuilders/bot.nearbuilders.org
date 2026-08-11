import os
import logging
from dotenv import load_dotenv

from telegram import (
    Update,
    BotCommand,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    ReactionTypeEmoji,
)
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    ContextTypes,
    filters,
)
from telegram.constants import ParseMode

import db
import api_client
from conversation import (
    STEPS,
    STEP_QUESTIONS,
    STEP_LABELS,
    get_session,
    start_session,
    clear_session,
    next_step,
    skip_current_step,
    toggle_skill,
    get_selected_skills,
    add_link,
    remove_link,
    build_links_overview,
    apply_answer,
    build_summary,
    build_api_payload,
)
from config import ALLOWED_SKILLS

load_dotenv()

import os
from logging.handlers import RotatingFileHandler

log_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
os.makedirs(log_dir, exist_ok=True)
log_path = os.path.join(log_dir, "bot.log")

log_formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(name)s | %(message)s")

file_handler = RotatingFileHandler(log_path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
file_handler.setFormatter(log_formatter)

console_handler = logging.StreamHandler()
console_handler.setFormatter(log_formatter)

logging.basicConfig(level=logging.INFO, handlers=[file_handler, console_handler])
logger = logging.getLogger(__name__)
logger.info(f"Logging to {log_path}")

BOT_USERNAME = "@nearbuildersbot"  # Update to match your bot's username
NEAR_WALLET_URL = os.getenv("NEAR_WALLET_URL", "https://wallet.meteorwallet.app")


def _escape_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def build_edit_keyboard() -> InlineKeyboardMarkup:
    """Inline keyboard with edit buttons in 2 columns and Confirm at the bottom."""
    buttons = []
    steps = list(STEPS)
    # Pair up steps into rows of 2
    for i in range(0, len(steps), 2):
        row = [InlineKeyboardButton(f"✏️ {STEP_LABELS[steps[i]]}", callback_data=f"edit:{steps[i]}")]
        if i + 1 < len(steps):
            row.append(InlineKeyboardButton(f"✏️ {STEP_LABELS[steps[i+1]]}", callback_data=f"edit:{steps[i+1]}"))
        buttons.append(row)
    buttons.append([InlineKeyboardButton("✅ Confirm & Submit", callback_data="confirm")])
    return InlineKeyboardMarkup(buttons)


def build_skip_keyboard() -> InlineKeyboardMarkup:
    """Single skip button shown under each onboarding question."""
    return InlineKeyboardMarkup([[InlineKeyboardButton("⏭️ Skip", callback_data="skip")]])


def build_wallet_keyboard() -> InlineKeyboardMarkup:
    """Shown on the near_address step - links to wallet creation instead of skip."""
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("☄️ Create NEAR Wallet", url=NEAR_WALLET_URL)
    ]])


def build_skills_keyboard(selected: list[str]) -> InlineKeyboardMarkup:
    """Toggle keyboard for skills - selected ones show ✅, two per row."""
    buttons = []
    row = []
    for skill in ALLOWED_SKILLS:
        label = f"✅ {skill}" if skill in selected else skill
        row.append(InlineKeyboardButton(label, callback_data=f"skill:{skill}"))
        if len(row) == 2:
            buttons.append(row)
            row = []
    if row:
        buttons.append(row)
    # Done and Skip on the last row
    buttons.append([
        InlineKeyboardButton("✅ Done", callback_data="skills_done"),
        InlineKeyboardButton("⏭️ Skip", callback_data="skip"),
    ])
    return InlineKeyboardMarkup(buttons)


def build_links_keyboard() -> InlineKeyboardMarkup:
    """Keyboard shown on the links overview screen."""
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("➕ Add Link", callback_data="link_add")],
        [InlineKeyboardButton("✅ Done", callback_data="links_done"),
         InlineKeyboardButton("⏭️ Skip", callback_data="skip")],
    ])


def build_links_confirm_keyboard(label: str) -> InlineKeyboardMarkup:
    """Keyboard shown after label is entered - confirm or re-enter."""
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(f'✅ Use "{label}"', callback_data=f"link_label_confirm:{label}")],
        [InlineKeyboardButton("✏️ Re-enter label", callback_data="link_add")],
    ])


async def send_links_overview(user_id: int, context: ContextTypes.DEFAULT_TYPE):
    """Send or refresh the links overview with current links and action buttons."""
    state = get_session(user_id)
    text = build_links_overview(state)
    await context.bot.send_message(
        chat_id=user_id,
        text=text + "\n\nAdd a link or press Done when finished.",
        parse_mode=ParseMode.HTML,
        reply_markup=build_links_keyboard(),
    )


async def send_next_question(user_id: int, context: ContextTypes.DEFAULT_TYPE):
    """Send the question for whatever step the session is currently on."""
    state = get_session(user_id)
    step = state.editing_field or state.current_step

    if step and step != "done":
        question = STEP_QUESTIONS[step]
        if step == "near_address":
            await context.bot.send_message(
                chat_id=user_id,
                text=question,
                parse_mode=ParseMode.HTML,
                reply_markup=build_wallet_keyboard(),
            )
        elif step == "skills":
            selected = get_selected_skills(get_session(user_id))
            await context.bot.send_message(
                chat_id=user_id,
                text=question,
                parse_mode=ParseMode.HTML,
                reply_markup=build_skills_keyboard(selected),
            )
        elif step == "links":
            await send_links_overview(user_id, context)
        else:
            await context.bot.send_message(
                chat_id=user_id,
                text=question,
                parse_mode=ParseMode.HTML,
                reply_markup=build_skip_keyboard(),
            )


async def send_summary(user_id: int, context: ContextTypes.DEFAULT_TYPE):
    """Send the full summary with edit/confirm keyboard."""
    state = get_session(user_id)
    summary = build_summary(state)
    await context.bot.send_message(
        chat_id=user_id,
        text=summary + "\n\n<i>Use the buttons below to edit any field or confirm your submission.</i>",
        parse_mode=ParseMode.HTML,
        reply_markup=build_edit_keyboard(),
    )


# ---------------------------------------------------------------------------
# /start  - DM from user
# ---------------------------------------------------------------------------

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user

    # Check for a pending nomination by username (for username-only nomination path)
    if user.username and not db.has_started_bot(user.id):
        pending = db.claim_pending_nomination(user.id, user.username)
        if pending:
            logger.info(f"Claimed pending nomination for @{user.username} (user_id={user.id})")
            db.register_user(user.id, user.username, user.first_name)

    # Not nominated at all
    if not db.has_started_bot(user.id):
        await update.message.reply_text(
            "👋 Welcome to the <b>NEAR Builders</b> onboarding bot!\n\n"
            "You will need to be nominated to enter the bot!",
            parse_mode=ParseMode.HTML,
        )
        return

    # Already completed onboarding
    if db.has_completed(user.id):
        await update.message.reply_text(
            "✅ You've already submitted your builder profile!\n\n"
            "The NEAR Builders team will be in touch. In the meantime, join @NearBuildersChat and follow @NearDevHub if you haven't already.\n\n"
            "Welcome to the community! 🌿",
            parse_mode=ParseMode.HTML,
        )
        return

    # Nominated - refresh user record and kick off the onboarding flow
    db.register_user(user.id, user.username, user.first_name)
    start_session(user.id)

    await update.message.reply_text(
        "✅ You've been nominated! Let's set up your builder profile.\n\n"
        "I'll ask you a few quick questions. "
        "All fields are optional - type <code>skip</code> to leave any field blank.\n\n"
        "Let's get started! 🚀",
        parse_mode=ParseMode.HTML,
    )
    await send_next_question(user.id, context)


# ---------------------------------------------------------------------------
# /onboard  - used in a group, as a reply to the target user
# ---------------------------------------------------------------------------

async def cmd_nominate(update: Update, context: ContextTypes.DEFAULT_TYPE):
    message = update.message
    chat = update.effective_chat
    invoker = update.effective_user
    target = None

    # Method 1: /onboard @username
    if context.args:
        username = context.args[0].lstrip("@")

        # Try DB first (most reliable - works if they've interacted with the bot before)
        db_user = db.get_user_by_username(username)
        if db_user:
            logger.info(f"Username @{username} resolved from DB (user_id={db_user['user_id']})")
            from telegram import User as TGUser
            target = type("User", (), {
                "id": db_user["user_id"],
                "username": db_user["username"],
                "first_name": db_user["first_name"],
                "is_bot": False,
                "mention_html": lambda self=None: f'<a href="tg://user?id={db_user["user_id"]}">{db_user["first_name"] or db_user["username"]}</a>',
            })()
        else:
            # Fall back to get_chat_member - works even if they haven't used the bot
            try:
                chat_member = await context.bot.get_chat_member(chat.id, f"@{username}")
                target = chat_member.user
                logger.info(f"Username @{username} resolved via get_chat_member (user_id={target.id})")
            except Exception as e:
                logger.info(f"Username @{username} could not be resolved ({e}) - using username-only fallback")
                # Can't resolve via API either - proceed with username only, no user_id
                target = type("User", (), {
                    "id": None,
                    "username": username,
                    "first_name": username,
                    "is_bot": False,
                    "mention_html": lambda self=None: f"@{username}",
                })()

    # Method 2: reply to a message
    elif message.reply_to_message:
        target = message.reply_to_message.from_user

    # Neither provided
    else:
        await message.reply_text(
            "⚠️ Use this command as a <b>reply</b> to someone, or with a username:\n"
            "<code>/onboard @username</code>",
            parse_mode=ParseMode.HTML,
        )
        return

    # Can't nominate a bot
    if target.is_bot:
        await message.reply_text("🤖 You can't nominate a bot!")
        return

    target_mention = target.mention_html() if callable(target.mention_html) else target.mention_html
    invoker_mention = invoker.mention_html()

    # If we have no user ID we can't DM them - store pending nomination by username
    if not target.id:
        db.add_pending_nomination(target.username, invoker.id, chat.id)
        db.log_nomination(
            nominated_by_user_id=invoker.id,
            group_chat_id=chat.id,
            nominated_username=target.username,
        )
        logger.info(f"Pending nomination stored for @{target.username}")
        bot_username = BOT_USERNAME.lstrip("@")
        start_keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("💬 Start Chat", url=f"https://t.me/{bot_username}")]
        ])
        await message.reply_text(
            f"👋 {target_mention}, you've been nominated as a NEAR Builder by {invoker_mention}!\n\n"
            "To complete your profile, please start a chat with me first by clicking the button below.",
            parse_mode=ParseMode.HTML,
            reply_markup=start_keyboard,
        )
        return

    # Check if they've previously started the bot BEFORE registering them
    already_started = db.has_started_bot(target.id)
    already_completed = db.has_completed(target.id) if already_started else False

    logger.info(f"Nomination check for user_id={target.id} username={target.username} already_started={already_started} already_completed={already_completed}")

    # If they've already completed onboarding - react with ✅, no group message
    if already_started and already_completed:
        try:
            await context.bot.set_message_reaction(
                chat_id=chat.id,
                message_id=message.message_id,
                reaction=[ReactionTypeEmoji(emoji="🎉")],
            )
        except Exception as e:
            logger.warning(f"Could not set reaction: {e}")
        return

    # Register the nominated user so they can pass the /start gate,
    # then log the nomination event
    db.register_user(target.id, target.username, target.first_name)
    db.log_nomination(
        nominated_user_id=target.id,
        nominated_by_user_id=invoker.id,
        group_chat_id=chat.id,
        nominated_username=target.username,
    )

    if already_started:
        # User has already started the bot - send them a DM directly
        try:
            start_session(target.id)
            await context.bot.send_message(
                chat_id=target.id,
                text=(
                    f"🎉 You've been nominated as a NEAR Builder by {invoker_mention}!\n\n"
                    "Let's set up your builder profile. I'll ask you a few quick questions.\n"
                    "Type <code>skip</code> at any point to leave a field blank.\n\n"
                    "Let's go! 🚀"
                ),
                parse_mode=ParseMode.HTML,
            )
            await send_next_question(target.id, context)

            # React with ⏳ on the command message - nominated, in progress
            try:
                await context.bot.set_message_reaction(
                    chat_id=chat.id,
                    message_id=message.message_id,
                    reaction=[ReactionTypeEmoji(emoji="👀")],
                )
            except Exception as re:
                logger.warning(f"Could not set reaction: {re}")

        except Exception as e:
            logger.warning(f"Failed to DM user {target.id}: {e}")
            start_keyboard = InlineKeyboardMarkup([
                [InlineKeyboardButton("💬 Start Chat", url=f"https://t.me/{BOT_USERNAME.lstrip('@')}")]
            ])
            await message.reply_text(
                f"⚠️ {target_mention} has been nominated, but I couldn't send them a DM. "
                "Please start a chat with me first by clicking the button below.",
                parse_mode=ParseMode.HTML,
                reply_markup=start_keyboard,
            )
    else:
        # User hasn't started the bot yet - react with ⏳ and send Start Chat button
        try:
            await context.bot.set_message_reaction(
                chat_id=chat.id,
                message_id=message.message_id,
                reaction=[ReactionTypeEmoji(emoji="👀")],
            )
        except Exception as e:
            logger.warning(f"Could not set reaction: {e}")
        start_keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("💬 Start Chat", url=f"https://t.me/{BOT_USERNAME.lstrip('@')}")]
        ])
        await message.reply_text(
            f"👋 {target_mention}, you've been nominated as a NEAR Builder by {invoker_mention}!\n\n"
            "To complete your profile, please start a chat with me first by clicking the button below.",
            parse_mode=ParseMode.HTML,
            reply_markup=start_keyboard,
        )


# ---------------------------------------------------------------------------
# Incoming DM text messages - onboarding answers
# ---------------------------------------------------------------------------

async def handle_dm_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    text = update.message.text.strip()

    state = get_session(user.id)

    # Not in a session
    if state.current_step is None:
        await update.message.reply_text(
            "Use /start to begin your builder profile onboarding, "
            "or wait to be nominated in a group!"
        )
        return

    # Already done - prompt them to confirm or edit
    if state.current_step == "done" and state.editing_field is None:
        await send_summary(user.id, context)
        return

    # Handle links sub-flow text input
    if (state.current_step == "links" or state.editing_field == "links"):
        if state.links_sub_step == "awaiting_label":
            label = text.strip()
            if not label:
                await update.message.reply_text("⚠️ Please enter a label, e.g. <code>github</code>", parse_mode=ParseMode.HTML)
                return
            state.pending_link_label = label
            state.links_sub_step = "awaiting_url"
            await update.message.reply_text(
                f"🔗 Now enter the URL for <b>{_escape_html(label)}</b>:",
                parse_mode=ParseMode.HTML,
            )
            return

        elif state.links_sub_step == "awaiting_url":
            url = text.strip()
            if not url:
                await update.message.reply_text("⚠️ Please enter a URL.", parse_mode=ParseMode.HTML)
                return
            label = state.pending_link_label or "link"
            add_link(state, label, url)
            state.links_sub_step = None
            state.pending_link_label = None
            await send_links_overview(user.id, context)
            return

    # Validate and store the answer.
    # ✂️ prefix = soft warning (answer accepted, trimmed) - show message but continue
    # ⚠️ prefix = hard validation error - show message and re-ask the same question
    message_out = apply_answer(state, text)

    if message_out:
        await update.message.reply_text(message_out, parse_mode=ParseMode.HTML)
        if message_out.startswith("⚠️"):
            return  # stay on the same step

    # Advance the flow
    new_step = next_step(state)

    if new_step == "done":
        await send_summary(user.id, context)
    else:
        await send_next_question(user.id, context)


# ---------------------------------------------------------------------------
# Inline button callbacks - edit field or confirm
# ---------------------------------------------------------------------------

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    user = update.effective_user
    state = get_session(user.id)
    data = query.data

    if data == "confirm":
        payload = build_api_payload(state)
        await query.edit_message_text(
            "⏳ Submitting your profile...",
        )

        # Fetch nomination context from DB for the API payload
        nomination = db.get_nomination(user.id)
        nominated_by = nomination["nominated_by_user_id"] if nomination else None
        group_chat_id = nomination["group_chat_id"] if nomination else None
        near_address = state.data.get("near_address")

        success, msg = await api_client.submit_builder(
            payload=payload,
            user_id=user.id,
            near_address=near_address,
            nominated_by_user_id=nominated_by,
            group_chat_id=group_chat_id,
        )

        if success:
            clear_session(user.id)
            db.mark_completed(user.id)
            await context.bot.send_message(
                chat_id=user.id,
                text=(
                    "🎉 <b>Your profile has been submitted and is now in review!</b>\n\n"
                    "The NEAR Builders team will be in touch. In the meantime, join @NearBuildersChat and follow @NearDevHub if you haven't already.\n\n"
                    "Welcome to the community! 🌿"
                ),
                parse_mode=ParseMode.HTML,
            )
        else:
            logger.error(f"API submission failed for user {user.id}: {msg}")
            await context.bot.send_message(
                chat_id=user.id,
                text=(
                    "❌ Something went wrong submitting your profile. Please try again in a moment.\n\n"
                    f"<i>Error: {msg}</i>"
                ),
                parse_mode=ParseMode.HTML,
                reply_markup=build_edit_keyboard(),
            )

    elif data.startswith("skill:"):
        skill = data.split(":", 1)[1]
        toggle_skill(state, skill)
        # Update the keyboard in-place
        selected = get_selected_skills(state)
        try:
            await query.edit_message_reply_markup(
                reply_markup=build_skills_keyboard(selected),
            )
        except Exception:
            pass  # message unchanged - no-op

    elif data == "skills_done":
        new_step = next_step(state)
        if new_step == "done":
            await send_summary(user.id, context)
        else:
            await send_next_question(user.id, context)

    elif data == "link_add":
        state.links_sub_step = "awaiting_label"
        state.pending_link_label = None
        await context.bot.send_message(
            chat_id=user.id,
            text="🏷 Enter a label for this link, e.g. <code>github</code>, <code>twitter</code>, <code>website</code>:",
            parse_mode=ParseMode.HTML,
        )

    elif data.startswith("link_label_confirm:"):
        label = data.split(":", 1)[1]
        state.links_sub_step = "awaiting_url"
        state.pending_link_label = label
        await context.bot.send_message(
            chat_id=user.id,
            text=f"🔗 Now enter the URL for <b>{_escape_html(label)}</b>:",
            parse_mode=ParseMode.HTML,
        )

    elif data == "links_done":
        state.links_sub_step = None
        state.pending_link_label = None
        new_step = next_step(state)
        if new_step == "done":
            await send_summary(user.id, context)
        else:
            await send_next_question(user.id, context)

    elif data == "skip":
        # near_address is mandatory - skip not allowed
        if (state.current_step == "near_address" or state.editing_field == "near_address"):
            await query.answer("NEAR address is required - please enter your address.", show_alert=True)
            return
        skip_current_step(state)
        new_step = next_step(state)
        if new_step == "done":
            await send_summary(user.id, context)
        else:
            await send_next_question(user.id, context)

    elif data.startswith("edit:"):
        field = data.split(":", 1)[1]
        if field not in STEPS:
            return

        state.editing_field = field
        await query.edit_message_text(
            build_summary(state),
            parse_mode=ParseMode.HTML,
        )
        if field == "near_address":
            await context.bot.send_message(
                chat_id=user.id,
                text=f"✏️ <b>Editing NEAR Address</b>\n\n{STEP_QUESTIONS['near_address']}",
                parse_mode=ParseMode.HTML,
                reply_markup=build_wallet_keyboard(),
            )
        elif field == "skills":
            selected = get_selected_skills(state)
            await context.bot.send_message(
                chat_id=user.id,
                text=f"✏️ <b>Editing Skills</b>\n\n{STEP_QUESTIONS['skills']}",
                parse_mode=ParseMode.HTML,
                reply_markup=build_skills_keyboard(selected),
            )
        elif field == "links":
            await send_links_overview(user.id, context)
        else:
            await context.bot.send_message(
                chat_id=user.id,
                text=f"✏️ <b>Editing {STEP_LABELS[field]}</b>\n\n{STEP_QUESTIONS[field]}",
                parse_mode=ParseMode.HTML,
            )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def post_init(application):
    """Clear all command menu entries so the button doesn't appear in any chat."""
    from telegram import BotCommandScopeAllGroupChats, BotCommandScopeAllPrivateChats, BotCommandScopeDefault

    await application.bot.set_my_commands([], scope=BotCommandScopeDefault())
    await application.bot.set_my_commands([], scope=BotCommandScopeAllGroupChats())
    await application.bot.set_my_commands([], scope=BotCommandScopeAllPrivateChats())
    logger.info("Bot command menu cleared.")


def main():
    db.setup_db()

    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        raise ValueError("TELEGRAM_BOT_TOKEN is not set in .env")

    app = Application.builder().token(token).post_init(post_init).build()

    # Commands
    app.add_handler(CommandHandler("start", cmd_start, filters=filters.ChatType.PRIVATE))
    app.add_handler(CommandHandler("onboard", cmd_nominate, filters=filters.ChatType.GROUPS))

    # DM text messages (onboarding answers)
    app.add_handler(MessageHandler(
        filters.ChatType.PRIVATE & filters.TEXT & ~filters.COMMAND,
        handle_dm_message,
    ))

    # Inline button presses
    app.add_handler(CallbackQueryHandler(handle_callback))

    logger.info("Bot is running...")
    # Python 3.10+ no longer auto-creates an event loop - create one explicitly
    import asyncio
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
