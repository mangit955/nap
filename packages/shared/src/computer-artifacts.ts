/** A durable tool call reserves this key before a screenshot can be uploaded. */
export function computerScreenshotKey(identity: {
  projectId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
}): string {
  return `computer/${[identity.projectId, identity.sessionId, identity.turnId, identity.toolCallId].map(encodeURIComponent).join("/")}.jpg`;
}
