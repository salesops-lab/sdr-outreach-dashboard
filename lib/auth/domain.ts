/** Single source of truth for who may access the dashboard. */
export const ALLOWED_EMAIL_DOMAIN = "spyne.ai";

/** True only for a verified-shape email on the allowed Google Workspace domain. */
export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.trim().toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}
