// Tracks what Claude Code sessions are doing, from hook events. Pure (clock injected) so it can be unit tested.
const crypto = require('node:crypto');

const THINKING = 'thinking';
const BUSY = 'busy';
const WAITING = 'waiting';
const PRIORITY = { [WAITING]: 3, [BUSY]: 2, [THINKING]: 1 };
const MAX_SESSIONS = 64;
const MAX_ID_LENGTH = 128;
const MAX_TRACKED = 32; // running tools and open permission prompts remembered per session

function isIdleNotification(payload) {
  return payload.notification_type === 'idle_prompt' || /waiting for your input/i.test(payload.message || '');
}

function shortText(value) {
  return typeof value === 'string' && value !== '' ? value.slice(0, MAX_ID_LENGTH) : null;
}

// Subagents and parallel tool calls report under the same session_id, so a permission prompt is matched to its
// own tool (and subagent) instead of being cleared by whichever tool finishes next.
function toolKey(payload) {
  return `${shortText(payload.agent_id) ?? ''} ${shortText(payload.tool_name) ?? ''}`;
}

function inputHash(payload) {
  if (payload.tool_input === undefined) return null;
  return crypto.createHash('sha256').update(JSON.stringify(payload.tool_input)).digest('hex');
}

// Removes the prompt a finished tool answers; returns whether there was one.
function takePrompt(prompts, key, toolUseId) {
  let index = toolUseId ? prompts.findIndex((p) => p.toolUseId === toolUseId) : -1;
  if (index < 0) {
    // A prompt only known from its Notification names no tool, so any tool finishing answers it.
    index = prompts.findIndex((p) => p.key === null || (p.key === key && !(p.toolUseId && toolUseId)));
  }
  if (index < 0) return false;
  prompts.splice(index, 1);
  return true;
}

class ClaudeActivity {
  constructor({
    now = Date.now,
    celebrateAfterMs = 20_000, // only celebrate turns that took at least this long
    staleMs = 10 * 60_000, // forget a working session that has gone silent (crashed, closed)
    waitingStaleMs = 30 * 60_000, // pending permission prompts are remembered longer
    maxSessions = MAX_SESSIONS,
  } = {}) {
    this.now = now;
    this.celebrateAfterMs = celebrateAfterMs;
    this.staleMs = staleMs;
    this.waitingStaleMs = waitingStaleMs;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
  }

  // The session an event belongs to, created if needed. The oldest session makes room when there are too many.
  touch(id, t) {
    let session = this.sessions.get(id);
    if (!session) {
      if (this.sessions.size >= this.maxSessions) {
        const [oldest] = [...this.sessions].reduce((a, b) => (b[1].lastEventAt < a[1].lastEventAt ? b : a));
        this.sessions.delete(oldest);
      }
      session = { status: THINKING, turnStartedAt: t, lastEventAt: t, tools: new Map(), prompts: [] };
      this.sessions.set(id, session);
    }
    session.lastEventAt = t;
    return session;
  }

  // The running tool a PermissionRequest is about: same tool and input, or the only running call of that tool.
  toolAsking(session, key, hash) {
    const candidates = [...session.tools]
      .filter(([id, tool]) => tool.key === key && !session.prompts.some((p) => p.toolUseId === id));
    const sameInput = hash && candidates.find(([, tool]) => tool.hash === hash);
    if (sameInput) return sameInput[0];
    return candidates.length === 1 ? candidates[0][0] : null;
  }

  // Records a hook event and returns the reactions it deserves: 'alert' | 'approve' | 'taskDone' | 'error'.
  handle(event, rawPayload) {
    const payload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload : {};
    const id = shortText(payload.session_id) ?? 'default';
    const t = this.now();
    const previous = this.sessions.get(id);

    switch (event) {
      case 'UserPromptSubmit': {
        const session = this.touch(id, t);
        Object.assign(session, { status: THINKING, turnStartedAt: t, tools: new Map(), prompts: [] });
        return [];
      }
      case 'PreToolUse': {
        const session = this.touch(id, t);
        const toolUseId = shortText(payload.tool_use_id);
        if (toolUseId) {
          session.tools.set(toolUseId, { key: toolKey(payload), hash: inputHash(payload) });
          if (session.tools.size > MAX_TRACKED) session.tools.delete(session.tools.keys().next().value);
        }
        if (!session.prompts.length) session.status = BUSY; // another tool starting doesn't answer a prompt
        return [];
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const session = this.touch(id, t);
        const toolUseId = shortText(payload.tool_use_id);
        if (toolUseId) session.tools.delete(toolUseId);
        const approved = takePrompt(session.prompts, toolKey(payload), toolUseId);
        if (!session.prompts.length) session.status = THINKING;
        const reactions = approved ? ['approve'] : [];
        return event === 'PostToolUseFailure' ? [...reactions, 'error'] : reactions;
      }
      case 'PermissionRequest': {
        const session = this.touch(id, t);
        const wasWaiting = session.prompts.length > 0;
        const key = toolKey(payload);
        const prompt = { key, toolUseId: this.toolAsking(session, key, inputHash(payload)) };
        const unnamed = session.prompts.findIndex((p) => p.key === null); // its Notification came first
        if (unnamed >= 0) session.prompts[unnamed] = prompt;
        else session.prompts.push(prompt);
        if (session.prompts.length > MAX_TRACKED) session.prompts.shift();
        session.status = WAITING;
        return wasWaiting ? [] : ['alert']; // PermissionRequest and its Notification ring once
      }
      case 'Notification': {
        // Claude Code sends idle_prompt when a turn is over and nothing is happening, including after you press
        // Esc or deny a permission, which don't send Stop.
        if (isIdleNotification(payload)) {
          this.sessions.delete(id);
          return [];
        }
        const session = this.touch(id, t);
        if (session.prompts.length) return [];
        session.prompts.push({ key: null, toolUseId: null });
        session.status = WAITING;
        return ['alert'];
      }
      case 'Stop':
        this.sessions.delete(id);
        return previous && t - previous.turnStartedAt >= this.celebrateAfterMs ? ['taskDone'] : [];
      case 'SessionEnd':
        this.sessions.delete(id);
        return [];
      default:
        return [];
    }
  }

  // The most urgent thing any session is doing: 'waiting' | 'busy' | 'thinking' | null.
  summary() {
    const t = this.now();
    let best = null;
    for (const [id, session] of this.sessions) {
      const limit = session.status === WAITING ? this.waitingStaleMs : this.staleMs;
      if (t - session.lastEventAt > limit) {
        this.sessions.delete(id);
      } else if (!best || PRIORITY[session.status] > PRIORITY[best]) {
        best = session.status;
      }
    }
    return best;
  }
}

module.exports = { ClaudeActivity, MAX_SESSIONS, MAX_ID_LENGTH };
