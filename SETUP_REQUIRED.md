# Setup required

No human action remains for the completed v0.3 local console, v0.2 live sandbox proof, GitHub source repository, or Linux CI.

On 2026-08-19 the official GitHub and Supabase login/confirmation boundaries were completed. The active GitHub identity is `momaibackend-ctrl`; other stored GitHub accounts were not logged out or modified. The only Supabase target is `qtyfdzjzmgxtrarpgcmn`; no second project was created and no billing action was required.

Future credential expiry may require the human-only OAuth/2FA/CAPTCHA step again. Backend Autopilot must then repeat exact identity and resource checks before any write. Billing upgrades, production targets, and `AUTONOMOUS_PRODUCTION` remain outside authorization.

## Current remote deployment boundary

Railway CLI authentication is not yet complete. The official `railway login` browser flow has been opened in a separate visible PowerShell window; the human must complete only Railway login/OAuth and any provider-required 2FA or legal consent. No password or token should be pasted into chat or committed.

After the callback succeeds, the agent can autonomously create the staging service, dedicated control-plane PostgreSQL, one workspace volume, server variables, GitHub source connection, and public HTTPS domain. If Railway requires a payment method, billing approval, or CAPTCHA, stop there and report it; do not infer consent or bypass the check.
