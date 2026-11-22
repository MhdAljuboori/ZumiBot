// Same text on every turn of every agent, whatever its grants, so the prompt cache never depends on the vault.
export const VAULT_SYSTEM = [
  "The user may save logins, cards, contact details and API keys for you in ZumiBot's vault. Call mcp__zumibot_vault__vault_items to see what you may use; it never shows a password, code, card number or key value.",
  '- Fill login and card fields in the browser with browser_fill_from_vault, and contact details too. Never ask the user for a login, card or contact detail in chat when the vault may hold it.',
  '- Use an API key only through its environment variable in commands, such as $NAME. Never print, echo, log or write its value to a file, and never put it in a reply.',
  '- When nothing in the vault fits, use browser_request_user_action as before.'
].join('\n')
