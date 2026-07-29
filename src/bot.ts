import { Markup, Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import type { User } from "telegraf/types";
import { submitBuilder as submitBuilderDefault } from "./api-client.js";
import { ALLOWED_SKILLS, config } from "./config.js";
import {
  STEP_LABELS,
  STEP_QUESTIONS,
  STEPS,
  addLink,
  applyAnswer,
  buildApiPayload,
  buildLinksOverview,
  buildSummary,
  clearSession,
  escapeHtml,
  getSelectedSkills,
  getSession,
  nextStep,
  skipCurrentStep,
  startSession,
  toggleSkill,
  type Step,
} from "./conversation.js";
import * as defaultDb from "./db.js";
import { logger } from "./logger.js";

type HandlerDatabase = Pick<
  typeof defaultDb,
  | "hasStartedBot"
  | "claimPendingNomination"
  | "registerUser"
  | "hasCompleted"
  | "getUserByUsername"
  | "addPendingNomination"
  | "logNomination"
  | "getNomination"
  | "markCompleted"
>;

export interface BotDependencies {
  db: HandlerDatabase;
  submitBuilder: typeof submitBuilderDefault;
}

const productionDependencies: BotDependencies = {
  db: defaultDb,
  submitBuilder: submitBuilderDefault,
};

interface NominationTarget {
  id: number | null;
  username: string | null;
  firstName: string;
  isBot: boolean;
}

function isPrivate(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

function isGroup(ctx: Context): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

function mentionUser(user: Pick<User, "id" | "first_name">): string {
  return `<a href="tg://user?id=${user.id}">${escapeHtml(user.first_name)}</a>`;
}

function mentionTarget(target: NominationTarget): string {
  if (target.id !== null) {
    return `<a href="tg://user?id=${target.id}">${escapeHtml(target.firstName)}</a>`;
  }
  return `@${escapeHtml(target.username ?? target.firstName)}`;
}

function buildEditKeyboard() {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let index = 0; index < STEPS.length; index += 2) {
    const first = STEPS[index];
    if (!first) continue;
    const row = [
      Markup.button.callback(`✏️ ${STEP_LABELS[first]}`, `edit:${first}`),
    ];
    const second = STEPS[index + 1];
    if (second) {
      row.push(
        Markup.button.callback(`✏️ ${STEP_LABELS[second]}`, `edit:${second}`),
      );
    }
    rows.push(row);
  }
  rows.push([Markup.button.callback("✅ Confirm & Submit", "confirm")]);
  return Markup.inlineKeyboard(rows);
}

function buildSkipKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⏭️ Skip", "skip")],
  ]);
}

function buildWalletKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.url("☄️ Create NEAR Wallet", config.nearWalletUrl)],
  ]);
}

function buildSkillsKeyboard(selected: string[]) {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  let row: ReturnType<typeof Markup.button.callback>[] = [];

  for (const skill of ALLOWED_SKILLS) {
    row.push(
      Markup.button.callback(
        selected.includes(skill) ? `✅ ${skill}` : skill,
        `skill:${skill}`,
      ),
    );
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  rows.push([
    Markup.button.callback("✅ Done", "skills_done"),
    Markup.button.callback("⏭️ Skip", "skip"),
  ]);
  return Markup.inlineKeyboard(rows);
}

function buildLinksKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Add Link", "link_add")],
    [
      Markup.button.callback("✅ Done", "links_done"),
      Markup.button.callback("⏭️ Skip", "skip"),
    ],
  ]);
}

export function buildLinksConfirmKeyboard(label: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `✅ Use "${label}"`,
        `link_label_confirm:${label}`,
      ),
    ],
    [Markup.button.callback("✏️ Re-enter label", "link_add")],
  ]);
}

function buildStartKeyboard(ctx: Context) {
  const username = config.botUsername || ctx.botInfo.username;
  return Markup.inlineKeyboard([
    [Markup.button.url("💬 Start Chat", `https://t.me/${username}`)],
  ]);
}

async function replyToGroupCommand(
  ctx: Context,
  text: string,
  extra: Parameters<Context["reply"]>[1] = {},
): Promise<void> {
  if (!ctx.message) return;
  await ctx.reply(text, {
    ...extra,
    reply_parameters: { message_id: ctx.message.message_id },
  });
}

