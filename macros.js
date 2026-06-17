/**
 * Macro substitution — the single place {{user}} and {{char}} become names.
 *
 * The Familiar's prompts, tool descriptions, and tool results are authored
 * in first person with {{user}} / {{char}} placeholders so one piece of text
 * serves every bonded pair. This helper is where those placeholders resolve
 * to the configured names. It lives on its own (not inside discord-gateway or
 * cerebellum) because every surface that renders the Familiar's voice needs
 * it — the Discord presence blocks, the warm reach-out prompt, the triage
 * deliberation, and the tool-result strings the Familiar reads back.
 *
 * Fallbacks matter: an unconfigured ward is "my human", never "the user", and
 * an unnamed Familiar is "the Familiar". A literal {{user}} reaching the model
 * is the bug this prevents.
 */
export function substituteMacros(text, settings) {
  return String(text ?? '')
    .replaceAll('{{user}}', settings?.userName || 'my human')
    .replaceAll('{{char}}', settings?.charName || 'the Familiar');
}
