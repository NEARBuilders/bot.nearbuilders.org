import { ALLOWED_SKILLS } from "./config.js";

export const STEPS = [
  "near_address",
  "name",
  "bio",
  "skills",
  "location",
  "links",
] as const;

export type Step = (typeof STEPS)[number];
export type CurrentStep = Step | "done" | null;

export const BIO_MAX_CHARS = 1_000;
export const NAME_MAX_CHARS = 100;
export const SKILL_MAX_CHARS = 50;
export const MAX_SKILLS = 20;

export const STEP_QUESTIONS: Record<Step, string> = {
  near_address:
    "🔗 What is your NEAR address?\n\n" +
    "Accepted formats:\n" +
    "  • <code>yourname.near</code>\n" +
    "  • <code>yourname.tg</code>\n" +
    "  • 64-character hex address",
  name: "👤 What's your name?",
  bio: `📝 Describe yourself in a short bio:\n\nMax ${BIO_MAX_CHARS} characters - anything longer will be trimmed.`,
  skills:
    "🛠 Select your skills - tap to toggle, then press <b>Done</b>:",
  location: "📍 Where are you based?",
  links: "🔗 Add your links below. You can add as many as you like.",
};

export const STEP_LABELS: Record<Step, string> = {
  near_address: "NEAR Address",
  name: "Name",
  bio: "Bio",
  skills: "Skills",
  location: "Location",
  links: "Links",
};

export interface ProfileData {
  near_address: string | null;
  name: string | null;
  bio: string | null;
  skills: string[] | null;
  location: string | null;
  links: Record<string, string> | null;
}

export interface ConversationState {
  userId: number;
  currentStep: CurrentStep;
  editingField: Step | null;
  linksSubStep: "awaiting_label" | "awaiting_url" | null;
  pendingLinkLabel: string | null;
  data: ProfileData;
}

export type ApiPayload = Partial<
  Pick<ProfileData, "name" | "bio" | "skills" | "location" | "links">
>;

const sessions = new Map<number, ConversationState>();

function createState(
  userId: number,
  currentStep: CurrentStep = null,
): ConversationState {
  return {
    userId,
    currentStep,
    editingField: null,
    linksSubStep: null,
    pendingLinkLabel: null,
    data: {
      near_address: null,
      name: null,
      bio: null,
      skills: null,
      location: null,
      links: null,
    },
  };
}

export function getSession(userId: number): ConversationState {
  const existing = sessions.get(userId);
  if (existing) return existing;

  const state = createState(userId);
  sessions.set(userId, state);
  return state;
}

export function clearSession(userId: number): void {
  sessions.delete(userId);
}

export function startSession(userId: number): ConversationState {
  const state = createState(userId, STEPS[0]);
  sessions.set(userId, state);
  return state;
}

export function nextStep(state: ConversationState): CurrentStep {
  if (state.editingField) {
    state.editingField = null;
    state.currentStep = "done";
    return "done";
  }

  if (state.currentStep === null) {
    state.currentStep = STEPS[0];
    return state.currentStep;
  }

  if (state.currentStep === "done") return "done";

  const index = STEPS.indexOf(state.currentStep);
  state.currentStep = STEPS[index + 1] ?? "done";
  return state.currentStep;
}

export function skipCurrentStep(state: ConversationState): void {
  const step = state.editingField ?? state.currentStep;
  if (step && step !== "done") state.data[step] = null;
}

export function getSelectedSkills(state: ConversationState): string[] {
  return state.data.skills ?? [];
}

export function toggleSkill(
  state: ConversationState,
  skill: string,
): void {
  if (!ALLOWED_SKILLS.includes(skill)) return;

  const current = [...getSelectedSkills(state)];
  const index = current.indexOf(skill);
  if (index >= 0) {
    current.splice(index, 1);
  } else if (current.length < MAX_SKILLS) {
    current.push(skill);
  }
  state.data.skills = current.length > 0 ? current : null;
}

export function parseSkills(raw: string): {
  valid: string[];
  invalid: string[];
} {
  const allowedByLowercase = new Map(
    ALLOWED_SKILLS.map((skill) => [skill.toLowerCase(), skill]),
  );
  const entered = raw
    .split(",")
    .map((skill) => skill.trim())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const entry of entered) {
    const canonical = allowedByLowercase.get(entry.toLowerCase());
    if (canonical) valid.push(canonical);
    else invalid.push(entry);
  }

  return { valid: valid.slice(0, MAX_SKILLS), invalid };
}