async function sendLinksOverview(
  userId: number,
  ctx: Context,
): Promise<void> {
  const state = getSession(userId);
  await ctx.telegram.sendMessage(
    userId,
    `${buildLinksOverview(state)}\n\nAdd a link or press Done when finished.`,
    {
      parse_mode: "HTML",
      ...buildLinksKeyboard(),
    },
  );
}

async function sendNextQuestion(
  userId: number,
  ctx: Context,
): Promise<void> {
  const state = getSession(userId);
  const step = state.editingField ?? state.currentStep;
  if (!step || step === "done") return;

  const common = {
    parse_mode: "HTML" as const,
  };
  if (step === "near_address") {
    await ctx.telegram.sendMessage(userId, STEP_QUESTIONS[step], {
      ...common,
      ...buildWalletKeyboard(),
    });
  } else if (step === "skills") {
    await ctx.telegram.sendMessage(userId, STEP_QUESTIONS[step], {
      ...common,
      ...buildSkillsKeyboard(getSelectedSkills(state)),
    });
  } else if (step === "links") {
    await sendLinksOverview(userId, ctx);
  } else {
    await ctx.telegram.sendMessage(userId, STEP_QUESTIONS[step], {
      ...common,
      ...buildSkipKeyboard(),
    });
  }
}

async function sendSummary(userId: number, ctx: Context): Promise<void> {
  await ctx.telegram.sendMessage(
    userId,
    `${buildSummary(getSession(userId))}\n\n<i>Use the buttons below to edit any field or confirm your submission.</i>`,
    {
      parse_mode: "HTML",
      ...buildEditKeyboard(),
    },
  );
}

async function handleStart(
  ctx: Context,
  dependencies: BotDependencies,
): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from) return;
  const user = ctx.from;
  const { db } = dependencies;

  if (user.username && !(await db.hasStartedBot(user.id))) {
    const pending = await db.claimPendingNomination(user.id, user.username);
    if (pending) {
      logger.info(
        { username: user.username, userId: user.id },
        "Claimed pending nomination",
      );
      await db.registerUser(user.id, user.username, user.first_name);
    }
  }

  if (!(await db.hasStartedBot(user.id))) {
    await ctx.reply(
      "👋 Welcome to the <b>NEAR Builders</b> onboarding bot!\n\n" +
        "You will need to be nominated to enter the bot!",
      { parse_mode: "HTML" },
    );
    return;
  }

  if (await db.hasCompleted(user.id)) {
    await ctx.reply(
      "✅ You've already submitted your builder profile!\n\n" +
        "The NEAR Builders team will be in touch. In the meantime, join @NearBuildersChat and follow @NearDevHub if you haven't already.\n\n" +
        "Welcome to the community! 🌿",
      { parse_mode: "HTML" },
    );
    return;
  }

  await db.registerUser(user.id, user.username, user.first_name);
  startSession(user.id);
  await ctx.reply(
    "✅ You've been nominated! Let's set up your builder profile.\n\n" +
      "I'll ask you a few quick questions. " +
      "All fields are optional - type <code>skip</code> to leave any field blank.\n\n" +
      "Let's get started! 🚀",
    { parse_mode: "HTML" },
  );
  await sendNextQuestion(user.id, ctx);
}

async function resolveTarget(
  ctx: Context,
  username: string,
  dependencies: BotDependencies,
): Promise<NominationTarget> {
  const { db } = dependencies;
  const dbUser = await db.getUserByUsername(username);
  if (dbUser) {
    logger.info(
      { username, userId: dbUser.user_id },
      "Username resolved from database",
    );
    return {
      id: dbUser.user_id,
      username: dbUser.username,
      firstName: dbUser.first_name ?? dbUser.username ?? username,
      isBot: false,
    };
  }

  try {
    // The Bot API types require a numeric ID, but this intentionally preserves
    // the original bot's best-effort @username lookup before its pending path.
    const member = await ctx.telegram.callApi("getChatMember", {
      chat_id: ctx.chat!.id,
      user_id: `@${username}` as unknown as number,
    });
    logger.info(
      { username, userId: member.user.id },
      "Username resolved from Telegram",
    );
    return {
      id: member.user.id,
      username: member.user.username ?? username,
      firstName: member.user.first_name,
      isBot: member.user.is_bot,
    };
  } catch (error) {
    logger.info(
      { username, err: error },
      "Username could not be resolved; using pending nomination",
    );
    return {
      id: null,
      username,
      firstName: username,
      isBot: false,
    };
  }
}

