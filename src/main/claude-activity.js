// Tracks what Claude Code sessions are doing, from hook events. Pure (clock injected) so it can be unit tested.

const THINKING = 'thinking';
const BUSY = 'busy';
const WAITING = 'waiting';
const PRIORITY = { [WAITING]: 3, [BUSY]: 2, [THINKING]: 1 };

function isIdleNotification(payload) {
  return payload.notification_type === 'idle_prompt' || /waiting for your input/i.test(payload.message || '');
}

class ClaudeActivity {
  constructor({
    now = Date.now,
    celebrateAfterMs = 20_000, // only celebrate turns that took at least this long
    staleMs = 10 * 60_000, // forget a working session that has gone silent (crashed, closed)
    waitingStaleMs = 30 * 60_000, // pending permission prompts are remembered longer
  } = {}) {
    this.now = now;
    this.celebrateAfterMs = celebrateAfterMs;
    this.staleMs = staleMs;
    this.waitingStaleMs = waitingStaleMs;
    this.sessions = new Map();
  }

  // Records a hook event and returns the reactions it deserves: 'alert' | 'approve' | 'taskDone'.
  handle(event, payload = {}) {
    const id = payload.session_id || 'default';
    const t = this.now();
    const previous = this.sessions.get(id);
    const setStatus = (status, turnStartedAt = previous?.turnStartedAt ?? t) => {
      this.sessions.set(id, { status, turnStartedAt, lastEventAt: t });
    };

    switch (event) {
      case 'UserPromptSubmit':
        setStatus(THINKING, t);
        return [];
      case 'PreToolUse':
        setStatus(BUSY);
        return previous?.status === WAITING ? ['approve'] : [];
      case 'PostToolUse':
        setStatus(THINKING);
        return previous?.status === WAITING ? ['approve'] : [];
      case 'PostToolUseFailure':
        setStatus(THINKING);
        return previous?.status === WAITING ? ['approve', 'error'] : ['error'];
      case 'PermissionRequest':
      case 'Notification':
        if (event === 'Notification' && isIdleNotification(payload)) return [];
        setStatus(WAITING);
        return previous?.status === WAITING ? [] : ['alert']; // PermissionRequest and its Notification ring once
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

module.exports = { ClaudeActivity };