export function addLink(
  state: ConversationState,
  label: string,
  url: string,
): void {
  state.data.links ??= {};
  state.data.links[label.trim().toLowerCase()] = url.trim();
}

export function removeLink(
  state: ConversationState,
  label: string,
): void {
  if (!state.data.links || !(label in state.data.links)) return;
  delete state.data.links[label];
  if (Object.keys(state.data.links).length === 0) state.data.links = null;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildLinksOverview(state: ConversationState): string {
  const links = state.data.links ?? {};
  if (Object.keys(links).length === 0) {
    return "🔗 <b>Links</b>\n\nNo links added yet.";
  }

  return [
    "🔗 <b>Links</b>\n",
    ...Object.entries(links).map(
      ([label, url]) =>
        `  • <b>${escapeHtml(label)}</b>: ${escapeHtml(url)}`,
    ),
  ].join("\n");
}

export function applyAnswer(
  state: ConversationState,
  text: string,
): string | null {
  const step = state.editingField ?? state.currentStep;

  if (step === "near_address") {
    const address = text.trim();
    if (!address) {
      return "⚠️ NEAR address is required. Please enter your address or create a wallet.";
    }
    if (
      address.endsWith(".near") ||
      address.endsWith(".tg") ||
      /^[0-9a-fA-F]{64}$/.test(address)
    ) {
      state.data.near_address = address;
    } else {
      return (
        "⚠️ That doesn't look like a valid NEAR address.\n\n" +
        "Accepted formats:\n" +
        "  • <code>yourname.near</code>\n" +
        "  • <code>yourname.tg</code>\n" +
        "  • 64-character hex address"
      );
    }
  } else if (step === "name") {
    if ([...text].length > NAME_MAX_CHARS) {
      return `⚠️ Name must be ${NAME_MAX_CHARS} characters or fewer.`;
    }
    state.data.name = text.trim();
  } else if (step === "bio") {
    const trimmed = text.trim();
    const codePoints = [...trimmed];
    state.data.bio = codePoints.slice(0, BIO_MAX_CHARS).join("");
    if (codePoints.length > BIO_MAX_CHARS) {
      return `✂️ Your bio was trimmed to ${BIO_MAX_CHARS} characters and saved.`;
    }
  } else if (step === "skills") {
    const { valid, invalid } = parseSkills(text);
    if (invalid.length > 0) {
      return (
        `⚠️ These skills aren't recognised: <b>${invalid.map(escapeHtml).join(", ")}</b>\n\n` +
        `Please choose from:\n<code>${escapeHtml(ALLOWED_SKILLS.join(", "))}</code>`
      );
    }
    state.data.skills = valid.length > 0 ? valid : null;
  } else if (step === "location") {
    state.data.location = text.trim();
  }

  return null;
}

function formatValue(
  value: string | string[] | Record<string, string> | null,
): string {
  if (value === null) return "<i>not provided</i>";
  if (Array.isArray(value)) {
    return value.length > 0
      ? escapeHtml(value.join(", "))
      : "<i>not provided</i>";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length > 0
      ? entries
          .map(
            ([key, item]) =>
              `  • ${escapeHtml(key)}: ${escapeHtml(item)}`,
          )
          .join("\n")
      : "<i>not provided</i>";
  }
  return escapeHtml(value);
}

export function buildSummary(state: ConversationState): string {
  const data = state.data;
  return [
    "📋 <b>Here's your builder profile so far:</b>\n",
    `🔗 <b>NEAR Address:</b> ${formatValue(data.near_address)}`,
    `👤 <b>Name:</b> ${formatValue(data.name)}`,
    `📝 <b>Bio:</b> ${formatValue(data.bio)}`,
    `🛠 <b>Skills:</b> ${formatValue(data.skills)}`,
    `📍 <b>Location:</b> ${formatValue(data.location)}`,
    `🔗 <b>Links:</b> ${formatValue(data.links)}`,
  ].join("\n");
}

export function buildApiPayload(state: ConversationState): ApiPayload {
  const payload: ApiPayload = {};
  const { name, bio, skills, location, links } = state.data;
  if (name) payload.name = name;
  if (bio) payload.bio = bio;
  if (skills) payload.skills = skills;
  if (location) payload.location = location;
  if (links) payload.links = links;
  return payload;
}