async function handleNominate(
  ctx: Context,
  dependencies: BotDependencies,
): Promise<void> {
  if (!isGroup(ctx) || !ctx.from || !ctx.message || !("text" in ctx.message)) {
    return;
  }

  const invoker = ctx.from;
  const argument = ctx.message.text.split(/\s+/)[1];
  let target: NominationTarget | null = null;

  if (argument) {
    const username = argument.replace(/^@/, "");
    if (username) target = await resolveTarget(ctx, username, dependencies);
  } else if (
    ctx.message.reply_to_message &&
    ctx.message.reply_to_message.from
  ) {
    const replyUser = ctx.message.reply_to_message.from;
    target = {
      id: replyUser.id,
      username: replyUser.username ?? null,
      firstName: replyUser.first_name,
      isBot: replyUser.is_bot,
    };
  }

  if (!target) {
    await replyToGroupCommand(
      ctx,
      "⚠️ Use this command as a <b>reply</b> to someone, or with a username:\n" +
        "<code>/onboard @username</code>",
      { parse_mode: "HTML" },
    );
    return;
  }

  if (target.isBot) {
    await replyToGroupCommand(ctx, "🤖 You can't nominate a bot!");
    return;
  }

  const targetMention = mentionTarget(target);
  const invokerMention = mentionUser(invoker);
  const { db } = dependencies;

  if (target.id === null) {
    const username = target.username;
    if (!username) return;
    await db.addPendingNomination(username, invoker.id, ctx.chat!.id);
    await db.logNomination({
      nominatedByUserId: invoker.id,
      groupChatId: ctx.chat!.id,
      nominatedUsername: username,
    });
    logger.info({ username }, "Pending nomination stored");
    await replyToGroupCommand(
      ctx,
      `👋 ${targetMention}, you've been nominated as a NEAR Builder by ${invokerMention}!\n\n` +
        "To complete your profile, please start a chat with me first by clicking the button below.",
      {
        parse_mode: "HTML",
        ...buildStartKeyboard(ctx),
      },
    );
    return;
  }

  const alreadyStarted = await db.hasStartedBot(target.id);
  const alreadyCompleted = alreadyStarted
    ? await db.hasCompleted(target.id)
    : false;
  logger.info(
    {
      userId: target.id,
      username: target.username,
      alreadyStarted,
      alreadyCompleted,
    },
    "Nomination status checked",
  );

  if (alreadyStarted && alreadyCompleted) {
    try {
      await ctx.react("🎉");
    } catch (error) {
      logger.warn({ err: error }, "Could not set completed reaction");
    }
    return;
  }

  await db.registerUser(
    target.id,
    target.username ?? undefined,
    target.firstName,
  );
  await db.logNomination({
    nominatedUserId: target.id,
    nominatedByUserId: invoker.id,
    groupChatId: ctx.chat!.id,
    ...(target.username
      ? { nominatedUsername: target.username }
      : {}),
  });

  if (alreadyStarted) {
    try {
      startSession(target.id);
      await ctx.telegram.sendMessage(
        target.id,
        `🎉 You've been nominated as a NEAR Builder by ${invokerMention}!\n\n` +
          "Let's set up your builder profile. I'll ask you a few quick questions.\n" +
          "Type <code>skip</code> at any point to leave a field blank.\n\n" +
          "Let's go! 🚀",
        { parse_mode: "HTML" },
      );
      await sendNextQuestion(target.id, ctx);
      try {
        await ctx.react("👀");
      } catch (error) {
        logger.warn({ err: error }, "Could not set in-progress reaction");
      }
    } catch (error) {
      logger.warn({ userId: target.id, err: error }, "Failed to DM user");
      await replyToGroupCommand(
        ctx,
        `⚠️ ${targetMention} has been nominated, but I couldn't send them a DM. ` +
          "Please start a chat with me first by clicking the button below.",
        {
          parse_mode: "HTML",
          ...buildStartKeyboard(ctx),
        },
      );
    }
    return;
  }

  try {
    await ctx.react("👀");
  } catch (error) {
    logger.warn({ err: error }, "Could not set in-progress reaction");
  }
  await replyToGroupCommand(
    ctx,
    `👋 ${targetMention}, you've been nominated as a NEAR Builder by ${invokerMention}!\n\n` +
      "To complete your profile, please start a chat with me first by clicking the button below.",
    {
      parse_mode: "HTML",
      ...buildStartKeyboard(ctx),
    },
  );
}

