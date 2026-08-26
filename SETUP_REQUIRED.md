# Setup required

No immediate human infrastructure setup is required for the v0.5 sandbox runtime. The owner explicitly made `momaibackend-ctrl/backend-autopilot` public, GitHub Pages is active with enforced HTTPS, and Supabase plus GitHub Actions are deployed. The superadmin bearer is generated locally, kept in the ignored `.env`, and deployed only to GitHub Actions/Supabase Edge secret stores.

The provider-neutral Kamal runtime is fully configured in the repository but intentionally not deployed because no VPS or stable domain was supplied and creating a paid server is forbidden. To activate it, the owner must provide one existing Linux server/IP, one stable DNS hostname, and the GitHub Environment variable/SSH secret references listed in `BOOTSTRAP_NEW_SERVER.md`. No application or database migration is needed.

No Render service was changed: there is no active Render Resource Registry record or credential reference in this control plane. If a legacy exact service is known, suspend it in the Render Dashboard after the stable hostname passes the MCP/OAuth/Console checks. Do not delete it during the migration window.

The sandbox Supabase project and GitHub Actions use the already authorized `momaibackend-ctrl` identity and project `qtyfdzjzmgxtrarpgcmn`. Other stored GitHub accounts were not logged out or modified.

An operator signs in at `https://momaibackend-ctrl.github.io/backend-autopilot/` by entering the allowlisted email and completing the Supabase magic-link flow. Passwords and tokens must never be copied into the repository or chat.

Future credential expiry may require the human-only OAuth, 2FA or CAPTCHA step again. Billing upgrades, production targets and `AUTONOMOUS_PRODUCTION` remain outside authorization.
