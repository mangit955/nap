/**
 * How a message sent mid-turn reads to the model (ADR-0026).
 *
 * One function, used twice: by the loop, through `BuiltContext.renderSteer`, when the agent takes
 * the steer in, and by the context engine when it rebuilds a conversation from the log. The same
 * words both times, so a turn compacted after a steer, and every turn after it, re-reads the
 * message as the model first read it.
 *
 * Framed rather than bare, because it rides in the user message that carries the tool results it
 * followed, and an unmarked paragraph there reads as more of the last tool's output. The framing
 * says who wrote it and that it is current: a person who interrupts a turn means it to change what
 * happens next, and a model that weighs it like the original request's background would not.
 */
export function renderSteer(text: string): string {
  return `<message_from_user sent_while_you_worked="true">\n${text}\n</message_from_user>\nThe person sent this while you were working. Take it into account from here on; where it conflicts with what you were doing, it wins.`;
}