async function handleDmMessage(ctx: Context): Promise<void> {
  if (
    !isPrivate(ctx) ||
    !ctx.from ||
    !ctx.message ||
    !("text" in ctx.message) ||
    ctx.message.text.startsWith("/")
  ) {
    return;
  }

  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const state = getSession(userId);

  if (state.currentStep === null) {
    await ctx.reply(
      "Use /start to begin your builder profile onboarding, or wait to be nominated in a group!",
    );
    return;
  }

  if (state.currentStep === "done" && state.editingField === null) {
    await sendSummary(userId, ctx);
    return;
  }

  if (state.currentStep === "links" || state.editingField === "links") {
    if (state.linksSubStep === "awaiting_label") {
      if (!text) {
        await ctx.reply(
          "⚠️ Please enter a label, e.g. <code>github</code>",
          { parse_mode: "HTML" },
        );
        return;
      }
      state.pendingLinkLabel = text;
      state.linksSubStep = "awaiting_url";
      await ctx.reply(
        `🔗 Now enter the URL for <b>${escapeHtml(text)}</b>:`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (state.linksSubStep === "awaiting_url") {
      if (!text) {
        await ctx.reply("⚠️ Please enter a URL.", { parse_mode: "HTML" });
        return;
      }
      addLink(state, state.pendingLinkLabel ?? "link", text);
      state.linksSubStep = null;
      state.pendingLinkLabel = null;
      await sendLinksOverview(userId, ctx);
      return;
    }
  }

  const response = applyAnswer(state, text);
  if (response) {
    await ctx.reply(response, { parse_mode: "HTML" });
    if (response.startsWith("⚠️")) return;
  }

  const step = nextStep(state);
  if (step === "done") await sendSummary(userId, ctx);
  else await sendNextQuestion(userId, ctx);
}

function callbackData(ctx: Context): string | null {
  if (!ctx.callbackQuery || !("data" in ctx.callbackQuery)) return null;
  return ctx.callbackQuery.data;
}

async function handleCallback(
  ctx: Context,
  dependencies: BotDependencies,
): Promise<void> {
  if (!ctx.from) return;
  const data = callbackData(ctx);
  if (!data) return;

  const userId = ctx.from.id;
  const state = getSession(userId);

  if (
    data === "skip" &&
    (state.currentStep === "near_address" ||
      state.editingField === "near_address")
  ) {
    await ctx.answerCbQuery(
      "NEAR address is required - please enter your address.",
      { show_alert: true },
    );
    return;
  }
  await ctx.answerCbQuery();

  if (data === "confirm") {
    await ctx.editMessageText("⏳ Submitting your profile...");
    const nomination = await dependencies.db.getNomination(userId);
    const result = await dependencies.submitBuilder({
      payload: buildApiPayload(state),
      userId,
      nearAddress: state.data.near_address,
      nominatedByUserId: nomination?.nominated_by_user_id ?? null,
      groupChatId: nomination?.group_chat_id ?? null,
    });

    if (result.success) {
      clearSession(userId);
      await dependencies.db.markCompleted(userId);
      await ctx.telegram.sendMessage(
        userId,
        "🎉 <b>Your profile has been submitted and is now in review!</b>\n\n" +
          "The NEAR Builders team will be in touch. In the meantime, join @NearBuildersChat and follow @NearDevHub if you haven't already.\n\n" +
          "Welcome to the community! 🌿",
        { parse_mode: "HTML" },
      );
    } else {
      logger.error(
        { userId, error: result.message },
        "API submission failed",
      );
      await ctx.telegram.sendMessage(
        userId,
        "❌ Something went wrong submitting your profile. Please try again in a moment.\n\n" +
          `<i>Error: ${escapeHtml(result.message)}</i>`,
        {
          parse_mode: "HTML",
          ...buildEditKeyboard(),
        },
      );
    }
    return;
  }

  if (data.startsWith("skill:")) {
    toggleSkill(state, data.slice("skill:".length));
    try {
      await ctx.editMessageReplyMarkup(
        buildSkillsKeyboard(getSelectedSkills(state)).reply_markup,
      );
    } catch {
      // Telegram returns an error when the keyboard did not change.
    }
    return;
  }

  if (data === "skills_done") {
    const step = nextStep(state);
    if (step === "done") await sendSummary(userId, ctx);
    else await sendNextQuestion(userId, ctx);
    return;
  }

  if (data === "link_add") {
    state.linksSubStep = "awaiting_label";
    state.pendingLinkLabel = null;
    await ctx.telegram.sendMessage(
      userId,
      "🏷 Enter a label for this link, e.g. <code>github</code>, <code>twitter</code>, <code>website</code>:",
      { parse_mode: "HTML" },
    );
    return;
  }

  if (data.startsWith("link_label_confirm:")) {
    const label = data.slice("link_label_confirm:".length);
    state.linksSubStep = "awaiting_url";
    state.pendingLinkLabel = label;
    await ctx.telegram.sendMessage(
      userId,
      `🔗 Now enter the URL for <b>${escapeHtml(label)}</b>:`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (data === "links_done") {
    state.linksSubStep = null;
    state.pendingLinkLabel = null;
    const step = nextStep(state);
    if (step === "done") await sendSummary(userId, ctx);
    else await sendNextQuestion(userId, ctx);
    return;
  }

  if (data === "skip") {
    skipCurrentStep(state);
    const step = nextStep(state);
    if (step === "done") await sendSummary(userId, ctx);
    else await sendNextQuestion(userId, ctx);
    return;
  }

  if (data.startsWith("edit:")) {
    const field = data.slice("edit:".length) as Step;
    if (!STEPS.includes(field)) return;

    state.editingField = field;
    await ctx.editMessageText(buildSummary(state), {
      parse_mode: "HTML",
    });

    if (field === "near_address") {
      await ctx.telegram.sendMessage(
        userId,
        `✏️ <b>Editing NEAR Address</b>\n\n${STEP_QUESTIONS.near_address}`,
        {
          parse_mode: "HTML",
          ...buildWalletKeyboard(),
        },
      );
    } else if (field === "skills") {
      await ctx.telegram.sendMessage(
        userId,
        `✏️ <b>Editing Skills</b>\n\n${STEP_QUESTIONS.skills}`,
        {
          parse_mode: "HTML",
          ...buildSkillsKeyboard(getSelectedSkills(state)),
        },
      );
    } else if (field === "links") {
      await sendLinksOverview(userId, ctx);
    } else {
      await ctx.telegram.sendMessage(
        userId,
        `✏️ <b>Editing ${STEP_LABELS[field]}</b>\n\n${STEP_QUESTIONS[field]}`,
        { parse_mode: "HTML" },
      );
    }
  }
}

export async function clearCommandMenus(bot: Telegraf): Promise<void> {
  await Promise.all([
    bot.telegram.setMyCommands([], { scope: { type: "default" } }),
    bot.telegram.setMyCommands([], {
      scope: { type: "all_group_chats" },
    }),
    bot.telegram.setMyCommands([], {
      scope: { type: "all_private_chats" },
    }),
  ]);
  logger.info("Bot command menus cleared");
}

export function createBot(
  token: string,
  dependencies: BotDependencies = productionDependencies,
): Telegraf {
  const bot = new Telegraf(token);
  bot.start((ctx) => handleStart(ctx, dependencies));
  bot.command("onboard", (ctx) => handleNominate(ctx, dependencies));
  bot.on(message("text"), handleDmMessage);
  bot.on("callback_query", (ctx) => handleCallback(ctx, dependencies));
  bot.catch((error, ctx) => {
    logger.error(
      { err: error, updateId: ctx.update.update_id },
      "Unhandled bot update error",
    );
  });
  return bot;
}
