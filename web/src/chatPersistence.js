const ACTION_FLAGS = ['pushed', 'applied', 'pushPending', 'actionPending', 'restoreBlocked'];

const compactPreview = (preview) => preview && ({ ...preview, segments: [] });

// Full plan previews are derivable and dominate stored size. Keep the plan and
// its distance/duration summaries, but drop segment arrays. Older plan payloads
// stay represented by their assistant text and model-history marker.
export function compactMessages(messages) {
  let latestPlan = -1;
  messages.forEach((message, index) => { if (message.plan) latestPlan = index; });
  return messages.map((message, index) => {
    let next = { ...message };
    if (message.plan) {
      if (index !== latestPlan) {
        const { plan, ...rest } = next;
        next = rest;
      } else {
        next.plan = {
          ...message.plan,
          sessions: (message.plan.sessions || []).map((session) => ({
            ...session,
            preview: compactPreview(session.preview),
          })),
        };
      }
    }
    if (message.preview && (message.pushed || message.applied)) {
      next.preview = compactPreview(message.preview);
    }
    return next;
  });
}

export function restoreMessages(messages) {
  let interrupted = false;
  const safe = messages.map((message) => {
    if (!message.pushPending && !message.actionPending) return message;
    interrupted = true;
    const { pushPending, actionPending, ...rest } = message;
    return { ...rest, restoreBlocked: true };
  });
  return { messages: safe, interrupted };
}

export const restoredMode = (threadMode, messages) =>
  messages.some((message) => message.planningEnded) ? 'chat' : threadMode;

export function actionRefreshReason(thread, index, baseRevision) {
  if (thread.revision !== baseRevision) return 'changed';
  const message = thread.messages[index];
  if (!message) return 'changed';
  return ACTION_FLAGS.some((flag) => message[flag]) ? 'already handled' : null;
}
